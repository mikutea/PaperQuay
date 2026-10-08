import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');

function service(file, flush, invoke) {
  const source = readFileSync(new URL('../src/services/' + file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, Error,
    require(name) {
      if (name === '../platform/electron/core') return { invoke };
      if (name === './readerConfig') return { flushReaderConfigWrites: flush };
      throw new Error('Unexpected dependency: ' + name);
    },
  });
  return exports;
}

for (const [file, method, command, args] of [
  ['appUpdate.ts', 'installAppUpdate', 'app_update_install', []],
  ['libraryLocation.ts', 'activateLibraryLocation', 'library_location_activate', ['fixture-token']],
]) {
  test(`${method} waits for settings before triggering a restart`, async () => {
    let finish;
    const saved = new Promise(resolve => { finish = resolve; });
    const calls = [];
    const commands = service(file, () => saved, async (...values) => { calls.push(values); return { done: true }; });
    const result = commands[method](...args);
    await Promise.resolve();
    assert.equal(calls.length, 0);
    finish();
    assert.deepEqual(await result, { done: true });
    assert.equal(calls[0][0], command);
    if (args.length) assert.equal(calls[0][1].token, args[0]);
  });

  test(`${method} does not start an installer or change the library when settings cannot save`, async () => {
    let calls = 0;
    const commands = service(file, async () => { throw new Error('fixture disk full'); }, async () => { calls++; });
    await assert.rejects(commands[method](...args), /fixture disk full/);
    assert.equal(calls, 0);
  });
}
