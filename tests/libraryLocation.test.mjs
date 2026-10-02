import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, symlinkSync, existsSync, utimesSync, realpathSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('../electron/backend/nodeSqlite.cjs');
const { createAppPaths, createLibraryStore } = require('../electron/backend/libraryStore.cjs');
const { createLibraryCommands } = require('../electron/backend/libraryCommands.cjs');
const { runBackup, runRestore } = require('../electron/backend/webdavBackup.cjs');
const { createMineruCommands } = require('../electron/backend/mineruCommands.cjs');
const { createAiCommands } = require('../electron/backend/aiCommands.cjs');
const { createRagStore } = require('../electron/backend/ragStore.cjs');
const { createNoteStore } = require('../electron/backend/noteStore.cjs');
const { REGISTRY_NAME, createLibraryLocationManager, inspectLibraryDirectory, readRegistry } = require('../electron/libraryLocation.cjs');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-location-'));
  const resources = [];
  t.after(() => { for (const close of resources) close(); rmSync(root, { recursive: true, force: true }); });
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
  return { root, appData, normalProfile, customProfile, fakeApp, makeLibrary, decisions, create, closeAfter: (close) => resources.push(close) };
}

test('an unregistered fresh profile is created before Electron setPath', (t) => {
  const f = fixture(t);
  assert.equal(existsSync(f.normalProfile), false);
  const app = f.fakeApp();
  const setPath = app.setPath;
  app.setPath = (name, value) => { assert.equal(existsSync(value), true); setPath(name, value); };
  const manager = createLibraryLocationManager({ app, dialog: {}, argv: [], restart() {} });
  assert.equal(manager.resolve().registered, false);
  assert.equal(existsSync(f.normalProfile), true);
  assert.equal(existsSync(path.join(f.normalProfile, 'PaperQuay', 'paperquay-library.sqlite')), false);
});

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
  custom.resolve(); custom.rememberActive({ makeDefault: true });
  const normalLaunch = f.create();
  const resolved = normalLaunch.resolve();
  assert.equal(resolved.profileDirectory, f.customProfile);
  assert.equal(resolved.dataDirectory, original);
  assert.equal(resolved.paperCount, 2);
  assert.equal(readFileSync(path.join(resolved.profileDirectory, 'theme-fixture.txt'), 'utf8'), 'dark');
});

test('an isolated first launch cannot take the default profile slot', (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.customProfile, 'PaperQuay'), 2);
  const isolated = f.create(f.customProfile, ['--user-data-dir=' + f.customProfile]);
  isolated.resolve(); isolated.rememberActive();
  assert.equal(readRegistry(path.join(f.appData, REGISTRY_NAME)).defaultProfileDirectory, '');
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'), 3);
  const normal = f.create();
  assert.equal(normal.resolve().profileDirectory, f.normalProfile);
  normal.rememberActive();
  assert.equal(readRegistry(path.join(f.appData, REGISTRY_NAME)).defaultProfileDirectory, f.normalProfile);
});

test('a corrupt generated registry lock is preserved and regenerated without losing mappings', (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  const file = path.join(f.appData, REGISTRY_NAME);
  const before = readFileSync(file, 'utf8');
  writeFileSync(file + '.lock.sqlite', 'broken lock fixture');
  manager.rememberActive();
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.ok(readdirSync(f.appData).filter((name) => name.endsWith('.corrupt')).some((name) => readFileSync(path.join(f.appData, name), 'utf8') === 'broken lock fixture'));
  assert.equal(existsSync(file + '.lock.sqlite.repair'), false);
  const next = f.create(); next.resolve(); next.rememberActive();
});

test('a profile junction reuses its registered external library and original profile spelling', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.customProfile, 'PaperQuay'));
  const external = f.makeLibrary(path.join(f.root, 'external'), 3);
  const manager = f.create(f.customProfile, ['--user-data-dir=' + f.customProfile]);
  manager.resolve(); manager.rememberActive();
  f.decisions.directory = external; f.decisions.confirm = 1;
  const selected = await manager.selectExisting();
  await manager.activateSelected(selected);
  const alias = path.join(f.root, 'profile-alias');
  symlinkSync(f.customProfile, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const viaAlias = f.create(alias, ['--user-data-dir=' + alias]);
  const resolved = viaAlias.resolve();
  assert.equal(resolved.profileDirectory, f.customProfile);
  assert.equal(resolved.dataDirectory, external);
  assert.equal(resolved.paperCount, 3);
  viaAlias.rememberActive();
  assert.equal(readRegistry(path.join(f.appData, REGISTRY_NAME)).libraries.length, 1);
});

test('explicit corrupt-registry recovery restores the newest valid backup and unrelated profiles', async (t) => {
  const f = fixture(t);
  const original = f.makeLibrary(path.join(f.customProfile, 'PaperQuay'));
  const unrelated = f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'), 2);
  const replacement = f.makeLibrary(path.join(f.root, 'replacement'), 3);
  const file = path.join(f.appData, REGISTRY_NAME);
  const registry = { version: 1, defaultProfileDirectory: f.customProfile, libraries: [
    { profileDirectory: f.customProfile, dataDirectory: original },
    { profileDirectory: f.normalProfile, dataDirectory: unrelated },
  ] };
  writeFileSync(file + '.old.backup', JSON.stringify({ ...registry, libraries: [registry.libraries[0]] }));
  writeFileSync(file + '.valid.backup', JSON.stringify(registry));
  writeFileSync(file + '.bad.backup', '{broken backup');
  for (const [index, suffix] of ['old', 'valid', 'bad'].entries()) utimesSync(file + '.' + suffix + '.backup', index + 1, index + 1);
  writeFileSync(file, '{broken current');
  const app = f.fakeApp();
  const manager = createLibraryLocationManager({ app, dialog: {
    async showOpenDialog() { return { canceled: false, filePaths: [replacement] }; },
    async showMessageBox() { return { response: 1 }; },
  }, argv: [], restart() {} });
  assert.throws(() => manager.resolve());
  assert.equal(app.getPath('userData'), f.customProfile);
  assert.equal(await manager.recover(new Error('corrupt registry')), true);
  const restored = readRegistry(file);
  assert.equal(restored.defaultProfileDirectory, f.customProfile);
  assert.equal(restored.libraries.length, 2);
  assert.deepEqual(restored.libraries.find((entry) => entry.profileDirectory === f.normalProfile), registry.libraries[1]);
  assert.equal(f.create().resolve().dataDirectory, replacement);
  assert.ok(readdirSync(f.appData).filter((name) => name.endsWith('.backup')).some((name) => readFileSync(path.join(f.appData, name), 'utf8') === '{broken current'));
});

test('a missing registry with surviving backups cannot silently start a fallback library', async (t) => {
  const f = fixture(t);
  const original = f.makeLibrary(path.join(f.customProfile, 'PaperQuay'), 2);
  const file = path.join(f.appData, REGISTRY_NAME);
  writeFileSync(file + '.fixture.backup', JSON.stringify({ version: 1, defaultProfileDirectory: f.customProfile,
    libraries: [{ profileDirectory: f.customProfile, dataDirectory: original }] }));
  const manager = f.create();
  assert.throws(() => manager.resolve(), /record is missing/);
  assert.equal(existsSync(path.join(f.normalProfile, 'PaperQuay', 'paperquay-library.sqlite')), false);
  f.decisions.directory = original; f.decisions.confirm = 1;
  assert.equal(await manager.recover(new Error('missing registry')), true);
  assert.equal(f.create().resolve().dataDirectory, original);
  assert.equal(readRegistry(file).defaultProfileDirectory, f.customProfile);
});

test('registry writers in separate processes wait for the shared lock and preserve every profile', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const original = f.create(); original.resolve(); original.rememberActive();
  const profiles = [f.customProfile, path.join(f.root, 'third-profile')];
  for (const profile of profiles) f.makeLibrary(path.join(profile, 'PaperQuay'));
  const file = path.join(f.appData, REGISTRY_NAME);
  const lock = new DatabaseSync(file + '.lock.sqlite');
  lock.exec('BEGIN IMMEDIATE');
  let released = false;
  t.after(() => { if (!released) { lock.exec('ROLLBACK'); lock.close(); } });
  const code = `
    const { createLibraryLocationManager } = require(process.argv[1]);
    const appData = process.argv[2]; let profile = process.argv[3];
    const manager = createLibraryLocationManager({
      app: { isPackaged: true, getPath: name => name === 'appData' ? appData : profile, setPath: (_, value) => { profile = value; } },
      dialog: {}, argv: ['--user-data-dir=' + profile], restart() {}
    });
    manager.resolve();
    process.once('message', () => { process.send('attempt'); manager.rememberActive(); process.send('done'); process.disconnect(); });
    process.send('ready');
  `;
  let completed = 0;
  const children = profiles.map((profile) => {
    const child = spawn(process.execPath, ['-e', code, require.resolve('../electron/libraryLocation.cjs'), f.appData, profile], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    const ready = once(child, 'message');
    const attempted = new Promise((resolve) => child.on('message', (message) => { if (message === 'attempt') resolve(); if (message === 'done') completed++; }));
    const exited = once(child, 'exit').then(([exitCode]) => assert.equal(exitCode, 0, stderr));
    return { child, ready, attempted, exited };
  });
  await Promise.all(children.map(({ ready }) => ready));
  for (const { child } of children) child.send('go');
  await Promise.all(children.map(({ attempted }) => attempted));
  await delay(150);
  assert.equal(completed, 0, 'no process may mutate the registry while another process owns its lock');
  assert.equal(readRegistry(file).libraries.length, 1);
  lock.exec('ROLLBACK'); lock.close(); released = true;
  await Promise.all(children.map(({ exited }) => exited));
  const registry = readRegistry(file);
  assert.equal(completed, 2);
  assert.equal(registry.defaultProfileDirectory, f.normalProfile);
  assert.deepEqual(registry.libraries.map((entry) => entry.profileDirectory).sort(), [f.normalProfile, ...profiles].sort());
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
  custom.resolve(); custom.rememberActive({ makeDefault: true });
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
  assert.deepEqual(candidate.attachmentRoots, [path.dirname(realpathSync.native(victim))]);
  f.decisions.confirm = 1;
  f.decisions.onConfirm = () => { if (f.decisions.messages.at(-1).type === 'warning') f.decisions.confirm = 0; };
  await manager.activateSelected({ token: candidate.token });
  assert.ok(f.decisions.messages.at(-1).detail.includes(JSON.stringify(path.dirname(realpathSync.native(victim)))));
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
  assert.ok(storedPath.startsWith(candidate.storageRoot + path.sep));
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
    assert.equal(readRegistry(path.join(f.appData, REGISTRY_NAME)).libraries[0].approvedFileAccess.attachmentRoots.includes(path.dirname(realpathSync.native(source))), false);
    const [result] = await commands.library_import_pdfs({ request: { paths: [source], importMode: 'keep' } });
    assert.equal(result.status, 'imported');
    const reopened = f.create(); reopened.resolve();
    reopened.validateFileOperation(store.load(), store.load().papers.flatMap((paper) => paper.attachments));
    await commands.library_update_settings({ settings: { openAlexEnabled: false } });
    assert.ok(readRegistry(path.join(f.appData, REGISTRY_NAME)).libraries[0].approvedFileAccess.attachmentRoots.includes(path.dirname(realpathSync.native(source))));
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
    assert.ok(f.decisions.messages.at(-1).detail.includes(JSON.stringify(realpathSync.native(outside))));
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

test('relocating a PDF rebinds its approved root and clears the obsolete relative path', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const oldPath = path.join(supplied, 'paperquay-data', 'missing.pdf');
  replaceAttachments(supplied, [oldPath]);
  const db = new DatabaseSync(path.join(supplied, 'paperquay-library.sqlite'));
  db.prepare('UPDATE attachments SET relative_path=?,missing=1').run('missing.pdf'); db.close();
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
    const newPath = path.join(f.root, 'relocated', 'found.pdf'); mkdirSync(path.dirname(newPath)); writeFileSync(newPath, '%PDF-1.4\nrelocated fixture\n%%EOF');
    f.decisions.confirm = 0;
    await assert.rejects(commands.library_relocate_attachment({ request: { attachmentId: 'attachment-0', newPath } }), /canceled/);
    assert.equal(store.load().papers[0].attachments[0].storedPath, oldPath);
    f.decisions.confirm = 1;
    const relocated = await commands.library_relocate_attachment({ request: { attachmentId: 'attachment-0', newPath } });
    assert.equal(relocated.storedPath, newPath);
    assert.equal(relocated.relativePath, null);
    const reopened = f.create(); reopened.resolve();
    reopened.validateFileOperation(store.load(), store.load().papers[0].attachments);
    await commands.library_update_settings({ settings: { openAlexEnabled: false } });
    await commands.library_delete_paper({ request: { paperId: 'fixture-0', deleteFiles: true } });
    assert.equal(readdirSync(path.dirname(newPath)).includes('found.pdf'), false);
  } finally { store.close(); }
});

test('storage migrations bind copies and metadata to the approved destination', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const paths = createAppPaths(f.fakeApp(), supplied);
  const store = createLibraryStore(paths);
  f.closeAfter(() => store.close());
  const source = path.join(store.load().settings.storageDir, 'category', 'fixture.pdf');
  mkdirSync(path.dirname(source), { recursive: true }); writeFileSync(source, 'approved migration fixture');
  replaceAttachments(supplied, [source]);
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied; f.decisions.confirm = 1;
  await manager.activateSelected({ token: (await manager.selectExisting()).token });
  const active = f.create(); active.resolve();
  const safe = path.join(f.root, 'approved-new-storage'); mkdirSync(safe);
  const outside = path.join(f.root, 'unapproved-storage'); mkdirSync(outside);
  const alias = path.join(f.root, 'selected-storage');
  symlinkSync(safe, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let replaced = false;
  const commands = createLibraryCommands({ appPaths: paths, store,
    validateLibraryFileOperation: (library, attachments) => active.validateFileOperation(library, attachments),
    async approveLibrarySettingsChange(previous, next) {
      const approval = await active.approveSettingsChange(previous, next);
      const validate = approval.validateDestination;
      approval.validateDestination = (target) => {
        const actual = validate(target);
        if (!replaced) {
          unlinkSync(alias); symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir'); replaced = true;
        }
        return actual;
      };
      return approval;
    },
  });
  await commands.library_update_settings({ settings: { storageDir: alias } });
  const attachment = store.load().papers[0].attachments[0];
  assert.equal(attachment.storedPath, path.join(realpathSync.native(safe), 'category', 'fixture.pdf'));
  assert.equal(readFileSync(attachment.storedPath, 'utf8'), 'approved migration fixture');
  assert.equal(readFileSync(source, 'utf8'), 'approved migration fixture');
  assert.deepEqual(readdirSync(outside), []);
  assert.throws(() => f.create().resolve(), /file access settings changed/, 'a retargeted setting is not implicitly reapproved on relaunch');
});

test('attachment deletion consumes validated canonical paths after an alias is retargeted', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const safe = path.join(supplied, 'paperquay-data'); mkdirSync(safe, { recursive: true });
  const outside = path.join(f.root, 'unrelated'); mkdirSync(outside);
  writeFileSync(path.join(safe, 'same.pdf'), 'approved original');
  writeFileSync(path.join(outside, 'same.pdf'), 'unrelated original');
  const alias = path.join(supplied, 'pdf-alias'); symlinkSync(safe, alias, process.platform === 'win32' ? 'junction' : 'dir');
  replaceAttachments(supplied, [path.join(alias, 'same.pdf')]);
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied; f.decisions.confirm = 1;
  await manager.activateSelected({ token: (await manager.selectExisting()).token });
  const active = f.create(); active.resolve();
  const paths = createAppPaths(f.fakeApp(), supplied), store = createLibraryStore(paths);
  f.closeAfter(() => store.close());
  const commands = createLibraryCommands({ appPaths: paths, store,
    validateLibraryFileOperation(library, attachments) {
      const approved = active.validateFileOperation(library, attachments);
      unlinkSync(alias); symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
      return approved;
    },
  });
  await commands.library_delete_paper({ request: { paperId: 'fixture-0', deleteFiles: true } });
  assert.equal(existsSync(path.join(safe, 'same.pdf')), false);
  assert.equal(readFileSync(path.join(outside, 'same.pdf'), 'utf8'), 'unrelated original');
  assert.equal(store.load().papers.length, 0);
});

for (const kind of ['pdf', 'mineru', 'translation', 'summary']) {
  test(`WebDAV ${kind} restore retains the validated destination when download retargets its alias`, async (t) => {
    const f = fixture(t);
    f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
    const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
    const paths = createAppPaths(f.fakeApp(), supplied), store = createLibraryStore(paths);
    f.closeAfter(() => store.close());
    const parent = kind === 'pdf' ? path.join(supplied, 'paperquay-data') : paths.mineruCacheDir;
    mkdirSync(parent, { recursive: true });
    const safe = path.join(parent, 'safe'); mkdirSync(safe);
    const outside = path.join(f.root, 'unrelated'); mkdirSync(outside);
    const alias = path.join(parent, 'document-alias'); symlinkSync(safe, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const name = kind === 'pdf' ? 'fixture.pdf' : 'fixture.json';
    writeFileSync(path.join(outside, name), 'unrelated fixture');
    if (kind === 'pdf') replaceAttachments(supplied, [path.join(alias, name)]);
    const manager = f.create(); manager.resolve(); manager.rememberActive();
    f.decisions.directory = supplied; f.decisions.confirm = 1;
    await manager.activateSelected({ token: (await manager.selectExisting()).token });
    const active = f.create(); active.resolve();
    const object = { kind, remotePath: kind === 'pdf' ? `latest/pdfs/${name}` : `latest/derived/document-alias/${name}`,
      source: `paper:fixture-0:attachment:attachment-0:${path.join(alias, name)}`, status: 'uploaded', byteSize: 100 };
    const result = await runRestore({ appPaths: paths, store,
      validateLibraryFileOperation: (library, attachments) => active.validateFileOperation(library, attachments),
      validateLibraryRestoreTarget: (type, target) => active.validateRestoreTarget(type, target),
    }, {
      getText: async () => JSON.stringify({ version: 3, backupId: 'fixture', objects: [object] }),
      getBytes: async () => {
        unlinkSync(alias); symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
        return Buffer.from('restored approved fixture');
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result.objects));
    assert.equal(readFileSync(path.join(safe, name), 'utf8'), 'restored approved fixture');
    assert.equal(readFileSync(path.join(outside, name), 'utf8'), 'unrelated fixture');
    if (kind === 'pdf') assert.equal(store.load().papers[0].attachments[0].storedPath, path.join(realpathSync.native(safe), name));
  });
}

test('PDF imports use the approved destination after a storage junction is retargeted', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const safeRoot = path.join(f.root, 'approved-storage'); mkdirSync(safeRoot);
  const outsideRoot = path.join(f.root, 'unapproved-storage'); mkdirSync(outsideRoot);
  const link = path.join(supplied, 'storage-link'); symlinkSync(safeRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  const paths = createAppPaths(f.fakeApp(), supplied);
  const store = createLibraryStore(paths);
  const library = store.load(); library.settings.storageDir = link; store.saveSync(library);
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied; f.decisions.confirm = 1;
  await manager.activateSelected({ token: (await manager.selectExisting()).token });
  const active = f.create(); active.resolve();
  const source = path.join(f.root, 'selected.pdf'); writeFileSync(source, '%PDF-1.4\nprivate import fixture\n%%EOF');
  const commands = createLibraryCommands({ appPaths: paths, store, approvedWritePaths: new Set(),
    validateLibraryFileOperation(library, attachments) {
      const approved = active.validateFileOperation(library, attachments);
      unlinkSync(link); symlinkSync(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
      return approved;
    },
  });
  try {
    const [result] = await commands.library_import_pdfs({ request: { paths: [source], importMode: 'copy' } });
    assert.equal(result.status, 'imported');
    assert.equal(path.dirname(result.paper.attachments[0].storedPath), realpathSync.native(safeRoot));
    assert.equal(readdirSync(outsideRoot).length, 0);
    assert.equal(existsSync(source), true);
  } finally { store.close(); }
});

test('WebDAV uploads private snapshots of validated PDFs instead of retargeted source links', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const safeRoot = path.join(supplied, 'paperquay-data'); mkdirSync(safeRoot, { recursive: true });
  const privateRoot = path.join(f.root, 'private'); mkdirSync(privateRoot);
  const safeFile = path.join(safeRoot, 'fixture.pdf'); writeFileSync(safeFile, 'approved backup fixture');
  writeFileSync(path.join(privateRoot, 'fixture.pdf'), 'private backup fixture must not leak');
  const link = path.join(supplied, 'pdf-link'); symlinkSync(safeRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  replaceAttachments(supplied, [path.join(link, 'fixture.pdf')]);
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied; f.decisions.confirm = 1;
  await manager.activateSelected({ token: (await manager.selectExisting()).token });
  const active = f.create(); active.resolve();
  const appPaths = createAppPaths(f.fakeApp(), supplied);
  const store = createLibraryStore(appPaths), noteStore = createNoteStore(appPaths), ragStore = createRagStore(appPaths);
  const library = store.load(); library.webdav.includePdfs = true; library.webdav.includeDerived = false; store.saveSync(library);
  let replaced = false;
  const context = { appPaths, store, noteStore, ragStore,
    validateLibraryFileOperation(library, attachments) {
      const result = active.validateFileOperation(library, attachments);
      if (!replaced) { unlinkSync(link); symlinkSync(privateRoot, link, process.platform === 'win32' ? 'junction' : 'dir'); replaced = true; }
      return result;
    },
  };
  const objects = new Map();
  try {
    const result = await runBackup(context, { getText: async () => null,
      atomicUploadFile: async (remote, _id, file) => { assert.ok(file.startsWith(appPaths.backupSnapshotDir + path.sep)); objects.set(remote, readFileSync(file)); },
      atomicUploadBytes: async (remote, _id, bytes) => objects.set(remote, Buffer.from(bytes)) }, {
      onProgress(event) { if (event.phase === 'uploading' && event.completed === 0) writeFileSync(safeFile, 'source changed after snapshot'); },
    });
    assert.equal(result.ok, true);
    assert.equal([...objects].find(([remote]) => remote.startsWith('latest/pdfs/'))[1].toString(), 'approved backup fixture');
    assert.equal(readFileSync(path.join(link, 'fixture.pdf'), 'utf8'), 'private backup fixture must not leak');
    assert.equal(appPaths.backupSnapshotDir.startsWith(supplied), false);
    assert.deepEqual(readdirSync(appPaths.backupSnapshotDir), []);
  } finally { noteStore.close(); ragStore.close(); store.close(); }
});

test('cloud PDF upload reads the approved canonical target even if the original link is retargeted', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied; f.decisions.confirm = 1;
  await manager.activateSelected({ token: (await manager.selectExisting()).token });
  const active = f.create(); active.resolve();
  const paths = createAppPaths(f.fakeApp(), supplied);
  const store = createLibraryStore(paths);
  const safeRoot = store.load().settings.storageDir;
  const privateRoot = path.join(f.root, 'private');
  mkdirSync(safeRoot, { recursive: true }); mkdirSync(privateRoot);
  writeFileSync(path.join(safeRoot, 'fixture.pdf'), 'safe upload fixture');
  writeFileSync(path.join(privateRoot, 'fixture.pdf'), 'private upload fixture');
  const link = path.join(supplied, 'linked-pdf');
  symlinkSync(safeRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  let authorizations = 0;
  const commands = createMineruCommands({ appPaths: paths, store,
    async authorizeCloudParsePath(library, pdfPath) {
      const actual = await active.authorizeCloudParsePath(library, pdfPath);
      if (++authorizations === 1) {
        unlinkSync(link); symlinkSync(privateRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return actual;
    },
  });
  const originalFetch = globalThis.fetch;
  let uploaded = '';
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'POST') return new Response(JSON.stringify({ code: 0, data: { batch_id: 'fixture', file_urls: ['https://upload.invalid/fixture'] } }));
    uploaded = Buffer.from(options.body).toString();
    throw new Error('fixture upload captured');
  };
  try {
    await assert.rejects(commands.run_mineru_cloud_parse({ options: { pdfPath: path.join(link, 'fixture.pdf'), apiToken: 'fixture' } }), /fixture upload captured/);
    assert.equal(authorizations, 2);
    assert.equal(uploaded, 'safe upload fixture');
    assert.equal(readFileSync(path.join(link, 'fixture.pdf'), 'utf8'), 'private upload fixture');
  } finally { globalThis.fetch = originalFetch; store.close(); }
});

test('PDF, derived text, binary reads and RAG indexing reject unapproved paths after adoption', async (t) => {
  const f = fixture(t);
  f.makeLibrary(path.join(f.normalProfile, 'PaperQuay'));
  const supplied = f.makeLibrary(path.join(f.root, 'supplied'));
  const safe = path.join(supplied, 'paperquay-data', 'safe.pdf');
  mkdirSync(path.dirname(safe), { recursive: true }); writeFileSync(safe, '%PDF-1.4\nsafe document\n%%EOF');
  replaceAttachments(supplied, [safe]);
  const manager = f.create(); manager.resolve(); manager.rememberActive();
  f.decisions.directory = supplied; f.decisions.confirm = 1;
  await manager.activateSelected({ token: (await manager.selectExisting()).token });
  const paths = createAppPaths(f.fakeApp(), supplied);
  const store = createLibraryStore(paths);
  const ragStore = createRagStore(paths);
  const privateFile = path.join(f.root, 'private.pdf');
  writeFileSync(privateFile, '%PDF-1.4\nprivate plaintext must not leak\n%%EOF');
  replaceAttachments(supplied, [privateFile]);
  const active = f.create(); active.resolve();
  const context = { appPaths: paths, store, ragStore, approvedWritePaths: new Set(),
    validateLibraryFileOperation: (library, attachments) => active.validateFileOperation(library, attachments),
    authorizeLocalRead: (filePath) => active.authorizeLocalRead(store.load(), filePath) };
  function loadWithElectron(relative, electron) {
    const url = new URL(relative, import.meta.url);
    const localRequire = createRequire(url);
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(url, 'utf8'), { require: (name) => name === 'electron' ? electron : localRequire(name),
      module, __dirname: path.dirname(url.pathname.replace(/^\/(?=[A-Za-z]:)/, '')), process, Buffer, URL, Response, Headers });
    return module.exports;
  }
  const fileCommands = loadWithElectron('../electron/backend/fileCommands.cjs', {}).createFileCommands(context);
  const handlers = new Map();
  const pdfProtocol = loadWithElectron('../electron/localPdfProtocol.cjs', { protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) } });
  pdfProtocol.registerLocalPdfProtocol(context.authorizeLocalRead);
  const pdfResponse = (filePath) => handlers.get('paperquay-pdf')({ url: 'paperquay-pdf://local/?path=' + encodeURIComponent(filePath), method: 'GET', headers: new Headers() });
  const ai = createAiCommands(context);
  const request = { documentKey: 'fixture-0', title: 'Fixture', sourceType: 'pdf-text', sourceSignature: 'fixture', embeddingModelKey: 'fixture', totalChunkCount: 1,
    chunks: [{ chunkId: 'fixture-chunk', chunkIndex: 0, pageIndex: 0, text: 'private plaintext must not leak', embedding: [1, 0, 0, 0] }] };
  try {
    const denied = await pdfResponse(privateFile);
    assert.equal(denied.status, 403); assert.equal((await denied.text()).includes('private plaintext'), false);
    await assert.rejects(fileCommands.read_binary_file_base64({ path: privateFile }), /file access settings changed/);
    await assert.rejects(ai.rag_index_document({ request }), /file access settings changed/);
    const inspect = new DatabaseSync(paths.ragDatabasePath, { readOnly: true });
    try { assert.equal(inspect.prepare('SELECT count(*) AS n FROM rag_chunks').get().n, 0); } finally { inspect.close(); }
    replaceAttachments(supplied, [safe]);
    const privateDerived = path.join(f.root, 'private-derived');
    mkdirSync(privateDerived);
    mkdirSync(paths.mineruCacheDir, { recursive: true });
    const link = path.join(paths.mineruCacheDir, 'document-linked');
    symlinkSync(privateDerived, link, process.platform === 'win32' ? 'junction' : 'dir');
    f.decisions.confirm = 0;
    for (const name of ['full.md', 'content_list.json']) {
      writeFileSync(path.join(privateDerived, name), 'private derived plaintext must not leak');
      await assert.rejects(fileCommands.read_text_file({ path: path.join(link, name) }), /file access settings changed/);
      await assert.rejects(fileCommands.read_text_file_if_exists({ path: path.join(link, name) }), /file access settings changed/);
    }
    writeFileSync(path.join(paths.mineruCacheDir, 'full.md'), 'safe derived text');
    assert.equal(await fileCommands.read_text_file({ path: path.join(paths.mineruCacheDir, 'full.md') }), 'safe derived text');
    assert.equal(await fileCommands.read_text_file_if_exists({ path: path.join(paths.mineruCacheDir, 'missing.json') }), null);
    const noLeak = new DatabaseSync(paths.ragDatabasePath, { readOnly: true });
    try { assert.equal(noLeak.prepare('SELECT count(*) AS n FROM rag_chunks').get().n, 0); } finally { noLeak.close(); }
    const allowed = await pdfResponse(safe);
    assert.equal(allowed.status, 200); assert.match(await allowed.text(), /safe document/);
    assert.match(Buffer.from(await fileCommands.read_binary_file_base64({ path: safe }), 'base64').toString(), /safe document/);
    const safeAlias = path.join(supplied, 'pdf-alias');
    const redirected = path.join(f.root, 'redirected-pdf'); mkdirSync(redirected);
    writeFileSync(path.join(redirected, 'safe.pdf'), 'private retargeted fixture');
    symlinkSync(path.dirname(safe), safeAlias, process.platform === 'win32' ? 'junction' : 'dir');
    pdfProtocol.registerLocalPdfProtocol(async (filePath) => {
      const actual = await context.authorizeLocalRead(filePath);
      unlinkSync(safeAlias); symlinkSync(redirected, safeAlias, process.platform === 'win32' ? 'junction' : 'dir');
      return actual;
    });
    const stable = await pdfResponse(path.join(safeAlias, 'safe.pdf'));
    assert.equal(stable.status, 200);
    assert.match(await stable.text(), /safe document/);
    await ai.rag_index_document({ request: { ...request, chunks: [{ ...request.chunks[0], text: 'safe document' }] } });
    assert.equal(ragStore.getDocumentIndexStatus({ documentKey: 'fixture-0', sourceType: 'pdf-text' }).indexedChunkCount, 1);
  } finally { ragStore.close(); store.close(); }
});
