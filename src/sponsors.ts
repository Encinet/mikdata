import type { AdminActor } from './auth/access';
import type { Env } from './env';
import { isSameOriginBrowserRequest, json } from './shared/http';

const PUBLIC_CACHE_SECONDS = 30;
const ADMIN_RETRY_SECONDS = 60;
const ADMIN_CATALOG = /^\/(?:sponsor-catalog(?:\/[^/]+)?|sponsor-accounts\/[^/]+)$/;
const ADMIN_RECORD = /^\/(?:sponsor-mappings(?:\/[^/]+)?|sponsors\/[^/]+(?:\/orders\/[^/]+)?)$/;

export async function handlePublicSponsorsRoute(
  routePath: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (routePath !== '/sponsors') return null;
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (typeof caches === 'undefined') return forwardToStore('/public', request, env);

  // Version the shared cache key when the public response shape changes.
  const key = new Request(new URL('/.mikdata-cache/sponsors/v3', request.url));
  try {
    const cached = await caches.default.match(key);
    if (cached) {
      const response = new Response(cached.body, cached);
      response.headers.set('Cache-Control', 'public, no-cache');
      return response;
    }
  } catch (error) {
    console.warn('Public sponsor cache read failed', error);
  }

  const response = await forwardToStore('/public', request, env);
  if (response.status === 200 && response.headers.get('X-Sponsor-Data') === 'complete') {
    const copy = response.clone();
    const cached = new Response(copy.body, copy);
    cached.headers.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);
    ctx.waitUntil(caches.default.put(key, cached).catch((error) => {
      console.warn('Public sponsor cache write failed', error);
    }));
  }
  return response;
}

export async function handleAdminSponsorsRoute(
  routePath: string,
  request: Request,
  env: Env,
  actor: AdminActor,
): Promise<Response | null> {
  if (request.method === 'GET') {
    return ADMIN_CATALOG.test(routePath) ? forwardToStore(routePath, request, env) : null;
  }
  if (!ADMIN_RECORD.test(routePath)) return null;
  if (!isSameOriginBrowserRequest(request))
    return json({ error: 'forbidden' }, 403);

  try {
    const key = (actor.email?.trim().toLowerCase() || actor.subject?.trim() || 'unknown').slice(0, 50);
    const { success } = await env.AUTH_SENSITIVE_RATE_LIMITER.limit({ key: 'sponsor-admin:' + key });
    if (!success) {
      return json({ error: 'rate_limited', retryAfterSeconds: ADMIN_RETRY_SECONDS }, 429, {
        'Cache-Control': 'no-store',
        'Retry-After': String(ADMIN_RETRY_SECONDS),
      });
    }
  } catch (error) {
    console.warn('Admin sponsor rate limit check failed', error);
  }

  return forwardToStore(routePath, request, env);
}

export function refreshSponsorCatalog(env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(
    forwardToStore('/refresh', { method: 'POST' }, env).then((response) =>
      response.body?.cancel(),
    ),
  );
}

async function forwardToStore(path: string, init: RequestInit, env: Env): Promise<Response> {
  try {
    const store = env.SPONSOR_STORE.getByName('catalog');
    return await store.fetch(new Request(new URL(path, 'https://sponsor-store.local'), init));
  } catch (error) {
    console.warn('Sponsor store unavailable', error);
    return json({ error: 'sponsor_data_unavailable' }, 503, { 'Cache-Control': 'no-store' });
  }
}
