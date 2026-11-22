import { expect, test } from 'bun:test';
import type { Env } from '../src/env';
import { afdianSign, md5Hex } from '../src/md5';
import { afdianOrderTime, fetchAfdianRemarkOrders, fetchAfdianSponsors } from '../src/afdian';
import { handlePublicSponsorsRoute, SPONSOR_MANUAL_PREFIX, SPONSOR_MAPPING_PREFIX, type Sponsor } from '../src/sponsors';
import { testAuthEnv } from './helpers/auth-store';

// --- md5 / signing -----------------------------------------------------------

test('md5 matches known digests', () => {
  expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  expect(
    md5Hex('The quick brown fox jumps over the lazy dog'),
  ).toBe('9e107d9d372bb6826bd81d3542a419d6');
  expect(
    md5Hex('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  ).toBe('76658de2ac7d406f93dfbe8bb6d9f549');
});

test('afdian sign matches the official vector', () => {
  // From the official docs: token=123, user_id=abc, params={"a":333}, ts=1624339905
  expect(afdianSign('123', 'abc', '{"a":333}', 1624339905)).toBe(
    'a4acc28b81598b7e5d84ebdc3e91710c',
  );
});

// --- order timestamp parsing -------------------------------------------------

test('parses Afdian out_trade_no head as China-time seconds', () => {
  // 2021-06-23 21:38:37 CNA -> 1624455517
  expect(afdianOrderTime('202106232138371083454010626')).toBe(1624455517);
  // 2026-02-01 09:30:59 CNA -> 1769909459
  expect(afdianOrderTime('202602010930591234567890123')).toBe(1769909459);
});

test('returns 0 for implausible or malformed heads', () => {
  expect(afdianOrderTime('short')).toBe(0);
  // month 13 is implausible
  expect(afdianOrderTime('202613010930591234567890123')).toBe(0);
});

// --- catalog assembly + public route -----------------------------------------

interface FakeKvOptions {
  mappings?: Record<string, string>;
  manual?: Record<string, unknown>;
  listShouldFail?: boolean;
}
function fakeKv(options: FakeKvOptions = {}) {
  const store = new Map<string, string>();
  if (options.mappings)
    for (const [userId, value] of Object.entries(options.mappings))
      store.set(`${SPONSOR_MAPPING_PREFIX}${userId}`, value);
  if (options.manual)
    for (const [key, value] of Object.entries(options.manual))
      store.set(`${SPONSOR_MANUAL_PREFIX}${key}`, JSON.stringify(value));
  return {
    get: async (key: string) => store.get(key) ?? null,
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [
        ...store.keys().filter((name) => !prefix || name.startsWith(prefix)).map((name) => ({ name })),
      ],
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as Env['BUILDINGS_KV'];
}

function mockAfdianFetch(
  calls: { url: string; body: string }[],
  sponsorsResponse?: unknown,
  ordersResponse?: unknown,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    calls.push({ url, body: '' });
    let data: unknown;
    if (url.includes('/query-sponsor')) data = sponsorsResponse;
    else if (url.includes('/query-order')) data = ordersResponse;
    else data = { ec: 200, em: 'ok' };
    return Response.json(data);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('catalog joins afdian roster, remark orders and a KV mapping', async () => {
  const restore = mockAfdianFetch(
    [],
    {
      ec: 200,
      data: {
        total_page: 1,
        list: [
          {
            user: { user_id: 'u-1', name: 'Hee' },
            all_sum_amount: '128.00',
          },
        ],
      },
    },
    {
      ec: 200,
      data: {
        total_page: 1,
        list: [
          { out_trade_no: '202106232138371083454010626', user_id: 'u-1', total_amount: '30.00', remark: '支持服务器！' },
          { out_trade_no: '202602010930591234567890123', user_id: 'u-1', total_amount: '98.00', remark: '二周年快乐' },
        ],
      },
    },
  );

  const kv = fakeKv({
    mappings: { 'u-1': '069a79f4-44e9-4726-a5be-fca4e82d3858' },
  });
  const env = testAuthEnv({
    BUILDINGS_KV: kv,
    AFDIAN_USER_ID: 'creator',
    AFDIAN_API_TOKEN: 'token',
  });

  const response = await handlePublicSponsorsRoute(
    '/sponsors',
    new Request('https://data.mcmik.top/api/sponsors', { method: 'GET' }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );

  expect(response!.status).toBe(200);
  const list = (await response!.json()) as Sponsor[];
  expect(list).toHaveLength(1);
  const sponsor = list[0];
  expect(sponsor.name).toBe('Hee');
  expect(sponsor.totalAmount).toBe('128.00');
  expect(sponsor.uuid).toBe('069a79f4-44e9-4726-a5be-fca4e82d3858');
  expect(sponsor.orders.map((order) => order.id)).toEqual([
    'af:202602010930591234567890123',
    'af:202106232138371083454010626',
  ]);
  expect(sponsor.orders[0].at).toBe(1769909459);
  expect(sponsor.orders[1].at).toBe(1624455517);
  restore();
});

test('serves manual records when afdian credentials are absent', async () => {
  const kv = fakeKv({
    manual: {
      '069a79f4-44e9-4726-a5be-fca4e82d3858': {
        displayKey: '069a79f4-44e9-4726-a5be-fca4e82d3858',
        name: '某位朋友',
        uuid: '069a79f4-44e9-4726-a5be-fca4e82d3858',
        totalAmount: '50',
        orders: [{ id: '20261119-0001', amount: '50', remark: '感谢转账支持', at: 1752950400 }],
      },
    },
  });
  const env = testAuthEnv({ BUILDINGS_KV: kv, AFDIAN_USER_ID: '', AFDIAN_API_TOKEN: '' });

  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(input.toString());
    return Response.json({ ec: 200, data: {} });
  }) as typeof fetch;

  const response = await handlePublicSponsorsRoute(
    '/sponsors',
    new Request('https://data.mcmik.top/api/sponsors', { method: 'GET' }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );

  expect(response!.status).toBe(200);
  expect(calls).toHaveLength(0); // no upstream traffic when credentials are unset
  const list = (await response!.json()) as Sponsor[];
  expect(list).toHaveLength(1);
  expect(list[0].uuid).toBe('069a79f4-44e9-4726-a5be-fca4e82d3858');
  expect(list[0].orders[0].id).toBe('mn:20261119-0001');
  globalThis.fetch = original;
});

test('fails closed with 503 when afdian is unreachable and nothing is cached', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('upstream down');
  }) as typeof fetch;

  const env = testAuthEnv({
    BUILDINGS_KV: fakeKv({}),
    AFDIAN_USER_ID: 'creator',
    AFDIAN_API_TOKEN: 'token',
  });

  const response = await handlePublicSponsorsRoute(
    '/sponsors',
    new Request('https://data.mcmik.top/api/sponsors', { method: 'GET' }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );

  expect(response!.status).toBe(503);
  expect(await response!.json()).toEqual({ error: 'sponsor_data_unavailable' });
  globalThis.fetch = original;
});

test('remark orders skip entries without a remark or id', async () => {
  const calls: { url: string }[] = [];
  const restore = mockAfdianFetch(calls, undefined, {
    ec: 200,
    data: {
      total_page: 1,
      list: [
        { out_trade_no: '202106232138371083454010626', user_id: 'u-1', total_amount: '10.00', remark: ' ' },
        { out_trade_no: '', user_id: 'u-1', total_amount: '10.00', remark: 'missing id' },
        { out_trade_no: '202106232138371083454010626', user_id: 'u-1', total_amount: '10.00', remark: 'kept' },
      ],
    },
  });

  const env = testAuthEnv({ AFDIAN_USER_ID: 'creator', AFDIAN_API_TOKEN: 'token' });
  const orders = await fetchAfdianRemarkOrders(env);
  expect(orders).toHaveLength(1);
  expect(orders[0].outTradeNo).toBe('202106232138371083454010626');
  expect(orders[0].remark).toBe('kept');
  restore();
});

test('unmapped afdian sponsors are withheld from the public list', async () => {
  const restore = mockAfdianFetch(
    [],
    {
      ec: 200,
      data: {
        total_page: 1,
        list: [
          { user: { user_id: 'u-9', name: '匿名赞助者' }, all_sum_amount: '10.00' },
        ],
      },
    },
    { ec: 200, data: { total_page: 0, list: [] } },
  );

  const env = testAuthEnv({
    BUILDINGS_KV: fakeKv({}),
    AFDIAN_USER_ID: 'creator',
    AFDIAN_API_TOKEN: 'token',
  });
  const response = await handlePublicSponsorsRoute(
    '/sponsors',
    new Request('https://data.mcmik.top/api/sponsors', { method: 'GET' }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );

  expect(response!.status).toBe(200);
  const list = (await response!.json()) as Sponsor[];
  expect(list).toHaveLength(0); // no mapping -> withheld
  restore();
});
