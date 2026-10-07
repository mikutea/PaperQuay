const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function comparable(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Resolve existing ancestors, including Windows junctions and 8.3 spellings.
// lstat deliberately distinguishes a dangling link from an absent directory.
function canonicalPath(filePath) {
  let parent = path.resolve(filePath);
  const suffix = [];
  for (;;) {
    try { fs.lstatSync(parent); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error;
      suffix.unshift(path.basename(parent)); parent = path.dirname(parent);
    }
  }
  return path.join(fs.realpathSync.native(parent), ...suffix);
}

function isWithin(root, target) {
  const relative = path.relative(comparable(root), comparable(target));
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function assertBoundPath(target) {
  if (comparable(canonicalPath(target)) !== comparable(target)) {
    throw new Error('Approved write path changed before use.');
  }
  return target;
}

async function writeBoundFile(target, bytes, options) {
  assertBoundPath(target);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  assertBoundPath(target);
  await fsp.writeFile(target, bytes, options);
}

async function openAuthorizedReadFile(filePath, authorize) {
  const actual = canonicalPath(filePath);
  const expected = fs.lstatSync(actual, { bigint: true });
  if (!expected.isFile()) throw Object.assign(new Error('Read path is not a file.'), { code: 'EISDIR' });
  await authorize?.(actual);
  const handle = await fsp.open(actual, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    assertBoundPath(actual);
    const current = fs.lstatSync(actual, { bigint: true });
    if (!opened.isFile() || !current.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino ||
        opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('Approved read file changed before use.');
    }
    return { handle, actual, stat: await handle.stat() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readAuthorizedFile(filePath, authorize, options) {
  const { handle } = await openAuthorizedReadFile(filePath, authorize);
  try { return await handle.readFile(options); }
  finally { await handle.close(); }
}

function createWriteAuthorizer(context) {
  const { appPaths } = context;
  const dataRoot = canonicalPath(appPaths.dataDir);
  const configPath = appPaths.configPath && canonicalPath(appPaths.configPath);
  context.approvedWritePaths ??= new Set();
  context.approvedWriteDirectories ??= new Set();
  return (filePath) => {
    const actual = canonicalPath(filePath);
    // Only the actual config command path gets this exception, not an alias
    // planted in an adopted library that happens to resolve to the config.
    if (configPath && comparable(filePath) === comparable(appPaths.configPath) &&
        comparable(actual) === comparable(configPath)) return actual;
    // Profile-local settings/cache operations do not depend on an unrelated
    // PDF storage volume being online. These canonical roots are pinned when
    // the backend is created or explicitly approved, not taken from SQLite.
    const independentRoots = [dataRoot, ...context.approvedWriteDirectories];
    if (independentRoots.some((root) => isWithin(root, actual)) ||
        [...context.approvedWritePaths].some((target) => comparable(target) === comparable(actual))) return actual;
    const library = context.store?.load() || { settings: {} };
    const approved = context.validateLibraryFileOperation?.(library, []);
    const storageRoot = approved?.storageRoot || canonicalPath(
      library.settings.storageDir || path.join(appPaths.dataDir, 'paperquay-data'));
    if (isWithin(storageRoot, actual)) return actual;
    throw new Error(`Writing to this path is not allowed until approved: ${filePath}`);
  };
}

module.exports = { canonicalPath, isWithin, assertBoundPath, writeBoundFile, createWriteAuthorizer, openAuthorizedReadFile, readAuthorizedFile };
