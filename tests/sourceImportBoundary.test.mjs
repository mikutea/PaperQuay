import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createAppPaths, createLibraryStore } = require('../electron/backend/libraryStore.cjs');
const { createLibraryCommands } = require('../electron/backend/libraryCommands.cjs');
const { createSourceAccess } = require('../electron/backend/sourceAccess.cjs');
const native = require('../electron/backend/nativeFs.cjs');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-import-boundary-')));
  const appPaths = createAppPaths({ getPath: () => path.join(root, 'profile') });
  const store = createLibraryStore(appPaths);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, 'selected.pdf'); fs.writeFileSync(source, '%PDF-1.4\nfixture');
  const access = createSourceAccess({ showMessageBox: async () => ({ response: 0 }) });
  const context = { appPaths, store, approveImportSources: access.authorize };
  return { root, source, access, context, commands: createLibraryCommands(context), store };
}

test('PDF import cancels supplier-listed sources before native source I/O or shared copy', async (t) => {
  const f = fixture(t), open = native.openRead; let reads = 0;
  native.openRead = async (...args) => { reads++; return open(...args); };
  t.after(() => { native.openRead = open; });
  await assert.rejects(f.commands.library_import_pdfs({ request: { paths: [f.source], importMode: 'move' } }), /canceled/);
  assert.equal(reads, 0); assert.equal(f.store.load().papers.length, 0);
  assert.equal(fs.existsSync(f.source), true);
  assert.equal(fs.existsSync(f.store.load().settings.storageDir), false);
});

test('selected PDF copy, duplicate detection, keep and move remain usable', async (t) => {
  const f = fixture(t); f.access.rememberPicked([f.source]);
  const [copied] = await f.commands.library_import_pdfs({ request: { paths: [f.source], importMode: 'copy' } });
  assert.equal(copied.status, 'imported'); assert.equal(fs.existsSync(f.source), true);
  assert.deepEqual(fs.readFileSync(copied.paper.attachments[0].storedPath), fs.readFileSync(f.source));
  const [duplicate] = await f.commands.library_import_pdfs({ request: { paths: [f.source], importMode: 'move' } });
  assert.equal(duplicate.status, 'duplicate'); assert.equal(fs.existsSync(f.source), true);
  fs.writeFileSync(f.source, '%PDF-1.4\nkeep fixture');
  const [kept] = await f.commands.library_import_pdfs({ request: { paths: [f.source], importMode: 'keep' } });
  assert.equal(kept.paper.attachments[0].storedPath, f.source);
  fs.writeFileSync(f.source, '%PDF-1.4\nmove fixture');
  const [moved] = await f.commands.library_import_pdfs({ request: { paths: [f.source], importMode: 'move' } });
  assert.equal(moved.status, 'imported'); assert.equal(moved.originalRetained, undefined);
  assert.equal(fs.existsSync(f.source), false); assert.equal(f.store.load().papers.length, 3);
});

test('MOVE retains the original if metadata cannot commit or source contents change', async (t) => {
  const f = fixture(t); f.access.rememberPicked([f.source]);
  const save = f.store.save.bind(f.store);
  f.store.save = async () => { throw new Error('fixture metadata failure'); };
  await assert.rejects(f.commands.library_import_pdfs({ request: { paths: [f.source], importMode: 'move' } }), /metadata failure/);
  assert.equal(fs.existsSync(f.source), true); assert.equal(f.store.load().papers.length, 0);
  f.store.save = async (library) => { await save(library); fs.writeFileSync(f.source, '%PDF-1.4\nnewer original contents'); };
  const [result] = await f.commands.library_import_pdfs({ request: { paths: [f.source], importMode: 'move' } });
  assert.equal(result.status, 'imported'); assert.equal(result.originalRetained, true);
  assert.match(result.message, /original retained/);
  assert.match(fs.readFileSync(f.source, 'utf8'), /newer original/);
  assert.equal(fs.readFileSync(result.paper.attachments[0].storedPath, 'utf8'), '%PDF-1.4\nfixture');
});

test('failed bound attachment deletion retains metadata and the outside file', async (t) => {
  const f = fixture(t); f.access.rememberPicked([f.source]);
  const [result] = await f.commands.library_import_pdfs({ request: { paths: [f.source], importMode: 'copy' } });
  const target = result.paper.attachments[0].storedPath, directory = path.dirname(target);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const victim = path.join(outside, path.basename(target)); fs.writeFileSync(victim, 'private');
  f.context.validateLibraryFileOperation = () => {
    fs.renameSync(directory, directory + '-old');
    fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    return { attachmentPaths: [target] };
  };
  await assert.rejects(f.commands.library_delete_paper({ request: { paperId: result.paper.id, deleteFiles: true } }), /path changed/);
  assert.equal(f.store.load().papers.length, 1); assert.equal(fs.readFileSync(victim, 'utf8'), 'private');
});
