import { sanitizeRateLimitPart } from './policy';
import type { AuthResult } from './model';

export function rateLimitKey(action: string, clientKey: string): string {
  return `${action}:${sanitizeRateLimitPart(clientKey)}`;
}

export async function consumeRateLimit(db: D1Database, key: string, limit: number, windowSeconds: number): Promise<AuthResult | null> {
  const now = Date.now();
  // Incrementing an active counter leaves its expiry index alone. Batch both paths to keep one round trip.
  const [incremented, renewed] = await db.batch<{ count: number; reset_at: number }>([
    db.prepare(`UPDATE auth_rate_limits SET count=min(count+1,?)
      WHERE id=? AND reset_at>? RETURNING count,reset_at`).bind(limit + 1, key, now),
    db.prepare(`INSERT INTO auth_rate_limits(id,count,reset_at) VALUES(?,1,?)
      ON CONFLICT(id) DO UPDATE SET count=1,reset_at=excluded.reset_at
      WHERE auth_rate_limits.reset_at<=? RETURNING count,reset_at`).bind(key, now + windowSeconds * 1000, now),
  ]);
  const row = incremented.results[0] ?? renewed.results[0];
  if (!row) throw new Error('Rate limit update failed');
  return row.count <= limit ? null : {
    status: 429, body: { error: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) },
  };
}
