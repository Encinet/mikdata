import { expect, test } from 'bun:test';
import { requireMemberAtCommit } from '../../src/auth/membership';
import { transact } from '../../src/db/transaction';
import { authFixture, seedSession, PLAYER_UUID } from '../helpers/auth';

test('SQLite rejects an expired session when committing a member write', async () => {
  const f = authFixture();
  const { record } = await seedSession(f.values);
  f.values.set('session:' + record.sidHash, { ...record, idleExpiresAt: '2000-01-01T00:00:00.000Z' });
  await expect(transact(f.env.DB, 'buildings', async tx => {
    requireMemberAtCommit(tx, record.sidHash, PLAYER_UUID);
    tx.write("INSERT INTO buildings(id,document) VALUES('expired','{}')");
  })).rejects.toThrow('current_session_required');
  expect(f.db.query('SELECT id FROM buildings').all()).toEqual([]);
  expect(f.db.query("SELECT version FROM domain_revisions WHERE domain='buildings'").get()).toEqual({ version: 0 });
});
