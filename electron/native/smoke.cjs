const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// An optional extracted package root exercises the exact shipped addon bytes.
const native = require(process.argv[2] ? path.join(process.argv[2], 'electron', 'backend', 'nativeFs.cjs') : '../backend/nativeFs.cjs');
const { DatabaseSync } = require(process.argv[2] ? path.join(process.argv[2], 'electron', 'backend', 'nodeSqlite.cjs') : '../backend/nodeSqlite.cjs');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-native-smoke-')));
(async () => {
  try {
    const file = path.join(root, 'test.txt');
    await native.write(file, Buffer.from('Electron native capability'));
    assert.equal((await native.read(file)).bytes.toString(), 'Electron native capability');
    const listed = await native.listFiles(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'test.txt');
    assert.equal(listed[0].size, Buffer.byteLength('Electron native capability'));
    assert.ok(Math.abs(listed[0].modifiedAtMs - fs.statSync(file).mtimeMs) < 1);
    const opened = await native.openRead(file);
    try { assert.equal(fs.readFileSync(opened.fd, 'utf8'), 'Electron native capability'); }
    finally { fs.closeSync(opened.fd); }
    await native.remove(file, { expectedIdentity: opened.identity });
    assert.deepEqual(await native.list(root), []);
    const databasePath = path.join(root, 'native.sqlite');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec('PRAGMA journal_mode=WAL; CREATE TABLE proof(n); INSERT INTO proof VALUES(42)');
      const reader = new DatabaseSync(databasePath, { readOnly: true });
      try { assert.equal(reader.prepare('SELECT n FROM proof').get().n, 42); }
      finally { reader.close(); }
    } finally { database.close(); }
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.equal(reopened.prepare('SELECT n FROM proof').get().n, 42); }
    finally { reopened.close(); }
    console.log(`Native filesystem passed in Electron ${process.versions.electron} (${process.platform}-${process.arch}).`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
