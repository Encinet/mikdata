import { DatabaseBusy } from '../db/transaction';
import type { AdminActor } from '../auth/access';
import type { Env } from '../env';
import { ADMIN_IMAGE_PATH, uploadAdminBuildingImage } from './images/admin-upload';
import { adminImageOwner } from './images/keys';
import { MAX_BUILDING_IMAGE_MULTIPART_BYTES } from './images/limits';
import type { AdminBuildingCommand } from './service';
import { BUILDING_ID_PATTERN } from './id';
import { adminBuildings } from './actions';
import { isSameOriginBrowserRequest, json, readLimitedRequestText, requestMediaType, RequestBodyTooLargeError } from '../shared/http';

const MAX_BODY_BYTES = 64 * 1024;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE']);
const BUILDING_ROUTE_RE = new RegExp(`^/buildings/(${BUILDING_ID_PATTERN})$`);
const SUBMISSION_ROUTE_RE = new RegExp(
  `^/building-submissions/(${BUILDING_ID_PATTERN})(?:/(approve|reject))?$`,
);
const error = (message: string, status: number): Response =>
  json({ error: message }, status);

export async function handleAdminBuildingsRoute(
  routePath: string,
  request: Request,
  env: Env,
  actor: AdminActor,
): Promise<Response | null> {
  if (!isAdminBuildingsRoute(routePath)) return null;
  try {
    return await adminRequest(routePath, request, env, actor);
  } catch (cause) {
    if (cause instanceof DatabaseBusy) return error('database_busy', 503);
    if (String(cause).includes('image_unavailable')) return error('image_unavailable', 409);
    console.error('Admin building operation failed', cause);
    return error('internal_error', 500);
  }
}

async function adminRequest(routePath: string, request: Request, env: Env, actor: AdminActor): Promise<Response> {
  if (MUTATING_METHODS.has(request.method) && !isSameOriginBrowserRequest(request))
    return error('forbidden', 403);
  if (routePath === ADMIN_IMAGE_PATH) return adminImage(request, env, actor);
  const target = adminTarget(routePath, request.method);
  if (!target) return error('method not allowed', 405);
  let status: string | undefined;
  if (target.operation === 'listSubmissions') {
    const values = new URL(request.url).searchParams.getAll('status');
    if (values.length > 1) return error('invalid_status', 400);
    status = values.at(0);
  }
  let body: unknown;
  if (request.method === 'POST' || request.method === 'PUT') {
    try {
      const text = await readLimitedRequestText(request, MAX_BODY_BYTES);
      if (requestMediaType(request) !== 'application/json')
        return error('content-type must be application/json', 415);
      body = JSON.parse(text);
    } catch (cause) {
      if (cause instanceof RequestBodyTooLargeError) return error('request body too large', 413);
      return error('invalid JSON body', 400);
    }
  }
  const result = await adminBuildings(env, { ...target, body, ifMatch: request.headers.get('If-Match') ?? undefined,
    draftKey: request.headers.get('X-Building-Draft') ?? undefined, status, actor } as AdminBuildingCommand);
  return json(result.body, result.status);
}

async function adminImage(request: Request, env: Env, actor: AdminActor): Promise<Response> {
  if (request.method !== 'POST') return error('method not allowed', 405);
  const owner = adminImageOwner(actor);
  if (!owner) return error('forbidden', 403);
  const contentType = request.headers.get('Content-Type');
  if (!contentType || requestMediaType(request) !== 'multipart/form-data') return error('multipart_required', 415);
  const length = request.headers.get('Content-Length');
  if (Number(length) > MAX_BUILDING_IMAGE_MULTIPART_BYTES) return error('image_too_large', 413);
  if (!request.body) return error('invalid_image', 422);
  return uploadAdminBuildingImage(request, env, owner);
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
        : method === 'DELETE'
          ? 'deleteBuilding'
          : null;
    return operation ? { operation, id: building[1] } : null;
  }
  const submission = route.match(SUBMISSION_ROUTE_RE);
  if (!submission || method !== 'PUT') return null;
  const action = submission[2];
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
