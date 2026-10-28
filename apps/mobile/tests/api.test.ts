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

test('feature opt-in is sent only after successful capability negotiation and can be disabled again', async () => {
  const sent: Headers[] = [];
  let enabled = true;
  const api = new SyncApi('https://sync.example.test', async () => 'opaque-test-token', async (url, options) => {
    sent.push(new Headers(options?.headers));
    return json(String(url).endsWith('/v1/capabilities') ? { protocolVersion: 1, ...(enabled ? { features: { paperOrganization: 1 } } : {}) } : identity);
  });
  const signal = new AbortController().signal;
  await api.capabilities(signal); await api.me(signal);
  assert.equal(sent[0].get('X-PaperQuay-Features'), null);
  assert.equal(sent[1].get('X-PaperQuay-Features'), 'paper-organization-v1');
  enabled = false; await api.capabilities(signal); await api.me(signal);
  assert.equal(api.supportsPaperOrganization, false);
  assert.equal(sent.at(-1)?.get('X-PaperQuay-Features'), null);
});

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

test('private PDF copies require explicit versioned capability and validated limits; old or disabled servers reset it', async () => {
  const limits = { maxFileBytes: 64 * 1024 * 1024, maxAccountBytes: 1024 * 1024 * 1024, maxCopies: 512 };
  let body: unknown;
  const api = new SyncApi('https://sync.example.test', async () => 'test-token', async () => json(body));
  const signal = new AbortController().signal;
  const enabled = { protocolVersion: 1, pdfStorage: true, features: { paperOrganization: 1, privatePdfStorage: 1 }, cloudPdf: limits };
  for (const disabled of [
    { protocolVersion: 1 }, { ...enabled, pdfStorage: false },
    { ...enabled, features: { privatePdfStorage: 2 } }, { ...enabled, features: {} },
  ]) {
    body = enabled;
    assert.deepEqual(await api.capabilities(signal), { paperOrganization: true });
    assert.deepEqual(api.cloudPdfCapability, limits);
    body = disabled;
    await api.capabilities(signal);
    assert.equal(api.cloudPdfCapability, null);
  }
  for (const invalid of [undefined, { ...limits, maxFileBytes: 0 }, { ...limits, maxFileBytes: limits.maxFileBytes + 1 },
    { ...limits, maxAccountBytes: 11 * 1024 * 1024 * 1024 }, { ...limits, maxCopies: 513 }, { ...limits, maxCopies: '512' }]) {
    body = enabled; await api.capabilities(signal);
    body = { ...enabled, cloudPdf: invalid };
    await assert.rejects(api.capabilities(signal), { code: 'INVALID_RESPONSE' });
    assert.equal(api.cloudPdfCapability, null);
  }
});

test('desktop transfer requires its independent versioned capability and old services never enable it', async () => {
  const limits = { transport: 'http-relay-v1', maxFileBytes: 64 * 1024 * 1024, requestTtlMs: 30_000, pollTimeoutMs: 20_000 };
  const enabled = { protocolVersion: 1, features: { desktopPdfTransfer: 1 }, desktopPdf: limits };
  let body: unknown; const requests: string[] = [];
  const api = new SyncApi('https://sync.example.test', async () => 'test-token', async (url) => { requests.push(String(url)); return json(body); });
  const signal = new AbortController().signal;
  for (const disabled of [{ protocolVersion: 1 }, { ...enabled, features: {} },
    { ...enabled, features: { desktopPdfTransfer: 2 } }, { ...enabled, features: { privatePdfStorage: 1 }, pdfStorage: false }]) {
    body = enabled; await api.capabilities(signal);
    assert.deepEqual(api.desktopPdfCapability, limits); assert.equal(api.cloudPdfCapability, null, 'desktop does not require private cloud storage');
    body = disabled; await api.capabilities(signal); assert.equal(api.desktopPdfCapability, null);
  }
  body = { ...enabled, desktopPdf: { ...limits, byteWindowMs: 60_000, accountWindowBytes: 1, processWindowBytes: 2 } };
  await api.capabilities(signal); assert.deepEqual(api.desktopPdfCapability, limits, 'unknown optional budget fields are not saved as client authority');
  assert.ok(requests.every((url) => url.endsWith('/v1/capabilities')), 'capability negotiation never probes a desktop endpoint');
});

test('malformed desktop bounds fail closed and a failed capability negotiation clears the old desktop capability', async () => {
  const limits = { transport: 'http-relay-v1', maxFileBytes: 64 * 1024 * 1024, requestTtlMs: 30_000, pollTimeoutMs: 20_000 };
  const enabled = { protocolVersion: 1, features: { desktopPdfTransfer: 1 }, desktopPdf: limits };
  let body: unknown;
  const api = new SyncApi('https://sync.example.test', async () => 'test-token', async () => json(body));
  const signal = new AbortController().signal;
  for (const invalid of [undefined, { ...limits, transport: 'p2p-url' }, { ...limits, maxFileBytes: 0 },
    { ...limits, maxFileBytes: limits.maxFileBytes + 1 }, { ...limits, requestTtlMs: 30_001 }, { ...limits, requestTtlMs: 1_999 },
    { ...limits, pollTimeoutMs: 0 }, { ...limits, pollTimeoutMs: 20_001 }, { ...limits, requestTtlMs: 2_000, pollTimeoutMs: 3_000 },
    { ...limits, requestTtlMs: '30000' }]) {
    body = enabled; await api.capabilities(signal);
    body = { ...enabled, desktopPdf: invalid };
    await assert.rejects(api.capabilities(signal), { code: 'INVALID_RESPONSE' }); assert.equal(api.desktopPdfCapability, null);
  }
  body = enabled; await api.capabilities(signal);
  body = { ...enabled, pdfStorage: true, features: { desktopPdfTransfer: 1, privatePdfStorage: 1 }, cloudPdf: {} };
  await assert.rejects(api.capabilities(signal), { code: 'INVALID_RESPONSE' });
  assert.equal(api.desktopPdfCapability, null, 'a later malformed capability must not leave desktop enabled from a failed reply');
});

test('optional desktop direct capability has fixed bounds and only adopts the configured STUN URLs', async () => {
  const direct = { transport: 'webrtc-data-v1', attemptMs: 6000, maxSdpBytes: 32768, stunUrls: ['stun:ice.example.test:3478'] };
  const limits = { transport: 'http-relay-v1', maxFileBytes: 64 * 1024 * 1024, requestTtlMs: 30000, pollTimeoutMs: 20000, direct };
  const enabled = { protocolVersion: 1, features: { desktopPdfTransfer: 1 }, desktopPdf: limits };
  let body: unknown = enabled;
  const api = new SyncApi('https://sync.example.test', async () => 'test-token', async () => json(body));
  const signal = new AbortController().signal;
  await api.capabilities(signal); assert.deepEqual(api.desktopPdfCapability, limits);
  body = { ...enabled, desktopPdf: { ...limits, direct: { ...direct, unknown: 'not stored' } } };
  await api.capabilities(signal); assert.deepEqual(api.desktopPdfCapability, limits);
  for (const invalid of [null, { ...direct, transport: 'turn' }, { ...direct, attemptMs: 6001 }, { ...direct, maxSdpBytes: 32769 },
    { ...direct, stunUrls: ['turn:relay.example.test'] }, { ...direct, stunUrls: ['stun:user:password@ice.example.test'] },
    { ...direct, stunUrls: ['stun:ice.example.test?transport=udp'] }, { ...direct, stunUrls: ['stun:a.test', 'stun:b.test', 'stun:c.test'] }]) {
    body = { ...enabled, desktopPdf: { ...limits, direct: invalid } };
    await assert.rejects(api.capabilities(signal), { code: 'INVALID_RESPONSE' }); assert.equal(api.desktopPdfCapability, null);
  }
  body = { ...enabled, desktopPdf: { ...limits, direct: undefined } };
  await api.capabilities(signal); assert.equal(api.desktopPdfCapability?.direct, undefined);
});
