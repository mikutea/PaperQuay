import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, Download, FileSearch, RefreshCw } from 'lucide-react';
import type { GraphEvidenceEdge, GraphEvidenceSnapshot } from '../../../packages/sync-core/src/graphEvidence';
import {
  desktopGraphEvidence, type DesktopGraphEvidenceList, type DesktopGraphEvidencePreview, type DesktopGraphEvidenceStatus,
} from '../../services/desktopGraphEvidence';
import { SettingsField, SettingsInput } from './readerPreferencesPrimitives';
import type { ReaderPreferencesLocalizer } from './readerPreferencesTypes';

const buttonClass = 'pq-button inline-flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50';
const summaryClass = 'min-h-11 cursor-pointer py-3 text-sm font-medium text-[var(--pq-text)]';
const selectionClass = 'flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm';
const inputClass = 'mt-1 h-4 w-4 shrink-0 accent-[var(--pq-accent)]';
const MAX_PAPERS = 16, PAGE_SIZE = 8;

function extractCode(error: unknown): string {
  const value = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
  return value.match(/\b[A-Z][A-Z_]{3,70}\b/)?.[0] || 'GRAPH_EVIDENCE_FAILED';
}
function reasonLabel(code: string, l: ReaderPreferencesLocalizer): string {
  const labels: Record<string, [string, string]> = {
    GRAPH_EVIDENCE_SCOPE_CHANGED: ['账号、服务或文库已变化，请重新选择文献。', 'The account, service or library changed. Select papers again.'],
    GRAPH_EVIDENCE_PREVIEW_STALE: ['缓存或文献关联已变化，请重新检查后保存。', 'Cached evidence or paper links changed. Check again before saving.'],
    GRAPH_EVIDENCE_SOURCE_CHANGED: ['本机来源已有变化，旧预览未保存。请重新检查。', 'Local sources changed. The old preview was not saved. Check again.'],
    GRAPH_EVIDENCE_PREVIEW_REQUIRED: ['请先检查所选文献的本机来源。', 'Check the selected papers’ local sources first.'],
    GRAPH_EVIDENCE_SELECTION_INVALID: ['请选择一到十六份已关联文献，并至少保留一种来源。', 'Select one to sixteen linked papers and at least one source type.'],
    GRAPH_EVIDENCE_LIMIT: ['这次来源包超过容量限制，请减少选择的文献或来源类型。', 'This source package exceeds the limit. Select fewer papers or source types.'],
    GRAPH_EVIDENCE_INVALID: ['缓存来源无法完整读取，请检查原图谱资料。', 'Cached sources cannot be read completely. Check the original graph material.'],
    GRAPH_EVIDENCE_INTEGRITY: ['来源包核验未通过，请重新检查本机缓存。', 'The source package could not be verified. Check the local cache again.'],
    GRAPH_EVIDENCE_BINDING_REQUIRED: ['这份文献尚未唯一关联到账号，已跳过。', 'This paper is not uniquely linked to the account and was skipped.'],
    GRAPH_EVIDENCE_BINDING_INVALID: ['文献或附件版本的对应关系无法核验，请先检查文件关联。', 'Paper or attachment version links could not be verified. Check the file links first.'],
    GRAPH_EVIDENCE_VERSION_LIMIT: ['这份文献的已关联附件版本超过来源包上限，已跳过。', 'This paper has more linked attachment versions than the package limit and was skipped.'],
    GRAPH_EVIDENCE_LIBRARY_LIMIT: ['本机文库超过本次可检查的范围，尚未生成来源包。', 'The local library exceeds the range that can be checked in this operation. No source package was prepared.'],
    GRAPH_EVIDENCE_LIBRARY_INVALID: ['本机文库记录无法完整读取，请先检查文库。', 'Local library records cannot be read completely. Check the library first.'],
    GRAPH_EVIDENCE_LOCAL_UNAVAILABLE: ['这份本机文献当前不可用，已跳过。', 'This local paper is unavailable and was skipped.'],
    GRAPH_EVIDENCE_TITLE_UNSUPPORTED: ['这份文献的题名无法完整放入来源包，已跳过。', 'This paper’s title cannot be included completely in the source package and was skipped.'],
    GRAPH_EVIDENCE_METADATA_UNSUPPORTED: ['这份题录无法完整核验，已跳过。', 'These paper details could not be verified completely and were skipped.'],
    GRAPH_EVIDENCE_DESCRIPTION_UNSUPPORTED: ['这项缓存说明无法完整放入来源包，已跳过。', 'This cached description cannot be included completely in the source package and was skipped.'],
    GRAPH_EVIDENCE_DUPLICATE: ['重复的关系记录已跳过。', 'A duplicate relationship record was skipped.'],
    GRAPH_EVIDENCE_EDGE_LIMIT: ['关系数量超过来源包上限，请减少选择的文献。', 'There are more relationships than the package limit. Select fewer papers.'],
    GRAPH_EVIDENCE_REFERENCE_UNAVAILABLE: ['没有可读取的参考文献缓存。', 'No readable reference cache is available.'],
    GRAPH_EVIDENCE_REFERENCE_INVALID: ['参考文献缓存无法完整读取。', 'The reference cache cannot be read completely.'],
    GRAPH_EVIDENCE_REFERENCE_LIMIT: ['参考文献缓存超过本次检查限制，请减少选择的文献。', 'The reference cache exceeds this check’s limit. Select fewer papers.'],
    GRAPH_EVIDENCE_REFERENCE_ROW_LIMIT: ['这条参考文献缓存超过单条容量限制，已跳过。', 'This reference cache entry exceeds the per-entry limit and was skipped.'],
    GRAPH_EVIDENCE_REFERENCE_UNRESOLVED: ['未找到对应的本机文献，已跳过。', 'No matching local paper was found, so this entry was skipped.'],
    GRAPH_EVIDENCE_REFERENCE_AMBIGUOUS: ['匹配到多份文献，无法确定引用对象，已跳过。', 'Multiple papers match, so the citation target is ambiguous and was skipped.'],
    GRAPH_EVIDENCE_TARGET_NOT_SELECTED: ['引用目标不在本次选择中，已跳过。', 'The citation target is not selected and was skipped.'],
    GRAPH_EVIDENCE_VECTOR_UNAVAILABLE: ['没有可读取的相似关系缓存。', 'No readable similarity cache is available.'],
    GRAPH_EVIDENCE_VECTOR_INVALID: ['相似关系缓存无法完整读取。', 'The similarity cache cannot be read completely.'],
    GRAPH_EVIDENCE_VECTOR_LIMIT: ['相似缓存超过本次读取限制，请减少选择的文献。', 'The similarity cache exceeds this read’s limit. Select fewer papers.'],
    GRAPH_EVIDENCE_EXPORT_FAILED: ['未确认文件保存完成。请检查目标位置，再重新选择位置保存。', 'Saving the file was not confirmed. Check the destination, then explicitly choose a location to save again.'],
    GRAPH_EVIDENCE_EXPORT_UNCONFIRMED: ['保存结果无法确认。请检查目标位置，再决定是否重新保存。', 'The save result is unconfirmed. Check the destination before deciding whether to save again.'],
    GRAPH_EVIDENCE_MAPPING_CHANGED: ['文献关联已变化，请重新检查。', 'Paper links changed. Check again.'],
    DESKTOP_LIBRARY_CHANGED: ['文库已变化，请重新选择文献。', 'The library changed. Select papers again.'],
    AUTHENTICATION_REQUIRED: ['请先连接账号，以确认文献的对应关系。', 'Connect your account to confirm paper links.'],
    AUTH_SESSION_CHANGED: ['登录身份已变化，请确认当前账号。', 'The signed-in identity changed. Check the current account.'],
    DESKTOP_OPERATION_CANCELLED: ['操作已取消。', 'The operation was cancelled.'],
  };
  return labels[code] ? l(...labels[code]) : l('这项来源暂未完成处理。请查看诊断记录，并重新检查本机来源。', 'This source could not be processed. Review its diagnostic record and check local sources again.');
}
function Diagnostics({ data, l }: { data: unknown; l: ReaderPreferencesLocalizer }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary className={summaryClass}>{l('诊断记录', 'Diagnostic record')}</summary>{open ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--pq-surface-2)] p-3 text-xs">{JSON.stringify(data, null, 2)}</pre> : null}</details>;
}
function PageRows<T>({ items, renderRow, label, l }: { items: T[]; renderRow: (item: T, index: number) => ReactNode; label: string; l: ReaderPreferencesLocalizer }) {
  const [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE)), current = Math.min(page, pages - 1);
  return <><ul className="min-w-0 divide-y divide-[var(--pq-border)]">{items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((item, index) => renderRow(item, current * PAGE_SIZE + index))}</ul>{pages > 1 ? <nav aria-label={label} className="flex flex-wrap items-center gap-2"><button type="button" className={buttonClass} disabled={!current} onClick={() => setPage(current - 1)}>{l('上一页', 'Previous')}</button><span className="text-xs text-[var(--pq-text-muted)]">{l(`第 ${current + 1} / ${pages} 页`, `Page ${current + 1} of ${pages}`)}</span><button type="button" className={buttonClass} disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>{l('下一页', 'Next')}</button></nav> : null}</>;
}
function cacheTime(value: number | null, l: ReaderPreferencesLocalizer): string {
  return value === null ? l('未记录缓存时间', 'Cache time was not recorded') : new Date(value).toLocaleString();
}
function EdgeDetails({ edge, snapshot, l }: { edge: GraphEvidenceEdge; snapshot: GraphEvidenceSnapshot; l: ReaderPreferencesLocalizer }) {
  const source = snapshot.sources.find(row => row.paperId === edge.sourcePaperId), target = snapshot.sources.find(row => row.paperId === edge.targetPaperId);
  return <li className="space-y-2 py-3" data-graph-evidence-edge={edge.kind}>
    <dl className="grid min-w-0 gap-2 md:grid-cols-2">{[
      { label: edge.kind === 'citation' ? l('引用线索来自', 'Citation clue from') : l('文献一', 'First paper'), value: source?.title },
      { label: edge.kind === 'citation' ? l('匹配到文献', 'Matched paper') : l('文献二', 'Second paper'), value: target?.title },
    ].map((row, index) => <div key={index} className="min-w-0 rounded-lg bg-[var(--pq-surface-2)] p-3"><dt className="text-xs text-[var(--pq-text-muted)]">{row.label}</dt><dd className="mt-1 break-words text-sm font-medium [overflow-wrap:anywhere]">{row.value || l('来源文献不可用', 'Source paper unavailable')}</dd></div>)}</dl>
    <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">{edge.description ?? l('缓存未附说明。', 'The cache contains no description.')}</div>
    {edge.kind === 'citation' ? <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('参考文献缓存时间：', 'Reference cache time: ')}{cacheTime(edge.provenance.fetchedAt, l)}</p> : <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs leading-5"><div><dt className="text-[var(--pq-text-muted)]">{l('余弦分数', 'Cosine score')}</dt><dd className="break-all font-medium" data-graph-evidence-score>{String(edge.score)}</dd></div><div><dt className="text-[var(--pq-text-muted)]">{l('相似记录时间', 'Similarity record time')}</dt><dd>{cacheTime(edge.provenance.indexedAt, l)}</dd></div></dl>}
    <Diagnostics data={edge} l={l} />
  </li>;
}
export function DesktopGraphEvidenceReview({ preview, disabled, onExport, onBack, l }: { preview: DesktopGraphEvidencePreview; disabled: boolean; onExport: () => void; onBack: () => void; l: ReaderPreferencesLocalizer }) {
  const { snapshot, counts } = preview, citations = snapshot.edges.filter(edge => edge.kind === 'citation'), similarities = snapshot.edges.filter(edge => edge.kind === 'similarity');
  return <div className="space-y-4" data-graph-evidence-review>
    <section className="space-y-2 border-l-2 border-[var(--pq-accent)] pl-3" aria-label={l('历史缓存来源说明', 'Historical cache qualification')}>
      <h5 className="text-sm font-medium">{l('历史缓存，未核验对应的 PDF 版本', 'Historical cache; its PDF version is unverified')}</h5>
      <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('这些是本机已有的引用线索与相似记录，不能据此确认当前 PDF 中的事实。附带的已关联版本仅供导入时比对。', 'These are existing local citation clues and similarity records. They do not verify facts in the current PDFs. Linked versions are included only for comparison when importing.')}</p>
      <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('本次检查时间：', 'Checked now: ')}{new Date(snapshot.createdAt).toLocaleString()}</p>
    </section>
    <dl className="flex flex-wrap gap-x-6 gap-y-3 text-sm">{[[l('文献来源', 'Paper sources'), counts.sources], [l('引用线索', 'Citation clues'), counts.citations], [l('相似关系', 'Similarities'), counts.similarities], [l('已跳过', 'Skipped'), counts.skipped]].map(([label, value]) => <div key={label}><dt className="text-xs text-[var(--pq-text-muted)]">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>)}</dl>
    <section aria-label={l('来源文献', 'Source papers')}><h5 className="text-sm font-medium">{l('来源文献', 'Source papers')}</h5><PageRows key={preview.token + '-sources'} items={snapshot.sources} label={l('来源文献分页', 'Source paper pages')} l={l} renderRow={source => <li key={source.paperId} className="py-3"><p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{source.title}</p><p className="mt-1 text-xs leading-5 text-[var(--pq-text-muted)]">{source.versions.length ? l(`附带 ${source.versions.length} 个已关联附件版本，供导入时比对。`, `${source.versions.length} linked attachment versions are included for comparison when importing.`) : l('未记录已关联附件版本，仅保留历史来源标记。', 'No linked attachment version is recorded; only the historical source qualification is retained.')}</p><Diagnostics data={source} l={l} /></li>} /></section>
    {snapshot.coverage.referenceCache ? <section aria-label={l('参考文献缓存', 'Reference cache')}><h5 className="text-sm font-medium">{l('参考文献缓存中的引用线索', 'Citation clues in the reference cache')}</h5>{citations.length ? <PageRows key={preview.token + '-citations'} items={citations} label={l('引用线索分页', 'Citation clue pages')} l={l} renderRow={edge => <EdgeDetails key={edge.id} edge={edge} snapshot={snapshot} l={l} />} /> : <p className="mt-2 text-sm text-[var(--pq-text-muted)]">{l('所选文献之间没有可导出的引用线索。', 'There are no exportable citation clues between the selected papers.')}</p>}</section> : null}
    {snapshot.coverage.vectorCache ? <section aria-label={l('相似关系缓存', 'Similarity cache')}><h5 className="text-sm font-medium">{l('缓存中的相似关系', 'Cached similarities')}</h5><p className="mt-1 text-xs leading-5 text-[var(--pq-text-muted)]">{l('方法为分块向量均值余弦，分数范围为 -1 到 1，不表示正确概率。', 'The method is cosine similarity of mean chunk vectors. Scores range from -1 to 1 and are not probabilities of correctness.')}</p>{similarities.length ? <PageRows key={preview.token + '-similarities'} items={similarities} label={l('相似关系分页', 'Similarity pages')} l={l} renderRow={edge => <EdgeDetails key={edge.id} edge={edge} snapshot={snapshot} l={l} />} /> : <p className="mt-2 text-sm text-[var(--pq-text-muted)]">{l('所选文献之间没有可导出的相似关系。', 'There are no exportable similarities between the selected papers.')}</p>}</section> : null}
    {preview.skipped.length ? <section aria-label={l('未纳入的来源', 'Sources not included')}><h5 className="text-sm font-medium">{l('未纳入的来源', 'Sources not included')}</h5><PageRows key={preview.token + '-skipped'} items={preview.skipped} label={l('未纳入来源分页', 'Skipped source pages')} l={l} renderRow={(row, index) => <li key={index} className="space-y-1 py-3"><p className="break-words text-sm font-medium">{row.label || l('所选来源', 'Selected source')}</p><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{reasonLabel(row.code, l)}</p><Diagnostics data={row} l={l} /></li>} /></section> : null}
    {!snapshot.edges.length && snapshot.sources.length ? <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('此范围内没有关系证据。保存的文件只包含这些来源文献的标识与版本对照。', 'There is no relationship evidence in this selection. The saved file will contain only these source paper identities and version references.')}</p> : null}
    {!snapshot.sources.length ? <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('没有取得可导出的文献来源，请重新选择并检查关联。', 'No exportable paper sources were found. Select again and check the links.')}</p> : null}
    <div className="flex flex-wrap gap-2 border-t border-[var(--pq-border)] pt-3"><button type="button" className={buttonClass} disabled={disabled || !snapshot.sources.length} onClick={onExport}><Download aria-hidden className="h-4 w-4" />{l('选择位置并保存来源包', 'Choose a location and save the source package')}</button><button type="button" className={buttonClass} disabled={disabled} onClick={onBack}>{l('返回选择', 'Back to selection')}</button></div>
    <details><summary className={summaryClass}>{l('来源包详情', 'Source package details')}</summary><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('文件包含所选文献之间的来源记录，不会创建手工关系。保存不会修改原缓存或上传账号服务。', 'The file contains source records between the selected papers and does not create manual relations. Saving does not change the original caches or upload to the account service.')}</p><Diagnostics data={snapshot} l={l} /></details>
  </div>;
}

export interface DesktopGraphEvidencePanelProps { l: ReaderPreferencesLocalizer; accountActive: boolean; status: DesktopGraphEvidenceStatus | null; onLinkPapers?: () => void }
export function DesktopGraphEvidencePanel(props: DesktopGraphEvidencePanelProps) {
  return <OwnedGraphEvidencePanel key={`${props.accountActive}:${props.status?.scopeKey ?? ''}`} {...props} />;
}
function OwnedGraphEvidencePanel({ l, accountActive, status, onLinkPapers }: DesktopGraphEvidencePanelProps) {
  const ownerKey = status?.scopeKey ?? null;
  const [list, setList] = useState<DesktopGraphEvidenceList | null>(null), [selected, setSelected] = useState<string[]>([]), [search, setSearch] = useState('');
  const [includeReferences, setIncludeReferences] = useState(true), [includeSimilarity, setIncludeSimilarity] = useState(true);
  const [preview, setPreview] = useState<DesktopGraphEvidencePreview | null>(null), [working, setWorking] = useState<'list' | 'preview' | 'export' | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const alive = useRef(false), sequence = useRef(0), operation = useRef<string | null>(null), currentView = useRef<object | null>(null);
  const latestStatus = useRef(status), latestActive = useRef(accountActive), heading = useRef<HTMLHeadingElement>(null);
  latestStatus.current = status; latestActive.current = accountActive;
  const clearPreview = () => { currentView.current = null; setPreview(null); setNotice(''); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; currentView.current = null; }; }, []);
  useEffect(() => { if (list || preview) heading.current?.focus({ preventScroll: true }); }, [list, preview]);
  useEffect(() => { if (status?.errorCode && /CHANGED|STALE|REQUIRED/.test(status.errorCode)) { currentView.current = null; setPreview(null); } }, [status?.errorCode]);
  const sameOwner = accountActive && !!ownerKey && status?.scopeKey === ownerKey;
  const busy = !!working || !!status?.busy, disabled = !sameOwner || busy;
  const run = async (kind: 'list' | 'preview' | 'export', action: (current: () => boolean) => Promise<void>) => {
    if (!alive.current || !latestActive.current || !ownerKey || latestStatus.current?.scopeKey !== ownerKey || operation.current || latestStatus.current.busy) return;
    const request = ++sequence.current; operation.current = kind; setWorking(kind); setError(null); setNotice('');
    const current = () => alive.current && request === sequence.current && latestActive.current && latestStatus.current?.scopeKey === ownerKey;
    try { await action(current); } catch (failure) { if (current()) { setError(extractCode(failure)); if (/CHANGED|STALE|REQUIRED/.test(extractCode(failure))) clearPreview(); } }
    finally { if (alive.current && request === sequence.current) { operation.current = null; setWorking(null); } }
  };
  const load = () => run('list', async current => {
    clearPreview(); const next = await desktopGraphEvidence.list(); if (!current() || next.scopeKey !== ownerKey) return;
    setList(next); setSelected(previous => previous.filter(id => next.papers.some(row => row.localPaperId === id && row.bound))); setSearch('');
  });
  const check = () => run('preview', async current => {
    clearPreview(); const next = await desktopGraphEvidence.preview({ localPaperIds: [...selected], includeReferences, includeSimilarity });
    if (!current() || next.scopeKey !== ownerKey) return; setPreview(next);
  });
  const validPreview = preview?.scopeKey === ownerKey ? preview : null;
  const view = { selected, includeReferences, includeSimilarity, validPreview, list, status }; currentView.current = view;
  const mayAct = () => alive.current && currentView.current === view && !disabled && latestStatus.current?.scopeKey === ownerKey;
  const visibleError = error || status?.errorCode;
  const rows = list?.papers.filter(row => row.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) || [];
  return <SettingsField label={l('本机图谱来源', 'Local graph sources')} description={l('把已有的引用线索与相似记录保存成文件。', 'Save existing citation clues and similarity records as a file.')}>
    <div className="space-y-3" data-desktop-graph-evidence aria-busy={busy}>
      {!accountActive ? <p className="text-sm text-[var(--pq-text-muted)]">{l('先连接账号，以确认这些文献在设备间的对应关系。', 'Connect your account to confirm which papers correspond across devices.')}</p> : !status || !ownerKey ? <p className="text-sm text-[var(--pq-text-muted)]">{l('当前连接尚未提供来源包导出，请重新连接后检查。', 'Source package export is unavailable for this connection. Reconnect and check again.')}</p> : null}
      {working ? <p role="status" className="text-sm text-[var(--pq-text-muted)]">{working === 'export' ? l('请在保存窗口选择位置，完成或取消后返回。', 'Choose a location in the save window, or cancel to return.') : l('正在读取本机来源…', 'Reading local sources…')}</p> : null}
      {visibleError ? <div role="alert"><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{reasonLabel(visibleError, l)}</p><Diagnostics data={{ code: visibleError }} l={l} /></div> : null}
      {notice ? <p role="status" className="text-sm leading-6 text-[var(--pq-text-muted)]">{notice}</p> : null}
      {!list && !validPreview ? <button type="button" data-graph-evidence-start className="flex min-h-20 w-full items-center gap-3 rounded-xl border border-[var(--pq-border)] p-4 text-left hover:bg-[var(--pq-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--pq-accent)] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={() => { if (mayAct()) void load(); }}><FileSearch aria-hidden className="h-5 w-5 shrink-0 text-[var(--pq-accent)]" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{l('选择文献并检查来源', 'Select papers and check sources')}</span><span className="mt-1 block text-xs leading-5 text-[var(--pq-text-muted)]">{l('只读取本机已有缓存，不调用模型。', 'Reads existing local caches without calling a model.')}</span></span><ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-[var(--pq-text-faint)]" /></button> : null}
      {list || validPreview ? <div className="flex flex-wrap items-center justify-between gap-2"><h4 ref={heading} tabIndex={-1} className="text-sm font-medium focus:outline-none">{validPreview ? l('核对要保存的来源', 'Review the sources to save') : l('选择来源文献', 'Select source papers')}</h4><button type="button" className={buttonClass} disabled={disabled} onClick={() => { if (mayAct()) { if (validPreview) void check(); else void load(); } }}><RefreshCw aria-hidden className="h-4 w-4" />{validPreview ? l('重新检查来源', 'Check sources again') : l('刷新本机列表', 'Refresh local list')}</button></div> : null}
      {list?.scopeKey === ownerKey && !validPreview ? <div className="space-y-3" data-graph-evidence-selection>
        <SettingsInput className="min-h-11" type="search" aria-label={l('搜索来源文献', 'Search source papers')} placeholder={l('按题名搜索', 'Search by title')} value={search} disabled={disabled} onChange={event => setSearch(event.target.value)} />
        <p className="text-xs text-[var(--pq-text-muted)]">{l(`已选择 ${selected.length} 份，最多 16 份。仅导出两端都在本次选择中的关系。`, `${selected.length} selected, up to 16 papers. Only relations whose two endpoints are selected are exported.`)}</p>
        <PageRows key={search} items={rows} label={l('本机文献分页', 'Local paper pages')} l={l} renderRow={row => <li key={row.localPaperId} className="py-1"><label className={selectionClass}><input type="checkbox" className={inputClass} checked={selected.includes(row.localPaperId)} disabled={disabled || !row.bound || !selected.includes(row.localPaperId) && selected.length >= MAX_PAPERS} onChange={event => { clearPreview(); setSelected(previous => event.target.checked ? [...new Set([...previous, row.localPaperId])].slice(0, MAX_PAPERS) : previous.filter(id => id !== row.localPaperId)); }} /><span className="min-w-0 break-words [overflow-wrap:anywhere]"><span className="font-medium">{row.title || l('未命名文献', 'Untitled paper')}</span><span className="mt-1 block text-xs leading-5 text-[var(--pq-text-muted)]">{!row.bound ? l('尚未唯一关联账号文献，请先核对文件关联。', 'Not uniquely linked to an account paper. Check its file links first.') : l(`已关联文献；${row.versionCount} 个附件版本。`, `Linked paper; ${row.versionCount} attachment versions.`)}</span></span></label></li>} />
        {!rows.length ? <p className="text-sm text-[var(--pq-text-muted)]">{l('没有找到相符的文献。', 'No matching papers found.')}</p> : null}
        <fieldset className="border-t border-[var(--pq-border)] pt-3"><legend className="text-sm font-medium">{l('包含哪些本机缓存', 'Local caches to include')}</legend><label className={selectionClass}><input type="checkbox" className={inputClass} checked={includeReferences} disabled={disabled} onChange={event => { clearPreview(); setIncludeReferences(event.target.checked); }} /><span>{l('参考文献缓存中的引用线索', 'Citation clues in the reference cache')}</span></label><label className={selectionClass}><input type="checkbox" className={inputClass} checked={includeSimilarity} disabled={disabled} onChange={event => { clearPreview(); setIncludeSimilarity(event.target.checked); }} /><span>{l('向量缓存中的相似关系', 'Similarities in the vector cache')}</span></label></fieldset>
        <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !selected.length || !includeReferences && !includeSimilarity} onClick={() => { if (mayAct() && selected.length > 0 && selected.length <= MAX_PAPERS && (includeReferences || includeSimilarity)) void check(); }}>{l('检查所选来源', 'Check selected sources')}</button>{list.papers.some(row => !row.bound) && onLinkPapers ? <button type="button" className={buttonClass} disabled={disabled} onClick={onLinkPapers}>{l('去关联文献', 'Link papers')}</button> : null}<button type="button" className={buttonClass} disabled={disabled} onClick={() => { clearPreview(); setList(null); setSelected([]); setError(null); }}><ArrowLeft aria-hidden className="h-4 w-4" />{l('返回来源包导出', 'Back to source export')}</button></div>
      </div> : null}
      {validPreview ? <DesktopGraphEvidenceReview key={validPreview.token} preview={validPreview} disabled={disabled} l={l} onBack={() => { clearPreview(); setError(null); }} onExport={() => { if (mayAct() && validPreview.snapshot.sources.length) void run('export', async current => { const result = await desktopGraphEvidence.export({ token: validPreview.token }); if (!current()) return; if (result.saved && !result.cancelled) setNotice(l('图谱来源包已保存到你选择的位置。', 'The graph source package was saved to your chosen location.')); else if (result.cancelled && !result.saved) setNotice(l('已取消保存，当前预览仍保留。', 'Saving was cancelled. The current preview is preserved.')); else setError('GRAPH_EVIDENCE_EXPORT_UNCONFIRMED'); }); }} /> : null}
    </div>
  </SettingsField>;
}
