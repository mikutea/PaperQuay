// This preload runs entirely in a sandboxed, isolated Blink world. Do not add a
// contextBridge, Node dependency, file path, token, or general network API here.
(() => {
  const { ipcRenderer } = require('electron');
  const CONTROL = 'paperquay:desktop-peer-control', EVENTS = 'paperquay:desktop-peer-event';
  const LABEL = 'paperquay-pdf-v1', CHUNK_BYTES = 16384, HIGH_WATER = 256 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const HASH = /^[0-9a-f]{64}$/;
  const encoder = new TextEncoder();
  const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...names].sort().join(',');
  const validStun = (url) => {
    if (typeof url !== 'string') return false;
    const match = /^stuns?:(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i.exec(url);
    if (!match || match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return false;
    try { return Boolean(new URL(`http://${match[1]}`).hostname); } catch { return false; }
  };
  let job = null, pc = null, channel = null, closed = false, metadataSent = false, eofSent = false;
  let offset = 0, sequence = 0, commandBusy = false, deadlineTimer, authorizationTimer;
  const waiting = new Set();
  const emit = (kind, extra = {}) => { if (job && !closed) ipcRenderer.send(EVENTS, { kind, nonce: job.nonce, ...extra }); };
  function close(code) {
    if (closed) return;
    if (code) emit('failed', { code });
    closed = true; clearTimeout(deadlineTimer); clearTimeout(authorizationTimer);
    for (const reject of waiting) reject(new Error('closed'));
    waiting.clear();
    try { channel?.close(); } catch {}
    try { pc?.close(); } catch {}
    channel = null; pc = null; job = null;
  }
  function check() {
    if (closed || !job) throw new Error('closed');
    if (Date.now() >= job.directExpiresAt) { close('DESKTOP_PEER_TIMEOUT'); throw new Error('expired'); }
    if (Date.now() >= job.authorizedUntil) { close('DESKTOP_PEER_AUTHORIZATION_EXPIRED'); throw new Error('unauthorized'); }
  }
  function authorize(until) {
    if (!job || closed) return;
    if (!Number.isFinite(until) || until <= Date.now()) { close('DESKTOP_PEER_AUTHORIZATION_EXPIRED'); return; }
    job.authorizedUntil = Math.max(job.authorizedUntil, Math.min(until, job.directExpiresAt, Date.now() + 2000));
    clearTimeout(authorizationTimer);
    authorizationTimer = setTimeout(() => close('DESKTOP_PEER_AUTHORIZATION_EXPIRED'), Math.max(1, job.authorizedUntil - Date.now()));
  }
  function waitFor(predicate, maximum = 6000) {
    return new Promise((resolve, reject) => {
      let timer, settled = false;
      const finish = (cause) => {
        if (settled) return;
        settled = true; clearTimeout(timer); waiting.delete(cancel);
        if (cause) reject(cause); else resolve();
      };
      const cancel = (cause) => finish(cause), until = Date.now() + maximum;
      waiting.add(cancel);
      const poll = () => {
        try {
          check();
          if (predicate()) { finish(); return; }
          if (Date.now() >= until) { finish(new Error('timeout')); return; }
          timer = setTimeout(poll, 10);
        } catch (cause) { finish(cause); }
      };
      poll();
    });
  }
  function sendJson(value) {
    check();
    const text = JSON.stringify(value);
    if (!channel || channel.readyState !== 'open' || encoder.encode(text).byteLength > 1024) throw new Error('invalid channel');
    channel.send(text);
  }
  async function connect(message) {
    if (!process.isMainFrame || window.location.href !== message.entryUrl || job || closed ||
        !UUID.test(message.nonce) || !UUID.test(message.requestId) || !UUID.test(message.attachmentVersionId) ||
        !HASH.test(message.sha256) || !Number.isSafeInteger(message.sizeBytes) || message.sizeBytes < 1 || message.sizeBytes > 67108864 ||
        typeof message.offer !== 'string' || encoder.encode(message.offer).byteLength > 32768 ||
        !Array.isArray(message.stunUrls) || message.stunUrls.length > 2 || message.stunUrls.join(',').length > 256 ||
        message.stunUrls.some((url) => !validStun(url))) return;
    job = { ...message, authorizedUntil: 0 };
    authorize(message.authorizedUntil); check();
    deadlineTimer = setTimeout(() => close('DESKTOP_PEER_TIMEOUT'), Math.max(1, job.directExpiresAt - Date.now()));
    if (typeof RTCPeerConnection !== 'function') { close('DESKTOP_PEER_UNSUPPORTED'); return; }
    pc = new RTCPeerConnection({ iceServers: message.stunUrls.length ? [{ urls: [...message.stunUrls] }] : [],
      iceTransportPolicy: 'all', bundlePolicy: 'max-bundle' });
    pc.onconnectionstatechange = () => { if (pc && ['failed', 'closed'].includes(pc.connectionState)) close('DESKTOP_PEER_FAILED'); };
    pc.ondatachannel = (event) => {
      const incoming = event.channel;
      if (channel || incoming.label !== LABEL || incoming.protocol !== LABEL || incoming.ordered !== true || incoming.negotiated !== false ||
          incoming.maxRetransmits !== null || incoming.maxPacketLifeTime !== null) { close('DESKTOP_PEER_INVALID_SIGNAL'); return; }
      channel = incoming; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = HIGH_WATER / 2;
      channel.onclose = () => { if (!closed && !eofSent) close('DESKTOP_PEER_FAILED'); };
      channel.onerror = () => close('DESKTOP_PEER_FAILED');
      channel.onmessage = (event) => {
        try {
          check();
          if (!eofSent || typeof event.data !== 'string' || encoder.encode(event.data).byteLength > 1024) throw new Error('unexpected peer message');
          const ack = JSON.parse(event.data);
          if (!exact(ack, ['type', 'requestId', 'sha256', 'sizeBytes']) || ack.type !== 'ack' || ack.requestId !== job.requestId ||
              ack.sha256 !== job.sha256 || ack.sizeBytes !== job.sizeBytes) throw new Error('invalid acknowledgement');
          emit('complete');
        } catch { close('DESKTOP_PEER_INVALID_SIGNAL'); }
      };
      let openingReported = false;
      const opened = async () => {
        if (openingReported) return;
        openingReported = true;
        try {
          check();
          if (pc.sctp?.maxMessageSize > 0 && pc.sctp.maxMessageSize < CHUNK_BYTES) throw new Error('small messages');
          const stats = await pc.getStats(); check();
          let pair;
          for (const stat of stats.values()) if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = stats.get(stat.selectedCandidatePairId);
          if (!pair) for (const stat of stats.values()) if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) pair = stat;
          const localType = stats.get(pair?.localCandidateId)?.candidateType || 'unknown';
          const remoteType = stats.get(pair?.remoteCandidateId)?.candidateType || 'unknown';
          if (localType === 'relay' || remoteType === 'relay') throw new Error('relay candidate');
          const allowed = new Set(['host', 'srflx', 'prflx']);
          emit('connected', { candidateType: allowed.has(localType) ? localType : 'unknown', remoteCandidateType: allowed.has(remoteType) ? remoteType : 'unknown' });
        } catch { close('DESKTOP_PEER_FAILED'); }
      };
      channel.onopen = opened;
      if (channel.readyState === 'open') void opened();
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: message.offer }); check();
    const answer = await pc.createAnswer(); check();
    await pc.setLocalDescription(answer); check();
    await waitFor(() => pc.iceGatheringState === 'complete', 1500); check();
    const sdp = pc.localDescription?.sdp;
    if (typeof sdp !== 'string' || encoder.encode(sdp).byteLength > 32768) throw new Error('invalid answer');
    emit('answer', { sdp });
  }
  async function command(message) {
    check();
    if (!Number.isSafeInteger(message.sequence) || message.sequence !== sequence + 1 || commandBusy) throw new Error('invalid sequence');
    commandBusy = true; sequence = message.sequence;
    try {
      if (message.kind === 'metadata') {
        if (metadataSent) throw new Error('duplicate metadata');
        sendJson({ type: 'metadata', requestId: job.requestId, attachmentVersionId: job.attachmentVersionId,
          sha256: job.sha256, sizeBytes: job.sizeBytes }); metadataSent = true;
      } else if (message.kind === 'chunk') {
        if (!metadataSent || eofSent || message.offset !== offset || !(message.bytes instanceof Uint8Array) ||
            message.bytes.byteLength < 1 || message.bytes.byteLength > CHUNK_BYTES || offset + message.bytes.byteLength > job.sizeBytes) throw new Error('invalid chunk');
        await waitFor(() => channel?.readyState === 'open' && channel.bufferedAmount + message.bytes.byteLength <= HIGH_WATER); check();
        channel.send(message.bytes); offset += message.bytes.byteLength;
      } else if (message.kind === 'drain') {
        if (!metadataSent || eofSent) throw new Error('invalid drain');
        await waitFor(() => channel?.readyState === 'open' && channel.bufferedAmount === 0); check();
      } else if (message.kind === 'finish') {
        if (!metadataSent || eofSent || offset !== job.sizeBytes) throw new Error('incomplete file');
        sendJson({ type: 'eof', requestId: job.requestId, sha256: job.sha256, sizeBytes: job.sizeBytes }); eofSent = true;
      } else throw new Error('unknown command');
      emit('accepted', { sequence });
    } finally { commandBusy = false; }
  }
  ipcRenderer.on(CONTROL, (_event, message) => {
    if (!message || typeof message !== 'object' || closed) return;
    if (message.kind === 'init') { void connect(message).catch(() => close('DESKTOP_PEER_FAILED')); return; }
    if (!job || message.nonce !== job.nonce) return;
    if (message.kind === 'close') { close(); return; }
    if (message.kind === 'authorize') { authorize(message.authorizedUntil); return; }
    void command(message).catch(() => close('DESKTOP_PEER_FAILED'));
  });
})();
