import { useEffect, useId, useRef, useState } from 'react';
import {
  appendAiConversation, conversationRecord, createAiConversation, validateAiTemplate,
  type AiConversationData, type AiTemplateData,
} from '../../../../packages/ai-core/src/conversation.ts';
import { AiArchiveError, deriveAiHistoryResult, type AiHistoryRecord } from '../ai/archiveTypes.ts';
import { AI_ACTION_LABELS } from '../ai/context.ts';
import { AiError, describeAiError } from '../ai/errors.ts';
import type { AiAction, AiResult, PdfCitationTarget } from '../ai/types.ts';
import type { AiSyncBridge, AiSyncEntry, AiSyncKind } from '../integration/aiSync.ts';
import { describeError } from '../errors.ts';

export interface AiSyncPanelProps {
  bridge?: AiSyncBridge;
  draft: { action: AiAction; question: string };
  currentResult: AiResult | null;
  busy: boolean;
  activeId: string | null;
  captureRecord(id: string): AiHistoryRecord;
  continuationFor(id: string): AiSyncEntry<AiConversationData> | undefined;
  onSelect(entry: AiSyncEntry<AiConversationData> | null): void;
  onSaved(id: string): void;
  onApplyDraft(action: AiAction, question: string): void;
  onNavigateCitation(target: PdfCitationTarget): void;
}
const statuses = { complete: '完成', incomplete: '不完整', cancelled: '已取消', failed: '失败' };
const delivery = (entry: AiSyncEntry<unknown>) => entry.conflicted ? '有冲突，请先比较' : entry.status === 'synced' ? '已同步' : '已保存到本机，等待同步';
function errorText(error: unknown) {
  return error instanceof AiError ? describeAiError(error) : error instanceof AiArchiveError ? error.code === 'RECORD_LIMIT'
    ? '会话超过24轮或1 MiB上限，未保存。请另建会话，原有内容仍保留。'
    : '内容已变化或格式不受支持，未覆盖原有会话。' : describeError(error);
}

/** Account changes remount the parent. Explicit save joins the normal outbox;
 * viewing or selecting a template performs no model or external API request. */
export function AiSyncPanel(props: AiSyncPanelProps) {
  const id = useId(), latest = useRef(props); latest.current = props;
  const generation = useRef(0), mounted = useRef(false);
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [viewId, setViewId] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ requestId: string; id: string } | null>(null);
  const [template, setTemplate] = useState<AiSyncEntry<AiTemplateData> | null>(null);
  const [editing, setEditing] = useState(false), [title, setTitle] = useState('');
  const [action, setAction] = useState<AiAction>('ask'), [question, setQuestion] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const bridge = props.bridge, view = bridge?.conversations.find(entry => entry.id === viewId);
  async function run(work: () => Promise<void>) {
    if (inFlight.current || latest.current.busy || !latest.current.bridge?.enabled) return;
    inFlight.current = true;
    const token = ++generation.current;
    setSaving(true); setError(''); setNotice('');
    try { await work(); }
    catch (failure) { if (mounted.current && token === generation.current) setError(errorText(failure)); }
    finally { if (mounted.current && token === generation.current) { inFlight.current = false; setSaving(false); } }
  }
  function saveResult(mode: 'append' | 'branch' | 'round') {
    const source = latest.current, result = source.currentResult;
    if (source.busy || !source.bridge?.enabled || !result || result.status === 'running') return;
    let record: AiHistoryRecord, data: AiConversationData;
    const previous = source.continuationFor(result.requestId);
    try {
      record = source.captureRecord(result.requestId);
      data = mode !== 'round' && previous ? appendAiConversation(previous.data, record) : createAiConversation(record);
    } catch (failure) { setError(errorText(failure)); return; }
    void run(async () => {
      const entityId = await source.bridge!.saveConversation(data, mode === 'append' ? previous : undefined);
      if (!mounted.current) return;
      setSaved({ requestId: result.requestId, id: entityId }); setViewId(entityId); source.onSaved(entityId);
      setNotice('会话已保存到本机同步队列。其他设备需连接同一账号的同步服务后读取。');
    });
  }
  function remove(kind: AiSyncKind, entry: AiSyncEntry<AiConversationData | AiTemplateData>) {
    const source = latest.current;
    if (source.busy || !source.bridge?.enabled || !window.confirm(kind === 'aiConversation'
      ? '删除此同步会话？同步后此账号其他设备也会删除；文献笔记、PDF和本机独立记录仍保留。'
      : '删除此同步模板？同步后此账号其他设备也会删除。')) return;
    void run(async () => {
      await source.bridge!.remove(kind, entry);
      if (!mounted.current) return;
      if (kind === 'aiConversation' && latest.current.activeId === entry.id) latest.current.onSelect(null);
      if (kind === 'aiConversation') setViewId(null);
      else if (template?.id === entry.id) { setTemplate(null); setEditing(false); }
      setNotice('删除已保存到本机同步队列。');
    });
  }
  function editTemplate(entry: AiSyncEntry<AiTemplateData> | null) {
    setTemplate(entry); setEditing(true); setError(''); setNotice('');
    setTitle(entry?.data.title ?? Array.from(props.draft.question.trim()).slice(0, 64).join(''));
    setAction(entry?.data.action ?? props.draft.action); setQuestion(entry?.data.question ?? props.draft.question);
  }
  function saveTemplate() {
    const source = latest.current;
    if (source.busy || !source.bridge?.enabled) return;
    let data: AiTemplateData;
    try { data = validateAiTemplate({ version: 1, title, action, question }); }
    catch (failure) { setError(errorText(failure)); return; }
    if (template && !window.confirm('使用编辑框中的完整问题替换此同步模板？其他设备会收到新版本。')) return;
    void run(async () => {
      await source.bridge!.saveTemplate(data, template ?? undefined);
      if (!mounted.current) return;
      setEditing(false); setTemplate(null); setNotice('模板已保存到本机同步队列。');
    });
  }
  return <details className="ai-sync-panel">
    <summary>同步会话与模板 <span>{bridge?.conversations.length ?? 0} 个会话 · {bridge?.templates.length ?? 0} 个模板</span></summary>
    <p className="ai-field-help">只在你明确保存后，将原文、问题、完整回答与终态同步到此账号。模型设置与密钥保留在本设备。每次继续都会重新发送共同原文和此前已完成的问答，费用以服务商为准。</p>
    {!bridge?.enabled && <p role="status" className="ai-warning">此同步服务尚未启用会话能力。可继续使用本机独立记录。</p>}
    <div className="ai-sync-actions">
      <button type="button" className="secondary" disabled={!bridge?.enabled || saving || props.busy || !props.currentResult || props.currentResult.status === 'running' || saved?.requestId === props.currentResult.requestId}
        onClick={() => saveResult('append')}>保存本轮到同步会话</button>
      {props.currentResult && props.continuationFor(props.currentResult.requestId) && <button type="button" className="text-button"
        disabled={!bridge?.enabled || saving || props.busy} onClick={() => saveResult('branch')}>将完整前文与本轮另存为新会话</button>}
      {props.currentResult && props.continuationFor(props.currentResult.requestId) && <button type="button" className="text-button"
        disabled={!bridge?.enabled || saving || props.busy} onClick={() => saveResult('round')}>仅将本轮另存为新会话（不带前文）</button>}
      {props.activeId && <button type="button" className="text-button" disabled={props.busy || saving} onClick={() => props.onSelect(null)}>结束继续，另开问答</button>}
    </div>
    <h3>会话</h3>
    {!bridge?.conversations.length && <p className="ai-muted">尚无同步会话。</p>}
    <ul className="ai-sync-list">{bridge?.conversations.map(entry => <li key={entry.id}>
      <button type="button" className="text-button" aria-pressed={viewId === entry.id} onClick={() => { setViewId(entry.id); setError(''); }}>{entry.data.title} · {entry.data.turns.length} 轮</button>
      <span className="ai-field-help">{delivery(entry)}{entry.id === props.activeId ? ' · 正在继续' : ''}</span>
    </li>)}</ul>
    {view && <section className="ai-sync-detail" aria-label="同步会话详情">
      <h4>{view.data.title}</h4><p className="ai-field-help">{view.data.context.label} · PDF {view.data.sha256.slice(0, 12)} · {view.data.context.pages.length} 页已保存文字</p>
      <details><summary>查看此会话共同原文</summary>{view.data.context.pages.map(page => <div key={page.pageIndex}><h5>第 {page.pageIndex + 1} 页</h5><pre>{page.text}</pre></div>)}</details>
      {view.data.turns.map((turn, index) => {
        const result = deriveAiHistoryResult(conversationRecord(view.data, index));
        return <article key={turn.id}><h5>第 {index + 1} 轮 · {AI_ACTION_LABELS[turn.action]} · {statuses[turn.result.status]}</h5>
          <p>{turn.question || '未填写补充要求。'}</p><pre>{turn.result.text || '未取得回答文字。'}</pre>
          <p className="ai-field-help">{turn.provider.model} · {turn.updatedAt} · {turn.result.usage ? `${turn.result.usage.totalTokens} tokens` : '用量未知'} · 费用未知</p>
          {!!result.citations.length && <div className="ai-sync-actions">{result.citations.map(citation => <button type="button" className="secondary" key={citation.pageNumber}
            onClick={() => latest.current.onNavigateCitation(citation.target)}>第 {citation.pageNumber} 页</button>)}</div>}
        </article>;
      })}
      <div className="ai-sync-actions"><button type="button" className="secondary" disabled={!bridge?.enabled || props.busy || saving || view.conflicted}
        onClick={() => { try { props.onSelect(view); setNotice('将使用此会话已保存的原文继续。查看发送范围后再发送。'); } catch (failure) { setError(errorText(failure)); } }}>用已保存原文继续此会话</button>
        <button type="button" className="text-button danger-text" disabled={!bridge?.enabled || saving || props.busy || view.conflicted} onClick={() => remove('aiConversation', view)}>删除同步会话</button></div>
      {view.conflicted && <p className="ai-warning">会话有未解决冲突，请到账号的冲突页比较双方完整内容。</p>}
    </section>}
    <h3>问题模板</h3>
    <button type="button" className="secondary" disabled={!bridge?.enabled || saving || props.busy} onClick={() => editTemplate(null)}>将当前问题建为同步模板</button>
    <ul className="ai-sync-list">{bridge?.templates.map(entry => <li key={entry.id}>
      <strong>{entry.data.title}</strong><span className="ai-field-help">{delivery(entry)}</span>
      <div className="ai-sync-actions"><button type="button" className="secondary" disabled={props.busy} onClick={() => props.onApplyDraft(entry.data.action, entry.data.question)}>填入问题</button>
        <button type="button" className="text-button" disabled={saving || props.busy || entry.conflicted} onClick={() => editTemplate(entry)}>编辑</button>
        <button type="button" className="text-button danger-text" disabled={!bridge?.enabled || saving || props.busy || entry.conflicted} onClick={() => remove('aiTemplate', entry)}>删除</button></div>
    </li>)}</ul>
    {editing && <fieldset disabled={saving || props.busy} className="ai-sync-template">
      <legend>{template ? '编辑同步模板' : '新建同步模板'}</legend>
      <label htmlFor={id + '-title'}>模板标题</label><input id={id + '-title'} maxLength={128} value={title} onChange={event => setTitle(event.target.value)} />
      <label htmlFor={id + '-action'}>任务</label><select id={id + '-action'} value={action} onChange={event => setAction(event.target.value as AiAction)}>{(Object.keys(AI_ACTION_LABELS) as AiAction[]).map(item => <option value={item} key={item}>{AI_ACTION_LABELS[item]}</option>)}</select>
      <label htmlFor={id + '-question'}>问题或要求</label><textarea id={id + '-question'} rows={4} maxLength={8192} value={question} onChange={event => setQuestion(event.target.value)} />
      <div className="ai-sync-actions"><button type="button" className="secondary" disabled={!bridge?.enabled} onClick={saveTemplate}>保存同步模板</button><button type="button" className="text-button" onClick={() => setEditing(false)}>取消编辑</button></div>
    </fieldset>}
    {error && <p role="alert" className="ai-error">{error}</p>}{notice && <p role="status" className="ai-notice">{notice}</p>}
  </details>;
}
