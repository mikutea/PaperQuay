import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createDesktopPeerHost, validSdp, validStunUrls, CONTROL, EVENTS, CHUNK_BYTES } = require('../electron/backend/desktopPeerHost.cjs');
const sdp = ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'), 'a=ice-ufrag:abcd', 'a=ice-pwd:' + 'a'.repeat(22), ''].join('\r\n');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 1500;
  while (!condition()) { if (Date.now() > deadline) assert.fail('Peer condition timed out'); await delay(2); }
}
function harness() {
  const ipcMain = new EventEmitter(), windows = [], messages = [], session = new EventEmitter();
  Object.assign(session, {
    setPermissionCheckHandler(handler) { this.checkPermission = handler; },
    setPermissionRequestHandler(handler) { this.requestPermission = handler; },
    setDevicePermissionHandler(handler) { this.devicePermission = handler; },
    webRequest: { onBeforeRequest(filter, handler) { session.filter = filter; session.request = handler; } },
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; windows.push(this);
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: '' }, isDestroyed: () => this.destroyed,
        getURL: () => this.webContents.mainFrame.url,
        setWindowOpenHandler: (handler) => { this.openWindow = handler; },
        send: (route, message) => { assert.equal(route, CONTROL); messages.push(message); this.onSend?.(message); },
      });
    }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; this.webContents.emit('did-finish-load'); }
  }
  const electron = { BrowserWindow, ipcMain, session: { fromPartition(partition, options) {
    assert.ok(!partition.startsWith('persist:')); assert.deepEqual(options, { cache: false }); return session;
  } } };
  const host = createDesktopPeerHost({ electron });
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(CHUNK_BYTES * 2 + 19, 65), Buffer.from('\n%%EOF\n')]);
  const job = { requestId: randomUUID(), attachmentVersionId: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length, offer: sdp, stunUrls: [], directExpiresAt: Date.now() + 5900,
    authorizedUntil: Date.now() + 1900, onAnswer: async () => {} };
  function event(message, override = {}) {
    const window = windows.at(-1), contents = window.webContents;
    ipcMain.emit(EVENTS, { sender: contents, senderFrame: contents.mainFrame, ...override },
      { nonce: messages.findLast((item) => item.kind === 'init')?.nonce, ...message });
  }
  function connect() { event({ kind: 'answer', sdp }); event({ kind: 'connected', candidateType: 'host', remoteCandidateType: 'host' }); }
  return { host, job, bytes, windows, messages, session, ipcMain, event, connect };
}

test('signal validation accepts only bounded data-only SDP and admin STUN hosts', () => {
  assert.equal(validSdp(sdp), true);
  for (const value of [sdp + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', sdp + 'a=candidate:1 1 UDP 1 0.0.0.0 9 typ relay\r\n',
    sdp + Array(33).fill('a=candidate:1 1 UDP 1 0.0.0.0 9 typ host\r\n').join(''), sdp + 'é', sdp + 'a='.repeat(17000)]) {
    assert.equal(validSdp(value), false);
  }
  for (const urls of [[], ['stun:example.test:3478'], ['stuns:[::1]:5349', 'stun:127.0.0.1']]) assert.equal(validStunUrls(urls), true);
  for (const urls of [['turn:example.test'], ['stun:user:password@example.test'], ['stun:example.test/path'],
    ['stun:example.test?transport=udp'], ['stun:example.test:0'], ['stun:example.test:65536'], ['stun:[::gg]'],
    ['stun:one.test', 'stun:two.test', 'stun:three.test'], ['stun:' + 'a'.repeat(252)]]) assert.equal(validStunUrls(urls), false);
});

test('helper denies network, permission, navigation and generic renderer IPC access', async (t) => {
  const f = harness(); t.after(() => f.host.close());
  let answered = 0; f.job.onAnswer = async () => { answered++; };
  const opening = f.host.open(f.job); opening.catch(() => {});
  const window = f.windows[0], contents = window.webContents;
  assert.equal(window.options.show, false); assert.equal(window.options.paintWhenInitiallyHidden, false);
  const prefs = window.options.webPreferences;
  assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true); assert.equal(prefs.devTools, false); assert.equal(prefs.backgroundThrottling, false);
  assert.equal(f.session.checkPermission(), false); assert.equal(f.session.devicePermission(), false);
  f.session.requestPermission(null, 'media', (value) => assert.equal(value, false));
  assert.deepEqual(window.openWindow(), { action: 'deny' });
  let denied;
  f.session.request({ url: contents.getURL(), resourceType: 'mainFrame' }, (value) => { denied = value.cancel; }); assert.equal(denied, false);
  f.session.request({ url: 'https://example.test/', resourceType: 'mainFrame' }, (value) => { denied = value.cancel; }); assert.equal(denied, true);
  f.session.request({ url: contents.getURL(), resourceType: 'script' }, (value) => { denied = value.cancel; }); assert.equal(denied, true);
  f.event({ kind: 'answer', sdp }, { sender: new EventEmitter() });
  f.event({ kind: 'answer', sdp }, { senderFrame: { url: contents.getURL() } });
  f.event({ kind: 'answer', sdp, nonce: randomUUID() });
  await delay(5); assert.equal(answered, 0);
  f.connect(); const peer = await opening; assert.equal(answered, 1);
  let prevented = false; contents.emit('will-navigate', { preventDefault: () => { prevented = true; } });
  await peer.settled(); assert.equal(prevented, true); assert.equal(window.destroyed, true); assert.equal(f.ipcMain.listenerCount(EVENTS), 0);
});

test('provider IPC holds the final block for fresh authorization and copies only bounded buffers', async (t) => {
  const f = harness(); t.after(() => f.host.close());
  const opening = f.host.open(f.job); f.connect(); const peer = await opening;
  const chunks = []; let beforeEnd = false, progress = 0;
  f.windows[0].onSend = (message) => {
    if (message.kind === 'chunk') {
      assert.ok(message.bytes.byteLength <= CHUNK_BYTES); assert.equal(message.bytes.buffer.byteLength, message.bytes.byteLength);
      assert.notEqual(message.bytes.buffer, f.bytes.buffer); assert.equal(message.offset, chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      if (message.offset + message.bytes.byteLength === f.bytes.length) assert.equal(beforeEnd, true);
      chunks.push(Buffer.from(message.bytes));
    }
    if (message.sequence) queueMicrotask(() => {
      f.event({ kind: 'accepted', sequence: message.sequence });
      if (message.kind === 'finish') f.event({ kind: 'complete' });
    });
  };
  const result = await peer.send(f.bytes, { beforeEnd: async () => {
    assert.ok(chunks.length > 0); assert.ok(Buffer.concat(chunks).length < f.bytes.length);
    assert.equal(f.messages.at(-1).kind, 'drain'); beforeEnd = true; return Date.now() + 1900;
  }, onProgress: (value) => { assert.ok(value > progress); progress = value; } });
  assert.deepEqual(Buffer.concat(chunks), f.bytes); assert.equal(progress, f.bytes.length);
  assert.deepEqual(result, { received: true, transport: 'webrtc-data-v1', candidateType: 'host', remoteCandidateType: 'host' });
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.ipcMain.listenerCount(EVENTS), 0);
  assert.ok(!JSON.stringify(f.messages).includes('accessToken'));
});

test('a stalled helper cannot retain an expired permission or accept another job', async (t) => {
  const f = harness(); t.after(() => f.host.close());
  f.job.authorizedUntil = Date.now() + 30;
  const opening = f.host.open(f.job); const rejected = assert.rejects(opening, { code: 'DESKTOP_PEER_AUTHORIZATION_EXPIRED' });
  await assert.rejects(f.host.open({ ...f.job, requestId: randomUUID() }), { code: 'DESKTOP_PEER_BUSY' });
  await delay(50); await rejected; await f.host.settled();
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.ipcMain.listenerCount(EVENTS), 0);
});

test('only current request renewal applies and cancellation destroys a blocked send', async (t) => {
  const f = harness(); t.after(() => f.host.close());
  const controller = new AbortController(); f.job.signal = controller.signal;
  const opening = f.host.open(f.job); f.connect(); const peer = await opening;
  f.host.authorize(randomUUID(), Date.now() + 1000);
  const renewals = f.messages.filter((item) => item.kind === 'authorize').length;
  f.host.authorize(f.job.requestId, Date.now() + 1000);
  assert.equal(f.messages.filter((item) => item.kind === 'authorize').length, renewals + 1);
  const sending = peer.send(f.bytes); const rejected = assert.rejects(sending, { code: 'DESKTOP_OPERATION_CANCELLED' });
  await until(() => f.messages.some((item) => item.kind === 'metadata'));
  controller.abort(); await rejected; assert.equal(f.windows[0].destroyed, true); assert.equal(f.ipcMain.listenerCount(EVENTS), 0);
});

test('unexpected trusted helper messages fail closed and do not publish an SDP', async (t) => {
  const f = harness(); t.after(() => f.host.close()); let answered = 0; f.job.onAnswer = async () => { answered++; };
  const opening = f.host.open(f.job); const rejected = assert.rejects(opening, { code: 'DESKTOP_PEER_INVALID_SIGNAL' });
  f.event({ kind: 'answer', sdp, path: 'C:\\private\\example.pdf' });
  await rejected; assert.equal(answered, 0); assert.equal(f.windows[0].destroyed, true);
});
