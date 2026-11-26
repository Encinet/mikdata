import { testDatabase } from '../helpers/d1';
import { expect, test } from 'bun:test';
import { afdianOrderTime, fetchAfdianOrders, fetchAfdianSponsors } from '../../src/sponsors/afdian';
import { AFDIAN_FRESH_MS, refreshAfdian } from '../../src/sponsors/snapshot';
import { readSponsorCatalog, readSponsorOverview } from '../../src/sponsors/queries';
import { afdianSign, md5Hex } from '../../src/sponsors/md5';
import worker from '../../src/index';
import { AFDIAN_ORDER_ID, afdianOrder, mockAfdian, sponsorEnv } from './helpers';

const credentials = { AFDIAN_USER_ID: 'creator', AFDIAN_API_TOKEN: 'token' };

test('Afdian signatures match the reference vector and dates use Unix seconds', () => {
  expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  expect(afdianSign('123', 'abc', '{"a":333}', 1624339905)).toBe('a4acc28b81598b7e5d84ebdc3e91710c');
  expect(afdianOrderTime('202106232138371083454010626')).toBe(1624455517);
  expect(afdianOrderTime('202602300930591234567890123')).toBeUndefined();
});

test('Afdian adapters deduplicate by source IDs and flag malformed paid orders', async () => {
  const pages: number[] = [];
  const restore = mockAfdian((endpoint, page) => {
    if (endpoint === 'query-sponsor') {
      pages.push(page);
      return { total_page: 2, list: [{ user: { user_id: 'u-1', name: 'First' } }] };
    }
    return { total_page: 2, list: [
      afdianOrder(),
      afdianOrder({ status: 3, out_trade_no: 'refunded' }),
      afdianOrder({ out_trade_no: '202611220912241234567', total_amount: 'NaN' }),
      afdianOrder({ out_trade_no: '202602300930591234567890123' }),
    ] };
  });
  try {
    const env = sponsorEnv(credentials);
    expect(await fetchAfdianSponsors(env)).toEqual([{ userId: 'u-1', name: 'First' }]);
    expect(pages).toEqual([1, 2]);
    const { orders, status } = await fetchAfdianOrders(env);
    expect(status).toBe('incomplete');
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ amountMinor: 2000, userId: 'u-1' });
  } finally {
    restore();
  }
});

test('a changing page count invalidates the roster scan and leaves order totals unconfirmed', async () => {
  const restore = mockAfdian((_endpoint, page) => ({ total_page: page === 1 ? 2 : 3, list: [afdianOrder()] }));
  try {
    const env = sponsorEnv(credentials);
    await expect(fetchAfdianSponsors(env)).rejects.toThrow('sponsor page count changed');
    const { orders, status } = await fetchAfdianOrders(env);
    expect(status).toBe('incomplete');
    expect(orders).toHaveLength(1);
  } finally {
    restore();
  }
});

test('catalog reads never fetch Afdian and overlapping background runs share one refresh', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let calls = 0;
  let unavailable = false;
  const restore = mockAfdian(() => {
    calls++;
    if (unavailable) throw new Error('upstream down');
    return { total_page: 0, list: [] };
  });
  try {
    const env = sponsorEnv(credentials);
    const read = async () => (await readSponsorCatalog({ ...env }, { kind: 'public' })).payload;
    const refresh = () => Promise.all([refreshAfdian(env), refreshAfdian({ ...env })]);
    expect(await read()).toBeUndefined();
    expect((await readSponsorOverview(env)).metadata).toBeUndefined();
    expect(calls).toBe(0);

    await refresh();
    const initial = await read();
    expect(initial?.ordersComplete).toBe(true);
    expect(calls).toBe(2);
    now += AFDIAN_FRESH_MS - 1;
    await refresh();
    expect(calls).toBe(2);

    now += 1;
    unavailable = true;
    const concurrent = await Promise.all([read(), read()]);
    expect(concurrent).toEqual([initial, initial]);
    expect(calls).toBe(2);
    await refresh();
    expect(await read()).toEqual(initial);
    expect(calls).toBe(4);
    now += 7 * 24 * 60 * 60_000;
    expect(await read()).toBeUndefined();
    expect(calls).toBe(4);
  } finally {
    restore();
    Date.now = originalNow;
  }
});

test('only hourly Worker events check Afdian without shifting the six-hour schedule', async () => {
  const database = testDatabase();
  const env = sponsorEnv(credentials, database);
  const hour = Date.UTC(2026, 10, 25, 0);
  let dueChecks = 0;
  let requests = 0;
  database.hooks.before = sql => {
    if (sql.startsWith('SELECT next_attempt FROM afdian_sync')) dueChecks++;
  };
  const originalNow = Date.now;
  const restore = mockAfdian(() => {
    requests++;
    return { total_page: 0, list: [] };
  });
  const tick = async (scheduledTime: number) => {
    Date.now = () => scheduledTime + 15_000;
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime } as ScheduledEvent, env, {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    } as ExecutionContext);
    await Promise.all(pending);
  };
  try {
    for (let time = hour; time <= hour + AFDIAN_FRESH_MS; time += 5 * 60_000) {
      await tick(time);
    }
    expect(dueChecks).toBe(7);
    expect(requests).toBe(4);
    expect(database.sqlite.query('SELECT fetched_at,next_attempt FROM afdian_sync').get()).toEqual({
      fetched_at: hour + AFDIAN_FRESH_MS + 15_000,
      next_attempt: hour + 2 * AFDIAN_FRESH_MS,
    });
  } finally {
    restore();
    Date.now = originalNow;
  }
});

test('player detail queries seek both order indexes and exclude unrelated payments', async () => {
  const database = testDatabase();
  const env = sponsorEnv(credentials, database);
  const now = Date.now();
  database.sqlite.query('INSERT INTO afdian_sync(creator,fetched_at,orders_complete,next_attempt) VALUES(?,?,1,?)')
    .run('creator', now, now + AFDIAN_FRESH_MS);
  for (const id of ['first','second']) {
    database.sqlite.query('INSERT INTO sponsor_accounts VALUES(?,?)').run(id, id);
    database.sqlite.query('INSERT INTO sponsor_orders VALUES(?,?,20,1700000000,NULL)').run(id, id);
    database.sqlite.query("INSERT INTO afdian_orders VALUES('creator',?,?,30,1700000000,NULL)").run(id, id);
  }
  const plans: string[] = [];
  database.hooks.before = (sql, args) => {
    if (!sql.startsWith('SELECT')) return;
    const rows = database.sqlite.query('EXPLAIN QUERY PLAN ' + sql).all(...args) as { detail: string }[];
    plans.push(...rows.map(row => row.detail));
  };
  const { players } = await readSponsorCatalog(env, { kind: 'player', id: 'first' });
  expect([...players.keys()]).toEqual(['first']);
  expect(players.get('first')?.orders).toHaveLength(2);
  expect(plans.some(row => row.includes('SEARCH afdian_orders USING INDEX afdian_orders_user'))).toBe(true);
  expect(plans.some(row => row.includes('SEARCH sponsor_orders USING INDEX sponsor_orders_player'))).toBe(true);
  expect(plans.some(row => /^SCAN (afdian_orders|sponsor_orders)/.test(row))).toBe(false);
});

test('overview aggregates order totals exactly across the JavaScript safe integer range', async () => {
  const f = testDatabase();
  const env = sponsorEnv({}, f);
  const amount = 99_999_999_999_999;
  f.sqlite.query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100)
    INSERT INTO sponsor_orders SELECT 'order-'||i,'player',?,1700000000,'message' FROM n`).run(amount);
  const { overview } = await readSponsorOverview(env);
  expect(overview.players).toMatchObject([{ uuid: 'player', totalAmount: '99999999999999.00', manual: true }]);
});

test('a failed refresh batch keeps the complete prior snapshot, including its names', async () => {
  const db = testDatabase();
  const env = sponsorEnv(credentials, db);
  const now = Date.now();
  db.sqlite.query('INSERT INTO afdian_sync(creator,fetched_at,orders_complete,next_attempt) VALUES(?,?,1,0)')
    .run('creator', now - AFDIAN_FRESH_MS - 1);
  db.sqlite.run("INSERT INTO afdian_sponsors VALUES('creator','u-1','Original')");
  db.sqlite.run("INSERT INTO afdian_orders VALUES('creator','old','u-1',10,1700000000,NULL)");
  db.hooks.before = sql => {
    if (sql.includes('UPDATE afdian_sync SET fetched_at=')) throw new Error('injected publish failure');
  };
  const restore = mockAfdian(endpoint => ({
    total_page: 1, list: endpoint === 'query-sponsor' ? [{ user: { user_id: 'u-1', name: 'New' } }] : [afdianOrder()],
  }));
  try {
    await refreshAfdian(env);
    const { pending } = await readSponsorCatalog(env, { kind: 'account', id: 'u-1' });
    expect(pending.get('u-1')).toMatchObject({ name: 'Original', totalMinor: 10n, orders: [{ id: 'af:old' }] });
  } finally {
    restore();
  }
});

test('refresh writes only changed orders and names, including refunds and removed names', async () => {
  const db = testDatabase();
  const env = sponsorEnv(credentials, db);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const removedId = '202611220912241234567';
  const addedId = '202611220912251234567';
  const person = (user_id: string, name: string) => ({ user: { user_id, name } });
  let sponsors = [person('u-1', 'First'), person('u-2', 'Second')];
  let orders = [afdianOrder({ remark: 'Message' }), afdianOrder({ out_trade_no: removedId, user_id: 'u-2' })];
  const restore = mockAfdian(endpoint => ({ total_page: 1, list: endpoint === 'query-sponsor' ? sponsors : orders }));
  try {
    await refreshAfdian(env);
    db.sqlite.run('CREATE TABLE observed_writes (item TEXT, action TEXT)');
    for (const [table, key] of [['afdian_orders', 'order_id'], ['afdian_sponsors', 'user_id']]) {
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = action === 'DELETE' ? 'OLD' : 'NEW';
        db.sqlite.run(`CREATE TRIGGER observe_${table}_${action} AFTER ${action} ON ${table}
          BEGIN INSERT INTO observed_writes VALUES (${row}.${key},'${action}'); END`);
      }
    }
    const writes = () => db.sqlite.query('SELECT item,action FROM observed_writes ORDER BY item').all();
    now += AFDIAN_FRESH_MS;
    await refreshAfdian(env);
    expect(writes()).toEqual([]);
    expect((await readSponsorOverview(env)).metadata?.fetchedAt).toBe(now);

    sponsors = [person('u-1', 'Renamed'), person('u-3', 'Third')];
    orders = [
      afdianOrder({ total_amount: '25.00' }),
      afdianOrder({ out_trade_no: removedId, user_id: 'u-2', status: 3 }),
      afdianOrder({ out_trade_no: addedId, user_id: 'u-3' }),
    ];
    now += AFDIAN_FRESH_MS;
    await refreshAfdian(env);
    expect(writes()).toEqual([
      { item: AFDIAN_ORDER_ID, action: 'UPDATE' },
      { item: removedId, action: 'DELETE' },
      { item: addedId, action: 'INSERT' },
      { item: 'u-1', action: 'UPDATE' },
      { item: 'u-2', action: 'DELETE' },
      { item: 'u-3', action: 'INSERT' },
    ]);
    const { pending } = await readSponsorCatalog(env, { kind: 'account', id: 'u-1' });
    expect(pending.get('u-1')).toMatchObject({ name: 'Renamed', totalMinor: 2500n });
    expect(pending.get('u-1')?.orders[0].message).toBeUndefined();
  } finally {
    restore();
    Date.now = originalNow;
  }
});

test('a displaced refresh cannot delete or overwrite rows published by the new lease owner', async () => {
  const db = testDatabase();
  const env = sponsorEnv(credentials, db);
  const now = Date.now();
  db.sqlite.query('INSERT INTO afdian_sync(creator,fetched_at,orders_complete,next_attempt) VALUES(?,?,1,0)')
    .run('creator', now - AFDIAN_FRESH_MS);
  db.sqlite.run("INSERT INTO afdian_orders VALUES('creator','keeper','u-1',10,1700000000,NULL)");
  db.sqlite.run("INSERT INTO afdian_sponsors VALUES('creator','u-1','Before')");
  db.hooks.beforeBatch = statements => {
    if (!statements.some(sql => sql.startsWith('UPDATE afdian_sync SET fetched_at='))) return;
    db.sqlite.query("UPDATE afdian_sync SET fetched_at=?,lease=NULL,next_attempt=? WHERE creator='creator'")
      .run(now, now + AFDIAN_FRESH_MS);
    db.sqlite.run("UPDATE afdian_orders SET amount_minor=30 WHERE order_id='keeper'");
    db.sqlite.run("UPDATE afdian_sponsors SET name='After' WHERE user_id='u-1'");
  };
  const restore = mockAfdian(endpoint => ({
    total_page: 1, list: endpoint === 'query-sponsor' ? [{ user: { user_id: 'u-1', name: 'Displaced' } }] : [afdianOrder()],
  }));
  try {
    await refreshAfdian(env);
    expect((await readSponsorOverview(env)).metadata?.fetchedAt).toBe(now);
    const { pending } = await readSponsorCatalog(env, { kind: 'account', id: 'u-1' });
    expect(pending.get('u-1')).toMatchObject({ name: 'After', totalMinor: 30n });
    expect(pending.get('u-1')?.orders.map(order => order.id)).toEqual(['af:keeper']);
  } finally {
    restore();
  }
});
