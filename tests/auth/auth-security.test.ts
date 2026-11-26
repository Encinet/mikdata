import { maintainAuth } from '../../src/auth/repository';
import { expect, test } from 'bun:test';
import worker from '../../src/index';
import {
  authCall,
  authDatabaseFixture,
  OTHER_UUID,
  passkeyFixture,
  PLAYER_UUID,
  seedSession,
  testAuthEnv,
  authFixture,
} from '../helpers/auth';

const completion = (body: Record<string, unknown>) => ({
  action: 'completeMinecraftChallenge',
  challengeId: body.challengeId,
  browserNonce: body.browserNonce,
});
const sessionCount = (values: Map<string, unknown>) =>
  [...values.keys()].filter((key) => key.startsWith('session:')).length;

test('one game approval issues one session across parallel completion and reconfirmation', async () => {
  const { store, values } = authFixture();
  const created = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  const results = await Promise.all([
    authCall(store, completion(created.body)),
    authCall(store, completion(created.body)),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  expect(sessionCount(values)).toBe(1);
  expect((await authCall(store, completion(created.body))).body.error).toBe('challenge_consumed');
});

test('storage failure rolls back challenge consumption and session creation, allowing retry', async () => {
  const { store, values, failNextPut } = authFixture();
  const created = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  failNextPut('session:');
  expect((await authCall(store, completion(created.body))).status).toBe(500);
  expect(sessionCount(values)).toBe(0);
  expect((values.get(`challenge:${created.body.challengeId}`) as { status: string }).status).toBe(
    'pending',
  );
  expect(values.has(`account:${PLAYER_UUID}`)).toBe(false);
  expect((await authCall(store, completion(created.body))).status).toBe(200);
});

test('game status and completion both require the initiating browser', async () => {
  const { store } = authFixture();
  const created = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  expect(
    (
      await authCall(store, {
        action: 'getMinecraftChallenge',
        challengeId: created.body.challengeId,
        browserNonce: 'wrong',
      })
    ).status,
  ).toBe(403);
  expect(
    (await authCall(store, { ...completion(created.body), browserNonce: 'wrong' })).status,
  ).toBe(403);
  expect(
    (await authCall(store, { action: 'getMinecraftChallenge', ...created.body })).body.status,
  ).toBe('confirmed');
  expect((await authCall(store, completion(created.body))).status).toBe(200);
});

test('parallel status polling makes one plugin request', async () => {
  let requests = 0;
  const { store } = authFixture({
    VPC_SERVICE: {
      fetch: async () => {
        requests++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({ status: 'pending' });
      },
    } as Fetcher,
  });
  const created = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  await Promise.all(
    Array.from({ length: 5 }, () =>
      authCall(store, { action: 'getMinecraftChallenge', ...created.body }),
    ),
  );
  expect(requests).toBe(1);
});

test('disabled accounts cannot be re-enabled by game login', async () => {
  const { store, values } = authFixture();
  values.set(`account:${PLAYER_UUID}`, {
    playerUuid: PLAYER_UUID,
    currentName: 'Player',
    role: 'member',
    disabledAt: new Date().toISOString(),
  });
  const created = await authCall(store, { action: 'createMinecraftChallenge', purpose: 'login' });
  expect((await authCall(store, completion(created.body))).body.error).toBe('account_disabled');
  expect(sessionCount(values)).toBe(0);
});

test('a real zero-counter Passkey assertion is browser bound and consumed once in parallel', async () => {
  const { store, values } = authFixture();
  const key = await passkeyFixture(values);
  const options = await authCall(store, {
    action: 'passkeyAuthenticationOptions',
    purpose: 'login',
  });
  const credential = await key.assertion(options.body.options.challenge);
  expect(
    (await authCall(store, { action: 'passkeyAuthenticate', credential, browserNonce: 'wrong' }))
      .body.error,
  ).toBe('invalid_browser_nonce');
  const results = await Promise.all(
    [0, 1].map(() =>
      authCall(store, {
        action: 'passkeyAuthenticate',
        credential,
        browserNonce: options.body.browserNonce,
      }),
    ),
  );
  expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
  expect(sessionCount(values)).toBe(1);
  expect(
    (
      await authCall(store, {
        action: 'passkeyAuthenticate',
        credential,
        browserNonce: options.body.browserNonce,
      })
    ).status,
  ).toBe(400);
});

test('Passkey authentication checks the user handle and user verification', async () => {
  const { store, values } = authFixture();
  const key = await passkeyFixture(values);
  const options = await authCall(store, {
    action: 'passkeyAuthenticationOptions',
    purpose: 'login',
  });
  for (const credential of [
    await key.assertion(options.body.options.challenge, OTHER_UUID),
    await key.assertion(options.body.options.challenge, PLAYER_UUID, false),
  ]) {
    expect(
      (
        await authCall(store, {
          action: 'passkeyAuthenticate',
          credential,
          browserNonce: options.body.browserNonce,
        })
      ).status,
    ).toBe(400);
  }
  expect(sessionCount(values)).toBe(0);
});

test('Passkey registration belongs to the exact session and does not refresh authentication', async () => {
  const { store, values } = authFixture();
  const key = await passkeyFixture(values);
  const first = await seedSession(values);
  const second = await seedSession(values);
  const options = await authCall(store, {
    action: 'passkeyRegistrationOptions',
    sessionId: first.token,
  });
  expect(options.status).toBe(200);
  expect(options.body.options.authenticatorSelection).toMatchObject({
    residentKey: 'required',
    userVerification: 'required',
  });
  const credential = await key.registration(options.body.options.challenge);
  expect(
    (await authCall(store, { action: 'passkeyRegister', sessionId: second.token, credential })).body
      .error,
  ).toBe('invalid_challenge');
  const result = await authCall(store, {
    action: 'passkeyRegister',
    sessionId: first.token,
    credential,
  });
  expect(result.status).toBe(200);
  expect(result.body.sessionId).toBeUndefined();
  expect(values.get(`session:${first.record.sidHash}`)).toEqual(first.record);
  expect(values.has(`passkey:${credential.id}`)).toBe(true);
  expect(
    (await authCall(store, { action: 'passkeyRegister', sessionId: first.token, credential }))
      .status,
  ).toBe(400);
});

test('old sessions cannot add or revoke keys even when issued recently', async () => {
  const { store, values } = authFixture();
  const key = await passkeyFixture(values);
  const session = await seedSession(values, 6 * 60_000);
  for (const request of [
    { action: 'passkeyRegistrationOptions' },
    { action: 'passkeyDelete', credentialId: key.id },
  ]) {
    const result = await authCall(store, { ...request, sessionId: session.token });
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('reauthentication_required');
  }
  expect(values.has(`passkey:${key.id}`)).toBe(true);
});

test('key revocation checks ownership and permits revoking the final key', async () => {
  const { store, values } = authFixture();
  const key = await passkeyFixture(values);
  const other = await seedSession(values, 0, OTHER_UUID);
  expect(
    (
      await authCall(store, {
        action: 'passkeyDelete',
        sessionId: other.token,
        credentialId: key.id,
      })
    ).status,
  ).toBe(404);
  const own = await seedSession(values);
  expect(
    (await authCall(store, { action: 'passkeyDelete', sessionId: own.token, credentialId: key.id }))
      .status,
  ).toBe(200);
  expect(values.has(`passkey:${key.id}`)).toBe(false);
  expect((await authCall(store, { action: 'me', sessionId: own.token })).body.authenticated).toBe(
    true,
  );
});

test('web revocation during an in-flight passkey login cannot recreate the credential or sign in', async () => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const memory = authDatabaseFixture();
  let pausedCredential = '';
  memory.hooks.afterRead = async (sql, args) => {
    if (sql.includes('FROM auth_passkeys WHERE id=?') && 'passkey:' + args[0] === pausedCredential) {
      pausedCredential = '';
      entered();
      await gate;
    }
  };
  const { store, values } = authFixture({}, memory);
  const session = await seedSession(values);
  const key = await passkeyFixture(values);
  const options = await authCall(store, {
    action: 'passkeyAuthenticationOptions',
    purpose: 'login',
  });
  const credential = await key.assertion(options.body.options.challenge);
  pausedCredential = `passkey:${key.id}`;
  const login = authCall(store, {
    action: 'passkeyAuthenticate',
    credential,
    browserNonce: options.body.browserNonce,
  });
  await waiting;
  try {
    expect(
      (
        await authCall(store, {
          action: 'passkeyDelete',
          sessionId: session.token,
          credentialId: key.id,
        })
      ).status,
    ).toBe(200);
  } finally {
    resume();
  }
  expect((await login).status).toBe(400);
  expect(values.has(`passkey:${key.id}`)).toBe(false);
  expect(sessionCount(values)).toBe(1);
});

test('unknown roles and credential changes invalidate existing web sessions', async () => {
  for (const policy of [
    { role: 'unknown', banned: false, credentialsChangedAt: 0 },
    { role: 'member', banned: false, credentialsChangedAt: Date.now() },
  ]) {
    const memory = authDatabaseFixture();
    const session = await seedSession(memory.values, 60_000);
    const { store } = authFixture(
      {
        VPC_SERVICE: {
          fetch: async () => Response.json({ player: { uuid: PLAYER_UUID, ...policy } }),
        } as Fetcher,
      },
      memory,
    );
    const me = await authCall(store, { action: 'me', sessionId: session.token });
    expect(me.body.authenticated).toBe(false);
    expect(sessionCount(memory.values)).toBe(0);
  }
});

test('policy lookup failure fails closed without deleting the account or session', async () => {
  const { store, values } = authFixture({
    VPC_SERVICE: {
      fetch: async () => {
        throw new Error('offline');
      },
    } as Fetcher,
  });
  const session = await seedSession(values);
  expect((await authCall(store, { action: 'me', sessionId: session.token })).status).toBe(503);
  expect(values.has(`account:${PLAYER_UUID}`)).toBe(true);
  expect(sessionCount(values)).toBe(1);
});

test('unknown routes and methods spend no D1 or limiter budget', async () => {
  let checks = 0;
  const env = testAuthEnv({
    AUTH_CLIENT_RATE_LIMITER: {
      limit: async () => {
        checks++;
        return { success: true };
      },
    } as RateLimit,
    DB: {
      prepare: () => {
        throw new Error('must not resolve the store');
      },
    } as unknown as D1Database,
  });
  for (const [method, path] of [
    ['POST', '/auth/unknown'],
    ['POST', '/me/summary'],
    ['GET', '/auth/passkeys/authenticate'],
  ]) {
    const result = await worker.fetch(
      new Request(`https://data.mcmik.top${path}`, {
        method,
        headers: { 'X-Mikweb-Auth': 'test-secret' },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(result.status).toBe(404);
  }
  expect(checks).toBe(0);
});

test('signing out all browsers clears the cookie and revokes web and chat sessions for the owner', async () => {
  const { store, values, env, background } = authFixture();
  const plugin = env.VPC_SERVICE;
  const notifications: string[][] = [];
  env.VPC_SERVICE = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(input.toString()).pathname === '/api/chat/revoke') {
        notifications.push(JSON.parse(String(init?.body)).sessionRefs);
        return Response.json({ ok: true });
      }
      return plugin.fetch(input, init);
    },
  } as Fetcher;
  const actor = await seedSession(values);
  const second = await seedSession(values);
  const other = await seedSession(values, 0, OTHER_UUID);
  const key = await passkeyFixture(values);
  for (const session of [actor, second, other]) {
    expect(
      (await authCall(store, { action: 'me', sessionId: session.token })).body.authenticated,
    ).toBe(true);
  }
  const response = await worker.fetch(
    new Request('https://data.mcmik.top/me/sessions/revoke', {
      method: 'POST',
      headers: {
        'X-Mikweb-Auth': 'test-secret',
        'X-Mik-Session': actor.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ all: true, playerUuid: OTHER_UUID, sessionId: 'untrusted-body' }),
    }),
    env,
    store.ctx,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get('Set-Cookie')).toContain('__Host-mik_sid=;');
  expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  await Promise.all(background);
  expect(notifications.map((refs) => refs.sort())).toEqual([
    [actor.record.sidHash, second.record.sidHash].sort(),
  ]);
  for (const session of [actor, second]) {
    expect(values.has(`session:${session.record.sidHash}`)).toBe(false);
    expect(values.sessions(PLAYER_UUID)).not.toContain(session.record.sidHash);
    expect(
      (await authCall(store, { action: 'me', sessionId: session.token })).body.authenticated,
    ).toBe(false);
  }
  expect((await authCall(store, { action: 'me', sessionId: other.token })).body.authenticated).toBe(
    true,
  );
  expect(values.has(`passkey:${key.id}`)).toBe(true);
});

test('revoking other or all sessions requires recent authentication while ordinary logout remains available', async () => {
  const { store, values } = authFixture();
  const actor = await seedSession(values, 10 * 60_000);
  const target = await seedSession(values);
  for (const scope of [{ all: true }, { targetSessionId: target.record.sidHash }]) {
    const result = await authCall(store, {
      action: 'revokeAccountSession',
      sessionId: actor.token,
      ...scope,
    });
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('reauthentication_required');
  }
  expect(sessionCount(values)).toBe(2);
  expect((await authCall(store, { action: 'logout', sessionId: actor.token })).status).toBe(200);
  expect(values.has(`session:${actor.record.sidHash}`)).toBe(false);
  expect(values.has(`session:${target.record.sidHash}`)).toBe(true);
});

test('session revocation rejects ambiguous scope and cannot target another account', async () => {
  const { store, values } = authFixture();
  const actor = await seedSession(values);
  const other = await seedSession(values, 0, OTHER_UUID);
  for (const scope of [{}, { all: 'true' }, { all: true, targetSessionId: other.record.sidHash }]) {
    expect(
      (await authCall(store, { action: 'revokeAccountSession', sessionId: actor.token, ...scope }))
        .status,
    ).toBe(422);
  }
  expect(
    (
      await authCall(store, {
        action: 'revokeAccountSession',
        sessionId: actor.token,
        targetSessionId: other.record.sidHash,
      })
    ).status,
  ).toBe(404);
  expect((await authCall(store, { action: 'revokeAccountSession', all: true })).status).toBe(401);
  expect(sessionCount(values)).toBe(2);
});

test('concurrent requests for one account share one authoritative policy lookup', async () => {
  let requests = 0;
  const { store, values } = authFixture({
    VPC_SERVICE: {
      fetch: async () => {
        requests += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({
          player: { uuid: PLAYER_UUID, role: 'member', banned: false, credentialsChangedAt: 0 },
        });
      },
    } as Fetcher,
  });
  const session = await seedSession(values);
  const replies = await Promise.all(
    Array.from({ length: 4 }, () => authCall(store, { action: 'me', sessionId: session.token })),
  );
  expect(replies.every((reply) => reply.body.authenticated)).toBe(true);
  expect(requests).toBe(1);
});

test('observing account disablement revokes sessions so enabling the account cannot resurrect them', async () => {
  const { store, values } = authFixture();
  const session = await seedSession(values);
  const account = values.get(`account:${PLAYER_UUID}`) as Record<string, unknown>;
  values.set(`account:${PLAYER_UUID}`, { ...account, disabledAt: new Date().toISOString() });
  expect(
    (await authCall(store, { action: 'me', sessionId: session.token })).body.authenticated,
  ).toBe(false);
  expect(sessionCount(values)).toBe(0);
  values.set(`account:${PLAYER_UUID}`, account);
  expect(
    (await authCall(store, { action: 'me', sessionId: session.token })).body.authenticated,
  ).toBe(false);
});

test('listing expired sessions deletes records and indexes while preserving a foreign account record', async () => {
  const f = authFixture();
  const current = await seedSession(f.values);
  const expired = await seedSession(f.values);
  const foreign = await seedSession(f.values, 0, OTHER_UUID);
  f.values.set(`session:${expired.record.sidHash}`, {
    ...expired.record,
    idleExpiresAt: '2020-01-01T00:00:00.000Z',
  });
  expect(
    (await authCall(f.store, { action: 'accountSecurity', sessionId: current.token })).status,
  ).toBe(200);
  expect(f.values.has(`session:${expired.record.sidHash}`)).toBe(false);
  expect(f.values.sessions(PLAYER_UUID)).not.toContain(expired.record.sidHash);
  expect(f.values.sessions(PLAYER_UUID)).not.toContain(foreign.record.sidHash);
  expect(f.values.has(`session:${foreign.record.sidHash}`)).toBe(true);
});

test('a successful login caps active sessions at sixteen without touching another account', async () => {
  const f = authFixture();
  for (let i = 0; i < 17; i++) await seedSession(f.values);
  const foreign = await seedSession(f.values, 0, OTHER_UUID);
  const challenge = await authCall(f.store, {
    action: 'createMinecraftChallenge',
    purpose: 'login',
  });
  expect((await authCall(f.store, completion(challenge.body))).status).toBe(200);
  expect(
    f.values.sessions(PLAYER_UUID),
  ).toHaveLength(16);
  expect(f.values.has(`session:${foreign.record.sidHash}`)).toBe(true);
});

test('session cleanup uses bounded expiry batches across cron runs', async () => {
  const f = authFixture();
  for (let i = 0; i < 278; i++) {
    const sidHash = String(i).padStart(4, '0');
    f.values.set(`session:${sidHash}`, {
      sidHash,
      playerUuid: PLAYER_UUID,
      idleExpiresAt: '2020-01-01',
      absoluteExpiresAt: '2020-01-01',
    });
  }
  await maintainAuth(f.env.DB);
  expect(sessionCount(f.values)).toBe(22);
  await maintainAuth(f.env.DB);
  expect(sessionCount(f.values)).toBe(0);
});
