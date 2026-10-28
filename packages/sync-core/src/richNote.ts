import type { JsonSchema } from './schema.ts';
import { inspectParsedImage } from './parsedDocument.ts';

/** Semantic subset of the desktop TipTap 3.31.3 schema. Standard text/list/code/
 * table/math/image nodes and all six desktop custom nodes are supported within
 * explicit budgets. Attributes are preserved, not default-filled or stripped.
 * Unknown extensions, invalid tables, remote/data/blob/local images, SVG/GIF/BMP,
 * credential/local links and version assertions on historical anchors are
 * rejected as a whole. Rejection does not mean that content has been preserved.
 * Plain text is never interpreted as HTML, a resource URL or a filesystem path. */
export const RICH_NOTE_LIMITS = Object.freeze({
  entityBytes: 1024 * 1024, depth: 32, nodes: 20_000, bodyCharacters: 262_144,
  assets: 32, assetBytes: 512 * 1024, assetPixels: 4 * 1024 * 1024,
  totalAssetPixels: 8 * 1024 * 1024, tableArea: 10_000, references: 1000,
});
export type RichNoteErrorCode = 'INVALID_NOTE' | 'NOTE_LIMIT' | 'UNSUPPORTED_CONTENT' | 'INVALID_ASSET' | 'ASSET_INTEGRITY' | 'BODY_MISMATCH';
export class RichNoteError extends Error {
  readonly code: RichNoteErrorCode;
  constructor(code: RichNoteErrorCode) { super(code); this.name = 'RichNoteError'; this.code = code; }
}
export type RichNoteAttribute = string | number | boolean | null | number[];
export interface RichNoteMark { type: string; attrs?: Record<string, RichNoteAttribute> }
export interface RichNoteNode {
  type: string; attrs?: Record<string, RichNoteAttribute>; content?: RichNoteNode[]; marks?: RichNoteMark[]; text?: string;
}
export interface RichNoteAsset {
  id: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string;
  sha256: string; sizeBytes: number; width: number; height: number;
}
export interface RichNotePdfLocation {
  pageNumber: number;
  boundingRect?: { x: number; y: number; width: number; height: number };
  bbox?: [number, number, number, number]; bboxCoordinateSystem?: 'pdf' | 'normalized-1000';
  bboxPageSize?: [number, number]; highlightColor?: string;
}
/** Historical desktop coordinates are deliberately not upgraded into version evidence. */
export interface RichNoteAnchor {
  id: string; label: string; excerpt: string; createdAt: number; verification: 'unverified';
  paperId?: string; sourceTitle?: string; source?: 'pdf' | 'blocks' | 'ai-chat' | 'manual';
  blockId?: string | null; pageIndex?: number | null; pdfLocation?: RichNotePdfLocation;
}
export interface RichNoteUnresolvedReference {
  kind: 'note' | 'paper' | 'folder' | 'ai-chat'; id: string; label: string;
  reason: 'unmapped' | 'missing' | 'historical-unverified';
}
export interface RichNoteMetadata {
  type: 'highlight' | 'area' | 'standalone' | 'ai-chat'; anchors: RichNoteAnchor[];
  tags: string[]; color: string; isFavorite: boolean; isPinned: boolean;
  linkedNoteIds: string[]; linkedPaperIds: string[]; createdAt: number; updatedAt: number;
  unresolvedReferences: RichNoteUnresolvedReference[];
  excerpt?: string; pdfLocation?: RichNotePdfLocation; aiChatId?: string; aiChatMessageIds?: string[];
  linkedPaperId?: string | null; folderId?: string | null;
}
export interface RichNoteData {
  paperId: string | null; title: string; body: string; format: 'tiptap-json';
  document: RichNoteNode; metadata: RichNoteMetadata; assets: RichNoteAsset[];
}
export interface CreateRichNoteInput { paperId: string | null; title: string; document: unknown; metadata: unknown; assets: unknown }

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
function fail(code: RichNoteErrorCode = 'INVALID_NOTE'): never { throw new RichNoteError(code); }
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Inspect descriptors before property reads; caller objects must not execute code. */
function inspect(value: unknown): void {
  let count = 0, characters = 0;
  const ancestors = new Set<object>();
  const visit = (input: unknown, depth: number): void => {
    if (++count > RICH_NOTE_LIMITS.nodes || depth > RICH_NOTE_LIMITS.depth) fail('NOTE_LIMIT');
    if (typeof input === 'string') { characters += input.length; if (characters > RICH_NOTE_LIMITS.entityBytes) fail('NOTE_LIMIT'); return; }
    if (input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return;
    if (!input || typeof input !== 'object' || ancestors.has(input)) fail();
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    if (array && input.length > RICH_NOTE_LIMITS.nodes) fail('NOTE_LIMIT');
    const keys = Reflect.ownKeys(input);
    if (keys.length > RICH_NOTE_LIMITS.nodes - count + 1) fail('NOTE_LIMIT');
    ancestors.add(input);
    let entries = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
      characters += key.length;
      if (characters > RICH_NOTE_LIMITS.entityBytes) fail('NOTE_LIMIT');
      visit(descriptor.value, depth + 1); entries++;
    }
    if (array && entries !== input.length) fail();
    ancestors.delete(input);
  };
  visit(value, 0);
}
function object(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const value = input as Record<string, unknown>;
  if (required.some((key) => !own(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) fail();
  return value;
}
function string(value: unknown, maximum = 2048, minimum = 0): string {
  if (typeof value !== 'string' || value.length < minimum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail();
  if (value.length > maximum) fail('NOTE_LIMIT');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) fail(); }
    else if (code >= 0xdc00 && code <= 0xdfff) fail();
  }
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}
function finite(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) fail();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value; }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !values.includes(value as T)) fail(); return value as T; }
function identifier(value: unknown): string { const result = string(value, 128, 1); if (!ID.test(result)) fail(); return result; }
function uuid(value: unknown): string { const result = string(value, 36, 36); if (!UUID.test(result)) fail(); return result; }
export function richNoteUnresolvedId(kind: RichNoteUnresolvedReference['kind'], sourceId: string): string {
  choice(kind, ['note', 'paper', 'folder', 'ai-chat']); identifier(sourceId);
  if (sourceId.startsWith('unresolved:')) fail();
  return identifier(`unresolved:${kind}:${sourceId}`);
}
export function parseRichNoteUnresolvedId(value: string): { kind: RichNoteUnresolvedReference['kind']; sourceId: string } | null {
  if (!value.startsWith('unresolved:')) return null;
  const matched = /^unresolved:(note|paper|folder|ai-chat):(.+)$/.exec(value);
  if (!matched) fail();
  const kind = matched[1] as RichNoteUnresolvedReference['kind'], sourceId = matched[2];
  if (richNoteUnresolvedId(kind, sourceId) !== value) fail();
  return { kind, sourceId };
}
function paperReferenceId(value: unknown): string {
  const result = identifier(value);
  if (!UUID.test(result) && parseRichNoteUnresolvedId(result)?.kind !== 'paper') fail();
  return result;
}
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) fail('INVALID_ASSET'); return value; }
function array<T>(value: unknown, convert: (item: unknown) => T, maximum: number = RICH_NOTE_LIMITS.references): T[] {
  if (!Array.isArray(value)) fail();
  if (value.length > maximum) fail('NOTE_LIMIT');
  return value.map(convert);
}
function uniqueStrings(value: unknown, convert = identifier): string[] {
  const result = array(value, convert); if (new Set(result).size !== result.length) fail(); return result;
}
function color(value: unknown): string {
  const result = string(value, 64, 1);
  if (!/^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,32}|rgba?\(\s*[0-9.,%\s]+\))$/.test(result)) fail();
  return result;
}

/** Only explicit link attributes may contain URLs. Renderers must never auto-fetch them. */
function href(value: unknown): string {
  const result = string(value, 4096, 1);
  if (result.trim() !== result || /[\\\s\u0000-\u001f]/.test(result) || !/^https?:\/\//i.test(result)) fail('UNSUPPORTED_CONTENT');
  let url: URL; try { url = new URL(result); } catch { return fail('UNSUPPORTED_CONTENT'); }
  if (url.username || url.password || url.port && !['80', '443'].includes(url.port)) fail('UNSUPPORTED_CONTENT');
  const host = url.hostname.toLowerCase();
  // Keep local resources and credential endpoints out of portable notes.
  if (!host.includes('.') || /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(host)
    || host.endsWith('.localhost') || host.endsWith('.local') || host.includes(':')) fail('UNSUPPORTED_CONTENT');
  const sensitive = /token|secret|pass(?:word|wd)?|pwd|credential|signature|authorization|api.?key|session|code_verifier|^(?:auth|key|code|sig|jwt|bearer|ticket)$/i;
  for (const key of url.searchParams.keys()) {
    let decodedKey = key;
    for (let i = 0; i < 3; i++) { try { const next = decodeURIComponent(decodedKey); if (next === decodedKey) break; decodedKey = next; } catch { fail('UNSUPPORTED_CONTENT'); } }
    if (sensitive.test(decodedKey) || decodedKey.includes('%')) fail('UNSUPPORTED_CONTENT');
  }
  let decoded = result;
  for (let i = 0; i < 3; i++) { try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { fail('UNSUPPORTED_CONTENT'); } }
  if (/[\u0000-\u001f\\]/.test(decoded) || /(?:file:|(?:^|[/?#=])[a-z]:[\/\\]|\/\/[^/?#]+@)/i.test(decoded)) fail('UNSUPPORTED_CONTENT');
  const fragment = decoded.slice(decoded.indexOf('#') + 1);
  if (decoded.includes('#') && fragment.split(/[&?]/).some((entry) => entry.includes('=') && sensitive.test(entry.split('=')[0]))) fail('UNSUPPORTED_CONTENT');
  return result;
}

const NODE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  doc: [], paragraph: [], text: [], heading: ['level'], blockquote: [], bulletList: [],
  orderedList: ['start', 'type'], listItem: [], taskList: [], taskItem: ['checked'],
  codeBlock: ['language'], hardBreak: [], horizontalRule: [], table: [], tableRow: [],
  tableCell: ['colspan', 'rowspan', 'colwidth', 'align'], tableHeader: ['colspan', 'rowspan', 'colwidth', 'align'],
  image: ['src', 'alt', 'title', 'width', 'height'], inlineMath: ['latex'], blockMath: ['latex'],
  noteComponentBlock: ['title', 'variant'], noteAnchorBlock: ['anchorId', 'label', 'sourceLabel', 'sourceTitle', 'excerpt'],
  noteAnchorLink: ['anchorId', 'label'], wikiLink: ['id', 'label'], hashTag: ['tag'], paperReference: ['paperId', 'label'],
});
const MARK_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  bold: [], italic: [], strike: [], code: [], underline: [], highlight: ['color'], link: ['href', 'target', 'rel', 'class', 'title'],
});
const INLINE = new Set(['text', 'hardBreak', 'inlineMath', 'noteAnchorLink', 'wikiLink', 'hashTag', 'paperReference']);
const BLOCK = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'horizontalRule', 'table', 'image', 'blockMath', 'noteComponentBlock', 'noteAnchorBlock']);
function attribute(type: string, key: string, value: unknown): RichNoteAttribute {
  if (value === null) {
    if (['level', 'start', 'checked', 'colspan', 'rowspan', 'latex', 'src'].includes(key)) fail();
    return null;
  }
  if (key === 'href') return href(value);
  if (key === 'src') { const result = string(value, 77, 77); if (!/^asset:sha256:[0-9a-f]{64}$/.test(result)) fail('INVALID_ASSET'); return result; }
  if (key === 'level') return integer(value, 1, 6);
  if (key === 'start') return integer(value, 0, 1_000_000_000);
  if (key === 'checked') return boolean(value);
  if (key === 'rowspan' || key === 'colspan') return integer(value, 1, 1000);
  if (key === 'width' || key === 'height') return integer(value, 1, 8192);
  if (key === 'colwidth') return array(value, (item) => integer(item, 0, 8192), 1000);
  if (key === 'align') return choice(value, ['left', 'center', 'right']);
  if (key === 'target') return choice(value, ['_blank', '_self']);
  if (key === 'rel') {
    const result = string(value, 128);
    if (result && result.split(/\s+/).some((token) => !['noopener', 'noreferrer', 'nofollow', 'ugc'].includes(token))) fail('UNSUPPORTED_CONTENT');
    return result;
  }
  if (key === 'class') { const result = string(value, 256); if (!/^[A-Za-z0-9_\- ]*$/.test(result)) fail('UNSUPPORTED_CONTENT'); return result; }
  if (key === 'color') return color(value);
  if (key === 'id' || key === 'anchorId' || key === 'paperId') return identifier(value);
  if (key === 'type') return choice(value, ['1', 'a', 'A', 'i', 'I']);
  if (key === 'variant' || key === 'language') { const result = string(value, 128); if (!/^[A-Za-z0-9_+.#-]*$/.test(result)) fail('UNSUPPORTED_CONTENT'); return result; }
  return string(value, key === 'latex' ? 16_384 : key === 'excerpt' ? 65_536 : 2048);
}
function attributes(type: string, input: unknown, mark = false): Record<string, RichNoteAttribute> {
  const allowed = (mark ? MARK_ATTRIBUTES : NODE_ATTRIBUTES)[type];
  const raw = object(input, [], allowed), result: Record<string, RichNoteAttribute> = {};
  for (const key of allowed) if (own(raw, key)) result[key] = attribute(type, key, raw[key]);
  return result;
}
function node(input: unknown, depth = 0): RichNoteNode {
  if (depth > 12) fail('NOTE_LIMIT');
  const raw = object(input, ['type'], ['attrs', 'content', 'marks', 'text']);
  const type = string(raw.type, 64, 1);
  if (!own(NODE_ATTRIBUTES, type)) fail('UNSUPPORTED_CONTENT');
  const result: RichNoteNode = { type };
  if (own(raw, 'attrs')) result.attrs = attributes(type, raw.attrs);
  if (own(raw, 'text')) { if (type !== 'text') fail(); result.text = string(raw.text, RICH_NOTE_LIMITS.bodyCharacters, 1); }
  if (type === 'text' && !own(raw, 'text')) fail();
  if (own(raw, 'content')) result.content = array(raw.content, (item) => node(item, depth + 1), RICH_NOTE_LIMITS.nodes);
  if (own(raw, 'marks')) {
    if (!INLINE.has(type)) fail();
    result.marks = array(raw.marks, (item) => {
      const mark = object(item, ['type'], ['attrs']), markType = string(mark.type, 32, 1);
      if (!own(MARK_ATTRIBUTES, markType)) fail('UNSUPPORTED_CONTENT');
      const next: RichNoteMark = { type: markType };
      if (own(mark, 'attrs')) next.attrs = attributes(markType, mark.attrs, true);
      if (markType === 'link' && typeof next.attrs?.href !== 'string') fail();
      return next;
    }, 7);
    if (new Set(result.marks.map((mark) => mark.type)).size !== result.marks.length) fail();
    if (result.marks.some((mark) => mark.type === 'code') && result.marks.length !== 1) fail();
  }
  const children = result.content ?? [];
  const attrs = result.attrs ?? {};
  const all = (allowed: Set<string>) => children.every((child) => allowed.has(child.type));
  if (type === 'paragraph' || type === 'heading') { if (!all(INLINE)) fail(); }
  else if (['doc', 'blockquote', 'noteComponentBlock', 'tableCell', 'tableHeader'].includes(type)) { if (!children.length || !all(BLOCK)) fail(); }
  else if (type === 'listItem' || type === 'taskItem') { if (children[0]?.type !== 'paragraph' || !all(BLOCK)) fail(); }
  else if (['bulletList', 'orderedList', 'taskList', 'table', 'tableRow'].includes(type)) {
    const childTypes = type === 'table' ? ['tableRow'] : type === 'tableRow' ? ['tableCell', 'tableHeader'] : type === 'taskList' ? ['taskItem'] : ['listItem'];
    if (type !== 'tableRow' && !children.length || !all(new Set(childTypes))) fail();
  } else if (type === 'codeBlock') { if (children.some((child) => child.type !== 'text' || child.marks?.length)) fail(); }
  else if (children.length) fail();
  if (type === 'heading' && attrs.level === undefined || type === 'taskItem' && attrs.checked === undefined
    || ['inlineMath', 'blockMath'].includes(type) && (typeof attrs.latex !== 'string' || !attrs.latex.trim())
    || type === 'image' && typeof attrs.src !== 'string') fail();
  if (type === 'table') validateTable(result);
  return result;
}
function validateTable(table: RichNoteNode): void {
  const rows = table.content!, occupied = new Set<number>();
  let width: number | undefined, area = 0;
  for (let row = 0; row < rows.length; row++) {
    let column = 0;
    for (const cell of rows[row].content!) {
      while (occupied.has(row * 1000 + column)) column++;
      const colspan = (cell.attrs?.colspan ?? 1) as number, rowspan = (cell.attrs?.rowspan ?? 1) as number;
      if (column + colspan > 1000 || row + rowspan > rows.length || (area += colspan * rowspan) > RICH_NOTE_LIMITS.tableArea) fail();
      if (cell.attrs?.colwidth !== undefined && cell.attrs.colwidth !== null && (cell.attrs.colwidth as number[]).length !== colspan) fail();
      for (let r = row; r < row + rowspan; r++) for (let c = column; c < column + colspan; c++) {
        const position = r * 1000 + c; if (occupied.has(position)) fail(); occupied.add(position);
      }
      column += colspan;
    }
    while (occupied.has(row * 1000 + column)) column++;
    if (width === undefined) width = column;
    if (column !== width) fail();
    for (let c = 0; c < width; c++) if (!occupied.has(row * 1000 + c)) fail();
  }
  if (!width) fail();
}

function location(input: unknown): RichNotePdfLocation {
  const raw = object(input, ['pageNumber'], ['boundingRect', 'bbox', 'bboxCoordinateSystem', 'bboxPageSize', 'highlightColor']);
  const result: RichNotePdfLocation = { pageNumber: integer(raw.pageNumber, 1, 1_000_000) };
  if (own(raw, 'boundingRect')) {
    const rect = object(raw.boundingRect, ['x', 'y', 'width', 'height']);
    result.boundingRect = { x: finite(rect.x, -1_000_000, 1_000_000), y: finite(rect.y, -1_000_000, 1_000_000), width: finite(rect.width, 0, 1_000_000), height: finite(rect.height, 0, 1_000_000) };
  }
  if (own(raw, 'bbox')) { const values = array(raw.bbox, (entry) => finite(entry, -1_000_000, 1_000_000), 4); if (values.length !== 4) fail(); result.bbox = values as RichNotePdfLocation['bbox']; }
  if (own(raw, 'bboxCoordinateSystem')) result.bboxCoordinateSystem = choice<'pdf' | 'normalized-1000'>(raw.bboxCoordinateSystem, ['pdf', 'normalized-1000']);
  if (own(raw, 'bboxPageSize')) { const values = array(raw.bboxPageSize, (entry) => finite(entry, Number.MIN_VALUE, 1_000_000), 2); if (values.length !== 2) fail(); result.bboxPageSize = values as RichNotePdfLocation['bboxPageSize']; }
  if (own(raw, 'highlightColor')) result.highlightColor = color(raw.highlightColor);
  return result;
}
function metadata(input: unknown): RichNoteMetadata {
  const raw = object(input, ['type', 'anchors', 'tags', 'color', 'isFavorite', 'isPinned', 'linkedNoteIds', 'linkedPaperIds', 'createdAt', 'updatedAt', 'unresolvedReferences'],
    ['excerpt', 'pdfLocation', 'aiChatId', 'aiChatMessageIds', 'linkedPaperId', 'folderId']);
  const result: RichNoteMetadata = {
    type: choice(raw.type, ['highlight', 'area', 'standalone', 'ai-chat']),
    anchors: array(raw.anchors, (entry): RichNoteAnchor => {
      const anchor = object(entry, ['id', 'label', 'excerpt', 'createdAt', 'verification'], ['paperId', 'sourceTitle', 'source', 'blockId', 'pageIndex', 'pdfLocation']);
      const next: RichNoteAnchor = { id: identifier(anchor.id), label: string(anchor.label), excerpt: string(anchor.excerpt, 65_536), createdAt: integer(anchor.createdAt), verification: choice(anchor.verification, ['unverified']) };
      if (own(anchor, 'paperId')) next.paperId = paperReferenceId(anchor.paperId);
      if (own(anchor, 'sourceTitle')) next.sourceTitle = string(anchor.sourceTitle);
      if (own(anchor, 'source')) next.source = choice<'pdf' | 'blocks' | 'ai-chat' | 'manual'>(anchor.source, ['pdf', 'blocks', 'ai-chat', 'manual']);
      if (own(anchor, 'blockId')) next.blockId = anchor.blockId === null ? null : identifier(anchor.blockId);
      if (own(anchor, 'pageIndex')) next.pageIndex = anchor.pageIndex === null ? null : integer(anchor.pageIndex, 0, 999_999);
      if (own(anchor, 'pdfLocation')) next.pdfLocation = location(anchor.pdfLocation);
      if (next.pageIndex !== undefined && next.pageIndex !== null && next.pdfLocation && next.pageIndex + 1 !== next.pdfLocation.pageNumber) fail();
      return next;
    }),
    tags: uniqueStrings(raw.tags, (entry) => string(entry, 128, 1)), color: color(raw.color), isFavorite: boolean(raw.isFavorite), isPinned: boolean(raw.isPinned),
    linkedNoteIds: uniqueStrings(raw.linkedNoteIds), linkedPaperIds: uniqueStrings(raw.linkedPaperIds, paperReferenceId),
    createdAt: integer(raw.createdAt), updatedAt: integer(raw.updatedAt),
    unresolvedReferences: array(raw.unresolvedReferences, (entry): RichNoteUnresolvedReference => {
      const reference = object(entry, ['kind', 'id', 'label', 'reason']);
      const kind = choice<RichNoteUnresolvedReference['kind']>(reference.kind, ['note', 'paper', 'folder', 'ai-chat']), id = identifier(reference.id), prefixed = parseRichNoteUnresolvedId(id);
      if (prefixed && prefixed.kind !== kind) fail();
      return { kind, id, label: string(reference.label), reason: choice(reference.reason, ['unmapped', 'missing', 'historical-unverified']) };
    }),
  };
  if (result.updatedAt < result.createdAt || new Set(result.anchors.map((anchor) => anchor.id)).size !== result.anchors.length) fail();
  const unresolvedKeys = result.unresolvedReferences.map((entry) => `${entry.kind}:${entry.id}`);
  if (new Set(unresolvedKeys).size !== unresolvedKeys.length) fail();
  if (own(raw, 'excerpt')) result.excerpt = string(raw.excerpt, 65_536);
  if (own(raw, 'pdfLocation')) result.pdfLocation = location(raw.pdfLocation);
  if (own(raw, 'aiChatId')) result.aiChatId = identifier(raw.aiChatId);
  if (own(raw, 'aiChatMessageIds')) result.aiChatMessageIds = uniqueStrings(raw.aiChatMessageIds);
  if (own(raw, 'linkedPaperId')) result.linkedPaperId = raw.linkedPaperId === null ? null : paperReferenceId(raw.linkedPaperId);
  if (own(raw, 'folderId')) result.folderId = raw.folderId === null ? null : identifier(raw.folderId);
  return result;
}

// Synchronous portable SHA-256 keeps semantic validation usable by the sync validator.
// It hashes only bounded decoded image bytes; it is not an authentication mechanism.
const SHA_K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function sha256(bytes: Uint8Array): string {
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64); data.set(bytes); data[bytes.length] = 128;
  const view = new DataView(data.buffer); view.setUint32(data.length - 4, bytes.length * 8);
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const w = new Uint32Array(64), rotate = (v: number, n: number) => v >>> n | v << 32 - n;
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) w[i] = (rotate(w[i-2],17)^rotate(w[i-2],19)^w[i-2]>>>10) + w[i-7] + (rotate(w[i-15],7)^rotate(w[i-15],18)^w[i-15]>>>3) + w[i-16];
    let [a,b,c,d,e,f,g,z] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = z + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + (e&f^~e&g) + SHA_K[i] + w[i];
      const t2 = (rotate(a,2)^rotate(a,13)^rotate(a,22)) + (a&b^a&c^b&c);
      z=g;g=f;f=e;e=d+t1|0;d=c;c=b;b=a;a=t1+t2|0;
    }
    [a,b,c,d,e,f,g,z].forEach((value, i) => { h[i] = h[i] + value | 0; });
  }
  return h.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
}
function assets(input: unknown): RichNoteAsset[] {
  let pixels = 0;
  const result = array(input, (entry): RichNoteAsset => {
    const raw = object(entry, ['id', 'mediaType', 'base64', 'sha256', 'sizeBytes', 'width', 'height']);
    const id = hash(raw.id), digest = hash(raw.sha256), sizeBytes = integer(raw.sizeBytes, 1, RICH_NOTE_LIMITS.assetBytes);
    if (id !== digest) fail('INVALID_ASSET');
    const base64 = string(raw.base64, Math.ceil(RICH_NOTE_LIMITS.assetBytes / 3) * 4, 4);
    if (base64.length !== Math.ceil(sizeBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) fail('INVALID_ASSET');
    let decoded: string; try { decoded = atob(base64); } catch { return fail('INVALID_ASSET'); }
    if (decoded.length !== sizeBytes || btoa(decoded) !== base64) fail('INVALID_ASSET');
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (sha256(bytes) !== digest) fail('ASSET_INTEGRITY');
    let info: ReturnType<typeof inspectParsedImage>; try { info = inspectParsedImage(bytes); } catch { return fail('INVALID_ASSET'); }
    const mediaType = choice(raw.mediaType, ['image/png', 'image/jpeg', 'image/webp']);
    const width = integer(raw.width, 1, 8192), height = integer(raw.height, 1, 8192);
    if (mediaType !== info.mediaType || width !== info.width || height !== info.height || width * height > RICH_NOTE_LIMITS.assetPixels
      || (pixels += width * height) > RICH_NOTE_LIMITS.totalAssetPixels) fail('INVALID_ASSET');
    return { id, mediaType, base64, sha256: digest, sizeBytes, width, height };
  }, RICH_NOTE_LIMITS.assets);
  if (new Set(result.map((entry) => entry.id)).size !== result.length) fail('INVALID_ASSET');
  return result;
}

function textFrom(node: RichNoteNode): string {
  const attrs = node.attrs ?? {}, children = node.content ?? [];
  if (node.type === 'text') return node.text!;
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'inlineMath' || node.type === 'blockMath') return String(attrs.latex);
  if (node.type === 'image') return String(attrs.alt ?? attrs.title ?? '');
  if (node.type === 'noteAnchorBlock') return [attrs.label, attrs.sourceLabel, attrs.sourceTitle, attrs.excerpt].filter((value) => typeof value === 'string' && value).join('\n');
  if (node.type === 'noteAnchorLink') return String(attrs.label ?? '定位');
  if (node.type === 'wikiLink') return `[[${attrs.label ?? attrs.id ?? ''}]]`;
  if (node.type === 'hashTag') return `#${attrs.tag ?? ''}`;
  if (node.type === 'paperReference') return `@${attrs.label ?? attrs.paperId ?? ''}`;
  if (node.type === 'horizontalRule') return '';
  const separator = node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock' ? '' : node.type === 'tableRow' ? '\t' : '\n';
  const text = children.map(textFrom).join(separator);
  return node.type === 'noteComponentBlock' && attrs.title ? `${attrs.title}\n${text}` : text;
}
/** Deterministic searchable text; never a replacement for the rich document. */
export function richNoteText(document: unknown): string {
  inspect(document); const checked = node(document); if (checked.type !== 'doc') fail();
  const result = textFrom(checked); if (result.length > RICH_NOTE_LIMITS.bodyCharacters) fail('NOTE_LIMIT'); return result;
}
function references(document: RichNoteNode, meta: RichNoteMetadata, resources: RichNoteAsset[]): void {
  const ids = new Set(resources.map((entry) => entry.id)), used = new Set<string>(), anchors = new Set(meta.anchors.map((anchor) => anchor.id));
  const unresolved = (kind: RichNoteUnresolvedReference['kind'], id: string) => meta.unresolvedReferences.some((entry) => entry.kind === kind && entry.id === id);
  const checkPrefixed = (value: unknown, kind: RichNoteUnresolvedReference['kind']) => {
    if (typeof value !== 'string') return;
    const prefixed = parseRichNoteUnresolvedId(value);
    if (prefixed && (prefixed.kind !== kind || !unresolved(kind, value))) fail();
  };
  for (const id of meta.linkedNoteIds) checkPrefixed(id, 'note');
  for (const id of meta.linkedPaperIds) checkPrefixed(id, 'paper');
  checkPrefixed(meta.linkedPaperId, 'paper'); checkPrefixed(meta.folderId, 'folder'); checkPrefixed(meta.aiChatId, 'ai-chat');
  for (const anchor of meta.anchors) checkPrefixed(anchor.paperId, 'paper');
  const walk = (current: RichNoteNode) => {
    const attrs = current.attrs ?? {};
    if (current.type === 'wikiLink') checkPrefixed(attrs.id, 'note');
    if (current.type === 'paperReference') checkPrefixed(attrs.paperId, 'paper');
    if (current.type === 'image') { const id = String(attrs.src).slice(13); if (!ids.has(id)) fail('INVALID_ASSET'); used.add(id); }
    if (current.type === 'noteAnchorBlock' || current.type === 'noteAnchorLink') { if (typeof attrs.anchorId !== 'string' || !anchors.has(attrs.anchorId)) fail(); }
    if (current.type === 'wikiLink' || current.type === 'paperReference') {
      const kind = current.type === 'wikiLink' ? 'note' : 'paper', id = current.type === 'wikiLink' ? attrs.id : attrs.paperId;
      const known = kind === 'note' ? meta.linkedNoteIds : meta.linkedPaperIds;
      if (typeof id === 'string') { if (!known.includes(id) && !unresolved(kind, id)) fail(); }
      else if (typeof attrs.label !== 'string' || !attrs.label || !meta.unresolvedReferences.some((entry) => entry.kind === kind && entry.label === attrs.label)) fail();
    }
    if (current.type === 'hashTag' && (typeof attrs.tag !== 'string' || !attrs.tag)) fail();
    for (const child of current.content ?? []) walk(child);
  };
  walk(document);
  if (used.size !== ids.size) fail('INVALID_ASSET');
}
/** Returns detached, fixed-key-order data. Every asset hash is checked synchronously. */
export function validateRichNoteData(value: unknown): RichNoteData {
  inspect(value);
  const raw = object(value, ['paperId', 'title', 'body', 'format', 'document', 'metadata', 'assets']);
  if (raw.format !== 'tiptap-json') fail();
  const document = node(raw.document); if (document.type !== 'doc') fail();
  const body = string(raw.body, RICH_NOTE_LIMITS.bodyCharacters);
  if (body !== textFrom(document)) fail('BODY_MISMATCH');
  const result: RichNoteData = { paperId: raw.paperId === null ? null : uuid(raw.paperId), title: string(raw.title), body, format: 'tiptap-json', document, metadata: metadata(raw.metadata), assets: assets(raw.assets) };
  references(document, result.metadata, result.assets);
  if (encoder.encode(JSON.stringify(result)).byteLength > RICH_NOTE_LIMITS.entityBytes) fail('NOTE_LIMIT');
  return result;
}
/** Requires an already explicit resource conversion; never fetches or drops content. */
export function createRichNoteData(input: CreateRichNoteInput): RichNoteData {
  inspect(input); const raw = object(input, ['paperId', 'title', 'document', 'metadata', 'assets']);
  return validateRichNoteData({ paperId: raw.paperId, title: raw.title, body: richNoteText(raw.document), format: 'tiptap-json', document: raw.document, metadata: raw.metadata, assets: raw.assets });
}

/** Rebind only explicit source identities. Existing unresolved references stay
 * unresolved unless the caller is resolving its own temporary capture aliases.
 * A null result is encoded with the original source id, never guessed by UUID. */
export function remapRichNoteReferences(value: RichNoteData,
  resolve: (kind: RichNoteUnresolvedReference['kind'], sourceId: string, wasUnresolved: boolean) => string | null,
  options: { rebindUnresolved?: boolean; paperId?: string | null } = {}): RichNoteData {
  const source = validateRichNoteData(value), descriptions = new Map(source.metadata.unresolvedReferences.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
  const cache = new Map<string, string>();
  const rebind = (kind: RichNoteUnresolvedReference['kind'], id: string, label = ''): string => {
    const key = `${kind}:${id}`, previous = cache.get(key); if (previous) return previous;
    const prefixed = parseRichNoteUnresolvedId(id), original = prefixed?.sourceId ?? id, description = descriptions.get(key);
    let target: string | null = null;
    if (options.rebindUnresolved || !prefixed && !description) {
      try { target = resolve(kind, original, Boolean(prefixed || description)); } catch { fail(); }
      if (target !== null) uuid(target);
    }
    if (target === null) {
      target = prefixed ? id : richNoteUnresolvedId(kind, original);
      descriptions.delete(key);
      descriptions.set(`${kind}:${target}`, { kind, id: target, label: description?.label || label || original, reason: description?.reason ?? 'unmapped' });
    } else descriptions.delete(key);
    cache.set(key, target); return target;
  };
  const walk = (node: RichNoteNode) => {
    if (node.type === 'wikiLink' && typeof node.attrs?.id === 'string') node.attrs.id = rebind('note', node.attrs.id, String(node.attrs.label || ''));
    if (node.type === 'paperReference' && typeof node.attrs?.paperId === 'string') node.attrs.paperId = rebind('paper', node.attrs.paperId, String(node.attrs.label || ''));
    for (const child of node.content ?? []) walk(child);
  };
  walk(source.document);
  source.metadata.linkedNoteIds = [...new Set(source.metadata.linkedNoteIds.map((id) => rebind('note', id)))];
  source.metadata.linkedPaperIds = [...new Set(source.metadata.linkedPaperIds.map((id) => rebind('paper', id)))];
  if (source.metadata.linkedPaperId) source.metadata.linkedPaperId = rebind('paper', source.metadata.linkedPaperId);
  if (source.metadata.folderId) source.metadata.folderId = rebind('folder', source.metadata.folderId);
  if (source.metadata.aiChatId) source.metadata.aiChatId = rebind('ai-chat', source.metadata.aiChatId);
  for (const anchor of source.metadata.anchors) if (anchor.paperId) anchor.paperId = rebind('paper', anchor.paperId, anchor.sourceTitle);
  source.metadata.unresolvedReferences = [...descriptions.values()];
  return createRichNoteData({ paperId: options.paperId === undefined ? source.paperId : options.paperId, title: source.title,
    document: source.document, metadata: source.metadata, assets: source.assets });
}

const s = (maximum = 2048): JsonSchema => ({ type: 'string', maxLength: maximum });
const obj = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const list = (items: JsonSchema, maxItems: number = RICH_NOTE_LIMITS.references): JsonSchema => ({ type: 'array', items, maxItems });
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [{ type: 'null' }, schema] });
const idSchema: JsonSchema = { type: 'string', pattern: ID.source };
const uuidSchema: JsonSchema = { type: 'string', pattern: UUID.source };
const paperReferenceSchema: JsonSchema = { anyOf: [uuidSchema, { type: 'string', maxLength: 128, pattern: '^unresolved:paper:[A-Za-z0-9][A-Za-z0-9._:-]*$' }] };
const integerSchema: JsonSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const numberSchema: JsonSchema = { type: 'number', minimum: -1_000_000, maximum: 1_000_000 };
const locationSchema = obj({ pageNumber: { ...integerSchema, minimum: 1 }, boundingRect: obj({ x: numberSchema, y: numberSchema, width: numberSchema, height: numberSchema }), bbox: { ...list(numberSchema, 4), minItems: 4 }, bboxCoordinateSystem: { enum: ['pdf', 'normalized-1000'] }, bboxPageSize: { ...list(numberSchema, 2), minItems: 2 }, highlightColor: s(64) }, ['pageNumber']);
const anchorSchema = obj({ id: idSchema, label: s(), excerpt: s(65_536), createdAt: integerSchema, verification: { const: 'unverified' }, paperId: paperReferenceSchema, sourceTitle: s(), source: { enum: ['pdf', 'blocks', 'ai-chat', 'manual'] }, blockId: nullable(idSchema), pageIndex: nullable(integerSchema), pdfLocation: locationSchema }, ['id', 'label', 'excerpt', 'createdAt', 'verification']);
const metadataSchema = obj({ type: { enum: ['highlight', 'area', 'standalone', 'ai-chat'] }, anchors: list(anchorSchema), tags: list(s(128)), color: s(64), isFavorite: { type: 'boolean' }, isPinned: { type: 'boolean' }, linkedNoteIds: list(idSchema), linkedPaperIds: list(paperReferenceSchema), createdAt: integerSchema, updatedAt: integerSchema,
  unresolvedReferences: list(obj({ kind: { enum: ['note', 'paper', 'folder', 'ai-chat'] }, id: idSchema, label: s(), reason: { enum: ['unmapped', 'missing', 'historical-unverified'] } })), excerpt: s(65_536), pdfLocation: locationSchema, aiChatId: idSchema, aiChatMessageIds: list(idSchema), linkedPaperId: nullable(paperReferenceSchema), folderId: nullable(idSchema) },
['type', 'anchors', 'tags', 'color', 'isFavorite', 'isPinned', 'linkedNoteIds', 'linkedPaperIds', 'createdAt', 'updatedAt', 'unresolvedReferences']);
const assetSchema = obj({ id: { type: 'string', pattern: HASH.source }, mediaType: { enum: ['image/png', 'image/jpeg', 'image/webp'] }, base64: s(Math.ceil(RICH_NOTE_LIMITS.assetBytes / 3) * 4), sha256: { type: 'string', pattern: HASH.source }, sizeBytes: { ...integerSchema, minimum: 1, maximum: RICH_NOTE_LIMITS.assetBytes }, width: { ...integerSchema, minimum: 1, maximum: 8192 }, height: { ...integerSchema, minimum: 1, maximum: 8192 } });
/** Envelope schema only. Call validateRichNoteData for recursive grammar, references,
 * derived text, UTF-8 budget, image bytes and hashes. JsonSchema has no recursive refs. */
export const RICH_NOTE_DATA_SCHEMA: JsonSchema = obj({ paperId: nullable(uuidSchema), title: s(), body: s(RICH_NOTE_LIMITS.bodyCharacters), format: { const: 'tiptap-json' }, document: obj({ type: { const: 'doc' }, attrs: obj({}), content: list({ type: 'object', additionalProperties: true }, RICH_NOTE_LIMITS.nodes) }, ['type', 'content']), metadata: metadataSchema, assets: list(assetSchema, RICH_NOTE_LIMITS.assets) });
