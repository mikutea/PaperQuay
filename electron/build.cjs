const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const DEFAULT_ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
const DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const buildArgs = process.argv.slice(2);
// Native modules are target-specific even though Node-API removes the Node /
// Electron ABI distinction. Build on the target OS; do not package a stale DLL.
const requestedArch = buildArgs.includes('--arm64') ? 'arm64' : buildArgs.includes('--x64') ? 'x64' : process.arch;
if ((buildArgs.some((arg) => ['--win', '-w', '--windows'].includes(arg)) && process.platform !== 'win32') ||
    (buildArgs.some((arg) => ['--mac', '-m', '--macos'].includes(arg)) && process.platform !== 'darwin') ||
    (buildArgs.some((arg) => ['--linux', '-l'].includes(arg)) && process.platform !== 'linux')) {
  throw new Error('Build the native filesystem module on the target operating system.');
}
const native = spawnSync(process.execPath, [path.join(__dirname, 'native', 'build.cjs'), `--arch=${requestedArch}`], {
  stdio: 'inherit', windowsHide: true,
});
if (native.error) throw native.error;
if (native.status !== 0) process.exit(native.status || 1);
const hasTarget = (targets) =>
  buildArgs.some((arg) => targets.some((target) => arg === target || arg.startsWith(`${target}=`)));
const isMacOnlyBuild = hasTarget(['-m', '--mac', '--macos']) && !hasTarget(['-w', '--win', '--windows', '-l', '--linux']);
const shouldUseDefaultMirrors = !isMacOnlyBuild;

const mirrorEnv = {
  CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false',
};

function setMirrorEnv(primaryName, npmConfigName, defaultValue) {
  const value = process.env[primaryName] || process.env[npmConfigName] || (shouldUseDefaultMirrors ? defaultValue : '');
  if (!value) return;

  mirrorEnv[primaryName] = value;
  mirrorEnv[npmConfigName] = value;
}

setMirrorEnv('ELECTRON_MIRROR', 'npm_config_electron_mirror', DEFAULT_ELECTRON_MIRROR);
setMirrorEnv(
  'ELECTRON_BUILDER_BINARIES_MIRROR',
  'npm_config_electron_builder_binaries_mirror',
  DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR,
);

function withNoDeprecationWarning(nodeOptions) {
  const value = (nodeOptions || '').trim();

  if (value.split(/\s+/).includes('--no-deprecation')) {
    return value;
  }

  return `${value} --no-deprecation`.trim();
}

const env = {
  ...process.env,
  ...mirrorEnv,
  NODE_OPTIONS: withNoDeprecationWarning(process.env.NODE_OPTIONS),
};

const child = spawn(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
