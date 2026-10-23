import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../../src/app.ts';
import { createOidcVerifier } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { PostgresSyncStore } from '../../src/store.ts';
import { operation, paper } from '../fixtures.ts';

if (process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1' || !process.env.PAPERQUAY_TEST_PASSWORD) {
  throw new Error('Real OIDC integration requires an isolated realm, PAPERQUAY_TEST_PASSWORD and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}
const config = loadConfig();
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.oidcIssuer).hostname)) {
  throw new Error('The password-grant fixture is restricted to a loopback test identity provider.');
}
const clientId = process.env.PAPERQUAY_TEST_CLIENT_ID || 'paperquay-integration';
const username = process.env.PAPERQUAY_TEST_USERNAME || 'qa-reader';
const otherUsername = process.env.PAPERQUAY_TEST_OTHER_USERNAME || 'qa-other';

interface Tokens { access_token: string; refresh_token: string; id_token?: string }
async function tokens(fields: Record<string, string>): Promise<Tokens> {
  const response = await fetch(`${config.oidcIssuer}/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: 'openid', ...fields }),
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  // Do not include response bodies, credentials or tokens in assertion diagnostics.
  assert.equal(response.status, 200, 'Isolated OIDC fixture token endpoint must accept the test grant.');
  const result: unknown = await response.json();
  assert.ok(result && typeof result === 'object' && 'access_token' in result && typeof result.access_token === 'string');
  assert.ok('refresh_token' in result && typeof result.refresh_token === 'string');
  return result as Tokens;
}

test('real Keycloak discovery/JWKS/access tokens, refreshed sessions and two-account API isolation', async (t) => {
  const repository = new PostgresSyncStore({ connectionString: config.databaseUrl, cursorSecret: config.cursorSecret });
  const verify = await createOidcVerifier({ issuer: config.oidcIssuer, audience: config.oidcAudience, clientIds: config.oidcClientIds });
  const app = await buildApp({ config, repository, verifyToken: verify, rateLimitEnabled: false });
  t.after(async () => { await app.close(); await repository.close(); });
  const [a, b] = await Promise.all([
    tokens({ grant_type: 'password', username, password: process.env.PAPERQUAY_TEST_PASSWORD! }),
    tokens({ grant_type: 'password', username: otherUsername, password: process.env.PAPERQUAY_TEST_PASSWORD! }),
  ]);
  const authA = { authorization: `Bearer ${a.access_token}` };
  const authB = { authorization: `Bearer ${b.access_token}` };
  const registrationA = await app.inject({ method: 'POST', url: '/v1/devices', headers: authA, payload: { name: 'Real OIDC A', platform: 'web' } });
  const registrationB = await app.inject({ method: 'POST', url: '/v1/devices', headers: authB, payload: { name: 'Real OIDC B', platform: 'web' } });
  assert.equal(registrationA.statusCode, 200); assert.equal(registrationB.statusCode, 200);
  const accountA = registrationA.json(); const accountB = registrationB.json();
  assert.notEqual(accountA.accountId, accountB.accountId);
  assert.notEqual(accountA.device.id, accountB.device.id);
  const refresh = await tokens({ grant_type: 'refresh_token', refresh_token: a.refresh_token });
  const authRefreshed = { authorization: `Bearer ${refresh.access_token}` };
  const refreshed = await app.inject({ method: 'GET', url: '/v1/me', headers: authRefreshed });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.json().device.id, accountA.device.id, 'Refresh preserves the OIDC session binding.');
  if (a.id_token) {
    const idTokenResponse = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${a.id_token}` } });
    assert.equal(idTokenResponse.statusCode, 401, 'ID-token client audience cannot authorize the sync API.');
  }
  const op = operation('paper', paper(`Real OIDC isolation fixture ${randomUUID()}`));
  const pushed = await app.inject({ method: 'POST', url: '/v1/sync/push', headers: authRefreshed,
    payload: { protocolVersion: 1, deviceId: accountA.device.id, operations: [op] } });
  assert.equal(pushed.statusCode, 200);
  assert.equal(pushed.json().results[0].status, 'applied');
  const replay = await app.inject({ method: 'POST', url: '/v1/sync/push', headers: authRefreshed,
    payload: { protocolVersion: 1, deviceId: accountA.device.id, operations: [op] } });
  assert.equal(replay.json().results[0].replayed, true);
  const ownFeed = await app.inject({ method: 'GET', url: '/v1/sync/pull?limit=1000', headers: authRefreshed });
  const foreignCursor = await app.inject({ method: 'GET', url: '/v1/sync/pull?cursor=' + encodeURIComponent(ownFeed.json().nextCursor), headers: authB });
  assert.equal(foreignCursor.statusCode, 400);
  assert.equal(foreignCursor.json().error.code, 'CURSOR_INVALID');
  const otherFeed = await app.inject({ method: 'GET', url: '/v1/sync/pull?limit=1000', headers: authB });
  assert.equal(otherFeed.statusCode, 200);
  assert.ok(otherFeed.json().records.every((record: { entityId: string }) => record.entityId !== op.entityId));
  const spoofedDevice = await app.inject({ method: 'POST', url: '/v1/sync/push', headers: authB,
    payload: { protocolVersion: 1, deviceId: accountA.device.id, operations: [operation('paper', paper())] } });
  assert.equal(spoofedDevice.statusCode, 403);
  assert.equal(spoofedDevice.json().error.code, 'DEVICE_SESSION_MISMATCH');
  const revoked = await app.inject({ method: 'DELETE', url: `/v1/devices/${accountA.device.id}`, headers: authRefreshed });
  assert.equal(revoked.statusCode, 200);
  for (const headers of [authA, authRefreshed]) {
    const blocked = await app.inject({ method: 'GET', url: '/v1/me', headers });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().error.code, 'SESSION_REVOKED');
  }
  const blockedRegistration = await app.inject({ method: 'POST', url: '/v1/devices', headers: authRefreshed,
    payload: { name: 'Cannot bypass revocation', platform: 'web' } });
  assert.equal(blockedRegistration.statusCode, 403);
  assert.equal(blockedRegistration.json().error.code, 'SESSION_REVOKED');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: authB })).statusCode, 200);
  await app.inject({ method: 'DELETE', url: `/v1/devices/${accountB.device.id}`, headers: authB });
});
