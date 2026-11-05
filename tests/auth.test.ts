import { expect, test } from 'bun:test';
import worker from '../src/index';
import {
  authCall,
  PLAYER_UUID,
  seedSession,
  testAuthEnv,
  testAuthStore,
} from './helpers/auth-store';

test('minecraft challenge completion rejects unknown plugin roles', async () => {
  const { store } = testAuthStore({
    VPC_SERVICE: {
      fetch: () =>
        Promise.resolve(
          Response.json({
            status: 'confirmed',
            player: {
              uuid: '00000000-0000-0000-0000-000000000001',
              name: 'GuestPlayer',
              role: '',
            },
          }),
        ),
    } as Fetcher,
  });

  const created = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });

  expect(created.status).toBe(200);

  const completed = await authCall(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });

  expect(completed.status).toBe(502);
  expect(completed.body).toEqual({ error: 'plugin_invalid_response' });
});

test('newcomer game confirmation opens a website account without promoting its role', async () => {
  const { store } = testAuthStore({
    VPC_SERVICE: {
      fetch: () =>
        Promise.resolve(
          Response.json({
            status: 'confirmed',
            confirmedAt: new Date().toISOString(),
            player: {
              uuid: '00000000-0000-0000-0000-000000000002',
              name: 'NewPlayer',
              role: 'default',
            },
          }),
        ),
    } as Fetcher,
  });
  const created = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  const completed = await authCall(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });
  expect(completed.status).toBe(200);
  expect(completed.body.account).toMatchObject({ currentName: 'NewPlayer', role: 'default' });
  expect(completed.body.sessionId).toEqual(expect.any(String));
});

test('minecraft challenge completion reports unavailable plugin without creating a session', async () => {
  const { store } = testAuthStore({
    VPC_SERVICE: {
      fetch: () => Promise.reject(new Error('plugin unavailable')),
    } as Fetcher,
  });

  const created = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });

  const completed = await authCall(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });

  expect(completed.status).toBe(503);
  expect(completed.body).toEqual({ error: 'plugin_unavailable' });
});

test('minecraft challenge completion rejects malformed confirmed plugin players', async () => {
  const { store } = testAuthStore({
    VPC_SERVICE: {
      fetch: () =>
        Promise.resolve(
          Response.json({
            status: 'confirmed',
            player: {
              uuid: 'not-a-uuid',
              name: 'MemberPlayer',
              role: 'member',
            },
          }),
        ),
    } as Fetcher,
  });

  const created = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  const completed = await authCall(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });

  expect(completed.status).toBe(502);
  expect(completed.body).toEqual({ error: 'plugin_invalid_response' });
});

test('minecraft challenge creation is rate limited per client key', async () => {
  const { store } = testAuthStore();

  for (let index = 0; index < 8; index += 1) {
    const response = await authCall(store, {
      action: 'createMinecraftChallenge',
      purpose: 'login',
      clientKey: 'ip:203.0.113.10',
    });
    expect(response.status).toBe(200);
  }

  const limited = await authCall(store, {
    action: 'createMinecraftChallenge',
    purpose: 'login',
    clientKey: 'ip:203.0.113.10',
  });

  expect(limited.status).toBe(429);
  expect(limited.body.error).toBe('rate_limited');
});

test('minecraft challenge status polling is rate limited per client key', async () => {
  const { store } = testAuthStore({
    VPC_SERVICE: {
      fetch: () => Promise.resolve(Response.json({ status: 'pending' })),
    } as Fetcher,
  });
  const created = await authCall(store, {
    action: 'createMinecraftChallenge',
    purpose: 'login',
    clientKey: 'ip:203.0.113.11',
  });

  for (let index = 0; index < 60; index += 1) {
    const response = await authCall(store, {
      action: 'getMinecraftChallenge',
      challengeId: created.body.challengeId,
      browserNonce: created.body.browserNonce,
      clientKey: 'ip:203.0.113.11',
    });
    expect(response.status).toBe(200);
  }

  const limited = await authCall(store, {
    action: 'getMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
    clientKey: 'ip:203.0.113.11',
  });

  expect(limited.status).toBe(429);
  expect(limited.body.error).toBe('rate_limited');
});

test('worker rate limits auth requests before invoking the durable object', async () => {
  const createKeys: string[] = [];
  const clientKeys: string[] = [];
  const response = await worker.fetch(
    new Request('https://data.mcmik.top/auth/challenges', {
      method: 'POST',
      headers: {
        'X-Mik-Client-Key': 'ip:203.0.113.12',
        'X-Mikweb-Auth': 'test-secret',
      },
    }),
    testAuthEnv({
      AUTH_CHALLENGE_CREATE_RATE_LIMITER: createRateLimit(true, createKeys),
      AUTH_CLIENT_RATE_LIMITER: createRateLimit(false, clientKeys),
      AUTH_STORE: {
        idFromName: () => {
          throw new Error('auth store should not be called');
        },
      } as unknown as DurableObjectNamespace,
    }),
    createExecutionContext(),
  );

  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  expect(await response.json()).toEqual({ error: 'rate_limited', retryAfterSeconds: 60 });
  expect(createKeys).toEqual(['ip:203.0.113.12']);
  expect(clientKeys).toEqual(['ip:203.0.113.12']);
});

test('worker fails closed when an auth rate limiter is unavailable', async () => {
  const response = await worker.fetch(
    new Request('https://data.mcmik.top/auth/challenges', {
      method: 'POST',
      headers: {
        'X-Mik-Client-Key': 'ip:203.0.113.13',
        'X-Mikweb-Auth': 'test-secret',
      },
    }),
    testAuthEnv({
      AUTH_CHALLENGE_CREATE_RATE_LIMITER: {
        limit: () => Promise.reject(new Error('rate limiter unavailable')),
      } as RateLimit,
      AUTH_STORE: {
        idFromName: () => {
          throw new Error('auth store should not be called');
        },
      } as unknown as DurableObjectNamespace,
    }),
    createExecutionContext(),
  );

  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBe('10');
  expect(await response.json()).toEqual({ error: 'rate_limiter_unavailable' });
});

test('auth preflight does not return wildcard cors headers', async () => {
  const response = await worker.fetch(
    new Request('https://data.mcmik.top/auth/me', { method: 'OPTIONS' }),
    testAuthEnv(),
    createExecutionContext(),
  );

  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
});

test('auth routes reject oversized JSON bodies before hitting auth store', async () => {
  const response = await worker.fetch(
    new Request('https://data.mcmik.top/auth/me', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mikweb-Auth': 'test-secret',
      },
      body: JSON.stringify({ value: 'x'.repeat(65 * 1024) }),
    }),
    testAuthEnv({
      AUTH_STORE: {
        idFromName: () => ({}),
        get: () => ({
          fetch: () => {
            throw new Error('auth store should not be called');
          },
        }),
      } as unknown as DurableObjectNamespace,
    }),
    createExecutionContext(),
  );

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: 'request_body_too_large' });
});

test('player resolution normalizes names and reuses the cached result', async () => {
  let resolveRequests = 0;
  const policy = testAuthEnv().VPC_SERVICE;
  const { store, values } = testAuthStore({
    VPC_SERVICE: {
      fetch: async (input: RequestInfo | URL) => {
        if (new URL(input.toString()).pathname !== '/api/players/resolve')
          return policy.fetch(input);
        resolveRequests++;
        return Response.json({
          player: { uuid: '00000000-0000-4000-8000-000000000011', name: 'BuilderOne' },
        });
      },
    } as Fetcher,
  });
  const { token } = await seedSession(values);
  for (const name of ['BuilderOne', 'builderone']) {
    const response = await authCall(store, { action: 'resolvePlayer', sessionId: token, name });
    expect(response.status).toBe(200);
    expect(response.body.player).toMatchObject({ name: 'BuilderOne' });
  }
  expect(resolveRequests).toBe(1);
});

test('account security lists own sessions and revokes one without signing out the current browser', async () => {
  const { store, values } = testAuthStore();
  const first = await seedSession(values),
    second = await seedSession(values);
  const security = await authCall(store, { action: 'accountSecurity', sessionId: first.token });
  expect(security.status).toBe(200);
  expect(security.body.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: first.record.sidHash, current: true }),
      expect.objectContaining({ id: second.record.sidHash, current: false }),
    ]),
  );
  expect(security.body.sessions).toHaveLength(2);
  const revoked = await authCall(store, {
    action: 'revokeAccountSession',
    sessionId: first.token,
    targetSessionId: second.record.sidHash,
  });
  expect(revoked).toMatchObject({ status: 200, body: { clearSession: false } });
  expect(
    (await authCall(store, { action: 'accountSecurity', sessionId: second.token })).status,
  ).toBe(401);
  expect(values.has(`account-session:${PLAYER_UUID}:${second.record.sidHash}`)).toBe(false);
});

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
