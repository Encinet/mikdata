import type { Env } from '../env';
import { json, serializedJson } from '../shared/http';
import { imagePublicBaseUrl } from './images/storage';
import { BUILDING_ID_PATTERN } from './id';
import { BuildingStore, type PublicBuildingsQuery } from './store';
import type { Building, Source } from './types';

const CACHE_TTL_SECONDS = 60;
const MAX_LIST_LIMIT = 100;
const BUILDING_ROUTE_RE = new RegExp(`^/buildings/(${BUILDING_ID_PATTERN})$`);
const reads = new WeakMap<D1Database, Map<string, Promise<string | null>>>();

interface Query extends PublicBuildingsQuery {
  locale: '' | 'zh-CN' | 'en';
}

export async function handlePublicBuildingsRoute(
  routePath: string,
  request: Request,
  env: Env,
): Promise<Response | null> {
  const detail = routePath.match(BUILDING_ROUTE_RE);
  if (routePath !== '/buildings' && !detail) return null;
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const url = new URL(request.url);
  const query = detail ? null : parseQuery(url.searchParams);
  if (query && 'error' in query) return json(query, 400, { 'Cache-Control': 'no-store' });

  const imageBaseUrl = imagePublicBaseUrl(env) ?? null;
  const key = new URL('/.mikdata-cache/v1' + routePath, url.origin);
  // Normalize parameters and separate responses that point to different image origins.
  key.search = new URLSearchParams({
    imageBaseUrl: imageBaseUrl ?? '',
    ...(query && {
      builder: query.builder, tag: query.tag, type: query.type, locale: query.locale,
      limit: String(query.limit ?? ''), offset: String(query.offset),
    }),
  }).toString();

  try {
    let pendingReads = reads.get(env.DB);
    if (!pendingReads) {
      pendingReads = new Map();
      reads.set(env.DB, pendingReads);
    }
    let pending = pendingReads.get(key.href);
    if (!pending) {
      const inFlight = pendingReads;
      pending = readPublicBuildings(
        new Request(key),
        async () => {
          const store = new BuildingStore(env.DB);
          if (query) {
            const { buildings, total } = await store.publicBuildings(query);
            if (!imageBaseUrl && buildings.some(building => building.images.length))
              throw new Error('Building image base URL is missing');
            const { locale } = query;
            return { imageBaseUrl, buildings: locale ? buildings.map(building => localizeBuilding(building, locale)) : buildings, total };
          }
          const building = await store.building(detail![1]);
          if (!building) return null;
          if (!imageBaseUrl && building.images.length) throw new Error('Building image base URL is missing');
          return { imageBaseUrl, building };
        },
      ).finally(() => inFlight.delete(key.href));
      pendingReads.set(key.href, pending);
    }
    const body = await pending;
    return body === null
      ? json({ error: 'building not found' }, 404, { 'Cache-Control': 'no-store' })
      : serializedJson(body, 200, { 'Cache-Control': 'public, max-age=0, must-revalidate' });
  } catch (error) {
    console.warn('Public building data unavailable', error);
    return json({ error: 'building_data_unavailable' }, 503, { 'Cache-Control': 'no-store' });
  }
}

async function readPublicBuildings(key: Request, load: () => Promise<object | null>): Promise<string | null> {
  const cache = typeof caches === 'undefined' ? undefined : caches.default;
  try {
    const cached = await cache?.match(key);
    if (cached) return await cached.text();
  } catch (error) {
    console.warn('Building cache read failed', error);
  }
  const value = await load();
  if (value === null) return null;
  const body = JSON.stringify(value);
  if (cache) {
    try {
      await cache.put(key, serializedJson(body, 200, { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` }));
    } catch (error) {
      console.warn('Building cache write failed', error);
    }
  }
  return body;
}

function parseQuery(params: URLSearchParams): Query | { error: 'invalid_limit' | 'invalid_offset' } {
  const limits = params.getAll('limit');
  const offsets = params.getAll('offset');
  const limit = parseInteger(limits);
  const offset = parseInteger(offsets);
  if (limits.length && (limit === null || limit < 1 || limit > MAX_LIST_LIMIT))
    return { error: 'invalid_limit' };
  if (offsets.length && (offset === null || limit === null))
    return { error: 'invalid_offset' };

  const locale = params.get('locale')?.trim() ?? '';
  return {
    builder: params.get('builder')?.trim() ?? '',
    limit,
    offset: offset ?? 0,
    tag: params.get('tag')?.trim() ?? '',
    type: params.get('type')?.trim() ?? '',
    locale: locale ? (locale === 'zh-CN' ? 'zh-CN' : 'en') : '',
  };
}

function parseInteger(values: string[]): number | null {
  if (values.length !== 1 || !/^\d+$/.test(values[0].trim())) return null;
  const value = Number(values[0]);
  return Number.isSafeInteger(value) ? value : null;
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
