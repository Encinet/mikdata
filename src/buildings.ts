import type { Env } from './env';
import type { AdminActor } from './types';
import type { AdminBuildingCommand } from './building-service';
import { AUTH_STORE_NAME } from './constants';
import { json } from './http';

const MAX_BODY_BYTES = 64 * 1024;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const error = (message: string, status: number, request: Request, env: Env): Response =>
  json({ error: message }, status, request, env);

/** Authenticate at the Worker boundary; the DO owns transactions and calls the service directly. */
export async function handleAdminBuildingsRoute(
  routePath: string,
  request: Request,
  env: Env,
  actor: AdminActor,
): Promise<Response | null> {
  if (!isAdminBuildingsRoute(routePath)) return null;
  if (MUTATING_METHODS.has(request.method) && !isSameOriginBrowserRequest(request))
    return error('forbidden', 403, request, env);
  const target = adminTarget(routePath, request.method);
  if (!target) return error('method not allowed', 405, request, env);
  const text = await readLimitedRequestText(request, env);
  if (!text.ok) return text.response;
  let body: unknown = {};
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    const optional = routePath.startsWith('/building-submissions/');
    if (text.text.trim() || !optional) {
      if (!(request.headers.get('Content-Type') ?? '').toLowerCase().includes('application/json'))
        return error('content-type must be application/json', 415, request, env);
      try {
        body = JSON.parse(text.text);
      } catch {
        return error('invalid JSON body', 400, request, env);
      }
    }
  }
  const response = await env.AUTH_STORE.get(env.AUTH_STORE.idFromName(AUTH_STORE_NAME)).fetch(
    new Request('https://auth-store.local/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'adminBuildingMutation',
        ...target,
        body,
        expectedUpdatedAt: request.headers.get('X-Expected-Updated-At') ?? undefined,
        status: new URL(request.url).searchParams.get('status') ?? undefined,
        actor,
      }),
    }),
  );
  const result = (await response.json()) as { status: number; body: unknown };
  return json(result.body, result.status, request, env);
}

async function readLimitedRequestText(
  request: Request,
  env: Env,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const contentLength = request.headers.get('content-length');

  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return { ok: false, response: error('request body too large', 413, request, env) };
  }

  if (!request.body) {
    return { ok: true, text: '' };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, response: error('request body too large', 413, request, env) };
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return { ok: true, text };
}

function isSameOriginBrowserRequest(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get('Origin');

  if (origin && origin !== requestOrigin) {
    return false;
  }

  const fetchSite = request.headers.get('Sec-Fetch-Site');

  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return false;
  }

  return true;
}

function isAdminBuildingsRoute(routePath: string): boolean {
  return (
    routePath === '/buildings' ||
    routePath === '/buildings/import' ||
    routePath === '/building-submissions' ||
    /^\/buildings\/[a-z0-9]{8,24}$/i.test(routePath) ||
    /^\/building-submissions\/[a-z0-9]{8,24}(?:\/(?:approve|reject))?$/i.test(routePath)
  );
}

function adminTarget(
  route: string,
  method: string,
): { operation: AdminBuildingCommand['operation']; id?: string } | null {
  if (route === '/buildings') {
    return method === 'GET'
      ? { operation: 'listBuildings' }
      : method === 'POST'
        ? { operation: 'createBuilding' }
        : null;
  }
  if (route === '/buildings/import')
    return method === 'POST' ? { operation: 'importBuildings' } : null;
  if (route === '/building-submissions')
    return method === 'GET' ? { operation: 'listSubmissions' } : null;
  const building = route.match(/^\/buildings\/([a-z0-9]{8,24})$/i);
  if (building) {
    const operation =
      method === 'PUT'
        ? 'replaceBuilding'
        : method === 'PATCH'
          ? 'patchBuilding'
          : method === 'DELETE'
            ? 'deleteBuilding'
            : null;
    return operation ? { operation, id: building[1] } : null;
  }
  const submission = route.match(
    /^\/building-submissions\/([a-z0-9]{8,24})(?:\/(approve|reject))?$/i,
  );
  if (!submission || method !== 'PUT') return null;
  const action = submission[2]?.toLowerCase();
  return {
    operation:
      action === 'approve'
        ? 'approveSubmission'
        : action === 'reject'
          ? 'rejectSubmission'
          : 'editSubmission',
    id: submission[1],
  };
}
