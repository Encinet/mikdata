import type { Env } from './env';
import { proxyJson, type CacheStatus, type DataSource } from './http';
import { TtlMemoryCache } from './memory-cache';

interface RouteConfig {
  id: string;
  publicPath: string;
  upstreamPath: string;
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

const CACHE_VERSION = 'v1';
const memoryCache = new TtlMemoryCache<CacheRecord>({
  defaultTtlMs: 60 * 1000,
  maxEntries: 32,
});
const refreshes = new Map<string, Promise<CacheRecord>>();

const ROUTES: RouteConfig[] = [
  {
    id: 'players',
    publicPath: '/players',
    upstreamPath: '/api/players',
    ttlSeconds: 5,
    staleSeconds: 60,
    fallback: fetchPlayerCountFallback,
  },
  {
    id: 'bans',
    publicPath: '/bans',
    upstreamPath: '/api/bans',
    ttlSeconds: 60,
    staleSeconds: 60 * 60 * 24 * 7,
  },
  {
    id: 'announcements',
    publicPath: '/announcements',
    upstreamPath: '/api/announcements',
    ttlSeconds: 300,
    staleSeconds: 60 * 60 * 24 * 14,
  },
];

export function matchProxyRoute(pathname: string): RouteConfig | null {
  return ROUTES.find((route) => route.publicPath === pathname) ?? null;
}

export function refreshProxyRoutes(env: Env, ctx: ExecutionContext): void {
  for (const route of ROUTES) {
    ctx.waitUntil(refreshRoute(route, env));
  }
}

export async function serveProxyRoute(
  route: RouteConfig,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const cacheKey = buildCacheKey(route);
  const now = Date.now();
  const cached = await readCache(cacheKey);

  if (cached && cached.freshUntil > now) {
    return cachedJsonResponse(route, cached, request, env, 'HIT', 'UPSTREAM');
  }

  if (cached && cached.staleUntil > now) {
    ctx.waitUntil(
      fetchAndCache(route, env).catch((error) => {
        console.error('Background refresh failed', route.id, error);
      }),
    );
    return cachedJsonResponse(route, cached, request, env, 'STALE', 'UPSTREAM');
  }

  try {
    const record = await fetchAndCache(route, env);
    return cachedJsonResponse(route, record, request, env, 'MISS', 'UPSTREAM');
  } catch (error) {
    console.error('Upstream fetch failed', route.id, error);

    if (cached) {
      return cachedJsonResponse(route, cached, request, env, 'STALE', 'UPSTREAM');
    }

    if (route.fallback) {
      try {
        const fallback = await route.fallback(env);
        return proxyJson(fallback, 200, request, env, 'MISS', 'FALLBACK');
      } catch (fallbackError) {
        console.error('Fallback failed', route.id, fallbackError);
      }
    }

    return proxyJson({ error: 'Upstream unavailable' }, 502, request, env, 'MISS', 'FALLBACK');
  }
}

async function refreshRoute(route: RouteConfig, env: Env): Promise<void> {
  await fetchAndCache(route, env);
}

async function fetchAndCache(route: RouteConfig, env: Env): Promise<CacheRecord> {
  const cacheKey = buildCacheKey(route);
  const existing = refreshes.get(cacheKey);

  if (existing) {
    return existing;
  }

  const refresh = fetchAndStore(route, env).finally(() => {
    refreshes.delete(cacheKey);
  });
  refreshes.set(cacheKey, refresh);
  return refresh;
}

async function fetchAndStore(route: RouteConfig, env: Env): Promise<CacheRecord> {
  const targetUrl = new URL(route.upstreamPath, env.MINECRAFT_SERVER_URL);
  const response = await env.VPC_SERVICE.fetch(targetUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw upstreamStatusError(route, targetUrl, response);
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

  await writeCache(route, record);

  return record;
}

async function fetchPlayerCountFallback(env: Env): Promise<unknown> {
  const host = env.MINECRAFT_SERVER_ADDRESS;

  if (!host) {
    throw new Error('MINECRAFT_SERVER_ADDRESS is not configured');
  }

  const port = env.MINECRAFT_SERVER_PORT;
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
    online: data.online ? (data.players?.online ?? 0) : -1,
    peak_online: -1,
    players: [],
  };
}

function upstreamStatusError(route: RouteConfig, targetUrl: URL, response: Response): Error {
  console.error('Upstream returned non-OK response', {
    route: route.id,
    target: `${targetUrl.origin}${targetUrl.pathname}`,
    status: response.status,
  });
  return new Error(`Upstream status ${response.status}`);
}

async function readCache(cacheKey: string): Promise<CacheRecord | null> {
  const memoryRecord = memoryCache.get(cacheKey);

  if (memoryRecord) {
    return memoryRecord;
  }

  let response: Response | undefined;
  const cache = getWorkerCache();

  if (!cache) {
    return null;
  }

  try {
    response = await cache.match(cacheRequest(cacheKey));
  } catch (error) {
    console.warn('Worker cache read failed', cacheKey, error);
    return null;
  }

  if (!response) {
    return null;
  }

  const raw = await response.text();

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (isCacheRecord(parsed)) {
      memoryCache.set(cacheKey, parsed, Math.max(parsed.staleUntil - Date.now(), 1));
      return parsed;
    }
  } catch {
    // The invalid cache entry is removed below.
  }

  try {
    await cache.delete(cacheRequest(cacheKey));
  } catch (error) {
    console.warn('Worker cache delete failed', cacheKey, error);
  }

  return null;
}

async function writeCache(route: RouteConfig, record: CacheRecord): Promise<void> {
  const cacheKey = buildCacheKey(route);
  memoryCache.set(cacheKey, record, Math.max(record.staleUntil - Date.now(), 1));
  const cache = getWorkerCache();

  if (!cache) {
    return;
  }

  try {
    await cache.put(
      cacheRequest(cacheKey),
      new Response(JSON.stringify(record), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${Math.max(route.ttlSeconds + route.staleSeconds + 60, 60)}`,
        },
      }),
    );
  } catch (error) {
    console.warn('Worker cache write failed', route.id, error);
  }
}

function cachedJsonResponse(
  route: RouteConfig,
  record: CacheRecord,
  request: Request,
  env: Env,
  cacheStatus: CacheStatus,
  source: DataSource,
): Response {
  return proxyJson(record.body, 200, request, env, cacheStatus, source, {
    'Cache-Control': cacheControlForRecord(route, record),
    'X-Data-Stored-At': new Date(record.storedAt).toISOString(),
  });
}

function cacheControlForRecord(route: RouteConfig, record: CacheRecord): string {
  const now = Date.now();
  const maxAge = Math.max(Math.floor((record.freshUntil - now) / 1000), 0);
  const staleWindow = Math.max(
    Math.floor((record.staleUntil - Math.max(record.freshUntil, now)) / 1000),
    0,
  );

  return `public, max-age=${Math.min(maxAge, route.ttlSeconds)}, stale-while-revalidate=${staleWindow}`;
}

function buildCacheKey(route: RouteConfig): string {
  return `${CACHE_VERSION}:${route.id}`;
}

function cacheRequest(cacheKey: string): Request {
  return new Request(`https://mikdata-cache.local/${cacheKey}`);
}

function getWorkerCache(): Cache | null {
  return typeof caches === 'undefined' ? null : caches.default;
}

function isCacheRecord(value: unknown): value is CacheRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    Object.prototype.hasOwnProperty.call(record, 'body') &&
    Number.isFinite(record.storedAt) &&
    Number.isFinite(record.freshUntil) &&
    Number.isFinite(record.staleUntil) &&
    (record.staleUntil as number) >= (record.freshUntil as number)
  );
}
