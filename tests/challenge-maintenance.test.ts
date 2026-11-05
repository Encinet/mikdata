import { expect, spyOn, test } from 'bun:test';
import { AuthStore } from '../src/auth';
import { authCall, testAuthStore } from './helpers/auth-store';

function expired(f: ReturnType<typeof testAuthStore>, count: number) {
  for (let i = 0; i < count; i++) {
    const id = String(i).padStart(24, '0'),
      code = String(i).padStart(6, '0');
    f.values.set(`challenge:${id}`, {
      type: 'minecraft-authentication',
      challengeId: id,
      displayCode: code,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    f.values.set(`code:${code}`, id);
    f.values.set(`webauthn:${id}`, {
      type: 'passkey-authentication',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
  }
}

test('challenge creation schedules maintenance without scanning expired challenges', async () => {
  const f = testAuthStore();
  expired(f, 129);
  const created = await authCall(f.store, {
    action: 'createMinecraftChallenge',
    purpose: 'login',
    clientKey: 'test',
    browserNonce: '',
  });
  expect(created.status).toBe(200);
  expect([...f.values.keys()].filter((key) => key.startsWith('challenge:'))).toHaveLength(130);
  expect([...f.values.keys()].filter((key) => key.startsWith('webauthn:'))).toHaveLength(129);
  expect(await f.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 301_000);
});

test('bounded challenge sweeps preserve active challenges and reassigned codes across restarts', async () => {
  const f = testAuthStore();
  expired(f, 300);
  f.values.set('code:000000', 'another-challenge');
  f.values.set('challenge:active', {
    type: 'minecraft-authentication',
    challengeId: 'active',
    displayCode: 'active',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  f.values.set('code:active', 'active');
  f.values.set('webauthn:active', {
    type: 'passkey-registration',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  const date = spyOn(Date, 'now');
  let now = new Date().getTime();
  date.mockImplementation(() => now);
  try {
    await f.store.alarm();
    expect([...f.values.keys()].filter((key) => key.startsWith('challenge:'))).toHaveLength(173);
    const restarted = new AuthStore({ storage: f.storage } as DurableObjectState, f.env);
    now += 1001;
    await restarted.alarm();
    now += 1001;
    await restarted.alarm();
    expect([...f.values.keys()].filter((key) => key.startsWith('challenge:'))).toEqual([
      'challenge:active',
    ]);
    expect([...f.values.keys()].filter((key) => key.startsWith('webauthn:'))).toEqual([
      'webauthn:active',
    ]);
    expect(f.values.get('code:000000')).toBe('another-challenge');
    expect(f.values.get('code:active')).toBe('active');
  } finally {
    date.mockRestore();
  }
});

test('challenge sweep cursor and deletions roll back together after a storage failure', async () => {
  const f = testAuthStore();
  expired(f, 130);
  f.failNextPut('maintenance:challenges-next-sweep');
  await expect(f.store.alarm()).rejects.toThrow('Injected storage failure');
  expect(f.values.has('maintenance:challenge:cursor')).toBe(false);
  expect([...f.values.keys()].filter((key) => key.startsWith('challenge:'))).toHaveLength(130);
  await f.store.alarm();
  expect([...f.values.keys()].filter((key) => key.startsWith('challenge:'))).toHaveLength(2);
});

test('passkey login options arm challenge cleanup without a Minecraft login or building operation', async () => {
  const f = testAuthStore();
  const options = await authCall(f.store, {
    action: 'passkeyAuthenticationOptions',
    purpose: 'login',
    clientKey: 'test',
    browserNonce: '',
  });
  expect(options.status).toBe(200);
  expect(f.values.get('maintenance:challenges-next-sweep')).toBeNumber();
  expect(await f.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 301_000);
});
