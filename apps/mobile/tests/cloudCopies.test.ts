import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CloudPdfError, deleteCloudPdfCopy, describeCloudPdfError, downloadCloudPdfCopy, inspectCloudPdfCopy,
  listCloudPdfCopies, uploadCloudPdfCopy, type CloudPdfCapability, type CloudPdfContext, type CloudPdfCopy,
  type CloudPdfOptions, type CloudPdfQuota,
} from '../src/pdf/cloudCopies.ts';
import { sha256 } from '../src/pdf/acquisition.ts';
import { ClientError } from '../src/errors.ts';
import { PdfError } from '../src/pdf/errors.ts';
import { PDF_LIMITS, type PdfVersion } from '../src/pdf/types.ts';

const API = 'https://sync.example.test/account-api';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAPER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATTACHMENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = '2026-10-26T12:00:00.000Z';
const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic cloud-copy fixture\n%%EOF\n');
const capability: CloudPdfCapability = { maxFileBytes: PDF_LIMITS.maxFileBytes, maxAccountBytes: 1024 ** 3, maxCopies: 512 };
const hash = await sha256(bytes);
const version: PdfVersion = { entityId: ID, data: { paperId: PAPER, attachmentId: ATTACHMENT,
  sha256: hash, sizeBytes: bytes.length, mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount: 1 } };
const item: CloudPdfCopy = { attachmentVersionId: ID, paperId: PAPER, sha256: hash,
  sizeBytes: bytes.length, fileName: 'synthetic.pdf', createdAt: NOW, available: true };
const usage = (items: CloudPdfCopy[] = [item]): CloudPdfQuota => ({
  usedBytes: items.reduce((sum, entry) => sum + entry.sizeBytes, 0), maxBytes: capability.maxAccountBytes,
  usedCopies: items.length, maxCopies: capability.maxCopies,
});
const context = (overrides: Partial<CloudPdfContext> = {}): CloudPdfContext => ({
  apiBaseUrl: API, getAccessToken: async () => 'opaque-test-token', getCloudPdfCapability: () => capability, ...overrides,
});
const options = (overrides: Partial<CloudPdfOptions> = {}): CloudPdfOptions => ({
  signal: new AbortController().signal, isCurrent: () => true, ...overrides,
});
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const binary = (value = bytes, headers: Record<string, string> = {}, status = 200) =>
  new Response(value as BodyInit, { status, headers: { 'content-type': 'application/pdf',
    'content-length': String(value.length), ...headers } });
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof CloudPdfError || error instanceof ClientError || error instanceof PdfError);
  assert.equal(error.code, expected); return true;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('cloud copy operations use only fixed configured endpoints with bearer headers and no redirects or cookies', async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), options: init! });
    if (init?.method === 'DELETE') return json({ attachmentVersionId: ID, deleted: true, quota: usage([]) });
    if (init?.method === 'PUT') return json({ copy: item, replayed: false, quota: usage() });
    if (String(url).endsWith('/content')) return binary();
    if (String(url).endsWith('/cloud-pdfs')) return json({ copies: [item], quota: usage() });
    return json({ copy: item, quota: usage() });
  };
  const transfer = options({ fetch: fetcher });
  assert.equal((await inspectCloudPdfCopy(context(), version, transfer)).copy?.sha256, hash);
  assert.equal((await uploadCloudPdfCopy(context(), version, bytes, transfer)).replayed, false);
  assert.deepEqual(await downloadCloudPdfCopy(context(), version, transfer), bytes);
  assert.equal((await listCloudPdfCopies(context(), transfer)).copies.length, 1);
  assert.equal((await deleteCloudPdfCopy(context(), ID, transfer)).deleted, true);
  assert.deepEqual(requests.map((request) => [request.options.method, request.url]), [
    ['GET', `${API}/v1/cloud-pdfs/${ID}`], ['PUT', `${API}/v1/cloud-pdfs/${ID}`],
    ['GET', `${API}/v1/cloud-pdfs/${ID}/content`], ['GET', `${API}/v1/cloud-pdfs`],
    ['DELETE', `${API}/v1/cloud-pdfs/${ID}`],
  ]);
  for (const request of requests) {
    assert.equal(request.options.redirect, 'error'); assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.referrerPolicy, 'no-referrer');
    assert.equal(new Headers(request.options.headers).get('authorization'), 'Bearer opaque-test-token');
    assert.ok(!request.url.includes('opaque-test-token')); assert.equal(new URL(request.url).search, '');
  }
  const upload = requests.find((request) => request.options.method === 'PUT')!;
  assert.equal(new Headers(upload.options.headers).get('content-type'), 'application/pdf');
  assert.deepEqual(upload.options.body, bytes); assert.notEqual(upload.options.body, bytes);
});

test('default transport preserves its browser receiver and never probes on construction', async (testContext) => {
  let calls = 0;
  testContext.mock.method(globalThis, 'fetch', function (this: typeof globalThis) {
    calls++; assert.equal(this, globalThis); return Promise.resolve(json({ copy: null, quota: usage([]) }));
  });
  const access = context(); assert.equal(calls, 0);
  assert.equal((await inspectCloudPdfCopy(access, version, options())).copy, null);
  assert.equal(calls, 1);
});

test('disabled, changed or malformed capability cannot dispatch an authenticated cloud operation', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('must not fetch'); };
  await assert.rejects(listCloudPdfCopies(context({ getCloudPdfCapability: () => null }), options({ fetch: fetcher })), code('STORAGE_DISABLED'));
  await assert.rejects(listCloudPdfCopies(context({ getCloudPdfCapability: () => ({ ...capability, maxFileBytes: 2 ** 31 }) }),
    options({ fetch: fetcher })), code('INVALID_RESPONSE'));
  const token = deferred<string>(); let enabled = true;
  const pending = listCloudPdfCopies(context({ getAccessToken: () => token.promise,
    getCloudPdfCapability: () => enabled ? capability : null }), options({ fetch: fetcher }));
  enabled = false; token.resolve('old-session-token');
  await assert.rejects(pending, code('STORAGE_DISABLED'));
  assert.equal(calls, 0);
});

test('cancel or an account/device/session epoch switch during token refresh prevents dispatch', async () => {
  for (const cancel of [false, true]) {
    const token = deferred<string>(); const abort = new AbortController(); let current = true; let calls = 0;
    const pending = inspectCloudPdfCopy(context({ getAccessToken: () => token.promise }), version,
      options({ signal: abort.signal, isCurrent: () => current, fetch: async () => { calls++; throw new Error('must not fetch'); } }));
    if (cancel) abort.abort(); else current = false;
    token.resolve('new-account-token');
    await assert.rejects(pending, code(cancel ? 'CANCELLED' : 'ACCOUNT_CHANGED'));
    assert.equal(calls, 0);
  }
});

test('a hung token provider is bounded and a late rejection does not become unhandled', async () => {
  const token = deferred<string>(); let calls = 0;
  await assert.rejects(listCloudPdfCopies(context({ getAccessToken: () => token.promise }), options({ timeoutMs: 10,
    fetch: async () => { calls++; throw new Error('must not fetch'); } })), code('TIMEOUT'));
  token.reject(new Error('private provider diagnostics'));
  await Promise.resolve(); assert.equal(calls, 0);
});

test('invalid token bytes and unsafe service configuration never reach the transport', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('must not fetch'); };
  for (const token of ['', 'token\r\nAuthorization: stolen', 'Bearer already-prefixed', 'x'.repeat(65_537)]) {
    await assert.rejects(listCloudPdfCopies(context({ getAccessToken: async () => token }), options({ fetch: fetcher })), code('AUTH_REQUIRED'));
  }
  for (const url of ['https://name:password@sync.example.test', 'https://sync.example.test/?token=private',
    'http://192.168.0.1', 'file:///private']) {
    await assert.rejects(listCloudPdfCopies(context({ apiBaseUrl: url }), options({ fetch: fetcher })), code('CONFIG_INVALID'));
  }
  assert.equal(calls, 0);
});

test('old responses and late transport completion are discarded and their response bodies are cancelled', async () => {
  const response = deferred<Response>(); const called = deferred<void>(); let current = true; let cancelled = 0;
  const pending = listCloudPdfCopies(context(), options({ isCurrent: () => current,
    fetch: async () => { called.resolve(); return response.promise; } }));
  await called.promise; current = false;
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(pending, code('ACCOUNT_CHANGED')); assert.equal(cancelled, 1);

  const late = deferred<Response>(); const abort = new AbortController(); const began = deferred<void>();
  const cancelledPending = listCloudPdfCopies(context(), options({ signal: abort.signal,
    fetch: async () => { began.resolve(); return late.promise; } }));
  await began.promise; abort.abort(); await assert.rejects(cancelledPending, code('CANCELLED'));
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await Promise.resolve(); await Promise.resolve(); assert.equal(cancelled, 2);
});

test('a response that followed or points at another URL is refused before reading its body', async () => {
  for (const kind of ['status', 'redirected', 'url']) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }),
      { status: kind === 'status' ? 302 : 200, headers: { 'content-type': 'application/json' } });
    if (kind === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
    if (kind === 'url') Object.defineProperty(response, 'url', { value: 'https://other.example.test/private' });
    await assert.rejects(listCloudPdfCopies(context(), options({ fetch: async () => response })), code('INVALID_RESPONSE'));
    assert.equal(cancelled, true);
  }
});

test('all expected identity metadata is bound to the requested version while a renamed filename may differ', async () => {
  for (const changed of [{ attachmentVersionId: ATTACHMENT }, { paperId: ATTACHMENT },
    { sha256: '0'.repeat(64) }, { sizeBytes: bytes.length + 1 }]) {
    const other = { ...item, ...changed };
    await assert.rejects(inspectCloudPdfCopy(context(), version, options({ fetch: async () => json({ copy: other, quota: usage([other]) }) })),
      code('INVALID_RESPONSE'));
  }
  const renamed = { ...item, fileName: 'previous-name.pdf' };
  assert.equal((await inspectCloudPdfCopy(context(), version, options({ fetch: async () => json({ copy: renamed, quota: usage() }) }))).copy?.fileName,
    'previous-name.pdf');
});

test('malformed metadata, unexpected JSON MIME, invalid UTF-8 and oversized JSON are rejected', async () => {
  const bad = [
    json({ copies: [{ ...item, fileName: '../../private.pdf' }], quota: usage() }),
    json({ copies: [{ ...item, available: 'yes' }], quota: usage() }),
    json({ copies: [{ ...item, createdAt: 'not-a-date' }], quota: usage() }),
    json({ copies: [item], quota: { ...usage(), usedBytes: -1 } }),
    new Response(JSON.stringify({ copies: [item], quota: usage() }), { headers: { 'content-type': 'text/html' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2000000' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1x' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '4' } }),
  ];
  for (const response of bad) await assert.rejects(listCloudPdfCopies(context(), options({ fetch: async () => response })), code('INVALID_RESPONSE'));
});

test('list accounts exactly for every copy, rejects duplicate IDs and enforces the 512-copy limit', async () => {
  const duplicate = [item, item];
  const tooMany = Array.from({ length: 513 }, () => item);
  for (const value of [{ copies: duplicate, quota: usage(duplicate) }, { copies: tooMany, quota: usage(tooMany) },
    { copies: [item], quota: usage([]) }, { copies: [], quota: usage() }]) {
    await assert.rejects(listCloudPdfCopies(context(), options({ fetch: async () => json(value) })), code('INVALID_RESPONSE'));
  }
});

test('tombstone copies remain listable and deletable even after the server quota is reduced', async () => {
  const tombstone = { ...item, available: false };
  const reduced = { ...usage(), maxBytes: 1 };
  const list = await listCloudPdfCopies(context(), options({ fetch: async () => json({ copies: [tombstone], quota: reduced }) }));
  assert.equal(list.copies[0].available, false); assert.ok(list.quota.usedBytes > list.quota.maxBytes);
  assert.equal((await deleteCloudPdfCopy(context(), list.copies[0].attachmentVersionId,
    options({ fetch: async () => json({ attachmentVersionId: ID, deleted: true, quota: { ...usage([]), maxBytes: 1 } }) }))).deleted, true);
});

test('a full 512-copy list with maximal multibyte filenames fits the bounded JSON reader', async () => {
  const copies = Array.from({ length: 512 }, (_, index) => ({ ...item,
    attachmentVersionId: `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    fileName: `${'文'.repeat(251)}.pdf`, sizeBytes: 1000,
  }));
  const value = { copies, quota: usage(copies) };
  assert.ok(new TextEncoder().encode(JSON.stringify(value)).length > 512 * 1024);
  assert.equal((await listCloudPdfCopies(context(), options({ fetch: async () => json(value) }))).copies.length, 512);
});

test('a whitespace-only basename accepted by the attachment schema remains listable for cleanup', async () => {
  const unusual = { ...item, fileName: ' ' };
  const result = await listCloudPdfCopies(context(), options({ fetch: async () => json({ copies: [unusual], quota: usage() }) }));
  assert.equal(result.copies[0].fileName, ' ');
});

test('upload validates exact PDF bytes before acquiring a token and snapshots caller-owned bytes', async () => {
  let tokenCalls = 0; let sent = 0;
  const access = context({ getAccessToken: async () => { tokenCalls++; return 'opaque-test-token'; } });
  const noFetch = options({ fetch: async () => { sent++; throw new Error('must not fetch'); } });
  await assert.rejects(uploadCloudPdfCopy(access, version, new Uint8Array(bytes.length), noFetch), code('NOT_PDF'));
  const corrupt = bytes.slice(); corrupt[20] ^= 1;
  await assert.rejects(uploadCloudPdfCopy(access, version, corrupt, noFetch), code('VERSION_MISMATCH'));
  await assert.rejects(uploadCloudPdfCopy(access, version, bytes.subarray(1), noFetch), code('VERSION_MISMATCH'));
  assert.equal(tokenCalls, 0); assert.equal(sent, 0);

  const token = deferred<string>(); const began = deferred<void>(); const original = bytes.slice();
  const pending = uploadCloudPdfCopy(context({ getAccessToken: () => { began.resolve(); return token.promise; } }), version, original,
    options({ fetch: async (_url, init) => {
      assert.deepEqual(init?.body, bytes); return json({ copy: item, replayed: true, quota: usage() });
    } }));
  await began.promise; original.fill(0); token.resolve('opaque-test-token');
  assert.equal((await pending).replayed, true);
});

test('oversized versions and malformed version IDs stop before token, allocation or network work', async () => {
  let tokens = 0; let requests = 0;
  const access = context({ getAccessToken: async () => { tokens++; return 'token'; } });
  const transfer = options({ fetch: async () => { requests++; throw new Error('must not fetch'); } });
  const oversized = { ...version, data: { ...version.data, sizeBytes: PDF_LIMITS.maxFileBytes + 1 } };
  await assert.rejects(uploadCloudPdfCopy(access, oversized, bytes, transfer), code('TOO_LARGE'));
  await assert.rejects(downloadCloudPdfCopy(access, oversized, transfer), code('TOO_LARGE'));
  await assert.rejects(deleteCloudPdfCopy(access, `${ID}/../content?secret=1`, transfer), code('VERSION_MISMATCH'));
  assert.equal(tokens, 0); assert.equal(requests, 0);
});

test('downloads require exact MIME, full response, size and SHA-256 before returning bytes', async () => {
  const corrupt = bytes.slice(); corrupt[20] ^= 1;
  const cases: [Response, string][] = [
    [binary(corrupt), 'VERSION_MISMATCH'],
    [binary(bytes, { 'content-type': 'text/html' }), 'INVALID_RESPONSE'],
    [binary(bytes, { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` }), 'INVALID_RESPONSE'],
    [binary(bytes, { 'content-encoding': 'gzip' }), 'INVALID_RESPONSE'],
    [binary(bytes, { 'content-length': String(bytes.length - 1) }), 'VERSION_MISMATCH'],
    [binary(bytes.subarray(0, bytes.length - 1), { 'content-length': String(bytes.length) }), 'INCOMPLETE'],
    [binary(bytes, { 'content-length': String(PDF_LIMITS.maxFileBytes + 1) }), 'INVALID_RESPONSE'],
  ];
  const noLength = binary(); noLength.headers.delete('content-length'); cases.push([noLength, 'INVALID_RESPONSE']);
  for (const [response, expected] of cases)
    await assert.rejects(downloadCloudPdfCopy(context(), version, options({ fetch: async () => response })), code(expected));
});

test('a binary stream cannot exceed its declared version size and is cancelled at the boundary', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(bytes.length + 1)); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } });
  await assert.rejects(downloadCloudPdfCopy(context(), version, options({ fetch: async () => response })), code('INVALID_RESPONSE'));
  assert.equal(cancelled, true);
});

test('cancelling a stalled download closes its stream and never reports a successful completion', async () => {
  for (const timeout of [false, true]) {
    let cancelled = false; const began = deferred<void>(); const abort = new AbortController(); const progress: number[] = [];
    const pending = downloadCloudPdfCopy(context(), version, options({ signal: abort.signal,
      timeoutMs: timeout ? 10 : 1000, onProgress: (loaded) => progress.push(loaded), fetch: async () => {
        began.resolve(); return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
          { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } });
      } }));
    await began.promise; if (!timeout) abort.abort();
    await assert.rejects(pending, code(timeout ? 'TIMEOUT' : 'CANCELLED'));
    assert.equal(cancelled, true); assert.deepEqual(progress, []);
  }
});

test('an account switch or cancellation from a progress callback prevents publishing downloaded bytes', async () => {
  for (const cancel of [false, true]) {
    let current = true; const abort = new AbortController(); let progresses = 0;
    await assert.rejects(downloadCloudPdfCopy(context(), version, options({ signal: abort.signal, isCurrent: () => current,
      fetch: async () => binary(), onProgress: () => { progresses++; if (cancel) abort.abort(); else current = false; } })),
    code(cancel ? 'CANCELLED' : 'ACCOUNT_CHANGED'));
    assert.equal(progresses, 1);
  }
});

test('upload progress starts at zero and completes only after a validated server reply', async () => {
  const reply = deferred<Response>(); const sent = deferred<void>(); const progress: number[] = [];
  const pending = uploadCloudPdfCopy(context(), version, bytes, options({ onProgress: (loaded) => progress.push(loaded),
    fetch: async () => { sent.resolve(); return reply.promise; } }));
  await sent.promise; assert.deepEqual(progress, [0]);
  reply.resolve(json({ copy: item, replayed: false, quota: usage() })); await pending;
  assert.deepEqual(progress, [0, bytes.length]);
});

test('authentication failures are safe even for HTML bodies and revoked sessions retain their reason', async () => {
  for (const [response, expected] of [
    [new Response('private proxy diagnostic', { status: 401 }), 'AUTH_REQUIRED'],
    [json({ error: { code: 'SESSION_REVOKED', message: 'private-secret' } }, 403), 'SESSION_REVOKED'],
    [json({ error: { code: 'DEVICE_NOT_REGISTERED', message: 'private-secret' } }, 403), 'AUTH_REQUIRED'],
  ] as const) {
    await assert.rejects(listCloudPdfCopies(context(), options({ fetch: async () => response })), (error: unknown) => {
      code(expected)(error); assert.ok(!describeCloudPdfError(error).includes('private')); return true;
    });
  }
});

test('quota, transfer rate, changed state and integrity errors are mapped without retries or raw diagnostics', async () => {
  const cases: [number, string, string][] = [
    [404, 'NOT_FOUND', 'VERSION_UNAVAILABLE'], [404, 'CLOUD_PDF_NOT_FOUND', 'NOT_FOUND'],
    [410, 'ATTACHMENT_VERSION_UNAVAILABLE', 'VERSION_UNAVAILABLE'], [413, 'REQUEST_TOO_LARGE', 'TOO_LARGE'],
    [415, 'INVALID_PDF', 'NOT_PDF'], [422, 'PDF_INTEGRITY_MISMATCH', 'VERSION_MISMATCH'],
    [409, 'CLOUD_PDF_QUOTA_EXCEEDED', 'QUOTA_EXCEEDED'], [409, 'CLOUD_PDF_CHANGED', 'CHANGED'],
    [429, 'CLOUD_PDF_TRANSFER_BUSY', 'RATE_LIMITED'], [503, 'CLOUD_PDF_STORAGE_DISABLED', 'STORAGE_DISABLED'],
    [500, 'PRIVATE_INTERNAL_PATH', 'FAILED'],
  ];
  for (const [status, serverCode, expected] of cases) {
    let requests = 0;
    await assert.rejects(listCloudPdfCopies(context(), options({ fetch: async () => {
      requests++; return json({ error: { code: serverCode, message: 'private token filesystem path' } }, status, { 'retry-after': '15' });
    } })), (error: unknown) => {
      code(expected)(error); assert.ok(!describeCloudPdfError(error).includes('private'));
      if (expected === 'RATE_LIMITED') assert.equal((error as CloudPdfError).retryAfterSeconds, 15);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('transport errors remain private and cancellation never claims a remote mutation was rolled back', async () => {
  await assert.rejects(deleteCloudPdfCopy(context(), ID, options({ fetch: async () => {
    throw new Error('private Authorization token=https://secret.example.test');
  } })), (error: unknown) => {
    code('NETWORK')(error); const message = describeCloudPdfError(error);
    assert.ok(!message.includes('private')); assert.ok(message.includes('可能已在服务端完成')); return true;
  });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(deleteCloudPdfCopy(context(), ID, options({ signal: abort.signal })), (error: unknown) => {
    code('CANCELLED')(error); assert.ok(describeCloudPdfError(error).includes('刷新云副本列表确认')); return true;
  });
});

test('a stale completed deletion is discarded and cannot claim ownership of the next operation', async () => {
  const firstResponse = deferred<Response>(); const began = deferred<void>(); let epoch = 1;
  const first = deleteCloudPdfCopy(context(), ID, options({ isCurrent: () => epoch === 1,
    fetch: async () => { began.resolve(); return firstResponse.promise; } }));
  await began.promise; epoch = 2;
  const next = await inspectCloudPdfCopy(context(), version, options({ isCurrent: () => epoch === 2,
    fetch: async () => json({ copy: null, quota: usage([]) }) }));
  firstResponse.resolve(json({ attachmentVersionId: ID, deleted: true, quota: usage([]) }));
  await assert.rejects(first, code('ACCOUNT_CHANGED')); assert.equal(next.copy, null);
});
