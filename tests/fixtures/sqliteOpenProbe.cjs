const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite = require('node:sqlite');
const [mode, root, kind, linkKind] = process.argv.slice(2);
const NativeDatabase = sqlite.DatabaseSync;
const outsideDirectory = path.join(root, 'outside');
fs.mkdirSync(outsideDirectory);
const victim = path.join(outsideDirectory, 'database.sqlite');
const outside = new NativeDatabase(victim);
outside.exec("CREATE TABLE sentinel (value); INSERT INTO sentinel VALUES ('outside')");
outside.close();
const before = fs.readFileSync(victim);
const directory = path.join(root, 'shared');
fs.mkdirSync(directory);
const file = path.join(directory, 'database.sqlite');
let changed = false;
const reparse = clear => {
  const result = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'sqliteReparseProbe.ps1'), directory, outsideDirectory, ...(clear ? ['-Clear'] : []),
  ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
};

// Intercept the real host constructor after the production wrapper acquires
// its native lease. No product test hook or fake SQLite implementation is used.
sqlite.DatabaseSync = new Proxy(NativeDatabase, {
  construct(target, args, newTarget) {
    if (!changed && String(args[0]).startsWith('file:')) {
      changed = true;
      if (mode === 'leaf') {
        if (linkKind === 'hard') fs.linkSync(victim, file);
        else fs.symlinkSync(victim, file, 'file');
      } else if (mode === 'reparse') {
        reparse(false);
        assert.equal(fs.lstatSync(directory).isSymbolicLink(), true);
      } else {
        try {
          fs.renameSync(directory, path.join(root, 'retained'));
          fs.symlinkSync(outsideDirectory, directory, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          // Windows directory handles deny replacement. POSIX keeps using the
          // retained directory after an actual successful namespace switch.
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        }
      }
    }
    return Reflect.construct(target, args, newTarget);
  },
});

const { DatabaseSync } = require('../../electron/backend/nodeSqlite.cjs');
let store;
try {
  if (kind === 'notes') store = require('../../electron/backend/noteStore.cjs').createNoteStore({ notesDatabasePath: file });
  else if (kind === 'rag') store = require('../../electron/backend/ragStore.cjs').createRagStore({ ragDatabasePath: file });
  else {
    store = new DatabaseSync(file);
    store.exec('PRAGMA journal_mode=WAL; CREATE TABLE safe (n); INSERT INTO safe VALUES(7)');
  }
  assert.notEqual(mode, 'leaf', 'a linked leaf must not be opened');
} catch (error) {
  if (mode !== 'leaf' && mode !== 'reparse') throw error;
  assert.match(error.message, /(?:unable to open|authorization denied|disk I\/O|not authorized)/i);
} finally { store?.close(); if (mode === 'reparse' && fs.lstatSync(directory).isSymbolicLink()) reparse(true); }
assert.equal(changed, true);
assert.deepEqual(fs.readFileSync(victim), before);
assert.equal(fs.existsSync(victim + '-wal'), false);
if (mode === 'directory' && process.platform !== 'win32') {
  assert.ok(fs.lstatSync(directory).isSymbolicLink());
  const read = new NativeDatabase(path.join(root, 'retained', 'database.sqlite'), { readOnly: true });
  try { assert.equal(read.prepare('SELECT n FROM safe').get().n, 7); }
  finally { read.close(); }
}
console.log('Pinned SQLite probe passed.');
