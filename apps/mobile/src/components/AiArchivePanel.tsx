import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AI_ACTION_LABELS } from '../ai/context.ts';
import { AiError, describeAiError } from '../ai/errors.ts';
import { aiAccountKey } from '../ai/provider.ts';
import {
  AiArchiveError, createAiQuestionTemplate, deriveAiHistoryResult,
  type AiArchiveItem, type AiArchiveSummary, type AiHistoryRecord, type AiQuestionTemplate,
} from '../ai/archiveTypes.ts';
import { getAiArchiveStore, type AiArchiveStore } from '../ai/archiveStore.ts';
import type { AiAccountScope, AiAction, AiResult, PdfAiContext, PdfCitationTarget } from '../ai/types.ts';

export interface AiArchivePanelProps {
  resetEpoch?: number;
  accountScope: AiAccountScope;
  currentContext: PdfAiContext | null;
  contextIdentity: string | null;
  currentResult: AiResult | null;
  busy: boolean;
  draft: { action: AiAction; question: string };
  captureRecord(requestId: string): AiHistoryRecord;
  canCaptureRecord(requestId: string): boolean;
  onApplyDraft(action: AiAction, question: string): void;
  onNavigateCitation(target: PdfCitationTarget): void;
  archiveStore?: AiArchiveStore;
}
interface Task { signal: AbortSignal; check(): void; guard(): boolean }
const statusLabels = { complete: '完成', incomplete: '不完整', cancelled: '已取消', failed: '失败' };
const errors = {
  INVALID_ITEM: '问答记录或模板格式不受支持，原有内容已保留。',
  RECORD_LIMIT: '内容超过单条或问题长度上限，未保存；请缩小内容范围后重试。',
  ARCHIVE_FULL: '本账号的本机问答空间已满。请删除不再需要的记录或模板后重试。',
  ARCHIVE_CORRUPT: '本机记录不完整，暂时无法读取。可清空此账号的问答记录和模板后重新使用。',
  ARCHIVE_UNAVAILABLE: '无法访问本机问答存储，请检查设备空间或稍后重试。',
  ITEM_CHANGED: '内容已在其他窗口变化。请重新读取后再编辑或删除，当前草稿已保留。',
  ACCOUNT_CHANGED: '账号、请求来源或本机记录集合已变化，此次操作已停止。',
};
function failure(error: unknown): string { return error instanceof AiArchiveError ? errors[error.code]
  : error instanceof AiError ? describeAiError(error) : errors.ARCHIVE_UNAVAILABLE; }

export function AiArchivePanel(props: AiArchivePanelProps) {
  let account: string;
  try { account = aiAccountKey(props.accountScope); }
  catch { return <p role="alert">当前账号范围无效，无法读取本机问答与模板。</p>; }
  return <AccountAiArchivePanel key={`${account}:${props.resetEpoch ?? 0}`} {...props} />;
}

const AccountAiArchivePanel = memo(function AccountAiArchivePanel(props: AiArchivePanelProps) {
  const id = useId();
  const account = aiAccountKey(props.accountScope);
  const latest = useRef(props); latest.current = props;
  const mounted = useRef(false), generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const storage = useRef<AiArchiveStore | null>(null);
  const [open, setOpen] = useState(false), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [items, setItems] = useState<AiArchiveSummary[]>([]);
  const [tab, setTab] = useState<'record' | 'template'>('record');
  const [selected, setSelected] = useState<AiArchiveItem | null>(null);
  const selectedNow = useRef(selected); selectedNow.current = selected;
  const [editing, setEditing] = useState(false), [previous, setPrevious] = useState<AiQuestionTemplate | null>(null);
  const [title, setTitle] = useState(''), [question, setQuestion] = useState(''), [action, setAction] = useState<AiAction>('ask');
  const store = useCallback(() => storage.current ??= latest.current.archiveStore ?? getAiArchiveStore(), []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; active.current?.abort(); };
  }, [account]);

  const run = useCallback(async (label: string, work: (task: Task, scope: AiAccountScope) => Promise<void>) => {
    active.current?.abort();
    const abort = new AbortController(), token = ++generation.current;
    active.current = abort;
    const scope = { ...latest.current.accountScope }, key = aiAccountKey(scope);
    const guard = () => mounted.current && !abort.signal.aborted && token === generation.current && aiAccountKey(latest.current.accountScope) === key;
    const check = () => { if (!guard()) throw new AiArchiveError('ACCOUNT_CHANGED'); };
    setBusy(label); setError(''); setNotice('');
    try { check(); await work({ signal: abort.signal, check, guard }, scope); }
    catch (problem) { if (guard()) setError(failure(problem)); }
    finally { if (mounted.current && token === generation.current) { setBusy(null); active.current = null; } }
  }, []);
  const refresh = useCallback(async (task: Task, scope: AiAccountScope) => {
    const rows = await store().list(scope); task.check(); setItems(rows); setLoaded(true);
  }, [store]);
  const load = useCallback(() => void run('正在读取本机问答…', async (task, scope) => { await refresh(task, scope); }), [run, refresh]);

  const saveCurrent = () => {
    const result = latest.current.currentResult;
    if (!result || result.status === 'running' || busy) return;
    let record: AiHistoryRecord;
    try { record = latest.current.captureRecord(result.requestId); }
    catch (problem) { setError(failure(problem)); return; }
    const identity = result.contextIdentity;
    void run('正在保存本机问答…', async (task, scope) => {
      const guard = () => task.guard() && latest.current.contextIdentity === identity && latest.current.canCaptureRecord(record.id);
      await store().put(scope, record, { signal: task.signal, guard, expectedRevision: 0 });
      task.check(); await refresh(task, scope); setNotice('问答已保存到此账号的本机记录，刷新后仍可查看。');
    });
  };
  const choose = (item: AiArchiveSummary) => {
    setSelected(null); setEditing(false);
    void run('正在读取保存的内容…', async (task, scope) => {
      const value = await store().read(scope, item.kind, item.id, { signal: task.signal, guard: task.guard }); task.check();
      if (!value || value.revision !== item.revision) throw new AiArchiveError('ITEM_CHANGED');
      setSelected(value);
    });
  };
  const remove = (item: AiArchiveSummary | AiArchiveItem) => {
    if (!window.confirm(item.kind === 'record' ? '删除此条本机问答记录？已保存的文献笔记和 PDF 会保留。' : '删除此问题模板？当前输入框中的问题会保留。')) return;
    void run('正在删除本机内容…', async (task, scope) => {
      await store().remove(scope, item.kind, item.id, { expectedRevision: item.revision, signal: task.signal, guard: task.guard });
      task.check(); setSelected(null); setEditing(false); await refresh(task, scope); setNotice('本机内容已删除。');
    });
  };
  const beginTemplate = (value: AiQuestionTemplate | null) => {
    setPrevious(value); setEditing(true); setError(''); setNotice('');
    setTitle(value?.title ?? Array.from(latest.current.draft.question.trim()).slice(0, 64).join(''));
    setQuestion(value?.question ?? latest.current.draft.question); setAction(value?.action ?? latest.current.draft.action);
  };
  const saveTemplate = () => {
    let template: AiQuestionTemplate;
    try {
      const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
      template = createAiQuestionTemplate({ id: previous?.id ?? crypto.randomUUID(), title: title.trim(), action, question },
        { ...(previous ? { previous } : {}), now });
    } catch (problem) { setError(failure(problem)); return; }
    void run('正在保存问题模板…', async (task, scope) => {
      const saved = await store().put(scope, template, { expectedRevision: previous?.revision ?? 0, signal: task.signal, guard: task.guard });
      task.check(); setSelected(saved); setEditing(false); await refresh(task, scope); setNotice('问题模板已保存到此账号的本机。');
    });
  };
  const apply = (value: { action: AiAction; question: string }) => {
    if (latest.current.busy || busy) return;
    const draft = latest.current.draft;
    if (draft.question.trim() && (draft.question !== value.question || draft.action !== value.action)
      && !window.confirm('用保存的问题替换当前输入框中的问题与辅助任务？')) return;
    latest.current.onApplyDraft(value.action, value.question); setNotice('已填入当前问题。请核对上方发送范围，再明确点击发送。');
  };
  const history = useMemo(() => selected?.kind === 'record' ? deriveAiHistoryResult(selected) : null, [selected]);
  const samePdf = Boolean(history && props.currentContext && history.source.paperId === props.currentContext.paperId
    && history.source.attachmentVersionId === props.currentContext.attachmentVersionId && history.source.sha256 === props.currentContext.sha256);
  const navigateHistory = (target: PdfCitationTarget) => {
    const current = latest.current.currentContext;
    if (!mounted.current || !history || selectedNow.current?.kind !== 'record' || selectedNow.current.id !== history.requestId
      || aiAccountKey(latest.current.accountScope) !== account || !current || current.paperId !== history.source.paperId
      || current.attachmentVersionId !== history.source.attachmentVersionId || current.sha256 !== history.source.sha256
      || target.attachmentVersionId !== current.attachmentVersionId || target.sha256 !== current.sha256
      || target.pageIndex < 0 || target.pageIndex >= current.totalPages) return;
    latest.current.onNavigateCitation(target);
  };
  const visible = items.filter(item => item.kind === tab);
  return <section className="ai-archive" aria-label="本机问答记录与问题模板">
    {props.currentResult && props.currentResult.status !== 'running' && <div className="ai-archive-save">
      <button type="button" className="secondary" disabled={Boolean(busy) || props.busy} onClick={saveCurrent}>保存此问答到本机记录</button>
      <p>保存本次输入、问题、结果与模型引用；只保存在此设备当前账号下。</p>
    </div>}
    <details open={open} onToggle={event => { const next = event.currentTarget.open; setOpen(next); if (next && !loaded && !busy) load(); }}>
      <summary>本机问答记录与问题模板</summary>
      {open && <div className="ai-archive-content">
        <p className="ai-field-help">记录是一轮独立问答。查看记录不会请求模型；问题模板只填入当前输入框。记录与模板最多共 16 MiB，最多 50 条记录、100 个模板。</p>
        <div className="ai-archive-toolbar"><div role="group" aria-label="本机内容类别">
          <button type="button" aria-pressed={tab === 'record'} disabled={Boolean(busy)} onClick={() => { setTab('record'); setSelected(null); setEditing(false); }}>问答记录</button>
          <button type="button" aria-pressed={tab === 'template'} disabled={Boolean(busy)} onClick={() => { setTab('template'); setSelected(null); setEditing(false); }}>问题模板</button>
        </div><button type="button" disabled={Boolean(busy)} onClick={load}>重新读取</button></div>
        <div className="ai-archive-list" aria-label={tab === 'record' ? '已保存问答' : '已保存问题模板'}>
          {visible.map(item => <div key={item.id} className="ai-archive-row">
            <button type="button" disabled={Boolean(busy)} aria-pressed={selected?.id === item.id} onClick={() => choose(item)}>
              <strong>{item.title}</strong><small>{item.status ? statusLabels[item.status] + ' · ' : ''}{new Date(item.updatedAt).toLocaleString()}</small></button>
            <button type="button" disabled={Boolean(busy)} aria-label={`删除${item.kind === 'record' ? '记录' : '模板'} ${item.title}`} onClick={() => remove(item)}>删除</button>
          </div>)}
          {loaded && !visible.length && <p className="ai-muted">{tab === 'record' ? '此账号在本设备还没有保存的问答。' : '此账号在本设备还没有问题模板。'}</p>}
        </div>
        {tab === 'template' && !editing && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => beginTemplate(null)}>从当前问题创建模板</button>}
        {editing && <form className="ai-template-form" aria-label="编辑问题模板" onSubmit={event => { event.preventDefault(); saveTemplate(); }}>
          <label htmlFor={id + '-title'}>模板名称</label><input id={id + '-title'} value={title} maxLength={128} disabled={Boolean(busy)} onChange={event => setTitle(event.target.value)} />
          <label htmlFor={id + '-action'}>模板任务</label><select id={id + '-action'} value={action} disabled={Boolean(busy)} onChange={event => setAction(event.target.value as AiAction)}>
            {Object.entries(AI_ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select><label htmlFor={id + '-question'}>模板问题</label><textarea id={id + '-question'} rows={4} value={question} disabled={Boolean(busy)} onChange={event => setQuestion(event.target.value)} />
          <div className="ai-archive-actions"><button type="submit" className="primary" disabled={Boolean(busy) || !title.trim() || !question.trim()}>保存问题模板</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => setEditing(false)}>取消编辑模板</button></div>
        </form>}
        {selected?.kind === 'template' && !editing && <section className="ai-archive-detail" aria-label="保存的问题模板">
          <h3>{selected.title}</h3><p>{AI_ACTION_LABELS[selected.action]}</p><pre>{selected.question}</pre>
          <div className="ai-archive-actions"><button type="button" disabled={props.busy || Boolean(busy)} onClick={() => apply(selected)}>填入当前问题</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => beginTemplate(selected)}>编辑此模板</button></div>
        </section>}
        {history && selected?.kind === 'record' && <section className="ai-archive-detail" aria-label="保存的问答记录">
          <h3>{AI_ACTION_LABELS[history.action]} · {history.source.label}</h3>
          <p>{statusLabels[selected.result.status]} · 第 {history.source.pageIndices.map(page => page + 1).join('、')} 页 · {history.source.scopeLabel}</p>
          <p className="ai-field-help">版本 {history.source.attachmentVersionId.slice(0, 8)} · PDF SHA-256 {history.source.sha256.slice(0, 12)}
            {history.source.textSource && <> · 解析包摘要 {history.source.textSource.packageDigest.slice(0, 12)}</>}</p>
          <p className="ai-field-help">当时的模型：{history.provider.model} · {history.provider.endpoint}</p>
          <h4>当时的问题或补充要求</h4><pre>{history.question || '未填写补充要求。'}</pre>
          <h4>保存的结果</h4><pre>{history.text || '此记录没有返回可显示的文字。'}</pre>
          {history.failure && <p className="ai-warning">{describeAiError(history.failure)}</p>}
          {!!history.citations.length && <div className="ai-archive-actions" aria-label="历史记录引用页码">
            {history.citations.map(citation => <button type="button" key={citation.pageNumber} disabled={!samePdf} onClick={() => navigateHistory(citation.target)}>查看 PDF 第 {citation.pageNumber} 页</button>)}
          </div>}
          {!samePdf && <p className="ai-field-help">在阅读器选择相同 PDF 版本的文字后，可使用历史记录的页码回跳。</p>}
          {!!history.unverifiedPageNumbers.length && <p className="ai-warning">记录中的第 {history.unverifiedPageNumbers.join('、')} 页未在当时输入中提供，引用未经核验。</p>}
          <details><summary>查看保存的输入原文</summary>{selected.context.pages.map(page => <div key={page.pageIndex}><h4>第 {page.pageIndex + 1} 页</h4><pre>{page.text}</pre></div>)}</details>
          <p className="ai-field-help">{history.usage ? `服务商返回用量 ${history.usage.totalTokens} tokens；` : '用量未知；'}费用未知，以服务商账单为准。</p>
          <button type="button" disabled={props.busy || Boolean(busy)} onClick={() => apply(history)}>把此问题填入当前输入框</button>
        </section>}
        <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => {
          if (!window.confirm('清除此账号在本设备保存的全部问答记录和问题模板？文库笔记、PDF、当前问题和模型设置会保留。')) return;
          void run('正在清空本机问答与模板…', async (task, scope) => {
            await store().clear(scope, { signal: task.signal, guard: task.guard }); task.check();
            setItems([]); setSelected(null); setEditing(false); setLoaded(true); setNotice('此账号的本机问答记录与问题模板已清空。');
          });
        }}>清空此账号的本机问答与模板</button>
      </div>}
    </details>
    {busy && <p role="status" className="ai-field-help">{busy}</p>}
    {error && <p role="alert" className="ai-error">{error}</p>}
    {notice && <p role="status" className="ai-notice">{notice}</p>}
  </section>;
});
