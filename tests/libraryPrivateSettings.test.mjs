import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createAppPaths, createLibraryStore } = require('../electron/backend/libraryStore.cjs');
const { DatabaseSync } = require('../electron/backend/nodeSqlite.cjs');
const { createWebdavCommands } = require('../electron/backend/webdavCommands.cjs');
const { createLibraryCommands } = require('../electron/backend/libraryCommands.cjs');

test('adopted libraries keep WebDAV/OpenAlex credentials and Zotero sources out of the DB and its snapshots', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-private-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'local-profile');
  const appPaths = createAppPaths({ getPath: () => profile }, path.join(root, 'shared-library'));
  let store = createLibraryStore(appPaths);
  try {
    const db = new DatabaseSync(appPaths.libraryDatabasePath);
    db.prepare('INSERT OR REPLACE INTO webdav_settings (key,value_json) VALUES (?,?)').run('endpointUrl', JSON.stringify('https://supplier.invalid/dav'));
    db.prepare('INSERT OR REPLACE INTO webdav_settings (key,value_json) VALUES (?,?)').run('password', JSON.stringify('supplier-fixture-token'));
    db.prepare('INSERT OR REPLACE INTO library_settings (key,value_json) VALUES (?,?)').run('zoteroLocalDataDir', JSON.stringify(path.join(root, 'supplier-zotero')));
    db.close();
    assert.equal(store.load().webdav.endpointUrl, '');
    assert.equal(store.load().webdav.password, '');
    assert.equal(store.load().settings.zoteroLocalDataDir, '');
    const context = { store, appPaths };
    await createWebdavCommands(context).webdav_update_backup_settings({ settings: {
      endpointUrl: 'https://user-fixture.invalid/dav', username: 'fixture-user', password: 'private-webdav-fixture-token',
    } });
    await createLibraryCommands(context).library_update_settings({ settings: {
      openAlexApiKey: 'private-openalex-fixture-token', openAlexMailto: 'fixture@example.invalid',
      zoteroLocalDataDir: path.join(root, 'private-zotero-fixture'),
    } });
    const snapshot = path.join(root, 'export.sqlite');
    store.snapshotTo(snapshot);
    for (const file of [appPaths.libraryDatabasePath, snapshot]) {
      const bytes = readFileSync(file);
      assert.equal(bytes.includes(Buffer.from('private-webdav-fixture-token')), false);
      assert.equal(bytes.includes(Buffer.from('private-openalex-fixture-token')), false);
      assert.equal(bytes.includes(Buffer.from('user-fixture.invalid')), false);
      assert.equal(bytes.includes(Buffer.from('private-zotero-fixture')), false);
      const inspection = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(JSON.parse(inspection.prepare("SELECT value_json FROM webdav_settings WHERE key='password'").get().value_json), '');
        assert.equal(JSON.parse(inspection.prepare("SELECT value_json FROM library_settings WHERE key='openAlexApiKey'").get().value_json), '');
        assert.equal(JSON.parse(inspection.prepare("SELECT value_json FROM library_settings WHERE key='zoteroLocalDataDir'").get().value_json), '');
      } finally { inspection.close(); }
    }
    const oldPrivate = readFileSync(appPaths.privateLibrarySettingsPath, 'utf8');
    const failedSave = store.load();
    failedSave.webdav.password = 'must-not-stick';
    store.close();
    assert.throws(() => store.saveSync(failedSave));
    assert.equal(readFileSync(appPaths.privateLibrarySettingsPath, 'utf8'), oldPrivate);
    store = createLibraryStore(appPaths);
    assert.equal(store.load().webdav.password, 'private-webdav-fixture-token');
    assert.equal(store.load().settings.openAlexApiKey, 'private-openalex-fixture-token');
    assert.equal(store.load().settings.zoteroLocalDataDir, path.join(root, 'private-zotero-fixture'));
    const changed = new DatabaseSync(appPaths.libraryDatabasePath);
    changed.prepare('UPDATE webdav_settings SET value_json=? WHERE key=?').run(JSON.stringify('https://supplier.invalid/changed'), 'endpointUrl');
    changed.prepare('UPDATE library_settings SET value_json=? WHERE key=?').run(JSON.stringify(path.join(root, 'changed-supplier-zotero')), 'zoteroLocalDataDir');
    changed.close();
    assert.equal(store.load().webdav.endpointUrl, 'https://user-fixture.invalid/dav');
    assert.equal(store.loadFromSnapshot(snapshot).webdav.password, 'private-webdav-fixture-token');
    assert.equal(store.loadFromSnapshot(snapshot).settings.zoteroLocalDataDir, path.join(root, 'private-zotero-fixture'));
    assert.equal(store.load().settings.zoteroLocalDataDir, path.join(root, 'private-zotero-fixture'));
  } finally { store.close(); }
});

test('a default profile library reached through a directory link retains existing service settings', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-profile-alias-'));
  try {
    const profile = path.join(root, 'profile'); mkdirSync(profile);
    const actual = path.join(root, 'actual-library'); mkdirSync(actual);
    symlinkSync(actual, path.join(profile, 'PaperQuay'), process.platform === 'win32' ? 'junction' : 'dir');
    const app = { getPath: () => profile };
    let paths = createAppPaths(app);
    let store = createLibraryStore(paths);
    try {
      const library = store.load();
      library.webdav.password = 'default-profile-fixture-token';
      library.settings.openAlexApiKey = 'default-openalex-fixture-token';
      store.saveSync(library);
    } finally { store.close(); }
    paths = createAppPaths(app, actual);
    assert.equal(paths.privateLibrarySettingsPath, null);
    store = createLibraryStore(paths);
    try {
      assert.equal(store.load().webdav.password, 'default-profile-fixture-token');
      assert.equal(store.load().settings.openAlexApiKey, 'default-openalex-fixture-token');
      store.saveSync(store.load());
      assert.equal(store.load().webdav.password, 'default-profile-fixture-token');
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('damaged private settings are preserved and replaced with safe disconnected defaults', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-damaged-private-'));
  const appPaths = createAppPaths({ getPath: () => path.join(root, 'profile') }, path.join(root, 'library'));
  const store = createLibraryStore(appPaths);
  try {
    store.saveSync(store.load());
    for (const broken of ['{"webdav":', 'null']) {
      writeFileSync(appPaths.privateLibrarySettingsPath, broken);
      assert.equal(store.load().webdav.endpointUrl, '');
      assert.equal(store.load().webdav.password, '');
      assert.equal(store.load().settings.openAlexApiKey, '');
      const directory = path.dirname(appPaths.privateLibrarySettingsPath);
      const preserved = readdirSync(directory).filter((name) => name.endsWith('.corrupt'));
      assert.ok(preserved.some((name) => readFileSync(path.join(directory, name), 'utf8') === broken));
      assert.equal(JSON.parse(readFileSync(appPaths.privateLibrarySettingsPath, 'utf8')).webdav.endpointUrl, '');
    }
    store.saveSync(store.load());
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
