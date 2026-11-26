import type { WebAuthnCredential } from '@simplewebauthn/server';
import { chatSessionScope } from './tokens';
import type { AccountRecord } from '../players/accounts';

export interface SessionRecord {
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

export interface PasskeyRecord {
  credentialId: string;
  playerUuid: string;
  publicKey: string;
  counter: number;
  transports?: WebAuthnCredential['transports'];
  createdAt: string;
  lastUsedAt?: string;
  displayName?: string;
}

export type AuthenticationContext =
  | { purpose: 'login'; browserNonceHash: string }
  | { purpose: 'reauthenticate'; playerUuid: string; sessionHash: string };

interface ChallengeLifetime {
  createdAt: string;
  expiresAt: string;
}

export type ChallengeRecord =
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

export type MinecraftChallenge = Extract<ChallengeRecord, { type: 'minecraft-authentication' }>;

export type AuthResult = { status: number; body: Record<string, unknown> };

export function activeSession(session: SessionRecord | undefined | null): session is SessionRecord {
  if (!session || typeof session.authenticatedAt !== 'string') return false;
  const authenticatedAt = Date.parse(session.authenticatedAt);
  return (
    Number.isFinite(authenticatedAt) &&
    authenticatedAt <= Date.now() + 5000 &&
    !isExpired(session.idleExpiresAt) &&
    !isExpired(session.absoluteExpiresAt)
  );
}

export function sameAuthenticationContext(
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

const RECENT_AUTH_SECONDS = 5 * 60;

export function recentlyAuthenticated(session: SessionRecord): boolean {
  const time = Date.parse(session.authenticatedAt);
  return (
    Number.isFinite(time) &&
    time <= Date.now() + 5000 &&
    Date.now() - time < RECENT_AUTH_SECONDS * 1000
  );
}

export function reauthenticationRequired(): AuthResult {
  return { status: 403, body: { error: 'reauthentication_required' } };
}

export async function sessionBody(
  sessionId: string,
  account: AccountRecord,
  passkeyCount: number,
): Promise<Record<string, unknown>> {
  return {
    authenticated: true,
    sessionId,
    clearLogin: true,
    account: {
      chatScope: await chatSessionScope(sessionId),
      playerUuid: account.playerUuid,
      currentName: account.currentName,
      role: account.role,
      passkeyCount,
    },
  };
}

export function securityDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim();
  if ([...name].length > 64 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return null;
  return name;
}

export function isExpired(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isFinite(time) || time <= Date.now();
}
