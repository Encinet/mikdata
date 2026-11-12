import { expect, test } from 'bun:test';
import type { Env } from '../src/env';
import { testAuthEnv } from './helpers/auth-store';
import worker from '../src/index';
import { matchProxyRoute, serveProxyRoute } from '../src/proxy';

test('public proxy routes survive unavailable KV', async () => {
  const env = createEnvWithUnavailableKv();
  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  for (const pathname of ['/players', '/bans', '/announcements']) {
    const route = matchProxyRoute(pathname);

    expect(route).not.toBeNull();

    const response = await serveProxyRoute(
      route!,
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Proxy-Source')).toBe('UPSTREAM');
  }
});

test('public API rate limiting rejects before upstream work', async () => {
  const keys: string[] = [];
  const env = createEnvWithUnavailableKv();
  env.PUBLIC_API_RATE_LIMITER = createRateLimit(false, keys);
  env.VPC_SERVICE = {
    fetch: () => {
      throw new Error('upstream should not be called');
    },
  } as unknown as Fetcher;

  const response = await worker.fetch(
    new Request('https://data.mcmik.top/api/players', {
      headers: { 'CF-Connecting-IP': '203.0.113.20' },
    }),
    env,
    createExecutionContext(),
  );

  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(await response.json()).toEqual({ error: 'rate_limited', retryAfterSeconds: 60 });
  expect(keys).toEqual(['ip:203.0.113.20']);
});

test('health checks bypass public API rate limiting', async () => {
  const env = createEnvWithUnavailableKv();
  env.PUBLIC_API_RATE_LIMITER = {
    limit: () => Promise.reject(new Error('rate limiter should not be called')),
  } as RateLimit;

  const response = await worker.fetch(
    new Request('https://data.mcmik.top/health'),
    env,
    createExecutionContext(),
  );

  expect(response.status).toBe(200);
});

function createEnvWithUnavailableKv(): Env {
  return testAuthEnv({
    BUILDINGS_KV: {
      get: () => {
        throw new Error('KV unavailable');
      },
    } as unknown as KVNamespace,
    VPC_SERVICE: {
      fetch: async (input: RequestInfo | URL) =>
        Response.json(responseBodyForPath(new URL(input.toString()).pathname)),
    } as Fetcher,
  });
}

function createRateLimit(success = true, keys?: string[]): RateLimit {
  return {
    limit: ({ key }) => {
      keys?.push(key);
      return Promise.resolve({ success });
    },
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

function responseBodyForPath(pathname: string): unknown {
  if (pathname === '/api/players') {
    return { online: 1, peak_online: 8, players: [] };
  }

  if (pathname === '/api/bans') {
    return [];
  }

  if (pathname === '/api/announcements') {
    return [];
  }

  return { error: 'unexpected path' };
}
