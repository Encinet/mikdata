import { expect, test } from 'bun:test';
import { authCall, OTHER_UUID, passkeyFixture, PLAYER_UUID, seedSession, testAuthStore } from './helpers/auth-store';

function banStore(policy = { role: 'default', banned: true }) {
  const fixture = testAuthStore({ VPC_SERVICE: {
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith('/api/auth/accounts/')) return Response.json({ player: {
        uuid: PLAYER_UUID, ...policy, credentialsChangedAt: 0,
      } });
      if (url.pathname.startsWith('/api/auth/challenges/')) return Response.json(policy.banned ? { status: 'banned' } : {
        status: 'confirmed', confirmedAt: new Date().toISOString(),
        player: { uuid: PLAYER_UUID, name: 'Player', role: policy.role },
      });
      return Response.json({ ok: true });
    },
  } as Fetcher });
  return { ...fixture, policy };
}

test('banned players cannot poll a game approval or use it after the ban starts', async () => {
  const { store, values, policy } = banStore({ role: 'default', banned: false });
  const created = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  expect((await authCall(store, { action: 'getMinecraftChallenge', ...created.body })).body.status).toBe('confirmed');
  policy.banned = true;
  const denied = await authCall(store, { action: 'completeMinecraftChallenge', ...created.body });
  expect(denied).toEqual({ status: 403, body: { error: 'account_banned' } });
  expect([...values.keys()].some((key) => key.startsWith('session:'))).toBe(false);

  const fresh = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  expect(await authCall(store, { action: 'getMinecraftChallenge', ...fresh.body }))
    .toEqual({ status: 403, body: { error: 'account_banned' } });
});

test.each(['default', 'member', 'moderator', 'custodian'])('bans block Passkey login for %s accounts', async (role) => {
  const { store, values } = banStore({ role, banned: true });
  const key = await passkeyFixture(values);
  const options = await authCall(store, { action: 'passkeyAuthenticationOptions', purpose: 'login' });
  const credential = await key.assertion(options.body.options.challenge);
  const result = await authCall(store, { action: 'passkeyAuthenticate', credential, browserNonce: options.body.browserNonce });
  expect(result).toEqual({ status: 403, body: { error: 'account_banned' } });
  expect([...values.keys()].filter((key) => key.startsWith('session:'))).toEqual([]);
});

test('ban checks revoke all sessions for the banned account and preserve other players', async () => {
  const { store, values } = banStore();
  const own = await seedSession(values), second = await seedSession(values), other = await seedSession(values, 0, OTHER_UUID);
  const me = await authCall(store, { action: 'me', sessionId: own.token });
  expect(me.body.authenticated).toBe(false);
  expect(values.has(`session:${own.record.sidHash}`)).toBe(false);
  expect(values.has(`session:${second.record.sidHash}`)).toBe(false);
  expect(values.has(`session:${other.record.sidHash}`)).toBe(true);
});

test('unbanning restores login without deleting Passkeys or permanently disabling the account', async () => {
  const { store, values, policy } = banStore();
  const key = await passkeyFixture(values);
  const attempt = async () => {
    const options = await authCall(store, { action: 'passkeyAuthenticationOptions', purpose: 'login' });
    const credential = await key.assertion(options.body.options.challenge);
    return authCall(store, { action: 'passkeyAuthenticate', credential, browserNonce: options.body.browserNonce });
  };
  expect((await attempt()).body.error).toBe('account_banned');
  expect(values.has(`passkey:${key.id}`)).toBe(true);
  policy.banned = false;
  expect((await attempt()).status).toBe(200);
  expect(values.get(`account:${PLAYER_UUID}`)).toMatchObject({ role: 'default', banned: false });
  expect(values.get(`account:${PLAYER_UUID}`)).not.toHaveProperty('disabledAt');
});

test.each([undefined, 'false', 0])('missing or malformed ban policy (%s) fails closed without deleting sessions', async (banned) => {
  const { store, values } = testAuthStore({ VPC_SERVICE: {
    fetch: async () => Response.json({ player: { uuid: PLAYER_UUID, role: 'default', credentialsChangedAt: 0, banned } }),
  } as Fetcher });
  const own = await seedSession(values);
  expect((await authCall(store, { action: 'me', sessionId: own.token })).status).toBe(503);
  expect(values.has(`session:${own.record.sidHash}`)).toBe(true);
});

test('sensitive writes refresh a warm account cache and revoke newly banned sessions', async () => {
  const { store, values, policy } = banStore({ role: 'default', banned: false });
  const own = await seedSession(values);
  expect((await authCall(store, { action: 'me', sessionId: own.token })).body.authenticated).toBe(true);
  policy.banned = true;
  expect((await authCall(store, { action: 'passkeyRegistrationOptions', sessionId: own.token })).status).toBe(403);
  expect(values.has(`session:${own.record.sidHash}`)).toBe(false);
  expect((await authCall(store, { action: 'me', sessionId: own.token })).body.authenticated).toBe(false);
});
