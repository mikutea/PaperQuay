import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { projectDesktopLibrary, createDesktopIdentityMap, type DesktopProjectionInput, type VerifiedDesktopRichNoteResource } from '../packages/sync-core/src/desktopProjection.ts';
import { validateRichNoteData, richNoteUnresolvedId, type RichNoteData, type RichNoteNode } from '../packages/sync-core/src/richNote.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const account = id(1), library = id(2), source = 'blob:synthetic-note-image';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
const sha = createHash('sha256').update(png).digest('hex');
function evidence(): VerifiedDesktopRichNoteResource {
  return { proof: 'verified-note-image-bytes', accountId: account, libraryBindingId: library, localNoteId: 'note-a', source,
    asset: { id: sha, sha256: sha, base64: png.toString('base64'), mediaType: 'image/png', sizeBytes: png.length, width: 1, height: 1 } };
}
function note() {
  return { id: 'note-a', paperId: 'paper-local', type: 'highlight', title: '桌面结构笔记', content: 'SENTINEL_LOSSY_FALLBACK', contentHtml: '<img src="file:///C:/private">',
    contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '中文原文', marks: [{ type: 'bold' }] },
      { type: 'wikiLink', attrs: { id: 'note-b', label: 'B' } }, { type: 'wikiLink', attrs: { id: 'unsupported', label: '不支持目标' } },
      { type: 'wikiLink', attrs: { id: null, label: '只有标签' } }, { type: 'paperReference', attrs: { paperId: 'missing-paper', label: '未导入论文' } }] },
      { type: 'blockMath', attrs: { latex: 'E=mc^2' } },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2, rowspan: 1, colwidth: [100, 120], align: 'center' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '跨列', marks: [{ type: 'italic' }] }] }] }] }] },
      { type: 'image', attrs: { src: source, alt: '图', title: null, width: 1, height: 1 } },
      { type: 'noteAnchorBlock', attrs: { anchorId: 'anchor-1', label: 'P2', sourceLabel: '摘录', sourceTitle: '旧论文', excerpt: '旧坐标' } }] } as RichNoteNode,
    anchors: [{ id: 'anchor-1', paperId: 'missing-paper', label: 'P2', excerpt: '旧坐标', source: 'pdf', pageIndex: 1,
      pdfLocation: { pageNumber: 2, bbox: [1, 2, 30, 40], bboxCoordinateSystem: 'pdf', bboxPageSize: [600, 800] }, createdAt: 100 }],
    tags: ['中文'], color: '#fef08a', isFavorite: true, isPinned: false, linkedNoteIds: ['note-b', 'unsupported'], linkedPaperIds: ['paper-local', 'missing-paper'],
    linkedPaperId: 'missing-paper', folderId: 'folder-local', aiChatId: 'chat-local', aiChatMessageIds: ['message-1'], createdAt: 100, updatedAt: 200 };
}
function input(): DesktopProjectionInput {
  return { accountId: account, libraryBindingId: library, identityMap: createDesktopIdentityMap(account, library),
    papers: [{ id: 'paper-local', title: 'Paper', doi: null, year: null, publication: null, abstractText: null, authors: [], keywords: [] }],
    notes: [note(), { id: 'note-b', paperId: null, format: 'markdown', title: 'B', body: 'B body' },
      { ...note(), id: 'unsupported', contentJson: { type: 'doc', content: [{ type: 'video' }] } }], richNoteResources: [evidence()] };
}
function allocate() { let n = 100; return () => id(n++); }

test('desktop rich projection preserves schema/metadata/images and remaps only successfully projected targets', () => {
  const original = input(), before = JSON.stringify(original), result = projectDesktopLibrary(original, allocate());
  const projected = result.entities.find((entry) => entry.entityType === 'note' && entry.data.title === '桌面结构笔记')!;
  assert.equal(projected.entityType, 'note'); const data = projected.data as RichNoteData;
  assert.deepEqual(validateRichNoteData(data), data); assert.equal(data.format, 'tiptap-json');
  const peer = result.entities.find((entry) => entry.entityType === 'note' && entry.data.title === 'B')!;
  assert.equal(data.document.content![0].content![1].attrs!.id, peer.entityId);
  assert.equal(data.document.content![0].content![2].attrs!.id, richNoteUnresolvedId('note', 'unsupported'));
  assert.equal(data.assets[0].sha256, sha); assert.equal(data.document.content![3].attrs!.src, `asset:sha256:${sha}`);
  assert.deepEqual(data.document.content![2], note().contentJson.content![2]);
  assert.deepEqual(data.metadata.tags, ['中文']); assert.equal(data.metadata.anchors[0].verification, 'unverified');
  assert.equal(data.metadata.anchors[0].paperId, richNoteUnresolvedId('paper', 'missing-paper'));
  assert.equal(data.metadata.linkedPaperId, richNoteUnresolvedId('paper', 'missing-paper'));
  assert.equal(data.metadata.folderId, richNoteUnresolvedId('folder', 'folder-local'));
  assert.ok(data.metadata.unresolvedReferences.some((entry) => entry.kind === 'note' && entry.label === '只有标签' && entry.reason === 'missing'));
  assert.ok(result.skipped.some((entry) => entry.code === 'UNSUPPORTED_RICH_NOTE'));
  assert.doesNotMatch(JSON.stringify(result.entities), /SENTINEL_LOSSY_FALLBACK|file:\/\/\/C:|blob:synthetic/);
  assert.equal(JSON.stringify(original), before);
});

test('missing, mismatched or corrupt image bindings reject the whole rich note, never fallback text', () => {
  const initial = input();
  for (const resources of [[], [{ ...evidence(), asset: { ...evidence().asset, width: 2 } }],
    [{ ...evidence(), asset: { ...evidence().asset, sha256: '0'.repeat(64), id: '0'.repeat(64) } }]]) {
    const result = projectDesktopLibrary({ ...initial, richNoteResources: resources }, allocate());
    assert.equal(result.entities.filter((entry) => entry.entityType === 'note').length, 1);
    assert.doesNotMatch(JSON.stringify(result.entities), /SENTINEL_LOSSY_FALLBACK/);
  }
  assert.throws(() => projectDesktopLibrary({ ...initial, richNoteResources: [{ ...evidence(), accountId: id(9) }] }, allocate()), /INVALID_RICH_NOTE_RESOURCE_EVIDENCE/);
  assert.throws(() => projectDesktopLibrary({ ...initial, richNoteResources: [evidence(), evidence()] }, allocate()), /DUPLICATE_RICH_NOTE_RESOURCE_EVIDENCE/);
});

test('data URI bytes must exactly match the explicit resource evidence', () => {
  const initial = input(), raw = note(), source = `data:image/png;base64,${evidence().asset.base64}`;
  raw.contentJson.content![3].attrs!.src = source;
  const proof = { ...evidence(), source };
  assert.equal(projectDesktopLibrary({ ...initial, notes: [raw], richNoteResources: [proof] }, allocate()).entities.filter((entry) => entry.entityType === 'note').length, 1);
  const wrong = { ...proof, asset: { ...proof.asset, base64: Buffer.from('wrong bytes').toString('base64') } };
  const result = projectDesktopLibrary({ ...initial, notes: [raw], richNoteResources: [wrong] }, allocate());
  assert.equal(result.entities.filter((entry) => entry.entityType === 'note').length, 0);
  assert.ok(result.skipped.some((entry) => entry.code === 'RICH_RESOURCE_EVIDENCE_MISMATCH'));
});

test('a resource claim cannot promote old filesystem paths or external URLs into verified historical images', () => {
  for (const src of ['file:///C:/private/old.png', 'C:/private/old.png', 'https://outside.test/image.png']) {
    const raw = note(); raw.contentJson.content![3].attrs!.src = src;
    const result = projectDesktopLibrary({ ...input(), notes: [raw], richNoteResources: [{ ...evidence(), source: src }] }, allocate());
    assert.equal(result.entities.filter((entry) => entry.entityType === 'note').length, 0);
    assert.ok(result.skipped.some((entry) => entry.code === 'UNSUPPORTED_RICH_NOTE'));
    assert.equal(JSON.stringify(result).includes(src), false);
  }
});

test('legacy getters cannot execute during document/resource/folder conversion', () => {
  let invoked = false; const raw = note();
  Object.defineProperty(raw.contentJson.content![0].content![0], 'text', { enumerable: true, get() { invoked = true; return 'private'; } });
  projectDesktopLibrary({ ...input(), notes: [raw] }, allocate()); assert.equal(invoked, false);
  const other = note() as unknown as Record<string, unknown>;
  other.folderId = { toString() { invoked = true; return 'private'; } };
  projectDesktopLibrary({ ...input(), notes: [other] }, allocate()); assert.equal(invoked, false);
});

test('an unknown source UUID equal to a new target UUID is never treated as that paper', () => {
  const raw = note();
  raw.contentJson.content![0].content![4].attrs!.paperId = id(100);
  raw.linkedPaperIds = [id(100)]; raw.anchors[0].paperId = id(100); raw.linkedPaperId = id(100);
  const result = projectDesktopLibrary({ ...input(), notes: [raw] }, allocate());
  const data = result.entities.find((entry) => entry.entityType === 'note')!.data as RichNoteData;
  assert.equal(result.entities.find((entry) => entry.entityType === 'paper')!.entityId, id(100));
  assert.equal(data.document.content![0].content![4].attrs!.paperId, richNoteUnresolvedId('paper', id(100)));
  assert.equal(data.metadata.linkedPaperId, richNoteUnresolvedId('paper', id(100)));
  assert.equal(data.metadata.anchors[0].paperId, richNoteUnresolvedId('paper', id(100)));
});
