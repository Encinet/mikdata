const UUID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
export const AFDIAN_ID_RE = /^[a-z0-9_-]{1,128}$/i;
// An edit sends two messages that must fit together in the 8 KiB request body.
export const MAX_MANUAL_MESSAGE_LENGTH = 500;
export const MAX_ORDER_AT = 253402300799;

export interface Payment {
  amountMinor: number;
  at: number;
  message?: string;
}

export interface ManualOrder extends Payment {
  uuid: string;
}

export interface Sponsor {
  uuid: string;
  name: string;
  totalAmount?: string;
  orders: SponsorOrder[];
}

export interface SponsorOrder {
  amount: string;
  at: string;
  message?: string;
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

export function parseOrderTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_ORDER_AT
    ? value : undefined;
}

function parseManualMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const message = value.replace(/\r\n?/g, '\n').trim();
  return message.length <= MAX_MANUAL_MESSAGE_LENGTH ? message : undefined;
}

export function parseManualOrder(body: Record<string, unknown>, uuid: string): ManualOrder | undefined {
  const amountMinor = parseManualAmount(body.amount);
  const at = parseOrderTime(body.at);
  const message = body.message === undefined ? '' : parseManualMessage(body.message);
  if (amountMinor === undefined || at === undefined || message === undefined) return undefined;
  const order: ManualOrder = { uuid, amountMinor, at };
  if (message) order.message = message;
  return order;
}

function parseChange<T>(value: unknown, parse: (value: unknown) => T | undefined) {
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
  const message = parseChange(body.message, parseManualMessage);
  if (!uuid || amount === null || time === null || message === null) return undefined;
  return { uuid, amount, time, message };
}

export type OrderRow = { id: string; player_uuid: string; amount_minor: number; paid_at: number; message: string | null };

export function manualOrder(row: OrderRow): ManualOrder {
  return { uuid: row.player_uuid, amountMinor: row.amount_minor, at: row.paid_at, ...(row.message ? { message: row.message } : {}) };
}
