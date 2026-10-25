import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { checkedHttpUrl, loadConfig, SERVER_LIMITS } from '../../src/config.ts';
import { CursorCodec } from '../../src/cursor.ts';
import { operationHash, PostgresSyncStore } from '../../src/store.ts';
import { isTransientDatabaseError } from '../../src/errors.ts';
import { testConfig } from '../fixtures.ts';

test('listener is loopback by default and remote HTTP origins/issuers are rejected', () => {
  assert.equal(testConfig().host, '127.0.0.1');
  assert.throws(() => loadConfig({ PAPERQUAY_HOST: '0.0.0.0' }), { code: 'NON_LOOPBACK_NOT_ENABLED' });
  for (const url of ['http://remote.example.test', 'https://user:secret@example.test', 'https://example.test?a=b']) {
    assert.throws(() => checkedHttpUrl(url, true), { code: 'CONFIGURATION_INVALID' });
  }
  assert.equal(checkedHttpUrl('http://127.0.0.1:18081/realms/test', true).hostname, '127.0.0.1');
});

test('only the exact Capacitor loopback origin is accepted outside HTTP origins', () => {
  assert.deepEqual(testConfig({ PAPERQUAY_ALLOWED_ORIGINS: 'capacitor://localhost,https://localhost' }).allowedOrigins,
    ['capacitor://localhost', 'https://localhost']);
  for (const origin of ['capacitor://evil.test', 'capacitor://localhost/', 'capacitor://user@localhost', 'file://', 'null', 'capacitor://localhost:123'])
    assert.throws(() => testConfig({ PAPERQUAY_ALLOWED_ORIGINS: origin }), { code: 'CONFIGURATION_INVALID' });
  assert.throws(() => testConfig({ PAPERQUAY_OIDC_ISSUER: 'capacitor://localhost' }), { code: 'CONFIGURATION_INVALID' });
});

test('retained-byte quota defaults to 256 MiB and rejects invalid or unbounded configuration before opening a pool', () => {
  assert.equal(testConfig().maxAccountRetainedBytes, 256 * 1024 * 1024);
  for (const limit of [1, 4096, SERVER_LIMITS.maxConfiguredAccountRetainedBytes]) {
    assert.equal(testConfig({ PAPERQUAY_MAX_ACCOUNT_RETAINED_BYTES: String(limit) }).maxAccountRetainedBytes, limit);
  }
  for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', 'unlimited', String(SERVER_LIMITS.maxConfiguredAccountRetainedBytes + 1)]) {
    assert.throws(() => testConfig({ PAPERQUAY_MAX_ACCOUNT_RETAINED_BYTES: value }), { code: 'CONFIGURATION_INVALID' });
  }
  for (const value of [0, -1, 0.5, NaN, Infinity, SERVER_LIMITS.maxConfiguredAccountRetainedBytes + 1]) {
    assert.throws(() => new PostgresSyncStore({ connectionString: 'never-connect', cursorSecret: Buffer.alloc(32),
      maxAccountRetainedBytes: value }), { code: 'CONFIGURATION_INVALID' });
  }
});

test('forwarded client addresses require an explicit bounded list of individual proxy IPs', () => {
  assert.deepEqual(testConfig().trustedProxyIps, []);
  assert.deepEqual(testConfig({ PAPERQUAY_TRUSTED_PROXY_IPS: '  ' }).trustedProxyIps, []);
  assert.deepEqual(testConfig({ PAPERQUAY_TRUSTED_PROXY_IPS: '127.0.0.1, ::1,192.0.2.10,2001:db8::a,127.0.0.1' }).trustedProxyIps,
    ['127.0.0.1', '::1', '192.0.2.10', '2001:db8::a']);
  for (const value of ['true', 'false', '*', '1', 'localhost', 'loopback', '0.0.0.0', '::', '0::0', '::ffff:0.0.0.0',
    '127.0.0.1/32', '198.51.100.0/24', '::1/128', '127.0.0.1,', ',127.0.0.1', 'fe80::1%eth0',
    Array.from({ length: 33 }, (_, index) => '192.0.2.' + (index + 1)).join(',')]) {
    assert.throws(() => testConfig({ PAPERQUAY_TRUSTED_PROXY_IPS: value }), { code: 'CONFIGURATION_INVALID' });
  }
});

test('opaque cursors reject tampering, another account/feed, and reset epochs', () => {
  const codec = new CursorCodec(Buffer.alloc(32, 18));
  const account = randomUUID(); const epoch = randomUUID();
  const cursor = codec.encode('changes', account, epoch, '17');
  assert.equal(codec.decode(cursor, 'changes', account, epoch), 17n);
  assert.equal(codec.decode(undefined, 'changes', account, epoch), 0n);
  assert.throws(() => codec.decode(cursor.replace(/^./, cursor[0] === 'a' ? 'b' : 'a'), 'changes', account, epoch), { code: 'CURSOR_INVALID' });
  assert.throws(() => codec.decode(cursor, 'changes', randomUUID(), epoch), { code: 'CURSOR_INVALID' });
  assert.throws(() => codec.decode(cursor, 'conflicts', account, epoch), { code: 'CURSOR_INVALID' });
  assert.throws(() => codec.decode(cursor, 'changes', account, randomUUID()), { code: 'SYNC_RESET_REQUIRED' });
  assert.throws(() => new CursorCodec(Buffer.alloc(4)), { code: 'CONFIGURATION_INVALID' });
});

test('idempotency hashes ignore object key order but preserve values and array order', () => {
  assert.equal(operationHash({ a: 1, b: { x: 2, y: [3, 4] } }), operationHash({ b: { y: [3, 4], x: 2 }, a: 1 }));
  assert.notEqual(operationHash({ a: [1, 2] }), operationHash({ a: [2, 1] }));
  assert.notEqual(operationHash({ opId: 'same', data: 'first' }), operationHash({ opId: 'same', data: 'second' }));
});

test('pool exhaustion/disconnection is retryable without classifying schema faults as transient', () => {
  for (const message of ['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout', 'Connection terminated unexpectedly']) {
    assert.equal(isTransientDatabaseError(new Error(message)), true);
  }
  assert.equal(isTransientDatabaseError({ code: '40001' }), true);
  assert.equal(isTransientDatabaseError({ code: '42P01' }), false);
});
