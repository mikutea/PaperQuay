import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SyncApi } from '../src/api.ts';
import { describeError } from '../src/errors.ts';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = '2026-10-23T12:00:00.000Z';
const identity = {
  accountId: ACCOUNT,
  device: {
    id: DEVICE,
    name: 'Browser',
    platform: 'web',
    createdAt: NOW,
    lastSeenAt: NOW,
    revokedAt: null,
  },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('default transport preserves the browser fetch receiver', async (context) => {
  context.mock.method(globalThis, 'fetch', function (this: typeof globalThis) {
    assert.equal(this, globalThis);
    return Promise.resolve(json(identity));
  });
  const api = new SyncApi('https://sync.example.test', async () => 'opaque-test-token');
  assert.equal((await api.me(new AbortController().signal)).accountId, ACCOUNT);
});

test('authenticated requests use the fixed service, omit cookies and refuse token-bearing redirects', async () => {
  let observed: { url?: string; options?: RequestInit } = {};
  const api = new SyncApi(
    'https://sync.example.test/',
    async () => 'opaque-test-token',
    async (url, options) => {
      observed = { url: String(url), options };
      return json(identity);
    },
  );
  await api.register('Browser', new AbortController().signal);
  assert.equal(observed.url, 'https://sync.example.test/v1/devices');
  assert.equal(observed.options?.redirect, 'error');
  assert.equal(observed.options?.credentials, 'omit');
  assert.equal(observed.options?.referrerPolicy, 'no-referrer');
  assert.equal(
    new Headers(observed.options?.headers).get('authorization'),
    'Bearer opaque-test-token',
  );
  assert.deepEqual(JSON.parse(String(observed.options?.body)), {
    name: 'Browser',
    platform: 'web',
  });
});

test('an account switch during token refresh prevents dispatching the old request', async () => {
  let release!: (token: string) => void;
  const token = new Promise<string>((resolve) => {
    release = resolve;
  });
  let sent = false;
  const api = new SyncApi(
    'https://sync.example.test',
    () => token,
    async () => {
      sent = true;
      return json(identity);
    },
  );
  const signal = new AbortController();
  const pending = api.me(signal.signal);
  signal.abort();
  release('opaque-test-token');
  await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
  assert.equal(sent, false);
});

test('a revoked session and non-JSON authentication error both require login without exposing server text', async () => {
  for (const response of [
    json({ error: { code: 'SESSION_REVOKED', message: 'secret-raw-message' } }, 403),
    new Response('private proxy diagnostic', { status: 401 }),
  ]) {
    const api = new SyncApi(
      'https://sync.example.test',
      async () => 'opaque-test-token',
      async () => response,
    );
    await assert.rejects(api.me(new AbortController().signal), (error: unknown) => {
      assert.ok(['AUTH_REQUIRED', 'SESSION_REVOKED'].includes((error as { code: string }).code));
      assert.ok(!describeError(error).includes('private'));
      assert.ok(!describeError(error).includes('secret'));
      return true;
    });
  }
});

test('malformed or oversized API success responses never become account state', async () => {
  for (const response of [
    json({ ...identity, accountId: 'not-an-id' }),
    new Response('{}', { headers: { 'content-length': String(25 * 1024 * 1024) } }),
    new Response('<html>upstream</html>'),
  ]) {
    const api = new SyncApi(
      'https://sync.example.test',
      async () => 'opaque-test-token',
      async () => response,
    );
    await assert.rejects(api.me(new AbortController().signal), { code: 'INVALID_RESPONSE' });
  }
});

test('conflict payloads cannot attach the body of another entity to an otherwise valid conflict', async () => {
  const entityId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const otherId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const data = { title: 'note', body: 'body', paperId: null, format: 'markdown' };
  const conflict = {
    conflictId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    entityType: 'note',
    entityId,
    createdAt: NOW,
    attemptedOperation: {
      opId: crypto.randomUUID(),
      entityType: 'note',
      entityId,
      mutation: 'put',
      baseRevision: 1,
      schemaVersion: 1,
      data,
      clientCreatedAt: NOW,
    },
    currentRecord: {
      entityType: 'note',
      entityId: otherId,
      schemaVersion: 1,
      revision: 2,
      deletedAt: null,
      updatedAt: NOW,
      modifiedByDeviceId: DEVICE,
      data,
    },
    observedRecord: null,
  };
  const api = new SyncApi(
    'https://sync.example.test',
    async () => 'opaque-test-token',
    async () => json({ conflicts: [conflict], nextCursor: 'done', hasMore: false }),
  );
  await assert.rejects(api.conflicts(null, new AbortController().signal), {
    code: 'INVALID_RESPONSE',
  });
});
