import type { AdminActor } from '../../auth/access';
import type { Building, BuildingSubmission } from '../types';

const HASH = /^[0-9a-f]{64}$/;
export const IMAGE_FILENAME_PATTERN = /^[0-9a-f]{64}\.webp$/;
export type StoredBuilding = Omit<Building, 'images'> & { imageHashes: string[] };

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

export function galleryImageKeys(id: string, urls: string[], origin?: string): string[] | null {
  const prefix = `buildings/${id}/`;
  const keys: string[] = [];
  for (const url of urls) {
    const key = imageKeyFromUrl(url, origin);
    if (!key?.startsWith(prefix)) return null;
    keys.push(key);
  }
  return keys;
}

export function expandImages(document: StoredBuilding, origin?: string): Building {
  return mapImageHashes(document, hash => publicImageUrl(`buildings/${document.id}/${hash}.webp`, origin));
}

export function expandImageFilenames(document: StoredBuilding): Building {
  return mapImageHashes(document, hash => `${hash}.webp`);
}

function mapImageHashes(document: StoredBuilding, map: (hash: string) => string): Building {
  const { imageHashes, ...building } = document;
  if ('images' in building || !Array.isArray(imageHashes) ||
      !imageHashes.every(hash => typeof hash === 'string' && HASH.test(hash)))
    throw new Error('Invalid stored gallery');
  return {
    ...building,
    images: imageHashes.map(map),
  };
}

export function imageKeyHash(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1, -'.webp'.length);
}

export function isImageKey(value: string): boolean {
  return /^buildings\/[0-9a-f]{32}\/[0-9a-f]{64}\.webp$/.test(value);
}

export function imageKeyFromUrl(url: string, origin?: string): string | null {
  if (!origin || !url.startsWith(origin + '/')) return null;
  const key = url.slice(origin.length + 1);
  return isImageKey(key) ? key : null;
}

export function publicImageUrl(key: string, origin?: string): string {
  if (!isImageKey(key)) throw new Error('Invalid stored image key');
  if (!origin) throw new Error('Missing building image public base URL');
  return origin + '/' + key;
}

export function mapSubmissionUrls(
  submission: BuildingSubmission,
  map: (url: string) => string,
): BuildingSubmission {
  return {
    ...submission,
    images: submission.images.map((image) => ({ ...image, url: map(image.url) })),
    payload: { ...submission.payload, images: submission.payload.images.map(map) },
  };
}
