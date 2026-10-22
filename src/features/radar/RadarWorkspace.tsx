import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Pin, Plus, Radar, RefreshCw, Settings2 } from 'lucide-react';
import { useLocaleText } from '../../i18n/uiLanguage';
import { listen } from '../../platform/electron/event';
import { emitOpenLibraryPaper } from '../../app/appEvents';
import { openExternalUrl, selectLocalPdfSource } from '../../services/desktop';
import { attachRadarPdf, cancelRadar, deleteRadarTopic, getRadarSnapshot, importRadarCandidate, RADAR_CHANGED_EVENT, runRadar, saveRadarTopic, setRadarCandidateDismissed, setReadingQueueState } from '../../services/radar';
import type { RadarSnapshot, RadarTopic, ReadingStatus } from '../../types/radar';
import RankingDetails from './RankingDetails';
import TopicEditor from './TopicEditor';
import './radar.css';

const PAGE_SIZE = 30;
type View = 'candidates' | 'queue';
type CandidateFilter = 'new' | 'imported' | 'dismissed';
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export default function RadarWorkspace({ active = true }: { active?: boolean }) {
  const l = useLocaleText();
  const [data, setData] = useState<RadarSnapshot | null>(null), [topicId, setTopicId] = useState<string | null>(null);
  const [view, setView] = useState<View>('candidates'), [candidateFilter, setCandidateFilter] = useState<CandidateFilter>('new');
  const [readingStatus, setReadingStatus] = useState<ReadingStatus>('unread'), [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const [editor, setEditor] = useState<{ topic: RadarTopic | null } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const request = useRef(0), mounted = useRef(true), selected = useRef(topicId);
  selected.current = topicId;
  const refresh = useCallback(async () => {
    const generation = ++request.current;
    try {
      const snapshot = await getRadarSnapshot(selected.current);
      if (mounted.current && generation === request.current) setData(snapshot);
    } catch (cause) { if (mounted.current && generation === request.current) setError(message(cause)); }
  }, []);
  useEffect(() => {
    mounted.current = true; let disposed = false, stop: (() => void) | undefined;
    void listen(RADAR_CHANGED_EVENT, () => { if (!disposed) void refresh(); }).then((cleanup) => { if (disposed) cleanup(); else stop = cleanup; }).catch((cause) => { if (!disposed) setError(message(cause)); });
    return () => { disposed = true; mounted.current = false; request.current++; stop?.(); };
  }, [refresh]);
  useEffect(() => { if (active) void refresh(); }, [topicId, refresh, active]);
  useEffect(() => { setPage(0); }, [topicId]);
  useEffect(() => { setPage(0); }, [view, candidateFilter, readingStatus, search]);
  const topic = data?.topics.find((item) => item.id === topicId) || data?.topics.find((item) => item.id === data.selectedTopicId);
  const act = async (action: () => Promise<unknown>, success = '') => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (mounted.current) setNotice(success); }
    catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { if (mounted.current) { setBusy(false); await refresh(); } }
  };
  const addPdf = (paperId: string) => act(async () => {
    const source = await selectLocalPdfSource();
    if (source?.kind === 'local-path') await attachRadarPdf(paperId, source.path);
  });
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const candidates = useMemo(() => (data?.candidates || []).filter((item) =>
    (!topic || item.topicIds.includes(topic.id)) &&
    (candidateFilter === 'dismissed' ? item.dismissed : candidateFilter === 'imported' ? !item.dismissed && Boolean(item.paperId) : !item.dismissed && !item.paperId) &&
    `${item.title} ${item.authors.join(' ')} ${item.doi}`.toLocaleLowerCase().includes(normalizedSearch)
  ).sort((a, b) => (b.ranking?.score || 0) - (a.ranking?.score || 0) || b.discoveredAt - a.discoveredAt), [data, topic, candidateFilter, normalizedSearch]);
  const queue = useMemo(() => (data?.queue || []).filter((item) => item.status === readingStatus &&
    `${item.paper.title} ${item.paper.authors.map((author) => author.name).join(' ')} ${item.paper.doi || ''}`.toLocaleLowerCase().includes(normalizedSearch)), [data, readingStatus, normalizedSearch]);
  const total = view === 'candidates' ? candidates.length : queue.length;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
  const pageRows = <T,>(rows: T[]) => rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const date = (value?: number | null) => value ? new Date(value).toLocaleString() : l('尚未运行', 'Not checked yet');
  const runStatus = { success: l('检查完成', 'Complete'), partial: l('部分来源失败', 'Partial failure'), failed: l('检查失败', 'Failed'), cancelled: l('检查已停止', 'Stopped') };

  return <section className="pq-radar" aria-label={l('文献雷达', 'Literature radar')}>
    <aside className="pq-radar-sidebar">
      <div className="pq-radar-sidebar-title"><Radar size={19} /><h1>{l('文献雷达', 'Literature radar')}</h1></div>
      <p className="pq-radar-muted">{l('发现值得读的下一篇', 'Find your next paper')}</p>
      <button className="pq-button pq-radar-add" onClick={() => setEditor({ topic: null })}><Plus size={15} />{l('新建主题', 'New topic')}</button>
      <nav aria-label={l('研究主题', 'Research topics')}>{data?.topics.map((item) => <button key={item.id} className={topic?.id === item.id ? 'selected' : ''} onClick={() => { setTopicId(item.id); setError(''); }}><span>{item.name}</span><small>{item.enabled ? l('自动检查', 'Scheduled') : l('手动检查', 'Manual')}</small></button>)}</nav>
      <div className="pq-radar-sidebar-foot">{l('主题决定检索与排序依据。阅读队列包含全库论文；已读状态由你手动标记。', 'Topics define discovery and ranking. The queue spans your whole library; you mark papers as read explicitly.')}</div>
    </aside>
    <div className="pq-radar-main">
      <header className="pq-radar-header"><div><h2>{topic?.name || l('从一个研究方向开始', 'Start with a research interest')}</h2><p className="pq-radar-muted">{topic ? l(`最近检查：${date(topic.lastAttemptAt)}`, `Last check: ${date(topic.lastAttemptAt)}`) : l('设置关键词，查找新文献，再决定是否入库。', 'Set up queries, discover papers and choose what to add.')}</p></div>
        <div className="pq-radar-inline">{topic ? <button className="pq-button" aria-label={l('编辑当前主题', 'Edit current topic')} onClick={() => setEditor({ topic })}><Settings2 size={16} />{l('主题设置', 'Topic settings')}</button> : null}
          {data?.activeTopicId ? <button className="pq-button" onClick={() => { void cancelRadar().catch((cause) => setError(message(cause))); }}>{l('停止查新', 'Stop check')}</button> : <button className="pq-button-primary" disabled={!topic || busy} onClick={() => topic && void act(() => runRadar(topic.id))}><RefreshCw size={15} />{l('立即查新', 'Check now')}</button>}</div></header>
      {error ? <div role="alert" className="pq-radar-banner pq-radar-error">{error}<button className="pq-button" onClick={() => { setError(''); void refresh(); }}>{l('刷新', 'Refresh')}</button></div> : null}
      {notice ? <div role="status" className="pq-radar-banner">{notice}</div> : null}
      {data?.activeTopicId ? <div role="status" className="pq-radar-banner">{l('正在检索并去重；其他主题不会同时启动。', 'Searching and deduplicating; other topics will wait.')}</div> : null}
      {topic?.lastRun ? <details className="pq-radar-run"><summary>{runStatus[topic.lastRun.status]} · {l(`新增 ${topic.lastRun.added}，已知 ${topic.lastRun.known}`, `${topic.lastRun.added} new, ${topic.lastRun.known} known`)}{topic.lastRun.reports.some((report) => report.limited) ? ` · ${l('结果达到上限', 'Results capped')}` : ''}</summary>
        {topic.lastRun.reports.map((report, index) => <p key={index}>{report.source} — {report.query}: {report.error || l(`取得 ${report.received} / ${report.total} 条`, `${report.received} / ${report.total} records`)}{report.limited ? l('；请缩小检索范围', '; narrow the query for more complete results') : ''}</p>)}
        {topic.lastRun.capacity ? <p className="pq-radar-error">{l('候选已达 5000 条；新结果未全部保存。请删除不再需要的主题以腾出空间。', 'The inbox reached 5,000 records; some results were not saved. Remove unused topics to free space.')}</p> : null}
      </details> : null}
      <div className="pq-radar-toolbar"><div className="pq-radar-switch" role="tablist" aria-label={l('雷达视图', 'Radar views')}>{(['candidates', 'queue'] as const).map((key) => <button key={key} role="tab" aria-selected={view === key} onClick={() => setView(key)}>{key === 'candidates' ? l('候选箱', 'Candidate inbox') : l('阅读队列', 'Reading queue')}</button>)}</div>
        <input className="pq-input pq-radar-search" aria-label={l('筛选题名、作者或 DOI', 'Filter title, author or DOI')} placeholder={l('筛选题名、作者或 DOI', 'Filter title, author or DOI')} value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <div className="pq-radar-filter"><div className="pq-radar-inline">{view === 'candidates' ? (['new', 'imported', 'dismissed'] as const).map((key) => <button className="pq-button" key={key} aria-pressed={candidateFilter === key} onClick={() => setCandidateFilter(key)}>{key === 'new' ? l('待处理', 'New') : key === 'imported' ? l('已在文库', 'In library') : l('已忽略', 'Dismissed')}</button>) : (['unread', 'later', 'read'] as const).map((key) => <button className="pq-button" key={key} aria-pressed={readingStatus === key} onClick={() => setReadingStatus(key)}>{key === 'unread' ? l('待读', 'To read') : key === 'later' ? l('稍后', 'Later') : l('已读', 'Read')}</button>)}</div><span>{l(`${total} 篇`, `${total} papers`)}</span></div>
      <div className="pq-radar-list" aria-busy={busy || Boolean(data?.activeTopicId)}>
        {!data && !error ? <div className="pq-radar-empty">{l('正在读取…', 'Loading…')}</div> : null}
        {data && !topic ? <div className="pq-radar-empty"><Radar size={34} /><h3>{l('创建你的第一个主题', 'Create your first topic')}</h3><p>{l('主题可以属于任何学科。检索式、排除词和阅读权重都由你设定。', 'Any discipline works. Choose your queries, exclusions and reading priorities.')}</p><button className="pq-button-primary" onClick={() => setEditor({ topic: null })}>{l('新建主题', 'New topic')}</button></div> : null}
        {topic && total === 0 ? <div className="pq-radar-empty"><BookOpen size={30} /><h3>{view === 'candidates' ? l('这里暂时没有候选', 'No candidates here yet') : l('这里暂时没有论文', 'No papers in this view')}</h3><p>{view === 'candidates' ? l('运行一次查新，或调整筛选条件。没有新结果也会留下检查记录。', 'Run a check or adjust the filters. Checks with no new results are recorded too.') : l('已在文库的新旧论文都会参与排序；可切换待读、稍后和已读。', 'Both new and existing library papers are ranked. Switch between To read, Later and Read.')}</p></div> : null}
        {view === 'candidates' ? pageRows(candidates).map((item) => <article className="pq-radar-paper" key={item.id}>
          <div className="pq-radar-paper-heading"><h3>{item.title}</h3><span className="pq-radar-score">{item.ranking?.score ?? 0}<small>{l('排序分', 'priority')}</small></span></div>
          <p className="pq-radar-byline">{item.authors.slice(0, 4).join(', ') || l('作者未提供', 'Authors unavailable')} · {item.year || l('年份未提供', 'Year unavailable')} {item.publication ? `· ${item.publication}` : ''}</p>
          <div className="pq-radar-inline pq-radar-meta"><span>{item.hasPdf ? l('有 PDF', 'PDF attached') : item.abstractText ? l('依据题录与摘要', 'Metadata and abstract') : l('仅题录', 'Metadata only')}</span><span>{item.sources.join(', ')}</span>{item.doi ? <span>DOI: {item.doi}</span> : null}</div>
          {item.abstractText ? <details className="pq-radar-abstract"><summary>{l('查看摘要', 'View abstract')}</summary><p>{item.abstractText}</p></details> : null}
          {item.ranking ? <RankingDetails ranking={item.ranking} /> : null}
          <div className="pq-radar-actions">{!item.paperId ? <button className="pq-button-primary" disabled={busy} onClick={() => void act(() => importRadarCandidate(item.id), l('题录已加入文库；可在阅读队列继续处理。', 'Metadata added to your library and reading queue.'))}>{l('题录入库', 'Add metadata')}</button> : item.hasPdf ? <button className="pq-button" onClick={() => emitOpenLibraryPaper(item.paperId!)}>{l('阅读 PDF', 'Read PDF')}</button> : <button className="pq-button" disabled={busy} onClick={() => void addPdf(item.paperId!)}>{l('添加本地 PDF', 'Attach local PDF')}</button>}
            {item.url ? <button className="pq-button" onClick={() => void act(() => openExternalUrl(item.url))}>{l('打开来源', 'Open source')}</button> : null}<button className="pq-button" disabled={busy} onClick={() => void act(() => setRadarCandidateDismissed(item.id, !item.dismissed))}>{item.dismissed ? l('恢复候选', 'Restore') : l('忽略', 'Dismiss')}</button></div>
        </article>) : pageRows(queue).map((item, index) => <article className="pq-radar-paper" key={item.paper.id}>
          <div className="pq-radar-paper-heading"><span className="pq-radar-position">{item.pinned ? <Pin size={16} aria-label={l('已置顶', 'Pinned')} /> : currentPage * PAGE_SIZE + index + 1}</span><h3>{item.paper.title}</h3><span className="pq-radar-score">{item.score}<small>{l('排序分', 'priority')}</small></span></div>
          <p className="pq-radar-byline">{item.paper.authors.slice(0, 4).map((author) => author.name).join(', ')} · {item.paper.year || l('年份未提供', 'Year unavailable')}</p>
          <div className="pq-radar-inline pq-radar-meta"><span>{item.evidence === 'pdf-available' ? l('有 PDF', 'PDF attached') : item.evidence === 'abstract' ? l('依据题录与摘要', 'Metadata and abstract') : l('仅题录', 'Metadata only')}</span><span>{l('排序分不代表论文质量', 'Priority is not a quality rating')}</span></div>
          <RankingDetails ranking={item} />
          <div className="pq-radar-actions">{item.evidence === 'pdf-available' ? <button className="pq-button-primary" onClick={() => emitOpenLibraryPaper(item.paper.id)}>{l('开始阅读', 'Start reading')}</button> : <button className="pq-button" disabled={busy} onClick={() => void addPdf(item.paper.id)}>{l('添加本地 PDF', 'Attach local PDF')}</button>}
            {item.paper.url ? <button className="pq-button" onClick={() => void act(() => openExternalUrl(item.paper.url!))}>{l('打开来源', 'Open source')}</button> : null}
            <button className="pq-button" aria-pressed={item.pinned} disabled={busy} onClick={() => void act(() => setReadingQueueState(item.paper.id, { pinned: !item.pinned }))}>{item.pinned ? l('取消置顶', 'Unpin') : l('置顶', 'Pin')}</button>
            {(['unread', 'later', 'read'] as const).filter((status) => status !== item.status).map((status) => <button className="pq-button" key={status} disabled={busy} onClick={() => void act(() => setReadingQueueState(item.paper.id, { status }))}>{status === 'read' ? l('标记已读', 'Mark read') : status === 'later' ? l('稍后再读', 'Read later') : l('放回待读', 'Mark unread')}</button>)}</div>
        </article>)}
      </div>
      <footer className="pq-radar-footer"><span>{topic?.enabled ? topic.nextRunAt ? l(`下次计划：${date(topic.nextRunAt)}（需应用打开）`, `Next: ${date(topic.nextRunAt)} (app must be open)`) : l('即将在应用内检查', 'A check is due while the app is open') : l('自动检查未开启', 'Automatic checks are off')}</span><div className="pq-radar-inline"><button className="pq-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{l('上一页', 'Previous')}</button><span>{currentPage + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span><button className="pq-button" disabled={(currentPage + 1) * PAGE_SIZE >= total} onClick={() => setPage(currentPage + 1)}>{l('下一页', 'Next')}</button></div></footer>
      {topic ? <details className="pq-radar-delete"><summary>{l('主题管理', 'Manage topic')}</summary><p>{l('删除主题会移除它独有的候选与计划，已入库论文和阅读状态会保留。', 'Removing a topic removes its unique candidates and schedule. Library papers and reading choices remain.')}</p><button className="pq-button" disabled={busy} onClick={() => { if (window.confirm(l(`删除主题“${topic.name}”？`, `Remove topic “${topic.name}”?`))) void act(async () => { await deleteRadarTopic(topic.id); setTopicId(null); }); }}>{l('删除当前主题', 'Remove current topic')}</button></details> : null}
    </div>
    {editor ? <TopicEditor topic={editor.topic} onClose={() => setEditor(null)} onSave={async (value) => { const saved = await saveRadarTopic(value); setTopicId(saved.id); setEditor(null); await refresh(); }} /> : null}
  </section>;
}
