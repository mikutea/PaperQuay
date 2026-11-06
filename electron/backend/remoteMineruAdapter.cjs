const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { journalArtifact } = require('./remoteTaskJournal.cjs');
const REMOTE_MINERU_CACHE_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, files: 16384, directories: 2048, directoriesPerRun: 128, depth: 16 });
const cacheWork = new Map();
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
function checkSignal(signal) { if (signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED'); }
function remoteUrl(value, signed = false) {
  try {
    if (typeof value !== 'string' || value.length > 8192) fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
    const url = new URL(value);
    if (url.username || url.password || url.hash || (!signed && url.search) || (url.protocol !== 'https:'
      && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
    return url.href.replace(/\/+$/, '');
  } catch { fail('REMOTE_PROVIDER_CONFIGURATION_INVALID'); }
}
async function readBounded(response, maximum, signal) {
  if (!response.body || Number(response.headers.get('content-length')) > maximum) fail('REMOTE_PROVIDER_RESPONSE_INVALID');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      checkSignal(signal); const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); fail('REMOTE_PROVIDER_RESPONSE_INVALID'); }
      chunks.push(next.value);
    }
    checkSignal(signal); return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}
async function requestJson(fetcher, url, init, signal, timeoutMs = 60000) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
  const response = await fetcher(url, { ...init, redirect: 'error', signal: combined });
  if (!response.ok) { await response.body?.cancel(); fail(response.status >= 400 && response.status < 500 ? 'REMOTE_PROVIDER_REJECTED' : 'REMOTE_PROVIDER_REQUEST_FAILED'); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response, 1024 * 1024, combined))); }
  catch (error) { if (signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED'); throw error; }
}
function abortableDelay(ms, signal) {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(Object.assign(new Error('DESKTOP_OPERATION_CANCELLED'), { code: 'DESKTOP_OPERATION_CANCELLED' })); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
/** Real staged MinerU protocol. A durable marker precedes the only submission;
 * recovery with a known batch only polls and downloads, never posts again. */
function createRemoteMineruAdapter(options) {
  if (typeof options?.getConfig !== 'function' || typeof options.materialize !== 'function') fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
  const fetcher = options.fetch || fetch;
  return { async execute(context) {
    const { task, snapshot, signal, checkpoint, pdf } = context;
    const check = async () => { checkSignal(signal); await context.check(); checkSignal(signal); };
    await check();
    const config = await options.getConfig({ task, snapshot }); await check();
    if (!config || typeof config.apiToken !== 'string' || !config.apiToken || config.apiToken.length > 8192
      || /[\x00-\x1f\x7f]/.test(config.apiToken) || (config.modelVersion || 'vlm') !== task.profile.model) fail('PROFILE_CHANGED');
    const base = remoteUrl(config.apiBaseUrl || 'https://mineru.net/api/v4');
    const timeout = config.timeoutMs ?? 900000; const interval = config.pollIntervalMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800000 || !Number.isInteger(interval) || interval < 1 || interval > 30000) fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
    const authorization = { Authorization: `Bearer ${config.apiToken}` };
    let entry = await checkpoint.read();
    if (entry.artifact) return Buffer.from(entry.artifact.base64, 'base64');
    const dataId = entry.dataId || `pq_${task.id.replaceAll('-', '')}`;
    let batchId = entry.batchId;
    if (!batchId && entry.stage === 'submit_pending') fail('EXTERNAL_OUTCOME_UNKNOWN');
    await options.materialize.preflight?.({ task, snapshot, signal, check }); await check();
    if (!batchId) {
      entry = await checkpoint.write({ ...entry, dataId, stage: 'submit_pending' });
      await check();
      const endpoint = new URL(base + '/file-urls/batch');
      endpoint.searchParams.set('enable_formula', String(config.enableFormula !== false));
      endpoint.searchParams.set('enable_table', String(config.enableTable !== false));
      endpoint.searchParams.set('language', String(config.language || 'ch'));
      let envelope;
      try {
        envelope = await requestJson(fetcher, endpoint.href, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: [{ name: task.target.fileName, data_id: dataId }], model_version: task.profile.model, is_ocr: config.isOcr === true }) }, signal);
      } catch {
        // This includes cancellation while receiving a successful response. The
        // marker also survives transport-only rejection: an HTTP status cannot
        // establish the external business outcome or authorize another charge.
        fail('EXTERNAL_OUTCOME_UNKNOWN');
      }
      batchId = envelope?.data?.batch_id;
      // Only a well-formed numeric business verdict is authoritative. Missing,
      // coerced or malformed codes may accompany an already accepted job.
      if (typeof envelope?.code !== 'number' || !Number.isSafeInteger(envelope.code)) fail('EXTERNAL_OUTCOME_UNKNOWN');
      if (envelope.code !== 0) { await checkpoint.write({ ...entry, stage: 'prepared' }); fail('EXECUTION_FAILED'); }
      if (typeof batchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(batchId)) fail('EXTERNAL_OUTCOME_UNKNOWN');
      let uploadUrl;
      try {
        if (!Array.isArray(envelope.data?.file_urls) || envelope.data.file_urls.length !== 1) fail('EXTERNAL_OUTCOME_UNKNOWN');
        uploadUrl = remoteUrl(envelope.data.file_urls[0], true);
      } catch { fail('EXTERNAL_OUTCOME_UNKNOWN'); }
      // Persist the recoverable identifier before checking cancellation again.
      try { entry = await checkpoint.write({ ...entry, batchId, stage: 'batch_known' }); }
      catch { fail('EXTERNAL_OUTCOME_UNKNOWN'); }
      await check();
      entry = await checkpoint.write({ ...entry, stage: 'upload_pending' }); await check();
      const uploadSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)].filter(Boolean));
      const response = await fetcher(uploadUrl, { method: 'PUT', body: pdf, redirect: 'error', signal: uploadSignal });
      await response.body?.cancel();
      if (!response.ok) fail('EXECUTION_FAILED');
      entry = await checkpoint.write({ ...entry, stage: 'uploaded' });
    }
    const deadline = Date.now() + timeout;
    entry = await checkpoint.write({ ...entry, dataId, batchId, stage: 'polling' });
    while (Date.now() < deadline) {
      await check();
      const envelope = await requestJson(fetcher, `${base}/extract-results/batch/${encodeURIComponent(batchId)}`,
        { headers: { ...authorization, Accept: 'application/json' } }, signal);
      await check();
      if (envelope?.code !== 0) fail('EXECUTION_FAILED');
      const values = Array.isArray(envelope.data?.extract_result) ? envelope.data.extract_result : [envelope.data?.extract_result].filter(Boolean);
      const current = values.find((item) => item?.data_id === dataId);
      if (current?.state === 'failed') fail('EXECUTION_FAILED');
      if (current?.state === 'done') {
        const url = remoteUrl(current.full_zip_url, true);
        const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)].filter(Boolean));
        const response = await fetcher(url, { redirect: 'error', signal: downloadSignal });
        if (!response.ok) { await response.body?.cancel(); fail('EXECUTION_FAILED'); }
        const zipBytes = await readBounded(response, 64 * 1024 * 1024, downloadSignal); await check();
        const artifact = await options.materialize({ zipBytes, pdf, task, snapshot, signal, check, runId: randomUUID() }); await check();
        const bytes = Buffer.from(artifact?.bytes || artifact);
        await checkpoint.write({ ...entry, stage: 'artifact_ready', artifact: journalArtifact(bytes) });
        return bytes;
      }
      await abortableDelay(Math.min(interval, Math.max(1, deadline - Date.now())), signal);
    }
    fail('SOURCE_UNAVAILABLE');
  } };
}
/** Default production materializer reuses existing no-follow ZIP writes,
 * signed provenance and portable conversion; it never invokes a save dialog. */
function createRemoteMineruMaterializer(context, options = {}) {
  const { createWriteAuthorizer } = require('./pathAccess.cjs');
  const { readZipWithAdm } = require('./utils.cjs');
  const { createParsedDocumentProvenance } = require('./parsedDocumentProvenance.cjs');
  const { createParsedDocumentExporter } = require('./parsedDocumentExport.cjs');
  const authorize = context.authorizeLocalWrite ||= createWriteAuthorizer(context);
  const provenance = context.parsedDocumentProvenance ||= createParsedDocumentProvenance(context);
  const exporter = options.exporter || createParsedDocumentExporter(context, options);
  const native = require('./nativeFs.cjs');
  const cacheRoot = path.resolve(context.appPaths.mineruCacheDir, 'remote-tasks');
  const byteLimit = options.maxCacheBytes ?? REMOTE_MINERU_CACHE_LIMITS.bytes;
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 64 * 1024 * 1024 || byteLimit > REMOTE_MINERU_CACHE_LIMITS.bytes) fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
  const serial = (work) => {
    const previous = cacheWork.get(cacheRoot) || Promise.resolve();
    const next = previous.catch(() => {}).then(work); cacheWork.set(cacheRoot, next);
    return next.finally(() => { if (cacheWork.get(cacheRoot) === next) cacheWork.delete(cacheRoot); });
  };
  async function inspectCache(check) {
    let bytes = 0, files = 0, directories = 0;
    async function walk(directory, depth) {
      await check(); authorize(directory);
      const state = native.inspectSync(directory);
      if (!state.exists) return;
      const same = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      if (state.linkPath || same(state.actual) !== same(directory)) fail('REMOTE_MINERU_CACHE_UNAVAILABLE');
      if (++directories > REMOTE_MINERU_CACHE_LIMITS.directories || depth > REMOTE_MINERU_CACHE_LIMITS.depth) fail('REMOTE_MINERU_CACHE_FULL');
      const regular = await native.listFiles(directory); const names = new Set();
      for (const file of regular) {
        if (!Number.isSafeInteger(file.size) || file.size < 0 || (bytes += file.size) > byteLimit || ++files > REMOTE_MINERU_CACHE_LIMITS.files) fail('REMOTE_MINERU_CACHE_FULL');
        names.add(file.name);
      }
      for (const name of await native.list(directory)) if (!names.has(name)) {
        if (name === '.' || name === '..' || /[\\/\0]/.test(name)) fail('REMOTE_MINERU_CACHE_UNAVAILABLE');
        await walk(path.join(directory, name), depth + 1);
      }
    }
    await walk(cacheRoot, 0);
    return { usedBytes: bytes, maxBytes: byteLimit, files, maxFiles: REMOTE_MINERU_CACHE_LIMITS.files,
      directories, maxDirectories: REMOTE_MINERU_CACHE_LIMITS.directories };
  }
  const materialize = ({ zipBytes, pdf, task, signal, check, runId }) => serial(async () => {
    await check();
    const entries = new (require('adm-zip'))(zipBytes).getEntries(); let total = 0, fileCount = 0; const seen = new Set(), incomingDirectories = new Set();
    if (entries.length > 4096) fail('REMOTE_PROVIDER_RESPONSE_INVALID');
    for (const entry of entries) {
      const name = entry.entryName.replaceAll('\\', '/'); const size = entry.header.size;
      if (seen.has(name.toLowerCase()) || name.includes(':') || name.startsWith('/') || name.split('/').some((v) => v === '..' || v === '.')
        || (entry.header.flags & 1) || ((entry.attr >>> 16) & 0o170000) === 0o120000
        || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || (total += size) > 64 * 1024 * 1024) fail('REMOTE_PROVIDER_RESPONSE_INVALID');
      seen.add(name.toLowerCase());
      const parts = name.replace(/\/+$/, '').split('/');
      if (parts.length + 2 > REMOTE_MINERU_CACHE_LIMITS.depth) fail('REMOTE_MINERU_CACHE_FULL');
      for (let index = 1; index < parts.length; index++) incomingDirectories.add(parts.slice(0, index).join('/'));
      if (!entry.isDirectory) fileCount++;
    }
    if (incomingDirectories.size + 3 > REMOTE_MINERU_CACHE_LIMITS.directoriesPerRun) fail('REMOTE_MINERU_CACHE_FULL');
    const usage = await inspectCache(check);
    if (usage.usedBytes > byteLimit - total || usage.files + fileCount > REMOTE_MINERU_CACHE_LIMITS.files
      || usage.directories + incomingDirectories.size + 3 > REMOTE_MINERU_CACHE_LIMITS.directories) fail('REMOTE_MINERU_CACHE_FULL');
    const root = authorize(path.join(context.appPaths.mineruCacheDir, 'remote-tasks', task.id, `parse-${runId}`));
    if (native.inspectSync(root).exists) fail('REMOTE_MINERU_CACHE_UNAVAILABLE');
    const extracted = await readZipWithAdm(zipBytes, root, (candidate) => { checkSignal(signal); return authorize(candidate); });
    await check();
    const evidence = await provenance.capture({ uploadBytes: pdf, zipBytes, extracted, model: task.profile.model, runId });
    await check(); if (evidence.status !== 'verified') fail('SOURCE_UNAVAILABLE');
    const prepared = await exporter.prepare({ binding: task.target, bytes: pdf, expectedPageCount: task.target.pageCount,
      check: () => checkSignal(signal) }); await check(); return prepared.bytes;
  });
  materialize.preflight = ({ check }) => serial(async () => {
    const usage = await inspectCache(check);
    // Reserve the documented worst-case output before the only paid submit.
    if (usage.usedBytes > byteLimit - 64 * 1024 * 1024 || usage.files > REMOTE_MINERU_CACHE_LIMITS.files - 4096
      || usage.directories > REMOTE_MINERU_CACHE_LIMITS.directories - REMOTE_MINERU_CACHE_LIMITS.directoriesPerRun) fail('REMOTE_MINERU_CACHE_FULL');
    return usage;
  });
  materialize.inspectCache = ({ check = async () => {} } = {}) => serial(() => inspectCache(check));
  return materialize;
}
module.exports = { createRemoteMineruAdapter, createRemoteMineruMaterializer, remoteUrl, readBounded, requestJson, abortableDelay, REMOTE_MINERU_CACHE_LIMITS };
