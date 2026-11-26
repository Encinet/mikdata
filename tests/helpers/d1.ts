import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('./d1-schema.sql', import.meta.url), 'utf8');

export function testDatabase() {
  const sqlite = new Database(':memory:');
  sqlite.exec(schema);
  const hooks: {
    before?: (sql: string, args: SQLQueryBindings[]) => void;
    beforeBatch?: (sql: string[]) => void;
    afterRead?: (sql: string, args: SQLQueryBindings[]) => Promise<void>;
  } = {};
  class Statement {
    constructor(readonly sql: string, readonly args: SQLQueryBindings[] = []) {}
    bind(...args: SQLQueryBindings[]) { return new Statement(this.sql, args); }
    execute() {
      hooks.before?.(this.sql, this.args);
      const stmt = sqlite.query(this.sql);
      const results = stmt.all(...this.args);
      const { changes } = sqlite.query('SELECT changes() AS changes').get() as { changes: number };
      return { success: true, results, meta: { changes } };
    }
    async first(key?: string) {
      hooks.before?.(this.sql, this.args);
      const row = sqlite.query(this.sql).get(...this.args) as Record<string, unknown> | null;
      await hooks.afterRead?.(this.sql, this.args);
      return key ? row?.[key] ?? null : row;
    }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      hooks.beforeBatch?.(statements.map(statement => statement.sql));
      return sqlite.transaction(() => statements.map(stmt => stmt.execute()))();
    },
  } as unknown as D1Database;
  return { db, sqlite, hooks };
}
