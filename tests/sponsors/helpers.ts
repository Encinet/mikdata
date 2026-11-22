import { SponsorStore } from '../../src/sponsors/store';
import type { Env } from '../../src/env';
import { testAuthEnv } from '../helpers/auth-store';

export const UUID = '069a79f4-44e9-4726-a5be-fca4e82d3858';
export const OTHER_UUID = '11111111-2222-4333-8444-555566667777';
export const ORDER_ID = 'aa111111-2222-4333-8444-555566667777';
export const AFDIAN_ORDER_ID = '202611220912231234567';

export function sponsorEnv(overrides: Partial<Env> = {}, storage = new Map<string, unknown>()): Env {
  const kv = {
    get: (key: string) => storage.get(key),
    list: ({ prefix }: { prefix: string }) =>
      new Map([...storage].filter(([key]) => key.startsWith(prefix))),
    put: (key: string, value: unknown) => { storage.set(key, structuredClone(value)); },
    delete: (key: string) => storage.delete(key),
  };
  const env = testAuthEnv(overrides);
  const store = new SponsorStore({
    storage: { kv },
  } as unknown as DurableObjectState, env);
  env.SPONSOR_STORE = {
    getByName: () => ({ fetch: (request: Request) => store.fetch(request) }),
  } as unknown as DurableObjectNamespace;
  return env;
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
