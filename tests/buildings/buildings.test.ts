import { expect, spyOn, test } from 'bun:test';
import { BuildingStore, PUBLIC_BUILDINGS_KEY, PUBLISH_INTERVAL_MS } from '../../src/buildings/store';
import { sha256 } from '../../src/buildings/images/storage';
import { AuthStore } from '../../src/auth/store';
import { initializeBuildingStorage } from '../../src/buildings/schema';
import { handleAdminBuildingsRoute } from '../../src/buildings/admin-route';
import { handlePublicBuildingsRoute } from '../../src/buildings/public-route';
import { validateBuildingInput } from '../../src/buildings/validation';
import type { Building, BuildingSubmission, BuildingSubmissionImage } from '../../src/buildings/types';
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
  images: [] as string[],
  buildDate: '2026-06-27',
});
const image: BuildingSubmissionImage = {
  url: `https://images.example/gallery/buildings/${'11'.repeat(16)}/${'a'.repeat(64)}.webp`,
  width: 1280,
  height: 720,
  size: 120_000,
  mime: 'image/webp',
};
const imageBaseUrl = 'https://images.example/gallery';
function setup(publicBaseUrl = imageBaseUrl) {
  const kv = new Map<string, string>();
  let writes = 0;
  let fail = false;
  const fixture = testAuthStore({
    BUILDING_IMAGE_PUBLIC_BASE_URL: publicBaseUrl,
    BUILDING_IMAGE_S3_BUCKET_URL: publicBaseUrl && 'https://bucket.example',
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
  expected?: string,
  draft?: string,
  actor = 'admin@example.com',
) {
  const response = await handleAdminBuildingsRoute(
    route,
    new Request(`https://data.example/admin/api${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(expected ? { 'X-Expected-Updated-At': expected } : {}),
        ...(draft ? { 'X-Building-Draft': draft } : {}),
      },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
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

async function adminUploadRequest(f: ReturnType<typeof setup>, draft: string, bytes: Uint8Array<ArrayBuffer>, target?: string, origin = 'https://data.example') {
  const path = '/building-images';
  const url = 'https://data.example/admin/api' + path + (target ? '?building=' + target : '');
  const response = await handleAdminBuildingsRoute(path, new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp', Origin: origin, 'X-Building-Draft': draft },
    body: bytes,
  }), f.env, { email: 'admin@example.com' });
  return { status: response!.status, body: await response!.json() };
}

async function adminUpload(
  f: ReturnType<typeof setup>, draft: string, target?: string,
  bytes = galleryWebps[0], writtenStatus = 200, mismatch = false,
) {
  const hash = await sha256(bytes);
  const network = spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    const url = new URL(request as string);
    if (init?.method === 'PUT') {
      expect(url.origin).toBe('https://bucket.example');
      expect(url.pathname).toEndWith('/' + hash + '.webp');
      expect(new Headers(init.headers).get('x-amz-content-sha256')).toBe(hash);
      expect(init.body).toEqual(bytes);
      return new Response(null, { status: writtenStatus });
    }
    expect(url.origin + url.pathname).toStartWith(f.env.BUILDING_IMAGE_PUBLIC_BASE_URL!.replace(/\/$/, '') + '/');
    const original = bytes.slice();
    if (mismatch) original[original.length - 1] ^= 1;
    return new Response(original, { headers: { 'Content-Type': 'image/webp' } });
  });
  try {
    return await adminUploadRequest(f, draft, bytes, target);
  } finally {
    network.mockRestore();
  }
}

async function completeImage(fixture: ReturnType<typeof setup>, token: string, id: string, receipt: BuildingSubmissionImage, bytes: Uint8Array) {
  const network = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    expect(init?.redirect).toBe('manual');
    return new Response(bytes, { headers: { 'content-type': 'image/webp' } });
  });
  try {
    return await authCall(fixture.store, { action: 'completeImageUpload', sessionId: token, uploadId: id, image: receipt });
  } finally {
    network.mockRestore();
  }
}

async function permitImage(fixture: ReturnType<typeof setup>, token: string) {
  const draftKey = crypto.randomUUID();
  const reserved = await authCall(fixture.store, {
    action: 'reserveImageUpload', sessionId: token, draftKey, requestKey: crypto.randomUUID(),
  });
  expect(reserved.status).toBe(200);
  const bytes = new Uint8Array(image.size);
  const prepared = await authCall(fixture.store, {
    action: 'prepareImageUpload', sessionId: token, uploadId: reserved.body.uploadId, hash: await sha256(bytes),
  });
  expect(prepared.status).toBe(200);
  const receipt = { ...image, url: prepared.body.url };
  const completed = await completeImage(fixture, token, reserved.body.uploadId, receipt, bytes);
  expect(completed.status).toBe(200);
  return { draftKey, receipt };
}

async function submit(fixture: ReturnType<typeof setup>, token: string, draft: Awaited<ReturnType<typeof permitImage>>, name = 'Building') {
  return authCall(fixture.store, {
    action: 'createBuildingSubmission', sessionId: token,
    payload: { draftKey: draft.draftKey, payload: { ...input(name), images: [draft.receipt.url] }, images: [draft.receipt] },
  });
}

test('validation rejects unknown fields, invalid dates and insecure image URLs', () => {
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

function stored(name = 'Building', id = 'ab'.repeat(16)): Building {
  const now = '2026-06-27T00:00:00.000Z';
  return { id, ...input(name), createdAt: now, updatedAt: now };
}

test('a missing public snapshot is rebuilt from SQLite and republished', async () => {
  const f = setup(),
    store = new BuildingStore(f.storage);
  initializeBuildingStorage(f.storage);
  store.insertBuilding(stored());
  const response = await handlePublicBuildingsRoute(
    '/buildings',
    new Request('https://data.example/api/buildings'),
    f.env,
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual([stored()]);
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
  expect(await response?.json()).toEqual([]);
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
  expect(await list!.json()).toEqual([building]);
  const detail = await handlePublicBuildingsRoute(
    `/buildings/${building.id}`,
    new Request(`https://data.example/api/buildings/${building.id}`),
    f.env,
  );
  expect(await detail!.json()).toEqual(building);
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

test('conditional deletes enforce the expected version without publishing failed mutations', async () => {
  const f = setup();
  const created = await admin(f, '/buildings', 'POST', input());
  const original = created.body as Building;
  const updated = await admin(f, `/buildings/${original.id}`, 'PUT', input('Updated'));
  const store = new BuildingStore(f.storage);
  const revision = store.snapshot().version;
  const stale = await admin(f, `/buildings/${original.id}`, 'DELETE', undefined, original.updatedAt);
  expect(stale.status).toBe(409);
  expect(store.snapshot().version).toBe(revision);
  expect(store.building(original.id)).toEqual(updated.body);
  const deleted = await admin(f, `/buildings/${original.id}`, 'DELETE', undefined, updated.body.updatedAt);
  expect(deleted.status).toBe(200);
  expect(store.snapshot()).toEqual({ version: revision + 1, buildings: [] });
  expect((await admin(f, `/buildings/${original.id}`, 'DELETE')).status).toBe(404);
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
  for (const method of ['PUT', 'PATCH']) {
    const rejected = await admin(f, `/buildings/${original.id}`, method, {
      ...input(), id: 'changed123',
    });
    expect(rejected.status).toBe(422);
  }

  const replacement = {
    ...input('Renamed'),
    coordinates: { world: 'world_nether', x: 100, y: 70, z: -200 },
    builders: [{ name: 'Other', uuid: OTHER_UUID, weight: 2 }],
    buildDate: '2026-06-28',
  };
  const replaced = await admin(f, `/buildings/${original.id}`, 'PUT', replacement);
  expect(replaced.status).toBe(200);
  expect(replaced.body).toMatchObject({
    ...replacement,
    id: original.id,
    createdAt: original.createdAt,
  });
  const patched = await admin(f, `/buildings/${original.id}`, 'PATCH', {
    name: { en: 'Patched' },
  });
  expect(patched.status).toBe(200);
  expect(patched.body.id).toBe(original.id);
  expect(patched.body.name).toEqual({ 'zh-CN': 'Renamed', en: 'Patched' });

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
  expect(await detail!.json()).toEqual(patched.body);
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
    expect(imported.body.imported).toBe(2);
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
  const submission = created.body.submission as BuildingSubmission;
  f.failNextSql('UPDATE submissions');
  const failed = await admin(f, `/building-submissions/${submission.id}/approve`, 'PUT', {});
  expect(failed.status).toBe(500);
  expect((await admin(f)).body).toHaveLength(0);
  expect(new BuildingStore(f.storage, imageBaseUrl).submission(submission.id)?.status).toBe('pending');
  const retry = await admin(f, `/building-submissions/${submission.id}/approve`, 'PUT', {});
  expect(retry.status).toBe(200);
  expect(retry.body.building.id).toMatch(/^[0-9a-f]{32}$/);
  expect(retry.body.submission.id).toBe(retry.body.building.id);
  expect(retry.body.submission).not.toHaveProperty('buildingId');
  expect(new BuildingStore(f.storage, imageBaseUrl).building(retry.body.building.id)).toEqual(retry.body.building);
  expect(new BuildingStore(f.storage, imageBaseUrl).submission(submission.id)?.status).toBe('approved');
  expect((await admin(f)).body).toHaveLength(1);
  expect(f.writes()).toBe(0);
});

test('concurrent approval creates exactly one building and retains the review result', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const draft = await permitImage(f, token);
  const created = await submit(f, token, draft);
  const id = (created.body.submission as BuildingSubmission).id;
  const results = await Promise.all([
    admin(f, `/building-submissions/${id}/approve`, 'PUT', {}),
    admin(f, `/building-submissions/${id}/approve`, 'PUT', {}),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await admin(f)).body).toHaveLength(1);
  const history = await authCall(f.store, {
    action: 'listBuildingSubmissions',
    sessionId: token,
  });
  expect((history.body.submissions as BuildingSubmission[])[0].status).toBe('approved');
});

test('building ID reservation also checks expired records awaiting cleanup', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  initializeBuildingStorage(f.storage);
  const store = new BuildingStore(f.storage, imageBaseUrl);
  const past = new Date(Date.now() - 86400_000).toISOString();
  const expired: BuildingSubmission = {
    id: '11'.repeat(16),
    status: 'rejected',
    submitterUuid: OTHER_UUID,
    submitterName: 'Other',
    submitterRole: 'member',
    payload: { ...input('Expired'), images: [image.url] },
    images: [image],
    createdAt: past,
    updatedAt: past,
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
    const row = f.db.query('SELECT owner,document FROM submissions WHERE id=?').get(expired.id) as {
      owner: string;
      document: string;
    };
    expect(row.owner).toBe(OTHER_UUID);
    expect(JSON.parse(row.document)).toMatchObject({ id: expired.id, status: expired.status });
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
    payload: { draftKey: draft.draftKey, payload: { ...input(), builders, images: [draft.receipt.url] }, images: [draft.receipt] },
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

test('optimistic concurrency rejects stale building updates inside the transaction', async () => {
  const f = setup();
  const created = await admin(f, '/buildings', 'POST', input());
  const building = created.body as unknown as Building;
  const results = await Promise.all([
    admin(f, `/buildings/${building.id}`, 'PUT', input('One'), building.updatedAt),
    admin(f, `/buildings/${building.id}`, 'PUT', input('Two'), building.updatedAt),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
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

test('upload receipts stay within a draft, survive retries and publish ordered hashes under the reserved ID', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const other = await seedSession(f.values, 0, OTHER_UUID);
  const draftKey = crypto.randomUUID();
  const reserve = (requestKey: string, draft = draftKey) => authCall(f.store, {
    action: 'reserveImageUpload', sessionId: token, draftKey: draft, requestKey,
  });
  const bytes = [new Uint8Array(image.size), new Uint8Array(image.size).fill(1)];
  const hashes = await Promise.all(bytes.map(sha256));
  const prepare = (uploadId: string, hash: string) => authCall(f.store, {
    action: 'prepareImageUpload', sessionId: token, uploadId, hash,
  });
  const complete = (id: string, metadata: BuildingSubmissionImage, data = bytes[0]) =>
    completeImage(f, token, id, metadata, data);
  const firstRequest = crypto.randomUUID();
  const first = await reserve(firstRequest);
  const id = first.body.buildingId;
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  const prefix = `${imageBaseUrl}/buildings/${id}/`;
  const images = hashes.map(hash => ({ ...image, url: prefix + hash + '.webp' }));
  expect((await reserve(firstRequest)).status).toBe(429);
  expect((await complete(first.body.uploadId, image)).status).toBe(409);
  expect((await complete(first.body.uploadId, images[0])).status).toBe(409);
  const signed = await prepare(first.body.uploadId, hashes[0]);
  expect(signed.body.put.headers['x-amz-content-sha256']).toBe(hashes[0]);
  expect((await prepare(first.body.uploadId, hashes[1])).status).toBe(409);
  expect((await complete(first.body.uploadId, images[0], bytes[1])).status).toBe(502);
  expect((await complete(first.body.uploadId, images[0])).status).toBe(200);
  expect((await complete(first.body.uploadId, images[1])).status).toBe(409);
  expect((await reserve(firstRequest)).body.image).toEqual(images[0]);
  const second = await reserve(crypto.randomUUID());
  expect(second.body.buildingId).toBe(id);
  expect((await prepare(second.body.uploadId, hashes[1])).status).toBe(200);
  expect((await complete(second.body.uploadId, images[1], bytes[1])).status).toBe(200);
  const otherDraft = crypto.randomUUID();
  const separate = await reserve(crypto.randomUUID(), otherDraft);
  expect(separate.body.buildingId).not.toBe(id);
  expect((await complete(separate.body.uploadId, images[0])).status).toBe(409);
  const payload = { ...input(), images: images.map(img => img.url) };
  const clientImages = images.map(receipt => ({ ...receipt, width: 1, size: 1 }));
  const create = (sessionId: string, key?: string, receipts = images) => authCall(f.store, {
    action: 'createBuildingSubmission',
    sessionId,
    payload: { payload, images: receipts, draftKey: key },
  });
  expect(await create(token)).toEqual({ status: 422, body: { error: 'invalid_draft' } });
  expect((await create(other.token, draftKey)).status).toBe(422);
  expect((await create(token, otherDraft)).status).toBe(422);
  const submitted = await create(token, draftKey, clientImages);
  expect(submitted.status).toBe(201);
  expect(submitted.body.submission.images).toEqual(images);
  const route = '/building-submissions/' + submitted.body.submission.id + '/approve';
  expect((await admin(f, route, 'PUT', { payload: input(), images: [image] })).status).toBe(422);
  const unknown = { ...images[0], url: 'https://media.example/unregistered.webp' };
  expect((await admin(f, route, 'PUT', {
    payload: { ...payload, images: [unknown.url] },
    images: [unknown],
  })).status).toBe(422);
  f.db.exec('DELETE FROM image_uploads');
  expect(await create(token, draftKey)).toMatchObject({
    status: 200,
    body: { submission: { id: submitted.body.submission.id } },
  });
  expect(await reserve(firstRequest)).toEqual({ status: 409, body: { error: 'draft_submitted' } });
  expect(f.db.query('SELECT COUNT(*) AS n FROM submissions').get()).toEqual({ n: 1 });
  expect(f.db.query('SELECT COUNT(*) AS n FROM image_uploads').get()).toEqual({ n: 0 });

  const approved = await admin(f, route, 'PUT', {
    payload: { ...payload, images: [...payload.images].reverse() },
    images: [...clientImages].reverse(),
  });
  expect(approved.status).toBe(200);
  expect(approved.body.building.id).toBe(id);
  expect(approved.body.submission.images).toEqual([...images].reverse());
  const stored = JSON.parse((f.db.query('SELECT document FROM buildings WHERE id=?').get(id) as { document: string }).document);
  expect(stored.images).toBeUndefined();
  expect(stored.imageHashes).toEqual([...hashes].reverse());
  const list = await handlePublicBuildingsRoute('/buildings', new Request('https://data.example/api/buildings?locale=en'), f.env);
  expect((await list!.json())[0].images).toEqual([...payload.images].reverse());
  f.db.exec('UPDATE building_publication SET next_attempt=0');
  await f.store.alarm();
  expect(JSON.parse(f.kv.get(PUBLIC_BUILDINGS_KEY)!).buildings[0]).toEqual(stored);
  const detail = await handlePublicBuildingsRoute('/buildings/' + id, new Request('https://data.example/api/buildings/' + id), f.env);
  expect((await detail!.json()).images).toEqual([...payload.images].reverse());
});

test('public list and detail use the configured URL prefix when the same KV revision moves to a CDN', async () => {
  const f = setup('https://media.example/gallery/');
  const created = (await admin(f, '/buildings', 'POST', input())).body as Building;
  const draft = crypto.randomUUID();
  const hash = await sha256(galleryWebps[0]);
  const key = `buildings/${created.id}/${hash}.webp`;
  expect((await adminUpload(f, draft, created.id)).status).toBe(200);
  const patch = await admin(f, '/buildings/' + created.id, 'PATCH', { images: [`https://media.example/gallery/${key}`] }, created.updatedAt, draft);
  expect(patch.body.images).toEqual([`https://media.example/gallery/${key}`]);
  f.db.exec('UPDATE building_publication SET next_attempt=0');
  await f.store.alarm();
  const snapshot = f.kv.get(PUBLIC_BUILDINGS_KEY)!;
  expect(JSON.parse(snapshot).buildings[0].imageHashes).toEqual([hash]);
  for (const base of ['https://media.example/gallery', 'https://cdn.example/photos']) {
    f.env.BUILDING_IMAGE_PUBLIC_BASE_URL = base + '/';
    for (const path of ['/buildings', '/buildings/' + created.id]) {
      const result = await handlePublicBuildingsRoute(path, new Request('https://data.example' + path), f.env);
      const body = await result!.json();
      expect((Array.isArray(body) ? body[0] : body).images).toEqual([`${base}/${key}`]);
    }
  }
  expect(f.kv.get(PUBLIC_BUILDINGS_KEY)).toBe(snapshot);
});

test('removing the last gallery reference waits for publication, survives reattachment and retries S3 deletion', async () => {
  const f = setup();
  const source = (await admin(f, '/buildings', 'POST', input('First'))).body;
  const hash = await sha256(galleryWebps[0]);
  const key = `buildings/${source.id}/${hash}.webp`;
  const url = imageBaseUrl + '/' + key;
  const path = '/buildings/' + source.id;
  const draft = crypto.randomUUID();
  const attach = async () => {
    expect((await adminUpload(f, draft, source.id)).status).toBe(200);
    const response = await admin(f, path, 'PATCH', { images: [url] }, undefined, draft);
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
  expect((await admin(f, path, 'PATCH', { images: [] })).status).toBe(200);
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
  expect((await admin(f, path, 'PATCH', { images: [] })).status).toBe(200);
  await sweep();

  let attempts = 0;
  const network = spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    expect(init?.redirect).toBe('manual');
    expect(request).toBeInstanceOf(Request);
    const req = request as Request;
    expect(req.url).toBe('https://bucket.example/' + key);
    expect(req.method).toBe('DELETE');
    expect(req.headers.get('Authorization')).toContain('/test-region/s3/aws4_request');
    attempts++;
    return new Response(null, { status: attempts === 1 ? 503 : 404 });
  });
  try {
    f.db.exec('UPDATE building_image_objects SET due=0');
    await sweep();
    expect(state().state).toBe('deleting');
    expect((await adminUploadRequest(f, draft, galleryWebps[0], source.id)).status).toBe(409);
    expect((await admin(f)).body[0].images).toEqual(input().images);
    f.db.exec('UPDATE building_image_objects SET due=0');
    await sweep();
    expect(attempts).toBe(2);
    expect(state()).toEqual({ state: 'deleted', due: null });
    expect((await admin(f, path, 'PATCH', { images: [url] }, undefined, draft)).status).toBe(422);
    await sweep();
    expect(attempts).toBe(2);
  } finally {
    network.mockRestore();
  }
  await attach();
  expect(state()).toEqual({ state: 'active', due: null });
});

test('a prepared upload without a receipt is collected after its lease and a rejected submission holds its own reference', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const approvedDraft = await permitImage(f, token);
  const submitted = await submit(f, token, approvedDraft);
  const id = submitted.body.submission.id;
  const reserve = await authCall(f.store, { action: 'reserveImageUpload', sessionId: token,
    draftKey: crypto.randomUUID(), requestKey: crypto.randomUUID() });
  const abandoned = await authCall(f.store, { action: 'prepareImageUpload', sessionId: token,
    uploadId: reserve.body.uploadId, hash: 'f'.repeat(64) });
  expect(abandoned.status).toBe(200);
  f.db.exec('UPDATE image_uploads SET expires_at=0');
  await f.store.alarm();
  const due = (url: string) => (f.db.query('SELECT due FROM building_image_objects WHERE object_key=?')
    .get(url.slice(imageBaseUrl.length + 1)) as { due: number | null }).due;
  expect(due(abandoned.body.url)).toBeNumber();
  expect(due(approvedDraft.receipt.url)).toBeNull();
  const reviewed = await admin(f, '/building-submissions/' + id + '/reject', 'PUT', { reviewNote: 'Retry' });
  expect(reviewed.status).toBe(200);
  f.values.delete('maintenance:next-sweep');
  await f.store.alarm();
  expect(due(approvedDraft.receipt.url)).toBeNull();
  f.db.exec('UPDATE submissions SET expires_at=0');
  f.values.delete('maintenance:next-sweep');
  await f.store.alarm();
  expect(due(approvedDraft.receipt.url)).toBeNumber();
});

test('a pending submission and its completed upload resolve against the current public origin', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const draft = await permitImage(f, token);
  const submitted = await submit(f, token, draft);
  const updated = new AuthStore({ storage: f.storage } as DurableObjectState, { ...f.env, BUILDING_IMAGE_PUBLIC_BASE_URL: 'https://new.example/assets' });
  const approved = await authCall(updated, { action: 'adminBuildingMutation', operation: 'approveSubmission',
    id: submitted.body.submission.id, body: {} });
  const url = draft.receipt.url.replace(imageBaseUrl, 'https://new.example/assets');
  expect(approved.body.building.images).toEqual([url]);
  expect(approved.body.submission.images[0].url).toBe(url);
  expect(new BuildingStore(f.storage, 'https://new.example/assets').snapshot().buildings[0]).toHaveProperty('imageHashes');
});

test('admin image uploads reserve one building ID and require verified, owned receipts to save', async () => {
  const f = setup();
  const draft = crypto.randomUUID();
  expect((await adminUploadRequest(f, draft, galleryWebps[0], undefined, 'https://elsewhere.example')).status).toBe(403);
  expect((await adminUploadRequest(f, draft, Uint8Array.of(0))).status).toBe(422);
  expect((await adminUpload(f, draft, undefined, galleryWebps[0], 503)).status).toBe(502);
  expect((await adminUpload(f, draft, undefined, galleryWebps[0], 200, true)).status).toBe(502);
  const first = await adminUpload(f, draft);
  const second = await adminUpload(f, draft, undefined, galleryWebps[1]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.body.image).toMatchObject({ width: 3, height: 2, mime: 'image/webp' });
  expect(await adminUploadRequest(f, draft, galleryWebps[0])).toEqual(first);
  const buildingId = first.body.image.url.split('/').at(-2);
  expect(second.body.image.url.split('/').at(-2)).toBe(buildingId);
  const images = [second.body.image.url, first.body.image.url];
  const payload = { ...input(), images };
  expect((await admin(f, '/buildings', 'POST', payload)).status).toBe(422);
  expect((await admin(f, '/buildings', 'POST', payload, undefined, draft, 'other@example.com')).status).toBe(422);
  const saved = await admin(f, '/buildings', 'POST', payload, undefined, draft);
  expect(saved.status).toBe(201);
  expect(saved.body.id).toBe(buildingId);
  expect(saved.body.images).toEqual(images);
  expect((await admin(f, '/buildings', 'POST', payload, undefined, draft)).status).toBe(409);

  const path = '/buildings/' + buildingId;
  expect((await admin(f, path, 'PATCH', { images: [images[1]] })).body.images).toEqual([images[1]]);
  const nextDraft = crypto.randomUUID();
  const added = await adminUpload(f, nextDraft, buildingId, galleryWebps[2]);
  expect(added.status).toBe(200);
  expect((await adminUploadRequest(f, nextDraft, galleryWebps[0], 'a'.repeat(32))).status).toBe(409);
  expect((await admin(f, path, 'PATCH', { images: [images[1], added.body.image.url] }, undefined, crypto.randomUUID())).status).toBe(422);
  expect((await admin(f, path, 'PATCH', { images: [images[1], images[1].replace(/[a-f0-9]{64}\.webp$/, 'e'.repeat(64) + '.webp')] }, undefined, nextDraft)).status).toBe(422);
  const edited = await admin(f, path, 'PATCH', { images: [added.body.image.url, images[1]] }, undefined, nextDraft);
  expect(edited.body.images).toEqual([added.body.image.url, images[1]]);
});

test('admins can add, reorder and remove submission images before approval', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const playerDraft = await permitImage(f, token);
  const { body: { submission } } = await submit(f, token, playerDraft);
  const draft = crypto.randomUUID();
  const first = await adminUpload(f, draft, submission.id, galleryWebps[1]);
  const second = await adminUpload(f, draft, submission.id, galleryWebps[2]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const path = '/building-submissions/' + submission.id;
  const receipts = [second.body.image, first.body.image, playerDraft.receipt];
  const payload = { ...submission.payload, images: receipts.map(image => image.url) };
  expect((await admin(f, path, 'PUT', { payload, images: receipts }, submission.updatedAt, draft, 'other@example.com')).status).toBe(422);
  const updated = await admin(f, path, 'PUT', { payload, images: receipts }, submission.updatedAt, draft);
  expect(updated.status).toBe(200);
  expect(updated.body.submission.images).toEqual(receipts);
  const ordered = [first.body.image, second.body.image];
  const approved = await admin(f, path + '/approve', 'PUT', {
    payload: { ...payload, images: ordered.map(image => image.url) }, images: ordered,
  }, updated.body.submission.updatedAt);
  expect(approved.status).toBe(200);
  expect(approved.body.building.id).toBe(submission.id);
  expect(approved.body.building.images).toEqual(ordered.map(image => image.url));
});

test('admin galleries and upload receipts only accept URLs under the current public base', async () => {
  const f = setup();
  const base = 'https://new.example/photos';
  const { token } = await seedSession(f.values);
  const draft = await permitImage(f, token);
  const building = (await admin(f, '/buildings', 'POST', input('Admin'))).body as Building;
  const adminDraft = crypto.randomUUID();
  const uploaded = await adminUpload(f, adminDraft, building.id);
  const key = uploaded.body.image.url.slice(imageBaseUrl.length + 1);
  const saved = await admin(f, '/buildings/' + building.id, 'PATCH', { images: [uploaded.body.image.url] }, undefined, adminDraft);
  const store = new AuthStore({ storage: f.storage } as DurableObjectState, { ...f.env, BUILDING_IMAGE_PUBLIC_BASE_URL: base });
  const edit = await authCall(store, {
    action: 'adminBuildingMutation', operation: 'replaceBuilding', id: building.id,
    body: { ...input('Renamed'), images: saved.body.images }, expectedUpdatedAt: saved.body.updatedAt,
  });
  expect(edit.status).toBe(422);
  const current = await authCall(store, {
    action: 'adminBuildingMutation', operation: 'listBuildings',
  });
  expect(current.body[0].images).toEqual([base + '/' + key]);
  expect(f.db.query('SELECT owner FROM building_image_refs WHERE object_key=? AND owner=?').get(key, 'building/' + building.id))
    .toEqual({ owner: 'building/' + building.id });
  const upload = f.db.query('SELECT id FROM image_uploads WHERE draft_key=?').get(draft.draftKey) as { id: string };
  const receipt = await completeImage({ ...f, store }, token, upload.id, draft.receipt, new Uint8Array(image.size));
  expect(receipt.status).toBe(409);
  const submitted = await submit({ ...f, store }, token, draft);
  expect(submitted.status).toBe(422);
});
