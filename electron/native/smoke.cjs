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
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-native-smoke-')));
(async () => {
  try {
    const file = path.join(root, 'test.txt');
    await native.write(file, Buffer.from('Electron native capability'));
    assert.equal((await native.read(file)).bytes.toString(), 'Electron native capability');
    const opened = await native.openRead(file);
    try { assert.equal(fs.readFileSync(opened.fd, 'utf8'), 'Electron native capability'); }
    finally { fs.closeSync(opened.fd); }
    await native.remove(file, { expectedIdentity: opened.identity });
    assert.deepEqual(await native.list(root), []);
    console.log(`Native filesystem passed in Electron ${process.versions.electron} (${process.platform}-${process.arch}).`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
