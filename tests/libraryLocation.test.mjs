import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('../electron/backend/nodeSqlite.cjs');
const { createAppPaths, createLibraryStore } = require('../electron/backend/libraryStore.cjs');
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
  const decisions = { directory: '', confirm: 0, restarts: 0 };
  const dialog = {
    async showOpenDialog() { return { canceled: !decisions.directory, filePaths: decisions.directory ? [decisions.directory] : [] }; },
    async showMessageBox() { return { response: decisions.confirm }; },
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
