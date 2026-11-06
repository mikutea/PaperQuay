const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');

const CONTROL = 'paperquay:desktop-peer-control';
const EVENTS = 'paperquay:desktop-peer-event';
const MAX_SDP_BYTES = 32768;
const CHUNK_BYTES = 16384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TYPES = new Set(['host', 'srflx', 'prflx', 'unknown']);
const error = (code) => Object.assign(new Error(code), { code });
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value, expected) => plain(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const timestamp = (value) => typeof value === 'number' ? value : Date.parse(value);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A cancelled job may never wait for a later protocol phase.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function validStunUrls(value) {
  return Array.isArray(value) && value.length <= 2 && value.join(',').length <= 256 && value.every((url) => {
    if (typeof url !== 'string') return false;
    const match = /^stuns?:(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i.exec(url);
    if (!match || match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return false;
    try { return Boolean(new URL(`http://${match[1]}`).hostname); } catch { return false; }
  });
}
function validSdp(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_SDP_BYTES || !value.startsWith('v=0') ||
      /[^\x09\x0a\x0d\x20-\x7e]/.test(value) || /(?:^|\s)typ\s+relay(?:\s|$)/im.test(value) || /iceServers/i.test(value)) return false;
  const lines = value.split(/\r?\n/), media = lines.filter((line) => line.startsWith('m='));
  return lines.filter((line) => line.startsWith('a=candidate:')).length <= 32 &&
    media.length === 1 && /^m=application [0-9]+ (?:UDP\/DTLS\/SCTP|DTLS\/SCTP) webrtc-datachannel$/.test(media[0]) &&
    lines.some((line) => /^a=fingerprint:sha-256 (?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(line)) &&
    lines.some((line) => /^a=ice-ufrag:[A-Za-z0-9+/]{4,256}$/.test(line)) &&
    lines.some((line) => /^a=ice-pwd:[A-Za-z0-9+/]{22,256}$/.test(line));
}

/** A disposable, sandboxed Blink worker. No account token, native path, generic
 * command bridge, or HTTP endpoint ever crosses this private IPC boundary. */
function createDesktopPeerHost(options = {}) {
  const now = options.now || Date.now;
  const entryPath = path.join(__dirname, '..', 'desktopPeer.html');
  const entryUrl = pathToFileURL(entryPath).href;
  const preload = path.join(__dirname, '..', 'desktopPeerPreload.cjs');
  const partition = `paperquay-desktop-peer-${randomUUID()}`;
  let active = null, workerSession = null;
  function sessionFor(electron) {
    if (workerSession) return workerSession;
    workerSession = electron.session.fromPartition(partition, { cache: false });
    workerSession.setPermissionCheckHandler(() => false);
    workerSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    workerSession.setDevicePermissionHandler(() => false);
    workerSession.on('will-download', (event) => event.preventDefault());
    workerSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: details.url !== entryUrl || details.resourceType !== 'mainFrame' });
    });
    return workerSession;
  }
  async function open(job) {
    const deadline = timestamp(job.directExpiresAt);
    if (!UUID.test(job.requestId) || !UUID.test(job.attachmentVersionId) || !HASH.test(job.sha256) ||
        !Number.isSafeInteger(job.sizeBytes) || job.sizeBytes < 1 || job.sizeBytes > 64 * 1024 * 1024 ||
        !validSdp(job.offer) || !validStunUrls(job.stunUrls) || !Number.isFinite(deadline) || deadline <= now() ||
        deadline > now() + 6000 || typeof job.onAnswer !== 'function') throw error('DESKTOP_PEER_INVALID_SIGNAL');
    if (job.signal?.aborted) throw error('DESKTOP_OPERATION_CANCELLED');
    if (active) throw error('DESKTOP_PEER_BUSY');
    const electron = options.electron || require('electron');
    const window = new electron.BrowserWindow({
      width: 1, height: 1, show: false, focusable: false, skipTaskbar: true, frame: false,
      paintWhenInitiallyHidden: false,
      webPreferences: { preload, session: sessionFor(electron), contextIsolation: true, sandbox: true,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false,
        backgroundThrottling: false, spellcheck: false },
    });
    const contents = window.webContents, nonce = randomUUID(), controller = new AbortController();
    const ready = deferred(), received = deferred(), ended = deferred();
    let stopped = false, failure = null, authorizedUntil = 0, authorizationTimer, deadlineTimer;
    let answered = false, answerAccepted = false, connected = false, sending = false, endedOnce = false, finishSent = false, completed = false;
    let sequence = 0, pendingWrite = null, candidateType = 'unknown', remoteCandidateType = 'unknown';
    const listeners = [];
    const listen = (target, name, handler) => { target.on(name, handler); listeners.push([target, name, handler]); };
    const instance = { requestId: job.requestId, authorize, close, settled: () => ended.promise };
    active = instance;
    function check() {
      if (stopped || controller.signal.aborted) throw failure || error('DESKTOP_OPERATION_CANCELLED');
      if (now() >= deadline) { close('DESKTOP_PEER_TIMEOUT'); throw failure; }
      if (now() >= authorizedUntil) { close('DESKTOP_PEER_AUTHORIZATION_EXPIRED'); throw failure; }
    }
    function finishDestroyed() {
      if (endedOnce) return;
      endedOnce = true;
      for (const [target, name, handler] of listeners) target.removeListener(name, handler);
      electron.ipcMain.removeListener(EVENTS, onMessage);
      job.signal?.removeEventListener('abort', parentAbort);
      clearTimeout(authorizationTimer); clearTimeout(deadlineTimer);
      if (active === instance) active = null;
      ended.resolve();
    }
    function close(code = 'DESKTOP_OPERATION_CANCELLED') {
      if (!stopped) {
        stopped = true; failure = error(code); controller.abort();
        ready.reject(failure); received.reject(failure); pendingWrite?.reject(failure); pendingWrite = null;
        clearTimeout(authorizationTimer); clearTimeout(deadlineTimer);
        if (!contents.isDestroyed()) {
          try { contents.send(CONTROL, { kind: 'close', nonce }); } catch {}
        }
        if (!window.isDestroyed()) window.destroy();
      }
      if (window.isDestroyed()) finishDestroyed();
      return ended.promise;
    }
    const parentAbort = () => { void close('DESKTOP_OPERATION_CANCELLED'); };
    function authorize(value) {
      if (stopped) return;
      const until = Math.min(timestamp(value), deadline, now() + 2000);
      if (!Number.isFinite(until) || until <= now()) { void close('DESKTOP_PEER_AUTHORIZATION_EXPIRED'); return; }
      authorizedUntil = Math.max(authorizedUntil, until);
      clearTimeout(authorizationTimer);
      authorizationTimer = setTimeout(() => { void close('DESKTOP_PEER_AUTHORIZATION_EXPIRED'); }, Math.max(1, authorizedUntil - now()));
      authorizationTimer.unref?.();
      if (!contents.isDestroyed()) contents.send(CONTROL, { kind: 'authorize', nonce, authorizedUntil });
    }
    function becameReady() { if (answerAccepted && connected && !stopped) ready.resolve(); }
    function onMessage(event, message) {
      if (stopped || event.sender !== contents || event.senderFrame !== contents.mainFrame ||
          event.senderFrame?.url !== entryUrl || !plain(message) || message.nonce !== nonce) return;
      try {
        check();
        if (message.kind === 'answer' && keys(message, ['kind', 'nonce', 'sdp']) && !answered && validSdp(message.sdp)) {
          answered = true;
          Promise.resolve(job.onAnswer(message.sdp, controller.signal)).then(() => {
            if (stopped) return;
            answerAccepted = true; becameReady();
          }, (cause) => { void close(typeof cause?.code === 'string' && /^(?:DESKTOP_|AUTH_|AUTHENTICATION_|SESSION_|DEVICE_|ATTACHMENT_)[A-Z0-9_]{1,64}$/.test(cause.code)
            ? cause.code : 'DESKTOP_PEER_SIGNAL_FAILED'); });
        } else if (message.kind === 'connected' && keys(message, ['kind', 'nonce', 'candidateType', 'remoteCandidateType']) &&
            !connected && TYPES.has(message.candidateType) && TYPES.has(message.remoteCandidateType)) {
          connected = true; candidateType = message.candidateType; remoteCandidateType = message.remoteCandidateType; becameReady();
        } else if (message.kind === 'accepted' && keys(message, ['kind', 'nonce', 'sequence']) &&
            pendingWrite && message.sequence === pendingWrite.sequence) {
          const pending = pendingWrite; pendingWrite = null; pending.resolve();
        } else if (message.kind === 'complete' && keys(message, ['kind', 'nonce']) && sending && finishSent && !completed) {
          completed = true;
          received.resolve({ received: true, transport: 'webrtc-data-v1', candidateType, remoteCandidateType });
        } else if (message.kind === 'failed' && keys(message, ['kind', 'nonce', 'code']) &&
            ['DESKTOP_PEER_TIMEOUT', 'DESKTOP_PEER_FAILED', 'DESKTOP_PEER_INVALID_SIGNAL', 'DESKTOP_PEER_AUTHORIZATION_EXPIRED',
              'DESKTOP_PEER_UNSUPPORTED'].includes(message.code)) {
          void close(message.code);
        } else void close('DESKTOP_PEER_INVALID_SIGNAL');
      } catch { void close(failure?.code || 'DESKTOP_PEER_INVALID_SIGNAL'); }
    }
    async function command(kind, extra = {}) {
      check();
      if (pendingWrite) throw error('DESKTOP_PEER_BUSY');
      const pending = deferred(); pending.sequence = ++sequence; pendingWrite = pending;
      contents.send(CONTROL, { kind, nonce, sequence, ...extra });
      await pending.promise; check();
    }
    async function send(bytes, { beforeEnd = async () => undefined, onProgress = () => {} } = {}) {
      check();
      if (sending || !(bytes instanceof Uint8Array) || bytes.byteLength !== job.sizeBytes ||
          createHash('sha256').update(bytes).digest('hex') !== job.sha256) throw error('DESKTOP_SOURCE_CHANGED');
      sending = true;
      try {
        await command('metadata');
        let offset = 0;
        while (offset + CHUNK_BYTES < bytes.byteLength) {
          // Own this small backing buffer: cloning a subarray can otherwise copy
          // the full PDF's ArrayBuffer for every IPC message.
          const chunk = Uint8Array.from(bytes.subarray(offset, offset + CHUNK_BYTES));
          await command('chunk', { offset, bytes: chunk }); offset += chunk.byteLength;
          onProgress(offset, bytes.byteLength);
        }
        await command('drain');
        const finalAuthorization = await Promise.race([
          Promise.resolve(beforeEnd(controller.signal)),
          new Promise((_resolve, reject) => {
            if (controller.signal.aborted) reject(failure);
            else controller.signal.addEventListener('abort', () => reject(failure), { once: true });
          }),
        ]);
        check();
        if (finalAuthorization !== undefined) authorize(finalAuthorization);
        check();
        await command('chunk', { offset, bytes: Uint8Array.from(bytes.subarray(offset)) });
        onProgress(bytes.byteLength, bytes.byteLength);
        finishSent = true; await command('finish');
        return await received.promise;
      } finally { await close(); }
    }
    electron.ipcMain.on(EVENTS, onMessage);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const denyNavigation = (event) => { event.preventDefault(); void close('DESKTOP_PEER_INVALID_SIGNAL'); };
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) listen(contents, name, denyNavigation);
    listen(contents, 'render-process-gone', () => { void close('DESKTOP_PEER_FAILED'); });
    listen(contents, 'did-fail-load', () => { void close('DESKTOP_PEER_FAILED'); });
    listen(window, 'unresponsive', () => { void close('DESKTOP_PEER_FAILED'); });
    listen(window, 'closed', () => { if (!stopped) void close('DESKTOP_PEER_FAILED'); finishDestroyed(); });
    listen(contents, 'did-finish-load', () => {
      if (stopped) return;
      if (contents.getURL() !== entryUrl) { void close('DESKTOP_PEER_INVALID_SIGNAL'); return; }
      contents.send(CONTROL, { kind: 'init', nonce, entryUrl, requestId: job.requestId,
        attachmentVersionId: job.attachmentVersionId, sha256: job.sha256, sizeBytes: job.sizeBytes,
        offer: job.offer, stunUrls: [...job.stunUrls], directExpiresAt: deadline, authorizedUntil });
    });
    job.signal?.addEventListener('abort', parentAbort, { once: true });
    deadlineTimer = setTimeout(() => { void close('DESKTOP_PEER_TIMEOUT'); }, Math.max(1, deadline - now()));
    deadlineTimer.unref?.();
    authorize(job.authorizedUntil);
    if (job.signal?.aborted) parentAbort();
    try {
      check();
      await Promise.all([window.loadFile(entryPath), ready.promise]); check();
      return { send, authorize, close, settled: () => ended.promise,
        get candidateType() { return candidateType; }, get remoteCandidateType() { return remoteCandidateType; } };
    } catch (cause) {
      await close(failure?.code || 'DESKTOP_PEER_FAILED');
      throw failure || cause;
    }
  }
  return { open, authorize: (requestId, until) => { if (active?.requestId === requestId) active.authorize(until); },
    close: () => active?.close() || Promise.resolve(), settled: () => active?.settled() || Promise.resolve() };
}

module.exports = { createDesktopPeerHost, validSdp, validStunUrls, CONTROL, EVENTS, CHUNK_BYTES, MAX_SDP_BYTES };
