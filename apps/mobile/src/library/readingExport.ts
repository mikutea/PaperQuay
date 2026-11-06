import {
  canonicalJson, ENTITY_DATA_SCHEMAS, ENTITY_TYPES, isPlainObject, SYNC_LIMITS, UUID_PATTERN,
  validateEntityData, validateJsonSchema,
  type AnnotationData, type AttachmentVersionData, type JsonSchema, type NoteData, type PaperData, type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import { RICH_NOTE_DATA_SCHEMA, RICH_NOTE_LIMITS, validateRichNoteData,
  type RichNoteAsset, type RichNoteData, type RichNoteMetadata, type RichNoteNode } from '../../../../packages/sync-core/src/richNote.ts';
import { escapeReadingMarkdown, formatPaperQuayReference, PAPERQUAY_CITATION_STYLE } from './citationTransfer.ts';

export const READING_EXPORT_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024, maxPapers: 500, maxVersions: 1000, maxNotes: 500, maxAnnotations: 2000, maxJsonDepth: 40,
});
export type ReadingExportErrorCode = 'INVALID_DATA' | 'INVALID_SELECTION' | 'UNSUPPORTED_NOTE_FORMAT' | 'UNSUPPORTED_RICH_NOTE'
  | 'EXPORT_TOO_LARGE' | 'TOO_MANY_ITEMS' | 'INVALID_JSON' | 'INVALID_ARCHIVE' | 'UNSUPPORTED_FORMAT';
export class ReadingExportError extends Error {
  constructor(readonly code: ReadingExportErrorCode) { super(code); this.name = 'ReadingExportError'; }
}
export interface ReadingExportSelection {
  paperId?: string | null;
  paperTag?: string | null;
  /** Applies only to annotations. Notes do not acquire a verified PDF version binding. */
  attachmentVersionId?: string | null;
  includeNotes?: boolean;
  includeAnnotations?: boolean;
  /** Independent notes are eligible only when no paper or paper-tag filter is active. */
  includeStandalone?: boolean;
  query?: string;
}
export type ReadingSavedState = 'synced' | 'pending' | 'conflict' | 'rejected' | 'device-blocked';
export type ReadingReferenceStatus = 'available' | 'missing' | 'deleted';
export type ReadingAnnotationIssue = 'PAPER_UNAVAILABLE' | 'VERSION_UNAVAILABLE' | 'VERSION_PAPER_MISMATCH'
  | 'PAGE_OUT_OF_RANGE' | 'PAGE_COUNT_UNKNOWN';
export type ReadingPaperMetadata = Omit<PaperData, 'organization'>;
export interface ReadingExportPaper {
  ref: string; status: ReadingReferenceStatus; savedState: ReadingSavedState | null;
  data: ReadingPaperMetadata | null;
  citation: { label: string; text: string } | null;
}
export interface ReadingExportVersion {
  ref: string; paperRef: string | null; status: ReadingReferenceStatus; savedState: ReadingSavedState | null;
  data: Pick<AttachmentVersionData, 'sha256' | 'sizeBytes' | 'mediaType' | 'fileName' | 'pageCount'> | null;
}
export interface ReadingExportMarkdownNote {
  ref: string; paperRef: string | null; savedState: ReadingSavedState;
  title: string; format: 'markdown'; body: string;
}
export interface ReadingExportRichNote {
  ref: string; paperRef: string | null; savedState: ReadingSavedState;
  title: string; format: 'tiptap-json'; body: string;
  /** Original primary reference; metadata/AST reference identifiers also remain verbatim. */
  sourcePaperId: string | null;
  document: RichNoteNode; metadata: RichNoteMetadata; assets: RichNoteAsset[];
}
export type ReadingExportNote = ReadingExportMarkdownNote | ReadingExportRichNote;
export interface ReadingExportAnnotation {
  ref: string; paperRef: string; versionRef: string; savedState: ReadingSavedState;
  kind: AnnotationData['kind']; color: string; comment: string; anchor: AnnotationData['anchor']; issues: ReadingAnnotationIssue[];
}
export interface ReadingExportArchive {
  format: 'paperquay-reading-summary'; version: 1 | 2;
  evidence: { pdf: 'not-included'; hash: 'saved-version-metadata'; citationStyle: typeof PAPERQUAY_CITATION_STYLE;
    richContent?: 'complete-tiptap-json-and-metadata'; richReferences?: 'original-identifiers-not-rebound';
    images?: 'embedded-base64-sha256-verified' };
  scope: { paperRef: string | null; paperTag: string | null; versionRef: string | null;
    includeNotes: boolean; includeAnnotations: boolean; includeStandalone: boolean; query: string };
  papers: ReadingExportPaper[];
  versions: ReadingExportVersion[];
  notes: ReadingExportNote[];
  annotations: ReadingExportAnnotation[];
}
export interface ReadingExportSummary {
  papers: number; versions: number; notes: number; annotations: number; standaloneNotes: number;
  unresolvedNotes: number; unresolvedAnnotations: number; pending: number; conflicts: number; omittedDeleted: number;
  richNotes: number; embeddedImages: number; embeddedImageBytes: number;
}
export interface ReadingExportResult {
  archive: ReadingExportArchive; json: string; markdown: string; summary: ReadingExportSummary;
  /** Preview-only IDs/signature are not exported. v2 rich source references are intentionally preserved separately. */
  paperIds: string[]; signature: string;
}
export interface ReadingExportCatalog {
  papers: { id: string; title: string; tags: string[] }[];
  versions: { id: string; paperId: string; fileName: string; sha256: string }[];
  tags: string[];
}

const uuid = new RegExp(UUID_PATTERN);
const statusValues = ['synced', 'queued', 'sending', 'uncertain', 'conflict', 'rejected', 'device-blocked', 'overlay'];
const savedStates = ['synced', 'pending', 'conflict', 'rejected', 'device-blocked'] as const;
const referenceStates = ['available', 'missing', 'deleted'] as const;
const issueValues: ReadingAnnotationIssue[] = ['PAPER_UNAVAILABLE', 'VERSION_UNAVAILABLE', 'VERSION_PAPER_MISMATCH', 'PAGE_OUT_OF_RANGE', 'PAGE_COUNT_UNKNOWN'];
const fields = ['title', 'doi', 'year', 'publication', 'abstractText', 'authors', 'keywords'] as const;
const invalidControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
  type: 'object', properties, required, additionalProperties: false,
});
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [{ type: 'null' }, schema] });
const text = (maxLength: number, minLength = 0): JsonSchema => ({ type: 'string', minLength, maxLength });
const refSchema = (prefix: string): JsonSchema => ({ type: 'string', pattern: `^${prefix}[1-9][0-9]{0,5}$`, maxLength: 7 });
const stateSchema: JsonSchema = { enum: savedStates };
const metadataSchema = object(Object.fromEntries(fields.map((field) => [field, ENTITY_DATA_SCHEMAS.paper.properties![field]])));
const versionDataSchema = object(Object.fromEntries(['sha256', 'sizeBytes', 'mediaType', 'fileName', 'pageCount']
  .map((field) => [field, ENTITY_DATA_SCHEMAS.attachmentVersion.properties![field]])));
const bool: JsonSchema = { type: 'boolean' };
const markdownNoteSchema = object({
  ref: refSchema('n'), paperRef: nullable(refSchema('p')), savedState: stateSchema,
  title: text(SYNC_LIMITS.maxTitleLength), format: { const: 'markdown' }, body: text(SYNC_LIMITS.maxNoteBodyLength),
});
const richNoteSchema = object({
  ref: refSchema('n'), paperRef: nullable(refSchema('p')), savedState: stateSchema,
  title: RICH_NOTE_DATA_SCHEMA.properties!.title, format: { const: 'tiptap-json' }, body: text(RICH_NOTE_LIMITS.bodyCharacters),
  sourcePaperId: RICH_NOTE_DATA_SCHEMA.properties!.paperId, document: RICH_NOTE_DATA_SCHEMA.properties!.document,
  metadata: RICH_NOTE_DATA_SCHEMA.properties!.metadata, assets: RICH_NOTE_DATA_SCHEMA.properties!.assets,
});
const archiveSchema = object({
  format: { const: 'paperquay-reading-summary' }, version: { const: 1 },
  evidence: object({ pdf: { const: 'not-included' }, hash: { const: 'saved-version-metadata' }, citationStyle: { const: PAPERQUAY_CITATION_STYLE } }),
  scope: object({ paperRef: nullable(refSchema('p')), paperTag: nullable(text(80, 1)), versionRef: nullable(refSchema('v')),
    includeNotes: bool, includeAnnotations: bool, includeStandalone: bool, query: text(512) }),
  papers: { type: 'array', maxItems: READING_EXPORT_LIMITS.maxPapers, items: object({
    ref: refSchema('p'), status: { enum: referenceStates }, savedState: nullable(stateSchema), data: nullable(metadataSchema),
    citation: nullable(object({ label: { type: 'string', pattern: '^\\[[1-9][0-9]{0,5}\\]$', maxLength: 8 }, text: text(131072, 1) })),
  }) },
  versions: { type: 'array', maxItems: READING_EXPORT_LIMITS.maxVersions, items: object({
    ref: refSchema('v'), paperRef: nullable(refSchema('p')), status: { enum: referenceStates }, savedState: nullable(stateSchema), data: nullable(versionDataSchema),
  }) },
  notes: { type: 'array', maxItems: READING_EXPORT_LIMITS.maxNotes, items: markdownNoteSchema },
  annotations: { type: 'array', maxItems: READING_EXPORT_LIMITS.maxAnnotations, items: object({
    ref: refSchema('a'), paperRef: refSchema('p'), versionRef: refSchema('v'), savedState: stateSchema,
    kind: ENTITY_DATA_SCHEMAS.annotation.properties!.kind, color: ENTITY_DATA_SCHEMAS.annotation.properties!.color,
    comment: ENTITY_DATA_SCHEMAS.annotation.properties!.comment, anchor: ENTITY_DATA_SCHEMAS.annotation.properties!.anchor,
    issues: { type: 'array', maxItems: issueValues.length, items: { enum: issueValues } },
  }) },
});
const archiveSchemaV2 = object({ ...archiveSchema.properties!, version: { const: 2 },
  evidence: object({ ...archiveSchema.properties!.evidence.properties!,
    richContent: { const: 'complete-tiptap-json-and-metadata' }, richReferences: { const: 'original-identifiers-not-rebound' },
    images: { const: 'embedded-base64-sha256-verified' } }),
  notes: { type: 'array', maxItems: READING_EXPORT_LIMITS.maxNotes, items: { oneOf: [markdownNoteSchema, richNoteSchema] } },
});
const selectionSchema = object({
  paperId: nullable({ type: 'string', pattern: UUID_PATTERN }), paperTag: nullable(text(80, 1)),
  attachmentVersionId: nullable({ type: 'string', pattern: UUID_PATTERN }),
  includeNotes: bool, includeAnnotations: bool, includeStandalone: bool, query: text(512),
}, []);

function dataObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
}
function checkText(value: string, error: ReadingExportErrorCode = 'INVALID_DATA'): void {
  if (invalidControls.test(value)) throw new ReadingExportError(error);
  try { encodeURIComponent(value); } catch { throw new ReadingExportError(error); }
}
function checkBytes(value: string): void {
  if (value.length > READING_EXPORT_LIMITS.maxBytes || new TextEncoder().encode(value).byteLength > READING_EXPORT_LIMITS.maxBytes) {
    throw new ReadingExportError('EXPORT_TOO_LARGE');
  }
}
function paperMetadata(data: PaperData): ReadingPaperMetadata {
  for (const field of fields) {
    const values = Array.isArray(data[field]) ? data[field] as string[] : [data[field]];
    for (const value of values) if (value !== null) checkText(value as string);
  }
  return Object.fromEntries(fields.map((field) => [field, clone(data[field])])) as unknown as ReadingPaperMetadata;
}
function savedState(entity: VisibleEntity): ReadingSavedState {
  if (entity.status === 'conflict' || entity.status === 'rejected' || entity.status === 'device-blocked') return entity.status;
  return entity.pending || entity.status !== 'synced' ? 'pending' : 'synced';
}
interface IndexedEntities {
  all: VisibleEntity[]; papers: Map<string, VisibleEntity>; versions: Map<string, VisibleEntity>;
  notes: VisibleEntity[]; annotations: VisibleEntity[];
}
function indexEntities(entities: readonly VisibleEntity[]): IndexedEntities {
  if (!Array.isArray(entities) || entities.length > SYNC_LIMITS.maxLocalEntities) throw new ReadingExportError('INVALID_DATA');
  const index: IndexedEntities = { all: [], papers: new Map(), versions: new Map(), notes: [], annotations: [] };
  const identities = new Set<string>();
  for (let position = 0; position < entities.length; position++) {
    const descriptor = Object.getOwnPropertyDescriptor(entities, position);
    if (!descriptor || !('value' in descriptor) || !dataObject(descriptor.value)) throw new ReadingExportError('INVALID_DATA');
    const candidate = descriptor.value;
    if (!ENTITY_TYPES.includes(candidate.entityType as VisibleEntity['entityType']) || typeof candidate.entityId !== 'string' || !uuid.test(candidate.entityId)
      || typeof candidate.deleted !== 'boolean' || typeof candidate.pending !== 'boolean' || !Number.isSafeInteger(candidate.revision)
      || (candidate.revision as number) < 0 || typeof candidate.status !== 'string' || !statusValues.includes(candidate.status)) throw new ReadingExportError('INVALID_DATA');
    const identity = `${candidate.entityType}:${candidate.entityId}`;
    if (identities.has(identity)) throw new ReadingExportError('INVALID_DATA');
    identities.add(identity);
    const entity = candidate as unknown as VisibleEntity;
    index.all.push(entity);
    if (entity.entityType === 'paper' || entity.entityType === 'attachmentVersion') {
      if (!entity.deleted && !validateEntityData(entity.entityType, entity.data).ok) throw new ReadingExportError('INVALID_DATA');
      if (entity.entityType === 'paper') index.papers.set(entity.entityId, entity); else index.versions.set(entity.entityId, entity);
    } else if (entity.entityType === 'note' || entity.entityType === 'annotation') {
      if (!entity.deleted && !dataObject(entity.data)) throw new ReadingExportError('INVALID_DATA');
      (entity.entityType === 'note' ? index.notes : index.annotations).push(entity);
    }
  }
  return index;
}

/** Catalog contains current paper labels and saved version descriptors, never note bodies. */
export function readingExportCatalog(entities: readonly VisibleEntity[]): ReadingExportCatalog {
  const index = indexEntities(entities);
  const papers = [...index.papers.values()].filter((entity) => !entity.deleted).sort((a, b) => compare(a.entityId, b.entityId)).map((entity) => {
    const data = entity.data as PaperData;
    return { id: entity.entityId, title: data.title, tags: [...(data.organization?.tags ?? [])] };
  });
  const versions = [...index.versions.values()].filter((entity) => !entity.deleted).sort((a, b) => compare(a.entityId, b.entityId)).map((entity) => {
    const data = entity.data as AttachmentVersionData;
    return { id: entity.entityId, paperId: data.paperId, fileName: data.fileName, sha256: data.sha256 };
  });
  return { papers, versions, tags: [...new Set(papers.flatMap((paper) => paper.tags))].sort(compare) };
}

function annotationIssues(paper: ReadingExportPaper, version: ReadingExportVersion, annotation: Pick<ReadingExportAnnotation, 'paperRef' | 'anchor'>): ReadingAnnotationIssue[] {
  const issues: ReadingAnnotationIssue[] = [];
  if (paper.status !== 'available') issues.push('PAPER_UNAVAILABLE');
  if (version.status !== 'available') issues.push('VERSION_UNAVAILABLE');
  else {
    if (version.paperRef !== annotation.paperRef) issues.push('VERSION_PAPER_MISMATCH');
    if (version.data!.pageCount === null) issues.push('PAGE_COUNT_UNKNOWN');
    else if (annotation.anchor.pageIndex >= version.data!.pageCount) issues.push('PAGE_OUT_OF_RANGE');
  }
  return issues;
}
function noteFormat(value: unknown, error: ReadingExportErrorCode = 'UNSUPPORTED_NOTE_FORMAT'): void {
  if (value === 'rich-v2') throw new ReadingExportError('UNSUPPORTED_RICH_NOTE');
  if (value !== 'markdown' && value !== 'tiptap-json') throw new ReadingExportError(error);
}
function richOriginal(note: ReadingExportRichNote): RichNoteData {
  return { paperId: note.sourcePaperId, title: note.title, body: note.body, format: 'tiptap-json',
    document: note.document, metadata: note.metadata, assets: note.assets };
}

/** Validates a closed report with resolvable file-local references. This is not a sync/import archive. */
export function validateReadingExportArchive(value: unknown): ReadingExportArchive {
  const schema = dataObject(value) && value.version === 2 ? archiveSchemaV2 : archiveSchema;
  const checked = validateJsonSchema<ReadingExportArchive>(schema, value);
  if (!checked.ok) {
    const unsupported = checked.issues.some((issue) => (issue.path === '$.format' || issue.path === '$.version') && issue.code === 'INVALID_CONSTANT');
    throw new ReadingExportError(unsupported ? 'UNSUPPORTED_FORMAT' : 'INVALID_ARCHIVE');
  }
  const archive = checked.value;
  const papers = new Map<string, ReadingExportPaper>(); const versions = new Map<string, ReadingExportVersion>();
  const noteRefs = new Set<string>(); const annotationRefs = new Set<string>(); let citation = 0;
  const invalid = () => { throw new ReadingExportError('INVALID_ARCHIVE'); };
  for (const paper of archive.papers) {
    if (papers.has(paper.ref)) invalid();
    papers.set(paper.ref, paper);
    if (paper.status === 'available') {
      if (!paper.data || !paper.savedState || !paper.citation) invalid();
      if (paper.citation!.label !== `[${++citation}]` || paper.citation!.text !== formatPaperQuayReference(paper.data!)) invalid();
      paperMetadata(paper.data!);
    } else if (paper.data !== null || paper.citation !== null || paper.savedState !== null) invalid();
  }
  for (const version of archive.versions) {
    if (versions.has(version.ref)) invalid();
    versions.set(version.ref, version);
    if (version.status === 'available') {
      if (!version.data || !version.paperRef || !papers.has(version.paperRef) || !version.savedState) invalid();
      checkText(version.data!.fileName, 'INVALID_ARCHIVE');
    } else if (version.data !== null || version.paperRef !== null || version.savedState !== null) invalid();
  }
  if (archive.scope.paperRef !== null && !papers.has(archive.scope.paperRef)
    || archive.scope.versionRef !== null && !versions.has(archive.scope.versionRef)) invalid();
  if (archive.scope.versionRef !== null && (archive.scope.paperRef === null
    || versions.get(archive.scope.versionRef)!.paperRef !== archive.scope.paperRef)) invalid();
  if (!archive.scope.includeNotes && archive.notes.length || !archive.scope.includeAnnotations && archive.annotations.length) invalid();
  checkText(archive.scope.query, 'INVALID_ARCHIVE');
  if (archive.scope.paperTag !== null) checkText(archive.scope.paperTag, 'INVALID_ARCHIVE');
  for (const note of archive.notes) {
    if (noteRefs.has(note.ref) || note.paperRef !== null && !papers.has(note.paperRef)) invalid();
    if (note.paperRef === null && !archive.scope.includeStandalone) invalid();
    if (archive.scope.paperRef !== null && note.paperRef !== archive.scope.paperRef) invalid();
    noteRefs.add(note.ref); checkText(note.title, 'INVALID_ARCHIVE'); checkText(note.body, 'INVALID_ARCHIVE');
    if (note.format === 'tiptap-json') {
      if (archive.version !== 2 || (note.sourcePaperId === null) !== (note.paperRef === null)) invalid();
      // Envelope validation alone cannot check recursive nodes, references, exact derived text or image hashes.
      try { validateRichNoteData(richOriginal(note)); } catch { invalid(); }
    }
  }
  for (const annotation of archive.annotations) {
    const paper = papers.get(annotation.paperRef); const version = versions.get(annotation.versionRef);
    if (annotationRefs.has(annotation.ref) || !paper || !version) invalid();
    if (archive.scope.paperRef !== null && annotation.paperRef !== archive.scope.paperRef
      || archive.scope.versionRef !== null && annotation.versionRef !== archive.scope.versionRef) invalid();
    annotationRefs.add(annotation.ref);
    if (canonicalJson(annotation.issues) !== canonicalJson(annotationIssues(paper!, version!, annotation))) invalid();
    checkText(annotation.comment, 'INVALID_ARCHIVE');
    if (annotation.anchor.quote) for (const value of Object.values(annotation.anchor.quote)) checkText(value, 'INVALID_ARCHIVE');
  }
  const serialized = canonicalJson(archive); checkBytes(serialized);
  return JSON.parse(serialized) as ReadingExportArchive;
}

export function parseReadingExport(text: string): ReadingExportArchive {
  if (typeof text !== 'string') throw new ReadingExportError('INVALID_JSON');
  checkBytes(text);
  let depth = 0; let quoted = false; let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > READING_EXPORT_LIMITS.maxJsonDepth) throw new ReadingExportError('INVALID_ARCHIVE'); }
    else if (char === '}' || char === ']') depth--;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ReadingExportError('INVALID_JSON'); }
  return validateReadingExportArchive(value);
}

/** Preserve each original body verbatim inside a fence longer than any fence in that body. */
function fenced(value: string, language = 'text'): string {
  let longest = 2;
  for (const run of value.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}\n`;
}
const issueMessages: Record<ReadingAnnotationIssue, string> = {
  PAPER_UNAVAILABLE: '关联文献不可用', VERSION_UNAVAILABLE: '附件版本不可用', VERSION_PAPER_MISMATCH: '文献与附件版本不匹配',
  PAGE_OUT_OF_RANGE: '页码超出保存的页数', PAGE_COUNT_UNKNOWN: '保存的版本尚无页数',
};
const stateLabels: Record<ReadingSavedState, string> = { synced: '已同步', pending: '本机已保存，待处理', conflict: '存在同步冲突', rejected: '同步被拒绝', 'device-blocked': '设备被阻断' };
function renderMarkdown(archive: ReadingExportArchive, summary: ReadingExportSummary): string {
  const papers = new Map(archive.papers.map((paper) => [paper.ref, paper]));
  const versions = new Map(archive.versions.map((version) => [version.ref, version]));
  const label = (paperRef: string | null) => {
    if (paperRef === null) return '独立笔记';
    const paper = papers.get(paperRef)!;
    return paper.data ? `${paper.citation!.label} ${paper.data.title}` : `${paperRef} · 关联文献${paper.status === 'deleted' ? '已删除' : '不可用'}`;
  };
  const parts = ['# PaperQuay 阅读汇总\n',
    '> 仅包含当前可见的已保存笔记和批注，不包含未保存草稿或 PDF 文件。版本 SHA-256 来自已保存的版本元数据，本次导出没有重新读取或校验 PDF。\n',
    '> 引用采用 PaperQuay 编号格式，不是 APA、CSL 或 GB/T。笔记不绑定 PDF 版本；版本筛选只作用于批注。原始 Markdown 正文逐条放在独立代码块中，保留原文与来源边界。\n',
    `范围：${escapeReadingMarkdown(archive.scope.paperRef ? label(archive.scope.paperRef) : '全部文献')}`
      + `${archive.scope.paperTag ? `；关联文献标签：${escapeReadingMarkdown(archive.scope.paperTag)}` : ''}`
      + `${archive.scope.query ? `；检索：${escapeReadingMarkdown(archive.scope.query)}` : ''}`
      + `${archive.scope.versionRef ? `；批注版本：${archive.scope.versionRef}` : '；批注按保存的版本分别列出'}。\n`,
    `${summary.notes} 条笔记 · ${summary.annotations} 条批注 · ${summary.standaloneNotes} 条独立笔记。\n`];
  if (summary.richNotes) parts.push(`> 本文件含 ${summary.richNotes} 条富文本笔记和 ${summary.embeddedImages} 条嵌入图片记录。可读正文后附完整 TipTap 结构、元数据和 base64 图片，原始引用标识保留。历史锚点仍是未验证记录，不转换为新的 PDF 定位证据。\n`,
    '> 嵌入图片 SHA-256 已按保存的图片字节重新核验。图片数据放在结构化代码块内，不自动访问外部链接或本地文件。\n');
  if (summary.pending) parts.push(`> ${summary.pending} 项来源含待处理的本机内容，其中 ${summary.conflicts} 项存在同步冲突；导出保留此设备当前可见内容，不代替冲突处理。\n`);
  for (const note of archive.notes) {
    parts.push(`## 笔记 ${note.ref} · ${escapeReadingMarkdown(note.title || '未命名笔记')}\n`,
      `来源：${escapeReadingMarkdown(label(note.paperRef))}。状态：${stateLabels[note.savedState]}。格式：${note.format === 'markdown' ? '原始 Markdown' : '完整富文本'}。\n`);
    if (note.format === 'markdown') parts.push(fenced(note.body, 'markdown'));
    else {
      parts.push('### 可读正文\n', '> 下列为随富文本保存的可检索正文；样式、表格合并、数学结构、链接、锚点和图片均完整保留在后面的原始结构中。\n', fenced(note.body),
        '### 笔记元数据与图片清单\n', `类型：${note.metadata.type}；标签：${escapeReadingMarkdown(note.metadata.tags.join('；') || '无')}；`
          + `历史锚点：${note.metadata.anchors.length}；已记录的未解析引用：${note.metadata.unresolvedReferences.length}。\n`);
      for (const asset of note.assets) parts.push(`- ${asset.mediaType} · ${asset.width} × ${asset.height} · ${asset.sizeBytes} 字节 · SHA-256：\`${asset.sha256}\`\n`);
      if (!note.assets.length) parts.push('此笔记没有嵌入图片。\n');
      parts.push('### 完整富文本原始结构\n', '> 以下 JSON 含原始文献/笔记等内部引用标识、完整元数据和图片字节；不代表这些历史引用已重新绑定或验证。\n',
        fenced(JSON.stringify(richOriginal(note), null, 2), 'json'));
    }
    parts.push('---\n');
  }
  for (const annotation of archive.annotations) {
    const version = versions.get(annotation.versionRef)!;
    const kind = { highlight: '高亮', underline: '下划线', area: '区域批注' }[annotation.kind];
    parts.push(`## 批注 ${annotation.ref} · 第 ${annotation.anchor.pageIndex + 1} 页 · ${kind}\n`,
      `来源：${escapeReadingMarkdown(label(annotation.paperRef))}。状态：${stateLabels[annotation.savedState]}。\n`);
    if (version.data) parts.push(`附件版本：${version.ref} · ${escapeReadingMarkdown(version.data.fileName)}；${version.data.sizeBytes} 字节；`
      + `保存的页数：${version.data.pageCount ?? '未知'}。\n`, `SHA-256：\`${version.data.sha256}\`\n`);
    else parts.push(`附件版本：${version.ref} · ${version.status === 'deleted' ? '已删除' : '不可用'}；无法给出保存的 PDF 指纹。\n`);
    if (annotation.issues.length) parts.push(`> 定位提示：${annotation.issues.map((issue) => issueMessages[issue]).join('；')}。不推断替代版本。\n`);
    if (annotation.kind === 'area') parts.push('区域批注仅包含位置和评论；此文件没有裁剪图像。\n');
    if (annotation.anchor.quote) parts.push('摘录（保存时的原文）：\n', fenced(annotation.anchor.quote.exact),
      '摘录前文：\n', fenced(annotation.anchor.quote.prefix), '摘录后文：\n', fenced(annotation.anchor.quote.suffix));
    else parts.push('此批注没有保存文字摘录。\n');
    parts.push('评论（原文）：\n', fenced(annotation.comment, 'markdown'),
      `颜色：\`${annotation.color}\`；坐标：未旋转 PDF CropBox 归一化四边形，内部页码从 0 开始（${annotation.anchor.pageIndex}）。\n`,
      fenced(JSON.stringify(annotation.anchor.quads), 'json'), '---\n');
  }
  parts.push('## 参考文献 · PaperQuay 编号格式\n');
  for (const paper of archive.papers) if (paper.citation) parts.push(`${paper.citation.label} ${escapeReadingMarkdown(paper.citation.text)}\n`);
  if (!archive.papers.some((paper) => paper.citation)) parts.push('没有可用于生成引用的已保存题录。\n');
  const markdown = parts.join('\n'); checkBytes(markdown); return markdown;
}

/** Read-only report generation; no network, persistence, restoration, or automatic download. */
export function buildReadingExport(entities: readonly VisibleEntity[], selection: ReadingExportSelection = {}): ReadingExportResult {
  const checkedSelection = validateJsonSchema<ReadingExportSelection>(selectionSchema, selection);
  if (!checkedSelection.ok) throw new ReadingExportError('INVALID_SELECTION');
  const selected = { paperId: selection.paperId ?? null, paperTag: selection.paperTag ?? null,
    attachmentVersionId: selection.attachmentVersionId ?? null, includeNotes: selection.includeNotes ?? true,
    includeAnnotations: selection.includeAnnotations ?? true, includeStandalone: selection.includeStandalone ?? true, query: selection.query ?? '' };
  checkText(selected.query, 'INVALID_SELECTION');
  if (selected.paperTag !== null) checkText(selected.paperTag, 'INVALID_SELECTION');
  if (selected.paperId !== null || selected.paperTag !== null) selected.includeStandalone = false;
  const index = indexEntities(entities);
  const selectedPaper = selected.paperId === null ? null : index.papers.get(selected.paperId);
  if (selected.paperId !== null && (!selectedPaper || selectedPaper.deleted)) throw new ReadingExportError('INVALID_SELECTION');
  const selectedVersion = selected.attachmentVersionId === null ? null : index.versions.get(selected.attachmentVersionId);
  if (selected.attachmentVersionId !== null && (!selectedVersion || selectedVersion.deleted || selected.paperId === null
    || (selectedVersion.data as AttachmentVersionData).paperId !== selected.paperId)) throw new ReadingExportError('INVALID_SELECTION');
  const query = selected.query.trim().toLocaleLowerCase();
  const matchesPaper = (paperId: string | null) => {
    if (paperId === null) return selected.includeStandalone;
    if (selected.paperId !== null && paperId !== selected.paperId) return false;
    if (selected.paperTag !== null) {
      const paper = index.papers.get(paperId);
      return Boolean(paper && !paper.deleted && (paper.data as PaperData).organization?.tags.includes(selected.paperTag));
    }
    return true;
  };
  const matchesText = (values: string[]) => !query || values.some((value) => value.toLocaleLowerCase().includes(query));
  const noteEntities: (VisibleEntity & { data: NoteData })[] = [];
  const annotationEntities: (VisibleEntity & { data: AnnotationData })[] = [];
  let reservedBytes = 0;
  const reserve = (value: unknown) => {
    reservedBytes += new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (reservedBytes > READING_EXPORT_LIMITS.maxBytes) throw new ReadingExportError('EXPORT_TOO_LARGE');
  };
  if (selected.includeNotes) for (const entity of index.notes) {
    if (entity.deleted) continue;
    const raw = entity.data as unknown as Record<string, unknown>;
    if (raw.paperId !== null && (typeof raw.paperId !== 'string' || !uuid.test(raw.paperId))) throw new ReadingExportError('INVALID_DATA');
    if (!matchesPaper(raw.paperId as string | null)) continue;
    noteFormat(raw.format);
    const checked = validateEntityData('note', raw);
    if (!checked.ok) throw new ReadingExportError('INVALID_DATA');
    const data = checked.value;
    checkText(data.title); checkText(data.body);
    if (!matchesText([data.title, data.body])) continue;
    if (noteEntities.length >= READING_EXPORT_LIMITS.maxNotes) throw new ReadingExportError('TOO_MANY_ITEMS');
    reserve(data); noteEntities.push(entity as VisibleEntity & { data: NoteData });
  }
  if (selected.includeAnnotations) for (const entity of index.annotations) {
    if (entity.deleted) continue;
    const raw = entity.data as unknown as Record<string, unknown>;
    if (typeof raw.paperId !== 'string' || !uuid.test(raw.paperId) || typeof raw.attachmentVersionId !== 'string' || !uuid.test(raw.attachmentVersionId)) throw new ReadingExportError('INVALID_DATA');
    if (!matchesPaper(raw.paperId) || selected.attachmentVersionId !== null && raw.attachmentVersionId !== selected.attachmentVersionId) continue;
    const checked = validateEntityData('annotation', raw);
    if (!checked.ok) throw new ReadingExportError('INVALID_DATA');
    const data = checked.value; checkText(data.comment);
    if (data.anchor.quote) for (const value of Object.values(data.anchor.quote)) checkText(value);
    if (!matchesText([data.comment, data.anchor.quote?.exact ?? '', data.anchor.quote?.prefix ?? '', data.anchor.quote?.suffix ?? ''])) continue;
    if (annotationEntities.length >= READING_EXPORT_LIMITS.maxAnnotations) throw new ReadingExportError('TOO_MANY_ITEMS');
    reserve(data); annotationEntities.push(entity as VisibleEntity & { data: AnnotationData });
  }
  noteEntities.sort((a, b) => compare(a.data.paperId ?? '', b.data.paperId ?? '') || compare(a.entityId, b.entityId));
  annotationEntities.sort((a, b) => compare(a.data.paperId, b.data.paperId) || compare(a.data.attachmentVersionId, b.data.attachmentVersionId)
    || a.data.anchor.pageIndex - b.data.anchor.pageIndex || compare(a.entityId, b.entityId));
  const neededPapers = new Set<string>(); const neededVersions = new Set<string>();
  for (const note of noteEntities) if (note.data.paperId !== null) neededPapers.add(note.data.paperId);
  for (const annotation of annotationEntities) { neededPapers.add(annotation.data.paperId); neededVersions.add(annotation.data.attachmentVersionId); }
  if (selected.paperId) neededPapers.add(selected.paperId);
  if (selected.attachmentVersionId) neededVersions.add(selected.attachmentVersionId);
  for (const id of neededVersions) {
    const version = index.versions.get(id);
    if (version && !version.deleted) neededPapers.add((version.data as AttachmentVersionData).paperId);
  }
  if (neededPapers.size > READING_EXPORT_LIMITS.maxPapers || neededVersions.size > READING_EXPORT_LIMITS.maxVersions) throw new ReadingExportError('TOO_MANY_ITEMS');
  const paperRefs = new Map([...neededPapers].sort(compare).map((id, position) => [id, `p${position + 1}`]));
  const versionRefs = new Map([...neededVersions].sort(compare).map((id, position) => [id, `v${position + 1}`]));
  const relevant: VisibleEntity[] = [...noteEntities, ...annotationEntities]; let citationNumber = 0;
  const papers: ReadingExportPaper[] = [...paperRefs].map(([id, ref]) => {
    const entity = index.papers.get(id);
    if (!entity || entity.deleted) return { ref, status: entity ? 'deleted' : 'missing', savedState: null, data: null, citation: null };
    const data = paperMetadata(entity.data as PaperData); reserve(data); relevant.push(entity);
    return { ref, status: 'available', savedState: savedState(entity), data, citation: { label: `[${++citationNumber}]`, text: formatPaperQuayReference(data) } };
  });
  const versions: ReadingExportVersion[] = [...versionRefs].map(([id, ref]) => {
    const entity = index.versions.get(id);
    if (!entity || entity.deleted) return { ref, paperRef: null, status: entity ? 'deleted' : 'missing', savedState: null, data: null };
    const data = entity.data as AttachmentVersionData; checkText(data.fileName); relevant.push(entity);
    const saved = { sha256: data.sha256, sizeBytes: data.sizeBytes, mediaType: data.mediaType, fileName: data.fileName, pageCount: data.pageCount };
    reserve(saved);
    return { ref, paperRef: paperRefs.get(data.paperId)!, status: 'available', savedState: savedState(entity), data: saved };
  });
  const papersByRef = new Map(papers.map((paper) => [paper.ref, paper])); const versionsByRef = new Map(versions.map((version) => [version.ref, version]));
  const notes: ReadingExportNote[] = noteEntities.map((entity, position) => {
    const data = entity.data;
    const common = { ref: `n${position + 1}`, paperRef: data.paperId === null ? null : paperRefs.get(data.paperId)!,
      savedState: savedState(entity), title: data.title, body: data.body };
    return data.format === 'markdown' ? { ...common, format: 'markdown' } : { ...common, format: 'tiptap-json', sourcePaperId: data.paperId,
      document: clone(data.document), metadata: clone(data.metadata), assets: clone(data.assets) };
  });
  const annotations: ReadingExportAnnotation[] = annotationEntities.map((entity, position) => {
    const data = entity.data; const paperRef = paperRefs.get(data.paperId)!; const versionRef = versionRefs.get(data.attachmentVersionId)!;
    const result: ReadingExportAnnotation = { ref: `a${position + 1}`, paperRef, versionRef, savedState: savedState(entity), kind: data.kind,
      color: data.color, comment: data.comment, anchor: clone(data.anchor), issues: [] };
    result.issues = annotationIssues(papersByRef.get(paperRef)!, versionsByRef.get(versionRef)!, result);
    return result;
  });
  const richNotes = notes.filter((note): note is ReadingExportRichNote => note.format === 'tiptap-json');
  const archive = validateReadingExportArchive({ format: 'paperquay-reading-summary', version: richNotes.length ? 2 : 1,
    evidence: { pdf: 'not-included', hash: 'saved-version-metadata', citationStyle: PAPERQUAY_CITATION_STYLE,
      ...(richNotes.length ? { richContent: 'complete-tiptap-json-and-metadata', richReferences: 'original-identifiers-not-rebound',
        images: 'embedded-base64-sha256-verified' } : {}) },
    scope: { paperRef: selected.paperId ? paperRefs.get(selected.paperId)! : null, paperTag: selected.paperTag,
      versionRef: selected.attachmentVersionId ? versionRefs.get(selected.attachmentVersionId)! : null,
      includeNotes: selected.includeNotes, includeAnnotations: selected.includeAnnotations, includeStandalone: selected.includeStandalone, query: selected.query },
    papers, versions, notes, annotations });
  const summary: ReadingExportSummary = { papers: papers.filter((paper) => paper.status === 'available').length,
    versions: versions.filter((version) => version.status === 'available').length, notes: notes.length, annotations: annotations.length,
    standaloneNotes: notes.filter((note) => note.paperRef === null).length,
    unresolvedNotes: notes.filter((note) => note.paperRef !== null && papersByRef.get(note.paperRef)!.status !== 'available').length,
    unresolvedAnnotations: annotations.filter((annotation) => annotation.issues.length > 0).length,
    pending: relevant.filter((entity) => savedState(entity) !== 'synced').length,
    conflicts: relevant.filter((entity) => entity.status === 'conflict').length,
    omittedDeleted: index.all.filter((entity) => entity.deleted && (entity.entityType === 'note' || entity.entityType === 'annotation')).length,
    richNotes: richNotes.length, embeddedImages: richNotes.reduce((count, note) => count + note.assets.length, 0),
    embeddedImageBytes: richNotes.reduce((count, note) => count + note.assets.reduce((bytes, asset) => bytes + asset.sizeBytes, 0), 0) };
  const json = JSON.stringify(archive, null, 2); checkBytes(json);
  const markdown = renderMarkdown(archive, summary);
  const signature = canonicalJson({ selection: selected, archive, summary,
    relevant: relevant.map(({ entityType, entityId, revision, pending, status }) => ({ entityType, entityId, revision, pending, status })) });
  return { archive, json, markdown, summary,
    paperIds: [...paperRefs.keys()].filter((id) => { const paper = index.papers.get(id); return Boolean(paper && !paper.deleted); }), signature };
}
