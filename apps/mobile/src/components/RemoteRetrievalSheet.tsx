import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { listVisibleEntities, type AccountSyncState, type PaperData } from '../../../../packages/sync-core/src/index.ts';
import { REMOTE_RETRIEVAL_LIMITS, remoteRetrievalTerms, type RemoteRetrievalReceipt, type RemoteRetrievalSource } from '../../../../packages/sync-core/src/remoteRetrieval.ts';
import { ClientError, describeError } from '../errors.ts';
import { exportFilename, exportTextFile, type ExportRuntime } from '../platform/exportFile.ts';
import { RetrievalClient, RetrievalError, describeRetrievalError, type RetrievalContext } from '../retrieval/client.ts';
import { RetrievalRunner } from '../retrieval/runner.ts';
import { assertRetrievalSourcesCurrent, createRetrievalSession, type RetrievalSession, type RetrievalPendingResolutions } from '../retrieval/session.ts';
import type { WorkspaceController } from '../sync/workspace.ts';
import { ReaderSheet } from './ReaderSheet.tsx';
import './remoteRetrieval.css';

export interface RemoteRetrievalSheetProps {
  context: RetrievalContext; scopeKey: string; controller: WorkspaceController; accountCurrent(): boolean;
  onClose(): void; onUse?(receipt: RemoteRetrievalReceipt, evidenceIds: string[]): void;
  initialQuery?: string; paperIds?: readonly string[]; exportRuntime?: ExportRuntime;
}
export interface RemoteRetrievalChoice { receipt: RemoteRetrievalReceipt; evidenceIds: string[] }
const expected = (session: RetrievalSession) => ({ requestId: session.request.requestId, revision: session.revision });
const message = (error: unknown) => error instanceof ClientError ? describeError(error) : describeRetrievalError(error);
const sourceRequest = (source: RemoteRetrievalSource) => ({ version: 1 as const, mode: 'lexical-v1' as const,
  requestId: '00000000-0000-4000-8000-000000000001', query: 'check', topK: 24, sources: [source] });
function sourceIsCurrent(source: RemoteRetrievalSource, sync?: Readonly<AccountSyncState>, pendingResolutions?: RetrievalPendingResolutions) {
  if (!sync) return false;
  try { assertRetrievalSourcesCurrent(sourceRequest(source), sync, pendingResolutions); return true; } catch { return false; }
}

/** The mounted view reads the local ledger only. Every server operation has its
 * own explicit action, including recovery of an uncertain original request. */
export function RemoteRetrievalSheet(p: RemoteRetrievalSheetProps) {
  const id = useId(), latest = useRef(p); latest.current = p;
  const owner = useMemo(() => ({ context: p.context, key: p.scopeKey, controller: p.controller }), [p.context, p.scopeKey, p.controller]);
  const activeOwner = useRef(owner); activeOwner.current = owner;
  const mounted = useRef(false), epoch = useRef(0), flight = useRef(false), abort = useRef<AbortController | null>(null);
  const snapshot = useSyncExternalStore(p.controller.subscribe, p.controller.getSnapshot, p.controller.getSnapshot);
  const saved = snapshot.workspace?.retrievalSession ?? null;
  function current() { const props = latest.current, s = props.controller.getSnapshot(), sync = s.workspace?.sync;
    return mounted.current && activeOwner.current === owner && props.accountCurrent() && s.status === 'ready' && !!sync
      && JSON.stringify([sync.accountId, sync.deviceId, sync.generation]) === owner.key; }
  const client = useMemo(() => new RetrievalClient(p.context), [owner]);
  const runner = useMemo(() => new RetrievalRunner(client, p.controller, current), [owner, client]);
  const running = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
  const [query, setQuery] = useState(p.initialQuery ?? ''), [sources, setSources] = useState<RemoteRetrievalSource[]>([]);
  const [selected, setSelected] = useState<RemoteRetrievalSource[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false), [hasMore, setHasMore] = useState(false), [localBusy, setLocalBusy] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<'remove' | 'clear' | null>(null), [closing, setClosing] = useState(false);
  const receipt = running.candidate?.session.receipt ?? saved?.receipt ?? null, busy = localBusy || running.busy;
  const allowedKey = JSON.stringify(p.paperIds ? [...p.paperIds].sort() : null);
  const selectionRef = useRef(selectedEvidence); selectionRef.current = selectedEvidence;
  const entities = useMemo(() => snapshot.workspace ? listVisibleEntities(snapshot.workspace.sync) : [], [snapshot.workspace]);
  const title = (source: RemoteRetrievalSource) => (entities.find(e => e.entityType === 'paper' && e.entityId === source.target.paperId)?.data as PaperData | undefined)?.title ?? '当前文库未找到对应文献';
  const allowed = (source: RemoteRetrievalSource) => !p.paperIds || p.paperIds.includes(source.target.paperId);
  const visibleSources = sources.filter(allowed), evidence = receipt?.result.evidence.filter(row => allowed(receipt.request.sources[row.sourceIndex])) ?? [];
  const selectedRows = evidence.filter(row => selectedEvidence.includes(row.id));
  const stale = receipt && selectedRows.some(row => !sourceIsCurrent(receipt.request.sources[row.sourceIndex], snapshot.workspace?.sync, snapshot.workspace?.pendingResolutions));
  const capability = p.context.getCapability(), sourceLimit = Math.min(8, capability?.maxSources ?? 8);
  function live(session: RetrievalSession) { const value = latest.current.controller.getSnapshot().workspace?.retrievalSession;
    return current() && value?.request.requestId === session.request.requestId && value.revision === session.revision; }
  async function local(work: (guard: () => boolean, signal: AbortSignal) => Promise<void>) {
    if (!current() || flight.current || runner.getSnapshot().busy) return;
    const token = ++epoch.current, controller = new AbortController(); abort.current = controller; flight.current = true;
    const guard = () => current() && token === epoch.current && !controller.signal.aborted;
    setLocalBusy(true); setError(''); setNotice('');
    try { await work(guard, controller.signal); } catch (e) { if (guard()) setError(message(e)); }
    finally { if (token === epoch.current) { flight.current = false; abort.current = null; if (current()) setLocalBusy(false); } }
  }
  useLayoutEffect(() => {
    mounted.current = true; runner.activate(); epoch.current++; flight.current = false;
    setQuery(latest.current.initialQuery ?? ''); setSources([]); setSelected([]); setLoaded(false); setCursor(null); setHasMore(false);
    setSelectedEvidence([]); setConfirmation(null); setClosing(false); setError(''); setNotice(''); setLocalBusy(false);
    void local(async guard => { await p.controller.refreshRetrievalSession(); if (!guard()) return; });
    return () => { mounted.current = false; epoch.current++; flight.current = false; abort.current?.abort(); runner.dispose(); };
  }, [owner, runner]);
  useLayoutEffect(() => { setSelectedEvidence([]); setConfirmation(null); }, [receipt?.resultDigest, allowedKey, owner]);
  useLayoutEffect(() => { setSelected(old => old.filter(source => !p.paperIds || p.paperIds.includes(source.target.paperId))); }, [allowedKey]);
  function list(more: boolean) { void local(async (guard, signal) => {
    const page = await client.listSources(more ? cursor : null, { current: guard, signal });
    if (!guard()) return; setSources(page.sources); setCursor(page.nextCursor); setHasMore(page.hasMore); setLoaded(true);
    setNotice('已读取一页可用索引；尚未发送检索词。');
  }); }
  function prepare() { void local(async guard => {
    if (runner.getSnapshot().candidate || latest.current.controller.getSnapshot().workspace?.retrievalSession) throw new RetrievalError('CHANGED');
    const request = createRetrievalSession({ version: 1, requestId: crypto.randomUUID(), mode: 'lexical-v1', query: query.trim(),
      topK: Math.min(24, capability?.maxTopK ?? 24), sources: selected }, new Date().toISOString());
    if (request.request.sources.some(source => !allowed(source))) throw new RetrievalError('CHANGED');
    assertRetrievalSourcesCurrent(request.request, latest.current.controller.getSnapshot().workspace!.sync, latest.current.controller.getSnapshot().workspace!.pendingResolutions);
    await latest.current.controller.saveRetrievalSession(request, null, guard);
    if (guard()) setNotice('检索范围已在本机保存。请核对后明确发送。');
  }); }
  function run(action: 'execute' | 'query' | 'remove', session: RetrievalSession) {
    if (!live(session) || flight.current || runner.getSnapshot().busy || runner.getSnapshot().candidate) return;
    if (action === 'execute' && (!['prepared', 'absent'].includes(session.status) || session.request.sources.some(source => !allowed(source)))) return;
    if (action === 'remove' && (confirmation !== 'remove' || session.status !== 'complete')) return;
    setError(''); setNotice(''); setConfirmation(null); void runner[action](session);
  }
  function clear(session: RetrievalSession) { if (!live(session) || session.status === 'uncertain' || confirmation !== 'clear' || runner.getSnapshot().candidate) return;
    void local(async guard => { await latest.current.controller.clearRetrievalSession(expected(session), guard);
      if (guard()) { setQuery(session.request.query); setSelected(session.request.sources.filter(allowed)); setConfirmation(null); setNotice('已清除这份本机检索记录，可以重新选择范围。'); }
    }); }
  function useEvidence() {
    if (!current() || busy || runner.getSnapshot().candidate || !receipt || !selectedRows.length
      || selectedEvidence.join(',') !== selectionRef.current.join(',')) return;
    try { const liveReceipt = latest.current.controller.getSnapshot().workspace?.retrievalSession?.receipt;
      if (liveReceipt?.resultDigest !== receipt.resultDigest) throw new RetrievalError('CHANGED');
      assertRetrievalSourcesCurrent({ ...receipt.request, sources: [...new Set(selectedRows.map(row => row.sourceIndex))].map(index => receipt.request.sources[index]) }, latest.current.controller.getSnapshot().workspace!.sync, latest.current.controller.getSnapshot().workspace!.pendingResolutions);
      latest.current.onUse?.(receipt, selectedRows.map(row => row.id));
    } catch (e) { setError(message(e)); }
  }
  function backup() { void local(async guard => {
    const candidate = runner.getSnapshot().candidate, session = candidate?.session ?? latest.current.controller.getSnapshot().workspace?.retrievalSession;
    if (!session) throw new RetrievalError('CHANGED');
    const valid = () => guard() && (candidate ? runner.getSnapshot().candidate === candidate : live(session));
    const result = await exportTextFile({ name: exportFilename('账号关键词检索与原文', 'json'), mime: 'application/json',
      text: JSON.stringify({ format: 'paperquay-remote-retrieval', version: 1, unconfirmedSave: !!candidate, session }) }, valid, latest.current.exportRuntime);
    if (valid()) setNotice(result === 'share' ? '已打开系统分享，请在目标应用确认接收。' : '已交给浏览器下载。');
  }); }
  function close() { if (!current()) return; if (busy || running.candidate) { setClosing(true); return; } latest.current.onClose(); }
  return <ReaderSheet open title="账号索引关键词检索" className="retrieval-sheet" onClose={close}><div className="remote-retrieval">
    <p className="retrieval-intro">在你明确选择的已有索引中查找原文。检索在账号服务运行，按关键词命中排序，不调用外部模型，也不自动创建索引。</p>
    {!capability && <p role="status">当前账号服务尚未开启远程检索。已保存的本机记录仍可查看和导出。</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}{!!running.error && <p role="alert" className="inline-error">{message(running.error)}</p>}{notice && <p role="status">{notice}</p>}
    {closing && <section className="retrieval-warning"><h3>先保留本次处理结果</h3><p>关闭会停止本机等待。未确认保存的结果仅在此窗口保留；重新打开后可查询原请求。</p><div className="retrieval-actions"><button type="button" className="secondary" onClick={() => setClosing(false)}>返回处理</button><button type="button" className="secondary" onClick={() => { if (current()) { runner.stop(); latest.current.onClose(); } }}>确认关闭，稍后查询</button></div></section>}
    {busy && <p role="status">正在处理… <button type="button" className="secondary" onClick={() => { runner.stop(); abort.current?.abort(); }}>停止本次等待</button></p>}
    {running.candidate && <section className="retrieval-warning" aria-label="检索结果待保存"><h3>已收结果尚未确认保存</h3><p>保留完整结果，只重试本机保存。恢复不会重新发送检索。</p><div className="retrieval-actions"><button type="button" className="primary" disabled={busy} onClick={() => { if (current()) void runner.retrySave(); }}>仅保存已收结果</button><button type="button" className="secondary" disabled={busy} onClick={backup}>导出未保存记录</button></div></section>}
    {!saved && !running.candidate && <section aria-label="选择检索范围"><h3>选择检索范围</h3><button type="button" className="secondary" disabled={busy || !capability} onClick={() => list(false)}>查看可用来源</button>
      {loaded && <><p className="muted">每页至多 8 份索引。逐份选择，最多 {sourceLimit} 篇；同一篇文献采用一份来源。</p><ul className="retrieval-sources">{visibleSources.map(source => {
        const checked = selected.some(item => item.taskId === source.taskId), available = sourceIsCurrent(source, snapshot.workspace?.sync, snapshot.workspace?.pendingResolutions);
        const blocked = !checked && (selected.length >= sourceLimit || selected.some(item => item.target.paperId === source.target.paperId));
        return <li key={source.taskId}><label className="retrieval-choice"><input type="checkbox" checked={checked} disabled={busy || !available || blocked} onChange={event => {
          if (!current() || busy) return; const check = event.target.checked;
          setSelected(old => check ? old.some(item => item.taskId === source.taskId || item.target.paperId === source.target.paperId) || old.length >= sourceLimit ? old : [...old, source] : old.filter(item => item.taskId !== source.taskId));
        }}/><span><strong>{title(source)}</strong><small>{source.target.fileName}</small><small>{source.target.pageCount} 页 · {source.chunkCount} 个片段{available ? '' : ' · 需先同步当前版本'}</small></span></label></li>;
      })}</ul>{!visibleSources.length && <p>这一页没有当前文献范围内可选的索引。{hasMore ? '可以手动查看下一页。' : '请先在远程任务中准备并核验对应索引。'}</p>}{hasMore && <button type="button" className="secondary" disabled={busy} onClick={() => list(true)}>查看下一页来源</button>}</>}
      <div className="retrieval-selected"><strong>已选 {selected.length}/{sourceLimit} 篇</strong>{selected.map(source => <button type="button" className="text-button" key={source.taskId} disabled={busy} onClick={() => setSelected(old => old.filter(item => item.taskId !== source.taskId))}>移除 {title(source)}</button>)}</div>
      <label className="field" htmlFor={id + '-query'}>检索词<textarea id={id + '-query'} name="retrieval-query" autoComplete="off" rows={3} maxLength={REMOTE_RETRIEVAL_LIMITS.queryCharacters} value={query} disabled={busy} onChange={event => setQuery(event.target.value)} placeholder="例如：公共空间 社区参与…"/></label>
      <button type="button" className="primary" disabled={busy || !selected.length || !query.trim() || !capability} onClick={prepare}>预览检索范围</button>
    </section>}
    {saved && <section className="retrieval-request" aria-label="检索请求预览"><h3>{saved.status === 'prepared' ? '核对后检索' : '本机保留的原请求'}</h3><blockquote>{saved.request.query}</blockquote><ul>{saved.request.sources.map(source => <li key={source.taskId}>{title(source)}<small>{source.target.fileName} · {source.chunkCount} 个索引片段</small></li>)}</ul><p>按关键词检索 · 至多 {saved.request.topK} 个结果片段</p><details><summary>查看实际匹配词项</summary><p>{remoteRetrievalTerms(saved.request.query).join('、')}</p><p className="muted">中文连续文字拆为相邻双字词项，字母与数字连续词转为小写。没有语义扩展。</p></details>
      {saved.status === 'uncertain' && !running.candidate && <><p role="status">原请求的结果尚未确认。先查询原请求；没有确认不存在前，不能清除记录或另建请求。</p><button type="button" className="primary" disabled={busy || !capability} onClick={() => run('query', saved)}>查询原请求</button></>}
      {saved.status === 'absent' && <p role="status">服务端已确认未找到原请求。可以明确执行这份原请求，或清除本机记录后重新选择。</p>}
      {['prepared', 'absent'].includes(saved.status) && <button type="button" className="primary" disabled={busy || !!running.candidate || !capability || saved.request.sources.some(source => !allowed(source) || !sourceIsCurrent(source, snapshot.workspace?.sync, snapshot.workspace?.pendingResolutions))} onClick={() => run('execute', saved)}>{saved.status === 'absent' ? '执行原请求' : '确认检索这些来源'}</button>}
      {saved.status === 'removed' && <p role="status">这份服务端结果已清理，原请求不会再次执行。已有本机原文仍保留。</p>}
      <details><summary>记录与清理</summary><div className="retrieval-actions"><button type="button" className="secondary" disabled={busy} onClick={backup}>导出完整检索记录</button>{saved.status === 'complete' && <button type="button" className="secondary" disabled={busy || !!running.candidate || !capability} onClick={() => setConfirmation('remove')}>清理服务端结果</button>}{saved.status !== 'uncertain' && <button type="button" className="secondary" disabled={busy || !!running.candidate} onClick={() => setConfirmation('clear')}>清除本机记录，重新选择</button>}</div><details><summary>请求与完整结果标识</summary><pre>{JSON.stringify({ requestId: saved.request.requestId, status: saved.status, requestDigest: saved.receipt?.requestDigest, resultDigest: saved.receipt?.resultDigest }, null, 2)}</pre></details></details>
      {confirmation && <section className="retrieval-warning" aria-label="确认清理检索记录"><h4>{confirmation === 'remove' ? '确认清理服务端结果' : '确认清除本机记录'}</h4><p>{confirmation === 'remove' ? '服务端保留清理回执，原请求不会重做。本机已保存的完整结果仍保留。' : '此设备将不再保留这份检索记录，文库和笔记不会改变。需要的完整原文请先导出。'}</p><div className="retrieval-actions"><button type="button" className="primary" disabled={busy} onClick={() => confirmation === 'remove' ? run('remove', saved) : clear(saved)}>确认{confirmation === 'remove' ? '清理服务端结果' : '清除本机记录'}</button><button type="button" className="secondary" disabled={busy} onClick={() => setConfirmation(null)}>保留记录</button></div></section>}
    </section>}
    {receipt && <section className="retrieval-results" aria-label="检索原文结果"><h3>检索到的原文</h3><p>扫描 {receipt.result.stats.scannedChunks} 个片段，命中 {receipt.result.stats.matchingChunks} 个，返回 {receipt.result.evidence.length} 个；另有 {receipt.result.stats.omittedMatches} 个命中片段未返回。</p>
      {!receipt.result.evidence.length && <p role="status">检索完成，没有匹配片段。没有自动改用摘要或其他来源。</p>}
      {receipt.result.evidence.length > 0 && !evidence.length && <p>已存结果没有本次所需文献的片段。可以导出原记录，再重新选择范围。</p>}
      <ol className="retrieval-excerpts">{evidence.map(row => { const source = receipt.request.sources[row.sourceIndex]; return <li key={row.id}><label className="retrieval-choice"><input type="checkbox" checked={selectedEvidence.includes(row.id)} disabled={busy || !!running.candidate || !p.onUse || !sourceIsCurrent(source, snapshot.workspace?.sync, snapshot.workspace?.pendingResolutions)} onChange={event => { const checked = event.target.checked; setSelectedEvidence(old => checked ? [...new Set([...old, row.id])] : old.filter(value => value !== row.id)); }}/><span><strong>{title(source)}</strong><small>{source.target.fileName} · 第 {row.pageIndex + 1} 页</small><small>命中词项数 {row.score} · {row.matchedTerms.join('、')}</small></span></label><blockquote>{row.text}</blockquote><p className="muted">原片段 {row.fullTextLength} 字符，本次展示 {row.text.length} 字符。{row.excerptStart > 0 ? '展示从片段中部开始。' : ''}</p></li>; })}</ol>
      {p.onUse && evidence.length > 0 && <><p role="status">已选 {selectedRows.length} 个片段。只采用勾选的原文，仍需返回工作区预览并确认模型发送。</p>{stale && <p role="alert">所选文献版本已变化，不能采用旧片段。完整结果仍可导出核对。</p>}<button type="button" className="primary" disabled={busy || !!running.candidate || !selectedRows.length || !!stale} onClick={useEvidence}>采用所选片段</button></>}
    </section>}
    <footer><button type="button" className="secondary" disabled={busy || !!running.candidate} onClick={() => void local(async guard => { await latest.current.controller.refreshRetrievalSession(); if (guard()) setNotice('已刷新本机检索记录，没有发送服务端查询。'); })}>刷新本机检索记录</button></footer>
  </div></ReaderSheet>;
}
