import type { Env } from './env';
import { requireCloudflareAccess } from './access';
import { adminPage } from './admin';
import { AuthStore, handleAuthRoute } from './auth';
import {
  handleAdminBuildingsRoute,
  handlePublicBuildingsRoute,
} from './buildings';
import { corsHeaders } from './http';
import { json, proxyJson } from './http';
import { matchProxyRoute, refreshProxyRoutes, serveProxyRoute } from './proxy';

const ADMIN_API_BASE_PATH = '/admin/api';
const PUBLIC_BASE_PATH = '/api';
const PUBLIC_RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_RETRY_SECONDS = 10;

export { AuthStore };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    refreshProxyRoutes(env, ctx);
  },
};

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    if (url.pathname.startsWith('/admin') || isAuthPath(url.pathname)) {
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  if (url.pathname === '/health') {
    return proxyJson({ ok: true }, 200, request, env, 'HIT', 'FALLBACK');
  }

  if (isAuthPath(url.pathname)) {
    return withoutCors((await handleAuthRoute(url.pathname, request, env)) ?? json({ error: 'Not found' }, 404, request, env));
  }

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    const access = await requireCloudflareAccess(request, env);

    if (!access.ok) {
      return withoutCors(access.response);
    }

    return adminPage();
  }

  if (url.pathname === ADMIN_API_BASE_PATH || url.pathname.startsWith(`${ADMIN_API_BASE_PATH}/`)) {
    const access = await requireCloudflareAccess(request, env);

    if (!access.ok) {
      return withoutCors(access.response);
    }

    const adminRoutePath = url.pathname.slice(ADMIN_API_BASE_PATH.length) || '/';
    const adminResponse = await handleAdminBuildingsRoute(adminRoutePath, request, env, access.user);

    if (adminResponse) {
      return withoutCors(adminResponse);
    }

    return withoutCors(json({ error: 'Not found' }, 404, request, env));
  }

  if (url.pathname.startsWith('/admin')) {
    const access = await requireCloudflareAccess(request, env);

    if (!access.ok) {
      return withoutCors(access.response);
    }

    return withoutCors(json({ error: 'Not found' }, 404, request, env));
  }

  if (!url.pathname.startsWith(`${PUBLIC_BASE_PATH}/`)) {
    return json({ error: 'Not found' }, 404, request, env);
  }

  if (request.method === 'GET') {
    const rateLimited = await enforcePublicRateLimit(request, env);
    if (rateLimited) return rateLimited;
  }

  if (url.pathname === '/api/community/notices'
      || url.pathname.startsWith('/api/community/notices/')) {
    return serveCommunityBoard(request, env);
  }

  const routePath = url.pathname.slice(PUBLIC_BASE_PATH.length);
  const buildingsResponse = await handlePublicBuildingsRoute(routePath, request, env);

  if (buildingsResponse) {
    return buildingsResponse;
  }

  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, request, env);
  }

  const route = matchProxyRoute(routePath);

  if (!route) {
    return json({ error: 'Not found' }, 404, request, env);
  }

  return serveProxyRoute(route, request, env, ctx);
}

/** MikData only forwards public board records; the game server owns all board data. */
async function serveCommunityBoard(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'GET')
    return json({ error: 'method_not_allowed' }, 405, request, env, headers);
  const prefix = '/api/community/notices/';
  if (pathname.startsWith(prefix)
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pathname.slice(prefix.length)))
    return json({ error: 'not_found' }, 404, request, env, headers);
  try {
    const response = await env.VPC_SERVICE.fetch(new URL(pathname, env.MINECRAFT_SERVER_URL), {
      method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200 && response.status !== 404)
      return json({ error: 'upstream_unavailable' }, 502, request, env, headers);
    if (!(response.headers.get('Content-Type') ?? '').toLowerCase().includes('application/json'))
      return json({ error: 'upstream_unavailable' }, 502, request, env, headers);
    return json(await response.json(), response.status, request, env, headers);
  } catch (error) {
    console.error('Community board upstream failed', error);
    return json({ error: 'upstream_unavailable' }, 502, request, env, headers);
  }
}

async function enforcePublicRateLimit(request: Request, env: Env): Promise<Response | null> {
  try {
    const { success } = await env.PUBLIC_API_RATE_LIMITER.limit({ key: publicClientKey(request) });
    if (success) return null;
    return json(
      { error: 'rate_limited', retryAfterSeconds: PUBLIC_RATE_LIMIT_WINDOW_SECONDS },
      429,
      request,
      env,
      {
        'Cache-Control': 'no-store',
        'Retry-After': String(PUBLIC_RATE_LIMIT_WINDOW_SECONDS),
      },
    );
  } catch (error) {
    console.error('Public API rate limit check failed', {
      path: new URL(request.url).pathname,
      error,
    });
    return json({ error: 'rate_limiter_unavailable' }, 503, request, env, {
      'Cache-Control': 'no-store',
      'Retry-After': String(RATE_LIMIT_RETRY_SECONDS),
    });
  }
}

function publicClientKey(request: Request): string {
  const address = request.headers.get('CF-Connecting-IP')?.trim().slice(0, 64) ?? '';
  const normalized = address.replace(/[^a-fA-F0-9:.-]/g, '_') || 'unknown';
  return `ip:${normalized}`;
}

function isAuthPath(pathname: string): boolean {
  return pathname === '/auth' || pathname.startsWith('/auth/') || pathname === '/me' || pathname.startsWith('/me/');
}

function withoutCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Access-Control-Allow-Methods');
  headers.delete('Access-Control-Allow-Headers');
  headers.delete('Access-Control-Max-Age');
  headers.delete('Vary');
  headers.set('Cache-Control', 'no-store');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
