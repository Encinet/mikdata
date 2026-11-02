import { Database } from 'bun:sqlite';
import { AuthStore } from '../../src/auth';
import type { Env } from '../../src/env';

export const PLAYER_UUID = '00000000-0000-4000-8000-000000000001';
export const OTHER_UUID = '00000000-0000-4000-8000-000000000002';

/** Structured-clone reads, isolated commits and rollback; intentionally does not model workerd input gates. */
export function memoryAuthStorage() {
  const values = new Map<string, unknown>();
  const db = new Database(':memory:');
  let alarm: number | null = null;
  let failSql: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let failPrefix: string | undefined;
  const access = (data: Map<string, unknown>) => ({
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      const entries = typeof key === 'string' ? [[key, value] as const] : Object.entries(key);
      for (const [name, entry] of entries) {
        if (failPrefix && name.startsWith(failPrefix)) {
          failPrefix = undefined;
          throw new Error('Injected storage failure');
        }
        data.set(name, structuredClone(entry));
      }
    },
    delete: async (key: string | string[]) =>
      Array.isArray(key)
        ? key.reduce((count, name) => count + Number(data.delete(name)), 0)
        : data.delete(key),
    list: async ({ prefix, limit, startAfter }: DurableObjectListOptions = {}) =>
      new Map(
        [...data.entries()]
          .filter(
            ([key]) => (!prefix || key.startsWith(prefix)) && (!startAfter || key > startAfter),
          )
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit ?? Infinity)
          .map(([key, value]) => [key, structuredClone(value)]),
      ),
  });
  const storage = {
    sql: {
      exec: (query: string, ...bindings: (string | number | null | ArrayBuffer)[]) => {
        if (failSql && query.includes(failSql)) {
          failSql = undefined;
          throw new Error('Injected SQL failure');
        }
        if (query.trim().split(';').filter(Boolean).length > 1) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const rows = db.query(query).all(...bindings) as Record<string, unknown>[];
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error('Expected one row');
            return rows[0];
          },
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => {
      alarm = time;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    ...Object.fromEntries(
      Object.keys(access(values)).map((name) => [
        name,
        async (...args: unknown[]) => {
          await queue;
          return (access(values) as unknown as Record<string, (...input: unknown[]) => unknown>)[
            name
          ](...args);
        },
      ]),
    ),
    transaction: (task: (txn: DurableObjectTransaction) => Promise<unknown>) => {
      const result = queue
        .catch(() => undefined)
        .then(async () => {
          const copy = structuredClone(values);
          const oldAlarm = alarm;
          db.exec('SAVEPOINT test_transaction');
          let output: unknown;
          try {
            output = await task(access(copy) as unknown as DurableObjectTransaction);
            db.exec('RELEASE test_transaction');
          } catch (error) {
            db.exec('ROLLBACK TO test_transaction; RELEASE test_transaction');
            alarm = oldAlarm;
            throw error;
          }
          values.clear();
          for (const [key, value] of copy) values.set(key, value);
          return output;
        });
      queue = result.catch(() => undefined);
      return result;
    },
  } as unknown as DurableObjectStorage;
  return {
    storage,
    values,
    db,
    failNextSql: (query: string) => {
      failSql = query;
    },
    failNextPut: (prefix: string) => {
      failPrefix = prefix;
    },
  };
}

export function testAuthEnv(overrides: Partial<Env> = {}): Env {
  const limiter = { limit: async () => ({ success: true }) } as RateLimit;
  return {
    BUILDINGS_KV: {
      get: async (key: string | string[]) =>
        Array.isArray(key) ? new Map(key.map((name) => [name, null])) : null,
      put: async () => undefined,
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace,
    AUTH_STORE: {} as DurableObjectNamespace,
    AUTH_CLIENT_RATE_LIMITER: limiter,
    AUTH_CHALLENGE_CREATE_RATE_LIMITER: limiter,
    AUTH_SENSITIVE_RATE_LIMITER: limiter,
    PUBLIC_API_RATE_LIMITER: limiter,
    MINECRAFT_SERVER_URL: 'https://minecraft.internal',
    MINECRAFT_SERVER_ADDRESS: 'mc.example',
    MINECRAFT_SERVER_PORT: '25565',
    CLOUDFLARE_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    CLOUDFLARE_ACCESS_AUD: 'aud',
    MIKWEB_AUTH_CLIENT_SECRET: 'test-secret',
    VPC_SERVICE: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        return url.pathname.startsWith('/api/auth/accounts/')
          ? Response.json({
              player: {
                uuid: url.pathname.split('/').at(-1),
                role: 'member',
                credentialsChangedAt: 0,
              },
            })
          : Response.json({
              status: 'confirmed',
              player: { uuid: PLAYER_UUID, name: 'Player', role: 'member' },
              confirmedAt: new Date().toISOString(),
            });
      },
    } as Fetcher,
    ...overrides,
  };
}

export function testAuthStore(overrides: Partial<Env> = {}, memory = memoryAuthStorage()) {
  const env = testAuthEnv(overrides);
  const background: Promise<unknown>[] = [];
  const store = new AuthStore(
    {
      storage: memory.storage,
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
    } as DurableObjectState,
    env,
  );
  return { store, env, background, ...memory };
}

export async function authCall(store: AuthStore, body: Record<string, unknown>) {
  const response = await store.fetch(
    new Request('https://auth-store.local/', { method: 'POST', body: JSON.stringify(body) }),
  );
  return (await response.json()) as {
    status: number;
    body: Record<string, unknown> & {
      options: { challenge: string };
      browserNonce: string;
      challengeId: string;
      sessionId: string;
      authenticated: boolean;
    };
  };
}

export function b64(value: Uint8Array | ArrayBuffer): string {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString(
    'base64url',
  );
}
export async function hash(value: string): Promise<string> {
  return b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
export async function seedSession(
  values: Map<string, unknown>,
  ageMs = 0,
  playerUuid = PLAYER_UUID,
) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  const sidHash = await hash(token);
  const now = Date.now();
  const record = {
    sidHash,
    playerUuid,
    issuedAt: new Date(now).toISOString(),
    authenticatedAt: new Date(now - ageMs).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    idleExpiresAt: new Date(now + 86400_000).toISOString(),
    absoluteExpiresAt: new Date(now + 86400_000).toISOString(),
    authMethod: 'minecraft-challenge',
  };
  values.set(`session:${sidHash}`, record);
  values.set(`account-session:${playerUuid}:${sidHash}`, sidHash);
  values.set(`account:${playerUuid}`, {
    playerUuid,
    currentName: 'Player',
    role: 'member',
    updatedAt: new Date().toISOString(),
  });
  return { token, record };
}

export async function passkeyFixture(values: Map<string, unknown>) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const cose = new Uint8Array([
    0xa5,
    1,
    2,
    3,
    0x26,
    0x20,
    1,
    0x21,
    0x58,
    32,
    ...Buffer.from(jwk.x!, 'base64url'),
    0x22,
    0x58,
    32,
    ...Buffer.from(jwk.y!, 'base64url'),
  ]);
  const idBytes = crypto.getRandomValues(new Uint8Array(16));
  const id = b64(idBytes);
  const record = {
    credentialId: id,
    playerUuid: PLAYER_UUID,
    publicKey: b64(cose),
    counter: 0,
    createdAt: new Date().toISOString(),
  };
  values.set(`passkey:${id}`, record);
  values.set(`account-passkey:${PLAYER_UUID}:${id}`, id);
  values.set(`account:${PLAYER_UUID}`, {
    playerUuid: PLAYER_UUID,
    currentName: 'Player',
    role: 'member',
    updatedAt: new Date().toISOString(),
  });
  const authData = new Uint8Array([
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mcmik.top'))),
    5,
    0,
    0,
    0,
    0,
  ]);
  return {
    id,
    assertion: async (challenge: string, owner = PLAYER_UUID, uv = true) => {
      const clientData = new TextEncoder().encode(
        JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://mcmik.top' }),
      );
      const data = authData.slice();
      if (!uv) data[32] = 1;
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keys.privateKey,
          new Uint8Array([
            ...data,
            ...new Uint8Array(await crypto.subtle.digest('SHA-256', clientData)),
          ]),
        ),
      );
      const integer = (bytes: Uint8Array) => {
        let i = 0;
        while (i < bytes.length - 1 && bytes[i] === 0) i++;
        const part = [...bytes.slice(i)];
        return part[0] & 0x80 ? [0, ...part] : part;
      };
      const r = integer(signature.slice(0, 32));
      const s = integer(signature.slice(32));
      const der = new Uint8Array([
        0x30,
        4 + r.length + s.length,
        2,
        r.length,
        ...r,
        2,
        s.length,
        ...s,
      ]);
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(clientData),
          authenticatorData: b64(data),
          signature: b64(der),
          userHandle: b64(new TextEncoder().encode(owner)),
        },
      };
    },
    registration: async (challenge: string) => {
      // A fresh credential, with a valid none-attestation response from the same real P-256 public key.
      const newId = crypto.getRandomValues(new Uint8Array(16));
      const credentialId = b64(newId);
      const data = new Uint8Array([
        ...authData.slice(0, 32),
        0x45,
        0,
        0,
        0,
        0,
        ...new Uint8Array(16),
        0,
        newId.length,
        ...newId,
        ...cose,
      ]);
      const object = new Uint8Array([
        0xa3,
        0x63,
        ...new TextEncoder().encode('fmt'),
        0x64,
        ...new TextEncoder().encode('none'),
        0x67,
        ...new TextEncoder().encode('attStmt'),
        0xa0,
        0x68,
        ...new TextEncoder().encode('authData'),
        0x58,
        data.length,
        ...data,
      ]);
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(
            new TextEncoder().encode(
              JSON.stringify({ type: 'webauthn.create', challenge, origin: 'https://mcmik.top' }),
            ),
          ),
          attestationObject: b64(object),
          transports: ['internal'],
        },
      };
    },
  };
}
