import { AwsClient } from 'aws4fetch';
import { buildingImageBaseUrl, imageKeyHash, isImageKey } from './keys';
import type { Env } from '../../env';

type ImageStorageEnv = Pick<
  Env,
  | 'BUILDING_IMAGE_S3_BUCKET_URL'
  | 'BUILDING_IMAGE_S3_REGION'
  | 'BUILDING_IMAGE_PUBLIC_BASE_URL'
  | 'BUILDING_IMAGE_ACCESS_KEY_ID'
  | 'BUILDING_IMAGE_SECRET_ACCESS_KEY'
>;

export function imagePublicBaseUrl(env: ImageStorageEnv) {
  return buildingImageBaseUrl(
    env.BUILDING_IMAGE_PUBLIC_BASE_URL || env.BUILDING_IMAGE_S3_BUCKET_URL,
  );
}

export function imageStorageConfig(env: ImageStorageEnv) {
  const bucketUrl = buildingImageBaseUrl(env.BUILDING_IMAGE_S3_BUCKET_URL);
  const publicBaseUrl = imagePublicBaseUrl(env);
  const region = env.BUILDING_IMAGE_S3_REGION?.trim();
  const accessKeyId = env.BUILDING_IMAGE_ACCESS_KEY_ID;
  const secretAccessKey = env.BUILDING_IMAGE_SECRET_ACCESS_KEY;
  if (!bucketUrl || !publicBaseUrl || !region || !accessKeyId || !secretAccessKey) return null;
  return { publicBaseUrl, bucketUrl, region, accessKeyId, secretAccessKey };
}

export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', data));
}

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type ImageStorage = NonNullable<ReturnType<typeof imageStorageConfig>>;

function signed(config: ImageStorage, key: string, method: string, headers?: HeadersInit) {
  if (!isImageKey(key)) throw new Error('Invalid building image key');
  return new AwsClient({ ...config, service: 's3', retries: 0 }).sign(
    `${config.bucketUrl}/${key}`,
    { method, headers, aws: { allHeaders: true } },
  );
}

export async function prepareImagePut(config: ImageStorage, key: string) {
  const request = await signed(config, key, 'PUT', {
    'Content-Type': 'image/webp',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'x-amz-content-sha256': imageKeyHash(key),
  });
  return { url: request.url, headers: Object.fromEntries(request.headers) };
}

export async function deleteBuildingImage(config: ImageStorage, key: string) {
  const response = await fetch(await signed(config, key, 'DELETE'), {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404)
    throw new Error(`S3 DELETE failed (${response.status})`);
}

export async function verifyOriginal(
  response: Response,
  hash: string,
  size: number,
): Promise<void> {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'image/webp') {
    await response.body?.cancel();
    throw new Error(`S3 original unavailable (${response.status})`);
  }
  const original = await readLimitedImageBody(response, size);
  if (original.length !== size || (await sha256(original)) !== hash)
    throw new Error('S3 original checksum mismatch');
}

/** Bound memory while reading a response, including when Content-Length is missing or wrong. */
export async function readLimitedImageBody(
  response: Request | Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Response exceeds size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Response exceeds size limit');
      chunks.push(value);
    }
  } finally {
    // A broken stream may reject cancellation too; preserve the original read/size error.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
