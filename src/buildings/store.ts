import type { Transaction } from '../db/transaction';
import type { Building, BuildingImage, BuildingInput, BuildingSubmission, BuildingSubmissionSummary } from './types';

import { setImageReferences } from './images/lifecycle';
import { buildingImageKey, IMAGE_HASH_PATTERN, imageKeyHash, type ImageFiles } from './images/keys';
import { createBuildingId } from './id';
import { parseStoredBuilding, validateSubmissionPayload } from './validation';

const HISTORY_RETENTION_MS = 14 * 86400_000;
const UPLOAD_LIFETIME_MS = 24 * 3600_000;
const ACTIVE_SUBMISSION = '(expires_at IS NULL OR expires_at>?)';
type UploadReservation =
  | { uploadId: string }
  | { image: BuildingImage; expiresAt: number }
  | { error: string; retryAfter?: number };

export interface PublicBuildingsQuery {
  builder: string;
  tag: string;
  type: string;
  limit: number | null;
  offset: number;
}
interface UploadRow {
  id: string;
  building_id: string;
  object_key: string | null;
  jxl_key: string | null;
  thumbnail_key: string | null;
  jxl_preview_bytes: number | null;
  completed: number;
  expires_at: number;
}
interface DocumentRow {
  document: string;
}
interface IdRow {
  id: string;
}
interface SubmissionSummaryRow {
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

export class BuildingStore {
  constructor(readonly db: D1Database, readonly tx?: Transaction) {}

  private async rows<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    return (await this.db.prepare(sql).bind(...args).all<T>()).results;
  }

  private write(sql: string, ...args: unknown[]) {
    if (!this.tx) throw new Error('Building write requires a transaction');
    this.tx.write(sql, ...args);
  }

  async buildings(): Promise<Building[]> {
    return (await this.rows<DocumentRow>('SELECT document FROM buildings ORDER BY id'))
      .map((row) => readStoredBuilding(JSON.parse(row.document)));
  }
  async publicBuildings({ builder, tag, type, limit, offset }: PublicBuildingsQuery): Promise<{
    buildings: Building[];
    total?: number;
  }> {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (type) {
      conditions.push("json_extract(document, '$.buildType') = ?");
      values.push(type);
    }
    if (tag) {
      conditions.push(`EXISTS (SELECT 1 FROM json_each(document, '$.tags') AS tag
        WHERE json_extract(tag.value, '$."zh-CN"') = ? OR json_extract(tag.value, '$.en') = ?)`);
      values.push(tag, tag);
    }
    if (builder) {
      conditions.push(`EXISTS (SELECT 1 FROM json_each(document, '$.builders') AS builder
        WHERE json_extract(builder.value, '$.name') = ? OR json_extract(builder.value, '$.uuid') = ?)`);
      values.push(builder, builder);
    }
    const source = 'FROM buildings' + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '');
    const list = `SELECT document ${source} ORDER BY json_extract(document, '$.buildDate') DESC, id`;
    if (limit === null) {
      const rows = await this.rows<DocumentRow>(list, ...values);
      return { buildings: rows.map(row => readStoredBuilding(JSON.parse(row.document))) };
    }
    // Read the page and its total from the same D1 snapshot.
    const [page, count] = await this.db.batch<DocumentRow | { total: number }>([
      this.db.prepare(list + ' LIMIT ? OFFSET ?').bind(...values, limit, offset),
      this.db.prepare(`SELECT count(*) AS total ${source}`).bind(...values),
    ]);
    return {
      buildings: page.results.map(row => readStoredBuilding(JSON.parse((row as DocumentRow).document))),
      total: (count.results[0] as { total: number }).total,
    };
  }
  async building(id: string): Promise<Building | null> {
    const row = (await this.rows<DocumentRow>('SELECT document FROM buildings WHERE id=?', id))[0];
    return row ? readStoredBuilding(JSON.parse(row.document)) : null;
  }
  async buildingIdExists(id: string): Promise<boolean> {
    return (await this.rows<IdRow>('SELECT id FROM buildings WHERE id=?', id)).length > 0;
  }
  async duplicateBuildingId(input: BuildingInput, excluding = ''): Promise<string | null> {
    const common = [input.coordinates.world, input.buildDate, input.builders[0].uuid];
    const row = (await this.rows<IdRow>(`SELECT id FROM buildings
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
    ))[0];
    return row?.id ?? null;
  }
  insertBuilding(building: Building): void {
    this.write(
      'INSERT INTO buildings(id,document) VALUES(?,?)',
      building.id,
      this.serializeBuilding(building),
    );
  }
  async importBuildings(inputs: BuildingInput[]): Promise<{ buildings: Building[] } | { duplicate: string }> {
    const match = await this.rows<IdRow>(`WITH incoming AS (
      SELECT value AS doc FROM json_each(?)
    ) SELECT b.id FROM incoming i JOIN buildings b
      ON json_extract(b.document,'$.coordinates.world')=json_extract(i.doc,'$.coordinates.world')
      AND json_extract(b.document,'$.buildDate')=json_extract(i.doc,'$.buildDate')
      AND json_extract(b.document,'$.builders[0].uuid')=json_extract(i.doc,'$.builders[0].uuid')
      AND (json_extract(b.document,'$.name.en')=json_extract(i.doc,'$.name.en')
        OR json_extract(b.document,'$.name."zh-CN"')=json_extract(i.doc,'$.name."zh-CN"'))
      LIMIT 1`, JSON.stringify(inputs));
    if (match.length) return { duplicate: match[0].id };
    const ids = await this.allocateIds(inputs.length);
    const buildings = inputs.map((input, i) => ({ id: ids[i], ...input }));
    // The import contract admits only new buildings without images.
    this.write(`INSERT INTO buildings(id,document) SELECT json_extract(value,'$.id'),value FROM json_each(?)`,
      JSON.stringify(buildings));
    return { buildings };
  }
  updateBuilding(building: Building): void {
    this.write(
      'UPDATE buildings SET document=? WHERE id=?',
      this.serializeBuilding(building),
      building.id,
    );
  }
  private serializeBuilding(building: Building): string {
    setImageReferences(this.tx!, 'building/' + building.id, imageObjectKeys(building.id, building.images));
    return JSON.stringify(building);
  }
  deleteBuilding(id: string): void {
    this.write('DELETE FROM buildings WHERE id=?', id);
  }
  async submissionIdExists(id: string): Promise<boolean> {
    return (await this.rows<{ id: string }>('SELECT id FROM submissions WHERE id=?', id)).length > 0;
  }
  async submission(id: string): Promise<BuildingSubmission | null> {
    const row = (await this.rows<SubmissionRow>(`SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE id=? AND ${ACTIVE_SUBMISSION}`,
        id,
        Date.now(),
      ))[0];
    return row ? this.readSubmission(row) : null;
  }
  async submissions(status?: BuildingSubmission['status']): Promise<BuildingSubmission[]> {
    return (await this.rows<SubmissionRow>(`SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE ${ACTIVE_SUBMISSION}${status ? ' AND status=?' : ''}
         ORDER BY created_at DESC LIMIT 500`,
        Date.now(),
        ...(status ? [status] : []),
      ))
      .map((row) => this.readSubmission(row));
  }
  async submissionHistory(owner: string): Promise<BuildingSubmissionSummary[]> {
    return (await this.rows<SubmissionSummaryRow>(`SELECT id, status, json_extract(document, '$.payload.name') AS name,
              json_extract(document, '$.reviewNote') AS review_note, expires_at
       FROM submissions WHERE owner=? AND ${ACTIVE_SUBMISSION}
       ORDER BY created_at DESC LIMIT 500`,
      owner,
      Date.now(),
    )).map(({ id, status, name, review_note, expires_at }) => summarizeSubmission({
      id,
      status,
      name: JSON.parse(name),
      reviewNote: review_note ?? undefined,
      expiresAt: expires_at === null ? undefined : new Date(expires_at).toISOString(),
    }));
  }
  async pendingCount(owner: string): Promise<number> {
    return (await this.rows<{ count: number }>('SELECT count(*) AS count FROM submissions WHERE owner=? AND status=?',
        owner,
        'pending',
      ))[0].count;
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
    setImageReferences(this.tx!, 'submission/' + id, imageObjectKeys(id, document.payload.images));
    return JSON.stringify(document);
  }
  insertSubmission(submission: BuildingSubmission, draftKey: string): void {
    this.write(
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
    this.write(
      'UPDATE submissions SET status=?,expires_at=?,document=? WHERE id=?',
      submission.status,
      expires,
      this.serializeSubmission(submission),
      submission.id,
    );
  }
  async allocateBuildingId(): Promise<string> {
    return (await this.allocateIds(1))[0];
  }

  private async allocateIds(count: number): Promise<string[]> {
    const available = new Set<string>();
    for (let attempt = 0; attempt < 5 && available.size < count; attempt++) {
      const candidates = Array.from({ length: count - available.size }, () => createBuildingId());
      const collisions = await this.rows<IdRow>(`WITH candidates AS (SELECT value AS id FROM json_each(?))
        SELECT id FROM candidates WHERE id IN (SELECT id FROM buildings)
        OR id IN (SELECT id FROM submissions)
        OR EXISTS (SELECT 1 FROM image_uploads u WHERE u.building_id=candidates.id)`, JSON.stringify(candidates));
      const taken = new Set(collisions.map(row => row.id));
      for (const id of candidates) if (!taken.has(id)) available.add(id);
    }
    if (available.size !== count) throw new Error('Could not allocate building ID');
    return [...available];
  }
  async draftBuilding(owner: string, draft: string): Promise<string | undefined> {
    return (await this.rows<{building_id: string}>(`SELECT id AS building_id FROM submissions WHERE owner=? AND draft_key=?
       UNION ALL SELECT building_id FROM image_uploads WHERE owner=? AND draft_key=? AND expires_at>? LIMIT 1`,
      owner, draft, owner, draft, Date.now(),
    ))[0]?.building_id;
  }
  async reserveAdminImage(owner: string, draft: string, target: string | null, hashes: ImageFiles<string>) {
    const now = Date.now();
    const reserved = await this.draftBuilding(owner, draft);
    if (target) {
      if (reserved && reserved !== target) return null;
      if (!await this.buildingIdExists(target) && (await this.submission(target))?.status !== 'pending') return null;
    } else if (reserved && (await this.buildingIdExists(reserved) || await this.submissionIdExists(reserved))) {
      return null;
    }

    const buildingId = target ?? reserved ?? await this.allocateBuildingId();
    const keys = keysForHashes(buildingId, hashes);
    const requestKey = Object.values(keys).map(imageKeyHash).join('/');
    const prior = (await this.rows<UploadRow>('SELECT id,building_id,completed,expires_at,object_key,jxl_key,thumbnail_key,jxl_preview_bytes FROM image_uploads WHERE owner=? AND draft_key=? AND request_key=?',
      owner, draft, requestKey,
    ))[0];
    if (prior?.completed && prior.expires_at > now && prior.jxl_preview_bytes !== null &&
        prior.object_key === keys.webp && prior.jxl_key === keys.jxl && prior.thumbnail_key === keys.thumbnailWebp)
      return { id: prior.id, keys, buildingId, image: imageFromKeys(keys, prior.jxl_preview_bytes), completed: true as const };
    const id = prior?.id ?? crypto.randomUUID();
    this.referenceUpload(id, keys);
    this.write(
      `INSERT INTO image_uploads(id,owner,created_at,expires_at,draft_key,building_id,request_key,object_key,jxl_key,thumbnail_key)
       VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
       created_at=excluded.created_at, expires_at=excluded.expires_at, building_id=excluded.building_id,
       object_key=excluded.object_key, jxl_key=excluded.jxl_key, thumbnail_key=excluded.thumbnail_key, jxl_preview_bytes=NULL, completed=0`,
      id, owner, now, now + UPLOAD_LIFETIME_MS, draft, buildingId, requestKey, keys.webp, keys.jxl, keys.thumbnailWebp,
    );
    return { id, keys, buildingId, completed: false as const };
  }
  async reserveUpload(owner: string, draft: string, request: string): Promise<UploadReservation> {
    const now = Date.now();
    let buildingId = await this.draftBuilding(owner, draft);
    if (buildingId) {
      const prior = (await this.rows<UploadRow>(`SELECT id,building_id,object_key,jxl_key,thumbnail_key,jxl_preview_bytes,completed,expires_at FROM image_uploads
         WHERE owner=? AND draft_key=? AND request_key=? AND expires_at>? AND completed=1`,
        owner, draft, request, now,
      ))[0];
      const keys = uploadKeys(prior);
      if (keys && prior?.jxl_preview_bytes != null) return { image: imageFromKeys(keys, prior.jxl_preview_bytes), expiresAt: prior.expires_at };
    }
    if (buildingId && await this.submissionIdExists(buildingId)) return { error: 'draft_submitted' };
    if (await this.pendingCount(owner) >= 10) return { error: 'pending_limit_reached' };
    const active = (await this.rows<{ created_at: number }>('SELECT created_at FROM image_uploads WHERE owner=? AND completed=0 AND created_at>? LIMIT 1',
        owner,
        now - 60_000,
      ))[0];
    if (active)
      return {
        error: 'upload_in_progress',
        retryAfter: Math.ceil((active.created_at + 60_000 - now) / 1000),
      };
    const count = (await this.rows<{ count: number }>('SELECT count(*) AS count FROM image_uploads WHERE owner=? AND created_at>?',
        owner,
        now - UPLOAD_LIFETIME_MS,
      ))[0].count;
    if (count >= 60) return { error: 'upload_limit_reached', retryAfter: 3600 };
    if (!buildingId) buildingId = await this.allocateBuildingId();
    const id = crypto.randomUUID();
    // A failed attempt still counts towards the daily quota. Retire its request key before retrying.
    this.write(
      'UPDATE image_uploads SET request_key=NULL WHERE owner=? AND draft_key=? AND request_key=?',
      owner, draft, request,
    );
    this.write(
      'INSERT INTO image_uploads(id,owner,created_at,expires_at,draft_key,building_id,request_key) VALUES(?,?,?,?,?,?,?)',
      id,
      owner,
      now,
      now + UPLOAD_LIFETIME_MS, draft, buildingId, request,
    );
    return { uploadId: id };
  }
  private async activeUpload(owner: string, id: string) {
    return (await this.rows<UploadRow>(`SELECT id,building_id,object_key,jxl_key,thumbnail_key,jxl_preview_bytes,completed,expires_at FROM image_uploads WHERE id=? AND owner=? AND expires_at>?
        AND request_key IS NOT NULL`, id, owner, Date.now(),
    ))[0];
  }
  private referenceUpload(id: string, keys: ImageFiles<string>) {
    // A fresh upload can recreate identical bytes after the previous objects were collected.
    this.write(
      "UPDATE building_image_objects SET state='active' WHERE object_key IN (?,?,?) AND state='deleted'",
      keys.webp, keys.jxl, keys.thumbnailWebp,
    );
    setImageReferences(this.tx!, 'upload/' + id, Object.values(keys));
  }
  async prepareUpload(owner: string, id: string, hashes: ImageFiles<string>): Promise<ImageFiles<string> | null> {
    const row = await this.activeUpload(owner, id);
    if (!row || !Object.values(hashes).every(hash => IMAGE_HASH_PATTERN.test(hash))) return null;
    const keys = keysForHashes(row.building_id, hashes);
    if (row.object_key && (row.object_key !== keys.webp || row.jxl_key !== keys.jxl || row.thumbnail_key !== keys.thumbnailWebp))
      return null;
    this.referenceUpload(id, keys);
    this.write('UPDATE image_uploads SET object_key=?,jxl_key=?,thumbnail_key=? WHERE id=?', keys.webp, keys.jxl, keys.thumbnailWebp, id);
    return keys;
  }
  async uploadKeys(owner: string, id: string): Promise<ImageFiles<string> | null> {
    return uploadKeys(await this.activeUpload(owner, id));
  }
  async completeUpload(owner: string, id: string, keys: ImageFiles<string>, previewBytes: number) {
    const row = await this.activeUpload(owner, id);
    if (!row || row.object_key !== keys.webp || row.jxl_key !== keys.jxl || row.thumbnail_key !== keys.thumbnailWebp) return null;
    const budget = row.completed ? row.jxl_preview_bytes : previewBytes;
    if (budget === null) return null;
    if (!row.completed) this.write('UPDATE image_uploads SET completed=1,jxl_preview_bytes=? WHERE id=?', budget, id);
    return { image: imageFromKeys(keys, budget), expiresAt: row.expires_at };
  }
  async draftImages(owner: string, draft: string, buildingId: string): Promise<BuildingImage[]> {
    const rows = (await this.rows<UploadRow>(`SELECT object_key,jxl_key,thumbnail_key,jxl_preview_bytes FROM image_uploads
       WHERE owner=? AND draft_key=? AND building_id=? AND expires_at>? AND completed=1`,
      owner, draft, buildingId, Date.now(),
    ));
    return rows.map(row => {
      const keys = uploadKeys(row);
      if (!keys || row.jxl_preview_bytes === null) throw new Error('Invalid completed image upload');
      return imageFromKeys(keys, row.jxl_preview_bytes);
    });
  }
  cleanup(): void {
    // Bound each sweep; indexed expiry queries do not scan all accounts or submissions.
    this.write(
      'DELETE FROM submissions WHERE id IN (SELECT id FROM submissions WHERE expires_at<=? LIMIT 128)',
      Date.now(),
    );
    this.write(
      'DELETE FROM image_uploads WHERE id IN (SELECT id FROM image_uploads WHERE expires_at<=? LIMIT 128)',
      Date.now(),
    );
  }
}
