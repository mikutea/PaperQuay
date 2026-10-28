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
  const syncCore = require(path.join(extractionRoot, 'electron', 'generated', 'desktopSyncCore.cjs'));
  for (const name of ['projectDesktopLibrary', 'createDesktopIdentityMap', 'queueLocalCreates', 'preparePush', 'applyPushResults']) {
    if (typeof syncCore[name] !== 'function') throw new Error(`Packaged desktop sync core is missing ${name}.`);
  }
  for (const file of ['backend/desktopPeerHost.cjs', 'desktopPeerPreload.cjs', 'desktopPeer.html', 'appWindowLifecycle.cjs']) {
    const stat = fs.statSync(path.join(extractionRoot, 'electron', file));
    if (!stat.isFile() || !stat.size) throw new Error(`Packaged direct transfer runtime is missing ${file}.`);
  }
  if (typeof require(path.join(extractionRoot, 'electron', 'backend', 'desktopPeerHost.cjs')).createDesktopPeerHost !== 'function') {
    throw new Error('Packaged direct transfer host failed verification.');
  }
  const oidcEntry = require.resolve('openid-client', { paths: [extractionRoot] });
  if (!oidcEntry.startsWith(`${extractionRoot}${path.sep}`)) throw new Error('OIDC dependency escaped the package.');
  const oidcCheck = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const client = await import(process.argv[1]); if (typeof client.authorizationCodeGrant !== "function" || typeof client.enableNonRepudiationChecks !== "function") process.exit(1);',
    require('node:url').pathToFileURL(oidcEntry).href], { stdio: 'inherit', windowsHide: true });
  if (oidcCheck.error) throw oidcCheck.error;
  if (oidcCheck.status !== 0) throw new Error('Packaged OIDC runtime dependencies failed verification.');
  const nativeCheck = spawnSync(process.execPath, [path.join(__dirname, 'native', 'smoke.cjs'), extractionRoot], {
    stdio: 'inherit', windowsHide: true,
  });
  if (nativeCheck.error) throw nativeCheck.error;
  if (nativeCheck.status !== 0) throw new Error('Packaged native filesystem module failed Electron verification.');

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(extractionRoot, 'package.json'), 'utf8'),
  );

  process.stdout.write(
    `Packaged PaperQuay ${packageJson.version} resolved document, desktop sync, and OIDC dependencies successfully.\n`,
  );
} finally {
  fs.rmSync(extractionRoot, { recursive: true, force: true });
}
