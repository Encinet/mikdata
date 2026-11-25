import type { Building, BuildingInput, Coord, I18n, Source } from './types';
import { isBuildingId } from './id';
import { isBuildingImage } from './images/keys';
export type ValidationResult = { ok: true; value: BuildingInput } | { ok: false; message: string };
export const BUILDING_TEXT_LIMITS = {
  name: 200,
  description: 2000,
  world: 128,
  tag: 50,
  sourceAuthor: 200,
  sourceLink: 500,
  sourceNote: 500,
} as const;
const MAX_TAGS = 20;
export const MAX_BUILDING_IMAGES = 15;
export const MAX_BUILDERS = 50;
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
const VALID_FIELDS = new Set<string>(INPUT_FIELDS);
const COORDINATE_FIELDS = new Set(['world', 'x', 'y', 'z']);
const BUILDER_FIELDS = new Set(['name', 'uuid', 'weight']);
const SOURCE_FIELDS = new Set(['originalAuthor', 'originalLink', 'notes']);

export function validateBuildingInput(data: unknown): ValidationResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, message: 'body must be a JSON object' };
  }

  const building = data as Record<string, unknown>;
  const unknownField = findUnknownField(building, VALID_FIELDS);
  if (unknownField !== undefined) {
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

    const limit = BUILDING_TEXT_LIMITS[key];

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
    coord.world.length > BUILDING_TEXT_LIMITS.world ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(coord.world) ||
    findUnknownField(coord, COORDINATE_FIELDS) !== undefined
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

    if (!builder || typeof builder !== 'object' || Array.isArray(builder)) {
      return { ok: false, message: `builders[${index}] must be an object` };
    }

    const value = builder as Record<string, unknown>;
    const field = findUnknownField(value, BUILDER_FIELDS);
    if (field !== undefined) {
      return { ok: false, message: `unknown field: builders[${index}].${field}` };
    }

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

  if (!Array.isArray(building.images)) {
    return { ok: false, message: 'images must be an array' };
  }

  if (building.images.length > MAX_BUILDING_IMAGES) {
    return { ok: false, message: `images exceeds max count ${MAX_BUILDING_IMAGES}` };
  }

  for (let index = 0; index < building.images.length; index += 1) {
    const image = building.images[index];

    if (!isBuildingImage(image)) {
      return { ok: false, message: `images[${index}] must contain WebP and JPEG XL SHA-256 digests` };
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

          if ((value[lang] as string).length > BUILDING_TEXT_LIMITS.tag) {
            return {
              ok: false,
              message: `tags[${index}].${lang} exceeds max length ${BUILDING_TEXT_LIMITS.tag}`,
            };
          }
        }
      }

      if (value['zh-CN'] === undefined && value.en === undefined) {
        return { ok: false, message: `tags[${index}] must have at least one language` };
      }
    }
  }

  if (building.source != null) {
    if (typeof building.source !== 'object' || Array.isArray(building.source)) {
      return { ok: false, message: 'source must be an object or null' };
    }

    const source = building.source as Record<string, unknown>;
    const field = findUnknownField(source, SOURCE_FIELDS);
    if (field !== undefined) {
      return { ok: false, message: `unknown field: source.${field}` };
    }

    if (source.originalAuthor !== undefined && typeof source.originalAuthor !== 'string') {
      return { ok: false, message: 'source.originalAuthor must be a string' };
    }

    if (typeof source.originalAuthor === 'string' && source.originalAuthor.length > BUILDING_TEXT_LIMITS.sourceAuthor) {
      return { ok: false, message: `source.originalAuthor exceeds max length ${BUILDING_TEXT_LIMITS.sourceAuthor}` };
    }

    if (source.originalLink !== undefined && typeof source.originalLink !== 'string') {
      return { ok: false, message: 'source.originalLink must be a string' };
    }

    if (typeof source.originalLink === 'string' && source.originalLink.length > BUILDING_TEXT_LIMITS.sourceLink) {
      return { ok: false, message: `source.originalLink exceeds max length ${BUILDING_TEXT_LIMITS.sourceLink}` };
    }

    if (source.originalLink?.trim() && !isHttpUrl(source.originalLink.trim())) {
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

          if ((notes[lang] as string).length > BUILDING_TEXT_LIMITS.sourceNote) {
            return {
              ok: false,
              message: `source.notes.${lang} exceeds max length ${BUILDING_TEXT_LIMITS.sourceNote}`,
            };
          }
        }
      }
    }
  }

  return { ok: true, value: normalizeInput(building) };
}

export function validateSubmissionPayload(data: unknown): ValidationResult {
  const payload = validateBuildingInput(data);
  if (payload.ok && !payload.value.images.length)
    return { ok: false, message: 'at least one image is required' };
  return payload;
}

function normalizeInput(building: Record<string, unknown>): BuildingInput {
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
    images: (building.images as Building['images']).map(({ webp, jxl }) => ({ webp, jxl })),
    buildDate: (building.buildDate as string).trim(),
  };

  if (building.tags !== undefined) {
    const tags = (building.tags as Record<string, unknown>[])
      .map(normalizeI18n)
      .filter((tag) => tag['zh-CN'] || tag.en);
    if (tags.length) normalized.tags = tags;
  }

  const source = normalizeSource(building.source as Source | null | undefined);
  if (source) normalized.source = source;

  return normalized;
}

function normalizeSource(source: Source | null | undefined): Source | undefined {
  if (!source) return undefined;
  const originalAuthor = source.originalAuthor?.trim();
  const originalLink = source.originalLink?.trim();
  const notes = source.notes && normalizeI18n(source.notes);
  const normalized: Source = {};
  if (originalAuthor) normalized.originalAuthor = originalAuthor;
  if (originalLink) normalized.originalLink = originalLink;
  if (notes && (notes['zh-CN'] || notes.en)) normalized.notes = notes;
  return Object.keys(normalized).length ? normalized : undefined;
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

export function findUnknownField(
  data: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
): string | undefined {
  return Object.keys(data).find((key) => !allowedFields.has(key));
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

export function parseStoredBuilding(data: unknown): Building | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { id, ...input } = data as Record<string, unknown>;
  if (!isBuildingId(id)) return null;
  const parsed = validateBuildingInput(input);
  return parsed.ok ? { id, ...parsed.value } : null;
}
