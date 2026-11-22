export const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 90;

export const CHALLENGE_TTL_SECONDS = 5 * 60;

export const AUTH_RATE_LIMIT_WINDOW_SECONDS = 60;

export function sanitizeRateLimitPart(value: string): string {
  return (
    value
      .trim()
      .slice(0, 128)
      .replace(/[^a-zA-Z0-9:._-]/g, '_') || 'unknown'
  );
}
