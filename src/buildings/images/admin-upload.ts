import { isBuildingId } from '../id';
import {
  imageStorageConfig,
  prepareImagePut,
  readLimitedImageBody,
  sha256,
  verifyOriginal,
} from './storage';
import { isImageDraftKey, publicImageUrl } from './keys';
import type { BuildingStore } from '../store';
import type { Env } from '../../env';
import { json } from '../../shared/http';

export const ADMIN_IMAGE_PATH = '/building-images';
export const ADMIN_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const ADMIN_IMAGE_MAX_DIMENSION = 1920;

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
  if (request.headers.get('Content-Type') !== 'image/webp')
    return json({ error: 'image_must_be_webp' }, 415);
  const config = imageStorageConfig(env);
  if (!config) return json({ error: 'image_upload_not_configured' }, 503);

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readLimitedImageBody(request, ADMIN_IMAGE_MAX_BYTES);
  } catch {
    return json({ error: 'image_too_large' }, 413);
  }
  const dimensions = webpDimensions(bytes);
  if (!dimensions || Math.max(dimensions.width, dimensions.height) > ADMIN_IMAGE_MAX_DIMENSION)
    return json({ error: 'invalid_image' }, 422);

  const hash = await sha256(bytes);
  const lease = await storage.transaction(async () => {
    const result = store.reserveAdminImage(owner, draft, target, hash);
    if (result) await scheduleMaintenance();
    return result;
  });
  if (!lease) return json({ error: 'image_draft_unavailable' }, 409);
  if (lease.image) return json({ image: lease.image }, 200);
  const url = publicImageUrl(lease.key, config.publicBaseUrl);
  try {
    const put = await prepareImagePut(config, lease.key);
    const written = await fetch(put.url, {
      method: 'PUT', body: bytes, headers: put.headers,
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    await written.body?.cancel();
    if (!written.ok) throw new Error(`S3 PUT failed (${written.status})`);
    const original = await fetch(url, {
      cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    await verifyOriginal(original, hash, bytes.length);
  } catch (error) {
    console.warn('Admin building image upload failed', lease.key, error);
    return json({ error: 'image_upload_unavailable' }, 502);
  }
  const image = { url, ...dimensions, size: bytes.length, mime: 'image/webp' };
  const expiresAt = await storage.transaction(async () => store.completeUpload(owner, lease.id, image));
  return expiresAt ? json({ image }, 200) : json({ error: 'image_draft_unavailable' }, 409);
}

type ImageDimensions = { width: number; height: number };

function webpDimensions(bytes: Uint8Array<ArrayBuffer>): ImageDimensions | null {
  if (bytes.length < 26) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (chunk(0) !== 'RIFF' || chunk(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length)
    return null;

  let frame: ImageDimensions | null = null;
  let canvas: ImageDimensions | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = chunk(offset);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    offset = data + length + (length % 2);
    if (offset > bytes.length || kind === 'ANIM' || kind === 'ANMF') return null;
    if (kind === 'VP8X') {
      if (length !== 10 || canvas || (bytes[data] & 2)) return null;
      const dimension = (at: number) => 1 + bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16);
      canvas = { width: dimension(data + 4), height: dimension(data + 7) };
    } else if (kind === 'VP8 ') {
      if (frame || length < 10 || (bytes[data] & 1) || bytes[data + 3] !== 0x9d ||
          bytes[data + 4] !== 1 || bytes[data + 5] !== 0x2a) return null;
      frame = { width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff };
    } else if (kind === 'VP8L') {
      if (frame || length < 5 || bytes[data] !== 0x2f || bytes[data + 4] >> 5) return null;
      const bits = view.getUint32(data + 1, true);
      frame = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if (offset !== bytes.length || !frame?.width || !frame.height ||
      (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))) return null;
  return frame;
}
