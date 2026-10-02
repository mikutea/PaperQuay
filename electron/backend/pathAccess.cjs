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
    const library = context.store?.load() || { settings: {} };
    const approved = context.validateLibraryFileOperation?.(library, []);
    const storageRoot = approved?.storageRoot || canonicalPath(
      library.settings.storageDir || path.join(appPaths.dataDir, 'paperquay-data'));
    const roots = [dataRoot, storageRoot, ...context.approvedWriteDirectories];
    if (roots.some((root) => isWithin(root, actual)) ||
        [...context.approvedWritePaths].some((target) => comparable(target) === comparable(actual))) return actual;
    throw new Error(`Writing to this path is not allowed until approved: ${filePath}`);
  };
}

module.exports = { canonicalPath, isWithin, assertBoundPath, writeBoundFile, createWriteAuthorizer };
