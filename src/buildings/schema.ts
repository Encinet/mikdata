export function initializeBuildingStorage(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
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
      created_at TEXT NOT NULL, expires_at INTEGER, document TEXT NOT NULL, draft_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS submissions_owner ON submissions(owner, created_at DESC);
    CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS submissions_expiry ON submissions(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS submissions_draft ON submissions(owner,draft_key);
    CREATE TABLE IF NOT EXISTS building_publication (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
      published_revision INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO building_publication(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS image_uploads (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, draft_key TEXT NOT NULL, building_id TEXT NOT NULL,
      request_key TEXT, object_key TEXT, jxl_key TEXT, thumbnail_key TEXT, jxl_preview_bytes INTEGER,
      completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1))
    );
    CREATE INDEX IF NOT EXISTS uploads_owner ON image_uploads(owner, created_at);
    CREATE INDEX IF NOT EXISTS uploads_expiry ON image_uploads(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uploads_request ON image_uploads(owner,draft_key,request_key);
    CREATE INDEX IF NOT EXISTS uploads_building ON image_uploads(building_id);
    CREATE TABLE IF NOT EXISTS building_image_objects (
      object_key TEXT PRIMARY KEY, retire_revision INTEGER, due INTEGER, state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleting','deleted'))
    );
    CREATE INDEX IF NOT EXISTS image_objects_due ON building_image_objects(due);
    CREATE TABLE IF NOT EXISTS building_image_refs (
      owner TEXT NOT NULL, object_key TEXT NOT NULL, PRIMARY KEY(owner,object_key)
    );
    CREATE INDEX IF NOT EXISTS image_refs_key ON building_image_refs(object_key);
    CREATE TRIGGER IF NOT EXISTS uploads_remove_refs AFTER DELETE ON image_uploads BEGIN
      DELETE FROM building_image_refs WHERE owner='upload/' || OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS submissions_remove_refs AFTER DELETE ON submissions BEGIN
      DELETE FROM building_image_refs WHERE owner='submission/' || OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS buildings_remove_refs AFTER DELETE ON buildings BEGIN
      DELETE FROM building_image_refs WHERE owner='building/' || OLD.id;
    END;
    `);
    const columns = storage.sql.exec<{name: string}>('PRAGMA table_info(image_uploads)').toArray();
    if (!columns.some(c => c.name === 'thumbnail_key'))
      storage.sql.exec('ALTER TABLE image_uploads ADD COLUMN thumbnail_key TEXT');
    if (!columns.some(c => c.name === 'jxl_preview_bytes'))
      storage.sql.exec('ALTER TABLE image_uploads ADD COLUMN jxl_preview_bytes INTEGER');
  });
}
