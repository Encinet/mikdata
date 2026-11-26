import type { Env } from '../env';
import { eligibleAccount, fetchPlayerPolicy, refreshPlayer, type AccountRecord } from '../players/accounts';
import { AuthRepository, AuthRecords, sessionKey, passkeyKey } from './repository';
import { SESSION_ABSOLUTE_SECONDS, AUTH_RATE_LIMIT_WINDOW_SECONDS, sanitizeRateLimitPart } from './policy';
import { sha256, randomToken, chatSessionScope } from './tokens';
import { notifyChatRevocation } from './chat';
import { consumeRateLimit, rateLimitKey } from './rate-limit';
import { activeSession, recentlyAuthenticated, reauthenticationRequired, securityDisplayName, type SessionRecord, type AuthenticationContext, type PasskeyRecord, type AuthResult } from './model';

const SESSION_IDLE_SECONDS = 60 * 60 * 24 * 30;

const SESSION_TOUCH_INTERVAL_SECONDS = 60 * 10;

const ACCOUNT_CACHE_TTL_MS = 60 * 1000;

const SESSION_CHECK_GUEST_RATE_LIMIT = 20;

const SESSION_CHECK_ACCOUNT_RATE_LIMIT = 120;

interface PlayerAccountSummary {
  playerUuid: string;
  currentName: string;
  role: string;
  passkeyCount: number;
}

function validBrowserNonce(value: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(value);
}

export class SessionService {
  readonly storage: AuthRepository;

  constructor(readonly env: Env, private readonly ctx: Pick<ExecutionContext, 'waitUntil'>) {
    this.storage = new AuthRepository(env.DB);
  }

  async createAuthenticationContext(
    purpose: unknown,
    previousNonce: string,
    sessionId: string,
  ): Promise<{ context: AuthenticationContext; browser?: { browserNonce: string } } | AuthResult> {
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

  async checkAuthenticationContext(
    context: AuthenticationContext,
    browserNonce: string,
    sessionId: string,
  ): Promise<AuthResult | null> {
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

  async storeAuthenticatedSession(
    txn: AuthRecords,
    context: AuthenticationContext,
    session: { sessionId: string; record: SessionRecord },
  ): Promise<AuthResult | null> {
    const playerUuid = session.record.playerUuid;
    const account = await txn.players.get(playerUuid);
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
      txn.delete(sessionKey(context.sessionHash));
    }
    await this.pruneAccountSessions(txn, playerUuid);
    txn.put(sessionKey(session.record.sidHash), session.record);
    return null;
  }

  authenticationCommitted(context: AuthenticationContext): void {
    if (context.purpose !== 'reauthenticate') return;
    this.ctx.waitUntil(notifyChatRevocation(this.env, [context.sessionHash]));
  }

  async me(sessionId: string, clientKey: string): Promise<AuthResult> {
    const account = sessionId ? await this.sessionSummary(sessionId) : null;
    const limited = await consumeRateLimit(
      this.env.DB,
      account ? 'me:account:' + account.playerUuid : 'me:guest:' + sanitizeRateLimitPart(clientKey),
      account ? SESSION_CHECK_ACCOUNT_RATE_LIMIT : SESSION_CHECK_GUEST_RATE_LIMIT,
      AUTH_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (limited) return limited;
    return account
      ? { status: 200, body: { authenticated: true, account: { ...account, chatScope: await chatSessionScope(sessionId) } } }
      : { status: 200, body: { authenticated: false, clearSession: true } };
  }

  private async sessionSummary(sessionId: string): Promise<PlayerAccountSummary | null> {
    const current = await this.storage.sessionAccount(await sha256(sessionId));
    if (!current) return null;
    const { session, account, passkeys } = current;
    if (activeSession(session) && eligibleAccount(account) && policyIsFresh(account) &&
        Date.parse(session.authenticatedAt) > (account.credentialsChangedAt ?? 0) && !needsSessionTouch(session)) {
      return { playerUuid: account.playerUuid, currentName: account.currentName, role: account.role, passkeyCount: passkeys };
    }
    const valid = await this.readValidSession(sessionId);
    const refreshed = valid && await this.readAccount(valid.playerUuid);
    return refreshed ? this.accountSummaryBody(refreshed) : null;
  }

  async logout(sessionId: string): Promise<AuthResult> {
    const sidHash = await sha256(sessionId);
    await this.storage.transaction(async (txn) => {
      const session = await txn.get<SessionRecord>(sessionKey(sidHash));
      if (session)
        txn.delete(sessionKey(sidHash));
    });
    if (sessionId) this.ctx.waitUntil(notifyChatRevocation(this.env, [sidHash]));
    return { status: 200, body: { ok: true, clearSession: true } };
  }

  async accountSecurity(sessionId: string): Promise<AuthResult> {
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

  async renameSecurityItem(
    sessionId: string,
    kind: unknown,
    targetId: string,
    displayName: unknown,
  ): Promise<AuthResult> {
    const session = await this.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const name = securityDisplayName(displayName);
    if (name === null) return { status: 422, body: { error: 'invalid_display_name' } };
    if (
      (kind !== 'session' && kind !== 'passkey') ||
      !(kind === 'session' ? /^[A-Za-z0-9_-]{43}$/ : /^[A-Za-z0-9_-]{1,2048}$/).test(targetId)
    )
      return { status: 404, body: { error: 'not_found' } };
    const rateLimited = await consumeRateLimit(this.env.DB,
      rateLimitKey('security:rename', session.playerUuid),
      20,
      60,
    );
    if (rateLimited) return rateLimited;
    const key = kind === 'session' ? sessionKey(targetId) : passkeyKey(targetId);
    const result = await this.storage.transaction(async (txn): Promise<AuthResult> => {
      if (!(await this.sessionStillActive(txn, session)))
        return { status: 401, body: { error: 'unauthenticated' } };
      const target =
        kind === 'session' ? await txn.get<SessionRecord>(key) : await txn.get<PasskeyRecord>(key);
      if (
        !target ||
        target.playerUuid !== session.playerUuid ||
        ('sidHash' in target && !activeSession(target))
      )
        return { status: 404, body: { error: 'not_found' } };
      txn.put(key, { ...target, displayName: name || undefined });
      return { status: 200, body: { ok: true } };
    });
    return result;
  }

  async revokeAccountSession(
    sessionId: string,
    targetSessionId: string,
    all: boolean,
  ): Promise<AuthResult> {
    const current = await this.readValidSession(sessionId);
    if (!current) return { status: 401, body: { error: 'unauthenticated' } };
    if ((all && targetSessionId) || (!all && !targetSessionId))
      return { status: 422, body: { error: 'invalid_session' } };
    const requiresRecentAuth = all || targetSessionId !== current.sidHash;
    if (requiresRecentAuth && !recentlyAuthenticated(current)) return reauthenticationRequired();
    if (requiresRecentAuth && !(await this.loadAccount(current.playerUuid)))
      return { status: 403, body: { error: 'authentication_invalidated' } };
    let revokedSessionHashes: string[] = [];
    const result = await this.storage.transaction(async (txn): Promise<AuthResult> => {
      const actor = await txn.get<SessionRecord>(sessionKey(current.sidHash));
      if (!actor || !(await this.sessionStillActive(txn, current)))
        return { status: 401, body: { error: 'unauthenticated' } };
      if (requiresRecentAuth && !recentlyAuthenticated(actor)) return reauthenticationRequired();
      if (all) {
        revokedSessionHashes = await this.deleteAccountSessions(txn, actor.playerUuid);
        txn.delete(sessionKey(actor.sidHash));
        return { status: 200, body: { ok: true, clearSession: true } };
      }
      const target = await txn.get<SessionRecord>(sessionKey(targetSessionId));
      if (!target || target.playerUuid !== actor.playerUuid)
        return { status: 404, body: { error: 'not_found' } };
      txn.delete(sessionKey(target.sidHash));
      return { status: 200, body: { ok: true, clearSession: target.sidHash === current.sidHash } };
    });
    if (result.status === 200) {
      this.ctx.waitUntil(
        notifyChatRevocation(this.env,
          all ? [...new Set([...revokedSessionHashes, current.sidHash])] : [targetSessionId],
        ),
      );
    }
    return result;
  }

  async sessionStillActive(
    txn: AuthRecords,
    session: Pick<SessionRecord, 'sidHash' | 'playerUuid'>,
  ): Promise<boolean> {
    const current = await txn.get<SessionRecord>(sessionKey(session.sidHash));
    const account = await txn.players.get(session.playerUuid);
    return (
      activeSession(current) &&
      eligibleAccount(account) &&
      current.playerUuid === session.playerUuid &&
      Date.parse(current.authenticatedAt) > (account.credentialsChangedAt ?? 0)
    );
  }

  private async pruneAccountSessions(
    txn: AuthRecords,
    playerUuid: string,
  ): Promise<void> {
    const owned = await txn.owned<SessionRecord>('session', playerUuid);
    const sessions = [...owned.values()].sort((a,b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    let active = 0;
    for (const record of sessions) {
      if (activeSession(record) && ++active <= 15) continue;
      txn.delete(sessionKey(record.sidHash));
    }
  }

  async prepareSession(
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

  async readValidSession(sessionId: string, touch = true): Promise<SessionRecord | null> {
    if (!sessionId) return null;
    const sidHash = await sha256(sessionId);
    let session = await this.readSessionByHash(sidHash);
    if (!activeSession(session)) {
      if (session)
        await this.storage.transaction(async (txn) => {
          const current = await txn.get<SessionRecord>(sessionKey(sidHash));
          if (!activeSession(current))
            txn.delete(sessionKey(sidHash));
        });
      return null;
    }
    const account = await this.readAccount(session.playerUuid);
    if (
      !eligibleAccount(account) ||
      Date.parse(session.authenticatedAt) <= (account.credentialsChangedAt ?? 0)
    ) {
      return null;
    }
    if (touch && needsSessionTouch(session)) {
      session = await this.touchSession(session);
    } else {
      // Recheck after the upstream policy request, which can overlap a logout.
      session = (await this.storage.get<SessionRecord>(sessionKey(sidHash))) ?? null;
    }
    if (!activeSession(session)) {
      return null;
    }
    return session;
  }

  async touchSession(session: SessionRecord, activityAt = Date.now()): Promise<SessionRecord | null> {
    const now = Math.min(activityAt, Date.now());
    if (!needsSessionTouch(session, now)) return session;
    const sidHash = session.sidHash;
    return this.storage.transaction(async (txn) => {
      const current = await txn.get<SessionRecord>(sessionKey(sidHash));
      if (!activeSession(current) || !await this.sessionStillActive(txn, current)) return null;
      if (!needsSessionTouch(current, now)) return current;
      const updated = {
        ...current,
        lastSeenAt: new Date(now).toISOString(),
        idleExpiresAt: new Date(
          Math.min(now + SESSION_IDLE_SECONDS * 1000, Date.parse(current.absoluteExpiresAt)),
        ).toISOString(),
      };
      txn.put(sessionKey(sidHash), updated);
      return updated;
    });
  }

  private async readSessionByHash(sidHash: string) {
    return (await this.storage.get<SessionRecord>(sessionKey(sidHash))) ?? null;
  }

  private async listAccountSessions(
    playerUuid: string,
    currentSidHash: string,
  ): Promise<Record<string, unknown>[]> {
    const owned = await this.storage.owned<SessionRecord>('session', playerUuid);
    const activeSessions = [...owned.values()].filter(activeSession);
    if (activeSessions.length < owned.size) {
      await this.storage.transaction(async txn => {
        for (const [id, record] of await txn.owned<SessionRecord>('session', playerUuid))
          if (!activeSession(record)) txn.delete(sessionKey(id));
      });
    }
    return activeSessions
      .sort(
        (left, right) =>
          Number(right.sidHash === currentSidHash) - Number(left.sidHash === currentSidHash) ||
          new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime(),
      )
      .map((session) => publicSession(session, session.sidHash === currentSidHash));
  }

  async readAccount(playerUuid: string): Promise<AccountRecord | null> {
    const account = await this.storage.players.get(playerUuid);
    if (!account) return null;
    if (!account.disabledAt && policyIsFresh(account))
      return eligibleAccount(account) ? account : null;
    return refreshPlayer(this.env, playerUuid, () => this.loadAccount(playerUuid));
  }

  async loadAccount(playerUuid: string): Promise<AccountRecord | null> {
    const initial = await this.storage.players.get(playerUuid);
    if (!initial) return null;
    if (initial.disabledAt) {
      await this.storage.transaction(async txn => {
        if ((await txn.players.get(playerUuid))?.disabledAt) await this.deleteAccountSessions(txn, playerUuid);
      });
      return null;
    }
    const started = Date.now();
    const policy = await fetchPlayerPolicy(this.env, playerUuid, initial.currentName);
    return this.storage.transaction(async txn => {
      const current = await txn.players.get(playerUuid);
      if (!current || current.disabledAt) return null;
      // A slower upstream response cannot undo a newer credential revocation.
      if (current.policyCheckedAt !== initial.policyCheckedAt && (current.policyCheckedAt ?? 0) >= started) return eligibleAccount(current) ? current : null;
      const account = { ...current, role: policy.role, banned: policy.banned, policyCheckedAt: started,
        credentialsChangedAt: Math.max(policy.credentialsChangedAt, current.credentialsChangedAt ?? 0) };
      txn.players.save(account);
      if (!eligibleAccount(account)) {
        await this.deleteAccountSessions(txn, playerUuid);
        return null;
      }
      if (account.credentialsChangedAt > (current.credentialsChangedAt ?? 0))
        await this.deleteAccountSessions(txn, playerUuid, account.credentialsChangedAt);
      return account;
    });
  }

  private async deleteAccountSessions(
    txn: AuthRecords,
    playerUuid: string,
    before?: number,
  ): Promise<string[]> {
    const entries = await txn.owned<SessionRecord>('session', playerUuid);
    const deleted: string[] = [];
    for (const [sidHash, session] of entries) {
      if (before === undefined || !activeSession(session) || Date.parse(session.authenticatedAt) <= before) {
        txn.delete(sessionKey(sidHash));
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
      passkeyCount: (await this.listPasskeys(account.playerUuid)).length,
    };
  }

  async listPasskeys(playerUuid: string): Promise<PasskeyRecord[]> {
    return [...(await this.storage.owned<PasskeyRecord>('passkey', playerUuid)).values()];
  }
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

function publicPasskey(passkey: PasskeyRecord): Record<string, unknown> {
  return {
    credentialId: passkey.credentialId,
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt,
    displayName: passkey.displayName,
  };
}

function policyIsFresh(account: AccountRecord): boolean {
  return Date.now() - (account.policyCheckedAt ?? 0) < ACCOUNT_CACHE_TTL_MS;
}

function needsSessionTouch(session: SessionRecord, at = Date.now()): boolean {
  return at - Date.parse(session.lastSeenAt) >= SESSION_TOUCH_INTERVAL_SECONDS * 1000;
}
