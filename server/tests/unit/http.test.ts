import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import test from 'node:test';
import { buildApp } from '../../src/app.ts';
import { ApiError } from '../../src/errors.ts';
import type { SyncRepository } from '../../src/types.ts';
import { identity, operation, paper, testConfig } from '../fixtures.ts';

function fakeRepository() {
  const deviceId = randomUUID(); const accountId = randomUUID();
  const session = { accountId, device: { id: deviceId, name: 'Test', platform: 'web' as const,
    createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null } };
  let pushed = 0;
  const repository: SyncRepository = {
    ready: async () => true, registerDevice: async () => session, me: async () => session,
    listDevices: async () => ({ devices: [session.device] }),
    revokeDevice: async (_identity, id) => ({ revoked: true, deviceId: id }),
    pull: async () => ({ protocolVersion: 1, records: [], nextCursor: null, hasMore: false }),
    push: async (_identity, request) => { pushed++; return { protocolVersion: 1,
      results: request.operations.map((item) => ({ opId: item.opId, status: 'rejected', replayed: false, code: 'TEST', retryable: false })) }; },
    listConflicts: async () => ({ conflicts: [], nextCursor: 'cursor', hasMore: false }),
    resolveConflict: async (_identity, _id, request) => ({ opId: request.opId, status: 'rejected', replayed: false, code: 'TEST', retryable: false }),
  };
  return { repository, session, pushed: () => pushed };
}

test('HTTP authenticates first and rejects private fields, oversized batches, unsupported schema, and malformed pagination', async (t) => {
  const fake = fakeRepository();
  const app = await buildApp({ config: testConfig(), repository: fake.repository,
    verifyToken: async (value) => { if (value !== 'Bearer test') throw new ApiError('AUTHENTICATION_REQUIRED', 401); return identity(); }, rateLimitEnabled: false });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/sync/push', payload: {} })).statusCode, 401);
  const op = operation('paper', paper());
  for (const invalid of [
    { ...op, accountId: 'do-not-trust' },
    { ...op, data: { ...op.data, localPath: 'C:\\private\\secret.pdf' } },
    { ...op, data: { ...op.data, apiKey: 'never-store-model-credentials' } },
    { ...op, schemaVersion: 2 },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/v1/sync/push', headers: { authorization: 'Bearer test' },
      payload: { protocolVersion: 1, deviceId: fake.session.device.id, operations: [invalid] } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_FAILED');
    assert.doesNotMatch(response.body, /secret|localPath|apiKey|credentials|do-not-trust/);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/v1/sync/push', headers: { authorization: 'Bearer test' },
    payload: { protocolVersion: 1, deviceId: fake.session.device.id, operations: Array.from({ length: 101 }, () => operation('paper', paper())) } })).statusCode, 400);
  assert.equal(fake.pushed(), 0);
  for (const query of ['?limit=0', '?limit=1001', '?limit=1e2', '?extra=private']) {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/sync/pull' + query, headers: { authorization: 'Bearer test' } })).statusCode, 400);
  }
  const valid = await app.inject({ method: 'POST', url: '/v1/sync/push', headers: { authorization: 'Bearer test' },
    payload: { protocolVersion: 1, deviceId: fake.session.device.id, operations: [op] } });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.headers['cache-control'], 'no-store');
  assert.equal(fake.pushed(), 1);
});

test('unexpected SQL errors and request content are absent from HTTP errors', async (t) => {
  const fake = fakeRepository();
  fake.repository.me = async () => { throw new Error('SELECT credential FROM private_secret WHERE body=private_note'); };
  const app = await buildApp({ config: testConfig(), repository: fake.repository, verifyToken: async () => identity(), rateLimitEnabled: false });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/v1/me' });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(response.body, /SELECT|credential|private_|stack|Error:/);
  assert.match(response.json().error.requestId, /^[0-9a-f-]{36}$/);
});

test('capabilities publish the configured retained-byte budget and its row reserve', async (t) => {
  const fake = fakeRepository();
  const app = await buildApp({ config: testConfig({ PAPERQUAY_MAX_ACCOUNT_RETAINED_BYTES: '1048576' }),
    repository: fake.repository, verifyToken: async () => identity(), rateLimitEnabled: false });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/v1/capabilities' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().limits.maxAccountRetainedBytes, 1048576);
  assert.equal(response.json().limits.retainedRowOverheadBytes, 512);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('request size, origin allowlist and direct-IP rate limits are enforced', async (t) => {
  const fake = fakeRepository();
  const config = { ...testConfig(), bodyLimitBytes: 1024, requestsPerMinute: 2 };
  const app = await buildApp({ config, repository: fake.repository, verifyToken: async () => identity() });
  t.after(() => app.close());
  const allowed = await app.inject({ method: 'GET', url: '/health/live', headers: { origin: 'http://127.0.0.1:5174' }, remoteAddress: '127.0.0.10' });
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://127.0.0.1:5174');
  const denied = await app.inject({ method: 'GET', url: '/health/live', headers: { origin: 'https://untrusted.example.test' }, remoteAddress: '127.0.0.11' });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  const oversized = await app.inject({ method: 'POST', url: '/v1/devices', payload: { name: 'x'.repeat(2048), platform: 'web' }, remoteAddress: '127.0.0.12' });
  assert.equal(oversized.statusCode, 413);
  for (let i = 0; i < 2; i++) {
    assert.equal((await app.inject({ method: 'GET', url: '/health/live', remoteAddress: '127.0.0.13', headers: { 'x-forwarded-for': `192.0.2.${i}` } })).statusCode, 200);
  }
  const limited = await app.inject({ method: 'GET', url: '/health/live', remoteAddress: '127.0.0.13', headers: { 'x-forwarded-for': '192.0.2.9' } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
});

test('application logs keep only safe error codes/request IDs, excluding headers, query strings, payloads and SQL', async (t) => {
  const fake = fakeRepository(); const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); } });
  fake.repository.me = async () => { throw new Error('PRIVATE_SQL_AND_PASSWORD'); };
  const app = await buildApp({ config: testConfig(), repository: fake.repository, verifyToken: async () => identity(),
    rateLimitEnabled: false, logger: { level: 'info', stream } });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/v1/me?private=PRIVATE_QUERY',
    headers: { authorization: 'Bearer PRIVATE_TOKEN', cookie: 'PRIVATE_COOKIE' } });
  assert.equal(response.statusCode, 500);
  const logs = lines.join('');
  assert.match(logs, /INTERNAL_ERROR/);
  assert.match(logs, new RegExp(response.json().error.requestId));
  assert.doesNotMatch(logs, /PRIVATE_|authorization|cookie|stack|SELECT/);
});
