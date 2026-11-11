const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const nativeFs = require('./nativeFs.cjs');
const { createRemoteTaskWorker } = require('./remoteTaskWorker.cjs');
const { createRemoteTaskJournal, scopeDigest, normalizeRemoteScope } = require('./remoteTaskJournal.cjs');
const { createRemoteMineruAdapter, createRemoteMineruMaterializer, remoteUrl } = require('./remoteMineruAdapter.cjs');
const { createRemoteVectorAdapter, REMOTE_VECTOR_CHUNKER } = require('./remoteVectorAdapter.cjs');
const { createParsedDocumentExporter } = require('./parsedDocumentExport.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function remoteConfiguration(value) {
  const settings = value?.settings || {}, secrets = value?.secrets || {};
  return {
    parse: { apiBaseUrl: String(settings.mineruApiBaseUrl || '').trim() || 'https://mineru.net/api/v4', apiToken: String(secrets.mineruApiToken || '').trim(),
      modelVersion: 'vlm', enableFormula: true, enableTable: true, language: 'ch', isOcr: false },
    index: { baseUrl: String(settings.embeddingBaseUrl || '').trim(), apiKey: String(secrets.embeddingApiKey || '').trim(), model: String(settings.embeddingModel || '').trim(),
      dimensions: settings.embeddingDimensions ?? null, inputFormat: settings.embeddingInputFormat || 'plain',
      batchSize: Number.isInteger(settings.embeddingBatchSize) ? Math.max(1, Math.min(64, settings.embeddingBatchSize)) : 16,
      timeoutMs: Number.isFinite(settings.embeddingRequestTimeoutSeconds) ? Math.max(1000, Math.min(600000, settings.embeddingRequestTimeoutSeconds * 1000)) : 180000 },
  };
}
function publicDescriptors(config) {
  const result = [], unavailable = {};
  try {
    remoteUrl(config.parse.apiBaseUrl);
    if (!config.parse.apiToken) fail('REMOTE_PARSE_NOT_CONFIGURED');
    result.push({ id: 'mineru-default', kind: 'parse', model: 'vlm', digest: sha(JSON.stringify({ kind: 'parse', parser: 'mineru', model: 'vlm',
      formula: true, table: true, language: 'ch', ocr: false, output: 'portable-v1' })) });
  } catch { unavailable.parse = 'REMOTE_PARSE_NOT_CONFIGURED'; }
  try {
    remoteUrl(config.index.baseUrl);
    if (!config.index.apiKey || !config.index.model || config.index.model.length > 128 || /[\x00-\x1f\x7f]/.test(config.index.model)) fail('REMOTE_INDEX_NOT_CONFIGURED');
    if (!Number.isInteger(config.index.dimensions) || config.index.dimensions < 1 || config.index.dimensions > 4096) fail('REMOTE_INDEX_DIMENSION_REQUIRED');
    if (config.index.inputFormat !== 'plain') fail('REMOTE_INDEX_INPUT_UNSUPPORTED');
    result.push({ id: 'embedding-default', kind: 'index', model: config.index.model, digest: sha(JSON.stringify({ kind: 'index', model: config.index.model,
      dimensions: config.index.dimensions, inputFormat: 'plain', chunker: REMOTE_VECTOR_CHUNKER })) });
  } catch (error) { unavailable.index = ['REMOTE_INDEX_DIMENSION_REQUIRED', 'REMOTE_INDEX_INPUT_UNSUPPORTED'].includes(error.code) ? error.code : 'REMOTE_INDEX_NOT_CONFIGURED'; }
  return { descriptors: result, unavailable };
}
/** Private fingerprint is encrypted with the OS and never sent to a renderer,
 * journal or service. Only an unrelated stable UUID guards credential epochs. */
function createCredentialRevisionStore(directory, options = {}) {
  const secure = () => options.secure || require('electron').safeStorage;
  async function load(scope) {
    const crypto = secure();
    if (!crypto?.isEncryptionAvailable?.() || crypto.getSelectedStorageBackend?.() === 'basic_text') fail('REMOTE_CREDENTIAL_STORAGE_UNAVAILABLE');
    const { deviceId: _sessionDevice, ...partition } = normalizeRemoteScope(scope);
    const destination = path.join(directory, sha(JSON.stringify(partition)) + '.bin'); let previous = null;
    try {
      const stored = await nativeFs.read(destination, { maxBytes: 32768, singleLink: true });
      previous = JSON.parse(crypto.decryptString(stored.bytes));
      if (!exact(previous, ['format', 'version', 'signature', 'revision', 'profiles', 'devices']) || previous.format !== 'paperquay-remote-credentials'
        || previous.version !== 1 || !HASH.test(previous.signature) || !UUID.test(previous.revision) || !Array.isArray(previous.profiles)
        || previous.profiles.length > 8 || previous.profiles.some((item) => !exact(item, ['id', 'revision', 'digest'])
          || !Number.isSafeInteger(item.revision) || item.revision < 1 || !HASH.test(item.digest) || !['mineru-default', 'embedding-default'].includes(item.id))
        || !Array.isArray(previous.devices) || previous.devices.length > 256 || previous.devices.some((id) => !UUID.test(id))
        || new Set(previous.devices).size !== previous.devices.length) fail('REMOTE_CREDENTIAL_STORAGE_UNAVAILABLE');
    } catch (error) { if (error.code !== 'ENOENT') fail('REMOTE_CREDENTIAL_STORAGE_UNAVAILABLE'); }
    return { crypto, destination, previous };
  }
  return { async update(scope, signature, descriptors) {
    const { crypto, destination, previous } = await load(scope);
    const profiles = descriptors.map((item) => {
      const old = previous?.profiles.find((value) => value.id === item.id);
      const revision = old ? old.revision + (old.digest === item.digest ? 0 : 1) : 1;
      if (!Number.isSafeInteger(revision)) fail('REMOTE_CREDENTIAL_STORAGE_UNAVAILABLE');
      return { id: item.id, revision, digest: item.digest };
    });
    const devices = previous?.devices.includes(scope.deviceId) ? previous.devices : [...(previous?.devices || []).slice(-255), scope.deviceId];
    const record = { format: 'paperquay-remote-credentials', version: 1, signature,
      revision: previous?.signature === signature ? previous.revision : randomUUID(), profiles, devices };
    if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) {
      try { await nativeFs.mkdir(directory); await nativeFs.write(destination, crypto.encryptString(JSON.stringify(record)), { mode: 0o600 }); }
      catch { fail('REMOTE_CREDENTIAL_STORAGE_UNAVAILABLE'); }
    }
    return { revision: record.revision, devices: [...devices], profiles: descriptors.map((item) => ({ id: item.id, revision: profiles.find((value) => value.id === item.id).revision,
      digest: item.digest, kind: item.kind, model: item.model })) };
  }, async devices(scope) { return [...((await load(scope)).previous?.devices || [])]; } };
}
function createDesktopRemoteTasks(context, options) {
  const core = options.core;
  const privateRoot = path.join(path.dirname(context.appPaths.configPath), 'account-sync', 'remote-tasks');
  const journalDirectory = path.join(privateRoot, 'journal');
  const journal = options.journal || createRemoteTaskJournal({ directory: journalDirectory });
  const revisions = options.revisions || createCredentialRevisionStore(path.join(privateRoot, 'credential-revisions'), options);
  const exporter = options.exporter || createParsedDocumentExporter(context, { core, ...options.parsedDocumentExport });
  const materialize = options.materialize || createRemoteMineruMaterializer(context, { core, ...options.parsedDocumentExport });
  let capability = null, profiles = [], unavailable = {}, configurationToken = null, privateConfig = null;
  let signature = null, scoped = null, credentialRevision = null, enabled = false, starting = false, cleaning = false, errorCode = null;
  let knownDevices = [];
  let worker = null, activeSnapshot = null, intent = 0, stopping = Promise.resolve(), refreshTail = Promise.resolve();
  const notify = () => { try { options.onChange?.(); } catch {} };
  const publicError = (error) => typeof error?.code === 'string' && /^(?:REMOTE_|DESKTOP_|AUTHENTICATION_REQUIRED$|SESSION_REVOKED$|PROFILE_CHANGED$|SOURCE_UNAVAILABLE$|EXTERNAL_OUTCOME_UNKNOWN$)[A-Z0-9_]*$/.test(error.code) ? error.code : 'REMOTE_EXECUTION_FAILED';
  function base() {
    const value = options.getContext();
    if (!value?.account || !value.library || !value.config) fail('AUTHENTICATION_REQUIRED');
    options.checkContext(value);
    return value;
  }
  function scope(value) { return { service: value.config.apiBaseUrl, accountId: value.account.accountId, deviceId: value.account.deviceId, libraryId: value.library.libraryBindingId }; }
  async function readConfig() {
    if (options.readConfiguration) return options.readConfiguration();
    for (const destination of [context.appPaths.configPath, context.appPaths.legacyConfigPath].filter(Boolean)) {
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await nativeFs.read(destination, { maxBytes: 4 * 1024 * 1024, singleLink: true })).bytes)); }
      catch (error) { if (error.code !== 'ENOENT') fail('REMOTE_CONFIGURATION_INVALID'); }
    }
    return {};
  }
  async function refresh() {
    const next = refreshTail.then(async () => {
      const current = base(), currentScope = scope(current), scopeKey = scopeDigest(currentScope);
      const config = remoteConfiguration(await readConfig()); options.checkContext(current);
      const nextSignature = sha(JSON.stringify(config));
      // An empty profile list is also a completed configuration read.
      if (signature === nextSignature && scoped === scopeKey) return;
      const manifest = publicDescriptors(config);
      const identity = manifest.descriptors.length ? await revisions.update(currentScope, nextSignature, manifest.descriptors)
        : { revision: null, profiles: [], devices: await revisions.devices?.(currentScope).catch(() => []) || [] };
      options.checkContext(current);
      const changed = signature !== null && (signature !== nextSignature || scoped !== scopeKey);
      privateConfig = config; signature = nextSignature; scoped = scopeKey; credentialRevision = identity.revision;
      knownDevices = identity.devices || [currentScope.deviceId];
      profiles = identity.profiles; unavailable = manifest.unavailable; configurationToken = randomUUID();
      if (changed && enabled) { errorCode = 'REMOTE_CONFIGURATION_CHANGED'; void stop(); }
      notify();
    });
    refreshTail = next.catch(() => {}); return next;
  }
  async function capture() {
    await refresh(); const current = base();
    if (!credentialRevision || !profiles.length) fail('REMOTE_PROFILE_UNAVAILABLE');
    return { scope: scope(current), generation: { account: current.epoch,
      library: sha(JSON.stringify({ anchor: current.library.anchor, bindings: current.bindings.map((value) => ({ bindingId: value.bindingId,
        paperId: value.paperId, attachmentVersionId: value.attachmentVersionId, sha256: value.sha256, sizeBytes: value.sizeBytes })).sort((a, b) => a.bindingId.localeCompare(b.bindingId)) })),
      profiles: sha(JSON.stringify(profiles)), credentials: credentialRevision }, profiles: structuredClone(profiles) };
  }
  function check(snapshot, task) {
    const current = base();
    if (scopeDigest(scope(current)) !== scopeDigest(snapshot.scope) || current.epoch !== snapshot.generation.account) fail('DESKTOP_OPERATION_CANCELLED');
    if (task && !current.bindings.some((binding) => binding.paperId === task.target.paperId && binding.attachmentVersionId === task.target.attachmentVersionId
      && binding.sha256 === task.target.sha256 && binding.sizeBytes === task.target.sizeBytes)) fail('SOURCE_UNAVAILABLE');
  }
  async function getPrivate(task, snapshot) {
    await refresh(); check(snapshot, task);
    if (credentialRevision !== snapshot.generation.credentials) fail('PROFILE_CHANGED');
    return { ...privateConfig[task.kind] };
  }
  async function stop() {
    enabled = false; intent++; const previous = stopping, owned = worker, captured = activeSnapshot;
    worker = null; activeSnapshot = null;
    const halted = owned?.stop(); // Real Abort occurs synchronously before this yields.
    stopping = (async () => { await Promise.allSettled([previous, halted]);
      if (captured) await options.withdrawPresence(captured).catch(() => {});
      notify(); })();
    notify(); return stopping;
  }
  return {
    status() { const state = worker?.snapshot(); return { enabled, running: !!state?.running, busy: starting || cleaning || !!state?.busy,
      capability: capability && structuredClone(capability), profiles: capability ? structuredClone(profiles) : [], unavailable: capability ? { ...unavailable } : {},
      configurationToken: capability ? configurationToken : null,
      errorCode: errorCode || state?.errorCode || null }; },
    setCapability(value) { capability = value ? core.validateRemoteTaskCapability(value) : null;
      if (!capability && (enabled || starting)) { errorCode = 'REMOTE_TASKS_DISABLED'; void stop(); } },
    async refreshStatus() { try { if (capability && options.getContext()?.account) await refresh(); } catch (error) { profiles = []; errorCode = publicError(error); } },
    async setEnabled(args) {
      if (typeof args?.enabled !== 'boolean') fail('DESKTOP_ARGUMENT_INVALID');
      if (!args.enabled) { if (!exact(args, ['enabled'])) fail('DESKTOP_ARGUMENT_INVALID'); await stop(); return; }
      if (!exact(args, ['enabled', 'consent', 'configurationToken']) || args.consent !== true || !UUID.test(args.configurationToken)) fail('DESKTOP_ARGUMENT_INVALID');
      if (cleaning || starting) fail('REMOTE_WORKER_BUSY');
      if (enabled) { await refresh(); if (args.configurationToken !== configurationToken) fail('REMOTE_CONFIGURATION_CHANGED'); return; }
      const requested = ++intent; starting = true; notify();
      try {
        await stopping; await refresh(); const current = base();
        if (requested !== intent) fail('DESKTOP_OPERATION_CANCELLED');
        if (!capability) fail('REMOTE_TASKS_DISABLED');
        if (args.configurationToken !== configurationToken) fail('REMOTE_CONFIGURATION_CHANGED');
        if (!profiles.length) fail('REMOTE_PROFILE_UNAVAILABLE');
        if (!current.bindings.length) fail('DESKTOP_NO_PUBLISHED_FILES');
        const snapshot = await capture(); if (requested !== intent) fail('DESKTOP_OPERATION_CANCELLED');
        activeSnapshot = snapshot;
        worker = (options.createWorker || createRemoteTaskWorker)({ core, journal, capture, check,
          api: (captured, input) => { check(captured); return options.api(captured, input); }, readPdf: options.readPdf,
          adapters: {
            parse: createRemoteMineruAdapter({ fetch: options.fetch, getConfig: ({ task, snapshot: captured }) => getPrivate(task, captured), materialize }),
            index: createRemoteVectorAdapter({ core, fetch: options.fetch, getConfig: ({ task, snapshot: captured }) => getPrivate(task, captured),
              readParsed: async ({ task, snapshot: captured, pdf, check: guard }) => {
                check(captured, task); const prepared = await exporter.prepare({ binding: task.target, bytes: pdf, expectedPageCount: task.target.pageCount,
                  check: () => check(captured, task) }); await guard(); return prepared.bytes;
              } }),
          }, timings: options.timings,
          onState(state) { if (!starting && !state.running && enabled) { enabled = false; errorCode = state.errorCode || 'REMOTE_EXECUTION_INTERRUPTED'; void stop(); } notify(); },
        });
        enabled = true; errorCode = null; await worker.start(options.manual ? { manual: true } : undefined);
        if (requested !== intent) fail('DESKTOP_OPERATION_CANCELLED');
      } catch (error) { errorCode = publicError(error); await stop(); throw Object.assign(new Error(errorCode), { code: errorCode }); }
      finally { starting = false; notify(); }
    },
    async configurationWillChange(content) {
      if (!enabled && !starting) return;
      let changed = true;
      try { changed = sha(JSON.stringify(remoteConfiguration(JSON.parse(content)))) !== signature; } catch {}
      if (changed) { errorCode = 'REMOTE_CONFIGURATION_CHANGED'; await stop(); }
    },
    async clearCompleted(args) {
      if (!exact(args, ['confirmed']) || args.confirmed !== true) fail('DESKTOP_ARGUMENT_INVALID');
      if (enabled || starting || cleaning || worker?.snapshot().busy) fail('REMOTE_WORKER_BUSY');
      cleaning = true; notify();
      try {
        await stopping; const current = base(), currentScope = scope(current); let files;
        const historical = await revisions.devices?.(currentScope).catch(() => []) || knownDevices;
        const scopes = [...new Set([currentScope.deviceId, ...historical])].map((deviceId) => ({ ...currentScope, deviceId }));
        const prefixes = scopes.map((value) => ({ scope: value, prefix: scopeDigest(value) + '-' }));
        try { files = await nativeFs.listFiles(journalDirectory); } catch (error) { if (error.code === 'ENOENT') return { removed: 0 }; throw error; }
        let removed = 0;
        for (const file of files) {
          const matched = prefixes.find((value) => file.name.startsWith(value.prefix));
          if (!matched || !file.name.endsWith('.json')) continue;
          const id = file.name.slice(matched.prefix.length, -5); if (!UUID.test(id)) continue;
          options.checkContext(current); const record = await journal.read(matched.scope, id);
          if (record?.stage === 'completed') { options.checkContext(current); await journal.remove(matched.scope, id); removed++; }
        }
        if (removed && errorCode === 'REMOTE_JOURNAL_FULL') errorCode = null;
        return { removed };
      } finally { cleaning = false; notify(); }
    },
    stop, async settled() { await Promise.allSettled([stopping, refreshTail]); },
    async runOnce() { if (!worker) fail('REMOTE_WORKER_STOPPED'); return worker.runOnce(); },
  };
}
module.exports = { createDesktopRemoteTasks, createCredentialRevisionStore, remoteConfiguration, publicDescriptors };
