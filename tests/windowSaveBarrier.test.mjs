import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createWindowSaveBarrier } = require('../electron/windowSaveBarrier.cjs');
const settled = () => new Promise(setImmediate);

function fixture({ response = 0, timeoutMs = 10000 } = {}) {
  const sent = [];
  const dialogs = [];
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.webContents.send = (...args) => sent.push(args);
  let destroyed = false;
  let canceled = 0;
  window.isDestroyed = () => destroyed;
  window.close = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    window.emit('close', event);
    if (!event.prevented) { destroyed = true; window.emit('closed'); }
  };
  const barrier = createWindowSaveBarrier({
    dialog: { async showMessageBox(_window, options) { dialogs.push(options); return { response }; } },
    continueClose: (target) => target.close(),
    cancelClose: () => { canceled++; },
    timeoutMs,
  });
  barrier.attach(window);
  const complete = (extra = {}) => barrier.complete(window.webContents, { ...sent.at(-1)[2], ...extra });
  return { window, barrier, sent, dialogs, complete, canceled: () => canceled };
}

test('window close waits for the renderer save and coalesces repeated close clicks', async () => {
  const f = fixture();
  f.barrier.ready(f.window.webContents);
  f.window.close();
  f.window.close();
  assert.equal(f.window.isDestroyed(), false);
  assert.equal(f.sent.length, 1);
  f.barrier.complete({}, f.sent[0][2]);
  f.barrier.complete(f.window.webContents, { requestId: 'old-request' });
  await settled();
  assert.equal(f.window.isDestroyed(), false);
  f.complete();
  await settled();
  assert.equal(f.window.isDestroyed(), true);
  assert.equal(f.dialogs.length, 0);
});

test('failed save defaults to staying open and a later close retries', async () => {
  const f = fixture();
  f.barrier.ready(f.window.webContents);
  f.window.close();
  f.complete({ error: true });
  await settled();
  assert.equal(f.window.isDestroyed(), false);
  assert.equal(f.dialogs[0].defaultId, 0);
  assert.equal(f.canceled(), 1);
  f.window.close();
  assert.equal(f.sent.length, 2);
  f.complete();
  await settled();
  assert.equal(f.window.isDestroyed(), true);
});

test('closing despite a save failure requires the explicit close-anyway choice', async () => {
  const f = fixture({ response: 1 });
  f.barrier.ready(f.window.webContents);
  f.window.close();
  f.complete({ error: true });
  await settled();
  assert.equal(f.window.isDestroyed(), true);
  assert.equal(f.dialogs.length, 1);
});

test('an unresponsive renderer gets a bounded timeout and can stay open', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.barrier.ready(f.window.webContents);
  f.window.close();
  t.mock.timers.tick(10000);
  await settled();
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.window.isDestroyed(), false);
  f.window.close();
  f.complete();
  await settled();
});

test('a window that has not loaded the UI can still close without a save round trip', () => {
  const f = fixture();
  f.window.close();
  assert.equal(f.window.isDestroyed(), true);
  assert.equal(f.sent.length, 0);
});
