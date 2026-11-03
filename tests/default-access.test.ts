import { expect, test } from 'bun:test';
import { authCall, passkeyFixture, PLAYER_UUID, seedSession, testAuthStore } from './helpers/auth-store';

function newcomerStore() {
  const controls: string[] = [];
  const fixture = testAuthStore({ VPC_SERVICE: {
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith('/api/auth/accounts/')) return Response.json({ player: {
        uuid: PLAYER_UUID, role: 'default', credentialsChangedAt: 0, banned: false,
      } });
      controls.push(url.pathname);
      return Response.json({ ok: true, lastActivityAt: 0 });
    },
  } as Fetcher });
  return { ...fixture, controls };
}

test('default accounts keep their verified session, security settings and Passkey enrollment', async () => {
  const { store, values } = newcomerStore();
  const { token, record } = await seedSession(values);
  const me = await authCall(store, { action: 'me', sessionId: token });
  expect(me.body).toMatchObject({ authenticated: true, account: { role: 'default' } });
  expect(values.has(`session:${record.sidHash}`)).toBe(true);
  const security = await authCall(store, { action: 'accountSecurity', sessionId: token });
  expect(security.status).toBe(200);
  expect(security.body.account).toMatchObject({ role: 'default' });
  expect((await authCall(store, { action: 'passkeyRegistrationOptions', sessionId: token })).status).toBe(200);
});

test('default accounts can sign in with an existing Passkey', async () => {
  const { store, values } = newcomerStore();
  const key = await passkeyFixture(values);
  const options = await authCall(store, { action: 'passkeyAuthenticationOptions', purpose: 'login' });
  const credential = await key.assertion(options.body.options.challenge);
  const login = await authCall(store, {
    action: 'passkeyAuthenticate', credential, browserNonce: options.body.browserNonce,
  });
  expect(login.status).toBe(200);
  expect(login.body.account).toMatchObject({ role: 'default' });
});

test('default accounts can authorize encrypted web chat after a membership downgrade', async () => {
  const { store, values, controls } = newcomerStore();
  const { token, record } = await seedSession(values);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const clientPublicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  const result = await authCall(store, {
    action: 'authorizeWebChat', sessionId: token, connectionId: 'A'.repeat(32), clientPublicKey,
  });
  expect(result).toEqual({ status: 200, body: { ok: true } });
  expect(controls).toEqual(['/api/chat/authorize']);
  expect(values.has(`session:${record.sidHash}`)).toBe(true);
  expect(values.get(`account:${PLAYER_UUID}`)).toMatchObject({ role: 'default' });
});

test.each(['createBuildingSubmission', 'listBuildingSubmissions', 'reserveImageUpload', 'completeImageUpload'])(
  'default chat access does not grant the member-only %s operation', async (action) => {
    const { store, values, controls } = newcomerStore();
    const { token } = await seedSession(values);
    const result = await authCall(store, { action, sessionId: token, uploadId: 'upload', image: {} });
    expect(result).toEqual({ status: 403, body: { error: 'member_required' } });
    expect(controls).toEqual([]);
  },
);

test.each(['createBuildingSubmission', 'reserveImageUpload', 'completeImageUpload'])(
  'a captured member policy cannot permit %s after the stored role changes', async (action) => {
    const { store, values } = testAuthStore();
    const { token } = await seedSession(values);
    expect((await authCall(store, { action: 'me', sessionId: token })).body.authenticated).toBe(true);
    const account = values.get(`account:${PLAYER_UUID}`) as Record<string, unknown>;
    values.set(`account:${PLAYER_UUID}`, { ...account, role: 'default' });
    const result = await authCall(store, { action, sessionId: token, uploadId: 'upload', image: {} });
    expect(result).toEqual({ status: 403, body: { error: 'member_required' } });
  },
);
