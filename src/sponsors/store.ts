import { asString } from '../auth/request';
import type { Env } from '../env';
import { canonicalContent, contentPrecondition, contentTag } from '../shared/content-precondition';
import { json, readLimitedRequestText, requestMediaType, RequestBodyTooLargeError, serializedJson } from '../shared/http';
import { AFDIAN_FRESH_MS, AfdianCache, type AfdianPayload } from './cache';
import { adminSponsorDetail, adminSponsorSummary, buildCatalog, publicSponsors } from './catalog';
import { AFDIAN_ID_RE, formatAmount, minecraftUuid, parseManualOrder, parseManualOrderEdit, type ManualOrder } from './model';

const MAPPING_PREFIX = 'sponsor-mapping:';
const MANUAL_ORDER_PREFIX = 'manual-order:';
const NAME_PREFIX = 'sponsor-name:';

export class SponsorStore implements DurableObject {
  private readonly records: SyncKvStorage;
  private readonly afdian: AfdianCache;
  private catalog?: { payload?: AfdianPayload; groups: ReturnType<typeof buildCatalog>; publicBody?: string };

  constructor(state: DurableObjectState, env: Env) {
    this.records = state.storage.kv;
    this.afdian = new AfdianCache(env);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const path = pathname.split('/');
    try {
      if (request.method === 'POST' && pathname === '/refresh') {
        return await this.afdian.get() ? new Response(null, { status: 204 }) : unavailable();
      }
      if (request.method === 'GET') return await this.read(path);
      if (request.method === 'DELETE') return await this.remove(path, request.headers.get('If-Match'));
      if (request.method === 'PUT' || request.method === 'PATCH') return await this.write(path, request);
      return json({ error: 'method not allowed' }, 405);
    } catch (error) {
      console.warn('Sponsor data unavailable', error);
      return unavailable();
    }
  }

  private async read(path: string[]): Promise<Response> {
    const [, route, id] = path;
    const payload = await this.afdian.get();
    const status = afdianStatus(payload);
    const catalog = this.readCatalog(payload);
    const { players, pending } = catalog.groups;
    if (route === 'public' && path.length === 2) {
      catalog.publicBody ??= JSON.stringify(publicSponsors(players.values()));
      return serializedJson(catalog.publicBody, 200, {
        'Cache-Control': 'public, no-cache',
        'X-Sponsor-Data': status === 'current' || status === 'disabled' ? 'complete' : status === 'stale' ? 'stale' : 'partial',
        'Access-Control-Expose-Headers': 'X-Sponsor-Data',
      });
    }
    if (route === 'sponsor-catalog' && path.length === 2) {
      return json({
        afdianStatus: status,
        players: [...players.values()].map(adminSponsorSummary),
        pending: [...pending.values()].map(adminSponsorSummary),
      }, 200);
    }
    if (path.length === 3) {
      const uuid = minecraftUuid(id);
      const group = route === 'sponsor-catalog' && uuid ? players.get(uuid)
        : route === 'sponsor-accounts' && AFDIAN_ID_RE.test(id) ? pending.get(id) : undefined;
      if (group) return json(adminSponsorDetail(group), 200);
    }
    return notFound();
  }

  private readCatalog(payload: AfdianPayload | undefined) {
    if (this.catalog && this.catalog.payload === payload) return this.catalog;
    const groups = buildCatalog(payload, {
      manualOrders: this.values<ManualOrder>(MANUAL_ORDER_PREFIX),
      mappings: this.values<string>(MAPPING_PREFIX),
      names: this.values<string>(NAME_PREFIX),
    });
    return this.catalog = { payload, groups };
  }

  private values<T>(prefix: string): Map<string, T> {
    return new Map([...this.records.list<T>({ prefix })].map(([key, value]) => [key.slice(prefix.length), value]));
  }

  private async write(path: string[], request: Request): Promise<Response> {
    const [, route, id, item, orderId] = path;
    const editing = request.method === 'PATCH';
    if (editing && (route !== 'sponsors' || item !== 'orders' || path.length !== 5)) return notFound();
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;

    if (route === 'sponsor-mappings' && path.length === 2) {
      const afdianUserId = asString(body.afdianUserId).trim();
      const uuid = minecraftUuid(body.uuid);
      if (!AFDIAN_ID_RE.test(afdianUserId) || !uuid) return invalid('an Afdian account and Minecraft UUID are required');
      this.records.put(MAPPING_PREFIX + afdianUserId, uuid);
      return this.changed();
    }

    const uuid = minecraftUuid(id);
    if (route !== 'sponsors' || !uuid) return notFound();
    if (path.length === 3) {
      const name = typeof body.name === 'string' ? body.name.trim() : undefined;
      if (name === undefined || name.length > 64) return invalid('name must be at most 64 characters');
      if (name) this.records.put(NAME_PREFIX + uuid, name);
      else this.records.delete(NAME_PREFIX + uuid);
      return this.changed();
    }
    const orderUuid = minecraftUuid(orderId);
    if (path.length !== 5 || item !== 'orders' || !orderUuid) return notFound();

    const key = MANUAL_ORDER_PREFIX + orderUuid;
    if (editing) return this.editManualOrder(key, uuid, body);

    const order = parseManualOrder(body, uuid);
    if (!order || (body.uuid !== undefined && minecraftUuid(body.uuid) !== uuid)) return invalid('invalid manual order');
    const existing = this.records.get<ManualOrder>(key);
    if (existing) return sameOrder(existing, order)
      ? new Response(null, { status: 204 }) : json({ error: 'that order already exists' }, 409);
    this.records.put(key, order);
    return this.changed();
  }

  private editManualOrder(key: string, owner: string, body: Record<string, unknown>): Response {
    const edit = parseManualOrderEdit(body, owner);
    if (!edit) return invalid('invalid manual order edit');
    const existing = this.records.get<ManualOrder>(key);
    if (!existing) return notFound();

    const { uuid, amount, time, message } = edit;
    const order = { ...existing, uuid, amountMinor: amount?.to ?? existing.amountMinor, at: time?.to ?? existing.at };
    if (message) {
      if (message.to) order.message = message.to;
      else delete order.message;
    }
    if (sameOrder(existing, order)) return new Response(null, { status: 204 });
    const currentMessage = existing.message ?? '';
    if (
      existing.uuid !== owner ||
      (amount && existing.amountMinor !== amount.from && existing.amountMinor !== amount.to) ||
      (time && existing.at !== time.from && existing.at !== time.to) ||
      (message && currentMessage !== message.from && currentMessage !== message.to)
    ) return json({ error: 'that order has changed' }, 409);
    this.records.put(key, order);
    return this.changed();
  }

  private async remove(path: string[], ifMatch: string | null): Promise<Response> {
    const [, route, id, item, orderId] = path;
    if (route === 'sponsor-mappings' && path.length === 3 && AFDIAN_ID_RE.test(id)) {
      return this.removeKey(MAPPING_PREFIX + id);
    }
    const uuid = minecraftUuid(id);
    const orderUuid = minecraftUuid(orderId);
    if (route !== 'sponsors' || path.length !== 5 || item !== 'orders' || !uuid || !orderUuid) return notFound();
    const expected = contentPrecondition(ifMatch);
    if ('status' in expected) return json(expected.body, expected.status);
    const key = MANUAL_ORDER_PREFIX + orderUuid;
    const order = this.records.get<ManualOrder>(key);
    if (!order || order.uuid !== uuid) return notFound();
    const content = canonicalContent({
      id: orderUuid, uuid, amount: formatAmount(order.amountMinor), at: order.at, message: order.message ?? '',
    });
    if (expected.tag !== await contentTag(content)) return orderChanged();
    const current = this.records.get<ManualOrder>(key);
    if (!current) return notFound();
    // Keep the comparison and deletion synchronous within the Durable Object.
    if (!sameOrder(current, order)) return orderChanged();
    return this.removeKey(key);
  }

  private removeKey(key: string): Response {
    return this.records.delete(key) ? this.changed() : notFound();
  }

  private changed(): Response {
    this.catalog = undefined;
    return new Response(null, { status: 204 });
  }
}

function sameOrder(a: ManualOrder, b: ManualOrder): boolean {
  return a.uuid === b.uuid && a.amountMinor === b.amountMinor && a.at === b.at && a.message === b.message;
}

function orderChanged(): Response {
  return json({ error: 'that order has changed' }, 412);
}

function afdianStatus(payload: AfdianPayload | undefined) {
  if (!payload) return 'unavailable';
  if (payload.fetchedAt === 0) return 'disabled';
  if (!payload.ordersComplete) return 'partial';
  return Date.now() - payload.fetchedAt < AFDIAN_FRESH_MS ? 'current' : 'stale';
}

function notFound(): Response {
  return json({ error: 'not found' }, 404);
}

function invalid(message: string): Response {
  return json({ error: message }, 400);
}

function unavailable(): Response {
  return json({ error: 'sponsor_data_unavailable' }, 503, { 'Cache-Control': 'no-store' });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (requestMediaType(request) !== 'application/json') {
    return json({ error: 'content-type must be application/json' }, 415);
  }
  try {
    const body: unknown = JSON.parse(await readLimitedRequestText(request, 8 * 1024));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('body must be a JSON object');
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return invalid('invalid JSON body');
  }
}
