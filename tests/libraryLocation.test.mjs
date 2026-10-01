import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('../electron/backend/nodeSqlite.cjs');
const { createAppPaths, createLibraryStore } = require('../electron/backend/libraryStore.cjs');
const { createLibraryCommands } = require('../electron/backend/libraryCommands.cjs');
const { runBackup, runRestore } = require('../electron/backend/webdavBackup.cjs');
const { createMineruCommands } = require('../electron/backend/mineruCommands.cjs');
const { REGISTRY_NAME, createLibraryLocationManager, inspectLibraryDirectory, readRegistry } = require('../electron/libraryLocation.cjs');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-location-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'Roaming');
  mkdirSync(appData);
  const normalProfile = path.join(appData, 'paperquay');
  const customProfile = path.join(root, 'custom-profile');
  function fakeApp(profile = normalProfile) {
    return {
      isPackaged: true,
      getPath(name) { return name === 'appData' ? appData : profile; },
      setPath(name, value) { assert.equal(name, 'userData'); profile = value; },
    };
  }
  function makeLibrary(directory, count = 1) {
    const store = createLibraryStore(createAppPaths(fakeApp(), directory));
    const library = store.load();
    library.papers = Array.from({ length: count }, (_, index) => ({
      id: 'fixture-' + index, title: 'Fixture ' + index, authors: [], tags: [], keywords: [], categoryIds: [], attachments: [],
      source: 'local', importedAt: 1, updatedAt: 1, readingProgress: 0, isFavorite: false, sortOrder: index,
    }));
    store.saveSync(library);
    store.close();
    return directory;
  }
  const decisions = { directory: '', confirm: 0, restarts: 0, messages: [], onConfirm: null };
  const dialog = {
    async showOpenDialog() { return { canceled: !decisions.directory, filePaths: decisions.directory ? [decisions.directory] : [] }; },
    async showMessageBox(options) { decisions.messages.push(options); decisions.onConfirm?.(); return { response: decisions.confirm }; },
  };
  const create = (profile, argv = []) => createLibraryLocationManager({ app: fakeApp(profile), dialog, argv, restart: () => { decisions.restarts++; } });
  return { root, appData, normalProfile, customProfile, fakeApp, makeLibrary, decisions, create };
}

test('ordinary upgrades reuse the same library without changing any records', (t) => {
  const f = fixture(t);
  const original = f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'), 3);
  const manager = f.create();
  assert.equal(manager.resolve().dataDirectory, original);
  manager.rememberActive();
  const before = readFileSync(path.join(original, 'paperquay-library.sqlite'));
  const nextLaunch = f.create();
  assert.equal(nextLaunch.resolve().dataDirectory, original);
  assert.equal(nextLaunch.status().paperCount, 3);
  assert.deepEqual(readFileSync(path.join(original, 'paperquay-library.sqlite')), before);
  nextLaunch.rememberActive();
  assert.equal(readdirSync(f.appData).filter((name) => name.endsWith('.backup')).length, 0, 'unchanged launches do not rewrite the registry');
});

test('a registered custom profile survives a normal installer launch without command-line arguments', (t) => {
  const f = fixture(t);
  const original = f.makeLibrary(path.join(f.customProfile, 'PaperQuay'), 2);
  writeFileSync(path.join(f.customProfile, 'theme-fixture.txt'), 'dark');
  const custom = f.create(f.customProfile, ['--user-data-dir=' + f.customProfile]);
  custom.resolve(); custom.rememberActive();
  const normalLaunch = f.create();
  const resolved = normalLaunch.resolve();
  assert.equal(resolved.profileDirectory, f.customProfile);
  assert.equal(resolved.dataDirectory, original);
  assert.equal(resolved.paperCount, 2);
  assert.equal(readFileSync(path.join(resolved.profileDirectory, 'theme-fixture.txt'), 'utf8'), 'dark');
});

test('an explicit alternate profile remains isolated and becomes default only on explicit update preparation', (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'), 1);
  const regular = f.create(); regular.resolve(); regular.rememberActive();
  f.makeLibrary(path.join(f.customProfile, 'PaperQuay'), 2);
  const alternate = f.create(f.customProfile, ['--user-data-dir', f.customProfile]);
  assert.equal(alternate.resolve().profileDirectory, f.customProfile);
  alternate.rememberActive();
  assert.equal(f.create().resolve().profileDirectory, f.normalProfile);
  alternate.rememberActive({ makeDefault: true });
  assert.equal(f.create().resolve().profileDirectory, f.customProfile);
});

test('missing registered libraries fail closed instead of creating or selecting a nested empty replacement', (t) => {
  const f = fixture(t);
  const directory = f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'), 1);
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  renameSync(path.join(directory, 'paperquay-library.sqlite'), path.join(directory, 'offline.sqlite'));
  f.makeLibrary(path.join(directory, 'PaperQuay'), 0);
  assert.throws(() => f.create().resolve(), /not found/);
  assert.equal(readdirSync(directory).includes('paperquay-library.sqlite'), false);
});

test('opening an existing populated library changes only the location pointer after native confirmation', async (t) => {
  const f = fixture(t);
  const oldDirectory = f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'), 2);
  const other = f.makeLibrary(path.join(f.root, 'another-library'), 4);
  const before = [oldDirectory, other].map((dir) => readFileSync(path.join(dir, 'paperquay-library.sqlite')));
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = other;
  const candidate = await manager.selectExisting();
  assert.equal(candidate.paperCount, 4);
  await assert.rejects(manager.activateSelected({ token: 'unapproved' }), /again/);
  assert.deepEqual(await manager.activateSelected({ token: candidate.token }), { canceled: true });
  assert.equal(f.create().resolve().dataDirectory, oldDirectory);
  f.decisions.confirm = 1;
  assert.deepEqual(await manager.activateSelected({ token: candidate.token }), { restarting: true });
  assert.equal(f.decisions.restarts, 1);
  assert.equal(f.create().resolve().dataDirectory, other);
  for (const [index, dir] of [oldDirectory, other].entries()) {
    assert.deepEqual(readFileSync(path.join(dir, 'paperquay-library.sqlite')), before[index]);
  }
  assert.equal(readdirSync(f.appData).filter((name) => name.endsWith('.backup')).length, 1);
});

test('a candidate disappearing before activation leaves the original selection intact', async (t) => {
  const f = fixture(t);
  const original = f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const other = f.makeLibrary(path.join(f.root, 'other'));
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = other;
  const candidate = await manager.selectExisting();
  renameSync(other, other + '-offline');
  f.decisions.confirm = 1;
  await assert.rejects(manager.activateSelected({ token: candidate.token }), /not found/);
  assert.equal(f.create().resolve().dataDirectory, original);
  assert.equal(f.decisions.restarts, 0);
});

test('invalid databases and ambiguous profile folders are not adopted', (t) => {
  const f = fixture(t);
  const wrong = path.join(f.root, 'wrong'); mkdirSync(wrong);
  const db = new DatabaseSync(path.join(wrong, 'paperquay-library.sqlite'));
  db.exec('CREATE TABLE unrelated (id INTEGER)'); db.close();
  assert.throws(() => inspectLibraryDirectory(wrong), /Not a supported/);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  assert.equal(inspectLibraryDirectory(f.normalProfile, { allowProfileDirectory: true }).paperCount, 1);
  f.makeLibrary(f.normalProfile);
  assert.throws(() => inspectLibraryDirectory(f.normalProfile, { allowProfileDirectory: true }), /Multiple/);
});

test('a damaged registry is not silently ignored or overwritten on normal startup', (t) => {
  const f = fixture(t);
  const file = path.join(f.appData, REGISTRY_NAME);
  writeFileSync(file, '{broken');
  assert.throws(() => f.create().resolve());
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  assert.throws(() => readRegistry(file));
});

test('profile registration cannot write a registry that the next launch rejects', (t) => {
  const f = fixture(t);
  const file = path.join(f.appData, REGISTRY_NAME);
  const registry = { version: 1, defaultProfileDirectory: f.normalProfile, libraries: Array.from({ length: 100 }, (_, i) => ({
    profileDirectory: path.join(f.root, 'profile-' + i), dataDirectory: path.join(f.root, 'data-' + i),
  })) };
  writeFileSync(file, JSON.stringify(registry));
  f.makeLibrary(path.join(f.customProfile, 'PaperQuay'));
  const manager = f.create(f.customProfile, ['--user-data-dir=' + f.customProfile]);
  manager.resolve();
  assert.throws(() => manager.rememberActive(), /limit reached/);
  assert.deepEqual(readRegistry(file), registry);
});

test('recovering an unavailable library retains the existing custom Chromium profile', async (t) => {
  const f = fixture(t);
  const original = f.makeLibrary(path.join(f.root, 'external-library'));
  mkdirSync(f.customProfile);
  writeFileSync(path.join(f.customProfile, 'theme-fixture.txt'), 'dark');
  writeFileSync(path.join(f.appData, REGISTRY_NAME), JSON.stringify({ version: 1, defaultProfileDirectory: f.customProfile,
    libraries: [{ profileDirectory: f.customProfile, dataDirectory: original }] }));
  renameSync(original, original + '-offline');
  const other = f.makeLibrary(path.join(f.root, 'replacement-library'), 3);
  const app = f.fakeApp();
  const manager = createLibraryLocationManager({ app, argv: [], restart() {}, dialog: {
    async showMessageBox() { return { response: 1 }; },
    async showOpenDialog() { return { canceled: false, filePaths: [other] }; },
  } });
  let failure;
  try { manager.resolve(); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.equal(app.getPath('userData'), f.customProfile, 'restore Chromium profile before validation can fail');
  assert.equal(await manager.recover(failure), true);
  const restored = f.create().resolve();
  assert.equal(restored.profileDirectory, f.customProfile);
  assert.equal(restored.dataDirectory, other);
  assert.equal(readFileSync(path.join(f.customProfile, 'theme-fixture.txt'), 'utf8'), 'dark');
});

test('a missing custom profile can recover explicitly into the normal launch profile', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.customProfile, 'PaperQuay'));
  const custom = f.create(f.customProfile, ['--user-data-dir=' + f.customProfile]);
  custom.resolve(); custom.rememberActive();
  renameSync(f.customProfile, f.customProfile + '-offline');
  const other = f.makeLibrary(path.join(f.root, 'replacement-library'));
  f.decisions.directory = other; f.decisions.confirm = 1;
  const normal = f.create();
  assert.throws(() => normal.resolve(), /Profile is unavailable/);
  assert.equal(await normal.recover(new Error('missing profile')), true);
  assert.equal(f.create().resolve().profileDirectory, f.normalProfile);
  assert.equal(f.create().resolve().dataDirectory, other);
  assert.equal(readdirSync(f.root).includes(path.basename(f.customProfile)), false);
});

test('ordinary startup avoids full integrity scans while explicit selection still verifies integrity', async (t) => {
  const f = fixture(t);
  const directory = f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const initial = f.create(); initial.resolve(); initial.rememberActive();
  const prepare = DatabaseSync.prototype.prepare;
  let fullScans = 0;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (/PRAGMA quick_check/i.test(sql)) fullScans++;
    return prepare.call(this, sql, ...args);
  };
  try {
    const reopened = f.create(); reopened.resolve(); reopened.rememberActive();
    assert.equal(fullScans, 0);
    f.decisions.directory = directory;
    await reopened.selectExisting();
    assert.equal(fullScans, 1);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
});

test('external-library import destinations and destructive modes require explicit approval', async (t) => {
  const f = fixture(t);
  const original = f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied-library'));
  const destination = path.join(f.root, 'shared-destination');
  const db = new DatabaseSync(path.join(supplied, 'paperquay-library.sqlite'));
  db.prepare('UPDATE library_settings SET value_json = ? WHERE key = ?').run(JSON.stringify(destination), 'storageDir');
  db.prepare('UPDATE library_settings SET value_json = ? WHERE key = ?').run(JSON.stringify('move'), 'importMode');
  db.close();
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied;
  const candidate = await manager.selectExisting();
  assert.equal(candidate.importMode, 'move');
  assert.equal(candidate.storageDirectory, destination);
  assert.deepEqual(await manager.activateSelected({ token: candidate.token }), { canceled: true });
  assert.ok(f.decisions.messages.at(-1).detail.includes(JSON.stringify(destination)));
  assert.match(f.decisions.messages.at(-1).detail, /REMOVE the original file/);
  assert.equal(f.create().resolve().dataDirectory, original);
  assert.equal(f.decisions.restarts, 0);
  f.decisions.confirm = 1;
  f.decisions.onConfirm = () => {
    const changed = new DatabaseSync(path.join(supplied, 'paperquay-library.sqlite'));
    changed.prepare('UPDATE library_settings SET value_json = ? WHERE key = ?').run(JSON.stringify(destination + '-changed'), 'storageDir');
    changed.close();
  };
  await assert.rejects(manager.activateSelected({ token: candidate.token }), /settings changed/);
  assert.equal(f.create().resolve().dataDirectory, original);
  assert.equal(f.decisions.restarts, 0);
});

test('recovery can decline imported write settings without changing the location record', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  const before = readFileSync(path.join(f.appData, REGISTRY_NAME), 'utf8');
  f.decisions.directory = f.makeLibrary(path.join(f.root, 'supplied-library'));
  f.decisions.confirm = 1;
  f.decisions.onConfirm = () => { if (f.decisions.messages.length === 2) f.decisions.confirm = 0; };
  assert.equal(await manager.recover(new Error('unavailable')), false);
  assert.match(f.decisions.messages.at(-1).detail, /FUTURE PDF imports/);
  assert.equal(readFileSync(path.join(f.appData, REGISTRY_NAME), 'utf8'), before);
});

function replaceAttachments(directory, targets) {
  const db = new DatabaseSync(path.join(directory, 'paperquay-library.sqlite'));
  try {
    db.exec('DELETE FROM attachments');
    const insert = db.prepare("INSERT INTO attachments (id,paper_id,kind,stored_path,file_name,mime_type,file_size,created_at,missing) VALUES (?,'fixture-0','pdf',?,?,'application/pdf',1,1,0)");
    for (const [index, target] of targets.entries()) insert.run('attachment-' + index, target, path.basename(target));
  } finally { db.close(); }
}

test('attachment roots are explicitly disclosed and confirmation-time path changes abort adoption', async (t) => {
  const f = fixture(t);
  const original = f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const victim = path.join(f.root, 'private', 'unrelated.pdf');
  mkdirSync(path.dirname(victim)); writeFileSync(victim, 'private fixture bytes');
  replaceAttachments(supplied, [victim]);
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied;
  const candidate = await manager.selectExisting();
  assert.deepEqual(candidate.attachmentRoots, [path.dirname(victim)]);
  f.decisions.confirm = 1;
  f.decisions.onConfirm = () => { if (f.decisions.messages.at(-1).type === 'warning') f.decisions.confirm = 0; };
  await manager.activateSelected({ token: candidate.token });
  assert.ok(f.decisions.messages.at(-1).detail.includes(JSON.stringify(path.dirname(victim))));
  assert.match(f.decisions.messages.at(-1).detail, /REMOVE original attachments/);
  assert.equal(f.create().resolve().dataDirectory, original);
  f.decisions.confirm = 1;
  f.decisions.onConfirm = () => replaceAttachments(supplied, [path.join(f.root, 'different-root', 'other.pdf')]);
  await assert.rejects(manager.activateSelected({ token: candidate.token }), /settings changed/);
  assert.equal(f.create().resolve().dataDirectory, original);
  assert.equal(readFileSync(victim, 'utf8'), 'private fixture bytes');
});

test('user-approved storage changes persist policy; cancel and save failure preserve the prior approval', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied; f.decisions.confirm = 1;
  await manager.activateSelected({ token: (await manager.selectExisting()).token });
  const active = f.create(); active.resolve();
  const paths = createAppPaths(f.fakeApp(), supplied);
  const store = createLibraryStore(paths);
  try {
    const commands = createLibraryCommands({ appPaths: paths, store,
      validateLibraryFileOperation: (library, attachments) => active.validateFileOperation(library, attachments),
      approveLibrarySettingsChange: (before, after) => active.approveSettingsChange(before, after) });
    const original = store.load().settings.storageDir;
    const destination = path.join(f.root, 'new-storage');
    f.decisions.confirm = 0;
    await assert.rejects(commands.library_update_settings({ settings: { storageDir: destination } }), /canceled/);
    assert.equal(store.load().settings.storageDir, original);
    assert.equal(readdirSync(f.root).includes('new-storage'), false);
    f.decisions.confirm = 1;
    await commands.library_update_settings({ settings: { storageDir: destination, importMode: 'keep' } });
    assert.equal(f.create().resolve().storageDirectory, destination);
    assert.equal(f.create().resolve().importMode, 'keep');
    active.validateFileOperation(store.load());
    await commands.library_update_settings({ settings: { openAlexEnabled: false } });
    const saveSync = store.saveSync;
    store.saveSync = () => { throw new Error('fixture save failure'); };
    await assert.rejects(commands.library_update_settings({ settings: { importMode: 'copy' } }), /fixture save failure/);
    store.saveSync = saveSync;
    assert.equal(f.create().resolve().importMode, 'keep');
    active.validateFileOperation(store.load());
  } finally { store.close(); }
});

test('adoption rejects corrupt and linked companion databases and retains local model config', async (t) => {
  const f = fixture(t);
  const original = f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied;
  const notes = path.join(supplied, 'paperquay-notes.sqlite');
  writeFileSync(notes, 'not a database');
  await assert.rejects(manager.selectExisting(), /database/);
  assert.equal(f.create().resolve().dataDirectory, original);
  rmSync(notes);
  const outside = path.join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, path.join(supplied, '.screenshots'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.selectExisting(), /Linked library companion/);
  const paths = createAppPaths(f.fakeApp(), supplied);
  assert.equal(paths.configPath, path.join(original, '.settings', 'paperquay.config.json'));
  assert.notEqual(paths.configPath, path.join(supplied, '.settings', 'paperquay.config.json'));
});

test('approved file access is bound across launches and guards actual import/delete operations', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied; f.decisions.confirm = 1;
  const candidate = await manager.selectExisting();
  await manager.activateSelected({ token: candidate.token });
  const reopened = f.create(); reopened.resolve(); reopened.rememberActive();
  assert.equal(readRegistry(path.join(f.appData, REGISTRY_NAME)).libraries[0].approvedFileAccess.importMode, 'copy');
  const paths = createAppPaths(f.fakeApp(), supplied);
  const store = createLibraryStore(paths);
  try {
  const commands = createLibraryCommands({ appPaths: paths, store,
    validateLibraryFileOperation: (library, attachments) => reopened.validateFileOperation(library, attachments) });
  const victim = path.join(f.root, 'private', 'private.pdf');
  mkdirSync(path.dirname(victim)); writeFileSync(victim, '%PDF-1.4\nprivate fixture\n%%EOF');
  const attackerDestination = path.join(f.root, 'attacker-readable');
  const db = new DatabaseSync(paths.libraryDatabasePath);
  try {
    db.prepare('UPDATE library_settings SET value_json = ? WHERE key = ?').run(JSON.stringify(attackerDestination), 'storageDir');
    db.prepare('UPDATE library_settings SET value_json = ? WHERE key = ?').run(JSON.stringify('move'), 'importMode');
    assert.throws(() => f.create().resolve(), /file access settings changed/);
    assert.throws(() => reopened.rememberActive({ makeDefault: true }), /file access settings changed/);
    await assert.rejects(commands.library_import_pdfs({ request: { paths: [victim] } }), /file access settings changed/);
    await assert.rejects(commands.library_update_settings({ settings: { openAlexEnabled: false } }), /file access settings changed/);
    let downloaded = 0;
    await assert.rejects(runRestore({ appPaths: paths, store,
      validateLibraryFileOperation: (library, attachments) => reopened.validateFileOperation(library, attachments) },
      { getText: async () => { downloaded++; return null; }, getBytes: async () => { downloaded++; return Buffer.from('fixture'); } }), /file access settings changed/);
    assert.equal(downloaded, 0, 'restore must stop before any remote objects are retrieved');
    assert.equal(readdirSync(f.root).includes('attacker-readable'), false);
    db.prepare('UPDATE library_settings SET value_json = ? WHERE key = ?').run(JSON.stringify(candidate.storageDirectory), 'storageDir');
    db.prepare('UPDATE library_settings SET value_json = ? WHERE key = ?').run(JSON.stringify('copy'), 'importMode');
  } finally { db.close(); }
  replaceAttachments(supplied, [victim]);
  const nextLaunch = f.create(); nextLaunch.resolve();
  let uploads = 0;
  await assert.rejects(runBackup({ appPaths: paths, store,
    validateLibraryFileOperation: (library, attachments) => reopened.validateFileOperation(library, attachments) },
    { getText: async () => null, atomicUploadFile: async () => uploads++, atomicUploadBytes: async () => uploads++ }), /file access settings changed/);
  assert.equal(uploads, 0, 'unapproved attachments must never reach backup upload');
  assert.throws(() => nextLaunch.validateFileOperation(store.load(), store.load().papers[0].attachments), /file access settings changed/);
  await assert.rejects(commands.library_delete_paper({ request: { paperId: 'fixture-0', deleteFiles: true } }), /file access settings changed/);
  assert.equal(store.load().papers.length, 1);
  assert.equal(readFileSync(victim, 'utf8'), '%PDF-1.4\nprivate fixture\n%%EOF');
  replaceAttachments(supplied, []);
  const [imported] = await commands.library_import_pdfs({ request: { paths: [victim] } });
  assert.equal(imported.status, 'imported');
  const storedPath = imported.paper.attachments[0].storedPath;
  assert.ok(storedPath.startsWith(candidate.storageDirectory + path.sep));
  assert.equal(readFileSync(storedPath, 'utf8'), readFileSync(victim, 'utf8'));
  await commands.library_delete_paper({ request: { paperId: imported.paper.id, deleteFiles: true } });
  assert.equal(readdirSync(candidate.storageDirectory).includes(path.basename(storedPath)), false);
  assert.equal(readFileSync(victim, 'utf8'), '%PDF-1.4\nprivate fixture\n%%EOF');
  } finally { store.close(); }
});

test('keep-path import commits approved selected roots and canceled imports leave no records', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied; f.decisions.confirm = 1;
  await manager.activateSelected({ token: (await manager.selectExisting()).token });
  const active = f.create(); active.resolve();
  const paths = createAppPaths(f.fakeApp(), supplied);
  const store = createLibraryStore(paths);
  try {
    const commands = createLibraryCommands({ appPaths: paths, store,
      validateLibraryFileOperation: (library, attachments) => active.validateFileOperation(library, attachments),
      approveImportedAttachments: (previous, attachments) => active.approveImportedAttachments(previous, attachments) });
    const source = path.join(f.root, 'selected-pdfs', 'keep.pdf');
    mkdirSync(path.dirname(source)); writeFileSync(source, '%PDF-1.4\nkeep fixture\n%%EOF');
    const before = store.load().papers.length;
    f.decisions.confirm = 0;
    await assert.rejects(commands.library_import_pdfs({ request: { paths: [source], importMode: 'keep' } }), /Keep-path import canceled/);
    assert.equal(store.load().papers.length, before);
    f.decisions.confirm = 1;
    const saveSync = store.saveSync;
    store.saveSync = () => { throw new Error('keep import save failure'); };
    await assert.rejects(commands.library_import_pdfs({ request: { paths: [source], importMode: 'keep' } }), /keep import save failure/);
    store.saveSync = saveSync;
    assert.equal(store.load().papers.length, before);
    assert.equal(readRegistry(path.join(f.appData, REGISTRY_NAME)).libraries[0].approvedFileAccess.attachmentRoots.includes(path.dirname(source)), false);
    const [result] = await commands.library_import_pdfs({ request: { paths: [source], importMode: 'keep' } });
    assert.equal(result.status, 'imported');
    const reopened = f.create(); reopened.resolve();
    reopened.validateFileOperation(store.load(), store.load().papers.flatMap((paper) => paper.attachments));
    await commands.library_update_settings({ settings: { openAlexEnabled: false } });
    assert.ok(readRegistry(path.join(f.appData, REGISTRY_NAME)).libraries[0].approvedFileAccess.attachmentRoots.includes(path.dirname(source)));
    await commands.library_delete_paper({ request: { paperId: result.paper.id, deleteFiles: true } });
    assert.equal(readdirSync(path.dirname(source)).includes('keep.pdf'), false);
    const outside = path.join(f.root, 'outside'); mkdirSync(outside);
    mkdirSync(path.join(supplied, '.mineru-cache'), { recursive: true });
    symlinkSync(outside, path.join(supplied, '.mineru-cache', 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => reopened.validateRestoreTarget('summary', path.join(supplied, '.mineru-cache', 'redirect', 'victim.json')), /escapes approved root/);
  } finally { store.close(); }
});

test('escaping effective attachment paths cannot be adopted or uploaded for cloud parsing', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied; f.decisions.confirm = 1;
  await manager.activateSelected({ token: (await manager.selectExisting()).token });
  const active = f.create(); active.resolve();
  const paths = createAppPaths(f.fakeApp(), supplied);
  const store = createLibraryStore(paths);
  const outside = path.join(f.root, 'private.pdf'); writeFileSync(outside, '%PDF-1.4\nprivate fixture\n%%EOF');
  const safe = path.join(store.load().settings.storageDir, 'safe.pdf');
  mkdirSync(path.dirname(safe), { recursive: true }); writeFileSync(safe, '%PDF-1.4\nsafe fixture\n%%EOF');
  replaceAttachments(supplied, [safe]);
  const db = new DatabaseSync(paths.libraryDatabasePath);
  db.prepare('UPDATE attachments SET relative_path=?').run('../../private.pdf'); db.close();
  let requests = 0;
  const fetch = globalThis.fetch; globalThis.fetch = async () => { requests++; throw new Error('unexpected network'); };
  try {
    assert.throws(() => inspectLibraryDirectory(supplied), /Unsafe attachment relative path/);
    const commands = createMineruCommands({ appPaths: paths, store,
      authorizeCloudParsePath: (library, pdfPath) => active.authorizeCloudParsePath(library, pdfPath) });
    await assert.rejects(commands.run_mineru_cloud_parse({ options: { pdfPath: outside, apiToken: 'fixture-token' } }), /Unsafe attachment relative path/);
    assert.equal(requests, 0);
    replaceAttachments(supplied, [safe]);
    await active.authorizeCloudParsePath(store.load(), safe);
    f.decisions.confirm = 0;
    await assert.rejects(active.authorizeCloudParsePath(store.load(), outside), /file access settings changed/);
    assert.equal(requests, 0);
    f.decisions.confirm = 1;
    await active.authorizeCloudParsePath(store.load(), outside);
    assert.ok(f.decisions.messages.at(-1).detail.includes(JSON.stringify(outside)));
    const prompts = f.decisions.messages.length;
    await active.authorizeCloudParsePath(store.load(), outside);
    assert.equal(f.decisions.messages.length, prompts, 'the approved exact file can be revalidated at the upload sink');
    globalThis.fetch = async () => {
      requests++;
      assert.equal(requests, 1, 'the PUT must not run after the library changes');
      const changed = new DatabaseSync(paths.libraryDatabasePath);
      changed.prepare('UPDATE attachments SET relative_path=?').run('../../private.pdf'); changed.close();
      return new Response(JSON.stringify({ code: 0, data: { batch_id: 'fixture', file_urls: ['https://upload.invalid/fixture'] } }), { headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(commands.run_mineru_cloud_parse({ options: { pdfPath: safe, apiToken: 'fixture-token' } }), /Unsafe attachment relative path/);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = fetch; store.close(); }
});
