import { testDatabase } from './d1';
import { SessionService } from '../../src/auth/sessions';
import { MinecraftLogin } from '../../src/auth/minecraft';
import { Passkeys } from '../../src/auth/passkeys';
import { authorizeWebChat } from '../../src/auth/chat';
import { asString } from '../../src/shared/http';
import { resolveMikwebPlayer, mikwebError } from '../../src/mikweb';
import { adminBuildings, playerBuildingAction } from '../../src/buildings/actions';
import type { Env } from '../../src/env';
import type { MemberBuildingCommand } from '../../src/buildings/actions';

import { playerRow, playerAccount } from '../../src/players/repository';

export const PLAYER_UUID = '00000000-0000-4000-8000-000000000001';
export const OTHER_UUID = '00000000-0000-4000-8000-000000000002';

const tables: Record<string, string> = {
  account: 'players', session: 'auth_sessions', passkey: 'auth_passkeys',
  challenge: 'auth_challenges', code: 'auth_codes', webauthn: 'auth_webauthn',
};
export class FixtureRecords {
  constructor(private readonly sqlite: ReturnType<typeof testDatabase>['sqlite']) {}
  get(key: string) {
    const [kind,id] = key.split(':');
    if (kind === 'account') {
      const row = this.sqlite.query('SELECT * FROM players WHERE id=?').get(id);
      return row ? playerAccount(row) : undefined;
    }
    const row = this.sqlite.query(`SELECT document FROM ${tables[kind]} WHERE id=?`).get(id) as { document: string } | null;
    return row ? JSON.parse(row.document) : undefined;
  }
  has(key: string) { return this.get(key) !== undefined; }
  set(key: string, value: unknown) {
    const [kind,id] = key.split(':');
    if (kind === 'account') {
      const row = playerRow(value);
      this.sqlite.query('INSERT OR REPLACE INTO players(id,current_name,role,disabled_at,banned,credentials_changed_at,policy_checked_at) VALUES(?,?,?,?,?,?,?)')
        .run(row.id, row.current_name, row.role, row.disabled_at, row.banned, row.credentials_changed_at, row.policy_checked_at);
    } else this.sqlite.query(`INSERT OR REPLACE INTO ${tables[kind]}(id,document) VALUES(?,?)`).run(id, JSON.stringify(value));
  }
  delete(key: string) {
    const [kind,id] = key.split(':');
    this.sqlite.query(`DELETE FROM ${tables[kind]} WHERE id=?`).run(id);
  }
  sessions(uuid: string) {
    return this.sqlite.query('SELECT id FROM auth_sessions WHERE player_uuid=?').all(uuid).map(row => row.id);
  }
  *keys() {
    for (const [kind, table] of Object.entries(tables))
      for (const { id } of this.sqlite.query(`SELECT id FROM ${table} ORDER BY id`).all()) yield kind + ':' + id;
  }
}

export function authDatabaseFixture() {
  const database = testDatabase();
  const values = new FixtureRecords(database.sqlite);
  function failNextSql(text: string) {
    database.hooks.before = sql => {
      if (!sql.includes(text)) return;
      database.hooks.before = undefined;
      throw new Error('Injected storage failure');
    };
  }
  return { ...database, values, failNextSql, failNextPut: (prefix: string) => failNextSql('INSERT INTO ' + tables[prefix.split(':')[0]]) };
}

export function testAuthEnv(overrides: Partial<Env> = {}): Env {
  const limiter = { limit: async () => ({ success: true }) } as RateLimit;
  return {
    DB: overrides.DB ?? testDatabase().db,
    AUTH_CLIENT_RATE_LIMITER: limiter,
    AUTH_SESSION_CHECK_IP_RATE_LIMITER: limiter,
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
                banned: false, credentialsChangedAt: 0,
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

export function authFixture(overrides: Partial<Env> = {}, memory = authDatabaseFixture()) {
  const env = testAuthEnv({ DB: memory.db, ...overrides });
  const background: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { background.push(p); } } as ExecutionContext;
  return { ...memory, store: { env, ctx }, env, ctx, background, db: memory.sqlite };
}

export async function authCall(store: { env: Env; ctx: ExecutionContext }, body: Record<string, unknown>) {
  const auth = new SessionService(store.env, store.ctx);
  const action = body as MemberBuildingCommand;
  if (['createBuildingSubmission','listBuildingSubmissions','prepareImageUpload','reserveImageUpload','completeImageUpload'].includes(action.action))
    return playerBuildingAction(store.env, auth, action);
  if (action.action === 'adminBuildingMutation') return adminBuildings(store.env, { actor: {}, ...body } as any);
  const data = body;
  const sessionId = asString(body.sessionId);
  const clientKey = asString(body.clientKey);
  const browserNonce = asString(body.browserNonce);
  try {
    switch (body.action) {
      case 'createMinecraftChallenge': return await new MinecraftLogin(auth).create(clientKey, browserNonce, data.purpose, sessionId);
      case 'getMinecraftChallenge': return await new MinecraftLogin(auth).get(asString(data.challengeId), clientKey, browserNonce, sessionId);
      case 'completeMinecraftChallenge': return await new MinecraftLogin(auth).complete(asString(data.challengeId), browserNonce, clientKey, sessionId);
      case 'me': return await auth.me(sessionId, clientKey);
      case 'logout': return await auth.logout(sessionId);
      case 'passkeyRegistrationOptions': return await new Passkeys(auth).registrationOptions(sessionId);
      case 'passkeyRegister': return await new Passkeys(auth).register(sessionId, data.credential, data.displayName);
      case 'passkeyAuthenticationOptions': return await new Passkeys(auth).authenticationOptions(clientKey, browserNonce, data.purpose, sessionId);
      case 'passkeyAuthenticate': return await new Passkeys(auth).authenticate(data.credential, clientKey, browserNonce, sessionId);
      case 'passkeyDelete': return await new Passkeys(auth).delete(sessionId, asString(data.credentialId));
      case 'accountSecurity': return await auth.accountSecurity(sessionId);
      case 'renameSecurityItem': return await auth.renameSecurityItem(sessionId, data.kind, asString(data.targetId), data.displayName);
      case 'revokeAccountSession': return await auth.revokeAccountSession(sessionId, asString(data.targetSessionId), data.all === true);
      case 'authorizeWebChat': return await authorizeWebChat(auth, sessionId, asString(data.connectionId), asString(data.clientPublicKey));
      case 'resolvePlayer': return await resolveMikwebPlayer(auth, sessionId, asString(data.name));
      default: throw new Error('Unknown fixture action ' + body.action);
    }
  } catch (error) { return mikwebError(error); }
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
  values: FixtureRecords,
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
  values.set(`account:${playerUuid}`, {
    playerUuid,
    currentName: 'Player',
    role: 'member',
  });
  return { token, record };
}

export async function passkeyFixture(values: FixtureRecords) {
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
  values.set(`account:${PLAYER_UUID}`, {
    playerUuid: PLAYER_UUID,
    currentName: 'Player',
    role: 'member',
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
