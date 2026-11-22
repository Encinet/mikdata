import { expect, test } from 'bun:test';
import { afdianOrderTime, fetchAfdianOrders, fetchAfdianSponsors } from '../../src/sponsors/afdian';
import { AFDIAN_FRESH_MS, AfdianCache } from '../../src/sponsors/cache';
import { afdianSign, md5Hex } from '../../src/sponsors/md5';
import { afdianOrder, mockAfdian, sponsorEnv } from './helpers';

const credentials = { AFDIAN_USER_ID: 'creator', AFDIAN_API_TOKEN: 'token' };

test('Afdian signatures match the reference vector and dates use Unix seconds', () => {
  expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  expect(afdianSign('123', 'abc', '{"a":333}', 1624339905)).toBe('a4acc28b81598b7e5d84ebdc3e91710c');
  expect(afdianOrderTime('202106232138371083454010626')).toBe(1624455517);
  expect(afdianOrderTime('202602300930591234567890123')).toBe(0);
});

test('Afdian adapters deduplicate by source IDs and flag malformed paid orders', async () => {
  const pages: number[] = [];
  const restore = mockAfdian((endpoint, page) => {
    if (endpoint === 'query-sponsor') {
      pages.push(page);
      return { total_page: 2, list: [{ user: { user_id: 'u-1', name: 'First' } }] };
    }
    return { total_page: 2, list: [
      afdianOrder(),
      afdianOrder({ status: 3, out_trade_no: 'refunded' }),
      afdianOrder({ out_trade_no: 'broken', total_amount: 'NaN' }),
    ] };
  });
  try {
    const env = sponsorEnv(credentials);
    expect(await fetchAfdianSponsors(env)).toEqual([{ userId: 'u-1', name: 'First' }]);
    expect(pages).toEqual([1, 2]);
    const { orders, status } = await fetchAfdianOrders(env);
    expect(status).toBe('incomplete');
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ amountMinor: 2000, userId: 'u-1' });
  } finally {
    restore();
  }
});

test('an order scan with a changing page count cannot confirm totals', async () => {
  const restore = mockAfdian((_endpoint, page) => ({ total_page: page === 1 ? 2 : 3, list: [afdianOrder()] }));
  try {
    const { orders, status } = await fetchAfdianOrders(sponsorEnv(credentials));
    expect(status).toBe('incomplete');
    expect(orders).toHaveLength(1);
  } finally {
    restore();
  }
});

test('cache shares one refresh and gives up on an expired fallback', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let calls = 0;
  let unavailable = false;
  const restore = mockAfdian(() => {
    calls++;
    if (unavailable) throw new Error('upstream down');
    return { total_page: 0, list: [] };
  });
  try {
    const cache = new AfdianCache(sponsorEnv(credentials));
    const initial = await cache.get();
    expect(initial?.ordersComplete).toBe(true);
    now += AFDIAN_FRESH_MS + 1;
    unavailable = true;
    const concurrent = await Promise.all([cache.get(), cache.get()]);
    expect(concurrent).toEqual([initial, initial]);
    expect(await cache.get()).toBe(initial);
    expect(calls).toBe(4);
    now += 7 * 24 * 60 * 60_000;
    expect(await cache.get()).toBeUndefined();
  } finally {
    restore();
    Date.now = originalNow;
  }
});
