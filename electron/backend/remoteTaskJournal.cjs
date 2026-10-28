const path = require('node:path');
const { createHash } = require('node:crypto');
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LIMITS = Object.freeze({ artifactBytes: 16 * 1024 * 1024, fileBytes: 24 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, entries: 200 });
const STAGES = new Set(['prepared', 'submit_pending', 'batch_known', 'upload_pending', 'uploaded', 'polling',
  'embedding_pending', 'embedding_progress', 'artifact_ready', 'complete_pending', 'completed', 'interrupted']);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exact = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && required.every((key) => Object.hasOwn(value, key))
  && Reflect.ownKeys(value).every((key) => typeof key === 'string' && [...required, ...optional].includes(key))
  && Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => 'value' in entry && entry.enumerable);
const text = (value, max = 2048) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
function normalizeRemoteScope(value) {
  if (!exact(value, ['service', 'accountId', 'deviceId', 'libraryId']) || !text(value.service)
    || !UUID.test(value.accountId) || !UUID.test(value.deviceId) || !text(value.libraryId, 512)) fail('REMOTE_JOURNAL_INVALID');
  let service;
  try {
    const url = new URL(value.service);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail('REMOTE_JOURNAL_INVALID');
    service = url.href.replace(/\/+$/, '');
  } catch { fail('REMOTE_JOURNAL_INVALID'); }
  return { service, accountId: value.accountId, deviceId: value.deviceId, libraryId: value.libraryId };
}
function scopeDigest(scope) { return sha(JSON.stringify(normalizeRemoteScope(scope))); }
function validateRemoteJournalEntry(input, jobId) {
  if (!exact(input, ['version', 'jobId', 'kind', 'executionKey', 'attempt', 'stage'], ['dataId', 'batchId', 'artifact', 'vectorProgress'])
    || input.version !== 1 || !UUID.test(input.jobId) || input.jobId !== jobId || !['parse', 'index'].includes(input.kind)
    || !HASH.test(input.executionKey) || !Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > 100 || !STAGES.has(input.stage)) fail('REMOTE_JOURNAL_INVALID');
  const result = { version: 1, jobId, kind: input.kind, executionKey: input.executionKey, attempt: input.attempt, stage: input.stage };
  for (const key of ['dataId', 'batchId']) if (Object.hasOwn(input, key)) {
    if (!ID.test(input[key])) fail('REMOTE_JOURNAL_INVALID'); result[key] = input[key];
  }
  if (Object.hasOwn(input, 'artifact')) {
    const item = input.artifact;
    if (!exact(item, ['base64', 'digest', 'sizeBytes']) || !HASH.test(item.digest) || !Number.isInteger(item.sizeBytes)
      || item.sizeBytes < 1 || item.sizeBytes > LIMITS.artifactBytes || typeof item.base64 !== 'string'
      || item.base64.length > Math.ceil(LIMITS.artifactBytes / 3) * 4) fail('REMOTE_JOURNAL_INVALID');
    const bytes = Buffer.from(item.base64, 'base64');
    if (bytes.length !== item.sizeBytes || bytes.toString('base64') !== item.base64 || sha(bytes) !== item.digest) fail('REMOTE_JOURNAL_CORRUPT');
    result.artifact = { base64: item.base64, digest: item.digest, sizeBytes: item.sizeBytes };
  }
  if (Object.hasOwn(input, 'vectorProgress')) {
    const item = input.vectorProgress;
    if (!exact(item, ['sourceDigest', 'chunkerDigest', 'chunksDigest', 'dimension', 'vectors', 'pendingStart', 'pendingCount'])
      || ![item.sourceDigest, item.chunkerDigest, item.chunksDigest].every((v) => HASH.test(v))
      || !Number.isInteger(item.dimension) || item.dimension < 1 || item.dimension > 4096 || !Array.isArray(item.vectors)
      || item.vectors.length > 10000 || item.vectors.length * item.dimension > 2000000
      || (item.pendingStart !== null && (!Number.isInteger(item.pendingStart) || item.pendingStart !== item.vectors.length))
      || (item.pendingCount !== null && (!Number.isInteger(item.pendingCount) || item.pendingCount < 1 || item.pendingCount > 64))
      || (item.pendingStart === null) !== (item.pendingCount === null)) fail('REMOTE_JOURNAL_INVALID');
    const vectors = item.vectors.map((vector) => {
      if (!Array.isArray(vector) || vector.length !== item.dimension || Object.keys(vector).length !== vector.length
        || vector.some((v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6)) fail('REMOTE_JOURNAL_INVALID');
      return [...vector];
    });
    result.vectorProgress = { sourceDigest: item.sourceDigest, chunkerDigest: item.chunkerDigest, chunksDigest: item.chunksDigest,
      dimension: item.dimension, vectors, pendingStart: item.pendingStart, pendingCount: item.pendingCount };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.fileBytes - 1024) fail('REMOTE_JOURNAL_FULL');
  return result;
}
function journalArtifact(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > LIMITS.artifactBytes) fail('REMOTE_JOURNAL_FULL');
  const buffer = Buffer.from(bytes);
  return { base64: buffer.toString('base64'), digest: sha(buffer), sizeBytes: buffer.length };
}
/** Private profile storage. nativeFs uses pinned no-follow handles and atomic
 * temporary-file replacement; never downgrade to pathname writes on failure. */
function createRemoteTaskJournal(options) {
  if (!options || !path.isAbsolute(options.directory)) fail('REMOTE_JOURNAL_INVALID');
  const native = options.nativeFs || require('./nativeFs.cjs');
  const directory = path.resolve(options.directory); let anchor = null; let tail = Promise.resolve();
  const serial = (work) => { const next = tail.then(work); tail = next.catch(() => {}); return next; };
  async function ready() {
    await native.mkdir(directory);
    const state = native.inspectSync(directory);
    if (state.linkPath || path.resolve(state.actual) !== directory || !state.exists || (anchor !== null && anchor !== state.identity)) fail('REMOTE_JOURNAL_UNAVAILABLE');
    anchor = state.identity;
  }
  const file = (scope, id) => {
    if (!UUID.test(id)) fail('REMOTE_JOURNAL_INVALID'); return path.join(directory, `${scopeDigest(scope)}-${id}.json`);
  };
  async function read(scope, id) {
    await ready(); const destination = file(scope, id); let stored;
    try { stored = await native.read(destination, { maxBytes: LIMITS.fileBytes, singleLink: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; fail('REMOTE_JOURNAL_UNAVAILABLE'); }
    try {
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stored.bytes));
      if (!exact(envelope, ['format', 'version', 'scopeDigest', 'record', 'digest']) || envelope.format !== 'paperquay-remote-task-journal'
        || envelope.version !== 1 || envelope.scopeDigest !== scopeDigest(scope) || !HASH.test(envelope.digest)
        || sha(JSON.stringify(envelope.record)) !== envelope.digest) fail('REMOTE_JOURNAL_CORRUPT');
      return validateRemoteJournalEntry(envelope.record, id);
    } catch { fail('REMOTE_JOURNAL_CORRUPT'); }
  }
  return {
    read: (scope, id) => serial(() => read(scope, id)),
    write: (scope, id, value) => serial(async () => {
      const record = validateRemoteJournalEntry(value, id); await ready();
      const destination = file(scope, id);
      const envelope = Buffer.from(JSON.stringify({ format: 'paperquay-remote-task-journal', version: 1,
        scopeDigest: scopeDigest(scope), record, digest: sha(JSON.stringify(record)) }));
      const files = (await native.listFiles(directory)).filter((item) => /^[0-9a-f]{64}-[0-9a-f-]{36}\.json$/.test(item.name));
      const existing = files.find((item) => item.name === path.basename(destination));
      if ((!existing && files.length >= LIMITS.entries) || files.reduce((sum, item) => sum + item.size, 0) - (existing?.size || 0) + envelope.length > LIMITS.totalBytes) fail('REMOTE_JOURNAL_FULL');
      await native.write(destination, envelope, { mode: 0o600 }); return record;
    }),
    remove: (scope, id) => serial(async () => {
      await ready(); const destination = file(scope, id);
      try { const state = native.inspectSync(destination); if (state.exists) await native.remove(destination, { expectedIdentity: state.identity }); }
      catch (error) { if (error.code !== 'ENOENT') fail('REMOTE_JOURNAL_UNAVAILABLE'); }
    }),
  };
}
module.exports = { createRemoteTaskJournal, normalizeRemoteScope, scopeDigest, validateRemoteJournalEntry, journalArtifact, REMOTE_JOURNAL_LIMITS: LIMITS };
