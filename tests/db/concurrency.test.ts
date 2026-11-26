import { authFixture, seedSession, PLAYER_UUID, authCall } from '../helpers/auth';
import { expect, test } from 'bun:test';
import { AuthRepository, sessionKey } from '../../src/auth/repository';
import { consumeRateLimit } from '../../src/auth/rate-limit';
import { testDatabase } from '../helpers/d1';

test('concurrent changes to distinct sessions commit without retrying other players', async () => {
  const { db } = testDatabase();
  const auth = new AuthRepository(db);
  let executions = 0;
  await Promise.all(Array.from({ length: 32 }, (_, index) => auth.transaction(async records => {
    executions++;
    const key = sessionKey('session-' + index);
    expect(await records.get(key)).toBeUndefined();
    records.put(key, { playerUuid: 'player-' + index });
  })));
  expect(executions).toBe(32);
});

test('an owner set changed between read and commit is reloaded even if the count stays the same', async () => {
  const { db, sqlite, hooks } = testDatabase();
  const auth = new AuthRepository(db);
  const document = JSON.stringify({ playerUuid: 'player' });
  sqlite.query('INSERT INTO auth_sessions(id,document) VALUES(?,?)').run('first', document);
  hooks.beforeBatch = () => {
    hooks.beforeBatch = undefined;
    sqlite.query("UPDATE auth_sessions SET id='second' WHERE id='first'").run();
  };
  let executions = 0;
  const removed = await auth.transaction(async records => {
    executions++;
    const owned = await records.owned('session', 'player');
    for (const id of owned.keys()) records.delete(sessionKey(id));
    return [...owned.keys()];
  });
  expect(removed).toEqual(['second']);
  expect(executions).toBe(2);
  expect(sqlite.query('SELECT id FROM auth_sessions').all()).toEqual([]);
});

test('a current session check reads its account and passkey count once and updates only the limit', async () => {
  const f = authFixture();
  const session = await seedSession(f.values);
  f.values.set('account:' + PLAYER_UUID, { ...f.values.get('account:' + PLAYER_UUID), policyCheckedAt: Date.now() });
  const statements: string[] = [];
  const batches: string[][] = [];
  f.hooks.before = sql => { statements.push(sql); };
  f.hooks.beforeBatch = sql => { batches.push(sql); };
  const response = await authCall(f.store, { action: 'me', sessionId: session.token });
  expect(response.body.account).toMatchObject({ playerUuid: PLAYER_UUID, passkeyCount: 0 });
  expect(statements[0]).toContain('JOIN players');
  expect(statements).toHaveLength(3);
  expect(batches).toEqual([statements.slice(1)]);
  expect(statements[1]).toContain('UPDATE auth_rate_limits SET count=');
  expect(statements[2]).toContain('INSERT INTO auth_rate_limits');
});

test('the rate limit increments concurrently and renews its indexed expiry only at rollover', async () => {
  const { db, sqlite } = testDatabase();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    sqlite.exec(`CREATE TABLE expiry_updates (at INTEGER);
      CREATE TRIGGER observe_expiry_update AFTER UPDATE OF reset_at ON auth_rate_limits
      BEGIN INSERT INTO expiry_updates VALUES(NEW.reset_at); END;`);
    const hit = () => consumeRateLimit(db, 'test:account', 3, 60);
    expect(await hit()).toBeNull();
    now += 10_000;
    const results = await Promise.all(Array.from({ length: 6 }, hit));
    expect(results.filter(result => result === null)).toHaveLength(2);
    expect(results.filter(result => result !== null)).toEqual(Array.from({ length: 4 }, () => ({
      status: 429, body: { error: 'rate_limited', retryAfterSeconds: 50 },
    })));
    expect(sqlite.query('SELECT * FROM expiry_updates').all()).toEqual([]);
    now += 50_000;
    expect(await hit()).toBeNull();
    expect(sqlite.query('SELECT count,reset_at FROM auth_rate_limits').get()).toEqual({ count: 1, reset_at: now + 60_000 });
    expect(sqlite.query('SELECT * FROM expiry_updates').all()).toEqual([{ at: now + 60_000 }]);
  } finally {
    Date.now = originalNow;
  }
});
