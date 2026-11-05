import type { Building, BuildingInput, BuildingSubmissionImage, Coord, I18n } from './types';
import { isBuildingId } from './building-id';
export type ValidationResult = { ok: true; value: BuildingInput } | { ok: false; message: string };
const MAX_NAME_LEN = 200;
const MAX_DESC_LEN = 2000;
const MAX_URL_LEN = 500;
const MAX_TAG_LEN = 50;
const MAX_TAGS = 20;
const MAX_IMAGES = 15;
const MAX_BUILDERS = 50;
const MAX_NOTE_LEN = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INPUT_FIELDS = [
  'name',
  'description',
  'coordinates',
  'builders',
  'buildType',
  'images',
  'buildDate',
  'tags',
  'source',
] as const;
export const VALID_FIELDS = new Set<string>(INPUT_FIELDS);
const STORED_FIELDS = new Set([...VALID_FIELDS, 'id', 'createdAt', 'updatedAt']);
const IMGBB_IMAGE_RE = /^https:\/\/i\.ibb\.co\/[^/]+\/[^/?#]+\.webp$/i;
export function validateBuildingInput(data: unknown): ValidationResult {
  return validateInput(data, true, false);
}

function validateInput(data: unknown, normalize: boolean, stored: boolean): ValidationResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, message: 'body must be a JSON object' };
  }

  const building = data as Record<string, unknown>;
  const unknownField = findUnknownField(building, stored ? STORED_FIELDS : VALID_FIELDS);

  if (unknownField) {
    return { ok: false, message: `unknown field: ${unknownField}` };
  }

  for (const key of ['name', 'description'] as const) {
    const value = building[key];

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, message: `${key} must be an object` };
    }

    const i18n = value as Record<string, unknown>;

    if (typeof i18n['zh-CN'] !== 'string' || !i18n['zh-CN'].trim()) {
      return { ok: false, message: `${key}['zh-CN'] is required` };
    }

    if (typeof i18n.en !== 'string' || !i18n.en.trim()) {
      return { ok: false, message: `${key}.en is required` };
    }

    const limit = key === 'name' ? MAX_NAME_LEN : MAX_DESC_LEN;

    if ((i18n['zh-CN'] as string).length > limit || (i18n.en as string).length > limit) {
      return { ok: false, message: `${key} exceeds max length ${limit}` };
    }
  }

  const coordinates = building.coordinates;

  if (!coordinates || typeof coordinates !== 'object' || Array.isArray(coordinates)) {
    return { ok: false, message: 'coordinates must be an object' };
  }

  const coord = coordinates as Record<string, unknown>;

  if (
    typeof coord.world !== 'string' ||
    !coord.world.trim() ||
    coord.world.length > 128 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(coord.world) ||
    Object.keys(coord).some((key) => !['world', 'x', 'y', 'z'].includes(key))
  ) {
    return { ok: false, message: 'coordinates must contain a valid world name and x, y, z' };
  }

  if (!Number.isFinite(coord.x) || !Number.isFinite(coord.y) || !Number.isFinite(coord.z)) {
    return { ok: false, message: 'coordinates x, y, z must be finite numbers' };
  }

  if (!Array.isArray(building.builders) || building.builders.length === 0) {
    return { ok: false, message: 'builders must be a non-empty array' };
  }

  if (building.builders.length > MAX_BUILDERS) {
    return { ok: false, message: `builders exceeds max count ${MAX_BUILDERS}` };
  }

  for (let index = 0; index < building.builders.length; index += 1) {
    const builder = building.builders[index];

    if (!builder || typeof builder !== 'object') {
      return { ok: false, message: `builders[${index}] must be an object` };
    }

    const value = builder as Record<string, unknown>;

    if (typeof value.name !== 'string' || !value.name.trim()) {
      return { ok: false, message: `builders[${index}].name is required` };
    }

    if (typeof value.uuid !== 'string' || !UUID_RE.test(value.uuid)) {
      return { ok: false, message: `builders[${index}].uuid must be a valid UUID` };
    }

    if (!Number.isFinite(value.weight) || (value.weight as number) < 0) {
      return { ok: false, message: `builders[${index}].weight must be a non-negative number` };
    }
  }

  if (!['original', 'derivative', 'replica'].includes(building.buildType as string)) {
    return { ok: false, message: 'buildType must be original | derivative | replica' };
  }

  if (!Array.isArray(building.images) || building.images.length === 0) {
    return { ok: false, message: 'images must be a non-empty array' };
  }

  if (building.images.length > MAX_IMAGES) {
    return { ok: false, message: `images exceeds max count ${MAX_IMAGES}` };
  }

  for (let index = 0; index < building.images.length; index += 1) {
    const image = building.images[index];

    if (typeof image !== 'string') {
      return { ok: false, message: `images[${index}] must be a string` };
    }

    if (image.length > MAX_URL_LEN) {
      return { ok: false, message: `images[${index}] exceeds max length ${MAX_URL_LEN}` };
    }

    if (!isAllowedImageUrl(image)) {
      return {
        ok: false,
        message: `images[${index}] must be a /path or https:// URL`,
      };
    }
  }

  if (
    typeof building.buildDate !== 'string' ||
    !DATE_RE.test(building.buildDate.trim()) ||
    !isRealDate(building.buildDate.trim())
  ) {
    return { ok: false, message: 'buildDate must be YYYY-MM-DD format' };
  }

  if (building.tags !== undefined) {
    if (!Array.isArray(building.tags)) {
      return { ok: false, message: 'tags must be an array' };
    }

    if (building.tags.length > MAX_TAGS) {
      return { ok: false, message: `tags exceeds max count ${MAX_TAGS}` };
    }

    for (let index = 0; index < building.tags.length; index += 1) {
      const tag = building.tags[index];

      if (!tag || typeof tag !== 'object' || Array.isArray(tag)) {
        return { ok: false, message: `tags[${index}] must be an I18n object` };
      }

      const value = tag as Record<string, unknown>;

      for (const lang of ['zh-CN', 'en']) {
        if (value[lang] !== undefined) {
          if (typeof value[lang] !== 'string') {
            return { ok: false, message: `tags[${index}].${lang} must be a string` };
          }

          if ((value[lang] as string).length > MAX_TAG_LEN) {
            return {
              ok: false,
              message: `tags[${index}].${lang} exceeds max length ${MAX_TAG_LEN}`,
            };
          }
        }
      }

      if (!value['zh-CN'] && !value.en) {
        return { ok: false, message: `tags[${index}] must have at least one language` };
      }
    }
  }

  if (building.source != null) {
    if (typeof building.source !== 'object' || Array.isArray(building.source)) {
      return { ok: false, message: 'source must be an object or null' };
    }

    const source = building.source as Record<string, unknown>;

    if (source.originalAuthor !== undefined && typeof source.originalAuthor !== 'string') {
      return { ok: false, message: 'source.originalAuthor must be a string' };
    }

    if (typeof source.originalAuthor === 'string' && source.originalAuthor.length > MAX_NAME_LEN) {
      return { ok: false, message: `source.originalAuthor exceeds max length ${MAX_NAME_LEN}` };
    }

    if (source.originalLink !== undefined && typeof source.originalLink !== 'string') {
      return { ok: false, message: 'source.originalLink must be a string' };
    }

    if (typeof source.originalLink === 'string' && source.originalLink.length > MAX_URL_LEN) {
      return { ok: false, message: `source.originalLink exceeds max length ${MAX_URL_LEN}` };
    }

    if (source.originalLink && !isHttpUrl(source.originalLink)) {
      return { ok: false, message: 'source.originalLink must be a valid http/https URL' };
    }

    if (source.notes != null) {
      if (typeof source.notes !== 'object' || Array.isArray(source.notes)) {
        return { ok: false, message: 'source.notes must be an object or null' };
      }

      const notes = source.notes as Record<string, unknown>;

      for (const lang of ['zh-CN', 'en']) {
        if (notes[lang] !== undefined) {
          if (typeof notes[lang] !== 'string') {
            return { ok: false, message: `source.notes.${lang} must be a string` };
          }

          if ((notes[lang] as string).length > MAX_NOTE_LEN) {
            return {
              ok: false,
              message: `source.notes.${lang} exceeds max length ${MAX_NOTE_LEN}`,
            };
          }
        }
      }
    }
  }

  return { ok: true, value: normalize ? normalizeInput(building) : (building as unknown as BuildingInput) };
}

function normalizeInput(building: Record<string, unknown>): BuildingInput {
  const source = building.source as Record<string, unknown> | null | undefined;
  const normalized: BuildingInput = {
    name: normalizeI18n(building.name as Record<string, unknown>),
    description: normalizeI18n(building.description as Record<string, unknown>),
    coordinates: normalizeCoordinates(building.coordinates as Record<string, unknown>),
    builders: (building.builders as Record<string, unknown>[]).map((builder) => ({
      name: (builder.name as string).trim(),
      uuid: (builder.uuid as string).toLowerCase(),
      weight: builder.weight as number,
    })),
    buildType: building.buildType as BuildingInput['buildType'],
    images: (building.images as string[]).map((image) => image.trim()),
    buildDate: (building.buildDate as string).trim(),
  };

  if (building.tags !== undefined) {
    normalized.tags = (building.tags as Record<string, unknown>[]).map(normalizeI18n);
  }

  if (building.source !== undefined) {
    normalized.source =
      source === null
        ? null
        : {
            originalAuthor:
              typeof source?.originalAuthor === 'string' ? source.originalAuthor.trim() : undefined,
            originalLink:
              typeof source?.originalLink === 'string' ? source.originalLink.trim() : undefined,
            notes:
              source?.notes && typeof source.notes === 'object' && !Array.isArray(source.notes)
                ? normalizeI18n(source.notes as Record<string, unknown>)
                : undefined,
          };
  }

  return normalized;
}

function normalizeI18n(value: Record<string, unknown>): I18n {
  return {
    'zh-CN': typeof value['zh-CN'] === 'string' ? value['zh-CN'].trim() : '',
    en: typeof value.en === 'string' ? value.en.trim() : '',
  };
}

function normalizeCoordinates(value: Record<string, unknown>): Coord {
  return {
    world: (value.world as string).trim(),
    x: value.x as number,
    y: value.y as number,
    z: value.z as number,
  };
}

function findUnknownField(
  data: Record<string, unknown>,
  allowedFields: Set<string>,
): string | null {
  return Object.keys(data).find((key) => !allowedFields.has(key)) ?? null;
}

function isAllowedImageUrl(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return true;
  }

  return trimmed.startsWith('https://') && isHttpUrl(trimmed);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isBuildingDocument(building: unknown): building is Building {
  if (!building || typeof building !== 'object' || Array.isArray(building)) {
    return false;
  }

  const record = building as Partial<Building>;
  return (
    isBuildingId(record.id) &&
    typeof record.createdAt === 'string' &&
    !Number.isNaN(Date.parse(record.createdAt)) &&
    typeof record.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(record.updatedAt)) &&
    validateInput(building, false, true).ok
  );
}

export function stripStoredBuildingFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const payload = { ...(value as Record<string, unknown>) };
  delete payload.id;
  delete payload.createdAt;
  delete payload.updatedAt;
  return payload;
}

export function validateSubmissionImages(
  raw: unknown,
  urls: string[],
): { ok: true; value: BuildingSubmissionImage[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'images metadata must be an array' };
  }
  if (raw.length !== urls.length) {
    return { ok: false, message: 'images metadata does not match payload images' };
  }

  const images: BuildingSubmissionImage[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `images[${index}] metadata must be an object` };
    }
    const value = item as Record<string, unknown>;
    if (
      value.url !== urls[index] ||
      typeof value.url !== 'string' ||
      !IMGBB_IMAGE_RE.test(value.url)
    ) {
      return { ok: false, message: `images[${index}].url must be an uploaded image URL` };
    }
    if (
      !Number.isFinite(value.width) ||
      !Number.isFinite(value.height) ||
      !Number.isFinite(value.size) ||
      (value.width as number) <= 0 ||
      (value.height as number) <= 0 ||
      (value.size as number) <= 0
    ) {
      return { ok: false, message: `images[${index}] dimensions and size are required` };
    }
    if (typeof value.mime !== 'string' || value.mime !== 'image/webp') {
      return { ok: false, message: `images[${index}].mime must be image/webp` };
    }
    images.push({
      url: value.url,
      width: value.width as number,
      height: value.height as number,
      size: value.size as number,
      mime: value.mime,
    });
  }
  return { ok: true, value: images };
}
