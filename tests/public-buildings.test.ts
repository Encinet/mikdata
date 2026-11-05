import { afterEach, expect, spyOn, test } from 'bun:test';
import { handlePublicBuildingsRoute } from '../src/public-buildings';
import { testAuthEnv, PLAYER_UUID } from './helpers/auth-store';
import type { Building } from '../src/types';

const originalCache = Object.getOwnPropertyDescriptor(globalThis, 'caches');
afterEach(() => {
  if (originalCache) Object.defineProperty(globalThis, 'caches', originalCache);
  else delete (globalThis as any).caches;
});
function fixture() {
  const building: Building = {
    id: '12345678',
    name: { 'zh-CN': '建筑', en: 'Building' },
    description: { 'zh-CN': '描述', en: 'Description' },
    coordinates: { world: 'world', x: 0, y: 64, z: 0 },
    builders: [{ uuid: PLAYER_UUID, name: 'Player', weight: 1 }],
    buildType: 'original',
    tags: [{ 'zh-CN': '标签', en: 'tag' }],
    images: ['/building.webp'],
    buildDate: '2026-06-27',
    createdAt: '2026-06-27T00:00:00Z',
    updatedAt: '2026-06-27T00:00:00Z',
  };
  let raw = JSON.stringify({ version: 1, buildings: [building] }),
    reads = 0;
  const env = testAuthEnv({
    BUILDINGS_KV: {
      get: async () => {
        reads++;
        return raw;
      },
    } as any,
  });
  return {
    env,
    building,
    reads: () => reads,
    update: () => {
      raw = JSON.stringify({
        version: 2,
        buildings: [{ ...building, name: { 'zh-CN': '新建筑', en: 'New' } }],
      });
    },
  };
}
async function read(f: ReturnType<typeof fixture>, query = '', id?: string) {
  return (await handlePublicBuildingsRoute(
    id ? `/buildings/${id}` : '/buildings',
    new Request(`https://data.example/api/buildings${id ? `/${id}` : ''}${query}`),
    f.env,
  ))!;
}

test('query filtering and cache keys share whitespace normalization', async () => {
  const f = fixture();
  for (const field of ['type=original', 'builder=Player', 'tag=tag', 'locale=zh-CN']) {
    const [key, value] = field.split('=');
    const padded = await (await read(f, `?${key}=%20${value}%20`)).text();
    const canonical = await read(f, `?${field}`);
    expect(await canonical.text()).toBe(padded);
    expect(JSON.parse(padded)).toHaveLength(1);
  }
  expect(await (await read(f, '?type=%20')).json()).toHaveLength(1);
});

test('unsupported locales share the English response and concurrent cache writes', async () => {
  const f = fixture();
  let writes = 0;
  (globalThis as any).caches = {
    default: {
      match: async () => undefined,
      put: async () => {
        writes++;
      },
    },
  };
  const bodies = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => (await read(f, `?locale=unknown${i}`)).text()),
  );
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0])[0].name).toBe('Building');
  expect(writes).toBe(1);
  expect(f.reads()).toBe(1);
  expect(await (await read(f, '?locale=en')).text()).toBe(bodies[0]);
  expect(writes).toBe(1);
});

test('snapshot refreshes are cached and revision changes invalidate both list and detail responses', async () => {
  const f = fixture(),
    realNow = Date.now;
  let now = realNow();
  const date = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    for (let i = 0; i < 9; i++) {
      await (await read(f)).text();
      now += 16_000;
    }
    expect(f.reads()).toBe(3);
    expect(await (await read(f, '', f.building.id)).json()).toEqual(f.building);
    expect((await read(f, '', 'missing123')).status).toBe(404);
    f.update();
    now += 60_000;
    expect((await (await read(f)).json())[0].name.en).toBe('New');
    expect((await (await read(f, '', f.building.id)).json()).name.en).toBe('New');
  } finally {
    date.mockRestore();
  }
});

test('public third-party reads share an empty snapshot lookup and retain CORS on failures', async () => {
  const f = fixture();
  let reads = 0;
  const publicRequest = () =>
    new Request('https://data.example/api/buildings', {
      headers: { Origin: 'https://third-party.example' },
    });
  f.env.BUILDINGS_KV = {
    get: async () => {
      reads++;
      await Promise.resolve();
      return JSON.stringify({ version: 1, buildings: [] });
    },
  } as unknown as KVNamespace;
  const responses = await Promise.all(
    Array.from({ length: 3 }, () =>
      handlePublicBuildingsRoute('/buildings', publicRequest(), f.env),
    ),
  );
  expect(reads).toBe(1);
  expect(responses.every((r) => r?.headers.get('Access-Control-Allow-Origin') === '*')).toBe(true);
  expect(await responses[0]?.json()).toEqual([]);
  await handlePublicBuildingsRoute('/buildings', publicRequest(), f.env);
  expect(reads).toBe(1);
  f.env.BUILDINGS_KV = {
    get: async () => {
      throw new Error('Unavailable');
    },
  } as unknown as KVNamespace;
  const failed = await handlePublicBuildingsRoute('/buildings', publicRequest(), f.env);
  expect(failed?.status).toBe(503);
  expect(failed?.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(failed?.headers.get('Cache-Control')).toBe('no-store');
});
