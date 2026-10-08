import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLibraryCommands } = require('../electron/backend/libraryCommands.cjs');
const nativeFs = require('../electron/backend/nativeFs.cjs');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pq-migrate-read-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source'), destination = path.join(root, 'destination');
  fs.mkdirSync(sourceDir); fs.mkdirSync(destination);
  const source = path.join(sourceDir, 'paper.pdf'); fs.writeFileSync(source, 'approved PDF');
  let saved = false, probes = 0;
  const library = { settings: { storageDir: sourceDir, importMode: 'copy' }, papers: [{ id: 'paper', attachments: [{ storedPath: source, relativePath: 'paper.pdf' }] }] };
  const approval = { sourcePaths: new Map([[source, source]]), storageRoot: destination, validateDestination: target => target, commit: save => save() };
  const context = { appPaths: {}, store: { load: () => structuredClone(library), saveSync: value => { Object.assign(library, value); saved = true; } }, approveLibrarySettingsChange: async () => approval };
  const access = fsp.access;
  fsp.access = async target => { probes++; throw new Error('unbound access probe'); };
  t.after(() => { fsp.access = access; });
  const redirect = directory => {
    fs.renameSync(directory, directory + '-old');
    fs.symlinkSync(process.platform === 'win32' ? '\\\\paperquay-never-contact.invalid\\share' : path.join(root, 'outside'), directory, process.platform === 'win32' ? 'junction' : 'dir');
  };
  return { root, source, sourceDir, destination, library, approval, context, redirect, probes: () => probes, saved: () => saved,
    run: () => createLibraryCommands(context).library_update_settings({ settings: { storageDir: destination } }) };
}

test('storage migration rejects a retargeted source parent before any pathname probe', async t => {
  const f = fixture(t);
  f.context.approveLibrarySettingsChange = async () => { f.redirect(f.sourceDir); return f.approval; };
  await assert.rejects(f.run(), /path changed|linked/);
  assert.equal(f.probes(), 0); assert.equal(f.saved(), false);
});

test('storage migration rejects destination retargeting after copy before the missing check', async t => {
  const f = fixture(t), copy = nativeFs.copy;
  nativeFs.copy = async (...args) => { const result = await copy(...args); f.redirect(f.destination); return result; };
  t.after(() => { nativeFs.copy = copy; });
  await assert.rejects(f.run(), /path changed|linked/);
  assert.equal(f.probes(), 0); assert.equal(f.saved(), false);
});

test('ordinary and missing-file migrations retain behavior without pathname access', async t => {
  const f = fixture(t);
  f.library.papers[0].attachments.push({ storedPath: path.join(f.sourceDir, 'missing.pdf'), relativePath: 'missing.pdf' });
  await f.run();
  assert.equal(fs.readFileSync(path.join(f.destination, 'paper.pdf'), 'utf8'), 'approved PDF');
  assert.equal(f.library.papers[0].attachments[0].missing, false);
  assert.equal(f.library.papers[0].attachments[1].missing, true);
  assert.equal(f.probes(), 0); assert.equal(f.saved(), true);
});

test('migration preserves preexisting destinations and keeps sources in move mode', async t => {
  const f = fixture(t);
  f.library.settings.importMode = 'move';
  fs.writeFileSync(path.join(f.destination, 'paper.pdf'), 'existing destination');
  fs.writeFileSync(path.join(f.destination, 'missing.pdf'), 'previously restored');
  f.library.papers[0].attachments.push({ storedPath: path.join(f.sourceDir, 'missing.pdf'), relativePath: 'missing.pdf' });
  await f.run();
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'approved PDF');
  assert.equal(fs.readFileSync(path.join(f.destination, 'paper.pdf'), 'utf8'), 'existing destination');
  assert.ok(f.library.papers[0].attachments.every(attachment => !attachment.missing));
  assert.equal(f.probes(), 0);
});

test('migration binds the copied source to the identity checked by its open handle', async t => {
  const f = fixture(t), copy = nativeFs.copy;
  nativeFs.copy = async (...args) => {
    assert.ok(args[2].expectedIdentity); assert.ok(args[2].expectedVersion);
    fs.renameSync(f.source, f.source + '-old'); fs.writeFileSync(f.source, 'replacement bytes');
    return copy(...args);
  };
  t.after(() => { nativeFs.copy = copy; });
  // Windows may prevent replacement while the source handle remains open;
  // POSIX permits it and must reject at the native identity/version check.
  await assert.rejects(f.run(), error => /identity changed|contents changed/.test(error.message) ||
    (process.platform === 'win32' && ['EBUSY', 'EPERM', 'EACCES'].includes(error.code)));
  assert.equal(f.saved(), false); assert.equal(f.probes(), 0);
  assert.equal(fs.existsSync(path.join(f.destination, 'paper.pdf')), false);
});
