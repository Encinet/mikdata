import type { SessionService } from './sessions';
import { activeSession } from './model';
import { eligibleAccount, type AccountRecord } from '../players/accounts';
import { consumeRateLimit, rateLimitKey } from './rate-limit';
import { bufferToBase64url, base64urlToBuffer, chatSessionScope } from './tokens';
import type { AuthResult, SessionRecord } from './model';
import type { Env } from '../env';

export async function authorizeWebChat(
  sessions: SessionService,
  sessionId: string,
  connectionId: string,
  clientPublicKey: string,
  expectedScope?: unknown,
): Promise<AuthResult> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(connectionId) || !/^[A-Za-z0-9_-]{87}$/.test(clientPublicKey))
    return { status: 422, body: { error: 'invalid_connection' } };
  const keyBytes = base64urlToBuffer(clientPublicKey);
  if (keyBytes[0] !== 4 || bufferToBase64url(keyBytes) !== clientPublicKey)
    return { status: 422, body: { error: 'invalid_connection' } };
  // A timer confirms authority without keeping an idle login alive or writing every renewal.
  const session = await sessions.readValidSession(sessionId, false);
  if (!session) return { status: 401, body: { error: 'unauthenticated', clearSession: true } };
  if (expectedScope !== undefined && expectedScope !== await chatSessionScope(sessionId))
    return { status: 403, body: { error: 'session_changed' } };
  const rateLimited = await consumeRateLimit(sessions.env.DB,
    rateLimitKey('web-chat:authorize', session.playerUuid),
    20,
    60,
  );
  if (rateLimited) return rateLimited;
  const account = await sessions.readAccount(session.playerUuid);
  if (!eligibleAccount(account)) return { status: 403, body: { error: 'chat_forbidden' } };
  const valid = await sessions.storage.transaction((txn) => sessions.sessionStillActive(txn, session));
  if (!valid) return { status: 401, body: { error: 'unauthenticated', clearSession: true } };
  const checkedAt = Date.now();
  const expiresAt = Math.min(
    checkedAt + 60_000,
    Date.parse(session.idleExpiresAt),
    Date.parse(session.absoluteExpiresAt),
  );
  const key = await renewalKey(sessions.env);
  if (!key) return { status: 503, body: { error: 'chat_unavailable' } };
  const renewalToken = bufferToBase64url(await crypto.subtle.sign('HMAC', key, renewalInput(session.sidHash)));
  try {
    const response = await sessions.env.VPC_SERVICE.fetch(
      new URL('/api/chat/authorize', sessions.env.MINECRAFT_SERVER_URL),
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
          renewalToken,
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
      await sessions.touchSession(session, result.lastActivityAt);
    return { status: 200, body: { ok: true } };
  } catch {
    return { status: 503, body: { error: 'chat_unavailable' } };
  }
}

// This proof authorizes only a server-to-server check of one website session.
function renewalInput(ref: string) {
  return new TextEncoder().encode('mikd/chat/session-check/v1\0' + ref);
}

async function renewalKey(env: Env) {
  const secret = env.MIKWEB_AUTH_CLIENT_SECRET?.trim();
  if (!secret) return null;
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

interface LeaseCheck {
  sessionRef: string;
  renewalToken: string;
  lastActivityAt?: number;
}

function hasSessionRef(value: unknown): value is { sessionRef: string } {
  return !!value && typeof value === 'object' && 'sessionRef' in value &&
    typeof value.sessionRef === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.sessionRef);
}

function validCheck(value: unknown): value is LeaseCheck {
  if (!hasSessionRef(value)) return false;
  const check = value as Partial<LeaseCheck>;
  return typeof check.renewalToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(check.renewalToken)
    && (check.lastActivityAt === undefined || (Number.isSafeInteger(check.lastActivityAt) && check.lastActivityAt >= 0));
}

export async function checkChatLeases(sessions: SessionService, input: Record<string, unknown>): Promise<AuthResult> {
  const batch = 'checks' in input;
  const items = batch ? input.checks : [input];
  if (!Array.isArray(items) || items.length === 0 || items.length > 16 ||
      !items.every(hasSessionRef) || new Set(items.map(item => item.sessionRef)).size !== items.length)
    return { status: batch ? 422 : 403, body: { error: 'invalid_check' } };
  const key = await renewalKey(sessions.env);
  if (!key) return { status: 503, body: { error: 'chat_unavailable' } };
  const verified = await Promise.all(items.map(item => validCheck(item) && crypto.subtle.verify('HMAC', key,
    base64urlToBuffer(item.renewalToken), renewalInput(item.sessionRef))));
  const checkedAt = Date.now();
  const rows = await sessions.storage.chatSessions(items.filter((_, i) => verified[i]).map(item => item.sessionRef));
  const results = await Promise.all(items.map(async (item, i): Promise<AuthResult> => {
    if (!verified[i] || !validCheck(item)) return { status: 403, body: { error: 'forbidden' } };
    try {
      return await checkedLease(sessions, rows.get(item.sessionRef), item.lastActivityAt, checkedAt);
    } catch {
      return { status: 503, body: { error: 'chat_unavailable' } };
    }
  }));
  if (!batch) return results[0];
  return { status: 200, body: { results: results.map(({status, body}, i) => ({
    sessionRef: items[i].sessionRef, status, ...(status === 200 && { lease: body }),
  })) } };
}

async function checkedLease(
  sessions: SessionService,
  current: { session: SessionRecord; account: AccountRecord } | undefined,
  lastActivityAt: number | undefined,
  checkedAt: number,
): Promise<AuthResult> {
  if (!current || !activeSession(current.session) || !eligibleAccount(current.account) ||
      Date.parse(current.session.authenticatedAt) <= (current.account.credentialsChangedAt ?? 0))
    return { status: 401, body: { error: 'session_revoked' } };
  let session = current.session;
  if (typeof lastActivityAt === 'number' &&
      lastActivityAt > Date.parse(session.lastSeenAt) && lastActivityAt <= checkedAt + 5000) {
    const touched = await sessions.touchSession(session, lastActivityAt);
    if (!touched) return { status: 401, body: { error: 'session_revoked' } };
    session = touched;
  }
  return { status: 200, body: {
    playerUuid: session.playerUuid, playerName: current.account.currentName,
    authenticatedAt: Date.parse(session.authenticatedAt), checkedAt,
    expiresAt: Math.min(checkedAt + 60_000, Date.parse(session.idleExpiresAt), Date.parse(session.absoluteExpiresAt))
  } };
}

export async function notifyChatRevocation(env: Env, sessionRefs: string[]): Promise<void> {
  if (!sessionRefs.length) return;
  try {
    const response = await env.VPC_SERVICE.fetch(
      new URL('/api/chat/revoke', env.MINECRAFT_SERVER_URL),
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
