import { expect, test } from 'bun:test';
import type { Env } from '../src/env';
import { handlePublicBuildingsRoute, validateBuildingInput } from '../src/buildings';
import type { Building } from '../src/types';

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
    BUILDINGS_WRITER: {} as DurableObjectNamespace,
    AUTH_STORE: {} as DurableObjectNamespace,
    VPC_SERVICE: {} as Fetcher,
    MINECRAFT_SERVER_URL: 'https://upstream.example',
    MINECRAFT_SERVER_ADDRESS: 'mc.example',
    MINECRAFT_SERVER_PORT: '25565',
    CLOUDFLARE_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    CLOUDFLARE_ACCESS_AUD: 'aud',
  };
}
