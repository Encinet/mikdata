import { createBuildingId, isBuildingId } from './building-id';

export function migrateBuildingStorage(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS building_migrations (version INTEGER PRIMARY KEY)',
    );
    if (
      storage.sql.exec('SELECT version FROM building_migrations WHERE version=1').toArray().length
    )
      return;
    storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS buildings (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS buildings_duplicate_zh ON buildings (
      json_extract(document, '$.coordinates.world'),
      json_extract(document, '$.buildDate'),
      json_extract(document, '$.builders[0].uuid'),
      json_extract(document, '$.name."zh-CN"'), id
    );
    CREATE INDEX IF NOT EXISTS buildings_duplicate_en ON buildings (
      json_extract(document, '$.coordinates.world'),
      json_extract(document, '$.buildDate'),
      json_extract(document, '$.builders[0].uuid'),
      json_extract(document, '$.name.en'), id
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at INTEGER, document TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS submissions_owner ON submissions(owner, created_at DESC);
    CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS submissions_expiry ON submissions(expires_at);
    CREATE TABLE IF NOT EXISTS building_publication (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
      published_revision INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO building_publication(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS image_uploads (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, image TEXT
    );
    CREATE INDEX IF NOT EXISTS uploads_owner ON image_uploads(owner, created_at);
    CREATE INDEX IF NOT EXISTS uploads_expiry ON image_uploads(expires_at);
    `);
    // Include historical references to deleted buildings so their identities stay distinct.
    const buildingIds = storage.sql
      .exec<{ id: string }>(`
      SELECT id FROM buildings
      UNION SELECT json_extract(document, '$.buildingId') AS id FROM submissions
      WHERE json_type(document, '$.buildingId')='text'
    `)
      .toArray();
    const replacements = replaceIds(storage.sql, 'buildings', buildingIds);
    replaceIds(
      storage.sql,
      'submissions',
      storage.sql.exec<{ id: string }>('SELECT id FROM submissions').toArray(),
    );
    for (const [previous, id] of replacements) {
      storage.sql.exec(
        `UPDATE submissions SET document=json_set(document, '$.buildingId', ?)
         WHERE json_extract(document, '$.buildingId')=?`,
        id,
        previous,
      );
    }
    if (replacements.size) {
      storage.sql.exec(
        'UPDATE building_publication SET revision=revision+1, next_attempt=max(next_attempt,?) WHERE id=1',
        Date.now() + 1000,
      );
    }
    storage.sql.exec('INSERT INTO building_migrations(version) VALUES(1)');
  });
}

function replaceIds(
  sql: SqlStorage,
  table: 'buildings' | 'submissions',
  rows: { id: string }[],
): Map<string, string> {
  const reserved = new Set(rows.map((row) => row.id));
  const replacements = new Map<string, string>();
  for (const { id: previous } of rows) {
    if (isBuildingId(previous)) continue;
    let id: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = createBuildingId();
      if (!reserved.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error(`Could not migrate ${table} ID`);
    reserved.add(id);
    sql.exec(
      `UPDATE ${table} SET id=?, document=json_set(document, '$.id', ?) WHERE id=?`,
      id,
      id,
      previous,
    );
    replacements.set(previous, id);
  }
  return replacements;
}
