import { expect, test } from 'bun:test';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { canonicalContent, contentTag } from '../../src/shared/content-precondition';
import { handleAdminSponsorsRoute } from '../../src/sponsors';
import { AFDIAN_FRESH_MS } from '../../src/sponsors/cache';
import { MAX_MANUAL_MESSAGE_LENGTH } from '../../src/sponsors/model';
import {
  AFDIAN_ORDER_ID, ORDER_ID, OTHER_UUID, UUID, afdianOrder, mockAfdian, sponsorEnv,
} from './helpers';

const actor = { email: 'admin@example.com' };
const afdianEnv = { AFDIAN_USER_ID: 'creator', AFDIAN_API_TOKEN: 'token' };
const MANUAL_AT = 1795290000;
const MANUAL_AT_UTC = '2026-11-21T19:40:00.000Z';
const AFDIAN_AT_UTC = '2026-11-22T01:12:23.000Z';
const manualPath = (uuid = UUID, orderId = ORDER_ID) => '/sponsors/' + uuid + '/orders/' + orderId;

function admin(env: Env, path: string, method = 'GET', body?: Record<string, unknown>, origin?: string, ifMatch?: string) {
  const headers = new Headers();
  if (body) headers.set('Content-Type', 'application/json');
  if (origin) headers.set('Origin', origin);
  if (ifMatch) headers.set('If-Match', ifMatch);
  const request = new Request('https://data.mcmik.top/admin/api' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return handleAdminSponsorsRoute(path, request, env, actor);
}

function orderMatch(uuid: string, amount: string, at: number, message = '') {
  return contentTag(canonicalContent({ id: ORDER_ID, uuid, amount, at, message }));
}

function publicList(env: Env) {
  return worker.fetch(new Request('https://data.mcmik.top/api/sponsors'), env, {
    waitUntil: () => {},
  } as unknown as ExecutionContext);
}

test('the public list sorts sponsors by their latest payment and orders by payment time', async () => {
  const message = '感谢维护服务器！\n下次见。';
  const pendingMessage = '支持一下 <3';
  const firstOrder = { at: AFDIAN_AT_UTC, amount: '20.00', message };
  const secondOrder = { at: '2026-11-22T16:00:00.000Z', amount: '0.20', message: pendingMessage };
  const manualOrder = { at: MANUAL_AT_UTC, amount: '0.10' };
  const restore = mockAfdian((endpoint) => ({
    total_page: 1,
    list: endpoint === 'query-sponsor'
      ? [
        { user: { user_id: 'u-1', name: 'Afdian supporter' }, all_sum_amount: '999.99' },
        { user: { user_id: 'u-2', name: 'Second account' } },
      ]
      : [afdianOrder({ remark: message }), afdianOrder({
        user_id: 'u-2', out_trade_no: '20261123000000001', total_amount: '0.20', remark: pendingMessage,
      })],
  }));
  try {
    const env = sponsorEnv(afdianEnv);
    expect((await (await admin(env, '/sponsor-catalog'))!.json()).pending).toHaveLength(2);
    for (const afdianUserId of ['u-1', 'u-2']) {
      expect((await admin(env, '/sponsor-mappings', 'PUT', {
        afdianUserId, uuid: UUID.replaceAll('-', '').toUpperCase(),
      }))!.status).toBe(204);
    }
    await admin(env, '/sponsors/' + UUID, 'PUT', { name: 'Player' });
    await admin(env, manualPath(), 'PUT', { amount: '0.10', at: MANUAL_AT });

    expect(await (await publicList(env))!.json()).toEqual([{
      uuid: UUID, name: 'Player', totalAmount: '20.30',
      orders: [secondOrder, firstOrder, manualOrder],
    }]);
    const { players, pending } = await (await admin(env, '/sponsor-catalog'))!.json();
    expect(pending).toEqual([]);
    expect(players).toEqual([{
      uuid: UUID, name: 'Player', totalAmount: '20.30', manual: true,
      accounts: [
        { afdianUserId: 'u-1', name: 'Afdian supporter' },
        { afdianUserId: 'u-2', name: 'Second account' },
      ],
    }]);
    const detail = await (await admin(env, '/sponsor-catalog/' + UUID))!.json();
    expect(detail.customName).toBe('Player');
    expect(detail.orders).toHaveLength(3);
    expect(detail.orders).toContainEqual({ id: 'af:' + AFDIAN_ORDER_ID, source: 'afdian', ...firstOrder, at: 1795309943 });
    expect(detail.orders).toContainEqual({ id: 'mn:' + ORDER_ID, source: 'manual', ...manualOrder, at: MANUAL_AT });

    expect((await admin(env, '/sponsor-mappings/u-2', 'DELETE'))!.status).toBe(204);
    expect(await (await publicList(env))!.json()).toEqual([{
      uuid: UUID, name: 'Player', totalAmount: '20.10', orders: [firstOrder, manualOrder],
    }]);
    const account = await (await admin(env, '/sponsor-accounts/u-2'))!.json();
    expect(account.orders).toEqual([{ id: 'af:20261123000000001', source: 'afdian', ...secondOrder, at: 1795363200 }]);

    await admin(env, '/sponsor-mappings', 'PUT', { afdianUserId: 'u-2', uuid: OTHER_UUID });
    expect(await (await publicList(env))!.json()).toEqual([
      { uuid: OTHER_UUID, name: 'Second account', totalAmount: '0.20', orders: [secondOrder] },
      { uuid: UUID, name: 'Player', totalAmount: '20.10', orders: [firstOrder, manualOrder] },
    ]);
  } finally {
    restore();
  }
});

test('moving a manual order is retryable, preserves its ID and prevents duplicate ownership', async () => {
  const storage = new Map<string, unknown>();
  const env = sponsorEnv({}, storage);
  const body = { amount: '28.25', at: MANUAL_AT };
  const writes = await Promise.all([
    admin(env, manualPath(), 'PUT', body),
    admin(env, manualPath(), 'PUT', body),
  ]);
  expect(writes.map((response) => response!.status)).toEqual([204, 204]);
  const move = { uuid: OTHER_UUID };
  expect((await admin(env, manualPath(), 'PATCH', move))!.status).toBe(204);
  expect((await admin(env, manualPath(), 'PATCH', move))!.status).toBe(204);
  expect((await admin(env, manualPath(), 'PUT', body))!.status).toBe(409);
  const edit = { amount: { from: '28.25', to: '30' } };
  expect((await admin(env, manualPath(), 'PATCH', edit))!.status).toBe(409);
  const originalTag = await orderMatch(UUID, '28.25', MANUAL_AT);
  expect((await admin(env, manualPath(), 'DELETE', undefined, undefined, originalTag))!.status).toBe(404);
  expect([...storage]).toEqual([['manual-order:' + ORDER_ID, {
    uuid: OTHER_UUID, amountMinor: 2825, at: MANUAL_AT,
  }]]);
  expect(await (await publicList(env))!.json()).toEqual([{
    uuid: OTHER_UUID, name: OTHER_UUID, totalAmount: '28.25',
    orders: [{ amount: '28.25', at: MANUAL_AT_UTC }],
  }]);
  const detail = await (await admin(env, '/sponsor-catalog/' + OTHER_UUID))!.json();
  expect(detail.orders).toEqual([{ id: 'mn:' + ORDER_ID, amount: '28.25', at: MANUAL_AT, source: 'manual' }]);
  const movedTag = await orderMatch(OTHER_UUID, '28.25', MANUAL_AT);
  expect((await admin(env, manualPath(OTHER_UUID), 'DELETE', undefined, undefined, movedTag))!.status).toBe(204);
  expect(storage.size).toBe(0);
  expect((await admin(env, manualPath(OTHER_UUID), 'PATCH', edit))!.status).toBe(404);
  expect(await (await publicList(env))!.json()).toEqual([]);
});

test('manual order deletion requires the current amount, date, and message', async () => {
  const env = sponsorEnv();
  const path = manualPath();
  expect((await admin(env, path, 'PUT', { amount: '10', at: MANUAL_AT, message: '原留言' }))!.status).toBe(204);
  const originalTag = await orderMatch(UUID, '10.00', MANUAL_AT, '原留言');
  expect((await admin(env, path, 'DELETE'))!.status).toBe(428);
  expect((await admin(env, path, 'DELETE', undefined, undefined, '*'))!.status).toBe(400);
  expect((await admin(env, path, 'PATCH', { message: { from: '原留言', to: '新留言' } }))!.status).toBe(204);
  expect((await admin(env, path, 'DELETE', undefined, undefined, originalTag))!.status).toBe(412);
  const detail = await (await admin(env, '/sponsor-catalog/' + UUID))!.json();
  expect(detail.orders[0].message).toBe('新留言');
  const currentTag = await orderMatch(UUID, '10.00', MANUAL_AT, '新留言');
  expect((await admin(env, path, 'DELETE', undefined, undefined, currentTag))!.status).toBe(204);
});

test('manual orders require a payment time that can be updated', async () => {
  const storage = new Map<string, unknown>();
  const env = sponsorEnv({}, storage);
  const key = 'manual-order:' + ORDER_ID;
  const payment = { uuid: UUID, amountMinor: 500, at: MANUAL_AT };
  expect((await admin(env, manualPath(), 'PUT', { amount: '5' }))!.status).toBe(400);
  expect((await admin(env, manualPath(), 'PUT', { amount: '5', at: MANUAL_AT }))!.status).toBe(204);
  expect(storage.get(key)).toEqual(payment);
  expect((await admin(env, manualPath(), 'PUT', { amount: '5.00', at: MANUAL_AT }))!.status).toBe(204);

  const at = 1795309943;
  expect((await admin(env, manualPath(), 'PATCH', { at: { from: MANUAL_AT, to: at } }))!.status).toBe(204);
  expect(storage.get(key)).toEqual({ ...payment, at });

  expect((await admin(env, manualPath(), 'PATCH', { at: { from: at, to: 0 } }))!.status).toBe(400);
  expect(storage.get(key)).toEqual({ ...payment, at });
});

test('manual edits merge disjoint changes and reject conflicting changes without writing', async () => {
  const storage = new Map<string, unknown>();
  const env = sponsorEnv({}, storage);
  const key = 'manual-order:' + ORDER_ID;
  const at = 1795309943;
  expect((await admin(env, manualPath(), 'PUT', { amount: '10', at: MANUAL_AT }))!.status).toBe(204);

  const amount = { from: '10.00', to: '20.00' };
  const message = { from: '', to: '谢谢！\r\n下次见。' };
  const writes = await Promise.all([
    admin(env, manualPath(), 'PATCH', { amount }),
    admin(env, manualPath(), 'PATCH', { at: { from: MANUAL_AT, to: at } }),
    admin(env, manualPath(), 'PATCH', { message }),
  ]);
  expect(writes.map((response) => response!.status)).toEqual([204, 204, 204]);
  expect((await admin(env, manualPath(), 'PATCH', { amount }))!.status).toBe(204);
  expect((await admin(env, manualPath(), 'PATCH', { message }))!.status).toBe(204);
  expect((await admin(env, manualPath(), 'PATCH', {
    amount: { from: '10', to: '30' }, at: { from: at, to: MANUAL_AT },
  }))!.status).toBe(409);
  expect((await admin(env, manualPath(), 'PATCH', {
    message: { from: '', to: 'Concurrent change' }, at: { from: at, to: MANUAL_AT },
  }))!.status).toBe(409);
  expect((await admin(env, manualPath(), 'PATCH', { amount: { to: '25' } }))!.status).toBe(400);
  expect(storage.get(key)).toEqual({ uuid: UUID, amountMinor: 2000, at, message: '谢谢！\n下次见。' });
});

test('manual order messages appear in the public list and can be cleared', async () => {
  const storage = new Map<string, unknown>();
  const env = sponsorEnv({}, storage);
  const message = '春天快乐！\nTake care <3';
  const body = { amount: '5', at: MANUAL_AT, message: '  ' + message + '  ' };
  expect((await admin(env, manualPath(), 'PUT', body))!.status).toBe(204);
  expect((await admin(env, manualPath(), 'PUT', body))!.status).toBe(204);
  expect((await admin(env, manualPath(), 'PUT', { ...body, message: '不同的留言' }))!.status).toBe(409);
  const order = { amount: '5.00', at: MANUAL_AT_UTC };
  const adminOrder = { id: 'mn:' + ORDER_ID, source: 'manual', ...order, at: MANUAL_AT };
  const details = async () => (await (await admin(env, '/sponsor-catalog/' + UUID))!.json()).orders;
  expect(await details()).toEqual([{ ...adminOrder, message }]);
  expect(await (await publicList(env))!.json()).toEqual([{
    uuid: UUID, name: UUID, totalAmount: '5.00', orders: [{ ...order, message }],
  }]);
  const { players } = await (await admin(env, '/sponsor-catalog'))!.json();
  expect(players).toEqual([{ uuid: UUID, name: UUID, totalAmount: '5.00', manual: true, accounts: [] }]);

  const clear = { message: { from: message, to: ' ' } };
  expect((await admin(env, manualPath(), 'PATCH', clear))!.status).toBe(204);
  expect((await admin(env, manualPath(), 'PATCH', clear))!.status).toBe(204);
  expect(storage.get('manual-order:' + ORDER_ID)).toEqual({ uuid: UUID, amountMinor: 500, at: MANUAL_AT });
  expect(await details()).toEqual([adminOrder]);
  expect(await (await publicList(env))!.json()).toEqual([{
    uuid: UUID, name: UUID, totalAmount: '5.00', orders: [order],
  }]);
});

test('manual writes validate identity, money and dates and keep the same-origin boundary', async () => {
  const env = sponsorEnv();
  for (const [path, body] of [
    [manualPath('invalid'), { amount: '1', at: MANUAL_AT }],
    [manualPath(), { amount: '1.001', at: MANUAL_AT }],
    [manualPath(), { amount: '1', at: 0 }],
    [manualPath(), { amount: '1', at: -1 }],
    [manualPath(), { amount: '1', at: MANUAL_AT, message: 123 }],
    [manualPath(), { amount: '1', at: MANUAL_AT, message: '字'.repeat(MAX_MANUAL_MESSAGE_LENGTH + 1) }],
  ] as const) {
    const result = await admin(env, path, 'PUT', body);
    expect(result!.status).toBe(path.includes('invalid') ? 404 : 400);
  }
  expect((await admin(env, manualPath(), 'PUT', { amount: '1', at: MANUAL_AT }, 'https://elsewhere.example'))!.status).toBe(403);
  env.AUTH_SENSITIVE_RATE_LIMITER = {
    limit: async () => ({ success: false }),
  } as unknown as Env['AUTH_SENSITIVE_RATE_LIMITER'];
  expect((await admin(env, manualPath(), 'PUT', { amount: '1', at: MANUAL_AT }))!.status).toBe(429);
  expect((await admin(env, '/sponsor-catalog'))!.status).toBe(200);
});

test('an unavailable Afdian feed keeps manual data and flags any incomplete player', async () => {
  const restore = mockAfdian(() => { throw new Error('upstream down'); });
  try {
    const env = sponsorEnv(afdianEnv);
    await admin(env, manualPath(), 'PUT', { amount: '8', at: MANUAL_AT });
    const response = (await publicList(env))!;
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Sponsor-Data')).toBe('partial');
    expect(await response.json()).toMatchObject([{ uuid: UUID, totalAmount: '8.00', orders: [{ amount: '8.00' }] }]);

    await admin(env, '/sponsor-mappings', 'PUT', { afdianUserId: 'u-1', uuid: UUID });
    const zeroOrderPath = manualPath(OTHER_UUID, 'ab111111-2222-4333-8444-555566667777');
    expect((await admin(env, zeroOrderPath, 'PUT', { amount: '0', at: MANUAL_AT }))!.status).toBe(204);
    const [boundSponsor, manualSponsor] = await (await publicList(env))!.json();
    expect(boundSponsor).toMatchObject({ uuid: UUID, orders: [{ amount: '8.00' }] });
    expect(boundSponsor).not.toHaveProperty('totalAmount');
    expect(manualSponsor).toMatchObject({ uuid: OTHER_UUID, totalAmount: '0.00', orders: [{ amount: '0.00' }] });
    const catalog = await (await admin(env, '/sponsor-catalog'))!.json();
    expect(catalog.afdianStatus).toBe('unavailable');
    const bound = catalog.players.find((player: { uuid: string }) => player.uuid === UUID);
    expect(bound.accounts[0].afdianUserId).toBe('u-1');
    expect(bound).not.toHaveProperty('totalAmount');
  } finally {
    restore();
  }
});

test('truncated order history omits incomplete totals and includes purchasers absent from the roster', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let orderPages = 1;
  const restore = mockAfdian((endpoint, page) => endpoint === 'query-sponsor'
    ? { total_page: 1, list: [{ user: { user_id: 'u-2', name: 'Second account' } }] }
    : { total_page: orderPages, list: page === 1 ? [afdianOrder()] : [] });
  try {
    const env = sponsorEnv(afdianEnv);
    expect((await publicList(env))!.headers.get('X-Sponsor-Data')).toBe('complete');
    now += AFDIAN_FRESH_MS;
    orderPages = 51;
    const pending = await (await admin(env, '/sponsor-accounts/u-1'))!.json();
    expect(pending.orders).toHaveLength(1);
    expect(pending).not.toHaveProperty('totalAmount');
    expect(pending).not.toHaveProperty('ordersComplete');
    await admin(env, '/sponsor-mappings', 'PUT', { afdianUserId: 'u-1', uuid: UUID });
    await admin(env, '/sponsor-mappings', 'PUT', { afdianUserId: 'u-2', uuid: OTHER_UUID });
    const response = (await publicList(env))!;
    expect(response.headers.get('X-Sponsor-Data')).toBe('partial');
    const sponsors = await response.json();
    expect(sponsors).toHaveLength(1);
    const [sponsor] = sponsors;
    expect(sponsor).toMatchObject({ uuid: UUID, orders: [{ amount: '20.00' }] });
    expect(sponsor).not.toHaveProperty('totalAmount');
  } finally {
    restore();
    Date.now = originalNow;
  }
});

test('a temporary order scan failure keeps the complete snapshot until retry or expiration', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let unstable = false;
  let total = '20.00';
  let orderReads = 0;
  const restore = mockAfdian((endpoint, page) => {
    if (endpoint === 'query-sponsor') return { total_page: 0, list: [] };
    orderReads++;
    return { total_page: unstable ? page + 1 : 1, list: page === 1 ? [afdianOrder({ total_amount: total })] : [] };
  });
  try {
    const env = sponsorEnv(afdianEnv);
    await admin(env, '/sponsor-mappings', 'PUT', { afdianUserId: 'u-1', uuid: UUID });
    expect((await publicList(env))!.headers.get('X-Sponsor-Data')).toBe('complete');

    now += AFDIAN_FRESH_MS;
    unstable = true;
    total = '25.00';
    const fallback = (await publicList(env))!;
    expect(fallback.headers.get('X-Sponsor-Data')).toBe('stale');
    expect(await fallback.json()).toMatchObject([{ totalAmount: '20.00', orders: [{ amount: '20.00' }] }]);
    const catalog = await (await admin(env, '/sponsor-catalog'))!.json();
    expect(catalog.afdianStatus).toBe('stale');
    expect(orderReads).toBe(3);

    now += 5 * 60_000;
    unstable = false;
    const recovered = (await publicList(env))!;
    expect(recovered.headers.get('X-Sponsor-Data')).toBe('complete');
    expect(await recovered.json()).toMatchObject([{ totalAmount: '25.00', orders: [{ amount: '25.00' }] }]);

    now += 7 * 24 * 60 * 60_000;
    unstable = true;
    const expired = (await publicList(env))!;
    expect(expired.headers.get('X-Sponsor-Data')).toBe('partial');
    const [sponsor] = await expired.json();
    expect(sponsor).toMatchObject({ orders: [{ amount: '25.00' }] });
    expect(sponsor).not.toHaveProperty('totalAmount');
  } finally {
    restore();
    Date.now = originalNow;
  }
});

test('a failed name lookup still exposes paid orders with a confirmed total', async () => {
  const restore = mockAfdian((endpoint) => {
    if (endpoint === 'query-sponsor') throw new Error('names unavailable');
    return { total_page: 1, list: [afdianOrder()] };
  });
  try {
    const env = sponsorEnv(afdianEnv);
    const detail = await (await admin(env, '/sponsor-accounts/u-1'))!.json();
    expect(detail.orders).toHaveLength(1);
    await admin(env, '/sponsor-mappings', 'PUT', { afdianUserId: 'u-1', uuid: UUID });
    const response = (await publicList(env))!;
    expect(response.headers.get('X-Sponsor-Data')).toBe('complete');
    expect(await response.json()).toMatchObject([{ name: UUID, totalAmount: '20.00', orders: [{ amount: '20.00' }] }]);
  } finally {
    restore();
  }
});

test('the public sponsor cache expires after 30 seconds and still checks the public rate limit', async () => {
  const originalCache = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  let now = 0;
  const entries = new Map<string, { response: Response; expiresAt: number }>();
  entries.set('https://data.mcmik.top/.mikdata-cache/sponsors', {
    response: Response.json([{ uuid: UUID, name: UUID, totalAmount: '10.00' }]),
    expiresAt: 30_000,
  });
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        async match(key: Request) {
          const entry = entries.get(key.url);
          return entry && entry.expiresAt > now ? entry.response.clone() : undefined;
        },
        async put(key: Request, response: Response) {
          expect(response.headers.get('Cache-Control')).toBe('public, max-age=30');
          entries.set(key.url, { response, expiresAt: now + 30_000 });
        },
      },
    },
  });

  let allowed = true;
  const env = sponsorEnv({ PUBLIC_API_RATE_LIMITER: { limit: async () => ({ success: allowed }) } });
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext;
  const read = (query = '') => worker.fetch(new Request('https://data.mcmik.top/api/sponsors' + query), env, ctx);

  try {
    await admin(env, manualPath(), 'PUT', { amount: '10', at: MANUAL_AT, message: 'Thanks' });
    const order = { amount: '10.00', at: MANUAL_AT_UTC, message: 'Thanks' };
    expect(await (await read()).json()).toEqual([{ uuid: UUID, name: UUID, totalAmount: '10.00', orders: [order] }]);
    await Promise.all(tasks);

    expect((await admin(env, manualPath(), 'PATCH', { amount: { from: '10', to: '12' } }))!.status).toBe(204);

    now = 29_999;
    const cached = await read('?ignored=1');
    expect(cached.headers.get('Cache-Control')).toBe('public, no-cache');
    expect(cached.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(cached.headers.get('X-Sponsor-Data')).toBe('complete');
    expect(await cached.json()).toMatchObject([{ totalAmount: '10.00', orders: [{ amount: '10.00' }] }]);

    allowed = false;
    expect((await read()).status).toBe(429);
    allowed = true;
    now = 30_000;
    expect(await (await read()).json()).toMatchObject([{ totalAmount: '12.00', orders: [{ amount: '12.00' }] }]);
    await Promise.all(tasks);
  } finally {
    if (originalCache) Object.defineProperty(globalThis, 'caches', originalCache);
    else Reflect.deleteProperty(globalThis, 'caches');
  }
});
