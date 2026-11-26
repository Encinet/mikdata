// D1 executes a batch atomically. Revalidate the reads that informed a write inside that batch.
export class DatabaseBusy extends Error {}

type Domain = 'buildings';

export class Transaction {
  private readonly assertions: D1PreparedStatement[] = [];
  private readonly statements: D1PreparedStatement[] = [];
  private readonly afterCommitCallbacks: (() => void)[] = [];
  private modified = false;

  constructor(readonly db: D1Database) {}

  write(sql: string, ...args: unknown[]) {
    this.modified = true;
    this.statements.push(this.db.prepare(sql).bind(...args));
  }

  check(sql: string, ...args: unknown[]) {
    this.assertions.push(this.db.prepare(sql).bind(...args));
  }

  afterCommit(callback: () => void) {
    this.afterCommitCallbacks.push(callback);
  }

  expect(predicate: string, ...args: unknown[]) {
    this.check('INSERT INTO auth_read_checks(valid) SELECT 0 WHERE NOT (' + predicate + ')', ...args);
  }

  async commit(domain?: Domain, version?: number) {
    if (domain && !this.assertions.length && !this.statements.length) {
      const current = await this.db.prepare('SELECT version FROM domain_revisions WHERE domain=?').bind(domain).first<number>('version');
      return current === version;
    }
    const guards = [...this.assertions];
    if (domain) guards.unshift(this.db.prepare(`UPDATE domain_revisions
      SET version=CASE WHEN version=? THEN version+? ELSE -1 END WHERE domain=?`)
      .bind(version, Number(this.modified), domain));
    try {
      if (guards.length || this.statements.length) await this.db.batch([...guards, ...this.statements]);
    } catch (error) {
      if (/revision_matches|auth_read_matches/.test(String(error))) return false;
      throw error;
    }
    for (const callback of this.afterCommitCallbacks) callback();
    return true;
  }
}

export async function transact<T>(db: D1Database, domain: Domain | undefined, work: (tx: Transaction) => Promise<T>): Promise<T> {
  const revision = domain && db.prepare('SELECT version FROM domain_revisions WHERE domain=?').bind(domain);
  for (let attempt = 0; attempt < 6; attempt++) {
    const version = await revision?.first<number>('version');
    if (version === null) throw new Error(`Missing database revision for ${domain}`);
    const tx = new Transaction(db);
    const value = await work(tx);
    if (await tx.commit(domain, version)) return value;
  }
  throw new DatabaseBusy('Concurrent database updates');
}
