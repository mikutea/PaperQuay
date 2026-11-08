// Populate @electron/get's normal cache through GitHub's release-asset API.
// npm's pinned Electron package and @electron/get still verify the archive.
const { execFileSync, spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const REPOSITORY = 'electron/electron';

function validateAsset(release, version, name, checksum) {
  if (!release || release.tag_name !== `v${version}` || release.draft !== false || !Array.isArray(release.assets)) {
    throw new Error('UNEXPECTED_ELECTRON_RELEASE');
  }
  const matches = release.assets.filter(asset => asset?.name === name);
  if (matches.length !== 1) throw new Error('MISSING_OR_DUPLICATE_ELECTRON_ASSET');
  const asset = matches[0];
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 || asset.size > 256 * 1024 * 1024 || asset.state !== 'uploaded' ||
      asset.digest !== `sha256:${checksum}`) throw new Error('INVALID_PINNED_ELECTRON_ASSET');
  return asset;
}

async function downloadAsset(asset, destination, env) {
  const child = spawn('gh', ['api', '--hostname', 'github.com',
    `repos/${REPOSITORY}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'],
  { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env });
  const exited = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('GITHUB_CLI_UNAVAILABLE')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('ELECTRON_API_DOWNLOAD_FAILED')));
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180000);
  let size = 0;
  const bounded = new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length;
    done(size > asset.size ? new Error('ELECTRON_DOWNLOAD_EXCEEDS_DECLARED_SIZE') : null, chunk);
  } });
  try {
    await Promise.all([exited, pipeline(child.stdout, bounded, createWriteStream(destination, { flags: 'wx' }))]);
    if (size !== asset.size) throw new Error('ELECTRON_DOWNLOAD_SIZE_MISMATCH');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    if (timedOut) throw new Error('ELECTRON_API_DOWNLOAD_TIMEOUT');
  }
}

async function main() {
  const { version } = require('electron/package.json');
  const lock = require('../../package-lock.json');
  if (lock.packages['node_modules/electron'].version !== version) throw new Error('ELECTRON_LOCK_VERSION_MISMATCH');
  const platform = process.platform;
  const arch = process.arch;
  if (!['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'].includes(`${platform}-${arch}`)) {
    throw new Error('UNSUPPORTED_CI_ELECTRON_TARGET');
  }
  const name = `electron-v${version}-${platform}-${arch}.zip`;
  const checksums = require('electron/checksums.json');
  if (!/^[a-f0-9]{64}$/.test(checksums[name] || '')) throw new Error('PINNED_ELECTRON_CHECKSUM_MISSING');
  const env = { ...process.env, GH_HOST: 'github.com', GH_DEBUG: '' };
  const metadata = JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com',
    `repos/${REPOSITORY}/releases/tags/v${version}`],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true, env }));
  const asset = validateAsset(metadata, version, name, checksums[name]);
  const url = `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`;
  const { downloadArtifact } = require('@electron/get');
  const file = await downloadArtifact({ version, artifactName: 'electron', platform, arch, checksums,
    cacheRoot: process.env.electron_config_cache || undefined,
    mirrorOptions: { resolveAssetURL: async () => url },
    downloader: { async download(requestedURL, destination) {
      if (requestedURL !== url) throw new Error('UNEXPECTED_ELECTRON_DOWNLOAD_URL');
      await downloadAsset(asset, destination, env);
    } },
  });
  console.log(JSON.stringify({ name, bytes: asset.size, sha256: checksums[name], cachePopulated: Boolean(file) }));
}

module.exports = { validateAsset, downloadAsset };
if (require.main === module) main().catch(() => {
  console.error('Pinned Electron API download or checksum verification failed.');
  process.exitCode = 1;
});
