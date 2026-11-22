const UUID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
export const AFDIAN_ID_RE = /^[a-z0-9_-]{1,128}$/i;
const MAX_ORDER_AT = 253402300799;

export interface Payment {
  amountMinor: number;
  at: number;
}

export interface ManualOrder {
  uuid: string;
  amountMinor: number;
  at?: number;
}

export interface Sponsor {
  uuid: string;
  name: string;
  totalAmount?: string;
}

export function minecraftUuid(value: unknown): string | undefined {
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) return undefined;
  const id = value.trim().toLowerCase().replaceAll('-', '');
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}

export function parseAmount(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function formatAmount(minor: number | bigint): string {
  const cents = BigInt(minor);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function parseManualAmount(value: unknown): number | undefined {
  return typeof value === 'string' ? parseAmount(value) : undefined;
}

function parseOrderTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ORDER_AT
    ? value : undefined;
}

export function parseManualOrder(body: Record<string, unknown>, uuid: string): ManualOrder | undefined {
  const amountMinor = parseManualAmount(body.amount);
  const at = body.at === undefined ? 0 : parseOrderTime(body.at);
  if (amountMinor === undefined || at === undefined) return undefined;
  return at ? { uuid, amountMinor, at } : { uuid, amountMinor };
}

function parseChange(value: unknown, parse: (value: unknown) => number | undefined) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || !('from' in value) || !('to' in value)) return null;
  const from = parse(value.from);
  const to = parse(value.to);
  return from === undefined || to === undefined ? null : { from, to };
}

export function parseManualOrderEdit(body: Record<string, unknown>, owner: string) {
  const uuid = body.uuid === undefined ? owner : minecraftUuid(body.uuid);
  const amount = parseChange(body.amount, parseManualAmount);
  const time = parseChange(body.at, parseOrderTime);
  if (!uuid || amount === null || time === null) return undefined;
  return { uuid, amount, time };
}
