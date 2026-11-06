/** Portable, private parse output. This format contains no filesystem paths or HTML. */
export const PARSED_LIMITS = Object.freeze({
  maxPackageBytes: 16 * 1024 * 1024,
  maxDepth: 20,
  maxNodes: 300_000,
  maxPages: 2000,
  maxPdfBytes: 64 * 1024 * 1024,
  maxBlocks: 20_000,
  maxTextCharacters: 2_000_000,
  maxBlockTextCharacters: 100_000,
  maxLatexCharacters: 16_384,
  maxAssets: 64,
  maxAssetBytes: 2 * 1024 * 1024,
  maxAssetTotalBytes: 8 * 1024 * 1024,
  maxAssetDimension: 8192,
  maxAssetPixels: 16 * 1024 * 1024,
  maxAssetTotalPixels: 32 * 1024 * 1024,
  maxTableArea: 10_000,
  maxTotalTableArea: 100_000,
  maxTableRows: 1000,
  maxTableColumns: 1000,
  maxIdentifierCharacters: 128,
  maxParserModelCharacters: 128,
});

export type ParsedAssetMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
export interface ParsedAsset {
  id: string;
  mediaType: ParsedAssetMediaType;
  base64: string;
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
}
export interface ParsedTableCell { text: string; rowSpan: number; colSpan: number; header: boolean }
export interface ParsedTableRow { section: 'head' | 'body' | 'foot'; cells: ParsedTableCell[] }
export interface ParsedTable { caption: string; rows: ParsedTableRow[] }
export interface ParsedBlock {
  id: string;
  pageIndex: number;
  kind: 'text' | 'heading' | 'equation' | 'table' | 'image';
  text: string;
  markdown?: string;
  latex?: string;
  table?: ParsedTable;
  assetId?: string;
  caption?: string;
  footnote?: string;
  sourceBlockId?: string;
}
export interface ParsedDocumentPackage {
  format: 'paperquay-parsed-document';
  version: 1;
  paperId: string;
  attachmentVersionId: string;
  pdf: { sha256: string; sizeBytes: number; pageCount: number };
  parser: { name: 'mineru'; model: string };
  blocks: ParsedBlock[];
  assets: ParsedAsset[];
}
export interface VerifiedParsedDocument { document: ParsedDocumentPackage; digest: string }
export type ParsedDocumentErrorCode = 'INVALID_PACKAGE' | 'PACKAGE_LIMIT' | 'INVALID_ASSET' | 'ASSET_INTEGRITY' | 'HASH_UNAVAILABLE';
export class ParsedDocumentError extends Error {
  readonly code: ParsedDocumentErrorCode;
  constructor(code: ParsedDocumentErrorCode) { super(code); this.name = 'ParsedDocumentError'; this.code = code; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const encoder = new TextEncoder();
function fail(code: ParsedDocumentErrorCode = 'INVALID_PACKAGE'): never { throw new ParsedDocumentError(code); }
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Reject accessors, exotic objects, holes, cycles and excessive work before reading fields. */
function inspectValue(value: unknown): void {
  let nodes = 0, characters = 0;
  const ancestors = new Set<object>();
  const walk = (input: unknown, depth: number): void => {
    if (++nodes > PARSED_LIMITS.maxNodes || depth > PARSED_LIMITS.maxDepth) fail('PACKAGE_LIMIT');
    if (typeof input === 'string') {
      characters += input.length;
      if (characters > PARSED_LIMITS.maxPackageBytes) fail('PACKAGE_LIMIT');
      return;
    }
    if (input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return;
    if (typeof input !== 'object' || !input || ancestors.has(input)) fail();
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    if (array && input.length > PARSED_LIMITS.maxNodes) fail('PACKAGE_LIMIT');
    const keys = Reflect.ownKeys(input);
    if (keys.length > PARSED_LIMITS.maxNodes - nodes + 1) fail('PACKAGE_LIMIT');
    ancestors.add(input);
    let entries = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
      characters += key.length;
      if (characters > PARSED_LIMITS.maxPackageBytes) fail('PACKAGE_LIMIT');
      walk(descriptor.value, depth + 1); entries += 1;
    }
    if (array && entries !== input.length) fail();
    ancestors.delete(input);
  };
  walk(value, 0);
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const result = value as Record<string, unknown>;
  if (required.some((key) => !own(result, key)) || Object.keys(result).some((key) => !required.includes(key) && !optional.includes(key))) fail();
  return result;
}
function string(value: unknown, maximum: number, minimum = 0): string {
  if (typeof value !== 'string') fail();
  if (value.length > maximum) fail('PACKAGE_LIMIT');
  if (value.length < minimum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail();
  // Lone surrogates do not survive a strict UTF-8 round trip.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
    } else if (code >= 0xdc00 && code <= 0xdfff) fail();
  }
  return value;
}
function identifier(value: unknown): string {
  const result = string(value, PARSED_LIMITS.maxIdentifierCharacters, 1);
  if (!ID.test(result)) fail();
  return result;
}
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) fail(); return value; }
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value; }
function number(value: unknown, minimum: number, maximum: number): number {
  if (!integer(value, minimum, maximum)) fail('PACKAGE_LIMIT');
  return value;
}

function u16be(bytes: Uint8Array, offset: number) { return bytes[offset] * 256 + bytes[offset + 1]; }
function u16le(bytes: Uint8Array, offset: number) { return bytes[offset] + bytes[offset + 1] * 256; }
function u24le(bytes: Uint8Array, offset: number) { return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536; }
function u32be(bytes: Uint8Array, offset: number) { return bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3]; }
function u32le(bytes: Uint8Array, offset: number) { return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536 + bytes[offset + 3] * 16777216; }
function ascii(bytes: Uint8Array, offset: number, value: string) {
  return offset + value.length <= bytes.length && [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}
function dimensions(width: number, height: number): { width: number; height: number } {
  if (!integer(width, 1, PARSED_LIMITS.maxAssetDimension) || !integer(height, 1, PARSED_LIMITS.maxAssetDimension)
    || width * height > PARSED_LIMITS.maxAssetPixels) fail('INVALID_ASSET');
  return { width, height };
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 45 || u32be(bytes, 8) !== 13 || !ascii(bytes, 12, 'IHDR')) fail('INVALID_ASSET');
  const result = dimensions(u32be(bytes, 16), u32be(bytes, 20));
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) fail('INVALID_ASSET');
  let offset = 33, image = false;
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    if (length > bytes.length - offset - 12) fail('INVALID_ASSET');
    if (ascii(bytes, offset + 4, 'IHDR') || ascii(bytes, offset + 4, 'acTL')
      || ascii(bytes, offset + 4, 'fcTL') || ascii(bytes, offset + 4, 'fdAT')) fail('INVALID_ASSET');
    if (ascii(bytes, offset + 4, 'IDAT') && length > 0) image = true;
    if (ascii(bytes, offset + 4, 'IEND')) {
      if (length !== 0 || !image || offset + 12 !== bytes.length) fail('INVALID_ASSET');
      return result;
    }
    offset += length + 12;
  }
  return fail('INVALID_ASSET');
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 16 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) fail('INVALID_ASSET');
  let offset = 2, result: { width: number; height: number } | undefined;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) fail('INVALID_ASSET');
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === undefined) fail('INVALID_ASSET');
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) fail('INVALID_ASSET');
    const length = u16be(bytes, offset);
    if (length < 2 || length > bytes.length - offset) fail('INVALID_ASSET');
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (![0xc0, 0xc1, 0xc2].includes(marker) || result || length < 11 || bytes[offset + 2] !== 8) fail('INVALID_ASSET');
      const components = bytes[offset + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) fail('INVALID_ASSET');
      result = dimensions(u16be(bytes, offset + 5), u16be(bytes, offset + 3));
    }
    if (marker === 0xda) {
      if (!result || length < 6 || offset + length >= bytes.length - 2) fail('INVALID_ASSET');
      return result;
    }
    offset += length;
  }
  return fail('INVALID_ASSET');
}

function webpSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 26 || u32le(bytes, 4) !== bytes.length - 8) fail('INVALID_ASSET');
  let offset = 12, canvas: { width: number; height: number } | undefined, frame: { width: number; height: number } | undefined;
  while (offset + 8 <= bytes.length) {
    const length = u32le(bytes, offset + 4), data = offset + 8;
    if (length > bytes.length - data || data + length + (length % 2) > bytes.length) fail('INVALID_ASSET');
    if (ascii(bytes, offset, 'ANIM') || ascii(bytes, offset, 'ANMF')) fail('INVALID_ASSET');
    if (ascii(bytes, offset, 'VP8X')) {
      if (canvas || frame || offset !== 12 || length !== 10 || (bytes[data] & 0xc3) !== 0
        || bytes[data + 1] || bytes[data + 2] || bytes[data + 3]) fail('INVALID_ASSET');
      canvas = dimensions(u24le(bytes, data + 4) + 1, u24le(bytes, data + 7) + 1);
    } else if (ascii(bytes, offset, 'VP8 ')) {
      if (frame || length < 10 || (bytes[data] & 1) !== 0 || !ascii(bytes, data + 3, '\x9d\x01\x2a')) fail('INVALID_ASSET');
      frame = dimensions(u16le(bytes, data + 6) & 0x3fff, u16le(bytes, data + 8) & 0x3fff);
    } else if (ascii(bytes, offset, 'VP8L')) {
      if (frame || length < 5 || bytes[data] !== 0x2f) fail('INVALID_ASSET');
      const bits = u32le(bytes, data + 1);
      if (bits >= 0x20000000) fail('INVALID_ASSET');
      frame = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else if (!canvas || !['ALPH', 'ICCP', 'EXIF', 'XMP '].some((tag) => ascii(bytes, offset, tag))) fail('INVALID_ASSET');
    offset = data + length + (length % 2);
  }
  if (offset !== bytes.length || !frame || canvas && (canvas.width !== frame.width || canvas.height !== frame.height)) fail('INVALID_ASSET');
  return frame;
}

/** Header validation is bounded; a client must still decode an image before display. */
export function inspectParsedImage(bytes: Uint8Array): { mediaType: ParsedAssetMediaType; width: number; height: number } {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > PARSED_LIMITS.maxAssetBytes) fail('INVALID_ASSET');
  if (bytes.length >= 8 && bytes[0] === 137 && ascii(bytes, 1, 'PNG\r\n\x1a\n')) return { mediaType: 'image/png', ...pngSize(bytes) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mediaType: 'image/jpeg', ...jpegSize(bytes) };
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return { mediaType: 'image/webp', ...webpSize(bytes) };
  return fail('INVALID_ASSET');
}

function base64Digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}
function decodeBase64(value: unknown, size: number): Uint8Array {
  if (typeof value !== 'string' || value.length !== Math.ceil(size / 3) * 4 || value.length % 4 !== 0) fail('INVALID_ASSET');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length / 4 * 3 - padding !== size) fail('INVALID_ASSET');
  for (let index = 0; index < value.length - padding; index += 1) if (base64Digit(value.charCodeAt(index)) < 0) fail('INVALID_ASSET');
  if (padding === 2 && (base64Digit(value.charCodeAt(value.length - 3)) & 15) !== 0
    || padding === 1 && (base64Digit(value.charCodeAt(value.length - 2)) & 3) !== 0) fail('INVALID_ASSET');
  let raw: string;
  try { raw = atob(value); } catch { return fail('INVALID_ASSET'); }
  if (raw.length !== size) fail('INVALID_ASSET');
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

interface Budget { text: number; tableArea: number }
function text(value: unknown, budget: Budget, maximum: number = PARSED_LIMITS.maxBlockTextCharacters): string {
  const result = string(value, maximum);
  budget.text += result.length;
  if (budget.text > PARSED_LIMITS.maxTextCharacters) fail('PACKAGE_LIMIT');
  return result;
}
function table(value: unknown, budget: Budget): ParsedTable {
  const raw = object(value, ['caption', 'rows']);
  if (!Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > PARSED_LIMITS.maxTableRows) fail('PACKAGE_LIMIT');
  const result: ParsedTable = { caption: text(raw.caption, budget), rows: [] };
  const occupied = new Set<number>();
  const occupiedRows = new Uint16Array(raw.rows.length);
  let area = 0, previousSection = -1, lastSpanRow = -1;
  for (let rowIndex = 0; rowIndex < raw.rows.length; rowIndex += 1) {
    const row = object(raw.rows[rowIndex], ['section', 'cells']);
    const section = ['head', 'body', 'foot'].indexOf(row.section as string);
    if (section < 0 || section < previousSection) fail();
    if (section !== previousSection && lastSpanRow >= rowIndex) fail();
    previousSection = section;
    if (!Array.isArray(row.cells) || row.cells.length > PARSED_LIMITS.maxTableColumns) fail('PACKAGE_LIMIT');
    const cells: ParsedTableCell[] = [];
    let column = 0;
    for (const entry of row.cells) {
      const cell = object(entry, ['text', 'rowSpan', 'colSpan', 'header']);
      const rowSpan = number(cell.rowSpan, 1, PARSED_LIMITS.maxTableRows);
      const colSpan = number(cell.colSpan, 1, PARSED_LIMITS.maxTableColumns);
      if (typeof cell.header !== 'boolean') fail();
      if (rowIndex + rowSpan > raw.rows.length) fail();
      while (occupied.has(rowIndex * PARSED_LIMITS.maxTableColumns + column)) column += 1;
      area += rowSpan * colSpan;
      if (column + colSpan > PARSED_LIMITS.maxTableColumns || area > PARSED_LIMITS.maxTableArea) fail('PACKAGE_LIMIT');
      for (let down = 0; down < rowSpan; down += 1) for (let across = 0; across < colSpan; across += 1) {
        const position = (rowIndex + down) * PARSED_LIMITS.maxTableColumns + column + across;
        if (occupied.has(position)) fail();
        occupied.add(position);
        occupiedRows[rowIndex + down] += 1;
      }
      lastSpanRow = Math.max(lastSpanRow, rowIndex + rowSpan - 1);
      cells.push({ text: text(cell.text, budget), rowSpan, colSpan, header: cell.header });
      column += colSpan;
    }
    if (!cells.length && !occupiedRows[rowIndex]) fail();
    result.rows.push({ section: row.section as ParsedTableRow['section'], cells });
  }
  budget.tableArea += area;
  if (budget.tableArea > PARSED_LIMITS.maxTotalTableArea) fail('PACKAGE_LIMIT');
  return result;
}

function normalize(value: unknown, assetBytes?: Uint8Array[]): ParsedDocumentPackage {
  inspectValue(value);
  const raw = object(value, ['format', 'version', 'paperId', 'attachmentVersionId', 'pdf', 'parser', 'blocks', 'assets']);
  if (raw.format !== 'paperquay-parsed-document' || raw.version !== 1) fail();
  const pdf = object(raw.pdf, ['sha256', 'sizeBytes', 'pageCount']);
  const parser = object(raw.parser, ['name', 'model']);
  if (parser.name !== 'mineru') fail();
  const model = string(parser.model, PARSED_LIMITS.maxParserModelCharacters, 1);
  if (!model.trim() || model !== model.trim()) fail();
  const result: ParsedDocumentPackage = {
    format: 'paperquay-parsed-document', version: 1, paperId: uuid(raw.paperId), attachmentVersionId: uuid(raw.attachmentVersionId),
    pdf: { sha256: hash(pdf.sha256), sizeBytes: number(pdf.sizeBytes, 1, PARSED_LIMITS.maxPdfBytes), pageCount: number(pdf.pageCount, 1, PARSED_LIMITS.maxPages) },
    parser: { name: 'mineru', model }, blocks: [], assets: [],
  };
  if (!Array.isArray(raw.blocks) || !raw.blocks.length || raw.blocks.length > PARSED_LIMITS.maxBlocks
    || !Array.isArray(raw.assets) || raw.assets.length > PARSED_LIMITS.maxAssets) fail('PACKAGE_LIMIT');
  const budget: Budget = { text: 0, tableArea: 0 };
  const blockMap = new Map<string, ParsedBlock>(), assetIds = new Set<string>(), usedAssets = new Set<string>();
  for (const entry of raw.blocks) {
    const block = object(entry, ['id', 'pageIndex', 'kind', 'text'], ['markdown', 'latex', 'table', 'assetId', 'caption', 'footnote', 'sourceBlockId']);
    if (!['text', 'heading', 'equation', 'table', 'image'].includes(block.kind as string)) fail();
    const normalized: ParsedBlock = { id: identifier(block.id), pageIndex: number(block.pageIndex, 0, result.pdf.pageCount - 1),
      kind: block.kind as ParsedBlock['kind'], text: text(block.text, budget) };
    if (blockMap.has(normalized.id)) fail();
    if (own(block, 'markdown')) normalized.markdown = text(block.markdown, budget);
    if (own(block, 'latex')) {
      if (block.kind !== 'equation') fail();
      normalized.latex = text(block.latex, budget, PARSED_LIMITS.maxLatexCharacters);
      if (!normalized.latex.trim()) fail();
    }
    if (own(block, 'table')) { if (block.kind !== 'table') fail(); normalized.table = table(block.table, budget); }
    if (own(block, 'assetId')) {
      if (block.kind !== 'image') fail();
      normalized.assetId = identifier(block.assetId); usedAssets.add(normalized.assetId);
    }
    if (own(block, 'caption')) normalized.caption = text(block.caption, budget);
    if (own(block, 'footnote')) normalized.footnote = text(block.footnote, budget);
    if (own(block, 'sourceBlockId')) normalized.sourceBlockId = identifier(block.sourceBlockId);
    if (block.kind === 'equation' && !normalized.latex && !normalized.sourceBlockId
      || block.kind === 'table' && !normalized.table && !normalized.sourceBlockId
      || block.kind === 'image' && !normalized.assetId && !normalized.sourceBlockId) fail();
    blockMap.set(normalized.id, normalized); result.blocks.push(normalized);
  }
  // Resolve each chain once. Neither a cycle nor a different-kind source is a valid continuation.
  const resolved = new Set<string>();
  for (const block of result.blocks) {
    const chain = new Set<string>(); let current = block;
    while (current.sourceBlockId) {
      if (resolved.has(current.id)) break;
      if (chain.has(current.id)) fail();
      chain.add(current.id);
      const source = blockMap.get(current.sourceBlockId);
      if (!source || source.kind !== current.kind) fail();
      current = source;
    }
    for (const id of chain) resolved.add(id);
  }
  let totalBytes = 0, totalPixels = 0;
  for (const entry of raw.assets) {
    const asset = object(entry, ['id', 'mediaType', 'base64', 'sha256', 'sizeBytes', 'width', 'height']);
    const id = identifier(asset.id);
    if (assetIds.has(id) || !usedAssets.has(id)) fail();
    assetIds.add(id);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mediaType as string)) fail('INVALID_ASSET');
    const sizeBytes = number(asset.sizeBytes, 1, PARSED_LIMITS.maxAssetBytes);
    totalBytes += sizeBytes;
    if (totalBytes > PARSED_LIMITS.maxAssetTotalBytes) fail('PACKAGE_LIMIT');
    const width = number(asset.width, 1, PARSED_LIMITS.maxAssetDimension), height = number(asset.height, 1, PARSED_LIMITS.maxAssetDimension);
    totalPixels += width * height;
    if (width * height > PARSED_LIMITS.maxAssetPixels || totalPixels > PARSED_LIMITS.maxAssetTotalPixels) fail('PACKAGE_LIMIT');
    const bytes = decodeBase64(asset.base64, sizeBytes);
    const metadata = inspectParsedImage(bytes);
    if (metadata.mediaType !== asset.mediaType || metadata.width !== width || metadata.height !== height) fail('INVALID_ASSET');
    result.assets.push({ id, mediaType: metadata.mediaType, base64: asset.base64 as string, sha256: hash(asset.sha256), sizeBytes, width, height });
    assetBytes?.push(bytes);
  }
  if ([...usedAssets].some((id) => !assetIds.has(id))) fail();
  if (encoder.encode(JSON.stringify(result)).byteLength > PARSED_LIMITS.maxPackageBytes) fail('PACKAGE_LIMIT');
  return result;
}

/** Validates all structure and image headers, returns detached data in a fixed key order.
 * Asset SHA-256 is deliberately deferred to verifyParsedDocument. */
export function validateParsedDocument(value: unknown): ParsedDocumentPackage {
  try { return normalize(value); }
  catch (error) { if (error instanceof ParsedDocumentError) throw error; return fail(); }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  try {
    // An owned ArrayBuffer also works with Web Crypto implementations rejecting SharedArrayBuffer.
    const buffer = new Uint8Array(bytes.length); buffer.set(bytes);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer.buffer);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  } catch { return fail('HASH_UNAVAILABLE'); }
}

/** The digest is SHA-256 of UTF-8 JSON.stringify(document), independent of input key order. */
export async function verifyParsedDocument(value: unknown): Promise<VerifiedParsedDocument> {
  const assets: Uint8Array[] = [];
  let document: ParsedDocumentPackage;
  try { document = normalize(value, assets); }
  catch (error) { if (error instanceof ParsedDocumentError) throw error; return fail(); }
  for (let index = 0; index < assets.length; index += 1) {
    if (await sha256(assets[index]) !== document.assets[index].sha256) fail('ASSET_INTEGRITY');
  }
  return { document, digest: await sha256(encoder.encode(JSON.stringify(document))) };
}

/** Scan before JSON.parse: no deeply nested input or duplicate-key last-write semantics. */
function inspectJson(input: string): void {
  const stack: { kind: string; keys: Set<string> }[] = [];
  let nodes = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (/\s/.test(char) || char === ',' || char === ':') continue;
    if (++nodes > PARSED_LIMITS.maxNodes) fail('PACKAGE_LIMIT');
    if (char === '{' || char === '[') {
      stack.push({ kind: char, keys: new Set() });
      if (stack.length > PARSED_LIMITS.maxDepth) fail('PACKAGE_LIMIT');
    } else if (char === '}' || char === ']') {
      if (stack.pop()?.kind !== (char === '}' ? '{' : '[')) fail();
    } else if (char === '"') {
      const start = index; let escaped = false, ended = false;
      for (index += 1; index < input.length; index += 1) {
        if (!escaped && input[index] === '"') { ended = true; break; }
        if (!escaped && input[index] === '\\') escaped = true; else escaped = false;
      }
      if (!ended) fail();
      let next = index + 1;
      while (next < input.length && /\s/.test(input[next])) next += 1;
      if (input[next] === ':') {
        const frame = stack[stack.length - 1];
        if (frame?.kind !== '{' || index - start > PARSED_LIMITS.maxIdentifierCharacters * 6 + 2) fail();
        let key: unknown;
        try { key = JSON.parse(input.slice(start, index + 1)); } catch { return fail(); }
        if (typeof key !== 'string' || frame.keys.has(key)) fail();
        frame.keys.add(key);
      }
    } else {
      while (index + 1 < input.length && !/[\s,\]}]/.test(input[index + 1])) index += 1;
    }
  }
  if (stack.length) fail();
}

export async function decodeParsedDocument(bytes: Uint8Array): Promise<VerifiedParsedDocument> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) fail();
  if (bytes.byteLength > PARSED_LIMITS.maxPackageBytes) fail('PACKAGE_LIMIT');
  let input: string;
  try {
    // BOM is forbidden rather than silently dropped; the portable representation is plain UTF-8.
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail();
    input = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return fail(); }
  inspectJson(input);
  let value: unknown;
  try { value = JSON.parse(input); } catch { return fail(); }
  return verifyParsedDocument(value);
}
