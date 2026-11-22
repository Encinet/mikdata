import { expect, test } from 'bun:test';
import type { Env } from '../src/env';
import {
  handleAdminSponsorsRoute,
  handlePublicSponsorsRoute,
  SPONSOR_MANUAL_PREFIX,
  SPONSOR_MAPPING_PREFIX,
  SPONSOR_REVISION_KEY,
  type AdminCatalogEntry,
  type ManualSponsorRecord,
} from '../src/sponsors';
import { testAuthEnv } from './helpers/auth-store';

const ACTOR = { email: 'admin@mcmik.top' };
const UUID = '069a79f4-44e9-4726-a5be-fca4e82d3858';

interface FakeKvOptions {
  mappings?: Record<string, string>;
  manual?: Record<string, unknown>;
  revision?: number;
}

function fakeKv(options: FakeKvOptions = {}) {
  const store = new Map<string, string>();
  if (options.mappings)
    for (const [userId, value] of Object.entries(options.mappings))
      store.set(`${SPONSOR_MAPPING_PREFIX}${userId}`, value);
  if (options.manual)
    for (const [key, value] of Object.entries(options.manual))
      store.set(`${SPONSOR_MANUAL_PREFIX}${key}`, JSON.stringify(value));
  if (options.revision !== undefined) store.set(SPONSOR_REVISION_KEY, String(options.revision));
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as Env['BUILDINGS_KV'];
}

function adminRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://data.mcmik.top/admin/api${path}`, init);
}

function mockAfdianFetch(
  calls: string[],
  roster?: unknown,
  ordersResponse?: unknown,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    calls.push(url);
    if (url.includes('/query-sponsor'))
      return Response.json(roster ?? { ec: 200, data: { total_page: 0, list: [] } });
    if (url.includes('/query-order'))
      return Response.json(ordersResponse ?? { ec: 200, data: { total_page: 0, list: [] } });
    return Response.json({ ec: 200, data: {} });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// --- mapping management ------------------------------------------------------

test('mapping PUT upserts and bumps the revision', async () => {
  const kv = fakeKv();
  const env = testAuthEnv({ BUILDINGS_KV: kv, AFDIAN_USER_ID: '', AFDIAN_API_TOKEN: '' });

  const response = await handleAdminSponsorsRoute(
    '/sponsor-mappings',
    adminRequest('/sponsor-mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ afdianUserId: 'adf1', uuid: UUID }),
    }),
    env,
    ACTOR,
  );

  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({ afdianUserId: 'adf1', uuid: UUID });
  expect(kv.get(`${SPONSOR_MAPPING_PREFIX}adf1`)).resolves.toBe(UUID);
  expect(kv.get(SPONSOR_REVISION_KEY)).resolves.toBe('1');
});

test('mapping PUT rejects non-UUID values and bad ids', async () => {
  const kv = fakeKv();
  const env = testAuthEnv({ BUILDINGS_KV: kv, AFDIAN_USER_ID: '', AFDIAN_API_TOKEN: '' });

  const bad = await handleAdminSponsorsRoute(
    '/sponsor-mappings',
    adminRequest('/sponsor-mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ afdianUserId: 'adf1', uuid: 'not-a-uuid' }),
    }),
    env,
    ACTOR,
  );
  expect(bad!.status).toBe(400);

  const missing = await handleAdminSponsorsRoute(
    '/sponsor-mappings',
    adminRequest('/sponsor-mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: UUID }),
    }),
    env,
    ACTOR,
  );
  expect(missing!.status).toBe(400);
});

test('mapping DELETE removes the key, 404 when absent', async () => {
  const kv = fakeKv({ mappings: { adf1: UUID }, revision: 0 });
  const env = testAuthEnv({ BUILDINGS_KV: kv, AFDIAN_USER_ID: '', AFDIAN_API_TOKEN: '' });

  const missing = await handleAdminSponsorsRoute(
    '/sponsor-mappings/adf2',
    adminRequest('/sponsor-mappings/adf2', { method: 'DELETE' }),
    env,
    ACTOR,
  );
  expect(missing!.status).toBe(404);

  const gone = await handleAdminSponsorsRoute(
    '/sponsor-mappings/adf1',
    adminRequest('/sponsor-mappings/adf1', { method: 'DELETE' }),
    env,
    ACTOR,
  );
  expect(gone!.status).toBe(204);
  expect(kv.get(`${SPONSOR_MAPPING_PREFIX}adf1`)).resolves.toBeNull();
  expect(kv.get(SPONSOR_REVISION_KEY)).resolves.toBe('1');

  const list = await handleAdminSponsorsRoute(
    '/sponsor-mappings',
    adminRequest('/sponsor-mappings'),
    env,
    ACTOR,
  );
  expect(await list!.json()).toEqual([]);
});

// --- manual records ----------------------------------------------------------

test('manual PUT stores the record and bumps the revision', async () => {
  const kv = fakeKv({ revision: 0 });
  const env = testAuthEnv({ BUILDINGS_KV: kv, AFDIAN_USER_ID: '', AFDIAN_API_TOKEN: '' });

  const response = await handleAdminSponsorsRoute(
    '/sponsors/friend',
    adminRequest('/sponsors/friend', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '某位朋友',
        uuid: UUID,
        totalAmount: '50',
        orders: [{ id: '20261119-0001', amount: '50', remark: '感谢转账支持', at: 1752950400 }],
      }),
    }),
    env,
    ACTOR,
  );

  expect(response!.status).toBe(200);
  const body = (await response!.json()) as ManualSponsorRecord;
  expect(body.displayKey).toBe('friend');
  expect(body.name).toBe('某位朋友');
  expect(kv.get(`${SPONSOR_MANUAL_PREFIX}friend`)).resolves.toBe(JSON.stringify(body));
  expect(kv.get(SPONSOR_REVISION_KEY)).resolves.toBe('1');
});

test('manual PUT validates order fields', async () => {
  const kv = fakeKv();
  const env = testAuthEnv({ BUILDINGS_KV: kv, AFDIAN_USER_ID: '', AFDIAN_API_TOKEN: '' });

  const put = (payload: unknown) =>
    handleAdminSponsorsRoute(
      '/sponsors/friend',
      adminRequest('/sponsors/friend', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      env,
      ACTOR,
    );

  expect((await put({ name: '', orders: [] }))!.status).toBe(400); // empty name
  expect(
    (await put({ name: 'A', totalAmount: 'abc' }))!.status,
  ).toBe(400); // bad amount
  expect(
    (await put({ name: 'A', orders: [{ id: 'x', amount: '1', remark: 'r' }, { id: 'x', amount: '1', remark: 'r' }] }))!.status,
  ).toBe(400); // duplicate order id
  expect(
    (await put({ name: 'A', orders: [{ id: 'x', amount: '1', remark: '' }] }))!.status,
  ).toBe(400); // remark required
  expect(
    (await put({ name: 'A', orders: [{ id: 'x', amount: '1', remark: 'r', at: -5 }] }))!.status,
  ).toBe(400); // negative at
  expect(
    (await put({ name: 'A', uuid: 'nope', orders: [] }))!.status,
  ).toBe(400); // bad uuid
});

test('manual DELETE returns 404 for unknown keys and 204 for stored ones', async () => {
  const kv = fakeKv({ manual: { friend: { displayKey: 'friend', name: '某位朋友', orders: [] } } });
  const env = testAuthEnv({ BUILDINGS_KV: kv, AFDIAN_USER_ID: '', AFDIAN_API_TOKEN: '' });

  const missing = await handleAdminSponsorsRoute(
    '/sponsors/ghost',
    adminRequest('/sponsors/ghost', { method: 'DELETE' }),
    env,
    ACTOR,
  );
  expect(missing!.status).toBe(404);

  const gone = await handleAdminSponsorsRoute(
    '/sponsors/friend',
    adminRequest('/sponsors/friend', { method: 'DELETE' }),
    env,
    ACTOR,
  );
  expect(gone!.status).toBe(204);
});

// --- admin catalog view ------------------------------------------------------

test('admin catalog exposes afdianUserId and mapping state', async () => {
  const calls: string[] = [];
  const restore = mockAfdianFetch(
    calls,
    {
      ec: 200,
      data: {
        total_page: 1,
        list: [{ user: { user_id: 'u-1', name: 'Hee' }, all_sum_amount: '128.00' }],
      },
    },
  );
  const kv = fakeKv({ mappings: { 'u-1': UUID }, revision: 0 });
  const env = testAuthEnv({
    BUILDINGS_KV: kv,
    AFDIAN_USER_ID: 'creator',
    AFDIAN_API_TOKEN: 'token',
  });

  const response = await handleAdminSponsorsRoute(
    '/sponsor-catalog',
    adminRequest('/sponsor-catalog'),
    env,
    ACTOR,
  );

  expect(response!.status).toBe(200);
  const entries = (await response!.json()) as AdminCatalogEntry[];
  expect(entries).toEqual([
    { afdianUserId: 'u-1', name: 'Hee', totalAmount: '128.00', uuid: UUID },
  ]);
  restore();
});

// --- revision-driven instant effect + zero extra upstream pressure -----------

test('admin writes take effect on the next public read without re-fetching afdian', async () => {
  const calls: string[] = [];
  const restore = mockAfdianFetch(
    calls,
    {
      ec: 200,
      data: {
        total_page: 1,
        list: [{ user: { user_id: 'u-1', name: 'Hee' }, all_sum_amount: '128.00' }],
      },
    },
    {
      ec: 200,
      data: {
        total_page: 1,
        list: [
          { out_trade_no: '202602010930591234567890123', user_id: 'u-1', total_amount: '98.00', remark: '二周年快乐' },
        ],
      },
    },
  );
  const kv = fakeKv({ mappings: { 'u-1': UUID }, revision: 0 });
  const env = testAuthEnv({
    BUILDINGS_KV: kv,
    AFDIAN_USER_ID: 'creator',
    AFDIAN_API_TOKEN: 'token',
  });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

  const first = await handlePublicSponsorsRoute(
    '/sponsors',
    new Request('https://data.mcmik.top/api/sponsors'),
    env,
    ctx,
  );
  expect(first!.status).toBe(200);
  const upstreamCallsBefore = calls.filter((url) => url.includes('afdian.com')).length;
  expect(upstreamCallsBefore).toBeGreaterThan(0);

  // Add a manual sponsor through the admin API: bumps the revision.
  const write = await handleAdminSponsorsRoute(
    '/sponsors/friend',
    adminRequest('/sponsors/friend', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '某位朋友',
        uuid: '11111111-2222-4333-8444-555566667777',
        totalAmount: '50',
        orders: [{ id: 'm-1', amount: '50', remark: '感谢转账支持', at: 1752950400 }],
      }),
    }),
    env,
    ACTOR,
  );
  expect(write!.status).toBe(200);

  const second = await handlePublicSponsorsRoute(
    '/sponsors',
    new Request('https://data.mcmik.top/api/sponsors'),
    env,
    ctx,
  );
  expect(second!.status).toBe(200);
  const list = (await second!.json()) as Array<{ uuid: string; name: string }>;
  expect(list).toHaveLength(2);
  expect(list.map((s) => s.name).sort()).toEqual(['Hee', '某位朋友']);
  // The fresh Afdian payload was still inside its fifteen-minute window:
  // the revision bump forced a re-join but produced zero new upstream calls.
  expect(calls.filter((url) => url.includes('afdian.com')).length).toBe(upstreamCallsBefore);
  restore();
});

// --- rate limiting -----------------------------------------------------------

test('admin routes return 429 when the limiter rejects', async () => {
  const kv = fakeKv();
  const env = testAuthEnv({ BUILDINGS_KV: kv, AFDIAN_USER_ID: '', AFDIAN_API_TOKEN: '' });
  env.AUTH_SENSITIVE_RATE_LIMITER = {
    limit: async () => ({ success: false }),
  } as unknown as Env['AUTH_SENSITIVE_RATE_LIMITER'];

  const response = await handleAdminSponsorsRoute(
    '/sponsor-mappings',
    adminRequest('/sponsor-mappings'),
    env,
    ACTOR,
  );
  expect(response!.status).toBe(429);
  expect(response!.headers.get('Retry-After')).toBe('60');
});

test('admin routes fail open when the limiter is unavailable', async () => {
  const kv = fakeKv();
  const env = testAuthEnv({ BUILDINGS_KV: kv, AFDIAN_USER_ID: '', AFDIAN_API_TOKEN: '' });
  env.AUTH_SENSITIVE_RATE_LIMITER = {
    limit: async () => {
      throw new Error('limiter down');
    },
  } as unknown as Env['AUTH_SENSITIVE_RATE_LIMITER'];

  const response = await handleAdminSponsorsRoute(
    '/sponsor-mappings',
    adminRequest('/sponsor-mappings'),
    env,
    ACTOR,
  );
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual([]);
});

// --- boundary ----------------------------------------------------------------

test('unknown admin sponsor routes fall through to the caller', async () => {
  const kv = fakeKv();
  const env = testAuthEnv({ BUILDINGS_KV: kv, AFDIAN_USER_ID: '', AFDIAN_API_TOKEN: '' });
  const response = await handleAdminSponsorsRoute(
    '/buildings/069a79f444e94726a5befca4e82d3858',
    adminRequest('/buildings/069a79f444e94726a5befca4e82d3858'),
    env,
    ACTOR,
  );
  expect(response).toBeNull();
});
