import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Disposable local/CI identity provider only. Never import this realm into a
// production Keycloak: its direct-grant client exists solely for integration tests.
const output = process.argv[2];
const password = process.env.PAPERQUAY_TEST_PASSWORD;
if (!output || !password || password.length < 16) {
  throw new Error('Provide an output path and a generated PAPERQUAY_TEST_PASSWORD (at least 16 characters).');
}
const audience = {
  name: 'paperquay-sync-audience',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-audience-mapper',
  consentRequired: false,
  config: { 'included.custom.audience': 'paperquay-sync', 'id.token.claim': 'false', 'access.token.claim': 'true' },
};
const realm = {
  realm: 'paperquay-local', enabled: true, displayName: 'PaperQuay 本机测试',
  registrationAllowed: false, resetPasswordAllowed: false, sslRequired: 'external',
  accessTokenLifespan: 300,
  clients: [
    {
      clientId: 'paperquay-mobile', name: 'PaperQuay 本机开发', enabled: true,
      protocol: 'openid-connect', publicClient: true, standardFlowEnabled: true,
      directAccessGrantsEnabled: false, implicitFlowEnabled: false,
      redirectUris: ['http://127.0.0.1:4317/auth/callback', 'http://127.0.0.1:4318/auth/callback'],
      webOrigins: ['http://127.0.0.1:4317', 'http://127.0.0.1:4318'],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': 'http://127.0.0.1:4317/##http://127.0.0.1:4318/',
      },
      protocolMappers: [audience],
    },
    {
      clientId: 'paperquay-integration', name: 'Disposable integration tests ONLY', enabled: true,
      protocol: 'openid-connect', publicClient: true, standardFlowEnabled: false,
      directAccessGrantsEnabled: true, implicitFlowEnabled: false,
      protocolMappers: [audience],
    },
  ],
  users: ['qa-reader', 'qa-other'].map((username) => ({
    username, enabled: true, emailVerified: true, email: `${username}@example.invalid`,
    firstName: 'PaperQuay', lastName: 'Test', requiredActions: [],
    credentials: [{ type: 'password', value: password, temporary: false }],
  })),
};
const target = resolve(output);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(realm, null, 2) + '\n', { mode: 0o600 });
console.log('Created disposable test realm (credentials omitted).');
