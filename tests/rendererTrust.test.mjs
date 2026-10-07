import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const trust = require('../electron/rendererTrust.cjs');
const entry = 'file:///C:/PaperQuay/resources/app.asar/dist/index.html';

test('only the exact packaged or development entrypoint is privileged', () => {
  for (const expected of [entry, 'http://localhost:1420/']) {
    assert.equal(trust.isTrustedRendererUrl(expected + '#section', expected), true);
    for (const value of ['file://host/share/payload.html', 'file:///C:/private.html', expected + '/other', expected + '?foreign=1',
      'http://localhost:1420.evil/', 'http://localhost:1420/other', 'data:text/html,payload', 'about:blank']) {
      assert.equal(trust.isTrustedRendererUrl(value, expected), false, value);
    }
  }
});

test('foreign navigations, redirects, popups and frames cannot replace the app', () => {
  const contents = new EventEmitter(), external = [];
  contents.setWindowOpenHandler = (handler) => { contents.open = handler; };
  trust.attachRendererTrust(contents, (url) => external.push(url), entry);
  function navigate(eventName, url, isMainFrame = true) {
    const event = { url, isMainFrame, blocked: false, preventDefault() { this.blocked = true; } };
    contents.emit(eventName, event, url); return event.blocked;
  }
  assert.equal(navigate('will-navigate', entry), false);
  for (const url of ['file://host/share/payload.html', 'file:///C:/other.html', 'data:text/html,payload']) {
    assert.equal(navigate('will-navigate', url), true);
    assert.equal(navigate('will-frame-navigate', url), true);
    assert.equal(navigate('will-redirect', url), true);
    assert.equal(contents.open({ url }).action, 'deny');
  }
  assert.deepEqual(external, []);
  assert.equal(navigate('will-frame-navigate', 'https://example.com/', false), true);
  assert.equal(navigate('will-frame-navigate', 'about:srcdoc', false), false);
  assert.equal(navigate('will-navigate', 'https://example.com/paper'), true);
  assert.deepEqual(external, ['https://example.com/paper']);
});

test('IPC rejects foreign documents and child frames even in the app webContents', () => {
  const mainFrame = { url: entry }, sender = { mainFrame }, trusted = new WeakSet([sender]);
  assert.doesNotThrow(() => trust.assertTrustedRenderer({ sender, senderFrame: mainFrame }, trusted, entry));
  for (const event of [{ sender, senderFrame: { url: entry } }, { sender, senderFrame: null },
    { sender: { mainFrame }, senderFrame: mainFrame }]) {
    assert.throws(() => trust.assertTrustedRenderer(event, trusted, entry), /trusted PaperQuay/);
  }
  mainFrame.url = 'file:///C:/supplier.html';
  assert.throws(() => trust.assertTrustedRenderer({ sender, senderFrame: mainFrame }, trusted, entry), /trusted PaperQuay/);
});

test('foreign documents receive no preload API, including direct clipboard access', () => {
  const source = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  for (const [url, isMainFrame, count] of [[entry, true, 1], [entry, false, 0], ['file:///C:/supplier.html', true, 0], ['about:srcdoc', false, 0]]) {
    const exposed = [];
    vm.runInNewContext(source, {
      process: { platform: 'win32', isMainFrame }, window: { location: { href: url } },
      require: (name) => name === 'electron' ? { contextBridge: { exposeInMainWorld: (...args) => exposed.push(args) }, ipcRenderer: {}, clipboard: {} }
        : { isTrustedRendererUrl: (value) => trust.isTrustedRendererUrl(value, entry) },
    });
    assert.equal(exposed.length, count, url);
  }
});
