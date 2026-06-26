interface Env {
  MIKDATA_CACHE: KVNamespace;
  MINECRAFT_SERVER_URL: string;
  BUILDINGS_SERVER_URL?: string;
  MINECRAFT_SERVER_ADDRESS?: string;
  MINECRAFT_SERVER_PORT?: string;
  TOTP_SECRET?: string;
  BUILDINGS_TOTP_SECRET?: string;
  ALLOWED_ORIGINS?: string;
}

type CacheStatus = 'MISS' | 'HIT' | 'STALE';
type DataSource = 'UPSTREAM' | 'FALLBACK';

interface RouteConfig {
  id: string;
  publicPath: string;
  upstreamPath: string;
  upstream: 'minecraft' | 'buildings';
  ttlSeconds: number;
  staleSeconds: number;
  fallback?: (env: Env) => Promise<unknown>;
}

interface CacheRecord {
  body: unknown;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
}

const PUBLIC_BASE_PATH = '/api';
const CACHE_VERSION = 'v1';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

const ROUTES: RouteConfig[] = [
  {
    id: 'players',
    publicPath: '/players',
    upstreamPath: '/api/players',
    upstream: 'minecraft',
    ttlSeconds: 5,
    staleSeconds: 60,
    fallback: fetchPlayerCountFallback,
  },
  {
    id: 'buildings',
    publicPath: '/buildings',
    upstreamPath: '/api/buildings',
    upstream: 'buildings',
    ttlSeconds: 300,
    staleSeconds: 60 * 60 * 24 * 14,
  },
  {
    id: 'bans',
    publicPath: '/bans',
    upstreamPath: '/api/bans',
    upstream: 'minecraft',
    ttlSeconds: 60,
    staleSeconds: 60 * 60 * 24 * 7,
  },
  {
    id: 'announcements',
    publicPath: '/announcements',
    upstreamPath: '/api/announcements',
    upstream: 'minecraft',
    ttlSeconds: 300,
    staleSeconds: 60 * 60 * 24 * 14,
  },
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const route of ROUTES) {
      ctx.waitUntil(refreshRoute(route, env));
    }
  },
};

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  if (url.pathname === '/health') {
    return jsonResponse({ ok: true }, 200, request, env, 'HIT', 'FALLBACK');
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, request, env, 'MISS', 'FALLBACK');
  }

  if (!url.pathname.startsWith(`${PUBLIC_BASE_PATH}/`)) {
    return jsonResponse({ error: 'Not found' }, 404, request, env, 'MISS', 'FALLBACK');
  }

  const routePath = url.pathname.slice(PUBLIC_BASE_PATH.length);
  const route = matchRoute(routePath);

  if (!route) {
    return jsonResponse({ error: 'Not found' }, 404, request, env, 'MISS', 'FALLBACK');
  }

  return serveCachedRoute(route, request, env, ctx);
}

async function serveCachedRoute(
  route: RouteConfig,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const cacheKey = buildCacheKey(route);
  const now = Date.now();
  const cached = await readCache(env, cacheKey);

  if (cached && cached.freshUntil > now) {
    return cachedJsonResponse(cached, request, env, 'HIT', 'UPSTREAM');
  }

  if (cached && cached.staleUntil > now) {
    ctx.waitUntil(
      fetchAndCache(route, env).catch((error) => {
        console.error('Background refresh failed', route.id, error);
      }),
    );
    return cachedJsonResponse(cached, request, env, 'STALE', 'UPSTREAM');
  }

  try {
    const record = await fetchAndCache(route, env);
    return cachedJsonResponse(record, request, env, 'MISS', 'UPSTREAM');
  } catch (error) {
    console.error('Upstream fetch failed', route.id, error);

    if (cached) {
      return cachedJsonResponse(cached, request, env, 'STALE', 'UPSTREAM');
    }

    if (route.fallback) {
      try {
        const fallback = await route.fallback(env);
        return jsonResponse(fallback, 200, request, env, 'MISS', 'FALLBACK');
      } catch (fallbackError) {
        console.error('Fallback failed', route.id, fallbackError);
      }
    }

    return jsonResponse({ error: 'Upstream unavailable' }, 502, request, env, 'MISS', 'FALLBACK');
  }
}

async function refreshRoute(route: RouteConfig, env: Env): Promise<void> {
  await fetchAndCache(route, env);
}

async function fetchAndCache(route: RouteConfig, env: Env): Promise<CacheRecord> {
  const targetUrl = buildUpstreamUrl(route, env);
  const response = await fetch(targetUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-TOTP-Token': await generateToken(secretForRoute(route, env)),
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Upstream status ${response.status}`);
  }

  const contentType = response.headers.get('Content-Type') ?? '';

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(`Unexpected upstream content type: ${contentType || 'unknown'}`);
  }

  const body = await response.json();
  const now = Date.now();
  const record: CacheRecord = {
    body,
    storedAt: now,
    freshUntil: now + route.ttlSeconds * 1000,
    staleUntil: now + (route.ttlSeconds + route.staleSeconds) * 1000,
  };

  await env.MIKDATA_CACHE.put(buildCacheKey(route), JSON.stringify(record), {
    expirationTtl: Math.max(route.ttlSeconds + route.staleSeconds + 60, 60),
  });

  return record;
}

async function fetchPlayerCountFallback(env: Env): Promise<unknown> {
  const host = env.MINECRAFT_SERVER_ADDRESS;

  if (!host) {
    throw new Error('MINECRAFT_SERVER_ADDRESS is not configured');
  }

  const port = env.MINECRAFT_SERVER_PORT || '25565';
  const address = port === '25565' ? host : `${host}:${port}`;
  const response = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(address)}`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`mcstatus.io status ${response.status}`);
  }

  const data = (await response.json()) as {
    online?: boolean;
    players?: {
      online?: number;
    };
  };

  return {
    players: [],
    online: data.online ? (data.players?.online ?? 0) : -1,
  };
}

async function readCache(env: Env, cacheKey: string): Promise<CacheRecord | null> {
  const raw = await env.MIKDATA_CACHE.get(cacheKey);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as CacheRecord;
  } catch {
    await env.MIKDATA_CACHE.delete(cacheKey);
    return null;
  }
}

function cachedJsonResponse(
  record: CacheRecord,
  request: Request,
  env: Env,
  cacheStatus: CacheStatus,
  source: DataSource,
): Response {
  const responseHeaders = {
    'X-Data-Stored-At': new Date(record.storedAt).toISOString(),
  };

  return jsonResponse(record.body, 200, request, env, cacheStatus, source, responseHeaders);
}

function jsonResponse(
  body: unknown,
  status: number,
  request: Request,
  env: Env,
  cacheStatus: CacheStatus,
  source: DataSource,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(request, env),
      ...extraHeaders,
      'Cache-Control': source === 'UPSTREAM' ? 'public, max-age=0, must-revalidate' : 'no-store',
      'X-Proxy-Cache': cacheStatus,
      'X-Proxy-Source': source,
    },
  });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const requestOrigin = request.headers.get('Origin');
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin =
    requestOrigin && allowedOrigins.has(requestOrigin)
      ? requestOrigin
      : allowedOrigins.size === 0
        ? '*'
        : '';

  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function parseAllowedOrigins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function matchRoute(pathname: string): RouteConfig | null {
  return ROUTES.find((route) => route.publicPath === pathname) ?? null;
}

function buildUpstreamUrl(route: RouteConfig, env: Env): URL {
  const baseUrl =
    route.upstream === 'buildings' && env.BUILDINGS_SERVER_URL
      ? env.BUILDINGS_SERVER_URL
      : env.MINECRAFT_SERVER_URL;
  return new URL(route.upstreamPath, baseUrl);
}

function buildCacheKey(route: RouteConfig): string {
  return `${CACHE_VERSION}:${route.id}`;
}

function secretForRoute(route: RouteConfig, env: Env): string {
  const secret =
    route.upstream === 'buildings'
      ? env.BUILDINGS_TOTP_SECRET || env.TOTP_SECRET
      : env.TOTP_SECRET;

  if (!secret) {
    throw new Error(`Missing TOTP secret for ${route.id}`);
  }

  return secret;
}

async function generateToken(secret: string): Promise<string> {
  const step = Math.floor(Date.now() / 1000 / 30).toString();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(step));

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
