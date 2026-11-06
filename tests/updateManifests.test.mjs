import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url), yaml = require('js-yaml');
const { SPECS, readManifest, mergeUpdateManifests } = require('../packaging/mergeUpdateManifests.cjs');
const version = '0.1.26-fixture.1';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-update-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifests = {}, dirs = {};
  for (const [target, spec] of Object.entries(SPECS)) {
    const directory = path.join(root, spec.directory); fs.mkdirSync(directory); dirs[target] = directory;
    const files = spec.suffixes.map(suffix => {
      const url = `PaperQuay-${version}-${suffix}`, bytes = Buffer.from(url);
      fs.writeFileSync(path.join(directory, url), bytes);
      return { url, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length };
    });
    for (const suffix of spec.assets) {
      const file = path.join(directory, `PaperQuay-${version}-${suffix}`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, 'fixture package');
    }
    manifests[target] = { version, files, path: files[0].url, sha512: files[0].sha512,
      releaseDate: target === 'mac-arm64' ? '2026-11-06T12:01:00.000Z' : '2026-11-06T12:00:00.000Z' };
  }
  const save = target => fs.writeFileSync(path.join(dirs[target], SPECS[target].manifest), yaml.dump(manifests[target]));
  Object.keys(SPECS).forEach(save);
  return { root, dirs, manifests, save, output: path.join(root, 'merged') };
}

test('final update metadata preserves both Mac architectures, ZIPs and platform checksums', t => {
  const f = fixture(t);
  for (const target of Object.keys(SPECS)) readManifest(f.dirs[target], version, target, true);
  mergeUpdateManifests(f.root, f.output, version);
  const mac = yaml.load(fs.readFileSync(path.join(f.output, 'stable-mac.yml'), 'utf8'));
  assert.equal(mac.files.length, 4);
  for (const arch of ['x64', 'arm64']) assert.ok(mac.files.some(file => file.url.endsWith(`mac-${arch}.zip`)));
  assert.equal(mac.path, `PaperQuay-${version}-mac-x64.zip`);
  assert.equal(mac.sha512, mac.files.find(file => file.url === mac.path).sha512);
  assert.equal(mac.releaseDate, '2026-11-06T12:01:00.000Z');
  assert.deepEqual(yaml.load(fs.readFileSync(path.join(f.output, 'stable.yml'), 'utf8')), f.manifests['win-x64']);
  assert.deepEqual(yaml.load(fs.readFileSync(path.join(f.output, 'stable-linux.yml'), 'utf8')), f.manifests['linux-x64']);
});

test('merge rejects missing architectures and mixed versions before writing output', t => {
  const f = fixture(t); f.manifests['mac-arm64'].version = '0.1.0'; f.save('mac-arm64');
  assert.throws(() => mergeUpdateManifests(f.root, f.output, version), /Mixed release versions/);
  assert.equal(fs.existsSync(f.output), false);
  fs.unlinkSync(path.join(f.dirs['mac-arm64'], 'stable-mac.yml'));
  assert.throws(() => mergeUpdateManifests(f.root, f.output, version), /ENOENT/);
});

test('metadata rejects external, traversal, duplicate and wrong-architecture package names', t => {
  const f = fixture(t), data = f.manifests['mac-x64'], original = data.files[0].url;
  for (const url of ['../outside.zip', 'https://fixture.invalid/package.zip', '%2e%2e%2foutside.zip', `PaperQuay-${version}-mac-arm64.zip`]) {
    data.files[0].url = url; f.save('mac-x64');
    assert.throws(() => readManifest(f.dirs['mac-x64'], version, 'mac-x64'), /Unsafe, duplicate or wrong-architecture/);
  }
  data.files[0].url = original; data.files[1].url = original; f.save('mac-x64');
  assert.throws(() => readManifest(f.dirs['mac-x64'], version, 'mac-x64'), /Unsafe, duplicate or wrong-architecture/);
});

test('Mac metadata requires an updater ZIP and matching legacy checksum', t => {
  const f = fixture(t), data = f.manifests['mac-x64']; data.files.pop(); f.save('mac-x64');
  assert.throws(() => readManifest(f.dirs['mac-x64'], version, 'mac-x64'), /Required automatic update package/);
  data.files.push({ ...data.files[0], url: `PaperQuay-${version}-mac-x64.zip` }); data.sha512 = 'different'; f.save('mac-x64');
  assert.throws(() => readManifest(f.dirs['mac-x64'], version, 'mac-x64'), /Legacy update path\/checksum/);
});

test('matrix validation detects altered package bytes and absent installer assets', t => {
  const f = fixture(t), data = f.manifests['win-x64'], file = path.join(f.dirs['win-x64'], data.path);
  fs.writeFileSync(file, Buffer.alloc(data.files[0].size));
  assert.throws(() => readManifest(f.dirs['win-x64'], version, 'win-x64', true), /Package checksum differs/);
  fs.writeFileSync(file, Buffer.from(data.path));
  fs.unlinkSync(path.join(f.dirs['win-x64'], `PaperQuay-${version}-win-x64.msi`));
  assert.throws(() => readManifest(f.dirs['win-x64'], version, 'win-x64', true), /ENOENT/);
});

test('merge rejects conflicting rollout metadata and malformed sizes/checksums', t => {
  const f = fixture(t); f.manifests['mac-arm64'].stagingPercentage = 20; f.save('mac-arm64');
  assert.throws(() => mergeUpdateManifests(f.root, f.output, version), /Conflicting macOS/);
  const entry = f.manifests['win-x64'].files[0]; entry.size = 0; f.save('win-x64');
  assert.throws(() => readManifest(f.dirs['win-x64'], version, 'win-x64'), /Invalid update file size/);
  entry.size = 10; entry.sha512 = 'invalid'; f.save('win-x64');
  assert.throws(() => readManifest(f.dirs['win-x64'], version, 'win-x64'), /Invalid update checksum/);
});
