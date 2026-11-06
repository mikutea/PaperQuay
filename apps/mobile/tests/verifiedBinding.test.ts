import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountIdentity } from '../src/api.ts';
import type { AuthSubject } from '../src/auth/oidc.ts';
import { parseAppConfig } from '../src/config.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';
import { verifiedBinding } from '../src/storage/verifiedBinding.ts';

const config = parseAppConfig({ apiBaseUrl: 'https://sync.example.test', oidcAuthority: 'https://id.example.test/realms/paperquay', oidcClientId: 'paperquay-mobile' }, 'https://app.example.test');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = '2026-10-25T12:00:00.000Z';
const identity = (accountId = A): AccountIdentity => ({ accountId, device: { id: DEVICE, name: 'Saved device', platform: 'ios', createdAt: NOW, lastSeenAt: NOW, revokedAt: null } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('verified binding starts empty, restores parsed identity, and isolates API, issuer, client and subject', async () => {
  const secrets = new MemorySecretStore();
  const subject: AuthSubject = { issuer: config.oidcAuthority, subject: 'subject-a' };
  const binding = verifiedBinding(config, secrets, () => subject);
  assert.equal(await binding.read(), null);
  await binding.write(identity());
  assert.deepEqual(await verifiedBinding(config, secrets, () => subject).read(), identity());
  const variants = [
    { ...config, apiBaseUrl: 'https://other-sync.example.test' },
    { ...config, oidcAuthority: 'https://other-id.example.test/realms/paperquay' },
    { ...config, oidcClientId: 'other-client' },
  ];
  for (const variant of variants) {
    const other = verifiedBinding(variant, secrets, () => ({ ...subject, issuer: variant.oidcAuthority }));
    assert.equal(await other.read(), null);
    assert.notEqual(other.key(), binding.key());
  }
  assert.equal(await verifiedBinding(config, secrets, () => ({ ...subject, subject: 'subject-b' })).read(), null);
  await assert.rejects(verifiedBinding(config, secrets, () => ({ ...subject, issuer: 'https://wrong.example.test' })).read(), { code: 'AUTH_REQUIRED' });
  await assert.rejects(verifiedBinding(config, secrets, () => null).read(), { code: 'AUTH_REQUIRED' });
});

test('invalid or revoked identity cannot enter the verified cache and malformed persisted rows fail closed', async () => {
  class CapturingSecrets extends MemorySecretStore {
    address?: [string, string];
    writes = 0;
    async set(namespace: string, key: string, value: string) { this.address = [namespace, key]; this.writes += 1; await super.set(namespace, key, value); }
  }
  const secrets = new CapturingSecrets();
  const binding = verifiedBinding(config, secrets, () => ({ issuer: config.oidcAuthority, subject: 'a' }));
  await assert.rejects(binding.write({ ...identity(), accountId: 'untrusted-account' }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(binding.write({ ...identity(), device: { ...identity().device, revokedAt: NOW } }), { code: 'SESSION_REVOKED' });
  assert.equal(secrets.writes, 0);
  await binding.write(identity());
  await secrets.set(...secrets.address!, '{malformed');
  await assert.rejects(binding.read(), { code: 'STORAGE_CORRUPT' });
});

test('a pending cache read cannot return a previous subject after auth switches before React cleanup', async () => {
  const entered = deferred(); const release = deferred();
  class SlowSecrets extends MemorySecretStore {
    delayed = false;
    async get(namespace: string, key: string) {
      const value = await super.get(namespace, key);
      if (this.delayed) { entered.resolve(); await release.promise; }
      return value;
    }
  }
  const secrets = new SlowSecrets(); let sub = 'subject-a';
  const binding = verifiedBinding(config, secrets, () => ({ issuer: config.oidcAuthority, subject: sub }));
  await binding.write(identity()); secrets.delayed = true;
  const reading = binding.read(); await entered.promise; sub = 'subject-b'; release.resolve();
  await assert.rejects(reading, { code: 'ACCOUNT_CHANGED' });
});

test('a late previous-subject cache write cannot overwrite the new subject mapping', async () => {
  const entered = deferred(); const release = deferred();
  class SlowSecrets extends MemorySecretStore {
    async set(namespace: string, key: string, value: string) {
      if (JSON.parse(value).subject === 'subject-a') { entered.resolve(); await release.promise; }
      await super.set(namespace, key, value);
    }
  }
  const secrets = new SlowSecrets(); let sub = 'subject-a';
  const binding = verifiedBinding(config, secrets, () => ({ issuer: config.oidcAuthority, subject: sub }));
  const writing = binding.write(identity(A)); const oldResult = assert.rejects(writing, { code: 'ACCOUNT_CHANGED' });
  await entered.promise; sub = 'subject-b'; await binding.write(identity(B)); release.resolve(); await oldResult;
  assert.deepEqual(await binding.read(), identity(B));
});

test('removing a revoked subject mapping does not erase another subject cache', async () => {
  const secrets = new MemorySecretStore(); let sub = 'subject-a';
  const binding = verifiedBinding(config, secrets, () => ({ issuer: config.oidcAuthority, subject: sub }));
  await binding.write(identity(A)); sub = 'subject-b'; await binding.write(identity(B));
  sub = 'subject-a'; await binding.remove(); sub = 'subject-b';
  assert.deepEqual(await binding.read(), identity(B));
});
