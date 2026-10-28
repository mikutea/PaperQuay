import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  decodeParsedDocument, inspectParsedImage, PARSED_LIMITS, ParsedDocumentError,
  validateParsedDocument, verifyParsedDocument,
  type ParsedAsset, type ParsedDocumentPackage, type ParsedDocumentErrorCode,
} from '../packages/sync-core/src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const png = () => Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR3sAAAAASUVORK5CYII=', 'base64'));
function asset(bytes = png(), name = 'figure-1'): ParsedAsset {
  return { id: name, ...inspectParsedImage(bytes), base64: Buffer.from(bytes).toString('base64'), sha256: digest(bytes), sizeBytes: bytes.length };
}
function fixture(): ParsedDocumentPackage {
  return {
    format: 'paperquay-parsed-document', version: 1, paperId: id(1), attachmentVersionId: id(2),
    pdf: { sha256: 'a'.repeat(64), sizeBytes: 2048, pageCount: 3 }, parser: { name: 'mineru', model: 'vlm' },
    blocks: [
      { id: 'heading', pageIndex: 0, kind: 'heading', text: '研究方法', markdown: '研究方法' },
      { id: 'paragraph', pageIndex: 0, kind: 'text', text: 'a = 1', markdown: '令 $a=1$。' },
      { id: 'equation', pageIndex: 1, kind: 'equation', text: 'a^2+b^2=c^2', latex: 'a^2+b^2=c^2' },
      { id: 'table', pageIndex: 1, kind: 'table', text: '42', caption: '表 $T_1$', footnote: '注：$n=1$。', table: {
        caption: '表 $T_1$', rows: [
          { section: 'head', cells: [{ text: '结果', rowSpan: 1, colSpan: 2, header: true }] },
          { section: 'body', cells: [{ text: '值 $x$', rowSpan: 1, colSpan: 1, header: false }, { text: '42', rowSpan: 1, colSpan: 1, header: false }] },
          { section: 'foot', cells: [{ text: '注', rowSpan: 1, colSpan: 2, header: false }] },
        ],
      } },
      { id: 'figure', pageIndex: 2, kind: 'image', text: '', assetId: 'figure-1', caption: '图 $x$' },
      { id: 'continued', pageIndex: 2, kind: 'table', text: '', sourceBlockId: 'table' },
    ], assets: [asset()],
  };
}
function fails(value: unknown, code?: ParsedDocumentErrorCode) {
  assert.throws(() => validateParsedDocument(value), (error: unknown) => error instanceof ParsedDocumentError && (!code || error.code === code));
}
function rejection(code?: ParsedDocumentErrorCode) {
  return (error: unknown) => error instanceof ParsedDocumentError && (!code || error.code === code);
}

test('complete package verifies assets and a deterministic detached canonical document', async () => {
  const input = fixture(), before = JSON.stringify(input);
  const verified = await verifyParsedDocument(input);
  assert.deepEqual(verified.document, input);
  assert.equal(verified.digest, digest(JSON.stringify(verified.document)));
  assert.equal(JSON.stringify(input), before);
  input.blocks[3].table!.rows[0].cells[0].text = 'Caller edit';
  input.assets[0].width = 3;
  assert.equal(verified.document.blocks[3].table!.rows[0].cells[0].text, '结果');
  assert.equal(verified.document.assets[0].width, 1);
  const backwards = (value: unknown): unknown => Array.isArray(value) ? value.map(backwards)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, backwards(entry)])) : value;
  assert.equal((await verifyParsedDocument(backwards(fixture()))).digest, verified.digest);
  assert.deepEqual(await decodeParsedDocument(encode(fixture())), verified);
});

test('source continuations retain page identity and reject missing, cross-kind or cyclic sources', () => {
  const valid = fixture();
  assert.equal(validateParsedDocument(valid).blocks[5].sourceBlockId, 'table');
  for (const target of ['missing', 'figure', 'continued']) {
    const input = fixture(); input.blocks[5].sourceBlockId = target; fails(input);
  }
  const cycle = fixture(); cycle.blocks[3].sourceBlockId = 'continued'; fails(cycle);
  const chain = fixture(); chain.blocks.push({ id: 'continued-2', pageIndex: 2, kind: 'table', text: '', sourceBlockId: 'continued' });
  assert.equal(validateParsedDocument(chain).blocks.length, 7);
});

test('all object schemas are closed and IDs, versions and kind payloads are checked', () => {
  const mutations: ((value: ParsedDocumentPackage) => void)[] = [
    (value) => Object.assign(value, { sourcePath: 'C:/private/output.json' }),
    (value) => Object.assign(value.pdf, { url: 'https://private.test/file' }),
    (value) => Object.assign(value.parser, { apiToken: 'private' }),
    (value) => Object.assign(value.blocks[0], { html: '<script>bad()</script>' }),
    (value) => Object.assign(value.blocks[3].table!, { html: '<table>bad</table>' }),
    (value) => Object.assign(value.blocks[3].table!.rows[0], { style: 'background:url(https://private)' }),
    (value) => Object.assign(value.blocks[3].table!.rows[0].cells[0], { url: 'https://private' }),
    (value) => Object.assign(value.assets[0], { path: 'images/figure.png' }),
    (value) => { value.version = 2 as 1; },
    (value) => { value.paperId = 'local-paper'; },
    (value) => { value.attachmentVersionId = id(0xab).toUpperCase(); },
    (value) => { value.pdf.sha256 = 'A'.repeat(64); },
    (value) => { value.parser.model = ' '; },
    (value) => { value.blocks[0].id = '../private'; },
    (value) => { value.blocks[1].id = value.blocks[0].id; },
    (value) => { value.blocks[0].pageIndex = 3; },
    (value) => { value.blocks[0].latex = 'x'; },
    (value) => { value.blocks[0].assetId = 'figure-1'; },
    (value) => { delete value.blocks[2].latex; },
    (value) => { delete value.blocks[3].table; },
    (value) => { delete value.blocks[4].assetId; },
    (value) => { value.blocks[4].assetId = 'https://private.test/figure'; },
    (value) => { value.assets[0].id = 'unreferenced'; },
    (value) => { value.assets.push({ ...value.assets[0] }); },
    (value) => { value.blocks[0].text = '\ud800'; },
    (value) => { value.blocks[0].text = '\u0000'; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); fails(input); }
  assert.equal(validateParsedDocument(fixture()).blocks[1].markdown, '令 $a=1$。');
});

test('pure validation refuses accessors, non-JSON objects, cycles, sparse arrays and hidden fields', () => {
  let getterCalls = 0;
  const getter = fixture(); Object.defineProperty(getter, 'paperId', { enumerable: true, get() { getterCalls += 1; return id(1); } });
  fails(getter); assert.equal(getterCalls, 0);
  const cycle = fixture(); Object.assign(cycle, { cycle }); fails(cycle);
  const sparse = fixture(); delete sparse.blocks[1]; fails(sparse);
  const extra = fixture(); Object.assign(extra.blocks, { extra: 'private' }); fails(extra);
  const hidden = fixture(); Object.defineProperty(hidden, 'private', { value: 'private' }); fails(hidden);
  const symbol = fixture(); Object.assign(symbol, { [Symbol('private')]: 'private' }); fails(symbol);
  const date = fixture(); Object.assign(date, { private: new Date() }); fails(date);
  const inherited = Object.create(fixture()); fails(inherited);
  const invalid = fixture(); Object.assign(invalid, { private: undefined }); fails(invalid);
});

test('table spans cannot overlap, escape rows or sections, or exceed bounded occupied area', () => {
  const valid = fixture();
  valid.blocks[3].table = { caption: '', rows: [
    { section: 'body', cells: [{ text: 'A', rowSpan: 2, colSpan: 2, header: false }] },
    { section: 'body', cells: [] },
  ] };
  assert.equal(validateParsedDocument(valid).blocks[3].table!.rows.length, 2);
  for (const mutate of [
    (value: ParsedDocumentPackage) => { value.blocks[3].table!.rows[0].cells[0].rowSpan = 3; },
    (value: ParsedDocumentPackage) => { value.blocks[3].table!.rows[1].section = 'foot'; },
    (value: ParsedDocumentPackage) => { value.blocks[3].table!.rows[0].cells[0].rowSpan = 0; },
    (value: ParsedDocumentPackage) => { value.blocks[3].table!.rows[0].cells[0].colSpan = 0; },
  ]) { const input = structuredClone(valid); mutate(input); fails(input); }
  const overlap = fixture();
  overlap.blocks[3].table = { caption: '', rows: [
    { section: 'body', cells: [{ text: '', rowSpan: 1, colSpan: 1, header: false }, { text: '', rowSpan: 2, colSpan: 1, header: false }] },
    { section: 'body', cells: [{ text: '', rowSpan: 1, colSpan: 2, header: false }] },
  ] }; fails(overlap);
  const empty = fixture(); empty.blocks[3].table!.rows = []; fails(empty);
  const backwards = fixture(); backwards.blocks[3].table!.rows[2].section = 'head'; fails(backwards);
  const huge = fixture(); huge.blocks[3].table = { caption: '', rows: Array.from({ length: 101 }, () => ({ section: 'body', cells: [] })) };
  huge.blocks[3].table.rows[0].cells.push({ text: '', rowSpan: 101, colSpan: 100, header: false }); fails(huge, 'PACKAGE_LIMIT');
});

function jpeg(width = 2, height = 3): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x55, 0xff, 0xd9]);
}
function webp(lossless = false): Uint8Array {
  const payload = lossless ? [0x2f, 1, 0x80, 0, 0] : [0, 0, 0, 0x9d, 1, 0x2a, 2, 0, 3, 0];
  const bytes = new Uint8Array(20 + payload.length + payload.length % 2);
  bytes.set(Buffer.from('RIFF'), 0); new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(Buffer.from('WEBP'), 8); bytes.set(Buffer.from(lossless ? 'VP8L' : 'VP8 '), 12);
  new DataView(bytes.buffer).setUint32(16, payload.length, true); bytes.set(payload, 20);
  return bytes;
}
function extendedWebp(): Uint8Array {
  const ordinary = webp(), bytes = new Uint8Array(ordinary.length + 18);
  bytes.set(ordinary.subarray(0, 12)); bytes.set(Buffer.from('VP8X'), 12);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  bytes[24] = 1; bytes[27] = 2; bytes.set(ordinary.subarray(12), 30);
  return bytes;
}

test('image inspection identifies PNG, JPEG and VP8/VP8L/VP8X WebP from headers', () => {
  assert.deepEqual(inspectParsedImage(png()), { mediaType: 'image/png', width: 1, height: 1 });
  assert.deepEqual(inspectParsedImage(jpeg()), { mediaType: 'image/jpeg', width: 2, height: 3 });
  for (const bytes of [webp(), webp(true), extendedWebp()]) assert.deepEqual(inspectParsedImage(bytes), { mediaType: 'image/webp', width: 2, height: 3 });
  for (const bytes of [new Uint8Array(), Buffer.from('<svg/>'), Buffer.from('GIF89a'), png().subarray(0, 32), jpeg().subarray(0, 20), webp().subarray(0, 25)]) {
    assert.throws(() => inspectParsedImage(bytes), rejection('INVALID_ASSET'));
  }
  const animated = extendedWebp(); animated[20] = 2;
  assert.throws(() => inspectParsedImage(animated), rejection('INVALID_ASSET'));
  const wrongCanvas = extendedWebp(); wrongCanvas[24] = 2;
  assert.throws(() => inspectParsedImage(wrongCanvas), rejection('INVALID_ASSET'));
  const wrongRiff = webp(); wrongRiff[4] = 0;
  assert.throws(() => inspectParsedImage(wrongRiff), rejection('INVALID_ASSET'));
  assert.throws(() => inspectParsedImage(jpeg(8193, 1)), rejection('INVALID_ASSET'));
});

test('base64, declared type, dimensions, length and asset digest must agree', async () => {
  for (const mutate of [
    (value: ParsedAsset) => { value.base64 = `data:image/png;base64,${value.base64}`; },
    (value: ParsedAsset) => { value.base64 = value.base64.slice(0, -1); },
    (value: ParsedAsset) => { value.base64 = value.base64.replace('A', '-'); },
    (value: ParsedAsset) => { value.base64 = value.base64.slice(0, 10) + '\n' + value.base64.slice(10); },
    (value: ParsedAsset) => { value.base64 = value.base64.slice(0, -2) + 'J='; },
    (value: ParsedAsset) => { value.mediaType = 'image/jpeg'; },
    (value: ParsedAsset) => { value.width = 2; },
    (value: ParsedAsset) => { value.sizeBytes += 1; },
    (value: ParsedAsset) => { value.sha256 = 'ABC'; },
  ]) { const input = fixture(); mutate(input.assets[0]); fails(input); }
  const corrupt = fixture(); corrupt.assets[0].sha256 = 'f'.repeat(64);
  assert.equal(validateParsedDocument(corrupt).assets[0].sha256, 'f'.repeat(64));
  await assert.rejects(verifyParsedDocument(corrupt), rejection('ASSET_INTEGRITY'));
  const mutation = fixture(); const checking = verifyParsedDocument(mutation);
  mutation.assets[0].sha256 = 'f'.repeat(64); mutation.blocks[0].text = 'Late edit';
  const verified = await checking; assert.equal(verified.document.blocks[0].text, '研究方法');
});

test('per-field, total text, table, image and page limits prevent unbounded packages', () => {
  const changes: ((value: ParsedDocumentPackage) => void)[] = [
    (value) => { value.pdf.pageCount = PARSED_LIMITS.maxPages + 1; },
    (value) => { value.pdf.sizeBytes = PARSED_LIMITS.maxPdfBytes + 1; },
    (value) => { value.blocks[0].text = 'x'.repeat(PARSED_LIMITS.maxBlockTextCharacters + 1); },
    (value) => { value.blocks[2].latex = 'x'.repeat(PARSED_LIMITS.maxLatexCharacters + 1); },
    (value) => { value.blocks = Array.from({ length: PARSED_LIMITS.maxBlocks + 1 }, (_, index) => ({ id: `b${index}`, pageIndex: 0, kind: 'text', text: '' })); },
    (value) => { value.assets[0].sizeBytes = PARSED_LIMITS.maxAssetBytes + 1; },
  ];
  for (const change of changes) { const input = fixture(); change(input); fails(input, 'PACKAGE_LIMIT'); }
  const text = fixture(); text.blocks = Array.from({ length: 21 }, (_, index) => ({ id: `b${index}`, kind: 'text', pageIndex: 0, text: 'x'.repeat(100_000) })); text.assets = [];
  fails(text, 'PACKAGE_LIMIT');
  const pixels = fixture(), large = png();
  new DataView(large.buffer).setUint32(16, 4096); new DataView(large.buffer).setUint32(20, 4096);
  pixels.assets = [asset(large, 'a'), asset(large, 'b')]; pixels.blocks = pixels.assets.map(({ id }) => ({ id, kind: 'image', pageIndex: 0, text: '', assetId: id }));
  assert.equal(validateParsedDocument(pixels).assets.length, 2);
  pixels.assets.push(asset(large, 'c')); pixels.blocks.push({ id: 'c', kind: 'image', pageIndex: 0, text: '', assetId: 'c' });
  fails(pixels, 'PACKAGE_LIMIT');
});

test('raw decoder rejects oversized input, malformed UTF-8, duplicate keys, excessive depth and invalid JSON', async () => {
  await assert.rejects(decodeParsedDocument(new Uint8Array(PARSED_LIMITS.maxPackageBytes + 1)), rejection('PACKAGE_LIMIT'));
  for (const bytes of [Uint8Array.from([0xc0, 0xaf]), Uint8Array.from([0xed, 0xa0, 0x80]), Uint8Array.from([0xef, 0xbb, 0xbf, 123, 125])]) {
    await assert.rejects(decodeParsedDocument(bytes), rejection('INVALID_PACKAGE'));
  }
  const json = JSON.stringify(fixture());
  for (const raw of [json.replace('"version":1', '"version":2,"version":1'), json.replace('"version":1', '"version":1,"\\u0076ersion":1'), '{', '[]', 'null', json + 'x']) {
    await assert.rejects(decodeParsedDocument(new TextEncoder().encode(raw)), rejection('INVALID_PACKAGE'));
  }
  await assert.rejects(decodeParsedDocument(new TextEncoder().encode('['.repeat(PARSED_LIMITS.maxDepth + 1) + ']'.repeat(PARSED_LIMITS.maxDepth + 1))), rejection('PACKAGE_LIMIT'));
  const escaped = fixture(); escaped.blocks[0].text = 'Quoted " bracket [ and backslash \\ do not create JSON depth.';
  assert.equal((await decodeParsedDocument(encode(escaped))).document.blocks[0].text, escaped.blocks[0].text);
  const deep: unknown[] = []; let current = deep;
  for (let index = 0; index < PARSED_LIMITS.maxDepth + 1; index += 1) { const next: unknown[] = []; current.push(next); current = next; }
  fails(deep, 'PACKAGE_LIMIT');
});

test('aggregate image bytes, count and structural node budgets are enforced before adoption', async () => {
  const bytes = png();
  const expanded = new Uint8Array(PARSED_LIMITS.maxAssetBytes);
  const marker = bytes.length - 12, extraLength = expanded.length - bytes.length - 12;
  expanded.set(bytes.subarray(0, marker));
  new DataView(expanded.buffer).setUint32(marker, extraLength);
  expanded.set(Buffer.from('tEXt'), marker + 4);
  expanded.set(bytes.subarray(marker), expanded.length - 12);
  const input = fixture();
  input.assets = Array.from({ length: 4 }, (_, index) => asset(expanded, `a${index}`));
  input.blocks = input.assets.map(({ id }) => ({ id, kind: 'image', pageIndex: 0, text: '', assetId: id }));
  assert.equal(validateParsedDocument(input).assets.length, 4);
  input.assets.push(asset(expanded, 'a4'));
  input.blocks.push({ id: 'a4', kind: 'image', pageIndex: 0, text: '', assetId: 'a4' });
  fails(input, 'PACKAGE_LIMIT');
  const count = fixture();
  count.assets = Array.from({ length: PARSED_LIMITS.maxAssets + 1 }, (_, index) => asset(bytes, `a${index}`));
  count.blocks = count.assets.map(({ id }) => ({ id, kind: 'image', pageIndex: 0, text: '', assetId: id }));
  fails(count, 'PACKAGE_LIMIT');
  await assert.rejects(decodeParsedDocument(new TextEncoder().encode('[' + '0,'.repeat(PARSED_LIMITS.maxNodes) + '0]')), rejection('PACKAGE_LIMIT'));
});

test('validation errors expose controlled codes instead of supplied data', async () => {
  const input = fixture(); Object.assign(input, { privatePath: 'C:/SENTINEL/private.json' });
  try { await verifyParsedDocument(input); assert.fail('must reject'); }
  catch (error) {
    assert.ok(error instanceof ParsedDocumentError);
    assert.equal(error.message, 'INVALID_PACKAGE');
    assert.equal(error.message.includes('SENTINEL'), false);
  }
});
