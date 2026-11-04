import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const require = createRequire(import.meta.url);
const { createDesktopOidcSession, validateDesktopAccountConfig } = require('../electron/backend/desktopOidc.cjs');
const key = await generateKeyPair('RS256');
const otherKey = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(key.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };

async function fixture(options = {}) {
  let authorization;
  let callbackResponse;
  let refreshCount = 0;
  let grantCount = 0;
  let releaseRefresh;
  const refreshStarted = new Promise((resolve) => { releaseRefresh = resolve; });
  const server = http.createServer(async (request, response) => {
    const json = (body) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
    if (request.url === '/.well-known/openid-configuration') {
      json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: options.foreignEndpoint || `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true });
    } else if (request.url === '/jwks') json({ keys: [jwk] });
    else if (request.url === '/token') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const parameters = new URLSearchParams(Buffer.concat(chunks).toString());
      const isRefresh = parameters.get('grant_type') === 'refresh_token';
      if (isRefresh) { refreshCount += 1; releaseRefresh(); if (options.refreshBarrier) await options.refreshBarrier; }
      else {
        grantCount += 1;
        assert.equal(parameters.get('client_id'), 'desktop-test');
        assert.equal(parameters.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
        assert.equal(createHash('sha256').update(parameters.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
      }
      if (options.oversizedTokenBody) { response.setHeader('Content-Type', 'application/json'); response.end('x'.repeat(1024 * 1024 + 1)); return; }
      const claims = { sid: isRefresh && options.changedSid ? 'other-session' : 'test-session',
        name: 'Desktop Test', ...(isRefresh ? {} : { nonce: options.badNonce ? 'wrong-nonce' : authorization.searchParams.get('nonce') }) };
      const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(issuer).setAudience(options.badAudience ? 'wrong-client' : 'desktop-test')
        .setSubject(isRefresh && options.changedSubject ? 'other-user' : 'test-user')
        .setIssuedAt().setExpirationTime('5m').sign(options.badSignature || isRefresh && options.badRefreshSignature ? otherKey.privateKey : key.privateKey);
      const omitIdToken = isRefresh ? options.refreshWithoutIdToken : options.signInWithoutIdToken;
      json({ access_token: isRefresh && options.invalidRefreshAccessToken ? '' : `dummy-access-${isRefresh ? 'refreshed' : 'initial'}`, token_type: 'Bearer', ...(omitIdToken ? {} : { id_token: idToken }),
        refresh_token: 'dummy-refresh', expires_in: isRefresh ? 300 : (options.shortExpiry ? 1 : 300) });
    } else { response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const issuer = `http://127.0.0.1:${server.address().port}`;
  let opened;
  const browserOpened = new Promise((resolve) => { opened = resolve; });
  const auth = createDesktopOidcSession({
    openExternal(url) {
      authorization = new URL(url);
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorization.searchParams.get('response_type'), 'code');
      assert.equal(authorization.searchParams.get('scope'), 'openid profile');
      opened();
      if (options.manualCallback) return;
      const callback = callbackUrl();
      callbackResponse = (async () => {
        if (options.badStateFirst) {
          const malformed = await new Promise((resolve, reject) => {
            const request = http.request({ hostname: callback.hostname, port: callback.port, path: '//[', method: 'GET' }, (response) => {
              response.resume(); response.once('end', () => resolve(response.statusCode));
            });
            request.once('error', reject); request.end();
          });
          assert.equal(malformed, 400);
          const incorrect = new URL(callback); incorrect.searchParams.set('state', 'wrong');
          assert.equal((await fetch(incorrect)).status, 400);
        }
        return fetch(callback);
      })();
      callbackResponse.catch(() => {});
    },
  });
  function callbackUrl() {
    const url = new URL(authorization.searchParams.get('redirect_uri'));
    url.searchParams.set('state', authorization.searchParams.get('state'));
    url.searchParams.set('code', 'test-code'); url.searchParams.set('iss', issuer);
    return url;
  }
  return {
    auth, config: { apiBaseUrl: issuer, oidcIssuer: issuer, oidcClientId: 'desktop-test' },
    browserOpened, refreshStarted, callbackUrl, callbackResponse: () => callbackResponse,
    counters: () => ({ refreshCount, grantCount }),
    async close() { auth.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

test('desktop account configuration accepts TLS and local development only', () => {
  for (const url of ['http://example.com', 'file:///secret', 'https://user:pass@example.com', 'https://example.com/?secret=1']) {
    assert.throws(() => validateDesktopAccountConfig({ apiBaseUrl: url, oidcIssuer: url, oidcClientId: 'desktop-test' }), /ACCOUNT_CONFIGURATION_INVALID/);
  }
  assert.equal(validateDesktopAccountConfig({ apiBaseUrl: 'https://sync.example/', oidcIssuer: 'https://id.example/realm/', oidcClientId: 'desktop-test' }).oidcIssuer, 'https://id.example/realm');
});

test('real PKCE code exchange verifies signed ID token and closes callback listener', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  await f.auth.signIn(f.config);
  assert.equal(f.auth.getSnapshot().status, 'signed-in');
  assert.equal(f.auth.getSnapshot().displayName, 'Desktop Test');
  assert.equal(await f.auth.getAccessToken(), 'dummy-access-initial');
  const response = await f.callbackResponse();
  assert.equal(response.status, 200); assert.match(await response.text(), /completed/);
  assert.equal(JSON.stringify(f.auth.getSnapshot()).includes('dummy-'), false);
  await assert.rejects(fetch(f.callbackUrl()));
  await f.auth.signOut();
  assert.deepEqual(f.auth.getSnapshot(), { status: 'signed-out' });
  await assert.rejects(f.auth.getAccessToken(), /AUTHENTICATION_REQUIRED/);
});

test('malformed callback path and incorrect state cannot crash or consume the real login', async (t) => {
  const f = await fixture({ badStateFirst: true }); t.after(() => f.close());
  await f.auth.signIn(f.config);
  assert.equal(f.auth.getSnapshot().status, 'signed-in');
  assert.equal(f.counters().grantCount, 1);
});

for (const option of ['badNonce', 'badAudience', 'badSignature', 'oversizedTokenBody']) {
  test(`invalid identity response is rejected: ${option}`, async (t) => {
    const f = await fixture({ [option]: true }); t.after(() => f.close());
    await assert.rejects(f.auth.signIn(f.config), /AUTH_SIGN_IN_FAILED/);
    assert.equal(f.auth.getSnapshot().status, 'error');
    await assert.rejects(f.auth.getAccessToken(), /AUTHENTICATION_REQUIRED/);
  });
}

test('metadata cannot send authorization or tokens to another origin', async (t) => {
  const f = await fixture({ foreignEndpoint: 'http://127.0.0.1:1/token' }); t.after(() => f.close());
  await assert.rejects(f.auth.signIn(f.config), /AUTH_SIGN_IN_FAILED/);
  assert.equal(f.counters().grantCount, 0);
});

test('cancel login closes loopback and late callbacks cannot restore identity', async (t) => {
  const f = await fixture({ manualCallback: true }); t.after(() => f.close());
  const operation = f.auth.signIn(f.config);
  await f.browserOpened;
  const callback = f.callbackUrl(); f.auth.cancelSignIn();
  await assert.rejects(operation, /AUTH_CANCELLED/);
  await assert.rejects(fetch(callback));
  assert.deepEqual(f.auth.getSnapshot(), { status: 'signed-out' });
});

test('concurrent token callers share one early refresh', async (t) => {
  const f = await fixture({ shortExpiry: true }); t.after(() => f.close());
  await f.auth.signIn(f.config);
  const tokens = await Promise.all([f.auth.getAccessToken(), f.auth.getAccessToken(), f.auth.getAccessToken()]);
  assert.deepEqual(tokens, Array(3).fill('dummy-access-refreshed'));
  assert.equal(f.counters().refreshCount, 1);
});

test('refresh without a new ID token preserves the verified identity and shares the replacement access token', async (t) => {
  const f = await fixture({ shortExpiry: true, refreshWithoutIdToken: true }); t.after(() => f.close());
  await f.auth.signIn(f.config);
  const before = f.auth.getSnapshot();
  const tokens = await Promise.all([f.auth.getAccessToken(), f.auth.getAccessToken(), f.auth.getAccessToken()]);
  assert.deepEqual(tokens, Array(3).fill('dummy-access-refreshed'));
  assert.equal(f.counters().refreshCount, 1);
  assert.equal(f.auth.getSnapshot().status, 'signed-in');
  assert.equal(f.auth.getSnapshot().displayName, before.displayName);
  assert(f.auth.getSnapshot().expiresAt > before.expiresAt);
  assert.equal(await f.auth.getAccessToken(), 'dummy-access-refreshed');
  assert.equal(f.counters().refreshCount, 1);
});

test('initial sign-in still requires a signed ID token', async (t) => {
  const f = await fixture({ signInWithoutIdToken: true }); t.after(() => f.close());
  await assert.rejects(f.auth.signIn(f.config), /AUTH_SIGN_IN_FAILED/);
  await assert.rejects(f.auth.getAccessToken(), /AUTHENTICATION_REQUIRED/);
});

for (const option of ['badRefreshSignature', 'invalidRefreshAccessToken']) {
  test(`optional refresh ID tokens do not bypass token validation: ${option}`, async (t) => {
    const f = await fixture({ shortExpiry: true, [option]: true, refreshWithoutIdToken: option === 'invalidRefreshAccessToken' }); t.after(() => f.close());
    await f.auth.signIn(f.config);
    await assert.rejects(f.auth.getAccessToken(), /AUTHENTICATION_REQUIRED/);
    assert.equal(f.auth.getSnapshot().status, 'error');
  });
}

test('sign-out during refresh without an ID token cannot restore the previous identity', async (t) => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const f = await fixture({ shortExpiry: true, refreshWithoutIdToken: true, refreshBarrier: barrier });
  t.after(() => { release(); return f.close(); });
  await f.auth.signIn(f.config);
  const token = f.auth.getAccessToken();
  await f.refreshStarted; await f.auth.signOut(); release();
  await assert.rejects(token, /AUTHENTICATION_REQUIRED/);
  assert.deepEqual(f.auth.getSnapshot(), { status: 'signed-out' });
});

for (const option of ['changedSubject', 'changedSid']) {
  test(`refresh cannot change the account or session: ${option}`, async (t) => {
    const f = await fixture({ shortExpiry: true, [option]: true }); t.after(() => f.close());
    await f.auth.signIn(f.config);
    await assert.rejects(f.auth.getAccessToken(), /AUTHENTICATION_REQUIRED/);
    assert.equal(f.auth.getSnapshot().errorCode, 'AUTH_SESSION_CHANGED');
  });
}

test('sign out during refresh cancels I/O and never re-adopts a late token', async (t) => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const f = await fixture({ shortExpiry: true, refreshBarrier: barrier });
  t.after(() => { release(); return f.close(); });
  await f.auth.signIn(f.config);
  const token = f.auth.getAccessToken();
  await f.refreshStarted; await f.auth.signOut();
  release();
  await assert.rejects(token, /AUTHENTICATION_REQUIRED/);
  assert.deepEqual(f.auth.getSnapshot(), { status: 'signed-out' });
});
