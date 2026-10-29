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

const extractionParent = fs.realpathSync.native(os.tmpdir());
const extractionRoot = fs.mkdtempSync(path.join(extractionParent, 'paperquay-package-smoke-'));

try {
  asar.extractAll(resolvedArchivePath, extractionRoot);

  const pizzipDirectory = path.join(extractionRoot, 'node_modules', 'pizzip', 'js');
  const pakoEntry = require.resolve('pako/dist/pako.es5.min.js', {
    paths: [pizzipDirectory],
  });

  require(pakoEntry);
  require(path.join(pizzipDirectory, 'flate.js'));
  const syncCore = require(path.join(extractionRoot, 'electron', 'generated', 'desktopSyncCore.cjs'));
  for (const name of ['projectDesktopLibrary', 'createDesktopIdentityMap', 'queueLocalCreates', 'preparePush', 'applyPushResults', 'verifyParsedDocument', 'inspectParsedImage']) {
    if (typeof syncCore[name] !== 'function') throw new Error(`Packaged desktop sync core is missing ${name}.`);
  }
  const parsedConverter = require(path.join(extractionRoot, 'electron', 'generated', 'desktopParsedDocument.cjs'));
  if (typeof parsedConverter.createPortableParsedDocument !== 'function') throw new Error('Packaged parsed document converter is missing.');
  const richNoteConverter = require(path.join(extractionRoot, 'electron', 'generated', 'desktopRichNoteArchive.cjs'));
  for (const name of ['createPortableRichNoteArchive', 'snapshotDesktopSavedNote', 'inspectDesktopSavedNote']) {
    if (typeof richNoteConverter[name] !== 'function') throw new Error(`Packaged saved note archive converter is missing ${name}.`);
  }
  for (const file of ['node_modules/pdfjs-dist/legacy/build/pdf.mjs', 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs']) {
    const stat = fs.statSync(path.join(extractionRoot, file));
    if (!stat.isFile() || !stat.size) throw new Error(`Packaged PDF inspection runtime is missing ${file}.`);
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
  const markdownEntries = ['unified', 'remark-parse', 'remark-math'].map((name) => {
    const entry = require.resolve(name, { paths: [extractionRoot] });
    if (!entry.startsWith(`${extractionRoot}${path.sep}`)) throw new Error(`Markdown dependency escaped the package: ${name}.`);
    return require('node:url').pathToFileURL(entry).href;
  });
  const markdownCheck = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const [{unified},{default:parse},{default:math}]=await Promise.all(process.argv.slice(1).map(entry=>import(entry))); const tree=unified().use(parse).use(math).parse("formula $x=1$"); if(!tree.children[0]?.children?.some(node=>node.type==="inlineMath"&&node.value==="x=1"))process.exit(1);',
    ...markdownEntries], { stdio: 'inherit', windowsHide: true });
  if (markdownCheck.error) throw markdownCheck.error;
  if (markdownCheck.status !== 0) throw new Error('Packaged remote vector Markdown runtime failed verification.');
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
  const resolvedExtraction = fs.realpathSync.native(extractionRoot);
  if (path.dirname(resolvedExtraction) !== extractionParent || !path.basename(resolvedExtraction).startsWith('paperquay-package-smoke-')) {
    throw new Error('Refusing to clean an unexpected package verification directory.');
  }
  fs.rmSync(resolvedExtraction, { recursive: true, force: true });
}
