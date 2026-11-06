const fs = require('node:fs');
const path = require('node:path');
const sqliteVec = require('sqlite-vec');
const { DatabaseSync, vacuumInto, withTransaction } = require('./nodeSqlite.cjs');
const { cleanString, toError } = require('./utils.cjs');
const { withSnapshotDatabase, assertSnapshotTables, copyTable, replaceTables } = require('./databaseRestore.cjs');
const { createHash } = require('node:crypto');

const RAG_SOURCE_TYPES = new Set(['mineru-markdown', 'pdf-text']);
const MAX_VECTOR_DIMENSION = 32768;
const RAG_SIMILARITY_LIMITS = Object.freeze({ documentKeys: 32, rows: 8192, vectorElements: 2000000, textBytes: 8 * 1024 * 1024, comparisons: 4096, edges: 512 });
const similarityFailure = code => { throw Object.assign(new Error(code), { code }); };
const similarityHash = value => createHash('sha256').update(value).digest('hex');
function cachedVector(bytes, dimension) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== dimension * 4) similarityFailure('RAG_SIMILARITY_INVALID');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), values = new Float64Array(dimension);
  for (let i = 0; i < dimension; i++) {
    const value = view.getFloat32(i * 4, true); if (!Number.isFinite(value)) similarityFailure('RAG_SIMILARITY_INVALID'); values[i] = value;
  }
  return values;
}

function resolveSqliteVecLoadablePath() {
  const loadablePath = typeof sqliteVec.getLoadablePath === 'function'
    ? sqliteVec.getLoadablePath()
    : '';
  const unpackedPath = loadablePath.replace(/\.asar([\\/])/, '.asar.unpacked$1');

  if (unpackedPath !== loadablePath && fs.existsSync(unpackedPath)) {
    return unpackedPath;
  }

  return loadablePath;
}

function loadSqliteVec(db) {
  const loadablePath = resolveSqliteVecLoadablePath();

  if (loadablePath) {
    db.loadExtension(loadablePath);
    return;
  }

  sqliteVec.load(db);
}

function normalizeDocumentKey(value) {
  const documentKey = cleanString(value);
  if (!documentKey) throw new Error('RAG documentKey is required');
  return documentKey;
}

function normalizeSourceType(value) {
  const sourceType = cleanString(value);
  if (!RAG_SOURCE_TYPES.has(sourceType)) {
    throw new Error(`Unsupported RAG sourceType: ${sourceType || '(empty)'}`);
  }
  return sourceType;
}

function normalizeRequiredString(value, label) {
  const text = cleanString(value);
  if (!text) throw new Error(`RAG ${label} is required`);
  return text;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.trunc(number));
}

function normalizeNullableInteger(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function normalizeVectorDimension(value) {
  const dimension = Number(value);
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_VECTOR_DIMENSION) {
    throw new Error(`Unsupported RAG embedding dimension: ${value}`);
  }
  return dimension;
}

function vectorTableName(dimension) {
  return `rag_vec_${normalizeVectorDimension(dimension)}`;
}

function validateEmbedding(embedding, expectedDimension = null) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('RAG chunk embedding must be a non-empty number array');
  }

  const dimension = normalizeVectorDimension(embedding.length);
  if (expectedDimension !== null && dimension !== expectedDimension) {
    throw new Error(`RAG chunk embedding dimension mismatch: expected ${expectedDimension}, got ${dimension}`);
  }

  for (const value of embedding) {
    if (!Number.isFinite(Number(value))) {
      throw new Error('RAG chunk embedding contains a non-finite value');
    }
  }

  return dimension;
}

function toFloat32Array(vector) {
  const output = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    output[index] = Number(vector[index]);
  }
  return output;
}

function cosineSimilarity(left, right) {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = Number(left[index]) || 0;
    const rightValue = Number(right[index]) || 0;

    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function averageVectors(vectors, dimension) {
  const output = new Array(dimension).fill(0);

  for (const vector of vectors) {
    for (let index = 0; index < dimension; index += 1) {
      output[index] += Number(vector[index]) || 0;
    }
  }

  return output.map((value) => value / Math.max(1, vectors.length));
}

function normalizeChunk(chunk, dimension) {
  const chunkId = cleanString(chunk?.chunkId) || `chunk-${normalizeNonNegativeInteger(chunk?.chunkIndex)}`;
  const chunkIndex = normalizeNonNegativeInteger(chunk?.chunkIndex);
  const pageIndex = chunk?.pageIndex === null || chunk?.pageIndex === undefined
    ? null
    : normalizeNonNegativeInteger(chunk.pageIndex);
  const blockId = cleanString(chunk?.blockId) || null;
  const text = typeof chunk?.text === 'string' ? chunk.text : String(chunk?.text ?? '');

  validateEmbedding(chunk?.embedding, dimension);

  return {
    chunkId,
    chunkIndex,
    pageIndex,
    blockId,
    text,
    embedding: chunk.embedding,
  };
}

function rowToStatus(row) {
  if (!row) return null;

  return {
    documentKey: row.document_key,
    sourceType: row.source_type,
    sourceSignature: row.source_signature,
    embeddingModelKey: row.embedding_model_key,
    embeddingDimension: Number(row.embedding_dimension) || 0,
    totalChunkCount: Number(row.total_chunk_count) || 0,
    chunkCount: Number(row.chunk_count) || 0,
    indexedChunkCount: Number(row.indexed_chunk_count) || 0,
    indexedAt: Number(row.indexed_at) || 0,
    status: row.status,
    lastError: row.last_error ?? null,
    failedAt: row.failed_at ?? null,
    retryAfterMs: row.retry_after_ms ?? null,
    cooldownUntil: row.cooldown_until ?? null,
  };
}

function createSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS rag_indexes (
      document_key TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT,
      source_signature TEXT NOT NULL,
      embedding_model_key TEXT NOT NULL,
      embedding_dimension INTEGER NOT NULL,
      total_chunk_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      indexed_chunk_count INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
      last_error TEXT,
      failed_at INTEGER,
      retry_after_ms INTEGER,
      cooldown_until INTEGER,
      PRIMARY KEY (document_key, source_type)
    );

    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_key TEXT NOT NULL,
      source_type TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      page_index INTEGER,
      block_id TEXT,
      text TEXT NOT NULL,
      UNIQUE (document_key, source_type, chunk_id)
    );

    CREATE INDEX IF NOT EXISTS idx_rag_chunks_document_source
      ON rag_chunks (document_key, source_type, chunk_index);

    CREATE TABLE IF NOT EXISTS rag_vec_dimensions (
      dimension INTEGER PRIMARY KEY
    );
  `);
}

function openDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, {
    allowExtension: true,
    timeout: 5000,
  });

  try {
    db.enableLoadExtension(true);
    try { loadSqliteVec(db); }
    finally { db.enableLoadExtension(false); }
    db.exec('PRAGMA journal_mode = WAL;');
    createSchema(db);
    return db;
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}

function ensureVectorTable(db, dimension) {
  const normalizedDimension = normalizeVectorDimension(dimension);
  const table = vectorTableName(normalizedDimension);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${table}
    USING vec0(
      document_key TEXT partition key,
      source_type TEXT partition key,
      embedding float[${normalizedDimension}]
    );
  `);
  db.prepare('INSERT OR IGNORE INTO rag_vec_dimensions (dimension) VALUES (?)').run(normalizedDimension);
  return table;
}

function hasVectorTable(db, dimension) {
  const row = db
    .prepare('SELECT dimension FROM rag_vec_dimensions WHERE dimension = ?')
    .get(normalizeVectorDimension(dimension));
  return Boolean(row);
}

function knownVectorDimensions(db) {
  return db
    .prepare('SELECT dimension FROM rag_vec_dimensions ORDER BY dimension')
    .all()
    .map((row) => Number(row.dimension))
    .filter((dimension) => Number.isSafeInteger(dimension) && dimension > 0);
}

function deleteVectorRowsByIds(db, ids) {
  if (ids.length === 0) return;

  for (const dimension of knownVectorDimensions(db)) {
    const table = vectorTableName(dimension);
    const statement = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);

    for (const id of ids) {
      statement.run(BigInt(id));
    }
  }
}

function chunkIdsForSource(db, documentKey, sourceType) {
  return db
    .prepare('SELECT id FROM rag_chunks WHERE document_key = ? AND source_type = ?')
    .all(documentKey, sourceType)
    .map((row) => Number(row.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

function deleteDocumentSourceData(db, documentKey, sourceType) {
  deleteVectorRowsByIds(db, chunkIdsForSource(db, documentKey, sourceType));
  db.prepare('DELETE FROM rag_chunks WHERE document_key = ? AND source_type = ?').run(documentKey, sourceType);
  db.prepare('DELETE FROM rag_indexes WHERE document_key = ? AND source_type = ?').run(documentKey, sourceType);
}

function getStatus(db, documentKey, sourceType) {
  return rowToStatus(
    db
      .prepare('SELECT * FROM rag_indexes WHERE document_key = ? AND source_type = ?')
      .get(documentKey, sourceType),
  );
}

function countChunks(db, documentKey, sourceType) {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM rag_chunks WHERE document_key = ? AND source_type = ?')
    .get(documentKey, sourceType);
  return Number(row?.count) || 0;
}

function upsertStatus(db, status) {
  db.prepare(`
    INSERT INTO rag_indexes (
      document_key,
      source_type,
      title,
      source_signature,
      embedding_model_key,
      embedding_dimension,
      total_chunk_count,
      chunk_count,
      indexed_chunk_count,
      indexed_at,
      status,
      last_error,
      failed_at,
      retry_after_ms,
      cooldown_until
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (document_key, source_type) DO UPDATE SET
      title = excluded.title,
      source_signature = excluded.source_signature,
      embedding_model_key = excluded.embedding_model_key,
      embedding_dimension = excluded.embedding_dimension,
      total_chunk_count = excluded.total_chunk_count,
      chunk_count = excluded.chunk_count,
      indexed_chunk_count = excluded.indexed_chunk_count,
      indexed_at = excluded.indexed_at,
      status = excluded.status,
      last_error = excluded.last_error,
      failed_at = excluded.failed_at,
      retry_after_ms = excluded.retry_after_ms,
      cooldown_until = excluded.cooldown_until
  `).run(
    status.documentKey,
    status.sourceType,
    status.title,
    status.sourceSignature,
    status.embeddingModelKey,
    status.embeddingDimension,
    status.totalChunkCount,
    status.chunkCount,
    status.indexedChunkCount,
    status.indexedAt,
    status.status,
    status.lastError,
    status.failedAt,
    status.retryAfterMs,
    status.cooldownUntil,
  );
}

function indexedSourceRows(db, documentKey, sourceType, dimension) {
  const sql = `
    SELECT source_type
    FROM rag_indexes
    WHERE document_key = ?
      AND status = 'ready'
      AND embedding_dimension = ?
      ${sourceType ? 'AND source_type = ?' : ''}
    ORDER BY source_type
  `;
  const args = sourceType ? [documentKey, dimension, sourceType] : [documentKey, dimension];
  return db.prepare(sql).all(...args);
}

function createRagStore(appPaths) {
  if (!appPaths?.ragDatabasePath) {
    throw new Error('ragDatabasePath is required');
  }

  let db = openDatabase(appPaths.ragDatabasePath);

  function indexDocument(request) {
    const documentKey = normalizeDocumentKey(request?.documentKey);
    const sourceType = normalizeSourceType(request?.sourceType);
    const title = cleanString(request?.title);
    const sourceSignature = normalizeRequiredString(request?.sourceSignature, 'sourceSignature');
    const embeddingModelKey = normalizeRequiredString(request?.embeddingModelKey, 'embeddingModelKey');
    const chunks = Array.isArray(request?.chunks) ? request.chunks : [];
    const totalChunkCount = normalizeNonNegativeInteger(request?.totalChunkCount, chunks.length);
    const dimension = chunks.length > 0 ? validateEmbedding(chunks[0]?.embedding) : 0;

    if (dimension > 0) {
      for (const chunk of chunks) {
        validateEmbedding(chunk?.embedding, dimension);
      }
    }

    return withTransaction(db, () => {
      const existing = getStatus(db, documentKey, sourceType);
      const shouldReset =
        !existing ||
        existing.status === 'failed' ||
        existing.sourceSignature !== sourceSignature ||
        existing.embeddingModelKey !== embeddingModelKey ||
        existing.embeddingDimension !== dimension;

      if (shouldReset) {
        deleteDocumentSourceData(db, documentKey, sourceType);
      }

      if (dimension === 0) {
        upsertStatus(db, {
          documentKey,
          sourceType,
          title,
          sourceSignature,
          embeddingModelKey,
          embeddingDimension: 0,
          totalChunkCount,
          chunkCount: 0,
          indexedChunkCount: 0,
          indexedAt: Date.now(),
          status: totalChunkCount === 0 ? 'ready' : 'pending',
          lastError: null,
          failedAt: null,
          retryAfterMs: null,
          cooldownUntil: null,
        });
        return;
      }

      const vectorTable = ensureVectorTable(db, dimension);
      const selectChunk = db.prepare(
        'SELECT id FROM rag_chunks WHERE document_key = ? AND source_type = ? AND chunk_id = ?',
      );
      const insertChunk = db.prepare(`
        INSERT INTO rag_chunks (
          document_key,
          source_type,
          chunk_id,
          chunk_index,
          page_index,
          block_id,
          text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const updateChunk = db.prepare(`
        UPDATE rag_chunks
        SET chunk_index = ?, page_index = ?, block_id = ?, text = ?
        WHERE id = ?
      `);
      const lastInsertedId = db.prepare('SELECT last_insert_rowid() AS id');
      const insertVector = db.prepare(`
        INSERT INTO ${vectorTable} (rowid, document_key, source_type, embedding)
        VALUES (?, ?, ?, ?)
      `);

      for (const rawChunk of chunks) {
        const chunk = normalizeChunk(rawChunk, dimension);
        const existingChunk = selectChunk.get(documentKey, sourceType, chunk.chunkId);
        let chunkRowId;

        if (existingChunk) {
          chunkRowId = Number(existingChunk.id);
          deleteVectorRowsByIds(db, [chunkRowId]);
          updateChunk.run(chunk.chunkIndex, chunk.pageIndex, chunk.blockId, chunk.text, chunkRowId);
        } else {
          insertChunk.run(
            documentKey,
            sourceType,
            chunk.chunkId,
            chunk.chunkIndex,
            chunk.pageIndex,
            chunk.blockId,
            chunk.text,
          );
          chunkRowId = Number(lastInsertedId.get().id);
        }

        insertVector.run(
          BigInt(chunkRowId),
          documentKey,
          sourceType,
          toFloat32Array(chunk.embedding),
        );
      }

      const indexedChunkCount = countChunks(db, documentKey, sourceType);
      upsertStatus(db, {
        documentKey,
        sourceType,
        title,
        sourceSignature,
        embeddingModelKey,
        embeddingDimension: dimension,
        totalChunkCount,
        chunkCount: indexedChunkCount,
        indexedChunkCount,
        indexedAt: Date.now(),
        status: indexedChunkCount >= totalChunkCount ? 'ready' : 'pending',
        lastError: null,
        failedAt: null,
        retryAfterMs: null,
        cooldownUntil: null,
      });
    });
  }

  function reportFailure(request) {
    const documentKey = normalizeDocumentKey(request?.documentKey);
    const sourceType = normalizeSourceType(request?.sourceType);
    const title = cleanString(request?.title);
    const sourceSignature = normalizeRequiredString(request?.sourceSignature, 'sourceSignature');
    const embeddingModelKey = normalizeRequiredString(request?.embeddingModelKey, 'embeddingModelKey');
    const retryAfterMs = normalizeNullableInteger(request?.retryAfterMs);
    const failedAt = Date.now();

    return withTransaction(db, () => {
      deleteDocumentSourceData(db, documentKey, sourceType);
      upsertStatus(db, {
        documentKey,
        sourceType,
        title,
        sourceSignature,
        embeddingModelKey,
        embeddingDimension: 0,
        totalChunkCount: normalizeNonNegativeInteger(request?.totalChunkCount),
        chunkCount: 0,
        indexedChunkCount: 0,
        indexedAt: 0,
        status: 'failed',
        lastError: cleanString(request?.errorMessage) || 'RAG index failed',
        failedAt,
        retryAfterMs,
        cooldownUntil: retryAfterMs ? failedAt + retryAfterMs : null,
      });
    });
  }

  function getDocumentIndexStatus(request) {
    const documentKey = normalizeDocumentKey(request?.documentKey);
    const sourceType = normalizeSourceType(request?.sourceType);
    return getStatus(db, documentKey, sourceType);
  }

  function retrieveDocumentChunks(request) {
    const documentKey = normalizeDocumentKey(request?.documentKey);
    const sourceType = request?.sourceType ? normalizeSourceType(request.sourceType) : null;
    const topK = Math.max(1, normalizeNonNegativeInteger(request?.topK, 6));
    const dimension = validateEmbedding(request?.queryEmbedding);

    if (!hasVectorTable(db, dimension)) {
      return [];
    }

    const vectorTable = vectorTableName(dimension);
    const queryEmbedding = toFloat32Array(request.queryEmbedding);
    const sourceRows = indexedSourceRows(db, documentKey, sourceType, dimension);
    const search = db.prepare(`
      SELECT
        c.chunk_id,
        c.source_type,
        c.page_index,
        c.block_id,
        c.text,
        v.distance
      FROM ${vectorTable} v
      JOIN rag_chunks c ON c.id = v.rowid
      WHERE v.embedding MATCH ?
        AND k = ?
        AND v.document_key = ?
        AND v.source_type = ?
      ORDER BY v.distance
    `);
    const results = [];

    for (const row of sourceRows) {
      results.push(
        ...search.all(queryEmbedding, topK, documentKey, row.source_type).map((chunk) => ({
          chunkId: chunk.chunk_id,
          sourceType: chunk.source_type,
          pageIndex: chunk.page_index ?? null,
          blockId: chunk.block_id ?? null,
          text: chunk.text,
          score: Number(chunk.distance) || 0,
        })),
      );
    }

    return results
      .sort((left, right) => left.score - right.score)
      .slice(0, topK);
  }

  function similarityOptions(request, strict) {
    const limits = RAG_SIMILARITY_LIMITS;
    if (strict && (!request || Object.getPrototypeOf(request) !== Object.prototype
      || Reflect.ownKeys(request).some(key => typeof key !== 'string' || !['documentKeys', 'minSimilarity', 'maxRows', 'maxVectorElements', 'maxTextBytes', 'maxComparisons', 'maxEdges'].includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(request)).some(row => !row.enumerable || !('value' in row)))) similarityFailure('RAG_SIMILARITY_INVALID');
    if (strict && (!Array.isArray(request.documentKeys) || Object.getPrototypeOf(request.documentKeys) !== Array.prototype
      || Reflect.ownKeys(request.documentKeys).length !== request.documentKeys.length + 1 || Object.keys(request.documentKeys).length !== request.documentKeys.length
      || Object.values(Object.getOwnPropertyDescriptors(request.documentKeys)).some(row => !('value' in row)))) similarityFailure('RAG_SIMILARITY_INVALID');
    const keys = Array.isArray(request.documentKeys) ? [...new Set(request.documentKeys.map(key => cleanString(key)).filter(Boolean))].sort() : null;
    if (strict && (!Array.isArray(request.documentKeys) || !keys || keys.length !== request.documentKeys.length
      || keys.length > limits.documentKeys || keys.some(key => key.length > 1024) || request.documentKeys.some(key => typeof key !== 'string' || key !== key.trim()))) similarityFailure('RAG_SIMILARITY_INVALID');
    const rawMinimum = request.minSimilarity === undefined ? 0.82 : request.minSimilarity, minimum = Number(rawMinimum);
    if (strict && (typeof rawMinimum !== 'number' || !Number.isFinite(minimum) || minimum < -1 || minimum > 1)) similarityFailure('RAG_SIMILARITY_INVALID');
    const budget = (name, maximum) => {
      if (!strict) return Infinity;
      const value = request[name] ?? maximum;
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum) similarityFailure('RAG_SIMILARITY_LIMIT'); return value;
    };
    return { keys, minimum: Number.isFinite(minimum) ? Math.max(-1, Math.min(1, minimum)) : 0.82,
      rows: budget('maxRows', limits.rows), elements: budget('maxVectorElements', limits.vectorElements), text: budget('maxTextBytes', limits.textBytes),
      comparisons: budget('maxComparisons', limits.comparisons), edges: budget('maxEdges', limits.edges) };
  }

  function computeDocumentSimilarities(request, strict) {
    const options = similarityOptions(request, strict), grouped = new Map();
    const stats = { rows: 0, vectorElements: 0, textBytes: 0, comparisons: 0 };
    if (options.keys && !options.keys.length) return { documents: [], similarities: [], fingerprint: similarityHash('[]'), stats };
    const clauses = options.keys ? ` AND document_key IN (${options.keys.map(() => '?').join(',')})` : '';
    const indexes = db.prepare(`SELECT document_key, source_type, source_signature, embedding_model_key, embedding_dimension,
      chunk_count, indexed_chunk_count, total_chunk_count, indexed_at FROM rag_indexes WHERE status = 'ready'${clauses}
      ORDER BY document_key, embedding_model_key, embedding_dimension, source_type`).all(...(options.keys || []));
    for (const index of indexes) {
      const dimension = Number(index.embedding_dimension), modelKey = index.embedding_model_key;
      if (dimension === 0 && Number(index.indexed_chunk_count) === 0) continue;
      if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_VECTOR_DIMENSION
        || !Number.isSafeInteger(Number(index.total_chunk_count)) || Number(index.total_chunk_count) < 0
        || typeof modelKey !== 'string' || !modelKey.trim() || modelKey.length > 16384 || typeof index.source_signature !== 'string'
        || index.source_signature.length > 65536 || !Number.isSafeInteger(Number(index.indexed_at)) || Number(index.indexed_at) < 0) similarityFailure('RAG_SIMILARITY_INVALID');
      if (!hasVectorTable(db, dimension)) similarityFailure('RAG_SIMILARITY_INVALID');
      const table = vectorTableName(dimension), parameters = [index.document_key, index.source_type];
      const count = db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(length(CAST(c.text AS BLOB))), 0) AS text_bytes
        FROM ${table} v JOIN rag_chunks c ON c.id = v.rowid
        WHERE v.document_key = ? AND v.source_type = ? AND c.document_key = v.document_key AND c.source_type = v.source_type`).get(...parameters);
      const rowsCount = Number(count.rows), textBytes = Number(count.text_bytes);
      if (!Number.isSafeInteger(rowsCount) || rowsCount !== Number(index.indexed_chunk_count) || rowsCount !== Number(index.chunk_count)
        || rowsCount < Number(index.total_chunk_count) || rowsCount < 1 || !Number.isSafeInteger(textBytes) || textBytes < 0) similarityFailure('RAG_SIMILARITY_INVALID');
      stats.rows += rowsCount; stats.vectorElements += rowsCount * dimension; stats.textBytes += textBytes;
      if (stats.rows > options.rows || stats.vectorElements > options.elements || strict && stats.textBytes > options.text) similarityFailure('RAG_SIMILARITY_LIMIT');
      const rows = db.prepare(`SELECT c.chunk_id, c.chunk_index, c.page_index, c.block_id, ${strict ? 'c.text,' : ''} v.embedding
        FROM ${table} v JOIN rag_chunks c ON c.id = v.rowid
        WHERE v.document_key = ? AND v.source_type = ? AND c.document_key = v.document_key AND c.source_type = v.source_type
        ORDER BY c.chunk_index, c.chunk_id, c.id`).all(...parameters);
      if (rows.length !== rowsCount) similarityFailure('RAG_SIMILARITY_INVALID');
      // One exact provider/model/input-format key defines one vector space.
      // Neither equal dimension nor equal display model name proves compatibility.
      const key = JSON.stringify([index.document_key, dimension, modelKey]), entry = grouped.get(key) || {
        documentKey: index.document_key, dimension, modelKey, modelDigest: similarityHash(modelKey), sourceTypes: new Set(),
        sum: new Float64Array(dimension), count: 0, indexedAt: 0, parts: [],
      };
      const digest = strict ? createHash('sha256').update(JSON.stringify(['paperquay-rag-source-v1', index.source_type, index.source_signature, modelKey,
        dimension, Number(index.indexed_at), rowsCount, Number(index.total_chunk_count)])) : null;
      for (const row of rows) {
        const vector = cachedVector(row.embedding, dimension);
        for (let i = 0; i < dimension; i++) entry.sum[i] += vector[i];
        entry.count++;
        if (digest) {
          digest.update(JSON.stringify([row.chunk_id, row.chunk_index, row.page_index, row.block_id, row.text]));
          digest.update(Buffer.from(row.embedding));
        }
      }
      entry.indexedAt = Math.max(entry.indexedAt, Number(index.indexed_at)); entry.sourceTypes.add(index.source_type);
      if (digest) entry.parts.push({ sourceType: index.source_type, digest: digest.digest('hex') }); grouped.set(key, entry);
    }
    const documents = [...grouped.values()].map(entry => ({ documentKey: entry.documentKey, dimension: entry.dimension, modelDigest: entry.modelDigest,
      sourceTypes: [...entry.sourceTypes].sort(), chunkCount: entry.count, indexedAt: entry.indexedAt,
      cacheDigest: strict ? similarityHash(JSON.stringify(['mean-chunk-cosine-v1', entry.dimension, entry.modelDigest, entry.parts])) : '',
      modelKey: entry.modelKey, vector: entry.sum.map(value => value / entry.count) }));
    const similarities = [];
    for (let leftIndex = 0; leftIndex < documents.length; leftIndex++) for (let rightIndex = leftIndex + 1; rightIndex < documents.length; rightIndex++) {
      const left = documents[leftIndex], right = documents[rightIndex];
      if (left.documentKey === right.documentKey || left.dimension !== right.dimension || left.modelKey !== right.modelKey) continue;
      if (++stats.comparisons > options.comparisons) similarityFailure('RAG_SIMILARITY_LIMIT');
      const similarity = Math.max(-1, Math.min(1, cosineSimilarity(left.vector, right.vector))); if (!Number.isFinite(similarity)) similarityFailure('RAG_SIMILARITY_INVALID');
      if (similarity < options.minimum) continue;
      if (similarities.length >= options.edges) similarityFailure('RAG_SIMILARITY_LIMIT');
      similarities.push({ sourceDocumentKey: left.documentKey, targetDocumentKey: right.documentKey, similarity, dimension: left.dimension,
        modelDigest: left.modelDigest, sourceCacheDigest: left.cacheDigest, targetCacheDigest: right.cacheDigest, indexedAt: Math.max(left.indexedAt, right.indexedAt),
        sourceTypes: [...new Set([...left.sourceTypes, ...right.sourceTypes])].sort() });
    }
    similarities.sort((left, right) => right.similarity - left.similarity || left.sourceDocumentKey.localeCompare(right.sourceDocumentKey)
      || left.targetDocumentKey.localeCompare(right.targetDocumentKey) || left.modelDigest.localeCompare(right.modelDigest));
    const publicDocuments = documents.map(({ modelKey: _modelKey, vector: _vector, ...row }) => row);
    return { documents: publicDocuments, similarities, stats, fingerprint: similarityHash(JSON.stringify([options.keys, publicDocuments])) };
  }

  function readSimilaritySnapshot(request, strict) {
    db.exec('BEGIN');
    try { const value = computeDocumentSimilarities(request, strict); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  function listDocumentSimilarities(request = {}) {
    const limit = Math.max(0, normalizeNonNegativeInteger(request.limit, 80)); if (!limit) return [];
    return readSimilaritySnapshot(request, false).similarities.slice(0, limit)
      .map(({ sourceDocumentKey, targetDocumentKey, similarity, sourceTypes }) => ({ sourceDocumentKey, targetDocumentKey, similarity, sourceTypes }));
  }

  /** Explicit bounded evidence capture. No index creation, text/vector export,
   * implicit model request, partial result or truncation occurs here. */
  function captureDocumentSimilarityEvidence(request = {}) {
    return readSimilaritySnapshot(request, true);
  }
  function migrateFromLibraryRagIndexes(ragIndexes) {
    const entries = Object.entries(ragIndexes && typeof ragIndexes === 'object' ? ragIndexes : {});
    const summary = {
      migratedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      errors: [],
    };

    for (const [key, value] of entries) {
      try {
        const status = value?.status ?? {};
        const keyParts = key.split('::');
        const fallbackSourceType = keyParts.pop();
        const fallbackDocumentKey = keyParts.join('::');
        const documentKey = status.documentKey || fallbackDocumentKey;
        const sourceType = status.sourceType || fallbackSourceType;

        if (status.status === 'failed') {
          reportFailure({
            documentKey,
            title: value?.title || '',
            sourceType,
            sourceSignature: status.sourceSignature,
            embeddingModelKey: status.embeddingModelKey,
            totalChunkCount: status.totalChunkCount,
            errorMessage: status.lastError || 'Legacy RAG index failed',
            retryAfterMs: status.retryAfterMs,
          });
          summary.migratedCount += 1;
          continue;
        }

        const chunks = (Array.isArray(value?.chunks) ? value.chunks : []).filter((chunk) =>
          Array.isArray(chunk?.embedding) && chunk.embedding.length > 0,
        );

        indexDocument({
          documentKey,
          title: value?.title || '',
          sourceType,
          sourceSignature: status.sourceSignature,
          embeddingModelKey: status.embeddingModelKey,
          totalChunkCount: status.totalChunkCount ?? chunks.length,
          chunks,
        });
        summary.migratedCount += 1;
      } catch (error) {
        summary.failedCount += 1;
        summary.errors.push({ key, message: toError(error) });
      }
    }

    summary.skippedCount = entries.length - summary.migratedCount - summary.failedCount;
    return summary;
  }

  function close() {
    if (db.isOpen) {
      db.close();
    }
  }

  return {
    close,
    getDocumentIndexStatus,
    indexDocument,
    listDocumentSimilarities,
    captureDocumentSimilarityEvidence,
    migrateFromLibraryRagIndexes,
    reportFailure,
    retrieveDocumentChunks,
    snapshotTo(targetPath) {
      return vacuumInto(db, targetPath);
    },
    async replaceWithSnapshot(snapshotPath) {
      const tables = ['rag_indexes', 'rag_chunks', 'rag_vec_dimensions'];
      return withSnapshotDatabase(snapshotPath, openDatabase, (source) => {
        const dimensions = knownVectorDimensions(source).map(normalizeVectorDimension);
        // sqlite-vec reports its embedding chunk table as an ordinary table,
        // unlike its other shadow tables. There is one embedding column here.
        assertSnapshotTables(source, [...tables, ...dimensions.flatMap(dimension => {
          const table = vectorTableName(dimension);
          return [table, `${table}_vector_chunks00`];
        })], db);
        return withTransaction(db, () => {
          for (const dimension of knownVectorDimensions(db)) db.exec(`DROP TABLE ${vectorTableName(dimension)}`);
          replaceTables(db, source, tables);
          db.prepare("DELETE FROM sqlite_sequence WHERE name = 'rag_chunks'").run();
          const sequence = source.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'rag_chunks'");
          sequence.setReadBigInts(true);
          const row = sequence.get();
          if (row) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('rag_chunks', ?)").run(row.seq);
          for (const dimension of dimensions) {
            const table = ensureVectorTable(db, dimension);
            copyTable(db, source, table, ['rowid', 'document_key', 'source_type', 'embedding']);
          }
        });
      }, tables);
    },
  };
}

module.exports = { createRagStore, RAG_SIMILARITY_LIMITS };
