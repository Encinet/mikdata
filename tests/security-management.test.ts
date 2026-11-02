import { expect, test } from 'bun:test';
import worker from '../src/index';
import {
  authCall,
  OTHER_UUID,
  passkeyFixture,
  PLAYER_UUID,
  seedSession,
  testAuthStore,
} from './helpers/auth-store';

test('names update only display metadata and invalidate warm session and Passkey caches', async () => {
  const { store, values } = testAuthStore();
  const key = await passkeyFixture(values);
  const actor = await seedSession(values, 6 * 60_000);
  await authCall(store, { action: 'accountSecurity', sessionId: actor.token });
  for (const [kind, targetId, storageKey] of [
    ['session', actor.record.sidHash, `session:${actor.record.sidHash}`],
    ['passkey', key.id, `passkey:${key.id}`],
  ] as const) {
    const before = structuredClone(values.get(storageKey)) as object;
    expect(
      (
        await authCall(store, {
          action: 'renameSecurityItem',
          sessionId: actor.token,
          kind,
          targetId,
          displayName: '  我的 Mac  ',
        })
      ).status,
    ).toBe(200);
    expect(values.get(storageKey)).toEqual({ ...before, displayName: '我的 Mac' });
  }
  const result = await authCall(store, { action: 'accountSecurity', sessionId: actor.token });
  expect(result.body.session.current).toBe(true);
  expect(result.body.session.displayName).toBe('我的 Mac');
  expect(result.body.sessions[0].displayName).toBe('我的 Mac');
  expect(result.body.passkeys[0].displayName).toBe('我的 Mac');
  // Naming is not proof of identity and must not extend recent authentication.
  expect(
    (await authCall(store, { action: 'passkeyRegistrationOptions', sessionId: actor.token })).body
      .error,
  ).toBe('reauthentication_required');
});

test('names validate types, Unicode controls and length; empty names restore the default', async () => {
  const { store, values } = testAuthStore();
  const actor = await seedSession(values);
  const base = {
    action: 'renameSecurityItem',
    sessionId: actor.token,
    kind: 'session',
    targetId: actor.record.sidHash,
  };
  for (const displayName of [
    undefined,
    null,
    123,
    {},
    [],
    'a'.repeat(65),
    '\nName',
    'Name\u202Efake',
    '\u0000',
    'a\u2028b',
  ]) {
    expect((await authCall(store, { ...base, displayName })).status).toBe(422);
  }
  expect((await authCall(store, { ...base, displayName: 'a'.repeat(64) })).status).toBe(200);
  expect((await authCall(store, { ...base, displayName: '  Cafe\u0301  ' })).status).toBe(200);
  expect((values.get(`session:${actor.record.sidHash}`) as any).displayName).toBe('Café');
  expect((await authCall(store, { ...base, displayName: '   ' })).status).toBe(200);
  expect((values.get(`session:${actor.record.sidHash}`) as any).displayName).toBeUndefined();
});

test('renaming cannot cross accounts or edit revoked and expired sessions', async () => {
  const { store, values } = testAuthStore();
  const actor = await seedSession(values);
  const other = await seedSession(values, 0, OTHER_UUID);
  const key = await passkeyFixture(values);
  values.set(`passkey:${key.id}`, {
    ...(values.get(`passkey:${key.id}`) as object),
    playerUuid: OTHER_UUID,
  });
  for (const [kind, targetId] of [
    ['session', other.record.sidHash],
    ['passkey', key.id],
  ]) {
    expect(
      (
        await authCall(store, {
          action: 'renameSecurityItem',
          sessionId: actor.token,
          kind,
          targetId,
          displayName: 'bad',
        })
      ).status,
    ).toBe(404);
  }
  const expired = await seedSession(values);
  values.set(`session:${expired.record.sidHash}`, {
    ...expired.record,
    idleExpiresAt: new Date(0).toISOString(),
  });
  expect(
    (
      await authCall(store, {
        action: 'renameSecurityItem',
        sessionId: actor.token,
        kind: 'session',
        targetId: expired.record.sidHash,
        displayName: 'bad',
      })
    ).status,
  ).toBe(404);
  await authCall(store, { action: 'logout', sessionId: actor.token });
  expect(
    (
      await authCall(store, {
        action: 'renameSecurityItem',
        sessionId: actor.token,
        kind: 'session',
        targetId: actor.record.sidHash,
        displayName: 'bad',
      })
    ).status,
  ).toBe(401);
});

test('naming rolls back on failure and never recreates a concurrently revoked session', async () => {
  const fixture = testAuthStore();
  const actor = await seedSession(fixture.values);
  const body = {
    action: 'renameSecurityItem',
    sessionId: actor.token,
    kind: 'session',
    targetId: actor.record.sidHash,
    displayName: 'Home',
  };
  fixture.failNextPut('session:');
  expect((await authCall(fixture.store, body)).status).toBe(500);
  expect(
    (fixture.values.get(`session:${actor.record.sidHash}`) as any).displayName,
  ).toBeUndefined();
  expect((await authCall(fixture.store, body)).status).toBe(200);
  const results = await Promise.all([
    authCall(fixture.store, { action: 'logout', sessionId: actor.token }),
    authCall(fixture.store, body),
  ]);
  expect(results[0].status).toBe(200);
  expect([200, 401]).toContain(results[1].status);
  expect(fixture.values.has(`session:${actor.record.sidHash}`)).toBe(false);
});

test('session names survive both game and Passkey reauthentication without copying another session label', async () => {
  for (const method of ['minecraft', 'passkey']) {
    const { store, values } = testAuthStore();
    const key = await passkeyFixture(values);
    const actor = await seedSession(values, 6 * 60_000);
    const other = await seedSession(values);
    await authCall(store, {
      action: 'renameSecurityItem',
      sessionId: actor.token,
      kind: 'session',
      targetId: actor.record.sidHash,
      displayName: 'Home',
    });
    const proof = await authCall(store, {
      action: method === 'minecraft' ? 'createMinecraftChallenge' : 'passkeyAuthenticationOptions',
      purpose: 'reauthenticate',
      sessionId: actor.token,
    });
    const completed =
      method === 'minecraft'
        ? await authCall(store, {
            action: 'completeMinecraftChallenge',
            challengeId: proof.body.challengeId,
            sessionId: actor.token,
          })
        : await authCall(store, {
            action: 'passkeyAuthenticate',
            credential: await key.assertion(proof.body.options.challenge),
            sessionId: actor.token,
          });
    expect(completed.status).toBe(200);
    const result = await authCall(store, {
      action: 'accountSecurity',
      sessionId: completed.body.sessionId,
    });
    expect(result.body.session.displayName).toBe('Home');
    expect(result.body.sessions[0].current).toBe(true);
    expect((values.get(`session:${other.record.sidHash}`) as any).displayName).toBeUndefined();
  }
});

test('Passkey names are normalized on creation and retained when that key is used', async () => {
  const { store, values } = testAuthStore();
  const key = await passkeyFixture(values);
  const actor = await seedSession(values);
  const options = await authCall(store, {
    action: 'passkeyRegistrationOptions',
    sessionId: actor.token,
  });
  const credential = await key.registration(options.body.options.challenge);
  expect(
    (
      await authCall(store, {
        action: 'passkeyRegister',
        sessionId: actor.token,
        credential,
        displayName: 'X\nY',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await authCall(store, {
        action: 'passkeyRegister',
        sessionId: actor.token,
        credential,
        displayName: '  安全密钥  ',
      })
    ).status,
  ).toBe(200);
  expect((values.get(`passkey:${credential.id}`) as any).displayName).toBe('安全密钥');
  const proof = await authCall(store, { action: 'passkeyAuthenticationOptions', purpose: 'login' });
  const assertion = await key.assertion(proof.body.options.challenge);
  await authCall(store, {
    action: 'renameSecurityItem',
    sessionId: actor.token,
    kind: 'passkey',
    targetId: key.id,
    displayName: 'Keychain',
  });
  expect(
    (
      await authCall(store, {
        action: 'passkeyAuthenticate',
        credential: assertion,
        browserNonce: proof.body.browserNonce,
      })
    ).status,
  ).toBe(200);
  expect((values.get(`passkey:${key.id}`) as any).displayName).toBe('Keychain');
  expect((values.get(`passkey:${key.id}`) as any).lastUsedAt).toBeDefined();
});

test('renaming has an account-wide write budget, including across browser sessions', async () => {
  const { store, values } = testAuthStore();
  const first = await seedSession(values);
  const second = await seedSession(values);
  for (let n = 0; n < 20; n++)
    expect(
      (
        await authCall(store, {
          action: 'renameSecurityItem',
          sessionId: first.token,
          kind: 'session',
          targetId: first.record.sidHash,
          displayName: `Name ${n}`,
        })
      ).status,
    ).toBe(200);
  expect(
    (
      await authCall(store, {
        action: 'renameSecurityItem',
        sessionId: second.token,
        kind: 'session',
        targetId: first.record.sidHash,
        displayName: 'Again',
      })
    ).status,
  ).toBe(429);
});

test('HTTP rename routes require the BFF secret and Cookie-derived session metadata', async () => {
  const { store, values, env } = testAuthStore();
  const actor = await seedSession(values);
  const other = await seedSession(values, 0, OTHER_UUID);
  const key = await passkeyFixture(values);
  env.AUTH_STORE = {
    idFromName: () => ({}),
    get: () => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        store.fetch(new Request(input, init)),
    }),
  } as unknown as DurableObjectNamespace;
  const request = (path: string, session: string, secret = 'test-secret', body: object = {}) =>
    worker.fetch(
      new Request(`https://data.mcmik.top${path}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Mikweb-Auth': secret,
          'X-Mik-Session': session,
        },
        body: JSON.stringify({ displayName: 'Home', ...body }),
      }),
      env,
      {} as ExecutionContext,
    );
  expect((await request(`/auth/passkeys/${key.id}`, actor.token, '')).status).toBe(403);
  expect(
    (await request(`/auth/passkeys/${key.id}`, '', 'test-secret', { sessionId: actor.token }))
      .status,
  ).toBe(401);
  expect(
    (
      await request(`/auth/passkeys/${key.id}`, actor.token, 'test-secret', {
        sessionId: other.token,
        playerUuid: OTHER_UUID,
        counter: 999,
      })
    ).status,
  ).toBe(200);
  expect((values.get(`passkey:${key.id}`) as any).playerUuid).toBe(PLAYER_UUID);
  expect((values.get(`passkey:${key.id}`) as any).counter).toBe(0);
  expect((await request(`/me/sessions/${actor.record.sidHash}`, actor.token)).status).toBe(200);
  expect((await request(`/me/sessions/${other.record.sidHash}`, actor.token)).status).toBe(404);
  expect((await request('/auth/passkeys/options/register', actor.token)).status).toBe(404);
});
