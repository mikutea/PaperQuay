import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { parseAppConfig, NATIVE_REDIRECT_URI } from '../src/config.ts';
import { NativeOidcSession, nativeAuthNamespace, nativeCallback, type NativeAuthBridge } from '../src/auth/nativeOidc.ts';
import { SecureOidcStateStore } from '../src/auth/secureStateStore.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';

const config = parseAppConfig({ apiBaseUrl: 'https://sync.example.test', oidcAuthority: 'https://id.example.test/realms/paperquay', oidcClientId: 'paperquay-mobile' }, 'capacitor://localhost', true);
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class Bridge implements NativeAuthBridge {
  urls: string[] = [];
  closes = 0;
  removed = 0;
  launch?: string;
  listener?: (url: string) => void;
  finished?: () => void;
  async open(url: string) { this.urls.push(url); }
  async close() { this.closes += 1; }
  async listen(listener: (url: string) => void) { this.listener = listener; return async () => { this.removed += 1; this.listener = undefined; }; }
  async listenFinished(listener: () => void) { this.finished = listener; return async () => { this.finished = undefined; }; }
  async launchUrl() { return this.launch; }
}
function fixture(t: TestContext, secrets = new MemorySecretStore()) {
  const bridge = new Bridge();
  const exchangeEntered = deferred();
  const refreshEntered = deferred();
  let exchangeRelease: Promise<void> | undefined;
  let refreshRelease: Promise<void> | undefined;
  let exchanges = 0;
  let refreshes = 0;
  let lifetime = 3600;
  let includeRefresh = true;
  let refreshError: string | undefined;
  let alteredClaims: Record<string, unknown> = {};
  let nonceOverride: string | undefined;
  const bodies: URLSearchParams[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === `${config.oidcAuthority}/.well-known/openid-configuration`) return Response.json({ issuer: config.oidcAuthority,
      authorization_endpoint: `${config.oidcAuthority}/authorize`, token_endpoint: `${config.oidcAuthority}/token`, end_session_endpoint: `${config.oidcAuthority}/logout` });
    assert.equal(url, `${config.oidcAuthority}/token`);
    assert.equal(init?.credentials, 'omit');
    const body = new URLSearchParams(String(init?.body));
    bodies.push(body);
    const refresh = body.get('grant_type') === 'refresh_token';
    if (refresh) {
      refreshes += 1;
      refreshEntered.resolve(); await refreshRelease;
      if (refreshError) return Response.json({ error: refreshError, error_description: 'private-server-token' }, { status: 400 });
    } else {
      exchanges += 1; exchangeEntered.resolve(); await exchangeRelease;
    }
    const request = new URL(bridge.urls[0]);
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: config.oidcAuthority, sub: 'subject-one', aud: config.oidcClientId, sid: 'session-one', name: 'Paper reader', iat: now,
      exp: now + 3600, nonce: nonceOverride ?? request.searchParams.get('nonce'), ...alteredClaims };
    // This fixture exercises the real code-flow library's state/nonce/claim checks over a mocked TLS token response.
    const idToken = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-only' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
    return Response.json({ access_token: `access-${exchanges}-${refreshes}`, token_type: 'Bearer', expires_in: refresh ? 3600 : lifetime,
      ...(includeRefresh ? { refresh_token: `refresh-${refreshes}` } : {}), id_token: idToken, scope: 'openid profile offline_access' });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const session = new NativeOidcSession(config, { secrets, bridge });
  t.after(() => session.dispose());
  const callback = () => `${config.redirectUri}?code=code-one&state=${new URL(bridge.urls[0]).searchParams.get('state')}`;
  return { secrets, bridge, session, callback, bodies, exchangeEntered, refreshEntered,
    get exchanges() { return exchanges; }, get refreshes() { return refreshes; },
    set lifetime(value: number) { lifetime = value; }, set includeRefresh(value: boolean) { includeRefresh = value; },
    set refreshError(value: string | undefined) { refreshError = value; },
    set alteredClaims(value: Record<string, unknown>) { alteredClaims = value; },
    set nonceOverride(value: string | undefined) { nonceOverride = value; },
    set exchangeRelease(value: Promise<void> | undefined) { exchangeRelease = value; },
    set refreshRelease(value: Promise<void> | undefined) { refreshRelease = value; },
  };
}

test('native config and callback gate require exact scheme, host, path and single state/code', () => {
  assert.equal(config.redirectUri, NATIVE_REDIRECT_URI);
  const state = 'b'.repeat(32);
  assert.deepEqual(nativeCallback(`${config.redirectUri}?code=abc&state=${state}`, config.redirectUri), { state });
  for (const url of [
    `https://auth/callback?code=abc&state=${state}`, `dev.paperquay.mobile://wrong/callback?code=abc&state=${state}`,
    `dev.paperquay.mobile://auth/wrong?code=abc&state=${state}`, `${config.redirectUri}?code=abc&state=${state}&state=${state}`,
    `${config.redirectUri}?code=abc&code=two&state=${state}`, `${config.redirectUri}?code=abc&state=${state}#token`,
    `${config.redirectUri}?code=abc&error=failed&state=${state}`, `${config.redirectUri}?code=abc&state=${state}&access_token=secret`,
  ]) assert.throws(() => nativeCallback(url, config.redirectUri), { code: 'AUTH_FAILED' });
});

test('real OIDC client creates S256 PKCE plus nonce, consumes state once, and stores only through the secret adapter', async (t) => {
  const f = fixture(t);
  await f.session.signIn();
  const request = new URL(f.bridge.urls[0]);
  assert.equal(request.searchParams.get('response_type'), 'code');
  assert.equal(request.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(request.searchParams.get('redirect_uri'), config.redirectUri);
  assert.ok(request.searchParams.get('nonce'));
  assert.equal(f.session.getSnapshot().status, 'signing-in');
  await f.session.completeSignIn(f.callback());
  const verifier = f.bodies[0].get('code_verifier')!;
  assert.ok(verifier.length >= 43);
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), request.searchParams.get('code_challenge'));
  assert.equal(await f.session.getAccessToken(), 'access-1-0');
  assert.deepEqual(f.session.getSubject(), { issuer: config.oidcAuthority, subject: 'subject-one' });
  assert.ok(!JSON.stringify(f.session.getSnapshot()).includes('access-1-0'));
  assert.ok(await f.secrets.get(nativeAuthNamespace(config), 'session'));
  await f.session.completeSignIn(f.callback());
  assert.equal(f.exchanges, 1);
});

test('PKCE state survives process replacement and cold-launch callback completes once', async (t) => {
  const f = fixture(t);
  await f.session.signIn();
  await f.session.dispose();
  const secondBridge = new Bridge(); secondBridge.launch = f.callback();
  const restored = new NativeOidcSession(config, { secrets: f.secrets, bridge: secondBridge });
  t.after(() => restored.dispose());
  await restored.initialize();
  assert.equal(restored.getSnapshot().status, 'signed-in');
  assert.equal(await restored.getAccessToken(), 'access-1-0');
  secondBridge.listener?.(f.callback());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.exchanges, 1);
  assert.equal(f.bridge.removed, 1);
  await restored.dispose();
  const third = new NativeOidcSession(config, { secrets: f.secrets, bridge: new Bridge() });
  t.after(() => third.dispose());
  await third.initialize();
  assert.equal(third.getSnapshot().status, 'signed-in');
});

test('wrong state never exchanges a code; nonce mismatch cannot persist tokens', async (t) => {
  const f = fixture(t);
  await f.session.signIn();
  await assert.rejects(f.session.completeSignIn(`${config.redirectUri}?code=x&state=${'x'.repeat(32)}`), { code: 'AUTH_FAILED' });
  assert.equal(f.exchanges, 0);
  f.nonceOverride = 'wrong-nonce';
  await assert.rejects(f.session.completeSignIn(f.callback()), { code: 'AUTH_FAILED' });
  assert.equal(f.session.getSubject(), null);
  assert.equal(await f.secrets.get(nativeAuthNamespace(config), 'session'), null);
});

test('expired secure session restores its verified subject for offline data but never returns an expired access token', async (t) => {
  const f = fixture(t); f.includeRefresh = false;
  await f.session.signIn(); await f.session.completeSignIn(f.callback()); await f.session.dispose();
  const stored = JSON.parse((await f.secrets.get(nativeAuthNamespace(config), 'session'))!);
  const user = JSON.parse(stored.user); user.expires_at = Math.floor(Date.now() / 1000) - 1; stored.user = JSON.stringify(user);
  await f.secrets.set(nativeAuthNamespace(config), 'session', JSON.stringify(stored));
  const restored = new NativeOidcSession(config, { secrets: f.secrets, bridge: new Bridge() });
  t.after(() => restored.dispose());
  await restored.initialize();
  assert.deepEqual(restored.getSubject(), { issuer: config.oidcAuthority, subject: 'subject-one' });
  assert.equal(restored.getSnapshot().status, 'signed-in'); assert.equal(restored.getSnapshot().needsLogin, true);
  await assert.rejects(restored.getAccessToken(), { code: 'AUTH_REQUIRED' });
  assert.equal(f.exchanges, 1);
});

test('refresh is single-flight, rotates the stored credential and rejects changed subject/session', async (t) => {
  const f = fixture(t); f.lifetime = 10;
  await f.session.signIn(); await f.session.completeSignIn(f.callback());
  const results = await Promise.all([f.session.getAccessToken(), f.session.getAccessToken()]);
  assert.deepEqual(results, ['access-1-1', 'access-1-1']); assert.equal(f.refreshes, 1);
  const stored = JSON.parse((await f.secrets.get(nativeAuthNamespace(config), 'session'))!);
  assert.equal(JSON.parse(stored.user).refresh_token, 'refresh-1');
  await f.session.dispose();
  const user = JSON.parse(stored.user); user.expires_at = 1; stored.user = JSON.stringify(user);
  await f.secrets.set(nativeAuthNamespace(config), 'session', JSON.stringify(stored));
  f.alteredClaims = { sid: 'different-session' };
  const restored = new NativeOidcSession(config, { secrets: f.secrets, bridge: new Bridge() });
  t.after(() => restored.dispose());
  await assert.rejects(restored.getAccessToken(), { code: 'AUTH_REQUIRED' });
  assert.equal(restored.getSnapshot().needsLogin, true);
  assert.equal(restored.getSubject()?.subject, 'subject-one');
  await assert.rejects(restored.getAccessToken(), { code: 'AUTH_REQUIRED' });
  assert.equal(f.refreshes, 2);
});

test('logout invalidates an in-flight token exchange and prevents token resurrection', async (t) => {
  const f = fixture(t); const release = deferred(); f.exchangeRelease = release.promise;
  await f.session.signIn();
  const completing = f.session.completeSignIn(f.callback());
  await f.exchangeEntered.promise;
  await f.session.clearLocalSession();
  release.resolve();
  await assert.rejects(completing, { code: 'ACCOUNT_CHANGED' });
  assert.equal(f.session.getSnapshot().status, 'signed-out');
  assert.equal(f.session.getSubject(), null);
  assert.equal(await f.secrets.get(nativeAuthNamespace(config), 'session'), null);
  await assert.rejects(f.session.getAccessToken(), { code: 'AUTH_REQUIRED' });
});

test('logout waits for an already-started secure write then removes it without resurrection', async (t) => {
  const entered = deferred(); const release = deferred();
  class SlowSecrets extends MemorySecretStore {
    async set(namespace: string, key: string, value: string) {
      if (key === 'session') { entered.resolve(); await release.promise; }
      await super.set(namespace, key, value);
    }
  }
  const f = fixture(t, new SlowSecrets());
  await f.session.signIn();
  const completing = f.session.completeSignIn(f.callback());
  await entered.promise;
  const clearing = f.session.clearLocalSession();
  release.resolve();
  await assert.rejects(completing, { code: 'ACCOUNT_CHANGED' }); await clearing;
  assert.equal(await f.secrets.get(nativeAuthNamespace(config), 'session'), null);
  assert.equal(f.session.getSnapshot().status, 'signed-out');
});

test('secure pending state has a ten-minute bound and shared updates do not lose another state', async () => {
  const secrets = new MemorySecretStore();
  const one = new SecureOidcStateStore(secrets, 'test'); const two = new SecureOidcStateStore(secrets, 'test');
  await Promise.all([one.set('a'.repeat(32), 'a'), two.set('b'.repeat(32), 'b')]);
  assert.equal((await one.getAllKeys()).length, 2);
  await one.remove('a'.repeat(32)); assert.equal(await two.get('b'.repeat(32)), 'b');
  await secrets.set('test', 'pending-state', JSON.stringify({ ['c'.repeat(32)]: { value: 'old-verifier', expiresAt: Date.now() - 1 } }));
  assert.equal(await one.get('c'.repeat(32)), null);
  await one.clear(); assert.equal(await secrets.get('test', 'pending-state'), null);
});

test('closing the system browser enables retry and a callback already in native delivery can still finish', async (t) => {
  const f = fixture(t);
  await f.session.signIn(); f.bridge.finished?.();
  assert.equal(f.session.getSnapshot().status, 'error');
  await f.session.completeSignIn(f.callback());
  assert.equal(f.session.getSnapshot().status, 'signed-in');
  f.bridge.finished?.();
  assert.equal(f.session.getSnapshot().status, 'signed-in');
});

test('disposing while native listener registration is pending removes the late listener', async () => {
  const entered = deferred(); const release = deferred(); let removed = 0;
  const bridge: NativeAuthBridge = {
    open: async () => undefined, close: async () => undefined, launchUrl: async () => undefined,
    listen: async () => { entered.resolve(); await release.promise; return async () => { removed += 1; }; },
  };
  const session = new NativeOidcSession(config, { secrets: new MemorySecretStore(), bridge });
  const initialization = session.initialize(); await entered.promise; await session.dispose(); release.resolve(); await initialization;
  assert.equal(removed, 1); assert.equal(session.getSubject(), null);
});

test('invalid_grant blocks credential reuse across cold restart while preserving the verified offline subject', async (t) => {
  const f = fixture(t); f.lifetime = 10;
  await f.session.signIn(); await f.session.completeSignIn(f.callback());
  f.refreshError = 'invalid_grant';
  await assert.rejects(f.session.getAccessToken(), { code: 'AUTH_REQUIRED' });
  assert.equal(f.session.getSnapshot().needsLogin, true);
  await f.session.dispose();
  const restored = new NativeOidcSession(config, { secrets: f.secrets, bridge: new Bridge() });
  t.after(() => restored.dispose());
  await restored.initialize();
  assert.equal(restored.getSubject()?.subject, 'subject-one');
  await assert.rejects(restored.getAccessToken(), { code: 'AUTH_REQUIRED' });
  assert.equal(f.refreshes, 1);
});

test('late refresh cannot restore credentials or change signed-out state after local logout', async (t) => {
  const f = fixture(t); f.lifetime = 10;
  await f.session.signIn(); await f.session.completeSignIn(f.callback());
  const release = deferred(); f.refreshRelease = release.promise;
  const refreshing = f.session.getAccessToken(); await f.refreshEntered.promise;
  await f.session.clearLocalSession(); release.resolve();
  await assert.rejects(refreshing, { code: 'AUTH_REQUIRED' });
  assert.equal(f.session.getSnapshot().status, 'signed-out');
  assert.equal(f.session.getSubject(), null);
  assert.equal(await f.secrets.get(nativeAuthNamespace(config), 'session'), null);
});
