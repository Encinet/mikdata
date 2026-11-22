import type { AdminActor } from '../auth/access';
import type { Env } from '../env';
import { ADMIN_IMAGE_MAX_BYTES, ADMIN_IMAGE_PATH } from './images/admin-upload';
import { adminImageOwner } from './images/keys';
import type { AdminBuildingCommand } from './service';
import { BUILDING_ID_PATTERN } from './id';
import { authStore } from '../auth/binding';
import { isSameOriginBrowserRequest, json } from '../shared/http';

const MAX_BODY_BYTES = 64 * 1024;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BUILDING_ROUTE_RE = new RegExp(`^/buildings/(${BUILDING_ID_PATTERN})$`, 'i');
const SUBMISSION_ROUTE_RE = new RegExp(
  `^/building-submissions/(${BUILDING_ID_PATTERN})(?:/(approve|reject))?$`,
  'i',
);
const error = (message: string, status: number): Response =>
  json({ error: message }, status);

/** Authenticate at the Worker boundary; the DO owns transactions and calls the service directly. */
export async function handleAdminBuildingsRoute(
  routePath: string,
  request: Request,
  env: Env,
  actor: AdminActor,
): Promise<Response | null> {
  if (!isAdminBuildingsRoute(routePath)) return null;
  if (MUTATING_METHODS.has(request.method) && !isSameOriginBrowserRequest(request))
    return error('forbidden', 403);
  if (routePath === ADMIN_IMAGE_PATH) return forwardAdminImage(request, env, actor);
  const target = adminTarget(routePath, request.method);
  if (!target) return error('method not allowed', 405);
  const text = await readLimitedRequestText(request);
  if (!text.ok) return text.response;
  let body: unknown = {};
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    const optional = routePath.startsWith('/building-submissions/');
    if (text.text.trim() || !optional) {
      if (!(request.headers.get('Content-Type') ?? '').toLowerCase().includes('application/json'))
        return error('content-type must be application/json', 415);
      try {
        body = JSON.parse(text.text);
      } catch {
        return error('invalid JSON body', 400);
      }
    }
  }
  const response = await authStore(env).fetch(
    new Request('https://auth-store.local/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'adminBuildingMutation',
        ...target,
        body,
        expectedUpdatedAt: request.headers.get('X-Expected-Updated-At') ?? undefined,
        draftKey: request.headers.get('X-Building-Draft') ?? undefined,
        status: new URL(request.url).searchParams.get('status') ?? undefined,
        actor,
      }),
    }),
  );
  const result = (await response.json()) as { status: number; body: unknown };
  return json(result.body, result.status);
}

async function forwardAdminImage(request: Request, env: Env, actor: AdminActor): Promise<Response> {
  if (request.method !== 'POST') return error('method not allowed', 405);
  const owner = adminImageOwner(actor);
  if (!owner) return error('forbidden', 403);
  const contentType = request.headers.get('Content-Type');
  if (contentType !== 'image/webp') return error('image_must_be_webp', 415);
  const length = request.headers.get('Content-Length');
  if (Number(length) > ADMIN_IMAGE_MAX_BYTES) return error('image_too_large', 413);
  if (!request.body) return error('invalid_image', 422);
  const headers = new Headers({
    'Content-Type': contentType,
    'X-Admin-Image-Owner': owner,
    'X-Building-Draft': request.headers.get('X-Building-Draft') ?? '',
  });
  const url = new URL(ADMIN_IMAGE_PATH, 'https://auth-store.local');
  const building = new URL(request.url).searchParams.get('building');
  if (building !== null) url.searchParams.set('building', building);
  return authStore(env).fetch(
    new Request(url, { method: 'POST', headers, body: request.body }),
  );
}

async function readLimitedRequestText(
  request: Request,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const contentLength = request.headers.get('content-length');

  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return { ok: false, response: error('request body too large', 413) };
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
      return { ok: false, response: error('request body too large', 413) };
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return { ok: true, text };
}

function isAdminBuildingsRoute(routePath: string): boolean {
  return (
    routePath === '/buildings' ||
    routePath === ADMIN_IMAGE_PATH ||
    routePath === '/buildings/import' ||
    routePath === '/building-submissions' ||
    BUILDING_ROUTE_RE.test(routePath) ||
    SUBMISSION_ROUTE_RE.test(routePath)
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
  const building = route.match(BUILDING_ROUTE_RE);
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
  const submission = route.match(SUBMISSION_ROUTE_RE);
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
