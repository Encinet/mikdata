import { expect, test } from 'bun:test';
import worker, { AuthStore } from '../src/index';
import type { Env } from '../src/env';
import { memoryAuthStorage } from './helpers/auth-store';

test('minecraft challenge completion rejects non-member plugin confirmations', async () => {
  const store = createAuthStore({
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

  const created = await callStore(store, { action: 'createMinecraftChallenge', purpose: 'login' });

  expect(created.status).toBe(200);

  const completed = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });

  expect(completed.status).toBe(403);
  expect(completed.body).toEqual({ error: 'member_required' });
});

test('newcomer game access does not open a website account', async () => {
  const store = createAuthStore({
    VPC_SERVICE: {
      fetch: () =>
        Promise.resolve(
          Response.json({
            status: 'confirmed',
            player: {
              uuid: '00000000-0000-0000-0000-000000000002',
              name: 'NewPlayer',
              role: 'default',
            },
          }),
        ),
    } as Fetcher,
  });
  const created = await callStore(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  const completed = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });
  expect(completed.status).toBe(403);
  expect(completed.body).toEqual({ error: 'member_required' });
});

test('passkey registration options require an authenticated session', async () => {
  const store = createAuthStore();

  const response = await callStore(store, {
    action: 'passkeyRegistrationOptions',
    sessionId: '',
  });

  expect(response.status).toBe(401);
  expect(response.body).toEqual({ error: 'unauthenticated' });
});

test('minecraft challenge completion reports unavailable plugin without creating a session', async () => {
  const store = createAuthStore({
    VPC_SERVICE: {
      fetch: () => Promise.reject(new Error('plugin unavailable')),
    } as Fetcher,
  });

  const created = await callStore(store, { action: 'createMinecraftChallenge', purpose: 'login' });

  const completed = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });

  expect(completed.status).toBe(503);
  expect(completed.body).toEqual({ error: 'plugin_unavailable' });
});

test('minecraft challenge completion rejects malformed confirmed plugin players', async () => {
  const store = createAuthStore({
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

  const created = await callStore(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  const completed = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });

  expect(completed.status).toBe(502);
  expect(completed.body).toEqual({ error: 'plugin_invalid_response' });
});

test('passkey registration options require resident credentials', async () => {
  const store = createAuthStore({
    VPC_SERVICE: {
      fetch: () =>
        Promise.resolve(
          Response.json({
            status: 'confirmed',
            player: {
              uuid: '00000000-0000-0000-0000-000000000002',
              name: 'MemberPlayer',
              role: 'member',
            },
          }),
        ),
    } as Fetcher,
  });

  const created = await callStore(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  const completed = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });

  const options = await callStore(store, {
    action: 'passkeyRegistrationOptions',
    sessionId: completed.body.sessionId,
  });

  expect(options.status).toBe(200);
  expect(options.body.options.authenticatorSelection.residentKey).toBe('required');
  expect(options.body.options.authenticatorSelection.userVerification).toBe('required');
});

test('minecraft challenge creation is rate limited per client key', async () => {
  const store = createAuthStore();

  for (let index = 0; index < 8; index += 1) {
    const response = await callStore(store, {
      action: 'createMinecraftChallenge',
      purpose: 'login',
      clientKey: 'ip:203.0.113.10',
    });
    expect(response.status).toBe(200);
  }

  const limited = await callStore(store, {
    action: 'createMinecraftChallenge',
    purpose: 'login',
    clientKey: 'ip:203.0.113.10',
  });

  expect(limited.status).toBe(429);
  expect(limited.body.error).toBe('rate_limited');
});

test('minecraft challenge status polling is rate limited per client key', async () => {
  const store = createAuthStore({
    VPC_SERVICE: {
      fetch: () => Promise.resolve(Response.json({ status: 'pending' })),
    } as Fetcher,
  });
  const created = await callStore(store, {
    action: 'createMinecraftChallenge',
    purpose: 'login',
    clientKey: 'ip:203.0.113.11',
  });

  for (let index = 0; index < 60; index += 1) {
    const response = await callStore(store, {
      action: 'getMinecraftChallenge',
      challengeId: created.body.challengeId,
      browserNonce: created.body.browserNonce,
      clientKey: 'ip:203.0.113.11',
    });
    expect(response.status).toBe(200);
  }

  const limited = await callStore(store, {
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
    createEnv({
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
    createEnv({
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
    createEnv(),
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
    createEnv({
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

test('player resolve reuses durable object memory cache', async () => {
  let resolveRequests = 0;
  const store = createAuthStore({
    VPC_SERVICE: {
      fetch: (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        if (url.pathname.startsWith('/api/auth/challenges/')) {
          return Promise.resolve(
            Response.json({
              status: 'confirmed',
              player: {
                uuid: '00000000-0000-0000-0000-000000000010',
                name: 'MemberPlayer',
                role: 'member',
              },
            }),
          );
        }
        if (url.pathname === '/api/players/resolve') {
          resolveRequests += 1;
          return Promise.resolve(
            Response.json({
              player: {
                uuid: '00000000-0000-4000-8000-000000000011',
                name: 'BuilderOne',
              },
            }),
          );
        }
        return Promise.resolve(Response.json({ status: 'pending' }));
      },
    } as Fetcher,
  });

  const created = await callStore(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  const completed = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });

  const first = await callStore(store, {
    action: 'resolvePlayer',
    sessionId: completed.body.sessionId,
    name: 'BuilderOne',
  });
  const second = await callStore(store, {
    action: 'resolvePlayer',
    sessionId: completed.body.sessionId,
    name: 'builderone',
  });

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(resolveRequests).toBe(1);
});

test('account security lists and revokes browser sessions', async () => {
  const store = createAuthStore({
    VPC_SERVICE: {
      fetch: () =>
        Promise.resolve(
          Response.json({
            status: 'confirmed',
            player: {
              uuid: '00000000-0000-0000-0000-000000000004',
              name: 'SessionPlayer',
              role: 'member',
            },
          }),
        ),
    } as Fetcher,
  });

  const firstChallenge = await callStore(store, {
    action: 'createMinecraftChallenge',
    purpose: 'login',
  });
  const firstLogin = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: firstChallenge.body.challengeId,
    browserNonce: firstChallenge.body.browserNonce,
  });
  const secondChallenge = await callStore(store, {
    action: 'createMinecraftChallenge',
    purpose: 'login',
  });
  const secondLogin = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: secondChallenge.body.challengeId,
    browserNonce: secondChallenge.body.browserNonce,
  });

  const security = await callStore(store, {
    action: 'accountSecurity',
    sessionId: firstLogin.body.sessionId,
  });

  expect(security.status).toBe(200);
  expect(security.body.sessions).toHaveLength(2);
  const secondSession = security.body.sessions?.find((session) => !session.current);
  expect(typeof secondSession?.id).toBe('string');

  const revoked = await callStore(store, {
    action: 'revokeAccountSession',
    sessionId: firstLogin.body.sessionId,
    targetSessionId: secondSession?.id,
  });

  expect(revoked.status).toBe(200);
  expect(revoked.body.clearSession).toBe(false);

  const revokedSecurity = await callStore(store, {
    action: 'accountSecurity',
    sessionId: secondLogin.body.sessionId,
  });
  expect(revokedSecurity.status).toBe(401);
});

function createAuthStore(overrides: Partial<Env> = {}): AuthStore {
  const state = {
    storage: createStorage(),
    waitUntil: (promise: Promise<unknown>) => {
      void promise;
    },
  } as unknown as DurableObjectState;

  const env = createEnv(overrides);
  const original = env.VPC_SERVICE;
  env.VPC_SERVICE = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname.startsWith('/api/auth/accounts/'))
        return Response.json({
          player: { uuid: url.pathname.split('/').at(-1), role: 'member', credentialsChangedAt: 0 },
        });
      const response = await original.fetch(input, init);
      const payload = (await response.json()) as Record<string, unknown>;
      return Response.json(
        payload.status === 'confirmed'
          ? { ...payload, confirmedAt: new Date().toISOString() }
          : payload,
      );
    },
  } as Fetcher;
  return new AuthStore(state, env);
}

async function callStore(
  store: AuthStore,
  body: Record<string, unknown>,
): Promise<{ status: number; body: StoreTestBody }> {
  const response = await store.fetch(
    new Request('https://auth-store.local/', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

  return (await response.json()) as { status: number; body: StoreTestBody };
}

type StoreTestBody = Record<string, unknown> & {
  browserNonce?: string;
  challengeId?: string;
  error?: unknown;
  options?: {
    authenticatorSelection?: {
      residentKey?: unknown;
      userVerification?: unknown;
    };
  };
  sessionId?: string;
  sessions?: {
    id: string;
    current: boolean;
  }[];
};

function createStorage(): DurableObjectStorage {
  return memoryAuthStorage().storage;
}

function createMemoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    put: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
    list: ({ prefix }: KVNamespaceListOptions = {}) => {
      const keys = [...values.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort()
        .map((name) => ({ name }));
      return Promise.resolve({ keys, list_complete: true, cacheStatus: null });
    },
  } as unknown as KVNamespace;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    BUILDINGS_KV: {} as KVNamespace,
    AUTH_STORE: {} as DurableObjectNamespace,
    AUTH_CLIENT_RATE_LIMITER: createRateLimit(),
    AUTH_CHALLENGE_CREATE_RATE_LIMITER: createRateLimit(),
    AUTH_SENSITIVE_RATE_LIMITER: createRateLimit(),
    PUBLIC_API_RATE_LIMITER: createRateLimit(),
    VPC_SERVICE: {} as Fetcher,
    MINECRAFT_SERVER_URL: 'https://minecraft.internal',
    MINECRAFT_SERVER_ADDRESS: 'mc.example',
    MINECRAFT_SERVER_PORT: '25565',
    CLOUDFLARE_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    CLOUDFLARE_ACCESS_AUD: 'aud',
    MIKWEB_AUTH_CLIENT_SECRET: 'test-secret',
    ...overrides,
  };
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
