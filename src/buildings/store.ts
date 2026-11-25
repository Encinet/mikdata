import type { Building, BuildingImage, BuildingInput, BuildingSubmission, BuildingSubmissionSummary } from './types';

import { setImageReferences } from './images/lifecycle';
import { buildingImageKey, IMAGE_HASH_PATTERN, imageKeyHash, type ImageFiles } from './images/keys';
import { createBuildingId } from './id';
import { parseStoredBuilding, validateSubmissionPayload } from './validation';

export const PUBLIC_BUILDINGS_KEY = 'buildings:public:v3';
export const PUBLISH_INTERVAL_MS = 5 * 60_000;
const HISTORY_RETENTION_MS = 14 * 86400_000;
const UPLOAD_LIFETIME_MS = 24 * 3600_000;
const ACTIVE_SUBMISSION = '(expires_at IS NULL OR expires_at>?)';
type UploadReservation =
  | { uploadId: string }
  | { image: BuildingImage; expiresAt: number }
  | { error: string; retryAfter?: number };

export interface PublicBuildingsSnapshot {
  version: number;
  buildings: Building[];
}
interface UploadRow extends Record<string, SqlStorageValue> {
  id: string;
  building_id: string;
  object_key: string | null;
  jxl_key: string | null;
  thumbnail_key: string | null;
  jxl_preview_bytes: number | null;
  completed: number;
  expires_at: number;
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
interface SubmissionSummaryRow extends Record<string, SqlStorageValue> {
  id: string;
  status: BuildingSubmission['status'];
  name: string;
  review_note: string | null;
  expires_at: number | null;
}
interface SubmissionRow extends DocumentRow {
  id: string;
  owner: string;
  status: BuildingSubmission['status'];
  created_at: string;
  expires_at: number | null;
}
type SubmissionDocument = Omit<BuildingSubmission, 'id' | 'submitterUuid' | 'status' | 'createdAt' | 'expiresAt'>;
const SUBMISSION_COLUMNS = 'id,owner,status,created_at,expires_at,document';

function readStoredBuilding(document: unknown): Building {
  const building = parseStoredBuilding(document);
  if (!building) throw new Error('Invalid stored building');
  return building;
}

function imageObjectKeys(id: string, images: BuildingImage[]) {
  return images.flatMap(image => Object.values(keysForHashes(id, image)));
}

function imageFromKeys(keys: ImageFiles<string>, previewBytes: number): BuildingImage {
  return {
    webp: imageKeyHash(keys.webp), jxl: imageKeyHash(keys.jxl),
    thumbnailWebp: imageKeyHash(keys.thumbnailWebp),
    jxlPreviewBytes: previewBytes,
  };
}

function uploadKeys(row?: UploadRow): ImageFiles<string> | null {
  return row?.object_key && row.jxl_key && row.thumbnail_key ? {
    webp: row.object_key, jxl: row.jxl_key, thumbnailWebp: row.thumbnail_key,
  } : null;
}

function keysForHashes(id: string, hashes: ImageFiles<string>): ImageFiles<string> {
  return {
    webp: buildingImageKey(id, hashes.webp, 'webp'),
    jxl: buildingImageKey(id, hashes.jxl, 'jxl'),
    thumbnailWebp: buildingImageKey(id, hashes.thumbnailWebp, 'webp'),
  };
}

export function summarizeSubmission({ id, name, status, reviewNote, expiresAt }: BuildingSubmissionSummary): BuildingSubmissionSummary {
  return status === 'rejected' ? { id, name, status, reviewNote, expiresAt } : { id, name, status };
}

/** All methods are local SQL operations. Call mutations inside the owning DO's transaction. */
export class BuildingStore {
  constructor(private readonly storage: DurableObjectStorage) {}
  buildings(): Building[] {
    return this.storage.sql
      .exec<DocumentRow>('SELECT document FROM buildings ORDER BY id')
      .toArray()
      .map((row) => readStoredBuilding(JSON.parse(row.document)));
  }
  building(id: string): Building | null {
    const row = this.storage.sql
      .exec<DocumentRow>('SELECT document FROM buildings WHERE id=?', id)
      .toArray()[0];
    return row ? readStoredBuilding(JSON.parse(row.document)) : null;
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
      this.serializeBuilding(building),
    );
  }
  updateBuilding(building: Building): void {
    this.storage.sql.exec(
      'UPDATE buildings SET document=? WHERE id=?',
      this.serializeBuilding(building),
      building.id,
    );
    this.markChanged();
  }
  private serializeBuilding(building: Building): string {
    setImageReferences(this.storage.sql, 'building/' + building.id, imageObjectKeys(building.id, building.images));
    return JSON.stringify(building);
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
  submissionIdExists(id: string): boolean {
    return this.storage.sql
      .exec<{ id: string }>('SELECT id FROM submissions WHERE id=?', id)
      .toArray().length > 0;
  }
  submission(id: string): BuildingSubmission | null {
    const row = this.storage.sql
      .exec<SubmissionRow>(
        `SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE id=? AND ${ACTIVE_SUBMISSION}`,
        id,
        Date.now(),
      )
      .toArray()[0];
    return row ? this.readSubmission(row) : null;
  }
  submissions(status?: BuildingSubmission['status']): BuildingSubmission[] {
    return this.storage.sql
      .exec<SubmissionRow>(
        `SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE ${ACTIVE_SUBMISSION}${status ? ' AND status=?' : ''}
         ORDER BY created_at DESC LIMIT 500`,
        Date.now(),
        ...(status ? [status] : []),
      )
      .toArray()
      .map((row) => this.readSubmission(row));
  }
  submissionHistory(owner: string): BuildingSubmissionSummary[] {
    return this.storage.sql.exec<SubmissionSummaryRow>(
      `SELECT id, status, json_extract(document, '$.payload.name') AS name,
              json_extract(document, '$.reviewNote') AS review_note, expires_at
       FROM submissions WHERE owner=? AND ${ACTIVE_SUBMISSION}
       ORDER BY created_at DESC LIMIT 500`,
      owner,
      Date.now(),
    ).toArray().map(({ id, status, name, review_note, expires_at }) => summarizeSubmission({
      id,
      status,
      name: JSON.parse(name),
      reviewNote: review_note ?? undefined,
      expiresAt: expires_at === null ? undefined : new Date(expires_at).toISOString(),
    }));
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
  private readSubmission({ id, owner, status, created_at, expires_at, document }: SubmissionRow): BuildingSubmission {
    const stored = JSON.parse(document) as SubmissionDocument;
    const payload = validateSubmissionPayload(stored.payload);
    if (!payload.ok) throw new Error('Invalid stored submission payload');
    return {
      ...stored,
      payload: payload.value,
      id,
      submitterUuid: owner,
      status,
      createdAt: created_at,
      expiresAt: expires_at === null ? undefined : new Date(expires_at).toISOString(),
    };
  }
  private serializeSubmission({ id, submitterUuid: _owner, status: _status, createdAt: _createdAt, expiresAt: _expiresAt, ...document }: BuildingSubmission): string {
    setImageReferences(this.storage.sql, 'submission/' + id, imageObjectKeys(id, document.payload.images));
    return JSON.stringify(document);
  }
  insertSubmission(submission: BuildingSubmission, draftKey: string): void {
    this.storage.sql.exec(
      'INSERT INTO submissions(id,owner,status,created_at,expires_at,document,draft_key) VALUES(?,?,?,?,?,?,?)',
      submission.id,
      submission.submitterUuid,
      submission.status,
      submission.createdAt,
      submission.expiresAt ? Date.parse(submission.expiresAt) : null,
      this.serializeSubmission(submission),
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
      this.serializeSubmission(submission),
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
  reserveAdminImage(owner: string, draft: string, target: string | null, hashes: ImageFiles<string>) {
    const now = Date.now();
    const reserved = this.draftBuilding(owner, draft);
    if (target) {
      if (reserved && reserved !== target) return null;
      if (!this.buildingIdExists(target) && this.submission(target)?.status !== 'pending') return null;
    } else if (reserved && (this.buildingIdExists(reserved) || this.submissionIdExists(reserved))) {
      return null;
    }

    const buildingId = target ?? reserved ?? this.allocateBuildingId();
    const keys = keysForHashes(buildingId, hashes);
    const requestKey = Object.values(keys).map(imageKeyHash).join('/');
    const prior = this.storage.sql.exec<UploadRow>(
      'SELECT id,building_id,completed,expires_at,object_key,jxl_key,thumbnail_key,jxl_preview_bytes FROM image_uploads WHERE owner=? AND draft_key=? AND request_key=?',
      owner, draft, requestKey,
    ).toArray()[0];
    if (prior?.completed && prior.expires_at > now && prior.jxl_preview_bytes !== null &&
        prior.object_key === keys.webp && prior.jxl_key === keys.jxl && prior.thumbnail_key === keys.thumbnailWebp)
      return { id: prior.id, keys, buildingId, image: imageFromKeys(keys, prior.jxl_preview_bytes), completed: true as const };
    const id = prior?.id ?? crypto.randomUUID();
    this.referenceUpload(id, keys);
    this.storage.sql.exec(
      `INSERT INTO image_uploads(id,owner,created_at,expires_at,draft_key,building_id,request_key,object_key,jxl_key,thumbnail_key)
       VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
       created_at=excluded.created_at, expires_at=excluded.expires_at, building_id=excluded.building_id,
       object_key=excluded.object_key, jxl_key=excluded.jxl_key, thumbnail_key=excluded.thumbnail_key, jxl_preview_bytes=NULL, completed=0`,
      id, owner, now, now + UPLOAD_LIFETIME_MS, draft, buildingId, requestKey, keys.webp, keys.jxl, keys.thumbnailWebp,
    );
    return { id, keys, buildingId, completed: false as const };
  }
  reserveUpload(owner: string, draft: string, request: string): UploadReservation {
    const now = Date.now();
    let buildingId = this.draftBuilding(owner, draft);
    if (buildingId) {
      const prior = this.storage.sql.exec<UploadRow>(
        `SELECT id,building_id,object_key,jxl_key,thumbnail_key,jxl_preview_bytes,completed,expires_at FROM image_uploads
         WHERE owner=? AND draft_key=? AND request_key=? AND expires_at>? AND completed=1`,
        owner, draft, request, now,
      ).toArray()[0];
      const keys = uploadKeys(prior);
      if (keys && prior?.jxl_preview_bytes != null) return { image: imageFromKeys(keys, prior.jxl_preview_bytes), expiresAt: prior.expires_at };
    }
    if (buildingId && this.submissionIdExists(buildingId)) return { error: 'draft_submitted' };
    if (this.pendingCount(owner) >= 10) return { error: 'pending_limit_reached' };
    const active = this.storage.sql
      .exec<{ created_at: number }>(
        'SELECT created_at FROM image_uploads WHERE owner=? AND completed=0 AND created_at>? LIMIT 1',
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
    return { uploadId: id };
  }
  private activeUpload(owner: string, id: string) {
    return this.storage.sql.exec<UploadRow>(
      `SELECT id,building_id,object_key,jxl_key,thumbnail_key,jxl_preview_bytes,completed,expires_at FROM image_uploads WHERE id=? AND owner=? AND expires_at>?
        AND request_key IS NOT NULL`, id, owner, Date.now(),
    ).toArray()[0];
  }
  private referenceUpload(id: string, keys: ImageFiles<string>) {
    // A fresh upload can recreate identical bytes after the previous objects were collected.
    this.storage.sql.exec(
      "UPDATE building_image_objects SET state='active' WHERE object_key IN (?,?,?) AND state='deleted'",
      keys.webp, keys.jxl, keys.thumbnailWebp,
    );
    setImageReferences(this.storage.sql, 'upload/' + id, Object.values(keys));
  }
  prepareUpload(owner: string, id: string, hashes: ImageFiles<string>): ImageFiles<string> | null {
    const row = this.activeUpload(owner, id);
    if (!row || !Object.values(hashes).every(hash => IMAGE_HASH_PATTERN.test(hash))) return null;
    const keys = keysForHashes(row.building_id, hashes);
    if (row.object_key && (row.object_key !== keys.webp || row.jxl_key !== keys.jxl || row.thumbnail_key !== keys.thumbnailWebp))
      return null;
    this.referenceUpload(id, keys);
    this.storage.sql.exec('UPDATE image_uploads SET object_key=?,jxl_key=?,thumbnail_key=? WHERE id=?', keys.webp, keys.jxl, keys.thumbnailWebp, id);
    return keys;
  }
  uploadKeys(owner: string, id: string): ImageFiles<string> | null {
    return uploadKeys(this.activeUpload(owner, id));
  }
  completeUpload(owner: string, id: string, keys: ImageFiles<string>, previewBytes: number) {
    const row = this.activeUpload(owner, id);
    if (!row || row.object_key !== keys.webp || row.jxl_key !== keys.jxl || row.thumbnail_key !== keys.thumbnailWebp) return null;
    const budget = row.completed ? row.jxl_preview_bytes : previewBytes;
    if (budget === null) return null;
    if (!row.completed) this.storage.sql.exec('UPDATE image_uploads SET completed=1,jxl_preview_bytes=? WHERE id=?', budget, id);
    return { image: imageFromKeys(keys, budget), expiresAt: row.expires_at };
  }
  draftImages(owner: string, draft: string, buildingId: string): BuildingImage[] {
    const rows = this.storage.sql.exec<UploadRow>(
      `SELECT object_key,jxl_key,thumbnail_key,jxl_preview_bytes FROM image_uploads
       WHERE owner=? AND draft_key=? AND building_id=? AND expires_at>? AND completed=1`,
      owner, draft, buildingId, Date.now(),
    ).toArray();
    return rows.map(row => {
      const keys = uploadKeys(row);
      if (!keys || row.jxl_preview_bytes === null) throw new Error('Invalid completed image upload');
      return imageFromKeys(keys, row.jxl_preview_bytes);
    });
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
