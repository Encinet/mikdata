import type { AdminActor } from '../../auth/access';
import { MAX_JXL_PREVIEW_BYTES } from './limits';
import { BUILDING_ID_PATTERN } from '../id';
import type { BuildingImage } from '../types';

export type ImageFormat = 'webp' | 'jxl';
export type ImageFiles<T> = Record<ImageFormat | 'thumbnailWebp', T>;
export const IMAGE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_FILENAME = '[0-9a-f]{64}\\.(webp|jxl)';
const IMAGE_KEY_PATTERN = new RegExp(`^buildings/${BUILDING_ID_PATTERN}/${IMAGE_FILENAME}$`);

export function isImageFiles<T>(value: unknown, valid: (entry: unknown) => entry is T): value is ImageFiles<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const files = value as Record<string, unknown>;
  return Object.keys(files).length === 3 && valid(files.webp) && valid(files.jxl) && valid(files.thumbnailWebp);
}

export function isBuildingImage(value: unknown): value is BuildingImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { jxlPreviewBytes, ...files } = value as Record<string, unknown>;
  return isImageFiles(files, (v): v is string => typeof v === 'string' && IMAGE_HASH_PATTERN.test(v)) &&
    typeof jxlPreviewBytes === 'number' && Number.isInteger(jxlPreviewBytes) &&
    jxlPreviewBytes >= 0 && jxlPreviewBytes <= MAX_JXL_PREVIEW_BYTES;
}

export function sameBuildingImage(a: BuildingImage, b: BuildingImage): boolean {
  return a.webp === b.webp && a.jxl === b.jxl && a.thumbnailWebp === b.thumbnailWebp &&
    a.jxlPreviewBytes === b.jxlPreviewBytes;
}

export function adminImageOwner(actor: AdminActor): string | undefined {
  const identity = actor.subject || actor.email;
  return identity ? `admin/${encodeURIComponent(identity)}` : undefined;
}

export function isImageDraftKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}

export function buildingImageBaseUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const base = value.trim();
  if (!base.startsWith('https://') || /[?#\\\s]/.test(base) || !URL.canParse(base))
    return undefined;
  const url = new URL(base);
  if (url.username || url.password) return undefined;
  return url.href.replace(/\/+$/, '');
}

export function buildingImageKey(id: string, hash: string, format: ImageFormat): string {
  const key = `buildings/${id}/${hash}.${format}`;
  if (!isImageKey(key)) throw new Error('Invalid building image key');
  return key;
}

export function imageKeyHash(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1, key.lastIndexOf('.'));
}

export function imageKeyFormat(key: string): ImageFormat {
  const match = key.match(IMAGE_KEY_PATTERN);
  if (!match) throw new Error('Invalid stored image key');
  return match[1] as ImageFormat;
}

export function isImageKey(value: string): boolean {
  return IMAGE_KEY_PATTERN.test(value);
}

export function publicImageUrl(key: string, origin?: string): string {
  if (!isImageKey(key)) throw new Error('Invalid stored image key');
  if (!origin) throw new Error('Missing building image public base URL');
  return origin + '/' + key;
}
