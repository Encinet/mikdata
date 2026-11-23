import { afdianSign } from './md5';
import type { Env } from '../env';
import { AFDIAN_ID_RE, parseAmount, parseOrderTime, type Payment } from './model';

const AFDIAN_API_BASE = 'https://afdian.com/api/open';
/** Bound page scans so one bad upstream response cannot stall the sync. */
const MAX_SPONSOR_PAGES = 100;
const MAX_ORDER_PAGES = 50;
/** Afdian order numbers begin with YYYYMMDDHHMMSS in UTC+8. */
const CNA_TZ_OFFSET_SECONDS = 8 * 3600;

export interface AfdianSponsor {
  userId: string;
  name: string;
}

export interface AfdianOrder extends Payment {
  outTradeNo: string;
  userId: string;
}

type AfdianPath = '/query-sponsor' | '/query-order';

async function afdianPage(
  env: Env,
  path: AfdianPath,
  params: Record<string, number>,
  signal: AbortSignal,
): Promise<{ list: unknown[]; totalPages: number }> {
  const userId = env.AFDIAN_USER_ID?.trim();
  const token = env.AFDIAN_API_TOKEN?.trim();
  if (!userId || !token) throw new Error('Afdian credentials are not configured');

  const ts = Math.floor(Date.now() / 1000);
  const paramsJson = JSON.stringify(params);
  const response = await fetch(AFDIAN_API_BASE + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      params: paramsJson,
      ts,
      sign: afdianSign(token, userId, paramsJson, ts),
    }),
    signal,
  });
  if (!response.ok) throw new Error('Afdian ' + path + ' status ' + response.status);

  const envelope = object(await response.json());
  if (envelope?.ec !== 200) throw new Error('Afdian ' + path + ' rejected the request');
  const data = object(envelope.data);
  const list = data?.list;
  const count = data?.total_page;
  const totalPages = typeof count === 'string' && /^\d+$/.test(count) ? Number(count) : count;
  if (!Array.isArray(list) || typeof totalPages !== 'number' || !Number.isSafeInteger(totalPages) || totalPages < 0) {
    throw new Error('Afdian ' + path + ' returned an invalid page');
  }

  return { list, totalPages };
}

export async function fetchAfdianSponsors(
  env: Env,
  signal = AbortSignal.timeout(20_000),
): Promise<AfdianSponsor[]> {
  const sponsors = new Map<string, AfdianSponsor>();
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const data = await afdianPage(env, '/query-sponsor', { page }, signal);
    if (page === 1) {
      if (data.totalPages > MAX_SPONSOR_PAGES) throw new Error('Afdian sponsor page limit exceeded');
      totalPages = data.totalPages;
    }

    for (const entry of data.list) {
      const row = object(entry);
      const user = object(row?.user);
      const userId = string(user?.user_id);
      const name = string(user?.name);
      if (AFDIAN_ID_RE.test(userId) && name && !sponsors.has(userId)) {
        sponsors.set(userId, { userId, name });
      }
    }
  }
  return [...sponsors.values()];
}

export async function fetchAfdianOrders(
  env: Env,
  signal = AbortSignal.timeout(20_000),
): Promise<{ orders: AfdianOrder[]; status: 'complete' | 'incomplete' | 'truncated' }> {
  const orders = new Map<string, AfdianOrder>();
  let totalPages = 1;
  let incomplete = false;
  for (let page = 1; page <= Math.min(totalPages, MAX_ORDER_PAGES); page++) {
    const data = await afdianPage(env, '/query-order', { page }, signal);
    if (page === 1) totalPages = data.totalPages;
    if (data.totalPages !== totalPages) incomplete = true;

    for (const entry of data.list) {
      const row = object(entry);
      if (row?.status !== 2 && row?.status !== '2') {
        if (row?.status === undefined) incomplete = true;
        continue;
      }
      const outTradeNo = string(row?.out_trade_no);
      const userId = string(row?.user_id);
      const amountMinor = parseAmount(row?.total_amount);
      const at = afdianOrderTime(outTradeNo);
      if (!AFDIAN_ID_RE.test(outTradeNo) || !AFDIAN_ID_RE.test(userId) || amountMinor === undefined || at === undefined) {
        incomplete = true;
        continue;
      }
      if (!orders.has(outTradeNo)) {
        const message = string(row.remark) || undefined;
        orders.set(outTradeNo, { outTradeNo, userId, amountMinor, at, message });
      }
    }
  }
  const status = incomplete ? 'incomplete' : totalPages > MAX_ORDER_PAGES ? 'truncated' : 'complete';
  return { orders: [...orders.values()], status };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Second-precision UTC timestamp of the order moment, parsed from the
 * YYYYMMDDHHMMSS head of out_trade_no, interpreted as China wall-clock time
 * (UTC+8).
 */
export function afdianOrderTime(outTradeNo: string): number | undefined {
  if (!/^\d{14}/.test(outTradeNo)) return undefined;
  const year = Number(outTradeNo.slice(0, 4));
  const month = Number(outTradeNo.slice(4, 6));
  const day = Number(outTradeNo.slice(6, 8));
  const hour = Number(outTradeNo.slice(8, 10));
  const minute = Number(outTradeNo.slice(10, 12));
  const second = Number(outTradeNo.slice(12, 14));
  if (
    year < 1970 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  // The wall-clock head is China time: shift 8 hours back to the UTC instant.
  return parseOrderTime(ms / 1000 - CNA_TZ_OFFSET_SECONDS);
}
