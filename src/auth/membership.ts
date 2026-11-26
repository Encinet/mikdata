import type { Transaction } from '../db/transaction';
import { PlayerRepository } from '../players/repository';
import { eligibleMemberAccount, type AccountRecord } from '../players/accounts';
import type { AuthResult, SessionRecord } from './model';

export async function memberAtCommit(tx: Transaction, session: SessionRecord): Promise<AccountRecord | AuthResult> {
  requireMemberAtCommit(tx, session.sidHash, session.playerUuid);
  const account = await new PlayerRepository(tx.db).get(session.playerUuid);
  if (!eligibleMemberAccount(account)) return { status: 403, body: { error: 'member_required' } };
  return account;
}

export function membershipError(error: unknown): AuthResult | undefined {
  const message = String(error);
  if (message.includes('current_session_required')) return { status: 401, body: { error: 'unauthenticated' } };
  if (message.includes('membership_required')) return { status: 403, body: { error: 'member_required' } };
}

export function requireMemberAtCommit(tx: Transaction, sessionHash: string, uuid: string) {
  // Recheck the clock inside SQLite as well. A session can expire while an upload is being validated.
  tx.check(`INSERT INTO member_write_checks(active,member)
    SELECT 0,1 WHERE NOT EXISTS (
      SELECT 1 FROM auth_sessions s JOIN players p ON p.id=s.player_uuid
      WHERE s.id=? AND p.id=? AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND p.banned=0
        AND p.disabled_at IS NULL
        AND json_extract(s.document,'$.authenticatedAt') >
          strftime('%Y-%m-%dT%H:%M:%fZ',p.credentials_changed_at/1000.0,'unixepoch')
    )`, sessionHash, uuid);
  tx.check(`INSERT INTO member_write_checks(active,member)
    SELECT 1,0 WHERE NOT EXISTS (SELECT 1 FROM players WHERE id=?
      AND role IN ('member','moderator','custodian'))`, uuid);
}
