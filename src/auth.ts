import { BuildingStore } from './building-store';
import { migrateBuildingCatalog } from './building-migration';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import type { Env } from './env';
import { AUTH_STORE_NAME } from './constants';
import {
  createPlayerBuildingSubmission,
  handleAdminBuildingsRouteDirect,
  listPlayerBuildingSubmissions,
} from './buildings';
import { authJson } from './http';
import { TtlMemoryCache } from './memory-cache';

const SESSION_COOKIE_NAME = '__Host-mik_sid';
const LOGIN_COOKIE_NAME = '__Host-mik_login';
const SESSION_IDLE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 90;
const SESSION_TOUCH_INTERVAL_SECONDS = 60 * 10;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_CLEANUP_INTERVAL_SECONDS = 5 * 60;
const RECENT_AUTH_SECONDS = 5 * 60;
const MAX_PASSKEYS_PER_ACCOUNT = 16;
const ACCOUNT_CACHE_TTL_MS = 60 * 1000;
const PASSKEY_CACHE_TTL_MS = 60 * 1000;
const PLAYER_RESOLVE_CACHE_TTL_MS = 60 * 1000;
const MAX_AUTH_BODY_BYTES = 64 * 1024;
const AUTH_RATE_LIMIT_WINDOW_SECONDS = 60;
const AUTH_RATE_LIMIT_RETRY_SECONDS = 10;
const WEB_LOGIN_CODE_RE = /^[0-9]{6,10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = new Set(['default', 'member', 'moderator', 'custodian']);
const DEFAULT_WEBAUTHN_RP_ID = 'mcmik.top';
const DEFAULT_WEBAUTHN_ORIGIN = 'https://mcmik.top';
const RP_NAME = 'Mik Casual';
class BuildingCatalogUnavailableError extends Error {}

type AuthRouteResult = Response | null;

interface PlayerAccountSummary {
  playerUuid: string;
  currentName: string;
  role: string;
  updatedAt: string;
  passkeyCount: number;
}

interface PluginChallengeResponse {
  status: 'confirmed' | 'pending' | 'expired' | 'not_found' | 'consumed' | 'unavailable' | 'banned';
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
  authenticatedAt: string;
  displayName?: string;
}

interface AccountRecord {
  playerUuid: string;
  currentName: string;
  updatedAt: string;
  role: string;
  disabledAt?: string;
  banned?: boolean;
  credentialsChangedAt?: number;
}

interface PasskeyRecord {
  credentialId: string;
  playerUuid: string;
  publicKey: string;
  counter: number;
  transports?: WebAuthnCredential['transports'];
  createdAt: string;
  lastUsedAt?: string;
  displayName?: string;
}

type AuthenticationContext =
  | { purpose: 'login'; browserNonceHash: string }
  | { purpose: 'reauthenticate'; playerUuid: string; sessionHash: string };

interface ChallengeLifetime {
  createdAt: string;
  expiresAt: string;
}

type ChallengeRecord =
  | (ChallengeLifetime & {
      type: 'minecraft-authentication';
      context: AuthenticationContext;
      challengeId: string;
      displayCode: string;
      status: 'pending' | 'confirmed' | 'consumed' | 'expired';
      confirmedPlayerUuid?: string;
      confirmedPlayerName?: string;
      confirmedRole?: string;
      confirmedAt?: string;
      lastPluginCheckAt?: string;
    })
  | (ChallengeLifetime & {
      type: 'passkey-authentication';
      context: AuthenticationContext;
      challenge: string;
    })
  | (ChallengeLifetime & {
      type: 'passkey-registration';
      playerUuid: string;
      sessionHash: string;
      challenge: string;
    });

type MinecraftChallenge = Extract<ChallengeRecord, { type: 'minecraft-authentication' }>;
type StoreResult = { status: number; body: Record<string, unknown> };

function activeSession(session: SessionRecord | undefined | null): session is SessionRecord {
  if (!session || typeof session.authenticatedAt !== 'string') return false;
  const authenticatedAt = Date.parse(session.authenticatedAt);
  return (
    Number.isFinite(authenticatedAt) &&
    authenticatedAt <= Date.now() + 5000 &&
    !isExpired(session.idleExpiresAt) &&
    !isExpired(session.absoluteExpiresAt)
  );
}

function eligibleAccount(account: AccountRecord | undefined | null): account is AccountRecord {
  return !!account && !account.disabledAt && !account.banned && isEligibleRole(account.role);
}

function eligibleMemberAccount(account: AccountRecord | undefined | null): account is AccountRecord {
  return eligibleAccount(account) && account.role !== 'default';
}

function sameAuthenticationContext(
  left: AuthenticationContext,
  right: AuthenticationContext,
): boolean {
  if (left?.purpose === 'login' && right?.purpose === 'login')
    return left.browserNonceHash === right.browserNonceHash;
  return (
    left?.purpose === 'reauthenticate' &&
    right?.purpose === 'reauthenticate' &&
    left.playerUuid === right.playerUuid &&
    left.sessionHash === right.sessionHash
  );
}

function recentlyAuthenticated(session: SessionRecord): boolean {
  const time = Date.parse(session.authenticatedAt);
  return (
    Number.isFinite(time) &&
    time <= Date.now() + 5000 &&
    Date.now() - time < RECENT_AUTH_SECONDS * 1000
  );
}

function reauthenticationRequired(): StoreResult {
  return { status: 403, body: { error: 'reauthentication_required' } };
}

function validBrowserNonce(value: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(value);
}

function validConfirmationTime(record: MinecraftChallenge, value?: string): boolean {
  const time = Date.parse(value ?? '');
  return (
    Number.isFinite(time) &&
    time >= Date.parse(record.createdAt) - 5000 &&
    time <= Date.now() + 5000 &&
    time < Date.parse(record.expiresAt)
  );
}

function minecraftChallengeError(
  record: MinecraftChallenge | undefined | null,
): StoreResult | null {
  if (!record) return { status: 404, body: { error: 'not_found' } };
  if (isExpired(record.expiresAt)) return { status: 410, body: { error: 'expired' } };
  if (record.status === 'consumed') return { status: 409, body: { error: 'challenge_consumed' } };
  return null;
}

class PluginUnavailableError extends Error {}

interface StoreRequest {
  action: string;
  [key: string]: unknown;
}

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

interface AuthRateLimitCheck {
  limiter: RateLimit;
  key: string;
}

function isAllowedAuthRoute(path: string, method: string): boolean {
  if (method === 'GET') return /^\/auth\/challenges\/[A-Za-z0-9_-]{24}$/.test(path);
  if (method === 'PATCH') {
    return (
      /^\/auth\/passkeys\/[A-Za-z0-9_-]{1,2048}$/.test(path) ||
      /^\/me\/sessions\/[A-Za-z0-9_-]{43}$/.test(path)
    );
  }
  if (method === 'DELETE') return /^\/auth\/passkeys\/[A-Za-z0-9_-]{1,2048}$/.test(path);
  if (method !== 'POST') return false;
  return (
    new Set([
      '/auth/challenges',
      '/auth/me',
      '/auth/logout',
      '/auth/passkeys/options/register',
      '/auth/passkeys/register',
      '/auth/passkeys/options/authenticate',
      '/auth/passkeys/authenticate',
      '/me/security',
      '/me/sessions/revoke',
      '/me/players/resolve',
      '/me/chat/authorize',
      '/me/building-submissions',
      '/me/building-submissions/mine',
      '/me/images/reserve',
      '/me/images/complete',
    ]).has(path) || /^\/auth\/challenges\/[A-Za-z0-9_-]{24}\/complete$/.test(path)
  );
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
  if (!isAllowedAuthRoute(routePath, request.method)) {
    return authJson({ error: 'not_found' }, 404);
  }

  const clientKey = clientRateLimitKey(request);
  const rateLimited = await enforceAuthRateLimits(routePath, request.method, clientKey, env);
  if (rateLimited) return rateLimited;
  const store = authStore(env);
  const sessionId = request.headers.get('X-Mik-Session') ?? '';
  const browserNonce = request.headers.get('X-Mik-Browser-Nonce') ?? '';

  if (routePath === '/auth/challenges' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'createMinecraftChallenge',
      purpose: payload.data.purpose,
      sessionId,
      clientKey,
      browserNonce,
    });
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      setLoginCookie(response.body),
    );
  }

  const challengeStatus = routePath.match(/^\/auth\/challenges\/([^/]+)$/);
  if (challengeStatus && request.method === 'GET') {
    const response = await callStore(store, {
      action: 'getMinecraftChallenge',
      sessionId,
      challengeId: challengeStatus[1],
      browserNonce,
      clientKey,
    });
    return authJson(response.body, response.status);
  }

  const challengeComplete = routePath.match(/^\/auth\/challenges\/([^/]+)\/complete$/);
  if (challengeComplete && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'completeMinecraftChallenge',
      sessionId,
      challengeId: challengeComplete[1],
      browserNonce,
      clientKey,
    });
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  if (routePath === '/auth/me' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, { action: 'me', sessionId });
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  if (routePath === '/me/chat/authorize' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'authorizeWebChat',
      sessionId,
      connectionId: payload.data.connectionId,
      clientPublicKey: payload.data.clientPublicKey,
    });
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  if (routePath === '/auth/logout' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'logout',
      sessionId,
    });
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  if (routePath === '/auth/passkeys/options/register' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'passkeyRegistrationOptions',
      sessionId,
    });
    return authJson(response.body, response.status);
  }

  if (routePath === '/auth/passkeys/register' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'passkeyRegister',
      sessionId,
      credential: payload.data.credential,
      displayName: payload.data.displayName,
    });
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  if (routePath === '/auth/passkeys/options/authenticate' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'passkeyAuthenticationOptions',
      purpose: payload.data.purpose,
      sessionId,
      clientKey,
      browserNonce,
    });
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      setLoginCookie(response.body),
    );
  }

  if (routePath === '/auth/passkeys/authenticate' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'passkeyAuthenticate',
      sessionId,
      credential: payload.data.credential,
      browserNonce,
      clientKey,
    });
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  const passkeyResource = routePath.match(/^\/auth\/passkeys\/([^/]+)$/);
  const sessionResource = routePath.match(/^\/me\/sessions\/([A-Za-z0-9_-]{43})$/);
  const renameTarget = passkeyResource ?? sessionResource;
  if (request.method === 'PATCH' && renameTarget) {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'renameSecurityItem',
      kind: passkeyResource ? 'passkey' : 'session',
      targetId: renameTarget[1],
      displayName: payload.data.displayName,
      sessionId,
    });
    return authJson(response.body, response.status);
  }
  if (passkeyResource && request.method === 'DELETE') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'passkeyDelete',
      credentialId: passkeyResource[1],
      sessionId,
    });
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/security' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'accountSecurity',
      sessionId,
    });
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/sessions/revoke' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'revokeAccountSession',
      sessionId,
      targetSessionId: payload.data.targetSessionId,
      all: payload.data.all === true,
    });
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  if (routePath === '/me/players/resolve' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'resolvePlayer',
      sessionId,
      name: payload.data.name,
    });
    return authJson(response.body, response.status);
  }

  if (
    (routePath === '/me/images/reserve' || routePath === '/me/images/complete') &&
    request.method === 'POST'
  ) {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: routePath.endsWith('/reserve') ? 'reserveImageUpload' : 'completeImageUpload',
      sessionId,
      uploadId: payload.data.uploadId,
      image: payload.data.image,
    });
    return authJson(
      response.body,
      response.status,
      typeof (response.body as { retryAfter?: unknown }).retryAfter === 'number'
        ? { 'Retry-After': String((response.body as { retryAfter: number }).retryAfter) }
        : {},
    );
  }

  if (routePath === '/me/building-submissions' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'createBuildingSubmission',
      sessionId,
      payload: payload.data,
    });
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/building-submissions/mine' && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: 'listBuildingSubmissions',
      sessionId,
    });
    return authJson(response.body, response.status);
  }

  return authJson({ error: 'not_found' }, 404);
}

async function enforceAuthRateLimits(
  routePath: string,
  method: string,
  clientKey: string,
  env: Env,
): Promise<Response | null> {
  const checks: AuthRateLimitCheck[] = [];
  const action = authSensitiveAction(routePath, method);

  if (routePath === '/auth/challenges' && method === 'POST') {
    checks.push({ limiter: env.AUTH_CHALLENGE_CREATE_RATE_LIMITER, key: clientKey });
  } else if (action) {
    checks.push({ limiter: env.AUTH_SENSITIVE_RATE_LIMITER, key: `${action}:${clientKey}` });
  }

  checks.push({ limiter: env.AUTH_CLIENT_RATE_LIMITER, key: clientKey });

  try {
    for (const check of checks) {
      const { success } = await check.limiter.limit({ key: check.key });
      if (!success) {
        return authJson(
          { error: 'rate_limited', retryAfterSeconds: AUTH_RATE_LIMIT_WINDOW_SECONDS },
          429,
          { 'Retry-After': String(AUTH_RATE_LIMIT_WINDOW_SECONDS) },
        );
      }
    }
  } catch (error) {
    console.error('Auth rate limit check failed', { routePath, method, error });
    return authJson({ error: 'rate_limiter_unavailable' }, 503, {
      'Retry-After': String(AUTH_RATE_LIMIT_RETRY_SECONDS),
    });
  }

  return null;
}

function authSensitiveAction(routePath: string, method: string): string | null {
  if (method === 'PATCH') return 'security:rename';
  if (method !== 'POST') return null;
  if (/^\/auth\/challenges\/[^/]+\/complete$/.test(routePath)) {
    return 'minecraft-challenge:complete';
  }
  if (routePath === '/auth/passkeys/options/authenticate') {
    return 'passkey-authentication:create';
  }
  if (routePath === '/auth/passkeys/authenticate') {
    return 'passkey-authentication:complete';
  }
  return null;
}

export class AuthStore implements DurableObject {
  private readonly storage: DurableObjectStorage;
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly rateLimits = new TtlMemoryCache<RateLimitRecord>({
    defaultTtlMs: AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000,
    maxEntries: 2048,
  });
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
  private readonly accountReads = new Map<string, Promise<AccountRecord | null>>();
  private lastChallengeCleanupAt = 0;
  private initialized: Promise<void> | null = null;
  private catalogReady: Promise<void> | null = null;
  private catalogRetryAt = 0;
  private readonly buildings: BuildingStore;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.buildings = new BuildingStore(this.storage);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();
    let body: StoreRequest;

    try {
      const text = await readLimitedRequestText(request);
      body = (text.trim() ? JSON.parse(text) : {}) as StoreRequest;
    } catch (error) {
      return json({
        status: error instanceof RequestBodyTooLargeError ? 413 : 400,
        body: {
          error:
            error instanceof RequestBodyTooLargeError
              ? 'request_body_too_large'
              : 'invalid_json_body',
        },
      });
    }

    try {
      return json(await this.dispatch(body));
    } catch (error) {
      if (error instanceof BuildingCatalogUnavailableError) {
        return json({ status: 503, body: { error: 'building_data_unavailable' } });
      }
      if (error instanceof PluginUnavailableError) {
        return json({ status: 503, body: { error: 'plugin_unavailable' } });
      }
      console.error('AuthStore error', error);
      return json({ status: 500, body: { error: 'internal_error' } });
    }
  }

  private async dispatch(body: StoreRequest): Promise<{ status: number; body: unknown }> {
    switch (body.action) {
      case 'createMinecraftChallenge':
        return this.createMinecraftChallenge(
          asString(body.clientKey),
          asString(body.browserNonce),
          body.purpose,
          asString(body.sessionId),
        );
      case 'getMinecraftChallenge':
        return this.getMinecraftChallenge(
          asString(body.challengeId),
          asString(body.clientKey),
          asString(body.browserNonce),
          asString(body.sessionId),
        );
      case 'completeMinecraftChallenge':
        return this.completeMinecraftChallenge(
          asString(body.challengeId),
          asString(body.browserNonce),
          asString(body.clientKey),
          asString(body.sessionId),
        );
      case 'me':
        return this.me(asString(body.sessionId));
      case 'logout':
        return this.logout(asString(body.sessionId));
      case 'passkeyRegistrationOptions':
        return this.passkeyRegistrationOptions(asString(body.sessionId));
      case 'passkeyRegister':
        return this.passkeyRegister(
          asString(body.sessionId),
          body.credential,
          body.displayName,
        );
      case 'passkeyAuthenticationOptions':
        return this.passkeyAuthenticationOptions(
          asString(body.clientKey),
          asString(body.browserNonce),
          body.purpose,
          asString(body.sessionId),
        );
      case 'passkeyAuthenticate':
        return this.passkeyAuthenticate(
          body.credential,
          asString(body.clientKey),
          asString(body.browserNonce),
          asString(body.sessionId),
        );
      case 'passkeyDelete':
        return this.passkeyDelete(asString(body.sessionId), asString(body.credentialId));
      case 'accountSecurity':
        return this.accountSecurity(asString(body.sessionId));
      case 'renameSecurityItem':
        return this.renameSecurityItem(
          asString(body.sessionId),
          body.kind,
          asString(body.targetId),
          body.displayName,
        );
      case 'revokeAccountSession':
        return this.revokeAccountSession(
          asString(body.sessionId),
          asString(body.targetSessionId),
          body.all === true,
        );
      case 'authorizeWebChat':
        return this.authorizeWebChat(
          asString(body.sessionId),
          asString(body.connectionId),
          asString(body.clientPublicKey),
        );
      case 'resolvePlayer':
        return this.resolvePlayer(asString(body.sessionId), asString(body.name));
      case 'reserveImageUpload':
        return this.imageUpload(asString(body.sessionId));
      case 'completeImageUpload':
        return this.imageUpload(asString(body.sessionId), asString(body.uploadId), body.image);
      case 'createBuildingSubmission':
        return this.createBuildingSubmission(asString(body.sessionId), body.payload);
      case 'listBuildingSubmissions':
        return this.listBuildingSubmissions(asString(body.sessionId));
      case 'adminBuildingMutation':
        await this.ensureBuildingCatalog();
        return this.adminBuildingMutation(body);
      case 'publicBuildingSnapshot':
        await this.ensureBuildingCatalog();
        this.buildings.requestPublication();
        await this.scheduleMaintenance();
        return { status: 200, body: this.buildings.snapshot() };
      default:
        return { status: 404, body: { error: 'not_found' } };
    }
  }

  private async adminBuildingMutation(
    body: StoreRequest,
  ): Promise<{ status: number; body: unknown }> {
    return this.storage.transaction(async () => {
      const result = await this.runAdminBuildingMutation(body);
      if (result.status < 400) await this.scheduleMaintenance();
      return result;
    });
  }

  private async runAdminBuildingMutation(
    body: StoreRequest,
  ): Promise<{ status: number; body: unknown }> {
    const routePath = asString(body.routePath);
    const method = asString(body.method) || 'GET';
    const url = asString(body.url) || `https://data.mcmik.top/admin/api${routePath}`;
    const headers = new Headers();
    const rawHeaders = body.headers;

    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (typeof value === 'string') {
          headers.set(key, value);
        }
      }
    }

    const request = new Request(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : asString(body.requestBody),
    });
    const actor = adminActorFromStoreBody(body.actor);
    return responseToStoreResult(
      await handleAdminBuildingsRouteDirect(
        routePath,
        request,
        { ...this.env, buildingStore: this.buildings },
        actor,
      ),
    );
  }

  private async createAuthenticationContext(
    purpose: unknown,
    previousNonce: string,
    sessionId: string,
  ): Promise<{ context: AuthenticationContext; browser?: { browserNonce: string } } | StoreResult> {
    if (purpose === 'login') {
      const browserNonce = validBrowserNonce(previousNonce) ? previousNonce : randomToken(24);
      return {
        context: { purpose, browserNonceHash: await sha256(browserNonce) },
        browser: { browserNonce },
      };
    }
    if (purpose !== 'reauthenticate')
      return { status: 422, body: { error: 'invalid_authentication_purpose' } };
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    return { context: { purpose, playerUuid: session.playerUuid, sessionHash: session.sidHash } };
  }

  private async checkAuthenticationContext(
    context: AuthenticationContext,
    browserNonce: string,
    sessionId: string,
  ): Promise<StoreResult | null> {
    if (context?.purpose === 'login') {
      return browserNonce && context.browserNonceHash === (await sha256(browserNonce))
        ? null
        : { status: 403, body: { error: 'invalid_browser_nonce' } };
    }
    if (context?.purpose !== 'reauthenticate')
      return { status: 400, body: { error: 'invalid_challenge' } };
    const session = await this.readValidSession(sessionId);
    return session &&
      session.sidHash === context.sessionHash &&
      session.playerUuid === context.playerUuid
      ? null
      : { status: 401, body: { error: 'unauthenticated' } };
  }

  private async storeAuthenticatedSession(
    txn: DurableObjectTransaction,
    context: AuthenticationContext,
    session: { sessionId: string; record: SessionRecord },
  ): Promise<StoreResult | null> {
    const playerUuid = session.record.playerUuid;
    const account = await txn.get<AccountRecord>(accountKey(playerUuid));
    if (
      account?.disabledAt ||
      Date.parse(session.record.authenticatedAt) <= (account?.credentialsChangedAt ?? 0)
    )
      return { status: 403, body: { error: 'authentication_invalidated' } };
    if (context.purpose === 'reauthenticate') {
      if (context.playerUuid !== playerUuid)
        return { status: 403, body: { error: 'account_mismatch' } };
      if (!(await this.sessionStillActive(txn, { sidHash: context.sessionHash, playerUuid })))
        return { status: 401, body: { error: 'unauthenticated' } };
      const previous = await txn.get<SessionRecord>(sessionKey(context.sessionHash));
      session.record.displayName = previous?.displayName;
      await txn.delete([
        sessionKey(context.sessionHash),
        accountSessionKey(playerUuid, context.sessionHash),
      ]);
    }
    await this.pruneAccountSessions(txn, playerUuid);
    await txn.put({
      [sessionKey(session.record.sidHash)]: session.record,
      [accountSessionKey(playerUuid, session.record.sidHash)]: session.record.sidHash,
    });
    return null;
  }

  private authenticationCommitted(context: AuthenticationContext): void {
    if (context.purpose !== 'reauthenticate') return;
    this.sessionCache.delete(context.sessionHash);
    this.state.waitUntil(this.notifyChatRevocation([context.sessionHash]));
  }

  private async createMinecraftChallenge(
    clientKey: string,
    previousNonce: string,
    purpose: unknown,
    sessionId: string,
  ): Promise<StoreResult> {
    const rateLimited = this.consumeRateLimit(
      rateLimitKey('minecraft-challenge:create', clientKey),
      8,
      60,
    );
    if (rateLimited) return rateLimited;
    await this.cleanupExpiredChallenges();
    const binding = await this.createAuthenticationContext(purpose, previousNonce, sessionId);
    if ('status' in binding) return binding;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const challengeId = randomToken(18);
      const displayCode = createDisplayCode();
      const record: MinecraftChallenge = {
        type: 'minecraft-authentication',
        challengeId,
        displayCode,
        context: binding.context,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
        status: 'pending',
      };
      const created = await this.storage.transaction(async (txn) => {
        if (await txn.get(codeKey(displayCode))) return false;
        await txn.put({ [challengeKey(challengeId)]: record, [codeKey(displayCode)]: challengeId });
        return true;
      });
      if (created)
        return {
          status: 200,
          body: { challengeId, displayCode, ...binding.browser, expiresAt: record.expiresAt },
        };
    }
    return { status: 503, body: { error: 'challenge_unavailable' } };
  }

  private async getMinecraftChallenge(
    challengeId: string,
    clientKey: string,
    browserNonce: string,
    sessionId: string,
  ): Promise<StoreResult> {
    const rateLimited = this.consumeRateLimit(
      rateLimitKey('minecraft-challenge:status', clientKey),
      60,
      60,
    );
    if (rateLimited) return rateLimited;
    let record = await this.readMinecraftChallenge(challengeId);
    if (!record) return { status: 404, body: { status: 'not_found' } };
    const bindingError = await this.checkAuthenticationContext(
      record.context,
      browserNonce,
      sessionId,
    );
    if (bindingError) return bindingError;
    if (isExpired(record.expiresAt)) {
      await this.deleteMinecraftChallenge(record);
      return { status: 200, body: { status: 'expired' } };
    }
    if (record.status === 'pending' && shouldCheckPlugin(record.lastPluginCheckAt)) {
      // Reserve the poll before network I/O; concurrent polls cannot multiply plugin requests.
      const claimed = await this.storage.transaction(async (txn) => {
        const current = await txn.get<MinecraftChallenge>(challengeKey(challengeId));
        if (
          !current ||
          current.status !== 'pending' ||
          !shouldCheckPlugin(current.lastPluginCheckAt)
        )
          return false;
        await txn.put(challengeKey(challengeId), {
          ...current,
          lastPluginCheckAt: new Date().toISOString(),
        });
        return true;
      });
      if (claimed) {
        const plugin = await this.fetchPluginChallenge(record.displayCode);
        if (plugin.status === 'unavailable')
          return { status: 503, body: { error: 'plugin_unavailable' } };
        if (plugin.status === 'banned')
          return { status: 403, body: { error: 'account_banned' } };
        const player = normalizePluginPlayer(plugin.player);
        const role = normalizeRole(plugin.player?.role);
        await this.storage.transaction(async (txn) => {
          const current = await txn.get<MinecraftChallenge>(challengeKey(challengeId));
          if (!current || current.status !== 'pending' || isExpired(current.expiresAt)) return;
          if (
            plugin.status === 'confirmed' &&
            player &&
            role &&
            validConfirmationTime(current, plugin.confirmedAt)
          ) {
            await txn.put(challengeKey(challengeId), {
              ...current,
              status: 'confirmed',
              confirmedPlayerUuid: player.uuid,
              confirmedPlayerName: player.name,
              confirmedRole: role,
              confirmedAt: plugin.confirmedAt,
            });
          }
        });
      }
      record = await this.readMinecraftChallenge(challengeId);
    }
    return { status: 200, body: record ? challengePublicBody(record) : { status: 'not_found' } };
  }

  private async completeMinecraftChallenge(
    challengeId: string,
    browserNonce: string,
    clientKey: string,
    sessionId: string,
  ): Promise<StoreResult> {
    const rateLimited = this.consumeRateLimit(
      rateLimitKey('minecraft-challenge:complete', clientKey),
      20,
      60,
    );
    if (rateLimited) return rateLimited;
    const record = await this.readMinecraftChallenge(challengeId);
    const rejected = minecraftChallengeError(record);
    if (rejected) return rejected;
    if (!record) return { status: 404, body: { error: 'not_found' } };
    const bindingError = await this.checkAuthenticationContext(
      record.context,
      browserNonce,
      sessionId,
    );
    if (bindingError) return bindingError;

    // Approvals remain readable until expiry. Only this store consumes an authentication request.
    const plugin = await this.fetchPluginChallenge(record.displayCode);
    if (plugin.status === 'unavailable')
      return { status: 503, body: { error: 'plugin_unavailable' } };
    if (plugin.status === 'banned')
      return { status: 403, body: { error: 'account_banned' } };
    const player = normalizePluginPlayer(plugin.player);
    const role = normalizeRole(plugin.player?.role);
    if (plugin.status !== 'confirmed')
      return { status: 409, body: { error: 'confirmation_required' } };
    if (!player) return { status: 502, body: { error: 'plugin_invalid_response' } };
    if (!role) return { status: 502, body: { error: 'plugin_invalid_response' } };
    if (!validConfirmationTime(record, plugin.confirmedAt))
      return { status: 409, body: { error: 'invalid_confirmation' } };
    const session = await this.prepareSession(
      player.uuid,
      'minecraft-challenge',
      plugin.confirmedAt,
    );
    const result = await this.storage.transaction(async (txn): Promise<StoreResult> => {
      const current = await txn.get<MinecraftChallenge>(challengeKey(challengeId));
      const invalid = minecraftChallengeError(current);
      if (invalid) return invalid;
      if (
        !current ||
        !sameAuthenticationContext(current.context, record.context) ||
        (current.confirmedPlayerUuid && current.confirmedPlayerUuid !== player.uuid)
      ) {
        return { status: 409, body: { error: 'confirmation_changed' } };
      }
      const existing = await txn.get<AccountRecord>(accountKey(player.uuid));
      if (existing?.disabledAt) return { status: 403, body: { error: 'account_disabled' } };
      const account: AccountRecord = {
        ...existing,
        playerUuid: player.uuid,
        currentName: player.name,
        role,
        banned: false,
        updatedAt: new Date().toISOString(),
      };
      const sessionError = await this.storeAuthenticatedSession(txn, record.context, session);
      if (sessionError) return sessionError;
      await txn.put({
        [accountKey(player.uuid)]: account,
        [accountNameKey(player.name)]: player.uuid,
        [challengeKey(challengeId)]: { ...current, status: 'consumed' },
      });
      await txn.delete(codeKey(current.displayCode));
      if (
        existing &&
        normalizePlayerName(existing.currentName) !== normalizePlayerName(player.name)
      ) {
        await txn.delete(accountNameKey(existing.currentName));
      }
      return {
        status: 200,
        body: sessionBody(
          session.sessionId,
          account,
          (await txn.list({ prefix: accountPasskeyPrefix(account.playerUuid) })).size,
        ),
      };
    });
    if (result.status === 200) {
      this.accountCache.delete(player.uuid);
      this.authenticationCommitted(record.context);
    }
    return result;
  }

  private async me(sessionId: string): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 200, body: { authenticated: false, clearSession: true } };
    const account = await this.readAccount(session.playerUuid);
    if (!account) return { status: 200, body: { authenticated: false, clearSession: true } };
    return {
      status: 200,
      body: { authenticated: true, account: await this.accountSummaryBody(account) },
    };
  }

  private async logout(sessionId: string): Promise<StoreResult> {
    const sidHash = await sha256(sessionId);
    await this.storage.transaction(async (txn) => {
      const session = await txn.get<SessionRecord>(sessionKey(sidHash));
      if (session)
        await txn.delete([sessionKey(sidHash), accountSessionKey(session.playerUuid, sidHash)]);
    });
    this.sessionCache.delete(sidHash);
    if (sessionId) this.state.waitUntil(this.notifyChatRevocation([sidHash]));
    return { status: 200, body: { ok: true, clearSession: true } };
  }

  private async passkeyRegistrationOptions(sessionId: string): Promise<StoreResult> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    if (!recentlyAuthenticated(session)) return reauthenticationRequired();
    const limited = this.consumeRateLimit(
      rateLimitKey('passkey-registration:create', session.sidHash),
      8,
      60,
    );
    if (limited) return limited;
    const account = await this.loadAccount(session.playerUuid);
    if (!account) return { status: 403, body: { error: 'authentication_invalidated' } };
    await this.cleanupExpiredChallenges();
    const passkeys = await this.listPasskeys(account.playerUuid);
    if (passkeys.length >= MAX_PASSKEYS_PER_ACCOUNT)
      return { status: 409, body: { error: 'passkey_limit' } };
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: webAuthnConfig(this.env).rpID,
      userName: account.currentName,
      userID: toArrayBufferBytes(new TextEncoder().encode(account.playerUuid)),
      userDisplayName: account.currentName,
      attestationType: 'none',
      excludeCredentials: passkeys.map(({ credentialId: id, transports }) => ({ id, transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challenge: ChallengeRecord = {
      type: 'passkey-registration',
      playerUuid: account.playerUuid,
      sessionHash: session.sidHash,
      challenge: options.challenge,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    };
    return this.storage.transaction(async (txn): Promise<StoreResult> => {
      const current = await txn.get<SessionRecord>(sessionKey(session.sidHash));
      if (!current || !(await this.sessionStillActive(txn, session)))
        return { status: 401, body: { error: 'unauthenticated' } };
      if (!recentlyAuthenticated(current)) return reauthenticationRequired();
      await txn.put(webauthnChallengeKey(options.challenge), challenge);
      return { status: 200, body: { options } };
    });
  }

  private async passkeyRegister(
    sessionId: string,
    credential: unknown,
    displayName: unknown,
  ): Promise<StoreResult> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const name = securityDisplayName(displayName === undefined ? '' : displayName);
    if (name === null) return { status: 422, body: { error: 'invalid_display_name' } };
    const challenge = await this.readWebauthnChallenge(
      'passkey-registration',
      credentialChallengeId(credential),
    );
    if (
      !challenge ||
      challenge.playerUuid !== session.playerUuid ||
      challenge.sessionHash !== session.sidHash
    ) {
      return { status: 400, body: { error: 'invalid_challenge' } };
    }
    const verification = await verifyPasskeyRegistration(
      credential,
      challenge.challenge,
      webAuthnConfig(this.env),
    );
    if (!verification.verified || !verification.registrationInfo)
      return { status: 400, body: { error: 'passkey_verification_failed' } };
    const account = await this.loadAccount(session.playerUuid);
    if (!account) return { status: 403, body: { error: 'authentication_invalidated' } };
    const verifiedCredential = verification.registrationInfo.credential;
    const record: PasskeyRecord = {
      credentialId: verifiedCredential.id,
      playerUuid: session.playerUuid,
      publicKey: bufferToBase64url(verifiedCredential.publicKey),
      counter: verifiedCredential.counter,
      transports: verifiedCredential.transports,
      createdAt: new Date().toISOString(),
      displayName: name || undefined,
    };
    const result = await this.storage.transaction(async (txn): Promise<StoreResult> => {
      if (!(await this.sessionStillActive(txn, session)))
        return { status: 401, body: { error: 'unauthenticated' } };
      const currentAccount = await txn.get<AccountRecord>(accountKey(session.playerUuid));
      if (!eligibleAccount(currentAccount))
        return { status: 403, body: { error: 'authentication_invalidated' } };
      const current = await txn.get<ChallengeRecord>(webauthnChallengeKey(challenge.challenge));
      if (
        !current ||
        current.type !== 'passkey-registration' ||
        isExpired(current.expiresAt) ||
        current.sessionHash !== session.sidHash ||
        current.playerUuid !== session.playerUuid
      ) {
        return { status: 400, body: { error: 'invalid_challenge' } };
      }
      if (await txn.get(passkeyKey(record.credentialId)))
        return { status: 409, body: { error: 'passkey_already_registered' } };
      const keys = await txn.list({ prefix: accountPasskeyPrefix(record.playerUuid) });
      if (keys.size >= MAX_PASSKEYS_PER_ACCOUNT)
        return { status: 409, body: { error: 'passkey_limit' } };
      await txn.put({
        [passkeyKey(record.credentialId)]: record,
        [accountPasskeyKey(record.playerUuid, record.credentialId)]: record.credentialId,
      });
      await txn.delete(webauthnChallengeKey(challenge.challenge));
      return { status: 200, body: { ok: true } };
    });
    this.passkeyCache.delete(session.playerUuid);
    // Registration is not a new authentication and must not refresh authentication time.
    return result;
  }

  private async passkeyAuthenticationOptions(
    clientKey: string,
    previousNonce: string,
    purpose: unknown,
    sessionId: string,
  ): Promise<StoreResult> {
    const rateLimited = this.consumeRateLimit(
      rateLimitKey('passkey-authentication:create', clientKey),
      20,
      60,
    );
    if (rateLimited) return rateLimited;
    await this.cleanupExpiredChallenges();
    const binding = await this.createAuthenticationContext(purpose, previousNonce, sessionId);
    if ('status' in binding) return binding;
    const allowed =
      binding.context.purpose === 'reauthenticate'
        ? (await this.listPasskeys(binding.context.playerUuid)).map(
            ({ credentialId: id, transports }) => ({ id, transports }),
          )
        : undefined;
    if (allowed?.length === 0) return { status: 409, body: { error: 'passkey_unavailable' } };
    const options = await generateAuthenticationOptions({
      rpID: webAuthnConfig(this.env).rpID,
      userVerification: 'required',
      allowCredentials: allowed,
    });
    await this.storage.put(webauthnChallengeKey(options.challenge), {
      type: 'passkey-authentication',
      context: binding.context,
      challenge: options.challenge,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    } satisfies ChallengeRecord);
    return { status: 200, body: { options, ...binding.browser } };
  }

  private async passkeyAuthenticate(
    credential: unknown,
    clientKey: string,
    browserNonce: string,
    sessionId: string,
  ): Promise<StoreResult> {
    const rateLimited = this.consumeRateLimit(
      rateLimitKey('passkey-authentication:complete', clientKey),
      20,
      60,
    );
    if (rateLimited) return rateLimited;
    if (
      !credential ||
      typeof credential !== 'object' ||
      !('id' in credential) ||
      typeof credential.id !== 'string'
    ) {
      return { status: 400, body: { error: 'passkey_verification_failed' } };
    }
    const response = credential as AuthenticationResponseJSON;
    const challenge = await this.readWebauthnChallenge(
      'passkey-authentication',
      credentialChallengeId(credential),
    );
    if (!challenge) return { status: 400, body: { error: 'invalid_challenge' } };
    const bindingError = await this.checkAuthenticationContext(
      challenge.context,
      browserNonce,
      sessionId,
    );
    if (bindingError) return bindingError;
    const passkey = await this.storage.get<PasskeyRecord>(passkeyKey(response.id));
    if (!passkey) return { status: 400, body: { error: 'passkey_verification_failed' } };
    const boundPlayer =
      challenge.context.purpose === 'reauthenticate' ? challenge.context.playerUuid : undefined;
    if (boundPlayer && passkey.playerUuid !== boundPlayer)
      return { status: 403, body: { error: 'account_mismatch' } };
    const userHandle = response.response?.userHandle;
    const expectedHandle = bufferToBase64url(new TextEncoder().encode(passkey.playerUuid));
    if (
      (userHandle == null && !boundPlayer) ||
      (userHandle != null && userHandle !== expectedHandle)
    )
      return { status: 400, body: { error: 'passkey_verification_failed' } };
    const verification = await verifyPasskeyAuthentication(
      response,
      passkey,
      challenge.challenge,
      webAuthnConfig(this.env),
    );
    if (!verification?.verified)
      return { status: 400, body: { error: 'passkey_verification_failed' } };
    const account = await this.loadAccount(passkey.playerUuid);
    if (!account) {
      const stored = await this.storage.get<AccountRecord>(accountKey(passkey.playerUuid));
      return { status: 403, body: { error: stored?.banned ? 'account_banned' : 'authentication_invalidated' } };
    }
    const session = await this.prepareSession(account.playerUuid, 'passkey');
    const result = await this.storage.transaction(async (txn): Promise<StoreResult> => {
      const currentChallenge = await txn.get<ChallengeRecord>(
        webauthnChallengeKey(challenge.challenge),
      );
      if (
        !currentChallenge ||
        currentChallenge.type !== 'passkey-authentication' ||
        !sameAuthenticationContext(currentChallenge.context, challenge.context) ||
        isExpired(currentChallenge.expiresAt)
      ) {
        return { status: 400, body: { error: 'invalid_challenge' } };
      }
      const currentKey = await txn.get<PasskeyRecord>(passkeyKey(passkey.credentialId));
      const currentAccount = await txn.get<AccountRecord>(accountKey(account.playerUuid));
      if (
        !currentKey ||
        currentKey.playerUuid !== passkey.playerUuid ||
        currentKey.publicKey !== passkey.publicKey ||
        currentKey.counter !== passkey.counter ||
        !eligibleAccount(currentAccount)
      ) {
        return { status: 400, body: { error: 'passkey_verification_failed' } };
      }
      const sessionError = await this.storeAuthenticatedSession(txn, challenge.context, session);
      if (sessionError) return sessionError;
      await txn.put({
        [passkeyKey(passkey.credentialId)]: {
          ...currentKey,
          counter: verification.authenticationInfo.newCounter,
          lastUsedAt: new Date().toISOString(),
        },
      });
      await txn.delete(webauthnChallengeKey(challenge.challenge));
      return {
        status: 200,
        body: sessionBody(
          session.sessionId,
          currentAccount,
          (await txn.list({ prefix: accountPasskeyPrefix(account.playerUuid) })).size,
        ),
      };
    });
    this.passkeyCache.delete(passkey.playerUuid);
    if (result.status === 200) this.authenticationCommitted(challenge.context);
    return result;
  }

  private async passkeyDelete(sessionId: string, credentialId: string): Promise<StoreResult> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    if (!recentlyAuthenticated(session)) return reauthenticationRequired();
    if (!(await this.loadAccount(session.playerUuid)))
      return { status: 403, body: { error: 'authentication_invalidated' } };
    const result = await this.storage.transaction(async (txn): Promise<StoreResult> => {
      const current = await txn.get<SessionRecord>(sessionKey(session.sidHash));
      if (!(await this.sessionStillActive(txn, session)))
        return { status: 401, body: { error: 'unauthenticated' } };
      if (!current || !recentlyAuthenticated(current)) return reauthenticationRequired();
      const passkey = await txn.get<PasskeyRecord>(passkeyKey(credentialId));
      if (!passkey || passkey.playerUuid !== current.playerUuid)
        return { status: 404, body: { error: 'not_found' } };
      await txn.delete([
        passkeyKey(credentialId),
        accountPasskeyKey(current.playerUuid, credentialId),
      ]);
      return { status: 200, body: { ok: true } };
    });
    this.passkeyCache.delete(session.playerUuid);
    return result;
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
        session: publicSession(session, true),
        sessions: await this.listAccountSessions(account.playerUuid, session.sidHash),
        passkeys: (await this.listPasskeys(account.playerUuid)).map(publicPasskey),
      },
    };
  }

  private async renameSecurityItem(
    sessionId: string,
    kind: unknown,
    targetId: string,
    displayName: unknown,
  ): Promise<StoreResult> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const name = securityDisplayName(displayName);
    if (name === null) return { status: 422, body: { error: 'invalid_display_name' } };
    if (
      (kind !== 'session' && kind !== 'passkey') ||
      !(kind === 'session' ? /^[A-Za-z0-9_-]{43}$/ : /^[A-Za-z0-9_-]{1,2048}$/).test(targetId)
    )
      return { status: 404, body: { error: 'not_found' } };
    const rateLimited = this.consumeRateLimit(
      rateLimitKey('security:rename', session.playerUuid),
      20,
      60,
    );
    if (rateLimited) return rateLimited;
    const key = kind === 'session' ? sessionKey(targetId) : passkeyKey(targetId);
    const result = await this.storage.transaction(async (txn): Promise<StoreResult> => {
      if (!(await this.sessionStillActive(txn, session)))
        return { status: 401, body: { error: 'unauthenticated' } };
      const target =
        kind === 'session'
          ? await txn.get<SessionRecord>(key)
          : await txn.get<PasskeyRecord>(key);
      if (
        !target ||
        target.playerUuid !== session.playerUuid ||
        ('sidHash' in target && !activeSession(target))
      )
        return { status: 404, body: { error: 'not_found' } };
      await txn.put(key, { ...target, displayName: name || undefined });
      return { status: 200, body: { ok: true } };
    });
    if (result.status === 200) {
      if (kind === 'session') this.sessionCache.delete(targetId);
      else this.passkeyCache.delete(session.playerUuid);
    }
    return result;
  }

  private async revokeAccountSession(
    sessionId: string,
    targetSessionId: string,
    all: boolean,
  ): Promise<StoreResult> {
    const current = await this.readValidSession(sessionId);
    if (!current) return { status: 401, body: { error: 'unauthenticated' } };
    if ((all && targetSessionId) || (!all && !targetSessionId))
      return { status: 422, body: { error: 'invalid_session' } };
    const requiresRecentAuth = all || targetSessionId !== current.sidHash;
    if (requiresRecentAuth && !recentlyAuthenticated(current)) return reauthenticationRequired();
    if (requiresRecentAuth && !(await this.loadAccount(current.playerUuid)))
      return { status: 403, body: { error: 'authentication_invalidated' } };
    let revokedSessionHashes: string[] = [];
    const result = await this.storage.transaction(async (txn): Promise<StoreResult> => {
      const actor = await txn.get<SessionRecord>(sessionKey(current.sidHash));
      if (!actor || !(await this.sessionStillActive(txn, current)))
        return { status: 401, body: { error: 'unauthenticated' } };
      if (requiresRecentAuth && !recentlyAuthenticated(actor)) return reauthenticationRequired();
      if (all) {
        revokedSessionHashes = await this.deleteAccountSessions(txn, actor.playerUuid);
        await txn.delete([
          sessionKey(actor.sidHash),
          accountSessionKey(actor.playerUuid, actor.sidHash),
        ]);
        return { status: 200, body: { ok: true, clearSession: true } };
      }
      const target = await txn.get<SessionRecord>(sessionKey(targetSessionId));
      if (!target || target.playerUuid !== actor.playerUuid)
        return { status: 404, body: { error: 'not_found' } };
      await txn.delete([
        sessionKey(target.sidHash),
        accountSessionKey(target.playerUuid, target.sidHash),
      ]);
      return { status: 200, body: { ok: true, clearSession: target.sidHash === current.sidHash } };
    });
    if (result.status === 200) {
      if (all) {
        for (const sidHash of revokedSessionHashes) this.sessionCache.delete(sidHash);
        this.sessionCache.delete(current.sidHash);
      } else this.sessionCache.delete(targetSessionId);
      this.state.waitUntil(
        this.notifyChatRevocation(
          all ? [...new Set([...revokedSessionHashes, current.sidHash])] : [targetSessionId],
        ),
      );
    }
    return result;
  }

  private async authorizeWebChat(
    sessionId: string,
    connectionId: string,
    clientPublicKey: string,
  ): Promise<StoreResult> {
    if (
      !/^[A-Za-z0-9_-]{32}$/.test(connectionId) ||
      !/^[A-Za-z0-9_-]{87}$/.test(clientPublicKey)
    )
      return { status: 422, body: { error: 'invalid_connection' } };
    const keyBytes = base64urlToBuffer(clientPublicKey);
    if (keyBytes[0] !== 4 || bufferToBase64url(keyBytes) !== clientPublicKey)
      return { status: 422, body: { error: 'invalid_connection' } };
    // A timer confirms authority without keeping an idle login alive or writing every renewal.
    const session = await this.readValidSession(sessionId, false);
    if (!session) return { status: 401, body: { error: 'unauthenticated', clearSession: true } };
    const rateLimited = this.consumeRateLimit(
      rateLimitKey('web-chat:authorize', session.playerUuid),
      20,
      60,
    );
    if (rateLimited) return rateLimited;
    const account = await this.readAccount(session.playerUuid);
    if (!eligibleAccount(account)) return { status: 403, body: { error: 'chat_forbidden' } };
    const valid = await this.storage.transaction((txn) => this.sessionStillActive(txn, session));
    if (!valid) return { status: 401, body: { error: 'unauthenticated', clearSession: true } };
    const checkedAt = Date.now();
    const expiresAt = Math.min(
      checkedAt + 60_000,
      Date.parse(session.idleExpiresAt),
      Date.parse(session.absoluteExpiresAt),
    );
    try {
      const response = await this.env.VPC_SERVICE.fetch(
        new URL('/api/chat/authorize', this.env.MINECRAFT_SERVER_URL),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          // Workers supports follow/manual only; non-2xx responses are rejected below.
          redirect: 'manual',
          body: JSON.stringify({
            connectionId,
            clientPublicKey,
            playerUuid: session.playerUuid,
            playerName: account.currentName,
            sessionRef: session.sidHash,
            authenticatedAt: Date.parse(session.authenticatedAt),
            checkedAt,
            expiresAt,
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) {
        const status = [403, 409, 429].includes(response.status) ? response.status : 503;
        const failure = (await response.json().catch(() => null)) as { error?: unknown } | null;
        const error =
          status === 429
            ? failure?.error === 'chat_capacity'
              ? 'chat_capacity'
              : 'connection_limit'
            : status === 409
              ? 'connection_unavailable'
              : 'chat_unavailable';
        return { status, body: { error } };
      }
      const result = (await response.json()) as { lastActivityAt?: unknown };
      // Only accepted messages attested by the plugin count as activity, never a browser claim.
      if (
        typeof result.lastActivityAt === 'number' &&
        Number.isSafeInteger(result.lastActivityAt) &&
        result.lastActivityAt > Date.parse(session.lastSeenAt) &&
        result.lastActivityAt <= Date.now() + 5000
      )
        await this.readValidSession(sessionId);
      return { status: 200, body: { ok: true } };
    } catch {
      return { status: 503, body: { error: 'chat_unavailable' } };
    }
  }

  private async notifyChatRevocation(sessionRefs: string[]): Promise<void> {
    if (!sessionRefs.length) return;
    try {
      const response = await this.env.VPC_SERVICE.fetch(
        new URL('/api/chat/revoke', this.env.MINECRAFT_SERVER_URL),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionRefs }),
          redirect: 'manual',
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!response.ok) throw new Error('chat_revocation_failed');
    } catch {
      // The stored session has already been revoked. Plugin authority expires within 60 seconds.
      console.warn('Web chat revocation notification unavailable');
    }
  }

  private async resolvePlayer(
    sessionId: string,
    name: string,
  ): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const requester = await this.readAccount(session.playerUuid);
    if (!requester) return { status: 403, body: { error: 'authentication_invalidated' } };

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
    if (!eligibleMemberAccount(account)) return { status: 403, body: { error: 'member_required' } };

    return this.storage.transaction(async (txn) => {
      if (!(await this.sessionStillActive(txn, session)))
        return { status: 401, body: { error: 'unauthenticated' } };
      const currentAccount = await txn.get<AccountRecord>(accountKey(session.playerUuid));
      if (!eligibleMemberAccount(currentAccount))
        return { status: 403, body: { error: 'member_required' } };
      const result = await responseToStoreResult(
        await createPlayerBuildingSubmission(
          new Request('https://auth-store.local/building-submissions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
          }),
          { ...this.env, buildingStore: this.buildings },
          account,
        ),
      );
      if (result.status < 400) await this.scheduleMaintenance();
      return result;
    });
  }

  private async listBuildingSubmissions(
    sessionId: string,
  ): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const account = await this.readAccount(session.playerUuid);
    if (!eligibleMemberAccount(account)) return { status: 403, body: { error: 'member_required' } };
    await this.ensureBuildingCatalog();

    return responseToStoreResult(
      await listPlayerBuildingSubmissions(
        new Request('https://auth-store.local/building-submissions/mine', { method: 'POST' }),
        { ...this.env, buildingStore: this.buildings },
        account,
      ),
    );
  }

  private async imageUpload(
    sessionId: string,
    uploadId?: string,
    rawImage?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const account = await this.readAccount(session.playerUuid);
    if (!eligibleMemberAccount(account)) return { status: 403, body: { error: 'member_required' } };
    return this.storage.transaction(async (txn) => {
      if (!(await this.sessionStillActive(txn, session)))
        return { status: 401, body: { error: 'unauthenticated' } };
      const currentAccount = await txn.get<AccountRecord>(accountKey(session.playerUuid));
      if (!eligibleMemberAccount(currentAccount))
        return { status: 403, body: { error: 'member_required' } };
      if (uploadId !== undefined) {
        if (!validUploadedImage(rawImage)) return { status: 422, body: { error: 'invalid_image' } };
        const saved = this.buildings.completeUpload(account.playerUuid, uploadId, rawImage);
        return saved
          ? { status: 200, body: { image: rawImage } }
          : { status: 409, body: { error: 'upload_expired' } };
      }
      if (this.buildings.pendingCount(account.playerUuid) >= 10)
        return { status: 429, body: { error: 'pending_limit_reached' } };
      const result = this.buildings.reserveUpload(account.playerUuid);
      await this.scheduleMaintenance();
      return {
        status: result.error ? 429 : 200,
        body: result.error ? result : { uploadId: result.id },
      };
    });
  }

  private async sessionStillActive(
    txn: DurableObjectTransaction,
    session: Pick<SessionRecord, 'sidHash' | 'playerUuid'>,
  ): Promise<boolean> {
    const current = await txn.get<SessionRecord>(sessionKey(session.sidHash));
    const account = await txn.get<AccountRecord>(accountKey(session.playerUuid));
    return (
      activeSession(current) &&
      eligibleAccount(account) &&
      current.playerUuid === session.playerUuid &&
      Date.parse(current.authenticatedAt) > (account.credentialsChangedAt ?? 0)
    );
  }

  private async scheduleMaintenance(): Promise<void> {
    const current = await this.storage.getAlarm();
    const due = Math.min(this.buildings.publicationDue() ?? Infinity, Date.now() + 3600_000);
    if (current === null || current > due) await this.storage.setAlarm(due);
  }

  async alarm(): Promise<void> {
    await this.ensureInitialized();
    // Install a recovery alarm before external I/O. Publication state remains durable on failure.
    await this.storage.setAlarm(Date.now() + 3600_000);
    try {
      await this.ensureBuildingCatalog();
      await this.buildings.publish(this.env.BUILDINGS_KV);
    } catch (error) {
      console.warn('Building catalog maintenance deferred', error);
    }
    const nextSweep = (await this.storage.get<number>('maintenance:next-sweep')) ?? 0;
    if (nextSweep <= Date.now()) {
      await this.storage.transaction(async (txn) => {
        this.buildings.cleanup();
        const cursor = await txn.get<string>('maintenance:session-cursor');
        const rows = await txn.list<SessionRecord>({
          prefix: 'session:',
          startAfter: cursor,
          limit: 128,
        });
        for (const [key, session] of rows) {
          const { playerUuid, sidHash } = session;
          if (!activeSession(session)) {
            await txn.delete([key, accountSessionKey(playerUuid, sidHash)]);
            this.sessionCache.delete(sidHash);
          }
        }
        const last = [...rows.keys()].at(-1);
        if (rows.size === 128 && last) await txn.put('maintenance:session-cursor', last);
        else await txn.delete('maintenance:session-cursor');
        await txn.put('maintenance:next-sweep', Date.now() + 3600_000);
      });
    }
    await this.scheduleMaintenance();
  }

  private async pruneAccountSessions(
    txn: DurableObjectTransaction,
    playerUuid: string,
  ): Promise<void> {
    const index = await txn.list<string>({ prefix: accountSessionPrefix(playerUuid) });
    const sessions: SessionRecord[] = [];
    for (const [key, hash] of index) {
      const session = await txn.get<SessionRecord>(sessionKey(hash));
      if (!session || session.playerUuid !== playerUuid) {
        await txn.delete(key);
        continue;
      }
      if (!activeSession(session)) {
        await txn.delete([key, sessionKey(hash)]);
        this.sessionCache.delete(hash);
      } else sessions.push(session);
    }
    sessions.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    for (const session of sessions.slice(15)) {
      await txn.delete([
        sessionKey(session.sidHash),
        accountSessionKey(playerUuid, session.sidHash),
      ]);
      this.sessionCache.delete(session.sidHash);
    }
    await this.scheduleMaintenance();
  }

  private async prepareSession(
    playerUuid: string,
    authMethod: SessionRecord['authMethod'],
    authenticatedAt = new Date().toISOString(),
  ): Promise<{ sessionId: string; record: SessionRecord }> {
    const sessionId = randomToken(32);
    const now = Date.now();
    return {
      sessionId,
      record: {
        sidHash: await sha256(sessionId),
        playerUuid,
        authMethod,
        authenticatedAt,
        issuedAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        idleExpiresAt: new Date(now + SESSION_IDLE_SECONDS * 1000).toISOString(),
        absoluteExpiresAt: new Date(now + SESSION_ABSOLUTE_SECONDS * 1000).toISOString(),
      },
    };
  }

  private async readValidSession(sessionId: string, touch = true): Promise<SessionRecord | null> {
    if (!sessionId) return null;
    const sidHash = await sha256(sessionId);
    let session = await this.readSessionByHash(sidHash);
    if (!activeSession(session)) {
      this.sessionCache.delete(sidHash);
      if (session)
        await this.storage.transaction(async (txn) => {
          const current = await txn.get<SessionRecord>(sessionKey(sidHash));
          if (!activeSession(current))
            await txn.delete([
              sessionKey(sidHash),
              accountSessionKey(session!.playerUuid, sidHash),
            ]);
        });
      return null;
    }
    const account = await this.readAccount(session.playerUuid);
    if (
      !eligibleAccount(account) ||
      Date.parse(session.authenticatedAt) <= (account.credentialsChangedAt ?? 0)
    ) {
      this.sessionCache.delete(sidHash);
      return null;
    }
    const now = Date.now();
    if (touch && now - Date.parse(session.lastSeenAt) >= SESSION_TOUCH_INTERVAL_SECONDS * 1000) {
      session = await this.storage.transaction(async (txn) => {
        const current = await txn.get<SessionRecord>(sessionKey(sidHash));
        if (!activeSession(current)) return null;
        const updated = {
          ...current,
          lastSeenAt: new Date(now).toISOString(),
          idleExpiresAt: new Date(
            Math.min(now + SESSION_IDLE_SECONDS * 1000, Date.parse(current.absoluteExpiresAt)),
          ).toISOString(),
        };
        await txn.put(sessionKey(sidHash), updated);
        return updated;
      });
    } else {
      // A policy refresh or concurrent revocation may have invalidated this cache entry.
      if (!this.sessionCache.get(sidHash))
        session = (await this.storage.get<SessionRecord>(sessionKey(sidHash))) ?? null;
    }
    if (!activeSession(session)) {
      this.sessionCache.delete(sidHash);
      return null;
    }
    this.sessionCache.set(sidHash, session, sessionCacheTtlMs(session, now), now);
    return session;
  }

  private async readSessionByHash(sidHash: string): Promise<SessionRecord | null> {
    let session = this.sessionCache.get(sidHash);
    session ??= (await this.storage.get<SessionRecord>(sessionKey(sidHash))) ?? null;

    if (session) {
      this.sessionCache.set(sidHash, session, sessionCacheTtlMs(session));
    }

    return session;
  }

  private async listAccountSessions(
    playerUuid: string,
    currentSidHash: string,
  ): Promise<Record<string, unknown>[]> {
    const index = await this.storage.list<string>({ prefix: accountSessionPrefix(playerUuid) });
    const sessionEntries = await Promise.all(
      [...index.entries()].map(async ([indexKey, sidHash]) => ({
        indexKey,
        session: await this.readSessionByHash(sidHash),
      })),
    );
    const activeSessions: SessionRecord[] = [];
    const cleanup: Promise<unknown>[] = [];
    for (const { indexKey, session } of sessionEntries) {
      if (!activeSession(session) || session.playerUuid !== playerUuid) {
        if (session && session.playerUuid === playerUuid) {
          cleanup.push(this.storage.delete([sessionKey(session.sidHash), indexKey]));
          this.sessionCache.delete(session.sidHash);
        } else {
          cleanup.push(this.storage.delete(indexKey));
        }
        continue;
      }
      activeSessions.push(session);
    }
    if (cleanup.length) {
      await Promise.all(cleanup);
    }

    if (!activeSessions.some((session) => session.sidHash === currentSidHash)) {
      const currentSession = await this.readSessionByHash(currentSidHash);
      if (activeSession(currentSession) && currentSession.playerUuid === playerUuid) {
        activeSessions.push(currentSession);
        await this.storage.put(accountSessionKey(playerUuid, currentSidHash), currentSidHash);
      }
    }

    return activeSessions
      .sort(
        (left, right) =>
          Number(right.sidHash === currentSidHash) - Number(left.sidHash === currentSidHash) ||
          new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime(),
      )
      .map((session) => publicSession(session, session.sidHash === currentSidHash));
  }

  private readAccount(playerUuid: string): Promise<AccountRecord | null> {
    const cached = this.accountCache.get(playerUuid);
    if (cached) return Promise.resolve(eligibleAccount(cached) ? cached : null);
    let loading = this.accountReads.get(playerUuid);
    if (!loading) {
      loading = this.loadAccount(playerUuid).finally(() => this.accountReads.delete(playerUuid));
      this.accountReads.set(playerUuid, loading);
    }
    return loading;
  }

  private async loadAccount(playerUuid: string): Promise<AccountRecord | null> {
    const account = await this.storage.get<AccountRecord>(accountKey(playerUuid));
    if (!account) return null;
    if (account.disabledAt) {
      await this.storage.transaction((txn) => this.deleteAccountSessions(txn, playerUuid));
      this.sessionCache.clear();
      return null;
    }
    const policy = await this.fetchPluginAccountPolicy(playerUuid, account.currentName);
    const role = policy.role;
    if (policy.banned || !isEligibleRole(role)) {
      await this.storage.transaction(async (txn) => {
        const current = await txn.get<AccountRecord>(accountKey(playerUuid));
        if (current)
          await txn.put(accountKey(playerUuid), {
            ...current,
            role,
            banned: policy.banned,
            updatedAt: new Date().toISOString(),
          });
        await this.deleteAccountSessions(txn, playerUuid);
      });
      this.sessionCache.clear();
      this.accountCache.delete(playerUuid);
      return null;
    }
    const updated = {
      ...account,
      role,
      banned: false,
      credentialsChangedAt: policy.credentialsChangedAt,
    };
    if (
      account.banned ||
      account.role !== role ||
      account.credentialsChangedAt !== policy.credentialsChangedAt
    ) {
      const committed = await this.storage.transaction(async (txn) => {
        const current = await txn.get<AccountRecord>(accountKey(playerUuid));
        if (!current || current.disabledAt) return false;
        await txn.put(accountKey(playerUuid), {
          ...current,
          role,
          banned: false,
          credentialsChangedAt: policy.credentialsChangedAt,
        });
        if (policy.credentialsChangedAt > (current.credentialsChangedAt ?? 0)) {
          await this.deleteAccountSessions(txn, playerUuid, policy.credentialsChangedAt);
        }
        return true;
      });
      this.sessionCache.clear();
      if (!committed) return null;
    }
    this.accountCache.set(playerUuid, updated);
    return updated;
  }

  private async fetchPluginAccountPolicy(
    playerUuid: string,
    currentName: string,
  ): Promise<{ role: string; credentialsChangedAt: number; banned: boolean }> {
    try {
      const response = await this.env.VPC_SERVICE.fetch(
        new URL(
          `/api/auth/accounts/${encodeURIComponent(playerUuid)}?name=${encodeURIComponent(currentName)}`,
          this.env.MINECRAFT_SERVER_URL,
        ),
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) throw new PluginUnavailableError();
      const payload = (await response.json()) as {
        player?: { uuid?: string; role?: string; credentialsChangedAt?: number; banned?: boolean };
      };
      if (
        payload.player?.uuid?.toLowerCase() !== playerUuid ||
        typeof payload.player.role !== 'string' ||
        typeof payload.player.banned !== 'boolean'
      )
        throw new PluginUnavailableError();
      const changed = payload.player.credentialsChangedAt;
      if (typeof changed !== 'number' || !Number.isSafeInteger(changed) || changed < 0)
        throw new PluginUnavailableError();
      return {
        role: payload.player.role.toLowerCase(),
        credentialsChangedAt: changed,
        banned: payload.player.banned,
      };
    } catch {
      throw new PluginUnavailableError();
    }
  }

  private async deleteAccountSessions(
    txn: DurableObjectTransaction,
    playerUuid: string,
    before?: number,
  ): Promise<string[]> {
    const entries = await txn.list<string>({ prefix: accountSessionPrefix(playerUuid) });
    const deleted: string[] = [];
    for (const [key, sidHash] of entries) {
      const session = await txn.get<SessionRecord>(sessionKey(sidHash));
      if (
        before === undefined ||
        !activeSession(session) ||
        Date.parse(session.authenticatedAt) <= before
      ) {
        await txn.delete([key, sessionKey(sidHash)]);
        deleted.push(sidHash);
      }
    }
    return deleted;
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
      [...index.values()].map((credentialId) =>
        this.storage.get<PasskeyRecord>(passkeyKey(credentialId)),
      ),
    );
    const result = passkeys.filter(
      (passkey): passkey is PasskeyRecord => !!passkey && passkey.playerUuid === playerUuid,
    );
    this.passkeyCache.set(playerUuid, result);
    return result;
  }

  private async readMinecraftChallenge(
    challengeId: string,
  ): Promise<Extract<ChallengeRecord, { type: 'minecraft-authentication' }> | null> {
    const record = await this.storage.get<ChallengeRecord>(challengeKey(challengeId));
    return record?.type === 'minecraft-authentication' ? record : null;
  }

  private async readWebauthnChallenge<T extends 'passkey-registration' | 'passkey-authentication'>(
    type: T,
    challenge?: string,
  ): Promise<Extract<ChallengeRecord, { type: T }> | null> {
    if (!challenge) return null;
    const record = await this.storage.get<ChallengeRecord>(webauthnChallengeKey(challenge));
    if (!record || record.type !== type) return null;
    if (isExpired(record.expiresAt)) {
      await this.storage.delete(webauthnChallengeKey(challenge));
      return null;
    }
    return record as Extract<ChallengeRecord, { type: T }>;
  }

  private async fetchPluginChallenge(code: string): Promise<PluginChallengeResponse> {
    const path = `/api/auth/challenges/${encodeURIComponent(code)}`;
    try {
      const response = await this.env.VPC_SERVICE.fetch(
        new URL(path, this.env.MINECRAFT_SERVER_URL),
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) return { status: 'not_found' };
      return (await response.json()) as PluginChallengeResponse;
    } catch {
      return { status: 'unavailable' };
    }
  }

  private async fetchPluginPlayer(name: string): Promise<{ uuid: string; name: string } | null> {
    const path = `/api/players/resolve?name=${encodeURIComponent(name)}`;
    try {
      const response = await this.env.VPC_SERVICE.fetch(
        new URL(path, this.env.MINECRAFT_SERVER_URL),
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        },
      );
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
    this.initialized ??= Promise.resolve().then(() => this.buildings.initialize());
    return this.initialized;
  }

  private ensureBuildingCatalog(): Promise<void> {
    if (this.catalogReady) return this.catalogReady;
    if (this.catalogRetryAt > Date.now())
      return Promise.reject(new BuildingCatalogUnavailableError());
    this.catalogReady = migrateBuildingCatalog(this.storage, this.env.BUILDINGS_KV, this.buildings)
      .then(() => this.scheduleMaintenance())
      .catch((error: unknown) => {
        this.catalogReady = null;
        this.catalogRetryAt = Date.now() + 60_000;
        console.error('Building catalog initialization deferred', error);
        throw new BuildingCatalogUnavailableError();
      });
    return this.catalogReady;
  }

  private async cleanupExpiredChallenges(): Promise<void> {
    const now = Date.now();
    if (now - this.lastChallengeCleanupAt < CHALLENGE_CLEANUP_INTERVAL_SECONDS * 1000) {
      return;
    }
    this.lastChallengeCleanupAt = now;

    const [minecraftChallenges, webauthnChallenges] = await Promise.all([
      this.storage.list<MinecraftChallenge>({ prefix: 'challenge:' }),
      this.storage.list<ChallengeRecord>({ prefix: 'webauthn:' }),
    ]);

    const deletes: Promise<unknown>[] = [];
    for (const record of minecraftChallenges.values()) {
      if (isExpired(record.expiresAt)) {
        deletes.push(this.deleteMinecraftChallenge(record));
      }
    }
    for (const [key, record] of webauthnChallenges.entries()) {
      if (isExpired(record.expiresAt)) {
        deletes.push(this.storage.delete(key));
      }
    }

    await Promise.all(deletes);
  }

  private async deleteMinecraftChallenge(record: MinecraftChallenge): Promise<void> {
    await this.storage.transaction(async (txn) => {
      await txn.delete(challengeKey(record.challengeId));
      if ((await txn.get(codeKey(record.displayCode))) === record.challengeId)
        await txn.delete(codeKey(record.displayCode));
    });
  }

  private consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): { status: number; body: Record<string, unknown> } | null {
    const now = Date.now();
    const existing = this.rateLimits.get(key, now);

    if (!existing) {
      this.rateLimits.set(
        key,
        { count: 1, resetAt: now + windowSeconds * 1000 },
        windowSeconds * 1000,
        now,
      );
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

function adminActorFromStoreBody(value: unknown): { email?: string; subject?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const actor = value as Record<string, unknown>;
  return {
    email: optionalString(actor.email),
    subject: optionalString(actor.subject),
  };
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

async function responseToStoreResult(
  response: Response,
): Promise<{ status: number; body: unknown }> {
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function readJsonObject(
  request: Request,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; response: Response }> {
  let text: string;
  try {
    text = await readLimitedRequestText(request);
  } catch (error) {
    return {
      ok: false,
      response: authJson(
        {
          error:
            error instanceof RequestBodyTooLargeError
              ? 'request_body_too_large'
              : 'invalid_request_body',
        },
        error instanceof RequestBodyTooLargeError ? 413 : 400,
      ),
    };
  }

  if (!text.trim()) {
    return { ok: true, data: {} };
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, response: authJson({ error: 'invalid_json_body' }, 400) };
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, response: authJson({ error: 'body_must_be_object' }, 400) };
  }

  return { ok: true, data: body as Record<string, unknown> };
}

class RequestBodyTooLargeError extends Error {}

async function readLimitedRequestText(request: Request): Promise<string> {
  const contentLength = request.headers.get('content-length');

  if (contentLength && Number.parseInt(contentLength, 10) > MAX_AUTH_BODY_BYTES) {
    throw new RequestBodyTooLargeError('request body too large');
  }

  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;
    if (size > MAX_AUTH_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError('request body too large');
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

function isMikwebClientRequest(request: Request, env: Env): boolean {
  return safeSecretEqual(
    env.MIKWEB_AUTH_CLIENT_SECRET?.trim(),
    request.headers.get('X-Mikweb-Auth'),
  );
}

function safeSecretEqual(expected: string | undefined, actual: string | null): boolean {
  if (!expected || !actual) return false;
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(expected);
  const actualBytes = encoder.encode(actual);
  if (expectedBytes.byteLength !== actualBytes.byteLength) return false;
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(expectedBytes, actualBytes);
  }

  let difference = 0;
  for (let index = 0; index < expectedBytes.byteLength; index += 1) {
    difference |= expectedBytes[index] ^ actualBytes[index];
  }
  return difference === 0;
}

function clientRateLimitKey(request: Request): string {
  return sanitizeRateLimitPart(request.headers.get('X-Mik-Client-Key') ?? 'unknown');
}

function rateLimitKey(action: string, clientKey: string): string {
  return `${action}:${sanitizeRateLimitPart(clientKey)}`;
}

function sanitizeRateLimitPart(value: string): string {
  return (
    value
      .trim()
      .slice(0, 128)
      .replace(/[^a-zA-Z0-9:._-]/g, '_') || 'unknown'
  );
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
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_ABSOLUTE_SECONDS}`,
    );
  }
  if (body.clearSession) {
    headers.append(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  }
  if (body.clearLogin || sessionId) {
    headers.append(
      'Set-Cookie',
      `${LOGIN_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  }
  return headers;
}

function sessionBody(
  sessionId: string,
  account: AccountRecord,
  passkeyCount: number,
): Record<string, unknown> {
  return {
    authenticated: true,
    sessionId,
    clearLogin: true,
    account: {
      playerUuid: account.playerUuid,
      currentName: account.currentName,
      role: account.role,
      updatedAt: account.updatedAt,
      passkeyCount,
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

function challengePublicBody(
  record: Extract<ChallengeRecord, { type: 'minecraft-authentication' }>,
): Record<string, unknown> {
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

function publicSession(session: SessionRecord, current = false): Record<string, unknown> {
  return {
    id: session.sidHash,
    current,
    issuedAt: session.issuedAt,
    lastSeenAt: session.lastSeenAt,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    authMethod: session.authMethod,
    displayName: session.displayName,
  };
}

/** Labels are plain display metadata, never an authentication or authorization input. */
function securityDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim();
  if ([...name].length > 64 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return null;
  return name;
}

function publicPasskey(passkey: PasskeyRecord): Record<string, unknown> {
  return {
    credentialId: passkey.credentialId,
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt,
    displayName: passkey.displayName,
  };
}

function webAuthnConfig(env: Env): { rpID: string; origins: string[] } {
  const rpID = env.WEBAUTHN_RP_ID?.trim() || DEFAULT_WEBAUTHN_RP_ID;
  const origins = (env.WEBAUTHN_ORIGIN ?? DEFAULT_WEBAUTHN_ORIGIN)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return { rpID, origins: origins.length ? origins : [DEFAULT_WEBAUTHN_ORIGIN] };
}

async function verifyPasskeyRegistration(
  credential: unknown,
  expectedChallenge: string,
  webAuthn: { rpID: string; origins: string[] },
): ReturnType<typeof verifyRegistrationResponse> {
  try {
    return await verifyRegistrationResponse({
      response: credential as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: webAuthn.origins,
      expectedRPID: webAuthn.rpID,
      requireUserVerification: true,
    });
  } catch {
    return { verified: false };
  }
}

async function verifyPasskeyAuthentication(
  response: AuthenticationResponseJSON,
  passkey: PasskeyRecord,
  expectedChallenge: string,
  webAuthn: { rpID: string; origins: string[] },
): Promise<Awaited<ReturnType<typeof verifyAuthenticationResponse>> | null> {
  try {
    return await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: webAuthn.origins,
      expectedRPID: webAuthn.rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: base64urlToBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports,
      } satisfies WebAuthnCredential,
    });
  } catch {
    return null;
  }
}

function normalizePluginPlayer(
  raw: PluginChallengeResponse['player'],
): { uuid: string; name: string } | null {
  const uuid = asString(raw?.uuid).trim().toLowerCase();
  const name = asString(raw?.name).trim();

  if (!UUID_RE.test(uuid) || !name || name.length > 64) {
    return null;
  }

  return { uuid, name };
}

function normalizeRole(raw: unknown): string {
  const role = asString(raw).trim().toLowerCase();
  return ALLOWED_ROLES.has(role) ? role : '';
}

function isEligibleRole(raw: unknown): boolean {
  return ALLOWED_ROLES.has(asString(raw));
}

function shouldCheckPlugin(value?: string): boolean {
  return !value || Date.now() - new Date(value).getTime() >= 5000;
}

function isExpired(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isFinite(time) || time <= Date.now();
}

function sessionCacheTtlMs(session: SessionRecord, now = Date.now()): number {
  const idleTtl = new Date(session.idleExpiresAt).getTime() - now;
  const absoluteTtl = new Date(session.absoluteExpiresAt).getTime() - now;
  const ttl = Math.min(idleTtl, absoluteTtl, SESSION_TOUCH_INTERVAL_SECONDS * 1000);
  return Number.isFinite(ttl) ? Math.max(1, ttl) : 1;
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
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
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

function accountSessionPrefix(playerUuid: string): string {
  return `account-session:${playerUuid}:`;
}

function accountSessionKey(playerUuid: string, sidHash: string): string {
  return `${accountSessionPrefix(playerUuid)}${sidHash}`;
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

function validUploadedImage(value: unknown): value is import('./types').BuildingSubmissionImage {
  if (!value || typeof value !== 'object') return false;
  const image = value as Record<string, unknown>;
  return (
    typeof image.url === 'string' &&
    /^https:\/\/i\.ibb\.co\/[^/]+\/[^/?#]+\.webp$/i.test(image.url) &&
    image.mime === 'image/webp' &&
    Number.isInteger(image.width) &&
    Number.isInteger(image.height) &&
    Number.isInteger(image.size) &&
    Number(image.width) >= 960 &&
    Number(image.height) >= 540 &&
    Number(image.width) <= 1920 &&
    Number(image.height) <= 1920 &&
    Number(image.size) > 0 &&
    Number(image.size) <= 4 * 1024 * 1024
  );
}
