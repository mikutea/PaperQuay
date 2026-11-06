import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as core from '../packages/sync-core/src/index.ts';
import { snapshotDesktopSavedNote } from '../src/services/portableRichNoteArchive.ts';
import { collectText, noteContentToTiptap } from '../src/features/notes/notesTiptap.ts';

const require = createRequire(import.meta.url);
const { createNoteStore } = require('../electron/backend/noteStore.cjs');
const { DatabaseSync } = require('../electron/backend/nodeSqlite.cjs');
const { desktopNoteCopy, sameDesktopNoteCopy } = require('../electron/backend/desktopNoteCopy.cjs');
const id = value => '00000000-0000-4000-8000-' + value.toString(16).padStart(12, '0');
const at = '2026-11-04T10:00:00.000Z', accountId = id(1), libraryBindingId = id(2);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
const hash = createHash('sha256').update(png).digest('hex');
const asset = { id: hash, sha256: hash, base64: png.toString('base64'), sizeBytes: png.length, mediaType: 'image/png', width: 1, height: 1 };
const dataUri = `data:${asset.mediaType};base64,${asset.base64}`;
const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const record = data => ({ entityType: 'note', entityId: id(80), schemaVersion: 1, revision: 3, data, deletedAt: null, updatedAt: at, modifiedByDeviceId: id(3) });
const bindings = () => ({ papers: new Map([[id(60), 'local-paper-main'], [id(61), 'local-paper-other']]), notes: new Map([[id(70), 'local-peer']]) });

function rich() {
  const pdfLocation = { pageNumber: 2, bbox: [10, 20, 30, 40], bboxCoordinateSystem: 'pdf', bboxPageSize: [600, 800],
    boundingRect: { x: 1.5, y: 2, width: 30, height: 40 }, highlightColor: '#fef08a' };
  return core.createRichNoteData({ paperId: id(60), title: '完整副本', assets: [asset],
    metadata: { type: 'highlight', tags: ['manual'], color: '#fef08a', isFavorite: true, isPinned: true,
      linkedNoteIds: [id(70)], linkedPaperIds: [id(61), id(60)], linkedPaperId: id(60), folderId: null,
      createdAt: 100, updatedAt: 200, excerpt: '来源摘录', pdfLocation, aiChatMessageIds: [], unresolvedReferences: [],
      anchors: [{ id: 'anchor-1', paperId: id(60), label: 'P2', excerpt: '保留历史摘录', sourceTitle: '原文献', source: 'pdf',
        blockId: 'block-1', pageIndex: 1, pdfLocation, createdAt: 0, verification: 'unverified' }] },
    document: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '待编辑标题' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: '原始正文', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'link', attrs: { href: 'https://doi.org/10.1000/example' } }] },
        { type: 'inlineMath', attrs: { latex: 'E=mc^2' } }, { type: 'wikiLink', attrs: { id: id(70), label: '同伴' } },
        { type: 'paperReference', attrs: { paperId: id(60), label: '文献' } }, { type: 'hashTag', attrs: { tag: 'derived' } },
        { type: 'noteAnchorLink', attrs: { anchorId: 'anchor-1', label: 'P2' } },
      ] },
      { type: 'blockMath', attrs: { latex: '\\int_0^1 x^2 dx' } },
      { type: 'table', content: [{ type: 'tableRow', content: [
        { type: 'tableHeader', attrs: { colspan: 2, rowspan: 1, colwidth: [120, 140], align: 'center' }, content: [paragraph('合并列')] },
      ] }] },
      { type: 'image', attrs: { src: `asset:sha256:${hash}`, alt: '原始图片', title: '图题', width: 1, height: 1 } },
      { type: 'noteComponentBlock', attrs: { title: '组件', variant: 'note' }, content: [paragraph('组件原文')] },
      { type: 'noteAnchorBlock', attrs: { anchorId: 'anchor-1', label: 'P2', sourceLabel: '摘录', sourceTitle: '原文献', excerpt: '保留历史摘录' } },
    ] } });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-note-copy-'));
  const appPaths = { notesDatabasePath: path.join(root, 'notes.sqlite') }, store = createNoteStore(appPaths);
  t.after(() => {
    store.close(); const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('paperquay-note-copy-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const local = (localId, title = localId) => store.createNote({ id: localId, paperId: 'global-notes', title, contentJson: { type: 'doc', content: [paragraph('本机原记录')] } });
  return { store, local, appPaths };
}

function publish(saved, material = bindings()) {
  const identityMap = core.createDesktopIdentityMap(accountId, libraryBindingId);
  identityMap.aliases[JSON.stringify(['note', saved.id])] = id(80);
  const papers = [];
  for (const [entityId, localId] of material.papers) {
    identityMap.aliases[JSON.stringify(['paper', localId])] = entityId;
    papers.push({ id: localId, title: localId, authors: [], keywords: [], year: null, doi: null, publication: null, abstractText: null });
  }
  const confirmedNotes = [];
  for (const [entityId, localNoteId] of material.notes) {
    identityMap.aliases[JSON.stringify(['note', localNoteId])] = entityId;
    confirmedNotes.push({ localNoteId, entityId });
  }
  const projected = core.projectDesktopLibrary({ accountId, libraryBindingId, identityMap, papers, notes: [snapshotDesktopSavedNote(saved)], confirmedNotes,
    richNoteResources: [{ proof: 'verified-note-image-bytes', accountId, libraryBindingId, localNoteId: saved.id, source: dataUri, asset }] }, () => { throw Error('Unexpected identity allocation'); });
  assert.deepEqual(projected.skipped, []);
  return projected.entities.find(row => row.entityType === 'note').data;
}

test('real SQLite copy, ordinary text edit and publication preserve rich structure, asset bytes and unverified anchor coordinates', t => {
  const f = fixture(t), peer = f.local('local-peer', '同伴'), source = rich(), original = structuredClone(source);
  const request = desktopNoteCopy(core, record(source), 'account-note-copy', bindings());
  const saved = f.store.createNote(request);
  assert.equal(sameDesktopNoteCopy(core, saved, request), true);
  assert.equal(saved.contentJson.content[4].attrs.src, dataUri);
  assert.deepEqual(saved.anchors[0], request.anchors[0]);
  assert.equal(saved.anchors[0].verification, 'unverified'); assert.equal(saved.anchors[0].createdAt, 0);
  const doc = noteContentToTiptap(saved); doc.content[0].content[0].text = '普通编辑后的标题';
  const text = collectText(doc), edited = f.store.updateNote({ id: saved.id, patch: { contentJson: doc, content: text, contentText: text, anchors: saved.anchors,
    linkedNoteTitles: ['同伴'], linkedPaperIds: ['local-paper-main'] } });
  const outgoing = publish(edited), expected = structuredClone(source.document); expected.content[0].content[0].text = '普通编辑后的标题';
  assert.deepEqual(outgoing.document, expected); assert.deepEqual(outgoing.assets, source.assets);
  assert.deepEqual(outgoing.metadata.anchors, source.metadata.anchors); assert.deepEqual(outgoing.metadata.pdfLocation, source.metadata.pdfLocation);
  assert.deepEqual(outgoing.metadata.linkedNoteIds, [id(70)]); assert.equal(outgoing.metadata.linkedPaperId, id(60));
  assert.deepEqual(new Set(outgoing.metadata.linkedPaperIds), new Set(source.metadata.linkedPaperIds));
  assert.equal(outgoing.metadata.isFavorite, true); assert.equal(outgoing.metadata.isPinned, true); assert.ok(outgoing.metadata.tags.includes('manual'));
  assert.match(outgoing.body, /E=mc\^2/); assert.match(outgoing.body, /合并列/); assert.match(outgoing.body, /组件原文/);
  assert.deepEqual({ ...f.store.getNote({ id: peer.id }), backlinks: [] }, peer); assert.deepEqual(source, original);
  assert.equal(sameDesktopNoteCopy(core, edited, request), false);
});

test('unknown references remain unresolved through SQLite editing even beside colliding local UUIDs and titles', t => {
  const f = fixture(t), source = rich(), missingNote = id(71), missingPaper = id(62);
  source.document.content[1].content[2].attrs = { id: missingNote, label: '相同标题' };
  source.document.content[1].content[3].attrs = { paperId: missingPaper, label: '相同文献' };
  source.metadata.linkedNoteIds = [missingNote]; source.metadata.linkedPaperIds.push(missingPaper);
  const data = core.createRichNoteData({ paperId: source.paperId, title: source.title, document: source.document, metadata: source.metadata, assets: source.assets });
  const coincidental = f.local(missingNote, '相同标题');
  const request = desktopNoteCopy(core, record(data), 'account-note-unresolved', bindings()), saved = f.store.createNote(request);
  assert.equal(sameDesktopNoteCopy(core, saved, request), true);
  const doc = noteContentToTiptap(saved); doc.content[0].content[0].text = '保留未知引用';
  const edited = f.store.updateNote({ id: saved.id, patch: { contentJson: doc, content: collectText(doc), contentText: collectText(doc), linkedNoteTitles: ['相同标题'] } });
  assert.deepEqual(f.store.listBacklinks({ noteId: coincidental.id }), []);
  const material = bindings(); material.notes.set(id(72), missingNote); material.papers.set(id(63), missingPaper);
  const outgoing = publish(edited, material);
  assert.equal(outgoing.document.content[1].content[2].attrs.id, core.richNoteUnresolvedId('note', missingNote));
  assert.equal(outgoing.document.content[1].content[3].attrs.paperId, core.richNoteUnresolvedId('paper', missingPaper));
  assert.ok(outgoing.metadata.unresolvedReferences.some(row => row.kind === 'note' && row.id === core.richNoteUnresolvedId('note', missingNote) && row.label === '相同标题'));
  const db = new DatabaseSync(f.appPaths.notesDatabasePath);
  try { assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.prepare('SELECT count(*) AS n FROM note_links WHERE source_note_id = ?').get(saved.id).n, 0); }
  finally { db.close(); }
});

test('existing unresolved folder, chat and reference descriptions retain their original tokens and historical reason', t => {
  const f = fixture(t); f.local('local-peer', '同伴');
  const source = rich(), noteToken = core.richNoteUnresolvedId('note', id(71)), folderToken = core.richNoteUnresolvedId('folder', 'old-folder'), chatToken = core.richNoteUnresolvedId('ai-chat', 'old-chat');
  source.document.content[1].content[2].attrs.id = noteToken; source.metadata.linkedNoteIds = [noteToken];
  source.metadata.folderId = folderToken; source.metadata.aiChatId = chatToken; source.metadata.aiChatMessageIds = ['original-message'];
  source.metadata.unresolvedReferences = [
    { kind: 'note', id: noteToken, label: '历史同伴', reason: 'historical-unverified' },
    { kind: 'folder', id: folderToken, label: '原文件夹', reason: 'missing' },
    { kind: 'ai-chat', id: chatToken, label: '原会话', reason: 'unmapped' },
  ];
  const data = core.createRichNoteData({ paperId: source.paperId, title: source.title, document: source.document, metadata: source.metadata, assets: source.assets });
  const request = desktopNoteCopy(core, record(data), 'account-note-history', bindings()), saved = f.store.createNote(request);
  assert.equal(sameDesktopNoteCopy(core, saved, request), true);
  const edited = f.store.updateNote({ id: saved.id, patch: { title: '普通重命名' } }), outgoing = publish(edited);
  assert.equal(outgoing.metadata.folderId, folderToken); assert.equal(outgoing.metadata.aiChatId, chatToken);
  assert.deepEqual(outgoing.metadata.aiChatMessageIds, ['original-message']);
  for (const value of source.metadata.unresolvedReferences) assert.deepEqual(outgoing.metadata.unresolvedReferences.find(row => row.kind === value.kind && row.id === value.id), value);
  assert.equal(outgoing.document.content[1].content[2].attrs.id, noteToken);
});

test('fixed-copy comparison tolerates only derived caches and rejects changed core content without writing it', t => {
  const f = fixture(t); f.local('local-peer', '同伴');
  const request = desktopNoteCopy(core, record(rich()), 'account-note-comparison', bindings()), saved = f.store.createNote(request);
  assert.equal(sameDesktopNoteCopy(core, { ...saved, contentText: 'derived differently', createdAt: 999, tags: [...saved.tags, 'extracted'] }, request), true);
  for (const patch of [{ title: 'User title' }, { content: 'User content' }, { isPinned: false }, { tags: [] }, { deletedAt: Date.parse(at) }]) {
    assert.equal(sameDesktopNoteCopy(core, { ...saved, ...patch }, request), false);
  }
  const edited = structuredClone(saved); edited.contentJson.content[2].attrs.latex = 'x^3';
  assert.equal(sameDesktopNoteCopy(core, edited, request), false);
  assert.deepEqual(f.store.getNote({ id: saved.id }), saved);
});

test('a valid epoch creation timestamp survives account copying and a later ordinary edit', t => {
  const f = fixture(t); f.local('local-peer', '同伴'); const data = rich(); data.metadata.createdAt = 0;
  const request = desktopNoteCopy(core, record(data), 'account-note-epoch', bindings()), saved = f.store.createNote(request);
  assert.equal(saved.createdAt, 0); const edited = f.store.updateNote({ id: saved.id, patch: { title: 'Later edit' } });
  assert.equal(edited.createdAt, 0); assert.equal(publish(edited).metadata.createdAt, 0);
});

test('metadata-only references to another not-yet-saved local copy survive without an invalid foreign key', t => {
  const f = fixture(t); f.local('local-peer', '同伴');
  const source = rich(), material = bindings(); source.metadata.linkedNoteIds.push(id(75)); material.notes.set(id(75), 'copy-created-later');
  const data = core.createRichNoteData({ paperId: source.paperId, title: source.title, document: source.document, metadata: source.metadata, assets: source.assets });
  const request = desktopNoteCopy(core, record(data), 'first-copy', material), saved = f.store.createNote(request);
  assert.equal(sameDesktopNoteCopy(core, saved, request), true);
  assert.deepEqual(saved.linkedNoteIds, ['local-peer', 'copy-created-later']);
  f.local('copy-created-later', '新副本');
  const edited = f.store.updateNote({ id: saved.id, patch: { title: '普通编辑' } });
  assert.deepEqual(publish(edited, material).metadata.linkedNoteIds, [id(70), id(75)]);
  assert.equal(f.store.listBacklinks({ noteId: 'copy-created-later' }).length, 1);
});

test('structured link identity wins over both its displayed title and derived text', t => {
  const f = fixture(t), peer = f.local('local-peer', '明确目标'), coincidence = f.local('wrong-target', '相同标签');
  const saved = f.store.createNote({ id: 'explicit-links', paperId: 'global-notes', title: '显式引用', contentText: '[[相同标签]] @wrong-paper',
    contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'wikiLink', attrs: { id: peer.id, label: '相同标签' } }, { type: 'paperReference', attrs: { paperId: 'correct-paper', label: '相同文献' } },
    ] }] }, linkedNoteTitles: ['相同标签'] });
  assert.deepEqual(saved.linkedNoteIds, [peer.id]); assert.deepEqual(saved.linkedPaperIds, ['correct-paper']);
  assert.equal(f.store.listBacklinks({ noteId: peer.id }).length, 1); assert.deepEqual(f.store.listBacklinks({ noteId: coincidence.id }), []);
  const edited = f.store.updateNote({ id: saved.id, patch: { title: '改标题', linkedNoteTitles: ['相同标签'] } });
  assert.deepEqual(edited.linkedNoteIds, [peer.id]); assert.deepEqual(f.store.listBacklinks({ noteId: coincidence.id }), []);
});

test('old databases gain only a nullable metadata column and preserve existing note rows and legacy text links', t => {
  const f = fixture(t), peer = f.local('legacy-peer', '旧目标');
  f.store.createNote({ id: 'legacy-source', paperId: 'global-notes', title: '旧笔记', content: '[[旧目标]]' });
  f.store.close();
  const db = new DatabaseSync(f.appPaths.notesDatabasePath);
  db.exec('ALTER TABLE notes DROP COLUMN reference_metadata');
  const before = db.prepare('SELECT * FROM notes ORDER BY id').all(); db.close();
  const reopened = createNoteStore(f.appPaths); t.after(() => reopened.close());
  assert.deepEqual(reopened.getNote({ id: 'legacy-source' }).linkedNoteIds, [peer.id]);
  assert.deepEqual(reopened.getNote({ id: 'legacy-source' }).unresolvedReferences, []);
  const check = new DatabaseSync(f.appPaths.notesDatabasePath);
  try {
    const after = check.prepare('SELECT * FROM notes ORDER BY id').all();
    assert.deepEqual(after.map(({ reference_metadata, ...row }) => { assert.equal(reference_metadata, null); return row; }), before.map(row => ({ ...row })));
  } finally { check.close(); reopened.close(); }
});

test('bounded unresolved metadata rejects malformed writes without changing an existing note', t => {
  const f = fixture(t), original = f.local('bounded-metadata');
  const entry = { kind: 'note', id: core.richNoteUnresolvedId('note', id(75)), label: '未解析', reason: 'missing' };
  for (const unresolvedReferences of [[{ ...entry, extra: 'not-a-reference' }], [{ ...entry, id: 'unresolved:paper:wrong-kind' }],
    [entry, entry], Array.from({ length: 1001 }, (_, index) => ({ ...entry, id: 'unresolved:note:source-' + index }))]) {
    assert.throws(() => f.store.updateNote({ id: original.id, patch: { unresolvedReferences } }), /INVALID_NOTE_REFERENCE_METADATA/);
    assert.deepEqual(f.store.getNote({ id: original.id }), original);
  }
});

test('ordinary document edits update AST links while retaining separate metadata associations', t => {
  const f = fixture(t); f.local('body-peer'); f.local('metadata-peer');
  const original = f.store.createNote({ id: 'body-and-metadata', paperId: 'global-notes', title: '正文与关联',
    contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'wikiLink', attrs: { id: 'body-peer', label: '正文笔记' } }, { type: 'paperReference', attrs: { paperId: 'body-paper', label: '正文文献' } },
    ] }] }, linkedNoteIds: ['body-peer', 'metadata-peer'], linkedPaperIds: ['body-paper', 'metadata-paper'] });
  const edited = f.store.updateNote({ id: original.id, patch: { contentJson: { type: 'doc', content: [paragraph('删除正文引用')] }, contentText: '删除正文引用', linkedPaperIds: [] } });
  assert.deepEqual(edited.linkedNoteIds, ['metadata-peer']); assert.deepEqual(edited.linkedPaperIds, ['metadata-paper']);
  assert.deepEqual(f.store.listBacklinks({ noteId: 'body-peer' }), []); assert.equal(f.store.listBacklinks({ noteId: 'metadata-peer' }).length, 1);
  const explicitlyUnlinked = f.store.updateNote({ id: edited.id, patch: { linkedNoteIds: [], linkedPaperIds: [] } });
  assert.deepEqual(explicitlyUnlinked.linkedNoteIds, []); assert.deepEqual(explicitlyUnlinked.linkedPaperIds, []);
});
