import type { Env } from './env';
import { json } from './http';
import type { AdminActor, Building, Coord, I18n, Source } from './types';
export type { AdminActor, Building, Builder, Coord, I18n, Source } from './types';

type Input = Omit<Building, 'id' | 'createdAt' | 'updatedAt'>;
type ValidationResult = { ok: true; value: Input } | { ok: false; message: string };
interface MemoryRecord<T> {
  value: T;
  expiresAt: number;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_NAME_LEN = 200;
const MAX_DESC_LEN = 2000;
const MAX_URL_LEN = 500;
const MAX_TAG_LEN = 50;
const MAX_TAGS = 20;
const MAX_IMAGES = 10;
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
const SUMMARY_STORAGE_KEY = 'summary:v1';
const INTERNAL_SUMMARY_PATH = '/__internal/buildings-summary';
const BUILDINGS_CACHE_VERSION = 'v1';
const SUMMARY_CACHE_KEY = `${BUILDINGS_CACHE_VERSION}:summary`;
const BUILDINGS_CACHE_TTL_SECONDS = 300;
const MAX_IMPORT_ITEMS = 100;
const PUBLIC_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
} as const;
const buildingMemoryCache = new Map<string, MemoryRecord<Building>>();
let summaryMemoryCache: MemoryRecord<Building[]> | null = null;

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
  if (routePath !== '/buildings' && routePath !== '/buildings/import') {
    const match = routePath.match(/^\/buildings\/([a-z0-9]{8,24})$/i);

    if (!match) {
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

  return forwardWriteToDurableObject(routePath, request, env, actor);
}

async function listBuildings(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const tag = params.get('tag');
  const type = params.get('type');
  const builder = params.get('builder');
  const locale = params.get('locale');

  const buildings = await readBuildingsSummary(env);
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

  if (locale) {
    return json(
      result.map((building) => localizeBuilding(building, locale)),
      200,
      request,
      env,
      PUBLIC_CACHE_HEADERS,
    );
  }

  return json(result, 200, request, env, PUBLIC_CACHE_HEADERS);
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
  summaryStorage: DurableObjectStorage,
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
  await rebuildBuildingsSummary(env, summaryStorage);
  auditBuildingMutation('create', building.id, request);

  return json(building, 201, request, env);
}

async function replaceBuilding(
  id: string,
  request: Request,
  env: Env,
  summaryStorage: DurableObjectStorage,
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
  await rebuildBuildingsSummary(env, summaryStorage);
  auditBuildingMutation('replace', id, request);
  return json(building, 200, request, env);
}

async function patchBuilding(
  id: string,
  request: Request,
  env: Env,
  summaryStorage: DurableObjectStorage,
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
  await rebuildBuildingsSummary(env, summaryStorage);
  auditBuildingMutation('patch', id, request);
  return json(building, 200, request, env);
}

async function deleteBuilding(
  id: string,
  request: Request,
  env: Env,
  summaryStorage: DurableObjectStorage,
): Promise<Response> {
  if (!(await buildingsKv(env).get(buildingKey(id)))) {
    return error('building not found', 404, request, env);
  }

  await buildingsKv(env).delete(buildingKey(id));
  await rebuildBuildingsSummary(env, summaryStorage);
  auditBuildingMutation('delete', id, request);

  return json({ deleted: id }, 200, request, env);
}

async function importBuildings(
  request: Request,
  env: Env,
  summaryStorage: DurableObjectStorage,
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
  await rebuildBuildingsSummary(env, summaryStorage);

  for (const building of buildings) {
    auditBuildingMutation('import', building.id, request);
  }

  return json({ imported: buildings.length, buildings }, 201, request, env);
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
  if (summaryMemoryCache && summaryMemoryCache.expiresAt > Date.now()) {
    return summaryMemoryCache.value;
  }

  summaryMemoryCache = null;
  const cached = await readCachedSummary();

  if (cached) {
    return cached;
  }

  const snapshot = await readSummaryFromWriter(env);

  if (snapshot) {
    await writeSummaryCache(snapshot);
    return snapshot;
  }

  const buildings = await readAllBuildings(env);
  buildings.sort(compareBuildingsForSummary);
  await writeSummaryCache(buildings);
  return buildings;
}

async function rebuildBuildingsSummary(
  env: Env,
  summaryStorage: DurableObjectStorage,
): Promise<Building[]> {
  const buildings = await readAllBuildings(env);
  buildings.sort(compareBuildingsForSummary);
  await writeSummaryStorage(summaryStorage, buildings);
  return buildings;
}

async function readSummaryFromWriter(env: Env): Promise<Building[] | null> {
  const id = env.BUILDINGS_WRITER.idFromName('global');
  const writer = env.BUILDINGS_WRITER.get(id);

  try {
    const response = await writer.fetch(
      new Request(`https://internal.mikdata${INTERNAL_SUMMARY_PATH}`),
    );

    if (!response.ok) {
      console.warn('Building summary snapshot read failed', response.status);
      return null;
    }

    const data = (await response.json()) as unknown;
    return normalizeSummary(data);
  } catch (error) {
    console.warn('Building summary snapshot read failed', error);
    return null;
  }
}

async function readSummaryStorageOrRebuild(
  env: Env,
  summaryStorage: DurableObjectStorage,
): Promise<Building[]> {
  const stored = await summaryStorage.get<unknown>(SUMMARY_STORAGE_KEY);
  const normalizedStored = normalizeSummary(stored);

  if (normalizedStored) {
    return normalizedStored;
  }

  const legacy = await readLegacySummary(env);

  if (legacy) {
    await writeSummaryStorage(summaryStorage, legacy);
    return legacy;
  }

  return rebuildBuildingsSummary(env, summaryStorage);
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

async function writeSummaryStorage(
  summaryStorage: DurableObjectStorage,
  buildings: Building[],
): Promise<void> {
  await summaryStorage.put(SUMMARY_STORAGE_KEY, buildings);
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

async function findDuplicateBuildingId(env: Env, input: Input): Promise<string | null> {
  const buildings = await readAllBuildings(env);

  for (const building of buildings) {
    if (isDuplicateBuilding(building, input)) {
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

function writeBuilding(env: Env, building: Building): Promise<void> {
  return buildingsKv(env).put(buildingKey(building.id), JSON.stringify(building));
}

async function readCachedSummary(): Promise<Building[] | null> {
  const cached = await readJsonCache(SUMMARY_CACHE_KEY);

  if (!Array.isArray(cached)) {
    return null;
  }

  const buildings = cached.filter(isBuildingDocument);
  summaryMemoryCache = createMemoryRecord(buildings);
  return buildings;
}

async function writeSummaryCache(buildings: Building[]): Promise<void> {
  summaryMemoryCache = createMemoryRecord(buildings);
  await writeJsonCache(SUMMARY_CACHE_KEY, buildings);
}

async function readCachedBuilding(id: string): Promise<Building | null> {
  const memoryRecord = buildingMemoryCache.get(id);

  if (memoryRecord && memoryRecord.expiresAt > Date.now()) {
    return memoryRecord.value;
  }

  buildingMemoryCache.delete(id);
  const cached = await readJsonCache(buildingCacheKey(id));

  if (!isBuildingDocument(cached)) {
    return null;
  }

  buildingMemoryCache.set(id, createMemoryRecord(cached));
  return cached;
}

async function writeBuildingCache(building: Building): Promise<void> {
  buildingMemoryCache.set(building.id, createMemoryRecord(building));
  await writeJsonCache(buildingCacheKey(building.id), building);
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

function cacheRequest(cacheKey: string): Request {
  return new Request(`https://mikdata-buildings-cache.local/${cacheKey}`);
}

function getWorkerCache(): Cache | null {
  return typeof caches === 'undefined' ? null : caches.default;
}

function createMemoryRecord<T>(value: T): MemoryRecord<T> {
  return {
    value,
    expiresAt: Date.now() + BUILDINGS_CACHE_TTL_SECONDS * 1000,
  };
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

async function forwardWriteToDurableObject(
  routePath: string,
  request: Request,
  env: Env,
  actor: AdminActor,
): Promise<Response> {
  const id = env.BUILDINGS_WRITER.idFromName('global');
  const writer = env.BUILDINGS_WRITER.get(id);
  const url = new URL(request.url);
  url.pathname = routePath;

  const headers = new Headers(request.headers);
  headers.delete('X-Admin-Email');
  headers.delete('X-Admin-Subject');

  if (actor.email) {
    headers.set('X-Admin-Email', actor.email);
  }
  if (actor.subject) {
    headers.set('X-Admin-Subject', actor.subject);
  }

  const response = await writer.fetch(
    new Request(url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    }),
  );

  if (response.ok && isMutatingMethod(request.method)) {
    await syncBuildingCachesAfterMutation(routePath, request.method, env, response.clone());
  }

  return response;
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

  const summary = await readSummaryFromWriter(env);

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

export class BuildingsWriter {
  private queue = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const response = this.queue.then(() => this.handle(request));
    this.queue = response.then(
      () => undefined,
      () => undefined,
    );
    return response;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === INTERNAL_SUMMARY_PATH) {
      if (request.method === 'GET') {
        const buildings = await readSummaryStorageOrRebuild(this.env, this.state.storage);
        return json(buildings, 200, request, this.env);
      }

      return methodNotAllowed(request, this.env);
    }

    if (url.pathname === '/buildings') {
      if (request.method === 'POST') {
        return createBuilding(request, this.env, this.state.storage);
      }

      return methodNotAllowed(request, this.env);
    }

    if (url.pathname === '/buildings/import') {
      if (request.method === 'POST') {
        return importBuildings(request, this.env, this.state.storage);
      }

      return methodNotAllowed(request, this.env);
    }

    const match = url.pathname.match(/^\/buildings\/([a-z0-9]{8,24})$/i);

    if (!match) {
      return error('not found', 404, request, this.env);
    }

    const id = match[1];

    if (request.method === 'PUT') {
      return replaceBuilding(id, request, this.env, this.state.storage);
    }

    if (request.method === 'PATCH') {
      return patchBuilding(id, request, this.env, this.state.storage);
    }

    if (request.method === 'DELETE') {
      return deleteBuilding(id, request, this.env, this.state.storage);
    }

    return methodNotAllowed(request, this.env);
  }
}
