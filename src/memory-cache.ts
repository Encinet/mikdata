interface MemoryCacheOptions<T> {
  defaultTtlMs: number;
  maxEntries: number;
  maxWeight?: number;
  weightOf?: (value: T, key: string) => number;
}

interface MemoryCacheRecord<T> {
  value: T;
  expiresAt: number;
  weight: number;
}

export class TtlMemoryCache<T> {
  private readonly records = new Map<string, MemoryCacheRecord<T>>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxWeight: number;
  private readonly weightOf: (value: T, key: string) => number;
  private weight = 0;
  private nextPruneAt = 0;

  constructor(options: MemoryCacheOptions<T>) {
    this.defaultTtlMs = options.defaultTtlMs;
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxWeight = Math.max(0, options.maxWeight ?? Infinity);
    this.weightOf = options.weightOf ?? (() => 1);
  }

  get(key: string, now = Date.now()): T | null {
    const record = this.records.get(key);

    if (!record) {
      return null;
    }

    if (record.expiresAt <= now) {
      this.delete(key);
      return null;
    }

    this.records.delete(key);
    this.records.set(key, record);
    return record.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs, now = Date.now()): void {
    const weight = Math.max(0, this.weightOf(value, key));
    this.delete(key);
    if (!Number.isFinite(weight) || weight > this.maxWeight) return;
    if (now >= this.nextPruneAt) this.prune(now);
    this.records.set(key, {
      value,
      expiresAt: now + Math.max(1, ttlMs),
      weight,
    });
    this.weight += weight;

    while (this.records.size > this.maxEntries || this.weight > this.maxWeight) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const record = this.records.get(key);
    if (record) this.weight -= record.weight;
    this.records.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) {
        this.delete(key);
      }
    }
  }

  clear(): void {
    this.records.clear();
    this.weight = 0;
  }

  private prune(now: number): void {
    this.nextPruneAt = now + 1000;
    for (const [key, record] of this.records.entries()) {
      if (record.expiresAt <= now) {
        this.delete(key);
      }
    }
  }
}
