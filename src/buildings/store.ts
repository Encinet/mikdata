import type { Building, BuildingInput, BuildingSubmission, BuildingSubmissionImage } from './types';

import { setImageReferences } from './images/lifecycle';
import { expandImages, galleryImageKeys, imageKeyFromUrl, imageKeyHash, mapSubmissionUrls, publicImageUrl, type StoredBuilding } from './images/keys';
import { createBuildingId } from './id';

export const PUBLIC_BUILDINGS_KEY = 'buildings:public:v2';
export const PUBLISH_INTERVAL_MS = 5 * 60_000;
const HISTORY_RETENTION_MS = 14 * 86400_000;
const UPLOAD_LIFETIME_MS = 24 * 3600_000;
interface UploadReservation {
  id?: string;
  buildingId?: string;
  image?: BuildingSubmissionImage;
  expiresAt?: number;
  error?: string;
  retryAfter?: number;
}

export interface PublicBuildingsSnapshot {
  version: number;
  buildings: StoredBuilding[];
}
interface DocumentRow extends Record<string, SqlStorageValue> {
  document: string;
}
interface IdRow extends Record<string, SqlStorageValue> {
  id: string;
}
interface PublicationRow extends Record<string, SqlStorageValue> {
  revision: number;
  published_revision: number;
  next_attempt: number;
  failures: number;
}

/** All methods are local SQL operations. Call mutations inside the owning DO's transaction. */
export class BuildingStore {
  constructor(private readonly storage: DurableObjectStorage, readonly imageOrigin?: string) {}
  buildings(): Building[] {
    return this.storedBuildings().map(row => expandImages(row, this.imageOrigin));
  }
  private storedBuildings(): StoredBuilding[] {
    return this.storage.sql
      .exec<DocumentRow>('SELECT document FROM buildings ORDER BY id')
      .toArray()
      .map((row) => JSON.parse(row.document) as StoredBuilding);
  }
  building(id: string): Building | null {
    const row = this.storage.sql
      .exec<DocumentRow>('SELECT document FROM buildings WHERE id=?', id)
      .toArray()[0];
    return row ? expandImages(JSON.parse(row.document), this.imageOrigin) : null;
  }
  buildingIdExists(id: string): boolean {
    return this.storage.sql.exec<IdRow>('SELECT id FROM buildings WHERE id=?', id).toArray().length > 0;
  }
  duplicateBuildingId(input: BuildingInput, excluding = ''): string | null {
    const common = [input.coordinates.world, input.buildDate, input.builders[0].uuid];
    const row = this.storage.sql.exec<IdRow>(
      `SELECT id FROM buildings
       WHERE json_extract(document, '$.coordinates.world')=?
         AND json_extract(document, '$.buildDate')=?
         AND json_extract(document, '$.builders[0].uuid')=?
         AND json_extract(document, '$.name."zh-CN"')=? AND id<>?
       UNION ALL
       SELECT id FROM buildings
       WHERE json_extract(document, '$.coordinates.world')=?
         AND json_extract(document, '$.buildDate')=?
         AND json_extract(document, '$.builders[0].uuid')=?
         AND json_extract(document, '$.name.en')=? AND id<>?
       ORDER BY id LIMIT 1`,
      ...common, input.name['zh-CN'], excluding,
      ...common, input.name.en, excluding,
    ).toArray()[0];
    return row?.id ?? null;
  }
  insertBuilding(building: Building): void {
    this.insertBuildingRow(building);
    this.markChanged();
  }
  insertBuildings(buildings: readonly Building[]): void {
    for (const building of buildings) this.insertBuildingRow(building);
    if (buildings.length) this.markChanged();
  }
  private insertBuildingRow(building: Building): void {
    this.storage.sql.exec(
      'INSERT INTO buildings(id,document) VALUES(?,?)',
      building.id,
      this.buildingDocument(building),
    );
  }
  updateBuilding(building: Building): void {
    this.storage.sql.exec(
      'UPDATE buildings SET document=? WHERE id=?',
      this.buildingDocument(building),
      building.id,
    );
    this.markChanged();
  }
  private buildingDocument({ images, ...building }: Building): string {
    const keys = galleryImageKeys(building.id, images, this.imageOrigin);
    if (!keys) throw new Error('Invalid building gallery');
    setImageReferences(this.storage.sql, 'building/' + building.id, keys);
    return JSON.stringify({ ...building, imageHashes: keys.map(imageKeyHash) } satisfies StoredBuilding);
  }
  snapshot(): PublicBuildingsSnapshot {
    return { version: this.publication().revision, buildings: this.storedBuildings() };
  }
  requestPublication(): void {
    const state = this.publication();
    if (state.revision <= state.published_revision) this.markChanged();
  }
  deleteBuilding(id: string, expectedUpdatedAt?: string): 'deleted' | 'not-found' | 'conflict' {
    const expected = expectedUpdatedAt ?? null;
    const deleted = this.storage.sql.exec<IdRow>(
      `DELETE FROM buildings WHERE id=?
       AND (? IS NULL OR json_extract(document, '$.updatedAt')=?) RETURNING id`,
      id, expected, expected,
    ).toArray().length > 0;
    if (deleted) {
      this.markChanged();
      return 'deleted';
    }
    return this.buildingIdExists(id) ? 'conflict' : 'not-found';
  }
  private markChanged(): void {
    this.storage.sql.exec(
      'UPDATE building_publication SET revision=revision+1, next_attempt=max(next_attempt,?) WHERE id=1',
      Date.now() + 1000,
    );
  }
  submissionIdExists(id: string): boolean {
    return this.storage.sql
      .exec<{ id: string }>('SELECT id FROM submissions WHERE id=?', id)
      .toArray().length > 0;
  }
  submission(id: string): BuildingSubmission | null {
    const row = this.storage.sql
      .exec<DocumentRow>(
        'SELECT document FROM submissions WHERE id=? AND draft_key IS NOT NULL AND (expires_at IS NULL OR expires_at>?)',
        id,
        Date.now(),
      )
      .toArray()[0];
    return row ? this.readSubmission(row.document) : null;
  }
  submissions(owner?: string, status?: BuildingSubmission['status']): BuildingSubmission[] {
    const filters = ['draft_key IS NOT NULL', '(expires_at IS NULL OR expires_at>?)'];
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
      .map((row) => this.readSubmission(row.document));
  }
  pendingCount(owner: string): number {
    return this.storage.sql
      .exec<{ count: number }>(
        'SELECT count(*) AS count FROM submissions WHERE owner=? AND status=? AND draft_key IS NOT NULL',
        owner,
        'pending',
      )
      .one().count;
  }
  private readSubmission(document: string): BuildingSubmission {
    return mapSubmissionUrls(JSON.parse(document), url => publicImageUrl(url, this.imageOrigin));
  }
  private submissionDocument(submission: BuildingSubmission): string {
    const stored = mapSubmissionUrls(submission, url => {
      const key = imageKeyFromUrl(url, this.imageOrigin);
      if (!key) throw new Error('Invalid submission image URL');
      return key;
    });
    setImageReferences(this.storage.sql, 'submission/' + submission.id, stored.payload.images);
    return JSON.stringify(stored);
  }
  insertSubmission(submission: BuildingSubmission, draftKey: string): void {
    this.storage.sql.exec(
      'INSERT INTO submissions(id,owner,status,created_at,expires_at,document,draft_key) VALUES(?,?,?,?,?,?,?)',
      submission.id,
      submission.submitterUuid,
      submission.status,
      submission.createdAt,
      submission.expiresAt ? Date.parse(submission.expiresAt) : null,
      this.submissionDocument(submission),
      draftKey,
    );
  }
  updateSubmission(submission: BuildingSubmission): void {
    // Preserve the review result briefly; a successful approval and its building commit together.
    const expires =
      submission.status === 'pending'
        ? null
        : Date.parse(
            submission.expiresAt ?? new Date(Date.now() + HISTORY_RETENTION_MS).toISOString(),
          );
    if (expires !== null) submission.expiresAt = new Date(expires).toISOString();
    this.storage.sql.exec(
      'UPDATE submissions SET status=?,expires_at=?,document=? WHERE id=?',
      submission.status,
      expires,
      this.submissionDocument(submission),
      submission.id,
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
  allocateBuildingId(reserved?: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = createBuildingId();
      if (reserved?.has(id) || this.submissionIdExists(id)) continue;
      if (this.buildingIdExists(id)) continue;
      // New submissions share the ID reserved for their final building.
      if (!this.storage.sql.exec('SELECT 1 FROM image_uploads WHERE building_id=? LIMIT 1', id).toArray().length)
        return id;
    }
    throw new Error('Could not allocate building ID');
  }
  draftBuilding(owner: string, draft: string): string | undefined {
    return this.storage.sql.exec<{building_id: string}>(
      `SELECT id AS building_id FROM submissions WHERE owner=? AND draft_key=?
       UNION ALL SELECT building_id FROM image_uploads WHERE owner=? AND draft_key=? AND expires_at>? LIMIT 1`,
      owner, draft, owner, draft, Date.now(),
    ).toArray()[0]?.building_id;
  }
  reserveAdminImage(owner: string, draft: string, target: string | null, hash: string) {
    const now = Date.now();
    const reserved = this.draftBuilding(owner, draft);
    if (target) {
      if (reserved && reserved !== target) return null;
      if (!this.buildingIdExists(target) && this.submission(target)?.status !== 'pending') return null;
    } else if (reserved && (this.buildingIdExists(reserved) || this.submissionIdExists(reserved))) {
      return null;
    }

    const buildingId = target ?? reserved ?? this.allocateBuildingId();
    const key = `buildings/${buildingId}/${hash}.webp`;
    const prior = this.storage.sql.exec<{ id: string; image: string | null; expires_at: number; object_key: string }>(
      'SELECT id,image,expires_at,object_key FROM image_uploads WHERE owner=? AND draft_key=? AND request_key=?',
      owner, draft, hash,
    ).toArray()[0];
    if (prior?.image && prior.object_key === key && prior.expires_at > now)
      return { id: prior.id, key, image: this.readImage(prior.image) };
    const id = prior?.id ?? crypto.randomUUID();
    // A fresh upload can recreate identical bytes after the previous object was collected.
    this.storage.sql.exec(
      "UPDATE building_image_objects SET state='active' WHERE object_key=? AND state='deleted'",
      key,
    );
    setImageReferences(this.storage.sql, 'upload/' + id, [key]);
    this.storage.sql.exec(
      `INSERT INTO image_uploads(id,owner,created_at,expires_at,draft_key,building_id,request_key,object_key)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
       created_at=excluded.created_at, expires_at=excluded.expires_at, building_id=excluded.building_id,
       object_key=excluded.object_key, image=NULL`,
      id, owner, now, now + UPLOAD_LIFETIME_MS, draft, buildingId, hash, key,
    );
    return { id, key };
  }
  reserveUpload(owner: string, draft: string, request: string): UploadReservation {
    const now = Date.now();
    let buildingId = this.draftBuilding(owner, draft);
    if (buildingId) {
      const prior = this.storage.sql.exec<{id: string; image: string | null; expires_at: number}>(
        'SELECT id,image,expires_at FROM image_uploads WHERE owner=? AND draft_key=? AND request_key=? AND expires_at>?',
        owner, draft, request, now,
      ).toArray()[0];
      if (prior?.image) return { id: prior.id, buildingId, image: this.readImage(prior.image), expiresAt: prior.expires_at };
    }
    if (buildingId && this.submissionIdExists(buildingId)) return { error: 'draft_submitted' };
    if (this.pendingCount(owner) >= 10) return { error: 'pending_limit_reached' };
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
    if (!buildingId) buildingId = this.allocateBuildingId();
    const id = crypto.randomUUID();
    // A failed attempt still counts towards the daily quota. Retire its request key before retrying.
    this.storage.sql.exec(
      'UPDATE image_uploads SET request_key=NULL WHERE owner=? AND draft_key=? AND request_key=?',
      owner, draft, request,
    );
    this.storage.sql.exec(
      'INSERT INTO image_uploads(id,owner,created_at,expires_at,draft_key,building_id,request_key) VALUES(?,?,?,?,?,?,?)',
      id,
      owner,
      now,
      now + UPLOAD_LIFETIME_MS, draft, buildingId, request,
    );
    return { id, buildingId };
  }
  private readImage(document: string): BuildingSubmissionImage {
    const image: BuildingSubmissionImage = JSON.parse(document);
    return { ...image, url: publicImageUrl(image.url, this.imageOrigin) };
  }
  private activeUpload(owner: string, id: string) {
    return this.storage.sql.exec<{ building_id: string; object_key: string | null; image: string | null; expires_at: number }>(
      `SELECT building_id,object_key,image,expires_at FROM image_uploads WHERE id=? AND owner=? AND expires_at>?
        AND request_key IS NOT NULL`, id, owner, Date.now(),
    ).toArray()[0];
  }
  prepareUpload(owner: string, id: string, hash: string): string | null {
    const row = this.activeUpload(owner, id);
    if (!row || !/^[0-9a-f]{64}$/.test(hash)) return null;
    const key = `buildings/${row.building_id}/${hash}.webp`;
    if (row.object_key && row.object_key !== key) return null;
    setImageReferences(this.storage.sql, 'upload/' + id, [key]);
    this.storage.sql.exec('UPDATE image_uploads SET object_key=? WHERE id=?', key, id);
    return key;
  }
  uploadKey(owner: string, id: string, url: string): string | null {
    const key = this.activeUpload(owner, id)?.object_key;
    return key && publicImageUrl(key, this.imageOrigin) === url ? key : null;
  }
  completeUpload(owner: string, id: string, image: BuildingSubmissionImage): number | null {
    const row = this.activeUpload(owner, id);
    if (!row?.object_key || publicImageUrl(row.object_key, this.imageOrigin) !== image.url) return null;
    const document = JSON.stringify({ ...image, url: row.object_key });
    if (row.image !== null) return row.image === document ? row.expires_at : null;
    this.storage.sql.exec('UPDATE image_uploads SET image=? WHERE id=?', document, id);
    return row.expires_at;
  }
  ownedImages(owner: string, images: BuildingSubmissionImage[], buildingId: string): BuildingSubmissionImage[] | null {
    // Never derive authoritative metadata from browser fields.
    const rows = this.storage.sql
      .exec<{ image: string }>(
        'SELECT image FROM image_uploads WHERE owner=? AND building_id=? AND expires_at>? AND image IS NOT NULL',
        owner, buildingId,
        Date.now(),
      )
      .toArray();
    const byUrl = new Map(
      rows.map((row) => {
        const image = this.readImage(row.image);
        return [image.url, image] as const;
      }),
    );
    const result = images.map((image) => byUrl.get(image.url));
    return result.every((image): image is BuildingSubmissionImage => !!image) ? result : null;
  }
  adminDraftImages(owner: string, draft: string, buildingId: string): BuildingSubmissionImage[] {
    return this.storage.sql.exec<{image: string}>(
      `SELECT image FROM image_uploads WHERE owner=? AND draft_key=? AND building_id=? AND expires_at>? AND image IS NOT NULL`,
      owner, draft, buildingId, Date.now(),
    ).toArray().map(row => this.readImage(row.image));
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
