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

  const created = await callStore(store, { action: 'createMinecraftChallenge' });
  const completed = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: created.body.challengeId,
    browserNonce: created.body.browserNonce,
  });

  expect(completed.status).toBe(403);
  expect(completed.body).toEqual({ error: 'member_required' });
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
        if (url.pathname.endsWith('/consume')) {
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

  const created = await callStore(store, { action: 'createMinecraftChallenge' });
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

  const firstChallenge = await callStore(store, { action: 'createMinecraftChallenge' });
  const firstLogin = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: firstChallenge.body.challengeId,
    browserNonce: firstChallenge.body.browserNonce,
  });
  const secondChallenge = await callStore(store, { action: 'createMinecraftChallenge' });
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

test('admin building mutations are queued inside auth store', async () => {
  const values = new Map<string, string>([['building-summary:v1', JSON.stringify([])]]);
  const kv = {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    put: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
    list: () => {
      throw new Error('KV list should not be used');
    },
  } as unknown as KVNamespace;
  const store = createAuthStore({ BUILDINGS_KV: kv });

  const [first, second] = await Promise.all([
    callStore(store, adminCreateBuildingMutation('Queued Building One')),
    callStore(store, adminCreateBuildingMutation('Queued Building Two')),
  ]);

  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const summary = JSON.parse(values.get('building-summary:v1') ?? '[]') as { name: { en: string } }[];
  expect(summary.map((building) => building.name.en).sort()).toEqual([
    'Queued Building One',
    'Queued Building Two',
  ]);
});

test('queued admin building mutations enforce stale update checks', async () => {
  const existing = {
    id: 'queuedstale',
    name: { 'zh-CN': '原建筑', en: 'Original Building' },
    description: { 'zh-CN': '描述', en: 'Description' },
    coordinates: { x: 0, y: 64, z: 0 },
    builders: [{ name: 'Player', uuid: '00000000-0000-0000-0000-000000000000', weight: 1 }],
    buildType: 'original',
    images: ['/images/test.png'],
    buildDate: '2026-06-27',
    createdAt: '2026-06-27T12:00:00.000Z',
    updatedAt: '2026-06-27T12:00:00.000Z',
  };
  const values = new Map<string, string>([
    ['building-summary:v1', JSON.stringify([existing])],
    ['building:queuedstale', JSON.stringify(existing)],
  ]);
  const kv = {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    put: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
    list: () => {
      throw new Error('KV list should not be used');
    },
  } as unknown as KVNamespace;
  const store = createAuthStore({ BUILDINGS_KV: kv });

  const [first, second] = await Promise.all([
    callStore(store, adminReplaceBuildingMutation('queuedstale', 'First Update', existing.updatedAt)),
    callStore(store, adminReplaceBuildingMutation('queuedstale', 'Second Update', existing.updatedAt)),
  ]);

  expect([first.status, second.status].sort()).toEqual([200, 409]);
  const stored = JSON.parse(values.get('building:queuedstale') ?? '{}') as { name: { en: string } };
  expect(['First Update', 'Second Update']).toContain(stored.name.en);
});

test('player building submissions are queued per player before enforcing pending limit', async () => {
  const store = createAuthStore({
    BUILDINGS_KV: createMemoryKv(),
    VPC_SERVICE: {
      fetch: () =>
        Promise.resolve(
          Response.json({
            status: 'confirmed',
            player: {
              uuid: '00000000-0000-0000-0000-000000000020',
              name: 'SubmitPlayer',
              role: 'member',
            },
          }),
        ),
    } as Fetcher,
  });
  const challenge = await callStore(store, { action: 'createMinecraftChallenge' });
  const login = await callStore(store, {
    action: 'completeMinecraftChallenge',
    challengeId: challenge.body.challengeId,
    browserNonce: challenge.body.browserNonce,
  });

  const responses = await Promise.all(
    Array.from({ length: 11 }, (_, index) =>
      callStore(store, {
        action: 'createBuildingSubmission',
        sessionId: login.body.sessionId,
        payload: buildingSubmissionPayload(index),
      }),
    ),
  );

  expect(responses.filter((response) => response.status === 201)).toHaveLength(10);
  expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
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

function adminCreateBuildingMutation(name: string): Record<string, unknown> {
  return {
    action: 'adminBuildingMutation',
    routePath: '/buildings',
    method: 'POST',
    url: 'https://data.mcmik.top/admin/api/buildings',
    headers: { 'Content-Type': 'application/json' },
    requestBody: JSON.stringify({
      name: { 'zh-CN': name, en: name },
      description: { 'zh-CN': '描述', en: 'Description' },
      coordinates: { x: 0, y: 64, z: 0 },
      builders: [{ name: 'Player', uuid: '00000000-0000-0000-0000-000000000000', weight: 1 }],
      buildType: 'original',
      images: ['/images/test.png'],
      buildDate: '2026-06-27',
    }),
  };
}

function adminReplaceBuildingMutation(id: string, name: string, expectedUpdatedAt: string): Record<string, unknown> {
  return {
    action: 'adminBuildingMutation',
    routePath: `/buildings/${id}`,
    method: 'PUT',
    url: `https://data.mcmik.top/admin/api/buildings/${id}`,
    headers: {
      'Content-Type': 'application/json',
      'X-Expected-Updated-At': expectedUpdatedAt,
    },
    requestBody: JSON.stringify({
      name: { 'zh-CN': name, en: name },
      description: { 'zh-CN': '描述', en: 'Description' },
      coordinates: { x: 0, y: 64, z: 0 },
      builders: [{ name: 'Player', uuid: '00000000-0000-0000-0000-000000000000', weight: 1 }],
      buildType: 'original',
      images: ['/images/test.png'],
      buildDate: '2026-06-27',
    }),
  };
}

function buildingSubmissionPayload(index: number): Record<string, unknown> {
  const imageUrl = `https://i.ibb.co/example/building-${index}.webp`;
  return {
    payload: {
      name: { 'zh-CN': `申请建筑${index}`, en: `Submission Building ${index}` },
      description: { 'zh-CN': '描述', en: 'Description' },
      coordinates: { x: index, y: 64, z: 0 },
      builders: [{ name: 'SubmitPlayer', uuid: '00000000-0000-0000-0000-000000000020', weight: 100 }],
      buildType: 'original',
      images: [imageUrl],
      buildDate: '2026-06-27',
    },
    images: [{
      url: imageUrl,
      width: 1280,
      height: 720,
      size: 120_000,
      mime: 'image/webp',
    }],
  };
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
