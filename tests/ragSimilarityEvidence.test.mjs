import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRagStore } = require('../electron/backend/ragStore.cjs');
const { DatabaseSync } = require('../electron/backend/nodeSqlite.cjs');
const sqliteVec = require('sqlite-vec');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-graph-vector-')), databasePath = path.join(directory, 'rag.sqlite');
  const store = createRagStore({ ragDatabasePath: databasePath });
  function index(documentKey, embedding, model = 'same-provider::model-a::4', sourceType = 'pdf-text', extra = {}) {
    store.indexDocument({ documentKey, title: documentKey, sourceType, sourceSignature: 'signature-' + documentKey, embeddingModelKey: model,
      totalChunkCount: 1, chunks: [{ chunkId: 'one', chunkIndex: 0, pageIndex: 0, text: 'Fixture private body ' + documentKey, embedding }], ...extra });
  }
  t.after(() => { store.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('paperquay-graph-vector-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, index, databasePath };
}

test('actual sqlite-vec values are Float32 byte blobs, not arrays of scalar vector elements', t => {
  const f = fixture(t); f.index('a', [1, .5, .25, 0]); const db = new DatabaseSync(f.databasePath, { allowExtension: true });
  try {
    db.enableLoadExtension(true); sqliteVec.load(db); db.enableLoadExtension(false);
    const row = db.prepare('SELECT embedding FROM rag_vec_4 LIMIT 1').get(); assert.ok(row.embedding instanceof Uint8Array); assert.equal(row.embedding.byteLength, 16);
    const bytes = Buffer.from(row.embedding); assert.deepEqual([0, 4, 8, 12].map(offset => bytes.readFloatLE(offset)), [1, .5, .25, 0]);
  } finally { db.close(); }
});

test('same-model ready caches yield the actual mean-chunk cosine similarity', t => {
  const f = fixture(t); f.index('a', [1, 0, 0, 0]); f.index('b', [1, 0, 0, 0]);
  const edges = f.store.listDocumentSimilarities({ documentKeys: ['a', 'b'], minSimilarity: .9 }); assert.equal(edges.length, 1); assert.equal(edges[0].similarity, 1);
});

test('equal dimensions and vectors from different model or provider keys never become similarity edges', t => {
  const f = fixture(t); f.index('a', [1, 0, 0, 0], 'private-provider-a::model::4'); f.index('b', [1, 0, 0, 0], 'private-provider-b::model::4');
  assert.deepEqual(f.store.listDocumentSimilarities({ documentKeys: ['a', 'b'], minSimilarity: -1 }), []);
});

test('bounded evidence preserves cache provenance without exporting model keys, signatures, raw text or vectors', t => {
  const f = fixture(t); f.index('a', [1, 0, 0, 0]); f.index('b', [1, 0, 0, 0]);
  const evidence = f.store.captureDocumentSimilarityEvidence({ documentKeys: ['a', 'b'] });
  assert.equal(evidence.similarities.length, 1); assert.equal(evidence.similarities[0].similarity, 1);
  assert.equal(evidence.documents.length, 2); assert.deepEqual(evidence.stats, { rows: 2, vectorElements: 8,
    textBytes: Buffer.byteLength('Fixture private body a') + Buffer.byteLength('Fixture private body b'), comparisons: 1 });
  for (const row of evidence.documents) { assert.match(row.cacheDigest, /^[0-9a-f]{64}$/); assert.match(row.modelDigest, /^[0-9a-f]{64}$/); }
  for (const value of ['same-provider', 'Fixture private body', 'signature-', 'embedding', 'modelKey', '"vector"']) assert(!JSON.stringify(evidence).includes(value), value);
  assert.deepEqual(f.store.captureDocumentSimilarityEvidence({ documentKeys: ['b', 'a'] }), evidence);
});

test('source types sharing the exact model space average their chunks, while another model remains separate', t => {
  const f = fixture(t); f.index('a', [1, 0, 0, 0]); f.index('a', [0, 1, 0, 0], 'same-provider::model-a::4', 'mineru-markdown');
  f.index('b', [1, 1, 0, 0]); let evidence = f.store.captureDocumentSimilarityEvidence({ documentKeys: ['a', 'b'] });
  assert.equal(evidence.documents.length, 2); assert(Math.abs(evidence.similarities[0].similarity - 1) < 1e-12);
  assert.deepEqual(evidence.similarities[0].sourceTypes, ['mineru-markdown', 'pdf-text']);
  f.index('a', [0, 1, 0, 0], 'same-provider::model-b::4', 'mineru-markdown');
  evidence = f.store.captureDocumentSimilarityEvidence({ documentKeys: ['a', 'b'], minSimilarity: -1 });
  assert.equal(evidence.documents.length, 3); assert.equal(evidence.similarities.length, 1);
  assert(Math.abs(evidence.similarities[0].similarity - Math.SQRT1_2) < 1e-12);
});

test('ready-only evidence ignores pending and failed indexes without creating or changing cache rows', t => {
  const f = fixture(t); f.index('ready', [1, 0, 0, 0]); f.index('pending', [1, 0, 0, 0], undefined, 'pdf-text', { totalChunkCount: 2 });
  f.store.reportFailure({ documentKey: 'failed', sourceType: 'pdf-text', sourceSignature: 'sig', embeddingModelKey: 'same-provider::model-a::4', message: 'Fixture failure' });
  const before = ['ready', 'pending', 'failed'].map(documentKey => f.store.getDocumentIndexStatus({ documentKey, sourceType: 'pdf-text' }));
  const evidence = f.store.captureDocumentSimilarityEvidence({ documentKeys: ['ready', 'pending', 'failed', 'absent'] });
  assert.deepEqual(evidence.documents.map(row => row.documentKey), ['ready']); assert.deepEqual(evidence.similarities, []);
  assert.deepEqual(['ready', 'pending', 'failed'].map(documentKey => f.store.getDocumentIndexStatus({ documentKey, sourceType: 'pdf-text' })), before);
});

test('every evidence budget fails atomically and leaves the same store usable for a subsequent complete capture', t => {
  const f = fixture(t); f.index('a', [1, 0, 0, 0]); f.index('b', [1, 0, 0, 0]);
  for (const budget of [{ maxRows: 1 }, { maxVectorElements: 7 }, { maxTextBytes: 1 }, { maxComparisons: 0 }, { maxEdges: 0 }]) {
    assert.throws(() => f.store.captureDocumentSimilarityEvidence({ documentKeys: ['a', 'b'], ...budget }), { code: 'RAG_SIMILARITY_LIMIT' });
    assert.equal(f.store.captureDocumentSimilarityEvidence({ documentKeys: ['a', 'b'] }).similarities.length, 1);
  }
  assert.throws(() => f.store.captureDocumentSimilarityEvidence({ documentKeys: ['a'], maxRows: 8193 }), { code: 'RAG_SIMILARITY_LIMIT' });
  for (const request of [{}, { documentKeys: ['a', 'a'] }, { documentKeys: [' a'] }, { documentKeys: ['a'], minSimilarity: '0.8' },
    { documentKeys: ['a'], minSimilarity: null }, { documentKeys: ['a'], arbitrary: true }, { documentKeys: ['a'], [Symbol('hidden')]: true },
    { get documentKeys() { throw Error('Getter must not run'); } }, { documentKeys: Array(1) }])
    assert.throws(() => f.store.captureDocumentSimilarityEvidence(request), { code: 'RAG_SIMILARITY_INVALID' });
});

test('body-only cache edits alter the evidence fingerprint without leaking the changed body', t => {
  const f = fixture(t); f.index('a', [1, 0, 0, 0]); f.index('b', [1, 0, 0, 0]);
  const before = f.store.captureDocumentSimilarityEvidence({ documentKeys: ['a', 'b'] }), db = new DatabaseSync(f.databasePath);
  try { db.prepare('UPDATE rag_chunks SET text = ? WHERE document_key = ?').run('A changed private body', 'a'); } finally { db.close(); }
  const after = f.store.captureDocumentSimilarityEvidence({ documentKeys: ['a', 'b'] });
  assert.notEqual(after.fingerprint, before.fingerprint); assert.equal(after.similarities[0].similarity, before.similarities[0].similarity);
  assert.notEqual(after.documents[0].cacheDigest, before.documents[0].cacheDigest); assert(!JSON.stringify(after).includes('A changed private body'));
});

test('corrupted complete-cache counters fail capture without returning a partial graph', t => {
  const f = fixture(t); f.index('a', [1, 0, 0, 0]); f.index('b', [1, 0, 0, 0]); const db = new DatabaseSync(f.databasePath);
  try { db.prepare('UPDATE rag_indexes SET indexed_chunk_count = 2 WHERE document_key = ?').run('b'); } finally { db.close(); }
  assert.throws(() => f.store.captureDocumentSimilarityEvidence({ documentKeys: ['a', 'b'] }), { code: 'RAG_SIMILARITY_INVALID' });
});
