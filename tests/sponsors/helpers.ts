import { testDatabase } from '../helpers/d1';
import type { Env } from '../../src/env';
import { testAuthEnv } from '../helpers/auth';

export const UUID = '069a79f4-44e9-4726-a5be-fca4e82d3858';
export const OTHER_UUID = '11111111-2222-4333-8444-555566667777';
export const ORDER_ID = 'aa111111-2222-4333-8444-555566667777';
export const AFDIAN_ORDER_ID = '202611220912231234567';

export function sponsorEnv(overrides: Partial<Env> = {}, database = testDatabase()): Env {
  return testAuthEnv({ DB: database.db, ...overrides });
}

export function sponsorFixture() {
  const database = testDatabase();
  const env = sponsorEnv({}, database);
  const orders = () => new Map(database.sqlite.query('SELECT * FROM sponsor_orders').all().map(row =>
    [row.id, { uuid: row.player_uuid, amountMinor: row.amount_minor, at: row.paid_at, ...(row.message ? { message: row.message } : {}) }]));
  return { env, orders };
}

export function mockAfdian(
  read: (endpoint: 'query-sponsor' | 'query-order', page: number) => {
    list: unknown[];
    total_page: number;
  },
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const endpoint = new URL(String(input)).pathname.split('/').pop();
    if (endpoint !== 'query-sponsor' && endpoint !== 'query-order') throw new Error('unexpected request');
    const { page } = JSON.parse(JSON.parse(String(init?.body)).params);
    return Response.json({ ec: 200, data: read(endpoint, page) });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

export function afdianOrder(overrides: Record<string, unknown> = {}) {
  return {
    out_trade_no: AFDIAN_ORDER_ID, user_id: 'u-1', total_amount: '20.00',
    show_amount: '25.00', status: 2, ...overrides,
  };
}
