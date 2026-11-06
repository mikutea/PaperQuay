import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { bundledPdfResources } from '../src/pdf/bundledResources.ts';
import { createBundledImageDecoderUrl, type BundledImageDecoders } from '../src/pdf/bundledImageDecoders.ts';
import { openVerifiedPdf } from '../src/pdf/engine.ts';
import expected from './fixtures/pdf-scanned/expected.json';

const fixtureDirectory = new URL('./fixtures/pdf-scanned/', import.meta.url);
const decoderDirectory = new URL('../node_modules/pdfjs-dist/wasm/', import.meta.url);
const digest = (bytes: Uint8Array | Uint8ClampedArray) => createHash('sha256').update(bytes).digest('hex');

test('original scan fixture bytes match their reproducible CC0 manifests', async () => {
  assert.equal(expected.license, 'CC0-1.0');
  for (const fixture of expected.fixtures) {
    const bytes = await readFile(new URL(`${fixture.name}.pdf`, fixtureDirectory));
    assert.equal(bytes.byteLength, fixture.bytes);
    assert.equal(digest(bytes), fixture.sha256);
    assert.equal(fixture.pages.length, 2);
    assert(fixture.pages.every((page) => page.nonwhitePixels > 4000 && page.nonwhitePixels < 5000));
  }
});

test('installed PDF.js decodes JPX, JBIG2 and CCITT to the original pixels with bundled WASM and JS fallbacks', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'paperquay-pdf-decoder-test-'));
  const modules: { path: string; source: Blob }[] = [];
  // Node cannot import blob: modules. Persist the exact generated module bodies as
  // temporary ESM files; the browser regression separately exercises real Blob URLs.
  context.mock.method(URL, 'createObjectURL', (source: Blob) => {
    const path = join(directory, `module-${modules.length}.mjs`);
    modules.push({ path, source });
    return pathToFileURL(path).href;
  });
  try {
    const names = ['openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js'] as const;
    const sources = Object.fromEntries(await Promise.all(names.map(async (name) =>
      [name, await readFile(new URL(name, decoderDirectory), 'utf8')]))
    ) as BundledImageDecoders;
    const wasmUrl = createBundledImageDecoderUrl(sources);
    assert.equal(modules.length, 3);
    assert(wasmUrl.endsWith('#/'));
    await Promise.all(modules.map(async ({ path, source }) => writeFile(path, await source.text())));
    const binaries = Object.fromEntries(await Promise.all(['openjpeg.wasm', 'jbig2.wasm'].map(async (name) =>
      [`/pdfjs-dist/wasm/${name}`, `data:application/wasm;base64,${(await readFile(new URL(name, decoderDirectory))).toString('base64')}`])));
    const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Regression is offline'); });
    const library = await import('pdfjs-dist/legacy/build/pdf.mjs');
    for (const useWasm of [true, false]) {
      for (const fixture of expected.fixtures) {
        const bytes = new Uint8Array(await readFile(new URL(`${fixture.name}.pdf`, fixtureDirectory)));
        const resources = bundledPdfResources(binaries);
        const pdf = await openVerifiedPdf(bytes, { runtime: { library, resourceError: resources.error,
          options: { useWasm, wasmUrl, useWorkerFetch: false, BinaryDataFactory: resources.BinaryDataFactory,
            isOffscreenCanvasSupported: false, isImageDecoderSupported: false } } });
        try {
          for (const index of [0, 1]) {
            const page = await pdf.page(index);
            const viewport = page.getViewport({ scale: 1 });
            const canvas = createCanvas(viewport.width, viewport.height);
            const drawing = canvas.getContext('2d');
            await page.render({ canvas: canvas as unknown as HTMLCanvasElement,
              canvasContext: drawing as unknown as CanvasRenderingContext2D, viewport }).promise;
            assert.equal(resources.error(), null);
            assert.equal(digest(drawing.getImageData(0, 0, canvas.width, canvas.height).data), fixture.pages[index].rgbaSha256,
              `${fixture.name} page ${index + 1}, useWasm=${useWasm}`);
            page.cleanup();
          }
        } finally { await pdf.close(); }
        assert.equal(digest(bytes), fixture.sha256, 'closing a worker must preserve cached PDF bytes');
      }
    }
    for (const name of ['../openjpeg_nowasm_fallback.js', '__proto__', 'other.js']) {
      const module = await import(`${wasmUrl}${name}`);
      await assert.rejects(module.default(), /Unknown bundled PDF image decoder/);
    }
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    // Only remove the temporary directory created by this test.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(basename(directory).startsWith('paperquay-pdf-decoder-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
