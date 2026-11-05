import { expect, test } from 'bun:test';
import { TtlMemoryCache } from '../src/memory-cache';

test('ttl memory cache expires records', () => {
  const cache = new TtlMemoryCache<string>({ defaultTtlMs: 100, maxEntries: 8 });

  cache.set('key', 'value', undefined, 1_000);

  expect(cache.get('key', 1_050)).toBe('value');
  expect(cache.get('key', 1_101)).toBe(null);
});

test('ttl memory cache evicts oldest records past max entries', () => {
  const cache = new TtlMemoryCache<string>({ defaultTtlMs: 1_000, maxEntries: 2 });

  cache.set('a', 'A', undefined, 1_000);
  cache.set('b', 'B', undefined, 1_000);
  cache.set('c', 'C', undefined, 1_000);

  expect(cache.get('a', 1_001)).toBe(null);
  expect(cache.get('b', 1_001)).toBe('B');
  expect(cache.get('c', 1_001)).toBe('C');
});

test('weighted cache evicts least recently used entries and rejects oversized values', () => {
  const cache = new TtlMemoryCache<string>({
    defaultTtlMs: 1000,
    maxEntries: 10,
    maxWeight: 4,
    weightOf: (value) => value.length,
  });
  cache.set('a', 'aa', undefined, 1000);
  cache.set('b', 'bb', undefined, 1000);
  expect(cache.get('a', 1001)).toBe('aa');
  cache.set('c', 'cc', undefined, 1001);
  expect(cache.get('b', 1001)).toBeNull();
  expect(cache.get('a', 1001)).toBe('aa');
  cache.set('c', 'oversized', undefined, 1001);
  expect(cache.get('c', 1001)).toBeNull();
  cache.set('a', 'x', undefined, 1001);
  cache.set('d', 'ddd', undefined, 1001);
  expect(cache.get('a', 1001)).toBe('x');
  expect(cache.get('d', 1001)).toBe('ddd');
});
