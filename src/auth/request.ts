export const MAX_AUTH_BODY_BYTES = 64 * 1024;

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
