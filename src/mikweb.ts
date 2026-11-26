import { DatabaseBusy } from './db/transaction';
import type { Env } from './env';
import { asString, authJson, readLimitedRequestText, RequestBodyTooLargeError } from './shared/http';
import { SessionService } from './auth/sessions';
import { MinecraftLogin } from './auth/minecraft';
import { Passkeys } from './auth/passkeys';
import { authorizeWebChat, checkChatLeases } from './auth/chat';
import { playerBuildingAction, type UploadAction } from './buildings/actions';
import { lookupPlayer, PluginUnavailableError } from './players/accounts';
import { AUTH_RATE_LIMIT_WINDOW_SECONDS, CHALLENGE_TTL_SECONDS, sanitizeRateLimitPart, SESSION_ABSOLUTE_SECONDS } from './auth/policy';
const MAX_AUTH_BODY_BYTES = 64 * 1024;

const SESSION_COOKIE_NAME = '__Host-mik_sid';

const LOGIN_COOKIE_NAME = '__Host-mik_login';

const AUTH_RATE_LIMIT_RETRY_SECONDS = 10;

type AuthRouteResult = Response | null;

interface AuthRateLimitCheck {
  limiter: RateLimit;
  key: string;
}

const imageUploadActions = new Map<string, UploadAction>([
  ['/me/images/reserve', 'reserveImageUpload'],
  ['/me/images/prepare', 'prepareImageUpload'],
  ['/me/images/complete', 'completeImageUpload'],
]);

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
      '/me/building-submissions',
      '/me/building-submissions/mine',
    ]).has(path) || imageUploadActions.has(path) || /^\/auth\/challenges\/[A-Za-z0-9_-]{24}\/complete$/.test(path)
  );
}

function chatSessionCookie(request: Request) {
  const cookies = (request.headers.get('cookie') ?? '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(SESSION_COOKIE_NAME + '='));
  const token = cookies.length === 1 ? cookies[0].slice(SESSION_COOKIE_NAME.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}

export async function handleChatRequest(
  request: Request, env: Env, ctx: ExecutionContext, path: '/chat/connect' | '/chat/check' | '/chat/session',
) {
  const reading = path === '/chat/session';
  if (request.method !== (reading ? 'GET' : 'POST')) return authJson({ error: 'method_not_allowed' }, 405);
  if (path !== '/chat/check') {
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if ((site && site !== 'same-origin') || (origin !== 'https://mcmik.top' && !(reading && !origin)))
      return authJson({ error: 'forbidden' }, 403);
  }
  if (!reading && request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    return authJson({ error: 'unsupported_media_type' }, 415);

  try {
    const sessions = new SessionService(env, ctx);
    const clientKey = 'ip:' + sanitizeRateLimitPart(request.headers.get('cf-connecting-ip') ?? 'unknown');
    if (reading) {
      const limited = await enforceAuthRateLimits('/auth/me', 'POST', clientKey, env);
      if (limited) return limited;
      const result = await sessions.me(chatSessionCookie(request), clientKey);
      const headers = sessionHeaders(result.body);
      if (result.status === 429 && typeof result.body.retryAfterSeconds === 'number')
        headers.set('Retry-After', String(result.body.retryAfterSeconds));
      return authJson(stripInternalAuthFields(result.body), result.status, headers);
    }
    const payload = await readJsonObject(request, path === '/chat/check' ? 4096 : 1024);
    if (!payload.ok) return payload.response;
    const data = payload.data;
    if (path === '/chat/check') {
      const result = await checkChatLeases(sessions, data);
      return authJson(result.body, result.status);
    }
    const token = chatSessionCookie(request);
    if (!token) return authJson({ error: 'unauthenticated' }, 401);
    const limited = await enforceAuthRateLimits(path, 'POST', clientKey, env);
    if (limited) return limited;
    const result = await authorizeWebChat(sessions, token, asString(data.connectionId), asString(data.clientPublicKey), data.chatScope);
    return authJson(stripInternalAuthFields(result.body), result.status);
  } catch (error) {
    const result = mikwebError(error);
    return authJson(result.body, result.status);
  }
}

export async function handleMikwebRoute(
  routePath: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
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
  try {
    return await serveMikwebRoute(routePath, request, env, ctx, clientKey);
  } catch (error) {
    const result = mikwebError(error);
    return authJson(result.body, result.status);
  }
}

async function serveMikwebRoute(routePath: string, request: Request, env: Env, ctx: ExecutionContext, clientKey: string) {
  const auth = new SessionService(env, ctx);
  const sessionId = request.headers.get('X-Mik-Session') ?? '';
  const browserNonce = request.headers.get('X-Mik-Browser-Nonce') ?? '';

  const payload = request.method === 'GET' ? { ok: true as const, data: {} as Record<string, unknown> } : await readJsonObject(request);
  if (!payload.ok) return payload.response;
  const data = payload.data;

  if (routePath === '/auth/challenges' && request.method === 'POST') {
    const response = await new MinecraftLogin(auth).create(clientKey, browserNonce, data.purpose, sessionId);
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      setLoginCookie(response.body),
    );
  }

  const challengeStatus = routePath.match(/^\/auth\/challenges\/([^/]+)$/);
  if (challengeStatus && request.method === 'GET') {
    const response = await new MinecraftLogin(auth).get(challengeStatus[1], clientKey, browserNonce, sessionId);
    return authJson(response.body, response.status);
  }

  const challengeComplete = routePath.match(/^\/auth\/challenges\/([^/]+)\/complete$/);
  if (challengeComplete && request.method === 'POST') {
    const response = await new MinecraftLogin(auth).complete(challengeComplete[1], browserNonce, clientKey, sessionId);
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  if (routePath === '/auth/me' && request.method === 'POST') {
    const { status, body } = await auth.me(sessionId, clientKey);
    const headers = sessionHeaders(body);
    if (status === 429 && typeof body.retryAfterSeconds === 'number') {
      headers.set('Retry-After', String(body.retryAfterSeconds));
    }
    return authJson(stripInternalAuthFields(body), status, headers);
  }

  if (routePath === '/auth/logout' && request.method === 'POST') {
    const response = await auth.logout(sessionId);
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  if (routePath === '/auth/passkeys/options/register' && request.method === 'POST') {
    const response = await new Passkeys(auth).registrationOptions(sessionId);
    return authJson(response.body, response.status);
  }

  if (routePath === '/auth/passkeys/register' && request.method === 'POST') {
    const response = await new Passkeys(auth).register(sessionId, data.credential, data.displayName);
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  if (routePath === '/auth/passkeys/options/authenticate' && request.method === 'POST') {
    const response = await new Passkeys(auth).authenticationOptions(clientKey, browserNonce, data.purpose, sessionId);
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      setLoginCookie(response.body),
    );
  }

  if (routePath === '/auth/passkeys/authenticate' && request.method === 'POST') {
    const response = await new Passkeys(auth).authenticate(data.credential, clientKey, browserNonce, sessionId);
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
    const response = await auth.renameSecurityItem(sessionId, passkeyResource ? 'passkey' : 'session', renameTarget[1], data.displayName);
    return authJson(response.body, response.status);
  }
  if (passkeyResource && request.method === 'DELETE') {
    const response = await new Passkeys(auth).delete(sessionId, passkeyResource[1]);
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/security' && request.method === 'POST') {
    const response = await auth.accountSecurity(sessionId);
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/sessions/revoke' && request.method === 'POST') {
    const response = await auth.revokeAccountSession(sessionId, asString(data.targetSessionId), data.all === true);
    return authJson(
      stripInternalAuthFields(response.body),
      response.status,
      sessionHeaders(response.body),
    );
  }

  if (routePath === '/me/players/resolve' && request.method === 'POST') {
    const response = await resolveMikwebPlayer(auth, sessionId, asString(data.name));
    return authJson(response.body, response.status);
  }

  const uploadAction = imageUploadActions.get(routePath);
  if (uploadAction && request.method === 'POST') {
    const response = await playerBuildingAction(env, auth, {
      action: uploadAction,
      hashes: data.hashes,
      sessionId,
      draftKey: data.draftKey,
      requestKey: data.requestKey,
      uploadId: data.uploadId,
      sizes: data.sizes,
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
    const response = await playerBuildingAction(env, auth, {
      action: 'createBuildingSubmission',
      sessionId,
      payload: payload.data,
    });
    return authJson(response.body, response.status);
  }

  if (routePath === '/me/building-submissions/mine' && request.method === 'POST') {
    const response = await playerBuildingAction(env, auth, {
      action: 'listBuildingSubmissions',
      sessionId,
    });
    return authJson(response.body, response.status);
  }

  return authJson({ error: 'not_found' }, 404);
}

export async function resolveMikwebPlayer(auth: SessionService, sessionId: string, name: string) {
  const session = await auth.readValidSession(sessionId);
  if (!session) return { status: 401, body: { error: 'unauthenticated' } };
  if (!await auth.readAccount(session.playerUuid)) return { status: 403, body: { error: 'authentication_invalidated' } };
  return lookupPlayer(auth.env, name);
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

  checks.push({
    limiter:
      routePath === '/auth/me' ? env.AUTH_SESSION_CHECK_IP_RATE_LIMITER : env.AUTH_CLIENT_RATE_LIMITER,
    key: clientKey,
  });

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

export function mikwebError(error: unknown) {
  if (error instanceof DatabaseBusy) return { status: 503, body: { error: 'database_busy' } };
  if (error instanceof PluginUnavailableError) return { status: 503, body: { error: 'plugin_unavailable' } };
  if (String(error).includes('image_unavailable')) return { status: 409, body: { error: 'image_unavailable' } };
  console.error('MikWeb request failed', error);
  return { status: 500, body: { error: 'internal_error' } };
}

async function readJsonObject(
  request: Request,
  maxBytes = MAX_AUTH_BODY_BYTES,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; response: Response }> {
  let text: string;
  try {
    text = await readLimitedRequestText(request, maxBytes);
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

function setLoginCookie(body: Record<string, unknown>): HeadersInit {
  const nonce = asString(body.browserNonce);
  if (!nonce) return {};
  return {
    'Set-Cookie': `${LOGIN_COOKIE_NAME}=${encodeURIComponent(nonce)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${CHALLENGE_TTL_SECONDS}`,
  };
}

function sessionHeaders(body: Record<string, unknown>): Headers {
  const headers = new Headers();
  const sessionId = asString(body.sessionId);
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
