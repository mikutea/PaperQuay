import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { EntityData, PaperData, VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import { createRichNoteData, validateRichNoteData, richNoteUnresolvedId, type RichNoteData, type RichNoteAsset } from '../../../packages/sync-core/src/richNote.ts';
import { exportLibraryArchive, parseLibraryArchive, planLibraryImport, materializeLibraryImport, LibraryTransferError,
  type LibraryArchive, type LibraryRichNote } from '../src/library/libraryTransfer.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
const hash = createHash('sha256').update(png).digest('hex');
const asset = (): RichNoteAsset => ({ id: hash, sha256: hash, mediaType: 'image/png', base64: png.toString('base64'), sizeBytes: png.length, width: 1, height: 1 });
const paper = (title = 'P1', doi = '10.1000/p1'): PaperData => ({ title, doi, year: '2026', publication: null, abstractText: null, authors: [], keywords: [] });
const visible = (entityType: VisibleEntity['entityType'], entityId: string, data: EntityData): VisibleEntity => ({ entityType, entityId, data, revision: 1, deleted: false, pending: false, status: 'synced' });
function rich(mark = 'bold', references = true): RichNoteData {
  return createRichNoteData({ paperId: references ? id(1) : null, title: 'Rich note', document: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '相同正文', marks: [{ type: mark }] }, ...(references ? [
      { type: 'wikiLink', attrs: { id: id(4), label: 'B' } }, { type: 'wikiLink', attrs: { id: id(98), label: '未知笔记' } },
      { type: 'paperReference', attrs: { paperId: id(2), label: '未选文献' } }, { type: 'paperReference', attrs: { paperId: id(99), label: '未知文献' } },
    ] : [])] }, { type: 'blockMath', attrs: { latex: 'x_i^2' } },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2, rowspan: 1, colwidth: [120, 140], align: 'center' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '合并表格' }] }] }] }] },
    { type: 'image', attrs: { src: `asset:sha256:${hash}`, alt: '图', title: null, width: null, height: null } },
  ] }, assets: [asset()], metadata: { type: 'standalone', tags: ['原标签'], color: '#fef08a', isFavorite: true, isPinned: false, createdAt: 100, updatedAt: 200,
    linkedNoteIds: references ? [id(4), id(98)] : [], linkedPaperIds: references ? [id(2), id(99)] : [], unresolvedReferences: [],
    anchors: references ? [{ id: 'a1', paperId: id(99), label: 'P2', excerpt: '历史定位', createdAt: 100, verification: 'unverified',
      pdfLocation: { pageNumber: 2, bbox: [1, 2, 3, 4], bboxCoordinateSystem: 'pdf', bboxPageSize: [600, 800] } }] : [] } });
}
const source = () => [visible('paper', id(1), paper()), visible('paper', id(2), paper('P2', '10.1000/p2')),
  visible('note', id(3), rich()), visible('note', id(4), { paperId: null, title: 'B', body: 'B body', format: 'markdown' })];
const allocator = (start = 1000) => { let next = start; return () => id(next++); };
function fails(run: () => unknown, code = 'INVALID_ARCHIVE') {
  assert.throws(run, (error: unknown) => error instanceof LibraryTransferError && error.code === code);
}

test('v2 exports the full rich truth and image hashes, while Markdown-only archives remain v1', () => {
  const original = source(), before = JSON.stringify(original), result = exportLibraryArchive(original);
  assert.equal(result.archive.version, 2); assert.equal(result.summary.scope, 'visible-saved-library-and-rich-notes');
  assert.equal(result.archive.papers[0].sourceId, id(1));
  const note = result.archive.notes[0] as LibraryRichNote;
  assert.equal(note.sourceId, id(3)); assert.deepEqual(note.document, rich().document); assert.deepEqual(note.metadata, rich().metadata);
  assert.equal(note.assets[0].sha256, hash); assert.ok(result.json.includes(id(3)), 'sourceId is explicit source-only identity, not a target account binding');
  assert.deepEqual(parseLibraryArchive(result.json), result.archive); assert.equal(JSON.stringify(original), before);
  const plain = exportLibraryArchive([source()[3]]); assert.equal(plain.archive.version, 1); assert.equal(plain.json.includes(id(4)), false);
});

test('desktop v2 export diagnostics are strict and never grant target-account identity authority', () => {
  const values = source(), report = { source: 'desktop-saved-notes' as const, sourceIds: 'export-only-aliases' as const,
    scope: 'selected-saved-notes' as const, requestedNotes: 3,
    skipped: [{ entityType: 'note' as const, index: 2, code: 'EXPIRED_BLOB_IMAGE' }],
    aliases: values.map(entry => ({ entityType: entry.entityType as 'paper' | 'note', sourceId: entry.entityId, originalId: `${entry.entityType}-local-${entry.entityId}` })) };
  const exported = exportLibraryArchive(values, { version: 2, exportReport: report });
  assert.deepEqual(parseLibraryArchive(exported.json).exportReport, report);
  const plan = planLibraryImport(exported.archive, []), imported = materializeLibraryImport(plan, allocator());
  assert.ok(imported.edits.every(edit => !values.some(source => source.entityId === edit.entityId)));
  for (const mutate of [
    (value: any) => { value.exportReport.requestedNotes = 4; },
    (value: any) => { value.exportReport.skipped.push(value.exportReport.skipped[0]); },
    (value: any) => { value.exportReport.aliases[0].sourceId = id(999); },
    (value: any) => { value.exportReport.aliases.pop(); },
    (value: any) => { value.exportReport.aliases[0].originalId = 'C:/private/library'; },
    (value: any) => { value.exportReport.aliases[0].originalId = 'C:private'; },
    (value: any) => { value.exportReport.path = '/private'; },
  ]) {
    const invalid = structuredClone(exported.archive); mutate(invalid);
    fails(() => parseLibraryArchive(JSON.stringify(invalid)));
  }
  const markdown = exportLibraryArchive([values[3]], { version: 2 });
  assert.equal(markdown.archive.version, 2); assert.equal(parseLibraryArchive(markdown.json).notes[0].sourceId, id(4));
});

test('selected graph targets use fresh IDs and all unselected/unknown refs become explicit unresolved values', () => {
  const archive = exportLibraryArchive(source()).archive;
  const existing = [visible('paper', id(2), paper('Unrelated current paper', '10.1000/other')),
    visible('paper', id(99), paper('Unknown UUID collision', '10.1000/collision')),
    visible('note', id(4), { paperId: null, title: 'Unrelated B', body: 'different', format: 'markdown' }),
    visible('note', id(98), { paperId: null, title: 'Unknown UUID collision', body: 'private unrelated note', format: 'markdown' })];
  const plan = planLibraryImport(archive, existing, ['paper:p1', 'note:n1', 'note:n2']);
  const result = materializeLibraryImport(plan, allocator());
  const main = result.edits.find((edit) => edit.entityType === 'note' && edit.data?.title === 'Rich note')!, peer = result.edits.find((edit) => edit.entityType === 'note' && edit.data?.title === 'B')!;
  const data = main.data as RichNoteData;
  assert.equal(data.paperId, result.edits[0].entityId); assert.notEqual(data.paperId, id(1));
  assert.equal(data.document.content![0].content![1].attrs!.id, peer.entityId); assert.notEqual(peer.entityId, id(4));
  assert.equal(data.document.content![0].content![2].attrs!.id, richNoteUnresolvedId('note', id(98)));
  assert.equal(data.document.content![0].content![3].attrs!.paperId, richNoteUnresolvedId('paper', id(2)));
  assert.equal(data.document.content![0].content![4].attrs!.paperId, richNoteUnresolvedId('paper', id(99)));
  assert.equal(data.metadata.anchors[0].paperId, richNoteUnresolvedId('paper', id(99))); assert.equal(data.metadata.anchors[0].verification, 'unverified');
  assert.equal(data.assets[0].sha256, hash); assert.deepEqual(data.document.content!.slice(1), rich().document.content!.slice(1));
  assert.deepEqual(validateRichNoteData(data), data); assert.deepEqual(data.metadata.tags, ['原标签']);
  assert.equal(data.metadata.createdAt, 100); assert.equal(data.metadata.updatedAt, 200);
});

test('a partial graph does not reuse even an identical existing note as an embedded target', () => {
  const archive = exportLibraryArchive(source()).archive;
  const target = visible('note', id(4), { paperId: null, title: 'B', body: 'B body', format: 'markdown' });
  const plan = planLibraryImport(archive, [target], ['paper:p1', 'note:n1']);
  const data = materializeLibraryImport(plan, allocator()).edits.find((edit) => edit.entityType === 'note')!.data as RichNoteData;
  assert.equal(data.document.content![0].content![1].attrs!.id, richNoteUnresolvedId('note', id(4)));
  assert.ok(data.metadata.unresolvedReferences.some((entry) => entry.id === richNoteUnresolvedId('note', id(4))));
});

test('rich deduplication compares AST/marks/metadata/resources, never derived body alone', () => {
  const bold = rich('bold', false), italic = rich('italic', false); assert.equal(bold.body, italic.body);
  const existing = [visible('note', id(10), bold)];
  const changed = exportLibraryArchive([visible('note', id(20), italic)]).archive;
  assert.equal(planLibraryImport(changed, existing).rows[0].duplicate, null);
  const same = exportLibraryArchive([visible('note', id(21), bold)]).archive;
  assert.equal(planLibraryImport(same, existing).summary.duplicateNotes, 1);
  const differentTags = structuredClone(bold); differentTags.metadata.tags.push('另一个标签');
  assert.equal(planLibraryImport(exportLibraryArchive([visible('note', id(22), differentTags)]).archive, existing).summary.duplicateNotes, 0);
});

test('only selected rich creates require the workspace rich-note capability', () => {
  const archive = exportLibraryArchive(source()).archive;
  assert.equal(planLibraryImport(archive, [], ['note:n2']).requiresRichNotes, false);
  assert.equal(planLibraryImport(archive, [], ['paper:p1', 'note:n1']).requiresRichNotes, true);
  assert.equal(materializeLibraryImport(planLibraryImport(archive, [], ['note:n2']), allocator()).requiresRichNotes, false);
});

test('missing main paper associations remain blocked even if a target account UUID happens to match', () => {
  const archive = exportLibraryArchive([visible('note', id(3), rich())]).archive;
  assert.equal(archive.notes[0].paperSourceId, id(1), 'missing primary source identity is retained without inventing paper metadata');
  const plan = planLibraryImport(archive, [visible('paper', id(1), paper())], ['note:n1']);
  assert.equal(plan.summary.selectedBlockedNotes, 1); fails(() => materializeLibraryImport(plan, allocator()), 'BLOCKED_ASSOCIATION');
});

test('v2 sources cannot allocate the original source IDs or silently downgrade damaged resources', () => {
  const archive = exportLibraryArchive(source()).archive, plan = planLibraryImport(archive, []);
  fails(() => materializeLibraryImport(plan, () => id(1)), 'ID_ALLOCATION_FAILED');
  const corrupt = structuredClone(archive); (corrupt.notes[0] as LibraryRichNote).assets[0].width = 999;
  fails(() => parseLibraryArchive(JSON.stringify(corrupt)));
  fails(() => parseLibraryArchive(JSON.stringify({ ...archive, version: 1 })));
  const duplicate = structuredClone(archive); duplicate.notes[1].sourceId = duplicate.notes[0].sourceId;
  fails(() => parseLibraryArchive(JSON.stringify(duplicate)));
  const wrongPaper = structuredClone(archive); wrongPaper.notes[0].paperSourceId = id(2);
  fails(() => parseLibraryArchive(JSON.stringify(wrongPaper)));
});

test('paper and note source UUID namespaces stay separate even when the raw UUID is identical', () => {
  const data = rich('bold', false);
  data.paperId = id(1); data.document.content![0].content!.push({ type: 'wikiLink', attrs: { id: id(1), label: '自己' } });
  data.metadata.linkedNoteIds = [id(1)];
  const final = createRichNoteData({ paperId: data.paperId, title: data.title, document: data.document, metadata: data.metadata, assets: data.assets });
  const archive = exportLibraryArchive([visible('paper', id(1), paper()), visible('note', id(1), final)]).archive;
  const result = materializeLibraryImport(planLibraryImport(archive, []), allocator());
  const note = result.edits[1].data as RichNoteData;
  assert.equal(note.paperId, result.edits[0].entityId);
  assert.equal(note.document.content![0].content!.at(-1)!.attrs!.id, result.edits[1].entityId);
  assert.notEqual(note.paperId, result.edits[1].entityId);
});

test('unresolved source references never reactivate merely because an import contains that UUID', () => {
  const unresolved = rich('bold', false); unresolved.document.content![0].content!.push({ type: 'wikiLink', attrs: { id: richNoteUnresolvedId('note', id(4)), label: '旧未解析引用' } });
  unresolved.metadata.unresolvedReferences.push({ kind: 'note', id: richNoteUnresolvedId('note', id(4)), label: '旧未解析引用', reason: 'unmapped' });
  const final = createRichNoteData({ paperId: null, title: unresolved.title, document: unresolved.document, metadata: unresolved.metadata, assets: unresolved.assets });
  const archive = exportLibraryArchive([visible('note', id(3), final), source()[3]]).archive;
  const result = materializeLibraryImport(planLibraryImport(archive, []), allocator());
  const data = result.edits.find((edit) => edit.entityType === 'note' && edit.data?.title === 'Rich note')!.data as RichNoteData;
  assert.equal(data.document.content![0].content!.at(-1)!.attrs!.id, richNoteUnresolvedId('note', id(4)));
});
