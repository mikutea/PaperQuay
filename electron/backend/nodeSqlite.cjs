function requireNodeSqlite() {
  const originalEmitWarning = process.emitWarning;

  process.emitWarning = function emitWarningExceptNodeSqlite(warning, ...args) {
    const message = typeof warning === 'string' ? warning : warning?.message;
    const warningType = typeof args[0] === 'string' ? args[0] : args[0]?.type;

    if (
      warningType === 'ExperimentalWarning' &&
      typeof message === 'string' &&
      message.includes('SQLite is an experimental feature')
    ) {
      return;
    }

    return originalEmitWarning.call(process, warning, ...args);
  };

  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const sqlite = requireNodeSqlite();
let boundary;

function nativeBoundary() {
  if (boundary) return boundary;
  const modulePath = path.join(__dirname, '..', 'native', 'bin', `${process.platform}-${process.arch}`, 'paperquay_fs.node');
  const binding = require(modulePath);
  const bootstrap = new sqlite.DatabaseSync(':memory:', { allowExtension: true });
  // SQLite's OS loader does not understand Electron's virtual ASAR paths.
  const loadablePath = modulePath.replace(/\.asar([\\/])/g, '.asar.unpacked$1');
  try { bootstrap.loadExtension(loadablePath); }
  finally { bootstrap.close(); }
  boundary = binding;
  return boundary;
}

function databasePath(value) {
  if (value === ':memory:' || value === '') return null;
  const input = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof input !== 'string' || input.includes('\0') || input.startsWith('file:')) throw new TypeError('A local SQLite file path is required.');
  return path.resolve(input);
}

function databaseUri(file) {
  // Four slashes preserve Windows UNC paths without a URI authority. SQLite
  // decodes the path but does not get to choose an unpinned VFS from input.
  const normalized = file.replace(/\\/g, '/');
  const uriPath = process.platform === 'win32' && normalized.startsWith('//') ? '//' + normalized : normalized;
  return 'file:' + encodeURI(uriPath).replace(/[?#]/g, encodeURIComponent) + '?vfs=paperquay-pinned';
}

function pinDatabase(file, readOnly = false) {
  const binding = nativeBoundary();
  if (!readOnly) require('./nativeFs.cjs').mkdirSync(path.dirname(file));
  return binding.sqlitePin(file);
}

class DatabaseSync extends sqlite.DatabaseSync {
  #file;
  #lease;
  #readOnly;

  constructor(value, options = {}) {
    const file = databasePath(value);
    const lease = file && options.open !== false ? pinDatabase(file, options.readOnly) : null;
    try { super(file ? databaseUri(file) : value, options); }
    catch (error) { if (lease) nativeBoundary().sqliteRelease(lease); throw error; }
    this.#file = file;
    this.#lease = lease;
    this.#readOnly = options.readOnly;
  }

  open() {
    if (this.isOpen) return super.open();
    const lease = this.#file ? pinDatabase(this.#file, this.#readOnly) : null;
    try { super.open(); this.#lease = lease; }
    catch (error) { if (lease) nativeBoundary().sqliteRelease(lease); throw error; }
  }

  close() {
    super.close();
    if (this.#lease) { nativeBoundary().sqliteRelease(this.#lease); this.#lease = null; }
  }
}

function withPinnedDatabasePath(value, callback) {
  const file = databasePath(value);
  if (!file) throw new TypeError('A local SQLite file path is required.');
  const lease = pinDatabase(file);
  try { return callback(file); }
  finally { nativeBoundary().sqliteRelease(lease); }
}

function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function vacuumInto(db, targetPath) {
  return withPinnedDatabasePath(targetPath, (file) => {
    try { require('./nativeFs.cjs').removeSync(file, { singleLink: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    db.exec(`VACUUM main INTO ${sqlStringLiteral(file)}`);
    return targetPath;
  });
}

function withTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

module.exports = {
  ...sqlite,
  DatabaseSync,
  withPinnedDatabasePath,
  vacuumInto,
  sqlStringLiteral,
  withTransaction,
};
