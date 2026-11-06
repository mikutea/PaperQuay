import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as core from '../packages/sync-core/src/index.ts';
const require = createRequire(import.meta.url);
const { createLibraryStore } = require('../electron/backend/libraryStore.cjs');
const { createRagStore } = require('../electron/backend/ragStore.cjs');
const { createDesktopGraphEvidence } = require('../electron/backend/desktopGraphEvidence.cjs');
const { DatabaseSync } = require('../electron/backend/nodeSqlite.cjs');
const at = '2026-11-04T12:00:00.000Z';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-graph-evidence-'));
  const context = { appPaths: { dataDir: directory, libraryPath: path.join(directory, 'library.json'), libraryDatabasePath: path.join(directory, 'library.sqlite'), ragDatabasePath: path.join(directory, 'rag.sqlite') } };
  context.store = createLibraryStore(context.appPaths); context.ragStore = createRagStore(context.appPaths);
  let snapshot = { config: { apiBaseUrl: 'https://sync.example.test', oidcIssuer: 'https://login.example.test', oidcClientId: 'fixture-desktop' },
    account: { accountId: randomUUID(), deviceId: randomUUID() }, epoch: 1, library: { libraryBindingId: randomUUID() } }, bindings = [];
  const manager = createDesktopGraphEvidence(context, { core, now: () => Date.parse(at), getContext: () => snapshot,
    checkContext(owner) { if (owner.epoch !== snapshot.epoch) throw Object.assign(Error('Owner changed'), { code: 'DESKTOP_OPERATION_CANCELLED' }); },
    getMaterialBindings: () => ({ bindings }) });
  function local(id, title = 'Paper ' + id, bound = true) {
    const library = context.store.load(), entityId = randomUUID();
    library.papers.push({ id, title, doi: '10.1234/' + id, year: '2026', publication: 'Fixture Journal', abstractText: 'Private abstract ' + id,
      authors: [{ id: 'author-' + id, name: 'Author ' + id, order: 0 }], keywords: ['Key'], attachments: [], tags: [], categoryIds: [],
      importedAt: 10, updatedAt: 10, storedPath: 'C:\\fixture-private\\' + id + '.pdf', userNote: 'Private body ' + id });
    context.store.saveSync(library);
    if (bound) bindings.push({ localPaperId: id, entityId, versions: [{ versionId: randomUUID(), sha256: 'a'.repeat(64), sizeBytes: 1024 }] });
    return { localPaperId: id, entityId };
  }
  function edit(id, patch) { const library = context.store.load(); Object.assign(library.papers.find(row => row.id === id), patch); context.store.saveSync(library); }
  function reference(source, target, patch = {}) { return context.store.saveReferences(source, [{ title: context.store.load().papers.find(row => row.id === target).title,
    doi: '10.1234/' + target, seq: 1, fetchedAt: 1, unstructured: 'Private raw citation body', ...patch }]); }
  function index(id, vector = [1, 0, 0, 0], patch = {}) { context.ragStore.indexDocument({ documentKey: 'native-library:' + id, sourceType: 'pdf-text',
    title: 'Private title', sourceSignature: 'C:\\fixture-private\\source-signature', embeddingModelKey: 'https://private-provider.example.test::secret-fixture-key::model::4',
    totalChunkCount: 1, chunks: [{ chunkId: 'one', chunkIndex: 0, pageIndex: 0, blockId: null, text: 'Private full paper body ' + id, embedding: vector }], ...patch }); }
  const preview = (ids = ['one', 'two'], options = {}) => manager.preview({ localPaperIds: ids, includeReferences: true, includeSimilarity: true, ...options });
  t.after(() => { manager.close(); context.ragStore.close(); context.store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('paperquay-graph-evidence-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return { context, manager, local, edit, reference, index, preview, get bindings() { return bindings; }, setBindings(value) { bindings = value; },
    get snapshot() { return snapshot; }, setSnapshot(value) { snapshot = value; } };
}

test('actual SQLite capture exports only confirmed selected graph sources and hashed historical provenance, without changing library or caches', async t => {
  const f = fixture(t), one = f.local('one'), two = f.local('two'); f.reference('one', 'two'); f.index('one'); f.index('two');
  const before = core.canonicalJson([f.context.store.load(), f.context.store.loadAllReferences(), f.context.ragStore.captureDocumentSimilarityEvidence({ documentKeys: ['native-library:one', 'native-library:two'] })]);
  const list = await f.manager.list(); assert.equal(list.papers.length, 2); assert(list.papers.every(row => row.bound));
  const preview = await f.preview(), checked = await core.verifyGraphEvidence(preview.snapshot);
  assert.deepEqual(checked.sources.map(row => row.paperId).sort(), [one.entityId, two.entityId].sort());
  assert.deepEqual(preview.counts, { sources: 2, citations: 1, similarities: 1, skipped: 0 });
  assert.equal(checked.createdAt, at); assert.equal(checked.edges.find(row => row.kind === 'similarity').score, 1);
  assert(checked.edges.every(row => row.provenance.pdfVersionVerified === false));
  for (const privateValue of ['native-library:', 'localPaperId', 'C:\\fixture-private', 'private-provider', 'secret-fixture-key', 'Private raw', 'Private full', 'Private abstract', 'embeddingModelKey'])
    assert(!JSON.stringify(checked).includes(privateValue), privateValue);
  assert.deepEqual(f.manager.current(preview.token), checked);
  assert.equal(core.canonicalJson([f.context.store.load(), f.context.store.loadAllReferences(), f.context.ragStore.captureDocumentSimilarityEvidence({ documentKeys: ['native-library:one', 'native-library:two'] })]), before);
});

test('equal titles or UUID-looking local ids never manufacture confirmed paper bindings', async t => {
  const f = fixture(t), one = f.local('one'); f.local('two', 'Paper one', false); f.reference('one', 'two');
  const preview = await f.preview(['one', 'two'], { includeSimilarity: false });
  assert.equal(preview.snapshot.sources.length, 1); assert.equal(preview.snapshot.sources[0].paperId, one.entityId);
  assert(preview.skipped.some(row => row.localPaperId === 'two' && row.code === 'GRAPH_EVIDENCE_BINDING_REQUIRED'));
  assert.equal(preview.snapshot.edges.length, 0);
});

test('many-to-one and one-to-many material bindings are excluded instead of choosing an arbitrary owner', async t => {
  const f = fixture(t); f.local('one'); f.local('two');
  f.bindings[1].entityId = f.bindings[0].entityId;
  assert.equal((await f.preview()).snapshot.sources.length, 0);
  f.bindings[1].entityId = randomUUID(); f.setBindings([...f.bindings, { ...f.bindings[0], entityId: randomUUID() }]);
  const preview = await f.preview(); assert.equal(preview.snapshot.sources.length, 1); assert.equal(preview.snapshot.sources[0].paperId, f.bindings[1].entityId);
});

test('reference matching considers duplicate DOI and title matches in the whole library, including unselected papers', async t => {
  const f = fixture(t); f.local('one'); f.local('two'); f.local('duplicate', 'Paper two', false); f.edit('duplicate', { doi: '10.1234/two' }); f.reference('one', 'two');
  const preview = await f.preview(['one', 'two'], { includeSimilarity: false });
  assert.equal(preview.counts.citations, 0); assert(preview.skipped.some(row => row.code === 'GRAPH_EVIDENCE_REFERENCE_AMBIGUOUS'));
});

test('reference matches beyond the explicit selection are reported and cannot add implicit materials', async t => {
  const f = fixture(t); f.local('one'); f.local('two'); f.reference('one', 'two');
  const preview = await f.preview(['one'], { includeSimilarity: false });
  assert.equal(preview.snapshot.sources.length, 1); assert.equal(preview.snapshot.edges.length, 0);
  assert(preview.skipped.some(row => row.code === 'GRAPH_EVIDENCE_TARGET_NOT_SELECTED'));
});

test('reference titles longer than the helper presentation limit keep their complete valid description', async t => {
  const f = fixture(t); f.local('one'); const title = 'Long historical reference ' + 'word '.repeat(90); f.local('two', title); f.reference('one', 'two');
  const preview = await f.preview(['one', 'two'], { includeSimilarity: false });
  assert.equal(preview.snapshot.edges[0].description, title.trim()); assert(preview.snapshot.edges[0].description.length > 260);
});

test('a private path in a source title is explicitly skipped and cannot enter a portable package', async t => {
  const f = fixture(t); f.local('one', 'C:\\private-fixture\\paper.pdf'); f.local('two');
  const preview = await f.preview(['one', 'two'], { includeSimilarity: false });
  assert.equal(preview.snapshot.sources.length, 1); assert(preview.skipped.some(row => row.code === 'GRAPH_EVIDENCE_TITLE_UNSUPPORTED'));
  assert(!JSON.stringify(preview.snapshot).includes('private-fixture'));
});

test('unsupported and oversized reference rows are reported whole while another valid row and epoch zero remain exact', async t => {
  const f = fixture(t); f.local('one'); f.local('two');
  f.context.store.saveReferences('one', [
    { title: 'Paper two\u0001', doi: '10.1234/two', seq: 1, fetchedAt: 1 },
    { title: 'Paper two', doi: '10.1234/two', seq: 2, fetchedAt: 1, unstructured: 'x'.repeat(65536) },
    { title: 'Paper two', doi: '10.1234/two', seq: 3, fetchedAt: 1 },
  ]);
  const db = new DatabaseSync(f.context.appPaths.libraryDatabasePath);
  try { db.prepare('UPDATE paper_references SET fetched_at = 0 WHERE paper_id = ?').run('one'); } finally { db.close(); }
  const preview = await f.preview(['one', 'two'], { includeSimilarity: false });
  assert.equal(preview.counts.citations, 1); assert.equal(preview.snapshot.edges[0].provenance.fetchedAt, 0);
  assert.deepEqual(preview.skipped.map(row => row.code), ['GRAPH_EVIDENCE_DESCRIPTION_UNSUPPORTED', 'GRAPH_EVIDENCE_REFERENCE_ROW_LIMIT']);
  assert.equal(preview.snapshot.edges[0].description, 'Paper two');
});

for (const [name, change] of [
  ['metadata', f => f.edit('one', { title: 'Changed metadata' })],
  ['reference rows', f => f.reference('one', 'two', { unstructured: 'Changed hidden raw citation' })],
  ['version mapping', f => { f.bindings[0].versions[0].sha256 = 'b'.repeat(64); }],
  ['whole-library reference ambiguity', f => f.local('new-unselected', 'Paper two', false)],
  ['vector cache', f => f.index('two', [1, .1, 0, 0])],
]) test(`synchronous final capture rejects a preview after ${name} changes`, async t => {
  const f = fixture(t); f.local('one'); f.local('two'); f.reference('one', 'two'); f.index('one'); f.index('two');
  const preview = await f.preview(); change(f);
  assert.throws(() => f.manager.current(preview.token), { code: 'GRAPH_EVIDENCE_PREVIEW_STALE' });
});

test('a cache body-only change invalidates the frozen preview even when its cosine score stays identical', async t => {
  const f = fixture(t); f.local('one'); f.local('two'); f.index('one'); f.index('two');
  const preview = await f.preview(['one', 'two'], { includeReferences: false });
  const db = new DatabaseSync(f.context.appPaths.ragDatabasePath);
  try { db.prepare('UPDATE rag_chunks SET text = ? WHERE document_key = ?').run('Changed private chunk body', 'native-library:one'); } finally { db.close(); }
  assert.throws(() => f.manager.current(preview.token), { code: 'GRAPH_EVIDENCE_PREVIEW_STALE' });
});

test('account, device, service and library changes reject old previews and invalidation cancels queued work', async t => {
  const f = fixture(t); f.local('one'); f.local('two'); const original = structuredClone(f.snapshot);
  for (const mutate of [row => { row.account.accountId = randomUUID(); }, row => { row.account.deviceId = randomUUID(); },
    row => { row.config.apiBaseUrl = 'https://other.example.test'; }, row => { row.library.libraryBindingId = randomUUID(); }]) {
    f.setSnapshot(structuredClone(original)); const preview = await f.preview(); const next = structuredClone(original); mutate(next); f.setSnapshot(next);
    assert.throws(() => f.manager.current(preview.token), { code: 'GRAPH_EVIDENCE_SCOPE_CHANGED' });
  }
  f.setSnapshot(original); const pending = f.preview(); f.manager.invalidate(); await assert.rejects(pending, { code: 'DESKTOP_OPERATION_CANCELLED' });
  assert.throws(() => f.manager.current(randomUUID()), { code: 'GRAPH_EVIDENCE_PREVIEW_STALE' });
});

test('selection, source version limits and unavailable evidence caches produce explicit outcomes', async t => {
  const f = fixture(t); f.local('one'); f.local('two');
  await assert.rejects(f.preview(['one', 'one']), { code: 'GRAPH_EVIDENCE_SELECTION_INVALID' });
  f.bindings[0].versions = Array.from({ length: 17 }, () => ({ versionId: randomUUID(), sha256: 'a'.repeat(64), sizeBytes: 42 }));
  f.context.ragStore.available = false;
  const preview = await f.preview(); assert.equal(preview.counts.sources, 1);
  assert(preview.skipped.some(row => row.code === 'GRAPH_EVIDENCE_VERSION_LIMIT'));
  assert(preview.skipped.some(row => row.code === 'GRAPH_EVIDENCE_VECTOR_UNAVAILABLE'));
  assert.equal(preview.snapshot.coverage.vectorCache, false);
});
