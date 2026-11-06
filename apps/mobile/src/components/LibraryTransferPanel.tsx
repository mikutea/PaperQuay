import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { NoteData, PaperData, VisibleEntity } from '../../../../packages/sync-core/src/index.ts';
import { ClientError, describeError } from '../errors.ts';
import {
  exportLibraryArchive, LIBRARY_TRANSFER_LIMITS, LibraryTransferError, parseLibraryArchive, planLibraryImport,
  richLibraryNoteData, type LibraryArchive, type LibraryImportRow, type LibraryArchiveNote, type LibraryImportSummary,
} from '../library/libraryTransfer.ts';
import { remapRichNoteReferences } from '../../../../packages/sync-core/src/richNote.ts';
import { ContentPreview } from './EntityEditor.tsx';
import { RichNoteImagePool, RichNoteImageError } from './richNoteImages.ts';
import { BibliographyTransferError, exportBibliography, parseBibliography,
  type BibliographyFormat, type BibliographyWarning } from '../library/bibliographyTransfer.ts';
import { DoiLookupError, lookupDoi, type DoiLookupErrorCode, type DoiLookupWarning } from '../library/doiLookup.ts';
import { exportFilename, exportTextFile, FileExportError } from '../platform/exportFile.ts';
import { assertPreparedIncomingShareSource, type PreparedSource } from '../library/incomingShare.ts';
import { IncomingReceiptError, peekIncomingReceipt, prepareIncomingImport } from '../library/incomingReceipt.ts';
import type { WorkspaceController } from '../sync/workspace.ts';
import { ReaderSheet } from './ReaderSheet.tsx';
import { ExternalLibraryPanel } from './ExternalLibraryPanel.tsx';
import './readerSheet.css';
import './libraryTransfer.css';
import './externalLibrary.css';

interface Props {
  incomingSource?: PreparedSource;
  entities: readonly VisibleEntity[];
  controller: WorkspaceController;
  scopeKey: string;
  accountCurrent: () => boolean;
  onClose: () => void;
}

export function libraryTransferScope(controller: WorkspaceController): string | null {
  const snapshot = controller.getSnapshot();
  const sync = snapshot.workspace?.sync;
  return snapshot.status === 'ready' && sync
    ? JSON.stringify([sync.accountId, sync.deviceId, sync.generation]) : null;
}

function message(error: unknown): string {
  if (error instanceof IncomingReceiptError) return error.code === 'FULL'
    ? describeError(new ClientError('IMPORT_RECEIPT_FULL')) : error.code === 'CHANGED'
    ? '这项分享或导入选择已有变化，请关闭面板后重新预览。' : '无法完整核对这项分享，尚未保存。请返回待处理箱重试。';
  if (error instanceof ClientError) return error.code === 'IMPORT_UNSUPPORTED' ? '当前账号尚未启用所选内容的同步能力，请更新服务后重新比较。' : describeError(error);
  if (error instanceof FileExportError) {
    if (error.code === 'CHANGED') return '账号已变化，请关闭此面板后重试。';
    if (error.code === 'UNAVAILABLE') return '此设备暂不支持文件分享，请使用包含分享组件的完整安装包。';
    return '导出或分享未完成。可以重新导出文件。';
  }
  if (error instanceof BibliographyTransferError) {
    const record = error.record ? `第 ${error.record} 条记录：` : '';
    if (error.code === 'ARCHIVE_TOO_LARGE' || error.code === 'TOO_MANY_RECORDS') return '书目文件最多 4 MB、500 篇文献，请缩小范围后重试。';
    if (error.code === 'EMPTY_BIBLIOGRAPHY') return '文件中没有可导入的文献。';
    if (error.code === 'INVALID_RECORD') return `${record}题录缺少标题或字段不符合要求，请检查原文件后重试。`;
    return `${record}书目文件无法完整解析，请检查格式后重试。尚未导入任何记录。`;
  }
  if (error instanceof DoiLookupError) return doiErrorMessage(error.code);
  if (error instanceof RichNoteImageError) return '结构笔记图片不能完整解码，尚未导入任何记录。';
  if (error instanceof LibraryTransferError) {
    if (error.code === 'ARCHIVE_TOO_LARGE') return '文件超出本次导入上限：4 MB、500 篇文献和 500 条笔记。请拆分后重试。';
    if (error.issues.some((issue) => issue.code === 'TOO_MANY_ITEMS')) return '本次文件最多支持 500 篇文献和 500 条笔记。请缩小范围后重试。';
    if (error.code === 'INVALID_JSON') return 'JSON 文件无法读取，请检查文件内容或重新导出。';
    if (error.code === 'UNSUPPORTED_FORMAT') return '请选择 PaperQuay JSON、Markdown、BibTeX 或 RIS 文件。';
    if (error.code === 'BLOCKED_ASSOCIATION') return '所选笔记的文献关联尚未确定，请先处理下方提示。';
    if (error.code === 'EMPTY_SELECTION') return '请至少选择一项内容。';
    return '文件内容不符合当前导入格式，请检查记录字段、关联与内容长度。';
  }
  return '未能读取或处理此文件，请重新选择后重试。';
}

function doiErrorMessage(code: DoiLookupErrorCode): string {
  const messages: Record<DoiLookupErrorCode, string> = {
    INVALID_DOI: '请输入有效 DOI 或 doi.org 链接；不支持普通网页链接。',
    INVALID_OPTIONS: '查询暂时无法启动，请重新打开面板后重试。',
    ABORTED: '已取消查询。',
    TIMEOUT: 'Crossref 查询超时，请稍后重试或改用书目文件。',
    NETWORK_FAILED: '无法连接 Crossref，请检查网络，或改用书目文件。',
    NOT_FOUND: 'Crossref 未找到这个 DOI。请核对 DOI，或从出版方导出 BibTeX / RIS。',
    RATE_LIMITED: 'Crossref 暂时限制了请求，请稍后再试。',
    SERVICE_UNAVAILABLE: 'Crossref 暂时不可用，请稍后重试或改用书目文件。',
    HTTP_ERROR: 'Crossref 未能完成查询，请稍后重试。',
    RESPONSE_TOO_LARGE: '来源返回的内容过大，请改用书目文件。',
    INVALID_RESPONSE: '来源返回的题录无法安全读取，请改用书目文件。',
    DOI_MISMATCH: '来源返回的 DOI 与查询不一致，未生成导入预览。',
    METADATA_LIMIT: '来源题录超过当前字段长度上限，请核对并使用书目文件导入。',
    MISSING_TITLE: '来源没有提供可用标题，无法导入。可手动新建文献。',
  };
  return messages[code];
}

function doiWarningMessage(warning: DoiLookupWarning): string {
  const messages: Record<DoiLookupWarning['code'], string> = {
    TITLE_ALTERNATIVES_OMITTED: '存在多个标题，本次仅保留第一个。',
    SUBTITLE_OMITTED: '来源副标题未导入。',
    TEXT_FORMATTING_REMOVED: '来源格式标记已转为纯文本，请核对文字。',
    AUTHORS_MISSING: '来源未提供作者。',
    AUTHORS_INCOMPLETE: '部分作者姓名不完整，请核对作者列表。',
    AFFILIATIONS_OMITTED: '作者所属机构未导入；机构作者名称仍会保留。',
    YEAR_MISSING: '来源未提供出版年份。',
    YEAR_INVALID: '来源日期格式无法确定出版年份。',
    YEAR_FALLBACK: '来源缺少首选出版日期，本次使用其他出版日期中的年份。',
    YEAR_CONFLICT: '来源的不同出版日期存在年份差异，请核对年份。',
    PUBLICATION_MISSING: '来源未提供期刊或出版来源名称。',
    PUBLICATION_ALTERNATIVES_OMITTED: '存在多个出版来源名称，本次仅保留第一个。',
    ABSTRACT_MISSING: '来源未提供摘要。',
    ABSTRACT_UNSUPPORTED: '来源摘要包含当前不支持的结构，摘要未导入。',
    SUBJECTS_AS_KEYWORDS: '来源学科分类已作为关键词导入，请核对。',
    ADDITIONAL_METADATA_OMITTED: '本次仅保留当前题录字段；文献类型、卷期页、出版商、资源链接等额外出版信息不会导入。',
  };
  return messages[warning.code];
}

function WarningList({ warnings }: { warnings: readonly string[] }) {
  if (!warnings.length) return null;
  const unique = [...new Set(warnings)];
  return <div className="transfer-warnings" role="note" aria-label="字段转换提示">
    <details><summary>{unique.length} 项字段变化，查看详情</summary>
      <p>请核对以下字段变化；原文件仍需保留。</p>
      <ul>{unique.map((warning) => <li key={warning}>{warning}</li>)}</ul>
    </details>
  </div>;
}

const bibliographyFieldNames: Record<string, string> = {
  volume: '卷', number: '期', issue: '期', pages: '页码', publisher: '出版商', address: '出版地',
  type: '文献类型', url: '链接', file: '附件路径', 'citation-key': '引用键',
  author: '作者', title: '标题', abstract: '摘要', year: '年份', keywords: '关键词',
  journal: '出版来源', booktitle: '图书 / 会议名称', organization: '个人分类',
  'entry-type': '文献类型', authors: '作者', TY: '文献类型', AU: '作者', A1: '作者',
  VL: '卷', IS: '期', SP: '起始页', EP: '结束页', UR: '链接', L1: '附件链接',
};
const bibliographyWarnings = (warnings: readonly BibliographyWarning[]) => {
  const grouped = new Map<string, { warning: BibliographyWarning; records: number[] }>();
  for (const warning of warnings) {
    const key = JSON.stringify([warning.code, [...warning.fields].sort(), warning.record === null]);
    const group = grouped.get(key) ?? { warning, records: [] };
    if (warning.record !== null) group.records.push(warning.record);
    grouped.set(key, group);
  }
  return [...grouped.values()].map(({ warning, records }) => {
    const ranges: string[] = [];
    const sorted = [...new Set(records)].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length; index++) {
      const start = sorted[index]; let end = start;
      while (sorted[index + 1] === end + 1) { index++; end++; }
      ranges.push(start === end ? `${start}` : `${start}–${end}`);
    }
    const fields = [...new Set(warning.fields.map((field) => bibliographyFieldNames[field] || field))].join('、');
    const text = warning.code === 'TYPE_NOT_PRESERVED' ? '文献类型未保留，导出时使用通用类型。'
      : warning.code === 'AUTHOR_STRUCTURE_FLATTENED' ? '作者保存为显示名称，姓 / 名拆分与机构标记不保留。' : warning.message;
    return `${ranges.length ? `第 ${ranges.join('、')} 篇：` : ''}${text}${fields ? `（${fields}）` : ''}`;
  });
};

function MetadataPreview({ paper }: { paper: PaperData }) {
  return <details className="transfer-metadata"><summary>查看题录</summary><dl>
    <dt>作者</dt><dd>{paper.authors.join('；') || '未提供'}</dd>
    <dt>年份</dt><dd>{paper.year || '未提供'}</dd>
    <dt>出版来源</dt><dd>{paper.publication || '未提供'}</dd>
    <dt>DOI</dt><dd>{paper.doi || '未提供'}</dd>
    {paper.keywords.length > 0 && <><dt>关键词</dt><dd>{paper.keywords.join('；')}</dd></>}
    {paper.abstractText && <><dt>摘要</dt><dd>{paper.abstractText}</dd></>}
    {paper.organization && <>
      <dt>收藏 / 进度</dt><dd>{paper.organization.favorite ? '已收藏' : '未收藏'} · {{ unread: '待读', reading: '在读', read: '已读' }[paper.organization.readingStatus]}</dd>
      <dt>标签</dt><dd>{paper.organization.tags.join('；') || '无'}</dd>
      <dt>合集</dt><dd>{paper.organization.collections.join('；') || '无'}</dd>
    </>}
  </dl></details>;
}

function rowDetail(row: LibraryImportRow): string {
  const parts: string[] = [];
  if (row.duplicate) parts.push(row.duplicate.reason === 'doi' ? '相同 DOI，默认跳过'
    : row.duplicate.reason === 'exact-paper' ? '相同题录，默认跳过；分类不自动合并' : '已有相同内容，默认跳过');
  if (row.association?.kind === 'new-paper') parts.push(`关联本次文献：${row.association.paperTitle}`);
  if (row.association?.kind === 'existing-paper') parts.push(`关联现有文献：${row.association.paperTitle}`);
  if (row.association?.kind === 'none') parts.push('独立笔记');
  if (row.blockedReason === 'PAPER_NOT_SELECTED') parts.push('请同时选择它关联的文献，或跳过此笔记');
  if (row.blockedReason === 'MISSING_PAPER') parts.push('文件中缺少关联文献，请补全后重新导入');
  if (row.blockedReason === 'AMBIGUOUS_PAPER') parts.push('存在多个匹配文献；选择文件中的文献另存副本后即可关联');
  return parts.join('。');
}
function ArchiveNotePreview({ note }: { note: LibraryArchiveNote }) {
  const [open, setOpen] = useState(false);
  const data = useMemo(() => !open ? null : note.format === 'tiptap-json'
    ? remapRichNoteReferences(richLibraryNoteData(note), () => null)
    : { paperId: null, title: note.title, body: note.body, format: 'markdown' as const }, [open, note]);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{note.format === 'tiptap-json' ? '查看完整结构笔记' : '查看 Markdown 正文'}</summary>
    {data && <ContentPreview data={data} sessionKey={`file-note:${note.ref}`} />}</details>;
}

export function LibraryTransferPanel({ entities, controller, scopeKey, accountCurrent, onClose, incomingSource }: Props) {
  if (incomingSource) assertPreparedIncomingShareSource(incomingSource);
  const [tab, setTab] = useState<'import' | 'export' | 'external'>('import');
  const [archive, setArchive] = useState<LibraryArchive | null>(() => incomingSource?.archive ?? null);
  const [filename, setFilename] = useState(incomingSource?.sourceName ?? '');
  const [selection, setSelection] = useState<readonly string[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [noteId, setNoteId] = useState('');
  const [sourceMode, setSourceMode] = useState<'file' | 'doi'>(incomingSource && incomingSource.kind !== 'archive' ? 'doi' : 'file');
  const [doi, setDoi] = useState(incomingSource?.doi ?? '');
  const [lookedUpDoi, setLookedUpDoi] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>(() => bibliographyWarnings(incomingSource?.warnings ?? []));
  const [bibliographyFormat, setBibliographyFormat] = useState<BibliographyFormat>('bibtex');
  const [paperId, setPaperId] = useState('');
  const alive = useRef(true);
  const operation = useRef(0);
  const busyRef = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const noteSelectId = useId();
  const paperSelectId = useId();
  const formatSelectId = useId();
  const doiInputId = useId();
  const queryAbort = useRef<AbortController | null>(null);
  const importImages = useRef<RichNoteImagePool | null>(null);
  useEffect(() => { alive.current = true; return () => {
    alive.current = false; operation.current++; queryAbort.current?.abort(); importImages.current?.close();
  }; }, []);
  const current = () => alive.current && accountCurrent() && libraryTransferScope(controller) === scopeKey;
  let savedIncoming: LibraryImportSummary | null = null, incomingReceiptError: string | null = null;
  if (incomingSource) {
    try { savedIncoming = peekIncomingReceipt(controller.getSnapshot().workspace?.incomingReceipts ?? [], incomingSource); }
    catch (cause) { incomingReceiptError = message(cause); }
  }
  const planned = useMemo(() => {
    if (!archive) return null;
    try { return { plan: planLibraryImport(archive, entities, selection), error: null }; }
    catch (cause) { return { plan: null, error: message(cause) }; }
  }, [archive, entities, selection]);
  const plan = planned?.plan;
  const richSupported = controller.getContentCapabilities().richNotes;
  const exported = useMemo(() => {
    if (tab !== 'export') return null;
    try { return { result: exportLibraryArchive(entities), error: null }; }
    catch (cause) {
      const tooLarge = cause instanceof LibraryTransferError && (cause.code === 'ARCHIVE_TOO_LARGE'
        || cause.issues.some((issue) => issue.code === 'TOO_MANY_ITEMS'));
      return { result: null, error: tooLarge
        ? '当前文库超过本次 JSON 导出上限（4 MB、500 篇文献和 500 条笔记）。可逐条导出笔记；结构笔记保持 JSON，分批文库导出尚未支持。'
        : message(cause) };
    }
  }, [entities, tab]);
  const notes = entities.filter((entity) => entity.entityType === 'note' && !entity.deleted && entity.data) as (VisibleEntity & { data: NoteData })[];
  const chosenNote = notes.find((note) => note.entityId === noteId);
  const papers = entities.filter((entity) => entity.entityType === 'paper' && !entity.deleted && entity.data) as (VisibleEntity & { data: PaperData })[];
  const bibliography = useMemo(() => {
    if (tab !== 'export') return null;
    try { return { result: exportBibliography(paperId ? entities.filter((entity) => entity.entityType === 'paper' && entity.entityId === paperId) : entities, bibliographyFormat), error: null }; }
    catch (cause) { return { result: null, error: message(cause) }; }
  }, [entities, tab, paperId, bibliographyFormat]);

  function changeTab(next: 'import' | 'export' | 'external') {
    if (busyRef.current) return;
    setTab(next); setError(null); setFeedback(null);
  }
  async function readFile(file?: File) {
    if (incomingSource || !file || busyRef.current || !current()) return;
    const request = ++operation.current;
    busyRef.current = true; setBusy(true); setError(null); setFeedback(null); setArchive(null); setSelection(undefined); setWarnings([]);
    try {
      if (file.size > LIBRARY_TRANSFER_LIMITS.maxBytes) throw new LibraryTransferError('ARCHIVE_TOO_LARGE');
      const buffer = await file.arrayBuffer();
      if (!current() || operation.current !== request) return;
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { setError('文件不是有效的 UTF-8 文本，请用 UTF-8 编码重新导出后再选择。'); return; }
      const format = /\.(bib|bibtex)$/i.test(file.name) ? 'bibtex' : /\.ris$/i.test(file.name) ? 'ris' : null;
      const parsed = format ? parseBibliography(text, format) : null;
      const value = parsed?.archive ?? (/\.(md|markdown)$/i.test(file.name)
        ? parseLibraryArchive(JSON.stringify({ format: 'paperquay-library', version: 1, papers: [], notes: [
          { ref: 'n1', paperRef: null, title: file.name.replace(/\.(md|markdown)$/i, '').slice(0, 2048) || '导入笔记', body: text, format: 'markdown' },
        ] })) : parseLibraryArchive(text));
      setFilename(file.name); setArchive(value); setWarnings(parsed ? bibliographyWarnings(parsed.warnings) : []);
    } catch (cause) { if (current() && operation.current === request) setError(message(cause)); }
    finally {
      if (operation.current === request) { busyRef.current = false; if (alive.current) setBusy(false); }
    }
  }
  async function queryDoi() {
    if (busyRef.current || !current() || savedIncoming || incomingReceiptError) return;
    const request = ++operation.current;
    setLookedUpDoi(null);
    const abort = new AbortController(); queryAbort.current = abort;
    busyRef.current = true; setBusy(true); setError(null); setFeedback(null); setArchive(null); setSelection(undefined); setWarnings([]);
    try {
      const result = await lookupDoi(doi, { signal: abort.signal });
      if (!current() || operation.current !== request || abort.signal.aborted) return;
      setFilename(`Crossref · ${result.source.doi}`); setArchive(result.archive); setLookedUpDoi(result.source.doi);
      setWarnings(result.warnings.map(doiWarningMessage));
    } catch (cause) { if (current() && operation.current === request && !abort.signal.aborted) setError(message(cause)); }
    finally {
      if (operation.current === request) {
        queryAbort.current = null; busyRef.current = false; if (alive.current) setBusy(false);
      }
    }
  }
  function cancelQuery() {
    if (!queryAbort.current) return;
    operation.current++; queryAbort.current.abort(); queryAbort.current = null;
    busyRef.current = false; setBusy(false); setError(null); setFeedback('已取消查询。');
  }
  function changeSource(next: 'file' | 'doi') {
    if (incomingSource || busyRef.current) return;
    setSourceMode(next); setArchive(null); setSelection(undefined); setWarnings([]); setError(null); setFeedback(null);
  }
  function toggle(row: LibraryImportRow) {
    if (!plan || busyRef.current) return;
    const keys = new Set(plan.rows.filter((entry) => entry.selected).map((entry) => entry.key));
    if (keys.has(row.key)) keys.delete(row.key); else keys.add(row.key);
    setSelection([...keys]); setError(null); setFeedback(null);
  }
  async function confirmImport() {
    if (!plan || busyRef.current || !current() || savedIncoming || incomingReceiptError) return;
    if (plan.requiresRichNotes && !controller.getContentCapabilities().richNotes) { setError('当前账号尚未启用结构笔记同步，请取消选择结构笔记或更新服务。'); return; }
    busyRef.current = true; setBusy(true); setError(null); setFeedback(null);
    try {
      const chosen = new Set(plan.rows.filter((row) => row.selected).map((row) => row.key));
      for (const note of plan.archive.notes) if (note.format === 'tiptap-json' && chosen.has(`note:${note.ref}`)) {
        const pool = new RichNoteImagePool(); importImages.current = pool;
        try { const ready = await pool.replace(note.assets); if (!ready || !current()) return; }
        finally { pool.close(); if (importImages.current === pool) importImages.current = null; }
      }
      if (!current()) return;
      const incoming = incomingSource ? await prepareIncomingImport(incomingSource, plan.archive, selection, {
        current, ...(incomingSource.kind === 'unsupported' ? { manualDoi: lookedUpDoi ?? '' } : {}),
      }) : undefined;
      if (!current()) return;
      const result = await controller.importLibrary(incoming?.archive ?? plan.archive, incoming ? incoming.selection ?? undefined : selection, plan.signature, incoming);
      if (!current()) return;
      setArchive(null); setSelection(undefined); setWarnings([]);
      setFeedback(`已保存 ${result.selectedPapers} 篇文献、${result.selectedNotes} 条笔记到此设备，联网后继续同步。`);
    } catch (cause) { if (current()) setError(message(cause)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function saveExport(kind: 'library' | 'note' | 'bibliography') {
    if (busyRef.current || !current()) return;
    const result = exported?.result;
    if ((kind === 'library' && !result) || (kind === 'note' && !chosenNote?.data) || (kind === 'bibliography' && !bibliography?.result?.summary.papers)) return;
    busyRef.current = true; setBusy(true); setError(null); setFeedback(null);
    try {
      const note = chosenNote?.data as NoteData | undefined;
      const richExport = kind === 'note' && note?.format === 'tiptap-json' ? exportLibraryArchive(entities.filter((entry) =>
        entry.entityType === 'note' && entry.entityId === chosenNote!.entityId || entry.entityType === 'paper' && entry.entityId === note.paperId)) : null;
      const outcome = await exportTextFile(kind === 'bibliography'
        ? { name: `PaperQuay-bibliography-${new Date().toISOString().slice(0, 10)}.${bibliographyFormat === 'bibtex' ? 'bib' : 'ris'}`,
          text: bibliography!.result!.text, mime: bibliographyFormat === 'bibtex' ? 'application/x-bibtex' : 'application/x-research-info-systems' }
        : kind === 'library'
        ? { name: `PaperQuay-library-${new Date().toISOString().slice(0, 10)}.json`, text: result!.json, mime: 'application/json' }
        : richExport ? { name: exportFilename(note!.title || '未命名笔记', 'json'), text: richExport.json, mime: 'application/json' }
        : { name: exportFilename(note!.title || '未命名笔记', 'md'), text: note!.body, mime: 'text/markdown' }, current,undefined,controller.getAccountScope()??undefined);
      if (current()) setFeedback(outcome === 'download' ? '已开始下载，请在浏览器下载列表中查看文件。' : '系统分享面板已关闭；保存结果请在所选应用中确认。');
    } catch (cause) { if (current()) setError(message(cause)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  const selected = plan ? plan.summary.selectedPapers + plan.summary.selectedNotes : 0;
  return <ReaderSheet open title={incomingSource ? "确认本次分享" : "导入与导出"} onClose={onClose} className="library-transfer-sheet">
    <div className="library-transfer">
      {!incomingSource && <div className="transfer-tabs" role="group" aria-label="文件操作">
        <button type="button" aria-pressed={tab === 'import'} disabled={busy} onClick={() => changeTab('import')}>导入</button>
        <button type="button" aria-pressed={tab === 'export'} disabled={busy} onClick={() => changeTab('export')}>导出</button>
        <button type="button" aria-pressed={tab === 'external'} disabled={busy} onClick={() => changeTab('external')}>外部文库</button>
      </div>}
      {tab === 'import' ? <>
        {incomingSource && <section aria-label="分享来源" className="transfer-intro">
          <h3>{incomingSource.sourceName}</h3>
          <p className="muted">本次内容已绑定当前账号。确认保存后，原文仍留在待处理箱，可返回后手动移除。</p>
          {incomingSource.kind === 'unsupported' && <><p>{incomingSource.reason}</p>
            <details><summary>查看原始文字</summary><pre className="incoming-share-text">{incomingSource.sourceText?.slice(0, 5000)}</pre></details>
            <p className="transfer-hint">可从原文核对并填写一个 DOI，再明确查询。普通网页不会自动读取。</p></>}
          {savedIncoming && <p role="status">这项分享此前已保存到当前账号：{savedIncoming.selectedPapers} 篇文献、{savedIncoming.selectedNotes} 条笔记。无需重复导入。</p>}
          {incomingReceiptError && <p role="alert">{incomingReceiptError}</p>}
        </section>}
        {!savedIncoming && !incomingReceiptError && <section className="transfer-intro">
          {!incomingSource && !archive && <div className="transfer-source-tabs" role="group" aria-label="导入来源">
            <button type="button" aria-pressed={sourceMode === 'file'} disabled={busy} onClick={() => changeSource('file')}>文件</button>
            <button type="button" aria-pressed={sourceMode === 'doi'} disabled={busy} onClick={() => changeSource('doi')}>DOI 查询</button>
          </div>}
          {!archive && sourceMode === 'file' && <><h3>将文件加入文库</h3>
            <p className="muted">支持 PaperQuay JSON、Markdown、BibTeX 和 RIS，先预览再保存。</p></>}
          <input ref={input} type="file" accept=".json,.md,.markdown,.bib,.bibtex,.ris,application/json,text/markdown,application/x-bibtex,application/x-research-info-systems" hidden
            aria-label="选择导入文件" onChange={(event) => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void readFile(file);
            }} />
          {!incomingSource && (sourceMode === 'file' || archive) && <div className={archive ? 'transfer-source' : undefined}>
            {archive && <p className="transfer-filename">{filename}</p>}
            <button type="button" className="secondary" disabled={busy} onClick={() => sourceMode === 'file' ? input.current?.click() : changeSource('doi')}>
              {archive ? sourceMode === 'file' ? '更换文件' : '重新查询' : '选择文件'}</button>
          </div>}
          {!archive && sourceMode === 'file' && <p className="transfer-hint">UTF-8 文本，每次最多 4 MB、500 篇文献和 500 条笔记。</p>}
          {!archive && sourceMode === 'doi' && <form className="transfer-doi" onSubmit={(event) => { event.preventDefault(); void queryDoi(); }}>
            <div className="field"><label htmlFor={doiInputId}>DOI 或 DOI 链接</label>
              <input id={doiInputId} value={doi} onChange={(event) => { setDoi(event.target.value); setLookedUpDoi(null); }} readOnly={incomingSource?.kind === 'doi'} maxLength={2048}
                placeholder="10.… 或 https://doi.org/…" spellCheck={false} autoCapitalize="none" autoComplete="off" disabled={busy} /></div>
            <p className="transfer-hint">点击查询会将这个 DOI 发送到 Crossref。查询结果需确认后才会加入文库。</p>
            <div className="transfer-doi-actions"><button type="submit" className="primary" disabled={busy || !doi.trim()}>{busy ? '正在查询…' : '查询 DOI'}</button>
              {busy && queryAbort.current && <button type="button" className="secondary" onClick={cancelQuery}>取消查询</button>}</div>
          </form>}
        </section>}
        {plan && !savedIncoming && !incomingReceiptError && <section className="transfer-preview" aria-label="导入预览">
          <h3>预览导入</h3>
          <p>选中 {plan.summary.selectedPapers} 篇文献、{plan.summary.selectedNotes} 条笔记；跳过 {plan.summary.skipped} 项。</p>
          <p className="transfer-hint">重复项默认跳过；勾选后另存副本，也会保留文件中的分类。</p>
          {plan.archive.version === 2 && <p className="transfer-hint">结构笔记包含完整正文、标记和图片。sourceId 是原文件的来源标识，仅用于文件内引用绑定，不代表当前账号记录；未选或未知目标会保留为未解析引用。</p>}
          {plan.archive.exportReport && <div className="transfer-hint" role="note">
            <p>此文件来自桌面选中的已保存笔记。sourceId 是独立导出别名，originalId 仅供核对原记录；两者都不会直接绑定当前账号。</p>
            <p>原选 {plan.archive.exportReport.requestedNotes} 条笔记，文件保留 {plan.archive.notes.length} 条；跳过 {plan.archive.exportReport.skipped.length} 项。</p>
            {plan.archive.exportReport.skipped.length > 0 && <details><summary>查看未导出项</summary><ul>
              {plan.archive.exportReport.skipped.map((item, index) => <li key={index}>{item.entityType === 'note' ? '笔记' : '题录'} {item.index + 1}：{item.code}</li>)}
            </ul></details>}
          </div>}
          <WarningList warnings={warnings} />
          <div className="transfer-selection-actions">
            <button type="button" className="text-button" disabled={busy} onClick={() => setSelection(undefined)}>使用默认选择</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => setSelection([])}>全部取消</button>
          </div>
          <ul className="transfer-rows">{plan.rows.map((row) => <li key={row.key}>
            <label className="transfer-row"><input type="checkbox" checked={row.selected} disabled={busy} onChange={() => toggle(row)} />
              <span><span className="transfer-row-kind">{row.entityType === 'paper' ? '文献' : '笔记'}{row.duplicate && row.selected ? ' · 另存副本' : ''}</span>
                <strong>{row.title || '未命名笔记'}</strong>
                {rowDetail(row) && <small className={row.blockedReason ? 'transfer-blocked' : ''}>{rowDetail(row)}</small>}
              </span></label>
            {row.entityType === 'paper' && <MetadataPreview paper={plan.archive.papers.find((paper) => paper.ref === row.ref)!.data} />}
            {row.entityType === 'note' && <ArchiveNotePreview note={plan.archive.notes.find((note) => note.ref === row.ref)!} />}
          </li>)}</ul>
          {plan.summary.selectedBlockedNotes > 0 && <p className="inline-error" role="status">有 {plan.summary.selectedBlockedNotes} 条笔记的关联需要处理。</p>}
          {plan.requiresRichNotes && !richSupported && <p className="inline-error" role="status">当前账号未启用结构笔记同步。可取消选择这些笔记，其他已支持内容仍可导入。</p>}
          <div className="transfer-confirm">
            {error && <p className="inline-error transfer-message" role="alert">{error}</p>}
            <button type="button" className="primary"
            disabled={busy || selected === 0 || plan.summary.selectedBlockedNotes > 0 || plan.requiresRichNotes && !richSupported} onClick={() => void confirmImport()}>
            {busy ? '正在保存…' : `导入所选 ${selected} 项`}</button></div>
        </section>}
        {busy && !plan && sourceMode === 'file' && <p role="status">正在读取文件…</p>}
        {planned?.error && <p className="inline-error" role="alert">{planned.error}</p>}
      </> : tab === 'external' ? <ExternalLibraryPanel controller={controller} scopeKey={scopeKey}
        accountCurrent={accountCurrent} onBusyChange={setBusy} /> : <>
        <section className="transfer-export">
          <h3>书目文件</h3>
          <p className="muted">导出当前已保存的题录，供 Zotero 等文献工具读取。</p>
          <div className="field"><label htmlFor={paperSelectId}>选择书目范围</label>
            <select id={paperSelectId} value={paperId} disabled={busy} onChange={(event) => setPaperId(event.target.value)}>
              <option value="">全部文献（{papers.length} 篇）</option>
              {papers.map((paper) => <option key={paper.entityId} value={paper.entityId}>{paper.data.title}</option>)}
            </select></div>
          <div className="field"><label htmlFor={formatSelectId}>书目格式</label>
            <select id={formatSelectId} value={bibliographyFormat} disabled={busy} onChange={(event) => setBibliographyFormat(event.target.value as BibliographyFormat)}>
              <option value="bibtex">BibTeX (.bib)</option><option value="ris">RIS (.ris)</option>
            </select></div>
          {bibliography?.result && <>
            <WarningList warnings={bibliographyWarnings(bibliography.result.warnings)} />
            {bibliography.result.summary.conflicted > 0 && <p className="transfer-hint">{bibliography.result.summary.conflicted} 篇仍有同步冲突，将导出本设备显示的已保存题录。</p>}
            <button type="button" className="primary" disabled={busy || bibliography.result.summary.papers === 0}
              onClick={() => void saveExport('bibliography')}>导出 {bibliographyFormat === 'bibtex' ? 'BibTeX' : 'RIS'}</button>
          </>}
          {bibliography?.error && <p className="inline-error" role="alert">{bibliography.error}</p>}
          <p className="transfer-hint">仅含题录，不含 PDF、批注、笔记或分类。完整分类与笔记可用下方文库 JSON。</p>
        </section>
        <section className="transfer-export">
          <h3>文库 JSON</h3>
          <p className="muted">导出已保存的题录、分类与笔记。结构笔记保存完整节点、引用、元数据和图片，不转换为 Markdown。</p>
          {exported?.result && <>
            <p>{exported.result.summary.papers} 篇文献 · {exported.result.summary.notes} 条笔记</p>
            {exported.result.summary.unresolvedNoteLinks > 0 && <p className="transfer-hint">{exported.result.summary.unresolvedNoteLinks} 条笔记的关联文献不可用，文件会保留待核对的关联；重新导入时需补全对应文献。</p>}
            {exported.result.summary.conflicted > 0 && <p className="transfer-hint">其中 {exported.result.summary.conflicted} 项仍有同步冲突，将导出此设备当前显示的已保存内容。</p>}
            <button type="button" className="primary" disabled={busy || !exported.result.summary.papers && !exported.result.summary.notes}
              onClick={() => void saveExport('library')}>导出文库 JSON</button>
          </>}
          <p className="transfer-hint">不包含 PDF、批注、AI 会话、自定义或 AI 关系、未保存草稿及账号设置。图谱页面可另行导出当前可见关系，不能代替完整备份。单个导出文件最多 4 MB。</p>
          {exported?.error && <p className="inline-error" role="alert">{exported.error}</p>}
        </section>
        <section className="transfer-export">
          <h3>单条笔记</h3>
          <div className="field"><label htmlFor={noteSelectId}>选择已保存的笔记</label>
            <select id={noteSelectId} value={noteId} disabled={busy || notes.length === 0} onChange={(event) => setNoteId(event.target.value)}>
              <option value="">{notes.length ? '请选择一条笔记' : '还没有可导出的笔记'}</option>
              {notes.map((note) => <option key={note.entityId} value={note.entityId}>{note.data?.title || '未命名笔记'}</option>)}
            </select></div>
          <button type="button" className="secondary" disabled={busy || !chosenNote} onClick={() => void saveExport('note')}>{chosenNote?.data.format === 'tiptap-json' ? '导出结构笔记 JSON' : '导出 Markdown'}</button>
          {chosenNote?.data.format === 'tiptap-json' && <p className="transfer-hint">JSON 会附带当前可用的主关联题录；其他未随包导入的引用保持未解析。sourceId 只用于文件内绑定。</p>}
        </section>
      </>}
      {tab !== 'external' && error && !(tab === 'import' && plan) && <p className="inline-error transfer-message" role="alert">{error}</p>}
      {tab !== 'external' && feedback && <p className="transfer-message transfer-success" role="status">{feedback}</p>}
    </div>
  </ReaderSheet>;
}
