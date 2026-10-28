import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { VisibleEntity } from '../../../../packages/sync-core/src/index.ts';
import { CitationTransferError, exportPaperQuayCitations } from '../library/citationTransfer.ts';
import {
  buildReadingExport, readingExportCatalog, ReadingExportError, READING_EXPORT_LIMITS,
  type ReadingExportSelection,
} from '../library/readingExport.ts';
import { exportFilename, exportTextFile, FileExportError, type ExportRuntime, type TextFileExport } from '../platform/exportFile.ts';

export interface NoteExportPanelProps {
  entities: readonly VisibleEntity[];
  initialPaperId?: string | null;
  initialAttachmentVersionId?: string | null;
  /** Pass the current account/device/generation key from the owning workspace. */
  scopeKey?: string;
  accountCurrent?: () => boolean;
  onBusyChange?: (busy: boolean) => void;
  /** Optional host adapter for tests or a supported platform. Defaults to exportTextFile's adapter. */
  exportRuntime?: ExportRuntime;
}
const PREVIEW_LENGTH = 24_000;
function message(error: unknown): string {
  if (error instanceof ReadingExportError) {
    const messages: Record<ReadingExportError['code'], string> = {
      INVALID_DATA: '当前范围含无法验证的已保存内容，导出已停止。原记录没有改动。',
      INVALID_SELECTION: '文献或附件版本已不可用，请重新选择导出范围。',
      UNSUPPORTED_NOTE_FORMAT: '此范围含尚未支持的笔记格式，不能保证原文完整，导出已停止。请缩小范围。',
      UNSUPPORTED_RICH_NOTE: '此范围含尚未支持的富文本格式，无法保证原结构完整，导出已停止。',
      EXPORT_TOO_LARGE: '导出内容超过 4 MiB，请按文献、文献标签或关键词缩小范围。',
      TOO_MANY_ITEMS: `范围超过 ${READING_EXPORT_LIMITS.maxNotes} 条笔记或 ${READING_EXPORT_LIMITS.maxAnnotations} 条批注等导出上限，请缩小范围。`,
      INVALID_JSON: '无法读取汇总文件。', INVALID_ARCHIVE: '汇总结构或来源关系不完整，导出已停止。',
      UNSUPPORTED_FORMAT: '尚不支持此汇总格式版本。',
    };
    return messages[error.code];
  }
  if (error instanceof CitationTransferError) {
    return error.code === 'TOO_MANY_PAPERS' || error.code === 'EXPORT_TOO_LARGE'
      ? '引用超过 500 篇或 4 MiB，请按文献或标签缩小范围。'
      : '所选题录已改变或无法验证，请重新选择引用范围。';
  }
  if (error instanceof FileExportError) return error.code === 'CHANGED'
    ? '账号、筛选或已保存内容已变化，本次导出已取消。请核对新预览后重试。'
    : error.code === 'UNAVAILABLE' ? '此平台尚不能打开文件分享，请使用支持下载的浏览器。'
      : '文件准备或分享失败，请重试。原记录没有改动。';
  return '无法准备导出文件，请重试。原记录没有改动。';
}

/** Embeddable content panel; the owner supplies its sheet/dialog and imports noteExport.css. */
export function NoteExportPanel(props: NoteExportPanelProps) {
  const { entities, initialPaperId, initialAttachmentVersionId, scopeKey = '', accountCurrent } = props;
  const paperSelectId = useId(); const tagSelectId = useId(); const versionSelectId = useId(); const searchId = useId();
  const [paperId, setPaperId] = useState(initialPaperId ?? '');
  const [paperTag, setPaperTag] = useState('');
  const [versionId, setVersionId] = useState(initialAttachmentVersionId ?? '');
  const [query, setQuery] = useState('');
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [includeStandalone, setIncludeStandalone] = useState(true);
  const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null); const [feedback, setFeedback] = useState<string | null>(null);
  const alive = useRef(true); const operation = useRef(0);
  const catalog = useMemo(() => {
    try { return { value: readingExportCatalog(entities), error: null }; }
    catch (error) { return { value: null, error: message(error) }; }
  }, [entities]);
  const selection = useMemo<ReadingExportSelection>(() => ({ paperId: paperId || null, paperTag: paperTag || null,
    attachmentVersionId: versionId || null, query, includeNotes, includeAnnotations, includeStandalone }),
  [paperId, paperTag, versionId, query, includeNotes, includeAnnotations, includeStandalone]);
  const report = useMemo(() => {
    try { return { value: buildReadingExport(entities, selection), error: null }; }
    catch (error) { return { value: null, error: message(error) }; }
  }, [entities, selection]);
  const citationIds = useMemo(() => catalog.value?.papers.filter((paper) => (!paperId || paper.id === paperId)
    && (!paperTag || paper.tags.includes(paperTag))).map((paper) => paper.id) ?? [], [catalog.value, paperId, paperTag]);
  const citations = useMemo(() => {
    if (!catalog.value) return { value: null, error: catalog.error };
    try { return { value: exportPaperQuayCitations(entities, citationIds), error: null }; }
    catch (error) { return { value: null, error: message(error) }; }
  }, [entities, citationIds, catalog.value, catalog.error]);
  const live = useRef({ scopeKey, accountCurrent, report, citations, readingEpoch: 0, citationEpoch: 0, onBusyChange: props.onBusyChange });
  // A preview that changed and later returned to the same contents still retires an old click.
  const readingEpoch = live.current.readingEpoch + Number(live.current.scopeKey !== scopeKey
    || live.current.report.value?.signature !== report.value?.signature);
  const citationEpoch = live.current.citationEpoch + Number(live.current.scopeKey !== scopeKey
    || live.current.citations.value?.signature !== citations.value?.signature);
  live.current = { scopeKey, accountCurrent, report, citations, readingEpoch, citationEpoch, onBusyChange: props.onBusyChange };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; operation.current++; live.current.onBusyChange?.(false); };
  }, []);
  useEffect(() => {
    setPaperId(initialPaperId ?? ''); setVersionId(initialAttachmentVersionId ?? '');
    setError(null); setFeedback(null);
  }, [initialPaperId, initialAttachmentVersionId, scopeKey]);
  useEffect(() => {
    setPaperTag(''); setQuery(''); setIncludeNotes(true); setIncludeAnnotations(true); setIncludeStandalone(true);
  }, [scopeKey]);

  const clearStatus = () => { setError(null); setFeedback(null); };
  const accountValid = () => {
    try { return alive.current && (live.current.accountCurrent?.() ?? true); } catch { return false; }
  };
  async function save(kind: 'markdown' | 'json' | 'citations') {
    if (busyRef.current || !accountValid()) return;
    const value = report.value; const reference = citations.value;
    if (kind === 'citations' ? !reference?.summary.papers : !value || value.summary.notes + value.summary.annotations === 0) return;
    const capturedScope = scopeKey;
    const signature = kind === 'citations' ? reference!.signature : value!.signature;
    const epoch = kind === 'citations' ? citationEpoch : readingEpoch;
    const current = () => accountValid() && live.current.scopeKey === capturedScope
      && (kind === 'citations' ? live.current.citationEpoch : live.current.readingEpoch) === epoch
      && (kind === 'citations' ? live.current.citations.value?.signature : live.current.report.value?.signature) === signature;
    const token = ++operation.current;
    busyRef.current = true; setBusy(true); props.onBusyChange?.(true); clearStatus();
    const file: TextFileExport = kind === 'json'
      ? { name: exportFilename('PaperQuay-阅读汇总', 'json'), text: value!.json, mime: 'application/json' }
      : kind === 'citations'
        ? { name: exportFilename('PaperQuay-编号引用', 'md'), text: reference!.markdown, mime: 'text/markdown' }
        : { name: exportFilename('PaperQuay-阅读汇总', 'md'), text: value!.markdown, mime: 'text/markdown' };
    try {
      const outcome = await exportTextFile(file, current, props.exportRuntime);
      if (current()) setFeedback(outcome === 'download' ? '已开始下载，请在浏览器下载列表中查看文件。'
        : '系统分享面板已关闭；保存结果请在所选应用中确认。');
    } catch (cause) {
      if (current() || (cause instanceof FileExportError && cause.code === 'CHANGED'
        && accountValid() && live.current.scopeKey === capturedScope)) setError(message(cause));
    } finally {
      if (alive.current && operation.current === token) { busyRef.current = false; setBusy(false); live.current.onBusyChange?.(false); }
    }
  }
  const result = report.value;
  const versions = catalog.value?.versions.filter((version) => version.paperId === paperId) ?? [];
  const summary = result?.summary;
  const empty = !summary || summary.notes + summary.annotations === 0;
  return <section className="note-export" aria-label="笔记与批注导出" aria-busy={busy}>
    <h3>笔记、批注与引用</h3>
    <p className="muted">按文献和关联文献标签汇总已保存内容。Markdown 原文与富文本原始结构逐条保留，批注按 PDF 版本列出出处、页码和坐标。</p>
    <div className="note-export-filters">
      <div className="field"><label htmlFor={paperSelectId}>文献范围</label>
        <select id={paperSelectId} value={paperId} disabled={busy || !catalog.value} onChange={(event) => {
          if (busyRef.current) return; setPaperId(event.target.value); setVersionId(''); clearStatus();
        }}><option value="">全部文献</option>{catalog.value?.papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}</select></div>
      <div className="field"><label htmlFor={tagSelectId}>关联文献标签</label>
        <select id={tagSelectId} value={paperTag} disabled={busy || !catalog.value} onChange={(event) => {
          if (busyRef.current) return; setPaperTag(event.target.value); clearStatus();
        }}><option value="">全部标签</option>{catalog.value?.tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></div>
      <div className="field"><label htmlFor={versionSelectId}>批注的 PDF 版本</label>
        <select id={versionSelectId} value={versionId} disabled={busy || !paperId || !includeAnnotations} onChange={(event) => {
          if (busyRef.current) return; setVersionId(event.target.value); clearStatus();
        }}><option value="">各版本分别列出</option>{versions.map((version) => <option key={version.id} value={version.id}>
          {version.fileName} · {version.sha256.slice(0, 12)}…</option>)}</select></div>
      <div className="field"><label htmlFor={searchId}>检索笔记与批注内容</label>
        <input id={searchId} type="search" maxLength={512} value={query} disabled={busy} placeholder="标题、正文、摘录或评论"
          onChange={(event) => { if (!busyRef.current) { setQuery(event.target.value); clearStatus(); } }} /></div>
    </div>
    <div className="note-export-toggles">
      <label><input type="checkbox" checked={includeNotes} disabled={busy} onChange={(event) => {
        if (!busyRef.current) { setIncludeNotes(event.target.checked); clearStatus(); }
      }} />包含笔记（Markdown 与富文本）</label>
      <label><input type="checkbox" checked={includeAnnotations} disabled={busy} onChange={(event) => {
        if (!busyRef.current) { setIncludeAnnotations(event.target.checked); clearStatus(); }
      }} />包含批注</label>
      <label><input type="checkbox" checked={includeStandalone && !paperId && !paperTag} disabled={busy || Boolean(paperId || paperTag) || !includeNotes}
        onChange={(event) => { if (!busyRef.current) { setIncludeStandalone(event.target.checked); clearStatus(); } }} />全库范围包含独立笔记</label>
    </div>
    <p className="note-export-hint">标签来自关联文献；独立笔记没有文献标签。笔记不绑定 PDF 版本，版本筛选只影响批注。删除记录和未保存草稿不导出。</p>
    {(catalog.error || report.error) && <p className="inline-error" role="alert">{catalog.error || report.error}</p>}
    {summary && <div className="note-export-summary" aria-live="polite">
      <strong>{summary.notes} 条笔记 · {summary.annotations} 条批注</strong>
      <span>{summary.papers} 篇有题录的关联文献 · {summary.versions} 个有元数据的 PDF 版本 · {summary.standaloneNotes} 条独立笔记</span>
      {summary.richNotes > 0 && <span>{summary.richNotes} 条富文本笔记 · {summary.embeddedImages} 条嵌入图片记录 · {summary.embeddedImageBytes.toLocaleString()} 字节图片数据</span>}
    </div>}
    {summary && summary.richNotes > 0 && <p className="note-export-hint">此范围使用阅读汇总 JSON v2，保留完整富文本结构、元数据及图片字节与 SHA-256。Markdown 文件含可读正文与同等完整 JSON 结构。富文本中的原始文献、笔记等引用标识保留；历史锚点不表示 PDF 已重新验证。</p>}
    {summary && (summary.pending > 0 || summary.unresolvedNotes > 0 || summary.unresolvedAnnotations > 0) && <ul className="note-export-warnings">
      {summary.pending > 0 && <li>{summary.pending} 项来源仍有待处理内容，其中 {summary.conflicts} 项存在同步冲突；导出本设备当前可见的已保存版本。</li>}
      {summary.unresolvedNotes > 0 && <li>{summary.unresolvedNotes} 条笔记的关联文献不可用；文件保留明确的缺失来源记录。</li>}
      {summary.unresolvedAnnotations > 0 && <li>{summary.unresolvedAnnotations} 条批注有版本、页码或来源提示；不推断替代文献或 PDF。</li>}
    </ul>}
    {result && <details className="note-export-preview"><summary>预览汇总内容</summary>
      <pre>{result.markdown.slice(0, PREVIEW_LENGTH)}</pre>
      {result.markdown.length > PREVIEW_LENGTH && <p className="note-export-hint">此处只预览前 {PREVIEW_LENGTH.toLocaleString()} 个字符，导出文件包含本次范围的完整内容。</p>}
    </details>}
    <div className="note-export-actions">
      <button type="button" className="primary" disabled={busy || empty} onClick={() => void save('markdown')}>导出阅读汇总 Markdown</button>
      <button type="button" className="secondary" disabled={busy || empty} onClick={() => void save('json')}>导出阅读汇总 JSON</button>
    </div>
    <p className="note-export-hint">JSON 主列表使用文件内部引用，保存题录、原始正文、批注坐标和已保存的版本指纹；富文本原始结构另保留原始引用标识。它不包含 PDF 或账号会话，也不是可恢复到文库的账号备份。本次没有重新读取 PDF 验证指纹。</p>
    <section className="note-export-citations" aria-label="PaperQuay 编号引用">
      <h4>PaperQuay 编号格式</h4>
      <p>使用与桌面综述导出相同的确定性引用格式；不声称 APA、CSL 或 GB/T，不补写缺少的卷期页与文献类型。</p>
      <p className="note-export-hint">此处按文献和标签选择题录，内容关键词只筛选上方笔记与批注。</p>
      {citations.value && <><details className="note-export-preview"><summary>预览 {citations.value.summary.papers} 篇参考文献</summary>
        <ol>{citations.value.citations.map((citation) => <li key={citation.paperId}><span>{citation.label}</span> {citation.text}</li>)}</ol></details>
        {citations.value.summary.pending > 0 && <p className="note-export-hint">{citations.value.summary.pending} 篇题录含待处理内容；导出当前可见的已保存题录。</p>}</>}
      {citations.error && <p className="inline-error" role="alert">{citations.error}</p>}
      <button type="button" className="secondary" disabled={busy || !citations.value?.summary.papers}
        onClick={() => void save('citations')}>导出 PaperQuay 编号引用</button>
    </section>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {feedback && <p className="note-export-feedback" role="status">{feedback}</p>}
  </section>;
}
