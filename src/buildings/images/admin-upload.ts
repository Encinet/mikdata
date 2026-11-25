import { isBuildingId } from '../id';
import {
  imageStorageConfig,
  putBuildingImage,
  readBuildingImage,
  readLimitedImageBody,
  sha256,
} from './storage';
import { isImageDraftKey } from './keys';
import { MAX_BUILDING_IMAGE_BYTES, MAX_BUILDING_IMAGE_MULTIPART_BYTES, MAX_THUMBNAIL_BYTES } from './limits';
import { inspectBuildingImages } from './validation';
import type { BuildingStore } from '../store';
import type { Env } from '../../env';
import { json, requestMediaType } from '../../shared/http';

export const ADMIN_IMAGE_PATH = '/building-images';

export async function uploadAdminBuildingImage(
  request: Request,
  storage: DurableObjectStorage,
  store: BuildingStore,
  env: Env,
  scheduleMaintenance: () => Promise<void>,
): Promise<Response> {
  const owner = request.headers.get('X-Admin-Image-Owner');
  const draft = request.headers.get('X-Building-Draft');
  const target = new URL(request.url).searchParams.get('building');
  if (!owner?.startsWith('admin/') || !isImageDraftKey(draft) || (target !== null && !isBuildingId(target)))
    return json({ error: 'invalid_image_draft' }, 422);
  if (requestMediaType(request) !== 'multipart/form-data')
    return json({ error: 'multipart_required' }, 415);
  const config = imageStorageConfig(env);
  if (!config) return json({ error: 'image_upload_not_configured' }, 503);

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readLimitedImageBody(request, MAX_BUILDING_IMAGE_MULTIPART_BYTES);
  } catch {
    return json({ error: 'image_too_large' }, 413);
  }
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('Content-Type')! } }).formData();
  } catch {
    return json({ error: 'invalid_image' }, 422);
  }
  const webp = form.get('webp');
  const jxl = form.get('jxl');
  const thumbnail = form.get('thumbnailWebp');
  if (thumbnail !== null && (!(thumbnail instanceof File) || thumbnail.type !== 'image/webp' || thumbnail.size > MAX_THUMBNAIL_BYTES))
    return json({ error: 'invalid_image' }, 422);
  if (!(webp instanceof File) || !(jxl instanceof File) || [...form.keys()].length !== (thumbnail ? 3 : 2) ||
      webp.type !== 'image/webp' || (jxl.type && jxl.type !== 'image/jxl'))
    return json({ error: 'invalid_image' }, 422);
  if (webp.size + jxl.size > MAX_BUILDING_IMAGE_BYTES)
    return json({ error: 'image_too_large' }, 413);
  const images = {
    webp: new Uint8Array(await webp.arrayBuffer()),
    jxl: new Uint8Array(await jxl.arrayBuffer()),
    ...(thumbnail && { thumbnailWebp: new Uint8Array(await thumbnail.arrayBuffer()) }),
  };
  const inspected = await inspectBuildingImages(images);
  if (!inspected) return json({ error: 'invalid_image' }, 422);

  const hashes = { webp: await sha256(images.webp), jxl: await sha256(images.jxl),
    ...(images.thumbnailWebp && { thumbnailWebp: await sha256(images.thumbnailWebp) }),
  };
  const lease = await storage.transaction(async () => {
    const result = store.reserveAdminImage(owner, draft, target, hashes);
    if (result) await scheduleMaintenance();
    return result;
  });
  if (!lease) return json({ error: 'image_draft_unavailable' }, 409);
  const receipt = { buildingId: lease.buildingId, image: lease.image };
  if (lease.completed) return json(receipt, 200);
  try {
    const uploaded = await Promise.allSettled([
      putBuildingImage(config, lease.keys.webp, images.webp),
      putBuildingImage(config, lease.keys.jxl, images.jxl),
      ...(images.thumbnailWebp ? [putBuildingImage(config, lease.keys.thumbnailWebp!, images.thumbnailWebp)] : []),
    ]);
    for (const result of uploaded) {
      if (result.status === 'rejected') throw result.reason;
    }
    await Promise.all([
      readBuildingImage(config, lease.keys.webp, images.webp.length),
      readBuildingImage(config, lease.keys.jxl, images.jxl.length),
      ...(images.thumbnailWebp ? [readBuildingImage(config, lease.keys.thumbnailWebp!, images.thumbnailWebp.length)] : []),
    ]);
  } catch (error) {
    console.warn('Admin building image upload failed', lease.keys, error);
    return json({ error: 'image_upload_unavailable' }, 502);
  }
  const completed = await storage.transaction(async () => store.completeUpload(owner, lease.id, lease.keys, inspected.jxlPreviewBytes));
  return completed ? json({ buildingId: lease.buildingId, image: completed.image }, 200) : json({ error: 'image_draft_unavailable' }, 409);
}
