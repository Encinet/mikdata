import { fetchAfdianOrders, fetchAfdianSponsors, type AfdianCredentials, type AfdianOrder, type AfdianSponsor } from './afdian';

export const AFDIAN_FRESH_MS = 6 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const LEASE_MS = 60_000;
const LEASE_OWNED = 'EXISTS (SELECT 1 FROM afdian_sync WHERE creator=? AND lease=?)';

export interface AfdianPayload {
  fetchedAt: number;
  sponsors: AfdianSponsor[];
  orders: AfdianOrder[];
  ordersComplete: boolean;
}

export interface SyncState {
  fetched_at: number;
  orders_complete: number;
}

export function hasUsableSnapshot(sync: SyncState | undefined): sync is SyncState {
  return !!sync?.fetched_at && Date.now() - sync.fetched_at < MAX_AGE_MS;
}

export function afdianCreator(env: AfdianCredentials) {
  return env.AFDIAN_API_TOKEN?.trim() ? env.AFDIAN_USER_ID?.trim() : undefined;
}

// Bind small groups of rows as JSON so page imports stay below the statement parameter limit.
function* pages(rows: readonly unknown[]) {
  const encoder = new TextEncoder();
  let page: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const value = JSON.stringify(row);
    const size = encoder.encode(value).length + 1;
    if (page.length && bytes + size > 64 * 1024) {
      yield '[' + page.join(',') + ']';
      page = [];
      bytes = 0;
    }
    page.push(value);
    bytes += size;
  }
  if (page.length) yield '[' + page.join(',') + ']';
}

function* removeMissing(
  db: D1Database,
  table: 'afdian_orders' | 'afdian_sponsors',
  creator: string,
  lease: string,
  stored: { id: string }[],
  incoming: string[],
) {
  const key = table === 'afdian_orders' ? 'order_id' : 'user_id';
  const received = new Set(incoming);
  const removed = stored.filter(row => !received.has(row.id)).map(row => row.id);
  for (const page of pages(removed)) {
    yield db.prepare(`DELETE FROM ${table} WHERE creator=? AND ${key} IN (SELECT value FROM json_each(?))
      AND ${LEASE_OWNED}`).bind(creator, page, creator, lease);
  }
}

type SnapshotUpdate = Omit<AfdianPayload, 'sponsors'> & {
  sponsors: AfdianSponsor[] | undefined;
  nextAttempt: number;
};

async function publish(db: D1Database, creator: string, lease: string, payload: SnapshotUpdate) {
  const reads = [db.prepare('SELECT order_id AS id FROM afdian_orders WHERE creator=?').bind(creator)];
  if (payload.sponsors)
    reads.push(db.prepare('SELECT user_id AS id FROM afdian_sponsors WHERE creator=?').bind(creator));
  const [storedOrders, storedSponsors] = await db.batch<{ id: string }>(reads);

  // Compare values in SQLite and publish the resulting rows and metadata in one transaction.
  const writes = [...removeMissing(db, 'afdian_orders', creator, lease,
    storedOrders.results, payload.orders.map(order => order.outTradeNo))];
  for (const page of pages(payload.orders))
    writes.push(db.prepare(`INSERT INTO afdian_orders(creator,order_id,user_id,amount_minor,paid_at,message)
      SELECT ?,value->>'$.outTradeNo',value->>'$.userId',value->>'$.amountMinor',value->>'$.at',value->>'$.message'
      FROM json_each(?) WHERE ${LEASE_OWNED}
      ON CONFLICT(creator,order_id) DO UPDATE SET user_id=excluded.user_id,amount_minor=excluded.amount_minor,
        paid_at=excluded.paid_at,message=excluded.message
      WHERE afdian_orders.user_id IS NOT excluded.user_id OR afdian_orders.amount_minor IS NOT excluded.amount_minor
        OR afdian_orders.paid_at IS NOT excluded.paid_at OR afdian_orders.message IS NOT excluded.message`)
      .bind(creator, page, creator, lease));

  if (payload.sponsors) {
    writes.push(...removeMissing(db, 'afdian_sponsors', creator, lease,
      storedSponsors.results, payload.sponsors.map(sponsor => sponsor.userId)));
    for (const page of pages(payload.sponsors))
      writes.push(db.prepare(`INSERT INTO afdian_sponsors(creator,user_id,name)
        SELECT ?,value->>'$.userId',value->>'$.name' FROM json_each(?) WHERE ${LEASE_OWNED}
        ON CONFLICT(creator,user_id) DO UPDATE SET name=excluded.name WHERE afdian_sponsors.name IS NOT excluded.name`)
        .bind(creator, page, creator, lease));
  }

  writes.push(db.prepare(`UPDATE afdian_sync SET fetched_at=?,orders_complete=?,lease=NULL,next_attempt=?
    WHERE creator=? AND lease=?`).bind(payload.fetchedAt, Number(payload.ordersComplete), payload.nextAttempt, creator, lease));
  await db.batch(writes);
}

export async function refreshAfdian(env: AfdianCredentials & { DB: D1Database }, scheduledTime = Date.now()): Promise<void> {
  const creator = afdianCreator(env);
  if (!creator) return;
  const db = env.DB;
  const due = await db.prepare('SELECT next_attempt FROM afdian_sync WHERE creator=?').bind(creator).first<number>('next_attempt');
  const now = Date.now();
  if (due !== null && now < due) return;
  const lease = crypto.randomUUID();
  const previous = await db.prepare(`INSERT INTO afdian_sync(creator,lease,next_attempt) VALUES(?,?,?)
    ON CONFLICT(creator) DO UPDATE SET lease=excluded.lease,next_attempt=excluded.next_attempt
    WHERE afdian_sync.next_attempt<=?
    RETURNING fetched_at,orders_complete`).bind(creator, lease, now + LEASE_MS, now).first<SyncState>();
  if (!previous) return;

  let nextAttempt: number;
  try {
    const signal = AbortSignal.timeout(20_000);
    const [sponsors, { orders, status }] = await Promise.all([
      fetchAfdianSponsors(env, signal).catch(error => {
        console.warn('Afdian sponsor names unavailable', error);
        return undefined;
      }),
      fetchAfdianOrders(env, signal),
    ]);
    const fetchedAt = Date.now();
    if (status === 'incomplete' && previous.orders_complete && hasUsableSnapshot(previous)) {
      nextAttempt = Math.min(scheduledTime + RETRY_MS, previous.fetched_at + MAX_AGE_MS);
    } else {
      await publish(db, creator, lease, {
        fetchedAt,
        sponsors: sponsors ?? (hasUsableSnapshot(previous) ? undefined : []),
        orders,
        ordersComplete: status === 'complete',
        nextAttempt: scheduledTime + (status === 'incomplete' ? RETRY_MS : AFDIAN_FRESH_MS),
      });
      return;
    }
  } catch (error) {
    console.warn('Afdian refresh failed', error);
    nextAttempt = scheduledTime + RETRY_MS;
  }
  await db.prepare('UPDATE afdian_sync SET lease=NULL,next_attempt=? WHERE creator=? AND lease=?')
    .bind(nextAttempt, creator, lease).run();
}
