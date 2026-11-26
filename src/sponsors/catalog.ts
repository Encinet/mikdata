import type { AfdianPayload } from './snapshot';
import { formatAmount, type ManualOrder, type Payment, type Sponsor, type SponsorOrder } from './model';

interface CatalogOrder extends Payment {
  id: string;
  source: 'afdian' | 'manual';
}

interface Account {
  afdianUserId: string;
  name?: string;
}

interface Group {
  uuid?: string;
  name?: string;
  customName?: string;
  accounts: Account[];
  orders: CatalogOrder[];
  totalMinor?: bigint;
  manual: boolean;
}

export interface CatalogData {
  names: Map<string, string>;
  mappings: Map<string, string>;
  manualOrders: Map<string, ManualOrder>;
}

function groupAccounts(data: Pick<CatalogData, 'mappings' | 'names'>, names: Map<string, string>,
  payingAccounts: Iterable<string>, complete: boolean) {
  const players = new Map<string, Group>();
  const pending = new Map<string, Group>();
  const accounts = new Map<string, Group>();

  function player(uuid: string): Group {
    const existing = players.get(uuid);
    if (existing) return existing;
    const group = newGroup(uuid, data.names.get(uuid));
    players.set(uuid, group);
    return group;
  }

  const ids = new Set([...data.mappings.keys(), ...names.keys()]);
  for (const id of payingAccounts) ids.add(id);
  for (const afdianUserId of [...ids].sort()) {
    const uuid = data.mappings.get(afdianUserId);
    const name = names.get(afdianUserId);
    const group = uuid ? player(uuid) : newGroup();
    group.name ??= name;
    if (!complete) group.totalMinor = undefined;
    group.accounts.push({ afdianUserId, name });
    accounts.set(afdianUserId, group);
    if (!uuid) pending.set(afdianUserId, group);
  }

  return { players, pending, accounts, player };
}

export function buildCatalog(payload: AfdianPayload | undefined, data: CatalogData) {
  const { players, pending, accounts, player } = groupAccounts(data,
    new Map(payload?.sponsors.map(({ userId, name }) => [userId, name])),
    (payload?.orders ?? []).map(order => order.userId), Boolean(payload?.ordersComplete));
  for (const [orderId, { uuid, amountMinor, at, message }] of data.manualOrders) {
    addOrder(player(uuid), { id: 'mn:' + orderId, source: 'manual', amountMinor, at, message });
  }
  for (const { outTradeNo, userId, amountMinor, at, message } of payload?.orders ?? []) {
    addOrder(accounts.get(userId)!, { id: 'af:' + outTradeNo, source: 'afdian', amountMinor, at, message });
  }
  return { players, pending };
}

function newGroup(uuid?: string, customName?: string): Group {
  return { uuid, name: customName, customName, accounts: [], orders: [], totalMinor: 0n, manual: false };
}

function addOrder(group: Group, order: CatalogOrder): void {
  group.orders.push(order);
  if (order.source === 'manual') group.manual = true;
  if (group.totalMinor !== undefined) group.totalMinor += BigInt(order.amountMinor);
}

function summary(group: Group) {
  return {
    uuid: group.uuid,
    name: group.name ?? group.uuid ?? group.accounts[0].afdianUserId,
    totalAmount: group.totalMinor === undefined ? undefined : formatAmount(group.totalMinor),
  };
}

function sortedOrders(group: Group): CatalogOrder[] {
  return [...group.orders].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

function orderDetails({ amountMinor, at, message }: CatalogOrder) {
  return { amount: formatAmount(amountMinor), at, message };
}

function publicOrder(order: CatalogOrder): SponsorOrder {
  return { ...orderDetails(order), at: new Date(order.at * 1000).toISOString() };
}

export function publicSponsors(groups: Iterable<Group>): Sponsor[] {
  return [...groups]
    .filter((group): group is Group & { uuid: string } => Boolean(group.uuid && group.orders.length))
    .map((group) => ({ group, orders: sortedOrders(group) }))
    .sort((a, b) => b.orders[0].at - a.orders[0].at || a.group.uuid.localeCompare(b.group.uuid))
    .map(({ group, orders }) => ({ ...summary(group), uuid: group.uuid, orders: orders.map(publicOrder) }));
}

function adminSponsorSummary(group: Group) {
  return {
    ...summary(group), accounts: group.accounts,
    manual: group.manual,
  };
}

export function adminSponsorDetail(group: Group) {
  return {
    ...summary(group), accounts: group.accounts, customName: group.customName,
    orders: sortedOrders(group).map((order) => ({ id: order.id, source: order.source, ...orderDetails(order) })),
  };
}

export interface SponsorSubtotal { owner: string; amount: string }

export function catalogOverview(complete: boolean, names: Map<string, string>,
  accounts: Map<string, string>, mappings: Map<string, string>, payments: SponsorSubtotal[], manual: SponsorSubtotal[]) {
  const groups = groupAccounts({ names, mappings }, accounts, payments.map(row => row.owner), complete);
  for (const { owner, amount } of manual) {
    const group = groups.player(owner);
    group.manual = true;
    if (group.totalMinor !== undefined) group.totalMinor += BigInt(amount);
  }
  for (const { owner, amount } of payments) {
    const group = groups.accounts.get(owner)!;
    if (group.totalMinor !== undefined) group.totalMinor += BigInt(amount);
  }
  return {
    players: [...groups.players.values()].map(adminSponsorSummary),
    pending: [...groups.pending.values()].map(adminSponsorSummary),
  };
}
