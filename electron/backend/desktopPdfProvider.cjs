const path = require('node:path');
const { createHash } = require('node:crypto');
const nativeFs = require('./nativeFs.cjs');
const { openAuthorizedReadFile } = require('./pathAccess.cjs');
const { validSdp } = require('./desktopPeerHost.cjs');

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
function checkSignal(signal) { if (signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED'); }

// This is a private, profile-owned library binding. It is never sent to the API.
// The database inode/Windows file ID is stable across ordinary SQLite writes,
// but deliberately does not survive replacement/restoration of the database.
function captureLibraryAnchor(context) {
  const directory = nativeFs.inspectSync(context.appPaths.dataDir);
  const database = nativeFs.inspectSync(context.appPaths.libraryDatabasePath);
  if (directory.linkPath || database.linkPath || !directory.exists || !database.exists ||
      !samePath(directory.actual, context.appPaths.dataDir) || !samePath(database.actual, context.appPaths.libraryDatabasePath)) {
    fail('DESKTOP_LIBRARY_CHANGED');
  }
  return { dataDirectory: context.appPaths.dataDir, directoryIdentity: directory.identity, databaseIdentity: database.identity };
}
function sameLibraryAnchor(left, right) {
  return Boolean(left && right && samePath(left.dataDirectory, right.dataDirectory) &&
    left.directoryIdentity === right.directoryIdentity && left.databaseIdentity === right.databaseIdentity);
}
function assertLibraryAnchor(context, expected) {
  if (!sameLibraryAnchor(captureLibraryAnchor(context), expected)) fail('DESKTOP_LIBRARY_CHANGED');
}
function findAttachment(context, localPaperId, localAttachmentId) {
  const library = context.store.load();
  const paper = library.papers?.find((item) => item.id === localPaperId);
  const attachment = paper?.attachments?.find((item) => item.id === localAttachmentId);
  if (!paper || !attachment || attachment.paperId !== paper.id || attachment.kind !== 'pdf' ||
      typeof attachment.storedPath !== 'string' || !path.isAbsolute(attachment.storedPath)) fail('DESKTOP_SOURCE_UNAVAILABLE');
  return { library, paper, attachment };
}

/** Read only an existing library attachment, through the existing main-process
 * path policy and a pinned descriptor. No caller can supply a filesystem path.
 * Bound the read itself, not merely fstat: another process may grow the file.
 */
async function readDesktopAttachment(context, { localPaperId, localAttachmentId, anchor, signal, maxBytes = MAX_FILE_BYTES, expected }) {
  checkSignal(signal);
  assertLibraryAnchor(context, anchor);
  const initial = findAttachment(context, localPaperId, localAttachmentId);
  const initialPath = initial.attachment.storedPath;
  const initialHash = initial.attachment.contentHash, initialSize = initial.attachment.fileSize;
  let opened;
  try {
    opened = await openAuthorizedReadFile(initialPath, async (raw) => {
      checkSignal(signal);
      assertLibraryAnchor(context, anchor);
      const current = findAttachment(context, localPaperId, localAttachmentId);
      if (current.attachment.storedPath !== initialPath) fail('DESKTOP_SOURCE_CHANGED');
      const approved = context.validateLibraryFileOperation?.(current.library, [current.attachment]);
      const actual = approved?.attachmentPaths?.[0] || await context.authorizeLocalProbe?.(raw);
      // An optional authorizer returning nothing is not a source capability.
      if (typeof actual !== 'string' || !path.isAbsolute(actual)) fail('DESKTOP_SOURCE_NOT_APPROVED');
      return actual;
    });
    checkSignal(signal);
    const limit = Math.min(MAX_FILE_BYTES, maxBytes);
    if (!Number.isSafeInteger(limit) || limit < 1 || !opened.stat.isFile() || opened.stat.size < 1 || opened.stat.size > limit) {
      fail('DESKTOP_FILE_TOO_LARGE');
    }
    if (expected && opened.stat.size !== expected.sizeBytes) fail('DESKTOP_SOURCE_CHANGED');
    const stream = opened.handle.createReadStream({ autoClose: true, highWaterMark: 64 * 1024 });
    const streamClosed = new Promise((resolve) => stream.once('close', resolve));
    // Cancellation can destroy the stream before the async iterator starts.
    stream.on('error', () => {});
    const cancel = () => stream.destroy(Object.assign(new Error('DESKTOP_OPERATION_CANCELLED'), { code: 'DESKTOP_OPERATION_CANCELLED' }));
    signal?.addEventListener('abort', cancel, { once: true });
    const chunks = []; let size = 0;
    const hash = createHash('sha256');
    try {
      checkSignal(signal);
      for await (const chunk of stream) {
        checkSignal(signal);
        size += chunk.length;
        if (size > limit || expected && size > expected.sizeBytes) fail('DESKTOP_FILE_TOO_LARGE');
        chunks.push(chunk); hash.update(chunk);
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      stream.destroy();
      // pathAccess updates its descriptor ownership on this close event.
      // Await it before the handle's finalizer to avoid closing a reused fd.
      await streamClosed;
    }
    checkSignal(signal);
    const sha256 = hash.digest('hex');
    if (size !== opened.stat.size || expected && (sha256 !== expected.sha256 || size !== expected.sizeBytes)) fail('DESKTOP_SOURCE_CHANGED');
    const bytes = Buffer.concat(chunks, size);
    if (!bytes.subarray(0, Math.min(1024, size)).includes(Buffer.from('%PDF-')) ||
        !bytes.subarray(Math.max(0, size - 8192)).includes(Buffer.from('%%EOF'))) fail('INVALID_PDF');
    assertLibraryAnchor(context, anchor);
    const current = findAttachment(context, localPaperId, localAttachmentId);
    if (current.attachment.storedPath !== initialPath || current.attachment.contentHash !== initialHash ||
        current.attachment.fileSize !== initialSize) fail('DESKTOP_SOURCE_CHANGED');
    return { bytes, sha256, sizeBytes: size, paper: structuredClone(current.paper), attachment: structuredClone(current.attachment) };
  } catch (error) {
    if (signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED');
    if (typeof error?.code === 'string' && /^(DESKTOP_|INVALID_PDF)/.test(error.code)) throw error;
    fail('DESKTOP_SOURCE_UNAVAILABLE');
  } finally { await opened?.handle.close(); }
}

function validRequest(value, now) {
  return value && typeof value === 'object' && Object.keys(value).sort().join(',') ===
      (value.direct === undefined ? 'attachmentVersionId,expiresAt,requestId,sha256,sizeBytes' : 'attachmentVersionId,direct,expiresAt,requestId,sha256,sizeBytes') &&
    UUID.test(value.requestId) && UUID.test(value.attachmentVersionId) && HASH.test(value.sha256) &&
    Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= MAX_FILE_BYTES &&
    typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.expiresAt) > now && Date.parse(value.expiresAt) <= now + 60_000 &&
    (value.direct === undefined || value.direct && Object.keys(value.direct).sort().join(',') === 'expiresAt,offer' &&
      validSdp(value.direct.offer) && typeof value.direct.expiresAt === 'string' && Number.isFinite(Date.parse(value.direct.expiresAt)) &&
      Date.parse(value.direct.expiresAt) <= Math.min(Date.parse(value.expiresAt), now + 6000));
}
function directStatus(value, item) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'answer,authorizedUntil,directExpiresAt,expiresAt,relayReady,state' ||
      !['direct', 'relay', 'complete'].includes(value.state) || typeof value.relayReady !== 'boolean' ||
      Date.parse(value.expiresAt) !== Date.parse(item.expiresAt) || Date.parse(value.directExpiresAt) !== Date.parse(item.direct.expiresAt) ||
      value.answer !== null && !validSdp(value.answer) || value.authorizedUntil !== null &&
        (typeof value.authorizedUntil !== 'string' || !Number.isFinite(Date.parse(value.authorizedUntil)))) fail('DESKTOP_INVALID_RESPONSE');
  return value;
}
const canFallback = (error) => /^DESKTOP_PEER_/.test(error?.code || '') ||
  ['DESKTOP_PDF_DIRECT_FALLBACK', 'DESKTOP_REQUEST_TIMEOUT', 'NETWORK_UNAVAILABLE', 'DESKTOP_PDF_TIMEOUT'].includes(error?.code);
function waitForRetry(signal, milliseconds) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds); timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** One poll and one bounded file transfer per desktop session. A cancelled read
 * retains its slot until the underlying descriptor operation has actually ended.
 */
function createDesktopPdfProvider({ request, sendContent, getBinding, read, validateTarget, ensureTokenLifetime,
  getDirectCapability = () => null, getPeerHost, onChange = () => {}, onError = () => {}, now = Date.now, retryDelay = waitForRetry }) {
  let generation = 0, controller = null, loop = null, transfer = null;
  const snapshot = () => transfer ? [{ transferId: transfer.request.requestId, attachmentVersionId: transfer.request.attachmentVersionId,
    status: transfer.status, sizeBytes: transfer.request.sizeBytes, ...(transfer.transport ? { transport: transfer.transport } : {}),
    ...(transfer.candidateType ? { candidateType: transfer.candidateType } : {}) }] : [];
  const changed = () => { try { onChange(); } catch {} };
  function current(run) { return controller && !controller.signal.aborted && generation === run; }
  async function unavailable(item, signal) {
    if (signal.aborted || Date.parse(item.expiresAt) <= now()) return;
    await request(`/v1/desktop-pdfs/requests/${item.requestId}/unavailable`, { method: 'POST', body: {}, signal }).catch(() => {});
  }
  async function serveDirect(item, binding, run, signal, readVerified) {
    const route = `/v1/desktop-pdfs/requests/${item.requestId}/direct`;
    let controls = Promise.resolve();
    // The service permits one in-flight control request per lease role. ICE
    // answer/final authorization and the renewal loop share this one queue;
    // queueing never extends the independent peer authorization deadline.
    const control = (target, options) => {
      const task = controls.then(() => { checkSignal(options.signal); return request(target, options); });
      controls = task.catch(() => {}); return task;
    };
    const status = async (requestSignal = signal) => directStatus(await control(route, { signal: requestSignal, timeoutMs: 1000 }), item);
    let latest = await status();
    const assertCurrent = () => {
      checkSignal(signal);
      if (!current(run) || getBinding(item.attachmentVersionId)?.bindingId !== binding.bindingId) fail('DESKTOP_OPERATION_CANCELLED');
    };
    const awaitRelay = async () => {
      for (;;) {
        assertCurrent();
        latest = await status();
        if (latest.state === 'complete') return true;
        if (latest.state === 'relay' && latest.relayReady) return false;
        await retryDelay(signal, 250);
      }
    };
    assertCurrent();
    if (latest.state === 'complete') return true;
    if (latest.state === 'relay') return awaitRelay();
    const capability = getDirectCapability();
    let peer = null, host = null, completed = false, monitorFailure = null, directFailure = null;
    const directController = new AbortController(), monitorController = new AbortController();
    const stopDirect = () => directController.abort();
    signal.addEventListener('abort', stopDirect, { once: true });
    let monitor = Promise.resolve();
    try {
      if (!capability || !getPeerHost) fail('DESKTOP_PEER_UNSUPPORTED');
      const authorizedUntil = Date.parse(latest.authorizedUntil);
      if (!Number.isFinite(authorizedUntil) || authorizedUntil <= now()) fail('DESKTOP_PEER_AUTHORIZATION_EXPIRED');
      host = getPeerHost();
      transfer.status = 'connecting'; transfer.transport = 'webrtc-data-v1'; changed();
      monitor = (async () => {
        while (!monitorController.signal.aborted) {
          await retryDelay(monitorController.signal, 1000);
          if (monitorController.signal.aborted) break;
          try {
            latest = await status(monitorController.signal); assertCurrent();
            if (latest.state === 'complete') { completed = true; stopDirect(); break; }
            if (latest.state === 'relay') { stopDirect(); break; }
            const until = Date.parse(latest.authorizedUntil);
            if (!Number.isFinite(until) || until <= now()) fail('DESKTOP_PEER_AUTHORIZATION_EXPIRED');
            host.authorize(item.requestId, until);
          } catch (cause) {
            if (!monitorController.signal.aborted) { monitorFailure = cause; stopDirect(); }
            break;
          }
        }
      })();
      const opening = host.open({ requestId: item.requestId, attachmentVersionId: item.attachmentVersionId,
        sha256: item.sha256, sizeBytes: item.sizeBytes, offer: item.direct.offer, stunUrls: [...capability.stunUrls],
        directExpiresAt: item.direct.expiresAt, authorizedUntil, signal: directController.signal,
        onAnswer: async (sdp, answerSignal) => {
          assertCurrent();
          const result = await control(`${route}/answer`, { method: 'POST', body: { sdp }, signal: answerSignal, timeoutMs: 1000 });
          if (!result || Object.keys(result).join(',') !== 'accepted' || result.accepted !== true) fail('DESKTOP_INVALID_RESPONSE');
        } });
      const [opened, verified] = await Promise.all([opening, readVerified()]); peer = opened;
      assertCurrent();
      transfer.status = 'sending'; transfer.candidateType = peer.candidateType; changed();
      await peer.send(verified.bytes, { beforeEnd: async (finalSignal) => {
        assertCurrent(); await validateTarget(binding, finalSignal); await ensureTokenLifetime(Date.parse(item.expiresAt), finalSignal);
        const result = await control(`${route}/authorize`, { method: 'POST', body: {}, signal: finalSignal, timeoutMs: 1000 });
        if (!result || Object.keys(result).join(',') !== 'authorizedUntil' || typeof result.authorizedUntil !== 'string' ||
            !Number.isFinite(Date.parse(result.authorizedUntil))) fail('DESKTOP_INVALID_RESPONSE');
        assertCurrent(); return Date.parse(result.authorizedUntil);
      } });
      latest = await status(); assertCurrent();
      if (latest.state !== 'complete') fail('DESKTOP_PEER_FAILED');
      completed = true;
    } catch (cause) { directFailure = cause; }
    finally {
      stopDirect(); monitorController.abort(); signal.removeEventListener('abort', stopDirect);
      await Promise.allSettled([peer?.close(), host?.close(), monitor]);
    }
    assertCurrent();
    if (completed) return true;
    const cause = monitorFailure || directFailure;
    if (cause && cause.code !== 'DESKTOP_OPERATION_CANCELLED' && !canFallback(cause)) throw cause;
    if (cause?.code === 'DESKTOP_OPERATION_CANCELLED' && latest.state !== 'relay' && !monitorFailure) throw cause;
    transfer.status = 'connecting'; transfer.transport = 'http-relay-v1'; delete transfer.candidateType; changed();
    try {
      const result = await control(`${route}/fallback`, { method: 'POST', body: {}, signal, timeoutMs: 1000 });
      if (!result || Object.keys(result).join(',') !== 'state' || result.state !== 'relay') fail('DESKTOP_INVALID_RESPONSE');
    } catch (cause) {
      if (cause.code !== 'DESKTOP_PDF_REQUEST_IN_USE') throw cause;
      latest = await status();
      if (latest.state === 'complete') return true;
      throw cause;
    }
    return awaitRelay();
  }
  async function serve(item, run, parentSignal) {
    const binding = getBinding(item.attachmentVersionId);
    if (!binding || binding.sha256 !== item.sha256 || binding.sizeBytes !== item.sizeBytes) {
      await unavailable(item, parentSignal); return;
    }
    const work = new AbortController();
    const abort = () => work.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    const expiry = setTimeout(abort, Math.max(1, Date.parse(item.expiresAt) - now())); expiry.unref?.();
    transfer = { request: item, controller: work, status: 'reading', bindingId: binding.bindingId }; changed();
    let reading;
    try {
      await ensureTokenLifetime(Date.parse(item.expiresAt), work.signal);
      checkSignal(work.signal);
      await validateTarget(binding, work.signal);
      const readVerified = () => reading ||= (async () => {
        const result = await read(binding, work.signal);
        if (!current(run) || work.signal.aborted || getBinding(item.attachmentVersionId)?.bindingId !== binding.bindingId) fail('DESKTOP_OPERATION_CANCELLED');
        if (result.sha256 !== item.sha256 || result.sizeBytes !== item.sizeBytes) fail('DESKTOP_SOURCE_CHANGED');
        return result;
      })();
      if (item.direct && await serveDirect(item, binding, run, work.signal, readVerified)) return;
      const result = await readVerified();
      await validateTarget(binding, work.signal);
      await ensureTokenLifetime(Date.parse(item.expiresAt), work.signal);
      if (!current(run) || work.signal.aborted || getBinding(item.attachmentVersionId)?.bindingId !== binding.bindingId) fail('DESKTOP_OPERATION_CANCELLED');
      transfer.status = 'sending'; transfer.transport = 'http-relay-v1'; changed();
      await sendContent(`/v1/desktop-pdfs/requests/${item.requestId}/content`, result.bytes, work.signal, Date.parse(item.expiresAt));
    } catch (error) {
      work.abort();
      if (current(run)) onError(error, binding);
      // Revocation/cancel may end a local read; reject the dispatched request
      // using the still-live provider signal, without continuing its body upload.
      if (current(run)) await unavailable(item, parentSignal);
    } finally {
      // Parallel ICE failure/cancellation must not release a native-read slot
      // before the underlying descriptor operation has actually settled.
      if (reading) await reading.catch(() => {});
      clearTimeout(expiry); parentSignal.removeEventListener('abort', abort);
      if (transfer?.request.requestId === item.requestId) transfer = null;
      changed();
    }
  }
  async function runPoll(run, signal) {
    while (current(run)) {
      try {
        const result = await request('/v1/desktop-pdfs/provider/poll', { method: 'POST', body: getDirectCapability() ? { direct: true } : {}, signal, timeoutMs: 25_000 });
        if (!current(run)) break;
        if (!result || Object.keys(result).join(',') !== 'request') fail('DESKTOP_INVALID_RESPONSE');
        if (result.request !== null) {
          if (!validRequest(result.request, now())) fail('DESKTOP_INVALID_RESPONSE');
          await serve(result.request, run, signal);
        } else {
          // A proxy or misconfigured server may return immediately. Do not spin.
          await retryDelay(signal, 250);
        }
      } catch (error) {
        if (!current(run)) break;
        onError(error);
        await retryDelay(signal, 1500);
      }
    }
  }
  return {
    snapshot,
    start() {
      if (controller && !controller.signal.aborted) return;
      const previous = loop;
      controller = new AbortController(); const run = ++generation, signal = controller.signal;
      // Re-enabling cannot overlap a cancelled native read from the last run.
      loop = Promise.resolve(previous).catch(() => {}).then(() => current(run) && runPoll(run, signal));
    },
    stop() { generation++; controller?.abort(); transfer?.controller.abort(); changed(); },
    cancel(id) { if (transfer?.request.requestId === id) transfer.controller.abort(); },
    cancelBinding(id) { if (transfer?.bindingId === id) transfer.controller.abort(); },
    settled() { return loop || Promise.resolve(); },
  };
}

module.exports = { MAX_FILE_BYTES, captureLibraryAnchor, sameLibraryAnchor, assertLibraryAnchor, findAttachment,
  readDesktopAttachment, createDesktopPdfProvider };
