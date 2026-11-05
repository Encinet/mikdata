import type { BuildingStore } from './building-store';
import type { AdminActor, Building, BuildingInput, BuildingSubmission } from './types';
import {
  stripStoredBuildingFields,
  validateBuildingInput,
  validateSubmissionImages,
  VALID_FIELDS,
} from './building-validation';

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
const IMGBB_IMAGE_RE = /^https:\/\/i\.ibb\.co\/[^/]+\/[^/?#]+\.webp$/i;
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
function duplicate(left: BuildingInput, right: BuildingInput): boolean {
  return (
    (left.name['zh-CN'] === right.name['zh-CN'] || left.name.en === right.name.en) &&
    left.coordinates.world === right.coordinates.world &&
    left.buildDate === right.buildDate &&
    left.builders[0]?.uuid === right.builders[0]?.uuid
  );
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
    if (this.store.pendingCount(owner) >= 10)
      return result({ error: 'pending_limit_reached', limit: 10 }, 429);
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
    const ownedImages = this.store.ownedImages(owner, images.value);
    if (!ownedImages)
      return error('images must be uploaded by the current account within 24 hours', 422);
    if (!payload.images.every((url) => IMGBB_IMAGE_RE.test(url)))
      return error('images must be uploaded through the image uploader', 422);
    const now = new Date().toISOString();
    const submission: BuildingSubmission = {
      id: this.allocateId('submission'),
      status: 'pending',
      submitterUuid: owner,
      submitterName: account.currentName,
      submitterRole: account.role,
      payload: final.value,
      images: ownedImages,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveSubmission(submission);
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
    const existing = this.findDuplicate(input.value);
    if (existing) return error(`duplicate building: ${existing}`, 409);
    const now = new Date().toISOString();
    const building = {
      id: this.allocateId('building'),
      ...input.value,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveBuilding(building);
    this.audit('create', building.id, command.actor);
    return result(building, 201);
  }

  private update(id: string, command: AdminBuildingCommand): BuildingResult {
    const previous = this.store.building(id);
    if (!previous) return error('building not found', 404);
    let data = command.body;
    if (command.operation === 'patchBuilding') {
      if (!object(data)) return error('body must be a JSON object', 400);
      for (const key of Object.keys(data))
        if (!VALID_FIELDS.has(key)) return error(`unknown field: ${key}`, 422);
      const merged = stripStoredBuildingFields(previous) as Record<string, unknown>;
      for (const [key, value] of Object.entries(data)) {
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
    const conflict = this.conflict(
      command,
      previous.updatedAt,
      'building has changed, refresh before saving',
    );
    if (conflict) return conflict;
    const building = {
      id,
      ...input.value,
      createdAt: previous.createdAt,
      updatedAt: nextUpdatedAt(previous.updatedAt),
    };
    const existing = this.findDuplicate(building, id);
    if (existing) return error(`duplicate building: ${existing}`, 409);
    this.store.saveBuilding(building);
    this.audit(command.operation === 'patchBuilding' ? 'patch' : 'replace', id, command.actor);
    return result(building);
  }

  private delete(id: string, command: AdminBuildingCommand): BuildingResult {
    const previous = this.store.building(id);
    if (!previous) return error('building not found', 404);
    const conflict = this.conflict(
      command,
      previous.updatedAt,
      'building has changed, refresh before deleting',
    );
    if (conflict) return conflict;
    this.store.deleteBuilding(id);
    this.audit('delete', id, command.actor);
    return result({ deleted: id });
  }

  private import(command: AdminBuildingCommand): BuildingResult {
    const values = object(command.body) ? command.body.buildings : command.body;
    if (!Array.isArray(values)) return error('import body must be an array', 400);
    if (!values.length) return error('import body must not be empty', 400);
    if (values.length > 100) return error('import exceeds max count 100', 413);
    const inputs: BuildingInput[] = [];
    for (const [index, value] of values.entries()) {
      const input = validateBuildingInput(stripStoredBuildingFields(value));
      if (!input.ok) return error(`buildings[${index}]: ${input.message}`, 422);
      inputs.push(input.value);
    }
    for (let i = 0; i < inputs.length; i++) {
      if (inputs.slice(i + 1).some((next) => duplicate(inputs[i], next)))
        return error(`duplicate import item: import item ${i + 1}`, 422);
    }
    for (const existing of this.store.buildings()) {
      if (inputs.some((input) => duplicate(existing, input)))
        return error(`duplicate building: ${existing.id}`, 409);
    }
    const now = new Date().toISOString();
    const buildings = inputs.map((input) => ({
      id: this.allocateId('building'),
      ...input,
      createdAt: now,
      updatedAt: now,
    }));
    for (const building of buildings) this.store.saveBuilding(building);
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
      this.store.saveSubmission(submission);
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
      if (!validation.value.images.every((url) => IMGBB_IMAGE_RE.test(url)))
        return error('images must be uploaded through the image uploader', 422);
      payload = validation.value;
      images = validatedImages.value;
    }
    let building: Building | undefined;
    if (action === 'approve') {
      const existing = this.findDuplicate(payload);
      if (existing) return error(`duplicate building: ${existing}`, 409);
      const now = new Date().toISOString();
      building = { id: this.allocateId('building'), ...payload, createdAt: now, updatedAt: now };
      submission.status = 'approved';
      submission.buildingId = building.id;
      submission.updatedAt = now;
      this.store.saveBuilding(building);
    } else submission.updatedAt = nextUpdatedAt(submission.updatedAt);
    Object.assign(submission, {
      payload,
      images,
      reviewer: this.actor(command.actor),
      reviewNote: reviewNote(data.reviewNote),
    });
    this.store.saveSubmission(submission);
    if (building) this.audit('approve-submission', building.id, command.actor);
    return result(building ? { submission, building } : { submission });
  }

  private findDuplicate(input: BuildingInput, excluding?: string): string | null {
    return (
      this.store
        .buildings()
        .find((building) => building.id !== excluding && duplicate(building, input))?.id ?? null
    );
  }
  private allocateId(kind: 'building' | 'submission'): string {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
      if (!(kind === 'building' ? this.store.building(id) : this.store.submission(id))) return id;
    }
    throw new Error(`Could not allocate ${kind} id`);
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
