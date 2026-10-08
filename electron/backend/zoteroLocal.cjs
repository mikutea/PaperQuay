const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nativeFs = require('./nativeFs.cjs');
const { readAuthorizedFile } = require('./pathAccess.cjs');
const { cleanString } = require('./utils.cjs');
const { yearFromDate } = require('./zoteroApi.cjs');

let sqlModulePromise = null;

function getSqlModule() {
  if (!sqlModulePromise) {
    const initSqlJs = require('sql.js');
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    sqlModulePromise = initSqlJs({
      locateFile: (file) => file.endsWith('.wasm') ? wasmPath : file,
    });
  }

  return sqlModulePromise;
}

function isReadableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function candidateLocalZoteroDirs() {
  const candidates = [];
  const home = os.homedir();

  if (home) candidates.push(path.join(home, 'Zotero'));
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, 'Zotero'));

  const appDataProfiles = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Zotero', 'Zotero', 'Profiles')
    : '';
  const macProfiles = home
    ? path.join(home, 'Library', 'Application Support', 'Zotero', 'Profiles')
    : '';

  for (const profilesDir of [appDataProfiles, macProfiles]) {
    if (!profilesDir) continue;
    try {
      for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(profilesDir, entry.name));
      }
    } catch {}
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function candidateLocalZoteroProfileDirs() {
  const home = os.homedir();
  const appDataProfiles = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Zotero', 'Zotero', 'Profiles')
    : '';
  const macProfiles = home
    ? path.join(home, 'Library', 'Application Support', 'Zotero', 'Profiles')
    : '';
  const candidates = [];

  for (const profilesDir of [appDataProfiles, macProfiles]) {
    if (!profilesDir) continue;
    try {
      for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(profilesDir, entry.name));
      }
    } catch {}
  }

  return candidates;
}

function resolveLocalZoteroDataDir(input) {
  const requested = cleanString(input);
  if (requested) {
    return path.resolve(requested);
  }

  const detected = candidateLocalZoteroDirs().find((candidate) =>
    isReadableFile(path.join(candidate, 'zotero.sqlite')),
  );
  if (!detected) throw new Error('No local Zotero data directory was found');

  return detected;
}

function samePath(left, right) {
  if (!left || !right) return false;
  try {
    return path.resolve(left) === path.resolve(right);
  } catch {
    return false;
  }
}

function decodePrefsString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function readZoteroPreference(filePath, prefName) {
  let text = '';
  try {
    text = nativeFs.readSync(filePath, { singleLink: true }).bytes.toString('utf8');
  } catch {
    return '';
  }

  const escapedName = prefName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:user_)?pref\\(\\s*"${escapedName}"\\s*,\\s*"((?:\\\\.|[^"\\\\])*)"\\s*\\)`,
  );
  const match = text.match(pattern);
  return match ? cleanString(decodePrefsString(match[1])) : '';
}

function expandHomePath(value) {
  const raw = cleanString(value);
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function defaultZoteroDataDirs() {
  const home = os.homedir();
  return [
    home ? path.join(home, 'Zotero') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Zotero') : '',
  ].filter(Boolean);
}

function zoteroPreferenceFiles(dataDir) {
  const files = [path.join(dataDir, 'prefs.js')];
  for (const profileDir of candidateLocalZoteroProfileDirs()) {
    files.push(path.join(profileDir, 'prefs.js'));
  }

  const seen = new Set();
  return files.filter((filePath) => {
    const normalized = path.resolve(filePath);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function readBaseAttachmentPath(dataDir) {
  const candidates = [];
  const defaultDataDir = defaultZoteroDataDirs().some((candidate) => samePath(candidate, dataDir));

  for (const prefsFile of zoteroPreferenceFiles(dataDir)) {
    const basePath = expandHomePath(readZoteroPreference(prefsFile, 'extensions.zotero.baseAttachmentPath'));
    if (!basePath) continue;

    const configuredDataDir = expandHomePath(readZoteroPreference(prefsFile, 'extensions.zotero.dataDir'));
    const matchesDataDir = configuredDataDir
      ? samePath(configuredDataDir, dataDir)
      : defaultDataDir || samePath(path.dirname(prefsFile), dataDir);
    candidates.push({ basePath, matchesDataDir });
  }

  return candidates.find((candidate) => candidate.matchesDataDir)?.basePath
    ?? candidates[0]?.basePath
    ?? '';
}

async function withLocalZoteroDatabase(dataDirInput, callback) {
  const dataDir = resolveLocalZoteroDataDir(dataDirInput);
  const source = path.join(dataDir, 'zotero.sqlite');
  const SQL = await getSqlModule();
  const bytes = (await nativeFs.read(source, { singleLink: true })).bytes;
  const db = new SQL.Database(bytes);
  const baseAttachmentPath = readBaseAttachmentPath(dataDir);

  try {
    return await callback(db, dataDir, baseAttachmentPath);
  } finally {
    db.close();
  }
}

function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  const output = [];

  try {
    statement.bind(params);
    while (statement.step()) {
      output.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }

  return output;
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] ?? null;
}

function normalizeLimit(value) {
  if (value == null || value === 0) return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  return Math.max(1, Math.min(10000, Math.floor(numeric)));
}

function withOptionalLimit(sql, limit) {
  return limit == null
    ? { sql, params: [] }
    : { sql: `${sql}\n      limit ?`, params: [limit] };
}

function localFieldValue(db, itemId, fieldName) {
  return one(db, `
    select idv.value as value
    from itemData id
    join fields f on f.fieldID = id.fieldID
    join itemDataValues idv on idv.valueID = id.valueID
    where id.itemID = ? and f.fieldName = ?
    limit 1
  `, [itemId, fieldName])?.value ?? null;
}

function localCreatorSummary(db, itemId) {
  const names = rows(db, `
    select coalesce(c.firstName, '') as firstName, coalesce(c.lastName, '') as lastName
    from itemCreators ic
    join creators c on c.creatorID = ic.creatorID
    where ic.itemID = ?
    order by ic.orderIndex asc
  `, [itemId])
    .map((row) => [row.firstName, row.lastName].map(cleanString).filter(Boolean).join(' '))
    .filter(Boolean);

  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(', ');
  return `${names[0]} et al.`;
}

function resolveLocalAttachmentPath(dataDir, attachmentKey, rawPath, baseAttachmentPath = '') {
  const raw = cleanString(rawPath);
  if (!raw) return undefined;

  let candidate;
  const safeRelative = (value) => value && !/^[\\/]|^[a-z]:/i.test(value) &&
    !value.split(/[\\/]/).some((part) => part === '..' || part === '.' || !part) && !value.includes('\0');

  if (raw.startsWith('storage:')) {
    const suffix = raw.slice('storage:'.length);
    if (!/^[a-z0-9_-]+$/i.test(attachmentKey) || !safeRelative(suffix)) return undefined;
    candidate = path.join(dataDir, 'storage', attachmentKey, suffix);
  } else if (raw.startsWith('attachments:')) {
    const relativePath = raw.slice('attachments:'.length);
    if (!safeRelative(relativePath)) return undefined;
    candidate = baseAttachmentPath ? path.join(baseAttachmentPath, relativePath) : '';
  } else {
    if (!path.isAbsolute(raw) && !safeRelative(raw)) return undefined;
    candidate = path.isAbsolute(raw) ? raw : path.join(dataDir, raw);
  }

  // SQLite/prefs contain untrusted references. Listing metadata must not stat
  // them (which can contact SMB); import/read authorization checks availability.
  return candidate || undefined;
}

function attachmentFilename(rawPath) {
  const raw = cleanString(rawPath);
  if (!raw) return undefined;
  const value = raw.startsWith('storage:')
    ? raw.slice('storage:'.length)
    : raw.startsWith('attachments:')
      ? raw.slice('attachments:'.length)
      : raw;
  return path.basename(value) || undefined;
}

function buildLocalLibraryItem(db, dataDir, baseAttachmentPath, row) {
  const attachmentItemId = Number(row.attachmentItemId);
  const parentItemId = row.parentItemId == null ? null : Number(row.parentItemId);
  const metadataItemId = parentItemId ?? attachmentItemId;
  const attachmentKey = String(row.attachmentKey);
  const rawPath = String(row.rawPath ?? '');
  const title = cleanString(localFieldValue(db, metadataItemId, 'title'))
    || cleanString(localFieldValue(db, attachmentItemId, 'title'))
    || 'Untitled PDF';
  const date = localFieldValue(db, metadataItemId, 'date');

  return {
    itemKey: String(row.itemKey),
    title,
    creators: localCreatorSummary(db, metadataItemId),
    year: yearFromDate(date),
    itemType: cleanString(row.itemType) || 'attachment',
    attachmentKey,
    attachmentTitle: undefined,
    attachmentFilename: attachmentFilename(rawPath),
    localPdfPath: resolveLocalAttachmentPath(dataDir, attachmentKey, rawPath, baseAttachmentPath),
  };
}

function stripHtmlTags(input) {
  return cleanString(input)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function buildNoteTitle(prefix, content) {
  const plain = stripHtmlTags(content);
  if (!plain) return prefix;
  return `${prefix}: ${plain.slice(0, 28)}${plain.length > 28 ? '...' : ''}`;
}

function loadRelatedNoteItems(db, parentItemId, parentItemKey) {
  return rows(db, `
    select noteItem.itemID as noteItemId, coalesce(itemNotes.note, '') as content
    from itemNotes
    join items noteItem on noteItem.itemID = itemNotes.itemID
    where itemNotes.parentItemID = ?
    order by noteItem.dateModified desc
  `, [parentItemId])
    .filter((row) => cleanString(row.content))
    .map((row) => ({
      id: `note-${row.noteItemId}`,
      parentItemKey,
      title: buildNoteTitle('Zotero note', row.content),
      kind: 'zotero-note',
      content: String(row.content),
      contentFormat: 'html',
      sourceLabel: 'Zotero note',
      filePath: undefined,
    }));
}

async function loadRelatedFileNotes(db, dataDir, baseAttachmentPath, parentItemId, parentItemKey, authorizeSources) {
  const notes = [];
  const fileRows = rows(db, `
    select attachment.key as attachmentKey, ia.path as rawPath, coalesce(ia.contentType, '') as contentType
    from itemAttachments ia
    join items attachment on attachment.itemID = ia.itemID
    where ia.parentItemID = ?
      and ia.path is not null
      and (
        ia.contentType in ('text/markdown', 'text/plain')
        or lower(ia.path) like '%.md'
        or lower(ia.path) like '%.markdown'
        or lower(ia.path) like '%.txt'
        or lower(ia.path) like 'storage:%.md'
        or lower(ia.path) like 'storage:%.markdown'
        or lower(ia.path) like 'storage:%.txt'
        or lower(ia.path) like 'attachments:%.md'
        or lower(ia.path) like 'attachments:%.markdown'
        or lower(ia.path) like 'attachments:%.txt'
      )
    order by attachment.dateModified desc
  `, [parentItemId]);

  const candidates = fileRows.map((row) => ({ row, filePath: resolveLocalAttachmentPath(dataDir, String(row.attachmentKey), String(row.rawPath), baseAttachmentPath) }))
    .filter((item) => item.filePath);
  const mappings = await authorizeSources?.(candidates.map((item) => item.filePath), { mode: 'read' });
  for (const { row, filePath } of candidates) {

    let content;
    try { content = await readAuthorizedFile(mappings?.get(filePath) || filePath, null, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!cleanString(content)) continue;

    const lowerPath = filePath.toLowerCase();
    const isMarkdown = row.contentType === 'text/markdown' || lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown');

    notes.push({
      id: `attachment-${row.attachmentKey}`,
      parentItemKey,
      title: path.basename(filePath) || 'Zotero attachment note',
      kind: isMarkdown ? 'markdown' : 'text',
      content,
      contentFormat: isMarkdown ? 'markdown' : 'plain',
      sourceLabel: isMarkdown ? 'Zotero Markdown' : 'Zotero text attachment',
      filePath,
    });
  }

  return notes;
}

const PDF_ATTACHMENT_FILTER = `
        (
          ia.contentType = 'application/pdf'
          or lower(ia.path) like '%.pdf'
          or lower(ia.path) like 'storage:%.pdf'
          or lower(ia.path) like 'attachments:%.pdf'
        )
        and ia.path is not null
`;

async function detectLocalZoteroDataDir() {
  return candidateLocalZoteroDirs().find((candidate) =>
    isReadableFile(path.join(candidate, 'zotero.sqlite')),
  ) ?? null;
}

async function listLocalCollections(options = {}) {
  return withLocalZoteroDatabase(options.dataDir, (db) =>
    rows(db, `
      select
        c.key as collectionKey,
        c.collectionName as name,
        parent.key as parentCollectionKey,
        count(distinct pdfItems.itemID) as itemCount
      from collections c
      left join collections parent on parent.collectionID = c.parentCollectionID
      left join collectionItems ci on ci.collectionID = c.collectionID
      left join (
        select distinct
          ia.itemID as attachmentItemID,
          coalesce(ia.parentItemID, ia.itemID) as itemID
        from itemAttachments ia
        join items attachment on attachment.itemID = ia.itemID
        left join items parent on parent.itemID = ia.parentItemID
        left join deletedItems deletedAttachment on deletedAttachment.itemID = attachment.itemID
        left join deletedItems deletedParent on deletedParent.itemID = parent.itemID
        where ${PDF_ATTACHMENT_FILTER}
          and deletedAttachment.itemID is null
          and deletedParent.itemID is null
      ) pdfItems on pdfItems.itemID = ci.itemID or pdfItems.attachmentItemID = ci.itemID
      group by c.collectionID, c.key, c.collectionName, parent.key, c.parentCollectionID
      order by
        case when c.parentCollectionID is null then 0 else 1 end asc,
        lower(c.collectionName) asc
    `).map((row) => ({
      collectionKey: String(row.collectionKey),
      name: String(row.name),
      parentCollectionKey: row.parentCollectionKey == null ? null : String(row.parentCollectionKey),
      itemCount: Math.max(0, Number(row.itemCount) || 0),
    })),
  );
}

async function listLocalLibraryItems(options = {}) {
  return withLocalZoteroDatabase(options.dataDir, (db, dataDir, baseAttachmentPath) => {
    const limit = normalizeLimit(options.limit);
    const query = withOptionalLimit(`
      select distinct
        attachment.itemID as attachmentItemId,
        attachment.key as attachmentKey,
        ia.parentItemID as parentItemId,
        ia.path as rawPath,
        coalesce(parent.key, attachment.key) as itemKey,
        coalesce(parentType.typeName, attachmentType.typeName, 'attachment') as itemType
      from itemAttachments ia
      join items attachment on attachment.itemID = ia.itemID
      left join items parent on parent.itemID = ia.parentItemID
      left join itemTypes parentType on parentType.itemTypeID = parent.itemTypeID
      left join itemTypes attachmentType on attachmentType.itemTypeID = attachment.itemTypeID
      left join deletedItems deletedAttachment on deletedAttachment.itemID = attachment.itemID
      left join deletedItems deletedParent on deletedParent.itemID = parent.itemID
      where ${PDF_ATTACHMENT_FILTER}
        and deletedAttachment.itemID is null
        and deletedParent.itemID is null
      order by attachment.dateModified desc
    `, limit);

    return rows(db, query.sql, query.params).map((row) =>
      buildLocalLibraryItem(db, dataDir, baseAttachmentPath, row),
    );
  });
}

async function listLocalCollectionItems(options = {}) {
  const collectionKey = cleanString(options.collectionKey);
  if (!collectionKey) throw new Error('Zotero collection key cannot be empty');

  return withLocalZoteroDatabase(options.dataDir, (db, dataDir, baseAttachmentPath) => {
    const limit = normalizeLimit(options.limit);
    const query = withOptionalLimit(`
      select distinct
        attachment.itemID as attachmentItemId,
        attachment.key as attachmentKey,
        ia.parentItemID as parentItemId,
        ia.path as rawPath,
        coalesce(parent.key, attachment.key) as itemKey,
        coalesce(parentType.typeName, attachmentType.typeName, 'attachment') as itemType
      from collections c
      join collectionItems ci on ci.collectionID = c.collectionID
      join itemAttachments ia
        on (ia.parentItemID = ci.itemID or ia.itemID = ci.itemID)
        and ${PDF_ATTACHMENT_FILTER}
      join items attachment on attachment.itemID = ia.itemID
      left join items parent on parent.itemID = ia.parentItemID
      left join itemTypes parentType on parentType.itemTypeID = parent.itemTypeID
      left join itemTypes attachmentType on attachmentType.itemTypeID = attachment.itemTypeID
      left join deletedItems deletedAttachment on deletedAttachment.itemID = attachment.itemID
      left join deletedItems deletedParent on deletedParent.itemID = parent.itemID
      where c.key = ?
        and deletedAttachment.itemID is null
        and deletedParent.itemID is null
      order by attachment.dateModified desc
    `, limit);

    return rows(db, query.sql, [collectionKey, ...query.params]).map((row) =>
      buildLocalLibraryItem(db, dataDir, baseAttachmentPath, row),
    );
  });
}

async function listRelatedNotes(options = {}) {
  const itemKey = cleanString(options.itemKey);
  if (!itemKey) throw new Error('Zotero item key cannot be empty');

  return withLocalZoteroDatabase(options.dataDir, async (db, dataDir, baseAttachmentPath) => {
    const parent = one(db, 'select itemID as itemId from items where key = ? limit 1', [itemKey]);
    if (!parent) return [];

    const noteItems = loadRelatedNoteItems(db, Number(parent.itemId), itemKey);
    const fileNotes = await loadRelatedFileNotes(db, dataDir, baseAttachmentPath, Number(parent.itemId), itemKey, options.authorizeSources);
    return [...noteItems, ...fileNotes];
  });
}

module.exports = {
  detectLocalZoteroDataDir,
  listLocalCollections,
  listLocalLibraryItems,
  listLocalCollectionItems,
  listRelatedNotes,
};
