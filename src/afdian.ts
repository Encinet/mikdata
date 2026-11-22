import { afdianSign } from './md5';
import type { Env } from './env';

const AFDIAN_API_BASE = 'https://afdian.com/api/open';
/** Bound page scans so one bad upstream response cannot stall the sync. */
const MAX_SPONSOR_PAGES = 100;
const MAX_ORDER_PAGES = 50;
const ORDER_PAGE_SIZE = 50;
/** The first 14 characters of an out_trade_no are YYMMDDHHMMSS in China time. */
const CNA_TZ_OFFSET_SECONDS = 8 * 3600;

export interface AfdianSponsor {
  userId: string;
  name: string;
  totalAmount?: string;
}

export interface AfdianOrder {
  outTradeNo: string;
  userId: string;
  amount: string;
  remark: string;
}

interface AfdianEnvelope {
  ec: number;
  em?: string;
  data?: unknown;
}

interface SponsorPageData {
  total_page?: number;
  list?: Array<{
    user?: { user_id?: string; name?: string };
    all_sum_amount?: string;
  }>;
}

interface OrderPageData {
  total_page?: number;
  list?: Array<{
    out_trade_no?: string;
    user_id?: string;
    total_amount?: string;
    remark?: string;
  }>;
}

async function afdianRequest(env: Env, path: string, paramsJson: string): Promise<unknown> {
  const userId = env.AFDIAN_USER_ID?.trim();
  const token = env.AFDIAN_API_TOKEN?.trim();
  if (!userId || !token) throw new Error('Afdian credentials are not configured');

  const ts = Math.floor(Date.now() / 1000);
  const response = await fetch(`${AFDIAN_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      params: paramsJson,
      ts,
      sign: afdianSign(token, userId, paramsJson, ts),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Afdian ${path} status ${response.status}`);

  const envelope = (await response.json()) as AfdianEnvelope;
  if (envelope.ec !== 200) {
    throw new Error(
      `Afdian ${path} error ${envelope.ec}: ${envelope.em ?? 'unknown'}`,
    );
  }
  return envelope.data;
}

/** Full sponsor roster. Each sponsor appears once, with the official cumulative total. */
export async function fetchAfdianSponsors(env: Env): Promise<AfdianSponsor[]> {
  const sponsors: AfdianSponsor[] = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const data = (await afdianRequest(env, '/query-sponsor', JSON.stringify({ page }))) as
      | SponsorPageData
      | undefined;
    totalPages = Math.min(data?.total_page ?? 1, MAX_SPONSOR_PAGES);
    for (const entry of data?.list ?? []) {
      const userId = entry.user?.user_id?.trim();
      const name = entry.user?.name?.trim();
      if (!userId || !name) continue;
      sponsors.push({
        userId,
        name,
        totalAmount: entry.all_sum_amount ?? undefined,
      });
    }
  }
  return sponsors;
}

/**
 * Orders whose remark is non-empty, newest first. Pages are read up to the
 * platform total (bounded by MAX_ORDER_PAGES) so a large backlog cannot stall
 * the sync.
 */
export async function fetchAfdianRemarkOrders(env: Env): Promise<AfdianOrder[]> {
  const orders: AfdianOrder[] = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const data = (await afdianRequest(
      env,
      '/query-order',
      JSON.stringify({ page, per_page: ORDER_PAGE_SIZE }),
    )) as OrderPageData | undefined;
    totalPages = Math.min(data?.total_page ?? 1, MAX_ORDER_PAGES);
    for (const entry of data?.list ?? []) {
      const outTradeNo = entry.out_trade_no?.trim();
      const userId = entry.user_id?.trim();
      const remark = (entry.remark ?? '').trim();
      if (!outTradeNo || !userId || !remark) continue;
      orders.push({
        outTradeNo,
        userId,
        amount: entry.total_amount ?? '',
        remark,
      });
    }
  }
  return orders;
}

/**
 * Second-precision UTC timestamp of the order moment, parsed from the
 * YYYYMMDDHHMMSS head of out_trade_no, interpreted as China wall-clock time
 * (UTC+8). Returns 0 when the head is not a plausible date.
 */
export function afdianOrderTime(outTradeNo: string): number {
  if (!/^\d{14}/.test(outTradeNo)) return 0;
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
    return 0;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(ms)) return 0;
  // The wall-clock head is China time: shift 8 hours back to the UTC instant.
  return Math.floor((ms - CNA_TZ_OFFSET_SECONDS * 1000) / 1000);
}
