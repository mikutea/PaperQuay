import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { parseAppConfig } from '../src/config.ts';
import { describeError, errorFromResponse } from '../src/errors.ts';
import { buildOidcSettings } from '../src/auth/oidc.ts';

const input = {
  apiBaseUrl: 'https://sync.example.test/',
  oidcAuthority: 'https://id.example.test/realms/paperquay',
  oidcClientId: 'paperquay-mobile',
};

test('public configuration accepts HTTPS and local development but rejects credential-bearing or remote HTTP URLs', () => {
  const config = parseAppConfig(input, 'https://app.example.test');
  assert.equal(config.redirectUri, 'https://app.example.test/auth/callback');
  assert.equal(config.apiBaseUrl, 'https://sync.example.test');
  assert.equal(
    parseAppConfig({ ...input, apiBaseUrl: 'http://127.0.0.1:4310' }, 'http://127.0.0.1:1430')
      .apiBaseUrl,
    'http://127.0.0.1:4310',
  );
  for (const apiBaseUrl of [
    'http://remote.example.test',
    'https://user:secret@example.test',
    'https://example.test?token=secret',
    'https://example.test/#secret',
    'file:///private',
  ]) {
    assert.throws(() => parseAppConfig({ ...input, apiBaseUrl }, 'https://app.example.test'), {
      code: 'CONFIG_INVALID',
    });
  }
  assert.throws(() => parseAppConfig({}, 'https://app.example.test'), { code: 'CONFIG_MISSING' });
});

test('OIDC uses Code+PKCE and keeps tokens separate from transient session storage', async () => {
  const transient = new InMemoryWebStorage();
  const config = parseAppConfig(input, 'https://app.example.test');
  const settings = buildOidcSettings(config, transient);
  assert.equal(settings.response_type, 'code');
  assert.equal(settings.disablePKCE, false);
  assert.equal(settings.client_secret, undefined);
  await settings.userStore!.set('test-user', 'access-token-sentinel');
  await settings.stateStore!.set('test-state', 'pkce-state');
  assert.ok(transient.getItem('paperquay.auth.user.test-user') == null);
  assert.equal(transient.getItem('paperquay.auth.state.test-state'), 'pkce-state');
  const afterReload = buildOidcSettings(config, transient);
  assert.ok((await afterReload.userStore!.get('test-user')) == null);
});

test('raw provider, network and server errors are not displayed or retained as causes', () => {
  const detail = 'token=private /home/user/library secret-note';
  assert.ok(!describeError(new Error(detail)).includes(detail));
  assert.equal(errorFromResponse(401, detail).code, 'AUTH_REQUIRED');
  assert.equal(errorFromResponse(403, 'SESSION_REVOKED').code, 'SESSION_REVOKED');
  assert.equal(errorFromResponse(503).retryable, true);
});
