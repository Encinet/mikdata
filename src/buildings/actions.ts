import type { Env } from '../env';
import type { SessionService } from '../auth/sessions';
import { memberAtCommit, membershipError } from '../auth/membership';
import { asString } from '../shared/http';
import { eligibleMemberAccount, type AccountRecord } from '../players/accounts';
import { transact } from '../db/transaction';
import { BuildingStore } from './store';
import { BuildingService, type AdminBuildingCommand, type BuildingResult } from './service';
import { isImageDraftKey, isImageFiles, type ImageFiles } from './images/keys';
import { imageStorageConfig, prepareImagePut, readBuildingImage } from './images/storage';
import { MAX_BUILDING_IMAGE_BYTES, MAX_THUMBNAIL_BYTES } from './images/limits';
import { inspectBuildingImages } from './images/validation';
import { collectBuildingImages } from './images/lifecycle';

export function adminBuildings(env: Env, command: AdminBuildingCommand) {
  return transact(env.DB, 'buildings', tx => new BuildingService(new BuildingStore(env.DB, tx)).admin(command));
}

export async function maintainBuildings(env: Env) {
  await transact(env.DB, 'buildings', async tx => new BuildingStore(env.DB, tx).cleanup());
  const images = imageStorageConfig(env);
  if (images) await collectBuildingImages(env.DB, images);
}

export type UploadAction = 'reserveImageUpload' | 'prepareImageUpload' | 'completeImageUpload';
export type MemberBuildingCommand = { sessionId: string } & (
  | { action: UploadAction; uploadId?: unknown; draftKey?: unknown; requestKey?: unknown; sizes?: unknown; hashes?: unknown }
  | { action: 'listBuildingSubmissions' }
  | { action: 'createBuildingSubmission'; payload: unknown }
);

export async function playerBuildingAction(env: Env, auth: SessionService, body: MemberBuildingCommand): Promise<BuildingResult> {
  const { action } = body;
  const session = await auth.readValidSession(asString(body.sessionId));
  if (!session) return { status: 401, body: { error: 'unauthenticated' } };
  const account = await auth.readAccount(session.playerUuid);
  if (!eligibleMemberAccount(account)) return { status: 403, body: { error: 'member_required' } };
  const memberWrite = async (work: (store: BuildingStore, account: AccountRecord) => Promise<BuildingResult>) => {
    try {
      return await transact(env.DB, 'buildings', async tx => {
        const current = await memberAtCommit(tx, session);
        if ('status' in current) return current;
        return work(new BuildingStore(env.DB, tx), current);
      });
    } catch (error) {
      const denied = membershipError(error);
      if (denied) return denied;
      throw error;
    }
  };
  if (action === 'listBuildingSubmissions')
    return new BuildingService(new BuildingStore(env.DB)).listSubmissions(account.playerUuid);
  if (action === 'createBuildingSubmission')
    return memberWrite((store, current) => new BuildingService(store).createSubmission(body.payload, current));
  const { draftKey, requestKey, hashes, sizes } = body;
  const uploadId = asString(body.uploadId);
  const config = imageStorageConfig(env);
  if (!config) return { status: 503, body: { error: 'image_upload_not_configured' } };
  let verified: { keys: ImageFiles<string>; previewBytes: number } | undefined;
  if (action === 'completeImageUpload') {
    const isSize = (value: unknown): value is number => typeof value === 'number' &&
      Number.isInteger(value) && value >= 1 && value <= MAX_BUILDING_IMAGE_BYTES;
    if (!isImageFiles(sizes, isSize) || sizes.webp + sizes.jxl > MAX_BUILDING_IMAGE_BYTES || sizes.thumbnailWebp > MAX_THUMBNAIL_BYTES)
      return { status: 422, body: { error: 'invalid_image' } };
    const keys = await new BuildingStore(env.DB).uploadKeys(account.playerUuid, uploadId);
    if (!keys) return { status: 409, body: { error: 'upload_expired' } };
    try {
      const [webp, jxl, thumbnailWebp] = await Promise.all([
        readBuildingImage(config, keys.webp, sizes.webp),
        readBuildingImage(config, keys.jxl, sizes.jxl),
        readBuildingImage(config, keys.thumbnailWebp, sizes.thumbnailWebp),
      ]);
      const inspected = await inspectBuildingImages({ webp, jxl, thumbnailWebp });
      if (!inspected) return { status: 422, body: { error: 'invalid_image' } };
      verified = { keys, previewBytes: inspected.jxlPreviewBytes };
    } catch (error) {
      console.warn('Building image verification failed', keys, error instanceof Error ? error.message : 'storage error');
      return { status: 502, body: { error: 'image_upload_unavailable' } };
    }
  }
  return memberWrite(async (store, account) => {
    if (action === 'prepareImageUpload') {
      const keys = isImageFiles(hashes, (value): value is string => typeof value === 'string') &&
        await store.prepareUpload(account.playerUuid, uploadId, hashes);
      if (!keys) return { status: 409, body: { error: 'upload_expired' } };
      const [webp, jxl, thumbnailWebp] = await Promise.all([
        prepareImagePut(config, keys.webp), prepareImagePut(config, keys.jxl),
        prepareImagePut(config, keys.thumbnailWebp),
      ]);
      return { status: 200, body: { put: { webp, jxl, thumbnailWebp } } };
    }
    if (verified) {
      const completed = await store.completeUpload(account.playerUuid, uploadId, verified.keys, verified.previewBytes);
      return completed
        ? { status: 200, body: completed }
        : { status: 409, body: { error: 'upload_expired' } };
    }
    if (!isImageDraftKey(draftKey) || !isImageDraftKey(requestKey))
      return { status: 422, body: { error: 'invalid_draft' } };
    const reservation = await store.reserveUpload(account.playerUuid, draftKey, requestKey);
    if ('error' in reservation)
      return { status: reservation.error === 'draft_submitted' ? 409 : 429, body: reservation };
    return { status: 200, body: reservation };
  });
}
