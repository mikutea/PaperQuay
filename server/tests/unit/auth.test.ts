import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { createOidcVerifier } from '../../src/auth.ts';
import { ApiError } from '../../src/errors.ts';
import { fixtureIssuer } from '../fixtures.ts';

const keys = await generateKeyPair('RS256');
const verify = await createOidcVerifier({ issuer: fixtureIssuer, audience: 'paperquay-sync',
  clientIds: ['paperquay-test'], keyResolver: async () => keys.publicKey });
const now = Math.floor(Date.now() / 1000);

async function token(overrides: Record<string, unknown> = {}, algorithm = 'RS256') {
  const jwt = await new SignJWT({ iss: fixtureIssuer, sub: 'test-subject', sid: 'test-login-session',
    aud: 'paperquay-sync', azp: 'paperquay-test', iat: now, exp: now + 300, ...overrides })
    .setProtectedHeader({ alg: algorithm, typ: 'JWT' }).sign(keys.privateKey);
  return `Bearer ${jwt}`;
}

test('signed OIDC access token supplies issuer/sub/sid, never client-supplied device identity', async () => {
  assert.deepEqual(await verify(await token()), { issuer: fixtureIssuer, subject: 'test-subject',
    sessionId: 'test-login-session', clientId: 'paperquay-test' });
});

test('wrong issuer/audience/client, missing session, expiry, future issuance and conflicting client claims fail closed', async () => {
  for (const claims of [
    { iss: 'https://attacker.example.test' }, { aud: 'another-api' }, { azp: 'another-client' },
    { sid: undefined }, { sub: '' }, { exp: now - 30 }, { iat: now + 60 },
    { client_id: 'another-client' }, { sid: 'bad\nsession' },
  ]) {
    await assert.rejects(verify(await token(claims)), (error: unknown) => error instanceof ApiError
      && error.statusCode === 401 && error.code === 'AUTHENTICATION_REQUIRED');
  }
  for (const value of [undefined, '', 'Basic secret', 'Bearer malformed', 'Bearer ' + 'a'.repeat(16385)]) {
    await assert.rejects(verify(value), { code: 'AUTHENTICATION_REQUIRED' });
  }
});

test('untrusted signatures are rejected without exposing JWT material', async () => {
  const other = await generateKeyPair('RS256');
  const jwt = await new SignJWT({ iss: fixtureIssuer, sub: 'sensitive-subject', sid: 'sensitive-session',
    aud: 'paperquay-sync', azp: 'paperquay-test', iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: 'RS256' }).sign(other.privateKey);
  await assert.rejects(verify(`Bearer ${jwt}`), (error: unknown) => error instanceof ApiError
    && error.message === 'AUTHENTICATION_REQUIRED' && !JSON.stringify(error).includes('sensitive'));
});

test('identity-provider connection failure is retryable without exposing network details', async () => {
  const unavailable = await createOidcVerifier({ issuer: fixtureIssuer, audience: 'paperquay-sync',
    clientIds: ['paperquay-test'], keyResolver: async () => {
      throw new TypeError('fetch failed for private-host', { cause: Object.assign(new Error('private-url'), { code: 'ECONNREFUSED' }) });
    } });
  await assert.rejects(unavailable(await token()), (error: unknown) => error instanceof ApiError
    && error.code === 'IDENTITY_PROVIDER_UNAVAILABLE' && error.statusCode === 503
    && !JSON.stringify(error).includes('private'));
});
