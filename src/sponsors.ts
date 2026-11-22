import {
  afdianOrderTime,
  fetchAfdianRemarkOrders,
  fetchAfdianSponsors,
  type AfdianOrder,
  type AfdianSponsor,
} from './afdian';
import type { Env } from './env';
import { json } from './shared/http';
import type { AdminActor } from './auth/access';

export const SPONSOR_MAPPING_PREFIX = 'sponsor-mapping:';
export const SPONSOR_MANUAL_PREFIX = 'sponsor-manual:';
/** Single KV counter bumped by admin writes to invalidate the public catalog. */
export const SPONSOR_REVISION_KEY = 'sponsor-revision';
/** Keep Afdian API traffic bounded; the cron fires every five minutes. */
export const SPONSOR_SYNC_INTERVAL_MS = 15 * 60_000;
/** Dedupe window for the admin catalog view. */
const ADMIN_CATALOG_TTL_MS = 30_000;
const ADMIN_RATE_RETRY_SECONDS = 60;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MANUAL_ORDERS = 200;
const TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;
const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;
const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=900, stale-while-revalidate=3600',
} as const;
const WORKER_CACHE_PREFIX = 'v8:sponsors';

export interface SponsorOrder {
  /** Stable order id: `af:<out_trade_no>` for Afdian orders, `mn:<id>` for manual ones. */
  id: string;
  amount: string;
  remark: string;
  /** Second-precision timestamp of the payment moment; 0 when unparseable. */
  at: number;
}

export interface Sponsor {
  /** The sponsor's Minecraft UUID; the public identifier. Present on every sponsor. */
  uuid: string;
  name: string;
  /** Cumulative sponsored amount; the official Afdian figure when present. */
  totalAmount?: string;
  orders: SponsorOrder[];
}

/** Internal cache payload; the public response is the `sponsors` array. */
export interface SponsorCatalog {
  /** Internal freshness marker driving the fifteen-minute sync gate. */
  publishedAt: number;
  sponsors: Sponsor[];
}

export interface ManualSponsorRecord {
  displayKey: string;
  name: string;
  totalAmount?: string;
  uuid?: string;
  orders: Array<{ id: string; amount: string; remark: string; at: number }>;
}

/** Admin view of one Afdian sponsor; the public list withholds unmapped ones. */
export interface AdminCatalogEntry {
  afdianUserId: string;
  name: string;
  totalAmount?: string;
  /** The mapped Minecraft UUID when a mapping exists. */
  uuid?: string;
}

interface AfdianPayload {
  fetchedAt: number;
  sponsors: AfdianSponsor[];
  orders: AfdianOrder[];
}

interface SponsorsState {
  revision: number;
  publishedAt: number;
  catalog?: SponsorCatalog;
  payload?: AfdianPayload;
  adminCatalog?: { at: number; revision: number; entries: AdminCatalogEntry[] };
  pending?: Promise<SponsorCatalog>;
}

const states = new WeakMap<KVNamespace, SponsorsState>();

// ---------------------------------------------------------------------------
// Public route
// ---------------------------------------------------------------------------

export async function handlePublicSponsorsRoute(
  routePath: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (routePath !== '/sponsors') return null;
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  return serveSponsorCatalog(env, ctx);
}

/**
 * Serve the sponsor list from caches. Admin KV writes bump a revision counter
 * so the next request rebuilds immediately; the Afdian payload only refreshes
 * on its own fifteen-minute gate, so cache misses never pay upstream twice.
 */
export async function serveSponsorCatalog(env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const catalog = await serveCatalog(env, ctx);
    return json(catalog.sponsors, 200, CACHE_HEADERS);
  } catch (error) {
    console.warn('Public sponsor catalog unavailable', error);
    return json({ error: 'sponsor_data_unavailable' }, 503, {
      'Cache-Control': 'no-store',
    });
  }
}

/** Cron entry point: refresh the catalog when its shared caches have gone stale. */
export function refreshSponsorCatalog(env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(
    (async () => {
      try {
        await serveCatalog(env, ctx);
      } catch (error) {
        console.warn('Scheduled sponsor refresh failed', error);
      }
    })(),
  );
}

async function serveCatalog(env: Env, ctx: ExecutionContext): Promise<SponsorCatalog> {
  const state = stateFor(env);
  const kv = env.BUILDINGS_KV;
  const now = Date.now();
  const revision = await readRevision(kv);
  if (state.catalog && state.revision === revision && now - state.publishedAt < SPONSOR_SYNC_INTERVAL_MS)
    return state.catalog;
  const cached = await readWorkerCatalog(revision);
  if (cached && now - cached.publishedAt < SPONSOR_SYNC_INTERVAL_MS) {
    state.catalog = cached;
    state.revision = revision;
    state.publishedAt = cached.publishedAt;
    return cached;
  }
  const catalog = await rebuildCatalog(env, state, revision, now);
  ctx.waitUntil(
    writeCatalogCaches(catalog, state, revision).catch((error) =>
      console.warn('Sponsor catalog cache write failed', error),
    ),
  );
  return catalog;
}

async function rebuildCatalog(
  env: Env,
  state: SponsorsState,
  revision: number,
  now: number,
): Promise<SponsorCatalog> {
  if (state.pending) return state.pending;
  state.pending = (async () => {
    const payload = await freshAfdianPayload(env, state, now);
    const kv = env.BUILDINGS_KV;
    const [mappings, manual] = await Promise.all([loadMappings(kv), listManual(kv)]);

    const ordersByUser = new Map<string, AfdianOrder[]>();
    for (const order of payload.orders) {
      const existing = ordersByUser.get(order.userId);
      if (existing) existing.push(order);
      else ordersByUser.set(order.userId, [order]);
    }

    const sponsors: Sponsor[] = [];
    for (const sponsor of payload.sponsors) {
      // Unmapped Afdian sponsors are withheld from the public list.
      const mapping = mappings.get(sponsor.userId);
      if (!mapping) continue;
      const orders = (ordersByUser.get(sponsor.userId) ?? []).map((order) => ({
        id: `af:${order.outTradeNo}`,
        amount: order.amount,
        remark: order.remark,
        at: afdianOrderTime(order.outTradeNo),
      }));
      orders.sort((a, b) => b.at - a.at);
      sponsors.push({
        uuid: mapping,
        name: sponsor.name,
        totalAmount: sponsor.totalAmount,
        orders,
      });
    }
    for (const record of manual) {
      if (!record.uuid) continue;
      sponsors.push({
        uuid: record.uuid,
        name: record.name,
        totalAmount: record.totalAmount,
        orders: record.orders.map((order) => ({
          id: `mn:${order.id}`,
          amount: order.amount,
          remark: order.remark,
          at: order.at,
        })),
      });
    }
    sponsors.sort((a, b) =>
      (b.totalAmount ?? '').localeCompare(a.totalAmount ?? '', undefined, { numeric: true }),
    );

    const catalog: SponsorCatalog = { publishedAt: Date.now(), sponsors };
    state.catalog = catalog;
    state.revision = revision;
    state.publishedAt = catalog.publishedAt;
    return catalog;
  })();
  try {
    return await state.pending;
  } finally {
    state.pending = undefined;
  }
}

async function freshAfdianPayload(
  env: Env,
  state: SponsorsState,
  now: number,
): Promise<AfdianPayload> {
  if (state.payload && now - state.payload.fetchedAt < SPONSOR_SYNC_INTERVAL_MS)
    return state.payload;
  const cached = await readWorkerPayload();
  if (cached && now - cached.fetchedAt < SPONSOR_SYNC_INTERVAL_MS) {
    state.payload = cached;
    return cached;
  }
  const afdianConfigured = Boolean(env.AFDIAN_USER_ID?.trim() && env.AFDIAN_API_TOKEN?.trim());
  let payload: AfdianPayload;
  if (afdianConfigured) {
    const [sponsors, orders] = await Promise.all([
      fetchAfdianSponsors(env),
      fetchAfdianRemarkOrders(env),
    ]);
    payload = { fetchedAt: Date.now(), sponsors, orders };
  } else {
    payload = { fetchedAt: Date.now(), sponsors: [], orders: [] };
  }
  state.payload = payload;
  return payload;
}

// ---------------------------------------------------------------------------
// Admin routes: sponsor-catalog, sponsor-mappings, manual sponsors
// ---------------------------------------------------------------------------

export async function handleAdminSponsorsRoute(
  routePath: string,
  request: Request,
  env: Env,
  actor: AdminActor,
): Promise<Response | null> {
  if (!isSponsorAdminRoute(routePath)) return null;
  const limited = await enforceAdminRateLimit(env, actor);
  if (limited) return limited;

  if (routePath === '/sponsor-catalog') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    try {
      return json(await adminCatalogView(env), 200);
    } catch (error) {
      console.warn('Admin sponsor catalog view unavailable', error);
      return json({ error: 'sponsor_data_unavailable' }, 503, { 'Cache-Control': 'no-store' });
    }
  }

  if (routePath === '/sponsor-mappings') {
    if (request.method === 'GET') return json(await listMappings(env.BUILDINGS_KV), 200);
    if (request.method === 'PUT') {
      if (!isSameOriginBrowserRequest(request)) return json({ error: 'forbidden' }, 403);
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const afdianUserId =
        typeof body.value.afdianUserId === 'string' ? body.value.afdianUserId.trim() : '';
      const uuid = typeof body.value.uuid === 'string' ? body.value.uuid.trim().toLowerCase() : '';
      if (!TOKEN_RE.test(afdianUserId)) return json({ error: 'afdianUserId is required' }, 400);
      if (!UUID_RE.test(uuid)) return json({ error: 'uuid must be a Minecraft UUID' }, 400);
      const kv = env.BUILDINGS_KV;
      await kv.put(`${SPONSOR_MAPPING_PREFIX}${afdianUserId}`, uuid);
      await bumpRevision(kv);
      return json({ afdianUserId, uuid }, 200);
    }
    return json({ error: 'method not allowed' }, 405);
  }

  const mappingTarget = routePath.match(/^\/sponsor-mappings\/([^/]+)$/);
  if (mappingTarget) {
    if (request.method !== 'DELETE') return json({ error: 'method not allowed' }, 405);
    if (!isSameOriginBrowserRequest(request)) return json({ error: 'forbidden' }, 403);
    const afdianUserId = mappingTarget[1];
    if (!TOKEN_RE.test(afdianUserId)) return json({ error: 'not found' }, 404);
    const key = `${SPONSOR_MAPPING_PREFIX}${afdianUserId}`;
    if ((await env.BUILDINGS_KV.get(key)) === null) return json({ error: 'not found' }, 404);
    await env.BUILDINGS_KV.delete(key);
    await bumpRevision(env.BUILDINGS_KV);
    return new Response(null, { status: 204 });
  }

  if (routePath === '/sponsors') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return json(await listManual(env.BUILDINGS_KV), 200);
  }

  const manualTarget = routePath.match(/^\/sponsors\/([^/]+)$/);
  if (manualTarget) {
    const displayKey = manualTarget[1];
    if (!TOKEN_RE.test(displayKey)) return json({ error: 'not found' }, 404);
    const key = `${SPONSOR_MANUAL_PREFIX}${displayKey}`;
    if (request.method === 'PUT') {
      if (!isSameOriginBrowserRequest(request)) return json({ error: 'forbidden' }, 403);
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = parseManualBody(body.value, displayKey);
      if (parsed.error || !parsed.record) return json({ error: parsed.error ?? 'invalid body' }, 400);
      await env.BUILDINGS_KV.put(key, JSON.stringify(parsed.record));
      await bumpRevision(env.BUILDINGS_KV);
      return json(parsed.record, 200);
    }
    if (request.method === 'DELETE') {
      if (!isSameOriginBrowserRequest(request)) return json({ error: 'forbidden' }, 403);
      if ((await env.BUILDINGS_KV.get(key)) === null) return json({ error: 'not found' }, 404);
      await env.BUILDINGS_KV.delete(key);
      await bumpRevision(env.BUILDINGS_KV);
      return new Response(null, { status: 204 });
    }
    return json({ error: 'method not allowed' }, 405);
  }

  return null;
}

/** Internal view for administrators: every Afdian sponsor with its mapping state. */
async function adminCatalogView(env: Env): Promise<AdminCatalogEntry[]> {
  const state = stateFor(env);
  const kv = env.BUILDINGS_KV;
  const revision = await readRevision(kv);
  const cached = state.adminCatalog;
  if (cached && cached.revision === revision && Date.now() - cached.at < ADMIN_CATALOG_TTL_MS)
    return cached.entries;
  const payload = await freshAfdianPayload(env, state, Date.now());
  const mappings = await loadMappings(kv);
  const entries: AdminCatalogEntry[] = payload.sponsors.map((sponsor) => ({
    afdianUserId: sponsor.userId,
    name: sponsor.name,
    totalAmount: sponsor.totalAmount,
    uuid: mappings.get(sponsor.userId),
  }));
  state.adminCatalog = { at: Date.now(), revision, entries };
  return entries;
}

// ---------------------------------------------------------------------------
// Rate limit (reuses the deployed sensitive-operation namespace; fail-open on
// limiter error since Cloudflare Access remains the primary gate)
// ---------------------------------------------------------------------------

async function enforceAdminRateLimit(env: Env, actor: AdminActor): Promise<Response | null> {
  try {
    const key = `sponsor-admin:${actor.email?.trim().toLowerCase() ?? actor.subject?.trim() ?? 'unknown'}`.slice(
      0,
      64,
    );
    const { success } = await env.AUTH_SENSITIVE_RATE_LIMITER.limit({ key });
    if (success) return null;
    return json(
      { error: 'rate_limited', retryAfterSeconds: ADMIN_RATE_RETRY_SECONDS },
      429,
      {
        'Cache-Control': 'no-store',
        'Retry-After': String(ADMIN_RATE_RETRY_SECONDS),
      },
    );
  } catch (error) {
    console.warn('Admin sponsor rate limit check failed', error);
    return null; // Fail open: Access already authenticated this request.
  }
}

// ---------------------------------------------------------------------------
// Revision counter (instant invalidation for admin writes)
// ---------------------------------------------------------------------------

async function readRevision(kv: KVNamespace): Promise<number> {
  // The worker-cache marker makes a fresh admin bump visible across isolates
  // immediately; KV reads lag by up to sixty seconds, so prefer the marker.
  try {
    const marker = await workerCache()?.match(cacheRequest(`${WORKER_CACHE_PREFIX}-revision`));
    if (marker) {
      const value = Number.parseInt(await marker.text(), 10);
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
  } catch (error) {
    console.warn('Sponsor revision marker read failed', error);
  }
  const raw = await kv.get(SPONSOR_REVISION_KEY);
  const value = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function bumpRevision(kv: KVNamespace): Promise<void> {
  const raw = await kv.get(SPONSOR_REVISION_KEY);
  const current = raw === null ? 0 : Number.parseInt(raw, 10);
  const next = (Number.isSafeInteger(current) && current >= 0 ? current : 0) + 1;
  try {
    await kv.put(SPONSOR_REVISION_KEY, String(next));
    await workerCache()?.put(
      cacheRequest(`${WORKER_CACHE_PREFIX}-revision`),
      new Response(String(next), { headers: { 'Cache-Control': 'public, max-age=60' } }),
    );
  } catch (error) {
    // The data write already succeeded; the revision is only an invalidation
    // hint, so at worst the public list lags one sync cycle.
    console.warn('Sponsor revision bump failed', error);
  }
}

// ---------------------------------------------------------------------------
// KV readers
// ---------------------------------------------------------------------------

async function listMappings(
  kv: KVNamespace,
): Promise<Array<{ afdianUserId: string; uuid: string }>> {
  const result: Array<{ afdianUserId: string; uuid: string }> = [];
  for (const key of await listKv(kv, SPONSOR_MAPPING_PREFIX)) {
    const raw = await kv.get(key);
    const uuid = raw?.trim();
    if (uuid) result.push({ afdianUserId: key.slice(SPONSOR_MAPPING_PREFIX.length), uuid });
  }
  result.sort((a, b) => a.afdianUserId.localeCompare(b.afdianUserId));
  return result;
}

async function loadMappings(kv: KVNamespace): Promise<Map<string, string>> {
  return new Map((await listMappings(kv)).map((entry) => [entry.afdianUserId, entry.uuid]));
}

async function listManual(kv: KVNamespace): Promise<ManualSponsorRecord[]> {
  const result: ManualSponsorRecord[] = [];
  for (const key of await listKv(kv, SPONSOR_MANUAL_PREFIX)) {
    const raw = await kv.get(key);
    const value = raw === null ? null : safeParse(raw);
    if (isManualRecord(value)) result.push(value);
  }
  result.sort((a, b) => a.displayKey.localeCompare(b.displayKey));
  return result;
}

async function listKv(kv: KVNamespace, prefix: string): Promise<string[]> {
  try {
    return (await kv.list({ prefix })).keys.map((entry) => entry.name);
  } catch (error) {
    console.warn('Sponsor KV listing failed', prefix, error);
    return [];
  }
}

function isManualRecord(value: unknown): value is ManualSponsorRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as ManualSponsorRecord;
  if (
    typeof record.displayKey !== 'string' ||
    record.displayKey.length === 0 ||
    typeof record.name !== 'string' ||
    record.name.length === 0 ||
    !Array.isArray(record.orders) ||
    (record.uuid !== undefined && typeof record.uuid !== 'string')
  )
    return false;
  return record.orders.every((order) => {
    if (!order || typeof order !== 'object') return false;
    return (
      typeof order.id === 'string' &&
      order.id.length > 0 &&
      typeof order.amount === 'string' &&
      typeof order.remark === 'string' &&
      Number.isSafeInteger(order.at)
    );
  });
}

// ---------------------------------------------------------------------------
// Request body + boundary helpers
// ---------------------------------------------------------------------------

function isSponsorAdminRoute(routePath: string): boolean {
  return (
    routePath === '/sponsor-catalog' ||
    routePath === '/sponsor-mappings' ||
    /^\/sponsor-mappings\/[^/]+$/.test(routePath) ||
    routePath === '/sponsors' ||
    /^\/sponsors\/[^/]+$/.test(routePath)
  );
}

function parseManualBody(
  value: Record<string, unknown>,
  displayKey: string,
): { record?: ManualSponsorRecord; error?: string } {
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 64) return { error: 'name must be 1-64 characters' };
  const record: ManualSponsorRecord = { displayKey, name, orders: [] };
  if (value.totalAmount !== undefined) {
    const totalAmount = typeof value.totalAmount === 'string' ? value.totalAmount.trim() : '';
    if (!AMOUNT_RE.test(totalAmount)) return { error: 'totalAmount must be a plain decimal amount' };
    record.totalAmount = totalAmount;
  }
  if (value.uuid !== undefined) {
    const uuid = typeof value.uuid === 'string' ? value.uuid.trim().toLowerCase() : '';
    if (!UUID_RE.test(uuid)) return { error: 'uuid must be a Minecraft UUID' };
    record.uuid = uuid;
  }
  if (value.orders !== undefined) {
    if (!Array.isArray(value.orders)) return { error: 'orders must be an array' };
    if (value.orders.length > MAX_MANUAL_ORDERS)
      return { error: `at most ${MAX_MANUAL_ORDERS} orders are allowed` };
    const seen = new Set<string>();
    const orders: ManualSponsorRecord['orders'] = [];
    for (const entry of value.orders) {
      if (!entry || typeof entry !== 'object') return { error: 'each order must be an object' };
      const order = entry as Record<string, unknown>;
      const id = typeof order.id === 'string' ? order.id.trim() : '';
      const amount = typeof order.amount === 'string' ? order.amount.trim() : '';
      const remark = typeof order.remark === 'string' ? order.remark.trim() : '';
      if (!id || id.length > 64)
        return { error: 'each order needs an id of at most 64 characters' };
      if (seen.has(id)) return { error: `duplicate order id ${id}` };
      if (!AMOUNT_RE.test(amount))
        return { error: `order ${id}: amount must be a plain decimal amount` };
      if (!remark) return { error: `order ${id}: remark is required` };
      if (remark.length > 500) return { error: `order ${id}: remark is too long` };
      let at = 0;
      if (order.at !== undefined) {
        if (typeof order.at !== 'number' || !Number.isSafeInteger(order.at) || order.at < 0)
          return { error: `order ${id}: at must be a non-negative integer` };
        at = order.at;
      }
      seen.add(id);
      orders.push({ id, amount, remark, at });
    }
    record.orders = orders;
  }
  return { record };
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  let text = '';
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: json({ error: 'request body too large' }, 413) };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  if (!text.trim()) return { ok: true, value: {} };
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().includes('application/json'))
    return { ok: false, response: json({ error: 'content-type must be application/json' }, 415) };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, response: json({ error: 'invalid JSON body' }, 400) };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, response: json({ error: 'body must be a JSON object' }, 400) };
  return { ok: true, value: body as Record<string, unknown> };
}

function isSameOriginBrowserRequest(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get('Origin');
  if (origin && origin !== requestOrigin) return false;
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

function stateFor(env: Env): SponsorsState {
  let state = states.get(env.BUILDINGS_KV);
  if (!state) {
    state = { revision: -1, publishedAt: 0 };
    states.set(env.BUILDINGS_KV, state);
  }
  return state;
}

function workerCache(): Cache | null {
  return typeof caches === 'undefined' ? null : caches.default;
}

function cacheRequest(key: string): Request {
  return new Request(`https://mikdata-sponsors-cache.local/${key}`);
}

async function readWorkerCatalog(revision: number): Promise<SponsorCatalog | null> {
  try {
    const response = await workerCache()?.match(
      cacheRequest(`${WORKER_CACHE_PREFIX}@${revision}`),
    );
    if (!response) return null;
    const value = safeParse(await response.text());
    return isSponsorCatalog(value) ? value : null;
  } catch (error) {
    console.warn('Sponsor catalog cache read failed', error);
    return null;
  }
}

async function readWorkerPayload(): Promise<AfdianPayload | null> {
  try {
    const response = await workerCache()?.match(cacheRequest(`${WORKER_CACHE_PREFIX}-afdian`));
    if (!response) return null;
    const value = safeParse(await response.text());
    return isAfdianPayload(value) ? value : null;
  } catch (error) {
    console.warn('Sponsor payload cache read failed', error);
    return null;
  }
}

async function writeCatalogCaches(
  catalog: SponsorCatalog,
  state: SponsorsState,
  revision: number,
): Promise<void> {
  await workerCache()?.put(
    cacheRequest(`${WORKER_CACHE_PREFIX}@${revision}`),
    new Response(JSON.stringify(catalog), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=604800',
      },
    }),
  );
  if (state.payload) {
    await workerCache()?.put(
      cacheRequest(`${WORKER_CACHE_PREFIX}-afdian`),
      new Response(JSON.stringify(state.payload), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=604800',
        },
      }),
    );
  }
}

function isSponsorCatalog(value: unknown): value is SponsorCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const catalog = value as SponsorCatalog;
  return (
    Number.isSafeInteger(catalog.publishedAt) &&
    catalog.publishedAt > 0 &&
    Array.isArray(catalog.sponsors) &&
    catalog.sponsors.every(
      (sponsor) =>
        sponsor &&
        typeof sponsor.uuid === 'string' &&
        sponsor.uuid.length > 0 &&
        typeof sponsor.name === 'string' &&
        Array.isArray(sponsor.orders),
    )
  );
}

function isAfdianPayload(value: unknown): value is AfdianPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as AfdianPayload;
  return (
    Number.isSafeInteger(payload.fetchedAt) &&
    payload.fetchedAt > 0 &&
    Array.isArray(payload.sponsors) &&
    Array.isArray(payload.orders)
  );
}
