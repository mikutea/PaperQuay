import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import test from 'node:test';
import { buildApp } from '../../src/app.ts';
import { ApiError } from '../../src/errors.ts';
import type { SyncRepository } from '../../src/types.ts';
import { identity, operation, paper, testConfig } from '../fixtures.ts';
import { PAPER_ORGANIZATION_FEATURE, SYNC_FEATURE_HEADER, type SyncRecord } from '../../../packages/sync-core/src/index.ts';

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

test('organization metadata is negotiated consistently for pull, push and every conflict view', async (t) => {
  const fake = fakeRepository();
  const organization = { favorite: true, readingStatus: 'reading' as const, tags: ['fieldwork'], collections: ['thesis'], queueRank: 3 };
  const op = operation('paper', { ...paper(), organization });
  const record: SyncRecord<'paper'> = { entityType: 'paper', entityId: op.entityId, schemaVersion: 1, revision: 1,
    deletedAt: null, updatedAt: new Date().toISOString(), modifiedByDeviceId: fake.session.device.id, data: op.data };
  const result = { opId: op.opId, status: 'applied' as const, replayed: false, record };
  const conflictId = randomUUID();
  fake.repository.pull = async () => ({ protocolVersion: 1, records: [record], nextCursor: 'current', hasMore: false });
  fake.repository.push = async () => ({ protocolVersion: 1, results: [result] });
  fake.repository.listConflicts = async () => ({ conflicts: [{ conflictId, entityType: 'paper', entityId: op.entityId,
    createdAt: record.updatedAt, attemptedOperation: op, observedRecord: record, currentRecord: record }], nextCursor: 'current', hasMore: false });
  fake.repository.resolveConflict = async () => result;
  const app = await buildApp({ config: testConfig(), repository: fake.repository, verifyToken: async () => identity(), rateLimitEnabled: false });
  t.after(() => app.close());
  assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/capabilities' })).json().features, { paperOrganization: 1 });
  for (const enabled of [false, true]) {
    const headers = enabled ? { [SYNC_FEATURE_HEADER]: `unknown, ${PAPER_ORGANIZATION_FEATURE}` } : {};
    const pull = (await app.inject({ method: 'GET', url: '/v1/sync/pull', headers })).json();
    const pushed = (await app.inject({ method: 'POST', url: '/v1/sync/push', headers,
      payload: { protocolVersion: 1, deviceId: fake.session.device.id, operations: [op] } })).json();
    const conflict = (await app.inject({ method: 'GET', url: '/v1/conflicts', headers })).json().conflicts[0];
    const resolved = (await app.inject({ method: 'POST', url: `/v1/conflicts/${conflictId}/resolve`, headers,
      payload: { opId: op.opId, expectedRevision: 1, choice: 'current' } })).json();
    for (const row of [pull.records[0], pushed.results[0].record, conflict.attemptedOperation, conflict.observedRecord, conflict.currentRecord, resolved.record]) {
      assert.deepEqual(row.data.organization, enabled ? organization : undefined);
      assert.equal(row.data.title, paper().title);
    }
  }
  assert.deepEqual(record.data?.organization, organization, 'legacy views cannot mutate retained records');
});

test('native origins and feature preflight require an explicit exact origin allowlist', async (t) => {
  const fake = fakeRepository();
  const app = await buildApp({ config: testConfig({ PAPERQUAY_ALLOWED_ORIGINS: 'capacitor://localhost,https://localhost' }),
    repository: fake.repository, verifyToken: async () => identity(), rateLimitEnabled: false });
  t.after(() => app.close());
  for (const origin of ['capacitor://localhost', 'https://localhost', 'capacitor://evil.test', 'capacitor://localhost.evil.test']) {
    const response = await app.inject({ method: 'OPTIONS', url: '/v1/sync/push', headers: { origin,
      'access-control-request-method': 'POST', 'access-control-request-headers': `authorization,content-type,${SYNC_FEATURE_HEADER}` } });
    if (['capacitor://localhost', 'https://localhost'].includes(origin)) {
      assert.equal(response.headers['access-control-allow-origin'], origin);
      assert.match(String(response.headers['access-control-allow-headers']).toLowerCase(), /x-paperquay-features/);
    } else assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
});

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

test('anonymous health floods cannot spend public or authenticated business budgets', async (t) => {
  const fake = fakeRepository(); const account = identity();
  const app = await buildApp({ config: { ...testConfig(), requestsPerMinute: 2 }, repository: fake.repository,
    verifyToken: async (token) => { if (token !== 'Bearer valid') throw new ApiError('AUTHENTICATION_REQUIRED', 401); return account; } });
  t.after(() => app.close());
  const source = { remoteAddress: '192.0.2.20' };
  for (let index = 0; index < 2; index++) {
    assert.equal((await app.inject({ method: 'GET', url: '/health/live', ...source })).statusCode, 200);
  }
  for (let index = 0; index < 5; index++) {
    assert.equal((await app.inject({ method: 'GET', url: index % 2 ? '/health/live' : '/health/ready', ...source })).statusCode, 429);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/v1/capabilities', ...source })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/missing-route', ...source })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/capabilities', ...source })).statusCode, 429);
  for (const url of ['/v1/me', '/v1/devices']) {
    assert.equal((await app.inject({ method: 'GET', url, ...source, headers: { authorization: 'Bearer valid' } })).statusCode, 200);
  }
  const limited = await app.inject({ method: 'GET', url: '/v1/sync/pull', ...source, headers: { authorization: 'Bearer valid' } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) > 0);
});

test('trusted proxies isolate actual anonymous clients and business accounts share one budget across routes, IPs and sessions', async (t) => {
  const fake = fakeRepository(); const first = identity();
  const refreshed = { ...first, sessionId: randomUUID(), clientId: 'second-allowed-client' };
  const other = { ...first, issuer: 'https://another-identity.example.test' };
  const tokens = new Map([['Bearer first', first], ['Bearer refreshed', refreshed], ['Bearer other', other]]);
  const app = await buildApp({ config: { ...testConfig({ PAPERQUAY_TRUSTED_PROXY_IPS: '127.0.0.10' }), requestsPerMinute: 2 },
    repository: fake.repository, verifyToken: async (token) => {
      const verified = tokens.get(token ?? '');
      if (!verified) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
      return verified;
    } });
  t.after(() => app.close());
  const request = (url: string, client: string, token?: string) => app.inject({ method: 'GET', url,
    remoteAddress: '127.0.0.10', headers: { 'x-forwarded-for': client, ...(token ? { authorization: token } : {}) } });
  assert.equal((await request('/v1/capabilities', '198.51.100.1')).statusCode, 200);
  assert.equal((await request('/v1/capabilities', '198.51.100.1')).statusCode, 200);
  assert.equal((await request('/v1/capabilities', '198.51.100.1')).statusCode, 429);
  assert.equal((await request('/v1/capabilities', '198.51.100.2')).statusCode, 200);
  assert.equal((await request('/v1/me', '198.51.100.1', 'Bearer first')).statusCode, 200);
  assert.equal((await request('/v1/devices', '198.51.100.2', 'Bearer refreshed')).statusCode, 200);
  assert.equal((await request('/v1/sync/pull', '198.51.100.3', 'Bearer first')).statusCode, 429);
  assert.equal((await request('/v1/me', '198.51.100.1', 'Bearer other')).statusCode, 200,
    'The same sub under a different verified issuer is a separate account even behind the same proxy/client.');
});

test('untrusted direct peers cannot forge XFF, and a trusted chain stops at its nearest untrusted client', async (t) => {
  const fake = fakeRepository();
  const app = await buildApp({ config: { ...testConfig({ PAPERQUAY_TRUSTED_PROXY_IPS: '127.0.0.10,192.0.2.10' }), requestsPerMinute: 2 },
    repository: fake.repository, verifyToken: async () => identity() });
  t.after(() => app.close());
  for (let index = 0; index < 3; index++) {
    const response = await app.inject({ method: 'GET', url: '/v1/capabilities', remoteAddress: '127.0.0.11',
      headers: { 'x-forwarded-for': '198.51.100.' + (index + 1) } });
    assert.equal(response.statusCode, index < 2 ? 200 : 429);
  }
  for (let index = 0; index < 3; index++) {
    const response = await app.inject({ method: 'GET', url: '/v1/capabilities', remoteAddress: '127.0.0.10',
      headers: { 'x-forwarded-for': `203.0.113.${index + 1},198.51.100.20,192.0.2.10` } });
    assert.equal(response.statusCode, index < 2 ? 200 : 429, 'An untrusted client cannot reset its bucket with a forged leftmost address.');
  }
  assert.equal((await app.inject({ method: 'GET', url: '/v1/capabilities', remoteAddress: '127.0.0.10',
    headers: { 'x-forwarded-for': '203.0.113.1,198.51.100.21,192.0.2.10' } })).statusCode, 200);
});

test('failed authentication uses the public client budget without claiming or exhausting an account budget', async (t) => {
  const fake = fakeRepository(); const account = identity(); const other = identity();
  const app = await buildApp({ config: { ...testConfig(), requestsPerMinute: 1 }, repository: fake.repository,
    verifyToken: async (token) => {
      if (token === 'Bearer valid') return account;
      if (token === 'Bearer other') return other;
      throw new ApiError('AUTHENTICATION_REQUIRED', 401);
    } });
  t.after(() => app.close());
  const source = { remoteAddress: '192.0.2.40' };
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', ...source,
    headers: { authorization: 'Bearer unverified-account-claims' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/devices', ...source,
    headers: { authorization: 'Bearer different-invalid-token' } })).statusCode, 429);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', ...source,
    headers: { authorization: 'Bearer valid' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', ...source,
    headers: { authorization: 'Bearer other' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/devices', remoteAddress: '192.0.2.41',
    headers: { authorization: 'Bearer valid' } })).statusCode, 429);
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
