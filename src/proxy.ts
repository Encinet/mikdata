import type { Env } from './env';
import { proxyJson, serializedJson, type CacheStatus } from './http';
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
  body: string;
  source: 'UPSTREAM' | 'FALLBACK';
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
}
interface RefreshState {
  reading?: Promise<CacheRecord | null>;
  pending?: Promise<CacheRecord>;
  failures: number;
  retryAt: number;
  fallbackRetryAt: number;
}
interface ProxyState {
  scope: string;
  routes: Map<string, RefreshState>;
}
const states = new WeakMap<Fetcher, ProxyState>();
const memory = new TtlMemoryCache<CacheRecord>({
  defaultTtlMs: 60_000,
  maxEntries: 32,
  maxWeight: 4 * 1024 * 1024,
  weightOf: (record, key) => (record.body.length + key.length) * 2 + 128,
});
let nextScope = 0;
const FALLBACK_TTL_MS = 5000;

export function matchProxyRoute(pathname: string): RouteConfig | null {
  return ROUTES.find((route) => route.publicPath === pathname) ?? null;
}
export function refreshProxyRoutes(env: Env, ctx: ExecutionContext): void {
  for (const route of ROUTES) {
    ctx.waitUntil(
      (async () => {
        const cached = await readCache(route, env);
        await refresh(route, env, cached);
      })().catch((error) => console.warn('Scheduled proxy refresh failed', route.id, error)),
    );
  }
}
export async function serveProxyRoute(
  route: RouteConfig,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const cached = await readCache(route, env);
  const now = Date.now();
  if (cached && cached.freshUntil > now) return cachedResponse(route, cached, request, env, 'HIT');
  if (cached?.source === 'UPSTREAM' && cached.staleUntil > now) {
    ctx.waitUntil(
      refresh(route, env, cached).catch((error) =>
        console.warn('Background proxy refresh failed', route.id, error),
      ),
    );
    return cachedResponse(route, cached, request, env, 'STALE');
  }
  try {
    const record = await refresh(route, env, cached);
    return cachedResponse(route, record, request, env, record === cached ? 'STALE' : 'MISS');
  } catch {
    return proxyJson({ error: 'Upstream unavailable' }, 502, request, env, 'MISS', 'FALLBACK');
  }
}

function proxyState(env: Env): ProxyState {
  let state = states.get(env.VPC_SERVICE);
  if (!state) {
    state = { scope: `vpc${nextScope++}`, routes: new Map() };
    states.set(env.VPC_SERVICE, state);
  }
  return state;
}
function refresh(route: RouteConfig, env: Env, cached: CacheRecord | null): Promise<CacheRecord> {
  const state = routeState(route, env);
  if (state.pending) return state.pending;
  if (state.retryAt > Date.now()) {
    if (cached?.source === 'UPSTREAM' || (cached && cached.freshUntil > Date.now()))
      return Promise.resolve(cached);
    if (!route.fallback || state.fallbackRetryAt > Date.now())
      return Promise.reject(new Error('Upstream retry deferred'));
  }
  // Fallback and cache publication share the same flight as the upstream request.
  const task =
    state.retryAt > Date.now()
      ? fetchFallback(route, env, state)
      : fetchAndStore(route, env, cached, state);
  state.pending = task.finally(() => {
    state.pending = undefined;
  });
  return state.pending;
}
function routeState(route: RouteConfig, env: Env): RefreshState {
  const proxy = proxyState(env);
  const key = cacheKey(route, env);
  let state = proxy.routes.get(key);
  if (!state) {
    state = { failures: 0, retryAt: 0, fallbackRetryAt: 0 };
    proxy.routes.set(key, state);
  }
  return state;
}
async function fetchAndStore(
  route: RouteConfig,
  env: Env,
  cached: CacheRecord | null,
  state: RefreshState,
): Promise<CacheRecord> {
  try {
    const response = await env.VPC_SERVICE.fetch(
      new URL(route.upstreamPath, env.MINECRAFT_SERVER_URL),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error(`Upstream status ${response.status}`);
    if (!(response.headers.get('Content-Type') ?? '').toLowerCase().includes('application/json'))
      throw new Error('Unexpected upstream content type');
    const record = createRecord(
      JSON.stringify(await response.json()),
      'UPSTREAM',
      route.ttlSeconds * 1000,
      route.staleSeconds * 1000,
    );
    state.failures = 0;
    state.retryAt = 0;
    state.fallbackRetryAt = 0;
    await writeCache(route, env, record);
    return record;
  } catch (error) {
    state.failures = Math.min(state.failures + 1, 6);
    const delay = Math.min(30_000, 1000 * 2 ** (state.failures - 1));
    state.retryAt = Date.now() + delay;
    console.warn('Upstream refresh deferred', route.id, error);
    if (cached?.source === 'UPSTREAM') return cached;
    try {
      return await fetchFallback(route, env, state);
    } finally {
      state.retryAt = Date.now() + delay;
    }
  }
}
async function fetchFallback(
  route: RouteConfig,
  env: Env,
  state: RefreshState,
): Promise<CacheRecord> {
  if (!route.fallback || state.fallbackRetryAt > Date.now())
    throw new Error('Fallback unavailable');
  try {
    const record = createRecord(
      JSON.stringify(await route.fallback(env)),
      'FALLBACK',
      FALLBACK_TTL_MS,
      0,
    );
    state.fallbackRetryAt = 0;
    await writeCache(route, env, record);
    return record;
  } catch (error) {
    state.fallbackRetryAt = Date.now() + Math.min(30_000, 1000 * 2 ** (state.failures - 1));
    console.warn('Fallback refresh deferred', route.id, error);
    throw error;
  }
}
function createRecord(
  body: string,
  source: CacheRecord['source'],
  ttl: number,
  stale: number,
): CacheRecord {
  const now = Date.now();
  return { body, source, storedAt: now, freshUntil: now + ttl, staleUntil: now + ttl + stale };
}
function cacheKey(route: RouteConfig, env: Env): string {
  return `v3:${encodeURIComponent(env.MINECRAFT_SERVER_URL)}:${route.id}`;
}
function memoryKey(route: RouteConfig, env: Env): string {
  return `${proxyState(env).scope}:${cacheKey(route, env)}`;
}
function cacheRequest(key: string): Request {
  return new Request(`https://mikdata-cache.local/${key}`);
}
function workerCache(): Cache | null {
  return typeof caches === 'undefined' ? null : caches.default;
}
function remember(route: RouteConfig, env: Env, record: CacheRecord): void {
  memory.set(memoryKey(route, env), record, Math.max(1, record.staleUntil - Date.now() + 60_000));
}
async function readCache(route: RouteConfig, env: Env): Promise<CacheRecord | null> {
  const cached = memory.get(memoryKey(route, env));
  if (cached) return cached;
  const state = routeState(route, env);
  if (state.reading) return state.reading;
  state.reading = readWorkerCache(route, env).finally(() => {
    state.reading = undefined;
  });
  return state.reading;
}
async function readWorkerCache(route: RouteConfig, env: Env): Promise<CacheRecord | null> {
  try {
    const response = await workerCache()?.match(cacheRequest(cacheKey(route, env)));
    if (!response) return null;
    const timestamp = (header: string) => Number(response.headers.get(header) ?? NaN);
    const record = {
      body: await response.text(),
      source: response.headers.get('X-Proxy-Source'),
      storedAt: timestamp('X-Record-Stored-At'),
      freshUntil: timestamp('X-Record-Fresh-Until'),
      staleUntil: timestamp('X-Record-Stale-Until'),
    };
    if (isCacheRecord(record)) {
      remember(route, env, record);
      return record;
    }
    await workerCache()?.delete(cacheRequest(cacheKey(route, env)));
  } catch (error) {
    console.warn('Proxy cache read failed', route.id, error);
  }
  return null;
}
async function writeCache(route: RouteConfig, env: Env, record: CacheRecord): Promise<void> {
  remember(route, env, record);
  try {
    await workerCache()?.put(
      cacheRequest(cacheKey(route, env)),
      new Response(record.body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Proxy-Source': record.source,
          'X-Record-Stored-At': String(record.storedAt),
          'X-Record-Fresh-Until': String(record.freshUntil),
          'X-Record-Stale-Until': String(record.staleUntil),
          'Cache-Control': `public, max-age=${Math.max(1, Math.ceil((record.staleUntil - Date.now()) / 1000) + 60)}`,
        },
      }),
    );
  } catch (error) {
    console.warn('Proxy cache write failed', route.id, error);
  }
}
function cachedResponse(
  route: RouteConfig,
  record: CacheRecord,
  request: Request,
  env: Env,
  status: CacheStatus,
): Response {
  const now = Date.now();
  const maxAge = Math.max(
    0,
    Math.min(route.ttlSeconds, Math.floor((record.freshUntil - now) / 1000)),
  );
  const stale = Math.max(
    0,
    Math.floor((record.staleUntil - Math.max(record.freshUntil, now)) / 1000),
  );
  return serializedJson(record.body, 200, request, env, {
    'Cache-Control':
      record.source === 'FALLBACK'
        ? 'no-store'
        : `public, max-age=${maxAge}, stale-while-revalidate=${stale}`,
    'X-Proxy-Cache': status,
    'X-Proxy-Source': record.source,
    'X-Data-Stored-At': new Date(record.storedAt).toISOString(),
  });
}
function isCacheRecord(value: unknown): value is CacheRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as CacheRecord;
  return (
    typeof record.body === 'string' &&
    (record.source === 'UPSTREAM' || record.source === 'FALLBACK') &&
    Number.isFinite(record.storedAt) &&
    Number.isFinite(record.freshUntil) &&
    Number.isFinite(record.staleUntil) &&
    record.storedAt <= record.freshUntil &&
    record.freshUntil <= record.staleUntil
  );
}

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

async function fetchPlayerCountFallback(env: Env): Promise<unknown> {
  const host = env.MINECRAFT_SERVER_ADDRESS;

  if (!host) {
    throw new Error('MINECRAFT_SERVER_ADDRESS is not configured');
  }

  const port = env.MINECRAFT_SERVER_PORT;
  const address = port === '25565' ? host : `${host}:${port}`;
  const response = await fetch(
    `https://api.mcstatus.io/v2/status/java/${encodeURIComponent(address)}`,
    {
      signal: AbortSignal.timeout(5000),
    },
  );

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
