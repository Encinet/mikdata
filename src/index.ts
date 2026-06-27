import type { Env } from './env';
import { requireCloudflareAccess } from './access';
import { adminPage } from './admin';
import { AuthStore, handleAuthRoute } from './auth';
import {
  BuildingsWriter,
  handleAdminBuildingsRoute,
  handlePublicBuildingsRoute,
} from './buildings';
import { corsHeaders } from './http';
import { json, proxyJson } from './http';
import { matchProxyRoute, refreshProxyRoutes, serveProxyRoute } from './proxy';

const ADMIN_API_BASE_PATH = '/admin/api';
const PUBLIC_BASE_PATH = '/api';

export { AuthStore, BuildingsWriter };

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
