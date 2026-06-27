import type { Env } from './env';

export type CacheStatus = 'MISS' | 'HIT' | 'STALE';
export type DataSource = 'UPSTREAM' | 'FALLBACK' | 'LOCAL';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export function json(
  body: unknown,
  status: number,
  request: Request,
  env: Env,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  });
}

export function proxyJson(
  body: unknown,
  status: number,
  request: Request,
  env: Env,
  cacheStatus: CacheStatus,
  source: DataSource,
  extraHeaders: Record<string, string> = {},
): Response {
  return json(body, status, request, env, {
    'Cache-Control': source === 'UPSTREAM' ? 'public, max-age=0, must-revalidate' : 'no-store',
    'X-Proxy-Cache': cacheStatus,
    'X-Proxy-Source': source,
    ...extraHeaders,
  });
}

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  void request;
  void env;

  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
