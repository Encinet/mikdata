import { expect, test } from 'bun:test';
import { BuildingStore, PUBLIC_BUILDINGS_KEY, PUBLISH_INTERVAL_MS } from '../src/building-store';
import { AuthStore } from '../src/auth';
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

function stored(name = 'Building', id = 'abc12345'): Building {
  const now = '2026-06-27T00:00:00.000Z';
  return { id, ...input(name), createdAt: now, updatedAt: now };
}
test('a missing public snapshot is rebuilt from SQLite and republished', async () => {
  const f = setup(),
    store = new BuildingStore(f.storage);
  store.initialize();
  store.saveBuilding(stored());
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

test('SQL deletions survive restart even when old KV records remain', async () => {
  const f = setup(),
    store = new BuildingStore(f.storage);
  store.initialize();
  const building = stored();
  f.kv.set(`building:${building.id}`, JSON.stringify(building));
  f.kv.set('building-summary:v1', JSON.stringify([building]));
  store.saveBuilding(building);
  store.deleteBuilding(building.id);
  const restarted = new AuthStore({ storage: f.storage } as DurableObjectState, f.env);
  const result = await authCall(restarted, { action: 'publicBuildingSnapshot' });
  expect(result.status).toBe(200);
  expect(result.body.buildings).toEqual([]);
  expect(f.kv.get(`building:${building.id}`)).toBe(JSON.stringify(building));
});

test('world is part of duplicate detection', async () => {
  const f = setup();
  expect((await admin(f, '/buildings', 'POST', input())).status).toBe(201);
  expect(
    (
      await admin(f, '/buildings', 'POST', {
        ...input(),
        coordinates: { ...input().coordinates, world: 'world_nether' },
      })
    ).status,
  ).toBe(201);
});

test('business writes and private reads are independent of public KV availability', async () => {
  const f = setup();
  f.setFail(true);
  const [a, b] = await Promise.all([
    admin(f, '/buildings', 'POST', input('One')),
    admin(f, '/buildings', 'POST', input('Two')),
  ]);
  expect([a.status, b.status]).toEqual([201, 201]);
  expect((await admin(f)).body).toHaveLength(2);
  expect(f.writes()).toBe(0);
  expect(await f.storage.getAlarm()).toBeNumber();
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
  f.failNextSql('INSERT INTO submissions');
  const failed = await admin(f, `/building-submissions/${submission.id}/approve`, 'PUT', {});
  expect(failed.status).toBe(500);
  expect((await admin(f)).body).toHaveLength(0);
  expect(new BuildingStore(f.storage).submission(submission.id)?.status).toBe('pending');
  const retry = await admin(f, `/building-submissions/${submission.id}/approve`, 'PUT', {});
  expect(retry.status).toBe(200);
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
