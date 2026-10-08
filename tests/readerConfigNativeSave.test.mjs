import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadService(library, write) {
  function load(file, dependencies) {
    const exports = {};
    const source = readFileSync(new URL('../src/services/' + file, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
    vm.runInNewContext(outputText, { exports, setTimeout, clearTimeout, console, require: name => {
      if (dependencies[name]) return dependencies[name];
      throw new Error('Unexpected dependency ' + name);
    } });
    return exports;
  }
  return load('readerConfig.ts', {
    './debouncedSave': load('debouncedSave.ts', {}),
    './library': library,
    './desktop': { writeLocalTextFile: write },
  });
}
const paths = { configPath: 'fixture-config.json' };

test('restart flush waits for native Zotero settings and then the config file', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const service = loadService({
    getLibrarySettings: async () => ({ zoteroLocalDataDir: 'old' }),
    updateLibrarySettings: async patch => { calls.push(['native', { ...patch }]); await gate; return patch; },
  }, async (_path, content) => { calls.push(['file', JSON.parse(content).zoteroLocalDataDir]); });
  service.scheduleReaderConfigWrite({ zoteroLocalDataDir: 'new' }, paths, () => calls.push(['saved']), assert.fail);
  const flushing = service.flushReaderConfigWrites();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['native', { zoteroLocalDataDir: 'new' }]]);
  release(); await flushing;
  assert.deepEqual(calls, [['native', { zoteroLocalDataDir: 'new' }], ['file', 'new'], ['saved']]);
});

test('failed native synchronization rejects close and retains the latest edit for retry', async () => {
  let fail = true;
  let current = 'old';
  const files = [], failures = [];
  const service = loadService({
    getLibrarySettings: async () => ({ zoteroLocalDataDir: current }),
    updateLibrarySettings: async patch => { if (fail) throw new Error('native save failed'); current = patch.zoteroLocalDataDir; return patch; },
  }, async (_path, content) => files.push(JSON.parse(content).zoteroLocalDataDir));
  service.scheduleReaderConfigWrite({ zoteroLocalDataDir: 'first' }, paths, () => {}, error => failures.push(error.message));
  await assert.rejects(service.flushReaderConfigWrites(), /native save failed/);
  assert.deepEqual(files, []);
  assert.deepEqual(failures, ['native save failed']);
  service.scheduleReaderConfigWrite({ zoteroLocalDataDir: 'latest' }, paths, () => {}, assert.fail);
  fail = false; await service.flushReaderConfigWrites();
  assert.equal(current, 'latest');
  assert.deepEqual(files, ['latest']);
});

test('unchanged native directories do not rewrite library settings; clearing is persisted', async () => {
  let current = 'existing';
  const patches = [];
  const service = loadService({
    getLibrarySettings: async () => ({ zoteroLocalDataDir: current }),
    updateLibrarySettings: async patch => { patches.push({ ...patch }); current = patch.zoteroLocalDataDir; return patch; },
  }, async () => {});
  service.scheduleReaderConfigWrite({ zoteroLocalDataDir: 'existing' }, paths, () => {}, assert.fail);
  await service.flushReaderConfigWrites();
  assert.deepEqual(patches, []);
  service.scheduleReaderConfigWrite({ zoteroLocalDataDir: '' }, paths, () => {}, assert.fail);
  await service.flushReaderConfigWrites();
  assert.deepEqual(patches, [{ zoteroLocalDataDir: '' }]);
});

test('a retry after a config-file failure still reconciles the native settings in memory', async () => {
  let current = 'old';
  let failFile = true;
  const saved = [];
  const service = loadService({
    getLibrarySettings: async () => ({ zoteroLocalDataDir: current }),
    updateLibrarySettings: async patch => { current = patch.zoteroLocalDataDir; return patch; },
  }, async () => { if (failFile) throw new Error('config disk full'); });
  service.scheduleReaderConfigWrite({ zoteroLocalDataDir: 'new' }, paths, native => saved.push(native.zoteroLocalDataDir), () => {});
  await assert.rejects(service.flushReaderConfigWrites(), /config disk full/);
  assert.equal(current, 'new'); assert.deepEqual(saved, []);
  failFile = false; await service.flushReaderConfigWrites();
  assert.deepEqual(saved, ['new']);
});
