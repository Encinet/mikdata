import { expect, test } from 'bun:test';
import type { Env } from '../src/env';
import {
  createPlayerBuildingSubmission,
  handleAdminBuildingsRoute,
  handlePublicBuildingsRoute,
  validateBuildingInput,
} from '../src/buildings';
import type { Building, BuildingSubmission } from '../src/types';

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

  const staleList = await handleAdminBuildingsRoute(
    '/buildings',
    new Request('https://data.mcmik.top/admin/api/buildings'),
    env,
    { email: 'admin@example.com' },
  );
  expect(await staleList?.json()).toEqual([]);

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

  return {
    BUILDINGS_KV: kv,
    AUTH_STORE: {} as DurableObjectNamespace,
    VPC_SERVICE: {} as Fetcher,
    MINECRAFT_SERVER_URL: 'https://upstream.example',
    MINECRAFT_SERVER_ADDRESS: 'mc.example',
    MINECRAFT_SERVER_PORT: '25565',
    CLOUDFLARE_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    CLOUDFLARE_ACCESS_AUD: 'aud',
  };
}

function createSubmissionRequest(): Request {
  return new Request('https://data.mcmik.top/api/account/building-submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: {
        ...validBuilding,
        images: ['https://i.ibb.co/example/test.webp'],
      },
      images: [
        {
          url: 'https://i.ibb.co/example/test.webp',
          width: 1280,
          height: 720,
          size: 1024,
          mime: 'image/webp',
        },
      ],
    }),
  });
}

function createMemoryEnv(): Env & { BUILDINGS_KV: KVNamespace } {
  const values = new Map<string, string>();
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

  return {
    BUILDINGS_KV: kv,
    AUTH_STORE: {} as DurableObjectNamespace,
    VPC_SERVICE: {} as Fetcher,
    MINECRAFT_SERVER_URL: 'https://upstream.example',
    MINECRAFT_SERVER_ADDRESS: 'mc.example',
    MINECRAFT_SERVER_PORT: '25565',
    CLOUDFLARE_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    CLOUDFLARE_ACCESS_AUD: 'aud',
  };
}
