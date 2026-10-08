const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const nativeFs = require('./nativeFs.cjs');
const { DatabaseSync } = require('./nodeSqlite.cjs');

const identifier = (value) => `"${value.replace(/"/g, '""')}"`;

// Never replace/reopen a live database by pathname in a supplier-writable
// directory. Migrate a private source copy, then restore through the existing
// destination connection. Any failed transaction leaves that connection usable.
async function withSnapshotDatabase(snapshotPath, openDatabase, restore, requiredTables) {
  const directory = await fsp.mkdtemp(path.join(fs.realpathSync.native(os.tmpdir()), 'paperquay-db-restore-'));
  let source;
  try {
    const privatePath = path.join(directory, 'snapshot.sqlite');
    await nativeFs.copy(snapshotPath, privatePath, { exclusive: true });
    // A normal store opener creates missing schemas. Check the original input
    // read-only first, or empty/arbitrary SQLite files would erase live data.
    const fd = fs.openSync(privatePath, 'r');
    const header = Buffer.alloc(16);
    try { fs.readSync(fd, header, 0, header.length, 0); }
    finally { fs.closeSync(fd); }
    if (!header.equals(Buffer.from('SQLite format 3\0'))) throw new Error('Invalid database snapshot header.');
    const original = new DatabaseSync(privatePath, { readOnly: true });
    try {
      const tables = new Set(original.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name));
      if (requiredTables.some(name => !tables.has(name))) throw new Error('Invalid database snapshot schema.');
    } finally { original.close(); }
    source = openDatabase(privatePath);
    const check = source.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok' || source.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('Invalid database snapshot.');
    }
    return restore(source);
  } finally {
    if (source?.isOpen) source.close();
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

function assertSnapshotTables(source, names, target) {
  for (const pragma of ['user_version', 'application_id']) {
    if (Object.values(source.prepare(`PRAGMA ${pragma}`).get())[0] !== Object.values(target.prepare(`PRAGMA ${pragma}`).get())[0]) {
      throw new Error(`Unsupported snapshot ${pragma}.`);
    }
  }
  const allowed = new Set(names);
  for (const table of source.prepare('PRAGMA table_list').all()) {
    if (table.schema !== 'main' || table.name.startsWith('sqlite_') || table.type === 'shadow') continue;
    if (!allowed.has(table.name)) throw new Error(`Unsupported snapshot table: ${table.name}`);
  }
  if (source.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('view', 'trigger') LIMIT 1").get()) {
    throw new Error('Unsupported snapshot views or triggers.');
  }
}

function copyTable(target, source, name, columns) {
  const table = identifier(name);
  const targetColumns = target.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  const sourceColumns = source.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (sourceColumns.length !== targetColumns.length || sourceColumns.some(column => !targetColumns.includes(column))) {
    throw new Error(`Unsupported snapshot columns: ${name}`);
  }
  columns ||= targetColumns;
  const projection = columns.map(identifier).join(', ');
  const rows = source.prepare(`SELECT ${projection} FROM ${table}`);
  rows.setReadBigInts(true);
  const insert = target.prepare(`INSERT INTO ${table} (${projection}) VALUES (${columns.map(() => '?').join(', ')})`);
  for (const row of rows.iterate()) insert.run(...columns.map(column => row[column]));
}

function replaceTables(target, source, names) {
  // Deferral preserves cross-row links regardless of source row ordering.
  target.exec('PRAGMA defer_foreign_keys = ON');
  for (const name of [...names].reverse()) target.exec(`DELETE FROM ${identifier(name)}`);
  for (const name of names) copyTable(target, source, name);
}

module.exports = { withSnapshotDatabase, assertSnapshotTables, copyTable, replaceTables };
