import type { AdminActor } from '../auth/access';
import { canonicalContent, contentPrecondition, contentTag } from '../shared/content-precondition';
import { summarizeSubmission, type BuildingStore } from './store';
import { adminImageOwner, isImageDraftKey } from './images/keys';
import type { Building, BuildingInput, BuildingSubmission } from './types';
import { findUnknownField, MAX_BUILDERS, validateBuildingInput, validateSubmissionPayload } from './validation';

export interface BuildingResult {
  status: number;
  body: unknown;
}
export interface BuildingAccount {
  playerUuid: string;
  currentName: string;
}
interface AdminCommandContext {
  body: unknown;
  ifMatch?: string;
  draftKey?: string;
  status?: string;
  actor: AdminActor;
}
export type AdminBuildingCommand = AdminCommandContext &
  (
    | { operation: 'listBuildings' | 'createBuilding' | 'importBuildings' | 'listSubmissions' }
    | { operation: 'replaceBuilding' | 'deleteBuilding'; id: string }
    | {
        operation: 'editSubmission' | 'approveSubmission' | 'rejectSubmission';
        id: string;
      }
  );
type BuildingChange = Extract<AdminBuildingCommand, { operation: 'replaceBuilding' | 'deleteBuilding' }>;
type RunMutation = (mutation: () => BuildingResult) => Promise<BuildingResult>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMISSION_FIELDS = new Set(['draftKey', 'payload']);
const IMPORT_FIELDS = new Set(['buildings']);
const PAYLOAD_FIELDS = new Set(['payload']);
const REJECTION_FIELDS = new Set(['reviewNote']);
const result = (body: unknown, status = 200): BuildingResult => ({ status, body });
const error = (message: string, status: number): BuildingResult =>
  result({ error: message }, status);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function reviewNote(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, 500) || undefined : undefined;
}

function submissionResult(submission: BuildingSubmission, httpStatus = 200): BuildingResult {
  const { id, status, submitterUuid: playerUuid, payload, reviewNote, expiresAt } = submission;
  return result({
    playerUuid,
    submission: summarizeSubmission({ id, name: payload.name, status, reviewNote, expiresAt }),
  }, httpStatus);
}

/** The owning Durable Object provides the transaction and authorization boundary. */
export class BuildingService {
  constructor(private readonly store: BuildingStore) {}

  async admin(command: AdminBuildingCommand, mutate: RunMutation): Promise<BuildingResult> {
    switch (command.operation) {
      case 'listBuildings':
        return result(this.store.buildings());
      case 'createBuilding':
        return mutate(() => this.create(command));
      case 'importBuildings':
        return mutate(() => this.import(command));
      case 'replaceBuilding':
      case 'deleteBuilding':
        return this.changeBuilding(command, mutate);
      case 'listSubmissions': {
        const status = command.status;
        if (status !== undefined && status !== 'pending' && status !== 'approved' && status !== 'rejected')
          return error('invalid_status', 400);
        return result({ submissions: this.store.submissions(status) });
      }
      case 'editSubmission':
      case 'approveSubmission':
      case 'rejectSubmission': {
        const action = command.operation === 'approveSubmission' ? 'approve'
          : command.operation === 'rejectSubmission' ? 'reject' : 'edit';
        return this.changeRecord(mutate, {
          ifMatch: command.ifMatch,
          name: 'submission',
          read: () => this.store.submission(command.id),
          write: (submission, content) => this.review(submission, content, action, command),
        });
      }
      default:
        return error('not found', 404);
    }
  }

  createSubmission(data: unknown, account: BuildingAccount): BuildingResult {
    const owner = account.playerUuid.toLowerCase();
    const name = account.currentName.trim();
    if (!UUID_RE.test(owner) || !name)
      return error('unauthenticated', 401);
    if (!object(data)) return error('body must be a JSON object', 400);
    const unknownField = findUnknownField(data, SUBMISSION_FIELDS);
    if (unknownField !== undefined) return error(`unknown field: ${unknownField}`, 422);
    const validation = validateSubmissionPayload(data.payload);
    if (!validation.ok) return error(validation.message, 422);
    const payload = validation.value;
    if (!payload.builders.some((builder) => builder.uuid === owner)) {
      if (payload.builders.length === MAX_BUILDERS)
        return error(`builders exceeds max count ${MAX_BUILDERS}`, 422);
      payload.builders.unshift({ uuid: owner, name, weight: 100 });
    }
    const draftKey = data.draftKey;
    if (!isImageDraftKey(draftKey)) return error('invalid_draft', 422);
    const buildingId = this.store.draftBuilding(owner, draftKey);
    if (!buildingId) return error('invalid_draft', 422);
    const prior = this.store.submission(buildingId);
    if (prior) {
      const repeated = prior.submitterUuid === owner && canonicalContent(prior.payload) === canonicalContent(payload);
      return repeated ? submissionResult(prior) : error('draft_submitted', 409);
    }
    if (this.store.pendingCount(owner) >= 10)
      return result({ error: 'pending_limit_reached', limit: 10 }, 429);
    const uploaded = this.store.draftImageFilenames(owner, draftKey, buildingId);
    if (!payload.images.every(filename => uploaded.has(filename)))
      return error('images must be uploaded by the current account within 24 hours', 422);
    const now = new Date().toISOString();
    const submission: BuildingSubmission = {
      id: buildingId,
      status: 'pending',
      submitterUuid: owner,
      submitterName: name,
      payload,
      createdAt: now,
    };
    this.store.insertSubmission(submission, draftKey);
    return submissionResult(submission, 201);
  }

  listSubmissions(playerUuid: string): BuildingResult {
    const owner = playerUuid.toLowerCase();
    return result({ playerUuid: owner, submissions: this.store.submissionHistory(owner) });
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
      const uploaded = this.store.draftImageFilenames(owner, draft, reserved);
      if (!input.value.images.every(filename => uploaded.has(filename))) return error('image_unavailable', 422);
    }
    const existing = this.store.duplicateBuildingId(input.value);
    if (existing) return error(`duplicate building: ${existing}`, 409);
    const building = { id: reserved ?? this.store.allocateBuildingId(), ...input.value };
    this.store.insertBuilding(building);
    this.audit('create', building.id, command.actor);
    return result(building, 201);
  }

  private changeBuilding(command: BuildingChange, mutate: RunMutation): Promise<BuildingResult> {
    const { id } = command;
    return this.changeRecord(mutate, {
      ifMatch: command.ifMatch,
      name: 'building',
      read: () => this.store.building(id),
      write: (building, content) => {
        if (command.operation !== 'deleteBuilding') return this.update(building, content, command);
        this.store.deleteBuilding(id);
        this.audit('delete', id, command.actor);
        return result({ deleted: id });
      },
    });
  }

  private async changeRecord<T>(
    mutate: RunMutation,
    { ifMatch, name, read, write }: {
      ifMatch?: string;
      name: string;
      read: () => T | null;
      write: (record: T, content: string) => BuildingResult;
    },
  ): Promise<BuildingResult> {
    const expected = contentPrecondition(ifMatch);
    if ('status' in expected) return expected;
    const record = read();
    if (record === null) return error(`${name} not found`, 404);
    const content = canonicalContent(record);
    const conflict = error(`${name} has changed, refresh before retrying`, 412);
    if (expected.tag !== await contentTag(content)) return conflict;
    return mutate(() => {
      // Recheck inside the write transaction after the asynchronous digest.
      const current = read();
      if (current === null) return error(`${name} not found`, 404);
      if (canonicalContent(current) !== content) return conflict;
      return write(current, content);
    });
  }

  private update(previous: Building, previousContent: string, command: BuildingChange): BuildingResult {
    const { id } = previous;
    const input = validateBuildingInput(command.body);
    if (!input.ok) return error(input.message, 422);
    const building = { id, ...input.value };
    if (canonicalContent(building) === previousContent) return result(previous);
    if (!this.adminImagesAvailable(command, id, building.images, previous.images))
      return error('image_unavailable', 422);
    const existing = this.store.duplicateBuildingId(building, id);
    if (existing) return error(`duplicate building: ${existing}`, 409);
    this.store.updateBuilding(building);
    this.audit('replace', id, command.actor);
    return result(building);
  }

  private import(command: AdminBuildingCommand): BuildingResult {
    if (!object(command.body)) return error('buildings must be an array', 400);
    const unknownField = findUnknownField(command.body, IMPORT_FIELDS);
    if (unknownField !== undefined) return error(`unknown field: ${unknownField}`, 422);
    const values = command.body.buildings;
    if (!Array.isArray(values)) return error('buildings must be an array', 400);
    if (!values.length) return error('import body must not be empty', 400);
    if (values.length > 100) return error('import exceeds max count 100', 413);
    const inputs: BuildingInput[] = [];
    const seen = new Map<string, number>();
    for (const [index, value] of values.entries()) {
      const input = validateBuildingInput(value);
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
    const reserved = new Set<string>();
    const buildings = inputs.map((input) => {
      const id = this.store.allocateBuildingId(reserved);
      reserved.add(id);
      return { id, ...input };
    });
    this.store.insertBuildings(buildings);
    for (const building of buildings) this.audit('import', building.id, command.actor);
    return result({ buildings }, 201);
  }

  private review(
    submission: BuildingSubmission,
    previousContent: string,
    action: 'edit' | 'approve' | 'reject',
    command: AdminBuildingCommand,
  ): BuildingResult {
    if (submission.status !== 'pending') return error('submission is not pending', 409);
    if (!object(command.body)) return error('body must be a JSON object', 400);
    const data = command.body;
    const unknownField = findUnknownField(data, action === 'reject' ? REJECTION_FIELDS : PAYLOAD_FIELDS);
    if (unknownField !== undefined) return error(`unknown field: ${unknownField}`, 422);
    if (action === 'reject') {
      const note = reviewNote(data.reviewNote);
      if (!note) return error('reviewNote is required', 422);
      Object.assign(submission, {
        status: 'rejected',
        reviewer: this.actor(command.actor),
        reviewNote: note,
      });
      this.store.updateSubmission(submission);
      return result({ id: submission.id });
    }
    const input = action === 'approve' && data.payload === undefined ? submission.payload : data.payload;
    const validation = validateSubmissionPayload(input);
    if (!validation.ok) return error(validation.message, 422);
    const payload = validation.value;
    if (!this.adminImagesAvailable(command, submission.id, payload.images, submission.payload.images))
      return error('image_unavailable', 422);
    let building: Building | undefined;
    if (action === 'approve') {
      const existing = this.store.duplicateBuildingId(payload);
      if (existing) return error(`duplicate building: ${existing}`, 409);
      building = { id: submission.id, ...payload };
      submission.status = 'approved';
      this.store.insertBuilding(building);
    }
    Object.assign(submission, {
      payload,
      reviewer: this.actor(command.actor),
    });
    if (canonicalContent(submission) !== previousContent) this.store.updateSubmission(submission);
    if (building) this.audit('approve-submission', building.id, command.actor);
    return result(building ? { building } : { submission });
  }

  private adminImagesAvailable(command: AdminBuildingCommand, id: string, images: string[], previous: string[]): boolean {
    const additions = images.filter(filename => !previous.includes(filename));
    if (!additions.length) return true;
    const owner = adminImageOwner(command.actor);
    const draft = command.draftKey;
    if (!owner || !isImageDraftKey(draft)) return false;
    const uploaded = this.store.draftImageFilenames(owner, draft, id);
    return additions.every(filename => uploaded.has(filename));
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
