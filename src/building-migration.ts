import { BuildingStore, PUBLIC_BUILDINGS_KEY } from './building-store';
import { isBuildingDocument } from './buildings';
import type { Building } from './types';

export const BUILDING_MIGRATION_KEY = 'buildings:catalog-world:v1';
const RECORD_PREFIX = 'building:';
const SUMMARY_KEY = 'building-summary:v1';

function withWorld(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (
    !record.coordinates ||
    typeof record.coordinates !== 'object' ||
    Array.isArray(record.coordinates)
  )
    return value;
  const coordinates = record.coordinates as Record<string, unknown>;
  return {
    ...record,
    coordinates: {
      ...coordinates,
      world: coordinates.world === undefined ? 'world' : coordinates.world,
    },
  };
}

function document(value: unknown, id?: string): Building {
  const upgraded = withWorld(value);
  if (!isBuildingDocument(upgraded) || (id !== undefined && upgraded.id !== id))
    throw new Error(`Invalid building during catalog migration${id ? `: ${id}` : ''}`);
  return upgraded;
}

/** Original records are read only; a durable transaction commits the catalog and completion marker together. */
export async function migrateBuildingCatalog(
  storage: DurableObjectStorage,
  kv: KVNamespace,
  store: BuildingStore,
): Promise<void> {
  if (await storage.get(BUILDING_MIGRATION_KEY)) return;
  const recovered: Building[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({
      prefix: RECORD_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (let offset = 0; offset < page.keys.length; offset += 100) {
      const names = page.keys.slice(offset, offset + 100).map(({ name }) => name);
      const values = await kv.get(names, 'text');
      for (const name of names) {
        const raw = values.get(name);
        if (raw == null) throw new Error(`Building disappeared during migration: ${name}`);
        recovered.push(document(JSON.parse(raw), name.slice(RECORD_PREFIX.length)));
      }
    }
    if (page.list_complete) break;
    if (!page.cursor || page.cursor === cursor) throw new Error('Incomplete building key listing');
    cursor = page.cursor;
  } while (true);

  if (!recovered.length) {
    const summary = await kv.get(SUMMARY_KEY);
    const published = summary === null ? await kv.get(PUBLIC_BUILDINGS_KEY) : null;
    const value: unknown =
      summary !== null ? JSON.parse(summary) : published !== null ? JSON.parse(published) : [];
    const entries =
      published !== null && value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).buildings
        : value;
    if (!Array.isArray(entries)) throw new Error('Invalid building summary during migration');
    recovered.push(...entries.map((entry) => document(entry)));
  }
  const byId = new Map<string, Building>();
  for (const building of recovered) {
    if (byId.has(building.id))
      throw new Error(`Duplicate building during migration: ${building.id}`);
    byId.set(building.id, building);
  }
  await storage.transaction(async (txn) => {
    if (await txn.get(BUILDING_MIGRATION_KEY)) return;
    // Changes already committed in SQL take precedence over older KV records.
    for (const existing of store.buildings()) byId.set(existing.id, document(existing));
    store.saveCatalog([...byId.values()]);
    storage.sql.exec(`UPDATE submissions SET document=json_set(document,'$.payload.coordinates.world','world')
      WHERE json_type(document,'$.payload.coordinates')='object' AND json_type(document,'$.payload.coordinates.world') IS NULL`);
    await txn.put(BUILDING_MIGRATION_KEY, {
      completedAt: Date.now(),
      count: byId.size,
    });
  });
}
