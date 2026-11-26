import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import type { SessionService } from './sessions';
import type { Env } from '../env';
import { eligibleAccount } from '../players/accounts';
import { passkeyKey, sessionKey, webauthnChallengeKey } from './repository';
import { CHALLENGE_TTL_SECONDS } from './policy';
import { consumeRateLimit, rateLimitKey } from './rate-limit';
import { bufferToBase64url, base64urlToBuffer } from './tokens';
import { isExpired, recentlyAuthenticated, reauthenticationRequired, sameAuthenticationContext, securityDisplayName, sessionBody, type SessionRecord, type PasskeyRecord, type ChallengeRecord, type AuthResult } from './model';

const MAX_PASSKEYS_PER_ACCOUNT = 16;
const DEFAULT_WEBAUTHN_RP_ID = 'mcmik.top';

const DEFAULT_WEBAUTHN_ORIGIN = 'https://mcmik.top';

const RP_NAME = 'Mik Casual';

export class Passkeys {
  constructor(private readonly sessions: SessionService) {}

  async registrationOptions(sessionId: string): Promise<AuthResult> {
    const session = await this.sessions.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    if (!recentlyAuthenticated(session)) return reauthenticationRequired();
    const limited = await consumeRateLimit(this.sessions.env.DB,
      rateLimitKey('passkey-registration:create', session.sidHash),
      8,
      60,
    );
    if (limited) return limited;
    const account = await this.sessions.loadAccount(session.playerUuid);
    if (!account) return { status: 403, body: { error: 'authentication_invalidated' } };
    const passkeys = await this.sessions.listPasskeys(account.playerUuid);
    if (passkeys.length >= MAX_PASSKEYS_PER_ACCOUNT)
      return { status: 409, body: { error: 'passkey_limit' } };
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: webAuthnConfig(this.sessions.env).rpID,
      userName: account.currentName,
      userID: toArrayBufferBytes(new TextEncoder().encode(account.playerUuid)),
      userDisplayName: account.currentName,
      attestationType: 'none',
      excludeCredentials: passkeys.map(({ credentialId: id, transports }) => ({ id, transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challenge: ChallengeRecord = {
      type: 'passkey-registration',
      playerUuid: account.playerUuid,
      sessionHash: session.sidHash,
      challenge: options.challenge,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    };
    return this.sessions.storage.transaction(async (txn): Promise<AuthResult> => {
      const current = await txn.get<SessionRecord>(sessionKey(session.sidHash));
      if (!current || !(await this.sessions.sessionStillActive(txn, session)))
        return { status: 401, body: { error: 'unauthenticated' } };
      if (!recentlyAuthenticated(current)) return reauthenticationRequired();
      txn.put(webauthnChallengeKey(options.challenge), challenge);
      return { status: 200, body: { options } };
    });
  }

  async register(
    sessionId: string,
    credential: unknown,
    displayName: unknown,
  ): Promise<AuthResult> {
    const session = await this.sessions.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    const name = securityDisplayName(displayName === undefined ? '' : displayName);
    if (name === null) return { status: 422, body: { error: 'invalid_display_name' } };
    const challenge = await this.readWebauthnChallenge(
      'passkey-registration',
      credentialChallengeId(credential),
    );
    if (
      !challenge ||
      challenge.playerUuid !== session.playerUuid ||
      challenge.sessionHash !== session.sidHash
    ) {
      return { status: 400, body: { error: 'invalid_challenge' } };
    }
    const verification = await verifyPasskeyRegistration(
      credential,
      challenge.challenge,
      webAuthnConfig(this.sessions.env),
    );
    if (!verification.verified || !verification.registrationInfo)
      return { status: 400, body: { error: 'passkey_verification_failed' } };
    const account = await this.sessions.loadAccount(session.playerUuid);
    if (!account) return { status: 403, body: { error: 'authentication_invalidated' } };
    const verifiedCredential = verification.registrationInfo.credential;
    const record: PasskeyRecord = {
      credentialId: verifiedCredential.id,
      playerUuid: session.playerUuid,
      publicKey: bufferToBase64url(verifiedCredential.publicKey),
      counter: verifiedCredential.counter,
      transports: verifiedCredential.transports,
      createdAt: new Date().toISOString(),
      displayName: name || undefined,
    };
    const result = await this.sessions.storage.transaction(async (txn): Promise<AuthResult> => {
      if (!(await this.sessions.sessionStillActive(txn, session)))
        return { status: 401, body: { error: 'unauthenticated' } };
      const currentAccount = await txn.players.get(session.playerUuid);
      if (!eligibleAccount(currentAccount))
        return { status: 403, body: { error: 'authentication_invalidated' } };
      const current = await txn.get<ChallengeRecord>(webauthnChallengeKey(challenge.challenge));
      if (
        !current ||
        current.type !== 'passkey-registration' ||
        isExpired(current.expiresAt) ||
        current.sessionHash !== session.sidHash ||
        current.playerUuid !== session.playerUuid
      ) {
        return { status: 400, body: { error: 'invalid_challenge' } };
      }
      if (await txn.get(passkeyKey(record.credentialId)))
        return { status: 409, body: { error: 'passkey_already_registered' } };
      const keys = await txn.owned('passkey', record.playerUuid);
      if (keys.size >= MAX_PASSKEYS_PER_ACCOUNT)
        return { status: 409, body: { error: 'passkey_limit' } };
      txn.put(passkeyKey(record.credentialId), record);
      txn.delete(webauthnChallengeKey(challenge.challenge));
      return { status: 200, body: { ok: true } };
    });
    // Registration is not a new authentication and must not refresh authentication time.
    return result;
  }

  async authenticationOptions(
    clientKey: string,
    previousNonce: string,
    purpose: unknown,
    sessionId: string,
  ): Promise<AuthResult> {
    const rateLimited = await consumeRateLimit(this.sessions.env.DB,
      rateLimitKey('passkey-authentication:create', clientKey),
      20,
      60,
    );
    if (rateLimited) return rateLimited;
    const binding = await this.sessions.createAuthenticationContext(purpose, previousNonce, sessionId);
    if ('status' in binding) return binding;
    const allowed =
      binding.context.purpose === 'reauthenticate'
        ? (await this.sessions.listPasskeys(binding.context.playerUuid)).map(
            ({ credentialId: id, transports }) => ({ id, transports }),
          )
        : undefined;
    if (allowed?.length === 0) return { status: 409, body: { error: 'passkey_unavailable' } };
    const options = await generateAuthenticationOptions({
      rpID: webAuthnConfig(this.sessions.env).rpID,
      userVerification: 'required',
      allowCredentials: allowed,
    });
    await this.sessions.storage.transaction(async (txn) => {
      txn.put(webauthnChallengeKey(options.challenge), {
        type: 'passkey-authentication',
        context: binding.context,
        challenge: options.challenge,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
      } satisfies ChallengeRecord);
    });
    return { status: 200, body: { options, ...binding.browser } };
  }

  async authenticate(
    credential: unknown,
    clientKey: string,
    browserNonce: string,
    sessionId: string,
  ): Promise<AuthResult> {
    const rateLimited = await consumeRateLimit(this.sessions.env.DB,
      rateLimitKey('passkey-authentication:complete', clientKey),
      20,
      60,
    );
    if (rateLimited) return rateLimited;
    if (
      !credential ||
      typeof credential !== 'object' ||
      !('id' in credential) ||
      typeof credential.id !== 'string'
    ) {
      return { status: 400, body: { error: 'passkey_verification_failed' } };
    }
    const response = credential as AuthenticationResponseJSON;
    const challenge = await this.readWebauthnChallenge(
      'passkey-authentication',
      credentialChallengeId(credential),
    );
    if (!challenge) return { status: 400, body: { error: 'invalid_challenge' } };
    const bindingError = await this.sessions.checkAuthenticationContext(
      challenge.context,
      browserNonce,
      sessionId,
    );
    if (bindingError) return bindingError;
    const passkey = await this.sessions.storage.get<PasskeyRecord>(passkeyKey(response.id));
    if (!passkey) return { status: 400, body: { error: 'passkey_verification_failed' } };
    const boundPlayer =
      challenge.context.purpose === 'reauthenticate' ? challenge.context.playerUuid : undefined;
    if (boundPlayer && passkey.playerUuid !== boundPlayer)
      return { status: 403, body: { error: 'account_mismatch' } };
    const userHandle = response.response?.userHandle;
    const expectedHandle = bufferToBase64url(new TextEncoder().encode(passkey.playerUuid));
    if (
      (userHandle == null && !boundPlayer) ||
      (userHandle != null && userHandle !== expectedHandle)
    )
      return { status: 400, body: { error: 'passkey_verification_failed' } };
    const verification = await verifyPasskeyAuthentication(
      response,
      passkey,
      challenge.challenge,
      webAuthnConfig(this.sessions.env),
    );
    if (!verification?.verified)
      return { status: 400, body: { error: 'passkey_verification_failed' } };
    const account = await this.sessions.loadAccount(passkey.playerUuid);
    if (!account) {
      const stored = await this.sessions.storage.players.get(passkey.playerUuid);
      return {
        status: 403,
        body: { error: stored?.banned ? 'account_banned' : 'authentication_invalidated' },
      };
    }
    const session = await this.sessions.prepareSession(account.playerUuid, 'passkey');
    const result = await this.sessions.storage.transaction(async (txn): Promise<AuthResult> => {
      const currentChallenge = await txn.get<ChallengeRecord>(
        webauthnChallengeKey(challenge.challenge),
      );
      if (
        !currentChallenge ||
        currentChallenge.type !== 'passkey-authentication' ||
        !sameAuthenticationContext(currentChallenge.context, challenge.context) ||
        isExpired(currentChallenge.expiresAt)
      ) {
        return { status: 400, body: { error: 'invalid_challenge' } };
      }
      const currentKey = await txn.get<PasskeyRecord>(passkeyKey(passkey.credentialId));
      const currentAccount = await txn.players.get(account.playerUuid);
      if (
        !currentKey ||
        currentKey.playerUuid !== passkey.playerUuid ||
        currentKey.publicKey !== passkey.publicKey ||
        currentKey.counter !== passkey.counter ||
        !eligibleAccount(currentAccount)
      ) {
        return { status: 400, body: { error: 'passkey_verification_failed' } };
      }
      const sessionError = await this.sessions.storeAuthenticatedSession(txn, challenge.context, session);
      if (sessionError) return sessionError;
      txn.put(passkeyKey(passkey.credentialId), {
        ...currentKey,
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date().toISOString(),
      });
      txn.delete(webauthnChallengeKey(challenge.challenge));
      return {
        status: 200,
        body: await sessionBody(
          session.sessionId,
          currentAccount,
          (await txn.owned('passkey', account.playerUuid)).size,
        ),
      };
    });
    if (result.status === 200) this.sessions.authenticationCommitted(challenge.context);
    return result;
  }

  async delete(sessionId: string, credentialId: string): Promise<AuthResult> {
    const session = await this.sessions.readValidSession(sessionId);
    if (!session) return { status: 401, body: { error: 'unauthenticated' } };
    if (!recentlyAuthenticated(session)) return reauthenticationRequired();
    if (!(await this.sessions.loadAccount(session.playerUuid)))
      return { status: 403, body: { error: 'authentication_invalidated' } };
    const result = await this.sessions.storage.transaction(async (txn): Promise<AuthResult> => {
      const current = await txn.get<SessionRecord>(sessionKey(session.sidHash));
      if (!(await this.sessions.sessionStillActive(txn, session)))
        return { status: 401, body: { error: 'unauthenticated' } };
      if (!current || !recentlyAuthenticated(current)) return reauthenticationRequired();
      const passkey = await txn.get<PasskeyRecord>(passkeyKey(credentialId));
      if (!passkey || passkey.playerUuid !== current.playerUuid)
        return { status: 404, body: { error: 'not_found' } };
      txn.delete(passkeyKey(credentialId));
      return { status: 200, body: { ok: true } };
    });
    return result;
  }

  private async readWebauthnChallenge<T extends 'passkey-registration' | 'passkey-authentication'>(
    type: T,
    challenge?: string,
  ): Promise<Extract<ChallengeRecord, { type: T }> | null> {
    if (!challenge) return null;
    const record = await this.sessions.storage.get<ChallengeRecord>(webauthnChallengeKey(challenge));
    if (!record || record.type !== type) return null;
    if (isExpired(record.expiresAt)) {
      await this.sessions.storage.transaction(async txn => txn.delete(webauthnChallengeKey(challenge)));
      return null;
    }
    return record as Extract<ChallengeRecord, { type: T }>;
  }
}

function webAuthnConfig(env: Env): { rpID: string; origins: string[] } {
  const rpID = env.WEBAUTHN_RP_ID?.trim() || DEFAULT_WEBAUTHN_RP_ID;
  const origins = (env.WEBAUTHN_ORIGIN ?? DEFAULT_WEBAUTHN_ORIGIN)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return { rpID, origins: origins.length ? origins : [DEFAULT_WEBAUTHN_ORIGIN] };
}

async function verifyPasskeyRegistration(
  credential: unknown,
  expectedChallenge: string,
  webAuthn: { rpID: string; origins: string[] },
): ReturnType<typeof verifyRegistrationResponse> {
  try {
    return await verifyRegistrationResponse({
      response: credential as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: webAuthn.origins,
      expectedRPID: webAuthn.rpID,
      requireUserVerification: true,
    });
  } catch {
    return { verified: false };
  }
}

async function verifyPasskeyAuthentication(
  response: AuthenticationResponseJSON,
  passkey: PasskeyRecord,
  expectedChallenge: string,
  webAuthn: { rpID: string; origins: string[] },
): Promise<Awaited<ReturnType<typeof verifyAuthenticationResponse>> | null> {
  try {
    return await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: webAuthn.origins,
      expectedRPID: webAuthn.rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: base64urlToBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports,
      } satisfies WebAuthnCredential,
    });
  } catch {
    return null;
  }
}

function toArrayBufferBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.byteLength));
  bytes.set(value);
  return bytes;
}

function credentialChallengeId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const response = value as { response?: { clientDataJSON?: string } };
  const clientData = response.response?.clientDataJSON;
  if (!clientData) return undefined;
  try {
    const text = new TextDecoder().decode(base64urlToBuffer(clientData));
    const parsed = JSON.parse(text) as { challenge?: string };
    return parsed.challenge;
  } catch {
    return undefined;
  }
}
