import { expect, test } from 'bun:test';
import worker, { AuthStore } from '../src/index';
import type { Env } from '../src/env';

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

  const created = await callStore(store, { action: 'createMinecraftChallenge' });

  expect(created.status).toBe(200);

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

  const created = await callStore(store, { action: 'createMinecraftChallenge' });

  const completed = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });

  expect(completed.status).toBe(503);
  expect(completed.body).toEqual({ error: 'plugin_unavailable' });
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

  const created = await callStore(store, { action: 'createMinecraftChallenge' });
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
      clientKey: 'ip:203.0.113.10',
    });
    expect(response.status).toBe(200);
  }

  const limited = await callStore(store, {
    action: 'createMinecraftChallenge',
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
    clientKey: 'ip:203.0.113.11',
  });

  for (let index = 0; index < 120; index += 1) {
    const response = await callStore(store, {
      action: 'getMinecraftChallenge',
      challengeId: created.body.challengeId,
      clientKey: 'ip:203.0.113.11',
    });
    expect(response.status).toBe(200);
  }

  const limited = await callStore(store, {
    action: 'getMinecraftChallenge',
    challengeId: created.body.challengeId,
    clientKey: 'ip:203.0.113.11',
  });

  expect(limited.status).toBe(429);
  expect(limited.body.error).toBe('rate_limited');
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

function createAuthStore(overrides: Partial<Env> = {}): AuthStore {
  const state = {
    storage: createStorage(),
  } as unknown as DurableObjectState;

  return new AuthStore(state, createEnv(overrides));
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
};

function createStorage(): DurableObjectStorage {
  const values = new Map<string, unknown>();

  return {
    get: (key: string) => Promise.resolve(values.get(key)),
    put: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(values.delete(key)),
    list: ({ prefix }: DurableObjectListOptions = {}) => {
      const entries = [...values.entries()].filter(([key]) => !prefix || key.startsWith(prefix));
      return Promise.resolve(new Map(entries));
    },
  } as unknown as DurableObjectStorage;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    BUILDINGS_KV: {} as KVNamespace,
    BUILDINGS_WRITER: {} as DurableObjectNamespace,
    AUTH_STORE: {} as DurableObjectNamespace,
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

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}
