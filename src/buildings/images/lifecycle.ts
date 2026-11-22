import { deleteBuildingImage, type ImageStorage } from './storage';

const RETIRE_AFTER_MS = 14 * 86_400_000;
const UNREFERENCED =
  'NOT EXISTS (SELECT 1 FROM building_image_refs r WHERE r.object_key=building_image_objects.object_key)';
export class UnavailableBuildingImage extends Error {
  constructor() {
    super('image_unavailable');
  }
}

/** Mutations run in the same SQLite transaction as their owning document. */
export function setImageReferences(
  sql: SqlStorage,
  owner: string,
  keys: string[],
): void {
  sql.exec('DELETE FROM building_image_refs WHERE owner=?', owner);
  for (const key of new Set(keys)) {
    const active = sql.exec(
      `INSERT INTO building_image_objects(object_key) VALUES(?)
       ON CONFLICT(object_key) DO UPDATE SET retire_revision=NULL,due=NULL WHERE state='active'
       RETURNING object_key`,
      key,
    ).toArray();
    if (!active.length) throw new UnavailableBuildingImage();
    sql.exec('INSERT OR IGNORE INTO building_image_refs(owner,object_key) VALUES(?,?)', owner, key);
  }
}

export async function collectBuildingImages(
  storage: DurableObjectStorage,
  config: ImageStorage,
): Promise<void> {
  const sql = storage.sql;
  // Remember the revision once. Later edits to unrelated buildings cannot postpone retirement.
  sql.exec(`UPDATE building_image_objects
    SET retire_revision=(SELECT revision FROM building_publication WHERE id=1)
    WHERE state='active' AND retire_revision IS NULL AND ${UNREFERENCED}`);
  sql.exec(
    `UPDATE building_image_objects SET due=? WHERE state='active' AND due IS NULL
      AND retire_revision <= (SELECT published_revision FROM building_publication WHERE id=1)`,
    Date.now() + RETIRE_AFTER_MS,
  );
  const candidates = sql
    .exec<{ object_key: string }>(
      'SELECT object_key FROM building_image_objects WHERE due<=? ORDER BY due LIMIT 8',
      Date.now(),
    )
    .toArray();
  for (const { object_key: key } of candidates) {
    // Persist the lock before network I/O. On an ambiguous DELETE the next alarm retries.
    const locked = sql
      .exec(
        `UPDATE building_image_objects SET state='deleting',due=?
      WHERE object_key=? AND due<=? AND ${UNREFERENCED} RETURNING object_key`,
        Date.now() + 3600_000,
        key,
        Date.now(),
      )
      .toArray();
    if (!locked.length) continue;
    try {
      await deleteBuildingImage(config, key);
      sql.exec(
        "UPDATE building_image_objects SET state='deleted',due=NULL WHERE object_key=? AND state='deleting'",
        key,
      );
    } catch (error) {
      console.warn(
        'Building image deletion deferred',
        key,
        error instanceof Error ? error.message : 'storage error',
      );
    }
  }
}
