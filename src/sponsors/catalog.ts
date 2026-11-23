import type { AfdianPayload } from './cache';
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
}

export interface CatalogData {
  names: Map<string, string>;
  mappings: Map<string, string>;
  manualOrders: Map<string, ManualOrder>;
}

export function buildCatalog(payload: AfdianPayload | undefined, data: CatalogData) {
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

  const names = new Map(payload?.sponsors.map(({ userId, name }) => [userId, name]));
  const ids = new Set([...data.mappings.keys(), ...names.keys()]);
  for (const order of payload?.orders ?? []) ids.add(order.userId);
  for (const afdianUserId of [...ids].sort()) {
    const uuid = data.mappings.get(afdianUserId);
    const name = names.get(afdianUserId);
    const group = uuid ? player(uuid) : newGroup();
    group.name ??= name;
    if (!payload?.ordersComplete) group.totalMinor = undefined;
    group.accounts.push({ afdianUserId, name });
    accounts.set(afdianUserId, group);
    if (!uuid) pending.set(afdianUserId, group);
  }

  for (const [orderId, { uuid, amountMinor, at, message }] of data.manualOrders) {
    addOrder(player(uuid), { id: 'mn:' + orderId, source: 'manual', amountMinor, at, message });
  }
  for (const { outTradeNo, userId, amountMinor, at, message } of payload?.orders ?? []) {
    addOrder(accounts.get(userId)!, { id: 'af:' + outTradeNo, source: 'afdian', amountMinor, at, message });
  }
  return { players, pending };
}

function newGroup(uuid?: string, customName?: string): Group {
  return { uuid, name: customName, customName, accounts: [], orders: [], totalMinor: 0n };
}

function addOrder(group: Group, order: CatalogOrder): void {
  group.orders.push(order);
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
    .filter((group): group is Group & { uuid: string } =>
      Boolean(group.uuid && (group.orders.length || (group.totalMinor === undefined && group.accounts.some(({ name }) => name)))))
    .sort((a, b) => {
      if (a.totalMinor === b.totalMinor) return a.uuid.localeCompare(b.uuid);
      if (a.totalMinor === undefined) return 1;
      if (b.totalMinor === undefined) return -1;
      return a.totalMinor > b.totalMinor ? -1 : 1;
    })
    .map((group) => ({ ...summary(group), uuid: group.uuid, orders: sortedOrders(group).map(publicOrder) }));
}

export function adminSponsorSummary(group: Group) {
  return {
    ...summary(group), accounts: group.accounts,
    manual: group.orders.some(({ source }) => source === 'manual'),
  };
}

export function adminSponsorDetail(group: Group) {
  return {
    ...summary(group), accounts: group.accounts, customName: group.customName,
    orders: sortedOrders(group).map((order) => ({ id: order.id, source: order.source, ...orderDetails(order) })),
  };
}
