import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
const source = fs.readFileSync(new URL('../electron/desktopPeerPreload.cjs', import.meta.url), 'utf8');
const CONTROL = 'paperquay:desktop-peer-control', EVENTS = 'paperquay:desktop-peer-event';
const LABEL = 'paperquay-pdf-v1', HIGH_WATER = 256 * 1024;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 1500;
  while (!condition()) { if (Date.now() > deadline) assert.fail('Preload condition timed out'); await delay(2); }
}
function harness(options = {}) {
  const ipcRenderer = new EventEmitter(), events = [], sent = [], peers = [], required = [];
  ipcRenderer.send = (route, message) => { assert.equal(route, EVENTS); events.push(message); };
  const channel = { label: LABEL, protocol: LABEL, ordered: true, negotiated: false, maxRetransmits: null, maxPacketLifeTime: null,
    readyState: 'open', bufferedAmount: 0, ...options.channel,
    send: (value) => { sent.push(value instanceof Uint8Array ? Uint8Array.from(value) : value); },
    close() { this.readyState = 'closed'; this.closed = true; this.onclose?.(); } };
  class RTCPeerConnection {
    constructor(config) { this.config = config; this.iceGatheringState = 'complete'; this.sctp = { maxMessageSize: 65536 }; peers.push(this); }
    async setRemoteDescription(value) { this.remote = value; queueMicrotask(() => this.ondatachannel?.({ channel })); }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async getStats() { return new Map([['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['local', { candidateType: options.candidateType || 'host' }], ['remote', { candidateType: 'host' }]]); }
    close() { this.closed = true; this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
  }
  const entryUrl = 'file:///isolated/desktopPeer.html';
  const context = vm.createContext({ require: (name) => { required.push(name); assert.equal(name, 'electron'); return { ipcRenderer }; },
    process: { isMainFrame: true }, window: { location: { href: entryUrl } }, TextEncoder, URL, Uint8Array,
    setTimeout, clearTimeout, Date, RTCPeerConnection: options.unsupported ? undefined : RTCPeerConnection });
  vm.runInContext(source, context, { filename: 'desktopPeerPreload.cjs' });
  const job = { kind: 'init', nonce: randomUUID(), entryUrl, requestId: randomUUID(), attachmentVersionId: randomUUID(),
    sha256: '1'.repeat(64), sizeBytes: 32, offer: 'v=0\r\n', stunUrls: [], directExpiresAt: Date.now() + 5900,
    authorizedUntil: Date.now() + 1900 };
  const command = (kind, extra = {}) => ipcRenderer.emit(CONTROL, {}, { kind, nonce: job.nonce, ...extra });
  const init = () => ipcRenderer.emit(CONTROL, {}, job);
  return { context, job, command, init, events, sent, peers, channel, required,
    accepted: (sequence) => events.some((event) => event.kind === 'accepted' && event.sequence === sequence),
    close: () => command('close') };
}

test('DOM-only sandbox preload sends bounded ordered bytes, validated metadata and exact acknowledgement', async (t) => {
  const f = harness(); t.after(f.close); f.init();
  await until(() => f.events.some((event) => event.kind === 'answer') && f.events.some((event) => event.kind === 'connected'));
  assert.deepEqual(f.required, ['electron']); assert.equal(vm.runInContext('typeof Buffer', f.context), 'undefined');
  assert.equal(vm.runInContext('Object.keys(window).join(",")', f.context), 'location');
  assert.equal(f.peers[0].config.iceServers.length, 0); assert.equal(f.peers[0].config.iceTransportPolicy, 'all');
  assert.equal(f.events.find((event) => event.kind === 'connected').candidateType, 'host');
  f.command('metadata', { sequence: 1 }); await until(() => f.accepted(1));
  assert.deepEqual(JSON.parse(f.sent[0]), { type: 'metadata', requestId: f.job.requestId, attachmentVersionId: f.job.attachmentVersionId,
    sha256: f.job.sha256, sizeBytes: f.job.sizeBytes });
  const bytes = new Uint8Array(32).fill(65);
  f.command('chunk', { sequence: 2, offset: 0, bytes }); await until(() => f.accepted(2));
  f.command('drain', { sequence: 3 }); await until(() => f.accepted(3));
  f.command('finish', { sequence: 4 }); await until(() => f.accepted(4));
  assert.deepEqual(f.sent[1], bytes); assert.deepEqual(JSON.parse(f.sent[2]), { type: 'eof', requestId: f.job.requestId, sha256: f.job.sha256, sizeBytes: 32 });
  f.channel.onmessage({ data: JSON.stringify({ type: 'ack', requestId: f.job.requestId, sha256: f.job.sha256, sizeBytes: 32 }) });
  assert.equal(f.events.filter((event) => event.kind === 'complete').length, 1);
});

test('bounded channel backpressure is released by cancellation without delivering queued bytes', async (t) => {
  const f = harness(); t.after(f.close); f.init(); await until(() => f.events.some((event) => event.kind === 'connected'));
  f.command('metadata', { sequence: 1 }); await until(() => f.accepted(1));
  f.channel.bufferedAmount = HIGH_WATER;
  f.command('chunk', { sequence: 2, offset: 0, bytes: new Uint8Array(32) });
  await delay(25); assert.equal(f.accepted(2), false); assert.equal(f.sent.length, 1);
  f.close(); await delay(15); assert.equal(f.sent.length, 1); assert.equal(f.peers[0].closed, true); assert.equal(f.channel.closed, true);
});

test('permission expiry independently destroys the sandbox peer while a chunk is backpressured', async (t) => {
  const f = harness(); t.after(f.close); f.job.authorizedUntil = Date.now() + 50; f.init();
  await until(() => f.events.some((event) => event.kind === 'connected'));
  f.command('metadata', { sequence: 1 }); await until(() => f.accepted(1));
  f.channel.bufferedAmount = HIGH_WATER; f.command('chunk', { sequence: 2, offset: 0, bytes: new Uint8Array(32) });
  await until(() => f.events.some((event) => event.code === 'DESKTOP_PEER_AUTHORIZATION_EXPIRED'));
  assert.equal(f.accepted(2), false); assert.equal(f.sent.length, 1); assert.equal(f.peers[0].closed, true);
});

test('a foreign nonce cannot renew permission or deliver a chunk', async (t) => {
  const f = harness(); t.after(f.close); f.job.authorizedUntil = Date.now() + 50; f.init();
  await until(() => f.events.some((event) => event.kind === 'connected'));
  f.command('authorize', { nonce: randomUUID(), authorizedUntil: Date.now() + 1900 });
  f.command('metadata', { nonce: randomUUID(), sequence: 1 });
  await until(() => f.events.some((event) => event.code === 'DESKTOP_PEER_AUTHORIZATION_EXPIRED'));
  assert.equal(f.sent.length, 0);
});

test('extra or unreliable channels, selected relay candidates, and missing WebRTC fail closed', async (t) => {
  for (const options of [{ channel: { label: 'other' } }, { channel: { ordered: false } }, { channel: { negotiated: true } },
    { channel: { maxRetransmits: 1 } }, { candidateType: 'relay' }, { unsupported: true }]) {
    const f = harness(options); t.after(f.close); f.init();
    await until(() => f.events.some((event) => event.kind === 'failed'));
    assert.equal(f.events.some((event) => event.kind === 'connected'), false); assert.equal(f.sent.length, 0);
    if (f.peers.length) assert.equal(f.peers[0].closed, true);
  }
});

test('oversized blocks and early or mismatched ACK frames cannot complete a transfer', async (t) => {
  for (const mode of ['oversized', 'early', 'mismatch', 'extra-field']) {
    const f = harness(); t.after(f.close); f.init(); await until(() => f.events.some((event) => event.kind === 'connected'));
    if (mode === 'oversized') {
      f.command('metadata', { sequence: 1 }); await until(() => f.accepted(1));
      f.command('chunk', { sequence: 2, offset: 0, bytes: new Uint8Array(16385) });
    } else {
      if (mode !== 'early') {
        f.command('metadata', { sequence: 1 }); await until(() => f.accepted(1));
        f.command('chunk', { sequence: 2, offset: 0, bytes: new Uint8Array(32) }); await until(() => f.accepted(2));
        f.command('finish', { sequence: 3 }); await until(() => f.accepted(3));
      }
      f.channel.onmessage({ data: JSON.stringify({ type: 'ack', requestId: f.job.requestId, sha256: f.job.sha256,
        sizeBytes: mode === 'mismatch' ? 31 : 32, ...(mode === 'extra-field' ? { path: '/private' } : {}) }) });
    }
    await until(() => f.events.some((event) => event.kind === 'failed'));
    assert.equal(f.events.some((event) => event.kind === 'complete'), false); assert.equal(f.peers[0].closed, true);
  }
});
