import type { Building, BuildingSubmission, BuildingSubmissionImage } from './types';

export const PUBLIC_BUILDINGS_KEY = 'buildings:public:v2';
export const PUBLISH_INTERVAL_MS = 5 * 60_000;
const HISTORY_RETENTION_MS = 14 * 86400_000;
const UPLOAD_LIFETIME_MS = 24 * 3600_000;
export interface PublicBuildingsSnapshot {
  version: number;
  buildings: Building[];
}
interface DocumentRow extends Record<string, SqlStorageValue> {
  document: string;
}
interface PublicationRow extends Record<string, SqlStorageValue> {
  revision: number;
  published_revision: number;
  next_attempt: number;
  failures: number;
}

/** All methods are local SQL operations. Call mutations inside the owning DO's transaction. */
export class BuildingStore {
  constructor(private readonly storage: DurableObjectStorage) {}
  initialize(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS buildings (id TEXT PRIMARY KEY, document TEXT NOT NULL);
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
  }
  buildings(): Building[] {
    return this.storage.sql
      .exec<DocumentRow>('SELECT document FROM buildings ORDER BY id')
      .toArray()
      .map((row) => JSON.parse(row.document) as Building);
  }
  building(id: string): Building | null {
    const row = this.storage.sql
      .exec<DocumentRow>('SELECT document FROM buildings WHERE id=?', id)
      .toArray()[0];
    return row ? (JSON.parse(row.document) as Building) : null;
  }
  saveBuilding(building: Building): void {
    this.storage.sql.exec(
      'INSERT INTO buildings(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
      building.id,
      JSON.stringify(building),
    );
    this.markChanged();
  }
  saveCatalog(buildings: Building[]): void {
    for (const building of buildings) {
      this.storage.sql.exec(
        'INSERT INTO buildings(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
        building.id, JSON.stringify(building),
      );
    }
    // Even a new, empty catalog needs an explicit public snapshot.
    this.markChanged();
  }
  snapshot(): PublicBuildingsSnapshot {
    return { version: this.publication().revision, buildings: this.buildings() };
  }
  requestPublication(): void {
    const state = this.publication();
    if (state.revision <= state.published_revision) this.markChanged();
  }
  deleteBuilding(id: string): void {
    this.storage.sql.exec('DELETE FROM buildings WHERE id=?', id);
    this.markChanged();
  }
  private markChanged(): void {
    this.storage.sql.exec(
      'UPDATE building_publication SET revision=revision+1, next_attempt=max(next_attempt,?) WHERE id=1',
      Date.now() + 1000,
    );
  }
  submission(id: string): BuildingSubmission | null {
    const row = this.storage.sql
      .exec<DocumentRow>(
        'SELECT document FROM submissions WHERE id=? AND (expires_at IS NULL OR expires_at>?)',
        id,
        Date.now(),
      )
      .toArray()[0];
    return row ? (JSON.parse(row.document) as BuildingSubmission) : null;
  }
  submissions(owner?: string, status?: BuildingSubmission['status']): BuildingSubmission[] {
    const filters = ['(expires_at IS NULL OR expires_at>?)'];
    const args: SqlStorageValue[] = [Date.now()];
    if (owner) {
      filters.push('owner=?');
      args.push(owner);
    }
    if (status) {
      filters.push('status=?');
      args.push(status);
    }
    return this.storage.sql
      .exec<DocumentRow>(
        `SELECT document FROM submissions WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT 500`,
        ...args,
      )
      .toArray()
      .map((row) => JSON.parse(row.document) as BuildingSubmission);
  }
  pendingCount(owner: string): number {
    return this.storage.sql
      .exec<{ count: number }>(
        'SELECT count(*) AS count FROM submissions WHERE owner=? AND status=?',
        owner,
        'pending',
      )
      .one().count;
  }
  saveSubmission(submission: BuildingSubmission): void {
    // Preserve the review result briefly; a successful approval and its building commit together.
    const expires =
      submission.status === 'pending'
        ? null
        : Date.parse(
            submission.expiresAt ?? new Date(Date.now() + HISTORY_RETENTION_MS).toISOString(),
          );
    if (expires !== null) submission.expiresAt = new Date(expires).toISOString();
    this.storage.sql.exec(
      `INSERT INTO submissions(id,owner,status,created_at,expires_at,document) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,expires_at=excluded.expires_at,document=excluded.document`,
      submission.id,
      submission.submitterUuid,
      submission.status,
      submission.createdAt,
      expires,
      JSON.stringify(submission),
    );
  }
  publication(): PublicationRow {
    return this.storage.sql
      .exec<PublicationRow>(
        'SELECT revision,published_revision,next_attempt,failures FROM building_publication WHERE id=1',
      )
      .one();
  }
  publicationDue(): number | null {
    const row = this.publication();
    return row.revision > row.published_revision
      ? Math.max(Date.now() + 1000, row.next_attempt)
      : null;
  }
  async publish(kv: KVNamespace): Promise<void> {
    const state = this.publication();
    if (state.revision <= state.published_revision || state.next_attempt > Date.now()) return;
    const snapshot = this.snapshot();
    // Persist the rate limit before external I/O; even an ambiguous timeout never causes a tight retry.
    this.storage.sql.exec(
      'UPDATE building_publication SET next_attempt=? WHERE id=1',
      Date.now() + PUBLISH_INTERVAL_MS,
    );
    try {
      await kv.put(PUBLIC_BUILDINGS_KEY, JSON.stringify(snapshot));
      this.storage.sql.exec(
        'UPDATE building_publication SET published_revision=max(published_revision,?),failures=0 WHERE id=1',
        snapshot.version,
      );
    } catch (error) {
      const failures = Math.min(state.failures + 1, 8);
      this.storage.sql.exec(
        'UPDATE building_publication SET failures=?,next_attempt=? WHERE id=1',
        failures,
        Date.now() + Math.min(3600_000, PUBLISH_INTERVAL_MS * 2 ** (failures - 1)),
      );
      console.warn('Public building snapshot publication deferred', error);
    }
  }
  reserveUpload(owner: string): { id?: string; error?: string; retryAfter?: number } {
    const now = Date.now();
    const active = this.storage.sql
      .exec<{ created_at: number }>(
        'SELECT created_at FROM image_uploads WHERE owner=? AND image IS NULL AND created_at>? LIMIT 1',
        owner,
        now - 60_000,
      )
      .toArray()[0];
    if (active)
      return {
        error: 'upload_in_progress',
        retryAfter: Math.ceil((active.created_at + 60_000 - now) / 1000),
      };
    const count = this.storage.sql
      .exec<{ count: number }>(
        'SELECT count(*) AS count FROM image_uploads WHERE owner=? AND created_at>?',
        owner,
        now - UPLOAD_LIFETIME_MS,
      )
      .one().count;
    if (count >= 60) return { error: 'upload_limit_reached', retryAfter: 3600 };
    const id = crypto.randomUUID();
    this.storage.sql.exec(
      'INSERT INTO image_uploads(id,owner,created_at,expires_at) VALUES(?,?,?,?)',
      id,
      owner,
      now,
      now + UPLOAD_LIFETIME_MS,
    );
    return { id };
  }
  completeUpload(owner: string, id: string, image: BuildingSubmissionImage): boolean {
    const row = this.storage.sql
      .exec<{ image: string | null }>(
        'SELECT image FROM image_uploads WHERE id=? AND owner=? AND expires_at>?',
        id,
        owner,
        Date.now(),
      )
      .toArray()[0];
    if (!row) return false;
    if (row.image !== null) return row.image === JSON.stringify(image);
    this.storage.sql.exec('UPDATE image_uploads SET image=? WHERE id=?', JSON.stringify(image), id);
    return true;
  }
  ownedImages(owner: string, images: BuildingSubmissionImage[]): BuildingSubmissionImage[] | null {
    // Never derive authoritative metadata from browser fields.
    const rows = this.storage.sql
      .exec<{ image: string }>(
        'SELECT image FROM image_uploads WHERE owner=? AND expires_at>? AND image IS NOT NULL',
        owner,
        Date.now(),
      )
      .toArray();
    const byUrl = new Map(
      rows.map((row) => {
        const image = JSON.parse(row.image) as BuildingSubmissionImage;
        return [image.url, image] as const;
      }),
    );
    const result = images.map((image) => byUrl.get(image.url));
    return result.every((image): image is BuildingSubmissionImage => !!image) ? result : null;
  }
  cleanup(): void {
    // Bound each sweep; indexed expiry queries do not scan all accounts or submissions.
    this.storage.sql.exec(
      'DELETE FROM submissions WHERE id IN (SELECT id FROM submissions WHERE expires_at<=? LIMIT 128)',
      Date.now(),
    );
    this.storage.sql.exec(
      'DELETE FROM image_uploads WHERE id IN (SELECT id FROM image_uploads WHERE expires_at<=? LIMIT 128)',
      Date.now(),
    );
  }
}
