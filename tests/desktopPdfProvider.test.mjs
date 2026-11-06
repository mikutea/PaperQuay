import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { captureLibraryAnchor, readDesktopAttachment, createDesktopPdfProvider } = require('../electron/backend/desktopPdfProvider.cjs');
const { resolveAuthorizedPath, isWithin } = require('../electron/backend/pathAccess.cjs');
const nativeFs = require('../electron/backend/nativeFs.cjs');
const PDF = Buffer.from('%PDF-1.7\nlocal synthetic bytes\n%%EOF\n');
const sha256 = createHash('sha256').update(PDF).digest('hex');
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
async function until(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() > deadline) assert.fail('Provider condition timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-desktop-provider-')));
  const directory = path.join(root, 'library'), attachments = path.join(directory, 'attachments');
  fs.mkdirSync(attachments, { recursive: true });
  const database = path.join(directory, 'library.sqlite'), source = path.join(attachments, 'article.pdf');
  fs.writeFileSync(database, 'fixture library identity'); fs.writeFileSync(source, PDF);
  const attachment = { id: 'local-attachment', paperId: 'local-paper', storedPath: source, kind: 'pdf', contentHash: sha256, fileSize: PDF.length };
  const context = { appPaths: { dataDir: directory, libraryDatabasePath: database }, store: { load: () => ({ papers: [{ id: 'local-paper', attachments: [attachment] }] }) },
    authorizeLocalProbe: (raw) => resolveAuthorizedPath(raw, (candidate) => isWithin(directory, candidate)) };
  const anchor = captureLibraryAnchor(context);
  const read = (options = {}) => readDesktopAttachment(context, { localPaperId: 'local-paper', localAttachmentId: 'local-attachment', anchor, ...options });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, attachments, database, source, attachment, context, anchor, read };
}

test('descriptor reader hashes the complete real file and never returns library paths as wire metadata', async (t) => {
  const f = fixture(t), result = await f.read({ expected: { sha256, sizeBytes: PDF.length } });
  assert.deepEqual(result.bytes, PDF); assert.equal(result.sha256, sha256); assert.equal(result.sizeBytes, PDF.length);
  // The provider returns source metadata only to its trusted main-process caller.
  assert.equal(result.attachment.id, 'local-attachment');
});

test('source policy rejection occurs before opening or inspecting the requested PDF', async (t) => {
  const f = fixture(t), originalOpen = nativeFs.openRead, originalInspect = nativeFs.inspectSync; let probes = 0;
  f.context.authorizeLocalProbe = () => { throw new Error('unapproved source'); };
  nativeFs.openRead = (...args) => { probes++; return originalOpen(...args); };
  nativeFs.inspectSync = (...args) => { if (args[0] === f.source) probes++; return originalInspect(...args); };
  t.after(() => { nativeFs.openRead = originalOpen; nativeFs.inspectSync = originalInspect; });
  await assert.rejects(f.read(), { code: 'DESKTOP_SOURCE_UNAVAILABLE' }); assert.equal(probes, 0);
});

test('a policy callback returning no capability does not authorize a library-listed path', async (t) => {
  const f = fixture(t), originalOpen = nativeFs.openRead; let opened = 0;
  f.context.authorizeLocalProbe = () => undefined;
  nativeFs.openRead = (...args) => { opened++; return originalOpen(...args); };
  t.after(() => { nativeFs.openRead = originalOpen; });
  await assert.rejects(f.read(), { code: 'DESKTOP_SOURCE_NOT_APPROVED' }); assert.equal(opened, 0);
});

test('an attachment parent swapped to an outside junction during authorization is not followed', async (t) => {
  const f = fixture(t), outside = path.join(f.root, 'private'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'article.pdf'), 'private bytes');
  f.context.authorizeLocalProbe = (raw) => {
    fs.renameSync(f.attachments, f.attachments + '.old');
    fs.symlinkSync(outside, f.attachments, process.platform === 'win32' ? 'junction' : 'dir');
    return raw;
  };
  await assert.rejects(f.read(), { code: 'DESKTOP_SOURCE_UNAVAILABLE' });
  assert.equal(fs.readFileSync(path.join(outside, 'article.pdf'), 'utf8'), 'private bytes');
});

test('size limits reject both an oversized snapshot and growth during descriptor streaming', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.read({ maxBytes: PDF.length - 1 }), { code: 'DESKTOP_FILE_TOO_LARGE' });
  const originalStream = fs.createReadStream; let grown = false;
  fs.createReadStream = (...args) => {
    // Grow after the provider's fstat, but before the first descriptor read.
    // A 'data' listener can run after a tiny file's EOF has already been read.
    if (!grown) { grown = true; fs.appendFileSync(f.source, Buffer.alloc(200000, 65)); }
    return originalStream(...args);
  };
  t.after(() => { fs.createReadStream = originalStream; });
  await assert.rejects(f.read({ maxBytes: PDF.length + 100 }), { code: 'DESKTOP_FILE_TOO_LARGE' }); assert.equal(grown, true);
});

test('library metadata changed while reading is not adopted as a new attachment capability', async (t) => {
  const f = fixture(t), originalStream = fs.createReadStream;
  fs.createReadStream = (...args) => {
    const stream = originalStream(...args); stream.once('data', () => { f.attachment.contentHash = '0'.repeat(64); }); return stream;
  };
  t.after(() => { fs.createReadStream = originalStream; });
  await assert.rejects(f.read(), { code: 'DESKTOP_SOURCE_CHANGED' });
});

test('a malformed dispatched request cannot introduce a remote path into the source reader', async () => {
  let readCount = 0, pollCount = 0; const failed = deferred();
  const provider = createDesktopPdfProvider({
    request: async (_route, { signal }) => {
      if (++pollCount === 1) return { request: { requestId: randomUUID(), attachmentVersionId: randomUUID(), sha256, sizeBytes: PDF.length,
        expiresAt: new Date(Date.now() + 30000).toISOString(), path: '\\\\unapproved.invalid\\share\\file.pdf' } };
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    },
    sendContent: async () => assert.fail('No upload'), getBinding: () => assert.fail('No binding lookup for malformed request'),
    read: async () => { readCount++; }, validateTarget: async () => {}, ensureTokenLifetime: async () => {},
    onError: () => failed.resolve(),
  });
  provider.start(); await failed.promise; provider.stop(); await provider.settled(); assert.equal(readCount, 0);
});

test('stop and immediate re-enable wait for an old native read before polling again', async () => {
  const requestId = randomUUID(), attachmentVersionId = randomUUID(), bindingId = randomUUID();
  const binding = { bindingId, attachmentVersionId, sha256, sizeBytes: PDF.length };
  const entered = deferred(), release = deferred(); let polls = 0, uploads = 0;
  const provider = createDesktopPdfProvider({
    request: async (_route, { signal }) => {
      if (++polls === 1) return { request: { requestId, attachmentVersionId, sha256, sizeBytes: PDF.length, expiresAt: new Date(Date.now() + 30000).toISOString() } };
      return new Promise((_resolve, reject) => { if (signal.aborted) reject(new Error('cancelled')); else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    },
    getBinding: () => binding, read: async () => { entered.resolve(); await release.promise; return { bytes: PDF, sha256, sizeBytes: PDF.length }; },
    validateTarget: async () => {}, ensureTokenLifetime: async () => {}, sendContent: async () => { uploads++; },
  });
  provider.start(); await entered.promise; provider.stop(); provider.start();
  await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(polls, 1); assert.equal(provider.snapshot().length, 1);
  release.resolve(); await until(() => polls === 2); provider.stop(); await provider.settled(); assert.equal(uploads, 0);
});
