import type { Env } from './env';
import { requireCloudflareAccess } from './auth/access';
import { adminPage } from './admin/page';
import { imagePublicBaseUrl } from './buildings/images/storage';
import { handleChatRequest, handleMikwebRoute } from './mikweb';
import { maintainAuth } from './auth/repository';
import { maintainBuildings } from './buildings/actions';
import { handleAdminBuildingsRoute } from './buildings/admin-route';
import { handlePublicBuildingsRoute } from './buildings/public-route';
import { json, proxyJson, PUBLIC_CORS_HEADERS } from './shared/http';
import { matchProxyRoute, refreshProxyRoutes, serveProxyRoute } from './proxy';
import {
  handleAdminSponsorsRoute,
  handlePublicSponsorsRoute,
} from './sponsors/route';
import { refreshAfdian } from './sponsors/snapshot';

const ADMIN_API_BASE_PATH = '/admin/api';
const PUBLIC_BASE_PATH = '/api';
const PUBLIC_RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_RETRY_SECONDS = 10;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(maintainAuth(env.DB));
    ctx.waitUntil(maintainBuildings(env));
    refreshProxyRoutes(env, ctx);
    if (new Date(event.scheduledTime).getUTCMinutes() === 0) {
      ctx.waitUntil(refreshAfdian(env, event.scheduledTime));
    }
  },
};

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/chat/connect' || url.pathname === '/chat/check' || url.pathname === '/chat/session') {
    return withoutCors(await handleChatRequest(request, env, ctx, url.pathname));
  }

  if (request.method === 'OPTIONS') {
    if (url.pathname.startsWith('/admin') || isAuthPath(url.pathname)) {
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 204, headers: PUBLIC_CORS_HEADERS });
  }

  if (url.pathname === '/health') {
    return proxyJson({ ok: true }, 200, 'HIT', 'FALLBACK');
  }

  if (isAuthPath(url.pathname)) {
    return withoutCors((await handleMikwebRoute(url.pathname, request, env, ctx)) ?? json({ error: 'Not found' }, 404));
  }

  const sponsorAdminPage = url.pathname === '/admin/sponsors' || url.pathname === '/admin/sponsors/';
  if (url.pathname === '/admin' || url.pathname === '/admin/' || sponsorAdminPage) {
    const access = await requireCloudflareAccess(request, env);

    if (!access.ok) {
      return withoutCors(access.response);
    }

    return sponsorAdminPage ? adminPage(undefined, 'sponsors') : adminPage(imagePublicBaseUrl(env));
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

    const sponsorResponse = await handleAdminSponsorsRoute(adminRoutePath, request, env, access.user);

    if (sponsorResponse) {
      return withoutCors(sponsorResponse);
    }

    return withoutCors(json({ error: 'Not found' }, 404));
  }

  if (url.pathname.startsWith('/admin')) {
    const access = await requireCloudflareAccess(request, env);

    if (!access.ok) {
      return withoutCors(access.response);
    }

    return withoutCors(json({ error: 'Not found' }, 404));
  }

  if (!url.pathname.startsWith(`${PUBLIC_BASE_PATH}/`)) {
    return json({ error: 'Not found' }, 404);
  }

  if (request.method === 'GET') {
    const rateLimited = await enforcePublicRateLimit(request, env);
    if (rateLimited) return rateLimited;
  }

  const routePath = url.pathname.slice(PUBLIC_BASE_PATH.length);
  const buildingsResponse = await handlePublicBuildingsRoute(routePath, request, env);

  if (buildingsResponse) {
    return buildingsResponse;
  }

  const sponsorsResponse = await handlePublicSponsorsRoute(routePath, request, env, ctx);

  if (sponsorsResponse) {
    return sponsorsResponse;
  }

  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const route = matchProxyRoute(routePath);

  if (!route) {
    return json({ error: 'Not found' }, 404);
  }

  return serveProxyRoute(route, env, ctx);
}

async function enforcePublicRateLimit(request: Request, env: Env): Promise<Response | null> {
  try {
    const { success } = await env.PUBLIC_API_RATE_LIMITER.limit({ key: publicClientKey(request) });
    if (success) return null;
    return json(
      { error: 'rate_limited', retryAfterSeconds: PUBLIC_RATE_LIMIT_WINDOW_SECONDS },
      429,
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
    return json({ error: 'rate_limiter_unavailable' }, 503, {
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
