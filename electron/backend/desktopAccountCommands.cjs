const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const nativeFs = require('./nativeFs.cjs');
const { MAX_FILE_BYTES, captureLibraryAnchor, sameLibraryAnchor, assertLibraryAnchor,
  findAttachment, readDesktopAttachment, createDesktopPdfProvider } = require('./desktopPdfProvider.cjs');
const { validStunUrls } = require('./desktopPeerHost.cjs');
const { createDesktopRemoteTasks } = require('./desktopRemoteTasks.cjs');
const { createDesktopModels } = require('./desktopModels.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_BINDINGS = 512;
const MAX_LIBRARIES = 16;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const localId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\\/\x00-\x1f\x7f]/.test(value);
const safeText = (value, maximum) => typeof value === 'string' && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const iso = () => new Date().toISOString();
const sha = (value) => createHash('sha256').update(value).digest('hex');
const KNOWN_ERRORS = new Set(['AUTHENTICATION_REQUIRED', 'AUTH_REQUIRED', 'AUTH_FAILED', 'SESSION_REVOKED', 'DEVICE_SESSION_MISMATCH',
  'AUTH_SIGN_IN_FAILED', 'AUTH_SESSION_CHANGED', 'AUTH_CANCELLED', 'ACCOUNT_CONFIGURATION_INVALID',
  'NOT_FOUND', 'DESKTOP_PDF_UNAVAILABLE', 'ATTACHMENT_VERSION_UNAVAILABLE', 'DESKTOP_PDF_CHANGED', 'DESKTOP_PDF_REQUEST_IN_USE',
  'DESKTOP_PDF_TRANSFER_BUSY', 'REQUEST_TOO_LARGE', 'PDF_INTEGRITY_MISMATCH', 'INVALID_PDF', 'DESKTOP_PDF_TIMEOUT',
  'DESKTOP_PDF_DIRECT_FALLBACK', 'IDENTITY_PROVIDER_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED', 'NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT',
  'ACCOUNT_STORAGE_LIMIT', 'ACCOUNT_ENTITY_LIMIT', 'ACCOUNT_CHANGE_LIMIT', 'ACCOUNT_RECEIPT_LIMIT', 'CONFLICT',
  'LOCAL_CAPACITY_EXCEEDED', 'ENTITY_ALREADY_EXISTS', 'INVALID_DESKTOP_SOURCE', 'INVALID_PAPER_METADATA', 'INVALID_ATTACHMENT_METADATA']);
function publicError(error) {
  const code = error?.code || error?.message;
  return typeof code === 'string' && (/^(?:DESKTOP_|REMOTE_|MODEL_)[A-Z0-9_]{1,64}$/.test(code) || ['PROFILE_CHANGED', 'SOURCE_UNAVAILABLE', 'EXTERNAL_OUTCOME_UNKNOWN'].includes(code) || KNOWN_ERRORS.has(code)) ? code : 'DESKTOP_OPERATION_FAILED';
}
function normalizeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()) fail('DESKTOP_CONFIG_INVALID');
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search ||
        url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) fail('DESKTOP_CONFIG_INVALID');
    return url.href.replace(/\/$/, '');
  } catch { fail('DESKTOP_CONFIG_INVALID'); }
}
function normalizeConfig(value) {
  if (!exactKeys(value, ['apiBaseUrl', 'oidcIssuer', 'oidcClientId', 'deviceName']) ||
      typeof value.oidcClientId !== 'string' || !/^[A-Za-z0-9._:-]{1,255}$/.test(value.oidcClientId) ||
      !safeText(value.deviceName, 80) || !value.deviceName.trim()) fail('DESKTOP_CONFIG_INVALID');
  return { apiBaseUrl: normalizeUrl(value.apiBaseUrl), oidcIssuer: normalizeUrl(value.oidcIssuer),
    oidcClientId: value.oidcClientId, deviceName: value.deviceName.trim() };
}
function serviceKey(config) { return sha(JSON.stringify([config.apiBaseUrl, config.oidcIssuer, config.oidcClientId])); }
function parseIdentity(value) {
  if (!exactKeys(value, ['accountId', 'device']) || !UUID.test(value.accountId) || !plain(value.device) ||
      !UUID.test(value.device.id) || !safeText(value.device.name, 80) || value.device.revokedAt !== null ||
      !['web', 'windows', 'macos', 'linux', 'ios', 'android'].includes(value.device.platform)) fail('DESKTOP_INVALID_RESPONSE');
  return { accountId: value.accountId, deviceId: value.device.id, deviceName: value.device.name };
}
function parseTarget(value) {
  if (!exactKeys(value, ['paper', 'version']) || !exactKeys(value.paper, ['entityId', 'revision', 'title']) ||
      !exactKeys(value.version, ['entityId', 'revision', 'data']) || !UUID.test(value.paper.entityId) || !UUID.test(value.version.entityId) ||
      !Number.isSafeInteger(value.paper.revision) || value.paper.revision < 1 || !Number.isSafeInteger(value.version.revision) || value.version.revision < 1 ||
      !safeText(value.paper.title, 4096) || !exactKeys(value.version.data, ['paperId', 'attachmentId', 'sha256', 'sizeBytes', 'mediaType', 'fileName', 'pageCount'])) fail('DESKTOP_INVALID_RESPONSE');
  const data = value.version.data;
  if (data.paperId !== value.paper.entityId || !UUID.test(data.attachmentId) || !HASH.test(data.sha256) ||
      !Number.isSafeInteger(data.sizeBytes) || data.sizeBytes < 1 || data.sizeBytes > MAX_FILE_BYTES || data.mediaType !== 'application/pdf' ||
      !safeText(data.fileName, 255) || !data.fileName || /[\\/:]/.test(data.fileName) ||
      data.pageCount !== null && (!Number.isSafeInteger(data.pageCount) || data.pageCount < 1)) fail('DESKTOP_INVALID_RESPONSE');
  return value;
}
async function boundedJson(response) {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_JSON_BYTES) fail('DESKTOP_INVALID_RESPONSE');
  const reader = response.body.getReader(); const chunks = []; let count = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      count += part.value.byteLength;
      if (count > MAX_JSON_BYTES) { await reader.cancel(); fail('DESKTOP_INVALID_RESPONSE'); }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks, count).toString('utf8')); }
    catch { fail('DESKTOP_INVALID_RESPONSE'); }
  } finally { reader.releaseLock(); }
}

function createDesktopAccountCommands(context, options = {}) {
  const fetcher = options.fetch || ((...args) => fetch(...args));
  const allocateId = options.randomUUID || randomUUID;
  const now = options.now || Date.now;
  const notify = () => { try { options.onChange?.(); } catch {} };
  const privateRoot = path.join(path.dirname(context.appPaths.configPath), 'account-sync');
  const configPath = path.join(privateRoot, 'config.json');
  let config = null, account = null, capability = null, enabled = false, lastError = null, closed = false;
  let epoch = 1, sessionController = new AbortController(), auth = options.auth || null, authUnsubscribe = null;
  let document = null, scopePath = null, libraryBindingId = null, busy = 0, loginTask = null, loginStarting = null, lock = null;
  let mutations = Promise.resolve(), actions = Promise.resolve(), shutdownTask = null, pendingCleanup = Promise.resolve();
  let providerIntent = 0, stoppingProvider = Promise.resolve();
  let peerHost = options.peerHost || null;
  const remoteWires = new Map();
  const modelWires = new Map();
  const getPeerHost = () => peerHost ||= require('./desktopPeerHost.cjs').createDesktopPeerHost();
  const actionTasks = new Map(), bindingControllers = new Map(), sourceErrors = new Map();
  let core;
  function syncCore() { return core ||= options.core || require('../generated/desktopSyncCore.cjs'); }
  const currentLibrary = () => document?.libraries.find((entry) => entry.libraryBindingId === libraryBindingId) || null;
  const assertEpoch = (captured) => { if (closed || captured !== epoch || sessionController.signal.aborted) fail('DESKTOP_OPERATION_CANCELLED'); };
  function requireAccount() { if (!account || !currentLibrary() || !auth || auth.getSnapshot().status !== 'signed-in') fail('AUTHENTICATION_REQUIRED'); }
  function ensureAuth() {
    if (!auth) auth = require('./desktopOidc.cjs').createDesktopOidcSession({
      openExternal: (url) => require('electron').shell.openExternal(url), fetch: fetcher,
    });
    if (!authUnsubscribe) authUnsubscribe = auth.subscribe(() => {
      const snapshot = auth.getSnapshot();
      if (account && ['signed-out', 'error'].includes(snapshot.status)) invalidateSession(publicError({ code: snapshot.errorCode || 'AUTHENTICATION_REQUIRED' }));
      else notify();
    });
    return auth;
  }
  async function privateRead(file, maximum = MAX_STATE_BYTES) {
    try { return JSON.parse((await nativeFs.read(file, { maxBytes: maximum, singleLink: true })).bytes.toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; fail('DESKTOP_STORAGE_INVALID'); }
  }
  async function privateWrite(file, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_STATE_BYTES) fail('DESKTOP_STORAGE_FULL');
    try { await nativeFs.mkdir(path.dirname(file)); await nativeFs.write(file, bytes, { mode: 0o600 }); }
    catch { fail('DESKTOP_STORAGE_UNAVAILABLE'); }
  }
  let initialization = (async () => {
    const saved = await privateRead(configPath, 16 * 1024);
    if (saved !== null) {
      if (!exactKeys(saved, ['formatVersion', 'config']) || saved.formatVersion !== 1) fail('DESKTOP_STORAGE_INVALID');
      config = normalizeConfig(saved.config);
    }
  })().catch((error) => { lastError = publicError(error); });

  function bindingStatus(binding, library = currentLibrary()) {
    if (sourceErrors.has(binding.bindingId)) return { publicationStatus: 'source-changed', errorCode: sourceErrors.get(binding.bindingId) };
    if (binding.mode === 'existing') return { publicationStatus: 'published' };
    const state = library.syncState;
    for (const [entityId, stage] of [[binding.paperId, 'pending-paper'], [binding.attachmentVersionId, 'pending-version']]) {
      const entry = state.outbox.find((item) => item.operation.entityId === entityId);
      if (entry) {
        if (['conflict', 'rejected', 'device-blocked'].includes(entry.status)) return { publicationStatus: 'blocked', errorCode: publicError({ code: entry.errorCode || 'CONFLICT' }) };
        return { publicationStatus: stage, ...(entry.errorCode ? { errorCode: publicError({ code: entry.errorCode }) } : {}) };
      }
      const type = entityId === binding.paperId ? 'paper' : 'attachmentVersion';
      const record = state.serverRecords[`${type}:${entityId}`];
      if (!record || record.deletedAt || !record.data) return { publicationStatus: 'blocked', errorCode: 'ATTACHMENT_VERSION_UNAVAILABLE' };
    }
    return { publicationStatus: 'published' };
  }
  function publicBinding(binding) {
    return { bindingId: binding.bindingId, localPaperId: binding.localPaperId, localAttachmentId: binding.localAttachmentId,
      title: binding.title, fileName: binding.fileName, paperId: binding.paperId, attachmentVersionId: binding.attachmentVersionId,
      sha256: binding.sha256, sizeBytes: binding.sizeBytes, ...bindingStatus(binding) };
  }
  function getStatus() {
    const raw = auth?.getSnapshot() || { status: 'signed-out' };
    const safeAuth = { status: ['signed-out', 'signing-in', 'signed-in', 'error'].includes(raw.status) ? raw.status : 'error' };
    if (safeText(raw.displayName, 160)) safeAuth.displayName = raw.displayName;
    if (Number.isFinite(raw.expiresAt)) safeAuth.expiresAt = raw.expiresAt;
    if (raw.errorCode) safeAuth.errorCode = publicError({ code: raw.errorCode });
    return { config: config && { ...config }, auth: safeAuth, account: account && { ...account }, enabled, busy: busy > 0,
      capability: capability && { ...capability, ...(capability.direct ? { direct: { ...capability.direct, stunUrls: [...capability.direct.stunUrls] } } : {}) },
      bindings: (currentLibrary()?.bindings || []).filter((item) => !item.removed).map(publicBinding),
      transfers: provider.snapshot(), remoteTasks: remoteTasks.status(), modelInference: models.status(), errorCode: lastError };
  }
  function activeBinding(versionId) {
    if (!enabled || !account) return null;
    return currentLibrary()?.bindings.find((item) => !item.removed && item.attachmentVersionId === versionId && bindingStatus(item).publicationStatus === 'published') || null;
  }
  async function tokenForExpiry(expiresAt, signal) {
    if (signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED');
    await ensureAuth().getAccessToken(signal);
    if (signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED');
    const expiry = auth.getSnapshot().expiresAt;
    if (!Number.isFinite(expiry) || expiry <= expiresAt + 1000) fail('AUTHENTICATION_REQUIRED');
  }
  function invalidateSession(code) {
    if (closed) return;
    void remoteTasks.stop(); void models.stop();
    enabled = false; providerIntent++; provider.stop(); epoch++; sessionController.abort(); sessionController = new AbortController();
    for (const controller of bindingControllers.values()) controller.abort();
    account = null; capability = null; document = null; libraryBindingId = null; scopePath = null; sourceErrors.clear();
    lastError = code; notify();
    void Promise.resolve(auth?.signOut()).catch(() => {});
    const ownedLock = lock; lock = null;
    pendingCleanup = Promise.allSettled([pendingCleanup, mutations, actions, loginTask, remoteTasks.settled(), models.settled()]).then(() => releaseLock(ownedLock));
  }
  async function request(route, { method = 'GET', body, signal, timeoutMs = 30_000, raw = false, minimumExpiry = 0, remoteHeaders } = {}) {
    if (!config) fail('DESKTOP_CONFIG_REQUIRED');
    const captured = epoch, settings = config;
    assertEpoch(captured);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const sessionSignal = sessionController.signal;
    signal?.addEventListener('abort', cancel, { once: true }); sessionSignal.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted || sessionSignal.aborted) controller.abort();
    const timer = setTimeout(cancel, timeoutMs); timer.unref?.();
    try {
      if (controller.signal.aborted) fail('DESKTOP_OPERATION_CANCELLED');
      const token = await ensureAuth().getAccessToken(controller.signal);
      assertEpoch(captured);
      if (controller.signal.aborted) fail('DESKTOP_OPERATION_CANCELLED');
      if (minimumExpiry && (!Number.isFinite(auth.getSnapshot().expiresAt) || auth.getSnapshot().expiresAt <= minimumExpiry + 1000)) fail('AUTHENTICATION_REQUIRED');
      if ((route.startsWith('/v1/remote-tasks') || route.startsWith('/v1/model-inference')) && account) {
        const key = JSON.stringify([settings.apiBaseUrl, account.accountId, account.deviceId]);
        const wires = route.startsWith('/v1/model-inference') ? modelWires : remoteWires;
        wires.set(key, { apiBaseUrl: settings.apiBaseUrl, token });
        while (wires.size > 16) wires.delete(wires.keys().next().value);
      }
      const response = await fetcher(`${settings.apiBaseUrl}${route}`, {
        method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
          ...(body !== undefined ? raw ? { 'Content-Type': remoteHeaders ? 'application/octet-stream' : 'application/pdf', 'Content-Length': String(body.length) }
            : { 'Content-Type': 'application/json' } : {}), ...(remoteHeaders ? {
              'X-PaperQuay-Remote-Attempt': remoteHeaders['X-PaperQuay-Remote-Attempt'],
              'X-PaperQuay-Remote-Fence': remoteHeaders['X-PaperQuay-Remote-Fence'],
            } : {}) },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      assertEpoch(captured);
      let result;
      try { result = await boundedJson(response); }
      catch (error) { if (response.status !== 401 && response.status !== 403) throw error; }
      assertEpoch(captured);
      if (controller.signal.aborted) fail('DESKTOP_OPERATION_CANCELLED');
      if (!response.ok) {
        const responseCode = result?.error?.code;
        const code = typeof responseCode === 'string' && (KNOWN_ERRORS.has(responseCode) || /^(?:REMOTE_|MODEL_)[A-Z_]{1,64}$/.test(responseCode)) ? responseCode
          : response.status === 401 ? 'AUTHENTICATION_REQUIRED' : response.status === 403 ? 'SESSION_REVOKED'
            : response.status === 404 ? 'NOT_FOUND' : response.status === 429 ? 'DESKTOP_PDF_TRANSFER_BUSY' : 'DESKTOP_SERVICE_FAILED';
        if (response.status === 401 || response.status === 403) invalidateSession(code);
        fail(code);
      }
      return result;
    } catch (error) {
      if (signal?.aborted || captured !== epoch || closed) fail('DESKTOP_OPERATION_CANCELLED');
      if (controller.signal.aborted) fail('DESKTOP_REQUEST_TIMEOUT');
      if (error?.code || error?.message?.startsWith('DESKTOP_')) throw error;
      fail('NETWORK_UNAVAILABLE');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); sessionSignal.removeEventListener('abort', cancel);
    }
  }
  async function validateTarget(binding, signal) {
    const target = parseTarget(await request(`/v1/desktop-pdfs/versions/${binding.attachmentVersionId}`, { signal }));
    if (target.version.entityId !== binding.attachmentVersionId || target.paper.entityId !== binding.paperId ||
        target.version.data.sha256 !== binding.sha256 || target.version.data.sizeBytes !== binding.sizeBytes) fail('DESKTOP_PDF_CHANGED');
    return target;
    return target;
  }
  const provider = createDesktopPdfProvider({
    request, sendContent: (route, bytes, signal, expiry) => request(route, { method: 'POST', body: bytes, raw: true, signal,
      timeoutMs: Math.max(1, expiry - now()), minimumExpiry: expiry }),
    getBinding: activeBinding,
    read: (binding, signal) => readDesktopAttachment(context, { ...binding, anchor: currentLibrary().anchor, signal,
      expected: binding, maxBytes: capability.maxFileBytes }),
    validateTarget, ensureTokenLifetime: tokenForExpiry, onChange: notify, now,
    getDirectCapability: () => capability?.direct || null, getPeerHost,
    ...(options.retryDelay ? { retryDelay: options.retryDelay } : {}),
    onError(error, binding) {
      const code = publicError(error);
      if (binding && ['DESKTOP_SOURCE_CHANGED', 'DESKTOP_SOURCE_UNAVAILABLE', 'DESKTOP_SOURCE_NOT_APPROVED',
        'DESKTOP_LIBRARY_CHANGED', 'DESKTOP_FILE_TOO_LARGE', 'DESKTOP_PDF_CHANGED', 'ATTACHMENT_VERSION_UNAVAILABLE', 'INVALID_PDF'].includes(code)) {
        sourceErrors.set(binding.bindingId, code);
      }
      if (['AUTHENTICATION_REQUIRED', 'AUTH_REQUIRED', 'SESSION_REVOKED', 'DEVICE_SESSION_MISMATCH'].includes(code)) invalidateSession(code);
      else if (!binding && code === 'NOT_FOUND') { enabled = false; provider.stop(); lastError = 'DESKTOP_FEATURE_UNAVAILABLE'; notify(); }
      else if (code !== 'DESKTOP_OPERATION_CANCELLED') { lastError = code; notify(); }
    },
  });
  const remoteTasks = createDesktopRemoteTasks(context, {
    core: syncCore(), fetch: fetcher, onChange: notify, ...options.remoteTasks,
    getContext: () => ({ config, account, epoch, library: currentLibrary(),
      bindings: (currentLibrary()?.bindings || []).filter((item) => !item.removed && bindingStatus(item).publicationStatus === 'published') }),
    checkContext(value) { assertEpoch(value.epoch); requireAccount();
      if (value.library.libraryBindingId !== libraryBindingId || value.account.accountId !== account.accountId
        || value.account.deviceId !== account.deviceId) fail('DESKTOP_OPERATION_CANCELLED');
      assertLibraryAnchor(context, value.library.anchor);
    },
    api(_snapshot, input) { return request(input.path, { method: input.method, body: input.bytes || input.body,
      signal: input.signal, raw: !!input.bytes, timeoutMs: input.bytes ? 45000 : 15000, remoteHeaders: input.bytes ? input.headers : undefined }); },
    readPdf: async ({ task, snapshot, signal, check }) => {
      await check(); requireAccount();
      if (snapshot.scope.libraryId !== libraryBindingId) fail('DESKTOP_OPERATION_CANCELLED');
      const binding = currentLibrary().bindings.find((item) => !item.removed && item.attachmentVersionId === task.target.attachmentVersionId
        && item.paperId === task.target.paperId && item.sha256 === task.target.sha256 && item.sizeBytes === task.target.sizeBytes
        && bindingStatus(item).publicationStatus === 'published');
      if (!binding) fail('SOURCE_UNAVAILABLE');
      if (context.authorizeCloudParsePath) {
        const source = findAttachment(context, binding.localPaperId, binding.localAttachmentId);
        // Reuse the existing cloud-egress policy for this selected attachment,
        // without probing or approving unrelated library attachments.
        const scopedLibrary = { ...source.library, papers: [{ ...source.paper, attachments: [source.attachment] }] };
        try { await context.authorizeCloudParsePath(scopedLibrary, source.attachment.storedPath); }
        catch { fail('DESKTOP_SOURCE_NOT_APPROVED'); }
        await check();
      }
      const result = await readDesktopAttachment(context, { localPaperId: binding.localPaperId, localAttachmentId: binding.localAttachmentId,
        anchor: currentLibrary().anchor, expected: binding, signal, maxBytes: MAX_FILE_BYTES }); await check(); return result.bytes;
    },
    async withdrawPresence(snapshot) {
      const key = JSON.stringify([snapshot.scope.service, snapshot.scope.accountId, snapshot.scope.deviceId]);
      const wire = remoteWires.get(key); if (!wire) return;
      const response = await fetcher(`${wire.apiBaseUrl}/v1/remote-tasks/provider`, { method: 'DELETE', signal: AbortSignal.timeout(3000),
        headers: { Authorization: `Bearer ${wire.token}`, Accept: 'application/json' }, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      await response.body?.cancel();
    },
  });

  const models = createDesktopModels(context, {
    core: syncCore(), fetch: fetcher, onChange: notify, ...options.models,
    getContext: () => ({ config, account, epoch, library: currentLibrary() }),
    checkContext(value) { assertEpoch(value.epoch); requireAccount();
      if (value.library.libraryBindingId !== libraryBindingId || value.account.accountId !== account.accountId
        || value.account.deviceId !== account.deviceId) fail('DESKTOP_OPERATION_CANCELLED');
      assertLibraryAnchor(context, value.library.anchor);
    },
    ensureTokenLifetime: (expiry) => tokenForExpiry(expiry, sessionController.signal),
    api(_snapshot, input) { return request(input.path, { method: input.method, body: input.body, signal: input.signal, timeoutMs: 15000 }); },
    async withdrawPresence(scope) {
      const wire = modelWires.get(JSON.stringify([scope.service, scope.accountId, scope.deviceId])); if (!wire) return;
      const response = await fetcher(wire.apiBaseUrl + '/v1/model-inference/provider', { method: 'DELETE', signal: AbortSignal.timeout(3000),
        headers: { Authorization: 'Bearer ' + wire.token, Accept: 'application/json' }, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      await response.body?.cancel();
    },
  });

  function validateDocument(value, expectedService, expectedAccount) {
    if (!exactKeys(value, ['formatVersion', 'serviceKey', 'accountId', 'libraries']) || value.formatVersion !== 1 ||
        value.serviceKey !== expectedService || value.accountId !== expectedAccount || !Array.isArray(value.libraries) || value.libraries.length > MAX_LIBRARIES) fail('DESKTOP_STORAGE_INVALID');
    const seen = new Set();
    for (const library of value.libraries) {
      if (!exactKeys(library, ['libraryBindingId', 'anchor', 'identityMap', 'syncState', 'bindings']) || !UUID.test(library.libraryBindingId) || seen.has(library.libraryBindingId) ||
          !exactKeys(library.anchor, ['dataDirectory', 'directoryIdentity', 'databaseIdentity']) || typeof library.anchor.dataDirectory !== 'string' ||
          !path.isAbsolute(library.anchor.dataDirectory) || library.anchor.dataDirectory.includes('\0') ||
          !/^\d+:\d+$/.test(library.anchor.directoryIdentity) || !/^\d+:\d+$/.test(library.anchor.databaseIdentity) ||
          !Array.isArray(library.bindings) || library.bindings.length > MAX_BINDINGS) fail('DESKTOP_STORAGE_INVALID');
      if (library.identityMap === null || library.syncState === null) {
        if (library.identityMap !== null || library.syncState !== null || library.bindings.some((item) => item.mode === 'publish')) fail('DESKTOP_STORAGE_INVALID');
      } else if (!syncCore().validateDesktopIdentityMap(library.identityMap).ok || library.identityMap.accountId !== expectedAccount ||
          library.identityMap.libraryBindingId !== library.libraryBindingId || !syncCore().validateClientState(library.syncState).ok ||
          library.syncState.accountId !== expectedAccount) fail('DESKTOP_STORAGE_INVALID');
      seen.add(library.libraryBindingId); const ids = new Set();
      for (const item of library.bindings) {
        if (!exactKeys(item, ['bindingId', 'localPaperId', 'localAttachmentId', 'paperId', 'attachmentVersionId', 'sha256', 'sizeBytes', 'title', 'fileName', 'mode', 'removed', 'createdAt']) ||
            !UUID.test(item.bindingId) || ids.has(item.bindingId) || !localId(item.localPaperId) || !localId(item.localAttachmentId) || !UUID.test(item.paperId) ||
            !UUID.test(item.attachmentVersionId) || !HASH.test(item.sha256) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 || item.sizeBytes > MAX_FILE_BYTES ||
            !safeText(item.title, 4096) || !safeText(item.fileName, 255) || /[\\/:]/.test(item.fileName) || !['publish', 'existing'].includes(item.mode) ||
            typeof item.removed !== 'boolean' || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) fail('DESKTOP_STORAGE_INVALID');
        ids.add(item.bindingId);
      }
    }
    return value;
  }
  async function acquireLock(file) {
    await nativeFs.mkdir(path.dirname(file));
    for (let attempt = 0; attempt < 2; attempt++) {
      const owner = allocateId();
      try {
        await nativeFs.write(file, Buffer.from(JSON.stringify({ pid: process.pid, owner })), { mode: 0o600, exclusive: true });
        const info = nativeFs.inspectSync(file); lock = { path: file, identity: info.identity, version: info.version }; return;
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt) fail('DESKTOP_ACCOUNT_IN_USE');
        const previous = await privateRead(file, 4096);
        if (!previous) continue;
        if (!exactKeys(previous, ['pid', 'owner']) || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || !UUID.test(previous.owner)) fail('DESKTOP_ACCOUNT_IN_USE');
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (probe) { alive = probe.code !== 'ESRCH'; }
        if (alive) fail('DESKTOP_ACCOUNT_IN_USE');
        const stale = nativeFs.inspectSync(file);
        await nativeFs.remove(file, { expectedIdentity: stale.identity, expectedVersion: stale.version });
      }
    }
    fail('DESKTOP_ACCOUNT_IN_USE');
  }
  async function releaseLock(old = lock) {
    if (lock === old) lock = null;
    if (old) await nativeFs.remove(old.path, { expectedIdentity: old.identity, expectedVersion: old.version }).catch(() => {});
  }
  async function openAccount(identity, captured) {
    const key = serviceKey(config);
    const destination = path.join(privateRoot, 'accounts', sha(JSON.stringify([key, identity.accountId])) + '.json');
    await pendingCleanup; assertEpoch(captured);
    await acquireLock(destination + '.lock');
    try { assertEpoch(captured); } catch (error) { await releaseLock(); throw error; }
    const saved = await privateRead(destination); assertEpoch(captured);
    const next = saved ? validateDocument(saved, key, identity.accountId)
      : { formatVersion: 1, serviceKey: key, accountId: identity.accountId, libraries: [] };
    const anchor = captureLibraryAnchor(context);
    let library = next.libraries.find((item) => sameLibraryAnchor(item.anchor, anchor));
    if (!library) {
      if (next.libraries.length >= MAX_LIBRARIES) fail('DESKTOP_STORAGE_FULL');
      if (next.libraries.some((item) => item.anchor.dataDirectory === anchor.dataDirectory)) lastError = 'DESKTOP_LIBRARY_CHANGED';
      const id = allocateId();
      // Empty stores need no generated protocol dependency until publication.
      library = { libraryBindingId: id, anchor, identityMap: null, syncState: null, bindings: [] };
      next.libraries.push(library);
    } else if (library.syncState) library.syncState = library.syncState.deviceId === identity.deviceId
      ? syncCore().resumeAfterRestart(library.syncState) : syncCore().rebindDevice(library.syncState, identity.deviceId);
    await privateWrite(destination, next); assertEpoch(captured);
    document = next; scopePath = destination; libraryBindingId = library.libraryBindingId; account = identity;
  }
  function commit(change, captured = epoch) {
    const operation = mutations.then(async () => {
      assertEpoch(captured); requireAccount();
      const next = structuredClone(document), destination = scopePath;
      const library = next.libraries.find((item) => item.libraryBindingId === libraryBindingId);
      assertLibraryAnchor(context, library.anchor);
      const result = change(library, next);
      await privateWrite(destination, next); assertEpoch(captured);
      document = next; notify(); return result;
    });
    mutations = operation.catch(() => {}); return operation;
  }
  function runAction(key, operation) {
    if (actionTasks.has(key)) return actionTasks.get(key);
    const captured = epoch;
    busy++; notify();
    const task = actions.then(async () => { assertEpoch(captured); requireAccount(); return operation(captured); })
      .finally(() => { busy--; actionTasks.delete(key); notify(); });
    actions = task.catch(() => {}); actionTasks.set(key, task); return task;
  }
  async function refreshCapability(signal) {
    const result = await request('/v1/capabilities', { signal });
    capability = null;
    if (result?.protocolVersion !== 1) fail('DESKTOP_INVALID_RESPONSE');
    remoteTasks.setCapability(result.features?.remoteTasks === 1 ? result.remoteTasks : null);
    await remoteTasks.refreshStatus();
    models.setCapability(result.features?.modelInference === 1 ? result.modelInference : null);
    await models.refreshStatus();
    if (result.features?.desktopPdfTransfer !== 1) return;
    const value = result.desktopPdf;
    if (!plain(value) || value.transport !== 'http-relay-v1' ||
        !Number.isSafeInteger(value.maxFileBytes) || value.maxFileBytes < 1 || value.maxFileBytes > MAX_FILE_BYTES ||
        value.requestTtlMs !== 30_000 || value.pollTimeoutMs !== 20_000) fail('DESKTOP_INVALID_RESPONSE');
    // The service may advertise additional limits. Only validated fields cross
    // into the desktop status contract or influence local transfer behavior.
    capability = { transport: value.transport, maxFileBytes: value.maxFileBytes,
      requestTtlMs: value.requestTtlMs, pollTimeoutMs: value.pollTimeoutMs };
    if (value.direct !== undefined) {
      const direct = value.direct;
      if (!plain(direct) || direct.transport !== 'webrtc-data-v1' || direct.attemptMs !== 6000 || direct.maxSdpBytes !== 32768 ||
          !validStunUrls(direct.stunUrls)) fail('DESKTOP_INVALID_RESPONSE');
      capability.direct = { transport: direct.transport, attemptMs: direct.attemptMs,
        maxSdpBytes: direct.maxSdpBytes, stunUrls: [...direct.stunUrls] };
    }
  }
  function stopProviderRemote() {
    const settings = config, currentAuth = auth, previousStop = stoppingProvider;
    enabled = false; providerIntent++; provider.stop(); void peerHost?.close(); notify();
    if (!settings || !currentAuth || !account) return stoppingProvider;
    // Capture the session before it is locally cleared; this fixed endpoint
    // cannot receive a renderer-supplied URL or credential.
    const task = (async () => { try {
      const signal = AbortSignal.timeout(3000), token = await currentAuth.getAccessToken(signal);
      await previousStop;
      if (signal.aborted) return;
      const response = await fetcher(`${settings.apiBaseUrl}/v1/desktop-pdfs/provider`, { method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      await response.body?.cancel();
    } catch {} })();
    stoppingProvider = task; return task;
  }
  async function clearSession() {
    const stopping = stopProviderRemote();
    const remoteStopping = remoteTasks.stop();
    const modelStopping = models.stop();
    epoch++; sessionController.abort(); sessionController = new AbortController();
    for (const controller of bindingControllers.values()) controller.abort();
    const oldAuth = auth;
    account = null; document = null; scopePath = null; libraryBindingId = null; capability = null; sourceErrors.clear();
    // Clear the visible session immediately. A cancelled native read still owns
    // its slot and private writer lock until it actually ends in the background.
    const ownedLock = lock; lock = null;
    pendingCleanup = Promise.allSettled([pendingCleanup, mutations, actions, loginTask, stopping, remoteStopping, modelStopping, remoteTasks.settled(), models.settled()]).then(() => releaseLock(ownedLock));
    notify(); await oldAuth?.signOut();
  }
  async function sendOperation(entityId, captured, signal) {
    let prepared;
    await commit((library) => {
      const entry = library.syncState.outbox.find((item) => item.operation.entityId === entityId);
      if (!entry) return;
      if (!['queued', 'uncertain'].includes(entry.status)) fail('DESKTOP_PUBLICATION_BLOCKED');
      const prioritized = { ...library.syncState, outbox: [entry, ...library.syncState.outbox.filter((item) => item !== entry)] };
      prepared = syncCore().preparePush(prioritized, syncCore().getSyncContext(prioritized), 1);
      library.syncState = prepared.state;
    }, captured);
    if (!prepared) return;
    try {
      const result = await request('/v1/sync/push', { method: 'POST', body: prepared.request, signal });
      assertEpoch(captured);
      await commit((library) => {
        library.syncState = syncCore().applyPushResults(library.syncState, prepared.context, result, prepared.opIds);
      }, captured);
    } catch (error) {
      if (captured === epoch && account) await commit((library) => {
        library.syncState = syncCore().markPushUncertain(library.syncState, prepared.context, prepared.opIds, 'NETWORK_ERROR');
      }, captured).catch(() => {});
      throw error;
    }
  }
  async function flushBinding(bindingId, captured) {
    const controller = new AbortController(); bindingControllers.set(bindingId, controller);
    try {
      const current = () => {
        assertEpoch(captured);
        const found = currentLibrary().bindings.find((item) => item.bindingId === bindingId && !item.removed);
        if (!found || controller.signal.aborted) fail('DESKTOP_OPERATION_CANCELLED');
        return found;
      };
      let binding = current();
      for (const id of [binding.paperId, binding.attachmentVersionId]) {
        await sendOperation(id, captured, controller.signal);
        binding = current();
        const remaining = currentLibrary().syncState.outbox.find((item) => item.operation.entityId === id);
        if (remaining) fail(['conflict', 'rejected', 'device-blocked'].includes(remaining.status) ? 'DESKTOP_PUBLICATION_BLOCKED' : 'DESKTOP_PUBLICATION_PENDING');
      }
      try { await validateTarget(binding, controller.signal); current(); }
      catch (error) {
        if (['ATTACHMENT_VERSION_UNAVAILABLE', 'DESKTOP_PDF_CHANGED'].includes(publicError(error))) sourceErrors.set(bindingId, publicError(error));
        throw error;
      }
      sourceErrors.delete(bindingId); lastError = null; notify();
    } finally { if (bindingControllers.get(bindingId) === controller) bindingControllers.delete(bindingId); }
  }
  async function publish({ localPaperId, localAttachmentId }, captured) {
    if (!localId(localPaperId) || !localId(localAttachmentId)) fail('DESKTOP_ARGUMENT_INVALID');
    if (!capability) fail('DESKTOP_FEATURE_UNAVAILABLE');
    const library = currentLibrary(), signal = sessionController.signal;
    const verified = await readDesktopAttachment(context, { localPaperId, localAttachmentId, anchor: library.anchor, signal, maxBytes: capability.maxFileBytes });
    // Publication sends metadata only. Do not retain a full PDF while waiting
    // for its two durable acknowledgements.
    delete verified.bytes;
    assertEpoch(captured);
    let bindingId;
    await commit((next) => {
      const currentSource = findAttachment(context, localPaperId, localAttachmentId).attachment;
      if (currentSource.storedPath !== verified.attachment.storedPath || currentSource.contentHash !== verified.attachment.contentHash ||
          currentSource.fileSize !== verified.attachment.fileSize) fail('DESKTOP_SOURCE_CHANGED');
      const duplicate = next.bindings.find((item) => !item.removed && item.localPaperId === localPaperId &&
        item.localAttachmentId === localAttachmentId && item.sha256 === verified.sha256 && item.mode === 'publish');
      if (duplicate) { bindingId = duplicate.bindingId; return; }
      if (next.bindings.length >= MAX_BINDINGS) fail('DESKTOP_STORAGE_FULL');
      next.identityMap ||= syncCore().createDesktopIdentityMap(account.accountId, next.libraryBindingId);
      next.syncState ||= syncCore().createAccountState(account.accountId, account.deviceId);
      // Only the explicitly selected attachment is projected. Today's complete
      // verified bytes replace stale *projection input* metadata, never SQLite.
      const paper = { ...verified.paper, attachments: [{ ...verified.attachment, contentHash: verified.sha256, fileSize: verified.sizeBytes }] };
      const projected = syncCore().projectDesktopLibrary({ accountId: account.accountId, libraryBindingId: next.libraryBindingId,
        identityMap: next.identityMap, papers: [paper], verifiedAttachments: [{ localPaperId, localAttachmentId,
          verification: 'sha256-complete', sha256: verified.sha256, sizeBytes: verified.sizeBytes, pageCount: null }] }, allocateId);
      const paperEntity = projected.entities.find((item) => item.entityType === 'paper');
      const version = projected.entities.find((item) => item.entityType === 'attachmentVersion');
      if (!paperEntity || !version || projected.skipped.length) fail('DESKTOP_PUBLICATION_INVALID');
      const additions = projected.entities.filter((item) => !next.syncState.serverRecords[`${item.entityType}:${item.entityId}`] &&
        !next.syncState.outbox.some((entry) => entry.operation.entityId === item.entityId));
      next.syncState = syncCore().queueLocalCreates(next.syncState, additions.map((item) => ({ entityType: item.entityType,
        entityId: item.entityId, mutation: 'put', data: item.data })), additions.map(() => ({ opId: allocateId(), clientCreatedAt: iso() })));
      next.identityMap = projected.identityMap;
      bindingId = allocateId();
      next.bindings.push({ bindingId, localPaperId, localAttachmentId, paperId: paperEntity.entityId, attachmentVersionId: version.entityId,
        sha256: verified.sha256, sizeBytes: verified.sizeBytes, title: paperEntity.data.title, fileName: version.data.fileName,
        mode: 'publish', removed: false, createdAt: iso() });
    }, captured);
    await flushBinding(bindingId, captured);
    return getStatus();
  }

  const handlers = {
    async desktop_account_status() { await initialization; await Promise.all([remoteTasks.refreshStatus(), models.refreshStatus()]); return getStatus(); },
    async desktop_remote_tasks_set_enabled(args) { await initialization;
      if (args?.enabled) { requireAccount(); await refreshCapability(sessionController.signal); }
      await remoteTasks.setEnabled(args); lastError = null; return getStatus();
    },
    async desktop_remote_tasks_clear_completed(args) { requireAccount(); const result = await remoteTasks.clearCompleted(args); lastError = null; return { ...result, status: getStatus() }; },
    async desktop_models_set_enabled(args) { await initialization;
      if (args?.enabled) { requireAccount(); await refreshCapability(sessionController.signal); }
      await models.setEnabled(args); lastError = null; return getStatus();
    },
    async desktop_models_records() { requireAccount(); return models.listRecords(); },
    async desktop_models_backup(args) { requireAccount(); return models.backup(args); },
    async desktop_models_export(args,event) { requireAccount();const captured=epoch,library=currentLibrary().libraryBindingId;
      return runAction('model-backup:'+String(args?.id),async()=>{const backup=await models.backup(args);const check=()=>{assertEpoch(captured);requireAccount();if(currentLibrary().libraryBindingId!==library)fail('DESKTOP_OPERATION_CANCELLED');assertLibraryAnchor(context,currentLibrary().anchor);};check();
        const exporter=options.modelBackupExporter||require('./modelBackupExport.cjs').createModelBackupExporter(options.modelBackupExport);return exporter.save(backup,{event,check});});
    },
    async desktop_models_retry_save(args) { requireAccount(); await models.retrySave(args); return getStatus(); },
    async desktop_models_clear_completed(args) { requireAccount(); const result = await models.clearAcknowledged(args); return { ...result, status: getStatus() }; },
    async desktop_account_configure({ config: value }) {
      const settings = normalizeConfig(value); await initialization; await clearSession();
      await privateWrite(configPath, { formatVersion: 1, config: settings });
      config = settings; lastError = null; notify(); return getStatus();
    },
    async desktop_account_sign_in() {
      await initialization;
      if (loginTask || loginStarting) return getStatus();
      if (!config) fail('DESKTOP_CONFIG_REQUIRED');
      const requestedEpoch = epoch;
      busy++;
      // Reserve startup before cleanup yields. Keep it separate from loginTask:
      // clearSession waits on the previous login and must never wait on itself.
      const starting = Promise.resolve().then(async () => {
        assertEpoch(requestedEpoch);
        const clearing = clearSession();
        const captured = epoch, settings = { ...config }, signal = sessionController.signal;
        await clearing; assertEpoch(captured); lastError = null; ensureAuth();
        const task = (async () => {
          await auth.signIn({ apiBaseUrl: settings.apiBaseUrl, oidcIssuer: settings.oidcIssuer, oidcClientId: settings.oidcClientId }, signal);
          assertEpoch(captured);
          const identity = parseIdentity(await request('/v1/devices', { method: 'POST', body: { name: settings.deviceName,
            platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux' }, signal }));
          await openAccount(identity, captured); await refreshCapability(signal); assertEpoch(captured);
        })().catch(async (error) => {
          if (captured === epoch) {
            lastError = publicError(error); account = null; document = null; libraryBindingId = null; scopePath = null;
            await auth.signOut().catch(() => {}); await releaseLock();
          }
        }).finally(() => { if (loginTask === task) loginTask = null; busy--; notify(); });
        loginTask = task;
      });
      loginStarting = starting;
      try { await starting; }
      catch (error) { busy--; throw error; }
      finally { if (loginStarting === starting) loginStarting = null; notify(); }
      return getStatus();
    },
    async desktop_account_cancel_sign_in() { auth?.cancelSignIn(); await clearSession(); return getStatus(); },
    async desktop_account_sign_out() { await clearSession(); lastError = null; return getStatus(); },
    async desktop_provider_candidates() {
      await initialization;
      const library = context.store.load(), bindings = currentLibrary()?.bindings || [];
      const items = [];
      for (const paper of library.papers || []) for (const attachment of paper.attachments || []) {
        if (attachment.kind !== 'pdf' || attachment.paperId !== paper.id || !localId(paper.id) || !localId(attachment.id)) continue;
        const binding = bindings.find((item) => !item.removed && item.localPaperId === paper.id && item.localAttachmentId === attachment.id);
        items.push({ localPaperId: paper.id, localAttachmentId: attachment.id,
          title: safeText(paper.title, 4096) ? paper.title : '', fileName: String(attachment.fileName || 'paper.pdf').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255),
          sizeBytes: Number.isSafeInteger(attachment.fileSize) && attachment.fileSize > 0 ? attachment.fileSize : 0,
          ...(binding ? { bindingId: binding.bindingId, publicationStatus: bindingStatus(binding).publicationStatus } : {}) });
        if (items.length >= 2000) return { items, hasMore: true };
      }
      return { items, hasMore: false };
    },
    async desktop_provider_remote_versions() {
      requireAccount(); if (!capability) fail('DESKTOP_FEATURE_UNAVAILABLE');
      const items = [], seen = new Set(); let after = null;
      do {
        const query = new URLSearchParams({ limit: '100' }); if (after) query.set('after', after);
        const page = await request(`/v1/desktop-pdfs/versions?${query}`);
        if (!exactKeys(page, ['items', 'nextAfter', 'hasMore']) || !Array.isArray(page.items) || page.items.length > 100 ||
            typeof page.hasMore !== 'boolean' || page.nextAfter !== null && !UUID.test(page.nextAfter) ||
            page.hasMore && (!page.nextAfter || seen.has(page.nextAfter))) fail('DESKTOP_INVALID_RESPONSE');
        for (const raw of page.items) {
          const target = parseTarget(raw), data = target.version.data;
          items.push({ paperId: target.paper.entityId, attachmentVersionId: target.version.entityId, title: target.paper.title,
            fileName: data.fileName, sha256: data.sha256, sizeBytes: data.sizeBytes, pageCount: data.pageCount });
        }
        if (!page.hasMore) return { items, hasMore: false };
        if (items.length >= 1000) return { items, hasMore: true };
        after = page.nextAfter; seen.add(after);
      } while (true);
    },
    desktop_provider_publish(args) {
      if (!exactKeys(args, ['localPaperId', 'localAttachmentId'])) fail('DESKTOP_ARGUMENT_INVALID');
      return runAction(`publish:${JSON.stringify(args)}`, (captured) => publish(args, captured));
    },
    desktop_provider_retry({ bindingId }) {
      if (!UUID.test(bindingId)) fail('DESKTOP_ARGUMENT_INVALID');
      return runAction(`retry:${bindingId}`, async (captured) => {
        const binding = currentLibrary().bindings.find((item) => item.bindingId === bindingId && !item.removed);
        if (!binding) fail('DESKTOP_BINDING_NOT_FOUND');
        await readDesktopAttachment(context, { ...binding, anchor: currentLibrary().anchor, signal: sessionController.signal, expected: binding });
        if (binding.mode === 'publish') await flushBinding(bindingId, captured);
        else { await validateTarget(binding, sessionController.signal); sourceErrors.delete(bindingId); }
        lastError = null; return getStatus();
      });
    },
    desktop_provider_bind(args) {
      if (!exactKeys(args, ['localPaperId', 'localAttachmentId', 'attachmentVersionId']) || !localId(args.localPaperId) ||
          !localId(args.localAttachmentId) || !UUID.test(args.attachmentVersionId)) fail('DESKTOP_ARGUMENT_INVALID');
      return runAction(`bind:${JSON.stringify(args)}`, async (captured) => {
        if (!capability) fail('DESKTOP_FEATURE_UNAVAILABLE');
        const target = parseTarget(await request(`/v1/desktop-pdfs/versions/${args.attachmentVersionId}`));
        if (target.version.entityId !== args.attachmentVersionId) fail('DESKTOP_INVALID_RESPONSE');
        await readDesktopAttachment(context, { ...args, anchor: currentLibrary().anchor, signal: sessionController.signal,
          expected: target.version.data, maxBytes: capability.maxFileBytes });
        assertEpoch(captured);
        const confirmed = parseTarget(await request(`/v1/desktop-pdfs/versions/${args.attachmentVersionId}`));
        if (JSON.stringify(confirmed.version.data) !== JSON.stringify(target.version.data) || confirmed.paper.entityId !== target.paper.entityId) fail('DESKTOP_PDF_CHANGED');
        await commit((library) => {
          const existing = library.bindings.find((item) => !item.removed && item.localPaperId === args.localPaperId &&
            item.localAttachmentId === args.localAttachmentId && item.attachmentVersionId === args.attachmentVersionId);
          if (existing) { sourceErrors.delete(existing.bindingId); return; }
          if (library.bindings.length >= MAX_BINDINGS) fail('DESKTOP_STORAGE_FULL');
          library.bindings.push({ bindingId: allocateId(), localPaperId: args.localPaperId, localAttachmentId: args.localAttachmentId,
            paperId: target.paper.entityId, attachmentVersionId: args.attachmentVersionId, sha256: target.version.data.sha256,
            sizeBytes: target.version.data.sizeBytes, title: target.paper.title, fileName: target.version.data.fileName,
            mode: 'existing', removed: false, createdAt: iso() });
        }, captured);
        lastError = null; return getStatus();
      });
    },
    async desktop_provider_export_parsed({ bindingId }, event) {
      requireAccount(); if (!UUID.test(bindingId)) fail('DESKTOP_ARGUMENT_INVALID');
      return runAction(`export-parsed:${bindingId}`, async (captured) => {
        const libraryId = libraryBindingId;
        const binding = currentLibrary().bindings.find((item) => item.bindingId === bindingId && !item.removed);
        if (!binding || bindingStatus(binding).publicationStatus !== 'published') fail('DESKTOP_BINDING_NOT_FOUND');
        const snapshot = structuredClone(binding);
        const check = () => {
          assertEpoch(captured); requireAccount();
          if (libraryBindingId !== libraryId || !currentLibrary().bindings.some((item) => !item.removed &&
              item.bindingId === bindingId && JSON.stringify(item) === JSON.stringify(snapshot))) fail('DESKTOP_OPERATION_CANCELLED');
          assertLibraryAnchor(context, currentLibrary().anchor);
        };
        const signal = sessionController.signal;
        const target = await validateTarget(snapshot, signal); check();
        const verified = await readDesktopAttachment(context, { localPaperId: snapshot.localPaperId,
          localAttachmentId: snapshot.localAttachmentId, anchor: currentLibrary().anchor, signal,
          expected: snapshot, maxBytes: MAX_FILE_BYTES }); check();
        const exporter = options.parsedDocumentExporter || require('./parsedDocumentExport.cjs').createParsedDocumentExporter(context,
          { core: syncCore(), ...options.parsedDocumentExport });
        const prepared = await exporter.prepare({ binding: snapshot, bytes: verified.bytes,
          expectedPageCount: target.version.data.pageCount, check });
        return exporter.save(prepared, { fileName: snapshot.fileName, event, check, beforeWrite: async () => {
          check();
          const currentTarget = await validateTarget(snapshot, signal); check();
          if (JSON.stringify(currentTarget.version.data) !== JSON.stringify(target.version.data)) fail('DESKTOP_PDF_CHANGED');
          await readDesktopAttachment(context, { localPaperId: snapshot.localPaperId,
            localAttachmentId: snapshot.localAttachmentId, anchor: currentLibrary().anchor, signal,
            expected: snapshot, maxBytes: MAX_FILE_BYTES }); check();
        } });
      });
    },
    async desktop_provider_unbind({ bindingId }) {
      requireAccount(); if (!UUID.test(bindingId)) fail('DESKTOP_ARGUMENT_INVALID');
      await remoteTasks.stop(); await models.stop();
      provider.cancelBinding(bindingId); bindingControllers.get(bindingId)?.abort();
      await commit((library) => {
        const binding = library.bindings.find((item) => item.bindingId === bindingId && !item.removed);
        if (!binding) fail('DESKTOP_BINDING_NOT_FOUND');
        binding.removed = true;
      });
      sourceErrors.delete(bindingId); return getStatus();
    },
    async desktop_provider_set_enabled({ enabled: value }) {
      if (typeof value !== 'boolean') fail('DESKTOP_ARGUMENT_INVALID');
      if (!value) { await stopProviderRemote(); return getStatus(); }
      const intent = ++providerIntent, captured = epoch;
      requireAccount(); await stoppingProvider; assertEpoch(captured);
      if (intent !== providerIntent) fail('DESKTOP_OPERATION_CANCELLED');
      await refreshCapability(sessionController.signal);
      assertEpoch(captured); if (intent !== providerIntent) fail('DESKTOP_OPERATION_CANCELLED');
      if (!capability) fail('DESKTOP_FEATURE_UNAVAILABLE');
      assertLibraryAnchor(context, currentLibrary().anchor);
      if (!currentLibrary().bindings.some((item) => !item.removed && bindingStatus(item).publicationStatus === 'published')) fail('DESKTOP_NO_PUBLISHED_FILES');
      await tokenForExpiry(now() + capability.requestTtlMs, sessionController.signal);
      assertEpoch(captured); if (intent !== providerIntent) fail('DESKTOP_OPERATION_CANCELLED');
      enabled = true; lastError = null; provider.start(); notify(); return getStatus();
    },
    async desktop_provider_cancel({ transferId }) {
      if (!UUID.test(transferId)) fail('DESKTOP_ARGUMENT_INVALID');
      provider.cancel(transferId); return getStatus();
    },
  };
  const commands = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (args = {}, event) => {
    const startedAtEpoch = epoch;
    try { if (closed) fail('DESKTOP_CLOSED'); return await handler(args, event); }
    catch (error) {
      const code = publicError(error);
      if (code !== 'DESKTOP_OPERATION_CANCELLED' || startedAtEpoch === epoch) { lastError = code; notify(); }
      throw Object.assign(new Error(code), { code });
    }
  }]));
  return {
    commands, getStatus,
    stopProvider: () => Promise.allSettled([stopProviderRemote(), remoteTasks.stop(), models.stop()]),
    configurationWillChange: (content) => Promise.all([remoteTasks.configurationWillChange(content), models.configurationWillChange(content)]),
    configurationDidChange: () => Promise.all([remoteTasks.refreshStatus(), models.refreshStatus()]),
    close() {
      if (closed) return;
      const remoteStopping = remoteTasks.stop();
      const modelStopping = models.stop();
      closed = true; enabled = false; providerIntent++; epoch++; sessionController.abort(); provider.stop();
      void peerHost?.close();
      for (const controller of bindingControllers.values()) controller.abort();
      authUnsubscribe?.(); auth?.close();
      const ownedLock = lock; lock = null;
      shutdownTask = Promise.allSettled([loginStarting, loginTask, mutations, actions, provider.settled(), peerHost?.settled(), initialization, pendingCleanup, stoppingProvider, remoteStopping, modelStopping, remoteTasks.settled(), models.settled()]).then(() => { remoteWires.clear(); modelWires.clear(); return releaseLock(ownedLock); });
      account = null; document = null; scopePath = null; libraryBindingId = null;
    },
    // A completion hook for isolated tests and orderly backend shutdown checks.
    async settled() {
      await Promise.allSettled([loginStarting]);
      await Promise.allSettled([loginTask, mutations, actions, provider.settled(), initialization, shutdownTask, pendingCleanup, remoteTasks.settled(), models.settled()]);
    },
  };
}

module.exports = { createDesktopAccountCommands, normalizeConfig, parseTarget, publicError };
