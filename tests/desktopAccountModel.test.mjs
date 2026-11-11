import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
let models;
test.before(async () => {
  const built = await build({
    entryPoints: ['src/services/desktopAccountModel.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
  models = module.exports;
});

test('optional account model discovery permits local fallback while an explicit scoped selection reports failure', async t => {
  const previous = globalThis.window;
  const failure = new Error('NETWORK_UNAVAILABLE');
  globalThis.window = { paperquay: { invoke: async () => { throw failure; } } };
  t.after(() => { globalThis.window = previous; });
  assert.equal(await models.loadDesktopAccountModelPreset(), null);
  await assert.rejects(models.loadDesktopAccountModelPreset(7), error => error === failure);
});
