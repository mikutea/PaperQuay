const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const SPECS = {
  'win-x64': { directory: 'paperquay-update-Windows x64', manifest: 'stable.yml', suffixes: ['win-x64.exe'], assets: ['win-x64.exe', 'win-x64.msi', 'win-x64-portable.zip'] },
  'linux-x64': { directory: 'paperquay-update-Linux x64', manifest: 'stable-linux.yml', suffixes: ['linux-x86_64.AppImage', 'linux-amd64.deb', 'linux-x64.tar.gz'], assets: ['linux-x86_64.AppImage', 'linux-amd64.deb', 'linux-x64.tar.gz'] },
  'mac-x64': { directory: 'paperquay-update-macOS x64', manifest: 'stable-mac.yml', suffixes: ['mac-x64.dmg', 'mac-x64.zip'], assets: ['mac-x64.dmg', 'mac-x64.zip'] },
  'mac-arm64': { directory: 'paperquay-update-macOS arm64', manifest: 'stable-mac.yml', suffixes: ['mac-arm64.dmg', 'mac-arm64.zip'], assets: ['mac-arm64.dmg', 'mac-arm64.zip'] },
};
const fields = new Set(['version', 'files', 'path', 'sha512', 'releaseDate', 'releaseName', 'releaseNotes', 'stagingPercentage', 'minimumSystemVersion', 'isAdminRightsRequired']);

function regularFile(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 512 * 1024 ** 2, 'Invalid package file');
  return stat;
}

function sha512(file) {
  const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha512'), buffer = Buffer.alloc(64 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return hash.digest('base64');
}

function readManifest(root, version, target, verifyPackages = false) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/);
  const spec = SPECS[target]; assert.ok(spec, 'Unknown update target');
  const file = path.join(root, spec.manifest);
  assert.ok(regularFile(file).size <= 64 * 1024, 'Oversized update manifest');
  const data = yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA });
  assert.ok(data && typeof data === 'object' && !Array.isArray(data), 'Invalid update manifest');
  assert.ok(Object.keys(data).every(key => fields.has(key)), 'Unknown update metadata field');
  assert.equal(data.version, version, 'Mixed release versions');
  assert.ok(typeof data.releaseDate === 'string' && Number.isFinite(Date.parse(data.releaseDate)), 'Invalid release date');
  assert.ok(Array.isArray(data.files) && data.files.length > 0 && data.files.length <= spec.suffixes.length, 'Invalid update file list');
  const prefix = `PaperQuay-${version}-`, allowed = new Set(spec.suffixes.map(suffix => prefix + suffix)), seen = new Set();
  for (const entry of data.files) {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid update file');
    assert.ok(Object.keys(entry).every(key => ['url', 'sha512', 'size', 'blockMapSize'].includes(key)), 'Unknown update file field');
    assert.ok(allowed.has(entry.url) && !seen.has(entry.url), 'Unsafe, duplicate or wrong-architecture update URL');
    seen.add(entry.url);
    assert.ok(typeof entry.sha512 === 'string' && Buffer.from(entry.sha512, 'base64').length === 64
      && Buffer.from(entry.sha512, 'base64').toString('base64') === entry.sha512, 'Invalid update checksum');
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size < 512 * 1024 ** 2, 'Invalid update file size');
    if (entry.blockMapSize !== undefined) assert.ok(Number.isSafeInteger(entry.blockMapSize) && entry.blockMapSize > 0 && entry.blockMapSize <= entry.size, 'Invalid blockmap size');
    if (verifyPackages) {
      const packageFile = path.join(root, entry.url);
      assert.equal(regularFile(packageFile).size, entry.size, 'Package size differs from manifest');
      assert.equal(sha512(packageFile), entry.sha512, 'Package checksum differs from manifest');
    }
  }
  const primary = data.files.find(entry => entry.url === data.path);
  assert.ok(primary && primary.sha512 === data.sha512, 'Legacy update path/checksum differs from file list');
  const updateSuffix = target.startsWith('mac-') ? `mac-${target.slice(4)}.zip` : spec.suffixes[0];
  assert.ok(seen.has(prefix + updateSuffix), 'Required automatic update package is absent');
  if (verifyPackages) for (const suffix of spec.assets) regularFile(path.join(root, prefix + suffix));
  return data;
}

function mergeUpdateManifests(inputRoot, outputRoot, version) {
  const sources = Object.fromEntries(Object.entries(SPECS).map(([target, spec]) => [target, readManifest(path.join(inputRoot, spec.directory), version, target)]));
  const intel = sources['mac-x64'], arm = sources['mac-arm64'];
  for (const key of ['releaseName', 'releaseNotes', 'stagingPercentage', 'minimumSystemVersion']) {
    assert.equal(JSON.stringify(intel[key]), JSON.stringify(arm[key]), `Conflicting macOS ${key}`);
  }
  const files = [...intel.files, ...arm.files];
  assert.equal(new Set(files.map(file => file.url)).size, files.length, 'Duplicate macOS update files');
  const primary = files.find(file => file.url === `PaperQuay-${version}-mac-x64.zip`);
  const mac = { ...intel, files, path: primary.url, sha512: primary.sha512,
    releaseDate: new Date(Math.max(Date.parse(intel.releaseDate), Date.parse(arm.releaseDate))).toISOString() };
  const manifests = { 'stable.yml': sources['win-x64'], 'stable-linux.yml': sources['linux-x64'], 'stable-mac.yml': mac };
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const [name, data] of Object.entries(manifests)) {
    fs.writeFileSync(path.join(outputRoot, name), yaml.dump(data, { lineWidth: -1, noRefs: true }), { flag: 'wx' });
  }
  return manifests;
}

module.exports = { SPECS, readManifest, mergeUpdateManifests };
if (require.main === module) {
  const [mode, input, arg, targetOrVersion] = process.argv.slice(2);
  if (mode === 'verify') readManifest(input, arg, targetOrVersion, true);
  else if (mode === 'merge') mergeUpdateManifests(input, arg, targetOrVersion);
  else throw new Error('Use verify <packages> <version> <target> or merge <input> <output> <version>');
  console.log(`Update metadata ${mode} passed.`);
}
