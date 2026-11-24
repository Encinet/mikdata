export function canonicalContent(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const object = entry as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
  });
}

export async function contentTag(content: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `"${hash}"`;
}

export function contentPrecondition(ifMatch?: string | null):
  | { tag: string }
  | { status: 400 | 428; body: { error: string } } {
  const tag = ifMatch?.trim();
  if (!tag) return { status: 428, body: { error: 'content fingerprint required' } };
  if (!/^"[0-9a-f]{64}"$/.test(tag))
    return { status: 400, body: { error: 'If-Match must contain a quoted SHA-256 digest' } };
  return { tag };
}
