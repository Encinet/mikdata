import type { Env } from '../env';
import { buildCatalog, catalogOverview, type SponsorSubtotal } from './catalog';
import { afdianCreator, hasUsableSnapshot, type AfdianPayload, type SyncState } from './snapshot';
import type { AfdianOrder, AfdianSponsor } from './afdian';
import { manualOrder, type OrderRow } from './model';

export type SponsorScope = { kind: 'public' } | { kind: 'player' | 'account'; id: string };

export async function readSponsorCatalog(env: Env, scope: SponsorScope) {
  const db = env.DB;
  const creator = afdianCreator(env) ?? '';
  const owner = scope.kind === 'public' ? [] : [scope.id];
  const playerFilter = scope.kind === 'public' ? '' : scope.kind === 'player' ? ' WHERE player_uuid=?' : ' WHERE 0';
  const playerArgs = scope.kind === 'player' ? owner : [];
  const mappingFilter = scope.kind === 'account' ? ' WHERE afdian_id=?' : playerFilter;
  let upstreamFilter = ' AND user_id IN (SELECT afdian_id FROM sponsor_accounts)';
  if (scope.kind === 'player') upstreamFilter = ' AND user_id IN (SELECT afdian_id FROM sponsor_accounts WHERE player_uuid=?)';
  if (scope.kind === 'account') upstreamFilter = ' AND user_id=?';

  // A binding can move to another player during a read. Get the binding and every contributing row together.
  const [meta, sponsors, payments, orders, mappings, names] = await db.batch([
    db.prepare('SELECT fetched_at,orders_complete FROM afdian_sync WHERE creator=?').bind(creator),
    db.prepare('SELECT user_id AS userId,name FROM afdian_sponsors WHERE creator=?' + upstreamFilter).bind(creator, ...owner),
    db.prepare(`SELECT order_id AS outTradeNo,user_id AS userId,amount_minor AS amountMinor,paid_at AS at,message
      FROM afdian_orders WHERE creator=?` + upstreamFilter).bind(creator, ...owner),
    db.prepare('SELECT * FROM sponsor_orders' + playerFilter + ' ORDER BY id').bind(...playerArgs),
    db.prepare('SELECT afdian_id,player_uuid FROM sponsor_accounts' + mappingFilter).bind(...owner),
    db.prepare('SELECT player_uuid,name FROM sponsor_names' + playerFilter).bind(...playerArgs),
  ]);
  const sync = meta.results[0] as unknown as SyncState | undefined;
  let payload: AfdianPayload | undefined;
  if (!creator) payload = { fetchedAt: 0, ordersComplete: true, sponsors: [], orders: [] };
  else if (hasUsableSnapshot(sync)) payload = {
    fetchedAt: sync.fetched_at, ordersComplete: Boolean(sync.orders_complete),
    sponsors: sponsors.results as unknown as AfdianSponsor[],
    orders: (payments.results as unknown as (Omit<AfdianOrder,'message'> & { message: string | null })[])
      .map(({ message, ...order }) => message ? { ...order, message } : order),
  };
  return { payload, ...buildCatalog(payload, {
    manualOrders: new Map((orders.results as OrderRow[]).map(row => [row.id, manualOrder(row)])),
    mappings: new Map((mappings.results as { afdian_id: string; player_uuid: string }[]).map(row => [row.afdian_id, row.player_uuid])),
    names: new Map((names.results as { player_uuid: string; name: string }[]).map(row => [row.player_uuid, row.name])),
  }) };
}

export async function readSponsorOverview(env: Env) {
  const creator = afdianCreator(env) ?? '';
  const db = env.DB;
  // Each amount fits in 14 decimal digits. Sum at most 16,384 row IDs per subtotal so SQLite
  // stays inside int64, then transfer decimal text and combine with BigInt in the catalog.
  const [meta, sponsors, payments, manual, bindings, displayNames] = await db.batch([
    db.prepare('SELECT fetched_at,orders_complete FROM afdian_sync WHERE creator=?').bind(creator),
    db.prepare('SELECT user_id,name FROM afdian_sponsors WHERE creator=?').bind(creator),
    db.prepare(`SELECT user_id AS owner,CAST(sum(amount_minor) AS TEXT) AS amount FROM afdian_orders
      WHERE creator=? GROUP BY user_id,(rowid >> 14)`).bind(creator),
    db.prepare(`SELECT player_uuid AS owner,CAST(sum(amount_minor) AS TEXT) AS amount FROM sponsor_orders
      GROUP BY player_uuid,(rowid >> 14) ORDER BY min(id)`),
    db.prepare('SELECT afdian_id,player_uuid FROM sponsor_accounts'),
    db.prepare('SELECT player_uuid,name FROM sponsor_names'),
  ]);
  const sync = meta.results[0] as unknown as SyncState | undefined;
  const metadata = !creator ? { fetchedAt: 0, ordersComplete: true } :
    hasUsableSnapshot(sync) ? { fetchedAt: sync.fetched_at, ordersComplete: Boolean(sync.orders_complete) } : undefined;
  const overview = catalogOverview(Boolean(metadata?.ordersComplete),
    new Map((displayNames.results as { player_uuid: string; name: string }[]).map(row => [row.player_uuid, row.name])),
    new Map(metadata?.fetchedAt ? (sponsors.results as { user_id: string; name: string }[]).map(row => [row.user_id, row.name]) : []),
    new Map((bindings.results as { afdian_id: string; player_uuid: string }[]).map(row => [row.afdian_id, row.player_uuid])),
    metadata?.fetchedAt ? payments.results as unknown as SponsorSubtotal[] : [], manual.results as unknown as SponsorSubtotal[]);
  return { metadata, overview };
}
