import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import { openVerifiedPdf, VerifiedPdf, type PdfRuntime } from '../src/pdf/engine.ts';
import { PdfError } from '../src/pdf/errors.ts';
import { sha256 } from '../src/pdf/acquisition.ts';
import { boundedCanvasScale, normalizedPointToViewport, pageWindow, quadBounds, rectToQuad, viewportPointToNormalized } from '../src/pdf/geometry.ts';
import { PDF_LIMITS, type PdfVersion } from '../src/pdf/types.ts';

const id = () => crypto.randomUUID();
const code = (expected: string) => (error: unknown) => error instanceof PdfError && error.code === expected;
const encode = (value: string) => new TextEncoder().encode(value);

/** A complete synthetic PDF, with xref offsets, nonzero CropBox and an internally rotated page. */
function fixture(texts = ['First page: synthetic science.', 'Second page: synthetic result.', 'Third page: conclusion.']): Uint8Array {
  const count = texts.length; const outline = 4 + count * 2;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /Outlines ${outline} 0 R >>`,
    `<< /Type /Pages /Kids [${texts.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  texts.forEach((text, index) => {
    const content = `BT /F1 15 Tf 30 350 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /CropBox [10 20 310 420] /Rotate ${index === 1 ? 90 : 0} /UserUnit ${index === 1 ? 2 : 1} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${encode(content).length} >>\nstream\n${content}endstream`);
  });
  objects.push(`<< /Type /Outlines /First ${outline + 1} 0 R /Last ${outline + 1} 0 R /Count 1 >>`);
  objects.push(`<< /Title (Synthetic chapter) /Parent ${outline} 0 R /Dest [${4 + (count > 1 ? 2 : 0)} 0 R /Fit] >>`);
  let file = '%PDF-1.7\n'; const offsets: number[] = [0];
  objects.forEach((object, index) => { offsets.push(encode(file).length); file += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = encode(file).length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  file += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(file);
}

async function version(bytes: Uint8Array, pageCount: number | null = 3): Promise<PdfVersion> {
  return { entityId: id(), data: { paperId: id(), attachmentId: id(), sha256: await sha256(bytes), sizeBytes: bytes.length,
    mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount } };
}

test('real PDF.js opens complete verified bytes, extracts all pages, searches and resolves internal contents', async () => {
  const bytes = fixture(); const expected = await version(bytes);
  const pdf = await openVerifiedPdf(bytes, { expected });
  try {
    assert.equal(pdf.pageCount, 3); assert.equal(pdf.sha256, expected.data.sha256);
    assert.equal(bytes.byteLength, expected.data.sizeBytes, 'worker transfer must not detach the caller cache bytes');
    assert.deepEqual(pdf.pages[0].cropBox, [10, 20, 310, 420]);
    assert.equal(pdf.pages[1].rotation, 90); assert.equal(pdf.pages[1].userUnit, 2);
    assert.equal(pdf.pages[1].width, 800); assert.equal(pdf.pages[1].height, 600);
    const text = await pdf.documentText();
    assert.deepEqual(text.map((page) => page.pageIndex), [0, 1, 2]);
    assert.match(text[1].text, /Second page: synthetic result/);
    const search = await pdf.search('SYNTHETIC');
    assert.deepEqual(search.matches.map((match) => match.pageIndex), [0, 1]); assert.equal(search.limited, false);
    assert.deepEqual(await pdf.outline(), [{ title: 'Synthetic chapter', pageIndex: 1, depth: 0 }]);
  } finally { await pdf.close(); }
  await assert.rejects(pdf.text(0), code('CANCELLED'));
});

test('SHA, length, page-count mismatch and invalid or incomplete PDFs cannot become a verified version', async () => {
  const bytes = fixture(); const expected = await version(bytes);
  await assert.rejects(openVerifiedPdf(bytes, { expected: { ...expected, data: { ...expected.data, sha256: '0'.repeat(64) } } }), code('VERSION_MISMATCH'));
  await assert.rejects(openVerifiedPdf(bytes, { expected: { ...expected, data: { ...expected.data, sizeBytes: bytes.length + 1 } } }), code('VERSION_MISMATCH'));
  await assert.rejects(openVerifiedPdf(bytes, { expected: { ...expected, data: { ...expected.data, pageCount: 4 } } }), code('VERSION_MISMATCH'));
  await assert.rejects(openVerifiedPdf(bytes.subarray(0, bytes.length - 10)), code('INCOMPLETE'));
  await assert.rejects(openVerifiedPdf(encode('%PDF-1.7\nnot a PDF object graph\n%%EOF\n')), code('INVALID_PDF'));
});

test('abort before opening and after opening never leaves usable document state', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(openVerifiedPdf(fixture(), { signal: before.signal }), code('CANCELLED'));
  const after = new AbortController(); const pdf = await openVerifiedPdf(fixture(), { signal: after.signal });
  after.abort(); await assert.rejects(pdf.page(0), code('CANCELLED')); await pdf.close();
});

test('real PDF.js explicitly owned workers close and reopen without detaching cached bytes', async () => {
  const library = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const workers: PDFWorker[] = [];
  const runtime: PdfRuntime = { library, createWorker() {
    const worker = new library.PDFWorker(); workers.push(worker);
    return { ready: worker.promise.then(() => worker), dispose: () => worker.destroy() };
  } };
  const bytes = fixture(); const expected = await version(bytes);
  for (let attempt = 0; attempt < 3; attempt++) {
    const abort = new AbortController();
    const pdf = await openVerifiedPdf(bytes, { expected, runtime, signal: abort.signal });
    assert.equal((await pdf.documentText()).length, 3);
    assert.equal(workers[attempt].destroyed, false);
    if (attempt === 1) abort.abort();
    await Promise.all([pdf.close(), pdf.close()]);
    assert.equal(workers[attempt].destroyed, true);
    assert.equal(await sha256(bytes), expected.data.sha256);
  }
  assert.equal(new Set(workers).size, 3);
});

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('worker startup failures are reader errors and release explicit worker ownership', async () => {
  for (const constructorFailure of [false, true]) {
    let destroyed = 0; let documentRequests = 0;
    const runtime: PdfRuntime = {
      library: { getDocument() { documentRequests++; throw new Error('must not parse'); } } as unknown as PdfRuntime['library'],
      createWorker() {
        if (constructorFailure) throw new Error('Worker blocked');
        return { ready: Promise.reject(new Error('Worker unavailable')), dispose() { destroyed++; } };
      },
    };
    await assert.rejects(openVerifiedPdf(fixture(), { runtime }), code('READER_UNAVAILABLE'));
    assert.equal(documentRequests, 0); assert.equal(destroyed, constructorFailure ? 0 : 1);
  }
});

for (const reason of ['cancel', 'timeout'] as const) {
  test(`${reason} before worker ready releases it once and ignores late readiness`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const ready = deferred<void>(); const created = deferred<void>();
    const abort = new AbortController(); let destroyed = 0; let documentRequests = 0;
    const runtime: PdfRuntime = {
      library: { getDocument() { documentRequests++; throw new Error('must not parse'); } } as unknown as PdfRuntime['library'],
      createWorker() {
        created.resolve();
        return { ready: ready.promise.then(() => ({} as PDFWorker)), dispose() { destroyed++; } };
      },
    };
    const opening = openVerifiedPdf(fixture(), { runtime, signal: abort.signal });
    await created.promise;
    if (reason === 'cancel') abort.abort();
    else context.mock.timers.tick(PDF_LIMITS.operationTimeoutMs);
    await assert.rejects(opening, code(reason === 'cancel' ? 'CANCELLED' : 'TIMEOUT'));
    ready.resolve(); await Promise.resolve();
    assert.equal(destroyed, 1); assert.equal(documentRequests, 0);
  });
}

test('parse failure, resource failure and parse cancellation destroy the task before its explicit worker', async () => {
  for (const reason of ['parse', 'resource', 'cancel'] as const) {
    const created = deferred<void>(); const pending = deferred<PDFDocumentProxy>();
    const events: string[] = []; const abort = new AbortController();
    const runtime: PdfRuntime = {
      library: { getDocument() {
        created.resolve();
        return { promise: reason === 'cancel' ? pending.promise : Promise.reject(new Error('Failed')),
          async destroy() { assert.equal(events.length, 0); events.push('task'); await Promise.resolve(); },
        } as unknown as PDFDocumentLoadingTask;
      } } as unknown as PdfRuntime['library'],
      createWorker() { return { ready: Promise.resolve({} as PDFWorker), dispose() { events.push('worker'); } }; },
      resourceError: () => reason === 'resource' ? new PdfError('READER_RESOURCE') : null,
    };
    const opening = openVerifiedPdf(fixture(), { runtime, signal: abort.signal });
    await created.promise;
    if (reason === 'cancel') abort.abort();
    await assert.rejects(opening, code(reason === 'cancel' ? 'CANCELLED' : reason === 'resource' ? 'READER_RESOURCE' : 'INVALID_PDF'));
    assert.deepEqual(events, ['task', 'worker']);
  }
});

test('a worker that cannot acknowledge parse teardown is released after a bounded grace period', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const created = deferred<void>(); const never = new Promise<never>(() => undefined);
  const events: string[] = []; const abort = new AbortController();
  const runtime: PdfRuntime = {
    library: { getDocument() {
      created.resolve();
      return { promise: never, destroy() { events.push('task'); return never; } } as unknown as PDFDocumentLoadingTask;
    } } as unknown as PdfRuntime['library'],
    createWorker() { return { ready: Promise.resolve({} as PDFWorker), dispose() { events.push('worker'); } }; },
  };
  const opening = openVerifiedPdf(fixture(), { runtime, signal: abort.signal });
  await created.promise; abort.abort();
  assert.deepEqual(events, ['task']);
  context.mock.timers.tick(PDF_LIMITS.teardownTimeoutMs);
  await assert.rejects(opening, code('CANCELLED'));
  assert.deepEqual(events, ['task', 'worker']);
});

test('crop-box anchors survive all display rotations, zoom and PDF user units', async () => {
  const pdf = await openVerifiedPdf(fixture());
  try {
    for (let index = 0; index < 2; index++) {
      const page = await pdf.page(index); const box = pdf.pages[index].cropBox;
      for (const rotation of [0, 90, 180, 270]) for (const scale of [0.5, 1, 2.75]) {
        const viewport = page.getViewport({ scale, rotation });
        for (const [x, y] of [[0, 0], [0.25, 0.75], [1, 1]]) {
          const point = normalizedPointToViewport(x, y, box, viewport);
          const recovered = viewportPointToNormalized(point[0], point[1], box, viewport);
          assert.ok(Math.abs(recovered[0] - x) < 1e-10); assert.ok(Math.abs(recovered[1] - y) < 1e-10);
        }
        const rect = { left: viewport.width * 0.1, top: viewport.height * 0.2,
          right: viewport.width * 0.6, bottom: viewport.height * 0.5 };
        const quad = rectToQuad(rect, box, viewport); const recovered = quadBounds(quad, box, viewport);
        for (const key of ['left', 'top', 'right', 'bottom'] as const) assert.ok(Math.abs(rect[key] - recovered[key]) < 1e-8);
      }
    }
    const page = await pdf.page(0); const view = page.getViewport({ scale: 1, rotation: 0 });
    assert.deepEqual(viewportPointToNormalized(0, 0, pdf.pages[0].cropBox, view), [0, 1]);
    assert.deepEqual(viewportPointToNormalized(300, 400, pdf.pages[0].cropBox, view), [1, 0]);
  } finally { await pdf.close(); }
});

test('render windows and raster budgets stay bounded even for large zoomed pages', () => {
  assert.deepEqual(pageWindow(100, 2000, true), [99, 100, 101]);
  assert.deepEqual(pageWindow(0, 2000, true), [0, 1]); assert.deepEqual(pageWindow(1999, 2000, true), [1998, 1999]);
  assert.deepEqual(pageWindow(100, 2000, false), [100]); assert.deepEqual(pageWindow(-1, 20, true), []);
  for (const [width, height, dpr] of [[300, 600, 3], [20000, 18000, 4], [2000, 4000, 2]]) {
    const scale = boundedCanvasScale(width, height, dpr, PDF_LIMITS.maxCanvasPixels);
    assert.ok(Math.floor(width * scale) * Math.floor(height * scale) <= PDF_LIMITS.maxCanvasPixels);
    assert.ok(scale <= 2);
  }
});

test('empty and oversized full-text contexts fail explicitly instead of claiming a complete document', async () => {
  const empty = await openVerifiedPdf(fixture(['']));
  try { await assert.rejects(empty.documentText(), code('NO_TEXT')); } finally { await empty.close(); }
  let pageRequests = 0; let destroyed = false;
  const document = { async getPage() { pageRequests++; return {
    streamTextContent() { return new ReadableStream({ start(controller) {
      controller.enqueue({ items: [{ str: 'a'.repeat(200001), hasEOL: false }], styles: {}, lang: null }); controller.close();
    } }); }, cleanup() {},
  }; }, loadingTask: { async destroy() { destroyed = true; } } } as unknown as PDFDocumentProxy;
  const pages = Array.from({ length: 6 }, () => ({ cropBox: [0, 0, 300, 400] as const, width: 300, height: 400, rotation: 0, userUnit: 1 }));
  const large = new VerifiedPdf(document, 'a'.repeat(64), 10, pages);
  await assert.rejects(large.documentText(), code('TEXT_LIMIT')); assert.equal(pageRequests, 5);
  await large.close(); assert.equal(destroyed, true);
});
