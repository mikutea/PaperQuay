import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url), yaml = require('js-yaml');
const { SPECS, proofName, createPublicationProof, decodePublicationProof, validatePublicationProof,
  publicationFingerprint, prepareReleaseManifests, assertDraftIdentity } = require('../packaging/releasePublication.cjs');
const version = '0.1.26-fixture.20', commit = 'a'.repeat(40);
const hash = (algorithm, data, encoding = 'hex') => createHash(algorithm).update(data).digest(encoding);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = [], proofs = [], dirs = {};
  let id = 1;
  for (const [target, spec] of Object.entries(SPECS)) {
    const dir = path.join(root, target); fs.mkdirSync(dir); dirs[target] = dir;
    const files = spec.suffixes.map(suffix => {
      const url = `PaperQuay-${version}-${suffix}`, bytes = Buffer.from(url);
      fs.writeFileSync(path.join(dir, url), bytes);
      return { url, size: bytes.length, sha512: hash('sha512', bytes, 'base64') };
    });
    for (const suffix of spec.assets) {
      const file = path.join(dir, `PaperQuay-${version}-${suffix}`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, 'fixture package');
    }
    if (target === 'win-x64') fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), 'synthetic checksum file');
    if (target.startsWith('mac-')) fs.writeFileSync(path.join(dir, `PaperQuay-${version}-${target}.zip.blockmap`), 'synthetic blockmap');
    const manifest = { version, files, path: files[0].url, sha512: files[0].sha512, releaseDate: '2026-11-08T00:00:00.000Z' };
    fs.writeFileSync(path.join(dir, spec.manifest), yaml.dump(manifest));
    const proof = createPublicationProof(dir, version, target, commit); proofs.push(proof);
    for (const item of proof.packages) assets.push({ id: id++, name: item.name, size: item.size, digest: 'sha256:' + item.sha256, state: 'uploaded' });
    const bytes = Buffer.from(JSON.stringify(proof));
    assets.push({ id: id++, name: proofName(target), size: bytes.length, digest: 'sha256:' + hash('sha256', bytes), state: 'uploaded' });
  }
  return { root, dirs, proofs, assets, input: path.join(root, 'input'), output: path.join(root, 'output') };
}

test('publication binds all platform manifests, blockmaps and Windows checksum file to uploaded bytes', t => {
  const f = fixture(t);
  const before = publicationFingerprint(f.proofs, f.assets, version, commit);
  prepareReleaseManifests(f.proofs, f.assets, version, commit, f.input, f.output);
  const mac = yaml.load(fs.readFileSync(path.join(f.output, 'stable-mac.yml'), 'utf8'));
  assert.equal(mac.files.length, 4);
  for (const proof of f.proofs) for (const entry of proof.manifest.files) {
    const manifest = yaml.load(fs.readFileSync(path.join(f.output, SPECS[proof.target].manifest), 'utf8'));
    assert.deepEqual(manifest.files.find(item => item.url === entry.url), entry);
  }
  assert.equal(publicationFingerprint(f.proofs, f.assets, version, commit), before);
});

test('a stale same-version proof rejects rebuilt Intel Mac bytes even when their size is unchanged', t => {
  const f = fixture(t), proof = f.proofs.find(item => item.target === 'mac-x64');
  const name = `PaperQuay-${version}-mac-x64.zip`, asset = f.assets.find(item => item.name === name);
  const previous = Buffer.from(name), rebuilt = Buffer.from(previous); rebuilt[0] ^= 1;
  asset.digest = 'sha256:' + hash('sha256', rebuilt);
  assert.throws(() => validatePublicationProof(proof, f.assets, version, 'mac-x64', commit), /Uploaded package checksum differs/);
  assert.throws(() => prepareReleaseManifests(f.proofs, f.assets, version, commit, f.input, f.output), /Uploaded package checksum differs/);
  assert.equal(fs.existsSync(f.input), false);
  assert.equal(fs.existsSync(f.output), false);
});

test('a completed retry replaces its paired proof and produces metadata for the rebuilt bytes', t => {
  const f = fixture(t), target = 'mac-x64', dir = f.dirs[target], name = `PaperQuay-${version}-mac-x64.zip`;
  const rebuilt = Buffer.from('same release, rebuilt final ZIP'); fs.writeFileSync(path.join(dir, name), rebuilt);
  const manifestPath = path.join(dir, SPECS[target].manifest), manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  Object.assign(manifest.files.find(item => item.url === name), { size: rebuilt.length, sha512: hash('sha512', rebuilt, 'base64') });
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
  const next = createPublicationProof(dir, version, target, commit);
  f.proofs[f.proofs.findIndex(item => item.target === target)] = next;
  Object.assign(f.assets.find(item => item.name === name), { size: rebuilt.length, digest: 'sha256:' + hash('sha256', rebuilt) });
  const proofBytes = Buffer.from(JSON.stringify(next));
  Object.assign(f.assets.find(item => item.name === proofName(target)), { size: proofBytes.length, digest: 'sha256:' + hash('sha256', proofBytes) });
  prepareReleaseManifests(f.proofs, f.assets, version, commit, f.input, f.output);
  const merged = yaml.load(fs.readFileSync(path.join(f.output, 'stable-mac.yml'), 'utf8'));
  assert.equal(merged.files.find(item => item.url === name).sha512, hash('sha512', rebuilt, 'base64'));
});

test('missing, duplicate and incomplete uploaded assets stop publication', t => {
  const f = fixture(t), proof = f.proofs[0], asset = f.assets.find(item => item.name === proof.packages[0].name);
  for (const assets of [f.assets.filter(item => item !== asset), [...f.assets, asset],
    f.assets.map(item => item === asset ? { ...item, state: 'starter' } : item),
    f.assets.map(item => item === asset ? { ...item, digest: null } : item)]) {
    assert.throws(() => validatePublicationProof(proof, assets, version, proof.target, commit));
  }
});

test('changed version, target, commit and extra fields reject a publication proof', t => {
  const f = fixture(t), original = f.proofs[0];
  for (const patch of [{ version: '0.1.0' }, { target: 'mac-x64' }, { commit: 'b'.repeat(40) }, { unexpected: 'data' }]) {
    assert.throws(() => validatePublicationProof({ ...original, ...patch }, f.assets, version, original.target, commit));
  }
});

test('manifest SHA512 and legacy checksum must match the same proof package', t => {
  const f = fixture(t), original = f.proofs[0];
  for (const change of ['file', 'legacy']) {
    const proof = structuredClone(original);
    if (change === 'file') proof.manifest.files[0].sha512 = hash('sha512', 'old attempt', 'base64');
    else proof.manifest.sha512 = hash('sha512', 'old attempt', 'base64');
    assert.throws(() => validatePublicationProof(proof, f.assets, version, proof.target, commit), /checksum differs/);
  }
});

test('unexpected paths, repeated packages and malformed paired hashes are rejected', t => {
  const f = fixture(t), original = f.proofs[0];
  const variants = [structuredClone(original), structuredClone(original), structuredClone(original)];
  variants[0].packages[0].name = '../outside.zip';
  variants[1].packages[1] = variants[1].packages[0];
  variants[2].packages[0].sha512 = 'not a checksum';
  for (const proof of variants) assert.throws(() => validatePublicationProof(proof, f.assets, version, proof.target, commit));
});

test('blockmaps and checksum text are included in the package binding', t => {
  const f = fixture(t);
  for (const name of ['SHA256SUMS.txt', `PaperQuay-${version}-mac-x64.zip.blockmap`]) {
    const asset = f.assets.find(item => item.name === name), old = asset.digest;
    asset.digest = 'sha256:' + '0'.repeat(64);
    assert.throws(() => publicationFingerprint(f.proofs, f.assets, version, commit), /Uploaded package checksum differs/);
    asset.digest = old;
  }
});

test('all four distinct targets are required before any merge output exists', t => {
  const f = fixture(t);
  for (const proofs of [f.proofs.slice(1), [...f.proofs.slice(0, 3), f.proofs[0]]]) {
    assert.throws(() => prepareReleaseManifests(proofs, f.assets, version, commit, f.input, f.output));
    assert.equal(fs.existsSync(f.input), false);
  }
});

test('proof downloads are size-bounded and verified against their release-asset digest', t => {
  const f = fixture(t), proof = f.proofs[0], asset = f.assets.find(item => item.name === proofName(proof.target));
  const data = Buffer.from(JSON.stringify(proof));
  assert.deepEqual(decodePublicationProof(asset, data), proof);
  const changed = Buffer.from(data); changed[0] ^= 1;
  assert.throws(() => decodePublicationProof(asset, changed), /checksum changed/);
  assert.throws(() => decodePublicationProof(asset, Buffer.alloc(65537)), /Oversized/);
});

test('a replacement asset identity or unexpected extra asset changes the publication snapshot', t => {
  const f = fixture(t), before = publicationFingerprint(f.proofs, f.assets, version, commit);
  f.assets[0].id += 1000;
  assert.notEqual(publicationFingerprint(f.proofs, f.assets, version, commit), before);
  assert.throws(() => publicationFingerprint(f.proofs, [...f.assets, { name: 'unbound-debug.txt' }], version, commit), /Unexpected release asset/);
});

test('published, wrong-tag and wrong-commit releases cannot have assets replaced', () => {
  const release = { id: 1, draft: true, tag_name: 'app-v' + version, target_commitish: commit };
  assertDraftIdentity(release, 1, release.tag_name, commit);
  for (const changed of [{ ...release, draft: false }, { ...release, tag_name: 'app-v0' },
    { ...release, target_commitish: 'b'.repeat(40) }, { ...release, id: 2 }]) {
    assert.throws(() => assertDraftIdentity(changed, 1, release.tag_name, commit), /expected draft/);
  }
});

async function workflowFixture(f, { published = false, stale = false, changeDuringPublish = false } = {}) {
  const workflow = yaml.load(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const step = workflow.jobs['publish-release'].steps.find(item => item.with?.script);
  let script = step.with.script;
  for (const [expression, value] of Object.entries({
    '${{ needs.create-release.outputs.release_id }}': '1',
    '${{ needs.create-release.outputs.tag_name }}': 'app-v' + version,
    '${{ needs.create-release.outputs.version }}': version,
  })) script = script.replaceAll(expression, value);
  script = script.replaceAll("'publication-input'", JSON.stringify(path.join(f.root, 'workflow-input')))
    .replaceAll("'release-metadata'", JSON.stringify(path.join(f.root, 'workflow-output')));
  const proofs = structuredClone(f.proofs), assets = structuredClone(f.assets);
  if (stale) {
    const proof = proofs.find(item => item.target === 'mac-x64');
    proof.manifest.files[1].sha512 = hash('sha512', 'previous build attempt', 'base64');
    const bytes = Buffer.from(JSON.stringify(proof));
    Object.assign(assets.find(item => item.name === proofName(proof.target)), { size: bytes.length, digest: 'sha256:' + hash('sha256', bytes) });
  }
  const calls = { uploads: 0, deletes: 0, publications: 0, lists: 0 };
  const release = { id: 1, draft: !published, tag_name: 'app-v' + version, target_commitish: commit };
  let nextId = 1000;
  if (published) {
    prepareReleaseManifests(proofs, assets, version, commit, f.input, f.output);
    for (const name of ['stable.yml', 'stable-linux.yml', 'stable-mac.yml']) {
      const bytes = fs.readFileSync(path.join(f.output, name));
      assets.push({ id: nextId++, name, size: bytes.length, digest: 'sha256:' + hash('sha256', bytes), state: 'uploaded' });
    }
  }
  const repos = {
    getRelease: async () => ({ data: { ...release } }),
    listReleaseAssets: async () => {
      calls.lists++;
      if (changeDuringPublish && calls.lists === 2) assets.find(item => item.name.endsWith('mac-x64.zip')).digest = 'sha256:' + '0'.repeat(64);
      return structuredClone(assets);
    },
    getReleaseAsset: async ({ asset_id }) => {
      const asset = assets.find(item => item.id === asset_id);
      const proof = proofs.find(item => proofName(item.target) === asset.name);
      const bytes = Buffer.from(JSON.stringify(proof));
      return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    deleteReleaseAsset: async ({ asset_id }) => { calls.deletes++; assets.splice(assets.findIndex(item => item.id === asset_id), 1); },
    uploadReleaseAsset: async ({ name, data }) => {
      calls.uploads++;
      const asset = { id: nextId++, name, size: data.length, digest: 'sha256:' + hash('sha256', data), state: 'uploaded' };
      assets.push(asset); return { data: asset };
    },
    updateRelease: async ({ draft }) => { assert.equal(draft, false); calls.publications++; release.draft = false; return { data: release }; },
  };
  const github = { rest: { repos }, paginate: async (method, args) => method(args) };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('github', 'context', 'core', 'require', script);
  return { calls, release, execute: () => execute(github, { repo: { owner: 'fixture', repo: 'fixture' }, sha: commit },
    { info() {} }, name => name === './packaging/releasePublication.cjs' ? require('../packaging/releasePublication.cjs') : require(name)) };
}

test('the actual publisher workflow verifies all proof downloads and uploaded metadata before publishing', async t => {
  const f = fixture(t), workflow = await workflowFixture(f);
  await workflow.execute();
  assert.equal(workflow.calls.uploads, 3);
  assert.equal(workflow.calls.publications, 1);
  assert.equal(workflow.release.draft, false);
});

test('the actual publisher stops a stale same-version manifest before any release mutation', async t => {
  const f = fixture(t), workflow = await workflowFixture(f, { stale: true });
  await assert.rejects(workflow.execute(), /Manifest checksum differs/);
  assert.equal(workflow.calls.uploads + workflow.calls.deletes + workflow.calls.publications, 0);
  assert.equal(workflow.release.draft, true);
});

test('the actual publisher verifies a published release without replacing its files', async t => {
  const f = fixture(t), workflow = await workflowFixture(f, { published: true });
  await workflow.execute();
  assert.equal(workflow.calls.uploads + workflow.calls.deletes + workflow.calls.publications, 0);
});

test('the actual publisher leaves the draft unpublished if a package changes during metadata upload', async t => {
  const f = fixture(t), workflow = await workflowFixture(f, { changeDuringPublish: true });
  await assert.rejects(workflow.execute(), /Uploaded package checksum differs/);
  assert.equal(workflow.calls.publications, 0);
  assert.equal(workflow.release.draft, true);
});
