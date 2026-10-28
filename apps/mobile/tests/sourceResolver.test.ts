import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClientError } from '../src/errors.ts';
import { sha256 } from '../src/pdf/acquisition.ts';
import { CloudPdfError, type CloudPdfContext } from '../src/pdf/cloudCopies.ts';
import { DesktopPdfError, type DesktopPdfContext } from '../src/pdf/desktopCopies.ts';
import { PdfError } from '../src/pdf/errors.ts';
import {
  describePdfSourceError, PDF_SOURCE_BUDGETS, resolvePdfSource, type PdfSourceAttempt, type PdfSourceOptions,
  type PdfSourceRequest, type PdfSourceResult,
} from '../src/pdf/sourceResolver.ts';
import { PDF_LIMITS, type PdfVersion } from '../src/pdf/types.ts';
import { FakeDesktopPeer, TEST_SDP, fakeDesktopFactory } from './helpers/desktopRtc.ts';

const API = 'https://sync.example.test/account-api';
const URL = 'https://papers.example.test/synthetic.pdf?private=not-for-diagnostics';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAPER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ATTACHMENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic resolver fixture\n%%EOF\n');
const hash = await sha256(bytes);
const version: PdfVersion = { entityId: ID, data: { paperId: PAPER, attachmentId: ATTACHMENT,
  sha256: hash, sizeBytes: bytes.length, mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount: 1 } };
const context = (overrides: Partial<CloudPdfContext> = {}): CloudPdfContext => ({
  apiBaseUrl: API, getAccessToken: async () => 'private-cloud-token',
  getCloudPdfCapability: () => ({ maxFileBytes: PDF_LIMITS.maxFileBytes, maxAccountBytes: 1024 ** 3, maxCopies: 512 }),
  ...overrides,
});
const DESKTOP_REQUEST = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const desktopContext = (overrides: Partial<DesktopPdfContext> = {}): DesktopPdfContext => ({
  apiBaseUrl: API, getAccessToken: async () => 'private-desktop-token',
  getDesktopPdfCapability: () => ({ transport: 'http-relay-v1', maxFileBytes: PDF_LIMITS.maxFileBytes, requestTtlMs: 30_000, pollTimeoutMs: 20_000 }),
  ...overrides,
});
const desktopRequest = () => new Response(JSON.stringify({ requestId: DESKTOP_REQUEST, attachmentVersionId: ID,
  expiresAt: new Date(Date.now() + 30_000).toISOString() }), { status: 201, headers: { 'content-type': 'application/json' } });
const request = (overrides: Partial<PdfSourceRequest> = {}): PdfSourceRequest => ({
  scope: { apiBaseUrl: API, accountId: ACCOUNT }, version: { ...version, data: { ...version.data } },
  cache: { peek: async () => null }, cloud: { context: context(), check: () => undefined }, publicUrl: URL, ...overrides,
});
const options = (overrides: Partial<PdfSourceOptions> = {}): PdfSourceOptions => ({
  signal: new AbortController().signal, check: () => undefined, ...overrides,
});
const binary = (value = bytes, extra: Record<string, string> = {}, status = 200) => new Response(value as BodyInit,
  { status, headers: { 'content-type': 'application/pdf', 'content-length': String(value.length), ...extra } });
const jsonError = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: 'secret server diagnostics' } }),
  { status, headers: { 'content-type': 'application/json' } });
const missingCloud = () => jsonError(404, 'CLOUD_PDF_NOT_FOUND');
const attempt = (result: PdfSourceResult, source: PdfSourceAttempt['source']) => result.attempts.find((entry) => entry.source === source)!;
const errorCode = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof PdfError || error instanceof CloudPdfError || error instanceof DesktopPdfError || error instanceof ClientError);
  assert.equal(error.code, expected); return true;
};
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

test('a verified cache hit owns its bytes and never requests a token or network source', async () => {
  let tokens = 0; let reads = 0;
  const events: PdfSourceAttempt[] = [];
  const result = await resolvePdfSource(request({ cache: { peek: async (scope, expected, access) => {
    reads++; assert.equal(scope.accountId, ACCOUNT); assert.deepEqual(expected, version);
    assert.ok(access?.signal); return bytes;
  } }, cloud: { context: context({ getAccessToken: async () => { tokens++; return 'token'; } }), check: () => undefined } }),
  options({ fetch: async () => { throw new Error('must not fetch'); }, onAttempt: (value) => events.push(value) }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'cache'); assert.equal(result.fileName, 'synthetic.pdf');
  assert.deepEqual(result.bytes, bytes); assert.notEqual(result.bytes, bytes); assert.equal(result.sourceUrl, undefined);
  assert.equal(reads, 1); assert.equal(tokens, 0);
  assert.deepEqual(result.attempts.map((entry) => entry.status), ['succeeded', 'skipped', 'skipped', 'skipped']);
  assert.equal(attempt(result, 'desktop').code, 'NOT_NEEDED');
  assert.equal(attempt(result, 'cloud').code, 'NOT_NEEDED');
  assert.deepEqual(events.filter((entry) => entry.source === 'cache').map((entry) => entry.status),
    ['pending', 'checking', 'verifying', 'succeeded']);
});

test('a missing cloud copy falls through to the exact public version without sharing credentials or diagnostics', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const result = await resolvePdfSource(request(), options({ fetch: async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return String(url).startsWith(API) ? missingCloud() : binary();
  } }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'public'); assert.equal(result.sourceUrl, URL);
  assert.deepEqual(result.bytes, bytes);
  assert.deepEqual(requests.map((entry) => entry.url), [`${API}/v1/cloud-pdfs/${ID}/content`, URL, URL]);
  assert.equal(attempt(result, 'cache').code, 'CACHE_MISSING'); assert.equal(attempt(result, 'cloud').code, 'NOT_FOUND');
  assert.equal(attempt(result, 'public').status, 'succeeded');
  for (const entry of requests) {
    assert.equal(entry.init.method, 'GET'); assert.equal(entry.init.credentials, 'omit');
    assert.equal(new Headers(entry.init.headers).get('authorization'), entry.url.startsWith(API) ? 'Bearer private-cloud-token' : null);
  }
  assert.ok(!JSON.stringify(result.attempts).includes('secret'));
  assert.ok(!JSON.stringify(result.attempts).includes('private='));
  assert.ok(!JSON.stringify(result.attempts).includes('https://'));
});

test('a corrupt cached payload is recorded and a verified private cloud copy suppresses public requests', async () => {
  const corrupt = bytes.slice(); corrupt[22] ^= 1;
  let requests = 0;
  const result = await resolvePdfSource(request({ cache: { peek: async () => corrupt } }), options({ fetch: async (url) => {
    requests++; assert.ok(String(url).startsWith(API)); return binary();
  } }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'cloud'); assert.equal(requests, 1);
  assert.equal(attempt(result, 'cache').code, 'VERSION_MISMATCH');
  assert.equal(attempt(result, 'public').code, 'NOT_NEEDED'); assert.equal(result.sourceUrl, undefined);
});

test('cloud hash mismatch permits only an independently verified copy of the expected public version', async () => {
  const corrupt = bytes.slice(); corrupt[22] ^= 1;
  const result = await resolvePdfSource(request(), options({ fetch: async (url) => String(url).startsWith(API) ? binary(corrupt) : binary() }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'public'); assert.deepEqual(result.bytes, bytes);
  assert.equal(attempt(result, 'cloud').code, 'VERSION_MISMATCH');
});

test('recoverable cloud failures are attempted once and retain their specific reason before public fallback', async () => {
  for (const [status, serverCode, expected] of [
    [404, 'CLOUD_PDF_NOT_FOUND', 'NOT_FOUND'], [429, 'CLOUD_PDF_TRANSFER_BUSY', 'RATE_LIMITED'],
    [503, 'CLOUD_PDF_STORAGE_DISABLED', 'STORAGE_DISABLED'], [409, 'CLOUD_PDF_CHANGED', 'CHANGED'],
    [500, 'PRIVATE_INTERNAL_PATH', 'FAILED'],
  ] as const) {
    let cloudRequests = 0; let publicRequests = 0;
    const result = await resolvePdfSource(request(), options({ fetch: async (url) => {
      if (String(url).startsWith(API)) { cloudRequests++; return jsonError(status, serverCode); }
      publicRequests++; return binary();
    } }));
    assert.ok(result.status === 'resolved'); assert.equal(result.source, 'public');
    assert.equal(cloudRequests, 1); assert.equal(publicRequests, 2); assert.equal(attempt(result, 'cloud').code, expected);
  }
});

test('cloud authentication failures and tombstones terminate the chain even when a public source is configured', async () => {
  for (const [status, serverCode, expected] of [
    [401, 'AUTH_REQUIRED', 'AUTH_REQUIRED'], [403, 'SESSION_REVOKED', 'SESSION_REVOKED'],
    [403, 'DEVICE_REVOKED', 'SESSION_REVOKED'], [404, 'UNKNOWN_NOT_FOUND', 'VERSION_UNAVAILABLE'],
    [410, 'ATTACHMENT_VERSION_UNAVAILABLE', 'VERSION_UNAVAILABLE'],
  ] as const) {
    let cloudRequests = 0; let publicRequests = 0; const events: PdfSourceAttempt[] = [];
    await assert.rejects(resolvePdfSource(request(), options({ onAttempt: (value) => events.push(value), fetch: async (url) => {
      if (String(url).startsWith(API)) { cloudRequests++; return jsonError(status, serverCode); }
      publicRequests++; return binary();
    } })), errorCode(expected));
    assert.equal(cloudRequests, 1); assert.equal(publicRequests, 0);
    assert.equal(events.filter((entry) => entry.source === 'cloud').at(-1)?.code, expected);
  }
});

test('a stalled cloud error body cannot turn an observed 401, 403 or tombstone into a public fallback', async () => {
  for (const status of [401, 403, 404, 410]) {
    let cancelled = false; let publicRequests = 0;
    await assert.rejects(resolvePdfSource(request(), options({ budgets: { cloudMs: 12 }, fetch: async (url) => {
      if (!String(url).startsWith(API)) { publicRequests++; return binary(); }
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { status, headers: { 'content-type': 'application/json' } });
    } })), errorCode(status === 401 || status === 403 ? 'AUTH_REQUIRED' : 'VERSION_UNAVAILABLE'));
    assert.equal(cancelled, true); assert.equal(publicRequests, 0);
  }
});

test('disabled or omitted cloud sources never request a token and explain why they were skipped', async () => {
  let tokens = 0;
  const result = await resolvePdfSource(request({ cloud: { check: () => undefined, context: context({
    getAccessToken: async () => { tokens++; return 'token'; }, getCloudPdfCapability: () => null,
  }) } }), options({ fetch: async (url) => { assert.equal(String(url), URL); return binary(); } }));
  assert.ok(result.status === 'resolved'); assert.equal(tokens, 0); assert.equal(attempt(result, 'cloud').status, 'skipped');
  assert.equal(attempt(result, 'cloud').code, 'STORAGE_DISABLED');
  for (const [reason, expected] of [
    ['not-configured', 'CLOUD_NOT_CONFIGURED'], ['not-enabled', 'STORAGE_DISABLED'],
    ['not-synced', 'CLOUD_NOT_SYNCED'], ['login-required', 'CLOUD_LOGIN_REQUIRED'],
  ] as const) {
    const unavailable = await resolvePdfSource(request({ cloud: undefined, publicUrl: undefined, cloudUnavailableReason: reason }), options());
    assert.equal(unavailable.status, 'unavailable'); assert.equal(attempt(unavailable, 'cloud').code, expected);
    assert.equal(attempt(unavailable, 'public').code, 'NO_PUBLIC_URL');
  }
});

test('all source failures retain safe reasons, and invalid local/private public paths are never fetched', async () => {
  for (const url of ['file:///private/file.pdf', 'https://127.0.0.1/a.pdf', 'https://name:password@papers.example.test/a.pdf']) {
    let requests = 0;
    const result = await resolvePdfSource(request({ publicUrl: url, cache: { peek: async () => { throw new Error('secret local path'); } } }),
      options({ fetch: async (input) => { requests++; assert.ok(String(input).startsWith(API)); return missingCloud(); } }));
    assert.equal(result.status, 'unavailable'); assert.equal(requests, 1);
    assert.deepEqual(result.attempts.map((entry) => entry.code), ['CACHE_UNAVAILABLE', 'DESKTOP_NOT_CONFIGURED', 'NOT_FOUND', 'URL_INVALID']);
    assert.ok(!JSON.stringify(result.attempts).includes('secret')); assert.ok(!JSON.stringify(result.attempts).includes(url));
  }
  const poisoned = new CloudPdfError('NETWORK'); poisoned.message = 'secret bearer and URL';
  assert.ok(!describePdfSourceError(poisoned, 'cloud').message.includes('secret'));
  assert.equal(describePdfSourceError(new Error('secret transport'), 'public').code, 'NETWORK');
});

test('pre-cancellation starts no cache work, network request or callback', async () => {
  const abort = new AbortController(); abort.abort(); let work = 0;
  await assert.rejects(resolvePdfSource(request({ cache: { peek: async () => { work++; return bytes; } } }), options({
    signal: abort.signal, fetch: async () => { work++; return binary(); }, onAttempt: () => { work++; },
  })), errorCode('CANCELLED'));
  assert.equal(work, 0);
});

test('cancelling a non-cooperative cache read returns promptly and discards its late success without fallback', async () => {
  const read = deferred<Uint8Array>(); const began = deferred<void>(); const abort = new AbortController();
  const events: PdfSourceAttempt[] = []; let requests = 0;
  const pending = resolvePdfSource(request({ cache: { peek: () => { began.resolve(); return read.promise; } } }), options({
    signal: abort.signal, onAttempt: (value) => events.push(value), fetch: async () => { requests++; return binary(); },
  }));
  await began.promise; abort.abort(); await assert.rejects(pending, errorCode('CANCELLED'));
  const count = events.length; read.resolve(bytes); await flush();
  assert.equal(events.length, count); assert.equal(requests, 0); assert.ok(!events.some((entry) => entry.status === 'succeeded'));
});

test('cache cancellation errors are terminal even when the outer signal has not been aborted', async () => {
  for (const error of [new PdfError('CANCELLED'), new DOMException('private cancellation reason', 'AbortError')]) {
    let requests = 0;
    await assert.rejects(resolvePdfSource(request({ cache: { peek: async () => { throw error; } } }),
      options({ fetch: async () => { requests++; return binary(); } })), errorCode('CANCELLED'));
    assert.equal(requests, 0);
  }
});

test('cloud eligibility loss during a stalled request outranks its stage timeout and forbids public fallback', async () => {
  const began = deferred<void>(); const original = new ClientError('AUTH_REQUIRED');
  let eligible = true; let publicRequests = 0;
  const pending = resolvePdfSource(request({ cloud: { context: context(), check: () => { if (!eligible) throw original; } } }),
    options({ budgets: { cloudMs: 12 }, fetch: async (url) => {
      if (!String(url).startsWith(API)) { publicRequests++; return binary(); }
      began.resolve(); return new Promise<Response>(() => undefined);
    } }));
  await began.promise; eligible = false;
  await assert.rejects(pending, (error) => error === original); assert.equal(publicRequests, 0);
});

test('cloud eligibility is rechecked after a failure callback before public fallback starts', async () => {
  const original = new ClientError('AUTH_REQUIRED'); let eligible = true; let publicRequests = 0;
  await assert.rejects(resolvePdfSource(request({ cloud: { context: context(), check: () => { if (!eligible) throw original; } } }),
    options({ onAttempt: (value) => { if (value.source === 'cloud' && value.status === 'failed') eligible = false; },
      fetch: async (url) => {
        if (String(url).startsWith(API)) return missingCloud(); publicRequests++; return binary();
      },
    })), (error) => error === original);
  assert.equal(publicRequests, 0);
});

test('a timed-out cache read permits the next source but its late bytes cannot replace the winner', async () => {
  const read = deferred<Uint8Array>(); const events: PdfSourceAttempt[] = []; let cacheSignal: AbortSignal | undefined;
  const result = await resolvePdfSource(request({ cache: { peek: (_scope, _version, access) => { cacheSignal = access?.signal; return read.promise; } } }),
    options({ budgets: { cacheMs: 10 }, onAttempt: (value) => events.push(value), fetch: async () => binary() }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'cloud'); assert.equal(attempt(result, 'cache').code, 'TIMEOUT');
  assert.equal(cacheSignal?.aborted, true);
  const count = events.length; read.resolve(bytes); await flush(); assert.equal(events.length, count);
});

test('a timed-out token provider cannot send a late authenticated cloud request after public fallback', async () => {
  const token = deferred<string>(); let cloudRequests = 0; let tokens = 0; let publicRequests = 0;
  const result = await resolvePdfSource(request({ cloud: { check: () => undefined, context: context({ getAccessToken: () => {
    tokens++; return token.promise;
  } }) } }), options({ budgets: { cloudMs: 10 }, fetch: async (url) => {
    if (String(url).startsWith(API)) cloudRequests++; else publicRequests++; return binary();
  } }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'public'); assert.equal(attempt(result, 'cloud').code, 'TIMEOUT');
  token.resolve('late-private-token'); await flush();
  assert.equal(tokens, 1); assert.equal(cloudRequests, 0); assert.equal(publicRequests, 2);
});

test('a timed-out non-cooperative cloud fetch disposes its late response and publishes no late progress', async () => {
  const reply = deferred<Response>(); const events: PdfSourceAttempt[] = []; const progress: unknown[] = [];
  let cancelled = false; let cloudRequests = 0;
  const result = await resolvePdfSource(request(), options({ budgets: { cloudMs: 10 }, onAttempt: (value) => events.push(value),
    onProgress: (value) => progress.push(value), fetch: async (url) => {
      if (String(url).startsWith(API)) { cloudRequests++; return reply.promise; } return binary();
    } }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'public');
  const eventCount = events.length; const progressCount = progress.length;
  reply.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } }));
  await flush(); assert.equal(cancelled, true); assert.equal(cloudRequests, 1);
  assert.equal(events.length, eventCount); assert.equal(progress.length, progressCount);
});

test('a timed-out public probe never starts a full download when its response eventually arrives', async () => {
  const reply = deferred<Response>(); let requests = 0; let cancelled = false;
  const result = await resolvePdfSource(request({ cloud: undefined }), options({ budgets: { publicMs: 10 }, fetch: async () => {
    requests++; return reply.promise;
  } }));
  assert.equal(result.status, 'unavailable'); assert.equal(attempt(result, 'public').code, 'TIMEOUT');
  reply.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/pdf' } }));
  await flush(); assert.equal(requests, 1); assert.equal(cancelled, true);
});

test('cancelling a stalled public probe closes its stream and does not download the full PDF', async () => {
  const began = deferred<void>(); const abort = new AbortController(); let requests = 0; let cancelled = false;
  const pending = resolvePdfSource(request({ cloud: undefined }), options({ signal: abort.signal, fetch: async () => {
    requests++; began.resolve(); return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
      { headers: { 'content-type': 'application/pdf' } });
  } }));
  await began.promise; await flush(); abort.abort(); await assert.rejects(pending, errorCode('CANCELLED'));
  await flush(); assert.equal(requests, 1); assert.equal(cancelled, true);
});

test('cancellation from a public download callback stops completion and future callbacks', async () => {
  const abort = new AbortController(); let progresses = 0; let requests = 0; const events: PdfSourceAttempt[] = [];
  await assert.rejects(resolvePdfSource(request({ cloud: undefined }), options({ signal: abort.signal, onAttempt: (value) => events.push(value),
    onProgress: () => { progresses++; abort.abort(); }, fetch: async () => { requests++; return binary(); },
  })), errorCode('CANCELLED'));
  const count = events.length; await flush();
  assert.equal(progresses, 1); assert.equal(requests, 2); assert.equal(events.length, count);
  assert.ok(!events.some((entry) => entry.status === 'succeeded'));
});

test('the total deadline ends the chain instead of granting every source a new full budget', async () => {
  let requests = 0; const events: PdfSourceAttempt[] = [];
  await assert.rejects(resolvePdfSource(request({ cache: { peek: () => new Promise(() => undefined) } }), options({
    budgets: { cacheMs: 100, totalMs: 10 }, onAttempt: (value) => events.push(value), fetch: async () => { requests++; return binary(); },
  })), errorCode('TIMEOUT'));
  assert.equal(requests, 0); assert.ok(!events.some((entry) => entry.source === 'cloud' && entry.status !== 'pending'));
});

test('a live guard failure after a cache success or rejection outranks fallback and preserves the original error', async () => {
  for (const rejectRead of [false, true]) {
    const read = deferred<Uint8Array>(); const began = deferred<void>(); const original = new PdfError('TARGET_CHANGED');
    let current = true; let requests = 0;
    const pending = resolvePdfSource(request({ cache: { peek: () => { began.resolve(); return read.promise; } } }), options({
      check: () => { if (!current) throw original; }, fetch: async () => { requests++; return binary(); },
    }));
    await began.promise; current = false;
    if (rejectRead) read.reject(new Error('secret cache failure')); else read.resolve(bytes);
    await assert.rejects(pending, (error) => error === original); assert.equal(requests, 0);
  }
});

test('account invalidation during cloud token refresh prevents dispatch and preserves the caller guard error', async () => {
  const token = deferred<string>(); const began = deferred<void>(); const original = new ClientError('ACCOUNT_CHANGED');
  let current = true; let requests = 0;
  const pending = resolvePdfSource(request({ cloud: { check: () => undefined, context: context({ getAccessToken: () => {
    began.resolve(); return token.promise;
  } }) } }), options({ check: () => { if (!current) throw original; }, fetch: async () => { requests++; return binary(); } }));
  await began.promise; current = false; token.resolve('next-account-token');
  await assert.rejects(pending, (error) => error === original); assert.equal(requests, 0);
});

test('version invalidation during public probing disposes the response and never dispatches the full download', async () => {
  const reply = deferred<Response>(); const began = deferred<void>(); const original = new PdfError('TARGET_CHANGED');
  let current = true; let requests = 0; let cancelled = false;
  const pending = resolvePdfSource(request({ cloud: undefined }), options({ check: () => { if (!current) throw original; },
    fetch: async () => { requests++; began.resolve(); return reply.promise; },
  }));
  await began.promise; current = false;
  reply.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/pdf' } }));
  await assert.rejects(pending, (error) => error === original); await flush();
  assert.equal(requests, 1); assert.equal(cancelled, true);
});

test('cloud eligibility checks preserve original errors and cannot prevent an already available offline cache hit', async () => {
  const original = new ClientError('AUTH_REQUIRED'); let tokens = 0; let checks = 0;
  const cloud = { context: context({ getAccessToken: async () => { tokens++; return 'token'; } }),
    check: () => { checks++; throw original; } };
  const cached = await resolvePdfSource(request({ cache: { peek: async () => bytes }, cloud }), options());
  assert.ok(cached.status === 'resolved'); assert.equal(cached.source, 'cache'); assert.equal(checks, 0);
  await assert.rejects(resolvePdfSource(request({ cloud }), options()), (error) => error === original);
  assert.equal(tokens, 0); assert.equal(checks, 1);
});

test('cloud endpoints must belong to the captured account service before any token is requested', async () => {
  let tokens = 0;
  await assert.rejects(resolvePdfSource(request({ cloud: { check: () => undefined, context: context({
    apiBaseUrl: 'https://other.example.test', getAccessToken: async () => { tokens++; return 'token'; },
  }) } }), options()), errorCode('ACCOUNT_CHANGED'));
  assert.equal(tokens, 0);
});

test('mutable caller inputs and callback records cannot change the captured version or internal attempt history', async () => {
  const read = deferred<Uint8Array>(); const began = deferred<void>();
  const input = request({ cache: { peek: (_scope, expected) => {
    assert.equal(expected.data.sha256, hash); assert.ok(Object.isFrozen(expected.data)); began.resolve(); return read.promise;
  } } });
  const pending = resolvePdfSource(input, options({ onAttempt: (value) => { value.status = 'failed'; value.message = 'poisoned callback record'; } }));
  await began.promise; input.version.entityId = ATTACHMENT; input.version.data.sha256 = '0'.repeat(64);
  input.version.data.fileName = 'changed.pdf'; input.scope.accountId = PAPER; read.resolve(bytes);
  const result = await pending;
  assert.ok(result.status === 'resolved'); assert.equal(result.fileName, 'synthetic.pdf'); assert.deepEqual(result.bytes, bytes);
  assert.equal(attempt(result, 'cache').status, 'succeeded'); assert.ok(!JSON.stringify(result.attempts).includes('poisoned'));
});

test('verification owns returned source bytes before its asynchronous hash operation', async (testContext) => {
  const acquired = bytes.slice(); const digest = crypto.subtle.digest.bind(crypto.subtle);
  testContext.mock.method(crypto.subtle, 'digest', ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
    acquired[22] ^= 1; return digest(algorithm, data);
  }) as typeof crypto.subtle.digest);
  const result = await resolvePdfSource(request({ cache: { peek: async () => acquired } }), options());
  assert.ok(result.status === 'resolved'); assert.deepEqual(result.bytes, bytes); assert.notDeepEqual(acquired, bytes);
});

test('a stalled hash is bounded and its late rejection is handled without callbacks or unhandled work', async (testContext) => {
  const digest = deferred<ArrayBuffer>(); const events: PdfSourceAttempt[] = [];
  testContext.mock.method(crypto.subtle, 'digest', () => digest.promise);
  const result = await resolvePdfSource(request({ cache: { peek: async () => bytes }, cloud: undefined, publicUrl: undefined }),
    options({ budgets: { cacheMs: 10 }, onAttempt: (value) => events.push(value) }));
  assert.equal(result.status, 'unavailable'); assert.equal(attempt(result, 'cache').code, 'TIMEOUT');
  const count = events.length; digest.reject(new Error('private late digest failure')); await flush(); assert.equal(events.length, count);
});

test('a declared public size mismatch stops after the probe and never accepts a new attachment version', async () => {
  let requests = 0;
  const result = await resolvePdfSource(request({ cloud: undefined }), options({ fetch: async () => {
    requests++; return binary(bytes, { 'content-length': String(bytes.length + 1) });
  } }));
  assert.equal(result.status, 'unavailable'); assert.equal(attempt(result, 'public').code, 'VERSION_MISMATCH'); assert.equal(requests, 1);
});

test('live invalidation between public range chunks stops further requests before a changed version can be assembled', async () => {
  const complete = new Uint8Array(PDF_LIMITS.rangeChunkBytes + 50).fill(32);
  complete.set(new TextEncoder().encode('%PDF-1.7\n')); complete.set(new TextEncoder().encode('\n%%EOF\n'), complete.length - 7);
  const expected = { ...version, data: { ...version.data, sha256: await sha256(complete), sizeBytes: complete.length } };
  const original = new PdfError('TARGET_CHANGED'); let current = true; const requests: string[] = [];
  await assert.rejects(resolvePdfSource(request({ version: expected, cloud: undefined }), options({
    check: () => { if (!current) throw original; }, onProgress: ({ loaded }) => { if (loaded >= PDF_LIMITS.rangeChunkBytes) current = false; },
    fetch: async (_url, init) => {
      const header = new Headers(init?.headers).get('range')!; requests.push(header);
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(header)!;
      const start = Number(first); const end = Math.min(Number(last), complete.length - 1);
      return binary(complete.subarray(start, end + 1), { 'content-range': `bytes ${start}-${end}/${complete.length}`, etag: '"stable"' }, 206);
    },
  })), (error) => error === original);
  assert.deepEqual(requests, ['bytes=0-1023', `bytes=0-${PDF_LIMITS.rangeChunkBytes - 1}`]);
});

test('injected budgets cannot extend the total or per-source defaults', async (testContext) => {
  const timers: number[] = []; const set = globalThis.setTimeout;
  testContext.mock.method(globalThis, 'setTimeout', ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    timers.push(timeout!); return set(handler, timeout, ...args);
  }) as typeof setTimeout);
  const result = await resolvePdfSource(request({ cache: { peek: async () => bytes } }), options({
    budgets: { totalMs: Number.MAX_SAFE_INTEGER, cacheMs: Number.MAX_SAFE_INTEGER },
  }));
  assert.ok(result.status === 'resolved'); assert.deepEqual(timers, [PDF_SOURCE_BUDGETS.totalMs, PDF_SOURCE_BUDGETS.cacheMs]);
});

test('malformed or oversize expected versions are rejected before starting source work', async () => {
  for (const [data, expected] of [
    [{ ...version, entityId: '../private' }, 'VERSION_MISMATCH'],
    [{ ...version, data: { ...version.data, sizeBytes: PDF_LIMITS.maxFileBytes + 1 } }, 'TOO_LARGE'],
  ] as const) {
    let reads = 0;
    await assert.rejects(resolvePdfSource(request({ version: data, cache: { peek: async () => { reads++; return bytes; } } }), options()), errorCode(expected));
    assert.equal(reads, 0);
  }
});

test('a cache hit skips desktop eligibility, credentials and requests even when remote access is no longer eligible', async () => {
  let tokens = 0; let checks = 0;
  const result = await resolvePdfSource(request({ cache: { peek: async () => bytes }, desktop: {
    context: desktopContext({ getAccessToken: async () => { tokens++; return 'token'; } }),
    check: () => { checks++; throw new ClientError('AUTH_REQUIRED'); },
  } }), options({ fetch: async () => { assert.fail('no remote source may run after a verified cache hit'); } }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'cache');
  assert.equal(tokens, 0); assert.equal(checks, 0); assert.equal(attempt(result, 'desktop').code, 'NOT_NEEDED');
});

test('a verified desktop copy follows cache and suppresses cloud and the private local public URL', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const result = await resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => undefined } }), options({ fetch: async (url, init) => {
    requests.push({ url: String(url), init: init! });
    assert.ok(String(url).startsWith(`${API}/v1/desktop-pdfs/`));
    return init?.method === 'POST' ? desktopRequest() : binary(bytes, { 'accept-ranges': 'none' });
  } }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'desktop'); assert.deepEqual(result.bytes, bytes);
  assert.equal(result.sourceUrl, undefined);
  assert.deepEqual(result.attempts.map(({ source, status }) => [source, status]), [
    ['cache', 'failed'], ['desktop', 'succeeded'], ['cloud', 'skipped'], ['public', 'skipped'],
  ]);
  assert.deepEqual(requests.map(({ url, init }) => [init.method, url]), [
    ['POST', `${API}/v1/desktop-pdfs/requests`], ['GET', `${API}/v1/desktop-pdfs/requests/${DESKTOP_REQUEST}/content`],
  ]);
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { attachmentVersionId: ID });
  assert.ok(!JSON.stringify(requests).includes(URL)); assert.ok(!JSON.stringify(result.attempts).includes('private'));
});

test('desktop unavailability, expiration, busy and integrity failures fall through once to the exact private cloud version', async () => {
  const corrupt = bytes.slice(); corrupt[25] ^= 1;
  for (const [reply, expected] of [
    [() => jsonError(404, 'DESKTOP_PDF_UNAVAILABLE'), 'UNAVAILABLE'],
    [() => jsonError(408, 'DESKTOP_PDF_TIMEOUT'), 'REQUEST_EXPIRED'],
    [() => jsonError(409, 'DESKTOP_PDF_REQUEST_IN_USE'), 'REQUEST_IN_USE'],
    [() => jsonError(429, 'DESKTOP_PDF_TRANSFER_BUSY'), 'RATE_LIMITED'],
    [() => jsonError(500, 'PRIVATE_SERVER_PATH'), 'FAILED'],
    [() => binary(corrupt, { 'accept-ranges': 'none' }), 'VERSION_MISMATCH'],
  ] as const) {
    const requests: string[] = [];
    const result = await resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => undefined } }), options({ fetch: async (url, init) => {
      requests.push(`${init?.method} ${String(url)}`);
      if (init?.method === 'POST') return desktopRequest();
      if (init?.method === 'DELETE') return jsonError(404, 'NOT_FOUND');
      if (String(url).includes('/desktop-pdfs/')) return reply();
      assert.ok(String(url).includes('/cloud-pdfs/')); return binary();
    } }));
    assert.ok(result.status === 'resolved'); assert.equal(result.source, 'cloud'); assert.equal(attempt(result, 'desktop').code, expected);
    assert.equal(requests.filter((item) => item.startsWith('POST ')).length, 1);
    assert.equal(requests.filter((item) => item.startsWith('GET ') && item.includes('/desktop-pdfs/')).length, 1);
    assert.equal(requests.filter((item) => item.startsWith('DELETE ')).length, 1);
    assert.equal(requests.filter((item) => item.includes('/cloud-pdfs/')).length, 1);
    assert.ok(!requests.some((item) => item.includes(URL))); assert.ok(!JSON.stringify(result.attempts).includes('PRIVATE'));
  }
});

test('an unavailable desktop at creation does not issue content or cleanup and preserves all later source reasons', async () => {
  const requests: string[] = [];
  const result = await resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => undefined } }), options({ fetch: async (url, init) => {
    requests.push(`${init?.method} ${String(url)}`);
    if (String(url).includes('/desktop-pdfs/')) return jsonError(404, 'DESKTOP_PDF_UNAVAILABLE');
    return String(url).includes('/cloud-pdfs/') ? missingCloud() : binary();
  } }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'public');
  assert.deepEqual(result.attempts.map((item) => item.code), ['CACHE_MISSING', 'UNAVAILABLE', 'NOT_FOUND', undefined]);
  assert.equal(requests.filter((item) => item.includes('/desktop-pdfs/')).length, 1);
  assert.ok(requests[0].startsWith('POST '));
});

test('disabled or omitted desktop capability makes no token request and preserves old cloud/public compatibility', async () => {
  let tokens = 0;
  const result = await resolvePdfSource(request({ desktop: { context: desktopContext({ getDesktopPdfCapability: () => null,
    getAccessToken: async () => { tokens++; return 'token'; } }), check: () => undefined } }), options({ fetch: async (url) => {
    assert.ok(String(url).includes('/cloud-pdfs/')); return binary();
  } }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'cloud'); assert.equal(tokens, 0);
  assert.equal(attempt(result, 'desktop').status, 'skipped'); assert.equal(attempt(result, 'desktop').code, 'TRANSFER_DISABLED');
  for (const [reason, expected] of [
    ['not-configured', 'DESKTOP_NOT_CONFIGURED'], ['not-enabled', 'TRANSFER_DISABLED'],
    ['not-synced', 'DESKTOP_NOT_SYNCED'], ['login-required', 'DESKTOP_LOGIN_REQUIRED'],
  ] as const) {
    const value = await resolvePdfSource(request({ cloud: undefined, publicUrl: undefined, desktopUnavailableReason: reason }),
      options({ fetch: async () => { assert.fail('omitted sources cannot probe endpoints'); } }));
    assert.equal(attempt(value, 'desktop').code, expected); assert.equal(value.status, 'unavailable');
  }
});

test('desktop authentication and object invalidation terminate every later source, including a configured public URL', async () => {
  for (const [status, serverCode, expected] of [
    [401, 'AUTHENTICATION_REQUIRED', 'AUTH_REQUIRED'], [403, 'SESSION_REVOKED', 'SESSION_REVOKED'],
    [404, 'NOT_FOUND', 'VERSION_UNAVAILABLE'], [410, 'ATTACHMENT_VERSION_UNAVAILABLE', 'VERSION_UNAVAILABLE'],
    [409, 'DESKTOP_PDF_CHANGED', 'CHANGED'],
  ] as const) {
    let requests = 0;
    await assert.rejects(resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => undefined } }),
      options({ fetch: async (url) => { requests++; assert.ok(String(url).includes('/desktop-pdfs/')); return jsonError(status, serverCode); } })), errorCode(expected));
    assert.equal(requests, 1);
  }
});

test('stalled desktop auth/object error bodies cannot be converted to a recoverable stage timeout', async () => {
  for (const [status, expected] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [404, 'VERSION_UNAVAILABLE'],
    [409, 'CHANGED'], [410, 'VERSION_UNAVAILABLE']] as const) {
    let cancelled = false; let requests = 0;
    await assert.rejects(resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => undefined } }), options({ budgets: { desktopMs: 12 },
      fetch: async (url) => { requests++; assert.ok(String(url).includes('/desktop-pdfs/'));
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { 'content-type': 'application/json' } }); },
    })), errorCode(expected));
    assert.equal(cancelled, true); assert.equal(requests, 1);
  }
});

test('desktop eligibility loss while waiting or after a failure callback cannot fall through to cloud', async () => {
  const original = new DesktopPdfError('VERSION_UNAVAILABLE'); let eligible = true;
  await assert.rejects(resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => { if (!eligible) throw original; } } }),
    options({ fetch: async (url) => { assert.ok(String(url).includes('/desktop-pdfs/')); return jsonError(404, 'DESKTOP_PDF_UNAVAILABLE'); },
      onAttempt: (value) => { if (value.source === 'desktop' && value.status === 'failed') eligible = false; },
    })), (error) => error === original);
  eligible = true; const began = deferred<void>();
  const pending = resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => { if (!eligible) throw original; } } }),
    options({ budgets: { desktopMs: 15 }, fetch: async (url) => { assert.ok(String(url).includes('/desktop-pdfs/')); began.resolve(); return new Promise(() => undefined); } }));
  await began.promise; eligible = false; await assert.rejects(pending, (error) => error === original);
});

test('desktop token timeout permits cloud but its late token never dispatches an old authenticated request', async () => {
  const token = deferred<string>(); let desktopRequests = 0;
  const result = await resolvePdfSource(request({ desktop: { context: desktopContext({ getAccessToken: () => token.promise }), check: () => undefined } }),
    options({ budgets: { desktopMs: 10 }, fetch: async (url) => {
      if (String(url).includes('/desktop-pdfs/')) desktopRequests++; return binary();
    } }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'cloud'); assert.equal(attempt(result, 'desktop').code, 'TIMEOUT');
  token.resolve('late-desktop-token'); await flush(); assert.equal(desktopRequests, 0);
});

test('a desktop content timeout cleans up separately and ignores late bytes and progress after cloud wins', async () => {
  const reply = deferred<Response>(); const events: PdfSourceAttempt[] = []; let cancelled = false; const methods: string[] = [];
  const result = await resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => undefined } }), options({
    budgets: { desktopMs: 12 }, onAttempt: (value) => events.push(value), fetch: async (url, init) => {
      if (String(url).includes('/desktop-pdfs/')) {
        methods.push(init!.method!);
        if (init?.method === 'POST') return desktopRequest();
        if (init?.method === 'DELETE') return jsonError(404, 'NOT_FOUND');
        return reply.promise;
      }
      return binary();
    },
  }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'cloud'); const count = events.length;
  reply.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length), 'accept-ranges': 'none' } }));
  await flush(); assert.equal(cancelled, true); assert.equal(events.length, count); assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
});

test('cancellation while desktop content waits ends the chain before fallback and late response disposal changes no row', async () => {
  const abort = new AbortController(); const began = deferred<void>(); const reply = deferred<Response>(); const events: PdfSourceAttempt[] = [];
  const methods: string[] = []; let cancelled = false;
  const pending = resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => undefined } }), options({
    signal: abort.signal, onAttempt: (value) => events.push(value), fetch: async (url, init) => {
      assert.ok(String(url).includes('/desktop-pdfs/')); methods.push(init!.method!);
      if (init?.method === 'POST') return desktopRequest();
      if (init?.method === 'DELETE') return jsonError(404, 'NOT_FOUND');
      began.resolve(); return reply.promise;
    },
  }));
  await began.promise; abort.abort(); await assert.rejects(pending, errorCode('CANCELLED')); await flush();
  const count = events.length; assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  reply.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/pdf' } }));
  await flush(); assert.equal(cancelled, true); assert.equal(events.length, count);
});

test('the shared total deadline stops during desktop instead of starting a fresh cloud budget', async () => {
  let calls = 0;
  await assert.rejects(resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => undefined } }), options({
    budgets: { totalMs: 12 }, fetch: async (url) => { calls++; assert.ok(String(url).includes('/desktop-pdfs/')); return new Promise(() => undefined); },
  })), errorCode('TIMEOUT'));
  assert.equal(calls, 1);
});

test('desktop service binding is checked before acquiring a token and its private diagnostics never enter attempts', async () => {
  let tokens = 0;
  await assert.rejects(resolvePdfSource(request({ desktop: { context: desktopContext({ apiBaseUrl: 'https://other-account.example.test',
    getAccessToken: async () => { tokens++; return 'token'; } }), check: () => undefined } }), options()), errorCode('ACCOUNT_CHANGED'));
  assert.equal(tokens, 0);
  const poisoned = new DesktopPdfError('UNAVAILABLE'); poisoned.message = 'private token and https://private.invalid';
  assert.ok(!describePdfSourceError(poisoned, 'desktop').message.includes('private'));
  assert.equal(describePdfSourceError(new Error('private token'), 'desktop').code, 'NETWORK');
});

test('injected desktop budgets cannot extend the new stage or overall deadline', async (t) => {
  const timers: number[] = []; const set = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    timers.push(timeout!); return set(handler, timeout, ...args);
  }) as typeof setTimeout);
  const result = await resolvePdfSource(request({ desktop: { context: desktopContext(), check: () => undefined } }), options({
    budgets: { desktopMs: Number.MAX_SAFE_INTEGER, totalMs: Number.MAX_SAFE_INTEGER },
    fetch: async (_url, init) => init?.method === 'POST' ? desktopRequest() : binary(bytes, { 'accept-ranges': 'none' }),
  }));
  assert.ok(result.status === 'resolved'); assert.equal(result.source, 'desktop');
  assert.deepEqual(timers, [60_000, 5_000, 15_000, 15_000]);
});

test('desktop direct and same-lease relay publish their transfer state and retain the original source order', async () => {
  for (const fallback of [false, true]) {
    const peer = new FakeDesktopPeer(); const events: PdfSourceAttempt[] = []; const paths: string[] = [];
    const expiresAt = new Date(Date.now() + 30000).toISOString(), directExpiresAt = new Date(Date.now() + 6000).toISOString();
    peer.onAnswer = () => {
      if (!fallback) peer.deliver(version, DESKTOP_REQUEST, bytes);
      else {
        peer.channel.receive(JSON.stringify({ type: 'metadata', requestId: DESKTOP_REQUEST, attachmentVersionId: ID, sha256: hash, sizeBytes: bytes.length }));
        peer.channel.receive(bytes.slice(0, 8).buffer); peer.fail();
      }
    };
    const legacy = desktopContext(); const direct = desktopContext({ getDesktopPdfCapability: () => ({ ...legacy.getDesktopPdfCapability()!,
      direct: { transport: 'webrtc-data-v1', attemptMs: 6000, maxSdpBytes: 32768, stunUrls: [] } }) });
    const result = await resolvePdfSource(request({ desktop: { context: direct, check: () => undefined } }), options({
      createDesktopPeerConnection: fakeDesktopFactory(peer), onAttempt: (value) => events.push(value), fetch: async (url, init) => {
        const path = String(url).slice(API.length); paths.push(path);
        const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (path === '/v1/desktop-pdfs/requests') return reply({ requestId: DESKTOP_REQUEST, attachmentVersionId: ID, expiresAt }, 201);
        if (path.endsWith('/direct')) return reply({ state: 'direct', answer: TEST_SDP, expiresAt, directExpiresAt, relayReady: false,
          authorizedUntil: new Date(Date.now() + 1900).toISOString() });
        if (path.endsWith('/complete')) return reply({ received: true });
        if (path.endsWith('/fallback')) return reply({ state: 'relay' });
        assert.equal(init?.method, 'GET'); assert.ok(path.endsWith(`/${DESKTOP_REQUEST}/content`));
        return binary(bytes, { 'accept-ranges': 'none' });
      },
    }));
    assert.ok(result.status === 'resolved'); assert.equal(result.source, 'desktop'); assert.deepEqual(result.bytes, bytes);
    assert.equal(attempt(result, 'desktop').desktopTransfer, fallback ? 'relay-received' : 'direct-received');
    assert.deepEqual(result.attempts.map(({ source, status }) => [source, status]), [
      ['cache', 'failed'], ['desktop', 'succeeded'], ['cloud', 'skipped'], ['public', 'skipped'],
    ]);
    assert.equal(paths.filter((path) => path === '/v1/desktop-pdfs/requests').length, 1);
    if (fallback) {
      assert.ok(events.some((entry) => entry.desktopTransfer === 'direct-connecting' && entry.loaded === 8));
      assert.ok(events.some((entry) => entry.desktopTransfer === 'relay-fallback' && entry.loaded === 0));
    } else assert.equal(paths.some((path) => path.endsWith('/content')), false);
    assert.equal(JSON.stringify(result.attempts).includes('synthetic.invalid'), false);
  }
});

test('the outer desktop deadline preserves direct auth or target status and never starts cloud', async () => {
  for (const [status, expected] of [[403, 'AUTH_REQUIRED'], [409, 'CHANGED'], [410, 'VERSION_UNAVAILABLE']] as const) {
    const peer = new FakeDesktopPeer(); let cancelled = false; const methods: string[] = [];
    const legacy = desktopContext(); const direct = desktopContext({ getDesktopPdfCapability: () => ({ ...legacy.getDesktopPdfCapability()!,
      direct: { transport: 'webrtc-data-v1', attemptMs: 6000, maxSdpBytes: 32768, stunUrls: [] } }) });
    await assert.rejects(resolvePdfSource(request({ desktop: { context: direct, check: () => undefined } }), options({
      createDesktopPeerConnection: fakeDesktopFactory(peer), budgets: { desktopMs: 30 }, fetch: async (url, init) => {
        assert.ok(String(url).includes('/desktop-pdfs/')); methods.push(init!.method!);
        if (init?.method === 'POST') return desktopRequest();
        if (init?.method === 'DELETE') return jsonError(404, 'NOT_FOUND');
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { 'content-type': 'application/json' } });
      },
    })), errorCode(expected));
    await flush(); assert.equal(cancelled, true); assert.equal(peer.closed, 1); assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  }
});
