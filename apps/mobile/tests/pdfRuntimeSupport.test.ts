import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PdfError, pdfError } from '../src/pdf/errors.ts';
import { assertPdfRuntimeSupported } from '../src/pdf/runtimeSupport.ts';

const compatibilitySource = readFileSync(new URL('../src/pdf/promiseWithResolvers.mjs', import.meta.url), 'utf8');

test('the PDF bootstrap provides the missing Promise API in an older worker', async () => {
  const result = runInNewContext(`
    delete Promise.withResolvers;
    ${compatibilitySource}
    const loading = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    const result = Promise.all([loading.promise, cancelled.promise.catch(error => error.message)]);
    loading.resolve('page loaded');
    cancelled.reject(new Error('cancelled'));
    result;
  `);
  assert.deepEqual(Array.from(await result), ['page loaded', 'cancelled']);
});

test('the PDF bootstrap preserves an existing Promise API', () => {
  assert.equal(runInNewContext(`
    const original = Promise.withResolvers;
    ${compatibilitySource}
    typeof original === 'function' && Promise.withResolvers === original;
  `), true);
});

test('missing PDF.js runtime API yields upgrade guidance rather than a damaged-file or retry error', (context) => {
  const original = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');
  context.after(() => {
    if (original) Object.defineProperty(Promise, 'withResolvers', original);
    else Reflect.deleteProperty(Promise, 'withResolvers');
  });
  for (const value of [undefined, null, true]) {
    Object.defineProperty(Promise, 'withResolvers', { configurable: true, value });
    assert.throws(assertPdfRuntimeSupported, (error) => {
      assert.ok(error instanceof PdfError);
      assert.equal(error.code, 'READER_UNSUPPORTED');
      assert.equal(pdfError(error), error, 'the reader must retain the specific recovery action');
      assert.match(error.message, /更新.*System WebView/);
      return true;
    });
  }
});

test('the supported runtime keeps its native Promise API and is not patched', () => {
  const original = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');
  assert.equal(typeof original?.value, 'function');
  assert.doesNotThrow(assertPdfRuntimeSupported);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Promise, 'withResolvers'), original);
});
