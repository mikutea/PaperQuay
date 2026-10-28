import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { canonicalJson, type AnnotationData, type AttachmentVersionData, type EntityData, type PaperData, type VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import { createRichNoteData, validateRichNoteData, type RichNoteAsset, type RichNoteData, type RichNoteMetadata, type RichNoteNode } from '../../../packages/sync-core/src/richNote.ts';
import { buildReadingExport, parseReadingExport, validateReadingExportArchive, ReadingExportError, READING_EXPORT_LIMITS,
  type ReadingExportArchive, type ReadingExportErrorCode, type ReadingExportRichNote } from '../src/library/readingExport.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC6kAAAAASUVORK5CYII=', 'base64');
const paragraph = (value: string): RichNoteNode => ({ type: 'paragraph', content: [{ type: 'text', text: value }] });
function asset(): RichNoteAsset {
  const sha256 = createHash('sha256').update(png).digest('hex');
  return { id: sha256, mediaType: 'image/png', base64: png.toString('base64'), sha256, sizeBytes: png.length, width: 1, height: 1 };
}
function metadata(): RichNoteMetadata {
  return { type: 'highlight', color: '#fef08a', tags: ['方法', '富文本'], isFavorite: true, isPinned: true,
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000, excerpt: '保存的来源摘录', folderId: 'folder_1',
    linkedPaperId: id(1), linkedNoteIds: ['old-note'], linkedPaperIds: [id(2)], aiChatId: 'chat_1', aiChatMessageIds: ['msg_1', 'msg_2'],
    pdfLocation: { pageNumber: 2, bbox: [10, 20, 30, 40], bboxCoordinateSystem: 'pdf', bboxPageSize: [600, 800], highlightColor: '#fef08a' },
    anchors: [{ id: 'anchor_1', label: 'P2', excerpt: '历史摘录', createdAt: 1_700_000_000_000, verification: 'unverified',
      paperId: id(1), sourceTitle: 'Original study', source: 'pdf', blockId: 'block_1', pageIndex: 1,
      pdfLocation: { pageNumber: 2, boundingRect: { x: 10, y: 20, width: 30, height: 40 } } }],
    unresolvedReferences: [{ kind: 'folder', id: 'folder_1', label: '历史文件夹', reason: 'unmapped' }] };
}
function rich(): RichNoteData {
  const image = asset();
  return createRichNoteData({ paperId: id(1), title: '完整富文本笔记', metadata: metadata(), assets: [image], document: {
    type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '研究标题' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: '<script>plain saved text</script>', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'strike' },
          { type: 'underline' }, { type: 'highlight', attrs: { color: 'rgba(255, 255, 0, 0.5)' } },
          { type: 'link', attrs: { href: 'https://doi.org/10.1000/example', target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: '论文' } }] },
        { type: 'text', text: 'inline_code', marks: [{ type: 'code' }] }, { type: 'hardBreak' },
        { type: 'inlineMath', attrs: { latex: 'E=mc^2' } }, { type: 'noteAnchorLink', attrs: { anchorId: 'anchor_1', label: 'P2' } },
        { type: 'wikiLink', attrs: { id: 'old-note', label: '关联笔记' } }, { type: 'hashTag', attrs: { tag: '方法' } },
        { type: 'paperReference', attrs: { paperId: id(2), label: '历史关联文献' } },
      ] },
      { type: 'blockquote', content: [paragraph('引用内容')] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('项目')] }] },
      { type: 'orderedList', attrs: { start: 3, type: 'I' }, content: [{ type: 'listItem', content: [paragraph('第三项')] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph('任务')] }] },
      { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const fences = "`````";\n' }] },
      { type: 'horizontalRule' }, { type: 'blockMath', attrs: { latex: '\\int_0^1 x^2 dx' } },
      { type: 'table', content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { rowspan: 2, colspan: 1, colwidth: [120], align: 'center' }, content: [paragraph('合并行')] },
          { type: 'tableHeader', attrs: { rowspan: 1, colspan: 2, colwidth: [130, 140], align: null }, content: [paragraph('合并列')] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', attrs: { rowspan: 1, colspan: 1, colwidth: null, align: 'right' }, content: [paragraph('左格')] },
          { type: 'tableCell', attrs: { rowspan: 1, colspan: 1, colwidth: [140], align: 'left' }, content: [paragraph('右格')] }] },
      ] },
      { type: 'image', attrs: { src: `asset:sha256:${image.id}`, alt: '原始图像', title: '原图', width: 1, height: null } },
      { type: 'noteComponentBlock', attrs: { title: '概念组件', variant: 'note' }, content: [paragraph('组件内容')] },
      { type: 'noteAnchorBlock', attrs: { anchorId: 'anchor_1', label: 'P2', sourceLabel: '来源', sourceTitle: 'Original study', excerpt: '历史摘录' } },
    ],
  } });
}
function entity(entityType: VisibleEntity['entityType'], n: number, data: EntityData): VisibleEntity {
  return { entityType, entityId: id(n), data, revision: 1, pending: false, deleted: false, status: 'synced' };
}
function source(note = rich()): VisibleEntity[] {
  const paper: PaperData = { title: 'Original study', authors: ['Stored author'], year: '2026', doi: null,
    publication: null, abstractText: null, keywords: [] };
  const version: AttachmentVersionData = { paperId: id(1), attachmentId: id(10), sha256: 'a'.repeat(64), sizeBytes: 1024,
    mediaType: 'application/pdf', fileName: 'saved.pdf', pageCount: 3 };
  const annotation: AnnotationData = { paperId: id(1), attachmentVersionId: id(11), kind: 'highlight', color: '#ffcc00', comment: 'Saved annotation',
    anchor: { pageIndex: 1, coordinateSpace: 'pdf-crop-box-unrotated-normalized', quads: [[0.1, 0.2, 0.4, 0.2, 0.4, 0.3, 0.1, 0.3]], quote: null } };
  return [entity('paper', 1, paper), entity('attachmentVersion', 11, version), entity('note', 21, note),
    entity('note', 22, { paperId: null, title: 'Markdown original', format: 'markdown', body: '# 原文\r\n尾行  ' }), entity('annotation', 31, annotation)];
}
function exported(archive: ReadingExportArchive): ReadingExportRichNote {
  const note = archive.notes.find(note => note.format === 'tiptap-json'); assert.ok(note && note.format === 'tiptap-json'); return note;
}
function original(note: ReadingExportRichNote): RichNoteData {
  return { paperId: note.sourcePaperId, title: note.title, format: 'tiptap-json', body: note.body,
    document: note.document, metadata: note.metadata, assets: note.assets };
}
const rejects = (code: ReadingExportErrorCode, run: () => unknown) => assert.throws(run, (error: unknown) => error instanceof ReadingExportError && error.code === code);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('v2 round trip retains every supported node/mark/attribute, full metadata and exact image bytes with verified SHA-256', () => {
  const data = rich(), input = freeze(source(data)), before = structuredClone(input), result = buildReadingExport(input);
  assert.equal(result.archive.version, 2); assert.equal(result.summary.richNotes, 1); assert.equal(result.summary.embeddedImages, 1);
  assert.equal(result.summary.embeddedImageBytes, png.length); assert.equal(result.summary.notes, 2); assert.equal(result.summary.annotations, 1);
  const parsed = parseReadingExport(result.json), saved = exported(parsed);
  assert.deepEqual(original(saved), data); assert.deepEqual(validateRichNoteData(original(saved)), data);
  assert.equal(canonicalJson(saved.document), canonicalJson(data.document)); assert.deepEqual(saved.metadata, data.metadata);
  assert.deepEqual(Buffer.from(saved.assets[0].base64, 'base64'), png);
  assert.equal(createHash('sha256').update(Buffer.from(saved.assets[0].base64, 'base64')).digest('hex'), saved.assets[0].sha256);
  assert.equal(parsed.evidence.images, 'embedded-base64-sha256-verified'); assert.equal(parsed.evidence.richReferences, 'original-identifiers-not-rebound');
  assert.equal(saved.metadata.anchors[0].verification, 'unverified'); assert.equal(parsed.annotations[0].anchor.pageIndex, 1);
  assert.equal(parsed.versions[0].data!.sha256, 'a'.repeat(64)); assert.deepEqual(input, before);
  saved.assets[0].base64 = ''; assert.deepEqual(input, before);
});

test('Markdown provides readable content and a complete parseable rich payload without active HTML, image loading or lost table structure', () => {
  const data = rich(), result = buildReadingExport(source(data)), tree = fromMarkdown(result.markdown);
  const nodes: { type: string; lang?: string | null; value?: string; children?: unknown[] }[] = [];
  const visit = (node: { type: string; children?: unknown[] }) => { nodes.push(node); (node.children ?? []).forEach(child => visit(child as typeof node)); };
  visit(tree);
  assert.equal(nodes.some(node => node.type === 'html' || node.type === 'image'), false);
  const payloads = nodes.filter(node => node.type === 'code' && node.lang === 'json').flatMap(node => {
    const value = JSON.parse(node.value!); return value.format === 'tiptap-json' ? [value] : [];
  });
  assert.deepEqual(payloads, [data]);
  assert.ok(result.markdown.includes('### 可读正文')); assert.ok(result.markdown.includes(data.body));
  assert.ok(result.markdown.includes(data.assets[0].sha256)); assert.ok(result.markdown.includes('完整富文本原始结构'));
  assert.ok(result.markdown.includes('合并行')); assert.ok(result.markdown.includes('历史锚点仍是未验证记录'));
});

test('Markdown-only and annotation-only scopes keep v1 compatibility while rich scopes use a declared v2 envelope', () => {
  const input = source();
  const plain = buildReadingExport(input, { query: 'Markdown original', includeAnnotations: false });
  assert.equal(plain.archive.version, 1); assert.equal(plain.summary.richNotes, 0);
  assert.deepEqual(parseReadingExport(plain.json), plain.archive); assert.equal(plain.archive.notes[0].body, '# 原文\r\n尾行  ');
  const annotations = buildReadingExport(input, { includeNotes: false }); assert.equal(annotations.archive.version, 1);
  const richOnly = buildReadingExport(input, { paperId: id(1), includeAnnotations: false });
  assert.equal(richOnly.archive.version, 2); assert.equal(richOnly.archive.notes.length, 1);
  const downgrade = structuredClone(richOnly.archive); downgrade.version = 1;
  rejects('INVALID_ARCHIVE', () => validateReadingExportArchive(downgrade));
  const undeclared = structuredClone(richOnly.archive); delete undeclared.evidence.images;
  rejects('INVALID_ARCHIVE', () => validateReadingExportArchive(undeclared));
});

test('historical references are preserved without pulling extra records or claiming new PDF verification', () => {
  const data = rich(), result = buildReadingExport(source(data), { paperId: id(1) });
  const note = exported(result.archive);
  assert.equal(note.sourcePaperId, id(1)); assert.equal(note.paperRef, result.archive.papers[0].ref);
  assert.deepEqual(note.metadata.linkedPaperIds, [id(2)]); assert.equal(result.archive.papers.length, 1);
  assert.equal(note.metadata.anchors[0].verification, 'unverified'); assert.equal(result.archive.evidence.hash, 'saved-version-metadata');
  for (const field of ['accountId', 'deviceId', 'apiKey', 'modifiedByDeviceId', 'sessionToken']) assert.equal(result.json.includes(`"${field}"`), false);
  assert.equal(result.archive.annotations.length, 1); assert.equal(result.archive.notes.length, 1);
});

test('v2 rejects modified image bytes/hash/dimensions, unknown rich nodes and metadata, forged derived text and rebound primary sources', () => {
  const archive = buildReadingExport(source()).archive;
  const mutations: ((note: ReadingExportRichNote) => void)[] = [
    note => { note.assets[0].base64 = note.assets[0].base64.replace(/^i/, 'j'); },
    note => { note.assets[0].sha256 = 'f'.repeat(64); }, note => { note.assets[0].width = 2; },
    note => { note.assets = []; }, note => { note.assets.push(structuredClone(note.assets[0])); },
    note => { note.document.content![0].type = 'unknownFutureNode'; },
    note => { Object.assign(note.document.content![0].attrs!, { onclick: 'private code' }); },
    note => { Object.assign(note.metadata, { apiKey: 'private metadata' }); },
    note => { note.body = 'Flattened or forged text'; }, note => { note.sourcePaperId = null; },
    note => { (note.metadata.anchors[0] as { verification: string }).verification = 'verified'; },
    note => { note.document.content![1].content![0].marks!.find(mark => mark.type === 'link')!.attrs!.href = 'file:///private'; },
  ];
  for (const change of mutations) {
    const modified = structuredClone(archive); change(exported(modified));
    rejects('INVALID_ARCHIVE', () => parseReadingExport(JSON.stringify(modified)));
  }
});

test('source validation does not execute accessors or export a damaged rich note as a flattened fallback', () => {
  const input = source(), data = input[2].data as RichNoteData; let calls = 0;
  Object.defineProperty(data.document.content![0], 'attrs', { enumerable: true, get() { calls++; return { level: 1 }; } });
  rejects('INVALID_DATA', () => buildReadingExport(input)); assert.equal(calls, 0);
  const damaged = source(); (damaged[2].data as RichNoteData).assets[0].sha256 = 'f'.repeat(64);
  rejects('INVALID_DATA', () => buildReadingExport(damaged));
  const forged = buildReadingExport(source()).archive;
  Object.defineProperty(exported(forged).metadata, 'tags', { enumerable: true, get() { calls++; return []; } });
  rejects('INVALID_ARCHIVE', () => validateReadingExportArchive(forged)); assert.equal(calls, 0);
});

test('valid nested rich structures beyond the former JSON depth limit remain lossless and oversized reports fail as a whole', () => {
  let nested: RichNoteNode = paragraph('Nested original');
  for (let depth = 0; depth < 8; depth++) nested = { type: 'blockquote', content: [nested] };
  const meta = metadata(); meta.anchors = []; meta.linkedNoteIds = []; meta.linkedPaperIds = [];
  const data = createRichNoteData({ paperId: id(1), title: 'Nested', document: { type: 'doc', content: [nested] }, metadata: meta, assets: [] });
  const exportedNested = buildReadingExport(source(data));
  assert.deepEqual(original(exported(parseReadingExport(exportedNested.json))), data);
  rejects('INVALID_ARCHIVE', () => parseReadingExport('['.repeat(READING_EXPORT_LIMITS.maxJsonDepth + 1) + '0' + ']'.repeat(READING_EXPORT_LIMITS.maxJsonDepth + 1)));
  const wide = createRichNoteData({ paperId: null, title: 'Large rich', document: { type: 'doc', content: [paragraph('汉'.repeat(130_000))] }, metadata: meta, assets: [] });
  rejects('EXPORT_TOO_LARGE', () => buildReadingExport(Array.from({ length: 6 }, (_, index) => entity('note', index + 100, wide))));
});

test('rich metadata-only and revision-only changes invalidate previews without mutating stored content', () => {
  const input = source(), initial = buildReadingExport(input), reordered = buildReadingExport([...input].reverse());
  assert.equal(reordered.json, initial.json); assert.equal(reordered.signature, initial.signature);
  const revised = structuredClone(input); revised[2].revision++;
  assert.equal(buildReadingExport(revised).json, initial.json); assert.notEqual(buildReadingExport(revised).signature, initial.signature);
  (revised[2].data as RichNoteData).metadata.isPinned = false;
  assert.notEqual(buildReadingExport(revised).json, initial.json); assert.notEqual(buildReadingExport(revised).signature, initial.signature);
  assert.equal((input[2].data as RichNoteData).metadata.isPinned, true);
});
