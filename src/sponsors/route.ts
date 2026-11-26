import { AFDIAN_ID_RE, minecraftUuid } from './model';
import type { AdminActor } from '../auth/access';
import { SponsorService } from './service';
import type { Env } from '../env';
import { isSameOriginBrowserRequest, json, readLimitedRequestText, requestMediaType, RequestBodyTooLargeError } from '../shared/http';

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
  if (typeof caches === 'undefined') return respond(() => new SponsorService(env).catalog({ kind: 'public' }));

  // Version the shared cache key when the public response contract changes.
  const key = new Request(new URL('/.mikdata-cache/sponsors/v4', request.url));
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

  const response = await respond(() => new SponsorService(env).catalog({ kind: 'public' }));
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
    return ADMIN_CATALOG.test(routePath) ? respond(() => adminSponsorRequest(routePath, request, env)) : null;
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

  return respond(() => adminSponsorRequest(routePath, request, env));
}

async function adminSponsorRequest(path: string, request: Request, env: Env): Promise<Response> {
  const service = new SponsorService(env);
  const [, resource, id, item, orderId] = path.split('/');
  const uuid = minecraftUuid(id);
  const order = minecraftUuid(orderId);
  const notFound = () => json({ error: 'not found' }, 404);
  if (request.method === 'GET') {
    if (resource === 'sponsor-catalog' && !id) return service.overview();
    if (resource === 'sponsor-catalog' && uuid) return service.catalog({ kind: 'player', id: uuid });
    if (resource === 'sponsor-accounts' && id && AFDIAN_ID_RE.test(id)) return service.catalog({ kind: 'account', id });
    return notFound();
  }
  if (request.method === 'DELETE') {
    if (resource === 'sponsor-mappings' && id && AFDIAN_ID_RE.test(id)) return service.unbindAccount(id);
    if (resource === 'sponsors' && item === 'orders' && uuid && order)
      return service.deleteOrder(uuid, order, request.headers.get('If-Match'));
    return notFound();
  }
  if (request.method !== 'PUT' && request.method !== 'PATCH') return json({ error: 'method not allowed' }, 405);
  if (request.method === 'PATCH' && item !== 'orders') return notFound();
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  if (resource === 'sponsor-mappings' && !id) return service.bindAccount(body);
  if (resource !== 'sponsors' || !uuid) return notFound();
  if (!item) return service.setName(uuid, body);
  if (item !== 'orders' || !order) return notFound();
  return request.method === 'PUT' ? service.addOrder(order, uuid, body) : service.editManualOrder(order, uuid, body);
}

async function respond(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    console.warn('Sponsor data unavailable', error);
    return json({ error: 'sponsor_data_unavailable' }, 503, { 'Cache-Control': 'no-store' });
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (requestMediaType(request) !== 'application/json') {
    return json({ error: 'content-type must be application/json' }, 415);
  }
  try {
    const body: unknown = JSON.parse(await readLimitedRequestText(request, 8 * 1024));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'body must be a JSON object' }, 400);
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return json({ error: 'invalid JSON body' }, 400);
  }
}
