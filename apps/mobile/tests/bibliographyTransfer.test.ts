import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { plugins } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import type { EntityData, PaperData, VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import {
  BibliographyTransferError, exportBibliography, parseBibliography,
  type BibliographyTransferErrorCode,
} from '../src/library/bibliographyTransfer.ts';
import { LIBRARY_TRANSFER_LIMITS, planLibraryImport } from '../src/library/libraryTransfer.ts';

const id = (value: number) => '00000000-0000-4000-8000-' + value.toString(16).padStart(12, '0');
const paper = (overrides: Partial<PaperData> = {}): PaperData => ({
  title: '中文 study', doi: '10.1234/study', year: '2026', publication: 'Journal',
  abstractText: 'Résumé & abstract', authors: ['Doe, Jane', 'World Health and Care Organization'],
  keywords: ['城乡', 'machine, learning'], ...overrides,
});
const visible = (data: PaperData = paper(), extra: Partial<VisibleEntity> = {}): VisibleEntity => ({
  entityId: id(1), entityType: 'paper', data, revision: 1, pending: false, deleted: false, status: 'synced', ...extra,
});
function rejects(code: BibliographyTransferErrorCode, action: () => unknown, record?: number): BibliographyTransferError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof BibliographyTransferError);
  assert.equal(caught.code, code);
  if (record !== undefined) assert.equal(caught.record, record);
  assert.equal(caught.message, code, 'errors must not reflect a title, source key, path or other source contents');
  return caught;
}
const warning = (result: ReturnType<typeof parseBibliography> | ReturnType<typeof exportBibliography>,
  code: string, field?: string) => result.warnings.some((item) => item.code === code && (!field || item.fields.includes(field)));
const bib = (fields: string) => '@misc{source-key,' + fields + '}';
const ris = (...lines: string[]) => ['TY  - JOUR', ...lines, 'ER  -', ''].join('\n');

test('BibTeX grammar handles macros, nested braces, Unicode, escaped accents and protected institutions', () => {
  const result = parseBibliography([
    '@string{prefix = "Journal of "}',
    '@article{a-private-source-key,',
    ' title = {Étude {城乡 {共生}} and G{\\\"o}del},',
    ' author = {Doe, Jane and {World Health and Care Organization}},',
    ' journal = prefix # {Tourism}, year = 2026,',
    ' doi = {https://doi.org/10.1234/ABC\\_DEF},',
    ' abstract = {First line',
    'Second line},',
    ' keywords = {{machine, learning}, 中文},',
    ' volume = {12}, number = {3}, pages = {1--9},',
    ' file = {C:\\private\\secret.pdf}, url = {https://example.invalid/private}, customfield = {secret}',
    '}',
  ].join('\n'), 'bibtex');
  assert.deepEqual(result.archive.papers, [{ ref: 'p1', data: {
    title: 'Étude 城乡 共生 and Gödel', doi: '10.1234/abc_def', year: '2026', publication: 'Journal of Tourism',
    abstractText: 'First line\nSecond line', authors: ['Doe, Jane', 'World Health and Care Organization'],
    keywords: ['machine, learning', '中文'],
  } }]);
  assert.deepEqual(result.archive.notes, []);
  assert.ok(warning(result, 'TYPE_NOT_PRESERVED'));
  assert.ok(warning(result, 'AUTHOR_STRUCTURE_FLATTENED'));
  for (const field of ['volume', 'number', 'pages', 'file', 'url', 'customfield', 'citation-key']) {
    assert.ok(warning(result, 'UNSUPPORTED_FIELDS', field));
  }
  assert.ok(!JSON.stringify(result).includes('a-private-source-key'));
  assert.ok(!JSON.stringify(result).includes('secret.pdf'));
});

test('unknown TeX is literal and explicit while known formatting becomes plain text', () => {
  const result = parseBibliography(bib('title={A \\unknown{literal}},abstract={A \\textbf{bold} word}'), 'bibtex');
  assert.equal(result.archive.papers[0].data.title, 'A \\unknown{literal}');
  assert.equal(result.archive.papers[0].data.abstractText, 'A bold word');
  assert.ok(warning(result, 'LATEX_PRESERVED', 'title'));
  assert.ok(warning(result, 'LATEX_NORMALIZED', 'abstract'));
  assert.ok(!result.archive.papers[0].data.abstractText?.includes('<b>'));
  const environment = '\\begin{unknown_environment}literal\\end{unknown_environment}';
  const preserved = parseBibliography(bib('title={' + environment + '}'), 'bibtex');
  assert.equal(preserved.archive.papers[0].data.title, environment);
  assert.ok(warning(preserved, 'LATEX_PRESERVED', 'title'));
});

test('BibTeX defaults and string definitions are isolated between imports', () => {
  parseBibliography('@string{jan={overridden}}\n@misc{x,title=jan}', 'bibtex');
  assert.equal(parseBibliography(bib('title=jan'), 'bibtex').archive.papers[0].data.title, '01');
  rejects('INVALID_BIBTEX', () => parseBibliography(bib('title=not_defined'), 'bibtex'));
});

test('BibTeX comments cannot introduce phantom records or mutate macros', () => {
  const result = parseBibliography([
    '@comment{outside',
    ' @misc{phantom,title={Not a paper}}',
    ' @string{jan={not a real definition}}',
    '}',
    '@preamble{"literal preamble"}',
    '@misc{actual,title=jan}',
  ].join('\n'), 'bibtex');
  assert.equal(result.archive.papers.length, 1);
  assert.equal(result.archive.papers[0].data.title, '01');
  assert.ok(warning(result, 'UNSUPPORTED_FIELDS', 'preamble'));
});

test('whole BibTeX batch rejects malformed endings, duplicate fields, garbage and mismatched delimiters', () => {
  const invalid = [
    '@misc{x,title={A}',
    '@misc{x,title={A})',
    '@misc(x,title={A}}',
    '@misc{x,title={A}, title={B}}',
    '@misc{x,title="Unclosed}',
    '@misc{x,title={A}} trailing garbage',
    '@misc{x,title={A}} @misc{second,title={',
    '@misc{x,title={A},__proto__={poison}}',
    '@string{constructor={poison}}\n@misc{x,title={A}}',
    '@misc{x,title={A},year=02026}',
    '@misc{x,title={A},year=999999999999999999999}',
  ];
  for (const value of invalid) rejects('INVALID_BIBTEX', () => parseBibliography(value, 'bibtex'));
});

test('missing/blank title and oversized mapped fields reject all entries before preview', () => {
  for (const value of [bib('author={An Author}'), bib('title={   }'), bib('title={' + 'x'.repeat(2049) + '}'),
    bib('title={A},author={' + 'a'.repeat(513) + '}'),
    bib('title={A},abstract={' + 'x'.repeat(65537) + '}')]) {
    rejects('INVALID_RECORD', () => parseBibliography(value, 'bibtex'), 1);
  }
  rejects('INVALID_RECORD', () => parseBibliography(bib('title={good}') + '\n' + bib('doi={10.1234/a}'), 'bibtex'), 2);
  rejects('INVALID_RECORD', () => parseBibliography(ris('TI  - ' + 'x'.repeat(2049)), 'ris'), 1);
});

test('RIS accepts CRLF/BOM, continuation lines, repeated author/keyword fields and exact record boundaries', () => {
  const source = '\ufeff' + [
    'TY  - JOUR', 'TI  - 城乡共生', 'AU  - Doe, Jane', 'AU  - World Health and Care Organization',
    'PY  - 2025/02/03/', 'JO  - Tourism Journal', 'DO  - doi:10.1234/ABC',
    'AB  - First paragraph', '      Indented continuation', 'Unindented continuation',
    '', '      Next paragraph', 'KW  - machine, learning', 'KW  - 中文',
    'VL  - 8', 'IS  - 2', 'SP  - 11', 'EP  - 25', 'L1  - C:\\private.pdf', 'ER  -',
    '', 'TY  - BOOK', 'T1  - 第二条', 'ER  -', '',
  ].join('\r\n');
  const result = parseBibliography(source, 'ris');
  assert.deepEqual(result.archive.papers.map((entry) => entry.ref), ['p1', 'p2']);
  assert.deepEqual(result.archive.papers[0].data, {
    title: '城乡共生', doi: '10.1234/abc', year: '2025', publication: 'Tourism Journal',
    abstractText: 'First paragraph\nIndented continuation\nUnindented continuation\n\nNext paragraph',
    authors: ['Doe, Jane', 'World Health and Care Organization'], keywords: ['machine, learning', '中文'],
  });
  assert.ok(warning(result, 'DATE_PARTS_DROPPED'));
  for (const field of ['VL', 'IS', 'SP', 'EP', 'L1']) assert.ok(warning(result, 'UNSUPPORTED_FIELDS', field));
  assert.ok(!JSON.stringify(result).includes('private.pdf'));
});

test('RIS rejects orphan/nested/incomplete records and malformed tags instead of partially importing', () => {
  const invalid = [
    'TI  - no TY\nER  -',
    'ER  -',
    'TY  - JOUR\nTI  - no ER',
    'TY  - JOUR\nTI  - a\nTY  - BOOK\nTI  - b\nER  -',
    'TY  - JOUR\nTI  - a\nER  - extra',
    'TY  - JOUR\nTI  - a\nER  -\ntrailing junk',
    'TY  - JOUR\nTI  - a\nDO-broken\nER  -',
    'TY  - JOUR\norphan continuation\nTI  - A\nER  -',
  ];
  for (const value of invalid) rejects('INVALID_RIS', () => parseBibliography(value, 'ris'));
  rejects('INVALID_RECORD', () => parseBibliography(ris('TI  - A', 'TI  - B'), 'ris'), 1);
  rejects('INVALID_RECORD', () => parseBibliography(ris('AU  - Missing title'), 'ris'), 1);
});

test('RIS year and full-date aliases agree while discarded month/day parts are explicit', () => {
  const result = parseBibliography(ris('TI  - A', 'PY  - 2026', 'DA  - 2026/02/03/', 'Y1  - 2026/02/03'), 'ris');
  assert.equal(result.archive.papers[0].data.year, '2026');
  assert.ok(warning(result, 'DATE_PARTS_DROPPED', 'DA'));
  assert.ok(warning(result, 'DATE_PARTS_DROPPED', 'Y1'));
  rejects('INVALID_RECORD', () => parseBibliography(ris('TI  - A', 'PY  - 2026', 'Y1  - 2025/02/03'), 'ris'), 1);
});

test('normalization feeds existing DOI duplicate detection without retaining external IDs', () => {
  const result = parseBibliography([
    '@misc{external-one,title={One},doi={HTTP://DX.DOI.ORG/10.1234/ABC}}',
    '@misc{external-two,title={Two},doi={doi:10.1234/abc}}',
  ].join('\n'), 'bibtex');
  const plan = planLibraryImport(result.archive, [visible(paper({ doi: 'https://doi.org/10.1234/ABC' }))]);
  assert.ok(plan.rows.every((row) => row.duplicate?.reason === 'doi'));
  assert.ok(plan.rows.every((row) => !row.defaultSelected));
  assert.ok(!JSON.stringify(result.archive).includes('external-'));
  for (const value of ['https://evil.invalid/10.1234/a', 'https://doi.org:443/10.1234/a',
    'https://doi.org/10.1234/a?x=1', 'not-a-doi']) {
    rejects('INVALID_RECORD', () => parseBibliography(ris('TI  - A', 'DO  - ' + value), 'ris'), 1);
  }
});

test('500-paper and four-MiB byte limits, expansion and nesting are bounded', () => {
  const tooManyBib = Array.from({ length: 501 }, (_, index) => '@misc{p' + index + ',title={A}}').join('\n');
  rejects('TOO_MANY_RECORDS', () => parseBibliography(tooManyBib, 'bibtex'));
  rejects('TOO_MANY_RECORDS', () => parseBibliography(Array(501).fill(ris('TI  - A')).join('\n'), 'ris'));
  rejects('ARCHIVE_TOO_LARGE', () => parseBibliography('汉'.repeat(Math.ceil(LIBRARY_TRANSFER_LIMITS.maxBytes / 3)), 'ris'));
  rejects('INVALID_BIBTEX', () => parseBibliography(bib('title={' + '{'.repeat(65) + 'A' + '}'.repeat(65) + '}'), 'bibtex'));
  const macros = ['@string{s0={0123456789}}'];
  for (let index = 1; index < 24; index++) macros.push('@string{s' + index + '=s' + (index - 1) + '#s' + (index - 1) + '}');
  macros.push('@misc{x,title=s23}');
  rejects('INVALID_BIBTEX', () => parseBibliography(macros.join('\n'), 'bibtex'));
  assert.equal(parseBibliography(Array.from({ length: 500 }, (_, index) =>
    '@misc{p' + index + ',title={A}}').join('\n'), 'bibtex').archive.papers.length, 500);
});

test('long valid author whitespace is processed within a bounded time rather than rescanned quadratically', async () => {
  const worker = new Worker([
    'const { parentPort, workerData } = require("node:worker_threads");',
    'import("tsx/esm/api").then(async ({ tsImport }) => {',
    '  const { parseBibliography } = await tsImport(workerData.moduleUrl, workerData.parentUrl);',
    '  const gap = " ".repeat(1024 * 1024);',
    '  const input = "@misc{x,title={Study},author={" + gap + "Smith and" + gap + "{World and Care}}}";',
    '  const result = parseBibliography(input, "bibtex");',
    '  parentPort.postMessage(result.archive.papers[0].data.authors);',
    '}).catch(error => { throw error; });',
  ].join('\n'), { eval: true, workerData: {
    moduleUrl: new URL('../src/library/bibliographyTransfer.ts', import.meta.url).href, parentUrl: import.meta.url,
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const authors = await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Valid bounded input exceeded the parsing deadline')), 8000);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => { if (code !== 0) reject(new Error('Parser worker exited unsuccessfully')); });
    });
    assert.deepEqual(authors, ['Smith', 'World and Care']);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});

test('empty/unknown format/control characters fail safely, while ordinary Unicode and bidi remain text', () => {
  rejects('EMPTY_BIBLIOGRAPHY', () => parseBibliography('  \n', 'ris'));
  rejects('EMPTY_BIBLIOGRAPHY', () => parseBibliography('% comment only\n', 'bibtex'));
  rejects('UNSUPPORTED_FORMAT', () => parseBibliography('', 'json' as 'ris'));
  rejects('INVALID_RECORD', () => parseBibliography(ris('TI  - null\u0000byte'), 'ris'));
  rejects('INVALID_RECORD', () => parseBibliography(bib('title={bad\ud800}'), 'bibtex'));
  assert.equal(parseBibliography(ris('TI  - עברית \u202e نص 😀'), 'ris').archive.papers[0].data.title, 'עברית \u202e نص 😀');
});

test('BibTeX export is parsed independently by Citation.js and protects literal authors and every TeX escape', () => {
  const data = paper({
    title: 'Literal },@article{injected,title={oops} \\ % $ # & _ ^ ~ { } " 😀',
    authors: ['An and Other Organization', 'Doe, Jane', '机构 {中文} \\ and % _ ^ ~'],
    keywords: ['comma, inside', 'and inside', 'brace{and}'], abstractText: 'Abstract \\ { } & é',
  });
  const result = exportBibliography([visible(data)], 'bibtex');
  assert.equal(result.summary.papers, 1);
  const parsed = plugins.input.data(result.text, '@bibtex/text');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'misc');
  assert.equal(parsed[0].label, 'p1');
  const independent = plugins.input.data(parsed, '@biblatex/entries+list') as unknown as {
    title: string; author: { family: string; given?: string }[]; abstract: string;
  }[];
  assert.equal(independent.length, 1);
  assert.equal(independent[0].title, data.title);
  assert.deepEqual(independent[0].author.map((author) => author.family), data.authors);
  assert.ok(independent[0].author.every((author) => !author.given));
  assert.equal(independent[0].abstract, data.abstractText);
  assert.deepEqual(parseBibliography(result.text, 'bibtex').archive.papers[0].data, data);
});

test('RIS export prevents newline tag/entry injection and declares its whitespace loss', () => {
  const data = paper({
    title: 'A\nER  -\nTY  - JOUR\nTI  - injected',
    authors: ['World and Other\r\nER  -\rTY  - BOOK'],
    abstractText: 'One\u2028ER  -\u2029TY  - JOUR\tTail',
    keywords: ['topic\nDO  - 10.1234/injected'],
  });
  const result = exportBibliography([visible(data)], 'ris');
  assert.equal((result.text.match(/^TY  - /gm) ?? []).length, 1);
  assert.equal((result.text.match(/^ER  -/gm) ?? []).length, 1);
  assert.ok(result.text.startsWith('TY  - GEN\n'));
  const parsed = parseBibliography(result.text, 'ris');
  assert.equal(parsed.archive.papers.length, 1);
  assert.equal(parsed.archive.papers[0].data.title, 'A ER  - TY  - JOUR TI  - injected');
  assert.deepEqual(parsed.archive.papers[0].data.authors, ['World and Other ER  - TY  - BOOK']);
  assert.equal(parsed.archive.papers[0].data.abstractText, 'One ER  - TY  - JOUR Tail');
  for (const field of ['TI', 'AU', 'AB', 'KW']) assert.ok(warning(result, 'LINE_BREAKS_NORMALIZED', field));
});

test('both formats round-trip saved visible metadata in deterministic paper order', () => {
  const one = visible(paper({ doi: '10.1234/a', abstractText: 'Unicode 中文 é 😀', keywords: ['A', 'B'] }));
  const two = visible(paper({ title: 'Second', doi: null, year: null, publication: null,
    abstractText: null, authors: [], keywords: [] }), { entityId: id(2), pending: true, status: 'queued' });
  Object.freeze(one.data); Object.freeze(one); Object.freeze(two.data); Object.freeze(two);
  for (const format of ['bibtex', 'ris'] as const) {
    const result = exportBibliography([two, one], format);
    assert.equal(result.text, exportBibliography([one, two], format).text);
    assert.deepEqual(parseBibliography(result.text, format).archive.papers.map((entry) => entry.data), [one.data, two.data]);
    assert.ok(!result.text.includes(one.entityId));
    assert.ok(!result.text.includes(two.entityId));
  }
});

test('empty abstract stays distinct from an absent abstract, and whitespace normalization is visible', () => {
  for (const format of ['bibtex', 'ris'] as const) {
    const data = paper({ abstractText: '' });
    const result = exportBibliography([visible(data)], format);
    assert.equal(parseBibliography(result.text, format).archive.papers[0].data.abstractText, '');
    const padded = exportBibliography([visible(paper({ title: ' A ', authors: [' Literal Name '],
      abstractText: '  padded  ' }))], format);
    assert.ok(warning(padded, 'LINE_BREAKS_NORMALIZED'));
    assert.equal(parseBibliography(padded.text, format).archive.papers[0].data.title, 'A');
  }
  const text = exportBibliography([visible(paper({ year: '2020-2021' }))], 'bibtex').text;
  assert.equal(parseBibliography(text, 'bibtex').archive.papers[0].data.year, '2020-2021');
});

test('paper-only exports ignore arbitrarily large notes while reporting omissions, conflicts and library state', () => {
  const organization = { favorite: true, readingStatus: 'reading' as const, tags: ['private-tag'],
    collections: ['private-collection'], queueRank: 7 };
  const notes = Array.from({ length: 600 }, (_, index): VisibleEntity => ({
    ...visible(), entityId: id(index + 10), entityType: 'note',
    data: { paperId: id(1), title: 'Private note', body: 'private '.repeat(1000), format: 'markdown' },
  }));
  const source = [
    ...notes, visible(paper({ organization }), { status: 'conflict', pending: true }),
    visible(paper(), { entityId: id(3), deleted: true }),
    visible({ accountId: 'secret', filePath: 'C:\\private.pdf' } as unknown as PaperData,
      { entityId: id(4), entityType: 'attachmentVersion' }),
  ];
  for (const format of ['bibtex', 'ris'] as const) {
    const result = exportBibliography(source, format);
    assert.deepEqual(result.summary, { papers: 1, omittedNotes: 600, omittedDeleted: 1, omittedUnsupported: 1,
      conflicted: 1, scope: 'visible-saved-paper-metadata' });
    for (const secret of ['private-tag', 'private-collection', 'Private note', 'private.pdf', 'accountId', 'secret']) {
      assert.ok(!result.text.includes(secret));
    }
    assert.ok(warning(result, 'NOTES_OMITTED'));
    assert.ok(warning(result, 'LIBRARY_STATE_OMITTED', 'organization'));
  }
});

test('export rejects malformed active papers, controls and oversized final text without executing accessors', () => {
  let calls = 0;
  const accessor = { ...visible(), get data(): EntityData { calls++; throw new Error('must not execute'); } };
  rejects('INVALID_EXISTING_DATA', () => exportBibliography([accessor], 'ris'));
  assert.equal(calls, 0);
  rejects('INVALID_EXISTING_DATA', () => exportBibliography([visible({ ...paper(), title: '' })], 'ris'));
  rejects('INVALID_RECORD', () => exportBibliography([visible(paper({ title: 'A\u0000B' }))], 'bibtex'), 1);
  const many = Array.from({ length: 500 }, (_, index) => visible(paper({ title: 'A'.repeat(2048),
    abstractText: '{'.repeat(7000), doi: null }), { entityId: id(index + 1) }));
  rejects('ARCHIVE_TOO_LARGE', () => exportBibliography(many, 'bibtex'));
});

test('empty export is a normal disabled state; saved pending paper changes remain exportable', () => {
  for (const format of ['bibtex', 'ris'] as const) {
    assert.equal(exportBibliography([], format).text, '');
    assert.equal(exportBibliography([], format).summary.papers, 0);
    assert.equal(exportBibliography([visible(paper(), { revision: 0, pending: true, status: 'queued' })], format).summary.papers, 1);
  }
});

test('format parsing never resolves a supplied URL or evaluates a supplied TeX command', () => {
  const previous = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => { fetches++; throw new Error('network disabled'); }) as typeof fetch;
  try {
    rejects('INVALID_BIBTEX', () => parseBibliography('https://example.invalid/metadata.bib', 'bibtex'));
    const result = parseBibliography(bib('title={\\input{https://example.invalid/secret}},url={https://example.invalid}'), 'bibtex');
    assert.ok(warning(result, 'LATEX_PRESERVED'));
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = previous; }
});
