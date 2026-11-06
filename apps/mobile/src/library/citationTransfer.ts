import {
  canonicalJson, isPlainObject, SYNC_LIMITS, UUID_PATTERN, validateEntityData,
  type PaperData, type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';

export const PAPERQUAY_CITATION_STYLE = 'paperquay-numbered-v1' as const;
export const CITATION_TRANSFER_LIMITS = Object.freeze({ maxPapers: 500, maxBytes: 4 * 1024 * 1024 });
export type CitationTransferErrorCode = 'INVALID_DATA' | 'INVALID_SELECTION' | 'TOO_MANY_PAPERS' | 'EXPORT_TOO_LARGE';
export class CitationTransferError extends Error {
  constructor(readonly code: CitationTransferErrorCode) { super(code); this.name = 'CitationTransferError'; }
}
export interface PaperQuayCitation {
  /** Internal preview identity; never included in the exported Markdown. */
  paperId: string;
  number: number;
  label: string;
  text: string;
}
export interface CitationExportResult {
  style: typeof PAPERQUAY_CITATION_STYLE;
  citations: PaperQuayCitation[];
  markdown: string;
  summary: { papers: number; pending: number; conflicted: number };
  /** Compare in memory only; contains private metadata. Never persist or log. */
  signature: string;
}

const uuid = new RegExp(UUID_PATTERN);
const statuses = new Set(['synced', 'queued', 'sending', 'uncertain', 'conflict', 'rejected', 'device-blocked', 'overlay']);
const invalidControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
function dataObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
}
function checkText(value: string): void {
  if (invalidControls.test(value)) throw new CitationTransferError('INVALID_DATA');
  try { encodeURIComponent(value); } catch { throw new CitationTransferError('INVALID_DATA'); }
}
function checkedPaper(value: unknown): PaperData {
  const result = validateEntityData('paper', value);
  if (!result.ok) throw new CitationTransferError('INVALID_DATA');
  const data = result.value;
  for (const value of [data.title, data.doi, data.year, data.publication, data.abstractText, ...data.authors, ...data.keywords]) {
    if (value !== null) checkText(value);
  }
  return data;
}

/**
 * The existing desktop review formatter, restricted to the seven available paper fields.
 * Authors use their stored display names joined with ", ". This is PaperQuay's format,
 * not APA, CSL, GB/T, DOI verification, or recovery of absent volume/issue/page metadata.
 */
export function formatPaperQuayReference(value: PaperData): string {
  const data = checkedPaper(value);
  const part = (value: string | null) => (value ?? '').trim().replace(/[.。;；,\s]+$/g, '');
  const parts = [part(data.authors.join(', ')), part(data.title), part(data.publication), part(data.year)].filter(Boolean);
  const doi = part(data.doi);
  if (doi) parts.push(`DOI: ${doi.replace(/^doi:\s*/i, '')}`);
  if (!parts.length) parts.push('PaperQuay source');
  return parts.map((value) => /[.!?。！？]$/.test(value) ? value : `${value}.`).join(' ');
}

/** Escape metadata only; stored Markdown note bodies are handled separately without rewriting. */
export function escapeReadingMarkdown(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/([\\`*_{}[\]()<>#+!|])/g, '\\$1');
}
function checkBytes(value: string): void {
  if (value.length > CITATION_TRANSFER_LIMITS.maxBytes || new TextEncoder().encode(value).byteLength > CITATION_TRANSFER_LIMITS.maxBytes) {
    throw new CitationTransferError('EXPORT_TOO_LARGE');
  }
}

/** Selection order determines numbering. Without a selection, stable paper IDs determine order. */
export function exportPaperQuayCitations(entities: readonly VisibleEntity[], paperIds?: readonly string[]): CitationExportResult {
  if (!Array.isArray(entities) || entities.length > SYNC_LIMITS.maxLocalEntities) throw new CitationTransferError('INVALID_DATA');
  const papers = new Map<string, VisibleEntity & { data: PaperData }>();
  const known = new Set<string>();
  for (let index = 0; index < entities.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(entities, index);
    if (!descriptor || !('value' in descriptor) || !dataObject(descriptor.value)) throw new CitationTransferError('INVALID_DATA');
    const entity = descriptor.value;
    if (entity.entityType !== 'paper') continue;
    if (typeof entity.entityId !== 'string' || !uuid.test(entity.entityId) || typeof entity.deleted !== 'boolean'
      || typeof entity.pending !== 'boolean' || !Number.isSafeInteger(entity.revision) || (entity.revision as number) < 0
      || typeof entity.status !== 'string' || !statuses.has(entity.status) || known.has(entity.entityId)) throw new CitationTransferError('INVALID_DATA');
    known.add(entity.entityId);
    if (entity.deleted) continue;
    const data = checkedPaper(entity.data);
    papers.set(entity.entityId, { entityType: 'paper', entityId: entity.entityId, data, deleted: false,
      revision: entity.revision as number, pending: entity.pending, status: entity.status as VisibleEntity['status'] });
  }
  let ids: string[];
  if (paperIds === undefined) ids = [...papers.keys()].sort();
  else {
    if (!Array.isArray(paperIds) || paperIds.length > CITATION_TRANSFER_LIMITS.maxPapers) throw new CitationTransferError('INVALID_SELECTION');
    ids = []; const seen = new Set<string>();
    for (let index = 0; index < paperIds.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(paperIds, index);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string'
        || !papers.has(descriptor.value) || seen.has(descriptor.value)) throw new CitationTransferError('INVALID_SELECTION');
      seen.add(descriptor.value); ids.push(descriptor.value);
    }
  }
  if (ids.length > CITATION_TRANSFER_LIMITS.maxPapers) throw new CitationTransferError('TOO_MANY_PAPERS');
  const selected = ids.map((id) => papers.get(id)!);
  const citations = selected.map((paper, index) => ({ paperId: paper.entityId, number: index + 1,
    label: `[${index + 1}]`, text: formatPaperQuayReference(paper.data) }));
  const summary = { papers: citations.length,
    pending: selected.filter((paper) => paper.pending || paper.status !== 'synced').length,
    conflicted: selected.filter((paper) => paper.status === 'conflict').length };
  const markdown = '# PaperQuay 编号格式参考文献\n\n'
    + '> 使用已保存的标题、显示作者、出版来源、年份和 DOI；不是 APA、CSL 或 GB/T 格式，不推测卷期页和文献类型。\n\n'
    + (summary.pending ? `> ${summary.pending} 篇含待处理的本机内容，其中 ${summary.conflicted} 篇存在同步冲突；此文件导出当前可见的已保存题录。\n\n` : '')
    + citations.map((citation) => `${citation.label} ${escapeReadingMarkdown(citation.text)}`).join('\n\n')
    + (citations.length ? '\n' : '（此范围没有可导出的文献。）\n');
  checkBytes(markdown);
  return { style: PAPERQUAY_CITATION_STYLE, citations, markdown, summary,
    signature: canonicalJson({ style: PAPERQUAY_CITATION_STYLE, selected, ids }) };
}
