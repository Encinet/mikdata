import type { Env } from '../env';
import {
  fetchAfdianOrders,
  fetchAfdianSponsors,
  type AfdianOrder,
  type AfdianSponsor,
} from './afdian';

export const AFDIAN_FRESH_MS = 15 * 60_000;
const RETRY_MS = 5 * 60_000;
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CACHE_NAME = 'mikdata-afdian-payments';

export interface AfdianPayload {
  fetchedAt: number;
  sponsors: AfdianSponsor[];
  orders: AfdianOrder[];
  ordersComplete: boolean;
}

const EMPTY: AfdianPayload = { fetchedAt: 0, sponsors: [], orders: [], ordersComplete: true };

export class AfdianCache {
  private readonly key?: Request;
  private payload?: AfdianPayload;
  private pending?: Promise<AfdianPayload | undefined>;
  private retryAt = 0;

  constructor(private readonly env: Env) {
    const userId = env.AFDIAN_USER_ID?.trim();
    if (userId && env.AFDIAN_API_TOKEN?.trim()) {
      const url = new URL('https://data.mcmik.top/api/sponsors');
      url.searchParams.set('afdian', userId);
      this.key = new Request(url);
    }
  }

  get(): Promise<AfdianPayload | undefined> {
    if (!this.key) return Promise.resolve(EMPTY);
    const now = Date.now();
    if (this.payload && now - this.payload.fetchedAt < AFDIAN_FRESH_MS)
      return Promise.resolve(this.payload);
    if (now < this.retryAt) return Promise.resolve(this.stale());
    this.pending ??= this.refresh(this.key).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private stale(): AfdianPayload | undefined {
    if (this.payload && Date.now() - this.payload.fetchedAt < MAX_AGE_SECONDS * 1000)
      return this.payload;
    return undefined;
  }

  private async refresh(key: Request): Promise<AfdianPayload | undefined> {
    if (!this.payload) {
      this.payload = await readCache(key);
      if (this.payload && Date.now() - this.payload.fetchedAt < AFDIAN_FRESH_MS) return this.payload;
    }

    try {
      const signal = AbortSignal.timeout(20_000);
      const [sponsors, { orders, status }] = await Promise.all([
        fetchAfdianSponsors(this.env, signal).catch((error) => {
          console.warn('Afdian sponsor names unavailable', error);
          return [];
        }),
        fetchAfdianOrders(this.env, signal),
      ]);
      const now = Date.now();
      const previous = this.stale();
      if (status === 'incomplete' && previous?.ordersComplete) {
        const expiresAt = previous.fetchedAt + MAX_AGE_SECONDS * 1000;
        this.retryAt = Math.min(now + RETRY_MS, expiresAt);
        return previous;
      }
      const payload = { fetchedAt: now, sponsors, orders, ordersComplete: status === 'complete' };
      this.payload = payload;
      await writeCache(key, payload);
      return payload;
    } catch (error) {
      this.retryAt = Date.now() + RETRY_MS;
      console.warn('Afdian sponsor refresh failed', error);
      return this.stale();
    }
  }
}

async function readCache(key: Request): Promise<AfdianPayload | undefined> {
  if (typeof caches === 'undefined') return undefined;
  try {
    const response = await (await caches.open(CACHE_NAME)).match(key);
    if (!response) return undefined;
    const value = await response.json<AfdianPayload>();
    if (
      Number.isSafeInteger(value?.fetchedAt) &&
      value.fetchedAt > 0 &&
      Array.isArray(value.sponsors) &&
      Array.isArray(value.orders) &&
      typeof value.ordersComplete === 'boolean'
    ) {
      return value;
    }
  } catch (error) {
    console.warn('Afdian cache read failed', error);
  }
  return undefined;
}

async function writeCache(key: Request, payload: AfdianPayload): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, Response.json(payload, {
      headers: { 'Cache-Control': 'public, max-age=' + MAX_AGE_SECONDS },
    }));
  } catch (error) {
    console.warn('Afdian cache write failed', error);
  }
}
