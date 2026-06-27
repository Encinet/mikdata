import { expect, test } from 'bun:test';
import type { Env } from '../src/env';
import { matchProxyRoute, serveProxyRoute } from '../src/proxy';

test('public proxy routes survive unavailable KV', async () => {
  const env = createEnvWithUnavailableKv();
  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  for (const pathname of ['/players', '/bans', '/announcements']) {
    const route = matchProxyRoute(pathname);

    expect(route).not.toBeNull();

    const response = await serveProxyRoute(
      route!,
      new Request(`https://data.mcmik.top/api${pathname}`),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Proxy-Source')).toBe('UPSTREAM');
  }
});

function createEnvWithUnavailableKv(): Env {
  const unavailableKv = {
    get: () => {
      throw new Error('KV unavailable');
    },
    put: () => {
      throw new Error('KV unavailable');
    },
    delete: () => {
      throw new Error('KV unavailable');
    },
    list: () => {
      throw new Error('KV unavailable');
    },
  } as unknown as KVNamespace;

  return {
    BUILDINGS_KV: unavailableKv,
    BUILDINGS_WRITER: {} as DurableObjectNamespace,
    AUTH_STORE: {} as DurableObjectNamespace,
    VPC_SERVICE: {
      fetch: (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        const body = responseBodyForPath(url.pathname);

        return Promise.resolve(
          new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    } as Fetcher,
    MINECRAFT_SERVER_URL: 'https://upstream.example',
    MINECRAFT_SERVER_ADDRESS: 'mc.example',
    MINECRAFT_SERVER_PORT: '25565',
    CLOUDFLARE_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    CLOUDFLARE_ACCESS_AUD: 'aud',
  };
}

function responseBodyForPath(pathname: string): unknown {
  if (pathname === '/api/players') {
    return { online: 1, peak_online: 8, players: [] };
  }

  if (pathname === '/api/bans') {
    return [];
  }

  if (pathname === '/api/announcements') {
    return [];
  }

  return { error: 'unexpected path' };
}
