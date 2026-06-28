import type { Env } from './env';
import { json } from './http';
import { TtlMemoryCache } from './memory-cache';
import type {
  AdminActor,
  Building,
  BuildingInput,
  BuildingSubmission,
  BuildingSubmissionImage,
  Coord,
  I18n,
  Source,
} from './types';
export type {
  AdminActor,
  Building,
  Builder,
  BuildingInput,
  BuildingSubmission,
  BuildingSubmissionImage,
  Coord,
  I18n,
  Source,
} from './types';

type Input = BuildingInput;
type ValidationResult = { ok: true; value: Input } | { ok: false; message: string };

const MAX_BODY_BYTES = 64 * 1024;
const MAX_NAME_LEN = 200;
const MAX_DESC_LEN = 2000;
const MAX_URL_LEN = 500;
const MAX_TAG_LEN = 50;
const MAX_TAGS = 20;
const MAX_IMAGES = 15;
const MAX_BUILDERS = 50;
const MAX_NOTE_LEN = 500;
const ID_RE = /^[a-z0-9]{8,24}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INPUT_FIELDS = [
  'name',
  'description',
  'coordinates',
  'builders',
  'buildType',
  'images',
  'buildDate',
  'tags',
  'source',
] as const;
const VALID_FIELDS = new Set<string>(INPUT_FIELDS);
const BUILDING_KEY_PREFIX = 'building:';
const LEGACY_SUMMARY_KEY = '__summary__';
const SUMMARY_KV_KEY = 'building-summary:v1';
const BUILDINGS_CACHE_VERSION = 'v1';
const SUMMARY_CACHE_KEY = `${BUILDINGS_CACHE_VERSION}:summary`;
const BUILDINGS_CACHE_TTL_SECONDS = 300;
const MAX_IMPORT_ITEMS = 100;
const MAX_PENDING_SUBMISSIONS_PER_PLAYER = 10;
const MAX_SUBMISSION_REVIEW_NOTE_LEN = 500;
const REJECTED_SUBMISSION_RETENTION_DAYS = 14;
const REJECTED_SUBMISSION_RETENTION_MS = REJECTED_SUBMISSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const REJECTED_SUBMISSION_RETENTION_SECONDS = REJECTED_SUBMISSION_RETENTION_DAYS * 24 * 60 * 60;
const SUBMISSION_KEY_PREFIX = 'building-submission:';
const SUBMISSION_PLAYER_INDEX_PREFIX = 'building-submission-player:';
const SUBMISSION_PLAYER_PENDING_INDEX_PREFIX = 'building-submission-player-pending:';
const SUBMISSION_STATUS_INDEX_PREFIX = 'building-submission-status:';
const SUBMISSION_INDEX_READY_KEY = 'building-submission-indexes:v1';
const SUBMISSION_STATUSES: BuildingSubmission['status'][] = ['pending', 'approved', 'rejected'];
const IMGBB_IMAGE_RE = /^https:\/\/i\.ibb\.co\/[^/]+\/[^/?#]+$/;
const PUBLIC_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
} as const;
const BUILDINGS_MEMORY_CACHE_TTL_MS = BUILDINGS_CACHE_TTL_SECONDS * 1000;
const buildingMemoryCache = new TtlMemoryCache<Building>({
  defaultTtlMs: BUILDINGS_MEMORY_CACHE_TTL_MS,
  maxEntries: 512,
});
const buildingListMemoryCache = new TtlMemoryCache<unknown[]>({
  defaultTtlMs: BUILDINGS_MEMORY_CACHE_TTL_MS,
  maxEntries: 128,
});
const summaryMemoryCache = new TtlMemoryCache<Building[]>({
  defaultTtlMs: BUILDINGS_MEMORY_CACHE_TTL_MS,
  maxEntries: 1,
});

export async function handlePublicBuildingsRoute(
  routePath: string,
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (routePath === '/buildings') {
    if (request.method === 'GET') {
      return listBuildings(request, env);
    }

    return methodNotAllowed(request, env);
  }

  const match = routePath.match(/^\/buildings\/([a-z0-9]{8,24})$/i);

  if (!match) {
    return null;
  }

  const id = match[1];

  if (request.method === 'GET') {
    return getBuilding(id, request, env);
  }

  return methodNotAllowed(request, env);
}

export async function handleAdminBuildingsRoute(
  routePath: string,
  request: Request,
  env: Env,
  actor: AdminActor,
): Promise<Response | null> {
  if (
    routePath !== '/buildings' &&
    routePath !== '/buildings/import' &&
    routePath !== '/building-submissions' &&
    routePath !== '/building-submissions/repair-approved'
  ) {
    const match = routePath.match(/^\/buildings\/([a-z0-9]{8,24})$/i);
    const submissionEditMatch = routePath.match(/^\/building-submissions\/([a-z0-9]{8,24})$/i);
    const submissionMatch = routePath.match(
      /^\/building-submissions\/([a-z0-9]{8,24})\/(approve|reject)$/i,
    );

    if (!match && !submissionEditMatch && !submissionMatch) {
      return null;
    }
  }

  const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  if (mutatingMethods.has(request.method)) {
    const authError = authorizeMutation(request, env);
    if (authError) {
      return authError;
    }
  }

  if (isSubmissionRoute(routePath)) {
    return handleSubmissionRoute(routePath, withAdminHeaders(request, actor), env);
  }

  const response = await handleAdminKvBuildingsRoute(routePath, request, env);
  if (response.ok && isMutatingMethod(request.method)) {
    await syncBuildingCachesAfterMutation(routePath, request.method, env, response.clone());
  }
  return response;
}

export async function createPlayerBuildingSubmission(
  request: Request,
  env: Env,
  account: { playerUuid: string; currentName: string; role: string },
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('X-Player-Uuid', account.playerUuid);
  headers.set('X-Player-Name', account.currentName);
  headers.set('X-Player-Role', account.role);
  return handleSubmissionRoute('/building-submissions', new Request(request, { headers }), env);
}

export async function listPlayerBuildingSubmissions(
  request: Request,
  env: Env,
  account: { playerUuid: string },
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('X-Player-Uuid', account.playerUuid);
  return handleSubmissionRoute('/building-submissions/mine', new Request(request, { headers }), env);
}

async function handleSubmissionRoute(routePath: string, request: Request, env: Env): Promise<Response> {
  if (routePath === '/building-submissions') {
    if (request.method === 'GET') {
      return listSubmissions(request, env);
    }
    if (request.method === 'POST') {
      return createSubmission(request, env);
    }
    return methodNotAllowed(request, env);
  }

  if (routePath === '/building-submissions/mine') {
    if (request.method === 'POST') {
      return listMineSubmissions(request, env);
    }
    return methodNotAllowed(request, env);
  }

  if (routePath === '/building-submissions/repair-approved') {
    if (request.method === 'POST') {
      return repairApprovedSubmissions(request, env);
    }
    return methodNotAllowed(request, env);
  }

  const submissionEdit = routePath.match(/^\/building-submissions\/([a-z0-9]{8,24})$/i);
  if (submissionEdit) {
    if (request.method === 'PUT') {
      return updateSubmission(submissionEdit[1], request, env);
    }
    return methodNotAllowed(request, env);
  }

  const submissionAction = routePath.match(/^\/building-submissions\/([a-z0-9]{8,24})\/(approve|reject)$/i);
  if (submissionAction) {
    if (request.method !== 'PUT') {
      return methodNotAllowed(request, env);
    }
    return submissionAction[2] === 'approve'
      ? approveSubmission(submissionAction[1], request, env)
      : rejectSubmission(submissionAction[1], request, env);
  }

  return error('not found', 404, request, env);
}

async function handleAdminKvBuildingsRoute(routePath: string, request: Request, env: Env): Promise<Response> {
  if (routePath === '/buildings') {
    if (request.method === 'GET') {
      const buildings = await readSummaryKvOrRebuild(env);
      return json(buildings, 200, request, env);
    }
    if (request.method === 'POST') {
      return createBuilding(request, env);
    }
    return methodNotAllowed(request, env);
  }

  if (routePath === '/buildings/import') {
    if (request.method === 'POST') {
      return importBuildings(request, env);
    }
    return methodNotAllowed(request, env);
  }

  const match = routePath.match(/^\/buildings\/([a-z0-9]{8,24})$/i);
  if (!match) {
    return error('not found', 404, request, env);
  }

  const id = match[1];
  if (request.method === 'PUT') {
    return replaceBuilding(id, request, env);
  }
  if (request.method === 'PATCH') {
    return patchBuilding(id, request, env);
  }
  if (request.method === 'DELETE') {
    return deleteBuilding(id, request, env);
  }
  return methodNotAllowed(request, env);
}

async function listBuildings(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const tag = params.get('tag');
  const type = params.get('type');
  const builder = params.get('builder');
  const locale = params.get('locale');

  const buildings = await readBuildingsSummary(env);
  const cacheKey = buildingListCacheKey(request, buildings);
  const cached = await readBuildingListCache(cacheKey);

  if (cached) {
    return json(cached, 200, request, env, PUBLIC_CACHE_HEADERS);
  }

  let result = [...buildings];

  if (tag) {
    result = result.filter((building) =>
      building.tags?.some((item) => item['zh-CN'] === tag || item.en === tag),
    );
  }

  if (type) {
    result = result.filter((building) => building.buildType === type);
  }

  if (builder) {
    result = result.filter((building) =>
      building.builders.some((item) => item.name === builder || item.uuid === builder),
    );
  }

  result.sort((a, b) => b.buildDate.localeCompare(a.buildDate));

  const body = locale ? result.map((building) => localizeBuilding(building, locale)) : result;
  await writeBuildingListCache(cacheKey, body);
  return json(body, 200, request, env, PUBLIC_CACHE_HEADERS);
}

async function getBuilding(id: string, request: Request, env: Env): Promise<Response> {
  const cached = await readCachedBuilding(id);

  if (cached) {
    return json(cached, 200, request, env, PUBLIC_CACHE_HEADERS);
  }

  const buildings = await readBuildingsSummary(env);
  const building = buildings.find((item) => item.id === id);

  if (!building) {
    return error('building not found', 404, request, env);
  }

  await writeBuildingCache(building);
  return json(building, 200, request, env, PUBLIC_CACHE_HEADERS);
}

async function createBuilding(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readBody(request, env);

  if (!body.ok) {
    return body.response;
  }

  const validation = validateBuildingInput(body.data);

  if (!validation.ok) {
    return error(validation.message, 422, request, env);
  }

  const duplicateId = await findDuplicateBuildingId(env, validation.value);

  if (duplicateId) {
    return error(`duplicate building: ${duplicateId}`, 409, request, env);
  }

  const now = new Date().toISOString();
  const building: Building = {
    id: await createBuildingId(env),
    ...validation.value,
    createdAt: now,
    updatedAt: now,
  };

  await writeBuilding(env, building);
  await rebuildBuildingsSummary(env);
  auditBuildingMutation('create', building.id, request);

  return json(building, 201, request, env);
}

async function replaceBuilding(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const existing = await buildingsKv(env).get(buildingKey(id));

  if (!existing) {
    return error('building not found', 404, request, env);
  }

  const body = await readBody(request, env);

  if (!body.ok) {
    return body.response;
  }

  const validation = validateBuildingInput(body.data);

  if (!validation.ok) {
    return error(validation.message, 422, request, env);
  }

  const previous = parseBuilding(existing, id);

  if (!previous) {
    return error('building record is corrupt', 500, request, env);
  }

  const building: Building = {
    id,
    ...validation.value,
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
  };

  await writeBuilding(env, building);
  await rebuildBuildingsSummary(env);
  auditBuildingMutation('replace', id, request);
  return json(building, 200, request, env);
}

async function patchBuilding(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const raw = await buildingsKv(env).get(buildingKey(id));

  if (!raw) {
    return error('building not found', 404, request, env);
  }

  const body = await readBody(request, env);

  if (!body.ok) {
    return body.response;
  }

  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    return error('body must be a JSON object', 400, request, env);
  }

  const patch = body.data as Record<string, unknown>;

  for (const key of Object.keys(patch)) {
    if (!VALID_FIELDS.has(key)) {
      return error(`unknown field: ${key}`, 422, request, env);
    }
  }

  const previous = parseBuilding(raw, id);

  if (!previous) {
    return error('building record is corrupt', 500, request, env);
  }

  const merged: Record<string, unknown> = { ...previous };

  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];

    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      merged[key] = { ...(current as object), ...(value as object) };
    } else {
      merged[key] = value;
    }
  }

  const validation = validateBuildingInput(merged);

  if (!validation.ok) {
    return error(`patch produces invalid document: ${validation.message}`, 422, request, env);
  }

  const building: Building = {
    id,
    ...validation.value,
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
  };

  await writeBuilding(env, building);
  await rebuildBuildingsSummary(env);
  auditBuildingMutation('patch', id, request);
  return json(building, 200, request, env);
}

async function deleteBuilding(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  if (!(await buildingsKv(env).get(buildingKey(id)))) {
    return error('building not found', 404, request, env);
  }

  await buildingsKv(env).delete(buildingKey(id));
  await rebuildBuildingsSummary(env);
  auditBuildingMutation('delete', id, request);

  return json({ deleted: id }, 200, request, env);
}

async function importBuildings(
  request: Request,
  env: Env,
): Promise<Response> {
  const inputs = await readImportInputs(request, env);

  if (!inputs.ok) {
    return inputs.response;
  }

  const validation = validateImportInputs(inputs.value, env);

  if (!validation.ok) {
    return error(validation.message, 422, request, env);
  }

  const existing = await readAllBuildings(env);
  const duplicate = findDuplicateInput(validation.value, existing);

  if (duplicate) {
    return error(`duplicate building: ${duplicate}`, 409, request, env);
  }

  const now = new Date().toISOString();
  const buildings: Building[] = [];

  for (const input of validation.value) {
    buildings.push({
      id: await createBuildingId(env),
      ...input,
      createdAt: now,
      updatedAt: now,
    });
  }

  await Promise.all(buildings.map((building) => writeBuilding(env, building)));
  await rebuildBuildingsSummary(env);

  for (const building of buildings) {
    auditBuildingMutation('import', building.id, request);
  }

  return json({ imported: buildings.length, buildings }, 201, request, env);
}

async function createSubmission(
  request: Request,
  env: Env,
): Promise<Response> {
  const submitterUuid = request.headers.get('X-Player-Uuid') ?? '';
  const submitterName = request.headers.get('X-Player-Name') ?? '';
  const submitterRole = request.headers.get('X-Player-Role') ?? '';

  if (!UUID_RE.test(submitterUuid) || !submitterName || !submitterRole) {
    return error('unauthenticated', 401, request, env);
  }

  const pendingCount = await countPlayerPendingSubmissions(env, submitterUuid);
  if (pendingCount >= MAX_PENDING_SUBMISSIONS_PER_PLAYER) {
    return json(
      { error: 'pending_limit_reached', limit: MAX_PENDING_SUBMISSIONS_PER_PLAYER },
      429,
      request,
      env,
    );
  }

  const body = await readBody(request, env);
  if (!body.ok) {
    return body.response;
  }
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    return error('body must be a JSON object', 400, request, env);
  }

  const data = body.data as Record<string, unknown>;
  const validation = validateBuildingInput(data.payload);
  if (!validation.ok) {
    return error(validation.message, 422, request, env);
  }

  const images = validateSubmissionImages(data.images, validation.value.images);
  if (!images.ok) {
    return error(images.message, 422, request, env);
  }

  const submitterBuilder = validation.value.builders.find((builder) => builder.uuid === submitterUuid.toLowerCase());
  if (!submitterBuilder) {
    validation.value.builders.unshift({
      uuid: submitterUuid.toLowerCase(),
      name: submitterName,
      weight: 100,
    });
  }

  if (!validation.value.images.every((url) => IMGBB_IMAGE_RE.test(url))) {
    return error('images must be uploaded through the image uploader', 422, request, env);
  }

  const now = new Date().toISOString();
  const submission: BuildingSubmission = {
    id: await createSubmissionId(env),
    status: 'pending',
    submitterUuid: submitterUuid.toLowerCase(),
    submitterName,
    submitterRole,
    payload: validation.value,
    images: images.value,
    createdAt: now,
    updatedAt: now,
  };

  await Promise.all([
    writeSubmission(env, submission),
    ...writeSubmissionIndexes(env, submission),
  ]);
  return json({ submission }, 201, request, env);
}

async function listMineSubmissions(
  request: Request,
  env: Env,
): Promise<Response> {
  const playerUuid = request.headers.get('X-Player-Uuid') ?? '';
  if (!UUID_RE.test(playerUuid)) {
    return error('unauthenticated', 401, request, env);
  }

  return json({ submissions: await listPlayerSubmissions(env, playerUuid.toLowerCase()) }, 200, request, env);
}

async function listSubmissions(
  request: Request,
  env: Env,
): Promise<Response> {
  await ensureSubmissionIndexes(env);
  const statusKeys = await Promise.all(
    SUBMISSION_STATUSES.map(async (status) => ({
      status,
      keys: await listKvKeys(env, submissionStatusPrefix(status)),
    })),
  );
  const submissions = await Promise.all(
    statusKeys.flatMap(({ keys, status }) =>
      keys.map(async (key) => {
        const submission = await readSubmission(env, key.slice(submissionStatusPrefix(status).length));
        if (!submission) {
          await buildingsKv(env).delete(key);
          return null;
        }
        if (submission.status !== status) {
          await buildingsKv(env).delete(key);
        }
        if (isExpiredRejectedSubmission(submission)) {
          await deleteSubmission(env, submission);
          return null;
        }
        return submission;
      }),
    ),
  );
  const byId = new Map<string, BuildingSubmission>();
  for (const submission of submissions) {
    if (submission) {
      byId.set(submission.id, submission);
    }
  }
  const sorted = [...byId.values()]
    .filter((submission): submission is BuildingSubmission => !!submission)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json({ submissions: sorted }, 200, request, env);
}
async function approveSubmission(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const submission = await readSubmission(env, id);
  if (!submission) {
    return error('submission not found', 404, request, env);
  }
  if (submission.status !== 'pending') {
    return error('submission is not pending', 409, request, env);
  }

  const body = await readJsonBodyObject(request);
  let payload = submission.payload;
  let images = submission.images;
  if (body.payload !== undefined || body.images !== undefined) {
    const validation = validateBuildingInput(body.payload ?? submission.payload);
    if (!validation.ok) {
      return error(validation.message, 422, request, env);
    }
    const imageValidation = validateSubmissionImages(body.images ?? submission.images, validation.value.images);
    if (!imageValidation.ok) {
      return error(imageValidation.message, 422, request, env);
    }
    if (!validation.value.images.every((url) => IMGBB_IMAGE_RE.test(url))) {
      return error('images must be uploaded through the image uploader', 422, request, env);
    }
    payload = validation.value;
    images = imageValidation.value;
  }

  const duplicateId = await findDuplicateBuildingId(env, payload);
  if (duplicateId) {
    return error(`duplicate building: ${duplicateId}`, 409, request, env);
  }

  const now = new Date().toISOString();
  const building: Building = {
    id: await createBuildingId(env),
    ...payload,
    createdAt: now,
    updatedAt: now,
  };

  submission.status = 'approved';
  submission.reviewer = adminActorLabel(request);
  submission.reviewNote = optionalReviewNote(body.reviewNote);
  submission.payload = payload;
  submission.images = images;
  submission.buildingId = building.id;
  submission.updatedAt = now;

  await writeBuilding(env, building);
  await writeApprovedSubmission(env, submission);
  await rebuildBuildingsSummary(env);
  await writeBuildingCache(building);
  auditBuildingMutation('approve-submission', building.id, request);
  return json({ submission, building }, 200, request, env);
}

async function repairApprovedSubmissions(
  request: Request,
  env: Env,
): Promise<Response> {
  await ensureSubmissionIndexes(env);

  const keys = await listKvKeys(env, submissionStatusPrefix('approved'));
  const existingBuildings = await readAllBuildings(env);
  const buildingsById = new Map(existingBuildings.map((building) => [building.id, building]));
  const changedBuildings: Building[] = [];
  const results: {
    submissionId: string;
    action: 'created' | 'restored' | 'linked' | 'skipped' | 'removed-index' | 'failed';
    buildingId?: string;
    reason?: string;
  }[] = [];

  let created = 0;
  let restored = 0;
  let linked = 0;
  let skipped = 0;
  let removedIndexes = 0;
  let failed = 0;

  for (const key of keys) {
    const submissionId = key.slice(submissionStatusPrefix('approved').length);
    const submission = await readSubmission(env, submissionId);

    if (!submission) {
      await buildingsKv(env).delete(key);
      removedIndexes += 1;
      results.push({ submissionId, action: 'removed-index', reason: 'submission not found' });
      continue;
    }

    if (submission.status !== 'approved') {
      await buildingsKv(env).delete(key);
      removedIndexes += 1;
      results.push({ submissionId, action: 'removed-index', reason: `status is ${submission.status}` });
      continue;
    }

    const validation = validateBuildingInput(submission.payload);
    if (!validation.ok) {
      failed += 1;
      results.push({ submissionId, action: 'failed', reason: validation.message });
      continue;
    }

    const payload = validation.value;
    const existingId =
      typeof submission.buildingId === 'string' && isValidBuildingId(submission.buildingId)
        ? submission.buildingId
        : null;

    if (existingId && buildingsById.has(existingId)) {
      skipped += 1;
      results.push({ submissionId, action: 'skipped', buildingId: existingId });
      continue;
    }

    const duplicateId = findDuplicateBuildingIdInList(existingBuildings, payload);
    if (duplicateId && duplicateId !== existingId) {
      submission.payload = payload;
      submission.buildingId = duplicateId;
      await writeApprovedSubmission(env, submission);
      linked += 1;
      results.push({ submissionId, action: 'linked', buildingId: duplicateId });
      continue;
    }

    const now = submission.updatedAt || submission.createdAt || new Date().toISOString();
    const building: Building = {
      id: existingId ?? (await createBuildingId(env)),
      ...payload,
      createdAt: now,
      updatedAt: now,
    };

    submission.payload = payload;
    submission.buildingId = building.id;
    await Promise.all([writeBuilding(env, building), writeApprovedSubmission(env, submission)]);

    existingBuildings.push(building);
    buildingsById.set(building.id, building);
    changedBuildings.push(building);

    if (existingId) {
      restored += 1;
      results.push({ submissionId, action: 'restored', buildingId: building.id });
    } else {
      created += 1;
      results.push({ submissionId, action: 'created', buildingId: building.id });
    }
  }

  if (changedBuildings.length > 0 || linked > 0 || removedIndexes > 0) {
    await rebuildBuildingsSummary(env);
    await Promise.all(changedBuildings.map(writeBuildingCache));
  }

  return json(
    {
      scanned: keys.length,
      created,
      restored,
      linked,
      skipped,
      removedIndexes,
      failed,
      results,
    },
    200,
    request,
    env,
  );
}

async function updateSubmission(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const submission = await readSubmission(env, id);
  if (!submission) {
    return error('submission not found', 404, request, env);
  }
  if (submission.status !== 'pending') {
    return error('submission is not pending', 409, request, env);
  }

  const body = await readJsonBodyObject(request);
  const validation = validateBuildingInput(body.payload);
  if (!validation.ok) {
    return error(validation.message, 422, request, env);
  }

  const images = validateSubmissionImages(body.images, validation.value.images);
  if (!images.ok) {
    return error(images.message, 422, request, env);
  }

  if (!validation.value.images.every((url) => IMGBB_IMAGE_RE.test(url))) {
    return error('images must be uploaded through the image uploader', 422, request, env);
  }

  submission.payload = validation.value;
  submission.images = images.value;
  submission.reviewer = adminActorLabel(request);
  submission.reviewNote = optionalReviewNote(body.reviewNote);
  submission.updatedAt = new Date().toISOString();
  await writeSubmission(env, submission);
  return json({ submission }, 200, request, env);
}

async function rejectSubmission(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const submission = await readSubmission(env, id);
  if (!submission) {
    return error('submission not found', 404, request, env);
  }
  if (submission.status !== 'pending') {
    return error('submission is not pending', 409, request, env);
  }

  const body = await readJsonBodyObject(request);
  const note = optionalReviewNote(body.reviewNote);
  if (!note) {
    return error('reviewNote is required', 422, request, env);
  }

  const now = new Date();
  submission.status = 'rejected';
  submission.reviewer = adminActorLabel(request);
  submission.reviewNote = note;
  submission.rejectedAt = now.toISOString();
  submission.expiresAt = new Date(now.getTime() + REJECTED_SUBMISSION_RETENTION_MS).toISOString();
  submission.updatedAt = submission.rejectedAt;
  await writeRejectedSubmission(env, submission);
  return json({ submission }, 200, request, env);
}

async function readBody(
  request: Request,
  env: Env,
): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  const contentType = request.headers.get('content-type') ?? '';

  if (!contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      response: error('content-type must be application/json', 415, request, env),
    };
  }

  const contentLength = request.headers.get('content-length');

  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return { ok: false, response: error('request body too large', 413, request, env) };
  }

  try {
    const text = await request.text();

    if (text.length > MAX_BODY_BYTES) {
      return { ok: false, response: error('request body too large', 413, request, env) };
    }

    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, response: error('invalid JSON body', 400, request, env) };
  }
}

async function readJsonBodyObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return {};
  }
  const body = await request.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function validateSubmissionImages(
  raw: unknown,
  urls: string[],
): { ok: true; value: BuildingSubmissionImage[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'images metadata must be an array' };
  }
  if (raw.length !== urls.length) {
    return { ok: false, message: 'images metadata does not match payload images' };
  }

  const images: BuildingSubmissionImage[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `images[${index}] metadata must be an object` };
    }
    const value = item as Record<string, unknown>;
    if (value.url !== urls[index] || typeof value.url !== 'string' || !IMGBB_IMAGE_RE.test(value.url)) {
      return { ok: false, message: `images[${index}].url must be an uploaded image URL` };
    }
    if (!Number.isFinite(value.width) || !Number.isFinite(value.height) || !Number.isFinite(value.size)) {
      return { ok: false, message: `images[${index}] dimensions and size are required` };
    }
    if (typeof value.mime !== 'string' || value.mime !== 'image/webp') {
      return { ok: false, message: `images[${index}].mime must be image/webp` };
    }
    images.push({
      url: value.url,
      width: value.width as number,
      height: value.height as number,
      size: value.size as number,
      mime: value.mime,
    });
  }
  return { ok: true, value: images };
}

async function listPlayerSubmissions(
  env: Env,
  playerUuid: string,
  status?: BuildingSubmission['status'],
): Promise<BuildingSubmission[]> {
  const prefix =
    status === 'pending'
      ? playerPendingSubmissionPrefix(playerUuid.toLowerCase())
      : playerSubmissionPrefix(playerUuid.toLowerCase());
  const keys = await listKvKeys(env, prefix);
  const submissions = await Promise.all(
    keys.map(async (key) => {
      const submission = await readSubmission(env, key.slice(prefix.length));
      if (!submission) {
        await buildingsKv(env).delete(key);
        return null;
      }
      if (isExpiredRejectedSubmission(submission)) {
        await deleteSubmission(env, submission);
        return null;
      }
      if (status && submission.status !== status) {
        await buildingsKv(env).delete(key);
        return null;
      }
      return submission;
    }),
  );
  return submissions
    .filter((submission): submission is BuildingSubmission => !!submission)
    .filter((submission) => !status || submission.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function countPlayerPendingSubmissions(env: Env, playerUuid: string): Promise<number> {
  await ensureSubmissionIndexes(env);
  return (await listPlayerSubmissions(env, playerUuid.toLowerCase(), 'pending')).length;
}

async function createSubmissionId(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 16);
    if (!(await readSubmission(env, id))) {
      return id;
    }
  }
  throw new Error('Could not allocate submission id');
}

function optionalReviewNote(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const note = value.trim();
  return note ? note.slice(0, MAX_SUBMISSION_REVIEW_NOTE_LEN) : undefined;
}

function adminActorLabel(request: Request): string {
  return request.headers.get('X-Admin-Email') ?? request.headers.get('X-Admin-Subject') ?? 'admin';
}

export function validateBuildingInput(data: unknown): ValidationResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, message: 'body must be a JSON object' };
  }

  const building = data as Record<string, unknown>;
  const unknownField = findUnknownField(building, VALID_FIELDS);

  if (unknownField) {
    return { ok: false, message: `unknown field: ${unknownField}` };
  }

  for (const key of ['name', 'description'] as const) {
    const value = building[key];

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, message: `${key} must be an object` };
    }

    const i18n = value as Record<string, unknown>;

    if (typeof i18n['zh-CN'] !== 'string' || !i18n['zh-CN'].trim()) {
      return { ok: false, message: `${key}['zh-CN'] is required` };
    }

    if (typeof i18n.en !== 'string' || !i18n.en.trim()) {
      return { ok: false, message: `${key}.en is required` };
    }

    const limit = key === 'name' ? MAX_NAME_LEN : MAX_DESC_LEN;

    if ((i18n['zh-CN'] as string).length > limit || (i18n.en as string).length > limit) {
      return { ok: false, message: `${key} exceeds max length ${limit}` };
    }
  }

  const coordinates = building.coordinates;

  if (!coordinates || typeof coordinates !== 'object' || Array.isArray(coordinates)) {
    return { ok: false, message: 'coordinates must be an object' };
  }

  const coord = coordinates as Record<string, unknown>;

  if (!Number.isFinite(coord.x) || !Number.isFinite(coord.y) || !Number.isFinite(coord.z)) {
    return { ok: false, message: 'coordinates x, y, z must be finite numbers' };
  }

  if (!Array.isArray(building.builders) || building.builders.length === 0) {
    return { ok: false, message: 'builders must be a non-empty array' };
  }

  if (building.builders.length > MAX_BUILDERS) {
    return { ok: false, message: `builders exceeds max count ${MAX_BUILDERS}` };
  }

  for (let index = 0; index < building.builders.length; index += 1) {
    const builder = building.builders[index];

    if (!builder || typeof builder !== 'object') {
      return { ok: false, message: `builders[${index}] must be an object` };
    }

    const value = builder as Record<string, unknown>;

    if (typeof value.name !== 'string' || !value.name.trim()) {
      return { ok: false, message: `builders[${index}].name is required` };
    }

    if (typeof value.uuid !== 'string' || !UUID_RE.test(value.uuid)) {
      return { ok: false, message: `builders[${index}].uuid must be a valid UUID` };
    }

    if (!Number.isFinite(value.weight) || (value.weight as number) < 0) {
      return { ok: false, message: `builders[${index}].weight must be a non-negative number` };
    }
  }

  if (!['original', 'derivative', 'replica'].includes(building.buildType as string)) {
    return { ok: false, message: 'buildType must be original | derivative | replica' };
  }

  if (!Array.isArray(building.images) || building.images.length === 0) {
    return { ok: false, message: 'images must be a non-empty array' };
  }

  if (building.images.length > MAX_IMAGES) {
    return { ok: false, message: `images exceeds max count ${MAX_IMAGES}` };
  }

  for (let index = 0; index < building.images.length; index += 1) {
    const image = building.images[index];

    if (typeof image !== 'string') {
      return { ok: false, message: `images[${index}] must be a string` };
    }

    if (image.length > MAX_URL_LEN) {
      return { ok: false, message: `images[${index}] exceeds max length ${MAX_URL_LEN}` };
    }

    if (!isAllowedImageUrl(image)) {
      return {
        ok: false,
        message: `images[${index}] must be a /path or https:// URL`,
      };
    }
  }

  if (
    typeof building.buildDate !== 'string' ||
    !DATE_RE.test(building.buildDate.trim()) ||
    !isRealDate(building.buildDate.trim())
  ) {
    return { ok: false, message: 'buildDate must be YYYY-MM-DD format' };
  }

  if (building.tags !== undefined) {
    if (!Array.isArray(building.tags)) {
      return { ok: false, message: 'tags must be an array' };
    }

    if (building.tags.length > MAX_TAGS) {
      return { ok: false, message: `tags exceeds max count ${MAX_TAGS}` };
    }

    for (let index = 0; index < building.tags.length; index += 1) {
      const tag = building.tags[index];

      if (!tag || typeof tag !== 'object' || Array.isArray(tag)) {
        return { ok: false, message: `tags[${index}] must be an I18n object` };
      }

      const value = tag as Record<string, unknown>;

      for (const lang of ['zh-CN', 'en']) {
        if (value[lang] !== undefined) {
          if (typeof value[lang] !== 'string') {
            return { ok: false, message: `tags[${index}].${lang} must be a string` };
          }

          if ((value[lang] as string).length > MAX_TAG_LEN) {
            return {
              ok: false,
              message: `tags[${index}].${lang} exceeds max length ${MAX_TAG_LEN}`,
            };
          }
        }
      }

      if (!value['zh-CN'] && !value.en) {
        return { ok: false, message: `tags[${index}] must have at least one language` };
      }
    }
  }

  if (building.source != null) {
    if (typeof building.source !== 'object' || Array.isArray(building.source)) {
      return { ok: false, message: 'source must be an object or null' };
    }

    const source = building.source as Record<string, unknown>;

    if (source.originalAuthor !== undefined && typeof source.originalAuthor !== 'string') {
      return { ok: false, message: 'source.originalAuthor must be a string' };
    }

    if (
      typeof source.originalAuthor === 'string' &&
      source.originalAuthor.length > MAX_NAME_LEN
    ) {
      return { ok: false, message: `source.originalAuthor exceeds max length ${MAX_NAME_LEN}` };
    }

    if (source.originalLink !== undefined && typeof source.originalLink !== 'string') {
      return { ok: false, message: 'source.originalLink must be a string' };
    }

    if (typeof source.originalLink === 'string' && source.originalLink.length > MAX_URL_LEN) {
      return { ok: false, message: `source.originalLink exceeds max length ${MAX_URL_LEN}` };
    }

    if (source.originalLink && !isHttpUrl(source.originalLink)) {
      return { ok: false, message: 'source.originalLink must be a valid http/https URL' };
    }

    if (source.notes != null) {
      if (typeof source.notes !== 'object' || Array.isArray(source.notes)) {
        return { ok: false, message: 'source.notes must be an object or null' };
      }

      const notes = source.notes as Record<string, unknown>;

      for (const lang of ['zh-CN', 'en']) {
        if (notes[lang] !== undefined) {
          if (typeof notes[lang] !== 'string') {
            return { ok: false, message: `source.notes.${lang} must be a string` };
          }

          if ((notes[lang] as string).length > MAX_NOTE_LEN) {
            return {
              ok: false,
              message: `source.notes.${lang} exceeds max length ${MAX_NOTE_LEN}`,
            };
          }
        }
      }
    }
  }

  return { ok: true, value: normalizeInput(building) };
}

function normalizeInput(building: Record<string, unknown>): Input {
  const source = building.source as Record<string, unknown> | null | undefined;
  const normalized: Input = {
    name: normalizeI18n(building.name as Record<string, unknown>),
    description: normalizeI18n(building.description as Record<string, unknown>),
    coordinates: normalizeCoordinates(building.coordinates as Record<string, unknown>),
    builders: (building.builders as Record<string, unknown>[]).map((builder) => ({
      name: (builder.name as string).trim(),
      uuid: (builder.uuid as string).toLowerCase(),
      weight: builder.weight as number,
    })),
    buildType: building.buildType as Input['buildType'],
    images: (building.images as string[]).map((image) => image.trim()),
    buildDate: (building.buildDate as string).trim(),
  };

  if (building.tags !== undefined) {
    normalized.tags = (building.tags as Record<string, unknown>[]).map(normalizeI18n);
  }

  if (building.source !== undefined) {
    normalized.source =
      source === null
        ? null
        : {
            originalAuthor:
              typeof source?.originalAuthor === 'string'
                ? source.originalAuthor.trim()
                : undefined,
            originalLink:
              typeof source?.originalLink === 'string' ? source.originalLink.trim() : undefined,
            notes:
              source?.notes && typeof source.notes === 'object' && !Array.isArray(source.notes)
                ? normalizeI18n(source.notes as Record<string, unknown>)
                : undefined,
          };
  }

  return normalized;
}

function normalizeI18n(value: Record<string, unknown>): I18n {
  return {
    'zh-CN': typeof value['zh-CN'] === 'string' ? value['zh-CN'].trim() : '',
    en: typeof value.en === 'string' ? value.en.trim() : '',
  };
}

function normalizeCoordinates(value: Record<string, unknown>): Coord {
  return {
    x: value.x as number,
    y: value.y as number,
    z: value.z as number,
  };
}

function findUnknownField(data: Record<string, unknown>, allowedFields: Set<string>): string | null {
  return Object.keys(data).find((key) => !allowedFields.has(key)) ?? null;
}

function isAllowedImageUrl(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return true;
  }

  return trimmed.startsWith('https://') && isHttpUrl(trimmed);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function readAllBuildings(env: Env): Promise<Building[]> {
  const ids = await listBuildingIds(env);
  const buildings = await Promise.all(
    ids.map(async (id) => {
      const raw = await buildingsKv(env).get(buildingKey(id));

      if (!raw) {
        return null;
      }

      return parseBuilding(raw, id);
    }),
  );

  return buildings.filter(isBuilding);
}

async function readBuildingsSummary(env: Env): Promise<Building[]> {
  const memorySummary = summaryMemoryCache.get(SUMMARY_CACHE_KEY);

  if (memorySummary) {
    return memorySummary;
  }

  const cached = await readCachedSummary();

  if (cached) {
    return cached;
  }

  const snapshot = await readSummaryFromKv(env);

  if (snapshot) {
    await writeSummaryCache(snapshot);
    return snapshot;
  }

  const buildings = await readAllBuildings(env);
  buildings.sort(compareBuildingsForSummary);
  await writeSummaryKv(env, buildings);
  await writeSummaryCache(buildings);
  return buildings;
}

async function rebuildBuildingsSummary(env: Env): Promise<Building[]> {
  const buildings = await readAllBuildings(env);
  buildings.sort(compareBuildingsForSummary);
  await writeSummaryKv(env, buildings);
  await writeSummaryCache(buildings);
  return buildings;
}

async function readSummaryKvOrRebuild(env: Env): Promise<Building[]> {
  const stored = await readSummaryFromKv(env);

  if (stored) {
    return stored;
  }

  return rebuildBuildingsSummary(env);
}

async function readSummaryFromKv(env: Env): Promise<Building[] | null> {
  const raw = await buildingsKv(env).get(SUMMARY_KV_KEY);

  if (raw) {
    try {
      return normalizeSummary(JSON.parse(raw) as unknown);
    } catch (error) {
      console.warn('Building summary snapshot is corrupt', error);
    }
  }

  const legacy = await readLegacySummary(env);
  if (legacy) {
    await writeSummaryKv(env, legacy);
    return legacy;
  }

  return null;
}

async function readLegacySummary(env: Env): Promise<Building[] | null> {
  const raw = await buildingsKv(env).get(LEGACY_SUMMARY_KEY);

  if (!raw) {
    return null;
  }

  try {
    return normalizeSummary(JSON.parse(raw) as unknown);
  } catch (error) {
    console.warn('Legacy building summary is corrupt', error);
    return null;
  }
}

async function writeSummaryKv(env: Env, buildings: Building[]): Promise<void> {
  await buildingsKv(env).put(SUMMARY_KV_KEY, JSON.stringify(buildings));
}

function normalizeSummary(value: unknown): Building[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const buildings = value.filter(isBuildingDocument);
  buildings.sort(compareBuildingsForSummary);
  return buildings;
}

function compareBuildingsForSummary(a: Building, b: Building): number {
  return b.buildDate.localeCompare(a.buildDate);
}

function parseBuilding(raw: string, id: string): Building | null {
  try {
    const building = JSON.parse(raw) as unknown;

    if (!building || typeof building !== 'object' || Array.isArray(building)) {
      throw new Error('record is not an object');
    }

    return building as Building;
  } catch (error) {
    console.warn('Skipping corrupt building record', id, error);
    return null;
  }
}

function isBuilding(building: Building | null): building is Building {
  return building !== null;
}

function isUnknownBuilding(building: unknown): building is Building {
  return Boolean(building && typeof building === 'object' && !Array.isArray(building));
}

function isBuildingDocument(building: unknown): building is Building {
  if (!isUnknownBuilding(building)) {
    return false;
  }

  return typeof building.id === 'string' && isValidBuildingId(building.id);
}

function isBuildingSubmission(value: unknown): value is BuildingSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const submission = value as Partial<BuildingSubmission>;
  return (
    typeof submission.id === 'string' &&
    isValidBuildingId(submission.id) &&
    (submission.status === 'pending' ||
      submission.status === 'approved' ||
      submission.status === 'rejected') &&
    typeof submission.submitterUuid === 'string' &&
    UUID_RE.test(submission.submitterUuid) &&
    typeof submission.submitterName === 'string' &&
    isUnknownBuilding(submission.payload)
  );
}

async function findDuplicateBuildingId(env: Env, input: Input): Promise<string | null> {
  return findDuplicateBuildingIdInList(await readAllBuildings(env), input);
}

function findDuplicateBuildingIdInList(buildings: (Input | Building)[], input: Input): string | null {
  for (const building of buildings) {
    if ('id' in building && isDuplicateBuilding(building, input)) {
      return building.id;
    }
  }

  return null;
}

function findDuplicateInput(inputs: Input[], existing: Building[]): string | null {
  for (const building of existing) {
    for (const input of inputs) {
      if (isDuplicateBuilding(building, input)) {
        return building.id;
      }
    }
  }

  for (let index = 0; index < inputs.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < inputs.length; nextIndex += 1) {
      if (isDuplicateBuilding(inputs[index], inputs[nextIndex])) {
        return `import item ${index + 1}`;
      }
    }
  }

  return null;
}

function isDuplicateBuilding(left: Input | Building, right: Input | Building): boolean {
  return (
    (left.name['zh-CN'] === right.name['zh-CN'] || left.name.en === right.name.en) &&
    left.buildDate === right.buildDate &&
    left.builders[0]?.uuid === right.builders[0]?.uuid
  );
}

async function createBuildingId(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 16);

    if (!(await buildingsKv(env).get(buildingKey(id)))) {
      return id;
    }
  }

  throw new Error('Could not allocate building id');
}

function localizeBuilding(building: Building, locale: string): Omit<Building, 'name' | 'description' | 'tags' | 'source'> & {
  name: string;
  description: string;
  tags?: (string | undefined)[];
  source?: (Omit<Source, 'notes'> & { notes?: string }) | null;
} {
  return {
    ...building,
    name: building.name[locale] ?? building.name.en,
    description: building.description[locale] ?? building.description.en,
    tags: building.tags?.map((tag) => tag[locale] ?? tag['zh-CN'] ?? tag.en),
    source: building.source
      ? {
          ...building.source,
          notes: building.source.notes
            ? (building.source.notes[locale] ?? building.source.notes.en)
            : undefined,
        }
      : building.source,
  };
}

async function listBuildingIds(env: Env): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await buildingsKv(env).list({ prefix: BUILDING_KEY_PREFIX, cursor });

    for (const key of page.keys) {
      const id = key.name.slice(BUILDING_KEY_PREFIX.length);

      if (isValidBuildingId(id)) {
        ids.push(id);
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return [...new Set(ids)];
}

function buildingsKv(env: Env): KVNamespace {
  return env.BUILDINGS_KV;
}

function buildingKey(id: string): string {
  return `${BUILDING_KEY_PREFIX}${id}`;
}

function submissionKey(id: string): string {
  return `${SUBMISSION_KEY_PREFIX}${id}`;
}

function playerSubmissionPrefix(playerUuid: string): string {
  return `${SUBMISSION_PLAYER_INDEX_PREFIX}${playerUuid}:`;
}

function playerSubmissionKey(playerUuid: string, submissionId: string): string {
  return `${playerSubmissionPrefix(playerUuid)}${submissionId}`;
}

function playerPendingSubmissionPrefix(playerUuid: string): string {
  return `${SUBMISSION_PLAYER_PENDING_INDEX_PREFIX}${playerUuid}:`;
}

function playerPendingSubmissionKey(playerUuid: string, submissionId: string): string {
  return `${playerPendingSubmissionPrefix(playerUuid)}${submissionId}`;
}

function submissionStatusPrefix(status: BuildingSubmission['status']): string {
  return `${SUBMISSION_STATUS_INDEX_PREFIX}${status}:`;
}

function submissionStatusKey(status: BuildingSubmission['status'], submissionId: string): string {
  return `${submissionStatusPrefix(status)}${submissionId}`;
}

function writeBuilding(env: Env, building: Building): Promise<void> {
  return buildingsKv(env).put(buildingKey(building.id), JSON.stringify(building));
}

async function readSubmission(env: Env, id: string): Promise<BuildingSubmission | null> {
  return readSubmissionByKey(env, submissionKey(id));
}

async function readSubmissionByKey(env: Env, key: string): Promise<BuildingSubmission | null> {
  const raw = await buildingsKv(env).get(key);
  if (!raw) {
    return null;
  }

  try {
    const value = JSON.parse(raw) as unknown;
    return isBuildingSubmission(value) ? value : null;
  } catch {
    return null;
  }
}

function writeSubmission(env: Env, submission: BuildingSubmission): Promise<void> {
  return buildingsKv(env).put(submissionKey(submission.id), JSON.stringify(submission));
}

function writeApprovedSubmission(env: Env, submission: BuildingSubmission): Promise<void[]> {
  return Promise.all([
    writeSubmission(env, submission),
    buildingsKv(env).delete(playerPendingSubmissionKey(submission.submitterUuid.toLowerCase(), submission.id)),
    buildingsKv(env).delete(submissionStatusKey('pending', submission.id)),
    ...writeSubmissionIndexes(env, submission),
  ]);
}

function writeRejectedSubmission(
  env: Env,
  submission: BuildingSubmission,
  expirationTtl = REJECTED_SUBMISSION_RETENTION_SECONDS,
): Promise<void[]> {
  return Promise.all([
    buildingsKv(env).put(submissionKey(submission.id), JSON.stringify(submission), {
      expirationTtl,
    }),
    buildingsKv(env).delete(playerPendingSubmissionKey(submission.submitterUuid.toLowerCase(), submission.id)),
    buildingsKv(env).delete(submissionStatusKey('pending', submission.id)),
    ...writeSubmissionIndexes(env, submission, expirationTtl),
  ]);
}

function writeSubmissionIndexes(
  env: Env,
  submission: BuildingSubmission,
  expirationTtl?: number,
): Promise<void>[] {
  const playerUuid = submission.submitterUuid.toLowerCase();
  const writeOptions = expirationTtl ? { expirationTtl } : undefined;
  const writes = [
    buildingsKv(env).put(playerSubmissionKey(playerUuid, submission.id), submission.id, writeOptions),
    buildingsKv(env).put(submissionStatusKey(submission.status, submission.id), submission.id, writeOptions),
  ];

  if (submission.status === 'pending') {
    writes.push(
      buildingsKv(env).put(playerPendingSubmissionKey(playerUuid, submission.id), submission.id),
    );
  }

  return writes;
}

async function ensureSubmissionIndexes(env: Env): Promise<void> {
  if ((await buildingsKv(env).get(SUBMISSION_INDEX_READY_KEY)) === 'ready') {
    return;
  }

  const keys = await listKvKeys(env, SUBMISSION_KEY_PREFIX);
  await Promise.all(
    keys.map(async (key) => {
      const submission = await readSubmissionByKey(env, key);
      if (!submission) {
        return;
      }
      if (isExpiredRejectedSubmission(submission)) {
        await deleteSubmission(env, submission);
        return;
      }
      if (submission.status === 'rejected') {
        const ttl = rejectedSubmissionRemainingTtlSeconds(submission);
        if (ttl <= 0) {
          await deleteSubmission(env, submission);
          return;
        }
        await Promise.all([
          buildingsKv(env).put(submissionKey(submission.id), JSON.stringify(submission), {
            expirationTtl: ttl,
          }),
          ...writeSubmissionIndexes(env, submission, ttl),
        ]);
        return;
      }
      await Promise.all(writeSubmissionIndexes(env, submission));
    }),
  );
  await buildingsKv(env).put(SUBMISSION_INDEX_READY_KEY, 'ready');
}

function deleteSubmission(env: Env, submission: BuildingSubmission): Promise<void[]> {
  return Promise.all([
    buildingsKv(env).delete(submissionKey(submission.id)),
    buildingsKv(env).delete(playerSubmissionKey(submission.submitterUuid.toLowerCase(), submission.id)),
    buildingsKv(env).delete(playerPendingSubmissionKey(submission.submitterUuid.toLowerCase(), submission.id)),
    ...SUBMISSION_STATUSES.map((status) =>
      buildingsKv(env).delete(submissionStatusKey(status, submission.id)),
    ),
  ]);
}

function isExpiredRejectedSubmission(submission: BuildingSubmission, now = new Date()): boolean {
  if (submission.status !== 'rejected') {
    return false;
  }
  const expiresAt = rejectedSubmissionExpiresAt(submission);
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function rejectedSubmissionRemainingTtlSeconds(
  submission: BuildingSubmission,
  now = new Date(),
): number {
  const expiresAt = rejectedSubmissionExpiresAt(submission);
  if (!Number.isFinite(expiresAt)) {
    return 0;
  }
  return Math.ceil((expiresAt - now.getTime()) / 1000);
}

function rejectedSubmissionExpiresAt(submission: BuildingSubmission): number {
  return Date.parse(
    submission.expiresAt ??
      addRetentionDays(submission.rejectedAt ?? submission.updatedAt ?? submission.createdAt),
  );
}

function addRetentionDays(value: string | undefined): string {
  const timestamp = Date.parse(value ?? '');
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  return new Date(timestamp + REJECTED_SUBMISSION_RETENTION_MS).toISOString();
}

async function listKvKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await buildingsKv(env).list({ prefix, cursor });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return keys;
}

async function readCachedSummary(): Promise<Building[] | null> {
  const cached = await readJsonCache(SUMMARY_CACHE_KEY);

  if (!Array.isArray(cached)) {
    return null;
  }

  const buildings = cached.filter(isBuildingDocument);
  summaryMemoryCache.set(SUMMARY_CACHE_KEY, buildings);
  return buildings;
}

async function writeSummaryCache(buildings: Building[]): Promise<void> {
  summaryMemoryCache.set(SUMMARY_CACHE_KEY, buildings);
  buildingListMemoryCache.clear();
  await writeJsonCache(SUMMARY_CACHE_KEY, buildings);
}

async function readCachedBuilding(id: string): Promise<Building | null> {
  const memoryBuilding = buildingMemoryCache.get(id);

  if (memoryBuilding) {
    return memoryBuilding;
  }

  const cached = await readJsonCache(buildingCacheKey(id));

  if (!isBuildingDocument(cached)) {
    return null;
  }

  buildingMemoryCache.set(id, cached);
  return cached;
}

async function writeBuildingCache(building: Building): Promise<void> {
  buildingMemoryCache.set(building.id, building);
  await writeJsonCache(buildingCacheKey(building.id), building);
}

async function readBuildingListCache(cacheKey: string): Promise<unknown[] | null> {
  const memoryList = buildingListMemoryCache.get(cacheKey);

  if (memoryList) {
    return memoryList;
  }

  const cached = await readJsonCache(cacheKey);

  if (!Array.isArray(cached)) {
    return null;
  }

  buildingListMemoryCache.set(cacheKey, cached);
  return cached;
}

async function writeBuildingListCache(cacheKey: string, body: unknown[]): Promise<void> {
  buildingListMemoryCache.set(cacheKey, body);
  await writeJsonCache(cacheKey, body);
}

async function deleteBuildingCache(id: string): Promise<void> {
  buildingMemoryCache.delete(id);
  const cache = getWorkerCache();

  if (!cache) {
    return;
  }

  try {
    await cache.delete(cacheRequest(buildingCacheKey(id)));
  } catch (error) {
    console.warn('Building cache delete failed', id, error);
  }
}

async function readJsonCache(cacheKey: string): Promise<unknown | null> {
  let response: Response | undefined;
  const cache = getWorkerCache();

  if (!cache) {
    return null;
  }

  try {
    response = await cache.match(cacheRequest(cacheKey));
  } catch (error) {
    console.warn('Building cache read failed', cacheKey, error);
    return null;
  }

  if (!response) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    try {
      await cache.delete(cacheRequest(cacheKey));
    } catch (error) {
      console.warn('Building cache corrupt delete failed', cacheKey, error);
    }

    return null;
  }
}

async function writeJsonCache(cacheKey: string, body: unknown): Promise<void> {
  const cache = getWorkerCache();

  if (!cache) {
    return;
  }

  try {
    await cache.put(
      cacheRequest(cacheKey),
      new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${BUILDINGS_CACHE_TTL_SECONDS}`,
        },
      }),
    );
  } catch (error) {
    console.warn('Building cache write failed', cacheKey, error);
  }
}

function buildingCacheKey(id: string): string {
  return `${BUILDINGS_CACHE_VERSION}:building:${id}`;
}

function buildingListCacheKey(request: Request, buildings: Building[]): string {
  return `${BUILDINGS_CACHE_VERSION}:building-list:${buildingsSummaryVersion(buildings)}:${canonicalBuildingListQuery(request)}`;
}

function buildingsSummaryVersion(buildings: Building[]): string {
  let latest = '';

  for (const building of buildings) {
    if (building.updatedAt > latest) {
      latest = building.updatedAt;
    }
  }

  return `${buildings.length}:${latest}`;
}

function canonicalBuildingListQuery(request: Request): string {
  const params = new URL(request.url).searchParams;
  const relevant = ['builder', 'locale', 'tag', 'type'];
  return relevant
    .map((key) => [key, params.get(key)?.trim() ?? ''] as const)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

function cacheRequest(cacheKey: string): Request {
  return new Request(`https://mikdata-buildings-cache.local/${cacheKey}`);
}

function getWorkerCache(): Cache | null {
  return typeof caches === 'undefined' ? null : caches.default;
}

function isValidBuildingId(id: string): boolean {
  return ID_RE.test(id);
}

function methodNotAllowed(request: Request, env: Env): Response {
  return error('method not allowed', 405, request, env);
}

function authorizeMutation(request: Request, env: Env): Response | null {
  if (!isSameOriginBrowserRequest(request)) {
    return error('forbidden', 403, request, env);
  }

  return null;
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

function error(message: string, status: number, request: Request, env: Env): Response {
  return json({ error: message }, status, request, env);
}

function withAdminHeaders(request: Request, actor: AdminActor): Request {
  const headers = new Headers(request.headers);
  headers.delete('X-Admin-Email');
  headers.delete('X-Admin-Subject');

  if (actor.email) {
    headers.set('X-Admin-Email', actor.email);
  }
  if (actor.subject) {
    headers.set('X-Admin-Subject', actor.subject);
  }

  return new Request(request, { headers });
}

function isSubmissionRoute(routePath: string): boolean {
  return (
    routePath === '/building-submissions' ||
    routePath === '/building-submissions/mine' ||
    routePath === '/building-submissions/repair-approved' ||
    /^\/building-submissions\/[a-z0-9]{8,24}(?:\/(?:approve|reject))?$/i.test(routePath)
  );
}

function isMutatingMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

async function syncBuildingCachesAfterMutation(
  routePath: string,
  method: string,
  env: Env,
  response: Response,
): Promise<void> {
  if (method === 'DELETE') {
    const match = routePath.match(/^\/buildings\/([a-z0-9]{8,24})$/i);

    if (match) {
      await deleteBuildingCache(match[1]);
    }
  } else {
    await cacheMutationResponseBuildings(response);
  }

  const summary = await readSummaryFromKv(env);

  if (summary) {
    await writeSummaryCache(summary);
  }
}

async function cacheMutationResponseBuildings(response: Response): Promise<void> {
  const contentType = response.headers.get('Content-Type') ?? '';

  if (!contentType.toLowerCase().includes('application/json')) {
    return;
  }

  try {
    const body = (await response.json()) as unknown;

    if (isBuildingDocument(body)) {
      await writeBuildingCache(body);
      return;
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return;
    }

    const buildings = (body as Record<string, unknown>).buildings;

    if (Array.isArray(buildings)) {
      await Promise.all(buildings.filter(isBuildingDocument).map(writeBuildingCache));
    }
  } catch (error) {
    console.warn('Building mutation cache update failed', error);
  }
}

async function readImportInputs(
  request: Request,
  env: Env,
): Promise<{ ok: true; value: unknown[] } | { ok: false; response: Response }> {
  const body = await readBody(request, env);

  if (!body.ok) {
    return body;
  }

  const value =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>).buildings
      : body.data;

  if (!Array.isArray(value)) {
    return { ok: false, response: error('import body must be an array', 400, request, env) };
  }

  if (value.length === 0) {
    return { ok: false, response: error('import body must not be empty', 400, request, env) };
  }

  if (value.length > MAX_IMPORT_ITEMS) {
    return {
      ok: false,
      response: error(`import exceeds max count ${MAX_IMPORT_ITEMS}`, 413, request, env),
    };
  }

  return { ok: true, value };
}

function validateImportInputs(
  values: unknown[],
  env: Env,
): { ok: true; value: Input[] } | { ok: false; message: string } {
  const inputs: Input[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const payload = stripStoredBuildingFields(values[index]);
    const validation = validateBuildingInput(payload);

    if (!validation.ok) {
      return { ok: false, message: `buildings[${index}]: ${validation.message}` };
    }

    inputs.push(validation.value);
  }

  const duplicate = findDuplicateInput(inputs, []);

  if (duplicate) {
    return { ok: false, message: `duplicate import item: ${duplicate}` };
  }

  return { ok: true, value: inputs };
}

function stripStoredBuildingFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const payload = { ...(value as Record<string, unknown>) };
  delete payload.id;
  delete payload.createdAt;
  delete payload.updatedAt;
  return payload;
}

function auditBuildingMutation(action: string, id: string, request: Request): void {
  console.log('building mutation', {
    action,
    id,
    actor: request.headers.get('X-Admin-Email') ?? request.headers.get('X-Admin-Subject') ?? 'unknown',
  });
}
