import type { Transaction } from '../../db/transaction';
import { deleteBuildingImage, type ImageStorage } from './storage';

const RETIRE_AFTER_MS = 14 * 86_400_000;
const UNREFERENCED =
  'NOT EXISTS (SELECT 1 FROM building_image_refs r WHERE r.object_key=building_image_objects.object_key)';
/** Mutations run in the same SQLite transaction as their owning document. */
export function setImageReferences(
  tx: Transaction,
  owner: string,
  keys: string[],
): void {
  tx.write('DELETE FROM building_image_refs WHERE owner=?', owner);
  if (!keys.length) return;
  const objects = JSON.stringify([...new Set(keys)]);
  tx.write(`INSERT INTO building_image_objects(object_key) SELECT value FROM json_each(?) WHERE true
    ON CONFLICT(object_key) DO UPDATE SET due=NULL WHERE state='active'`, objects);
  tx.write('INSERT INTO building_image_refs(owner,object_key) SELECT ?,value FROM json_each(?)', owner, objects);
}

export async function collectBuildingImages(
  db: D1Database,
  config: ImageStorage,
): Promise<void> {
  await db.prepare(`UPDATE building_image_objects SET due=?
    WHERE state='active' AND due IS NULL AND ${UNREFERENCED}`)
    .bind(Date.now() + RETIRE_AFTER_MS).run();
  const { results } = await db.prepare('SELECT object_key FROM building_image_objects WHERE due<=? ORDER BY due LIMIT 8')
    .bind(Date.now()).all<{ object_key: string }>();
  for (const { object_key: key } of results) {
    const locked = await db.prepare(`UPDATE building_image_objects SET state='deleting',due=?
      WHERE object_key=? AND due<=? AND ${UNREFERENCED} RETURNING object_key`)
      .bind(Date.now() + 3600_000, key, Date.now()).first();
    if (!locked) continue;
    try {
      await deleteBuildingImage(config, key);
      await db.prepare("UPDATE building_image_objects SET state='deleted',due=NULL WHERE object_key=? AND state='deleting'").bind(key).run();
    } catch (error) {
      console.warn('Building image deletion deferred', key, error);
    }
  }
}
