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

test('ttl memory cache deletes records by prefix', () => {
  const cache = new TtlMemoryCache<string>({ defaultTtlMs: 1_000, maxEntries: 8 });

  cache.set('kv0:v1:building-list:a', 'A', undefined, 1_000);
  cache.set('kv0:v1:building-list:b', 'B', undefined, 1_000);
  cache.set('kv1:v1:building-list:a', 'C', undefined, 1_000);
  cache.set('kv0:v1:building:detail', 'D', undefined, 1_000);

  cache.deletePrefix('kv0:v1:building-list:');

  expect(cache.get('kv0:v1:building-list:a', 1_001)).toBe(null);
  expect(cache.get('kv0:v1:building-list:b', 1_001)).toBe(null);
  expect(cache.get('kv1:v1:building-list:a', 1_001)).toBe('C');
  expect(cache.get('kv0:v1:building:detail', 1_001)).toBe('D');
});
