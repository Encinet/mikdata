import type { Transaction } from '../db/transaction';
import type { AccountRecord } from './accounts';

export interface PlayerRow {
  id: string;
  current_name: string;
  role: string;
  disabled_at: string | null;
  banned: number;
  credentials_changed_at: number;
  policy_checked_at: number;
}

export function playerRow(account: AccountRecord): PlayerRow {
  return {
    id: account.playerUuid,
    current_name: account.currentName,
    role: account.role,
    disabled_at: account.disabledAt ?? null,
    banned: Number(account.banned ?? false),
    credentials_changed_at: account.credentialsChangedAt ?? 0,
    policy_checked_at: account.policyCheckedAt ?? 0,
  };
}

export function playerAccount(row: PlayerRow): AccountRecord {
  return {
    playerUuid: row.id,
    currentName: row.current_name,
    role: row.role,
    ...(row.disabled_at && { disabledAt: row.disabled_at }),
    banned: Boolean(row.banned),
    credentialsChangedAt: row.credentials_changed_at,
    policyCheckedAt: row.policy_checked_at,
  };
}

export class PlayerRepository {
  private readonly pending = new Map<string, AccountRecord>();

  constructor(private readonly db: D1Database, private readonly tx?: Transaction) {}

  async get(uuid: string): Promise<AccountRecord | undefined> {
    const pending = this.pending.get(uuid);
    if (pending) return pending;
    const row = await this.db.prepare('SELECT * FROM players WHERE id=?').bind(uuid).first<PlayerRow>();
    if (this.tx) {
      if (row) this.tx.expect(`EXISTS (SELECT 1 FROM players WHERE id=? AND current_name=? AND role=? AND disabled_at IS ?
        AND banned=? AND credentials_changed_at=? AND policy_checked_at=?)`, uuid, row.current_name, row.role,
        row.disabled_at, row.banned, row.credentials_changed_at, row.policy_checked_at);
      else this.tx.expect('NOT EXISTS (SELECT 1 FROM players WHERE id=?)', uuid);
    }
    if (!row) return undefined;
    const account = playerAccount(row);
    if (this.tx) this.pending.set(uuid, account);
    return account;
  }

  save(account: AccountRecord) {
    if (!this.tx) throw new Error('Player writes require a transaction');
    const row = playerRow(account);
    this.tx.write(`INSERT INTO players(id,current_name,role,disabled_at,banned,credentials_changed_at,policy_checked_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_name=excluded.current_name,role=excluded.role,
      disabled_at=excluded.disabled_at,banned=excluded.banned,credentials_changed_at=excluded.credentials_changed_at,
      policy_checked_at=excluded.policy_checked_at`, row.id, row.current_name, row.role, row.disabled_at,
      row.banned, row.credentials_changed_at, row.policy_checked_at);
    this.pending.set(row.id, account);
  }
}
