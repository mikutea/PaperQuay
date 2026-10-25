import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkCompletePdfBytes, downloadPublicPdf, inspectPublicPdf, publicPdfUrl, readLocalPdf, safePdfName,
} from '../src/pdf/acquisition.ts';
import { PdfError } from '../src/pdf/errors.ts';
import { PDF_LIMITS } from '../src/pdf/types.ts';

const encoder = new TextEncoder();
const bytes = encoder.encode('%PDF-1.7\nsynthetic transfer fixture\n%%EOF\n');
const url = 'https://papers.example.org/synthetic.pdf';
const code = (expected: string) => (error: unknown) => error instanceof PdfError && error.code === expected;
const body = (value: Uint8Array, headers: Record<string, string> = {}) => new Response(value as BodyInit,
  { headers: { 'content-type': 'application/pdf', ...headers } });

test('only explicit public HTTPS PDF sources are accepted and file names cannot escape a cache', () => {
  for (const value of ['http://papers.example.org/a.pdf', 'file:///secret.pdf', 'https://localhost/a',
    'https://127.1/a', 'https://192.168.2.1/a', 'https://10.0.0.2/a', 'https://[::1]/a',
    'https://name:password@papers.example.org/a', 'https://papers.example.org/a#token']) {
    assert.throws(() => publicPdfUrl(value), code('URL_INVALID'));
  }
  assert.equal(publicPdfUrl(` ${url} `), url);
  assert.equal(safePdfName('C:\\private\\paper.pdf'), 'paper.pdf');
  assert.equal(safePdfName('../../x:paper\u0000.pdf'), 'xpaper.pdf');
});

test('a server ignoring Range is probed only to 1024 bytes and never implicitly downloaded', async () => {
  let calls = 0; let cancelled = false;
  const large = new Uint8Array(8192); large.set(bytes);
  const fetcher = (async (_input, options) => {
    calls++; assert.equal(new Headers(options?.headers).get('range'), 'bytes=0-1023');
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'manual');
    assert.equal(options?.referrerPolicy, 'no-referrer');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(large); }, cancel() { cancelled = true; } }),
      { headers: { 'content-type': 'application/pdf', 'content-length': '8192' } });
  }) as typeof fetch;
  const probe = await inspectPublicPdf(url, { fetch: fetcher });
  assert.equal(calls, 1); assert.equal(cancelled, true);
  assert.equal(probe.rangeSupported, false); assert.equal(probe.sizeBytes, 8192);
});

test('explicit full download verifies size, MIME, PDF signature and trailer', async () => {
  const probe = await inspectPublicPdf(url, { fetch: (async () => body(bytes, { 'content-length': String(bytes.length) })) as typeof fetch });
  assert.deepEqual(await downloadPublicPdf(probe, { fetch: (async () => body(bytes)) as typeof fetch }), bytes);
  await assert.rejects(downloadPublicPdf(probe, { fetch: (async () => body(bytes.subarray(0, bytes.length - 1))) as typeof fetch }), code('INCOMPLETE'));
  await assert.rejects(inspectPublicPdf(url, { fetch: (async () => body(bytes, { 'content-type': 'text/html' })) as typeof fetch }), code('NOT_PDF'));
  assert.throws(() => checkCompletePdfBytes(encoder.encode('<html>%PDF-1.7 %%EOF</html>')), code('NOT_PDF'));
  assert.throws(() => checkCompletePdfBytes(encoder.encode('%PDF-1.7 no trailer')), code('INCOMPLETE'));
});

test('Range download assembles the requested complete file and rejects changing validators', async () => {
  const complete = new Uint8Array(PDF_LIMITS.rangeChunkBytes + 57).fill(32);
  complete.set(encoder.encode('%PDF-1.7\n')); complete.set(encoder.encode('\n%%EOF\n'), complete.length - 7);
  const requests: string[] = [];
  const fetcher = (async (_input, options) => {
    const header = new Headers(options?.headers).get('range')!; requests.push(header);
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(header)!;
    const start = Number(first); const end = Math.min(Number(last), complete.length - 1);
    return new Response(complete.subarray(start, end + 1) as BodyInit, { status: 206,
      headers: { 'content-type': 'application/pdf', 'content-range': `bytes ${start}-${end}/${complete.length}`, etag: '"stable"' } });
  }) as typeof fetch;
  const probe = await inspectPublicPdf(url, { fetch: fetcher });
  assert.equal(probe.rangeSupported, true);
  assert.deepEqual(await downloadPublicPdf(probe, { fetch: fetcher }), complete);
  assert.deepEqual(requests, ['bytes=0-1023', `bytes=0-${PDF_LIMITS.rangeChunkBytes - 1}`, `bytes=${PDF_LIMITS.rangeChunkBytes}-${complete.length - 1}`]);
  await assert.rejects(downloadPublicPdf(probe, { fetch: (async (...args) => {
    const response = await fetcher(...args); response.headers.set('etag', '"changed"'); return response;
  }) as typeof fetch }), code('SOURCE_CHANGED'));
});

test('Range source changing to a full response is rejected instead of silently changing transfer mode', async () => {
  await assert.rejects(downloadPublicPdf({ url, fileName: 'synthetic.pdf', sizeBytes: bytes.length,
    rangeSupported: true, validator: null }, { fetch: (async () => body(bytes)) as typeof fetch }), code('SOURCE_CHANGED'));
});

test('oversize declarations and redirects stop before consuming a response body', async () => {
  let cancelled = 0;
  const stream = () => new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  await assert.rejects(inspectPublicPdf(url, { fetch: (async () => new Response(stream(), {
    headers: { 'content-type': 'application/pdf', 'content-length': String(PDF_LIMITS.maxFileBytes + 1) },
  })) as typeof fetch }), code('TOO_LARGE'));
  await assert.rejects(inspectPublicPdf(url, { fetch: (async () => new Response(stream(), {
    status: 302, headers: { location: 'https://other.example.org/private?token=secret' },
  })) as typeof fetch }), code('REDIRECT'));
  assert.equal(cancelled, 2);
});

test('cancel and timeout close a stalled response without exposing the source or transport error', async () => {
  let cancelled = false; let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const abort = new AbortController();
  const pending = inspectPublicPdf(`${url}?private=not-for-logs`, { signal: abort.signal, fetch: (async () => {
    began(); return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/pdf' } });
  }) as typeof fetch });
  await started; abort.abort();
  await assert.rejects(pending, code('CANCELLED')); assert.equal(cancelled, true);
  await assert.rejects(inspectPublicPdf(url, { timeoutMs: 10, fetch: (async () =>
    new Response(new ReadableStream(), { headers: { 'content-type': 'application/pdf' } })) as typeof fetch }), code('TIMEOUT'));
  await assert.rejects(inspectPublicPdf(url, { fetch: (async () => { throw new Error('secret-cookie-and-query'); }) as typeof fetch }),
    (error: unknown) => code('NETWORK')(error) && !String(error).includes('secret'));
});

test('local-file import validates bytes and cancellation and never reads an oversized file', async () => {
  assert.deepEqual(await readLocalPdf(new Blob([bytes as BlobPart], { type: 'application/pdf' })), bytes);
  await assert.rejects(readLocalPdf(new Blob([bytes as BlobPart], { type: 'text/plain' })), code('NOT_PDF'));
  const oversized = { size: PDF_LIMITS.maxFileBytes + 1, stream: () => { throw new Error('must not read'); } } as unknown as Blob;
  await assert.rejects(readLocalPdf(oversized), code('TOO_LARGE'));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readLocalPdf(new Blob([bytes as BlobPart]), { signal: abort.signal }), code('CANCELLED'));
});
