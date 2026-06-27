import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';
import { json } from './http';

interface AccessUser {
  email?: string;
  subject?: string;
}

type AccessResult =
  | { ok: true; user: AccessUser }
  | { ok: false; response: Response };

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function requireCloudflareAccess(
  request: Request,
  env: Env,
): Promise<AccessResult> {
  const issuer = normalizeIssuer(env.CLOUDFLARE_ACCESS_ISSUER);
  const audience = env.CLOUDFLARE_ACCESS_AUD?.trim();

  if (!issuer || !audience) {
    return {
      ok: false,
      response: json({ error: 'Cloudflare Access is not configured' }, 503, request, env),
    };
  }

  const token = readAccessToken(request);

  if (!token) {
    return { ok: false, response: json({ error: 'Cloudflare Access required' }, 401, request, env) };
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(issuer), {
      issuer,
      audience,
      clockTolerance: '60 seconds',
    });

    return {
      ok: true,
      user: {
        email: typeof payload.email === 'string' ? payload.email : undefined,
        subject: payload.sub,
      },
    };
  } catch (error) {
    console.warn('Cloudflare Access JWT validation failed', error);
    return { ok: false, response: json({ error: 'Cloudflare Access denied' }, 403, request, env) };
  }
}

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksByIssuer.get(issuer);

  if (cached) {
    return cached;
  }

  const jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer));
  jwksByIssuer.set(issuer, jwks);
  return jwks;
}

function normalizeIssuer(value: string | undefined): string {
  const issuer = value?.trim().replace(/\/+$/, '') ?? '';

  if (!issuer) {
    return '';
  }

  try {
    const url = new URL(issuer);

    if (url.protocol !== 'https:') {
      return '';
    }

    return url.origin;
  } catch {
    return '';
  }
}

function readAccessToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion')?.trim();

  if (header) {
    return header;
  }

  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);

  return match ? decodeURIComponent(match[1]) : null;
}
