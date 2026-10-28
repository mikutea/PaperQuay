const path = require('node:path');
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const nativeFs = require('./nativeFs.cjs');
const { isWithin } = require('./pathAccess.cjs');

const HASH = /^[0-9a-f]{64}$/;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_MANIFEST = 2 * 1024 * 1024;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.includes('\0') ||
      value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..'))
    fail('DESKTOP_PARSED_PROVENANCE_INVALID');
  return value;
}

/** Only main constructs this capability. There is deliberately no IPC for keys,
 * signing arbitrary data, selecting evidence paths, or registering old caches. */
function createParsedDocumentProvenance(context, options = {}) {
  const profile = context.app?.getPath?.('userData') || path.dirname(path.dirname(path.dirname(context.appPaths.configPath)));
  // Outside PaperQuay's renderer-writable data/cache root, including when that
  // library is external. safeStorage also protects a copied/enumerated key file.
  const privateRoot = path.join(profile, '.paperquay-parsed-provenance');
  const keyPath = path.join(privateRoot, 'signing-key.bin');
  let keyPromise;
  async function key() {
    return keyPromise ||= (async () => {
      if (options.key) {
        if (process.versions.electron && !options.allowTestKey) fail('DESKTOP_PARSED_PROVENANCE_UNAVAILABLE');
        if (!Buffer.isBuffer(options.key) || options.key.length !== 32) fail('DESKTOP_PARSED_PROVENANCE_UNAVAILABLE');
        return options.key;
      }
      const secure = require('electron').safeStorage;
      if (!secure?.isEncryptionAvailable() || secure.getSelectedStorageBackend?.() === 'basic_text')
        fail('DESKTOP_PARSED_PROVENANCE_UNAVAILABLE');
      try {
        const encrypted = await nativeFs.read(keyPath, { maxBytes: 8192, singleLink: true });
        const value = secure.decryptString(encrypted.bytes);
        if (!/^[0-9a-f]{64}$/.test(value)) fail('DESKTOP_PARSED_PROVENANCE_UNAVAILABLE');
        return Buffer.from(value, 'hex');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const fresh = randomBytes(32);
        await nativeFs.mkdir(privateRoot);
        try { await nativeFs.write(keyPath, secure.encryptString(fresh.toString('hex')), { exclusive: true, mode: 0o600 }); }
        catch (writeError) {
          if (writeError.code !== 'EEXIST') throw writeError;
          const existing = await nativeFs.read(keyPath, { maxBytes: 8192, singleLink: true });
          const value = secure.decryptString(existing.bytes);
          if (!/^[0-9a-f]{64}$/.test(value)) fail('DESKTOP_PARSED_PROVENANCE_UNAVAILABLE');
          return Buffer.from(value, 'hex');
        }
        return fresh;
      }
    })();
  }
  async function capture({ uploadBytes, zipBytes, extracted, model, runId }) {
    try {
      const signingKey = await key();
      const root = extracted.assetRootDir;
      if (!path.isAbsolute(root)) fail('DESKTOP_PARSED_PROVENANCE_INVALID');
      const entries = new (require('adm-zip'))(zipBytes).getEntries().filter((entry) => !entry.isDirectory);
      if (entries.length > 4096) fail('DESKTOP_PARSED_PROVENANCE_INVALID');
      let total = 0; const seen = new Set();
      const files = entries.map((entry) => {
        const relativePath = relativeFile(entry.entryName.replaceAll('\\', '/'));
        if (seen.has(relativePath.toLowerCase()) || entry.header.size > MAX_FILE) fail('DESKTOP_PARSED_PROVENANCE_INVALID');
        seen.add(relativePath.toLowerCase());
        const bytes = entry.getData(); total += bytes.length;
        if (bytes.length > MAX_FILE || total > 64 * 1024 * 1024) fail('DESKTOP_PARSED_PROVENANCE_INVALID');
        return { relativePath, sha256: sha(bytes), sizeBytes: bytes.length };
      });
      const selected = (file) => {
        if (!file || !isWithin(root, file)) return null;
        const relative = path.relative(root, file).replaceAll('\\', '/');
        return files.some((entry) => entry.relativePath === relative) ? relative : null;
      };
      const json = selected(extracted.contentJsonPath) || selected(extracted.middleJsonPath);
      if (!json || typeof model !== 'string' || !model || model.length > 128) fail('DESKTOP_PARSED_PROVENANCE_INVALID');
      const record = { format: 'paperquay-mineru-provenance', version: 1, runId, root,
        pdf: { sha256: sha(uploadBytes), sizeBytes: uploadBytes.length }, parser: { name: 'mineru', model },
        json, markdown: selected(extracted.markdownPath), files };
      const payload = Buffer.from(JSON.stringify(record));
      const envelope = Buffer.from(JSON.stringify({ payload: payload.toString('base64'), mac: createHmac('sha256', signingKey).update(payload).digest('hex') }));
      if (envelope.length > MAX_MANIFEST) fail('DESKTOP_PARSED_PROVENANCE_INVALID');
      await nativeFs.mkdir(privateRoot);
      await nativeFs.write(path.join(privateRoot, record.pdf.sha256 + '.json'), envelope, { mode: 0o600 });
      return { status: 'verified', runId, pdf: record.pdf };
    } catch {
      // Parsing remains useful when OS encryption, storage, or this strict
      // portable-export profile is unavailable. Never certify old output later.
      return { status: 'unavailable', code: 'DESKTOP_PARSED_PROVENANCE_UNAVAILABLE' };
    }
  }
  async function readForPdf(pdf) {
    if (!HASH.test(pdf.sha256)) fail('DESKTOP_PARSED_PROVENANCE_INVALID');
    try {
      const signingKey = await key();
      const stored = await nativeFs.read(path.join(privateRoot, pdf.sha256 + '.json'), { maxBytes: MAX_MANIFEST, singleLink: true });
      const envelope = JSON.parse(stored.bytes.toString('utf8'));
      if (typeof envelope.payload !== 'string' || !HASH.test(envelope.mac)) fail('DESKTOP_PARSED_PROVENANCE_INVALID');
      const payload = Buffer.from(envelope.payload, 'base64');
      const mac = createHmac('sha256', signingKey).update(payload).digest();
      if (!timingSafeEqual(mac, Buffer.from(envelope.mac, 'hex'))) fail('DESKTOP_PARSED_PROVENANCE_INVALID');
      const record = JSON.parse(payload.toString('utf8'));
      if (record.format !== 'paperquay-mineru-provenance' || record.version !== 1 ||
          record.pdf.sha256 !== pdf.sha256 || record.pdf.sizeBytes !== pdf.sizeBytes || !path.isAbsolute(record.root) ||
          !Array.isArray(record.files) || record.files.length > 4096) fail('DESKTOP_PARSED_PROVENANCE_INVALID');
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') fail('DESKTOP_PARSED_REPARSE_REQUIRED');
      if (String(error.code || '').startsWith('DESKTOP_PARSED_')) throw error;
      fail('DESKTOP_PARSED_PROVENANCE_INVALID');
    }
  }
  async function readFile(record, candidate) {
    // Perform lexical checks and current authorization before any filesystem
    // operation, including on network paths. No asset path is an authority.
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || !isWithin(record.root, candidate))
      fail('DESKTOP_PARSED_RESOURCE_INVALID');
    const relative = relativeFile(path.relative(record.root, candidate).replaceAll('\\', '/'));
    const evidence = record.files.find((file) => file.relativePath === relative);
    // nativeFs treats maxBytes:0 as no limit; an empty authenticated entry must
    // never disable the read bound after a later file replacement.
    if (!evidence || !Number.isSafeInteger(evidence.sizeBytes) || evidence.sizeBytes < 1 || evidence.sizeBytes > MAX_FILE)
      fail('DESKTOP_PARSED_RESOURCE_INVALID');
    let actual;
    try { actual = await context.authorizeLocalRead?.(candidate); } catch { fail('DESKTOP_PARSED_RESOURCE_UNAVAILABLE'); }
    if (typeof actual !== 'string' || path.resolve(actual) !== path.resolve(candidate)) fail('DESKTOP_PARSED_RESOURCE_UNAVAILABLE');
    try {
      const result = await nativeFs.read(actual, { maxBytes: evidence.sizeBytes, singleLink: true });
      if (result.bytes.length !== evidence.sizeBytes || sha(result.bytes) !== evidence.sha256) fail('DESKTOP_PARSED_OUTPUT_CHANGED');
      return result.bytes;
    } catch (error) {
      if (String(error.code || '').startsWith('DESKTOP_PARSED_')) throw error;
      fail('DESKTOP_PARSED_OUTPUT_CHANGED');
    }
  }
  return { capture, readForPdf, readFile };
}

module.exports = { createParsedDocumentProvenance };
