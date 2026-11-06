import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { ClientError } from '../src/errors.ts';
import { sha256 } from '../src/pdf/acquisition.ts';
import { DesktopPdfError, downloadDesktopPdfCopy, type DesktopPdfCapability,
  type DesktopPdfContext, type DesktopPdfOptions } from '../src/pdf/desktopCopies.ts';
import { PdfError } from '../src/pdf/errors.ts';
import { PDF_LIMITS, type PdfVersion } from '../src/pdf/types.ts';

const API = 'https://sync.example.test/account-api';
const VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAPER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATTACHMENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic online desktop fixture\n%%EOF\n');
const hash = await sha256(bytes);
const version: PdfVersion = { entityId: VERSION, data: { paperId: PAPER, attachmentId: ATTACHMENT,
  sha256: hash, sizeBytes: bytes.length, mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount: 1 } };
const capability: DesktopPdfCapability = { transport: 'http-relay-v1', maxFileBytes: PDF_LIMITS.maxFileBytes,
  requestTtlMs: 30_000, pollTimeoutMs: 20_000 };
const context = (overrides: Partial<DesktopPdfContext> = {}): DesktopPdfContext => ({
  apiBaseUrl: API, getAccessToken: async () => 'synthetic-desktop-token', getDesktopPdfCapability: () => capability, ...overrides,
});
const options = (overrides: Partial<DesktopPdfOptions> = {}): DesktopPdfOptions => ({
  signal: new AbortController().signal, isCurrent: () => true, ...overrides,
});
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const created = (patch: Record<string, unknown> = {}) => json({ requestId: REQUEST, attachmentVersionId: VERSION,
  expiresAt: new Date(Date.now() + 30_000).toISOString(), ...patch }, 201);
const binary = (data = bytes, headers: Record<string, string> = {}, status = 200) => new Response(data as BodyInit,
  { status, headers: { 'content-type': 'application/pdf', 'content-length': String(data.length), 'accept-ranges': 'none', ...headers } });
const responseError = (status: number, code: string) => json({ error: { code, message: 'private path and secret transport diagnostics' } }, status);
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof DesktopPdfError || error instanceof ClientError || error instanceof PdfError);
  assert.equal(error.code, expected); assert.ok(!error.message.includes('private')); return true;
};
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
const scripted = (content: () => Response | Promise<Response>, onRequest?: (method: string) => void): typeof fetch => async (_url, init) => {
  const method = init?.method ?? 'GET'; onRequest?.(method);
  if (method === 'POST') return created();
  if (method === 'DELETE') return json({ cancelled: true });
  return content();
};

test('desktop acquisition creates one fixed request, consumes it once and verifies exact bytes without polling', async () => {
  const requests: { url: string; init: RequestInit }[] = []; let tokens = 0; const progress: number[] = [];
  const result = await downloadDesktopPdfCopy(context({ getAccessToken: async () => { tokens++; return 'synthetic-desktop-token'; } }), version,
    options({ onProgress: (loaded, total) => { progress.push(loaded); assert.equal(total, bytes.length); }, fetch: async (url, init) => {
      requests.push({ url: String(url), init: init! }); return init?.method === 'POST' ? created({ providerUrl: 'https://untrusted.example.test/' }) : binary();
    } }));
  assert.deepEqual(result, bytes); assert.notEqual(result, bytes); assert.equal(tokens, 1);
  assert.deepEqual(requests.map((item) => [item.init.method, item.url]), [
    ['POST', `${API}/v1/desktop-pdfs/requests`], ['GET', `${API}/v1/desktop-pdfs/requests/${REQUEST}/content`],
  ]);
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { attachmentVersionId: VERSION });
  for (const item of requests) {
    assert.equal(item.init.redirect, 'error'); assert.equal(item.init.credentials, 'omit');
    assert.equal(item.init.cache, 'no-store'); assert.equal(item.init.referrerPolicy, 'no-referrer');
    assert.equal(new Headers(item.init.headers).get('authorization'), 'Bearer synthetic-desktop-token');
    assert.equal(new URL(item.url).search, ''); assert.ok(!item.url.includes('token'));
  }
  assert.equal(progress.at(-1), bytes.length);
});

test('default browser fetch keeps its receiver and no request begins before explicit acquisition', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', function (this: typeof globalThis, _url: RequestInfo | URL, init?: RequestInit) {
    assert.equal(this, globalThis); calls++; return Promise.resolve(init?.method === 'POST' ? created() : binary());
  });
  const access = context(); assert.equal(calls, 0);
  assert.deepEqual(await downloadDesktopPdfCopy(access, version, options()), bytes); assert.equal(calls, 2);
});

test('absent, malformed or lost capability prevents a token-bearing request', async () => {
  let tokens = 0; let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; throw new Error('must not fetch'); };
  for (const limits of [null, { ...capability, transport: 'arbitrary-url-v1' }, { ...capability, maxFileBytes: 2 ** 31 },
    { ...capability, requestTtlMs: 30_001 }, { ...capability, requestTtlMs: 1_999 },
    { ...capability, pollTimeoutMs: 20_001 }, { ...capability, pollTimeoutMs: 0 }]) {
    await assert.rejects(downloadDesktopPdfCopy(context({ getDesktopPdfCapability: () => limits as DesktopPdfCapability | null,
      getAccessToken: async () => { tokens++; return 'token'; } }), version, options({ fetch: fetcher })),
    code(limits === null ? 'TRANSFER_DISABLED' : 'INVALID_RESPONSE'));
  }
  assert.equal(tokens, 0);
  for (const disabled of [true, false]) {
    const token = deferred<string>(); let limits: DesktopPdfCapability | null = capability;
    const pending = downloadDesktopPdfCopy(context({ getAccessToken: () => token.promise, getDesktopPdfCapability: () => limits }),
      version, options({ fetch: fetcher }));
    limits = disabled ? null : { ...capability, maxFileBytes: capability.maxFileBytes - 1 }; token.resolve('token');
    await assert.rejects(pending, code(disabled ? 'TRANSFER_DISABLED' : 'CAPABILITY_CHANGED'));
  }
  assert.equal(requests, 0);
});

test('invalid target, oversized target, unsafe service and invalid tokens are rejected before transport', async () => {
  let tokens = 0; let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; throw new Error('must not fetch'); };
  for (const [target, expected] of [
    [{ ...version, entityId: '../private' }, 'VERSION_MISMATCH'],
    [{ ...version, data: { ...version.data, sha256: 'not-a-hash' } }, 'VERSION_MISMATCH'],
    [{ ...version, data: { ...version.data, sizeBytes: PDF_LIMITS.maxFileBytes + 1 } }, 'TOO_LARGE'],
  ] as const) await assert.rejects(downloadDesktopPdfCopy(context({ getAccessToken: async () => { tokens++; return 'token'; } }),
    target, options({ fetch: fetcher })), code(expected));
  assert.equal(tokens, 0);
  for (const url of ['https://name:password@sync.example.test', 'https://sync.example.test/?private=secret', 'http://192.168.0.1', 'file:///private'])
    await assert.rejects(downloadDesktopPdfCopy(context({ apiBaseUrl: url }), version, options({ fetch: fetcher })), code('CONFIG_INVALID'));
  for (const token of ['', 'Bearer prefixed', 'bad\r\nheader', 'x'.repeat(65_537)])
    await assert.rejects(downloadDesktopPdfCopy(context({ getAccessToken: async () => token }), version, options({ fetch: fetcher })), code('AUTH_REQUIRED'));
  assert.equal(requests, 0);
});

test('creation metadata must bind the requested version and a valid request id before any content or cleanup request', async () => {
  for (const patch of [{ requestId: '../private' }, { attachmentVersionId: PAPER }, { expiresAt: 'yesterday' }, { expiresAt: null }]) {
    const requests: string[] = [];
    await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ fetch: async (_url, init) => {
      requests.push(init!.method!); return created(patch);
    } })), code('INVALID_RESPONSE'));
    assert.deepEqual(requests, ['POST']);
  }
});

test('an already expired creation is cancelled without issuing its single content request', async () => {
  const requests: string[] = [];
  await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ fetch: async (_url, init) => {
    requests.push(init!.method!); return init?.method === 'POST' ? created({ expiresAt: new Date(Date.now() - 1_000).toISOString() }) : responseError(404, 'NOT_FOUND');
  } })), code('REQUEST_EXPIRED'));
  assert.deepEqual(requests, ['POST', 'DELETE']);
});

test('creation JSON is bounded, requires its MIME and strict UTF-8, and never supplies an alternate transport URL', async () => {
  for (const reply of [
    () => new Response('<html>private</html>', { status: 201, headers: { 'content-type': 'text/html' } }),
    () => new Response(new Uint8Array([0xff]), { status: 201, headers: { 'content-type': 'application/json' } }),
    () => json({ padding: 'x'.repeat(16 * 1024) }, 201),
    () => new Response('{}', { status: 201, headers: { 'content-type': 'application/json', 'content-length': '20000' } }),
  ]) {
    let requests = 0;
    await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ fetch: async () => { requests++; return reply(); } })), code('INVALID_RESPONSE'));
    assert.equal(requests, 1);
  }
});

test('redirected, opaque and mismatched response URLs are discarded before reading their bodies', async () => {
  for (const patch of [{ redirected: true }, { type: 'opaque' }, { type: 'opaqueredirect' }, { url: 'https://other.example.test/private' }]) {
    let cancelled = false; let reads = 0;
    const response = new Response(new ReadableStream({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }),
      { status: 201, headers: { 'content-type': 'application/json' } });
    for (const [key, value] of Object.entries(patch)) Object.defineProperty(response, key, { value });
    await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ fetch: async () => response })), code('INVALID_RESPONSE'));
    assert.equal(reads, 0); assert.equal(cancelled, true);
  }
});

test('HTTP failures have fixed auth, object, availability, expiry and busy meanings without retry', async () => {
  for (const [status, serverCode, expected] of [
    [401, 'AUTHENTICATION_REQUIRED', 'AUTH_REQUIRED'], [403, 'SESSION_REVOKED', 'SESSION_REVOKED'],
    [404, 'NOT_FOUND', 'VERSION_UNAVAILABLE'], [404, 'DESKTOP_PDF_UNAVAILABLE', 'UNAVAILABLE'],
    [410, 'ATTACHMENT_VERSION_UNAVAILABLE', 'VERSION_UNAVAILABLE'], [409, 'DESKTOP_PDF_CHANGED', 'CHANGED'],
    [409, 'DESKTOP_PDF_REQUEST_IN_USE', 'REQUEST_IN_USE'], [408, 'DESKTOP_PDF_TIMEOUT', 'REQUEST_EXPIRED'],
    [429, 'DESKTOP_PDF_TRANSFER_BUSY', 'RATE_LIMITED'], [413, 'REQUEST_TOO_LARGE', 'TOO_LARGE'],
    [422, 'PDF_INTEGRITY_MISMATCH', 'VERSION_MISMATCH'], [415, 'INVALID_PDF', 'NOT_PDF'],
    [500, 'PRIVATE_INTERNAL_PATH', 'FAILED'],
  ] as const) {
    for (const atCreation of [true, false]) {
      const requests: string[] = [];
      await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ fetch: async (_url, init) => {
        const method = init!.method!; requests.push(method);
        if (method === 'DELETE') return responseError(404, 'NOT_FOUND');
        if (method === 'POST' && !atCreation) return created();
        return responseError(status, serverCode);
      } })), code(expected));
      assert.deepEqual(requests, atCreation ? ['POST'] : ['POST', 'GET', 'DELETE']);
    }
  }
});

test('a malformed or stalled auth/object error body cannot hide its observed status behind a timeout', async () => {
  for (const [status, expected] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [404, 'VERSION_UNAVAILABLE'],
    [409, 'CHANGED'], [410, 'VERSION_UNAVAILABLE']] as const) {
    let cancelled = false;
    await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ timeoutMs: 12, fetch: async () =>
      new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { 'content-type': 'application/json' } }) })), code(expected));
    assert.equal(cancelled, true);
  }
});

test('cancellation and identity changes during token refresh prevent all later requests', async () => {
  for (const cancel of [true, false]) {
    const token = deferred<string>(); const abort = new AbortController(); let current = true; let requests = 0;
    const pending = downloadDesktopPdfCopy(context({ getAccessToken: () => token.promise }), version, options({
      signal: abort.signal, isCurrent: () => current, fetch: async () => { requests++; return created(); },
    }));
    if (cancel) abort.abort(); else current = false;
    token.resolve('late-token'); await assert.rejects(pending, code(cancel ? 'CANCELLED' : 'ACCOUNT_CHANGED'));
    assert.equal(requests, 0);
  }
});

test('a hung token has one bounded deadline and its late success or rejection cannot create a request', async () => {
  for (const reject of [true, false]) {
    const token = deferred<string>(); let requests = 0;
    await assert.rejects(downloadDesktopPdfCopy(context({ getAccessToken: () => token.promise }), version, options({ timeoutMs: 10,
      fetch: async () => { requests++; return created(); } })), code('TIMEOUT'));
    if (reject) token.reject(new Error('private token diagnostics')); else token.resolve('late-token');
    await flush(); assert.equal(requests, 0);
  }
});

test('pre-cancellation never calls the token provider or transport', async () => {
  const abort = new AbortController(); abort.abort(); let work = 0;
  await assert.rejects(downloadDesktopPdfCopy(context({ getAccessToken: async () => { work++; return 'token'; } }), version,
    options({ signal: abort.signal, fetch: async () => { work++; return created(); } })), code('CANCELLED'));
  assert.equal(work, 0);
});

test('late non-cooperative creation is disposed without consuming or reissuing the request', async () => {
  const reply = deferred<Response>(); let requests = 0; let cancelled = false;
  await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ timeoutMs: 10,
    fetch: async () => { requests++; return reply.promise; } })), code('TIMEOUT'));
  reply.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { status: 201, headers: { 'content-type': 'application/json' } }));
  await flush(); assert.equal(cancelled, true); assert.equal(requests, 1);
});

test('cancel closes the content stream and dispatches only a bounded nonblocking cleanup with the original token', async () => {
  const abort = new AbortController(); const began = deferred<void>(); const cleanup = deferred<Response>();
  let cancelled = false; let cleanupSignal: AbortSignal | undefined; let tokens = 0; const requests: string[] = [];
  const pending = downloadDesktopPdfCopy(context({ getAccessToken: async () => { tokens++; return 'original-token'; } }), version,
    options({ signal: abort.signal, fetch: async (_url, init) => {
      requests.push(init!.method!); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer original-token');
      if (init?.method === 'POST') return created();
      if (init?.method === 'DELETE') { cleanupSignal = init.signal!; return cleanup.promise; }
      return new Response(new ReadableStream({ pull() { began.resolve(); }, cancel() { cancelled = true; } }),
        { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length), 'accept-ranges': 'none' } });
    } }));
  await began.promise; abort.abort();
  await assert.rejects(pending, code('CANCELLED'));
  assert.equal(cancelled, true); assert.deepEqual(requests, ['POST', 'GET', 'DELETE']);
  assert.equal(tokens, 1); assert.equal(cleanupSignal?.aborted, false, 'cleanup has its own signal and does not delay the rejected operation');
  cleanup.resolve(responseError(404, 'NOT_FOUND')); await flush();
});

test('the cleanup timeout aborts a non-cooperative cleanup without a retry or token refresh', async (t) => {
  const timers: number[] = []; let cleanupSignal: AbortSignal | undefined;
  const set = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    timers.push(timeout!); return set(handler, timeout === 1_000 ? 10 : timeout, ...args);
  }) as typeof setTimeout);
  await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ fetch: async (_url, init) => {
    if (init?.method === 'POST') return created();
    if (init?.method === 'DELETE') { cleanupSignal = init.signal!; return new Promise(() => undefined); }
    return responseError(408, 'DESKTOP_PDF_TIMEOUT');
  } })), code('REQUEST_EXPIRED'));
  assert.ok(timers.includes(1_000));
  await new Promise((resolve) => set(resolve, 20)); assert.equal(cleanupSignal?.aborted, true);
});

test('a late content response after timeout is cancelled and cannot emit progress or replace a result', async () => {
  const late = deferred<Response>(); const progress: number[] = []; let cancelled = false; const methods: string[] = [];
  await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ timeoutMs: 10,
    fetch: scripted(() => late.promise, (method) => methods.push(method)), onProgress: (loaded) => progress.push(loaded),
  })), code('TIMEOUT'));
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length), 'accept-ranges': 'none' } }));
  await flush(); assert.equal(cancelled, true); assert.deepEqual(progress, []); assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
});

test('identity or capability loss while content is pending discards bytes and still cleans up only its own request', async () => {
  for (const identityChange of [true, false]) {
    let current = true; let enabled = true; const reply = deferred<Response>(); const began = deferred<void>(); const methods: string[] = [];
    const pending = downloadDesktopPdfCopy(context({ getDesktopPdfCapability: () => enabled ? capability : null }), version,
      options({ isCurrent: () => current, fetch: scripted(() => { began.resolve(); return reply.promise; }, (method) => methods.push(method)) }));
    await began.promise; if (identityChange) current = false; else enabled = false;
    reply.resolve(binary()); await assert.rejects(pending, code(identityChange ? 'ACCOUNT_CHANGED' : 'TRANSFER_DISABLED'));
    assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  }
});

test('exact full-response MIME, range policy, byte count and hash are checked before accepting content', async () => {
  const corrupt = bytes.slice(); corrupt[23] ^= 1;
  for (const [reply, expected] of [
    [() => binary(bytes, { 'content-type': 'text/html' }), 'INVALID_RESPONSE'],
    [() => binary(bytes, { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` }), 'INVALID_RESPONSE'],
    [() => binary(bytes, { 'accept-ranges': 'bytes' }), 'INVALID_RESPONSE'],
    [() => binary(bytes, { 'content-encoding': 'gzip' }), 'INVALID_RESPONSE'],
    [() => { const value = binary(); value.headers.delete('content-length'); return value; }, 'INVALID_RESPONSE'],
    [() => binary(bytes, { 'content-length': String(bytes.length - 1) }), 'VERSION_MISMATCH'],
    [() => binary(corrupt), 'VERSION_MISMATCH'],
    [() => binary(bytes.subarray(0, bytes.length - 1), { 'content-length': String(bytes.length) }), 'INCOMPLETE'],
  ] as const) {
    const methods: string[] = [];
    await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ fetch: scripted(reply, (method) => methods.push(method)) })), code(expected));
    assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  }
});

test('a stream cannot exceed the expected length and is cancelled at its allocation boundary', async () => {
  let cancelled = false;
  await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ fetch: scripted(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(bytes.length + 1)); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length), 'accept-ranges': 'none' } })) })), code('INVALID_RESPONSE'));
  assert.equal(cancelled, true);
});

test('cancellation from progress cannot publish the completed bytes or issue another content request', async () => {
  const abort = new AbortController(); const methods: string[] = []; let progress = 0;
  await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ signal: abort.signal,
    fetch: scripted(() => binary(), (method) => methods.push(method)), onProgress: () => { progress++; abort.abort(); },
  })), code('CANCELLED'));
  assert.equal(progress, 1); assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
});

test('caller-owned version mutation during token refresh cannot change the captured request identity or bytes', async () => {
  const token = deferred<string>(); const input = structuredClone(version); let posted: unknown;
  const pending = downloadDesktopPdfCopy(context({ getAccessToken: () => token.promise }), input, options({ fetch: async (_url, init) => {
    if (init?.method === 'POST') { posted = JSON.parse(String(init.body)); return created(); } return binary();
  } }));
  input.entityId = PAPER; input.data.sha256 = '0'.repeat(64); input.data.sizeBytes = 1;
  token.resolve('token'); assert.deepEqual(await pending, bytes); assert.deepEqual(posted, { attachmentVersionId: VERSION });
});

test('a stalled hash is bounded and caller guard failures preserve their original reason', async (t) => {
  const original = new PdfError('TARGET_CHANGED'); let current = true; const reply = deferred<Response>(); const began = deferred<void>();
  const pending = downloadDesktopPdfCopy(context(), version, options({ isCurrent: () => { if (!current) throw original; return true; },
    fetch: scripted(() => { began.resolve(); return reply.promise; }) }));
  await began.promise; current = false; reply.resolve(binary()); await assert.rejects(pending, (error) => error === original);
  const digest = deferred<ArrayBuffer>();
  t.mock.method(crypto.subtle, 'digest', () => digest.promise);
  await assert.rejects(downloadDesktopPdfCopy(context(), version, options({ timeoutMs: 10, fetch: scripted(() => binary()) })), code('TIMEOUT'));
  digest.reject(new Error('private hash diagnostics')); await flush();
});

test('per-operation timeout cannot extend the fixed 15-second desktop deadline', async (t) => {
  const timers: number[] = []; const set = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    timers.push(timeout!); return set(handler, timeout, ...args);
  }) as typeof setTimeout);
  await downloadDesktopPdfCopy(context(), version, options({ timeoutMs: Number.MAX_SAFE_INTEGER, fetch: scripted(() => binary()) }));
  assert.deepEqual(timers, [15_000]);
});

test('native HTTP transport receives one complete relay stream and uses the same bearer for POST and GET', async () => {
  const requests: { method: string; url: string; authorization: string | undefined; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, body });
    if (request.method === 'POST') {
      const data = JSON.stringify({ requestId: REQUEST, attachmentVersionId: VERSION, expiresAt: new Date(Date.now() + 30_000).toISOString() });
      response.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }); response.end(data); return;
    }
    response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.length, 'accept-ranges': 'none' });
    response.write(bytes.subarray(0, 15)); response.end(bytes.subarray(15));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const result = await downloadDesktopPdfCopy(context({ apiBaseUrl: `http://127.0.0.1:${address.port}` }), version, options());
    assert.deepEqual(result, bytes);
    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
      ['POST', '/v1/desktop-pdfs/requests'], ['GET', `/v1/desktop-pdfs/requests/${REQUEST}/content`],
    ]);
    assert.ok(requests.every((request) => request.authorization === 'Bearer synthetic-desktop-token'));
    assert.deepEqual(JSON.parse(requests[0].body), { attachmentVersionId: VERSION });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
