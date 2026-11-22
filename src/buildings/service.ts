import type { AdminActor } from '../auth/access';
import type { BuildingStore } from './store';
import { adminImageOwner, galleryImageKeys, isImageDraftKey } from './images/keys';
import type { Building, BuildingInput, BuildingSubmission } from './types';
import {
  stripStoredBuildingFields,
  validateBuildingInput,
  validateSubmissionImages,
  VALID_FIELDS,
} from './validation';

export interface BuildingResult {
  status: number;
  body: unknown;
}
export interface BuildingAccount {
  playerUuid: string;
  currentName: string;
  role: string;
}
interface AdminCommandContext {
  body: unknown;
  expectedUpdatedAt?: string;
  draftKey?: string;
  status?: string;
  actor: AdminActor;
}
export type AdminBuildingCommand = AdminCommandContext &
  (
    | { operation: 'listBuildings' | 'createBuilding' | 'importBuildings' | 'listSubmissions' }
    | {
        operation:
          | 'replaceBuilding'
          | 'patchBuilding'
          | 'deleteBuilding'
          | 'editSubmission'
          | 'approveSubmission'
          | 'rejectSubmission';
        id: string;
      }
  );
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETENTION_MS = 14 * 86400_000;
const result = (body: unknown, status = 200): BuildingResult => ({ status, body });
const error = (message: string, status: number): BuildingResult =>
  result({ error: message }, status);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function reviewNote(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, 500) || undefined : undefined;
}
function nextUpdatedAt(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

/** The owning Durable Object provides the transaction and authorization boundary. */
export class BuildingService {
  constructor(private readonly store: BuildingStore) {}

  admin(command: AdminBuildingCommand): BuildingResult {
    switch (command.operation) {
      case 'listBuildings':
        return result(this.store.buildings());
      case 'createBuilding':
        return this.create(command);
      case 'importBuildings':
        return this.import(command);
      case 'replaceBuilding':
      case 'patchBuilding':
        return this.update(command.id, command);
      case 'deleteBuilding':
        return this.delete(command.id, command);
      case 'listSubmissions': {
        const status = command.status;
        return result({
          submissions: this.store.submissions(
            undefined,
            status === 'pending' || status === 'approved' || status === 'rejected'
              ? status
              : undefined,
          ),
        });
      }
      case 'editSubmission':
        return this.review(command.id, undefined, command);
      case 'approveSubmission':
        return this.review(command.id, 'approve', command);
      case 'rejectSubmission':
        return this.review(command.id, 'reject', command);
      default:
        return error('not found', 404);
    }
  }

  createSubmission(data: unknown, account: BuildingAccount): BuildingResult {
    const owner = account.playerUuid.toLowerCase();
    if (!UUID_RE.test(owner) || !account.currentName || !account.role)
      return error('unauthenticated', 401);
    if (!object(data)) return error('body must be a JSON object', 400);
    const validation = validateBuildingInput(data.payload);
    if (!validation.ok) return error(validation.message, 422);
    const images = validateSubmissionImages(data.images, validation.value.images);
    if (!images.ok) return error(images.message, 422);
    const payload = validation.value;
    if (!payload.builders.some((builder) => builder.uuid === owner)) {
      payload.builders.unshift({ uuid: owner, name: account.currentName, weight: 100 });
    }
    const final = validateBuildingInput(payload);
    if (!final.ok) return error(final.message, 422);
    const draftKey = typeof data.draftKey === 'string' ? data.draftKey : '';
    const buildingId = draftKey && this.store.draftBuilding(owner, draftKey);
    if (!buildingId) return error('invalid_draft', 422);
    const prior = this.store.submission(buildingId);
    if (prior) {
      const repeated = prior.submitterUuid === owner && JSON.stringify(prior.payload) === JSON.stringify(final.value);
      return repeated ? result({ submission: prior }) : error('draft_submitted', 409);
    }
    if (this.store.pendingCount(owner) >= 10)
      return result({ error: 'pending_limit_reached', limit: 10 }, 429);
    const ownedImages = this.store.ownedImages(owner, images.value, buildingId);
    if (!ownedImages)
      return error('images must be uploaded by the current account within 24 hours', 422);
    const now = new Date().toISOString();
    const submission: BuildingSubmission = {
      id: buildingId,
      status: 'pending',
      submitterUuid: owner,
      submitterName: account.currentName,
      submitterRole: account.role,
      payload: final.value,
      images: ownedImages,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertSubmission(submission, draftKey);
    return result({ submission }, 201);
  }

  listSubmissions(playerUuid: string): BuildingResult {
    return result({ submissions: this.store.submissions(playerUuid.toLowerCase()) });
  }

  private conflict(
    command: AdminBuildingCommand,
    updatedAt: string,
    operation: string,
  ): BuildingResult | null {
    const expected = command.expectedUpdatedAt?.trim();
    return expected && expected !== updatedAt ? error(operation, 409) : null;
  }

  private create(command: AdminBuildingCommand): BuildingResult {
    const input = validateBuildingInput(command.body);
    if (!input.ok) return error(input.message, 422);
    let reserved: string | undefined;
    if (input.value.images.length) {
      const owner = adminImageOwner(command.actor);
      const draft = command.draftKey;
      reserved = owner && isImageDraftKey(draft) ? this.store.draftBuilding(owner, draft) : undefined;
      if (!reserved || !isImageDraftKey(draft) || !owner)
        return error('image_draft_unavailable', 422);
      if (this.store.buildingIdExists(reserved) || this.store.submissionIdExists(reserved))
        return error('image_draft_unavailable', 409);
      const uploaded = new Set(this.store.adminDraftImages(owner, draft, reserved).map(image => image.url));
      if (!input.value.images.every(url => uploaded.has(url))) return error('image_unavailable', 422);
    }
    const existing = this.store.duplicateBuildingId(input.value);
    if (existing) return error(`duplicate building: ${existing}`, 409);
    const now = new Date().toISOString();
    const building = {
      id: reserved ?? this.store.allocateBuildingId(),
      ...input.value,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertBuilding(building);
    this.audit('create', building.id, command.actor);
    return result(building, 201);
  }

  private update(id: string, command: AdminBuildingCommand): BuildingResult {
    const previous = this.store.building(id);
    if (!previous) return error('building not found', 404);
    let data = command.body;
    if (command.operation === 'patchBuilding') {
      if (!object(data)) return error('body must be a JSON object', 400);
      const patch = data;
      for (const key of Object.keys(patch))
        if (!VALID_FIELDS.has(key)) return error(`unknown field: ${key}`, 422);
      const merged = stripStoredBuildingFields(previous) as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        merged[key] = object(value) && object(merged[key]) ? { ...merged[key], ...value } : value;
      }
      data = merged;
    }
    const input = validateBuildingInput(data);
    if (!input.ok)
      return error(
        command.operation === 'patchBuilding'
          ? `patch produces invalid document: ${input.message}`
          : input.message,
        422,
      );
    if (!galleryImageKeys(id, input.value.images, this.store.imageOrigin))
      return error('images must be managed WebP originals for this building', 422);
    const conflict = this.conflict(
      command,
      previous.updatedAt,
      'building has changed, refresh before saving',
    );
    if (conflict) return conflict;
    const additions = input.value.images.filter(url => !previous.images.includes(url));
    if (additions.length) {
      const owner = adminImageOwner(command.actor);
      const draft = command.draftKey;
      if (!owner || !isImageDraftKey(draft)) return error('image_draft_unavailable', 422);
      const uploaded = this.store.adminDraftImages(owner, draft, id);
      if (!additions.every(url => uploaded.some(image => image.url === url)))
        return error('image_unavailable', 422);
    }
    const building = {
      id,
      ...input.value,
      createdAt: previous.createdAt,
      updatedAt: nextUpdatedAt(previous.updatedAt),
    };
    const existing = this.store.duplicateBuildingId(building, id);
    if (existing) return error(`duplicate building: ${existing}`, 409);
    this.store.updateBuilding(building);
    this.audit(command.operation === 'patchBuilding' ? 'patch' : 'replace', id, command.actor);
    return result(building);
  }

  private delete(id: string, command: AdminBuildingCommand): BuildingResult {
    const deleted = this.store.deleteBuilding(id, command.expectedUpdatedAt?.trim() || undefined);
    if (deleted === 'not-found') return error('building not found', 404);
    if (deleted === 'conflict') return error('building has changed, refresh before deleting', 409);
    this.audit('delete', id, command.actor);
    return result({ deleted: id });
  }

  private import(command: AdminBuildingCommand): BuildingResult {
    const values = object(command.body) ? command.body.buildings : command.body;
    if (!Array.isArray(values)) return error('import body must be an array', 400);
    if (!values.length) return error('import body must not be empty', 400);
    if (values.length > 100) return error('import exceeds max count 100', 413);
    const inputs: BuildingInput[] = [];
    const seen = new Map<string, number>();
    for (const [index, value] of values.entries()) {
      const input = validateBuildingInput(stripStoredBuildingFields(value));
      if (!input.ok) return error(`buildings[${index}]: ${input.message}`, 422);
      if (input.value.images.length)
        return error(`buildings[${index}]: add images after the building ID is assigned`, 422);
      for (const locale of ['zh-CN', 'en'] as const) {
        const key = JSON.stringify([
          input.value.coordinates.world, input.value.buildDate, input.value.builders[0].uuid,
          locale, input.value.name[locale],
        ]);
        const previous = seen.get(key);
        if (previous !== undefined) return error(`duplicate import item: import item ${previous + 1}`, 422);
        seen.set(key, index);
      }
      inputs.push(input.value);
    }
    for (const input of inputs) {
      const existing = this.store.duplicateBuildingId(input);
      if (existing) return error(`duplicate building: ${existing}`, 409);
    }
    const now = new Date().toISOString();
    const reserved = new Set<string>();
    const buildings = inputs.map((input) => {
      const id = this.store.allocateBuildingId(reserved);
      reserved.add(id);
      return {
        id,
        ...input,
        createdAt: now,
        updatedAt: now,
      };
    });
    this.store.insertBuildings(buildings);
    for (const building of buildings) this.audit('import', building.id, command.actor);
    return result({ imported: buildings.length, buildings }, 201);
  }

  private review(
    id: string,
    action: string | undefined,
    command: AdminBuildingCommand,
  ): BuildingResult {
    const submission = this.store.submission(id);
    if (!submission) return error('submission not found', 404);
    if (submission.status !== 'pending') return error('submission is not pending', 409);
    const conflict = this.conflict(
      command,
      submission.updatedAt,
      action
        ? 'submission has changed, refresh before reviewing'
        : 'submission has changed, refresh before saving',
    );
    if (conflict) return conflict;
    if (!object(command.body)) return error('body must be a JSON object', 400);
    const data = command.body;
    if (action === 'reject') {
      const note = reviewNote(data.reviewNote);
      if (!note) return error('reviewNote is required', 422);
      const now = new Date();
      Object.assign(submission, {
        status: 'rejected',
        reviewer: this.actor(command.actor),
        reviewNote: note,
        rejectedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
        updatedAt: now.toISOString(),
      });
      this.store.updateSubmission(submission);
      return result({ submission });
    }
    let payload = submission.payload,
      images = submission.images;
    if (!action || data.payload !== undefined || data.images !== undefined) {
      const validation = validateBuildingInput(action ? (data.payload ?? payload) : data.payload);
      if (!validation.ok) return error(validation.message, 422);
      const validatedImages = validateSubmissionImages(
        action ? (data.images ?? images) : data.images,
        validation.value.images,
      );
      if (!validatedImages.ok) return error(validatedImages.message, 422);
      const owner = adminImageOwner(command.actor);
      const extra = owner && isImageDraftKey(command.draftKey)
        ? this.store.adminDraftImages(owner, command.draftKey, submission.id)
        : [];
      const receipts = new Map([...extra, ...submission.images].map(image => [image.url, image]));
      const selected = validatedImages.value.map(image => receipts.get(image.url));
      if (!selected.every(image => image !== undefined)) return error('image does not belong to this submission', 422);
      images = selected;
      payload = { ...validation.value, images: selected.map(image => image.url) };
    }
    let building: Building | undefined;
    if (action === 'approve') {
      const existing = this.store.duplicateBuildingId(payload);
      if (existing) return error(`duplicate building: ${existing}`, 409);
      const now = new Date().toISOString();
      building = { id: submission.id, ...payload, createdAt: now, updatedAt: now };
      submission.status = 'approved';
      submission.updatedAt = now;
      this.store.insertBuilding(building);
    } else submission.updatedAt = nextUpdatedAt(submission.updatedAt);
    Object.assign(submission, {
      payload,
      images,
      reviewer: this.actor(command.actor),
      reviewNote: reviewNote(data.reviewNote),
    });
    this.store.updateSubmission(submission);
    if (building) this.audit('approve-submission', building.id, command.actor);
    return result(building ? { submission, building } : { submission });
  }

  private actor(actor: AdminActor): string {
    return actor.email ?? actor.subject ?? 'admin';
  }
  private audit(action: string, id: string, actor: AdminActor): void {
    console.log('building mutation', {
      action,
      id,
      actor: actor.email ?? actor.subject ?? 'unknown',
    });
  }
}
