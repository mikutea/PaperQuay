import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnnotationData, AttachmentVersionData, EntityData, NoteData, PaperData, VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import {
  buildReadingExport, parseReadingExport, readingExportCatalog, READING_EXPORT_LIMITS, ReadingExportError, validateReadingExportArchive,
  type ReadingExportErrorCode,
} from '../src/library/readingExport.ts';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const paper = (extra: Partial<PaperData> = {}): PaperData => ({ title: 'Study one', doi: '10.1234/one', year: '2026', publication: 'Journal',
  abstractText: 'Abstract', authors: ['A. Author'], keywords: ['method'], organization: {
    favorite: true, readingStatus: 'reading', tags: ['方法'], collections: ['课题'], queueRank: 1,
  }, ...extra });
const version = (paperId = id(1), hash = 'a', extra: Partial<AttachmentVersionData> = {}): AttachmentVersionData => ({
  paperId, attachmentId: id(500), sha256: hash.repeat(64), sizeBytes: 1024, mediaType: 'application/pdf', fileName: `${hash}.pdf`, pageCount: 5, ...extra,
});
const note = (paperId: string | null = id(1), body = 'Original **Markdown**.'): NoteData => ({ paperId, title: 'Reading note', body, format: 'markdown' });
const annotation = (paperId = id(1), attachmentVersionId = id(11), extra: Partial<AnnotationData> = {}): AnnotationData => ({
  paperId, attachmentVersionId, kind: 'highlight', color: '#ffcc00', comment: 'My comment',
  anchor: { pageIndex: 1, coordinateSpace: 'pdf-crop-box-unrotated-normalized', quads: [[0.1, 0.2, 0.4, 0.2, 0.4, 0.3, 0.1, 0.3]],
    quote: { exact: 'Exact original', prefix: 'Before', suffix: 'After' } }, ...extra,
});
function visible(type: VisibleEntity['entityType'], n: number, data: EntityData | null, extra: Partial<VisibleEntity> = {}): VisibleEntity {
  return { entityType: type, entityId: id(n), data, deleted: false, revision: 1, pending: false, status: 'synced', ...extra };
}
const originalBody = '# 原始标题\r\n\r\n```ts\r\nlet x = 1;\r\n```\r\n\n`````\n\n<!-- 原文 -->\n<script>not executed</script>\n$$ x^2 $$\n尾行  ';
function fixture(): VisibleEntity[] {
  return [visible('paper', 1, paper()), visible('paper', 2, paper({ title: 'Study two', doi: '10.1234/two', organization: {
    favorite: false, readingStatus: 'unread', tags: ['综述'], collections: [], queueRank: null,
  } })), visible('attachmentVersion', 11, version()), visible('attachmentVersion', 12, version(id(1), 'b')),
  visible('attachmentVersion', 13, version(id(2), 'c')), visible('note', 21, note(id(1), originalBody)),
  visible('note', 22, note(null, 'Independent note')), visible('note', 23, note(id(2), 'Second paper note')),
  visible('annotation', 31, annotation()), visible('annotation', 32, annotation(id(1), id(12), { kind: 'area', comment: 'Area comment',
    anchor: { ...annotation().anchor, pageIndex: 3, quote: null } })),
  visible('annotation', 33, annotation(id(2), id(13), { kind: 'underline', comment: 'Other paper comment' }))];
}
function rejects(code: ReadingExportErrorCode, action: () => unknown) {
  assert.throws(action, (error: unknown) => error instanceof ReadingExportError && error.code === code);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('closed reading JSON retains exact bodies, provenance, version fingerprints and annotation coordinates', () => {
  const source = freeze(fixture());
  const result = buildReadingExport(source);
  assert.deepEqual(parseReadingExport(result.json), result.archive);
  assert.equal(result.summary.notes, 3); assert.equal(result.summary.annotations, 3); assert.equal(result.summary.standaloneNotes, 1);
  assert.equal(result.archive.notes.find((entry) => entry.body.includes('原始标题'))!.body, originalBody);
  assert.deepEqual(result.archive.annotations[0].anchor, annotation().anchor);
  assert.equal(result.archive.versions[0].data!.sha256, 'a'.repeat(64));
  assert.equal(result.archive.versions[0].data!.sizeBytes, 1024);
  assert.equal(result.archive.papers[0].citation!.label, '[1]');
  assert.equal(result.archive.papers[0].citation!.text, 'A. Author. Study one. Journal. 2026. DOI: 10.1234/one.');
  for (const entity of source) { assert.ok(!result.json.includes(entity.entityId)); assert.ok(!result.markdown.includes(entity.entityId)); }
  for (const secret of [id(500), 'accountId', 'deviceId', 'organization', 'queueRank', 'apiKey']) assert.ok(!result.json.includes(secret));
  assert.equal(result.archive.evidence.hash, 'saved-version-metadata'); assert.equal(result.archive.evidence.pdf, 'not-included');
});

test('Markdown wraps original notes separately using fences that their original content cannot close', () => {
  const result = buildReadingExport(fixture());
  assert.ok(result.markdown.includes('``````markdown\n' + originalBody + '\n``````\n'));
  assert.ok(result.markdown.includes('来源：独立笔记'));
  assert.ok(result.markdown.includes('区域批注仅包含位置和评论'));
  assert.ok(result.markdown.includes('SHA-256：`' + 'b'.repeat(64) + '`'));
  assert.ok(result.markdown.includes('内部页码从 0 开始（1）'));
  assert.ok(result.markdown.includes(JSON.stringify(annotation().anchor.quads)));
  assert.ok(result.markdown.includes('本次导出没有重新读取或校验 PDF'));
  assert.equal((result.markdown.match(/## 笔记 n[1-9]/g) ?? []).length, 3);
});

test('paper and associated-tag filters retain document notes while version selection only restricts annotations', () => {
  const result = buildReadingExport(fixture(), { paperId: id(1), attachmentVersionId: id(11) });
  assert.equal(result.summary.notes, 1); assert.equal(result.summary.annotations, 1);
  assert.equal(result.archive.notes[0].body, originalBody); assert.equal(result.archive.versions[0].data!.sha256, 'a'.repeat(64));
  assert.equal(result.archive.scope.includeStandalone, false);
  const tagged = buildReadingExport(fixture(), { paperTag: '方法', includeStandalone: true });
  assert.equal(tagged.summary.notes, 1); assert.equal(tagged.summary.annotations, 2); assert.equal(tagged.summary.standaloneNotes, 0);
  assert.equal(tagged.archive.papers.length, 1); assert.equal(tagged.archive.papers[0].data!.title, 'Study one');
  const otherTag = buildReadingExport(fixture(), { paperTag: '不存在' });
  assert.equal(otherTag.summary.notes + otherTag.summary.annotations, 0);
});

test('content query and explicit category toggles never synthesize tags for independent notes', () => {
  const independent = buildReadingExport(fixture(), { query: 'INDEPENDENT', includeAnnotations: false });
  assert.equal(independent.summary.notes, 1); assert.equal(independent.summary.standaloneNotes, 1); assert.equal(independent.archive.papers.length, 0);
  const excluded = buildReadingExport(fixture(), { query: 'Independent', includeStandalone: false });
  assert.equal(excluded.summary.notes, 0);
  const area = buildReadingExport(fixture(), { query: 'area', includeNotes: false });
  assert.equal(area.summary.annotations, 1); assert.equal(area.archive.annotations[0].kind, 'area');
  assert.deepEqual(readingExportCatalog(fixture()).tags, ['方法', '综述']);
});

test('missing or deleted associations remain closed placeholders instead of silently becoming independent notes', () => {
  const source = [visible('paper', 1, null, { deleted: true }), visible('attachmentVersion', 11, null, { deleted: true }),
    visible('note', 21, note()), visible('note', 22, note(id(2), 'Missing paper')),
    visible('annotation', 31, annotation()), visible('annotation', 32, annotation(id(2), id(12)))];
  const result = buildReadingExport(source);
  assert.deepEqual(result.archive.papers.map((entry) => entry.status), ['deleted', 'missing']);
  assert.deepEqual(result.archive.versions.map((entry) => entry.status), ['deleted', 'missing']);
  assert.equal(result.summary.unresolvedNotes, 2); assert.equal(result.summary.unresolvedAnnotations, 2);
  assert.ok(result.archive.notes.every((entry) => entry.paperRef !== null));
  assert.deepEqual(result.archive.annotations[0].issues, ['PAPER_UNAVAILABLE', 'VERSION_UNAVAILABLE']);
  assert.deepEqual(parseReadingExport(result.json), result.archive);
  assert.ok(result.markdown.includes('无法给出保存的 PDF 指纹'));
});

test('wrong-paper versions, out-of-range pages and unknown page counts are visible without rebinding annotations', () => {
  const source = fixture();
  source.push(visible('annotation', 34, annotation(id(1), id(13), { anchor: { ...annotation().anchor, pageIndex: 20 } })));
  source.push(visible('attachmentVersion', 14, version(id(1), 'd', { pageCount: null })));
  source.push(visible('annotation', 35, annotation(id(1), id(14))));
  const result = buildReadingExport(source, { paperId: id(1) });
  const mismatch = result.archive.annotations.find((entry) => entry.anchor.pageIndex === 20)!;
  assert.deepEqual(mismatch.issues, ['VERSION_PAPER_MISMATCH', 'PAGE_OUT_OF_RANGE']);
  assert.notEqual(result.archive.versions.find((version) => version.ref === mismatch.versionRef)!.paperRef, mismatch.paperRef);
  assert.ok(result.archive.annotations.some((entry) => entry.issues.includes('PAGE_COUNT_UNKNOWN')));
  assert.equal(result.summary.unresolvedAnnotations, 2);
  assert.deepEqual(parseReadingExport(result.json), result.archive);
});

test('deleted content is omitted and saved pending or conflicted content remains clearly labelled', () => {
  const source = fixture();
  source[5] = { ...source[5], pending: true, status: 'conflict' };
  source[8] = { ...source[8], pending: true, status: 'queued' };
  source.push(visible('note', 24, null, { deleted: true }));
  source.push(visible('annotation', 36, null, { deleted: true }));
  const result = buildReadingExport(source);
  assert.equal(result.summary.pending, 2); assert.equal(result.summary.conflicts, 1); assert.equal(result.summary.omittedDeleted, 2);
  assert.equal(result.archive.notes.find((entry) => entry.body === originalBody)!.savedState, 'conflict');
  assert.equal(result.archive.annotations[0].savedState, 'pending');
  assert.ok(result.markdown.includes('不代替冲突处理'));
});

test('unknown and future rich note formats are explicitly rejected only within the selected paper scope', () => {
  const source = fixture();
  source[7] = visible('note', 23, { paperId: id(2), title: 'Rich', format: 'rich-v2', doc: { type: 'doc' } } as unknown as NoteData);
  rejects('UNSUPPORTED_RICH_NOTE', () => buildReadingExport(source));
  assert.equal(buildReadingExport(source, { paperId: id(1) }).summary.notes, 1);
  source[7] = visible('note', 23, { ...note(id(2)), format: 'html' } as unknown as NoteData);
  rejects('UNSUPPORTED_NOTE_FORMAT', () => buildReadingExport(source));
  assert.equal(buildReadingExport(source, { includeNotes: false }).summary.annotations, 3);
});

test('export selections reject unavailable papers, mismatched versions and unsafe extra fields', () => {
  for (const selection of [{ paperId: id(999) }, { attachmentVersionId: id(11) }, { paperId: id(2), attachmentVersionId: id(11) },
    { paperTag: 'x'.repeat(81) }, { query: 'bad\u0000query' }, { paperId: 'file:///secret' }, { path: 'C:\\secret' }]) {
    rejects('INVALID_SELECTION', () => buildReadingExport(fixture(), selection as never));
  }
  assert.deepEqual(buildReadingExport([], {}).archive.notes, []);
});

test('closed JSON rejects broken references, forged citations and hidden or inconsistent fields', () => {
  const archive = buildReadingExport(fixture()).archive;
  const cases = [
    (value: typeof archive) => { value.notes[0].paperRef = 'p999'; },
    (value: typeof archive) => { value.versions[0].paperRef = 'p999'; },
    (value: typeof archive) => { value.annotations[0].versionRef = 'v999'; },
    (value: typeof archive) => { value.papers[0].citation!.text = 'Invented reference'; },
    (value: typeof archive) => { value.notes.push(value.notes[0]); },
    (value: typeof archive) => { value.annotations[0].issues = ['VERSION_UNAVAILABLE']; },
    (value: typeof archive) => { value.scope.includeNotes = false; },
    (value: typeof archive) => { Object.assign(value.notes[0], { filePath: 'C:\\private' }); },
    (value: typeof archive) => { Object.assign(value.papers[0].data!, { organization: paper().organization }); },
  ];
  for (const mutate of cases) {
    const changed = structuredClone(archive); mutate(changed);
    rejects('INVALID_ARCHIVE', () => parseReadingExport(JSON.stringify(changed)));
  }
  rejects('UNSUPPORTED_FORMAT', () => parseReadingExport(JSON.stringify({ ...archive, version: 3 })));
  rejects('INVALID_JSON', () => parseReadingExport('{'));
  rejects('INVALID_ARCHIVE', () => parseReadingExport('['.repeat(17) + '0' + ']'.repeat(17)));
});

test('export validates accessors without executing them and preserves all caller data', () => {
  let calls = 0;
  const source = fixture();
  Object.defineProperty(source[5].data, 'body', { enumerable: true, get() { calls++; return 'secret'; } });
  rejects('INVALID_DATA', () => buildReadingExport(source));
  const selection = { get paperId() { calls++; return id(1); } };
  rejects('INVALID_SELECTION', () => buildReadingExport(fixture(), selection));
  const archive = buildReadingExport(fixture()).archive;
  Object.defineProperty(archive, 'notes', { enumerable: true, get() { calls++; return []; } });
  rejects('INVALID_ARCHIVE', () => validateReadingExportArchive(archive));
  assert.equal(calls, 0);
  const frozen = freeze(fixture()); const before = structuredClone(frozen);
  const result = buildReadingExport(frozen);
  result.archive.annotations[0].anchor.quads[0][0] = 0.9;
  assert.deepEqual(frozen, before);
});

test('count, UTF-8 bytes and per-field limits fail as a whole without partial summaries', () => {
  const many = [visible('paper', 1, paper()), ...Array.from({ length: READING_EXPORT_LIMITS.maxNotes + 1 }, (_, index) => visible('note', index + 100, note()))];
  rejects('TOO_MANY_ITEMS', () => buildReadingExport(many));
  const wide = [visible('paper', 1, paper()), ...Array.from({ length: 6 }, (_, index) => visible('note', index + 100, note(id(1), '汉'.repeat(262144))))];
  rejects('EXPORT_TOO_LARGE', () => buildReadingExport(wide));
  rejects('INVALID_DATA', () => buildReadingExport([visible('note', 21, note(null, 'x'.repeat(262145)))]));
  rejects('EXPORT_TOO_LARGE', () => parseReadingExport(' '.repeat(READING_EXPORT_LIMITS.maxBytes + 1)));
});

test('report ordering is deterministic and signatures detect saved content or revision changes', () => {
  const source = fixture(); const initial = buildReadingExport(source);
  assert.equal(buildReadingExport([...source].reverse()).json, initial.json);
  assert.equal(buildReadingExport([...source].reverse()).signature, initial.signature);
  const changed = structuredClone(source); changed[5].revision++;
  assert.equal(buildReadingExport(changed).json, initial.json);
  assert.notEqual(buildReadingExport(changed).signature, initial.signature);
  (changed[5].data as NoteData).body = 'Later saved note';
  assert.notEqual(buildReadingExport(changed).json, initial.json);
});
