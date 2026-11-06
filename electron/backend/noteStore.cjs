const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, sqlStringLiteral, withTransaction } = require('./nodeSqlite.cjs');
const { cleanString, id, now } = require('./utils.cjs');
const { withSnapshotDatabase, assertSnapshotTables, replaceTables } = require('./databaseRestore.cjs');

const NOTE_TYPES = new Set(['highlight', 'area', 'standalone', 'ai-chat']);
const GLOBAL_NOTES_PAPER_ID = 'global-notes';

function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath, { timeout: 5000 });
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    createSchema(db);
    return db;
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}

function getTableColumns(db, tableName) {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name),
  );
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = getTableColumns(db, tableName);
  if (columns.has(columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('highlight', 'area', 'standalone', 'ai-chat')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_json TEXT,
      content_html TEXT,
      content_text TEXT,
      excerpt TEXT,
      anchors TEXT,
      reference_metadata TEXT,
      linked_paper_id TEXT,
      folder_id TEXT,
      pdf_page_number INTEGER,
      pdf_bounding_rect TEXT,
      pdf_bbox TEXT,
      pdf_bbox_coordinate_system TEXT,
      pdf_bbox_page_size TEXT,
      highlight_color TEXT,
      ai_chat_id TEXT,
      ai_chat_message_ids TEXT,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      word_count INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      is_pinned INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS note_tags (
      note_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (note_id, tag),
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS note_links (
      source_note_id TEXT NOT NULL,
      target_note_id TEXT NOT NULL,
      link_text TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_note_id, target_note_id),
      FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS note_paper_links (
      note_id TEXT NOT NULL,
      paper_id TEXT NOT NULL,
      PRIMARY KEY (note_id, paper_id),
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

  `);

  ensureColumn(db, 'notes', 'content_json', 'TEXT');
  ensureColumn(db, 'notes', 'content_html', 'TEXT');
  ensureColumn(db, 'notes', 'content_text', 'TEXT');
  ensureColumn(db, 'notes', 'excerpt', 'TEXT');
  ensureColumn(db, 'notes', 'anchors', 'TEXT');
  ensureColumn(db, 'notes', 'reference_metadata', 'TEXT');
  ensureColumn(db, 'notes', 'linked_paper_id', 'TEXT');
  ensureColumn(db, 'notes', 'folder_id', 'TEXT');
  ensureColumn(db, 'notes', 'pdf_page_number', 'INTEGER');
  ensureColumn(db, 'notes', 'pdf_bounding_rect', 'TEXT');
  ensureColumn(db, 'notes', 'pdf_bbox', 'TEXT');
  ensureColumn(db, 'notes', 'pdf_bbox_coordinate_system', 'TEXT');
  ensureColumn(db, 'notes', 'pdf_bbox_page_size', 'TEXT');
  ensureColumn(db, 'notes', 'highlight_color', 'TEXT');
  ensureColumn(db, 'notes', 'ai_chat_id', 'TEXT');
  ensureColumn(db, 'notes', 'ai_chat_message_ids', 'TEXT');
  ensureColumn(db, 'notes', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'notes', 'word_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'notes', 'is_favorite', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'notes', 'is_pinned', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'note_tags', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'note_links', 'link_text', 'TEXT');
  ensureColumn(db, 'note_links', 'created_at', 'INTEGER NOT NULL DEFAULT 0');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notes_paper_id ON notes(paper_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notes_linked_paper_id ON notes(linked_paper_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notes_deleted_at ON notes(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_note_id);
    CREATE INDEX IF NOT EXISTS idx_note_paper_links_paper_id ON note_paper_links(paper_id);
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        note_id UNINDEXED,
        title,
        content_text,
        excerpt
      );
    `);
  } catch (error) {
    console.warn('PaperQuay notes FTS5 is unavailable; falling back to LIKE search.', error);
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function normalizeNoteType(value) {
  const noteType = cleanString(value) || 'standalone';
  if (!NOTE_TYPES.has(noteType)) throw new Error(`Unsupported note type: ${noteType}`);
  return noteType;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];

  const seen = new Set();
  const output = [];
  for (const tag of tags) {
    const cleanTag = cleanString(tag).replace(/^#/, '');
    if (!cleanTag || seen.has(cleanTag.toLowerCase())) continue;
    seen.add(cleanTag.toLowerCase());
    output.push(cleanTag);
  }
  return output;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const output = [];
  for (const item of value) {
    const text = cleanString(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function normalizeUnresolvedReferences(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 1000) throw new Error('INVALID_NOTE_REFERENCE_METADATA');
  const seen = new Set();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'id,kind,label,reason'
      || !['note', 'paper', 'folder', 'ai-chat'].includes(entry.kind) || typeof entry.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.id) || typeof entry.label !== 'string' || entry.label.length > 2048
      || !['unmapped', 'missing', 'historical-unverified'].includes(entry.reason)) throw new Error('INVALID_NOTE_REFERENCE_METADATA');
    if (entry.id.startsWith('unresolved:') && !entry.id.startsWith(`unresolved:${entry.kind}:`)) throw new Error('INVALID_NOTE_REFERENCE_METADATA');
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) throw new Error('INVALID_NOTE_REFERENCE_METADATA');
    seen.add(key);
    return { kind: entry.kind, id: entry.id, label: entry.label, reason: entry.reason };
  });
}

function referenceMetadata(value) {
  const result = { linkedNoteIds: normalizeStringList(value?.linkedNoteIds), linkedPaperIds: normalizeStringList(value?.linkedPaperIds),
    unresolvedReferences: normalizeUnresolvedReferences(value?.unresolvedReferences) };
  if ([result.linkedNoteIds, result.linkedPaperIds].some(list => list.length > 1000 || list.some(id => id.length > 512))
    || Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('INVALID_NOTE_REFERENCE_METADATA');
  return result;
}

function structuredReferences(document) {
  const notes = [], papers = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'wikiLink' && typeof node.attrs?.id === 'string') notes.push(node.attrs.id);
    if (node.type === 'paperReference' && typeof node.attrs?.paperId === 'string') papers.push(node.attrs.paperId);
    for (const child of Array.isArray(node.content) ? node.content : []) visit(child);
  };
  visit(document);
  return { notes, papers };
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return Boolean(fallback);
  return value === true || value === 1 || value === '1';
}

function normalizeTimestamp(value) {
  if (value === null) return null;
  const timestamp = Math.trunc(Number(value));
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

function normalizeBBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bbox = value.map((item) => Number(item));
  return bbox.every((item) => Number.isFinite(item)) ? bbox : null;
}

function normalizePageSize(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const pageSize = value.map((item) => Number(item));
  return pageSize.every((item) => Number.isFinite(item) && item > 0) ? pageSize : null;
}

function normalizeBoundingRect(value) {
  if (!value || typeof value !== 'object') return null;

  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);

  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

function normalizePdfLocation(value) {
  if (!value || typeof value !== 'object') return null;

  const pageNumber = Math.trunc(Number(value.pageNumber));
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) return null;

  const bbox = normalizeBBox(value.bbox);
  const boundingRect = normalizeBoundingRect(value.boundingRect);
  const bboxPageSize = normalizePageSize(value.bboxPageSize);
  const bboxCoordinateSystem =
    value.bboxCoordinateSystem === 'pdf' || value.bboxCoordinateSystem === 'normalized-1000'
      ? value.bboxCoordinateSystem
      : bbox
        ? 'normalized-1000'
        : undefined;

  return {
    pageNumber,
    boundingRect: boundingRect ?? undefined,
    bbox: bbox ?? undefined,
    bboxCoordinateSystem,
    bboxPageSize: bboxPageSize ?? undefined,
    highlightColor: cleanString(value.highlightColor) || undefined,
  };
}

function normalizeAnchors(value) {
  if (!Array.isArray(value)) return [];

  const output = [];
  const seen = new Set();

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    const idValue = cleanString(item.id) || id('note-anchor');
    if (seen.has(idValue)) continue;

    const excerpt = cleanString(item.excerpt);
    const paperId = cleanString(item.paperId);
    const label = cleanString(item.label) || (excerpt ? excerpt.slice(0, 48) : 'Reference');
    const sourceTitle = cleanString(item.sourceTitle);
    const source = ['pdf', 'blocks', 'ai-chat', 'manual'].includes(item.source)
      ? item.source
      : undefined;
    const pdfLocation = normalizePdfLocation(item.pdfLocation);
    const createdAt = item.createdAt === 0 ? 0 : normalizeTimestamp(item.createdAt) || now();
    if (item.verification !== undefined && item.verification !== 'unverified') throw new Error('INVALID_NOTE_ANCHOR_VERIFICATION');

    seen.add(idValue);
    output.push({
      id: idValue,
      paperId: paperId || undefined,
      label,
      sourceTitle: sourceTitle || undefined,
      excerpt,
      source,
      ...(item.blockId === undefined ? {} : { blockId: item.blockId === null ? null : cleanString(item.blockId) || undefined }),
      ...(item.pageIndex === undefined ? {} : { pageIndex: item.pageIndex === null ? null : Number.isSafeInteger(item.pageIndex) && item.pageIndex >= 0 ? item.pageIndex : undefined }),
      ...(item.verification === undefined ? {} : { verification: 'unverified' }),
      pdfLocation: pdfLocation ?? undefined,
      createdAt,
    });
  }

  return output;
}

function stripHtml(value) {
  return cleanString(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function textFromJsonContent(value) {
  if (!value || typeof value !== 'object') return '';
  const chunks = [];

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') chunks.push(node.text);

    if (node.type === 'wikiLink') {
      const label = cleanString(node.attrs?.label || node.attrs?.noteTitle || node.attrs?.id);
      if (label) chunks.push(`[[${label}]]`);
    } else if (node.type === 'hashTag') {
      const tag = cleanString(node.attrs?.tag || node.attrs?.label);
      if (tag) chunks.push(`#${tag}`);
    } else if (node.type === 'paperReference') {
      const paperId = cleanString(node.attrs?.paperId || node.attrs?.id);
      if (paperId) chunks.push(`@${paperId}`);
    } else if (node.type === 'noteAnchorLink') {
      const label = cleanString(node.attrs?.label || '定位');
      if (label) chunks.push(`引用 · ${label}`);
    } else if (node.type === 'noteAnchorBlock') {
      const label = cleanString(node.attrs?.label || '定位');
      const sourceLabel = cleanString(node.attrs?.sourceLabel || '摘录');
      const sourceTitle = cleanString(node.attrs?.sourceTitle);
      const excerpt = cleanString(node.attrs?.excerpt);
      chunks.push(`引用 ${excerpt} ${sourceTitle || sourceLabel} ${label}`);
      if (excerpt) chunks.push(excerpt);
    } else if (node.type === 'noteComponentBlock') {
      const title = cleanString(node.attrs?.title);
      if (title) chunks.push(title);
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };

  visit(value);
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

function extractTagsFromText(text) {
  const output = [];
  const regex = /(^|[\s([{"'，。；、])#([\p{L}\p{N}_-]{1,48})/gu;
  let match = regex.exec(text);

  while (match) {
    output.push(match[2]);
    match = regex.exec(text);
  }

  return output;
}

function extractWikiTitlesFromText(text) {
  const output = [];
  const regex = /\[\[([^[\]\n]{1,160})\]\]/g;
  let match = regex.exec(text);

  while (match) {
    output.push(match[1]);
    match = regex.exec(text);
  }

  return output;
}

function extractPaperRefsFromText(text) {
  const output = [];
  const regex = /(^|[\s([{"'，。；、])@([a-zA-Z0-9:_-]{2,160})/g;
  let match = regex.exec(text);

  while (match) {
    output.push(match[2]);
    match = regex.exec(text);
  }

  return output;
}

function countWords(text) {
  const normalized = cleanString(text);
  if (!normalized) return 0;
  const latinWords = normalized.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const cjkChars = normalized.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return latinWords + cjkChars;
}

function normalizeContentJson(value, fallback) {
  if (value === undefined) return fallback ?? null;
  if (value === null) return null;
  return typeof value === 'object' ? value : fallback ?? null;
}

function normalizeNoteInput(input, existing = null) {
  const timestamp = now();
  const contentJson = normalizeContentJson(input?.contentJson, existing?.contentJson);
  const contentHtml =
    input?.contentHtml === undefined
      ? existing?.contentHtml ?? null
      : cleanString(input.contentHtml) || null;
  const fallbackContentText =
    textFromJsonContent(contentJson) ||
    stripHtml(contentHtml) ||
    (typeof input?.content === 'string' ? input.content : existing?.content ?? '');
  const contentText =
    input?.contentText === undefined
      ? existing?.contentText ?? fallbackContentText
      : cleanString(input.contentText) || fallbackContentText;
  const content =
    typeof input?.content === 'string'
      ? input.content
      : typeof existing?.content === 'string'
        ? existing.content
        : contentText;
  const linkedPaperId =
    input?.linkedPaperId === undefined
      ? existing?.linkedPaperId ?? null
      : cleanString(input.linkedPaperId) || null;
  const paperId =
    cleanString(input?.paperId ?? existing?.paperId) ||
    linkedPaperId ||
    GLOBAL_NOTES_PAPER_ID;
  const type = normalizeNoteType(input?.type ?? existing?.type);
  const title = cleanString(input?.title ?? existing?.title) || 'Untitled Note';
  const pdfLocation = input?.pdfLocation === undefined
    ? existing?.pdfLocation ?? null
    : normalizePdfLocation(input.pdfLocation);
  const anchors = input?.anchors === undefined
    ? existing?.anchors ?? []
    : normalizeAnchors(input.anchors);
  const explicitTags = normalizeTags(input?.tags ?? existing?.tags);
  const extractedTags = normalizeTags(extractTagsFromText(contentText));
  const structured = contentJson?.type === 'doc' ? structuredReferences(contentJson) : null;
  const previousReferences = existing?.contentJson?.type === 'doc' ? structuredReferences(existing.contentJson) : { notes: [], papers: [] };
  const editingDocument = structured && existing && input?.contentJson !== undefined;
  const explicitReferences = (field, previousIds) => {
    const supplied = normalizeStringList(input?.[field] ?? (editingDocument ? [] : existing?.[field]));
    if (!editingDocument) return supplied;
    // A normal editor save derives body references, but cannot silently remove
    // independent metadata associations which were never in that body.
    const previous = new Set(previousIds);
    return [...supplied, ...normalizeStringList(existing[field]).filter(value => !previous.has(value))];
  };
  // A rendered [[label]] is not an identity. Structured references remain
  // explicit even when their target is unresolved or another note shares a title.
  const linkedNoteTitles = structured ? [] : normalizeStringList([
    ...normalizeStringList(input?.linkedNoteTitles),
    ...extractWikiTitlesFromText(contentText),
  ]);
  const linkedPaperIds = normalizeStringList([
    ...explicitReferences('linkedPaperIds', previousReferences.papers),
    ...(structured ? structured.papers : extractPaperRefsFromText(contentText)),
  ]);
  const references = referenceMetadata({
    linkedNoteIds: [...explicitReferences('linkedNoteIds', previousReferences.notes), ...(structured?.notes ?? [])], linkedPaperIds,
    unresolvedReferences: input?.unresolvedReferences === undefined ? existing?.unresolvedReferences : input.unresolvedReferences,
  });

  return {
    id: cleanString(input?.id ?? existing?.id) || id('note'),
    paperId,
    type,
    title,
    content,
    contentJson,
    contentHtml,
    contentText,
    excerpt:
      input?.excerpt === undefined
        ? existing?.excerpt ?? (contentText ? contentText.slice(0, 200) : null)
        : cleanString(input.excerpt) || null,
    pdfLocation,
    anchors,
    aiChatId:
      input?.aiChatId === undefined
        ? existing?.aiChatId ?? null
        : cleanString(input.aiChatId) || null,
    aiChatMessageIds: normalizeStringList(input?.aiChatMessageIds ?? existing?.aiChatMessageIds),
    linkedPaperId,
    folderId:
      input?.folderId === undefined
        ? existing?.folderId ?? null
        : cleanString(input.folderId) || null,
    tags: normalizeTags([...explicitTags, ...extractedTags]),
    color: cleanString(input?.color ?? existing?.color) || '#fef3c7',
    createdAt: Number.isSafeInteger(existing?.createdAt) && existing.createdAt >= 0 ? existing.createdAt
      : Number.isSafeInteger(input?.createdAt) && input.createdAt >= 0 ? input.createdAt : timestamp,
    updatedAt: timestamp,
    deletedAt:
      input?.deletedAt === undefined
        ? existing?.deletedAt ?? null
        : normalizeTimestamp(input.deletedAt),
    wordCount:
      Number.isSafeInteger(Math.trunc(Number(input?.wordCount)))
        ? Math.max(0, Math.trunc(Number(input.wordCount)))
        : Number(existing?.wordCount) || countWords(contentText),
    isFavorite: normalizeBoolean(input?.isFavorite, existing?.isFavorite),
    isPinned: normalizeBoolean(input?.isPinned, existing?.isPinned),
    linkedNoteIds: references.linkedNoteIds,
    linkedNoteTitles,
    linkedPaperIds: references.linkedPaperIds,
    unresolvedReferences: references.unresolvedReferences,
  };
}

function rowToNote(row, tags = [], linkedNoteIds = [], linkedPaperIds = [], backlinks = []) {
  if (!row) return null;
  const references = row.reference_metadata === null || row.reference_metadata === undefined ? null : referenceMetadata(parseJson(row.reference_metadata, null));

  const pdfLocation = row.pdf_page_number
    ? {
        pageNumber: Number(row.pdf_page_number),
        boundingRect: parseJson(row.pdf_bounding_rect, undefined),
        bbox: parseJson(row.pdf_bbox, undefined),
        bboxCoordinateSystem: row.pdf_bbox_coordinate_system || undefined,
        bboxPageSize: parseJson(row.pdf_bbox_page_size, undefined),
        highlightColor: row.highlight_color || undefined,
      }
    : undefined;

  return {
    id: row.id,
    paperId: row.paper_id,
    type: row.type,
    title: row.title,
    content: row.content,
    contentJson: parseJson(row.content_json, null),
    contentHtml: row.content_html ?? null,
    contentText: row.content_text ?? null,
    excerpt: row.excerpt ?? undefined,
    pdfLocation,
    anchors: parseJson(row.anchors, []),
    aiChatId: row.ai_chat_id ?? undefined,
    aiChatMessageIds: parseJson(row.ai_chat_message_ids, []),
    linkedPaperId: row.linked_paper_id ?? null,
    folderId: row.folder_id ?? null,
    tags,
    color: row.color,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
    wordCount: Number(row.word_count) || 0,
    isFavorite: Boolean(row.is_favorite),
    isPinned: Boolean(row.is_pinned),
    linkedNoteIds: references ? normalizeStringList([...references.linkedNoteIds, ...linkedNoteIds]) : linkedNoteIds,
    linkedPaperIds: references ? normalizeStringList([...references.linkedPaperIds, ...linkedPaperIds]) : linkedPaperIds,
    unresolvedReferences: references?.unresolvedReferences ?? [],
    backlinks,
  };
}

function relatedRowsByNoteId(db, table, keyColumn, noteIds) {
  const output = new Map(noteIds.map((noteId) => [noteId, []]));
  if (noteIds.length === 0) return output;

  const placeholders = noteIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT note_id, ${keyColumn} AS value
    FROM ${table}
    WHERE note_id IN (${placeholders})
    ORDER BY value
  `).all(...noteIds);

  for (const row of rows) {
    output.get(row.note_id)?.push(row.value);
  }

  return output;
}

function linkRowsBySourceId(db, noteIds) {
  const output = new Map(noteIds.map((noteId) => [noteId, []]));
  if (noteIds.length === 0) return output;

  const placeholders = noteIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT source_note_id, target_note_id
    FROM note_links
    WHERE source_note_id IN (${placeholders})
    ORDER BY target_note_id
  `).all(...noteIds);

  for (const row of rows) {
    output.get(row.source_note_id)?.push(row.target_note_id);
  }

  return output;
}

function backlinkRowsByTargetId(db, noteIds) {
  const output = new Map(noteIds.map((noteId) => [noteId, []]));
  if (noteIds.length === 0) return output;

  const placeholders = noteIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      link.target_note_id,
      link.source_note_id,
      COALESCE(link.link_text, source.title) AS link_text,
      COALESCE(link.created_at, source.created_at) AS created_at,
      source.title AS source_title,
      source.excerpt AS source_excerpt,
      source.updated_at AS source_updated_at
    FROM note_links AS link
    INNER JOIN notes AS source ON source.id = link.source_note_id
    WHERE link.target_note_id IN (${placeholders})
      AND source.deleted_at IS NULL
    ORDER BY source.updated_at DESC
  `).all(...noteIds);

  for (const row of rows) {
    output.get(row.target_note_id)?.push({
      sourceNoteId: row.source_note_id,
      targetNoteId: row.target_note_id,
      linkText: row.link_text,
      sourceTitle: row.source_title,
      sourceExcerpt: row.source_excerpt,
      sourceUpdatedAt: Number(row.source_updated_at) || 0,
      createdAt: Number(row.created_at) || 0,
    });
  }

  return output;
}

function hydrateNotes(db, rows) {
  // Full-library reads can exceed SQLite's bound-parameter limit. Hydrate
  // related records in batches without limiting the returned note count.
  if (rows.length > 500) {
    const notes = [];
    for (let offset = 0; offset < rows.length; offset += 500) {
      notes.push(...hydrateNotes(db, rows.slice(offset, offset + 500)));
    }
    return notes;
  }
  const noteIds = rows.map((row) => row.id);
  const tagMap = relatedRowsByNoteId(db, 'note_tags', 'tag', noteIds);
  const paperLinkMap = relatedRowsByNoteId(db, 'note_paper_links', 'paper_id', noteIds);
  const noteLinkMap = linkRowsBySourceId(db, noteIds);
  const backlinkMap = backlinkRowsByTargetId(db, noteIds);

  return rows.map((row) =>
    rowToNote(
      row,
      tagMap.get(row.id) ?? [],
      noteLinkMap.get(row.id) ?? [],
      paperLinkMap.get(row.id) ?? [],
      backlinkMap.get(row.id) ?? [],
    ),
  );
}

function findNoteIdByTitle(db, title) {
  const normalized = cleanString(title);
  if (!normalized) return null;

  const row = db.prepare(`
    SELECT id
    FROM notes
    WHERE deleted_at IS NULL AND lower(title) = lower(?)
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(normalized);

  return row?.id ?? null;
}

function findNoteTitleById(db, noteId) {
  const row = db.prepare('SELECT title FROM notes WHERE id = ?').get(noteId);
  return row?.title ?? noteId;
}

function resolveNoteLinks(db, note) {
  const links = new Map();

  for (const targetNoteId of note.linkedNoteIds) {
    if (!targetNoteId || targetNoteId === note.id || targetNoteId.startsWith('unresolved:')
      || !db.prepare('SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL').get(targetNoteId)) continue;
    links.set(targetNoteId, findNoteTitleById(db, targetNoteId));
  }

  for (const title of note.linkedNoteTitles ?? []) {
    const targetNoteId = findNoteIdByTitle(db, title);
    if (!targetNoteId || targetNoteId === note.id) continue;
    links.set(targetNoteId, title);
  }

  return Array.from(links.entries()).map(([targetNoteId, linkText]) => ({
    targetNoteId,
    linkText,
  }));
}

function ftsTableExists(db) {
  try {
    const row = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'notes_fts'
      LIMIT 1
    `).get();
    return Boolean(row);
  } catch {
    return false;
  }
}

function deleteFtsRow(db, noteId) {
  if (!ftsTableExists(db)) return;
  try {
    db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId);
  } catch {}
}

function syncFtsRow(db, note) {
  if (!ftsTableExists(db)) return;
  try {
    deleteFtsRow(db, note.id);
    if (!note.deletedAt) {
      db.prepare(`
        INSERT INTO notes_fts (note_id, title, content_text, excerpt)
        VALUES (?, ?, ?, ?)
      `).run(note.id, note.title, note.contentText || note.content || '', note.excerpt || '');
    }
  } catch {}
}

function saveRelations(db, note) {
  db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(note.id);
  db.prepare('DELETE FROM note_links WHERE source_note_id = ?').run(note.id);
  db.prepare('DELETE FROM note_paper_links WHERE note_id = ?').run(note.id);

  const timestamp = note.updatedAt || now();
  const insertTag = db.prepare(
    'INSERT OR IGNORE INTO note_tags (note_id, tag, created_at) VALUES (?, ?, ?)',
  );
  const insertNoteLink = db.prepare(`
    INSERT OR IGNORE INTO note_links (source_note_id, target_note_id, link_text, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertPaperLink = db.prepare(
    'INSERT OR IGNORE INTO note_paper_links (note_id, paper_id) VALUES (?, ?)',
  );

  for (const tag of note.tags) insertTag.run(note.id, tag, timestamp);
  for (const link of resolveNoteLinks(db, note)) {
    insertNoteLink.run(note.id, link.targetNoteId, link.linkText, timestamp);
  }
  for (const paperId of note.linkedPaperIds.filter((paperId) => paperId !== note.paperId && !paperId.startsWith('unresolved:'))) {
    insertPaperLink.run(note.id, paperId);
  }
}

function upsertNote(db, note) {
  db.prepare(`
    INSERT INTO notes (
      id,
      paper_id,
      type,
      title,
      content,
      content_json,
      content_html,
      content_text,
      excerpt,
      anchors,
      reference_metadata,
      linked_paper_id,
      folder_id,
      pdf_page_number,
      pdf_bounding_rect,
      pdf_bbox,
      pdf_bbox_coordinate_system,
      pdf_bbox_page_size,
      highlight_color,
      ai_chat_id,
      ai_chat_message_ids,
      color,
      created_at,
      updated_at,
      deleted_at,
      word_count,
      is_favorite,
      is_pinned
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      paper_id = excluded.paper_id,
      type = excluded.type,
      title = excluded.title,
      content = excluded.content,
      content_json = excluded.content_json,
      content_html = excluded.content_html,
      content_text = excluded.content_text,
      excerpt = excluded.excerpt,
      anchors = excluded.anchors,
      reference_metadata = excluded.reference_metadata,
      linked_paper_id = excluded.linked_paper_id,
      folder_id = excluded.folder_id,
      pdf_page_number = excluded.pdf_page_number,
      pdf_bounding_rect = excluded.pdf_bounding_rect,
      pdf_bbox = excluded.pdf_bbox,
      pdf_bbox_coordinate_system = excluded.pdf_bbox_coordinate_system,
      pdf_bbox_page_size = excluded.pdf_bbox_page_size,
      highlight_color = excluded.highlight_color,
      ai_chat_id = excluded.ai_chat_id,
      ai_chat_message_ids = excluded.ai_chat_message_ids,
      color = excluded.color,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      word_count = excluded.word_count,
      is_favorite = excluded.is_favorite,
      is_pinned = excluded.is_pinned
  `).run(
    note.id,
    note.paperId,
    note.type,
    note.title,
    note.content,
    toJson(note.contentJson),
    note.contentHtml,
    note.contentText,
    note.excerpt,
    toJson(note.anchors),
    toJson(referenceMetadata(note)),
    note.linkedPaperId,
    note.folderId,
    note.pdfLocation?.pageNumber ?? null,
    toJson(note.pdfLocation?.boundingRect),
    toJson(note.pdfLocation?.bbox),
    note.pdfLocation?.bboxCoordinateSystem ?? null,
    toJson(note.pdfLocation?.bboxPageSize),
    note.pdfLocation?.highlightColor ?? null,
    note.aiChatId,
    toJson(note.aiChatMessageIds),
    note.color,
    note.createdAt,
    note.updatedAt,
    note.deletedAt,
    note.wordCount,
    note.isFavorite ? 1 : 0,
    note.isPinned ? 1 : 0,
  );
  saveRelations(db, note);
  syncFtsRow(db, note);
}

function getNoteById(db, noteId, options = {}) {
  const idValue = cleanString(noteId);
  if (!idValue) return null;

  const row = db.prepare(`
    SELECT *
    FROM notes
    WHERE id = ?
      ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'}
  `).get(idValue);
  return hydrateNotes(db, row ? [row] : [])[0] ?? null;
}

function createNoteStore(appPaths) {
  if (!appPaths?.notesDatabasePath) {
    throw new Error('notesDatabasePath is required');
  }

  let db = openDatabase(appPaths.notesDatabasePath);

  function queryNotes(request = {}, limit) {
    const paperId = cleanString(request.paperId);
    const linkedPaperId = cleanString(request.linkedPaperId);
    const type = cleanString(request.type);
    const tag = cleanString(request.tag).replace(/^#/, '');
    const search = cleanString(request.search).toLowerCase();
    const includeDeleted = request.includeDeleted === true;
    const where = [];
    const args = [];

    if (!includeDeleted) {
      where.push('deleted_at IS NULL');
    }
    if (paperId) {
      where.push('paper_id = ?');
      args.push(paperId);
    }
    if (linkedPaperId) {
      where.push('linked_paper_id = ?');
      args.push(linkedPaperId);
    }
    if (NOTE_TYPES.has(type)) {
      where.push('type = ?');
      args.push(type);
    }
    if (tag) {
      where.push('id IN (SELECT note_id FROM note_tags WHERE lower(tag) = lower(?))');
      args.push(tag);
    }
    if (search) {
      where.push("(lower(title) LIKE ? OR lower(content) LIKE ? OR lower(COALESCE(content_text, '')) LIKE ? OR lower(COALESCE(excerpt, '')) LIKE ?)");
      const pattern = `%${search}%`;
      args.push(pattern, pattern, pattern, pattern);
    }

    const rows = db.prepare(`
      SELECT *
      FROM notes
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY is_pinned DESC, updated_at DESC, created_at DESC
      ${limit === undefined ? '' : 'LIMIT ?'}
    `).all(...args, ...(limit === undefined ? [] : [limit]));

    return hydrateNotes(db, rows);
  }

  function listNotes(request = {}) {
    const limit = Math.max(1, Math.min(5000, Math.trunc(Number(request.limit)) || 500));
    return queryNotes(request, limit);
  }

  function listAllNotes(request = {}) {
    return queryNotes(request);
  }

  function listTags(request = {}) {
    const paperId = cleanString(request.paperId);
    const args = [];
    const where = ['notes.deleted_at IS NULL'];

    if (paperId) {
      where.push('notes.paper_id = ?');
      args.push(paperId);
    }

    return db.prepare(`
      SELECT note_tags.tag AS tag, COUNT(*) AS count
      FROM note_tags
      INNER JOIN notes ON notes.id = note_tags.note_id
      WHERE ${where.join(' AND ')}
      GROUP BY note_tags.tag
      ORDER BY count DESC, lower(note_tags.tag) ASC
    `).all(...args).map((row) => ({
      tag: row.tag,
      count: Number(row.count) || 0,
    }));
  }

  function createNote(request) {
    return withTransaction(db, () => {
      const note = normalizeNoteInput(request);
      upsertNote(db, note);
      return getNoteById(db, note.id);
    });
  }

  function updateNote(request) {
    const noteId = cleanString(request?.id);
    if (!noteId) throw new Error('note id is required');

    return withTransaction(db, () => {
      const existing = getNoteById(db, noteId, { includeDeleted: true });
      if (!existing) throw new Error(`Note does not exist: ${noteId}`);

      const note = normalizeNoteInput({ ...(request.patch ?? {}), id: noteId }, existing);
      upsertNote(db, note);
      return getNoteById(db, note.id, { includeDeleted: true });
    });
  }

  function deleteNote(request) {
    const noteId = cleanString(request?.id);
    if (!noteId) throw new Error('note id is required');
    const timestamp = now();

    db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(timestamp, timestamp, noteId);
    deleteFtsRow(db, noteId);
  }

  function close() {
    if (db.isOpen) {
      db.close();
    }
  }

  return {
    close,
    createNote,
    deleteNote,
    getNote(request) {
      return getNoteById(db, request?.id, {
        includeDeleted: request?.includeDeleted === true,
      });
    },
    listBacklinks(request = {}) {
      const noteId = cleanString(request.noteId);
      if (!noteId) return [];
      return backlinkRowsByTargetId(db, [noteId]).get(noteId) ?? [];
    },
    listNotes,
    listAllNotes,
    listTags,
    updateNote,
    snapshotTo(targetPath) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.rmSync(targetPath, { force: true });
      db.exec(`VACUUM main INTO ${sqlStringLiteral(targetPath)}`);
      return targetPath;
    },
    async replaceWithSnapshot(snapshotPath) {
      const tables = ['notes', 'note_tags', 'note_links', 'note_paper_links'];
      return withSnapshotDatabase(snapshotPath, openDatabase, (source) => {
        assertSnapshotTables(source, [...tables, 'notes_fts'], db);
        return withTransaction(db, () => {
          replaceTables(db, source, tables);
          if (ftsTableExists(db)) {
            db.exec(`DELETE FROM notes_fts;
              INSERT INTO notes_fts (note_id, title, content_text, excerpt)
              SELECT id, title, COALESCE(NULLIF(content_text, ''), content, ''), COALESCE(excerpt, '')
              FROM notes WHERE deleted_at IS NULL`);
          }
        });
      }, tables);
    },
  };
}

module.exports = { createNoteStore };
