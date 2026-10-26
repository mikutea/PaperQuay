import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { NoteData, VisibleEntity } from '../../../../packages/sync-core/src/index.ts';
import { ClientError, describeError } from '../errors.ts';
import {
  exportLibraryArchive, LIBRARY_TRANSFER_LIMITS, LibraryTransferError, parseLibraryArchive, planLibraryImport,
  type LibraryArchive, type LibraryImportRow,
} from '../library/libraryTransfer.ts';
import { exportFilename, exportTextFile, FileExportError } from '../platform/exportFile.ts';
import type { WorkspaceController } from '../sync/workspace.ts';
import { ReaderSheet } from './ReaderSheet.tsx';
import './readerSheet.css';
import './libraryTransfer.css';

interface Props {
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
  if (error instanceof ClientError) return describeError(error);
  if (error instanceof FileExportError) {
    if (error.code === 'CHANGED') return '账号已变化，请关闭此面板后重试。';
    if (error.code === 'UNAVAILABLE') return '此设备暂不支持文件分享，请使用包含分享组件的完整安装包。';
    return '导出或分享未完成。可以重新导出文件。';
  }
  if (error instanceof LibraryTransferError) {
    if (error.code === 'ARCHIVE_TOO_LARGE') return '文件超出本次导入上限：4 MB、500 篇文献和 500 条笔记。请拆分后重试。';
    if (error.issues.some((issue) => issue.code === 'TOO_MANY_ITEMS')) return '本次文件最多支持 500 篇文献和 500 条笔记。请缩小范围后重试。';
    if (error.code === 'INVALID_JSON') return 'JSON 文件无法读取，请检查文件内容或重新导出。';
    if (error.code === 'UNSUPPORTED_FORMAT') return '请选择 PaperQuay 文库 JSON 或 Markdown 文件。';
    if (error.code === 'BLOCKED_ASSOCIATION') return '所选笔记的文献关联尚未确定，请先处理下方提示。';
    if (error.code === 'EMPTY_SELECTION') return '请至少选择一项内容。';
    return '文件内容不符合当前导入格式，请检查记录字段、关联与内容长度。';
  }
  return '未能读取或处理此文件，请重新选择后重试。';
}

function rowDetail(row: LibraryImportRow): string {
  const parts: string[] = [];
  if (row.duplicate) parts.push(row.duplicate.reason === 'doi' ? '相同 DOI，默认跳过' : '已有相同内容，默认跳过');
  if (row.association?.kind === 'new-paper') parts.push(`关联本次文献：${row.association.paperTitle}`);
  if (row.association?.kind === 'existing-paper') parts.push(`关联现有文献：${row.association.paperTitle}`);
  if (row.association?.kind === 'none') parts.push('独立笔记');
  if (row.blockedReason === 'PAPER_NOT_SELECTED') parts.push('请同时选择它关联的文献，或跳过此笔记');
  if (row.blockedReason === 'MISSING_PAPER') parts.push('文件中缺少关联文献，请补全后重新导入');
  if (row.blockedReason === 'AMBIGUOUS_PAPER') parts.push('存在多个匹配文献；选择文件中的文献另存副本后即可关联');
  return parts.join('。');
}

export function LibraryTransferPanel({ entities, controller, scopeKey, accountCurrent, onClose }: Props) {
  const [tab, setTab] = useState<'import' | 'export'>('import');
  const [archive, setArchive] = useState<LibraryArchive | null>(null);
  const [filename, setFilename] = useState('');
  const [selection, setSelection] = useState<readonly string[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [noteId, setNoteId] = useState('');
  const alive = useRef(true);
  const operation = useRef(0);
  const busyRef = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const noteSelectId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current++; }; }, []);
  const current = () => alive.current && accountCurrent() && libraryTransferScope(controller) === scopeKey;
  const planned = useMemo(() => {
    if (!archive) return null;
    try { return { plan: planLibraryImport(archive, entities, selection), error: null }; }
    catch (cause) { return { plan: null, error: message(cause) }; }
  }, [archive, entities, selection]);
  const plan = planned?.plan;
  const exported = useMemo(() => {
    if (tab !== 'export') return null;
    try { return { result: exportLibraryArchive(entities), error: null }; }
    catch (cause) {
      const tooLarge = cause instanceof LibraryTransferError && (cause.code === 'ARCHIVE_TOO_LARGE'
        || cause.issues.some((issue) => issue.code === 'TOO_MANY_ITEMS'));
      return { result: null, error: tooLarge
        ? '当前文库超过本次 JSON 导出上限（4 MB、500 篇文献和 500 条笔记）。逐条导出 Markdown 仍可使用，分批文库导出尚未支持。'
        : message(cause) };
    }
  }, [entities, tab]);
  const notes = entities.filter((entity) => entity.entityType === 'note' && !entity.deleted && entity.data) as (VisibleEntity & { data: NoteData })[];
  const chosenNote = notes.find((note) => note.entityId === noteId);

  function changeTab(next: 'import' | 'export') {
    if (busyRef.current) return;
    setTab(next); setError(null); setFeedback(null);
  }
  async function readFile(file?: File) {
    if (!file || busyRef.current || !current()) return;
    const request = ++operation.current;
    busyRef.current = true; setBusy(true); setError(null); setFeedback(null); setArchive(null); setSelection(undefined);
    try {
      if (file.size > LIBRARY_TRANSFER_LIMITS.maxBytes) throw new LibraryTransferError('ARCHIVE_TOO_LARGE');
      const text = await file.text();
      if (!current() || operation.current !== request) return;
      const value = /\.(md|markdown)$/i.test(file.name)
        ? parseLibraryArchive(JSON.stringify({ format: 'paperquay-library', version: 1, papers: [], notes: [
          { ref: 'n1', paperRef: null, title: file.name.replace(/\.(md|markdown)$/i, '').slice(0, 2048) || '导入笔记', body: text, format: 'markdown' },
        ] })) : parseLibraryArchive(text);
      setFilename(file.name); setArchive(value);
    } catch (cause) { if (current() && operation.current === request) setError(message(cause)); }
    finally {
      busyRef.current = false;
      if (alive.current && operation.current === request) setBusy(false);
    }
  }
  function toggle(row: LibraryImportRow) {
    if (!plan || busyRef.current) return;
    const keys = new Set(plan.rows.filter((entry) => entry.selected).map((entry) => entry.key));
    if (keys.has(row.key)) keys.delete(row.key); else keys.add(row.key);
    setSelection([...keys]); setError(null); setFeedback(null);
  }
  async function confirmImport() {
    if (!plan || busyRef.current || !current()) return;
    busyRef.current = true; setBusy(true); setError(null); setFeedback(null);
    try {
      const result = await controller.importLibrary(plan.archive, selection, plan.signature);
      if (!current()) return;
      setArchive(null); setSelection(undefined);
      setFeedback(`已保存 ${result.selectedPapers} 篇文献、${result.selectedNotes} 条笔记到此设备，联网后继续同步。`);
    } catch (cause) { if (current()) setError(message(cause)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function saveExport(kind: 'library' | 'note') {
    if (busyRef.current || !current()) return;
    const result = exported?.result;
    if ((kind === 'library' && !result) || (kind === 'note' && !chosenNote?.data)) return;
    busyRef.current = true; setBusy(true); setError(null); setFeedback(null);
    try {
      const note = chosenNote?.data as NoteData | undefined;
      const outcome = await exportTextFile(kind === 'library'
        ? { name: `PaperQuay-library-${new Date().toISOString().slice(0, 10)}.json`, text: result!.json, mime: 'application/json' }
        : { name: exportFilename(note!.title || '未命名笔记', 'md'), text: note!.body, mime: 'text/markdown' }, current);
      if (current()) setFeedback(outcome === 'download' ? '已开始下载，请在浏览器下载列表中查看文件。' : '系统分享面板已关闭；保存结果请在所选应用中确认。');
    } catch (cause) { if (current()) setError(message(cause)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  const selected = plan ? plan.summary.selectedPapers + plan.summary.selectedNotes : 0;
  return <ReaderSheet open title="导入与导出" onClose={onClose} className="library-transfer-sheet">
    <div className="library-transfer">
      <div className="transfer-tabs" role="group" aria-label="文件操作">
        <button type="button" aria-pressed={tab === 'import'} disabled={busy} onClick={() => changeTab('import')}>导入</button>
        <button type="button" aria-pressed={tab === 'export'} disabled={busy} onClick={() => changeTab('export')}>导出</button>
      </div>
      {tab === 'import' ? <>
        <section className="transfer-intro">
          {!archive && <><h3>将文件加入文库</h3>
            <p className="muted">选择 PaperQuay 文库 JSON 或 Markdown 笔记，确认预览后保存。</p></>}
          <input ref={input} type="file" accept=".json,.md,.markdown,application/json,text/markdown" hidden
            aria-label="选择导入文件" onChange={(event) => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void readFile(file);
            }} />
          <div className={archive ? 'transfer-source' : undefined}>
            {archive && <p className="transfer-filename">{filename}</p>}
            <button type="button" className="secondary" disabled={busy} onClick={() => input.current?.click()}>
              {archive ? '更换文件' : '选择文件'}</button>
          </div>
          {!archive && <p className="transfer-hint">每次最多 4 MB、500 篇文献和 500 条笔记。</p>}
        </section>
        {plan && <section className="transfer-preview" aria-label="导入预览">
          <h3>预览导入</h3>
          <p>选中 {plan.summary.selectedPapers} 篇文献、{plan.summary.selectedNotes} 条笔记；跳过 {plan.summary.skipped} 项。</p>
          <p className="transfer-hint">重复项默认跳过；勾选后另存副本。现有内容保持不变。</p>
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
          </li>)}</ul>
          {plan.summary.selectedBlockedNotes > 0 && <p className="inline-error" role="status">有 {plan.summary.selectedBlockedNotes} 条笔记的关联需要处理。</p>}
          <div className="transfer-confirm">
            {error && <p className="inline-error transfer-message" role="alert">{error}</p>}
            <button type="button" className="primary"
            disabled={busy || selected === 0 || plan.summary.selectedBlockedNotes > 0} onClick={() => void confirmImport()}>
            {busy ? '正在保存…' : `导入所选 ${selected} 项`}</button></div>
        </section>}
        {busy && !plan && <p role="status">正在读取文件…</p>}
        {planned?.error && <p className="inline-error" role="alert">{planned.error}</p>}
      </> : <>
        <section className="transfer-export">
          <h3>文库 JSON</h3>
          <p className="muted">导出已保存的题录、分类与 Markdown 笔记，可在这里重新导入。</p>
          {exported?.result && <>
            <p>{exported.result.summary.papers} 篇文献 · {exported.result.summary.notes} 条笔记</p>
            {exported.result.summary.unresolvedNoteLinks > 0 && <p className="transfer-hint">{exported.result.summary.unresolvedNoteLinks} 条笔记的关联文献不可用，文件会保留待核对的关联；重新导入时需补全对应文献。</p>}
            {exported.result.summary.conflicted > 0 && <p className="transfer-hint">其中 {exported.result.summary.conflicted} 项仍有同步冲突，将导出此设备当前显示的已保存内容。</p>}
            <button type="button" className="primary" disabled={busy || !exported.result.summary.papers && !exported.result.summary.notes}
              onClick={() => void saveExport('library')}>导出文库 JSON</button>
          </>}
          <p className="transfer-hint">不包含 PDF、批注、AI 会话、未保存草稿或账号设置。单个导出文件最多 4 MB。</p>
          {exported?.error && <p className="inline-error" role="alert">{exported.error}</p>}
        </section>
        <section className="transfer-export">
          <h3>Markdown 笔记</h3>
          <div className="field"><label htmlFor={noteSelectId}>选择已保存的笔记</label>
            <select id={noteSelectId} value={noteId} disabled={busy || notes.length === 0} onChange={(event) => setNoteId(event.target.value)}>
              <option value="">{notes.length ? '请选择一条笔记' : '还没有可导出的笔记'}</option>
              {notes.map((note) => <option key={note.entityId} value={note.entityId}>{note.data?.title || '未命名笔记'}</option>)}
            </select></div>
          <button type="button" className="secondary" disabled={busy || !chosenNote} onClick={() => void saveExport('note')}>导出 Markdown</button>
        </section>
      </>}
      {error && !(tab === 'import' && plan) && <p className="inline-error transfer-message" role="alert">{error}</p>}
      {feedback && <p className="transfer-message transfer-success" role="status">{feedback}</p>}
    </div>
  </ReaderSheet>;
}
