import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

async function startup({ unavailable = false, recover = false } = {}) {
  const events = [];
  let ready = false;
  const app = {
    isPackaged: false,
    whenReady() { events.push('whenReady'); ready = true; return Promise.resolve(); },
    setAppUserModelId() {},
    on() {},
    relaunch() { events.push('relaunch'); },
    quit() { events.push('quit'); },
  };
  class BrowserWindow {
    constructor() {
      assert.equal(ready, true);
      events.push('window');
      this.webContents = { setWindowOpenHandler() {}, on() {} };
    }
    once() {}
    loadFile() {}
  }
  const dependencies = {
    'node:path': path,
    electron: { app, BrowserWindow, ipcMain: { handle() {} }, shell: {}, dialog: {
      showErrorBox(_title, message) { events.push('error: ' + message); },
    } },
    './backend.cjs': { createBackend() { events.push('backend'); return {}; } },
    './libraryLocation.cjs': { createLibraryLocationManager() { return {
      resolve() {
        events.push('resolve');
        assert.equal(ready, false, 'profile must be restored before Electron readiness');
        if (unavailable) throw new Error('missing registered profile');
      },
      async recover(error) {
        assert.equal(ready, true, 'native recovery dialog must wait for ready');
        assert.match(error.message, /missing registered profile/);
        events.push('recover');
        return recover;
      },
      rememberActive() { events.push('remember'); },
    }; } },
    './localPdfProtocol.cjs': { registerLocalPdfProtocolScheme() {}, registerLocalPdfProtocol() {} },
  };
  vm.runInNewContext(source, {
    require(name) { assert.ok(name in dependencies, name); return dependencies[name]; },
    __dirname: '/fixture/electron', process: { env: {}, platform: 'win32' }, setImmediate,
  });
  await new Promise(setImmediate);
  return events;
}

test('main resolves the complete profile before Electron becomes ready', async () => {
  assert.deepEqual(await startup(), ['resolve', 'whenReady', 'backend', 'remember', 'window']);
});

test('recovery relaunches without opening a backend or a late-switched session', async () => {
  assert.deepEqual(await startup({ unavailable: true, recover: true }), ['resolve', 'whenReady', 'recover', 'relaunch', 'quit']);
});

test('canceled startup recovery quits without creating an empty library', async () => {
  assert.deepEqual(await startup({ unavailable: true }), ['resolve', 'whenReady', 'recover', 'quit']);
});
