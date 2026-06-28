import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import type { Env } from './env';
import {
  createPlayerBuildingSubmission,
  listPlayerBuildingSubmissions,
} from './buildings';
import { authJson } from './http';
import { TtlMemoryCache } from './memory-cache';

const AUTH_STORE_NAME = 'global';
const SESSION_COOKIE_NAME = '__Host-mik_sid';
const LOGIN_COOKIE_NAME = '__Host-mik_login';
const SESSION_IDLE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 90;
const SESSION_TOUCH_INTERVAL_SECONDS = 60 * 10;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_CLEANUP_INTERVAL_SECONDS = 5 * 60;
const ACCOUNT_CACHE_TTL_MS = 60 * 1000;
const PASSKEY_CACHE_TTL_MS = 60 * 1000;
const PLAYER_RESOLVE_CACHE_TTL_MS = 60 * 1000;
const WEB_LOGIN_CODE_RE = /^[0-9]{6,10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = new Set(['member', 'helper', 'manager']);
const RP_ID = 'mcmik.top';
const RP_NAME = 'Mik Casual';
const EXPECTED_ORIGIN = 'https://mcmik.top';

type AuthRouteResult = Response | null;

interface PlayerAccountSummary {
  playerUuid: string;
  currentName: string;
  role: string;
  updatedAt: string;
  passkeyCount: number;
}

interface PluginChallengeResponse {
  status: 'confirmed' | 'pending' | 'expired' | 'not_found' | 'consumed' | 'unavailable';
  player?: {
    uuid?: string;
    name?: string;
    role?: string;
  };
  confirmedAt?: string;
}

interface PluginPlayerResolveResponse {
  player?: {
    uuid?: string;
    name?: string;
  };
}

interface SessionRecord {
  sidHash: string;
  playerUuid: string;
  issuedAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  authMethod: 'minecraft-challenge' | 'passkey';
  revokedAt?: string;
}

interface AccountRecord {
  playerUuid: string;
  currentName: string;
  updatedAt: string;
  role: string;
  disabledAt?: string;
}

interface PasskeyRecord {
  credentialId: string;
  playerUuid: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  createdAt: string;
  lastUsedAt?: string;
  displayName?: string;
}

type ChallengeRecord =
  | {
      type: 'minecraft-login';
      challengeId: string;
      displayCode: string;
      browserNonceHash: string;
      createdAt: string;
      expiresAt: string;
      status: 'pending' | 'confirmed' | 'consumed' | 'expired';
      confirmedPlayerUuid?: string;
      confirmedPlayerName?: string;
      confirmedRole?: string;
      confirmedAt?: string;
      lastPluginCheckAt?: string;
    }
  | {
      type: 'passkey-registration' | 'passkey-authentication';
      challengeId: string;
      playerUuid?: string;
      challenge: string;
      createdAt: string;
      expiresAt: string;
    };

interface StoreRequest {
  action: string;
  [key: string]: unknown;
}

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export async function handleAuthRoute(
  routePath: string,
  request: Request,
  env: Env,
): Promise<AuthRouteResult> {
  if (!routePath.startsWith('/auth') && !routePath.startsWith('/me')) {
    return null;
  }

  if (!isMikwebClientRequest(request, env)) {
    return authJson({ error: 'forbidden' }, 403);
  }

  const store = authStore(env);
  const clientKey = clientRateLimitKey(request);

  if (routePath === '/auth/challenges' && request.method === 'POST') {
    const response = await callStore(store, { action: 'createMinecraftChallenge', clientKey });
    return authJson(stripInternalAuthFields(response.body), response.status, setLoginCookie(response.body));
  }

  const challengeStatus = routePath.match(/^\/auth\/challenges\/([^/]+)$/);
  if (challengeStatus && request.method === 'GET') {
    const response = await callStore(store, {
      action: 'getMinecraftChallenge',
      challengeId: challengeStatus[1],
      clientKey,
    });
    return authJson(response.body, response.status);
  }

  const challengeComplete = routePath.match(/^\/auth\/challenges\/([^/]+)\/complete$/);
  if (challengeComplete && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, {
      action: 'completeMinecraftChallenge',
      challengeId: challengeComplete[1],
      browserNonce: payload.browserNonce,
      clientKey,
    });
    return authJson(stripInternalAuthFields(response.body), response.status, sessionHeaders(response.body));
  }

  if (routePath === '/auth/me' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, { action: 'me', sessionId: payload.sessionId });
    return authJson(response.body, response.status);
  }

  if (routePath === '/auth/logout' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, { action: 'logout', sessionId: payload.sessionId });
    return authJson(stripInternalAuthFields(response.body), response.status, sessionHeaders(response.body));
  }

  if (routePath === '/auth/passkeys/options/register' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, {
      action: 'passkeyRegistrationOptions',
      sessionId: payload.sessionId,
    });
    return authJson(response.body, response.status);
  }

  if (routePath === '/auth/passkeys/register' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, {
      action: 'passkeyRegister',
      sessionId: payload.sessionId,
      credential: payload.credential,
      displayName: payload.displayName,
    });
    return authJson(stripInternalAuthFields(response.body), response.status, sessionHeaders(response.body));
  }

  if (routePath === '/auth/passkeys/options/login' && request.method === 'POST') {
    const response = await callStore(store, { action: 'passkeyAuthenticationOptions', clientKey });
    return authJson(response.body, response.status);
  }

  if (routePath === '/auth/passkeys/login' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, {
      action: 'passkeyLogin',
      credential: payload.credential,
      clientKey,
    });
    return authJson(stripInternalAuthFields(response.body), response.status, sessionHeaders(response.body));
  }

  const removePasskey = routePath.match(/^\/auth\/passkeys\/([^/]+)$/);
  if (removePasskey && request.method === 'DELETE') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, {
      action: 'passkeyDelete',
      credentialId: removePasskey[1],
      sessionId: payload.sessionId,
    });
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/summary' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, { action: 'accountSummary', sessionId: payload.sessionId });
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/security' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, { action: 'accountSecurity', sessionId: payload.sessionId });
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/players/resolve' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, {
      action: 'resolvePlayer',
      sessionId: payload.sessionId,
      name: payload.name,
    });
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/building-submissions' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, {
      action: 'createBuildingSubmission',
      sessionId: payload.sessionId,
      payload,
    });
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/building-submissions/mine' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    const response = await callStore(store, {
      action: 'listBuildingSubmissions',
      sessionId: payload.sessionId,
    });
    return authJson(response.body, response.status);
  }

  return authJson({ error: 'not_found' }, 404);
}

export class AuthStore implements DurableObject {
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;
  private readonly rateLimits = new Map<string, RateLimitRecord>();
  private readonly sessionCache = new TtlMemoryCache<SessionRecord>({
    defaultTtlMs: SESSION_TOUCH_INTERVAL_SECONDS * 1000,
    maxEntries: 2048,
  });
  private readonly accountCache = new TtlMemoryCache<AccountRecord>({
    defaultTtlMs: ACCOUNT_CACHE_TTL_MS,
    maxEntries: 1024,
  });
  private readonly passkeyCache = new TtlMemoryCache<PasskeyRecord[]>({
    defaultTtlMs: PASSKEY_CACHE_TTL_MS,
    maxEntries: 1024,
  });
  private readonly playerResolveCache = new TtlMemoryCache<{ uuid: string; name: string }>({
    defaultTtlMs: PLAYER_RESOLVE_CACHE_TTL_MS,
    maxEntries: 1024,
  });
  private lastChallengeCleanupAt = 0;
  private initialized: Promise<void> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();
    const body = (await request.json()) as StoreRequest;

    try {
      return json(await this.dispatch(body));
    } catch (error) {
      console.error('AuthStore error', error);
      return json({ status: 500, body: { error: 'internal_error' } });
    }
  }

  private async dispatch(body: StoreRequest): Promise<{ status: number; body: unknown }> {
    switch (body.action) {
      case 'createMinecraftChallenge':
        return this.createMinecraftChallenge(asString(body.clientKey));
      case 'getMinecraftChallenge':
        return this.getMinecraftChallenge(asString(body.challengeId), asString(body.clientKey));
      case 'completeMinecraftChallenge':
        return this.completeMinecraftChallenge(
          asString(body.challengeId),
          asString(body.browserNonce),
          asString(body.clientKey),
        );
      case 'me':
        return this.me(asString(body.sessionId));
      case 'logout':
        return this.logout(asString(body.sessionId));
      case 'passkeyRegistrationOptions':
        return this.passkeyRegistrationOptions(asString(body.sessionId));
      case 'passkeyRegister':
        return this.passkeyRegister(asString(body.sessionId), body.credential, optionalString(body.displayName));
      case 'passkeyAuthenticationOptions':
        return this.passkeyAuthenticationOptions(asString(body.clientKey));
      case 'passkeyLogin':
        return this.passkeyLogin(body.credential, asString(body.clientKey));
      case 'passkeyDelete':
        return this.passkeyDelete(asString(body.sessionId), asString(body.credentialId));
      case 'accountSummary':
        return this.accountSummary(asString(body.sessionId));
      case 'accountSecurity':
        return this.accountSecurity(asString(body.sessionId));
      case 'resolvePlayer':
        return this.resolvePlayer(asString(body.sessionId), asString(body.name));
      case 'createBuildingSubmission':
        return this.createBuildingSubmission(asString(body.sessionId), body.payload);
      case 'listBuildingSubmissions':
        return this.listBuildingSubmissions(asString(body.sessionId));
      default:
        return { status: 404, body: { error: 'not_found' } };
    }
  }

  private async createMinecraftChallenge(clientKey: string): Promise<{ status: number; body: unknown }> {
    const rateLimited = this.consumeRateLimit(rateLimitKey('minecraft-challenge:create', clientKey), 8, 60);
    if (rateLimited) return rateLimited;
    await this.cleanupExpiredChallenges();

    const challengeId = randomToken(18);
    const displayCode = await this.createUniqueDisplayCode();
    const browserNonce = randomToken(24);
    const now = new Date();
    const record: ChallengeRecord = {
      type: 'minecraft-login',
      challengeId,
      displayCode,
      browserNonceHash: await sha256(browserNonce),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
      status: 'pending',
    };

    await this.storage.put(challengeKey(challengeId), record);
    await this.storage.put(codeKey(displayCode), challengeId);

    return {
      status: 200,
      body: {
        challengeId,
        displayCode,
        browserNonce,
        expiresAt: record.expiresAt,
      },
    };
  }

  private async createUniqueDisplayCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const displayCode = createDisplayCode();
      const existingChallengeId = await this.storage.get<string>(codeKey(displayCode));
      if (!existingChallengeId) {
        return displayCode;
      }
    }

    throw new Error('Unable to allocate unique web login code');
  }

  private async getMinecraftChallenge(
    challengeId: string,
    clientKey: string,
  ): Promise<{ status: number; body: unknown }> {
    const rateLimited = this.consumeRateLimit(rateLimitKey('minecraft-challenge:status', clientKey), 120, 60);
    if (rateLimited) return rateLimited;

    const record = await this.readMinecraftChallenge(challengeId);
    if (!record) return { status: 404, body: { status: 'not_found' } };
    if (isExpired(record.expiresAt)) {
      await this.deleteMinecraftChallenge(record);
      return { status: 200, body: { status: 'expired' } };
    }

    if (record.status === 'pending' && shouldCheckPlugin(record.lastPluginCheckAt)) {
      const plugin = await this.fetchPluginChallenge(record.displayCode, false);
      const role = normalizeRole(plugin.player?.role);
      if (plugin.status === 'confirmed' && plugin.player && role) {
        record.status = 'confirmed';
        record.confirmedPlayerUuid = asString(plugin.player.uuid);
        record.confirmedPlayerName = asString(plugin.player.name);
        record.confirmedRole = role;
        record.confirmedAt = plugin.confirmedAt ?? new Date().toISOString();
      }
      record.lastPluginCheckAt = new Date().toISOString();
      await this.storage.put(challengeKey(challengeId), record);
    }

    return { status: 200, body: challengePublicBody(record) };
  }

  private async completeMinecraftChallenge(
    challengeId: string,
    browserNonce: string,
    clientKey: string,
  ): Promise<{ status: number; body: unknown }> {
    const rateLimited = this.consumeRateLimit(rateLimitKey('minecraft-challenge:complete', clientKey), 20, 60);
    if (rateLimited) return rateLimited;

    const record = await this.readMinecraftChallenge(challengeId);
    if (!record) return { status: 404, body: { error: 'not_found' } };
    if (isExpired(record.expiresAt)) {
      await this.deleteMinecraftChallenge(record);
      return { status: 410, body: { error: 'expired' } };
    }
    if ((await sha256(browserNonce)) !== record.browserNonceHash) {
      return { status: 403, body: { error: 'invalid_browser_nonce' } };
    }

    const plugin = await this.fetchPluginChallenge(record.displayCode, true);
    if (plugin.status === 'unavailable') {
      return { status: 503, body: { error: 'plugin_unavailable' } };
    }
    const role = normalizeRole(plugin.player?.role);
    if (plugin.status !== 'confirmed' || !plugin.player || !role) {
      return { status: 403, body: { error: 'member_required' } };
    }

    const account = await this.upsertAccount(
      asString(plugin.player.uuid),
      asString(plugin.player.name),
      role,
    );
    const session = await this.createSession(account.playerUuid, 'minecraft-challenge');
    record.status = 'consumed';
    await this.storage.put(challengeKey(challengeId), record);
    await this.storage.delete(codeKey(record.displayCode));

    return { status: 200, body: sessionBody(session.sessionId, account) };
  }

  private async me(sessionId: string): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 200, body: { authenticated: false } };
    const account = await this.readAccount(session.playerUuid);
    if (!account) return { status: 200, body: { authenticated: false } };
    return { status: 200, body: { authenticated: true, account: await this.accountSummaryBody(account) } };
  }

  private async logout(sessionId: string): Promise<{ status: number; body: unknown }> {
    const sidHash = await sha256(sessionId);
    const session = await this.storage.get<SessionRecord>(sessionKey(sidHash));
    if (session) {
      session.revokedAt = new Date().toISOString();
      await this.storage.put(sessionKey(sidHash), session);
    }
    this.sessionCache.delete(sidHash);
    return { status: 200, body: { ok: true, clearSession: true } };
  }

  private async passkeyRegistrationOptions(sessionId: string): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const account = await this.readAccount(session.playerUuid);
    if (!account) return { status: 403, body: { error: 'member_required' } };
    await this.cleanupExpiredChallenges();
    const passkeys = await this.listPasskeys(account.playerUuid);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: account.currentName,
      userID: toArrayBufferBytes(new TextEncoder().encode(account.playerUuid)),
      userDisplayName: account.currentName,
      attestationType: 'none',
      excludeCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });

    await this.storage.put(webauthnChallengeKey(options.challenge), {
      type: 'passkey-registration',
      challengeId: randomToken(12),
      playerUuid: account.playerUuid,
      challenge: options.challenge,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    } satisfies ChallengeRecord);

    return { status: 200, body: { options } };
  }

  private async passkeyRegister(
    sessionId: string,
    credential: unknown,
    displayName?: string,
  ): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const challenge = await this.readWebauthnChallenge('passkey-registration', credentialChallengeId(credential));
    if (!challenge?.playerUuid || challenge.playerUuid !== session.playerUuid) {
      return { status: 400, body: { error: 'invalid_challenge' } };
    }

    const verification = await verifyRegistrationResponse({
      response: credential as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return { status: 400, body: { error: 'passkey_verification_failed' } };
    }

    const account = await this.readAccount(session.playerUuid);
    if (!account) {
      await this.storage.delete(webauthnChallengeKey(challenge.challenge));
      return { status: 403, body: { error: 'member_required' } };
    }

    const { credential: verifiedCredential } = verification.registrationInfo;
    const record: PasskeyRecord = {
      credentialId: verifiedCredential.id,
      playerUuid: session.playerUuid,
      publicKey: bufferToBase64url(verifiedCredential.publicKey),
      counter: verifiedCredential.counter,
      transports: (credential as { response?: { transports?: AuthenticatorTransportFuture[] } })?.response?.transports,
      createdAt: new Date().toISOString(),
      displayName,
    };
    await Promise.all([
      this.storage.put(passkeyKey(record.credentialId), record),
      this.storage.put(accountPasskeyKey(record.playerUuid, record.credentialId), record.credentialId),
      this.storage.delete(webauthnChallengeKey(challenge.challenge)),
    ]);
    session.revokedAt = new Date().toISOString();
    await this.storage.put(sessionKey(session.sidHash), session);
    this.sessionCache.delete(session.sidHash);
    this.passkeyCache.delete(record.playerUuid);
    const newSession = await this.createSession(session.playerUuid, 'passkey');
    return {
      status: 200,
      body: sessionBody(newSession.sessionId, account),
    };
  }

  private async passkeyAuthenticationOptions(clientKey: string): Promise<{ status: number; body: unknown }> {
    const rateLimited = this.consumeRateLimit(rateLimitKey('passkey-authentication:create', clientKey), 20, 60);
    if (rateLimited) return rateLimited;
    await this.cleanupExpiredChallenges();

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
    });

    await this.storage.put(webauthnChallengeKey(options.challenge), {
      type: 'passkey-authentication',
      challengeId: randomToken(12),
      challenge: options.challenge,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    } satisfies ChallengeRecord);

    return { status: 200, body: { options } };
  }

  private async passkeyLogin(
    credential: unknown,
    clientKey: string,
  ): Promise<{ status: number; body: unknown }> {
    const rateLimited = this.consumeRateLimit(rateLimitKey('passkey-authentication:login', clientKey), 20, 60);
    if (rateLimited) return rateLimited;

    const response = credential as AuthenticationResponseJSON;
    const passkey = await this.storage.get<PasskeyRecord>(passkeyKey(response.id));
    if (!passkey) return { status: 404, body: { error: 'passkey_not_found' } };
    const challenge = await this.readWebauthnChallenge('passkey-authentication', credentialChallengeId(credential));
    if (!challenge) return { status: 400, body: { error: 'invalid_challenge' } };
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: base64urlToBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports,
      } satisfies WebAuthnCredential,
    });

    if (!verification.verified) return { status: 400, body: { error: 'passkey_verification_failed' } };
    const account = await this.readAccount(passkey.playerUuid);
    if (!account) return { status: 403, body: { error: 'member_required' } };
    passkey.counter = verification.authenticationInfo.newCounter;
    passkey.lastUsedAt = new Date().toISOString();
    await this.storage.put(passkeyKey(passkey.credentialId), passkey);
    await this.storage.delete(webauthnChallengeKey(challenge.challenge));
    this.passkeyCache.delete(passkey.playerUuid);
    const session = await this.createSession(account.playerUuid, 'passkey');
    return { status: 200, body: sessionBody(session.sessionId, account) };
  }

  private async passkeyDelete(sessionId: string, credentialId: string): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const passkey = await this.storage.get<PasskeyRecord>(passkeyKey(credentialId));
    if (!passkey || passkey.playerUuid !== session.playerUuid) return { status: 404, body: { error: 'not_found' } };
    await Promise.all([
      this.storage.delete(passkeyKey(credentialId)),
      this.storage.delete(accountPasskeyKey(session.playerUuid, credentialId)),
    ]);
    this.passkeyCache.delete(session.playerUuid);
    return { status: 200, body: { ok: true } };
  }

  private async accountSummary(sessionId: string): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const account = await this.readAccount(session.playerUuid);
    if (!account) return { status: 404, body: { error: 'not_found' } };
    return { status: 200, body: { account: await this.accountSummaryBody(account) } };
  }

  private async accountSecurity(sessionId: string): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const account = await this.readAccount(session.playerUuid);
    if (!account) return { status: 404, body: { error: 'not_found' } };
    return {
      status: 200,
      body: {
        account: await this.accountSummaryBody(account),
        session: publicSession(session),
        passkeys: (await this.listPasskeys(account.playerUuid)).map(publicPasskey),
      },
    };
  }

  private async resolvePlayer(
    sessionId: string,
    name: string,
  ): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const requester = await this.readAccount(session.playerUuid);
    if (!requester) return { status: 403, body: { error: 'member_required' } };

    const normalizedName = normalizePlayerName(name);
    if (!normalizedName) {
      return { status: 422, body: { error: 'invalid_name' } };
    }

    const player = await this.resolvePluginPlayer(normalizedName);
    if (!player) {
      return { status: 404, body: { error: 'player_not_found' } };
    }

    return {
      status: 200,
      body: {
        player: {
          uuid: player.uuid,
          name: player.name,
        },
      },
    };
  }

  private async createBuildingSubmission(
    sessionId: string,
    payload: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const account = await this.readAccount(session.playerUuid);
    if (!account) return { status: 403, body: { error: 'member_required' } };

    return responseToStoreResult(
      await createPlayerBuildingSubmission(
        new Request('https://auth-store.local/building-submissions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        }),
        this.env,
        account,
      ),
    );
  }

  private async listBuildingSubmissions(sessionId: string): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const account = await this.readAccount(session.playerUuid);
    if (!account) return { status: 403, body: { error: 'member_required' } };

    return responseToStoreResult(
      await listPlayerBuildingSubmissions(
        new Request('https://auth-store.local/building-submissions/mine', { method: 'POST' }),
        this.env,
        account,
      ),
    );
  }

  private async upsertAccount(
    playerUuid: string,
    currentName: string,
    role: string,
  ): Promise<AccountRecord> {
    const now = new Date().toISOString();
    const existing = await this.readAccount(playerUuid);
    const account: AccountRecord = existing
      ? { ...existing, currentName, role, updatedAt: now }
      : { playerUuid, currentName, role, updatedAt: now };
    const writes: Promise<unknown>[] = [
      this.storage.put(accountKey(playerUuid), account),
      this.storage.put(accountNameKey(currentName), account.playerUuid),
    ];
    if (existing && normalizePlayerName(existing.currentName) !== normalizePlayerName(currentName)) {
      writes.push(this.storage.delete(accountNameKey(existing.currentName)));
    }
    await Promise.all(writes);
    this.accountCache.set(account.playerUuid, account);
    return account;
  }

  private async createSession(
    playerUuid: string,
    authMethod: SessionRecord['authMethod'],
  ): Promise<{ sessionId: string; record: SessionRecord }> {
    const sessionId = randomToken(32);
    const now = Date.now();
    const record: SessionRecord = {
      sidHash: await sha256(sessionId),
      playerUuid,
      issuedAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      idleExpiresAt: new Date(now + SESSION_IDLE_SECONDS * 1000).toISOString(),
      absoluteExpiresAt: new Date(now + SESSION_ABSOLUTE_SECONDS * 1000).toISOString(),
      authMethod,
    };
    await this.storage.put(sessionKey(record.sidHash), record);
    this.sessionCache.set(record.sidHash, record, sessionCacheTtlMs(record));
    return { sessionId, record };
  }

  private async readValidSession(sessionId: string): Promise<SessionRecord | null> {
    if (!sessionId) return null;
    const sidHash = await sha256(sessionId);
    let session = this.sessionCache.get(sidHash);
    session ??= (await this.storage.get<SessionRecord>(sessionKey(sidHash))) ?? null;
    if (!session || session.revokedAt || isExpired(session.idleExpiresAt) || isExpired(session.absoluteExpiresAt)) {
      this.sessionCache.delete(sidHash);
      return null;
    }
    const now = Date.now();
    if (now - new Date(session.lastSeenAt).getTime() >= SESSION_TOUCH_INTERVAL_SECONDS * 1000) {
      session.lastSeenAt = new Date(now).toISOString();
      session.idleExpiresAt = new Date(now + SESSION_IDLE_SECONDS * 1000).toISOString();
      await this.storage.put(sessionKey(sidHash), session);
    }
    this.sessionCache.set(sidHash, session, sessionCacheTtlMs(session, now), now);
    return session;
  }

  private async readAccount(playerUuid: string): Promise<AccountRecord | null> {
    let account = this.accountCache.get(playerUuid);
    account ??= (await this.storage.get<AccountRecord>(accountKey(playerUuid))) ?? null;
    if (!account) return null;
    if (!isEligibleRole(account.role)) {
      await Promise.all([
        this.storage.delete(accountKey(playerUuid)),
        this.storage.delete(accountNameKey(account.currentName)),
      ]);
      this.accountCache.delete(playerUuid);
      return null;
    }
    this.accountCache.set(playerUuid, account);
    return account;
  }

  private async accountSummaryBody(account: AccountRecord): Promise<PlayerAccountSummary> {
    return {
      playerUuid: account.playerUuid,
      currentName: account.currentName,
      role: account.role,
      updatedAt: account.updatedAt,
      passkeyCount: (await this.listPasskeys(account.playerUuid)).length,
    };
  }

  private async listPasskeys(playerUuid: string): Promise<PasskeyRecord[]> {
    const cached = this.passkeyCache.get(playerUuid);
    if (cached) {
      return cached;
    }

    const index = await this.storage.list<string>({ prefix: accountPasskeyPrefix(playerUuid) });
    const passkeys = await Promise.all(
      [...index.values()].map((credentialId) => this.storage.get<PasskeyRecord>(passkeyKey(credentialId))),
    );
    const result = passkeys.filter((passkey): passkey is PasskeyRecord => !!passkey && passkey.playerUuid === playerUuid);
    this.passkeyCache.set(playerUuid, result);
    return result;
  }

  private async readMinecraftChallenge(challengeId: string): Promise<Extract<ChallengeRecord, { type: 'minecraft-login' }> | null> {
    const record = await this.storage.get<ChallengeRecord>(challengeKey(challengeId));
    return record?.type === 'minecraft-login' ? record : null;
  }

  private async readWebauthnChallenge(
    type: 'passkey-registration' | 'passkey-authentication',
    challenge?: string,
  ): Promise<Extract<ChallengeRecord, { type: 'passkey-registration' | 'passkey-authentication' }> | null> {
    if (!challenge) return null;
    const record = await this.storage.get<ChallengeRecord>(webauthnChallengeKey(challenge));
    if (!record || record.type !== type) return null;
    if (isExpired(record.expiresAt)) {
      await this.storage.delete(webauthnChallengeKey(challenge));
      return null;
    }
    return record;
  }

  private async fetchPluginChallenge(code: string, consume: boolean): Promise<PluginChallengeResponse> {
    const path = `/api/auth/challenges/${encodeURIComponent(code)}${consume ? '/consume' : ''}`;
    try {
      const response = await this.env.VPC_SERVICE.fetch(new URL(path, this.env.MINECRAFT_SERVER_URL), {
        method: consume ? 'POST' : 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { status: 'not_found' };
      return (await response.json()) as PluginChallengeResponse;
    } catch {
      return { status: 'unavailable' };
    }
  }

  private async fetchPluginPlayer(name: string): Promise<{ uuid: string; name: string } | null> {
    const path = `/api/players/resolve?name=${encodeURIComponent(name)}`;
    try {
      const response = await this.env.VPC_SERVICE.fetch(new URL(path, this.env.MINECRAFT_SERVER_URL), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as PluginPlayerResolveResponse;
      const uuid = asString(payload.player?.uuid).toLowerCase();
      const currentName = asString(payload.player?.name);
      if (!UUID_RE.test(uuid) || !currentName) {
        return null;
      }
      return { uuid, name: currentName };
    } catch {
      return null;
    }
  }

  private async resolvePluginPlayer(name: string): Promise<{ uuid: string; name: string } | null> {
    const cached = this.playerResolveCache.get(name);

    if (cached) {
      return cached;
    }

    const player = await this.fetchPluginPlayer(name);

    if (player) {
      this.playerResolveCache.set(name, player);
      this.playerResolveCache.set(normalizePlayerName(player.name), player);
    }

    return player;
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= Promise.resolve();
    return this.initialized;
  }

  private async cleanupExpiredChallenges(): Promise<void> {
    const now = Date.now();
    if (now - this.lastChallengeCleanupAt < CHALLENGE_CLEANUP_INTERVAL_SECONDS * 1000) {
      return;
    }
    this.lastChallengeCleanupAt = now;

    const [minecraftChallenges, webauthnChallenges] = await Promise.all([
      this.storage.list<ChallengeRecord>({ prefix: 'challenge:' }),
      this.storage.list<ChallengeRecord>({ prefix: 'webauthn:' }),
    ]);

    const deletes: Promise<unknown>[] = [];
    for (const record of minecraftChallenges.values()) {
      if (record.type === 'minecraft-login' && isExpired(record.expiresAt)) {
        deletes.push(this.deleteMinecraftChallenge(record));
      }
    }
    for (const [key, record] of webauthnChallenges.entries()) {
      if (record.type !== 'minecraft-login' && isExpired(record.expiresAt)) {
        deletes.push(this.storage.delete(key));
      }
    }

    await Promise.all(deletes);
  }

  private async deleteMinecraftChallenge(
    record: Extract<ChallengeRecord, { type: 'minecraft-login' }>,
  ): Promise<void> {
    await Promise.all([
      this.storage.delete(challengeKey(record.challengeId)),
      this.storage.delete(codeKey(record.displayCode)),
    ]);
  }

  private consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): { status: number; body: Record<string, unknown> } | null {
    const now = Date.now();
    if (this.rateLimits.size > 2048) {
      for (const [entryKey, record] of this.rateLimits.entries()) {
        if (record.resetAt <= now) {
          this.rateLimits.delete(entryKey);
        }
      }
    }

    const existing = this.rateLimits.get(key);

    if (!existing || existing.resetAt <= now) {
      this.rateLimits.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return null;
    }

    existing.count += 1;
    if (existing.count <= limit) {
      return null;
    }

    return {
      status: 429,
      body: {
        error: 'rate_limited',
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      },
    };
  }
}

function authStore(env: Env): DurableObjectStub {
  const id = env.AUTH_STORE.idFromName(AUTH_STORE_NAME);
  return env.AUTH_STORE.get(id);
}

async function callStore(
  store: DurableObjectStub,
  body: StoreRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await store.fetch('https://auth-store.local/', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return (await response.json()) as { status: number; body: Record<string, unknown> };
}

async function responseToStoreResult(response: Response): Promise<{ status: number; body: unknown }> {
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function isMikwebClientRequest(request: Request, env: Env): boolean {
  const expected = env.MIKWEB_AUTH_CLIENT_SECRET?.trim();
  if (!expected) return false;
  return request.headers.get('X-Mikweb-Auth') === expected;
}

function clientRateLimitKey(request: Request): string {
  return sanitizeRateLimitPart(request.headers.get('X-Mik-Client-Key') ?? 'unknown');
}

function rateLimitKey(action: string, clientKey: string): string {
  return `${action}:${sanitizeRateLimitPart(clientKey)}`;
}

function sanitizeRateLimitPart(value: string): string {
  return value.trim().slice(0, 128).replace(/[^a-zA-Z0-9:._-]/g, '_') || 'unknown';
}

function normalizePlayerName(value: string): string {
  const name = value.trim();
  return /^[a-zA-Z0-9_]{3,16}$/.test(name) ? name.toLowerCase() : '';
}

function setLoginCookie(body: Record<string, unknown>): HeadersInit {
  const nonce = asString(body.browserNonce);
  if (!nonce) return {};
  return {
    'Set-Cookie': `${LOGIN_COOKIE_NAME}=${encodeURIComponent(nonce)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${CHALLENGE_TTL_SECONDS}`,
  };
}

function sessionHeaders(body: Record<string, unknown>): HeadersInit {
  const headers = new Headers();
  const sessionId = optionalString(body.sessionId);
  if (sessionId) {
    headers.append(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_IDLE_SECONDS}`,
    );
  }
  if (body.clearSession) {
    headers.append('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  }
  if (body.clearLogin || sessionId) {
    headers.append('Set-Cookie', `${LOGIN_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  }
  return headers;
}

function sessionBody(sessionId: string, account: AccountRecord): Record<string, unknown> {
  return {
    authenticated: true,
    sessionId,
    clearLogin: true,
    account: {
      playerUuid: account.playerUuid,
      currentName: account.currentName,
      role: account.role,
      updatedAt: account.updatedAt,
    },
  };
}

function stripInternalAuthFields(body: Record<string, unknown>): Record<string, unknown> {
  const {
    browserNonce: _browserNonce,
    sessionId: _sessionId,
    clearLogin: _clearLogin,
    clearSession: _clearSession,
    ...safeBody
  } = body;
  return safeBody;
}

function challengePublicBody(record: Extract<ChallengeRecord, { type: 'minecraft-login' }>): Record<string, unknown> {
  if (record.status === 'confirmed') {
    return {
      status: 'confirmed',
      player: {
        uuid: record.confirmedPlayerUuid,
        name: record.confirmedPlayerName,
        role: record.confirmedRole,
      },
      confirmedAt: record.confirmedAt,
    };
  }
  return { status: record.status, expiresAt: record.expiresAt };
}

function publicSession(session: SessionRecord): Record<string, unknown> {
  return {
    issuedAt: session.issuedAt,
    lastSeenAt: session.lastSeenAt,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    authMethod: session.authMethod,
  };
}

function publicPasskey(passkey: PasskeyRecord): Record<string, unknown> {
  return {
    credentialId: passkey.credentialId,
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt,
    displayName: passkey.displayName,
  };
}

function normalizeRole(raw: unknown): string {
  const role = asString(raw);
  return ALLOWED_ROLES.has(role) ? role : '';
}

function isEligibleRole(raw: unknown): boolean {
  return ALLOWED_ROLES.has(asString(raw));
}

function shouldCheckPlugin(value?: string): boolean {
  return !value || Date.now() - new Date(value).getTime() >= 2000;
}

function isExpired(value: string): boolean {
  return new Date(value).getTime() <= Date.now();
}

function sessionCacheTtlMs(session: SessionRecord, now = Date.now()): number {
  const idleTtl = new Date(session.idleExpiresAt).getTime() - now;
  const absoluteTtl = new Date(session.absoluteExpiresAt).getTime() - now;
  return Math.max(1, Math.min(idleTtl, absoluteTtl, SESSION_TOUCH_INTERVAL_SECONDS * 1000));
}

function createDisplayCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value = new DataView(bytes.buffer).getUint32(0) % 100_000_000;
  return value.toString().padStart(8, '0');
}

function randomToken(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return bufferToBase64url(values);
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bufferToBase64url(new Uint8Array(hash));
}

function bufferToBase64url(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlToBuffer(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBufferBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.byteLength));
  bytes.set(value);
  return bytes;
}

function credentialChallengeId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const response = value as { response?: { clientDataJSON?: string } };
  const clientData = response.response?.clientDataJSON;
  if (!clientData) return undefined;
  try {
    const text = new TextDecoder().decode(base64urlToBuffer(clientData));
    const parsed = JSON.parse(text) as { challenge?: string };
    return parsed.challenge;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function accountKey(playerUuid: string): string {
  return `account:${playerUuid}`;
}

function accountNameKey(name: string): string {
  return `account-name:${normalizePlayerName(name)}`;
}

function challengeKey(challengeId: string): string {
  return `challenge:${challengeId}`;
}

function codeKey(code: string): string {
  return `code:${code}`;
}

function sessionKey(sidHash: string): string {
  return `session:${sidHash}`;
}

function passkeyKey(credentialId: string): string {
  return `passkey:${credentialId}`;
}

function accountPasskeyPrefix(playerUuid: string): string {
  return `account-passkey:${playerUuid}:`;
}

function accountPasskeyKey(playerUuid: string, credentialId: string): string {
  return `${accountPasskeyPrefix(playerUuid)}${credentialId}`;
}

function webauthnChallengeKey(challenge: string): string {
  return `webauthn:${challenge}`;
}
