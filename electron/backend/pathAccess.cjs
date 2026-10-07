const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const nativeFs = require('./nativeFs.cjs');

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
  const inspected = nativeFs.inspectSync(target);
  if (inspected.linkPath || comparable(inspected.actual) !== comparable(target)) {
    throw new Error('Approved write path changed before use.');
  }
  return target;
}

async function writeBoundFile(target, bytes, options) {
  const settings = typeof options === 'string' ? { encoding: options } : options || {};
  if (settings.flag && !['w', 'wx'].includes(settings.flag)) throw new Error('Unsupported bound write mode.');
  return nativeFs.write(target, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, settings.encoding || 'utf8'),
    { exclusive: settings.flag === 'wx', mode: settings.mode ?? 0o666 });
}

async function openAuthorizedReadFile(filePath, authorize) {
  // Raw authorization must precede *every* filesystem probe: realpath/lstat
  // can themselves contact an unapproved SMB host. Honor the approved mapping.
  const authorized = await authorize?.(filePath);
  const actual = typeof authorized === 'string' ? authorized : filePath;
  const opened = await nativeFs.openRead(actual);
  let descriptor = opened.fd;
  const handle = {
    identity: opened.identity,
    version: opened.version,
    stat: (options) => promisify(fs.fstat)(descriptor, options),
    readFile: (options) => promisify(fs.readFile)(descriptor, options),
    close: async () => { if (descriptor < 0) return; const closing = descriptor; descriptor = -1; await promisify(fs.close)(closing); },
    createReadStream(options = {}) {
      const stream = fs.createReadStream(null, { ...options, fd: descriptor });
      if (options.autoClose !== false) stream.once('close', () => { descriptor = -1; });
      return stream;
    },
  };
  try {
    const current = nativeFs.inspectSync(actual);
    if (current.linkPath || !current.exists || current.identity !== opened.identity) {
      throw new Error('Approved read file changed before use.');
    }
    return { handle, actual, stat: await handle.stat() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function removeBoundFile(target, { force = false, expectedIdentity, expectedVersion } = {}) {
  try { return await nativeFs.remove(target, { expectedIdentity, expectedVersion }); }
  catch (error) { if (!force || error.code !== 'ENOENT') throw error; }
}

// Resolve links one at a time without following them. The predicate checks the
// complete substituted target before its root/ancestors can cause network I/O.
function resolveAuthorizedPath(filePath, allowed) {
  let current = path.resolve(filePath);
  for (let redirects = 0; redirects < 40; redirects++) {
    if (!allowed(current)) throw new Error('Library file access settings changed; path is not approved and not allowed.');
    const inspected = nativeFs.inspectSync(current);
    if (!inspected.linkPath) return inspected.actual;
    current = path.resolve(path.dirname(inspected.linkPath), inspected.target, inspected.suffix);
  }
  throw new Error('Too many filesystem links.');
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
  context.approvedWriteAliases ??= new Map();
  return (filePath) => {
    const alias = [...context.approvedWriteAliases.values()].sort((a, b) => b.raw.length - a.raw.length)
      .find((item) => item.directory ? isWithin(item.raw, filePath) : comparable(item.raw) === comparable(filePath));
    if (alias) filePath = alias.directory ? path.join(alias.actual, path.relative(alias.raw, filePath)) : alias.actual;
    // Only the actual config command path gets this exception, not an alias
    // planted in an adopted library that happens to resolve to the config.
    if (configPath && comparable(filePath) === comparable(appPaths.configPath)) return assertBoundPath(configPath);
    // Profile-local settings/cache operations do not depend on an unrelated
    // PDF storage volume being online. These canonical roots are pinned when
    // the backend is created or explicitly approved, not taken from SQLite.
    const independentRoots = [dataRoot, ...context.approvedWriteDirectories];
    const allowedIndependent = (target) => independentRoots.some((root) => isWithin(root, target)) ||
      [...context.approvedWritePaths].some((approved) => comparable(approved) === comparable(target));
    if (allowedIndependent(filePath)) return resolveAuthorizedPath(filePath, allowedIndependent);
    const library = context.store?.load() || { settings: {} };
    const approved = context.validateLibraryFileOperation?.(library, []);
    const storageRoot = approved?.storageRoot || canonicalPath(
      library.settings.storageDir || path.join(appPaths.dataDir, 'paperquay-data'));
    const storageDirectory = library.settings.storageDir || path.join(appPaths.dataDir, 'paperquay-data');
    const mapped = isWithin(storageDirectory, filePath) ? path.join(storageRoot, path.relative(storageDirectory, filePath)) : filePath;
    if (isWithin(storageRoot, mapped)) return resolveAuthorizedPath(mapped, (target) => isWithin(storageRoot, target));
    throw new Error(`Writing to this path is not allowed until approved: ${filePath}`);
  };
}

module.exports = { canonicalPath, isWithin, assertBoundPath, writeBoundFile, removeBoundFile, resolveAuthorizedPath,
  createWriteAuthorizer, openAuthorizedReadFile, readAuthorizedFile };
