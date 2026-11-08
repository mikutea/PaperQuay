const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { SPECS, readManifest, mergeUpdateManifests } = require('./mergeUpdateManifests.cjs');

const FORMAT = 'paperquay-release-publication';
const MAX_PROOF_BYTES = 64 * 1024;
const manifestNames = ['stable.yml', 'stable-linux.yml', 'stable-mac.yml'];
const proofName = target => {
  assert.ok(Object.hasOwn(SPECS, target), 'Unknown publication target');
  return `publication-${target}.json`;
};
function packageNames(version, target) {
  const mandatory = SPECS[target].assets.map(suffix => `PaperQuay-${version}-${suffix}`);
  const optional = mandatory.filter(name => /\.(exe|dmg|zip)$/.test(name)).map(name => name + '.blockmap');
  if (target === 'win-x64') mandatory.push('SHA256SUMS.txt');
  return { mandatory, optional };
}
function hashes(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 512 * 1024 ** 2, 'Invalid publication package');
  const sha256 = crypto.createHash('sha256'), sha512 = crypto.createHash('sha512');
  const stream = fs.openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024);
  try {
    let count;
    while ((count = fs.readSync(stream, buffer, 0, buffer.length, null))) {
      sha256.update(buffer.subarray(0, count)); sha512.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(stream); }
  return { size: stat.size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}
function exactFields(object, fields) {
  assert.ok(object && typeof object === 'object' && !Array.isArray(object), 'Invalid publication object');
  assert.deepEqual(Object.keys(object).sort(), [...fields].sort(), 'Unexpected publication fields');
}
function validSha512(value) {
  return typeof value === 'string' && Buffer.from(value, 'base64').length === 64 && Buffer.from(value, 'base64').toString('base64') === value;
}
function createPublicationProof(root, version, target, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const manifest = readManifest(root, version, target, true);
  const { mandatory, optional } = packageNames(version, target);
  const names = [...mandatory, ...optional.filter(name => fs.existsSync(path.join(root, name)))].sort();
  return { format: FORMAT, formatVersion: 1, version, target, commit, manifest,
    packages: names.map(name => ({ name, ...hashes(path.join(root, name)) })) };
}
function oneAsset(assets, name) {
  const matches = assets.filter(asset => asset?.name === name);
  assert.equal(matches.length, 1, 'Missing or duplicate publication asset: ' + name);
  const asset = matches[0];
  assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0 && asset.state === 'uploaded', 'Publication asset is not uploaded');
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && /^sha256:[a-f0-9]{64}$/.test(asset.digest || ''), 'Invalid publication asset digest/size');
  return asset;
}
function decodePublicationProof(asset, bytes) {
  const data = Buffer.from(bytes);
  assert.ok(data.length > 0 && data.length <= MAX_PROOF_BYTES, 'Oversized publication proof');
  assert.equal(data.length, asset.size, 'Publication proof size changed');
  assert.equal('sha256:' + crypto.createHash('sha256').update(data).digest('hex'), asset.digest, 'Publication proof checksum changed');
  return JSON.parse(data.toString('utf8'));
}
function validatePublicationProof(proof, assets, version, target, commit) {
  exactFields(proof, ['format', 'formatVersion', 'version', 'target', 'commit', 'manifest', 'packages']);
  assert.ok(proof.format === FORMAT && proof.formatVersion === 1, 'Unknown publication proof format');
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(proof.version, version, 'Mixed publication versions');
  assert.equal(proof.target, target, 'Wrong publication target');
  assert.equal(proof.commit, commit, 'Wrong publication commit');
  const { mandatory, optional } = packageNames(version, target), allowed = new Set([...mandatory, ...optional]);
  assert.ok(Array.isArray(proof.packages) && proof.packages.length >= mandatory.length && proof.packages.length <= allowed.size, 'Invalid publication package count');
  const packages = new Map();
  for (const item of proof.packages) {
    exactFields(item, ['name', 'size', 'sha256', 'sha512']);
    assert.ok(allowed.has(item.name) && !packages.has(item.name), 'Unsafe or duplicate publication package');
    assert.ok(Number.isSafeInteger(item.size) && item.size > 0 && item.size < 512 * 1024 ** 2, 'Invalid publication package size');
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(validSha512(item.sha512), 'Invalid paired publication checksum');
    const actual = oneAsset(assets, item.name);
    assert.equal(actual.size, item.size, 'Uploaded package size differs from publication proof');
    assert.equal(actual.digest, 'sha256:' + item.sha256, 'Uploaded package checksum differs from publication proof');
    packages.set(item.name, item);
  }
  for (const name of mandatory) assert.ok(packages.has(name), 'Required publication package absent');
  for (const name of optional) if (assets.some(asset => asset?.name === name)) assert.ok(packages.has(name), 'Uploaded blockmap missing from publication proof');
  const manifest = proof.manifest;
  assert.ok(manifest && manifest.version === version && Array.isArray(manifest.files) && manifest.files.length > 0, 'Invalid publication manifest');
  for (const entry of manifest.files) {
    const item = packages.get(entry?.url);
    assert.ok(item, 'Manifest package missing from publication proof');
    assert.equal(entry.size, item.size, 'Manifest size differs from paired package');
    assert.equal(entry.sha512, item.sha512, 'Manifest checksum differs from paired package');
  }
  const primary = manifest.files.find(entry => entry.url === manifest.path);
  assert.ok(primary && primary.sha512 === manifest.sha512, 'Legacy publication checksum differs');
  return proof;
}
function validateAll(proofs, assets, version, commit) {
  assert.ok(Array.isArray(proofs) && proofs.length === Object.keys(SPECS).length, 'Missing publication targets');
  return Object.keys(SPECS).map(target => {
    const matches = proofs.filter(proof => proof?.target === target);
    assert.equal(matches.length, 1, 'Missing or duplicate publication target');
    return validatePublicationProof(matches[0], assets, version, target, commit);
  });
}
function publicationFingerprint(proofs, assets, version, commit) {
  const validated = validateAll(proofs, assets, version, commit);
  const names = new Set(validated.flatMap(proof => [proofName(proof.target), ...proof.packages.map(item => item.name)]));
  assert.ok(assets.every(asset => names.has(asset?.name) || manifestNames.includes(asset?.name)), 'Unexpected release asset outside publication proof');
  return JSON.stringify([...names].sort().map(name => {
    const asset = oneAsset(assets, name);
    return { id: asset.id, name, size: asset.size, digest: asset.digest, state: asset.state };
  }));
}
function prepareReleaseManifests(proofs, assets, version, commit, inputRoot, outputRoot) {
  const validated = validateAll(proofs, assets, version, commit);
  fs.mkdirSync(inputRoot);
  for (const proof of validated) {
    const directory = path.join(inputRoot, SPECS[proof.target].directory);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, SPECS[proof.target].manifest), yaml.dump(proof.manifest, { lineWidth: -1, noRefs: true }), { flag: 'wx' });
  }
  // Reuse the full metadata validation and Mac architecture merge before writing.
  return mergeUpdateManifests(inputRoot, outputRoot, version);
}
function assertDraftIdentity(release, releaseId, tag, commit) {
  assert.ok(release.id === releaseId && release.draft === true && release.tag_name === tag && release.target_commitish === commit,
    'Release must remain the expected draft; published assets are never replaced');
}
module.exports = { SPECS, manifestNames, proofName, createPublicationProof, decodePublicationProof,
  validatePublicationProof, publicationFingerprint, prepareReleaseManifests, assertDraftIdentity,
  getPublicationAsset: oneAsset, MAX_PROOF_BYTES };
if (require.main === module) {
  const [root, version, target, commit] = process.argv.slice(2);
  const proof = createPublicationProof(root, version, target, commit);
  fs.writeFileSync(path.join(root, proofName(target)), JSON.stringify(proof, null, 2), { flag: 'wx' });
  console.log(`Verified publication proof created for ${target}.`);
}
