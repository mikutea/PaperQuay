import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildApp } from '../../src/app.ts';
import { SERVER_LIMITS } from '../../src/config.ts';
import { ApiError } from '../../src/errors.ts';
import { PostgresSyncStore } from '../../src/store.ts';
import type { CloudPdfRepository, SessionView, SyncRepository } from '../../src/types.ts';
import { identity, testConfig } from '../fixtures.ts';

const bytes = Buffer.from('%PDF-1.7\nsynthetic marker fixture\n%%EOF\n');
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const target = randomUUID();
  const copy = { attachmentVersionId: target, paperId: randomUUID(), fileName: '合成.pdf',
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength,
    createdAt: new Date().toISOString(), available: true };
  const quota = { usedBytes: bytes.byteLength, usedCopies: 1, maxBytes: SERVER_LIMITS.cloudPdfAccountBytes, maxCopies: 512 };
  const accounts = new Map<string, SessionView>();
  const session = (subject: string) => {
    if (subject === 'unregistered') throw new ApiError('DEVICE_NOT_REGISTERED', 403);
    if (subject === 'revoked') throw new ApiError('SESSION_REVOKED', 403);
    if (!accounts.has(subject)) accounts.set(subject, { accountId: randomUUID(), device: { id: randomUUID(), name: 'Synthetic',
      platform: 'web', createdAt: copy.createdAt, lastSeenAt: copy.createdAt, revokedAt: null } });
    return accounts.get(subject)!;
  };
  const repository: SyncRepository = {
    ready: async () => true, registerDevice: async (who) => session(who.subject), me: async (who) => session(who.subject),
    listDevices: async (who) => ({ devices: [session(who.subject).device] }),
    revokeDevice: async (_who, id) => ({ revoked: true, deviceId: id }),
    pull: async () => ({ protocolVersion: 1, records: [], nextCursor: null, hasMore: false }),
    push: async () => ({ protocolVersion: 1, results: [] }),
    listConflicts: async () => ({ conflicts: [], nextCursor: 'cursor', hasMore: false }),
    resolveConflict: async (_who, _id, request) => ({ opId: request.opId, status: 'rejected', replayed: false }),
  };
  const cloud: CloudPdfRepository = {
    listCloudPdfs: async (who) => { session(who.subject); return { copies: [copy], quota }; },
    getCloudPdf: async (who) => { session(who.subject); return { copy, quota }; },
    prepareCloudPdfUpload: async (who) => ({ accountId: session(who.subject).accountId, sizeBytes: bytes.byteLength, generation: '0' }),
    putCloudPdf: async (who, _id, body, generation) => {
      session(who.subject); assert.equal(generation, '0'); assert.deepEqual(body, bytes);
      return { copy, quota, replayed: false };
    },
    downloadCloudPdf: async (who) => { session(who.subject); return { copy, content: bytes }; },
    deleteCloudPdf: async (who, id) => { session(who.subject); return { attachmentVersionId: id, deleted: true, quota }; },
  };
  const create = async (enabled = true) => buildApp({ config: testConfig({ PAPERQUAY_CLOUD_PDF_ENABLED: enabled ? '1' : '0' }),
    repository, cloudPdfRepository: cloud, rateLimitEnabled: false, verifyToken: async (header) => {
      if (!header?.startsWith('Bearer ')) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
      return { ...identity(), subject: header.slice(7) };
    } });
  const headers = (subject = 'active') => ({ authorization: 'Bearer ' + subject, 'content-type': 'application/pdf' });
  return { target, copy, quota, repository, cloud, create, headers };
}

test('private PDF storage is opt-in and configuration is bounded before opening a pool', async () => {
  assert.equal(testConfig().cloudPdfEnabled, false);
  assert.equal(testConfig().cloudPdfAccountBytes, 1024 * 1024 * 1024);
  for (const value of ['true', 'yes', '', '2', ' 1']) {
    assert.throws(() => testConfig({ PAPERQUAY_CLOUD_PDF_ENABLED: value }), { code: 'CONFIGURATION_INVALID' });
  }
  for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '10737418241']) {
    assert.throws(() => testConfig({ PAPERQUAY_CLOUD_PDF_ACCOUNT_BYTES: value }), { code: 'CONFIGURATION_INVALID' });
  }
  for (const value of [0, -1, NaN, Infinity, SERVER_LIMITS.cloudPdfMaxConfiguredAccountBytes + 1]) {
    assert.throws(() => new PostgresSyncStore({ connectionString: 'never-connect', cursorSecret: Buffer.alloc(32), cloudPdfAccountBytes: value }),
      { code: 'CONFIGURATION_INVALID' });
  }
  const fake = fixture();
  await assert.rejects(buildApp({ config: testConfig({ PAPERQUAY_CLOUD_PDF_ENABLED: '1' }), repository: fake.repository,
    verifyToken: async () => identity(), rateLimitEnabled: false }), { code: 'CONFIGURATION_INVALID' });
});

test('disabled capabilities preserve old clients and enabled capabilities expose only bounded binary limits', async (t) => {
  const fake = fixture(); const disabled = await fake.create(false); const enabled = await fake.create();
  t.after(async () => { await disabled.close(); await enabled.close(); });
  const old = (await disabled.inject('/v1/capabilities')).json();
  assert.equal(old.pdfStorage, false);
  assert.equal(old.cloudPdf, undefined);
  assert.deepEqual(old.features, { paperOrganization: 1 });
  const current = (await enabled.inject('/v1/capabilities')).json();
  assert.deepEqual(current.features, { paperOrganization: 1, privatePdfStorage: 1 });
  assert.deepEqual(current.cloudPdf, { maxFileBytes: 64 * 1024 * 1024, maxAccountBytes: 1024 * 1024 * 1024, maxCopies: 512 });
  assert.equal(current.limits.maxRequestBytes, old.limits.maxRequestBytes, 'binary exception does not enlarge sync JSON requests');
  const response = await disabled.inject({ method: 'PUT', url: '/v1/cloud-pdfs/' + fake.target, headers: fake.headers(), payload: bytes });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'CLOUD_PDF_STORAGE_DISABLED');
});

test('uploads authorize the current registered session and target before accepting a binary body', async (t) => {
  const fake = fixture(); let received = 0;
  const put = fake.cloud.putCloudPdf;
  fake.cloud.putCloudPdf = async (...args) => { received++; return put(...args); };
  const app = await fake.create(); t.after(() => app.close());
  const url = '/v1/cloud-pdfs/' + fake.target;
  for (const [subject, expected] of [['unregistered', 403], ['revoked', 403], ['', 401]] as const) {
    const response = await app.inject({ method: 'PUT', url, headers: { ...fake.headers(subject), authorization: subject ? 'Bearer ' + subject : '' },
      payload: bytes, });
    assert.equal(response.statusCode, expected);
  }
  for (const status of [404, 410, 409]) {
    fake.cloud.prepareCloudPdfUpload = async () => { throw new ApiError('PREFLIGHT_REJECTED', status); };
    const response = await app.inject({ method: 'PUT', url, headers: { ...fake.headers(), 'content-length': String(64 * 1024 * 1024 + 1) }, payload: bytes });
    assert.equal(response.statusCode, status, 'session/version/quota preflight runs before parsing or allocating oversized body');
  }
  assert.equal(received, 0);
});

test('binary routes reject URLs, paths, wrong content type and lengths and retain safe download headers', async (t) => {
  const fake = fixture(); const app = await fake.create(); t.after(() => app.close());
  const url = '/v1/cloud-pdfs/' + fake.target;
  for (const bad of [url + '?url=https://private.invalid/file.pdf', '/v1/cloud-pdfs/not-a-uuid']) {
    assert.equal((await app.inject({ method: 'PUT', url: bad, headers: fake.headers(), payload: bytes })).statusCode, 400);
  }
  for (const headers of [{ ...fake.headers(), 'content-type': 'application/json' }, { ...fake.headers(), 'content-encoding': 'gzip' }]) {
    assert.equal((await app.inject({ method: 'PUT', url, headers, payload: bytes })).statusCode, 415);
  }
  const wrongSize = await app.inject({ method: 'PUT', url, headers: fake.headers(), payload: Buffer.concat([bytes, bytes]) });
  assert.equal(wrongSize.statusCode, 422);
  assert.equal(wrongSize.json().error.code, 'PDF_INTEGRITY_MISMATCH');
  const upload = await app.inject({ method: 'PUT', url, headers: fake.headers(), payload: bytes });
  assert.equal(upload.statusCode, 200);
  assert.deepEqual(upload.json().copy, fake.copy);
  const download = await app.inject({ method: 'GET', url: url + '/content', headers: fake.headers() });
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, bytes);
  assert.equal(download.headers['content-type'], 'application/pdf');
  assert.equal(download.headers['cache-control'], 'no-store');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.equal(download.headers['content-length'], String(bytes.byteLength));
  assert.match(String(download.headers['content-disposition']), /^attachment;/);
  const preflight = await app.inject({ method: 'OPTIONS', url, headers: { origin: 'http://127.0.0.1:5174',
    'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' } });
  assert.match(String(preflight.headers['access-control-allow-methods']), /PUT/);
});

test('a slow upload holds one account slot and two global slots, while status/delete remain usable', async (t) => {
  const fake = fixture(); const started = gate(); const finish = gate(); let entered = 0;
  const original = fake.cloud.putCloudPdf;
  fake.cloud.putCloudPdf = async (...args) => { entered++; started.resolve(); await finish.promise; return original(...args); };
  const app = await fake.create(); t.after(() => app.close());
  const url = '/v1/cloud-pdfs/' + fake.target;
  const first = app.inject({ method: 'PUT', url, headers: fake.headers(), payload: bytes }).then((value) => value);
  await started.promise;
  const same = await app.inject({ method: 'PUT', url, headers: fake.headers(), payload: bytes });
  assert.equal(same.statusCode, 429);
  assert.equal(same.json().error.code, 'CLOUD_PDF_TRANSFER_BUSY');
  assert.equal(same.headers['retry-after'], '1');
  assert.equal((await app.inject({ method: 'GET', url, headers: fake.headers() })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url, headers: fake.headers() })).statusCode, 200);
  const secondStarted = gate();
  fake.cloud.putCloudPdf = async (...args) => { entered++; secondStarted.resolve(); await finish.promise; return original(...args); };
  const second = app.inject({ method: 'PUT', url, headers: fake.headers('second'), payload: bytes }).then((value) => value);
  await secondStarted.promise;
  assert.equal((await app.inject({ method: 'GET', url: url + '/content', headers: fake.headers('third') })).statusCode, 429);
  assert.equal(entered, 2);
  finish.resolve();
  assert.equal((await first).statusCode, 200);
  assert.equal((await second).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: url + '/content', headers: fake.headers('third') })).statusCode, 200);
});

test('failed body parsing, integrity checks and database writes release a transfer slot for an explicit retry', async (t) => {
  const fake = fixture(); const app = await fake.create(); t.after(() => app.close());
  const url = '/v1/cloud-pdfs/' + fake.target; const original = fake.cloud.putCloudPdf;
  const malformed = await app.inject({ method: 'PUT', url, headers: { ...fake.headers(), 'content-length': String(bytes.byteLength) }, payload: bytes.subarray(1) });
  assert.equal(malformed.statusCode, 400);
  for (const error of [new ApiError('PDF_INTEGRITY_MISMATCH', 422), new ApiError('CLOUD_PDF_CHANGED', 409),
    Object.assign(new Error('private SQL must not leak'), { code: '40001' })]) {
    fake.cloud.putCloudPdf = async () => { throw error; };
    const failed = await app.inject({ method: 'PUT', url, headers: fake.headers(), payload: bytes });
    assert.ok([409, 422, 503].includes(failed.statusCode));
    assert.doesNotMatch(failed.body, /private SQL/);
    fake.cloud.putCloudPdf = original;
    assert.equal((await app.inject({ method: 'PUT', url, headers: fake.headers(), payload: bytes })).statusCode, 200);
  }
});

test('chunked uploads are bounded and checked without requiring a client-set Content-Length', async (t) => {
  const fake = fixture(); const app = await fake.create(); t.after(() => app.close());
  const payload = new PassThrough();
  const result = app.inject({ method: 'PUT', url: '/v1/cloud-pdfs/' + fake.target, headers: { ...fake.headers(), 'transfer-encoding': 'chunked' }, payload }).then((value) => value);
  payload.end(bytes);
  assert.equal((await result).statusCode, 200);
});

test('PDF payloads above the sync JSON limit use only the explicit binary route budget', async (t) => {
  const fake = fixture(); const large = Buffer.alloc(5 * 1024 * 1024, 32);
  large.write('%PDF-1.7\n'); large.write('\n%%EOF\n', large.byteLength - 7);
  const original = fake.cloud.prepareCloudPdfUpload;
  fake.cloud.prepareCloudPdfUpload = async (...args) => ({ ...await original(...args), sizeBytes: large.byteLength });
  fake.cloud.putCloudPdf = async (_who, _id, received) => {
    assert.deepEqual(received, large);
    return { copy: { ...fake.copy, sizeBytes: large.byteLength, sha256: createHash('sha256').update(large).digest('hex') },
      replayed: false, quota: { ...fake.quota, usedBytes: large.byteLength } };
  };
  const app = await fake.create(); t.after(() => app.close());
  const binary = await app.inject({ method: 'PUT', url: '/v1/cloud-pdfs/' + fake.target, headers: fake.headers(), payload: large });
  assert.equal(binary.statusCode, 200);
  assert.equal(binary.json().copy.sizeBytes, large.byteLength);
  const json = await app.inject({ method: 'POST', url: '/v1/devices', headers: { authorization: 'Bearer active' },
    payload: { name: 'x'.repeat(large.byteLength), platform: 'web' } });
  assert.equal(json.statusCode, 413);
});
