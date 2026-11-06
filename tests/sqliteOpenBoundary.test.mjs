import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { DatabaseSync, vacuumInto } = require('../electron/backend/nodeSqlite.cjs');
const { DatabaseSync: NativeDatabase } = require('node:sqlite');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pq-sqlite-open-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const childOptions = { encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };

for (const kind of ['library', 'notes', 'rag']) for (const linkKind of ['symbolic', 'hard']) {
  test(`${kind} rejects a ${linkKind} DB leaf substituted after native pinning`, t => {
    const result = spawnSync(process.execPath, [path.resolve('tests/fixtures/sqliteOpenProbe.cjs'), 'leaf', fixture(t), kind, linkKind], childOptions);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test('an ancestor replaced after native pinning cannot redirect SQLite startup', t => {
  const result = spawnSync(process.execPath, [path.resolve('tests/fixtures/sqliteOpenProbe.cjs'), 'directory', fixture(t), 'library'], childOptions);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('in-place directory redirection cannot redirect SQLite startup', t => {
  const result = spawnSync(process.execPath, [path.resolve('tests/fixtures/sqliteOpenProbe.cjs'), process.platform === 'win32' ? 'reparse' : 'directory', fixture(t), 'library'], childOptions);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('adopted absent notes cannot become an outside SQLite write between inspection and backend startup', t => {
  const root = fixture(t), profile = path.join(root, 'profile'), shared = path.join(root, 'shared');
  const { createAppPaths, createLibraryStore } = require('../electron/backend/libraryStore.cjs');
  const { inspectLibraryDirectory } = require('../electron/libraryLocation.cjs');
  const { createNoteStore } = require('../electron/backend/noteStore.cjs');
  const app = { getPath() { return profile; } };
  const paths = createAppPaths(app, shared);
  const library = createLibraryStore(paths); library.load(); library.close();
  assert.equal(inspectLibraryDirectory(shared).dataDirectory, shared);
  const victim = path.join(root, 'victim.sqlite'), db = new NativeDatabase(victim);
  db.exec('CREATE TABLE sentinel(n); INSERT INTO sentinel VALUES(9)'); db.close();
  const before = fs.readFileSync(victim);
  fs.symlinkSync(victim, paths.notesDatabasePath, 'file');
  assert.throws(() => createNoteStore(paths));
  assert.deepEqual(fs.readFileSync(victim), before);
  assert.equal(fs.existsSync(victim + '-wal'), false);
});

test('backend startup never canonicalizes an already adopted root through a replacement junction', t => {
  const root = fixture(t), shared = path.join(root, 'shared'), outside = path.join(root, 'outside');
  const app = { getPath() { return path.join(root, 'profile'); } };
  const { createAppPaths, createLibraryStore } = require('../electron/backend/libraryStore.cjs');
  const { inspectLibraryDirectory } = require('../electron/libraryLocation.cjs');
  for (const directory of [shared, outside]) {
    const store = createLibraryStore(createAppPaths(app, directory)); store.load(); store.close();
  }
  const inspected = inspectLibraryDirectory(shared);
  const victim = path.join(outside, 'paperquay-notes.sqlite'), db = new NativeDatabase(victim);
  db.exec('CREATE TABLE sentinel(n); INSERT INTO sentinel VALUES(8)'); db.close();
  const before = fs.readFileSync(victim);
  fs.renameSync(shared, path.join(root, 'retained'));
  fs.symlinkSync(outside, shared, process.platform === 'win32' ? 'junction' : 'dir');
  const { createBackend } = require('../electron/backend.cjs');
  let backend;
  try { assert.throws(() => { backend = createBackend({ app, libraryLocation: { status: () => ({ ...inspected, registered: true }) } }); }); }
  finally { backend?.close(); }
  assert.deepEqual(fs.readFileSync(victim), before);
  assert.equal(fs.existsSync(victim + '-wal'), false);
});

test('registered startup refuses a redirected root without resolving the new target', async t => {
  const root = fixture(t), profile = path.join(root, 'profile'), appData = path.join(root, 'Roaming');
  fs.mkdirSync(appData);
  const app = { getPath: name => name === 'appData' ? appData : profile, setPath() {} };
  const { createAppPaths, createLibraryStore } = require('../electron/backend/libraryStore.cjs');
  const { createLibraryLocationManager } = require('../electron/libraryLocation.cjs');
  const shared = path.join(root, 'shared'), outside = path.join(root, 'outside');
  for (const directory of [undefined, shared, outside]) {
    const store = createLibraryStore(createAppPaths(app, directory)); store.load(); store.close();
  }
  const create = () => createLibraryLocationManager({ app, argv: [], restart() {}, dialog: {
    async showOpenDialog() { return { canceled: false, filePaths: [shared] }; },
    async showMessageBox() { return { response: 1 }; },
  } });
  const manager = create(); manager.resolve(); manager.rememberActive();
  await manager.activateSelected({ token: (await manager.selectExisting()).token });
  fs.renameSync(shared, path.join(root, 'retained'));
  fs.symlinkSync(outside, shared, process.platform === 'win32' ? 'junction' : 'dir');
  const realpath = fs.realpathSync.native;
  let resolutions = 0;
  fs.realpathSync.native = (...args) => { if (path.resolve(args[0]) === shared) resolutions++; return realpath(...args); };
  try { assert.throws(() => create().resolve(), /Linked|Approved path changed/); }
  finally { fs.realpathSync.native = realpath; }
  assert.equal(resolutions, 0);
});

for (const suffix of ['-wal', '-shm', '-journal']) for (const linkKind of ['symbolic', 'hard']) {
  test(`SQLite never writes through a ${linkKind} ${suffix} companion`, t => {
    const root = fixture(t), file = path.join(root, 'db.sqlite'), victim = path.join(root, 'outside');
    const db = new DatabaseSync(file);
    if (suffix !== '-journal') db.exec('PRAGMA journal_mode=WAL');
    fs.writeFileSync(victim, Buffer.alloc(65536, 0x53));
    const before = fs.readFileSync(victim), target = file + suffix;
    if (linkKind === 'hard') fs.linkSync(victim, target); else fs.symlinkSync(victim, target, 'file');
    try {
      try { db.exec('CREATE TABLE t(n); INSERT INTO t VALUES(1)'); }
      catch (error) { assert.match(error.message, /(?:unable to open|disk I\/O|readonly|locked)/i); }
    }
    finally { db.close(); }
    assert.deepEqual(fs.readFileSync(victim), before);
  });
}

test('two connections and a real child process share WAL, retain locks and reopen persistent data', t => {
  const root = fixture(t), file = path.join(root, 'db.sqlite');
  const first = new DatabaseSync(file, { timeout: 10 });
  first.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(n); INSERT INTO t VALUES(1)');
  const second = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(second.prepare('SELECT n FROM t').get().n, 1);
    first.exec('BEGIN IMMEDIATE; INSERT INTO t VALUES(2)');
    assert.equal(second.prepare('SELECT count(*) AS n FROM t').get().n, 1);
    second.close();
    const result = spawnSync(process.execPath, ['-e', `
      const {DatabaseSync}=require('./electron/backend/nodeSqlite.cjs');
      const assert=require('node:assert/strict');
      const db=new DatabaseSync(process.argv[1], {timeout:10});
      assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n,1);
      assert.throws(()=>db.exec('INSERT INTO t VALUES(3)'), /locked/);
      db.close();`, file], childOptions);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    first.exec('COMMIT');
    const reopened = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(reopened.prepare('SELECT count(*) AS n FROM t').get().n, 2); }
    finally { reopened.close(); }
  } finally { if (second.isOpen) second.close(); first.close(); }
  const persisted = new DatabaseSync(file);
  try { assert.equal(persisted.prepare('PRAGMA quick_check').get().quick_check, 'ok'); }
  finally { persisted.close(); }
  // An explicit close releases retained Windows directories too.
  fs.renameSync(root, root + '-moved'); fs.renameSync(root + '-moved', root);
});

test('deferred open and reopen reacquire a lease; file URL, Buffer and memory paths preserve behavior', t => {
  const root = fixture(t), file = path.join(root, 'db #%文.sqlite');
  const db = new DatabaseSync(Buffer.from(file), { open: false });
  assert.equal(fs.existsSync(file), false);
  db.open(); db.exec('CREATE TABLE t(n); INSERT INTO t VALUES(4)'); db.close();
  db.open(); assert.equal(db.prepare('SELECT n FROM t').get().n, 4); db.close();
  const fromUrl = new DatabaseSync(pathToFileURL(file), { readOnly: true });
  fromUrl.close();
  const memory = new DatabaseSync(':memory:'); memory.exec('CREATE TABLE t(n)'); memory.close();
  assert.throws(() => new DatabaseSync('file:untrusted?vfs=unix'), /local SQLite/);
});

test('VACUUM snapshot uses the pinned destination and rejects a linked overwrite', t => {
  const root = fixture(t), db = new DatabaseSync(path.join(root, 'db.sqlite'));
  try {
    db.exec('CREATE TABLE t(n); INSERT INTO t VALUES(5)');
    const snapshot = path.join(root, 'nested', 'snapshot.sqlite'); vacuumInto(db, snapshot);
    const read = new DatabaseSync(snapshot, { readOnly: true });
    try { assert.equal(read.prepare('SELECT n FROM t').get().n, 5); }
    finally { read.close(); }
    fs.unlinkSync(snapshot);
    const victim = path.join(root, 'outside'); fs.writeFileSync(victim, 'preserve');
    fs.symlinkSync(victim, snapshot, 'file');
    assert.throws(() => vacuumInto(db, snapshot));
    assert.equal(fs.readFileSync(victim, 'utf8'), 'preserve');
  } finally { db.close(); }
});
