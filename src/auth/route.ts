import type { Env } from '../env';
import { authJson } from '../shared/http';
import { authStore, type StoreRequest } from './binding';
import { AUTH_RATE_LIMIT_WINDOW_SECONDS, CHALLENGE_TTL_SECONDS, sanitizeRateLimitPart, SESSION_ABSOLUTE_SECONDS } from './policy';
import { asString, optionalString, readLimitedRequestText, RequestBodyTooLargeError } from './request';

const SESSION_COOKIE_NAME = '__Host-mik_sid';

const LOGIN_COOKIE_NAME = '__Host-mik_login';

const AUTH_RATE_LIMIT_RETRY_SECONDS = 10;

type AuthRouteResult = Response | null;

interface AuthRateLimitCheck {
  limiter: RateLimit;
  key: string;
}

const imageUploadActions = new Map([
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
      '/me/chat/authorize',
      '/me/building-submissions',
      '/me/building-submissions/mine',
    ]).has(path) || imageUploadActions.has(path) || /^\/auth\/challenges\/[A-Za-z0-9_-]{24}\/complete$/.test(path)
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
    const { status, body } = await callStore(store, { action: 'me', sessionId, clientKey });
    const headers = sessionHeaders(body);
    if (status === 429 && typeof body.retryAfterSeconds === 'number') {
      headers.set('Retry-After', String(body.retryAfterSeconds));
    }
    return authJson(stripInternalAuthFields(body), status, headers);
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

  const uploadAction = imageUploadActions.get(routePath);
  if (uploadAction && request.method === 'POST') {
    const payload = await readJsonObject(request);
    if (!payload.ok) return payload.response;
    const response = await callStore(store, {
      action: uploadAction,
      hash: payload.data.hash,
      sessionId,
      draftKey: payload.data.draftKey,
      requestKey: payload.data.requestKey,
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
