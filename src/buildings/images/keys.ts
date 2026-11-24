import type { AdminActor } from '../../auth/access';
import { BUILDING_ID_PATTERN } from '../id';

const IMAGE_FILENAME = '[0-9a-f]{64}\\.webp';
export const IMAGE_FILENAME_PATTERN = new RegExp(`^${IMAGE_FILENAME}$`);
const IMAGE_KEY_PATTERN = new RegExp(`^buildings/${BUILDING_ID_PATTERN}/${IMAGE_FILENAME}$`);

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

export function buildingImageKey(id: string, filename: string): string {
  const key = `buildings/${id}/${filename}`;
  if (!isImageKey(key)) throw new Error('Invalid building image key');
  return key;
}

export function imageKeyHash(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1, -'.webp'.length);
}

export function imageFilename(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

export function isImageKey(value: string): boolean {
  return IMAGE_KEY_PATTERN.test(value);
}

export function publicImageUrl(key: string, origin?: string): string {
  if (!isImageKey(key)) throw new Error('Invalid stored image key');
  if (!origin) throw new Error('Missing building image public base URL');
  return origin + '/' + key;
}
