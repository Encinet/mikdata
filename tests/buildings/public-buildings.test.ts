import { afterEach, expect, spyOn, test } from 'bun:test';
import { handlePublicBuildingsRoute } from '../../src/buildings/public-route';
import { testAuthEnv, OTHER_UUID, PLAYER_UUID } from '../helpers/auth-store';
import type { Building } from '../../src/buildings/types';

const originalCache = Object.getOwnPropertyDescriptor(globalThis, 'caches');
afterEach(() => {
  if (originalCache) Object.defineProperty(globalThis, 'caches', originalCache);
  else delete (globalThis as any).caches;
});
function fixture() {
  const origin = 'https://images.example';
  const hash = 'a'.repeat(64);
  const id = 'b40cfbaf9cd674ce203b81e7a8f690d2';
  const building: Building = {
    id,
    name: { 'zh-CN': '建筑', en: 'Building' },
    description: { 'zh-CN': '描述', en: 'Description' },
    coordinates: { world: 'world', x: 0, y: 64, z: 0 },
    builders: [{ uuid: PLAYER_UUID, name: 'Player', weight: 1 }],
    buildType: 'original',
    tags: [{ 'zh-CN': '标签', en: 'tag' }],
    images: [`${hash}.webp`],
    buildDate: '2026-06-27',
    createdAt: '2026-06-27T00:00:00Z',
    updatedAt: '2026-06-27T00:00:00Z',
  };
  const serialize = (buildings: Building[], version: number) => JSON.stringify({
    version,
    buildings: buildings.map(({ images: _, ...document }) => ({ ...document, imageHashes: [hash] })),
  });
  let raw = serialize([building], 1),
    reads = 0;
  const env = testAuthEnv({
    BUILDING_IMAGE_PUBLIC_BASE_URL: origin,
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
    replace: (buildings: Building[], version = 1) => {
      raw = serialize(buildings, version);
    },
    update: () => {
      raw = serialize([{ ...building, name: { 'zh-CN': '新建筑', en: 'New' } }], 2);
    },
  };
}
function catalogFixture() {
  const f = fixture();
  const otherBuilder = { uuid: OTHER_UUID, name: 'Other', weight: 1 };
  const entries: Partial<Building>[] = [
    { buildDate: '2026-07-01' },
    {
      buildDate: '2026-07-05',
      tags: [{ 'zh-CN': '其他', en: 'other' }],
      builders: [otherBuilder],
    },
    { buildDate: '2026-07-04', buildType: 'replica' },
    { buildDate: '2026-07-03', builders: [otherBuilder] },
    { buildDate: '2026-07-02', tags: undefined },
    { buildDate: '2026-06-30' },
  ];
  const buildings: Building[] = entries.map((entry, index) => {
    const id = (index + 1).toString(16).repeat(32);
    return { ...f.building, id, ...entry };
  });
  f.replace(buildings);
  return { ...f, buildings };
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
    const { buildings } = JSON.parse(padded);
    expect(buildings).toHaveLength(1);
    expect(buildings[0].id).toBe(f.building.id);
  }
  expect((await (await read(f, '?type=%20')).json()).buildings).toHaveLength(1);
});

test('limit is applied after every filter and before localization', async () => {
  const f = catalogFixture();
  const queries: [string, number[]][] = [
    ['type=original', [1, 3]],
    ['tag=tag', [2, 3]],
    [`tag=${encodeURIComponent('标签')}`, [2, 3]],
    ['builder=Player', [2, 4]],
    [`builder=${PLAYER_UUID}`, [2, 4]],
    ['type=original&tag=tag&builder=Player', [0, 5]],
    ['tag=missing', []],
  ];
  for (const [query, indexes] of queries) {
    const { buildings } = await (await read(f, `?limit=2&${query}`)).json() as { buildings: Building[] };
    expect(buildings.map((building) => building.id)).toEqual(
      indexes.map((index) => f.buildings[index].id),
    );
  }
  const { buildings: localized } = await (
    await read(f, '?limit=2&type=original&tag=tag&builder=Player&locale=zh-CN')
  ).json();
  expect(localized).toHaveLength(2);
  expect(localized.map((building: { name: string }) => building.name)).toEqual(['建筑', '建筑']);
  expect(localized[0].description).toBe('描述');
  expect(localized[0].tags).toEqual(['标签']);
});

test('invalid or repeated limits return uncached CORS errors before any storage read', async () => {
  const f = fixture();
  let cacheReads = 0;
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: { default: { match: async () => { cacheReads++; } } },
  });
  const values = [
    '', ' ', '0', '-1', '101', '1.5', '1.0', '1e2', '0x2', 'NaN', 'Infinity',
    '2cats', '+2', '1 0', '9007199254740993', '9'.repeat(400),
  ];
  const queries = values.map((value) => `?limit=${encodeURIComponent(value)}`);
  queries.push('?limit=1&limit=2', '?limit=2&limit=2');
  for (const query of queries) {
    const response = await read(f, query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_limit' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  }
  expect(f.reads()).toBe(0);
  expect(cacheReads).toBe(0);
});

test('normalized limits share concurrent work and keep full, limited and revision caches separate', async () => {
  const f = catalogFixture();
  const cache = new Map<string, Response>();
  let writes = 0;
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: {
      default: {
        match: async (request: Request) => cache.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          writes++;
          cache.set(request.url, response.clone());
        },
      },
    },
  });
  const { imageBaseUrl, buildings: full } = await (await read(f)).json() as { imageBaseUrl: string; buildings: Building[] };
  const limitedCatalog = (count: number) => ({ imageBaseUrl, buildings: full.slice(0, count) });
  expect(imageBaseUrl).toBe(f.env.BUILDING_IMAGE_PUBLIC_BASE_URL!);
  expect(full.map((building) => building.id)).toEqual(
    [1, 2, 3, 4, 0, 5].map((index) => f.buildings[index].id),
  );
  expect(full[0].name).toEqual(f.building.name);
  expect(await (await read(f, '?limit=100')).json()).toEqual({ imageBaseUrl, buildings: full });
  const queries = ['?limit=2', '?limit=%202%20', '?limit=02'];
  const bodies = await Promise.all(
    Array.from({ length: 20 }, async (_, index) =>
      (await read(f, queries[index % queries.length])).text(),
    ),
  );
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0])).toEqual(limitedCatalog(2));
  expect(writes).toBe(3);
  expect(await (await read(f, '?limit=1')).json()).toEqual(limitedCatalog(1));
  expect(writes).toBe(4);
  expect(cache.size).toBe(4);
  expect(f.reads()).toBe(1);

  // A fresh catalog state must receive the right variant from the shared edge cache.
  const cold = catalogFixture();
  expect(await (await read(cold, '?limit=2')).json()).toEqual(limitedCatalog(2));
  expect(await (await read(cold)).json()).toEqual({ imageBaseUrl, buildings: full });
  expect(await (await read(cold, '?limit=1')).json()).toEqual(limitedCatalog(1));
  expect(writes).toBe(4);

  const now = Date.now();
  const date = spyOn(Date, 'now').mockReturnValue(now + 60_001);
  try {
    f.update();
    const refreshed = await (await read(f, '?limit=2')).json();
    expect(refreshed.buildings).toHaveLength(1);
    expect(refreshed.buildings[0].name.en).toBe('New');
    expect(await (await read(f)).json()).toEqual(refreshed);
    expect(writes).toBe(6);
    expect(cache.size).toBe(6);
    expect(f.reads()).toBe(2);
  } finally {
    date.mockRestore();
  }
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
  expect(JSON.parse(bodies[0]).buildings[0].name).toBe('Building');
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
    expect(await (await read(f, '?limit=0', f.building.id)).json()).toEqual({
      imageBaseUrl: f.env.BUILDING_IMAGE_PUBLIC_BASE_URL,
      building: f.building,
    });
    expect((await read(f, '', '0'.repeat(32))).status).toBe(404);
    f.update();
    now += 60_000;
    expect((await (await read(f)).json()).buildings[0].name.en).toBe('New');
    expect((await (await read(f, '', f.building.id)).json()).building.name.en).toBe('New');
  } finally {
    date.mockRestore();
  }
});

test('public third-party reads share an empty snapshot lookup and retain CORS on failures', async () => {
  const f = fixture();
  let reads = 0;
  const publicRequest = (query = '') =>
    new Request('https://data.example/api/buildings' + query, {
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
  const empty = { imageBaseUrl: f.env.BUILDING_IMAGE_PUBLIC_BASE_URL, buildings: [] };
  expect(await responses[0]?.json()).toEqual(empty);
  const limited = await handlePublicBuildingsRoute('/buildings', publicRequest('?limit=2'), f.env);
  expect(await limited?.json()).toEqual(empty);
  expect(reads).toBe(1);
  f.env.BUILDING_IMAGE_PUBLIC_BASE_URL = undefined;
  const withoutBase = await handlePublicBuildingsRoute('/buildings', publicRequest(), f.env);
  expect(await withoutBase?.json()).toEqual({ imageBaseUrl: null, buildings: [] });
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
