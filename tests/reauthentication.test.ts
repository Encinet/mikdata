import { expect, spyOn, test } from 'bun:test';
import worker from '../src/index';
import {
  authCall,
  memoryAuthStorage,
  OTHER_UUID,
  passkeyFixture,
  PLAYER_UUID,
  seedSession,
  testAuthStore,
} from './helpers/auth-store';

const game = (sessionId: string) => ({
  action: 'createMinecraftChallenge',
  purpose: 'reauthenticate',
  sessionId,
});
const complete = (challengeId: string, sessionId: string) => ({
  action: 'completeMinecraftChallenge',
  challengeId,
  sessionId,
});
const sessions = (values: Map<string, unknown>) =>
  [...values.keys()].filter((key) => key.startsWith('session:')).length;

function plugin(playerUuid = PLAYER_UUID) {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.startsWith('/api/auth/accounts/'))
        return Response.json({
          player: { uuid: url.pathname.split('/').at(-1), role: 'member', banned: false, credentialsChangedAt: 0 },
        });
      return Response.json({
        status: 'confirmed',
        player: { uuid: playerUuid, name: 'Player', role: 'member' },
        confirmedAt: new Date().toISOString(),
      });
    },
  } as Fetcher;
}

test('authentication purposes are explicit and reauthentication requires a live session', async () => {
  const { store, values } = testAuthStore();
  for (const action of ['createMinecraftChallenge', 'passkeyAuthenticationOptions']) {
    expect((await authCall(store, { action })).body.error).toBe('invalid_authentication_purpose');
    expect((await authCall(store, { action, purpose: 'anything' })).status).toBe(422);
    expect((await authCall(store, { action, purpose: 'reauthenticate' })).status).toBe(401);
  }
  expect(
    [...values.keys()].filter((key) => key.startsWith('challenge:') || key.startsWith('webauthn:')),
  ).toHaveLength(0);
});

test('game reauthentication rotates only the bound session and invalidates its cached cookie', async () => {
  const { store, values } = testAuthStore();
  const old = await seedSession(values, 6 * 60_000);
  const other = await seedSession(values);
  expect((await authCall(store, { action: 'me', sessionId: old.token })).body.authenticated).toBe(
    true,
  );
  const challenge = await authCall(store, game(old.token));
  expect(challenge.status).toBe(200);
  expect(challenge.body.browserNonce).toBeUndefined();
  expect((await authCall(store, complete(challenge.body.challengeId, other.token))).status).toBe(
    401,
  );
  expect(
    (
      await authCall(store, {
        action: 'getMinecraftChallenge',
        challengeId: challenge.body.challengeId,
      })
    ).status,
  ).toBe(401);
  const result = await authCall(store, complete(challenge.body.challengeId, old.token));
  expect(result.status).toBe(200);
  expect(result.body.sessionId).not.toBe(old.token);
  expect((result.body.account as { playerUuid: string }).playerUuid).toBe(PLAYER_UUID);
  expect((result.body.account as { passkeyCount: number }).passkeyCount).toBe(0);
  expect(values.has(`session:${old.record.sidHash}`)).toBe(false);
  expect(values.has(`account-session:${PLAYER_UUID}:${old.record.sidHash}`)).toBe(false);
  expect(values.has(`session:${other.record.sidHash}`)).toBe(true);
  expect((await authCall(store, { action: 'me', sessionId: old.token })).body.authenticated).toBe(
    false,
  );
  expect(
    (
      await authCall(store, {
        action: 'passkeyRegistrationOptions',
        sessionId: result.body.sessionId,
      })
    ).status,
  ).toBe(200);
  expect(
    (await authCall(store, complete(challenge.body.challengeId, result.body.sessionId))).status,
  ).toBe(409);
  expect(sessions(values)).toBe(2);
});

test('a different game account cannot change the account during reauthentication', async () => {
  const { store, values } = testAuthStore({ VPC_SERVICE: plugin(OTHER_UUID) });
  const old = await seedSession(values, 6 * 60_000);
  const challenge = await authCall(store, game(old.token));
  const result = await authCall(store, complete(challenge.body.challengeId, old.token));
  expect(result.body.error).toBe('account_mismatch');
  expect(values.has(`session:${old.record.sidHash}`)).toBe(true);
  expect(values.has(`account:${OTHER_UUID}`)).toBe(false);
  expect(sessions(values)).toBe(1);
});

test('concurrent reauthentication proofs can replace one old session only once', async () => {
  const { store, values } = testAuthStore();
  const old = await seedSession(values, 6 * 60_000);
  const first = await authCall(store, game(old.token));
  const second = await authCall(store, game(old.token));
  const results = await Promise.all(
    [first, second].map((c) => authCall(store, complete(c.body.challengeId, old.token))),
  );
  expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
  expect(sessions(values)).toBe(1);
});

test('reauthentication rolls back session replacement and challenge consumption together', async () => {
  const { store, values, failNextPut } = testAuthStore();
  const old = await seedSession(values, 6 * 60_000);
  const challenge = await authCall(store, game(old.token));
  failNextPut('session:');
  expect((await authCall(store, complete(challenge.body.challengeId, old.token))).status).toBe(500);
  expect(values.has(`session:${old.record.sidHash}`)).toBe(true);
  expect((values.get(`challenge:${challenge.body.challengeId}`) as { status: string }).status).toBe(
    'pending',
  );
  expect((await authCall(store, complete(challenge.body.challengeId, old.token))).status).toBe(200);
  expect(sessions(values)).toBe(1);
});

test('revoking a session while its game proof is in flight prevents replacement', async () => {
  let enter!: () => void;
  const waiting = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = plugin();
  const { store, values } = testAuthStore({
    VPC_SERVICE: {
      fetch: async (input: RequestInfo | URL) => {
        if (new URL(input.toString()).pathname.startsWith('/api/auth/challenges/')) {
          enter();
          await gate;
        }
        return service.fetch(input);
      },
    } as Fetcher,
  });
  const old = await seedSession(values, 6 * 60_000);
  const challenge = await authCall(store, game(old.token));
  const verification = authCall(store, complete(challenge.body.challengeId, old.token));
  await waiting;
  try {
    expect((await authCall(store, { action: 'logout', sessionId: old.token })).status).toBe(200);
  } finally {
    release();
  }
  expect((await verification).status).toBe(401);
  expect(sessions(values)).toBe(0);
});

test('Passkey reauthentication is bound to an enrolled key, account, and exact session', async () => {
  const { store, values } = testAuthStore();
  const key = await passkeyFixture(values);
  const old = await seedSession(values, 6 * 60_000);
  const other = await seedSession(values);
  const options = await authCall(store, {
    action: 'passkeyAuthenticationOptions',
    purpose: 'reauthenticate',
    sessionId: old.token,
  });
  expect(options.body.browserNonce).toBeUndefined();
  expect(
    (options.body.options as { allowCredentials?: { id: string }[] }).allowCredentials?.map(
      (key) => key.id,
    ),
  ).toEqual([key.id]);
  const credential = await key.assertion(options.body.options.challenge);
  expect(
    (await authCall(store, { action: 'passkeyAuthenticate', credential, sessionId: other.token }))
      .status,
  ).toBe(401);
  const result = await authCall(store, {
    action: 'passkeyAuthenticate',
    credential,
    sessionId: old.token,
  });
  expect(result.status).toBe(200);
  expect((await authCall(store, { action: 'me', sessionId: old.token })).body.authenticated).toBe(
    false,
  );
  expect(
    (
      await authCall(store, {
        action: 'passkeyRegister',
        sessionId: result.body.sessionId,
        credential,
      })
    ).body.error,
  ).toBe('invalid_challenge');
  expect(
    (
      await authCall(store, {
        action: 'passkeyAuthenticate',
        credential,
        sessionId: result.body.sessionId,
      })
    ).status,
  ).toBe(400);
});

test('another enrolled account cannot satisfy a bound Passkey proof', async () => {
  const { store, values } = testAuthStore();
  const key = await passkeyFixture(values);
  const own = await passkeyFixture(values);
  values.set(`passkey:${own.id}`, {
    ...(values.get(`passkey:${own.id}`) as object),
    playerUuid: OTHER_UUID,
  });
  values.delete(`account-passkey:${PLAYER_UUID}:${own.id}`);
  values.set(`account-passkey:${OTHER_UUID}:${own.id}`, own.id);
  const old = await seedSession(values, 6 * 60_000, OTHER_UUID);
  const options = await authCall(store, {
    action: 'passkeyAuthenticationOptions',
    purpose: 'reauthenticate',
    sessionId: old.token,
  });
  const credential = await key.assertion(options.body.options.challenge);
  const result = await authCall(store, {
    action: 'passkeyAuthenticate',
    credential,
    sessionId: old.token,
  });
  expect(result.body.error).toBe('account_mismatch');
  expect(values.has(`session:${old.record.sidHash}`)).toBe(true);
  expect(sessions(values)).toBe(1);
});

test('an account without enrolled keys is not given an unrestricted reauthentication prompt', async () => {
  const { store, values } = testAuthStore();
  const old = await seedSession(values);
  expect(
    (
      await authCall(store, {
        action: 'passkeyAuthenticationOptions',
        purpose: 'reauthenticate',
        sessionId: old.token,
      })
    ).body.error,
  ).toBe('passkey_unavailable');
});

test('a registration begun within recent authentication completes under its own lifetime', async () => {
  const { store, values } = testAuthStore();
  const key = await passkeyFixture(values);
  const old = await seedSession(values, 4 * 60_000);
  const options = await authCall(store, {
    action: 'passkeyRegistrationOptions',
    sessionId: old.token,
  });
  const credential = await key.registration(options.body.options.challenge);
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now + 2 * 60_000);
  try {
    expect(
      (await authCall(store, { action: 'passkeyRegistrationOptions', sessionId: old.token })).body
        .error,
    ).toBe('reauthentication_required');
    const results = await Promise.all(
      [0, 1].map(() =>
        authCall(store, { action: 'passkeyRegister', sessionId: old.token, credential }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(
      (values.get(`session:${old.record.sidHash}`) as { authenticatedAt: string }).authenticatedAt,
    ).toBe(old.record.authenticatedAt);
  } finally {
    clock.mockRestore();
  }
});

test('expired registration grants cannot be used even when a session is still valid', async () => {
  const { store, values } = testAuthStore();
  const key = await passkeyFixture(values);
  const old = await seedSession(values);
  const options = await authCall(store, {
    action: 'passkeyRegistrationOptions',
    sessionId: old.token,
  });
  const credential = await key.registration(options.body.options.challenge);
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
  try {
    expect(
      (await authCall(store, { action: 'passkeyRegister', sessionId: old.token, credential })).body
        .error,
    ).toBe('invalid_challenge');
  } finally {
    clock.mockRestore();
  }
  expect(values.has(`passkey:${credential.id}`)).toBe(false);
});

test('account credential revocation during registration verification prevents the final write', async () => {
  const memory = memoryAuthStorage();
  let invalidate = false;
  const transaction = memory.storage.transaction.bind(memory.storage);
  const storage = {
    ...memory.storage,
    transaction: async (task: any) => {
      if (invalidate) {
        invalidate = false;
        const account = memory.values.get(`account:${PLAYER_UUID}`) as object;
        memory.values.set(`account:${PLAYER_UUID}`, {
          ...account,
          banned: false, credentialsChangedAt: Date.now() + 1,
        });
      }
      return transaction(task);
    },
  } as DurableObjectStorage;
  const { store, values } = testAuthStore({}, { ...memory, storage });
  const key = await passkeyFixture(values);
  const old = await seedSession(values);
  const options = await authCall(store, {
    action: 'passkeyRegistrationOptions',
    sessionId: old.token,
  });
  const credential = await key.registration(options.body.options.challenge);
  invalidate = true;
  expect(
    (await authCall(store, { action: 'passkeyRegister', sessionId: old.token, credential })).status,
  ).toBe(401);
  expect(values.has(`passkey:${credential.id}`)).toBe(false);
});

test('the HTTP boundary accepts session authority only from the authenticated BFF header', async () => {
  const { store, values, env } = testAuthStore();
  const old = await seedSession(values);
  env.AUTH_STORE = {
    idFromName: () => ({}),
    get: () => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        store.fetch(new Request(input, init)),
    }),
  } as unknown as DurableObjectNamespace;
  const response = await worker.fetch(
    new Request('https://data.mcmik.top/auth/passkeys/options/register', {
      method: 'POST',
      headers: { 'X-Mikweb-Auth': 'test-secret' },
      body: JSON.stringify({ sessionId: old.token }),
    }),
    env,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(401);
});

test('sensitive writes refresh plugin policy even when the ordinary account cache is warm', async () => {
  let role = 'member';
  const { store, values } = testAuthStore({
    VPC_SERVICE: {
      fetch: async (input: RequestInfo | URL) =>
        Response.json({
          player: {
            uuid: new URL(input.toString()).pathname.split('/').at(-1),
            role,
            banned: false, credentialsChangedAt: 0,
          },
        }),
    } as Fetcher,
  });
  const session = await seedSession(values);
  expect(
    (await authCall(store, { action: 'me', sessionId: session.token })).body.authenticated,
  ).toBe(true);
  role = 'unknown';
  expect(
    (await authCall(store, { action: 'passkeyRegistrationOptions', sessionId: session.token })).body
      .error,
  ).toBe('authentication_invalidated');
  expect(sessions(values)).toBe(0);
});

test('an unavailable fresh policy blocks registration without deleting its grant or session', async () => {
  let offline = false;
  const service = plugin();
  const { store, values } = testAuthStore({
    VPC_SERVICE: {
      fetch: async (input: RequestInfo | URL) => {
        if (offline) throw new Error('offline');
        return service.fetch(input);
      },
    } as Fetcher,
  });
  const key = await passkeyFixture(values);
  const session = await seedSession(values);
  const options = await authCall(store, {
    action: 'passkeyRegistrationOptions',
    sessionId: session.token,
  });
  const credential = await key.registration(options.body.options.challenge);
  offline = true;
  expect(
    (await authCall(store, { action: 'passkeyRegister', sessionId: session.token, credential }))
      .body.error,
  ).toBe('plugin_unavailable');
  expect(values.has(`session:${session.record.sidHash}`)).toBe(true);
  expect(values.has(`webauthn:${options.body.options.challenge}`)).toBe(true);
  expect(values.has(`passkey:${credential.id}`)).toBe(false);
  offline = false;
  expect(
    (await authCall(store, { action: 'passkeyRegister', sessionId: session.token, credential }))
      .status,
  ).toBe(200);
});

test('session rotation invalidates old registration grants for both the old and new cookies', async () => {
  const { store, values } = testAuthStore();
  const key = await passkeyFixture(values);
  const session = await seedSession(values);
  const grant = await authCall(store, {
    action: 'passkeyRegistrationOptions',
    sessionId: session.token,
  });
  const credential = await key.registration(grant.body.options.challenge);
  const proof = await authCall(store, {
    action: 'passkeyAuthenticationOptions',
    purpose: 'reauthenticate',
    sessionId: session.token,
  });
  const assertion = await key.assertion(proof.body.options.challenge);
  const verified = await authCall(store, {
    action: 'passkeyAuthenticate',
    sessionId: session.token,
    credential: assertion,
  });
  expect(verified.status).toBe(200);
  expect(
    (await authCall(store, { action: 'passkeyRegister', sessionId: session.token, credential }))
      .status,
  ).toBe(401);
  expect(
    (
      await authCall(store, {
        action: 'passkeyRegister',
        sessionId: verified.body.sessionId,
        credential,
      })
    ).body.error,
  ).toBe('invalid_challenge');
  expect(values.has(`passkey:${credential.id}`)).toBe(false);
});

test('plugin revocation notification cannot delay delivery of the rotated session', async () => {
  let release!: () => void;
  const notification = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = plugin();
  const { store, values, background } = testAuthStore({
    VPC_SERVICE: {
      fetch: async (input: RequestInfo | URL) => {
        if (new URL(input.toString()).pathname === '/api/chat/revoke') {
          await notification;
          return Response.json({ ok: true });
        }
        return service.fetch(input);
      },
    } as Fetcher,
  });
  const session = await seedSession(values, 6 * 60_000);
  const challenge = await authCall(store, game(session.token));
  try {
    const result = await authCall(store, complete(challenge.body.challengeId, session.token));
    expect(result.status).toBe(200);
    expect(background.length).toBe(1);
    expect(values.has(`session:${session.record.sidHash}`)).toBe(false);
  } finally {
    release();
    await Promise.all(background);
  }
}, 1000);

test('account-bound authentication permits an omitted user handle but rejects a mismatched one', async () => {
  const { store, values } = testAuthStore();
  const key = await passkeyFixture(values);
  const session = await seedSession(values, 6 * 60_000);
  const options = await authCall(store, {
    action: 'passkeyAuthenticationOptions',
    purpose: 'reauthenticate',
    sessionId: session.token,
  });
  const wrong = await key.assertion(options.body.options.challenge, OTHER_UUID);
  expect(
    (
      await authCall(store, {
        action: 'passkeyAuthenticate',
        sessionId: session.token,
        credential: wrong,
      })
    ).status,
  ).toBe(400);
  const credential = await key.assertion(options.body.options.challenge);
  const { userHandle: _, ...response } = credential.response;
  expect(
    (
      await authCall(store, {
        action: 'passkeyAuthenticate',
        sessionId: session.token,
        credential: { ...credential, response },
      })
    ).status,
  ).toBe(200);
});
