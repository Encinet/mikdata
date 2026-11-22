export const BUILDING_ID_PATTERN = '[0-9a-f]{32}';
const ID_RE = new RegExp(`^${BUILDING_ID_PATTERN}$`, 'i');

export function isBuildingId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

export function createBuildingId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
