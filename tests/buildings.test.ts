import { expect, spyOn, test } from 'bun:test';
import { BuildingStore, PUBLIC_BUILDINGS_KEY, PUBLISH_INTERVAL_MS } from '../src/building-store';
import { AuthStore } from '../src/auth';
import { migrateBuildingStorage } from '../src/building-migrations';
import { handleAdminBuildingsRoute } from '../src/buildings';
import { handlePublicBuildingsRoute } from '../src/public-buildings';
import { validateBuildingInput } from '../src/building-validation';
import type { Building, BuildingSubmission, BuildingSubmissionImage } from '../src/types';
import {
  authCall,
  OTHER_UUID,
  PLAYER_UUID,
  seedSession,
  testAuthStore,
} from './helpers/auth-store';

const input = (name = 'Building') => ({
  name: { 'zh-CN': name, en: name },
  description: { 'zh-CN': '描述', en: 'Description' },
  coordinates: { world: 'world', x: 0, y: 64, z: 0 },
  builders: [{ name: 'Player', uuid: PLAYER_UUID, weight: 1 }],
  buildType: 'original' as const,
  images: ['https://i.ibb.co/example/building.webp'],
  buildDate: '2026-06-27',
});
const image: BuildingSubmissionImage = {
  url: input().images[0],
  width: 1280,
  height: 720,
  size: 120_000,
  mime: 'image/webp',
};
function setup() {
  const kv = new Map<string, string>();
  let writes = 0;
  let fail = false;
  const fixture = testAuthStore({
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
) {
  const response = await handleAdminBuildingsRoute(
    route,
    new Request(`https://data.example/admin/api${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(expected ? { 'X-Expected-Updated-At': expected } : {}),
      },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
    }),
    fixture.env,
    { email: 'admin@example.com' },
  );
  if (!response) throw new Error('Unexpected admin route');
  return { status: response.status, body: await response.json() };
}

async function permitImage(fixture: ReturnType<typeof setup>, token: string) {
  const reserved = await authCall(fixture.store, {
    action: 'reserveImageUpload',
    sessionId: token,
  });
  expect(reserved.status).toBe(200);
  expect(
    (
      await authCall(fixture.store, {
        action: 'completeImageUpload',
        sessionId: token,
        uploadId: reserved.body.uploadId,
        image,
      })
    ).status,
  ).toBe(200);
}
async function submit(fixture: ReturnType<typeof setup>, token: string, name = 'Building') {
  return authCall(fixture.store, {
    action: 'createBuildingSubmission',
    sessionId: token,
    payload: { payload: input(name), images: [image] },
  });
}

test('validation rejects unknown fields, invalid dates and insecure image URLs', () => {
  expect(validateBuildingInput(input()).ok).toBe(true);
  expect(validateBuildingInput({ ...input(), images: ['/images/test.webp'] }).ok).toBe(true);
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

function seedPreviousBuildingStorage(f: ReturnType<typeof setup>) {
  f.db.exec(`
    CREATE TABLE buildings (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at INTEGER, document TEXT NOT NULL
    );
    CREATE TABLE building_publication (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
      published_revision INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0
    );
  `);
  const legacy = stored('Legacy', 'ab'.repeat(8));
  const current = stored('Current', '11'.repeat(16));
  for (const building of [legacy, current])
    f.db.query('INSERT INTO buildings VALUES(?,?)').run(building.id, JSON.stringify(building));
  const approved: BuildingSubmission = {
    id: 'be'.repeat(8), status: 'approved',
    submitterUuid: PLAYER_UUID, submitterName: 'Player', submitterRole: 'member',
    payload: input('Approved'), images: [image], buildingId: legacy.id,
    reviewer: 'admin@example.com', reviewNote: 'Reviewed',
    createdAt: legacy.createdAt, updatedAt: legacy.updatedAt, expiresAt: legacy.updatedAt,
  };
  const submissions: BuildingSubmission[] = [
    approved,
    { ...approved, id: 'ca'.repeat(8), payload: input('Deleted'), buildingId: '00'.repeat(8) },
    { ...approved, id: 'de'.repeat(8), payload: input('Pending'), status: 'pending',
      buildingId: undefined, expiresAt: undefined },
  ];
  for (const submission of submissions) {
    f.db.query('INSERT INTO submissions VALUES(?,?,?,?,?,?)').run(
      submission.id, submission.submitterUuid, submission.status, submission.createdAt,
      submission.expiresAt ? Date.parse(submission.expiresAt) : null, JSON.stringify(submission),
    );
  }
  const nextAttempt = Date.now() + PUBLISH_INTERVAL_MS;
  f.db.query('INSERT INTO building_publication VALUES(1,7,7,?,0)').run(nextAttempt);
  f.kv.set(PUBLIC_BUILDINGS_KEY, JSON.stringify({ version: 7, buildings: [legacy, current] }));
  return { legacy, current, submissions, nextAttempt };
}

test('a missing public snapshot is rebuilt from SQLite and republished', async () => {
  const f = setup(),
    store = new BuildingStore(f.storage);
  migrateBuildingStorage(f.storage);
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
  expect(JSON.parse(f.kv.get(PUBLIC_BUILDINGS_KEY)!).buildings).toEqual([stored()]);
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
  migrateBuildingStorage(f.storage);
  const building = stored('Authoritative');
  store.insertBuilding(building);
  f.kv.set(PUBLIC_BUILDINGS_KEY, JSON.stringify({
    version: 99,
    buildings: [building, { ...building, name: input('Conflicting').name }],
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
  migrateBuildingStorage(f.storage);
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

test('ID migration preserves existing data and references, then republishes one stable catalog revision', async () => {
  const f = setup();
  const previous = seedPreviousBuildingStorage(f);
  const values = [0x11, 0x22, 0x22, 0x33, 0x44, 0x55, 0x66];
  const random = spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
    (bytes as Uint8Array).fill(values.shift() ?? 0x77);
    return bytes;
  });
  try {
    const response = await handlePublicBuildingsRoute(
      '/buildings', new Request('https://data.example/api/buildings'), f.env,
    );
    expect(response?.status).toBe(200);
    const buildings = await response!.json() as Building[];
    expect(buildings).toHaveLength(2);
    const migrated = buildings.find((building) => building.name.en === 'Legacy')!;
    expect(migrated.id).toMatch(/^[0-9a-f]{32}$/);
    expect(migrated).toEqual({ ...previous.legacy, id: migrated.id });
    expect(buildings.find((building) => building.id === previous.current.id)).toEqual(previous.current);

    const store = new BuildingStore(f.storage);
    expect(store.building(previous.legacy.id)).toBeNull();
    expect(store.duplicateBuildingId(previous.legacy)).toBe(migrated.id);
    const rows = f.db.query('SELECT * FROM submissions').all() as {
      id: string; owner: string; status: string; created_at: string;
      expires_at: number | null; document: string;
    }[];
    expect(rows).toHaveLength(previous.submissions.length);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (const original of previous.submissions) {
      const row = rows.find((row) => JSON.parse(row.document).payload.name.en === original.payload.name.en)!;
      const submission = JSON.parse(row.document) as BuildingSubmission;
      expect(row.id).toMatch(/^[0-9a-f]{32}$/);
      expect(submission.id).toBe(row.id);
      expect(row).toMatchObject({
        owner: original.submitterUuid, status: original.status, created_at: original.createdAt,
        expires_at: original.expiresAt ? Date.parse(original.expiresAt) : null,
      });
      if (original.buildingId) {
        expect(submission.buildingId).toMatch(/^[0-9a-f]{32}$/);
        if (original.buildingId === previous.legacy.id) expect(submission.buildingId).toBe(migrated.id);
        else {
          expect(submission.buildingId).not.toBe(migrated.id);
          expect(store.building(submission.buildingId!)).toBeNull();
        }
      }
      expect(submission).toEqual(JSON.parse(JSON.stringify({
        ...original, id: row.id, buildingId: submission.buildingId,
      })));
    }
    expect(store.pendingCount(PLAYER_UUID)).toBe(1);
    expect(store.publication()).toMatchObject({ revision: 8, published_revision: 7, next_attempt: previous.nextAttempt });
    expect(await f.storage.getAlarm()).toBe(previous.nextAttempt);
    expect(f.writes()).toBe(0);
    const before = store.snapshot();
    migrateBuildingStorage(f.storage);
    const restarted = new AuthStore({ storage: f.storage } as DurableObjectState, f.env);
    const list = await authCall(restarted, { action: 'adminBuildingMutation', operation: 'listBuildings' });
    expect(list.status).toBe(200);
    expect(list.body).toEqual(before.buildings);
    expect(store.snapshot()).toEqual(before);
    expect(f.db.query('SELECT * FROM submissions').all()).toEqual(rows);

    const detail = await handlePublicBuildingsRoute(
      `/buildings/${migrated.id}`, new Request(`https://data.example/api/buildings/${migrated.id}`), f.env,
    );
    expect(await detail!.json()).toEqual(migrated);
    expect(await handlePublicBuildingsRoute(
      `/buildings/${previous.legacy.id}`, new Request(`https://data.example/api/buildings/${previous.legacy.id}`), f.env,
    )).toBeNull();
    f.db.exec('UPDATE building_publication SET next_attempt=0');
    await f.store.alarm();
    expect(JSON.parse(f.kv.get(PUBLIC_BUILDINGS_KEY)!)).toEqual(before);
    expect(f.writes()).toBe(1);
  } finally {
    random.mockRestore();
  }
});

test('failed ID migration rolls back all documents and can retry on the same object', async () => {
  const f = setup();
  seedPreviousBuildingStorage(f);
  const buildings = f.db.query('SELECT * FROM buildings').all();
  const submissions = f.db.query('SELECT * FROM submissions').all();
  const publication = f.db.query('SELECT * FROM building_publication').get();
  const verifyRollback = () => {
    expect(f.db.query('SELECT * FROM buildings').all()).toEqual(buildings);
    expect(f.db.query('SELECT * FROM submissions').all()).toEqual(submissions);
    expect(f.db.query('SELECT * FROM building_publication').get()).toEqual(publication);
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name='building_migrations'").all()).toEqual([]);
    expect(f.writes()).toBe(0);
  };
  f.failNextSql('INSERT INTO building_migrations');
  await expect(authCall(f.store, { action: 'publicBuildingSnapshot' })).rejects.toThrow('Injected SQL failure');
  verifyRollback();
  const random = spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
    (bytes as Uint8Array).fill(0x11);
    return bytes;
  });
  try {
    await expect(authCall(f.store, { action: 'publicBuildingSnapshot' })).rejects.toThrow('Could not migrate buildings ID');
    verifyRollback();
  } finally {
    random.mockRestore();
  }
  const recovered = await authCall(f.store, { action: 'publicBuildingSnapshot' });
  expect(recovered.status).toBe(200);
  const store = new BuildingStore(f.storage);
  expect(store.buildings()).toHaveLength(buildings.length);
  expect(store.snapshot().version).toBe(8);
  expect(store.buildings().every((building) => /^[0-9a-f]{32}$/.test(building.id))).toBe(true);
  expect(f.db.query('SELECT * FROM submissions').all()).toHaveLength(submissions.length);
  expect(await f.storage.getAlarm()).toBeNumber();
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
  migrateBuildingStorage(f.storage);
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
  expect(snapshot.body.buildings).toEqual([patched.body]);
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
  migrateBuildingStorage(f.storage);
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
  await permitImage(f, session.token);
  const created = await submit(f, session.token);
  const submission = created.body.submission as BuildingSubmission;
  f.failNextSql('UPDATE submissions');
  const failed = await admin(f, `/building-submissions/${submission.id}/approve`, 'PUT', {});
  expect(failed.status).toBe(500);
  expect((await admin(f)).body).toHaveLength(0);
  expect(new BuildingStore(f.storage).submission(submission.id)?.status).toBe('pending');
  const retry = await admin(f, `/building-submissions/${submission.id}/approve`, 'PUT', {});
  expect(retry.status).toBe(200);
  expect(retry.body.building.id).toMatch(/^[0-9a-f]{32}$/);
  expect(retry.body.submission.buildingId).toBe(retry.body.building.id);
  expect(new BuildingStore(f.storage).building(retry.body.building.id)).toEqual(retry.body.building);
  expect(new BuildingStore(f.storage).submission(submission.id)?.status).toBe('approved');
  expect((await admin(f)).body).toHaveLength(1);
  expect(f.writes()).toBe(0);
});

test('concurrent approval creates exactly one building and retains the review result', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  await permitImage(f, token);
  const created = await submit(f, token);
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

test('submission ID allocation also checks expired records awaiting cleanup', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  await permitImage(f, token);
  const store = new BuildingStore(f.storage);
  const past = new Date(Date.now() - 86400_000).toISOString();
  const expired: BuildingSubmission = {
    id: '11'.repeat(16),
    status: 'rejected',
    submitterUuid: OTHER_UUID,
    submitterName: 'Other',
    submitterRole: 'member',
    payload: input('Expired'),
    images: [image],
    createdAt: past,
    updatedAt: past,
    expiresAt: past,
  };
  store.insertSubmission(expired);
  expect(() => store.insertSubmission({ ...expired, submitterUuid: PLAYER_UUID })).toThrow();
  expect(store.submission(expired.id)).toBeNull();
  const values = [0x11, 0x22];
  const random = spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
    (bytes as Uint8Array).fill(values.shift() ?? 0x33);
    return bytes;
  });
  try {
    const created = await submit(f, token);
    expect(created.status).toBe(201);
    expect(created.body.submission.id).toBe('22'.repeat(16));
    const row = f.db.query('SELECT owner,document FROM submissions WHERE id=?').get(expired.id) as {
      owner: string;
      document: string;
    };
    expect(row.owner).toBe(OTHER_UUID);
    expect(JSON.parse(row.document)).toEqual(expired);
  } finally {
    random.mockRestore();
  }
});

test('the pending cap is atomic and browser image metadata is replaced by the owned receipt', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  await permitImage(f, token);
  const results = await Promise.all(
    Array.from({ length: 11 }, (_, i) => submit(f, token, `Building ${i}`)),
  );
  expect(results.filter((r) => r.status === 201)).toHaveLength(10);
  expect(results.filter((r) => r.status === 429)).toHaveLength(1);
  const saved = results.find((r) => r.status === 201)!.body.submission as BuildingSubmission;
  expect(saved.images).toEqual([image]);
});

test('a different account cannot use an upload receipt and unrecorded URLs are rejected', async () => {
  const f = setup();
  const first = await seedSession(f.values);
  const other = await seedSession(f.values, 0, OTHER_UUID);
  await permitImage(f, first.token);
  expect((await submit(f, other.token)).status).toBe(422);
  const result = await authCall(f.store, {
    action: 'createBuildingSubmission',
    sessionId: first.token,
    payload: { payload: input(), images: [{ ...image, width: 1, size: 1 }] },
  });
  expect((result.body.submission as BuildingSubmission).images).toEqual([image]);
});

test('adding the authenticated submitter cannot exceed the builder cap', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  await permitImage(f, token);
  const builders = Array.from({ length: 50 }, (_, i) => ({
    name: `Builder${i}`,
    uuid: `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`,
    weight: 1,
  }));
  const result = await authCall(f.store, {
    action: 'createBuildingSubmission',
    sessionId: token,
    payload: { payload: { ...input(), builders }, images: [image] },
  });
  expect(result.status).toBe(422);
});

test('image quota survives concurrent requests and records expire in bounded cleanup', async () => {
  const f = setup();
  const { token } = await seedSession(f.values);
  const reservations = await Promise.all(
    Array.from({ length: 4 }, () =>
      authCall(f.store, { action: 'reserveImageUpload', sessionId: token }),
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
