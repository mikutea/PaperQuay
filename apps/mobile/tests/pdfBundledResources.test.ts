import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { bundledPdfResources } from '../src/pdf/bundledResources.ts';
import { PdfError } from '../src/pdf/errors.ts';

test('bundled CMap, font and image decoder bytes remain available offline after worker transfer', async (context) => {
  const files = [
    ['cmaps', 'cMapUrl', 'UniGB-UTF16-H.bcmap'],
    ['standard_fonts', 'standardFontDataUrl', 'LiberationSans-Regular.ttf'],
    ['wasm', 'wasmUrl', 'openjpeg.wasm'],
  ];
  const originals = await Promise.all(files.map(([directory, _kind, filename]) =>
    readFile(new URL(`../node_modules/pdfjs-dist/${directory}/${filename}`, import.meta.url))));
  const resources = bundledPdfResources(Object.fromEntries(files.map(([directory, _kind, filename], index) =>
    [`/pdfjs-dist/${directory}/${filename}`, `data:application/octet-stream;base64,${originals[index].toString('base64')}`])));
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  for (let index = 0; index < files.length; index++) {
    const [, kind, filename] = files[index];
    const first = await new resources.BinaryDataFactory().fetch({ kind, filename });
    assert.deepEqual(first, new Uint8Array(originals[index]));
    structuredClone(first, { transfer: [first.buffer] });
    assert.equal(first.byteLength, 0);
    const reopened = await new resources.BinaryDataFactory().fetch({ kind, filename });
    assert.deepEqual(reopened, new Uint8Array(originals[index]));
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(resources.error(), null);
});

test('a missing, external or malformed resource fails explicitly without issuing a fetch', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  for (const [kind, filename, url] of [
    ['cMapUrl', '../other.bcmap', 'data:application/octet-stream;base64,AQID'],
    ['cMapUrl', 'map.bcmap', 'https://untrusted.example/map.bcmap'],
    ['wasmUrl', 'decoder.wasm', 'data:application/wasm;base64,!invalid!'],
  ]) {
    const resources = bundledPdfResources({
      '/pdfjs-dist/cmaps/map.bcmap': url,
      '/pdfjs-dist/wasm/decoder.wasm': url,
    });
    await assert.rejects(new resources.BinaryDataFactory().fetch({ kind, filename }),
      (error: unknown) => error instanceof PdfError && error.code === 'READER_RESOURCE');
    assert.equal(resources.error()?.code, 'READER_RESOURCE');
  }
  assert.equal(fetch.mock.callCount(), 0);
});
