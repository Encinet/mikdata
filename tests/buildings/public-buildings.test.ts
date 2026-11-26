import { afterEach, expect, test } from 'bun:test';
import { handlePublicBuildingsRoute } from '../../src/buildings/public-route';
import { testAuthEnv, OTHER_UUID, PLAYER_UUID } from '../helpers/auth';
import type { Building } from '../../src/buildings/types';
import { testDatabase } from '../helpers/d1';

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
    images: [{ webp: hash, jxl: hash, thumbnailWebp: hash, jxlPreviewBytes: 0 }],
    buildDate: '2026-06-27',
  };
  const { db, sqlite, hooks } = testDatabase();
  const selects: string[] = [];
  const env = testAuthEnv({ DB: db, BUILDING_IMAGE_PUBLIC_BASE_URL: origin });
  function replace(buildings: Building[]) {
    sqlite.exec('DELETE FROM buildings');
    for (const entry of buildings)
      sqlite.query('INSERT INTO buildings(id,document) VALUES(?,?)').run(entry.id, JSON.stringify(entry));
  }
  hooks.before = sql => selects.push(sql);
  replace([building]);
  return { env, building, selects, replace, hooks };
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

test('limit is applied after every filter and before localization', async () => {
  const f = catalogFixture();
  const queries: [string, number[], number][] = [
    ['type=original', [1, 3], 5],
    ['tag=tag', [2, 3], 4],
    [`tag=${encodeURIComponent('标签')}`, [2, 3], 4],
    ['builder=Player', [2, 4], 4],
    [`builder=${PLAYER_UUID}`, [2, 4], 4],
    ['type=original&tag=tag&builder=Player', [0, 5], 2],
    ['tag=missing', [], 0],
  ];
  for (const [query, indexes, expectedTotal] of queries) {
    const { buildings, total } = await (await read(f, `?limit=2&${query}`)).json() as { buildings: Building[]; total: number };
    expect(total).toBe(expectedTotal);
    expect(buildings.map((building) => building.id)).toEqual(
      indexes.map((index) => f.buildings[index].id),
    );
  }
  const { buildings: localized } = await (
    await read(f, '?limit=2&type=%20original&tag=tag%20&builder=%20Player&locale=zh-CN%20')
  ).json();
  expect(localized).toHaveLength(2);
  expect(localized.map((building: { name: string }) => building.name)).toEqual(['建筑', '建筑']);
  expect(localized[0].description).toBe('描述');
  expect(localized[0].tags).toEqual(['标签']);
  expect(await (await read(f, '?locale=unknown')).json()).toEqual(await (await read(f, '?locale=en')).json());
});

test('public building responses skip blank tags and fall back to the available language', async () => {
  const f = fixture();
  f.replace([{
    ...f.building,
    tags: [{ 'zh-CN': '', en: '' }, { 'zh-CN': '', en: 'Trail' }],
    source: { notes: { 'zh-CN': '', en: 'Credit' } },
  }]);
  const list = await read(f, '?locale=zh-CN');
  expect(list.status).toBe(200);
  const { buildings } = await list.json() as { buildings: { tags: string[]; source: { notes: string } }[] };
  expect(buildings[0].tags).toEqual(['Trail']);
  expect(buildings[0].source.notes).toBe('Credit');
  const detail = await (await read(f, '', f.building.id)).json() as { building: Building };
  expect(detail.building.tags).toEqual([{ 'zh-CN': '', en: 'Trail' }]);
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
  expect(f.selects).toHaveLength(0);
  expect(cacheReads).toBe(0);
});

test('normalized pages share concurrent work and cache hits perform no D1 queries', async () => {
  const f = catalogFixture();
  const cache = new Map<string, Response>();
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: {
      match: async (request: Request) => cache.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
        cache.set(request.url, response.clone());
      },
    } },
  });
  const imageBaseUrl = f.env.BUILDING_IMAGE_PUBLIC_BASE_URL;
  const indexes = [1, 2, 3, 4, 0, 5];
  const full = indexes.map(index => f.buildings[index]);
  const queries = ['?limit=2&offset=2', '?offset=02&limit=%202%20', '?limit=02&offset=2'];
  const bodies = await Promise.all(
    Array.from({ length: 20 }, async (_, index) => (await read(f, queries[index % queries.length])).text()),
  );
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0])).toEqual({ imageBaseUrl, buildings: full.slice(2, 4), total: 6 });
  expect(f.selects).toEqual([expect.stringContaining('LIMIT ? OFFSET ?'), expect.stringContaining('count(*)')]);

  const cold = catalogFixture();
  const page = await read(cold, '?limit=2&offset=2');
  expect(await page.text()).toBe(bodies[0]);
  expect(page.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(cold.selects).toHaveLength(0);

  expect(await (await read(f)).json()).toEqual({ imageBaseUrl, buildings: full });
  expect(await (await read(f, '?limit=2')).json()).toEqual({ imageBaseUrl, buildings: full.slice(0, 2), total: 6 });
  expect(await (await read(f, '?limit=2&offset=6')).json()).toEqual({ imageBaseUrl, buildings: [], total: 6 });
  expect(cache.size).toBe(4);
});

test('invalid offsets return before storage and offsets apply after filtering with stable ordering', async () => {
  const f = catalogFixture();
  for (const query of ['?offset=0', '?limit=2&offset=', '?limit=2&offset=-1', '?limit=2&offset=1&offset=2', '?limit=2&offset=9007199254740992']) {
    const response = await read(f, query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_offset' });
  }
  expect(f.selects).toHaveLength(0);

  const sameDate = f.buildings.map(building => ({ ...building, buildDate: '2026-07-01' }));
  f.replace(sameDate.reverse());
  const { buildings, total } = await (await read(f, '?limit=2&offset=1&type=original')).json();
  expect(buildings.map((building: Building) => building.id)).toEqual([f.buildings[1].id, f.buildings[3].id]);
  expect(total).toBe(5);
});

test('public reads use the configured image base URL in their cache key', async () => {
  const f = fixture();
  const cache = new Map<string, Response>();
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: {
      match: async (request: Request) => cache.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => { cache.set(request.url, response.clone()); },
    } },
  });
  for (const base of ['https://images.example/gallery', 'https://cdn.example/photos']) {
    f.env.BUILDING_IMAGE_PUBLIC_BASE_URL = base + '/';
    expect(await (await read(f)).json()).toEqual({ imageBaseUrl: base, buildings: [f.building] });
    expect(await (await read(f, '', f.building.id)).json()).toEqual({ imageBaseUrl: base, building: f.building });
  }
  expect(cache.size).toBe(4);
});

test('cold details query by ID and cached responses refresh after expiry', async () => {
  const f = catalogFixture();
  const original = f.buildings[0];
  const cache = new Map<string, Response>();
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: {
      match: async (request: Request) => cache.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => { cache.set(request.url, response.clone()); },
    } },
  });
  const readDetail = () => read(f, '?limit=0', original.id);
  const first = await (await readDetail()).json();
  expect(first.building).toEqual(original);
  expect(f.selects).toEqual(['SELECT document FROM buildings WHERE id=?']);
  f.replace([{ ...original, name: { 'zh-CN': '新建筑', en: 'New' } }]);
  expect(await (await readDetail()).json()).toEqual(first);
  expect(f.selects).toHaveLength(1);
  cache.clear();
  expect((await (await readDetail()).json()).building.name.en).toBe('New');
  expect(f.selects).toHaveLength(2);
  expect((await read(f, '', '0'.repeat(32))).status).toBe(404);
  expect(cache.size).toBe(1);
});

test('cache failures fall back to D1 and D1 failures return uncached CORS errors', async () => {
  const f = fixture();
  const failCache = async () => { throw new Error('Cache unavailable'); };
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: { match: failCache, put: failCache } },
  });
  f.replace([]);
  f.env.BUILDING_IMAGE_PUBLIC_BASE_URL = undefined;
  const responses = await Promise.all(Array.from({ length: 3 }, () => read(f)));
  expect(f.selects).toHaveLength(1);
  for (const response of responses) {
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toEqual({ imageBaseUrl: null, buildings: [] });
  }
  f.hooks.before = () => { throw new Error('D1 unavailable'); };
  const failed = await read(f);
  expect(failed.status).toBe(503);
  expect(failed.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(failed.headers.get('Cache-Control')).toBe('no-store');
});
