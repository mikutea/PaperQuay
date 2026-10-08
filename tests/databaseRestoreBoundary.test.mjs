import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createNoteStore } = require('../electron/backend/noteStore.cjs');
const { createRagStore } = require('../electron/backend/ragStore.cjs');
const { DatabaseSync } = require('../electron/backend/nodeSqlite.cjs');

function fixture(t, kind) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pq-db-restore-')));
  const create = kind === 'notes' ? createNoteStore : createRagStore;
  const key = kind === 'notes' ? 'notesDatabasePath' : 'ragDatabasePath';
  const sourcePath = path.join(root, 'source', 'database.sqlite');
  const targetPath = path.join(root, 'shared', 'database.sqlite');
  const source = create({ [key]: sourcePath }), target = create({ [key]: targetPath });
  t.after(() => { source.close(); target.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const seed = (store, id) => kind === 'notes' ? store.createNote({ id, paperId: 'paper', type: 'standalone', title: id, content: id, tags: ['restored'] }) : store.indexDocument({
    documentKey: id, sourceType: 'pdf-text', sourceSignature: id, embeddingModelKey: 'test', totalChunkCount: 1,
    chunks: [{ chunkId: id, chunkIndex: 0, text: id, embedding: [0.2, 0.8] }],
  });
  const has = (store, id) => kind === 'notes' ? Boolean(store.getNote({ id })) : Boolean(store.getDocumentIndexStatus({ documentKey: id, sourceType: 'pdf-text' }));
  seed(source, 'incoming'); seed(target, 'previous');
  const snapshot = path.join(root, 'snapshot.sqlite'); source.snapshotTo(snapshot);
  return { root, source, target, targetPath, snapshot, has };
}

for (const kind of ['notes', 'rag']) {
  test(`${kind} restore never stages through supplier-writable names or overwrites linked victims`, async (t) => {
    const f = fixture(t, kind), victim = path.join(f.root, 'victim.txt');
    fs.writeFileSync(victim, 'outside bytes');
    const original = fsp.copyFile;
    let unsafeCopies = 0;
    fsp.copyFile = async (source, destination, ...args) => {
      if (destination.startsWith(f.targetPath + '.restore-')) {
        unsafeCopies++; fs.linkSync(victim, destination);
      }
      return original(source, destination, ...args);
    };
    t.after(() => { fsp.copyFile = original; });
    await f.target.replaceWithSnapshot(f.snapshot);
    assert.ok(fs.readFileSync(victim).equals(Buffer.from('outside bytes')), 'outside victim must remain unchanged');
    assert.equal(unsafeCopies, 0);
    assert.equal(f.has(f.target, 'incoming'), true);
    assert.equal(f.has(f.target, 'previous'), false);
  });

  test(`${kind} corrupt restore preserves the usable previous database`, async (t) => {
    const f = fixture(t, kind);
    fs.writeFileSync(f.snapshot, 'not a SQLite database');
    await assert.rejects(f.target.replaceWithSnapshot(f.snapshot));
    assert.equal(f.has(f.target, 'previous'), true);
  });

  test(`${kind} unsupported columns roll back data replacement and keep the live inode`, async (t) => {
    const f = fixture(t, kind), identity = fs.statSync(f.targetPath).ino;
    const edit = new DatabaseSync(f.snapshot);
    edit.exec(`ALTER TABLE ${kind === 'notes' ? 'notes' : 'rag_chunks'} ADD COLUMN future_field TEXT`); edit.close();
    await assert.rejects(f.target.replaceWithSnapshot(f.snapshot), /Unsupported snapshot columns/);
    assert.equal(f.has(f.target, 'previous'), true);
    assert.equal(f.has(f.target, 'incoming'), false);
    assert.equal(fs.statSync(f.targetPath).ino, identity);
  });

  test(`${kind} empty, blank, missing-table and truncated snapshots never initialize over live data`, async t => {
    const f = fixture(t, kind), original = fs.readFileSync(f.snapshot), identity = fs.statSync(f.targetPath).ino;
    for (const invalid of ['zero', 'blank', 'missing-table', 'truncated']) {
      fs.writeFileSync(f.snapshot, invalid === 'zero' || invalid === 'blank' ? Buffer.alloc(0) : invalid === 'truncated' ? original.subarray(0, 24) : original);
      if (invalid === 'blank' || invalid === 'missing-table') {
        const edit = new DatabaseSync(f.snapshot);
        edit.exec(invalid === 'blank' ? 'CREATE TABLE unrelated (id INTEGER)' : `DROP TABLE ${kind === 'notes' ? 'note_paper_links' : 'rag_indexes'}`);
        edit.close();
      }
      await assert.rejects(f.target.replaceWithSnapshot(f.snapshot), undefined, invalid);
      assert.equal(f.has(f.target, 'previous'), true, invalid);
      assert.equal(fs.statSync(f.targetPath).ino, identity, invalid);
    }
  });

  test(`${kind} a valid empty-store snapshot still restores normally`, async t => {
    const f = fixture(t, kind), create = kind === 'notes' ? createNoteStore : createRagStore;
    const empty = create({ [kind === 'notes' ? 'notesDatabasePath' : 'ragDatabasePath']: path.join(f.root, 'empty.sqlite') });
    try { empty.snapshotTo(f.snapshot); } finally { empty.close(); }
    await f.target.replaceWithSnapshot(f.snapshot);
    assert.equal(f.has(f.target, 'previous'), false);
    assert.equal(f.has(f.target, 'incoming'), false);
  });
}

test('supported older notes columns are migrated only in the private source copy', async t => {
  const f = fixture(t, 'notes');
  const edit = new DatabaseSync(f.snapshot);
  edit.exec('ALTER TABLE notes DROP COLUMN is_pinned; ALTER TABLE notes DROP COLUMN content_html'); edit.close();
  const original = fs.readFileSync(f.snapshot);
  await f.target.replaceWithSnapshot(f.snapshot);
  assert.equal(f.has(f.target, 'incoming'), true);
  assert.equal(f.target.getNote({ id: 'incoming' }).isPinned, false);
  assert.ok(fs.readFileSync(f.snapshot).equals(original));
});

test('notes restore preserves relations, deleted notes and rich fields without replacing live files', async t => {
  const f = fixture(t, 'notes');
  const linked = f.source.createNote({ id: 'linked', paperId: 'paper', title: 'linked', content: 'link target' });
  f.source.updateNote({ id: 'incoming', patch: { contentText: 'searchable restored text', linkedNoteIds: [linked.id], linkedPaperIds: ['other-paper'], isFavorite: true } });
  f.source.createNote({ id: 'deleted', paperId: 'paper', title: 'deleted', content: 'deleted content' }); f.source.deleteNote({ id: 'deleted' });
  const expected = f.source.listNotes({ includeDeleted: true });
  f.source.snapshotTo(f.snapshot);
  const identity = fs.statSync(f.targetPath).ino;
  await f.target.replaceWithSnapshot(f.snapshot);
  assert.deepEqual(f.target.listNotes({ includeDeleted: true }), expected);
  assert.equal(f.target.listNotes({ search: 'searchable restored' }).length, 1);
  assert.deepEqual(f.target.listTags(), f.source.listTags());
  assert.equal(fs.statSync(f.targetPath).ino, identity);
  const check = new DatabaseSync(f.targetPath);
  assert.equal(check.prepare("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH 'searchable'").get().n, 1);
  assert.equal(check.prepare("SELECT count(*) AS n FROM notes_fts WHERE note_id='deleted'").get().n, 0); check.close();
});

test('RAG restore preserves multidimensional vectors and continues indexing with stable ids', async t => {
  const f = fixture(t, 'rag');
  f.source.indexDocument({ documentKey: 'three', sourceType: 'pdf-text', sourceSignature: 'three', embeddingModelKey: 'test', totalChunkCount: 2,
    chunks: [{ chunkId: 'three-1', chunkIndex: 0, text: 'three vector', embedding: [0.1, 0.2, 0.9] }] });
  f.source.snapshotTo(f.snapshot);
  const identity = fs.statSync(f.targetPath).ino;
  await f.target.replaceWithSnapshot(f.snapshot);
  for (const [documentKey, queryEmbedding] of [['incoming', [0.2, 0.8]], ['three', [0.1, 0.2, 0.9]]]) {
    const request = { documentKey, sourceType: 'pdf-text', queryEmbedding, topK: 2 };
    assert.deepEqual(f.target.retrieveDocumentChunks(request), f.source.retrieveDocumentChunks(request));
    assert.deepEqual(f.target.getDocumentIndexStatus(request), f.source.getDocumentIndexStatus(request));
  }
  f.target.indexDocument({ documentKey: 'three', sourceType: 'pdf-text', sourceSignature: 'three', embeddingModelKey: 'test', totalChunkCount: 2,
    chunks: [{ chunkId: 'three-2', chunkIndex: 1, text: 'next vector', embedding: [0.9, 0.2, 0.1] }] });
  assert.equal(f.target.getDocumentIndexStatus({ documentKey: 'three', sourceType: 'pdf-text' }).status, 'ready');
  assert.equal(fs.statSync(f.targetPath).ino, identity);
});
