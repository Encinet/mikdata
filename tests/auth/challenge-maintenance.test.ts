import { expect, spyOn, test } from 'bun:test';
import { maintainAuth } from '../../src/auth/repository';
import { authCall, authFixture } from '../helpers/auth';

function expired(f: ReturnType<typeof authFixture>, count: number) {
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

test('challenge creation does not scan expired challenges', async () => {
  const f = authFixture();
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
});

test('bounded challenge sweeps preserve active challenges and reassigned codes across restarts', async () => {
  const f = authFixture();
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
    await maintainAuth(f.env.DB);
    expect([...f.values.keys()].filter((key) => key.startsWith('challenge:'))).toHaveLength(45);

    now += 1001;
    await maintainAuth(f.env.DB);
    now += 1001;
    await maintainAuth(f.env.DB);
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

test('expired challenges and their display codes roll back together after a storage failure', async () => {
  const f = authFixture();
  expired(f, 258);
  f.failNextSql('DELETE FROM auth_webauthn');
  await expect(maintainAuth(f.env.DB)).rejects.toThrow('Injected storage failure');
  expect([...f.values.keys()].filter((key) => key.startsWith('challenge:'))).toHaveLength(258);
  await maintainAuth(f.env.DB);
  expect([...f.values.keys()].filter((key) => key.startsWith('challenge:'))).toHaveLength(2);
});

test('cron expires passkey challenges without a Minecraft login or building operation', async () => {
  const f = authFixture();
  const options = await authCall(f.store, {
    action: 'passkeyAuthenticationOptions',
    purpose: 'login',
    clientKey: 'test',
    browserNonce: '',
  });
  expect(options.status).toBe(200);
  f.db.run("UPDATE auth_webauthn SET document=json_set(document,'$.expiresAt','2000-01-01')");
  await maintainAuth(f.env.DB);
  expect([...f.values.keys()].filter(key => key.startsWith('webauthn:'))).toHaveLength(0);
});
