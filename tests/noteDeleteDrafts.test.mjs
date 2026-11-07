import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');

function service(invoke, clear) {
  const source = readFileSync(new URL('../src/services/notes.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const exports = {}, events = [];
  vm.runInNewContext(outputText, {
    exports, Error,
    require(name) {
      if (name === '../platform/electron/core') return { invoke };
      if (name === '../app/appEvents') return { emitNoteChanged: event => events.push(event) };
      if (name === '../features/notes/noteEditorUtils') return { clearNoteEditorDraftsForNote: clear };
      throw new Error('Unexpected dependency: ' + name);
    },
  });
  return { commands: exports, events };
}

test('note deletion clears its drafts only after the backend confirms deletion', async () => {
  let finish;
  const cleared = [], pending = new Promise(resolve => { finish = resolve; });
  const { commands, events } = service(() => pending, id => cleared.push(id));
  const deleting = commands.deleteNote('deleted-note');
  assert.deepEqual(cleared, []);
  finish();
  await deleting;
  assert.deepEqual(cleared, ['deleted-note']);
  assert.equal(events[0].action, 'deleted');
});

test('a failed deletion retains drafts and emits no deletion event', async () => {
  const cleared = [];
  const { commands, events } = service(async () => { throw new Error('delete refused'); }, id => cleared.push(id));
  await assert.rejects(commands.deleteNote('retained-note'), /delete refused/);
  assert.deepEqual(cleared, []);
  assert.deepEqual(events, []);
});
