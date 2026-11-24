export type CacheStatus = 'MISS' | 'HIT' | 'STALE';
export type DataSource = 'UPSTREAM' | 'FALLBACK';

export class RequestBodyTooLargeError extends Error {}

export function requestMediaType(request: Request): string | undefined {
  return request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
}

export async function readLimitedRequestText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get('Content-Length')) > maxBytes)
    throw new RequestBodyTooLargeError('request body too large');
  if (!request.body) return '';

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError('request body too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function isSameOriginBrowserRequest(request: Request): boolean {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  return (
    (!origin || origin === new URL(request.url).origin) &&
    (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none')
  );
}

export const PUBLIC_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
} as const;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export function json(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return serializedJson(JSON.stringify(body), status, extraHeaders);
}

/** Respond with an already serialized body without parsing or encoding it again. */
export function serializedJson(
  body: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      ...JSON_HEADERS,
      ...PUBLIC_CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function authJson(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(JSON_HEADERS);
  headers.set('Cache-Control', 'no-store');

  new Headers(extraHeaders).forEach((value, key) => {
    headers.append(key, value);
  });

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export function proxyJson(
  body: unknown,
  status: number,
  cacheStatus: CacheStatus,
  source: DataSource,
  extraHeaders: Record<string, string> = {},
): Response {
  return json(body, status, {
    'Cache-Control': source === 'UPSTREAM' ? 'public, max-age=0, must-revalidate' : 'no-store',
    'X-Proxy-Cache': cacheStatus,
    'X-Proxy-Source': source,
    ...extraHeaders,
  });
}
