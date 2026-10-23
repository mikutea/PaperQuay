import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { checkedHttpUrl, loadConfig } from '../../src/config.ts';
import { CursorCodec } from '../../src/cursor.ts';
import { operationHash } from '../../src/store.ts';
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
