const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { spawnSync } = require('node:child_process');

const archivePath = process.argv[2];

if (!archivePath) {
  throw new Error('Usage: node electron/verifyPackagedApp.cjs <path-to-app.asar>');
}

const resolvedArchivePath = path.resolve(archivePath);
if (!fs.existsSync(resolvedArchivePath)) {
  throw new Error(`Packaged app archive not found: ${resolvedArchivePath}`);
}

const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-package-smoke-'));

try {
  asar.extractAll(resolvedArchivePath, extractionRoot);

  const pizzipDirectory = path.join(extractionRoot, 'node_modules', 'pizzip', 'js');
  const pakoEntry = require.resolve('pako/dist/pako.es5.min.js', {
    paths: [pizzipDirectory],
  });

  require(pakoEntry);
  require(path.join(pizzipDirectory, 'flate.js'));
  const nativeCheck = spawnSync(process.execPath, [path.join(__dirname, 'native', 'smoke.cjs'), extractionRoot], {
    stdio: 'inherit', windowsHide: true,
  });
  if (nativeCheck.error) throw nativeCheck.error;
  if (nativeCheck.status !== 0) throw new Error('Packaged native filesystem module failed Electron verification.');

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(extractionRoot, 'package.json'), 'utf8'),
  );

  process.stdout.write(
    `Packaged PaperQuay ${packageJson.version} resolved pizzip and pako successfully.\n`,
  );
} finally {
  fs.rmSync(extractionRoot, { recursive: true, force: true });
}
