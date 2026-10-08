const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync, sqlStringLiteral, withTransaction } = require('./nodeSqlite.cjs');
const { cleanString } = require('./utils.cjs');
const nativeFs = require('./nativeFs.cjs');

function readLegacyLibrary(filePath) {
  try { return JSON.parse(nativeFs.readSync(filePath, { singleLink: true }).bytes.toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  createSchema(db);
  return db;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webdav_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      sort_order INTEGER NOT NULL,
      is_system INTEGER NOT NULL,
      system_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      year TEXT,
      publication TEXT,
      doi TEXT,
      url TEXT,
      abstract_text TEXT,
      imported_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_read_at INTEGER,
      reading_progress REAL NOT NULL,
      is_favorite INTEGER NOT NULL,
      user_note TEXT,
      ai_summary TEXT,
      citation TEXT,
      source TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_keywords (
      paper_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (paper_id, sort_order),
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS authors (
      id TEXT NOT NULL,
      paper_id TEXT NOT NULL,
      name TEXT NOT NULL,
      given_name TEXT,
      family_name TEXT,
      sort_order INTEGER NOT NULL,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT NOT NULL,
      paper_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      sort_order INTEGER NOT NULL,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS paper_categories (
      paper_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (paper_id, category_id),
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      original_path TEXT,
      stored_path TEXT NOT NULL,
      relative_path TEXT,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      content_hash TEXT,
      created_at INTEGER NOT NULL,
      missing INTEGER NOT NULL,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS paper_references (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      doi TEXT,
      title TEXT,
      authors TEXT,
      year TEXT,
      journal TEXT,
      volume TEXT,
      issue TEXT,
      pages TEXT,
      unstructured TEXT,
      fetched_at INTEGER NOT NULL,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_papers_sort_order ON papers(sort_order);
    CREATE INDEX IF NOT EXISTS idx_attachments_paper_id ON attachments(paper_id);
    CREATE INDEX IF NOT EXISTS idx_authors_paper_id ON authors(paper_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_tags_paper_id ON tags(paper_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_paper_categories_category_id ON paper_categories(category_id);
    CREATE INDEX IF NOT EXISTS idx_paper_references_paper_id ON paper_references(paper_id);
    CREATE INDEX IF NOT EXISTS idx_paper_references_doi ON paper_references(doi);
  `);

  migrateRepeatedIdListTable(db, 'authors', `
    CREATE TABLE authors (
      id TEXT NOT NULL,
      paper_id TEXT NOT NULL,
      name TEXT NOT NULL,
      given_name TEXT,
      family_name TEXT,
      sort_order INTEGER NOT NULL,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    )
  `, 'id, paper_id, name, given_name, family_name, sort_order');

  migrateRepeatedIdListTable(db, 'tags', `
    CREATE TABLE tags (
      id TEXT NOT NULL,
      paper_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      sort_order INTEGER NOT NULL,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    )
  `, 'id, paper_id, name, color, sort_order');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_authors_paper_id ON authors(paper_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_tags_paper_id ON tags(paper_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_paper_references_paper_id ON paper_references(paper_id);
    CREATE INDEX IF NOT EXISTS idx_paper_references_doi ON paper_references(doi);
  `);
}

function tableHasPrimaryKey(db, tableName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => Number(column.pk) > 0);
}

function migrateRepeatedIdListTable(db, tableName, createSql, columns) {
  if (!tableHasPrimaryKey(db, tableName)) return;

  const tempTableName = `${tableName}_legacy_${Date.now()}`;

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    withTransaction(db, () => {
      db.exec(`ALTER TABLE ${tableName} RENAME TO ${tempTableName}`);
      db.exec(createSql);
      db.exec(`
        INSERT INTO ${tableName} (${columns})
        SELECT ${columns}
        FROM ${tempTableName}
      `);
      db.exec(`DROP TABLE ${tempTableName}`);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

function boolToInteger(value) {
  return value ? 1 : 0;
}

function parseJsonValue(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function loadKeyValueTable(db, tableName) {
  return Object.fromEntries(
    db
      .prepare(`SELECT key, value_json FROM ${tableName} ORDER BY key`)
      .all()
      .map((row) => [row.key, parseJsonValue(row.value_json)]),
  );
}

function saveKeyValueTable(db, tableName, values) {
  db.prepare(`DELETE FROM ${tableName}`).run();
  const insert = db.prepare(`INSERT INTO ${tableName} (key, value_json) VALUES (?, ?)`);

  for (const [key, value] of Object.entries(values ?? {})) {
    insert.run(key, JSON.stringify(value ?? null));
  }
}

function rowsByPaperId(rows) {
  const grouped = new Map();

  for (const row of rows) {
    if (!grouped.has(row.paper_id)) grouped.set(row.paper_id, []);
    grouped.get(row.paper_id).push(row);
  }

  return grouped;
}

function loadLibraryFromDb(db, appPaths, normalizeLibrary) {
  const settings = loadKeyValueTable(db, 'library_settings');
  const webdav = loadKeyValueTable(db, 'webdav_settings');
  const categories = db.prepare(`
    SELECT
      id,
      name,
      parent_id AS parentId,
      sort_order AS sortOrder,
      is_system AS isSystem,
      system_key AS systemKey,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM categories
    ORDER BY is_system DESC, sort_order, name
  `).all().map((category) => ({
    ...category,
    isSystem: Boolean(category.isSystem),
    paperCount: 0,
  }));
  const authorRows = rowsByPaperId(db.prepare(`
    SELECT
      paper_id,
      id,
      name,
      given_name AS givenName,
      family_name AS familyName,
      sort_order AS sortOrder
    FROM authors
    ORDER BY paper_id, sort_order
  `).all());
  const tagRows = rowsByPaperId(db.prepare(`
    SELECT
      paper_id,
      id,
      name,
      color,
      sort_order AS sortOrder
    FROM tags
    ORDER BY paper_id, sort_order
  `).all());
  const keywordRows = rowsByPaperId(db.prepare(`
    SELECT paper_id, keyword
    FROM paper_keywords
    ORDER BY paper_id, sort_order
  `).all());
  const categoryRows = rowsByPaperId(db.prepare(`
    SELECT paper_id, category_id
    FROM paper_categories
    ORDER BY paper_id, sort_order
  `).all());
  const attachmentRows = rowsByPaperId(db.prepare(`
    SELECT
      paper_id,
      id,
      kind,
      original_path AS originalPath,
      stored_path AS storedPath,
      relative_path AS relativePath,
      file_name AS fileName,
      mime_type AS mimeType,
      file_size AS fileSize,
      content_hash AS contentHash,
      created_at AS createdAt,
      missing
    FROM attachments
    ORDER BY paper_id, created_at, id
  `).all());
  const papers = db.prepare(`
    SELECT
      id,
      title,
      year,
      publication,
      doi,
      url,
      abstract_text AS abstractText,
      imported_at AS importedAt,
      updated_at AS updatedAt,
      last_read_at AS lastReadAt,
      reading_progress AS readingProgress,
      is_favorite AS isFavorite,
      user_note AS userNote,
      ai_summary AS aiSummary,
      citation,
      source,
      sort_order AS sortOrder
    FROM papers
    ORDER BY sort_order, title
  `).all().map((paper) => ({
    ...paper,
    isFavorite: Boolean(paper.isFavorite),
    keywords: (keywordRows.get(paper.id) ?? []).map((row) => row.keyword),
    authors: (authorRows.get(paper.id) ?? []).map(({ paper_id: _paperId, ...author }) => author),
    tags: (tagRows.get(paper.id) ?? []).map(({ paper_id: _paperId, ...tag }) => tag),
    categoryIds: (categoryRows.get(paper.id) ?? []).map((row) => row.category_id),
    attachments: (attachmentRows.get(paper.id) ?? []).map(({ paper_id: _paperId, missing, ...attachment }) => ({
      ...attachment,
      paperId: paper.id,
      missing: Boolean(missing),
    })),
  }));

  return normalizeLibrary({
    version: 1,
    settings,
    webdav,
    categories,
    papers,
  }, appPaths);
}

function clearData(db) {
  for (const table of [
    'attachments',
    'paper_categories',
    'tags',
    'authors',
    'paper_keywords',
    'papers',
    'categories',
    'library_settings',
    'webdav_settings',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

function normalizeReferenceRow(row) {
  return {
    id: cleanString(row?.id),
    paperId: cleanString(row?.paperId || row?.paper_id),
    seq: Number(row?.seq) || 0,
    doi: cleanString(row?.doi),
    title: cleanString(row?.title),
    authors: cleanString(row?.authors),
    year: cleanString(row?.year),
    journal: cleanString(row?.journal),
    volume: cleanString(row?.volume),
    issue: cleanString(row?.issue),
    pages: cleanString(row?.pages),
    unstructured: cleanString(row?.unstructured),
    fetchedAt: Number(row?.fetchedAt || row?.fetched_at) || 0,
  };
}

function loadReferenceRows(db, paperId = '') {
  const sql = `
    SELECT
      id,
      paper_id AS paperId,
      seq,
      doi,
      title,
      authors,
      year,
      journal,
      volume,
      issue,
      pages,
      unstructured,
      fetched_at AS fetchedAt
    FROM paper_references
    ${paperId ? 'WHERE paper_id = ?' : ''}
    ORDER BY paper_id, seq
  `;
  const statement = db.prepare(sql);
  const rows = paperId ? statement.all(paperId) : statement.all();
  return rows.map(normalizeReferenceRow);
}

function saveReferenceRows(db, paperId, refs) {
  const normalizedPaperId = cleanString(paperId);
  if (!normalizedPaperId) {
    return [];
  }

  const fetchedAt = Date.now();
  const normalizedRefs = (Array.isArray(refs) ? refs : [])
    .map((ref, index) => ({
      id: cleanString(ref?.id) || `ref:${normalizedPaperId}:${index + 1}`,
      paperId: normalizedPaperId,
      seq: Number.isFinite(Number(ref?.seq)) ? Number(ref.seq) : index + 1,
      doi: cleanString(ref?.doi).toLowerCase(),
      title: cleanString(ref?.title),
      authors: cleanString(ref?.authors),
      year: cleanString(ref?.year),
      journal: cleanString(ref?.journal),
      volume: cleanString(ref?.volume),
      issue: cleanString(ref?.issue),
      pages: cleanString(ref?.pages),
      unstructured: cleanString(ref?.unstructured),
      fetchedAt: Number(ref?.fetchedAt || ref?.fetched_at) || fetchedAt,
    }))
    .filter((ref) => ref.doi || ref.title || ref.unstructured);

  const deleteStatement = db.prepare('DELETE FROM paper_references WHERE paper_id = ?');
  const insertStatement = db.prepare(`
    INSERT INTO paper_references (
      id,
      paper_id,
      seq,
      doi,
      title,
      authors,
      year,
      journal,
      volume,
      issue,
      pages,
      unstructured,
      fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  deleteStatement.run(normalizedPaperId);
  for (const ref of normalizedRefs) {
    insertStatement.run(
      ref.id,
      ref.paperId,
      ref.seq,
      ref.doi || null,
      ref.title || null,
      ref.authors || null,
      ref.year || null,
      ref.journal || null,
      ref.volume || null,
      ref.issue || null,
      ref.pages || null,
      ref.unstructured || null,
      ref.fetchedAt,
    );
  }

  return normalizedRefs;
}

function restoreReferenceRows(db, refs, paperIds) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return;
  }

  const grouped = new Map();
  for (const ref of refs) {
    const paperId = cleanString(ref.paperId);
    if (!paperId || !paperIds.has(paperId)) continue;
    if (!grouped.has(paperId)) grouped.set(paperId, []);
    grouped.get(paperId).push(ref);
  }

  for (const [paperId, paperRefs] of grouped) {
    saveReferenceRows(db, paperId, paperRefs);
  }
}

function saveLibraryToDb(db, appPaths, normalizeLibrary, library) {
  const normalized = normalizeLibrary(library, appPaths);

  withTransaction(db, () => {
    const referenceCache = loadReferenceRows(db);
    clearData(db);
    saveKeyValueTable(db, 'library_settings', normalized.settings);
    saveKeyValueTable(db, 'webdav_settings', normalized.webdav);
    db.prepare(`
      INSERT INTO library_meta (key, value)
      VALUES ('initialized', '1'), ('version', '1')
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run();

    const insertCategory = db.prepare(`
      INSERT INTO categories (
        id,
        name,
        parent_id,
        sort_order,
        is_system,
        system_key,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPaper = db.prepare(`
      INSERT INTO papers (
        id,
        title,
        year,
        publication,
        doi,
        url,
        abstract_text,
        imported_at,
        updated_at,
        last_read_at,
        reading_progress,
        is_favorite,
        user_note,
        ai_summary,
        citation,
        source,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertKeyword = db.prepare(`
      INSERT INTO paper_keywords (paper_id, keyword, sort_order)
      VALUES (?, ?, ?)
    `);
    const insertAuthor = db.prepare(`
      INSERT INTO authors (id, paper_id, name, given_name, family_name, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertTag = db.prepare(`
      INSERT INTO tags (id, paper_id, name, color, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertPaperCategory = db.prepare(`
      INSERT INTO paper_categories (paper_id, category_id, sort_order)
      VALUES (?, ?, ?)
    `);
    const insertAttachment = db.prepare(`
      INSERT INTO attachments (
        id,
        paper_id,
        kind,
        original_path,
        stored_path,
        relative_path,
        file_name,
        mime_type,
        file_size,
        content_hash,
        created_at,
        missing
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const category of normalized.categories) {
      insertCategory.run(
        category.id,
        category.name,
        category.parentId ?? null,
        Number(category.sortOrder) || 0,
        boolToInteger(category.isSystem),
        category.systemKey ?? null,
        Number(category.createdAt) || 0,
        Number(category.updatedAt) || 0,
      );
    }

    for (const paper of normalized.papers) {
      insertPaper.run(
        paper.id,
        paper.title,
        paper.year ?? null,
        paper.publication ?? null,
        paper.doi ?? null,
        paper.url ?? null,
        paper.abstractText ?? null,
        Number(paper.importedAt) || 0,
        Number(paper.updatedAt) || 0,
        paper.lastReadAt ?? null,
        Number(paper.readingProgress) || 0,
        boolToInteger(paper.isFavorite),
        paper.userNote ?? null,
        paper.aiSummary ?? null,
        paper.citation ?? null,
        paper.source || 'local',
        Number(paper.sortOrder) || 0,
      );

      (paper.keywords ?? []).forEach((keyword, index) => {
        insertKeyword.run(paper.id, String(keyword), index);
      });
      (paper.authors ?? []).forEach((author, index) => {
        insertAuthor.run(
          author.id,
          paper.id,
          author.name,
          author.givenName ?? null,
          author.familyName ?? null,
          Number(author.sortOrder ?? index) || 0,
        );
      });
      (paper.tags ?? []).forEach((tag, index) => {
        insertTag.run(tag.id, paper.id, tag.name, tag.color ?? null, index);
      });
      (paper.categoryIds ?? []).forEach((categoryId, index) => {
        insertPaperCategory.run(paper.id, categoryId, index);
      });
      (paper.attachments ?? []).forEach((attachment) => {
        insertAttachment.run(
          attachment.id,
          paper.id,
          attachment.kind || 'pdf',
          attachment.originalPath ?? null,
          attachment.storedPath,
          attachment.relativePath ?? null,
          attachment.fileName,
          attachment.mimeType,
          Number(attachment.fileSize) || 0,
          attachment.contentHash ?? null,
          Number(attachment.createdAt) || 0,
          boolToInteger(attachment.missing),
        );
      });
    }

    restoreReferenceRows(
      db,
      referenceCache,
      new Set(normalized.papers.map((paper) => paper.id)),
    );
  });

  return normalized;
}

function databaseInitialized(db) {
  const row = db
    .prepare("SELECT value FROM library_meta WHERE key = 'initialized'")
    .get();
  return row?.value === '1';
}

function legacyRagIndexes(raw) {
  return raw?.ragIndexes && typeof raw.ragIndexes === 'object' ? raw.ragIndexes : {};
}

function createLibraryDatabaseStore(appPaths, helpers) {
  let db = openDatabase(appPaths.libraryDatabasePath);
  const { normalizeLibrary } = helpers;

  try {
    if (!databaseInitialized(db)) {
      const rawLibrary = readLegacyLibrary(appPaths.libraryPath);

      if (rawLibrary && typeof rawLibrary === 'object') {
        saveLibraryToDb(db, appPaths, normalizeLibrary, rawLibrary);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    close() {
      if (db.isOpen) db.close();
    },

    load() {
      return loadLibraryFromDb(db, appPaths, normalizeLibrary);
    },

    save(library) {
      saveLibraryToDb(db, appPaths, normalizeLibrary, library);
    },

    saveSync(library) {
      saveLibraryToDb(db, appPaths, normalizeLibrary, library);
    },

    saveReferences(paperId, refs) {
      return withTransaction(db, () => saveReferenceRows(db, paperId, refs));
    },

    loadReferences(paperId) {
      return loadReferenceRows(db, cleanString(paperId));
    },

    loadAllReferences() {
      return loadReferenceRows(db);
    },

    loadFromSnapshot(snapshotPath) {
      const snapshotDb = openDatabase(snapshotPath);
      try {
        return loadLibraryFromDb(snapshotDb, appPaths, normalizeLibrary);
      } finally {
        if (snapshotDb.isOpen) snapshotDb.close();
      }
    },

    snapshotTo(targetPath) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.rmSync(targetPath, { force: true });
      db.exec(`VACUUM main INTO ${sqlStringLiteral(targetPath)}`);
      return targetPath;
    },

    loadLegacyRagIndexes() {
      return legacyRagIndexes(readLegacyLibrary(appPaths.libraryPath));
    },

    clearLegacyRagIndexesSync() {
      const rawLibrary = readLegacyLibrary(appPaths.libraryPath);
      if (!rawLibrary || typeof rawLibrary !== 'object' || !rawLibrary.ragIndexes) return;

      delete rawLibrary.ragIndexes;
      nativeFs.writeSync(appPaths.libraryPath, JSON.stringify(rawLibrary, null, 2));
    },

    async replaceWithSnapshot(snapshotPath) {
      const replacementPath = `${appPaths.libraryDatabasePath}.restore-${Date.now()}.tmp`;
      await fsp.mkdir(path.dirname(appPaths.libraryDatabasePath), { recursive: true });
      await fsp.copyFile(snapshotPath, replacementPath);

      if (db.isOpen) db.close();

      try {
        await fsp.rm(appPaths.libraryDatabasePath, { force: true });
        await fsp.rm(`${appPaths.libraryDatabasePath}-wal`, { force: true });
        await fsp.rm(`${appPaths.libraryDatabasePath}-shm`, { force: true });
        await fsp.rename(replacementPath, appPaths.libraryDatabasePath);
      } finally {
        await fsp.rm(replacementPath, { force: true }).catch(() => {});
        db = openDatabase(appPaths.libraryDatabasePath);
      }
    },
  };
}

module.exports = { createLibraryDatabaseStore };
