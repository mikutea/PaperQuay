import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { embedTexts } = require('../electron/backend/utils.cjs');

test('embedding request repairs lone surrogates without changing valid pairs', async () => {
  const originalFetch = globalThis.fetch;
  let sentInput;
  globalThis.fetch = async (_url, options) => {
    sentInput = JSON.parse(options.body).input;
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await embedTexts(['A\uD800B', 'C\uDC00D', '\uD83D\uDE00'], {
      model: 'local-test', baseUrl: 'http://127.0.0.1:1', apiKey: 'test-only',
    });
    assert.deepEqual(sentInput, ['A\uFFFDB', 'C\uFFFDD', '\uD83D\uDE00']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
