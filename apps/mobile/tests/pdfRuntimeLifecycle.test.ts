import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import * as library from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createOwnedPdfWorker } from '../src/pdf/ownedWorker.ts';
import { openVerifiedPdf, type PdfRuntime } from '../src/pdf/engine.ts';
import { boundedTextContent } from '../src/pdf/textContent.ts';
import { PdfError } from '../src/pdf/errors.ts';
import { PDF_LIMITS } from '../src/pdf/types.ts';

type Message = { sourceName?: string; targetName?: string; action?: string; data?: unknown;
  stream?: number; streamId?: number; success?: boolean; chunk?: unknown; reason?: Error };

/** A controllable raw port; PDFWorker and its MessageHandler are the installed PDF.js code. */
class TestWorker {
  readonly sent: Message[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly observers = new Set<(message: Message) => void>();
  terminated = 0;
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener); this.listeners.set(type, listeners);
    options?.signal?.addEventListener('abort', () => this.removeEventListener(type, listener), { once: true });
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  postMessage(message: Message) { this.sent.push(message); for (const observer of this.observers) observer(message); }
  terminate() { this.terminated++; }
  emit(message: Message) {
    for (const listener of [...this.listeners.get('message') ?? []]) listener(new MessageEvent('message', { data: message }));
  }
  ready() { this.emit({ sourceName: 'worker', targetName: 'main', action: 'ready', data: new Uint8Array() }); }
  fail() { for (const listener of [...this.listeners.get('error') ?? []]) listener(new Event('error')); }
  waitFor(predicate: (message: Message) => boolean): Promise<Message> {
    const existing = this.sent.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const observer = (message: Message) => {
        if (predicate(message)) { this.observers.delete(observer); resolve(message); }
      };
      this.observers.add(observer);
    });
  }
  get port(): Worker { return this as unknown as Worker; }
}

const bytes = new TextEncoder().encode('%PDF-1.7\n% Runtime lifecycle fixture\n%%EOF\n');
const code = (expected: string) => (error: unknown) => error instanceof PdfError && error.code === expected;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const reason of ['cancel', 'timeout', 'error'] as const) {
  test(`installed PDFWorker with an unresponsive raw port terminates once on ${reason}`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const raw = new TestWorker(); const created = deferred<void>();
    const abort = new AbortController(); let documentRequests = 0;
    const runtime: PdfRuntime = {
      library: { getDocument() { documentRequests++; throw new Error('must not parse'); } } as unknown as PdfRuntime['library'],
      createWorker() {
        const owned = createOwnedPdfWorker(library, raw.port); created.resolve(); return owned;
      },
    };
    const opening = openVerifiedPdf(bytes, { runtime, signal: abort.signal });
    await created.promise;
    const bridge = library.PDFWorker.create({ port: raw.port });
    await bridge.promise;
    assert.equal(documentRequests, 0, 'the port-backed PDFWorker resolves before the raw worker is ready');
    if (reason === 'cancel') abort.abort();
    else if (reason === 'timeout') context.mock.timers.tick(PDF_LIMITS.operationTimeoutMs);
    else raw.fail();
    await assert.rejects(opening, code(reason === 'cancel' ? 'CANCELLED' : reason === 'timeout' ? 'TIMEOUT' : 'READER_UNAVAILABLE'));
    raw.ready(); await Promise.resolve();
    assert.equal(bridge.destroyed, true); assert.equal(raw.terminated, 1); assert.equal(documentRequests, 0);
    assert.equal([...raw.listeners.values()].reduce((count, listeners) => count + listeners.size, 0), 0);
  });
}

test('raw worker ownership is released when the PDFWorker bridge cannot be constructed', () => {
  const raw = new TestWorker();
  assert.throws(() => createOwnedPdfWorker({ PDFWorker: { create() { throw new Error('bridge failed'); } } } as unknown as typeof library, raw.port), /bridge failed/);
  assert.equal(raw.terminated, 1);
});

for (const reason of ['parse', 'close', 'abort'] as const) {
  test(`installed PDFWorker raw port is terminated after document teardown on ${reason}`, async () => {
    const raw = new TestWorker(); const created = deferred<void>(); const events: string[] = [];
    const abort = new AbortController();
    const task = {
      get promise() { return reason === 'parse' ? Promise.reject(new Error('invalid PDF')) : Promise.resolve(document); },
      async destroy() { assert.equal(raw.terminated, 0); events.push('task'); await Promise.resolve(); },
    } as PDFDocumentLoadingTask;
    const document = { numPages: 1, loadingTask: task, async getPage() { return {
      view: [0, 0, 100, 100], rotate: 0, userUnit: 1, getViewport: () => ({ width: 100, height: 100 }), cleanup() {},
    }; } } as unknown as PDFDocumentProxy;
    const runtime: PdfRuntime = {
      library: { getDocument() { return task; } } as unknown as PdfRuntime['library'],
      createWorker() { const owned = createOwnedPdfWorker(library, raw.port); created.resolve(); return owned; },
    };
    const opening = openVerifiedPdf(bytes, { runtime, signal: abort.signal });
    await created.promise; const bridge = library.PDFWorker.create({ port: raw.port }); raw.ready();
    if (reason === 'parse') await assert.rejects(opening, code('INVALID_PDF'));
    else {
      const pdf = await opening;
      if (reason === 'abort') abort.abort();
      await Promise.all([pdf.close(), pdf.close()]);
    }
    assert.deepEqual(events, ['task']); assert.equal(bridge.destroyed, true); assert.equal(raw.terminated, 1);
  });
}

function textStream() {
  const raw = new TestWorker();
  const bridge = library.PDFWorker.create({ port: raw.port });
  const stream = bridge.messageHandler.sendWithStream('GetTextContent', {} as JSON, { highWaterMark: 0 });
  const request = raw.sent.find((message) => message.action === 'GetTextContent')!;
  const receive = (stream: number, extra: Partial<Message> = {}) => raw.emit({
    sourceName: 'worker', targetName: 'main', streamId: request.streamId, stream, success: true, ...extra,
  });
  receive(8); // START_COMPLETE
  return { raw, bridge, stream, receive, page: { streamTextContent: () => stream } as unknown as PDFPageProxy };
}

for (const reason of ['cancel', 'timeout', 'limit'] as const) {
  test(`installed PDF.js text stream sends one valid CANCEL on ${reason} and ignores late chunks`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const channel = textStream(); const abort = new AbortController();
    try {
      const pending = boundedTextContent(channel.page, abort.signal);
      const expected = reason === 'cancel' ? 'CANCELLED' : reason === 'timeout' ? 'TIMEOUT' : 'TEXT_LIMIT';
      await channel.raw.waitFor((message) => message.stream === 6); // PULL
      if (reason === 'cancel') abort.abort();
      else if (reason === 'timeout') context.mock.timers.tick(PDF_LIMITS.requestTimeoutMs);
      else channel.receive(4, { chunk: { items: [{ str: 'x'.repeat(PDF_LIMITS.maxTextPageCharacters + 1) }], styles: {}, lang: null } });
      channel.receive(7); // PULL_COMPLETE
      const cancelled = await channel.raw.waitFor((message) => message.stream === 1);
      assert.ok(cancelled.reason instanceof Error);
      assert.equal(cancelled.reason.message, new PdfError(expected).message);
      assert.doesNotThrow(() => channel.receive(4, { chunk: { items: [{ str: 'late' }], styles: {}, lang: null } }));
      channel.receive(2); // CANCEL_COMPLETE
      await assert.rejects(pending, code(expected));
      assert.equal(channel.raw.sent.filter((message) => message.stream === 1).length, 1);
      assert.equal(channel.stream.locked, false);
    } finally { channel.bridge.destroy(); }
  });
}

test('text extraction releases its reader after a bounded wait when CANCEL_COMPLETE never arrives', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const channel = textStream(); const abort = new AbortController();
  try {
    const pending = boundedTextContent(channel.page, abort.signal);
    const rejected = assert.rejects(pending, code('CANCELLED'));
    await channel.raw.waitFor((message) => message.stream === 6);
    abort.abort(); await channel.raw.waitFor((message) => message.stream === 1);
    await setImmediate();
    assert.equal(channel.stream.locked, true);
    context.mock.timers.tick(PDF_LIMITS.teardownTimeoutMs);
    await rejected;
    assert.equal(channel.stream.locked, false);
    assert.doesNotThrow(() => channel.receive(4, { chunk: { items: [], styles: {}, lang: null } }));
  } finally { channel.bridge.destroy(); }
});

test('a naturally completed text stream needs no cancellation message', async () => {
  const channel = textStream();
  try {
    const pending = boundedTextContent(channel.page);
    await channel.raw.waitFor((message) => message.stream === 6);
    channel.receive(4, { chunk: { items: [{ str: 'complete' }], styles: {}, lang: null } });
    channel.receive(7); channel.receive(3); // PULL_COMPLETE, CLOSE
    assert.equal((await pending).items.length, 1);
    assert.equal(channel.raw.sent.some((message) => message.stream === 1), false);
    assert.equal(channel.stream.locked, false);
  } finally { channel.bridge.destroy(); }
});
