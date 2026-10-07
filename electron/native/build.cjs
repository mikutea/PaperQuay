const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const arch = process.argv.find((arg) => arg.startsWith('--arch='))?.slice(7) || process.arch;
if (!['win32', 'linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error(`Unsupported native filesystem target: ${process.platform}-${arch}`);
}
const result = spawnSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', `--arch=${arch}`], {
  cwd: __dirname, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const destination = path.join(__dirname, 'bin', `${process.platform}-${arch}`);
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'build', 'Release', 'paperquay_fs.node'), path.join(destination, 'paperquay_fs.node'));
