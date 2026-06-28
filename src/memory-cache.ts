interface MemoryCacheOptions {
  defaultTtlMs: number;
  maxEntries: number;
}

interface MemoryCacheRecord<T> {
  value: T;
  expiresAt: number;
}

export class TtlMemoryCache<T> {
  private readonly records = new Map<string, MemoryCacheRecord<T>>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(options: MemoryCacheOptions) {
    this.defaultTtlMs = options.defaultTtlMs;
    this.maxEntries = Math.max(1, options.maxEntries);
  }

  get(key: string, now = Date.now()): T | null {
    const record = this.records.get(key);

    if (!record) {
      return null;
    }

    if (record.expiresAt <= now) {
      this.records.delete(key);
      return null;
    }

    return record.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs, now = Date.now()): void {
    this.prune(now);
    this.records.set(key, {
      value,
      expiresAt: now + Math.max(1, ttlMs),
    });

    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value;
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }

  delete(key: string): void {
    this.records.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) {
        this.records.delete(key);
      }
    }
  }

  clear(): void {
    this.records.clear();
  }

  private prune(now: number): void {
    if (this.records.size < this.maxEntries) {
      return;
    }

    for (const [key, record] of this.records.entries()) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
      }
    }
  }
}
