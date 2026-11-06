import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkspaceController } from '../sync/workspace.ts';
import { ClientError, describeError } from '../errors.ts';
import { decodeGraphEvidenceFile, graphEvidenceAdoptionKey, graphEvidenceView, graphEvidenceText, graphEvidenceJson, inspectGraphEvidenceSources,
  assertGraphEvidenceSelection, GraphEvidenceError, GRAPH_EVIDENCE_FILE_BYTES, type GraphEvidenceSnapshot, type GraphEvidenceEdge } from '../graph/evidence.ts';
import { exportTextFile, exportFilename, type ExportRuntime } from '../platform/exportFile.ts';

interface Props { controller: WorkspaceController; scopeKey: string; current(): boolean; exportRuntime?: ExportRuntime }
type Confirmation = { kind: 'adopt'; snapshot: GraphEvidenceSnapshot; edgeIds: string[]; expected: string | null } | { kind: 'remove'; expected: string };
const describe = (error: unknown) => error instanceof GraphEvidenceError
  ? ({ INVALID: '来源包无效或内容摘要不一致，请重新从桌面导出。', LIMIT: '来源包超过 1 MiB，请在桌面缩小文献范围后重新导出。', SCOPE_CHANGED: '来源包属于其他账号或服务，请使用当前账号导出的文件。',
    SOURCE_CHANGED: '所选文献或版本已变化，或存在未完成的同步操作。请核对后重新选择。', SELECTION: '请至少选择一条来源和版本仍匹配的关系。', CHANGED: '已接收的来源包已变化，请重新检查。' }[error.code])
  : error instanceof ClientError ? describeError(error) : '本次操作未完成，原有图谱来源仍保留。';
const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const cacheDate = (value: number | null) => value !== null && Number.isFinite(new Date(value).getTime()) ? date(new Date(value).toISOString()) : '未知';
export function GraphEvidencePanel(props: Props) {
  const latest = useRef(props); latest.current = props;
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot);
  const owner = useMemo(() => ({ controller: props.controller, key: props.scopeKey }), [props.controller, props.scopeKey]), active = useRef(owner); active.current = owner;
  const mounted = useRef(true), sequence = useRef(0), flight = useRef<number | null>(null), input = useRef<HTMLInputElement | null>(null), cancel = useRef<HTMLButtonElement | null>(null);
  const [candidate, setCandidate] = useState<GraphEvidenceSnapshot | null>(null), [filename, setFilename] = useState(''), [edgeIds, setEdgeIds] = useState<string[]>([]), [page, setPage] = useState(1);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const confirmationRef = useRef(confirmation); confirmationRef.current = confirmation;
  useLayoutEffect(() => { if (confirmation) cancel.current?.focus(); }, [confirmation]);
  useLayoutEffect(() => { mounted.current = true; sequence.current++; flight.current = null; setCandidate(null); setFilename(''); setEdgeIds([]); setConfirmation(null); setError(''); setNotice(''); setBusy(false);
    return () => { mounted.current = false; sequence.current++; }; }, [owner]);
  const current = () => { const snapshot = latest.current.controller.getSnapshot(), sync = snapshot.workspace?.sync;
    return mounted.current && active.current === owner && latest.current.current() && snapshot.status === 'ready' && !!sync && JSON.stringify([sync.accountId, sync.deviceId, sync.generation]) === owner.key; };
  const adopted = state.workspace?.graphEvidence ?? null, adoptedKey = graphEvidenceAdoptionKey(adopted);
  const view = useMemo(() => graphEvidenceView(state.workspace), [state.workspace]);
  const availability = useMemo(() => candidate && state.workspace ? inspectGraphEvidenceSources(candidate, state.workspace) : null, [candidate, state.workspace]);
  const sources = useMemo(() => new Map(candidate?.sources.map(row => [row.paperId, row]) ?? []), [candidate]);
  const eligible = (edge: GraphEvidenceEdge) => Boolean(availability?.available.has(edge.sourcePaperId) && availability.available.has(edge.targetPaperId));
  const selectedEdges = candidate?.edges.filter(row => edgeIds.includes(row.id)) ?? [];
  const readyToAdopt = selectedEdges.length > 0 && selectedEdges.every(eligible);
  const confirmationCurrent = !!confirmation && (confirmation.kind === 'remove' ? confirmation.expected === adoptedKey : confirmation.expected === adoptedKey
    && candidate?.digest === confirmation.snapshot.digest && confirmation.edgeIds.join(',') === [...edgeIds].sort().join(',') && readyToAdopt);
  const clearFeedback = () => { setError(''); setNotice(''); setConfirmation(null); };
  function begin() { const id = ++sequence.current; flight.current = id; setBusy(true); setError(''); setNotice(''); return id; }
  function finish(id: number) { if (current() && flight.current === id) { flight.current = null; setBusy(false); } }
  async function readFile(file?: File) {
    if (!file || !current() || flight.current !== null) return;
    const id = begin(); setCandidate(null); setEdgeIds([]); setConfirmation(null); setFilename(''); setPage(1);
    try {
      if (file.size > GRAPH_EVIDENCE_FILE_BYTES) throw new GraphEvidenceError('LIMIT');
      const bytes = new Uint8Array(await file.arrayBuffer()); if (!current() || flight.current !== id) return;
      const snapshot = props.controller.prepareGraphEvidenceFile(decodeGraphEvidenceFile(bytes));
      if (current() && flight.current === id) { setCandidate(snapshot); setFilename(file.name); }
    } catch (failure) { if (current() && flight.current === id) setError(describe(failure)); } finally { finish(id); }
  }
  function toggle(edge: GraphEvidenceEdge) {
    if (!current() || flight.current !== null || !eligible(edge)) return; clearFeedback();
    setEdgeIds(previous => previous.includes(edge.id) ? previous.filter(id => id !== edge.id) : [...previous, edge.id].sort());
  }
  function previewAdoption() {
    if (!current() || !candidate || flight.current !== null) return; clearFeedback();
    try { const workspace = props.controller.getSnapshot().workspace; if (!workspace) throw new ClientError('ACCOUNT_CHANGED');
      assertGraphEvidenceSelection(candidate, edgeIds, workspace); setConfirmation({ kind: 'adopt', snapshot: candidate, edgeIds: [...edgeIds].sort(), expected: graphEvidenceAdoptionKey(workspace.graphEvidence) });
    } catch (failure) { setError(describe(failure)); }
  }
  async function confirm() {
    const captured = confirmationRef.current; if (!current() || !captured || !confirmationCurrent || flight.current !== null) return;
    const id = begin(), guard = () => current() && flight.current === id && confirmationRef.current === captured;
    try {
      if (captured.kind === 'adopt') await props.controller.adoptGraphEvidence(captured.snapshot, captured.edgeIds, captured.expected, guard);
      else await props.controller.clearGraphEvidence(captured.expected, guard);
      if (guard()) { setConfirmation(null); setCandidate(null); setEdgeIds([]); setFilename(''); setNotice(captured.kind === 'adopt' ? '所选关系已保存到本机图谱。' : '本机已接收的来源已清理，文献和原始缓存仍保留。'); }
    } catch (failure) { if (current() && flight.current === id) setError(describe(failure)); } finally { finish(id); }
  }
  async function exportOriginal() {
    if (!current() || !adopted || flight.current !== null) return;
    const captured = adopted, key = graphEvidenceAdoptionKey(captured), id = begin();
    const guard = () => current() && flight.current === id && graphEvidenceAdoptionKey(latest.current.controller.getSnapshot().workspace?.graphEvidence) === key;
    try { const mode = await exportTextFile({ name: exportFilename('PaperQuay-图谱来源包', 'json'), text: graphEvidenceJson(captured), mime: 'application/json' }, guard, props.exportRuntime,props.controller.getAccountScope()??undefined);
      if (guard()) setNotice(mode === 'share' ? '已打开来源包的系统分享。' : '来源包已交给浏览器下载。');
    } catch (failure) { if (guard()) setError(describe(failure)); } finally { finish(id); }
  }
  const titles = (edge: GraphEvidenceEdge) => (sources.get(edge.sourcePaperId)?.title ?? '来源文献') + ' → ' + (sources.get(edge.targetPaperId)?.title ?? '目标文献');
  if (!current()) return null;
  return <details className="graph-evidence-import"><summary>桌面图谱来源{adopted ? ' · 已接收 ' + adopted.edgeIds.length + ' 条关系' : ''}</summary>
    <p className="muted">从桌面账号的“图谱来源包”导出参考文献与缓存相似关系，再在这里逐项采用。此操作不查询电脑或调用模型。</p>
    {view && <section aria-label="已接收的桌面图谱来源"><h4>已接收的来源</h4><p>{date(view.adoption.snapshot.createdAt)} 的缓存快照。已选 {view.adoption.edgeIds.length} 条，当前来源仍匹配 {view.edges.length} 条。</p>
      {view.hiddenEdges > 0 && <p role="status">{view.hiddenEdges} 条关系因文献、版本或同步状态变化暂不显示；原始来源仍保留，可导出核对。</p>}
      <div className="graph-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void exportOriginal()}>导出原始来源包</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { if (!current() || !adoptedKey) return; clearFeedback(); setConfirmation({ kind: 'remove', expected: adoptedKey }); }}>清理本机接收的来源</button></div>
    </section>}
    <input type="file" accept=".json,application/json" aria-label="桌面图谱来源包文件" hidden ref={input} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void readFile(file); }} />
    <div className="graph-actions"><button type="button" className="secondary" disabled={busy} onClick={() => { if (current()) { clearFeedback(); input.current?.click(); } }}>{candidate ? '更换来源包' : '选择桌面来源包'}</button>
      {candidate && <button type="button" className="secondary" disabled={busy} onClick={() => { if (current()) { clearFeedback(); setCandidate(null); setEdgeIds([]); setFilename(''); } }}>取消本次导入</button>}</div>
    {busy && <p role="status">正在处理来源包…</p>}{error && <p role="alert" className="graph-feedback">{error}</p>}{notice && <p role="status" className="graph-notice">{notice}</p>}
    {candidate && <section aria-label="选择桌面缓存关系"><h4>选择要采用的关系</h4><p>{filename} · {candidate.sources.length} 份文献 · {candidate.edges.length} 条关系</p>
      <p className="muted">缓存关系尚未核验到当前 PDF。引用是候选，相似度是缓存向量的余弦值，都需要回到原文确认。</p>
      {availability!.unavailable.length > 0 && <details><summary>暂不可用的文献 · {availability!.unavailable.length}</summary><ul>{availability!.unavailable.map(row => <li key={row.paperId}>{row.title}<p className="muted">题录、版本或同步状态与来源包不一致。先完成文献同步，再重新选择来源包。</p></li>)}</ul></details>}
      {!candidate.edges.length && <p>此包没有可采用的关系。请在桌面确认所选文献的缓存和关联。</p>}
      <ul className="graph-evidence-choices">{candidate.edges.slice(0, page * 40).map(edge => <li key={edge.id}><label><input type="checkbox" checked={edgeIds.includes(edge.id)} disabled={busy || !eligible(edge)} onChange={() => toggle(edge)} /><span><strong>{edge.kind === 'citation' ? '引用候选' : '缓存相似'}</strong>{titles(edge)}</span></label>
        {!eligible(edge) && <p className="muted">两端文献当前未全部匹配，暂不可采用。</p>}<details><summary>查看来源证据</summary><p>{graphEvidenceText(edge)}</p>
          <p className="muted">缓存时间：{cacheDate(edge.provenance.kind === 'reference-cache' ? edge.provenance.fetchedAt : edge.provenance.indexedAt)}。本次来源包生成于 {date(candidate.createdAt)}。</p><details><summary>来源摘要</summary><pre>{JSON.stringify({ snapshotDigest: candidate.digest, edge }, null, 2)}</pre></details></details></li>)}</ul>
      {candidate.edges.length > page * 40 && <button type="button" className="secondary" disabled={busy} onClick={() => setPage(value => value + 1)}>显示更多缓存关系</button>}
      <button type="button" disabled={busy || !readyToAdopt} onClick={previewAdoption}>预览采用所选关系{edgeIds.length ? ' · ' + edgeIds.length : ''}</button>
    </section>}
    {confirmation && <section className="graph-evidence-confirm" role="alertdialog" aria-label={confirmation.kind === 'adopt' ? '确认采用图谱来源' : '确认清理图谱来源'}>
      <h4>{confirmation.kind === 'adopt' ? '将所选关系用于本机图谱' : '清理本机接收的来源'}</h4>
      {confirmation.kind === 'adopt' ? <><p>采用 {confirmation.edgeIds.length} 条缓存关系{adopted ? '，替换当前已接收的 ' + adopted.edgeIds.length + ' 条关系' : ''}。文献题录和手动关系会保留。</p>
        <ul>{confirmation.snapshot.edges.filter(row => confirmation.edgeIds.includes(row.id)).map(edge => <li key={edge.id}>{titles(edge)}</li>)}</ul></>
        : <p>清理当前接收的 {adopted?.edgeIds.length ?? 0} 条缓存关系。文献、手动关系和桌面原始缓存会保留。</p>}
      {!confirmationCurrent && <p role="alert">来源或已接收记录已经变化，请取消后重新预览。</p>}
      <div className="graph-actions"><button type="button" disabled={busy || !confirmationCurrent} onClick={() => void confirm()}>{confirmation.kind === 'adopt' ? '确认采用到本机图谱' : '确认清理本机来源'}</button><button ref={cancel} type="button" className="secondary" disabled={busy} onClick={() => setConfirmation(null)}>取消</button></div>
    </section>}
  </details>;
}
