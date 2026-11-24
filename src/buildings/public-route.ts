import { imagePublicBaseUrl } from './images/storage';
import type { Env } from '../env';
import { authStore } from '../auth/binding';
import { BUILDING_ID_PATTERN } from './id';
import { PUBLIC_BUILDINGS_KEY } from './store';
import { parseStoredBuilding } from './validation';
import { json, serializedJson } from '../shared/http';
import { TtlMemoryCache } from '../shared/memory-cache';
import type { Building, Source } from './types';

const SNAPSHOT_TTL_MS = 60_000;
const RESPONSE_TTL_MS = 300_000;
const MAX_LIST_LIMIT = 100;
const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' };
const BUILDING_ROUTE_RE = new RegExp(`^/buildings/(${BUILDING_ID_PATTERN})$`);
interface PublicBuildingsSnapshot { version: number; buildings: Building[] }
interface Catalog {
  raw: string;
  snapshot: PublicBuildingsSnapshot;
  imageBaseUrl: string | null;
  byId: Map<string, Building>;
  sorted: Building[];
  expiresAt: number;
}
interface CatalogState {
  publicBaseUrl?: string;
  scope: string;
  catalog?: Catalog;
  pending?: Promise<Catalog>;
}
interface Query {
  builder: string;
  limit: number | null;
  locale: '' | 'zh-CN' | 'en';
  tag: string;
  type: string;
}
const catalogs = new WeakMap<KVNamespace, CatalogState>();
const listReads = new Map<string, Promise<string>>();
const responses = new TtlMemoryCache<string>({
  defaultTtlMs: RESPONSE_TTL_MS,
  maxEntries: 64,
  maxWeight: 8 * 1024 * 1024,
  // A conservative UTF-16 budget also bounds keys without encoding temporary byte arrays.
  weightOf: (body, key) => (body.length + key.length) * 2,
});
let nextScope = 0;

export async function handlePublicBuildingsRoute(
  routePath: string,
  request: Request,
  env: Env,
): Promise<Response | null> {
  const detail = routePath.match(BUILDING_ROUTE_RE);
  if (routePath !== '/buildings' && !detail) return null;
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  try {
    const state = catalogState(env);
    if (detail) {
      const catalog = await readCatalog(env, state);
      const building = catalog.byId.get(detail[1]);
      return building
        ? json({ imageBaseUrl: catalog.imageBaseUrl, building }, 200, CACHE_HEADERS)
        : json({ error: 'building not found' }, 404);
    }
    const query = parseQuery(new URL(request.url).searchParams);
    if (query === null) {
      return json({ error: 'invalid_limit' }, 400, { 'Cache-Control': 'no-store' });
    }
    const catalog = await readCatalog(env, state);
    const params = new URLSearchParams({
      ...query,
      limit: query.limit === null ? '' : String(query.limit),
    });
    const cacheVersion = query.limit === null ? 'v12' : 'v13';
    const key = `${cacheVersion}:${encodeURIComponent(state.publicBaseUrl ?? '')}:building-list:${catalog.snapshot.version}:${params}`;
    const memoryKey = `${state.scope}:${key}`;
    let body = responses.get(memoryKey);
    if (body === null) {
      let pending = listReads.get(memoryKey);
      if (!pending) {
        pending = loadList(catalog, query, key, memoryKey).finally(() =>
          listReads.delete(memoryKey),
        );
        listReads.set(memoryKey, pending);
      }
      body = await pending;
    }
    return serializedJson(body, 200, CACHE_HEADERS);
  } catch (error) {
    console.warn('Public buildings snapshot unavailable', error);
    return json({ error: 'building_data_unavailable' }, 503, {
      'Cache-Control': 'no-store',
    });
  }
}

async function loadList(
  catalog: Catalog,
  query: Query,
  key: string,
  memoryKey: string,
): Promise<string> {
  let body = await readResponseCache(key);
  if (body === null) {
    const matching = query.type || query.tag || query.builder
      ? catalog.sorted.filter((building) => {
        if (query.type && building.buildType !== query.type) return false;
        if (
          query.tag &&
          !building.tags?.some((tag) => tag['zh-CN'] === query.tag || tag.en === query.tag)
        ) return false;
        return !query.builder || building.builders.some(
          (builder) => builder.name === query.builder || builder.uuid === query.builder,
        );
      })
      : catalog.sorted;
    const selected = query.limit === null ? matching : matching.slice(0, query.limit);
    const locale = query.locale;
    const buildings = locale ? selected.map((building) => localizeBuilding(building, locale)) : selected;
    body = JSON.stringify({
      imageBaseUrl: catalog.imageBaseUrl,
      buildings,
      ...(query.limit === null ? {} : { total: matching.length }),
    });
    await writeResponseCache(key, body);
  }
  responses.set(memoryKey, body);
  return body;
}

function parseQuery(params: URLSearchParams): Query | null {
  const limits = params.getAll('limit');
  let limit: number | null = null;
  if (limits.length > 0) {
    const value = limits[0].trim();
    if (limits.length !== 1 || !/^\d+$/.test(value)) return null;
    limit = Number(value);
    if (limit < 1 || limit > MAX_LIST_LIMIT) return null;
  }
  const locale = params.get('locale')?.trim() ?? '';
  return {
    builder: params.get('builder')?.trim() ?? '',
    limit,
    tag: params.get('tag')?.trim() ?? '',
    type: params.get('type')?.trim() ?? '',
    locale: locale ? (locale === 'zh-CN' ? 'zh-CN' : 'en') : '',
  };
}
function catalogState(env: Env): CatalogState {
  const publicBaseUrl = imagePublicBaseUrl(env);
  let state = catalogs.get(env.BUILDINGS_KV);
  if (!state || state.publicBaseUrl !== publicBaseUrl) {
    state = { scope: `kv${nextScope++}`, publicBaseUrl };
    catalogs.set(env.BUILDINGS_KV, state);
  }
  return state;
}
async function readCatalog(env: Env, state: CatalogState): Promise<Catalog> {
  if (state.catalog && state.catalog.expiresAt > Date.now()) return state.catalog;
  if (state.pending) return state.pending;
  state.pending = loadCatalog(env, state);
  try {
    return await state.pending;
  } finally {
    state.pending = undefined;
  }
}
async function loadCatalog(env: Env, state: CatalogState): Promise<Catalog> {
  let raw = await env.BUILDINGS_KV.get(PUBLIC_BUILDINGS_KEY, { cacheTtl: 60 });
  const previous = state.catalog;
  if (raw !== null && previous?.raw === raw) {
    previous.expiresAt = Date.now() + SNAPSHOT_TTL_MS;
    return previous;
  }
  let value: unknown;
  try {
    value = raw === null ? null : JSON.parse(raw);
  } catch {
    value = null;
  }
  const origin = state.publicBaseUrl;
  let snapshot = publicSnapshot(value, origin);
  if (!snapshot) {
    const stub = authStore(env);
    const response = await stub.fetch(
      new Request('https://auth-store.local/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'publicBuildingSnapshot' }),
      }),
    );
    const recovered = (await response.json()) as { status: number; body: unknown };
    snapshot = publicSnapshot(recovered.body, origin);
    if (!response.ok || recovered.status !== 200 || !snapshot)
      throw new Error('Building catalog recovery unavailable');
    value = recovered.body;
    raw = JSON.stringify(value);
  }
  // A revision is immutable. Remove local derived responses when replacing the base catalog.
  responses.deletePrefix(`${state.scope}:`);
  const catalog: Catalog = {
    raw: raw!,
    snapshot,
    imageBaseUrl: origin ?? null,
    byId: new Map(snapshot.buildings.map((building) => [building.id, building])),
    sorted: [...snapshot.buildings].sort((a, b) => b.buildDate.localeCompare(a.buildDate)),
    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
  };
  state.catalog = catalog;
  return catalog;
}
function publicSnapshot(value: unknown, origin?: string): PublicBuildingsSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as { version: number; buildings: unknown };
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 0 || !Array.isArray(snapshot.buildings)) return null;
  const ids = new Set<string>();
  const buildings: Building[] = [];
  for (const entry of snapshot.buildings) {
    const building = parseStoredBuilding(entry);
    if (!building || ids.has(building.id) || (building.images.length > 0 && !origin)) return null;
    ids.add(building.id);
    buildings.push(building);
  }
  return { version: snapshot.version, buildings };
}
function localizeBuilding(
  building: Building,
  locale: 'zh-CN' | 'en',
): Omit<Building, 'name' | 'description' | 'tags' | 'source'> & {
  name: string;
  description: string;
  tags?: string[];
  source?: Omit<Source, 'notes'> & { notes?: string };
} {
  return {
    ...building,
    name: building.name[locale] ?? building.name.en,
    description: building.description[locale] ?? building.description.en,
    tags: building.tags?.map((tag) => tag[locale] || tag['zh-CN'] || tag.en),
    source: building.source
      ? {
          ...building.source,
          notes: building.source.notes
            ? (building.source.notes[locale] || building.source.notes['zh-CN'] || building.source.notes.en || undefined)
            : undefined,
        }
      : undefined,
  };
}
function workerCache(): Cache | null {
  return typeof caches === 'undefined' ? null : caches.default;
}
function cacheRequest(key: string): Request {
  return new Request(`https://mikdata-buildings-cache.local/${key}`);
}
async function readResponseCache(key: string): Promise<string | null> {
  try {
    return (await (await workerCache()?.match(cacheRequest(key)))?.text()) ?? null;
  } catch (error) {
    console.warn('Building cache read failed', error);
    return null;
  }
}
async function writeResponseCache(key: string, body: string): Promise<void> {
  try {
    await workerCache()?.put(
      cacheRequest(key),
      new Response(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      }),
    );
  } catch (error) {
    console.warn('Building cache write failed', error);
  }
}
