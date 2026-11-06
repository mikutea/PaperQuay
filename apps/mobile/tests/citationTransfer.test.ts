import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { PaperData, VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import {
  CitationTransferError, exportPaperQuayCitations, formatPaperQuayReference, PAPERQUAY_CITATION_STYLE,
  type CitationTransferErrorCode,
} from '../src/library/citationTransfer.ts';

const require = createRequire(import.meta.url);
// The desktop adapter delegates formatting to this same platform-free core.
// Loading reviewCommands would require Electron in a mobile-only installation.
const desktop = require('../../../packages/review-core/index.cjs').createReviewCore() as {
  prepareReviewDocxData(value: unknown): { references: { label: string; formattedText: string }[] };
};
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const paper = (extra: Partial<PaperData> = {}): PaperData => ({ title: 'A study', doi: '10.1234/study',
  year: '2026', publication: 'Journal', abstractText: null, authors: ['A. Author', 'B. Author'], keywords: [], ...extra });
const visible = (n: number, data: PaperData = paper(), extra: Partial<VisibleEntity> = {}): VisibleEntity => ({
  entityType: 'paper', entityId: id(n), data, deleted: false, revision: 1, pending: false, status: 'synced', ...extra,
});
function rejects(code: CitationTransferErrorCode, action: () => unknown) {
  assert.throws(action, (error: unknown) => error instanceof CitationTransferError && error.code === code);
}

test('PaperQuay reference text is byte-for-byte identical to the desktop DOCX formatter core', () => {
  const cases = [paper(), paper({ title: '中文研究。', authors: ['张三', 'Institute, Lab'], publication: '期刊；', year: '2026。', doi: 'DOI: 10.1234/中文' }),
    paper({ title: 'Question?', authors: [], publication: null, year: null, doi: null }),
    paper({ title: '  A title; ', authors: ['Smith, J.;', 'Other.'], publication: 'Journal, ', year: '2025;', doi: 'doi:10.5555/test.' }),
    paper({ title: '[Text](https://example.invalid)', authors: ['Institute'], publication: '<i>Journal</i>', year: null, doi: null })];
  for (const data of cases) {
    const prepared = desktop.prepareReviewDocxData({ title: 'Reference comparison',
      references: [{ id: 'P1', title: data.title, authors: data.authors.join(', '), journal: data.publication ?? '',
        year: data.year ?? '', doi: data.doi ?? '' }], sources: [{ id: 'P1', sourceType: 'paper', title: data.title }] });
    assert.equal(prepared.references.length, 1);
    assert.equal(formatPaperQuayReference(data), prepared.references[0].formattedText);
    assert.equal(exportPaperQuayCitations([visible(1, data)]).citations[0].label, prepared.references[0].label);
  }
});

test('explicit paper order determines numbering while default export is deterministic', () => {
  const source = [visible(2, paper({ title: 'Second' })), visible(1, paper({ title: 'First' }))];
  const selected = exportPaperQuayCitations(source, [id(2), id(1)]);
  assert.equal(selected.style, PAPERQUAY_CITATION_STYLE);
  assert.deepEqual(selected.citations.map((entry) => [entry.label, entry.paperId]), [['[1]', id(2)], ['[2]', id(1)]]);
  assert.equal(exportPaperQuayCitations(source).markdown, exportPaperQuayCitations([...source].reverse()).markdown);
  assert.equal(exportPaperQuayCitations(source).citations[0].paperId, id(1));
});

test('exported Markdown escapes active metadata and omits internal IDs and unused private metadata', () => {
  const data = paper({ title: '<script>run()</script> ![tracking](https://example.invalid)',
    abstractText: 'not part of citation', keywords: ['private keyword'],
    organization: { favorite: true, readingStatus: 'read', tags: ['private tag'], collections: [], queueRank: 2 } });
  const result = exportPaperQuayCitations([visible(1, data)]);
  assert.equal(result.citations[0].text, formatPaperQuayReference(data));
  for (const excluded of [id(1), '<script>', '![tracking]', 'not part of citation', 'private keyword', 'private tag']) {
    assert.ok(!result.markdown.includes(excluded), excluded);
  }
  assert.ok(result.markdown.includes('不是 APA、CSL 或 GB/T'));
  assert.ok(!result.markdown.includes('pp.'));
});

test('pending and conflicted source metadata is labelled and deleted records are excluded', () => {
  const result = exportPaperQuayCitations([visible(1, paper(), { status: 'conflict', pending: true }),
    visible(2, paper(), { status: 'queued' }), visible(3, paper(), { deleted: true })]);
  assert.deepEqual(result.summary, { papers: 2, pending: 2, conflicted: 1 });
  assert.ok(result.markdown.includes('2 篇含待处理'));
  rejects('INVALID_SELECTION', () => exportPaperQuayCitations([visible(3, paper(), { deleted: true })], [id(3)]));
});

test('citation generation rejects malformed data, duplicate selections and accessor inputs without executing them', () => {
  rejects('INVALID_DATA', () => exportPaperQuayCitations([visible(1, paper({ title: '\ud800' }))]));
  rejects('INVALID_DATA', () => exportPaperQuayCitations([visible(1), visible(1)]));
  rejects('INVALID_SELECTION', () => exportPaperQuayCitations([visible(1)], [id(1), id(1)]));
  rejects('INVALID_SELECTION', () => exportPaperQuayCitations([visible(1)], [id(2)]));
  let calls = 0;
  const accessor = paper(); Object.defineProperty(accessor, 'title', { enumerable: true, get() { calls++; return 'secret'; } });
  rejects('INVALID_DATA', () => formatPaperQuayReference(accessor));
  const source = [visible(1)]; Object.defineProperty(source, 0, { get() { calls++; return visible(1); } });
  rejects('INVALID_DATA', () => exportPaperQuayCitations(source));
  assert.equal(calls, 0);
});

test('citation bounds are scoped to selected papers and do not mutate stored metadata', () => {
  const entities = Array.from({ length: 501 }, (_, index) => visible(index + 1));
  rejects('TOO_MANY_PAPERS', () => exportPaperQuayCitations(entities));
  assert.equal(exportPaperQuayCitations(entities, [id(1)]).summary.papers, 1);
  const before = structuredClone(entities[0]);
  const result = exportPaperQuayCitations([entities[0]]);
  result.citations[0].text = 'Caller change';
  assert.deepEqual(entities[0], before);
  const changed = visible(1, paper(), { revision: 2 });
  assert.notEqual(exportPaperQuayCitations([changed]).signature, exportPaperQuayCitations([entities[0]]).signature);
});
