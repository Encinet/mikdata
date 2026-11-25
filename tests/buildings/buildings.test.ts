import { expect, spyOn, test } from 'bun:test';
import { BuildingStore, PUBLIC_BUILDINGS_KEY, PUBLISH_INTERVAL_MS } from '../../src/buildings/store';
import { canonicalContent, contentTag } from '../../src/shared/content-precondition';
import { sha256 } from '../../src/buildings/images/storage';
import { AuthStore } from '../../src/auth/store';
import { initializeBuildingStorage } from '../../src/buildings/schema';
import { handleAdminBuildingsRoute } from '../../src/buildings/admin-route';
import { handlePublicBuildingsRoute } from '../../src/buildings/public-route';
import { validateBuildingInput } from '../../src/buildings/validation';
import type { Building, BuildingImage, BuildingSubmission } from '../../src/buildings/types';
import {
  authCall,
  OTHER_UUID,
  PLAYER_UUID,
  seedSession,
  testAuthStore,
} from '../helpers/auth-store';

const input = (name = 'Building') => ({
  name: { 'zh-CN': name, en: name },
  description: { 'zh-CN': '描述', en: 'Description' },
  coordinates: { world: 'world', x: 0, y: 64, z: 0 },
  builders: [{ name: 'Player', uuid: PLAYER_UUID, weight: 1 }],
  buildType: 'original' as const,
  images: [] as BuildingImage[],
  buildDate: '2026-06-27',
});
const imageBaseUrl = 'https://images.example/gallery';
function setup() {
  const kv = new Map<string, string>();
  let writes = 0;
  let fail = false;
  const fixture = testAuthStore({
    BUILDING_IMAGE_PUBLIC_BASE_URL: imageBaseUrl,
    BUILDING_IMAGE_S3_BUCKET_URL: 'https://bucket.example',
    BUILDING_IMAGE_S3_REGION: 'test-region',
    BUILDING_IMAGE_ACCESS_KEY_ID: 'test',
    BUILDING_IMAGE_SECRET_ACCESS_KEY: 'test',
    BUILDINGS_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        writes++;
        if (fail) throw new Error('KV unavailable');
        kv.set(key, value);
      },
    } as unknown as KVNamespace,
  });
  fixture.env.AUTH_STORE = {
    idFromName: () => 'global',
    get: () => ({ fetch: (request: Request) => fixture.store.fetch(request) }),
  } as unknown as DurableObjectNamespace;
  return {
    ...fixture,
    kv,
    writes: () => writes,
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}
async function admin(
  fixture: ReturnType<typeof setup>,
  route = '/buildings',
  method = 'GET',
  body?: unknown,
  expected?: Building | BuildingSubmission,
  draft?: string,
  actor = 'admin@example.com',
) {
  const response = await handleAdminBuildingsRoute(
    route.split('?')[0],
    new Request(`https://data.example/admin/api${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(expected ? { 'If-Match': await contentTag(canonicalContent(expected)) } : {}),
        ...(draft ? { 'X-Building-Draft': draft } : {}),
      },
    body: JSON.stringify(body),
    }),
    fixture.env,
    { email: actor },
  );
  if (!response) throw new Error('Unexpected admin route');
  return { status: response.status, body: await response.json() };
}

// Three 3×2 WebP images using VP8L, VP8 and VP8X with alpha.
const galleryWebps = [
  'UklGRhwAAABXRUJQVlA4TA8AAAAvAkAAAAcQ/Y/+ByKi/wEA',
  'UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoDAAIAAUAiJaACdLoB+AADsAD+9FEf/nYPZd+9kv/rK/mV/Mr/d2AA',
  'UklGRlwAAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAgICAgICAAFZQOCAuAAAAkAEAnQEqAwACAAFAIiWgAnS6AAOYAP770d//sM//15l/68y/7DP/WqhU7+kAAA==',
].map(value => Uint8Array.from(atob(value), byte => byte.charCodeAt(0)));

// Corresponding 3×2 JPEG XL fixtures. The first uses a progressive low-frequency frame.
const galleryJxls = [
  '/woIQLATCgQAAIgAADgAWABYShJpKHbeJzMAGiAN/BaOHjoAkCSSNwjYO9kHAuCDVAUIAQCwwAAUAAAAAFUPAACoUBll3ODlXM+XHzospm1cZ2irbQtLEoVGxLswAF2SSNYWRHQQEREBU50BlSQoSQA=',
  '/woIQLATAEiAEADoAHM5AABUqIwybvByrufLDx0W0zauM7TVtoUliSLj2CTVIRM4JIkVkHkBAjhMAB9ERETm0dV6khytJAE=',
  '/woIQLATAEiAEADgAHM5AABUqIwybvByrufLDx0W0zauM7TVtoUliSLj2CTVIRM4JIkFUHYHBNAAiIYkSeadjk+1TCUJ',
].map(value => Uint8Array.from(atob(value), byte => byte.charCodeAt(0)));
const galleryHashes = await Promise.all(galleryWebps.map(async (webp, index) => ({
  webp: await sha256(webp), jxl: await sha256(galleryJxls[index]),
})));
const galleryImages = galleryHashes;

async function adminUploadRequest(f: ReturnType<typeof setup>, draft: string, bytes: Uint8Array<ArrayBuffer>,
  { target, origin = 'https://data.example', jxl }: {
    target?: string; origin?: string; jxl?: Uint8Array<ArrayBuffer>;
  } = {},
) {
  const path = '/building-images';
  const url = 'https://data.example/admin/api' + path + (target ? '?building=' + target : '');
  const form = new FormData();
  form.set('webp', new Blob([bytes], { type: 'image/webp' }), 'test.webp');
  form.set('jxl', new Blob([jxl ?? galleryJxls[galleryWebps.indexOf(bytes)] ?? galleryJxls[0]], { type: 'image/jxl' }), 'test.jxl');
  const response = await handleAdminBuildingsRoute(path, new Request(url, {
    method: 'POST',
    headers: { Origin: origin, 'X-Building-Draft': draft },
    body: form,
  }), f.env, { email: 'admin@example.com' });
  return { status: response!.status, body: await response!.json() };
}

async function adminUpload(
  f: ReturnType<typeof setup>, draft: string, target?: string,
  bytes = galleryWebps[0], writtenStatus = 200, mismatch = false,
) {
  const index = galleryWebps.indexOf(bytes);
  const network = spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    const url = new URL(request as string);
    const format = url.pathname.endsWith('.jxl') ? 'jxl' : 'webp';
    const variant = format === 'webp' ? bytes : galleryJxls[index];
    if (init?.method === 'PUT') {
      expect(url.origin).toBe('https://bucket.example');
      expect(url.pathname).toEndWith('/' + galleryImages[index][format] + '.' + format);
      expect(new Headers(init.headers).get('x-amz-content-sha256')).toBe(galleryHashes[index][format]);
      expect(init.body).toEqual(variant);
      return new Response(null, { status: format === 'jxl' ? writtenStatus : 200 });
    }
    expect(url.origin + url.pathname).toStartWith(f.env.BUILDING_IMAGE_PUBLIC_BASE_URL!.replace(/\/$/, '') + '/');
    const original = variant.slice();
    if (mismatch && format === 'jxl') original[original.length - 1] ^= 1;
    return new Response(original, { headers: { 'Content-Type': 'image/' + format } });
  });
  try {
    return await adminUploadRequest(f, draft, bytes, { target });
  } finally {
    network.mockRestore();
  }
}

async function completeImage(fixture: ReturnType<typeof setup>, token: string, id: string,
  bytes = galleryWebps[0], failJxl = false) {
  const jxl = galleryJxls[galleryWebps.indexOf(bytes)];
  const network = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(init?.redirect).toBe('manual');
    expect(String(input)).toStartWith(fixture.env.BUILDING_IMAGE_PUBLIC_BASE_URL!.replace(/\/$/, '') + '/buildings/');
    const isJxl = String(input).endsWith('.jxl');
    if (isJxl && failJxl) return new Response(null, { status: 404 });
    return new Response(isJxl ? jxl : bytes, { headers: { 'content-type': isJxl ? 'image/jxl' : 'image/webp' } });
  });
  try {
    return await authCall(fixture.store, {
      action: 'completeImageUpload', sessionId: token, uploadId: id, sizes: { webp: bytes.length, jxl: jxl.length },
    });
  } finally {
    network.mockRestore();
  }
}

async function permitImage(fixture: ReturnType<typeof setup>, token: string,
  draftKey: string = crypto.randomUUID(), bytes = galleryWebps[0]) {
  const reserved = await authCall(fixture.store, {
    action: 'reserveImageUpload', sessionId: token, draftKey, requestKey: crypto.randomUUID(),
  });
  expect(reserved.status).toBe(200);
  const prepared = await authCall(fixture.store, {
    action: 'prepareImageUpload', sessionId: token, uploadId: reserved.body.uploadId,
    hashes: galleryHashes[galleryWebps.indexOf(bytes)],
  });
  expect(prepared.status).toBe(200);
  const key = new URL(prepared.body.put.webp.url).pathname.slice(1);
  const completed = await completeImage(fixture, token, reserved.body.uploadId, bytes);
  expect(completed.status).toBe(200);
  return { draftKey, key, image: completed.body.image as BuildingImage };
}

async function submit(fixture: ReturnType<typeof setup>, token: string, draft: Awaited<ReturnType<typeof permitImage>>, name = 'Building') {
  return authCall(fixture.store, {
    action: 'createBuildingSubmission', sessionId: token,
    payload: { draftKey: draft.draftKey, payload: { ...input(name), images: [draft.image] } },
  });
}

function storedSubmission(fixture: ReturnType<typeof setup>, id: string): BuildingSubmission {
  return new BuildingStore(fixture.storage).submission(id)!;
}

test('validation rejects unknown fields, invalid dates and image paths', () => {
  expect(validateBuildingInput(input()).ok).toBe(true);
  expect(validateBuildingInput({ ...input(), images: ['/images/test.webp'] }).ok).toBe(false);
  expect(
    validateBuildingInput({
      ...input(),
      images: ['http://example.com/image.webp'],
    }).ok,
  ).toBe(false);
  expect(validateBuildingInput({ ...input(), buildDate: '2026-02-30' }).ok).toBe(false);
  expect(validateBuildingInput({ ...input(), secret: true }).ok).toBe(false);
  expect(validateBuildingInput({ ...input(), '': true }).ok).toBe(false);
  expect(validateBuildingInput({ ...input(), builders: [{ ...input().builders[0], wegiht: 2 }] }).ok).toBe(false);
  expect(validateBuildingInput({ ...input(), source: { originalLnik: 'https://example.test' } }).ok).toBe(false);
  for (const world of ['', ' ', 'bad\nworld', 'x'.repeat(129), undefined]) {
    expect(
      validateBuildingInput({
        ...input(),
        coordinates: { ...input().coordinates, world },
      }).ok,
    ).toBe(false);
  }
  expect(
    validateBuildingInput({
      ...input(),
      coordinates: { ...input().coordinates, secret: true },
    }).ok,
  ).toBe(false);
});

test('building validation normalizes optional localized text before storage', () => {
  const parsed = validateBuildingInput({
    ...input(),
    tags: [{ en: '  Trail  ' }, { 'zh-CN': '   ' }],
    source: { notes: { 'zh-CN': ' 原作备注 ' } },
  });
  expect(parsed).toEqual({ ok: true, value: {
    ...input(), tags: [{ 'zh-CN': '', en: 'Trail' }],
    source: { notes: { 'zh-CN': '原作备注', en: '' } },
  } });
  if (!parsed.ok) throw new Error(parsed.message);
  expect(validateBuildingInput(parsed.value)).toEqual(parsed);
  expect(validateBuildingInput({
    ...input(), source: { originalAuthor: '  ', originalLink: '  ', notes: { en: ' ' } },
  })).toEqual({ ok: true, value: input() });
  expect(validateBuildingInput({ ...input(), source: { originalAuthor: '  ', notes: { en: 'Credit' } } }))
    .toEqual({ ok: true, value: { ...input(), source: { notes: { 'zh-CN': '', en: 'Credit' } } } });
});

function stored(name = 'Building', id = 'ab'.repeat(16)): Building {
  return { id, ...input(name) };
}

test('a missing public snapshot is rebuilt from SQLite and republished', async () => {
  const f = setup(),
    store = new BuildingStore(f.storage);
  initializeBuildingStorage(f.storage);
  const building = stored();
  store.insertBuilding(building);
  const response = await handlePublicBuildingsRoute(
    '/buildings',
    new Request('https://data.example/api/buildings'),
    f.env,
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ imageBaseUrl, buildings: [{ id: building.id, ...input() }] });
  expect(await f.storage.getAlarm()).toBeNumber();
  f.db.exec('UPDATE building_publication SET next_attempt=0');
  await f.store.alarm();
  expect(JSON.parse(f.kv.get(PUBLIC_BUILDINGS_KEY)!).buildings).toEqual(store.snapshot().buildings);
});

test('a fresh database serves and publishes an empty public catalog', async () => {
  const f = setup();
  const response = await handlePublicBuildingsRoute(
    '/buildings',
    new Request('https://data.example/api/buildings'),
    f.env,
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ imageBaseUrl, buildings: [] });
  f.db.exec('UPDATE building_publication SET next_attempt=0');
  await f.store.alarm();
  expect(JSON.parse(f.kv.get(PUBLIC_BUILDINGS_KEY)!)).toMatchObject({ buildings: [] });
});

test('a public snapshot with duplicate IDs is rebuilt from the authoritative database', async () => {
  const f = setup();
  const store = new BuildingStore(f.storage);
  initializeBuildingStorage(f.storage);
  const building = stored('Authoritative');
  store.insertBuilding(building);
  const document = store.snapshot().buildings[0];
  f.kv.set(PUBLIC_BUILDINGS_KEY, JSON.stringify({
    version: 99,
    buildings: [document, { ...document, name: input('Conflicting').name }],
  }));
  const list = await handlePublicBuildingsRoute(
    '/buildings',
    new Request('https://data.example/api/buildings'),
    f.env,
  );
  expect(list?.status).toBe(200);
  expect(await list!.json()).toEqual({ imageBaseUrl, buildings: [{ id: building.id, ...input('Authoritative') }] });
  const detail = await handlePublicBuildingsRoute(
    `/buildings/${building.id}`,
    new Request(`https://data.example/api/buildings/${building.id}`),
    f.env,
  );
  expect(await detail!.json()).toEqual({ imageBaseUrl, building });
  expect(await f.storage.getAlarm()).toBeNumber();
});

test('duplicate lookups preserve multilingual matching and exclude the current building', () => {
  const f = setup();
  const store = new BuildingStore(f.storage);
  initializeBuildingStorage(f.storage);
  const building = { ...stored('Original'), name: { 'zh-CN': '中文建筑', en: 'English' } };
  store.insertBuilding(building);
  expect(store.duplicateBuildingId(building)).toBe(building.id);
  expect(store.duplicateBuildingId(building, building.id)).toBeNull();
  for (const name of [
    { 'zh-CN': '中文建筑', en: 'Different' },
    { 'zh-CN': '不同建筑', en: 'English' },
  ]) expect(store.duplicateBuildingId({ ...building, name })).toBe(building.id);
  for (const changed of [
    { name: { 'zh-CN': 'English', en: '中文建筑' } },
    { name: { 'zh-CN': '不同建筑', en: 'english' } },
    { coordinates: { ...building.coordinates, world: 'world_nether' } },
    { buildDate: '2026-06-28' },
    { builders: [{ name: 'Other', uuid: OTHER_UUID, weight: 1 }] },
  ]) expect(store.duplicateBuildingId({ ...building, ...changed })).toBeNull();
  const renamed = { ...building, name: { 'zh-CN': '已重命名', en: 'Renamed' } };
  store.updateBuilding(renamed);
  expect(store.duplicateBuildingId(building)).toBeNull();
  expect(store.duplicateBuildingId(renamed)).toBe(building.id);
});

test('conditional deletes compare the expected content without publishing failed mutations', async () => {
  const f = setup();
  const created = await admin(f, '/buildings', 'POST', input());
  const original = created.body as Building;
  const updated = await admin(f, `/buildings/${original.id}`, 'PUT', input('Updated'), original);
  expect(updated.status).toBe(200);
  const store = new BuildingStore(f.storage);
  const revision = store.snapshot().version;
  const stale = await admin(f, `/buildings/${original.id}`, 'DELETE', undefined, original);
  expect(stale.status).toBe(412);
  expect(store.snapshot().version).toBe(revision);
  expect(store.building(original.id)).toEqual(updated.body);
  const deleted = await admin(f, `/buildings/${original.id}`, 'DELETE', undefined, updated.body);
  expect(deleted.status).toBe(200);
  expect(store.snapshot()).toEqual({ version: revision + 1, buildings: [] });
  expect((await admin(f, `/buildings/${original.id}`, 'DELETE', undefined, updated.body)).status).toBe(404);
  expect(store.snapshot().version).toBe(revision + 1);
  const restarted = new AuthStore({ storage: f.storage } as DurableObjectState, f.env);
  const snapshot = await authCall(restarted, { action: 'publicBuildingSnapshot' });
  expect(snapshot.body.buildings).toEqual([]);
});

test('bulk import publishes one catalog revision and retains language-specific duplicate detection', async () => {
  const f = setup();
  const imported = await admin(f, '/buildings/import', 'POST', { buildings: [
    { ...input(), name: { 'zh-CN': '甲', en: 'Alpha' } },
    { ...input(), name: { 'zh-CN': 'Alpha', en: '甲' } },
    input('Third'),
  ] });
  expect(imported.status).toBe(201);
  expect(imported.body.buildings).toHaveLength(3);
  expect((await admin(f, '/buildings/import', 'POST', [input('Other')])).status).toBe(400);
  expect(await admin(f, '/buildings/import', 'POST', { buildings: [input('Other')], images: [] }))
    .toEqual({ status: 422, body: { error: 'unknown field: images' } });
  expect(await admin(f, '/buildings/import', 'POST', { buildings: [input('Fourth'), stored('Other')] }))
    .toEqual({ status: 422, body: { error: 'buildings[1]: unknown field: id' } });
  const store = new BuildingStore(f.storage);
  expect(store.snapshot().version).toBe(1);
  expect(store.buildings()).toHaveLength(3);
  for (const name of [
    { 'zh-CN': '甲', en: 'Different' },
    { 'zh-CN': '不同建筑', en: 'Alpha' },
  ]) {
    const duplicate = await admin(f, '/buildings/import', 'POST', { buildings: [{ ...input(), name }] });
    expect(duplicate.status).toBe(409);
    expect(store.snapshot().version).toBe(1);
  }
  const duplicateBatch = await admin(f, '/buildings/import', 'POST', {
    buildings: [input('Same'), input('Same')],
  });
  expect(duplicateBatch.status).toBe(422);
  expect(store.snapshot().version).toBe(1);
});

test('a failed batch insert rolls back all imported records and the publication revision', async () => {
  const f = setup();
  const store = new BuildingStore(f.storage);
  initializeBuildingStorage(f.storage);
  store.insertBuilding(stored('Existing'));
  const before = store.snapshot();
  const exec = f.storage.sql.exec.bind(f.storage.sql);
  let inserts = 0;
  const sql = spyOn(f.storage.sql, 'exec').mockImplementation((query, ...bindings) => {
    if (query.startsWith('INSERT INTO buildings') && ++inserts === 2) throw new Error('Injected batch failure');
    return exec(query, ...bindings);
  });
  try {
    const failed = await admin(f, '/buildings/import', 'POST', {
      buildings: [input('One'), input('Two')],
    });
    expect(failed.status).toBe(500);
    expect(inserts).toBe(2);
    expect(store.snapshot()).toEqual(before);
  } finally {
    sql.mockRestore();
  }
});

test('server-assigned building IDs survive edits, restarts and public reads', async () => {
  const f = setup();
  expect((await admin(f, '/buildings', 'POST', { ...input(), id: 'chosen123' })).status).toBe(422);
  const created = await admin(f, '/buildings', 'POST', input());
  expect(created.status).toBe(201);
  const original = created.body as Building;
  expect(original.id).toMatch(/^[0-9a-f]{32}$/);
  const rejected = await admin(f, `/buildings/${original.id}`, 'PUT', {
    ...input(), id: 'changed123',
  }, original);
  expect(rejected.status).toBe(422);
  expect((await admin(f, `/buildings/${original.id}`, 'PATCH', {}, original)).status).toBe(405);

  const replacement = {
    ...input('Renamed'),
    coordinates: { world: 'world_nether', x: 100, y: 70, z: -200 },
    builders: [{ name: 'Other', uuid: OTHER_UUID, weight: 2 }],
    buildDate: '2026-06-28',
  };
  const replaced = await admin(f, `/buildings/${original.id}`, 'PUT', replacement, original);
  expect(replaced.status).toBe(200);
  expect(replaced.body).toEqual({
    ...replacement,
    id: original.id,
  });
  const restarted = new AuthStore({ storage: f.storage } as DurableObjectState, f.env);
  const snapshot = await authCall(restarted, { action: 'publicBuildingSnapshot' });
  expect(snapshot.status).toBe(200);
  expect(snapshot.body.buildings).toEqual(new BuildingStore(f.storage).snapshot().buildings);
  f.env.AUTH_STORE = {
    idFromName: () => 'global',
    get: () => ({ fetch: (request: Request) => restarted.fetch(request) }),
  } as unknown as DurableObjectNamespace;
  const detail = await handlePublicBuildingsRoute(
    `/buildings/${original.id}`,
    new Request(`https://data.example/api/buildings/${original.id}`),
    f.env,
  );
  expect(detail?.status).toBe(200);
  expect(await detail!.json()).toEqual({ imageBaseUrl, building: replaced.body });
  const uppercasePath = `/buildings/${'AB'.repeat(16)}`;
  expect(await handlePublicBuildingsRoute(
    uppercasePath,
    new Request(`https://data.example/api${uppercasePath}`),
    f.env,
  )).toBeNull();
});

test('building ID collisions retry safely and cannot overwrite existing records', async () => {
  const f = setup();
  const store = new BuildingStore(f.storage);
  initializeBuildingStorage(f.storage);
  const existing = stored('Existing', '11'.repeat(16));
  store.insertBuilding(existing);
  const values = [0x11, 0x22, 0x22, 0x33];
  const random = spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
    (bytes as Uint8Array).fill(values.shift() ?? 0x44);
    return bytes;
  });
  try {
    const imported = await admin(f, '/buildings/import', 'POST', {
      buildings: [input('One'), input('Two')],
    });
    expect(imported.status).toBe(201);
    expect(imported.body.buildings).toHaveLength(2);
    expect(imported.body.buildings.map((building: Building) => building.id)).toEqual([
      '22'.repeat(16),
      '33'.repeat(16),
    ]);
    expect(store.buildings()).toHaveLength(3);
    expect(store.building(existing.id)).toEqual(existing);
    const before = store.snapshot();
    expect(() => store.insertBuilding({ ...existing, name: input('Replacement').name })).toThrow();
    expect(store.snapshot()).toEqual(before);
    random.mockImplementation((bytes) => {
      (bytes as Uint8Array).fill(0x11);
      return bytes;
    });
    const failed = await admin(f, '/buildings', 'POST', input('Blocked'));
    expect(failed.status).toBe(500);
    expect(store.snapshot()).toEqual(before);
  } finally {
    random.mockRestore();
  }
});

test('concurrent building writes stay unique and independent of public KV failures', async () => {
  const f = setup();
  f.setFail(true);
  const values = [0x11, 0x11, 0x22];
  const random = spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
    (bytes as Uint8Array).fill(values.shift() ?? 0x33);
    return bytes;
  });
  try {
    const created = await Promise.all([
      admin(f, '/buildings', 'POST', input('One')),
      admin(f, '/buildings', 'POST', input('Two')),
    ]);
    expect(created.map((response) => response.status)).toEqual([201, 201]);
    expect(new Set(created.map((response) => response.body.id)).size).toBe(2);
    const buildings = new BuildingStore(f.storage).buildings();
    expect(buildings.map((building) => building.name.en).sort()).toEqual(['One', 'Two']);
    expect((await admin(f)).body).toHaveLength(2);
    expect(f.writes()).toBe(0);
    expect(await f.storage.getAlarm()).toBeNumber();
  } finally {
    random.mockRestore();
  }
});

test('publication coalesces edits, respects the five minute write interval and retries durable pending state', async () => {
  const f = setup();
  await admin(f, '/buildings', 'POST', input('One'));
  await admin(f, '/buildings', 'POST', input('Two'));
  f.db.exec('UPDATE building_publication SET next_attempt=0');
  f.setFail(true);
  await f.store.alarm();
  expect(f.kv.size).toBe(0);
  expect((await admin(f)).body).toHaveLength(2);
  const store = new BuildingStore(f.storage);
  expect(store.publication().published_revision).toBe(0);
  expect(store.publication().next_attempt).toBeGreaterThan(Date.now() + PUBLISH_INTERVAL_MS - 2000);
  f.setFail(false);
  f.db.exec('UPDATE building_publication SET next_attempt=0');
  await f.store.alarm();
  const published = JSON.parse(f.kv.get(PUBLIC_BUILDINGS_KEY)!);
  expect(published.buildings).toHaveLength(2);
  await admin(f, '/buildings', 'POST', input('Three'));
  await f.store.alarm();
  expect(f.writes()).toBe(2);
  expect(store.publication().revision).toBeGreaterThan(store.publication().published_revision);
});

test('approval failure rolls back both building creation and submission state', async () => {
  const f = setup();
  const session = await seedSession(f.values);
  const draft = await permitImage(f, session.token);
  const created = await submit(f, session.token, draft);
  const submission = storedSubmission(f, created.body.submission.id);
  f.failNextSql('UPDATE submissions');
  const failed = await admin(f, `/building-submissions/${submission.id}/approve`, 'PUT', {}, submission);
  expect(failed.status).toBe(500);
  expect((await admin(f)).body).toHaveLength(0);
  expect(new BuildingStore(f.storage).submission(submission.id)?.status).toBe('pending');
  const retry = await admin(f, `/building-submissions/${submission.id}/approve`, 'PUT', {}, submission);
  expect(retry.status).toBe(200);
  expect(retry.body.building.id).toMatch(/^[0-9a-f]{32}$/);
  expect(retry.body.building.id).toBe(submission.id);
  expect(retry.body).not.toHaveProperty('submission');
  expect(new BuildingStore(f.storage).building(retry.body.building.id)).toEqual(retry.body.building);
  expect(new BuildingStore(f.storage).submission(submission.id)?.status).toBe('approved');
  expect((await admin(f)).body).toHaveLength(1);
  expect(f.writes()).toBe(0);
});

test('concurrent approval creates exactly one building and retains the review result', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const draft = await permitImage(f, token);
  const created = await submit(f, token, draft);
  const submission = storedSubmission(f, created.body.submission.id);
  const { id } = submission;
  const results = await Promise.all([
    admin(f, `/building-submissions/${id}/approve`, 'PUT', {}, submission),
    admin(f, `/building-submissions/${id}/approve`, 'PUT', {}, submission),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
  expect((await admin(f)).body).toHaveLength(1);
  const history = await authCall(f.store, {
    action: 'listBuildingSubmissions',
    sessionId: token,
  });
  expect(history.body).toEqual({ playerUuid: PLAYER_UUID, submissions: [{ id, name: input().name, status: 'approved' }] });
});

test('building ID reservation also checks expired records awaiting cleanup', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  initializeBuildingStorage(f.storage);
  const store = new BuildingStore(f.storage);
  const past = new Date(Date.now() - 86400_000).toISOString();
  const expired: BuildingSubmission = {
    id: '11'.repeat(16),
    status: 'rejected',
    submitterUuid: OTHER_UUID,
    submitterName: 'Other',
    payload: { ...input('Expired'), images: [galleryImages[0]] },
    createdAt: past,
    expiresAt: past,
  };
  const draftKey = crypto.randomUUID();
  store.insertSubmission(expired, draftKey);
  expect(() => store.insertSubmission({ ...expired, submitterUuid: PLAYER_UUID }, draftKey)).toThrow();
  expect(store.submission(expired.id)).toBeNull();
  const values = [0x11, 0x22];
  const random = spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
    (bytes as Uint8Array).fill(values.shift() ?? 0x33);
    return bytes;
  });
  try {
    const draft = await permitImage(f, token);
    const created = await submit(f, token, draft);
    expect(created.status).toBe(201);
    expect(created.body.submission.id).toBe('22'.repeat(16));
    const row = f.db.query('SELECT owner,status,document FROM submissions WHERE id=?').get(expired.id) as {
      owner: string;
      status: string;
      document: string;
    };
    expect(row.owner).toBe(OTHER_UUID);
    expect(row.status).toBe(expired.status);
    expect(JSON.parse(row.document)).toMatchObject({ payload: expired.payload });
  } finally {
    random.mockRestore();
  }
});

test('the pending submission cap is atomic', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const drafts = [];
  for (let i = 0; i < 11; i++) drafts.push(await permitImage(f, token));
  const results = await Promise.all(drafts.map((draft, i) => submit(f, token, draft, `Building ${i}`)));
  expect(results.filter((r) => r.status === 201)).toHaveLength(10);
  expect(results.filter((r) => r.status === 429)).toHaveLength(1);
});

test('adding the authenticated submitter cannot exceed the builder cap', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const draft = await permitImage(f, token);
  const builders = Array.from({ length: 50 }, (_, i) => ({
    name: `Builder${i}`,
    uuid: `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`,
    weight: 1,
  }));
  const result = await authCall(f.store, {
    action: 'createBuildingSubmission',
    sessionId: token,
    payload: { draftKey: draft.draftKey, payload: { ...input(), builders, images: [draft.image] } },
  });
  expect(result.status).toBe(422);
});

test('image quota survives concurrent requests and records expire in bounded cleanup', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  expect((await authCall(f.store, { action: 'reserveImageUpload', sessionId: token })).status).toBe(422);
  const reservations = await Promise.all(
    Array.from({ length: 4 }, () =>
      authCall(f.store, { action: 'reserveImageUpload', sessionId: token, draftKey: crypto.randomUUID(), requestKey: crypto.randomUUID() }),
    ),
  );
  expect(reservations.map((r) => r.status).sort()).toEqual([200, 429, 429, 429]);
  f.db.exec('UPDATE image_uploads SET created_at=0,expires_at=0');
  new BuildingStore(f.storage).cleanup();
  expect(f.db.query('SELECT count(*) AS count FROM image_uploads').get()).toEqual({ count: 0 });
});

test('building writes require the current content and leave the publication unchanged for identical edits', async () => {
  const f = setup();
  const created = await admin(f, '/buildings', 'POST', input());
  const building = created.body as Building;
  const path = `/buildings/${building.id}`;
  const store = new BuildingStore(f.storage);
  const version = store.snapshot().version;
  expect((await admin(f, path, 'PUT', input('One'))).status).toBe(428);
  expect((await admin(f, path, 'DELETE')).status).toBe(428);
  expect((await admin(f, path, 'PUT', input(), building)).status).toBe(200);
  expect(await admin(f, path, 'PUT', { ...input(), tags: [], source: null }, building))
    .toEqual({ status: 200, body: building });
  expect(store.snapshot().version).toBe(version);
  const [listed] = (await admin(f)).body as Building[];
  const reordered = Object.fromEntries(Object.entries(listed).reverse()) as unknown as Building;
  const results = await Promise.all([
    admin(f, path, 'PUT', input('One'), reordered),
    admin(f, path, 'PUT', input('Two'), reordered),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
  expect(store.snapshot().version).toBe(version + 1);
});

test('admin HTTP boundary preserves escaped JSON within the 64 KiB limit', async () => {
  const f = setup();
  const payload = input('Escaped');
  payload.builders[0].name = '\\"'.repeat(16000);
  const body = JSON.stringify(payload);
  expect(new TextEncoder().encode(body).byteLength).toBeLessThan(65536);
  const response = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.example/admin/api/buildings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://data.example' },
      body,
    }),
    f.env,
    { email: 'admin@example.com' },
  );
  expect(response?.status).toBe(201);
  expect((await response?.json()).builders[0].name).toBe(payload.builders[0].name);
});

test('admin HTTP adapter rejects malformed, cross-site and unsupported requests before storage', async () => {
  const f = setup();
  f.env.AUTH_STORE = {
    get: () => {
      throw new Error('Unexpected coordinator');
    },
  } as unknown as DurableObjectNamespace;
  for (const [method, headers, body, expected] of [
    ['POST', { 'Content-Type': 'application/json' }, '{broken', 400],
    ['POST', { 'Content-Type': 'text/plain' }, '{}', 415],
    ['POST', { 'Content-Type': 'application/jsonp' }, '{}', 415],
    ['POST', { Origin: 'https://other.example' }, '{}', 403],
    ['PUT', {}, '{}', 405],
    ['POST', { 'Content-Type': 'application/json' }, 'x'.repeat(65537), 413],
  ] as const) {
    const response = await handleAdminBuildingsRoute(
      '/buildings',
      new Request('https://data.example/admin/api/buildings', {
        method,
        headers,
        body,
      }),
      f.env,
      {},
    );
    expect(response?.status).toBe(expected);
  }
});

test('completed uploads stay within a draft, survive retries and publish ordered image pairs under the reserved ID', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const other = await seedSession(f.values, 0, OTHER_UUID);
  const draftKey = crypto.randomUUID();
  const reserve = (requestKey: string, draft = draftKey) => authCall(f.store, {
    action: 'reserveImageUpload', sessionId: token, draftKey: draft, requestKey,
  });
  const bytes = galleryWebps;
  const hashes = galleryHashes;
  const prepare = (uploadId: string, hashes: typeof galleryHashes[number]) => authCall(f.store, {
    action: 'prepareImageUpload', sessionId: token, uploadId, hashes,
  });
  const complete = (id: string, data = bytes[0]) => completeImage(f, token, id, data);
  const firstRequest = crypto.randomUUID();
  const first = await reserve(firstRequest);
  expect(first.body).toEqual({ uploadId: expect.any(String) });
  expect((await reserve(firstRequest)).status).toBe(429);
  expect((await complete(first.body.uploadId)).status).toBe(409);
  const signed = await prepare(first.body.uploadId, hashes[0]);
  expect(Object.keys(signed.body)).toEqual(['put']);
  const [, , id] = new URL(signed.body.put.webp.url).pathname.split('/');
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(signed.body.put.webp.headers['x-amz-content-sha256']).toBe(hashes[0].webp);
  expect(signed.body.put.jxl.headers['x-amz-content-sha256']).toBe(hashes[0].jxl);
  expect((await prepare(first.body.uploadId, hashes[1])).status).toBe(409);
  expect((await completeImage(f, other.token, first.body.uploadId, bytes[0])).status).toBe(409);
  expect((await complete(first.body.uploadId, bytes[1])).status).toBe(502);
  expect((await completeImage(f, token, first.body.uploadId, bytes[0], true)).status).toBe(502);
  const completed = await complete(first.body.uploadId);
  expect(completed.status).toBe(200);
  expect(await complete(first.body.uploadId)).toEqual(completed);
  expect((await reserve(firstRequest)).body).toEqual({ image: galleryImages[0], expiresAt: expect.any(Number) });
  const second = await reserve(crypto.randomUUID());
  const secondPut = await prepare(second.body.uploadId, hashes[1]);
  expect(new URL(secondPut.body.put.webp.url).pathname).toBe(`/buildings/${id}/${hashes[1].webp}.webp`);
  expect((await complete(second.body.uploadId, bytes[1])).status).toBe(200);
  const otherDraft = crypto.randomUUID();
  const separate = await reserve(crypto.randomUUID(), otherDraft);
  expect((await complete(separate.body.uploadId)).status).toBe(409);
  const separatePut = await prepare(separate.body.uploadId, hashes[0]);
  expect(new URL(separatePut.body.put.webp.url).pathname).not.toBe(new URL(signed.body.put.webp.url).pathname);
  const images = galleryImages.slice(0, 2);
  const payload = { ...input(), images };
  const create = (sessionId: string, key?: string, gallery = images) => authCall(f.store, {
    action: 'createBuildingSubmission',
    sessionId,
    payload: { payload: { ...payload, images: gallery }, draftKey: key },
  });
  expect(await create(token)).toEqual({ status: 422, body: { error: 'invalid_draft' } });
  expect((await create(other.token, draftKey)).status).toBe(422);
  expect((await create(token, otherDraft)).status).toBe(422);
  expect((await create(token, draftKey, [{ ...images[1], jxl: images[0].jxl }])).status).toBe(422);
  const submitted = await create(token, draftKey);
  const summary = { id, name: payload.name, status: 'pending' };
  expect(submitted).toEqual({ status: 201, body: { playerUuid: PLAYER_UUID, submission: summary } });
  const submission = storedSubmission(f, id);
  expect(submission.payload.images).toEqual(images);
  const history = (sessionId: string) => authCall(f.store, { action: 'listBuildingSubmissions', sessionId });
  expect((await history(token)).body).toEqual({ playerUuid: PLAYER_UUID, submissions: [summary] });
  expect((await history(other.token)).body).toEqual({ playerUuid: OTHER_UUID, submissions: [] });
  const route = '/building-submissions/' + id + '/approve';
  expect((await admin(f, route, 'PUT', { payload: input() }, submission)).status).toBe(422);
  expect((await admin(f, route, 'PUT', {
    payload: { ...payload, images: [{ ...images[0], webp: 'f'.repeat(64) }] },
  }, submission)).status).toBe(422);
  f.db.exec('DELETE FROM image_uploads');
  expect(await create(token, draftKey)).toEqual({ status: 200, body: submitted.body });
  expect(await reserve(firstRequest)).toEqual({ status: 409, body: { error: 'draft_submitted' } });
  expect(f.db.query('SELECT COUNT(*) AS n FROM submissions').get()).toEqual({ n: 1 });
  expect(f.db.query('SELECT COUNT(*) AS n FROM image_uploads').get()).toEqual({ n: 0 });

  const ordered = [...images].reverse();
  const approved = await admin(f, route, 'PUT', { payload: { ...payload, images: ordered } }, submission);
  expect(approved.status).toBe(200);
  expect(approved.body).toEqual({ building: { id, ...payload, images: ordered } });
  expect(storedSubmission(f, id).payload.images).toEqual(ordered);
  const stored = JSON.parse((f.db.query('SELECT document FROM buildings WHERE id=?').get(id) as { document: string }).document);
  expect(stored.images).toEqual(ordered);
  const list = await handlePublicBuildingsRoute('/buildings', new Request('https://data.example/api/buildings?locale=en'), f.env);
  expect((await list!.json()).buildings[0].images).toEqual(ordered);
  f.db.exec('UPDATE building_publication SET next_attempt=0');
  await f.store.alarm();
  expect(JSON.parse(f.kv.get(PUBLIC_BUILDINGS_KEY)!).buildings[0]).toEqual(stored);
  const detail = await handlePublicBuildingsRoute('/buildings/' + id, new Request('https://data.example/api/buildings/' + id), f.env);
  expect((await detail!.json()).building.images).toEqual(ordered);
});

test('removing the last gallery reference waits for publication, survives reattachment and retries S3 deletion', async () => {
  const f = setup();
  const source = (await admin(f, '/buildings', 'POST', input('First'))).body;
  const hash = await sha256(galleryWebps[0]);
  const key = `buildings/${source.id}/${hash}.webp`;
  const image = galleryImages[0];
  const path = '/buildings/' + source.id;
  const draft = crypto.randomUUID();
  let current: Building = source;
  const saveGallery = async (images: BuildingImage[], imageDraft?: string) => {
    const response = await admin(f, path, 'PUT', { ...input('First'), images }, current, imageDraft);
    if (response.status === 200) current = response.body;
    return response;
  };
  const attach = async () => {
    expect((await adminUpload(f, draft, source.id)).status).toBe(200);
    const response = await saveGallery([image], draft);
    expect(response.status).toBe(200);
    f.db.exec('UPDATE image_uploads SET expires_at=0');
  };
  await attach();
  const state = () => f.db.query('SELECT state,due FROM building_image_objects WHERE object_key=?').get(key) as {state: string; due: number | null};
  async function sweep() {
    f.values.delete('maintenance:next-sweep');
    f.db.exec('UPDATE building_publication SET next_attempt=0');
    await f.store.alarm();
  }
  await sweep();
  expect(state().due).toBeNull();
  expect((await saveGallery([])).status).toBe(200);
  f.setFail(true);
  await sweep();
  expect(state().due).toBeNull();
  const detached = new BuildingStore(f.storage).publication().revision;
  expect(f.db.query('SELECT retire_revision FROM building_image_objects WHERE object_key=?').get(key))
    .toEqual({ retire_revision: detached });
  f.setFail(false);
  await sweep();
  expect(state().due).toBeGreaterThanOrEqual(Date.now() + 13 * 86400_000);
  await attach();
  expect(state().due).toBeNull();
  expect((await saveGallery([])).status).toBe(200);
  await sweep();

  let attempts = 0;
  const network = spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    expect(init?.redirect).toBe('manual');
    expect(request).toBeInstanceOf(Request);
    const req = request as Request;
    expect([key, `buildings/${source.id}/${image.jxl}.jxl`].some(object => req.url === 'https://bucket.example/' + object)).toBe(true);
    expect(req.method).toBe('DELETE');
    expect(req.headers.get('Authorization')).toContain('/test-region/s3/aws4_request');
    attempts++;
    return new Response(null, { status: attempts === 1 ? 503 : 404 });
  });
  try {
    f.db.exec("UPDATE building_image_objects SET due=0 WHERE state<>'deleted'");
    await sweep();
    expect(state().state).toBe('deleting');
    expect((await adminUploadRequest(f, draft, galleryWebps[0], { target: source.id })).status).toBe(409);
    expect((await admin(f)).body[0].images).toEqual(input().images);
    f.db.exec("UPDATE building_image_objects SET due=0 WHERE state<>'deleted'");
    await sweep();
    expect(attempts).toBe(3);
    expect(state()).toEqual({ state: 'deleted', due: null });
    expect((await saveGallery([image], draft)).status).toBe(422);
    await sweep();
    expect(attempts).toBe(3);
  } finally {
    network.mockRestore();
  }
  await attach();
  expect(state()).toEqual({ state: 'active', due: null });
});

test('an incomplete upload expires independently of a rejected submission’s image reference', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const approvedDraft = await permitImage(f, token);
  const submitted = await submit(f, token, approvedDraft);
  const id = submitted.body.submission.id;
  const reserve = await authCall(f.store, { action: 'reserveImageUpload', sessionId: token,
    draftKey: crypto.randomUUID(), requestKey: crypto.randomUUID() });
  const abandoned = await authCall(f.store, { action: 'prepareImageUpload', sessionId: token,
    uploadId: reserve.body.uploadId, hashes: { webp: 'f'.repeat(64), jxl: 'a'.repeat(64) } });
  expect(abandoned.status).toBe(200);
  f.db.exec('UPDATE image_uploads SET expires_at=0');
  await f.store.alarm();
  const due = (key: string) => (f.db.query('SELECT due FROM building_image_objects WHERE object_key=?')
    .get(key) as { due: number | null }).due;
  expect(due(new URL(abandoned.body.put.webp.url).pathname.slice(1))).toBeNumber();
  expect(due(approvedDraft.key)).toBeNull();
  const reviewed = await admin(f, '/building-submissions/' + id + '/reject', 'PUT', { reviewNote: 'Retry' }, storedSubmission(f, id));
  expect(reviewed.status).toBe(200);
  f.values.delete('maintenance:next-sweep');
  await f.store.alarm();
  expect(due(approvedDraft.key)).toBeNull();
  f.db.exec('UPDATE submissions SET expires_at=0');
  f.values.delete('maintenance:next-sweep');
  await f.store.alarm();
  expect(due(approvedDraft.key)).toBeNumber();
});

test('admin image uploads reserve one building ID and require verified uploads from the same draft', async () => {
  const f = setup();
  const draft = crypto.randomUUID();
  expect((await adminUploadRequest(f, draft, galleryWebps[0], { origin: 'https://elsewhere.example' })).status).toBe(403);
  expect((await adminUploadRequest(f, draft, Uint8Array.of(0))).status).toBe(422);
  const webpWithoutPixels = galleryWebps[1].slice(0, 30);
  const header = new DataView(webpWithoutPixels.buffer);
  header.setUint32(4, webpWithoutPixels.length - 8, true);
  header.setUint32(16, 10, true);
  expect((await adminUploadRequest(f, draft, webpWithoutPixels)).status).toBe(422);
  const truncatedJxl = galleryJxls[0].slice(0, -1);
  expect((await adminUploadRequest(f, draft, galleryWebps[0], { jxl: truncatedJxl })).status).toBe(422);
  expect((await adminUpload(f, draft, undefined, galleryWebps[0], 503)).status).toBe(502);
  expect((await adminUpload(f, draft, undefined, galleryWebps[0], 200, true)).status).toBe(502);
  const first = await adminUpload(f, draft);
  const second = await adminUpload(f, draft, undefined, galleryWebps[1]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.body.image).toEqual(galleryImages[0]);
  expect(await adminUploadRequest(f, draft, galleryWebps[0])).toEqual(first);
  const { buildingId } = first.body;
  expect(second.body.buildingId).toBe(buildingId);
  const images = [second.body.image, first.body.image];
  const payload = { ...input(), images };
  expect((await admin(f, '/buildings', 'POST', payload)).status).toBe(422);
  expect((await admin(f, '/buildings', 'POST', payload, undefined, draft, 'other@example.com')).status).toBe(422);
  const saved = await admin(f, '/buildings', 'POST', payload, undefined, draft);
  expect(saved.status).toBe(201);
  expect(saved.body.id).toBe(buildingId);
  expect(saved.body.images).toEqual(images);
  expect((await admin(f, '/buildings', 'POST', payload, undefined, draft)).status).toBe(409);

  const path = '/buildings/' + buildingId;
  const trimmed = await admin(f, path, 'PUT', { ...input(), images: [images[1]] }, saved.body);
  expect(trimmed.body.images).toEqual([images[1]]);
  const nextDraft = crypto.randomUUID();
  const added = await adminUpload(f, nextDraft, buildingId, galleryWebps[2]);
  expect(added.status).toBe(200);
  expect((await adminUploadRequest(f, nextDraft, galleryWebps[0], { target: 'a'.repeat(32) })).status).toBe(409);
  expect((await admin(f, path, 'PUT', { ...input(), images: [images[1], added.body.image] }, trimmed.body, crypto.randomUUID())).status).toBe(422);
  expect((await admin(f, path, 'PUT', { ...input(), images: [images[1], 'e'.repeat(64) + '.webp'] }, trimmed.body, nextDraft)).status).toBe(422);
  const edited = await admin(f, path, 'PUT', { ...input(), images: [added.body.image, images[1]] }, trimmed.body, nextDraft);
  expect(edited.body.images).toEqual([added.body.image, images[1]]);
});

test('review rejects unexpected fields before changing the saved submission', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const draft = await permitImage(f, token);
  const created = await submit(f, token, draft);
  const submission = storedSubmission(f, created.body.submission.id);
  const path = '/building-submissions/' + submission.id;

  expect(await admin(f, path + '/approve', 'PUT', { paylod: submission.payload }, submission))
    .toEqual({ status: 422, body: { error: 'unknown field: paylod' } });
  expect(await admin(f, path, 'PUT', { payload: submission.payload, images: [] }, submission))
    .toEqual({ status: 422, body: { error: 'unknown field: images' } });
  expect(await admin(f, path + '/reject', 'PUT', { reviewNote: 'Retry', payload: submission.payload }, submission))
    .toEqual({ status: 422, body: { error: 'unknown field: payload' } });
  expect(storedSubmission(f, submission.id)).toEqual(submission);
  expect((await admin(f)).body).toEqual([]);

  expect(await admin(f, path + '/approve', 'PUT', undefined, submission))
    .toEqual({ status: 400, body: { error: 'invalid JSON body' } });
  expect(await admin(f, path + '/approve', 'PUT', {}, submission))
    .toEqual({ status: 200, body: { building: { id: submission.id, ...submission.payload } } });
});

test('invalid submission filters never broaden the queue query', async () => {
  const f = setup();
  expect(await admin(f, '/building-submissions?status=pending'))
    .toEqual({ status: 200, body: { submissions: [] } });
  for (const query of ['status=pendng', 'status=', 'status=pending&status=approved']) {
    expect(await admin(f, '/building-submissions?' + query))
      .toEqual({ status: 400, body: { error: 'invalid_status' } });
  }
});

test('admins can add, reorder and remove submission images before approval', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const playerDraft = await permitImage(f, token);
  const created = await submit(f, token, playerDraft);
  const submission = storedSubmission(f, created.body.submission.id);
  const draft = crypto.randomUUID();
  const first = await adminUpload(f, draft, submission.id, galleryWebps[1]);
  const second = await adminUpload(f, draft, submission.id, galleryWebps[2]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const path = '/building-submissions/' + submission.id;
  const images = [second.body.image, first.body.image, playerDraft.image];
  const payload = { ...submission.payload, images };
  expect((await admin(f, path, 'PUT', { payload }, submission, draft, 'other@example.com')).status).toBe(422);
  const updated = await admin(f, path, 'PUT', { payload }, submission, draft);
  expect(updated.status).toBe(200);
  expect(updated.body.submission.payload.images).toEqual(images);
  expect((await admin(f, path + '/reject', 'PUT', { reviewNote: 'Retry' })).status).toBe(428);
  expect((await admin(f, path + '/reject', 'PUT', { reviewNote: 'Retry' }, submission)).status).toBe(412);
  const ordered = [first.body.image, second.body.image];
  const approved = await admin(f, path + '/approve', 'PUT', {
    payload: { ...payload, images: ordered },
  }, updated.body.submission);
  expect(approved.status).toBe(200);
  expect(approved.body.building.id).toBe(submission.id);
  expect(approved.body.building.images).toEqual(ordered);
});

test('completed uploads and saved submissions remain usable across public base URL changes', async () => {
  const f = setup();
  const base = 'https://new.example/photos';
  const { token } = await seedSession(f.values);
  const draft = await permitImage(f, token);
  const building = (await admin(f, '/buildings', 'POST', input('Admin'))).body as Building;
  const adminDraft = crypto.randomUUID();
  const uploaded = await adminUpload(f, adminDraft, building.id);
  const key = 'buildings/' + building.id + '/' + uploaded.body.image.webp + '.webp';
  const saved = await admin(f, '/buildings/' + building.id, 'PUT', { ...input('Admin'), images: [uploaded.body.image] }, building, adminDraft);
  expect(saved.status).toBe(200);
  const env = { ...f.env, BUILDING_IMAGE_PUBLIC_BASE_URL: base };
  const store = new AuthStore({ storage: f.storage } as DurableObjectState, env);
  const current = await authCall(store, {
    action: 'adminBuildingMutation', operation: 'listBuildings',
  });
  expect(current.body[0]).toEqual(saved.body);
  const edit = await authCall(store, {
    action: 'adminBuildingMutation', operation: 'replaceBuilding', id: building.id,
    body: { ...input('Renamed'), images: saved.body.images }, ifMatch: await contentTag(canonicalContent(current.body[0])),
  });
  expect(edit.status).toBe(200);
  expect(f.db.query('SELECT owner FROM building_image_refs WHERE object_key=? AND owner=?').get(key, 'building/' + building.id))
    .toEqual({ owner: 'building/' + building.id });
  const upload = f.db.query('SELECT id FROM image_uploads WHERE draft_key=?').get(draft.draftKey) as { id: string };
  const completed = await completeImage({ ...f, store, env }, token, upload.id, galleryWebps[0]);
  expect(completed.status).toBe(200);
  expect(completed.body.image).toEqual(draft.image);
  const submitted = await submit({ ...f, store }, token, draft);
  expect(submitted.status).toBe(201);
  const submission = storedSubmission(f, submitted.body.submission.id);
  const approved = await admin(f, `/building-submissions/${submission.id}/approve`, 'PUT', {}, submission);
  expect(approved.status).toBe(200);
  expect(approved.body.building.images).toEqual([draft.image]);
});
