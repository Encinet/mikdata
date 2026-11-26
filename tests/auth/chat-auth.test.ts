import { expect, test } from 'bun:test';
import worker from '../../src/index';
import { authCall, OTHER_UUID, PLAYER_UUID, seedSession, testAuthEnv, authFixture } from '../helpers/auth';

const CONNECTION = 'A'.repeat(32);
const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
const CLIENT_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');

function chatStore(onControl: (path: string, body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response>) {
  return authFixture({ VPC_SERVICE: {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith('/api/auth/accounts/')) return Response.json({ player: {
        uuid: url.pathname.split('/').at(-1), role: 'member', banned: false, credentialsChangedAt: 0,
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

test('chat renewal records activity only when the plugin confirms it', async () => {
  let lastActivityAt = 0;
  const { store, values } = chatStore(() => Response.json({ ok: true, lastActivityAt }));
  const { token, record } = await seedSession(values);
  record.lastSeenAt = new Date(Date.now() - 11 * 60_000).toISOString();
  values.set(`session:${record.sidHash}`, record);
  const renewal = {
    action: 'authorizeWebChat',
    sessionId: token,
    connectionId: CONNECTION,
    clientPublicKey: CLIENT_PUBLIC_KEY,
  };
  for (let i = 0; i < 3; i++) {
    expect((await authCall(store, { ...renewal, lastActivityAt: Date.now() })).status).toBe(200);
  }
  expect(values.get(`session:${record.sidHash}`)).toEqual(record);

  lastActivityAt = Date.parse(record.lastSeenAt) + 1000;
  expect((await authCall(store, renewal)).status).toBe(200);
  expect(values.get(`session:${record.sidHash}`)).toEqual(record);
  lastActivityAt = Date.now() - 15_000;
  expect((await authCall(store, renewal)).status).toBe(200);
  const touched = values.get(`session:${record.sidHash}`) as typeof record;
  expect(Date.parse(touched.lastSeenAt)).toBe(lastActivityAt);
});

test('logout deletes authority before notifying every connection of that exact session', async () => {
  let expectedRef = '';
  const notifications: unknown[] = [];
  const { store, values } = chatStore((path, body, init) => {
    expect(path).toBe('/api/chat/revoke');
    expect(init?.redirect).toBe('manual');
    expect(values.has(`session:${expectedRef}`)).toBe(false);
    expect(values.sessions(PLAYER_UUID)).not.toContain(expectedRef);
    notifications.push(body.sessionRefs); return Response.json({ ok: true });
  });
  const own = await seedSession(values);
  expectedRef = own.record.sidHash;
  const other = await seedSession(values, 0, OTHER_UUID);
  expect((await authCall(store, { action: 'logout', sessionId: own.token })).status).toBe(200);
  expect(notifications).toEqual([[expectedRef]]);
  expect(values.has(`session:${other.record.sidHash}`)).toBe(true);
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
  }), testAuthEnv({ DB: { prepare: () => { calls++; throw new Error('must not reach store'); } } as unknown as D1Database }), {} as ExecutionContext);
  expect(response.status).toBe(403);
  expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  expect(calls).toBe(0);
});

test('CDN admission issues only mikd a session-scoped check proof, and logout ends renewal', async () => {
  let grant: Record<string, unknown> = {};
  const { store, values, hooks } = chatStore((_path, body) => { grant = body; return Response.json({ok:true}); });
  const { token } = await seedSession(values);
  const call = (path: string, body: unknown, headers: Record<string,string> = {}) => worker.fetch(
    new Request('https://data.mcmik.top/chat/' + path, {method:'POST', headers:{'content-type':'application/json', ...headers}, body:JSON.stringify(body)}),
    store.env, {waitUntil() {}} as unknown as ExecutionContext);
  const binding = {connectionId: CONNECTION, clientPublicKey: CLIENT_PUBLIC_KEY};
  const cookie = '__Host-mik_sid=' + token;
  expect((await call('connect',binding,{cookie,origin:'https://outside.invalid'})).status).toBe(403);
  expect((await call('connect',binding,{origin:'https://mcmik.top','X-Mik-Session':token})).status).toBe(401);
  const identity = await worker.fetch(new Request('https://data.mcmik.top/chat/session', {
    headers: {cookie, 'sec-fetch-site':'same-origin'},
  }), store.env, store.ctx);
  const me = await identity.json() as { account: { playerUuid: string; chatScope: string } };
  expect(me).toMatchObject({ authenticated:true, account:{ playerUuid:PLAYER_UUID } });
  expect(me.account.chatScope).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(me.account.chatScope).not.toBe(token);
  const replacement = await seedSession(values);
  const stale = await call('connect', { ...binding, chatScope: me.account.chatScope }, {
    cookie: '__Host-mik_sid=' + replacement.token, origin: 'https://mcmik.top',
  });
  expect(stale.status).toBe(403);
  expect(await stale.json()).toEqual({ error: 'session_changed' });
  expect(grant).toEqual({});
  const accepted = await call('connect', { ...binding, chatScope: me.account.chatScope }, {cookie,origin:'https://mcmik.top'});
  expect(await accepted.json()).toEqual({ok:true});
  const proof = { sessionRef:grant.sessionRef, renewalToken:grant.renewalToken };
  expect((await call('check',{...proof,renewalToken:'x'.repeat(43)})).status).toBe(403);
  const lease = await call('check',proof);
  expect(lease.status).toBe(200);
  expect(await lease.json()).toMatchObject({playerUuid:PLAYER_UUID,authenticatedAt:grant.authenticatedAt});
  await authCall(store, {action:'logout', sessionId:token});
  expect((await call('check',proof)).status).toBe(401);
  const other = await seedSession(values, 0, OTHER_UUID);
  expect((await call('connect', binding, {cookie: '__Host-mik_sid=' + other.token, origin: 'https://mcmik.top'})).status).toBe(200);
  const valid = { sessionRef: grant.sessionRef, renewalToken: grant.renewalToken };
  const invalid = { sessionRef: 'x'.repeat(43), renewalToken: valid.renewalToken };
  const reads: string[] = [];
  hooks.before = sql => { reads.push(sql); };
  const batch = await call('check', { checks: [valid, invalid, proof] });
  hooks.before = undefined;
  expect(reads).toHaveLength(1);
  expect(reads[0]).toContain('JOIN players');
  expect(reads[0]).not.toContain('auth_passkeys');
  expect(await batch.json()).toEqual({ results: [
    { sessionRef: valid.sessionRef, status: 200, lease: expect.objectContaining({ playerUuid: OTHER_UUID }) },
    { sessionRef: invalid.sessionRef, status: 403 },
    { sessionRef: proof.sessionRef, status: 401 },
  ] });
  const malformed = await call('check', {checks: [valid, {...invalid, renewalToken: 'malformed'}]});
  expect(await malformed.json()).toMatchObject({results: [{status: 200}, {status: 403}]});
  for (const checks of [[], [valid, valid], Array(17).fill(valid)])
    expect((await call('check', { checks })).status).toBe(422);
});
