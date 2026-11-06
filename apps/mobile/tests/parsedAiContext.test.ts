import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PARSED_LIMITS, verifyParsedDocument, type ParsedDocumentPackage } from '../../../packages/sync-core/src/parsedDocument.ts';
import { AiError } from '../src/ai/errors.ts';
import { AI_LIMITS } from '../src/ai/types.ts';
import { PdfError } from '../src/pdf/errors.ts';
import type { PdfVersion } from '../src/pdf/types.ts';
import { createParsedAiContext } from '../src/parsed/aiContext.ts';
import { resolveParsedBlocks } from '../src/parsed/resolve.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function document(): ParsedDocumentPackage {
  return { format: 'paperquay-parsed-document', version: 1, paperId: id(1), attachmentVersionId: id(2),
    pdf: { sha256: 'a'.repeat(64), sizeBytes: 2048, pageCount: 5 }, parser: { name: 'mineru', model: 'vlm-test' },
    blocks: [
      { id: 'heading', pageIndex: 0, kind: 'heading', text: '方法', markdown: '**方法**' },
      { id: 'text', pageIndex: 0, kind: 'text', text: '数学', markdown: '设 $\\{x\\} \\cdot y$；[证据](https://private.invalid/link?token=LINK_SECRET)和![图注](images/PRIVATE_IMAGE.png)。' },
      { id: 'equation', pageIndex: 1, kind: 'equation', text: 'formula', latex: '\\frac{a}{b} + x^2' },
      { id: 'table', pageIndex: 2, kind: 'table', text: '表格补充 OCR', caption: '独立表注 $T_1$', footnote: '表脚 $n=1$', table: {
        caption: '结果 $x^2$', rows: [
          { section: 'head', cells: [{ text: '[指标](https://private.invalid/table?token=CELL_SECRET)', header: true, rowSpan: 1, colSpan: 2 }] },
          { section: 'body', cells: [{ text: '$x$', header: false, rowSpan: 2, colSpan: 1 }, { text: '42', header: false, rowSpan: 1, colSpan: 1 }] },
          { section: 'body', cells: [{ text: '43', header: false, rowSpan: 1, colSpan: 1 }] },
          { section: 'foot', cells: [{ text: '统计脚注', header: false, rowSpan: 1, colSpan: 2 }] },
        ],
      } },
      { id: 'table-next', pageIndex: 3, kind: 'table', text: '', sourceBlockId: 'table' },
      { id: 'table-chain', pageIndex: 3, kind: 'table', text: '', sourceBlockId: 'table-next' },
    ], assets: [] };
}
function version(input = document()): PdfVersion {
  return { entityId: input.attachmentVersionId, data: { paperId: input.paperId, attachmentId: id(3),
    sha256: input.pdf.sha256, sizeBytes: input.pdf.sizeBytes, pageCount: input.pdf.pageCount, fileName: 'synthetic.pdf', mediaType: 'application/pdf' } };
}
const failure = (code: string) => (error: unknown) => error instanceof AiError && error.code === code;
const mismatch = (error: unknown) => error instanceof PdfError && error.code === 'VERSION_MISMATCH';
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test('page and document scopes preserve actual pages and verified parser provenance without claiming full text', async () => {
  const verified = await verifyParsedDocument(document()), target = version();
  const all = await createParsedAiContext(verified, target, 5, { scope: 'document' });
  assert.deepEqual(all.pages.map((page) => page.pageIndex), [0, 1, 2, 3]);
  assert.equal(all.totalPages, 5); assert.equal(all.complete, false); assert.equal(all.scope, 'document');
  assert.equal(all.label, 'synthetic.pdf · 解析文本');
  assert.deepEqual(all.textSource, { kind: 'parsed-document', packageDigest: verified.digest, parserName: 'mineru', parserModel: 'vlm-test' });
  assert.ok(all.pages.every((page) => !Object.hasOwn(page, 'anchor')));
  const page = await createParsedAiContext(verified, target, 5, { scope: 'page', pageIndex: 1 });
  assert.equal(page.complete, false); assert.equal(page.scope, 'page');
  assert.deepEqual(page.pages, [{ pageIndex: 1, text: '$$\n\\frac{a}{b} + x^2\n$$' }]);
  const everyPage = document(); everyPage.blocks.push({ id: 'last', pageIndex: 4, kind: 'text', text: '所有页都有字仍不代表解析完整' });
  assert.equal((await createParsedAiContext(await verifyParsedDocument(everyPage), target, 5, { scope: 'document' })).complete, false);
});

test('table sections, headers, spans, captions, footnotes and OCR prose survive on source and continuation pages', async () => {
  const input = document(), verified = await verifyParsedDocument(input);
  for (const index of [2, 3]) {
    const context = await createParsedAiContext(verified, version(input), 5, { scope: 'page', pageIndex: index });
    assert.deepEqual(context.pages.map((page) => page.pageIndex), [index]);
    const text = context.pages[0].text;
    for (const term of ['[head]', '[body]', '[foot]', 'header=true', 'header=false', 'rowSpan=2', 'colSpan=2', '结果 $x^2$', '独立表注 $T_1$', '表脚 $n=1$', '42', '43', '统计脚注', '表格补充 OCR'])
      assert.ok(text.includes(term), term);
    assert.ok(!text.includes('CELL_SECRET'));
  }
});

test('Markdown AST removes link/image destinations while preserving labels, references, escaped math and visible code', async () => {
  const input = document();
  input.blocks = [{ id: 'b', kind: 'text', pageIndex: 1, text: 'fallback', markdown:
    'A **visible** [source][ref] and ![figure][pic]. $\\{a\\} \\* b$\n\n'
    + '[ref]: https://private.invalid/REFERENCE_SECRET "TITLE_SECRET"\n[pic]: data:image/png;base64,BASE64_SECRET\n\n'
    + '`inline code`\n\n```txt\ncode value\n```\n\n<!-- HIDDEN_COMMENT -->\n\nVisible tail.' }];
  const context = await createParsedAiContext(await verifyParsedDocument(input), version(input), 5, { scope: 'document' });
  const text = context.pages[0].text;
  for (const visible of ['A visible source and figure.', '$\\{a\\} \\* b$', 'inline code', 'code value', 'Visible tail.']) assert.ok(text.includes(visible), visible);
  for (const secret of ['REFERENCE_SECRET', 'TITLE_SECRET', 'BASE64_SECRET', 'HIDDEN_COMMENT', 'private.invalid', 'data:image', '[ref]', '[pic]']) assert.ok(!text.includes(secret), secret);
  const simple = await createParsedAiContext(await verifyParsedDocument(document()), version(), 5, { scope: 'page', pageIndex: 0 });
  assert.match(simple.pages[0].text, /证据.*图注/);
  assert.doesNotMatch(simple.pages[0].text, /LINK_SECRET|PRIVATE_IMAGE|images\/|https:/);
});

test('raw HTML with visible data is explicitly rejected rather than silently flattened or omitted', async () => {
  for (const markdown of ['<table><tr><td>42</td></tr></table>', '<span>visible</span>', 'before <img src="https://private.invalid/image" alt="visual"> after', '<!-- comment -->visible HTML block']) {
    const input = document(); input.blocks = [{ id: 'b', pageIndex: 0, kind: 'text', text: 'fallback', markdown }];
    await assert.rejects(createParsedAiContext(await verifyParsedDocument(input), version(input), 5, { scope: 'document' }), failure('CONTEXT_INVALID'));
  }
  for (const latex of ['\\href{https://private.invalid/secret}{text}', '\\url{file:///private}', '\\includegraphics{private.png}']) {
    const input = document(); input.blocks = [{ id: 'b', pageIndex: 0, kind: 'equation', text: '', latex }];
    await assert.rejects(createParsedAiContext(await verifyParsedDocument(input), version(input), 5, { scope: 'document' }), failure('CONTEXT_INVALID'));
  }
});

test('every target identity dimension is compared, including known and unknown page metadata', async () => {
  const verified = await verifyParsedDocument(document());
  for (const change of [
    (v: PdfVersion) => { v.entityId = id(20); },
    (v: PdfVersion) => { v.data.paperId = id(20); },
    (v: PdfVersion) => { v.data.sha256 = 'b'.repeat(64); },
    (v: PdfVersion) => { v.data.sizeBytes++; },
    (v: PdfVersion) => { v.data.pageCount = 4; },
    (v: PdfVersion) => { v.data.mediaType = 'text/plain' as 'application/pdf'; },
  ]) { const target = version(); change(target); await assert.rejects(createParsedAiContext(verified, target, 5, { scope: 'document' }), mismatch); }
  await assert.rejects(createParsedAiContext(verified, version(), 4, { scope: 'document' }), mismatch);
  const unknown = version(); unknown.data.pageCount = null;
  assert.equal((await createParsedAiContext(verified, unknown, 5, { scope: 'document' })).totalPages, 5);
  await assert.rejects(createParsedAiContext(verified, unknown, 4, { scope: 'document' }), mismatch);
  for (const pageIndex of [-1, 5, 0.1, NaN]) await assert.rejects(createParsedAiContext(verified, version(), 5, { scope: 'page', pageIndex }), failure('CONTEXT_INVALID'));
});

test('each context rebuild re-verifies content and assets instead of trusting a previously verified digest', async () => {
  const valid = await verifyParsedDocument(document());
  const tampered = structuredClone(valid); tampered.document.blocks[0].text = 'Changed content';
  await assert.rejects(createParsedAiContext(tampered, version(), 5, { scope: 'document' }), failure('CONTEXT_INVALID'));
  await assert.rejects(createParsedAiContext({ ...valid, digest: 'f'.repeat(64) }, version(), 5, { scope: 'document' }), failure('CONTEXT_INVALID'));
  const image = document(), bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR3sAAAAASUVORK5CYII=', 'base64');
  image.assets = [{ id: 'PIXEL_ASSET', mediaType: 'image/png', width: 1, height: 1, base64: bytes.toString('base64'), sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
  image.blocks.push({ id: 'img', pageIndex: 4, kind: 'image', text: 'Image OCR', assetId: 'PIXEL_ASSET', caption: 'Image caption $x$', footnote: 'Image footnote' });
  const verified = await verifyParsedDocument(image);
  const context = await createParsedAiContext(verified, version(image), 5, { scope: 'page', pageIndex: 4 });
  const serialized = JSON.stringify(context);
  for (const text of ['Image OCR', 'Image caption $x$', 'Image footnote']) assert.ok(serialized.includes(text), text);
  for (const forbidden of ['PIXEL_ASSET', image.assets[0].base64, 'base64', 'assetId', 'bbox', 'anchor', 'data:image']) assert.ok(!serialized.includes(forbidden), forbidden);
  const corrupt = structuredClone(verified); corrupt.document.assets[0].sha256 = 'f'.repeat(64);
  await assert.rejects(createParsedAiContext(corrupt, version(image), 5, { scope: 'page', pageIndex: 0 }), failure('CONTEXT_INVALID'));
});

test('blank pages and pixel-only pages provide no fake text and partial documents include only actual text pages', async () => {
  const input = document();
  input.blocks = [{ id: 'empty', pageIndex: 0, kind: 'text', text: ' \n ' }, { id: 'text', pageIndex: 3, kind: 'text', text: 'Only actual text page' }];
  const valid = await verifyParsedDocument(input);
  assert.deepEqual((await createParsedAiContext(valid, version(input), 5, { scope: 'document' })).pages.map((page) => page.pageIndex), [3]);
  for (const pageIndex of [0, 1, 2, 4]) await assert.rejects(createParsedAiContext(valid, version(input), 5, { scope: 'page', pageIndex }), failure('TEXT_MISSING'));
  const pixels = document(), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR3sAAAAASUVORK5CYII=', 'base64');
  pixels.assets = [{ id: 'a', mediaType: 'image/png', width: 1, height: 1, base64: png.toString('base64'), sizeBytes: png.length, sha256: createHash('sha256').update(png).digest('hex') }];
  pixels.blocks = [{ id: 'b', pageIndex: 1, kind: 'image', text: '', assetId: 'a' }];
  await assert.rejects(createParsedAiContext(await verifyParsedDocument(pixels), version(pixels), 5, { scope: 'document' }), failure('TEXT_MISSING'));
});

test('the complete selected scope is rejected at its UTF-8 budget without clipping or counting hidden destinations', async () => {
  const input = document(); input.blocks = [
    { id: 'a', kind: 'text', pageIndex: 0, text: 'x'.repeat(100_000) },
    { id: 'b', kind: 'text', pageIndex: 1, text: 'y'.repeat(100_000) },
  ];
  const valid = await verifyParsedDocument(input);
  assert.equal((await createParsedAiContext(valid, version(input), 5, { scope: 'page', pageIndex: 0 })).pages[0].text.length, 100_000);
  await assert.rejects(createParsedAiContext(valid, version(input), 5, { scope: 'document' }), failure('CONTEXT_TOO_LARGE'));
  const utf8 = document(); utf8.blocks = [{ id: 'a', kind: 'text', pageIndex: 0, text: '文'.repeat(Math.floor(AI_LIMITS.contextBytes / 3) + 1) }];
  await assert.rejects(createParsedAiContext(await verifyParsedDocument(utf8), version(utf8), 5, { scope: 'document' }), failure('CONTEXT_TOO_LARGE'));
  const boundary = document(); boundary.blocks = [
    { id: 'a', kind: 'text', pageIndex: 0, text: 'x'.repeat(100_000) },
    { id: 'b', kind: 'text', pageIndex: 1, text: 'y'.repeat(AI_LIMITS.contextBytes - 100_000) },
  ];
  assert.equal((await createParsedAiContext(await verifyParsedDocument(boundary), version(boundary), 5, { scope: 'document' })).pages.reduce((count, page) => count + page.text.length, 0), AI_LIMITS.contextBytes);
});

test('construction does not mutate caller data or perform external requests', async (t) => {
  const input = deepFreeze(await verifyParsedDocument(document())), target = deepFreeze(version()), selection = deepFreeze({ scope: 'document' as const });
  const before = JSON.stringify({ input, target, selection }); let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must not fetch'); });
  const context = await createParsedAiContext(input, target, 5, selection);
  assert.equal(requests, 0); assert.equal(JSON.stringify({ input, target, selection }), before);
  context.pages[0].text = 'Caller changed result';
  assert.equal(JSON.stringify({ input, target, selection }), before);
});

test('target and selection identity are captured before asynchronous verification', async (t) => {
  const valid = await verifyParsedDocument(document()), target = version(), selection = { scope: 'page' as const, pageIndex: 0 };
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<SubtleCrypto['digest']>) => { await gate; return original(...args); });
  const pending = createParsedAiContext(valid, target, 5, selection);
  target.data.paperId = id(20); selection.pageIndex = 4; valid.digest = 'f'.repeat(64);
  release(); const context = await pending;
  assert.equal(context.paperId, id(1)); assert.deepEqual(context.pages.map((page) => page.pageIndex), [0]);
});

test('continuation resolution is bounded and shares large content without concatenation or page drift', async () => {
  const input = document();
  input.blocks = [{ id: 'b0', kind: 'text', pageIndex: 0, text: 'Original' }];
  for (let index = 1; index < PARSED_LIMITS.maxBlocks; index++) input.blocks.push({ id: `b${index}`, kind: 'text', pageIndex: index % 5, text: '', sourceBlockId: `b${index - 1}` });
  input.blocks.reverse();
  const before = JSON.stringify(input), resolved = resolveParsedBlocks(input);
  assert.equal(resolved.length, PARSED_LIMITS.maxBlocks); assert.equal(resolved[0].text, 'Original');
  assert.equal(resolved[0].id, `b${PARSED_LIMITS.maxBlocks - 1}`); assert.equal(resolved[0].pageIndex, (PARSED_LIMITS.maxBlocks - 1) % 5);
  assert.equal(JSON.stringify(input), before);
  const table = document().blocks[3];
  const continuation = { ...table, id: 'next', pageIndex: 4, text: '', table: undefined, sourceBlockId: table.id };
  const result = resolveParsedBlocks({ ...document(), blocks: [table, continuation] });
  assert.equal(result[1].table, table.table); assert.notEqual(result[0], table);
  const cycle = document(); cycle.blocks[4].sourceBlockId = cycle.blocks[5].id;
  assert.throws(() => resolveParsedBlocks(cycle));
});

test('a maximal empty-table continuation chain is not expanded repeatedly or turned into fake text', async () => {
  const input = document();
  input.blocks = [{ id: 'b0', pageIndex: 0, kind: 'table', text: '', table: { caption: '', rows: Array.from({ length: 100 }, () => ({
    section: 'body', cells: Array.from({ length: 100 }, () => ({ text: '', header: false, rowSpan: 1, colSpan: 1 })),
  })) } }];
  for (let index = 1; index < PARSED_LIMITS.maxBlocks; index++) input.blocks.push({ id: `b${index}`, pageIndex: 0, kind: 'table', text: '', sourceBlockId: `b${index - 1}` });
  input.blocks.reverse();
  await assert.rejects(createParsedAiContext(await verifyParsedDocument(input), version(input), 5, { scope: 'document' }), failure('TEXT_MISSING'));
});

test('hidden destinations are excluded from the send budget and inherited visible content is fully counted', async () => {
  const input = document();
  input.blocks = [{ id: 'resource', pageIndex: 0, kind: 'text', text: '', markdown: Array.from({ length: 400 }, (_, index) =>
    `[label](https://private.invalid/${index}/` + 'SECRET'.repeat(30) + ')').join(' ') }];
  const small = await createParsedAiContext(await verifyParsedDocument(input), version(input), 5, { scope: 'document' });
  assert.ok(small.pages[0].text.length < 3000); assert.doesNotMatch(small.pages[0].text, /SECRET|https:/);
  input.blocks = [{ id: 'b0', pageIndex: 0, kind: 'text', text: 'x'.repeat(100_000) },
    { id: 'b1', pageIndex: 0, kind: 'text', text: '', sourceBlockId: 'b0' }];
  await assert.rejects(createParsedAiContext(await verifyParsedDocument(input), version(input), 5, { scope: 'document' }), failure('CONTEXT_TOO_LARGE'));
});
