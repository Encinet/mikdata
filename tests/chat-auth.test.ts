import { expect, test } from 'bun:test';
import worker from '../src/index';
import { authCall, OTHER_UUID, PLAYER_UUID, seedSession, testAuthEnv, testAuthStore } from './helpers/auth-store';

const CONNECTION = 'A'.repeat(32);
const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
const CLIENT_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');

function chatStore(onControl: (path: string, body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response>) {
  return testAuthStore({ VPC_SERVICE: {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith('/api/auth/accounts/')) return Response.json({ player: {
        uuid: url.pathname.split('/').at(-1), role: 'member', credentialsChangedAt: 0,
      } });
      return onControl(url.pathname, JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>, init);
    },
  } as Fetcher });
}

test('chat authorization binds the cookie session owner and does not expose the grant to the browser', async () => {
  let grant: Record<string, unknown> = {};
  const { store, values } = chatStore((path, body, init) => {
    expect(path).toBe('/api/chat/authorize'); grant = body;
    expect(init?.redirect).toBe('manual');
    return Response.json({ ok: true, lastActivityAt: 0 });
  });
  const { token, record } = await seedSession(values);
  record.idleExpiresAt = new Date(Date.now() + 12_000).toISOString();
  values.set(`session:${record.sidHash}`, record);
  const result = await authCall(store, { action: 'authorizeWebChat', sessionId: token, connectionId: CONNECTION, clientPublicKey: CLIENT_PUBLIC_KEY,
    playerUuid: OTHER_UUID, sessionRef: 'attacker', role: 'custodian' });
  expect(result).toEqual({ status: 200, body: { ok: true } });
  expect(grant.playerUuid).toBe(PLAYER_UUID);
  expect(grant.sessionRef).toBe(record.sidHash);
  expect(grant.sessionRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(grant).not.toHaveProperty('sessionId');
  expect(grant.connectionId).toBe(CONNECTION);
  expect(grant.clientPublicKey).toBe(CLIENT_PUBLIC_KEY);
  expect(Number(grant.expiresAt)).toBeLessThanOrEqual(Date.parse(record.idleExpiresAt));
  expect(Number(grant.expiresAt) - Number(grant.checkedAt)).toBeLessThanOrEqual(60_000);
});

test('chat authorization rejects anonymous sessions and invalid connection locators before plugin work', async () => {
  let calls = 0;
  const { store } = chatStore(() => { calls++; return Response.json({ ok: true }); });
  expect((await authCall(store, { action: 'authorizeWebChat', connectionId: CONNECTION, clientPublicKey: CLIENT_PUBLIC_KEY })).status).toBe(401);
  expect((await authCall(store, { action: 'authorizeWebChat', connectionId: { id: CONNECTION } })).status).toBe(422);
  expect(calls).toBe(0);
});

test('timer-only chat renewal does not write or extend the web session', async () => {
  const { store, values } = chatStore(() => Response.json({ ok: true, lastActivityAt: 0 }));
  const { token, record } = await seedSession(values);
  record.lastSeenAt = new Date(Date.now() - 11 * 60_000).toISOString();
  values.set(`session:${record.sidHash}`, record);
  for (let i = 0; i < 3; i++) expect((await authCall(store, {
    action: 'authorizeWebChat', sessionId: token, connectionId: CONNECTION, clientPublicKey: CLIENT_PUBLIC_KEY, lastActivityAt: Date.now(),
  })).status).toBe(200);
  expect(values.get(`session:${record.sidHash}`)).toEqual(record);
});

test('only plugin-attested message activity can coalesce an idle-session touch', async () => {
  const { store, values } = chatStore(() => Response.json({ ok: true, lastActivityAt: Date.now() }));
  const { token, record } = await seedSession(values);
  record.lastSeenAt = new Date(Date.now() - 11 * 60_000).toISOString();
  values.set(`session:${record.sidHash}`, record);
  expect((await authCall(store, { action: 'authorizeWebChat', sessionId: token, connectionId: CONNECTION, clientPublicKey: CLIENT_PUBLIC_KEY })).status).toBe(200);
  const touched = values.get(`session:${record.sidHash}`) as typeof record;
  expect(Date.parse(touched.lastSeenAt)).toBeGreaterThan(Date.parse(record.lastSeenAt));
});

test('logout deletes authority before notifying every connection of that exact session', async () => {
  let expectedRef = '';
  const notifications: unknown[] = [];
  const { store, values } = chatStore((path, body, init) => {
    expect(path).toBe('/api/chat/revoke');
    expect(init?.redirect).toBe('manual');
    expect(values.has(`session:${expectedRef}`)).toBe(false);
    notifications.push(body.sessionRefs); return Response.json({ ok: true });
  });
  const own = await seedSession(values);
  expectedRef = own.record.sidHash;
  const other = await seedSession(values, 0, OTHER_UUID);
  expect((await authCall(store, { action: 'logout', sessionId: own.token })).status).toBe(200);
  expect(notifications).toEqual([[expectedRef]]);
  expect(values.has(`session:${other.record.sidHash}`)).toBe(true);
});

test('signing out all sessions notifies all own session references and preserves other accounts', async () => {
  let notified: string[] = [];
  const { store, values } = chatStore((_path, body) => { notified = body.sessionRefs as string[]; return Response.json({ ok: true }); });
  const first = await seedSession(values), second = await seedSession(values), foreign = await seedSession(values, 0, OTHER_UUID);
  expect((await authCall(store, { action: 'revokeAccountSession', sessionId: first.token, all: true })).status).toBe(200);
  expect(new Set(notified)).toEqual(new Set([first.record.sidHash, second.record.sidHash]));
  expect(values.has(`session:${foreign.record.sidHash}`)).toBe(true);
});

test.each([503, 307])('plugin failure or redirect (%i) never reports chat authorization success', async (status) => {
  const { store, values } = chatStore(() => new Response(null, { status, headers: { Location: 'https://untrusted.invalid' } }));
  const { token } = await seedSession(values);
  expect((await authCall(store, { action: 'authorizeWebChat', sessionId: token, connectionId: CONNECTION, clientPublicKey: CLIENT_PUBLIC_KEY })).status).toBe(503);
});

test('chat authorization is limited per account across browser sessions and client addresses', async () => {
  let calls = 0;
  const { store, values } = chatStore(() => { calls++; return Response.json({ ok: true, lastActivityAt: 0 }); });
  const first = await seedSession(values), second = await seedSession(values);
  for (let i = 0; i < 20; i++) expect((await authCall(store, {
    action: 'authorizeWebChat', sessionId: i % 2 ? first.token : second.token,
    connectionId: CONNECTION, clientPublicKey: CLIENT_PUBLIC_KEY, clientKey: `different-ip-${i}`,
  })).status).toBe(200);
  expect((await authCall(store, { action: 'authorizeWebChat', sessionId: first.token, connectionId: CONNECTION, clientPublicKey: CLIENT_PUBLIC_KEY })).status).toBe(429);
  expect(calls).toBe(20);
});

test('third-party callers cannot use the private chat authorization endpoint', async () => {
  let calls = 0;
  const response = await worker.fetch(new Request('https://data.mcmik.top/me/chat/authorize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: CONNECTION, clientPublicKey: CLIENT_PUBLIC_KEY }),
  }), testAuthEnv({ AUTH_STORE: { idFromName: () => { calls++; throw new Error('must not reach store'); } } as unknown as DurableObjectNamespace }), {} as ExecutionContext);
  expect(response.status).toBe(403);
  expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  expect(calls).toBe(0);
});
