import type { SessionService } from './sessions';
import type { AccountRecord } from '../players/accounts';
import { normalizeRole, normalizePluginPlayer } from '../players/accounts';
import { challengeKey, codeKey } from './repository';
import { CHALLENGE_TTL_SECONDS } from './policy';
import { consumeRateLimit, rateLimitKey } from './rate-limit';
import { randomToken } from './tokens';
import { isExpired, sameAuthenticationContext, sessionBody, type MinecraftChallenge, type ChallengeRecord, type AuthResult } from './model';

interface PluginChallengeResponse {
  status: 'confirmed' | 'pending' | 'expired' | 'not_found' | 'consumed' | 'unavailable' | 'banned';
  player?: {
    uuid?: string;
    name?: string;
    role?: string;
  };
  confirmedAt?: string;
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
): AuthResult | null {
  if (!record) return { status: 404, body: { error: 'not_found' } };
  if (isExpired(record.expiresAt)) return { status: 410, body: { error: 'expired' } };
  if (record.status === 'consumed') return { status: 409, body: { error: 'challenge_consumed' } };
  return null;
}

export class MinecraftLogin {
  constructor(private readonly sessions: SessionService) {}

  async create(
    clientKey: string,
    previousNonce: string,
    purpose: unknown,
    sessionId: string,
  ): Promise<AuthResult> {
    const rateLimited = await consumeRateLimit(this.sessions.env.DB,
      rateLimitKey('minecraft-challenge:create', clientKey),
      8,
      60,
    );
    if (rateLimited) return rateLimited;
    const binding = await this.sessions.createAuthenticationContext(purpose, previousNonce, sessionId);
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
      const created = await this.sessions.storage.transaction(async (txn) => {
        if (await txn.get(codeKey(displayCode))) return false;
        txn.put(challengeKey(challengeId), record);
        txn.put(codeKey(displayCode), challengeId);
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

  async get(
    challengeId: string,
    clientKey: string,
    browserNonce: string,
    sessionId: string,
  ): Promise<AuthResult> {
    const rateLimited = await consumeRateLimit(this.sessions.env.DB,
      rateLimitKey('minecraft-challenge:status', clientKey),
      60,
      60,
    );
    if (rateLimited) return rateLimited;
    let record = await this.readMinecraftChallenge(challengeId);
    if (!record) return { status: 404, body: { status: 'not_found' } };
    const bindingError = await this.sessions.checkAuthenticationContext(
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
      const claimed = await this.sessions.storage.transaction(async (txn) => {
        const current = await txn.get<MinecraftChallenge>(challengeKey(challengeId));
        if (
          !current ||
          current.status !== 'pending' ||
          !shouldCheckPlugin(current.lastPluginCheckAt)
        )
          return false;
        txn.put(challengeKey(challengeId), {
          ...current,
          lastPluginCheckAt: new Date().toISOString(),
        });
        return true;
      });
      if (claimed) {
        const plugin = await this.fetchPluginChallenge(record.displayCode);
        if (plugin.status === 'unavailable')
          return { status: 503, body: { error: 'plugin_unavailable' } };
        if (plugin.status === 'banned') return { status: 403, body: { error: 'account_banned' } };
        const player = normalizePluginPlayer(plugin.player);
        const role = normalizeRole(plugin.player?.role);
        await this.sessions.storage.transaction(async (txn) => {
          const current = await txn.get<MinecraftChallenge>(challengeKey(challengeId));
          if (!current || current.status !== 'pending' || isExpired(current.expiresAt)) return;
          if (
            plugin.status === 'confirmed' &&
            player &&
            role &&
            validConfirmationTime(current, plugin.confirmedAt)
          ) {
            txn.put(challengeKey(challengeId), {
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

  async complete(
    challengeId: string,
    browserNonce: string,
    clientKey: string,
    sessionId: string,
  ): Promise<AuthResult> {
    const rateLimited = await consumeRateLimit(this.sessions.env.DB,
      rateLimitKey('minecraft-challenge:complete', clientKey),
      20,
      60,
    );
    if (rateLimited) return rateLimited;
    const record = await this.readMinecraftChallenge(challengeId);
    const rejected = minecraftChallengeError(record);
    if (rejected) return rejected;
    if (!record) return { status: 404, body: { error: 'not_found' } };
    const bindingError = await this.sessions.checkAuthenticationContext(
      record.context,
      browserNonce,
      sessionId,
    );
    if (bindingError) return bindingError;

    // Approvals remain readable until expiry. Only this store consumes an authentication request.
    const plugin = await this.fetchPluginChallenge(record.displayCode);
    if (plugin.status === 'unavailable')
      return { status: 503, body: { error: 'plugin_unavailable' } };
    if (plugin.status === 'banned') return { status: 403, body: { error: 'account_banned' } };
    const player = normalizePluginPlayer(plugin.player);
    const role = normalizeRole(plugin.player?.role);
    if (plugin.status !== 'confirmed')
      return { status: 409, body: { error: 'confirmation_required' } };
    if (!player) return { status: 502, body: { error: 'plugin_invalid_response' } };
    if (!role) return { status: 502, body: { error: 'plugin_invalid_response' } };
    if (!validConfirmationTime(record, plugin.confirmedAt))
      return { status: 409, body: { error: 'invalid_confirmation' } };
    const session = await this.sessions.prepareSession(
      player.uuid,
      'minecraft-challenge',
      plugin.confirmedAt,
    );
    const result = await this.sessions.storage.transaction(async (txn): Promise<AuthResult> => {
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
      const existing = await txn.players.get(player.uuid);
      if (existing?.disabledAt) return { status: 403, body: { error: 'account_disabled' } };
      const account: AccountRecord = {
        ...existing,
        playerUuid: player.uuid,
        currentName: player.name,
        role,
        banned: false,
      };
      const sessionError = await this.sessions.storeAuthenticatedSession(txn, record.context, session);
      if (sessionError) return sessionError;
      txn.players.save(account);
      txn.put(challengeKey(challengeId), { ...current, status: 'consumed' });
      txn.delete(codeKey(current.displayCode));
      return {
        status: 200,
        body: await sessionBody(
          session.sessionId,
          account,
          (await txn.owned('passkey', account.playerUuid)).size,
        ),
      };
    });
    if (result.status === 200) {
      this.sessions.authenticationCommitted(record.context);
    }
    return result;
  }

  private async readMinecraftChallenge(
    challengeId: string,
  ): Promise<Extract<ChallengeRecord, { type: 'minecraft-authentication' }> | null> {
    const record = await this.sessions.storage.get<ChallengeRecord>(challengeKey(challengeId));
    return record?.type === 'minecraft-authentication' ? record : null;
  }

  private async fetchPluginChallenge(code: string): Promise<PluginChallengeResponse> {
    const path = `/api/auth/challenges/${encodeURIComponent(code)}`;
    try {
      const response = await this.sessions.env.VPC_SERVICE.fetch(
        new URL(path, this.sessions.env.MINECRAFT_SERVER_URL),
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

  private async deleteMinecraftChallenge(record: MinecraftChallenge): Promise<void> {
    await this.sessions.storage.transaction(async (txn) => {
      txn.delete(challengeKey(record.challengeId));
      if ((await txn.get(codeKey(record.displayCode))) === record.challengeId)
        txn.delete(codeKey(record.displayCode));
    });
  }
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

function shouldCheckPlugin(value?: string): boolean {
  return !value || Date.now() - new Date(value).getTime() >= 5000;
}

function createDisplayCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value = new DataView(bytes.buffer).getUint32(0) % 100_000_000;
  return value.toString().padStart(8, '0');
}
