import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const native = require('../electron/backend/nativeFs.cjs');
const { resolveAuthorizedPath, readAuthorizedFile } = require('../electron/backend/pathAccess.cjs');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-native-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inside = path.join(root, 'inside'), outside = path.join(root, 'outside');
  fs.mkdirSync(inside); fs.mkdirSync(outside);
  return { root, inside, outside, file: path.join(inside, 'file.txt') };
}

test('native asynchronous failures retain their error text after stack unwinding', async () => {
  await Promise.all(Array.from({ length: 128 }, () =>
    assert.rejects(native.read('relative.pdf'), { code: 'EPERM', message: 'Absolute filesystem path required.' })));
});

test('native async/sync write, exclusive copy, listing, bounded reads and identity deletion', async (t) => {
  const f = fixture(t);
  await native.write(f.file, Buffer.from('old'));
  await assert.rejects(native.write(f.file, Buffer.from('new'), { exclusive: true }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'old');
  native.writeSync(f.file, Buffer.from('new'));
  const copied = path.join(f.inside, 'nested', '副本.txt');
  await native.copy(f.file, copied, { exclusive: true });
  assert.deepEqual((await native.list(f.inside)).sort(), ['file.txt', 'nested']);
  assert.equal((await native.read(copied)).bytes.toString(), 'new');
  await assert.rejects(native.read(copied, { maxBytes: 2 }), /allowed size/);
  await assert.rejects(native.remove(copied, { expectedIdentity: 'wrong' }), /identity changed/);
  await native.remove(copied, { expectedIdentity: native.inspectSync(copied).identity });
  assert.equal(fs.existsSync(copied), false);
  assert.equal(await readAuthorizedFile(f.file, () => {}, 'utf8'), 'new');
  assert.equal(fs.readdirSync(f.inside).some((name) => name.startsWith('.paperquay-')), false);
});

test('parent links cannot redirect native read/write/copy/list/delete into outside files', async (t) => {
  const f = fixture(t), victim = path.join(f.outside, 'file.txt');
  fs.writeFileSync(victim, 'private bytes');
  const alias = path.join(f.inside, 'alias');
  fs.symlinkSync(f.outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const target = path.join(alias, 'file.txt');
  for (const operation of [() => native.read(target), () => native.write(target, Buffer.from('bad')),
    () => native.copy(victim, target), () => native.list(alias), () => native.remove(target)]) {
    await assert.rejects(operation, { code: 'EPERM' });
  }
  await assert.rejects(native.openRead(path.join(f.inside, 'absent', 'file.txt')), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'private bytes');
  const inspection = native.inspectSync(target);
  assert.equal(inspection.linkPath, alias);
  assert.equal(inspection.suffix, 'file.txt');
  assert.throws(() => resolveAuthorizedPath(target, (candidate) => candidate.startsWith(f.inside + path.sep)), /not approved/);
});

test('atomic replacement does not overwrite an outside hardlink target; companion reads reject hardlinks', async (t) => {
  const f = fixture(t), victim = path.join(f.outside, 'file.txt');
  fs.writeFileSync(victim, 'private bytes'); fs.linkSync(victim, f.file);
  await assert.rejects(native.read(f.file, { singleLink: true }), /Linked companion/);
  await native.write(f.file, Buffer.from('public bytes'));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'private bytes');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'public bytes');
  assert.notEqual(native.inspectSync(f.file).identity, native.inspectSync(victim).identity);
});

test('repeated ancestor replacement races never overwrite or delete outside victims', async (t) => {
  const f = fixture(t), original = path.join(f.root, 'original');
  const victim = path.join(f.outside, 'file.txt'); fs.writeFileSync(victim, 'private bytes');
  const bytes = Buffer.alloc(1024 * 1024, 42);
  for (let i = 0; i < 24; i++) {
    const operation = i % 2 ? native.remove(f.file).catch((error) => error) : native.write(f.file, bytes).catch((error) => error);
    let moved = false;
    try {
      fs.renameSync(f.inside, original); moved = true;
      fs.symlinkSync(f.outside, f.inside, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) { if (!['EBUSY', 'EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error; }
    await operation;
    if (moved) {
      // The competing mkdir/open can make link creation fail after rename;
      // an absent replacement is a valid race outcome, not a cleanup failure.
      const replacement = fs.lstatSync(f.inside, { throwIfNoEntry: false });
      if (replacement?.isSymbolicLink()) {
        if (process.platform === 'win32') fs.rmdirSync(f.inside); else fs.unlinkSync(f.inside);
      } else if (replacement) fs.rmSync(f.inside, { recursive: true });
      fs.renameSync(original, f.inside);
    }
    assert.equal(fs.readFileSync(victim, 'utf8'), 'private bytes');
  }
});

test('raw rejected paths cause no filesystem inspection or native open', async (t) => {
  const inspect = native.inspectSync, open = native.openRead;
  let probes = 0;
  native.inspectSync = native.openRead = () => { probes++; throw new Error('unexpected I/O'); };
  t.after(() => { native.inspectSync = inspect; native.openRead = open; });
  const untrusted = process.platform === 'win32' ? '\\\\unapproved.invalid\\share\\secret.pdf' : '/unapproved/secret.pdf';
  await assert.rejects(readAuthorizedFile(untrusted, () => { throw new Error('denied'); }), /denied/);
  assert.throws(() => resolveAuthorizedPath(untrusted, () => false), /not approved/);
  assert.equal(probes, 0);
});

test('malformed and device path forms fail without filesystem access', () => {
  const paths = ['', 'relative/file', '/a/../b', '/a\0b'];
  if (process.platform === 'win32') paths.push('C:relative', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', 'C:\\safe\\x:stream', 'C:\\safe\\NUL', 'C:\\safe\\x.');
  for (const target of paths) assert.throws(() => native.inspectSync(target), { code: 'EPERM' });
});
