import type { SessionRecord } from './model';
import { PlayerRepository, playerAccount, type PlayerRow } from '../players/repository';
import { transact, type Transaction } from '../db/transaction';

type AuthTable = 'auth_sessions' | 'auth_passkeys' | 'auth_challenges' | 'auth_codes' | 'auth_webauthn';
interface RecordKey { table: AuthTable; id: string }

export const sessionKey = (id: string): RecordKey => ({ table: 'auth_sessions', id });
export const passkeyKey = (id: string): RecordKey => ({ table: 'auth_passkeys', id });
export const challengeKey = (id: string): RecordKey => ({ table: 'auth_challenges', id });
export const codeKey = (id: string): RecordKey => ({ table: 'auth_codes', id });
export const webauthnChallengeKey = (id: string): RecordKey => ({ table: 'auth_webauthn', id });

export class AuthRecords {
  private readonly pending = new Map<string, string | null>();

  readonly players: PlayerRepository;

  constructor(readonly db: D1Database, readonly tx?: Transaction) {
    this.players = new PlayerRepository(db, tx);
  }

  async get<T>({ table, id }: RecordKey): Promise<T | undefined> {
    let value = this.pending.get(table + ':' + id);
    if (value === undefined) {
      value = await this.db.prepare(`SELECT document FROM ${table} WHERE id=?`).bind(id).first<string>('document');
      if (this.tx) {
        this.tx.expect(`(SELECT document FROM ${table} WHERE id=?) IS ?`, id, value);
        this.pending.set(table + ':' + id, value);
      }
    }
    return value == null ? undefined : JSON.parse(value);
  }

  put({ table, id }: RecordKey, value: unknown) {
    if (!this.tx) throw new Error('Authentication writes require a transaction');
    const document = JSON.stringify(value);
    this.pending.set(table + ':' + id, document);
    this.tx.write(`INSERT INTO ${table}(id,document) VALUES(?,?)
      ON CONFLICT(id) DO UPDATE SET document=excluded.document`, id, document);
  }

  delete({ table, id }: RecordKey) {
    if (!this.tx) throw new Error('Authentication writes require a transaction');
    this.pending.set(table + ':' + id, null);
    this.tx.write(`DELETE FROM ${table} WHERE id=?`, id);
  }

  async owned<T>(kind: 'session' | 'passkey', uuid: string): Promise<Map<string, T>> {
    const table = kind === 'session' ? 'auth_sessions' : 'auth_passkeys';
    const { results } = await this.db.prepare(`SELECT id,document FROM ${table} WHERE player_uuid=? ORDER BY id`)
      .bind(uuid).all<{ id: string; document: string }>();
    if (this.tx) {
      // Both the membership and contents of this player's indexed set must still match.
      const observed = JSON.stringify(results.map(row => [row.id, row.document]));
      this.tx.expect(`(SELECT count(*) FROM ${table} WHERE player_uuid=?)=? AND NOT EXISTS (
        SELECT id,document FROM ${table} WHERE player_uuid=?
        EXCEPT SELECT value->>0,value->>1 FROM json_each(?))`, uuid, results.length, uuid, observed);
    }
    const records = new Map<string,T>(results.map(row => [row.id, JSON.parse(row.document)]));
    for (const [key, document] of this.pending) {
      if (!key.startsWith(table + ':')) continue;
      const id = key.slice(table.length + 1);
      const item = document && JSON.parse(document);
      if (item?.playerUuid === uuid) records.set(id, item);
      else records.delete(id);
    }
    return records;
  }
}

export class AuthRepository extends AuthRecords {
  async chatSessions(refs: string[]) {
    const sessions = new Map<string, { session: SessionRecord; account: ReturnType<typeof playerAccount> }>();
    if (!refs.length) return sessions;
    const { results } = await this.db.prepare(`SELECT p.*, s.id AS ref, s.document AS session
      FROM auth_sessions s JOIN players p ON p.id=s.player_uuid WHERE s.id IN (${refs.map(() => '?').join(',')})`)
      .bind(...refs).all<PlayerRow & { ref: string; session: string }>();
    for (const row of results) sessions.set(row.ref, { session: JSON.parse(row.session), account: playerAccount(row) });
    return sessions;
  }

  async sessionAccount(sidHash: string) {
    const row = await this.db.prepare(`SELECT p.*,s.document AS session,
      (SELECT count(*) FROM auth_passkeys k WHERE k.player_uuid=p.id) AS passkeys
      FROM auth_sessions s JOIN players p ON p.id=s.player_uuid WHERE s.id=?`)
      .bind(sidHash).first<PlayerRow & { session: string; passkeys: number }>();
    if (!row) return null;
    return { session: JSON.parse(row.session) as SessionRecord, account: playerAccount(row), passkeys: row.passkeys };
  }

  transaction<T>(work: (records: AuthRecords) => Promise<T>) {
    return transact(this.db, undefined, tx => work(new AuthRecords(this.db, tx)));
  }
}

export async function maintainAuth(db: D1Database) {
  const cutoff = new Date().toISOString();
  await db.batch([
    db.prepare(`DELETE FROM auth_codes WHERE (id,json_extract(document,'$')) IN
      (SELECT json_extract(document,'$.displayCode'),id FROM auth_challenges WHERE expires_at<=? ORDER BY expires_at LIMIT 256)`).bind(cutoff),
    ...['auth_challenges', 'auth_webauthn', 'auth_sessions'].map(table =>
      db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE expires_at<=? ORDER BY expires_at LIMIT 256)`).bind(cutoff)),
    db.prepare('DELETE FROM auth_rate_limits WHERE id IN (SELECT id FROM auth_rate_limits WHERE reset_at<=? LIMIT 1024)').bind(Date.now()),
  ]);
}
