import { expect, test } from 'bun:test';
import type { Env } from '../src/env';
import {
  createPlayerBuildingSubmission,
  handleAdminBuildingsRoute,
  handleAdminBuildingsRouteDirect,
  handlePublicBuildingsRoute,
  validateBuildingInput,
} from '../src/buildings';
import type { AdminActor, Building, BuildingSubmission } from '../src/types';

const validBuilding = {
  name: { 'zh-CN': '测试建筑', en: 'Test Building' },
  description: { 'zh-CN': '描述', en: 'Description' },
  coordinates: { x: 0, y: 64, z: 0 },
  builders: [{ name: 'Player', uuid: '00000000-0000-0000-0000-000000000000', weight: 1 }],
  buildType: 'original',
  images: ['/images/test.png'],
  buildDate: '2026-06-27',
};

test('building validation allows relative image paths', () => {
  const result = validateBuildingInput(validBuilding);

  expect(result.ok).toBe(true);
});

test('building validation allows https image URLs', () => {
  const result = validateBuildingInput({
    ...validBuilding,
    images: ['https://assets.example.com/image.png'],
  });

  expect(result.ok).toBe(true);
});

test('building validation rejects http image URLs', () => {
  const result = validateBuildingInput({
    ...validBuilding,
    images: ['http://assets.example.com/image.png'],
  });

  expect(result.ok).toBe(false);
});

test('public building reads use KV summary without Durable Object summary storage', async () => {
  const building: Building = {
    id: 'abc12345',
    ...validBuilding,
    createdAt: '2026-06-27T12:00:00.000Z',
    updatedAt: '2026-06-27T12:00:00.000Z',
  };
  const env = createEnvWithSummary([building]);

  const detail = await handlePublicBuildingsRoute(
    '/buildings/abc12345',
    new Request('https://data.mcmik.top/api/buildings/abc12345'),
    env,
  );

  expect(detail?.status).toBe(200);
  expect(await detail?.json()).toEqual(building);

  const list = await handlePublicBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/api/buildings'),
    env,
  );

  expect(list?.status).toBe(200);
  expect(await list?.json()).toEqual([building]);
});

test('public building summary drops records that do not match the current schema', async () => {
  const env = createMemoryEnv();
  await env.BUILDINGS_KV.put(
    'building-summary:v1',
    JSON.stringify([{
      id: 'badbadbad',
      name: { en: 'Missing Chinese Name' },
      createdAt: '2026-06-27T12:00:00.000Z',
      updatedAt: '2026-06-27T12:00:00.000Z',
    }]),
  );

  const list = await handlePublicBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/api/buildings'),
    env,
  );

  expect(list?.status).toBe(200);
  expect(await list?.json()).toEqual([]);
});

test('building creation updates summary without scanning all building keys', async () => {
  const env = createNoListEnvWithSummary([]);
  const body = {
    ...validBuilding,
    name: { 'zh-CN': '无需扫描建筑', en: 'No Scan Building' },
  };

  const response = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(response?.status).toBe(201);
  const building = (await response?.json()) as Building;
  const summary = JSON.parse((await env.BUILDINGS_KV.get('building-summary:v1')) ?? '[]') as Building[];
  expect(summary.some((item) => item.id === building.id)).toBe(true);
});

test('concurrent building creations preserve incremental summary updates', async () => {
  const env = createNoListEnvWithSummary([]);

  const [first, second] = await Promise.all([
    handleAdminBuildingsRoute(
      '/buildings',
      new Request('https://data.mcmik.top/admin/api/buildings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validBuilding,
          name: { 'zh-CN': '并发建筑一', en: 'Concurrent Building One' },
        }),
      }),
      env,
      { email: 'admin@example.com' },
    ),
    handleAdminBuildingsRoute(
      '/buildings',
      new Request('https://data.mcmik.top/admin/api/buildings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validBuilding,
          name: { 'zh-CN': '并发建筑二', en: 'Concurrent Building Two' },
        }),
      }),
      env,
      { email: 'admin@example.com' },
    ),
  ]);

  expect(first?.status).toBe(201);
  expect(second?.status).toBe(201);
  const summary = JSON.parse((await env.BUILDINGS_KV.get('building-summary:v1')) ?? '[]') as Building[];
  expect(summary.map((building) => building.name.en).sort()).toEqual([
    'Concurrent Building One',
    'Concurrent Building Two',
  ]);
});

test('building summary mutations use KV snapshot instead of stale memory cache', async () => {
  const env = createNoListEnvWithSummary([]);
  const initial = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings'),
    env,
    { email: 'admin@example.com' },
  );
  expect(await initial?.json()).toEqual([]);

  const existing: Building = {
    id: 'existing1',
    ...validBuilding,
    name: { 'zh-CN': '已有建筑', en: 'Existing Building' },
    createdAt: '2026-06-27T12:00:00.000Z',
    updatedAt: '2026-06-27T12:00:00.000Z',
  };
  await env.BUILDINGS_KV.put('building-summary:v1', JSON.stringify([existing]));

  const created = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...validBuilding,
        name: { 'zh-CN': '新增建筑', en: 'New Building' },
      }),
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(created?.status).toBe(201);
  const summary = JSON.parse((await env.BUILDINGS_KV.get('building-summary:v1')) ?? '[]') as Building[];
  expect(summary.map((building) => building.name.en).sort()).toEqual([
    'Existing Building',
    'New Building',
  ]);
});

test('building duplicate checks use KV snapshot instead of stale memory cache', async () => {
  const env = createNoListEnvWithSummary([]);
  const initial = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings'),
    env,
    { email: 'admin@example.com' },
  );
  expect(await initial?.json()).toEqual([]);

  const existing: Building = {
    id: 'dupcheck1',
    ...validBuilding,
    createdAt: '2026-06-27T12:00:00.000Z',
    updatedAt: '2026-06-27T12:00:00.000Z',
  };
  await env.BUILDINGS_KV.put('building-summary:v1', JSON.stringify([existing]));

  const created = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBuilding),
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(created?.status).toBe(409);
  expect(await created?.json()).toEqual({ error: 'duplicate building: dupcheck1' });
});

test('admin building list uses KV snapshot instead of stale public cache', async () => {
  const env = createNoListEnvWithSummary([]);
  const initial = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings'),
    env,
    { email: 'admin@example.com' },
  );
  expect(await initial?.json()).toEqual([]);

  const building: Building = {
    id: 'adminnew',
    ...validBuilding,
    name: { 'zh-CN': '管理端新建筑', en: 'Admin New Building' },
    createdAt: '2026-06-27T12:00:00.000Z',
    updatedAt: '2026-06-27T12:00:00.000Z',
  };
  await env.BUILDINGS_KV.put('building-summary:v1', JSON.stringify([building]));

  const refreshed = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings'),
    env,
    { email: 'admin@example.com' },
  );

  expect(await refreshed?.json()).toEqual([building]);
});

test('admin mutation coordinator refreshes front public summary cache after durable object writes', async () => {
  const env = createMemoryEnv();
  const initial = await handlePublicBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/api/buildings'),
    env,
  );
  expect(await initial?.json()).toEqual([]);

  const building: Building = {
    id: 'frontsync',
    ...validBuilding,
    name: { 'zh-CN': '前台同步建筑', en: 'Front Sync Building' },
    createdAt: '2026-06-27T12:00:00.000Z',
    updatedAt: '2026-06-27T12:00:00.000Z',
  };
  env.AUTH_STORE = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => {
        await env.BUILDINGS_KV.put(`building:${building.id}`, JSON.stringify(building));
        await env.BUILDINGS_KV.put('building-summary:v1', JSON.stringify([building]));
        return Response.json({ status: 201, body: building });
      },
    }),
  } as unknown as DurableObjectNamespace;

  const created = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBuilding),
    }),
    env,
    { email: 'admin@example.com' },
  );
  expect(created?.status).toBe(201);

  const refreshed = await handlePublicBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/api/buildings'),
    env,
  );
  expect(await refreshed?.json()).toEqual([building]);
});

test('admin mutation coordinator clears front public detail cache after durable object deletes', async () => {
  const env = createMemoryEnv();
  const building: Building = {
    id: 'deleteold',
    ...validBuilding,
    name: { 'zh-CN': '待删除建筑', en: 'Delete Old Building' },
    createdAt: '2026-06-27T12:00:00.000Z',
    updatedAt: '2026-06-27T12:00:00.000Z',
  };
  await env.BUILDINGS_KV.put(`building:${building.id}`, JSON.stringify(building));
  await env.BUILDINGS_KV.put('building-summary:v1', JSON.stringify([building]));

  const cached = await handlePublicBuildingsRoute(
    `/buildings/${building.id}`,
    new Request(`https://data.mcmik.top/api/buildings/${building.id}`),
    env,
  );
  expect(await cached?.json()).toEqual(building);

  env.AUTH_STORE = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => {
        await env.BUILDINGS_KV.delete(`building:${building.id}`);
        await env.BUILDINGS_KV.put('building-summary:v1', JSON.stringify([]));
        return Response.json({ status: 200, body: { deleted: building.id } });
      },
    }),
  } as unknown as DurableObjectNamespace;

  const deleted = await handleAdminBuildingsRoute(
    `/buildings/${building.id}`,
    new Request(`https://data.mcmik.top/admin/api/buildings/${building.id}`, {
      method: 'DELETE',
    }),
    env,
    { email: 'admin@example.com' },
  );
  expect(deleted?.status).toBe(200);

  const detail = await handlePublicBuildingsRoute(
    `/buildings/${building.id}`,
    new Request(`https://data.mcmik.top/api/buildings/${building.id}`),
    env,
  );
  expect(detail?.status).toBe(404);
});

test('stale admin building updates are rejected', async () => {
  const building: Building = {
    id: 'stale001',
    ...validBuilding,
    createdAt: '2026-06-27T12:00:00.000Z',
    updatedAt: '2026-06-27T12:05:00.000Z',
  };
  const env = createNoListEnvWithSummary([building]);
  await env.BUILDINGS_KV.put('building:stale001', JSON.stringify(building));

  const updated = await handleAdminBuildingsRoute(
    '/buildings/stale001',
    new Request('https://data.mcmik.top/admin/api/buildings/stale001', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Expected-Updated-At': '2026-06-27T12:00:00.000Z',
      },
      body: JSON.stringify({
        ...validBuilding,
        name: { 'zh-CN': '过期修改', en: 'Stale Update' },
      }),
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(updated?.status).toBe(409);
  expect(await updated?.json()).toEqual({ error: 'building has changed, refresh before saving' });
});

test('admin mutation coordinator rejects oversized bodies before durable object', async () => {
  const env = createNoListEnvWithSummary([]);
  env.AUTH_STORE = {
    idFromName: () => ({}),
    get: () => ({
      fetch: () => {
        throw new Error('coordinator should not be called');
      },
    }),
  } as unknown as DurableObjectNamespace;

  const response = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(65 * 1024) }),
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(response?.status).toBe(413);
  expect(await response?.json()).toEqual({ error: 'request body too large' });
});

test('direct admin building handler rejects routes outside its boundary', async () => {
  const env = createNoListEnvWithSummary([]);
  const response = await handleAdminBuildingsRouteDirect(
    '/not-buildings',
    new Request('https://data.mcmik.top/admin/api/not-buildings'),
    env,
    { email: 'admin@example.com' },
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'not found' });
});

test('player pending limits use the pending-only player index', async () => {
  const env = createMemoryEnv();

  const created = await createPlayerBuildingSubmission(createSubmissionRequest(), env, {
    playerUuid: '00000000-0000-0000-0000-000000000000',
    currentName: 'Player',
    role: 'member',
  });
  const payload = (await created.json()) as { submission: { id: string } };

  expect(created.status).toBe(201);
  expect(await env.BUILDINGS_KV.get(`building-submission-player-pending:00000000-0000-0000-0000-000000000000:${payload.submission.id}`)).toBe(payload.submission.id);
  expect(await env.BUILDINGS_KV.get(`building-submission-status:pending:${payload.submission.id}`)).toBe(payload.submission.id);
});

test('player submissions require imgbb webp image URLs', async () => {
  const env = createMemoryEnv();
  const created = await createPlayerBuildingSubmission(createSubmissionRequest({
    imageUrl: 'https://i.ibb.co/example/test.png',
  }), env, {
    playerUuid: '00000000-0000-0000-0000-000000000000',
    currentName: 'Player',
    role: 'member',
  });

  expect(created.status).toBe(422);
  expect(await created.json()).toEqual({ error: 'images[0].url must be an uploaded image URL' });
});

test('player submissions require positive image metadata dimensions', async () => {
  const env = createMemoryEnv();
  const created = await createPlayerBuildingSubmission(createSubmissionRequest({
    width: 0,
  }), env, {
    playerUuid: '00000000-0000-0000-0000-000000000000',
    currentName: 'Player',
    role: 'member',
  });

  expect(created.status).toBe(422);
  expect(await created.json()).toEqual({ error: 'images[0] dimensions and size are required' });
});

test('stale admin submission reviews are rejected', async () => {
  const env = createMemoryEnv();
  const created = await createPlayerBuildingSubmission(createSubmissionRequest(), env, {
    playerUuid: '00000000-0000-0000-0000-000000000000',
    currentName: 'Player',
    role: 'member',
  });
  const payload = (await created.json()) as { submission: BuildingSubmission };

  const updated = await handleAdminBuildingsRoute(
    `/building-submissions/${payload.submission.id}`,
    new Request(`https://data.mcmik.top/admin/api/building-submissions/${payload.submission.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Expected-Updated-At': '2026-06-27T12:00:00.000Z',
      },
      body: JSON.stringify({
        payload: {
          ...validBuilding,
          images: ['https://i.ibb.co/example/test.webp'],
        },
        images: payload.submission.images,
      }),
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(updated?.status).toBe(409);
  expect(await updated?.json()).toEqual({ error: 'submission has changed, refresh before saving' });
});

test('player pending limit count does not read pending submission documents below limit', async () => {
  const env = createMemoryEnv();
  const orphanId = 'oldpend1';
  await env.BUILDINGS_KV.put('building-submission-indexes:v1', 'ready');
  await env.BUILDINGS_KV.put(
    `building-submission-player-pending:00000000-0000-0000-0000-000000000000:${orphanId}`,
    orphanId,
  );
  env.KV_GETS.length = 0;

  const created = await createPlayerBuildingSubmission(createSubmissionRequest(), env, {
    playerUuid: '00000000-0000-0000-0000-000000000000',
    currentName: 'Player',
    role: 'member',
  });

  expect(created.status).toBe(201);
  expect(env.KV_GETS).not.toContain(`building-submission:${orphanId}`);
});

test('submission status transitions maintain pending and status indexes', async () => {
  const env = createMemoryEnv();
  const created = await createPlayerBuildingSubmission(createSubmissionRequest(), env, {
    playerUuid: '00000000-0000-0000-0000-000000000000',
    currentName: 'Player',
    role: 'member',
  });
  const payload = (await created.json()) as { submission: { id: string } };

  const rejected = await handleAdminBuildingsRoute(
    `/building-submissions/${payload.submission.id}/reject`,
    new Request(`https://data.mcmik.top/admin/api/building-submissions/${payload.submission.id}/reject`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewNote: '资料不足' }),
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(rejected?.status).toBe(200);
  expect(await env.BUILDINGS_KV.get(`building-submission-player-pending:00000000-0000-0000-0000-000000000000:${payload.submission.id}`)).toBe(null);
  expect(await env.BUILDINGS_KV.get(`building-submission-status:pending:${payload.submission.id}`)).toBe(null);
  expect(await env.BUILDINGS_KV.get(`building-submission-status:rejected:${payload.submission.id}`)).toBe(payload.submission.id);
});

test('approved submissions are added to managed public buildings', async () => {
  const env = createMemoryEnv();
  const created = await createPlayerBuildingSubmission(createSubmissionRequest(), env, {
    playerUuid: '00000000-0000-0000-0000-000000000000',
    currentName: 'Player',
    role: 'member',
  });
  const payload = (await created.json()) as { submission: { id: string } };

  const approved = await handleAdminBuildingsRoute(
    `/building-submissions/${payload.submission.id}/approve`,
    new Request(`https://data.mcmik.top/admin/api/building-submissions/${payload.submission.id}/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(approved?.status).toBe(200);
  const approvedBody = (await approved?.json()) as { building: Building; submission: { buildingId: string; status: string } };
  expect(approvedBody.submission.status).toBe('approved');
  expect(approvedBody.submission.buildingId).toBe(approvedBody.building.id);
  expect(await env.BUILDINGS_KV.get(`building:${approvedBody.building.id}`)).not.toBe(null);
  expect(await env.BUILDINGS_KV.get(`building-submission:${payload.submission.id}`)).toBe(null);
  expect(await env.BUILDINGS_KV.get(`building-submission-player-pending:00000000-0000-0000-0000-000000000000:${payload.submission.id}`)).toBe(null);
  expect(await env.BUILDINGS_KV.get(`building-submission-status:pending:${payload.submission.id}`)).toBe(null);
  expect(await env.BUILDINGS_KV.get(`building-submission-status:approved:${payload.submission.id}`)).toBe(null);

  const adminList = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings'),
    env,
    { email: 'admin@example.com' },
  );
  expect(adminList?.status).toBe(200);
  expect(await adminList?.json()).toEqual([approvedBody.building]);

  const publicList = await handlePublicBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/api/buildings'),
    env,
  );
  expect(publicList?.status).toBe(200);
  expect(await publicList?.json()).toEqual([approvedBody.building]);
});

test('approved submissions can use the stored payload with an empty body', async () => {
  const env = createMemoryEnv();
  const created = await createPlayerBuildingSubmission(createSubmissionRequest(), env, {
    playerUuid: '00000000-0000-0000-0000-000000000000',
    currentName: 'Player',
    role: 'member',
  });
  const payload = (await created.json()) as { submission: BuildingSubmission };

  const approved = await handleAdminBuildingsRoute(
    `/building-submissions/${payload.submission.id}/approve`,
    new Request(`https://data.mcmik.top/admin/api/building-submissions/${payload.submission.id}/approve`, {
      method: 'PUT',
      headers: { 'X-Expected-Updated-At': payload.submission.updatedAt },
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(approved?.status).toBe(200);
  const approvedBody = (await approved?.json()) as { building: Building };
  expect(approvedBody.building.name.en).toBe('Test Building');
});

test('approved submission repair rebuilds stale building summary when building already exists', async () => {
  const env = createMemoryEnv();
  const created = await createPlayerBuildingSubmission(createSubmissionRequest(), env, {
    playerUuid: '00000000-0000-0000-0000-000000000000',
    currentName: 'Player',
    role: 'member',
  });
  const payload = (await created.json()) as { submission: { id: string } };

  const approved = await handleAdminBuildingsRoute(
    `/building-submissions/${payload.submission.id}/approve`,
    new Request(`https://data.mcmik.top/admin/api/building-submissions/${payload.submission.id}/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(approved?.status).toBe(200);
  const approvedBody = (await approved?.json()) as { building: Building; submission: BuildingSubmission };
  await env.BUILDINGS_KV.put(`building-submission:${approvedBody.submission.id}`, JSON.stringify(approvedBody.submission));
  await env.BUILDINGS_KV.put(`building-submission-status:approved:${approvedBody.submission.id}`, approvedBody.submission.id);
  await env.BUILDINGS_KV.put('building-summary:v1', JSON.stringify([]));

  const repair = await handleAdminBuildingsRoute(
    '/building-submissions/repair-approved',
    new Request('https://data.mcmik.top/admin/api/building-submissions/repair-approved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    env,
    { email: 'admin@example.com' },
  );

  expect(repair?.status).toBe(200);
  expect(await repair?.json()).toMatchObject({ scanned: 1, skipped: 1, deletedApproved: 1, failed: 0 });
  expect(await env.BUILDINGS_KV.get(`building-submission:${approvedBody.submission.id}`)).toBe(null);
  expect(await env.BUILDINGS_KV.get(`building-submission-status:approved:${approvedBody.submission.id}`)).toBe(null);
  expect(JSON.parse((await env.BUILDINGS_KV.get('building-summary:v1')) ?? '[]')).toEqual([approvedBody.building]);

  const repairedList = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings'),
    env,
    { email: 'admin@example.com' },
  );
  expect(await repairedList?.json()).toEqual([approvedBody.building]);
});

function createEnvWithSummary(buildings: Building[]): Env {
  const kv = {
    get: (key: string) => {
      if (key === 'building-summary:v1') {
        return Promise.resolve(JSON.stringify(buildings));
      }
      return Promise.resolve(null);
    },
    put: () => {
      throw new Error('KV unavailable');
    },
    delete: () => {
      throw new Error('KV unavailable');
    },
    list: () => {
      throw new Error('KV unavailable');
    },
  } as unknown as KVNamespace;

  const env = {
    BUILDINGS_KV: kv,
    AUTH_STORE: {} as DurableObjectNamespace,
    VPC_SERVICE: {} as Fetcher,
    MINECRAFT_SERVER_URL: 'https://upstream.example',
    MINECRAFT_SERVER_ADDRESS: 'mc.example',
    MINECRAFT_SERVER_PORT: '25565',
    CLOUDFLARE_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    CLOUDFLARE_ACCESS_AUD: 'aud',
  };
  env.AUTH_STORE = createCoordinatorNamespace(env);
  return env;
}

function createNoListEnvWithSummary(buildings: Building[]): Env & { BUILDINGS_KV: KVNamespace } {
  const values = new Map<string, string>([['building-summary:v1', JSON.stringify(buildings)]]);
  const kv = {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    put: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
    list: () => {
      throw new Error('KV list should not be used');
    },
  } as unknown as KVNamespace;

  const env = {
    BUILDINGS_KV: kv,
    AUTH_STORE: {} as DurableObjectNamespace,
    VPC_SERVICE: {} as Fetcher,
    MINECRAFT_SERVER_URL: 'https://upstream.example',
    MINECRAFT_SERVER_ADDRESS: 'mc.example',
    MINECRAFT_SERVER_PORT: '25565',
    CLOUDFLARE_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    CLOUDFLARE_ACCESS_AUD: 'aud',
  };
  env.AUTH_STORE = createCoordinatorNamespace(env);
  return env;
}

function createSubmissionRequest(overrides: {
  imageUrl?: string;
  width?: number;
  height?: number;
  size?: number;
  mime?: string;
} = {}): Request {
  const imageUrl = overrides.imageUrl ?? 'https://i.ibb.co/example/test.webp';
  return new Request('https://data.mcmik.top/api/account/building-submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: {
        ...validBuilding,
        images: [imageUrl],
      },
      images: [
        {
          url: imageUrl,
          width: overrides.width ?? 1280,
          height: overrides.height ?? 720,
          size: overrides.size ?? 1024,
          mime: overrides.mime ?? 'image/webp',
        },
      ],
    }),
  });
}

function createMemoryEnv(): Env & { BUILDINGS_KV: KVNamespace; KV_GETS: string[] } {
  const values = new Map<string, string>();
  const getKeys: string[] = [];
  const kv = {
    get: (key: string) => {
      getKeys.push(key);
      return Promise.resolve(values.get(key) ?? null);
    },
    put: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
    list: ({ prefix = '' }: { prefix?: string } = {}) =>
      Promise.resolve({
        keys: [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((name) => ({ name })),
        list_complete: true,
        cursor: undefined,
      }),
  } as unknown as KVNamespace;

  const env = {
    BUILDINGS_KV: kv,
    KV_GETS: getKeys,
    AUTH_STORE: {} as DurableObjectNamespace,
    VPC_SERVICE: {} as Fetcher,
    MINECRAFT_SERVER_URL: 'https://upstream.example',
    MINECRAFT_SERVER_ADDRESS: 'mc.example',
    MINECRAFT_SERVER_PORT: '25565',
    CLOUDFLARE_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    CLOUDFLARE_ACCESS_AUD: 'aud',
  };
  env.AUTH_STORE = createCoordinatorNamespace(env);
  return env;
}

function createCoordinatorNamespace(env: Env): DurableObjectNamespace {
  let queue: Promise<unknown> = Promise.resolve();

  return {
    idFromName: () => ({}),
    get: () => ({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const task = queue.then(async () => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          const method = typeof body.method === 'string' ? body.method : 'GET';
          const request = new Request(String(body.url ?? `https://data.mcmik.top/admin/api${body.routePath}`), {
            method,
            headers: objectHeaders(body.headers),
            body: method === 'GET' || method === 'HEAD' ? undefined : String(body.requestBody ?? ''),
          });
          const response = await handleAdminBuildingsRouteDirect(
            String(body.routePath ?? ''),
            request,
            env,
            objectActor(body.actor),
          );
          return new Response(JSON.stringify({
            status: response.status,
            body: await response.json().catch(() => ({})),
          }));
        });
        queue = task.catch(() => undefined);
        return task;
      },
    }),
  } as unknown as DurableObjectNamespace;
}

function objectHeaders(value: unknown): Headers {
  const headers = new Headers();

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, headerValue] of Object.entries(value)) {
      if (typeof headerValue === 'string') {
        headers.set(key, headerValue);
      }
    }
  }

  return headers;
}

function objectActor(value: unknown): AdminActor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const actor = value as Record<string, unknown>;
  return {
    email: typeof actor.email === 'string' ? actor.email : undefined,
    subject: typeof actor.subject === 'string' ? actor.subject : undefined,
  };
}
