import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { runBackup, runRestore } = require('../electron/backend/webdavBackup.cjs');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pq-webdav-read-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, 'shared'), privateDir = path.join(root, 'private');
  fs.mkdirSync(shared); fs.mkdirSync(privateDir);
  const pdf = path.join(shared, 'paper.pdf'); fs.writeFileSync(pdf, 'approved bytes');
  const attachment = { id: 'att', kind: 'pdf', storedPath: pdf, fileName: 'paper.pdf' };
  const library = { settings: { storageDir: shared }, webdav: { includePdfs: true, includeDerived: false }, papers: [{ id: 'paper', attachments: [attachment] }] };
  const snapshotTo = (target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'private snapshot'); };
  const context = { appPaths: { dataDir: shared, mineruCacheDir: path.join(shared, '.mineru-cache'), configPath: path.join(privateDir, 'config.json'),
    backupSnapshotDir: path.join(privateDir, 'snapshots'), libraryDatabasePath: 'library.sqlite', notesDatabasePath: 'notes.sqlite', ragDatabasePath: 'rag.sqlite' },
    store: { load: () => library, save: async () => {}, snapshotTo }, noteStore: { snapshotTo }, ragStore: { snapshotTo },
    validateLibraryFileOperation: (_library, files) => ({ attachmentPaths: files.map((file) => file.storedPath), storageRoot: shared }) };
  let probes = 0, downloads = 0, uploads = 0;
  for (const name of ['stat', 'realpath', 'readdir']) {
    const original = fsp[name];
    fsp[name] = (...args) => {
      if (String(args[0]).startsWith(shared)) { probes++; throw new Error('Unexpected pathname probe'); }
      return original(...args);
    };
    t.after(() => { fsp[name] = original; });
  }
  const object = { kind: 'pdf', remotePath: 'latest/pdfs/paper/att/paper.pdf', status: 'uploaded', source: `paper:paper:attachment:att:${pdf}`,
    byteSize: 14, checksum: createHash('sha256').update('approved bytes').digest('hex') };
  const webdav = { getText: async () => JSON.stringify({ version: 3, backupId: 'fixture', objects: [object] }),
    getBytes: async () => { downloads++; return Buffer.from('restored bytes'); },
    atomicUploadBytes: async () => { uploads++; }, atomicUploadFile: async () => { uploads++; } };
  const redirect = () => {
    fs.renameSync(shared, path.join(root, 'old-shared'));
    const destination = process.platform === 'win32' ? '\\\\paperquay-never-contact.invalid\\share' : path.join(root, 'outside');
    fs.symlinkSync(destination, shared, process.platform === 'win32' ? 'junction' : 'dir');
  };
  return { context, library, webdav, shared, pdf, object, redirect, probes: () => probes, downloads: () => downloads, uploads: () => uploads };
}

test('backup never probes an approved PDF pathname after its parent becomes a network link', async (t) => {
  const f = fixture(t);
  f.context.store.save = async () => f.redirect();
  await assert.rejects(runBackup(f.context, f.webdav), /path changed|linked/);
  assert.equal(f.probes(), 0); assert.equal(f.uploads(), 0);
});

test('restore matching check rejects a parent network link before stat/hash/download', async (t) => {
  const f = fixture(t);
  f.context.validateLibraryRestoreTarget = (_kind, target) => { f.redirect(); return target; };
  const result = await runRestore(f.context, f.webdav);
  assert.equal(result.failedCount, 1);
  assert.match(result.objects[0].message, /path changed|linked/);
  assert.equal(f.probes(), 0); assert.equal(f.downloads(), 0);
});

test('derived backup directory enumeration cannot follow a retargeted network parent', async (t) => {
  const f = fixture(t); f.library.webdav.includePdfs = false; f.library.webdav.includeDerived = true;
  fs.mkdirSync(f.context.appPaths.mineruCacheDir); fs.writeFileSync(path.join(f.context.appPaths.mineruCacheDir, 'full.md'), 'approved cache');
  f.context.authorizeLocalRead = (target) => { f.redirect(); return target; };
  await assert.rejects(runBackup(f.context, f.webdav), /path changed|linked/);
  assert.equal(f.probes(), 0); assert.equal(f.uploads(), 0);
});

test('ordinary backup, missing PDF, matching restore and replacement retain their behavior', async (t) => {
  const f = fixture(t);
  const backup = await runBackup(f.context, { ...f.webdav, getText: async () => null });
  assert.equal(backup.ok, true); assert.equal(backup.pdfCount, 1);
  const matching = await runRestore(f.context, f.webdav);
  assert.equal(matching.skippedCount, 1); assert.equal(f.downloads(), 0);
  fs.unlinkSync(f.pdf);
  const missing = await runBackup(f.context, { ...f.webdav, getText: async () => null });
  assert.equal(missing.objects.find((item) => item.kind === 'pdf').status, 'skipped');
  const restored = await runRestore(f.context, f.webdav);
  assert.equal(restored.pdfRestoredCount, 1); assert.equal(fs.readFileSync(f.pdf, 'utf8'), 'restored bytes');
  assert.equal(f.probes(), 0);
});
