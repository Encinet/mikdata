import { afterEach, expect, spyOn, test } from 'bun:test';
import { matchProxyRoute, serveProxyRoute } from '../src/proxy';
import { testAuthEnv } from './helpers/auth-store';

const originalFetch = globalThis.fetch;
const originalCache = Object.getOwnPropertyDescriptor(globalThis, 'caches');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCache) Object.defineProperty(globalThis, 'caches', originalCache);
  else delete (globalThis as any).caches;
});
function fixture(path = '/players') {
  let calls = 0,
    fail = true;
  const background: Promise<unknown>[] = [];
  const env = testAuthEnv({
    VPC_SERVICE: {
      fetch: async () => {
        calls++;
        if (fail) throw new Error('Test upstream unavailable');
        return Response.json({ online: 7, players: [] });
      },
    } as any,
  });
  const route = matchProxyRoute(path)!;
  const read = () =>
    serveProxyRoute(route, new Request(`https://data.example/api${path}`), env, {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    } as any);
  return {
    read,
    calls: () => calls,
    recover: () => {
      fail = false;
    },
    outage: () => {
      fail = true;
    },
    drain: () => Promise.all(background.splice(0)),
  };
}

test('concurrent and sequential outage requests share one upstream and fallback flight', async () => {
  const f = fixture();
  let fallbacks = 0,
    release!: () => void;
  let started!: () => void;
  const fallbackStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async () => {
    fallbacks++;
    started();
    await ready;
    return Response.json({ online: true, players: { online: 2 } });
  }) as typeof fetch;
  const requests = Array.from({ length: 3 }, () => f.read());
  await fallbackStarted;
  expect(fallbacks).toBe(1);
  release();
  const responses = await Promise.all(requests);
  expect(f.calls()).toBe(1);
  expect(
    responses.every(
      (response) =>
        response.status === 200 && response.headers.get('X-Proxy-Source') === 'FALLBACK',
    ),
  ).toBe(true);
  for (let i = 0; i < 2; i++) {
    const response = await f.read();
    expect(await response.json()).toEqual({ online: 2, peak_online: -1, players: [] });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(f.calls()).toBe(1);
  expect(fallbacks).toBe(1);
});

test('failed routes back off and recover after the cooldown', async () => {
  const f = fixture('/bans'),
    realNow = Date.now;
  let now = realNow();
  const date = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    expect((await f.read()).status).toBe(502);
    for (let i = 0; i < 2; i++) expect((await f.read()).status).toBe(502);
    expect(f.calls()).toBe(1);
    now += 1001;
    expect((await f.read()).status).toBe(502);
    expect(f.calls()).toBe(2);
    f.recover();
    now += 1001;
    expect((await f.read()).status).toBe(502);
    expect(f.calls()).toBe(2);
    now += 1001;
    const response = await f.read();
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Proxy-Source')).toBe('UPSTREAM');
    expect(f.calls()).toBe(3);
  } finally {
    date.mockRestore();
  }
});

test('stale upstream data is retained while failed background refreshes cool down', async () => {
  const f = fixture(),
    realNow = Date.now;
  let now = realNow();
  const date = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    f.recover();
    await f.read();
    f.outage();
    now += 5001;
    const stale = await f.read();
    await f.drain();
    expect(stale.headers.get('X-Proxy-Cache')).toBe('STALE');
    expect(await stale.json()).toEqual({ online: 7, players: [] });
    for (let i = 0; i < 2; i++) await f.read();
    await f.drain();
    expect(f.calls()).toBe(2);
    f.recover();
    now += 1001;
    await f.read();
    await f.drain();
    expect(f.calls()).toBe(3);
    expect((await f.read()).headers.get('X-Proxy-Cache')).toBe('HIT');
  } finally {
    date.mockRestore();
  }
});

test('fallback stays available during longer upstream cooldowns and preserves its source', async () => {
  const f = fixture(),
    realNow = Date.now;
  let now = realNow(),
    fallbacks = 0;
  const date = spyOn(Date, 'now').mockImplementation(() => now);
  globalThis.fetch = (async () => {
    fallbacks++;
    return Response.json({ online: true, players: { online: 3 } });
  }) as typeof fetch;
  try {
    for (let i = 0; i < 5; i++) {
      const response = await f.read();
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Proxy-Source')).toBe('FALLBACK');
      now += 5001;
    }
    expect(f.calls()).toBe(4);
    expect(fallbacks).toBe(5);
    f.recover();
    now += 30_000;
    expect((await f.read()).headers.get('X-Proxy-Source')).toBe('UPSTREAM');
  } finally {
    date.mockRestore();
  }
});

test('slow failures receive a cooldown after fallback completes', async () => {
  const f = fixture(),
    realNow = Date.now;
  let now = realNow(),
    fallbacks = 0;
  const date = spyOn(Date, 'now').mockImplementation(() => now);
  globalThis.fetch = (async () => {
    fallbacks++;
    now += 5000;
    throw new Error('Slow fallback failure');
  }) as typeof fetch;
  try {
    expect((await f.read()).status).toBe(502);
    expect((await f.read()).status).toBe(502);
    expect(f.calls()).toBe(1);
    expect(fallbacks).toBe(1);
    now += 1001;
    expect((await f.read()).status).toBe(502);
    expect(f.calls()).toBe(2);
  } finally {
    date.mockRestore();
  }
});

test('fallback edge cache records remain fallback records after a cold isolate read', async () => {
  let stored: Response | undefined;
  (globalThis as any).caches = {
    default: {
      match: async () => stored?.clone(),
      put: async (_: Request, response: Response) => {
        stored = response.clone();
      },
    },
  };
  globalThis.fetch = (async () =>
    Response.json({ online: true, players: { online: 4 } })) as typeof fetch;
  const first = fixture();
  await first.read();
  const cold = fixture();
  const response = await cold.read();
  expect(cold.calls()).toBe(0);
  expect(response.headers.get('X-Proxy-Source')).toBe('FALLBACK');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
