import { useEffect, useRef, useState } from 'react';
import { useLocaleText } from '../../i18n/uiLanguage';
import type { RadarTopic, RadarTopicConfig, RankingKey } from '../../types/radar';
import { newTopicConfig, parseTopicConfig, topicConfigOnly } from './topicConfig';

interface Props {
  topic: RadarTopic | null;
  onSave: (topic: RadarTopicConfig & { id?: string }) => Promise<void>;
  onClose: () => void;
}

export default function TopicEditor({ topic, onSave, onClose }: Props) {
  const l = useLocaleText();
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState<RadarTopicConfig>(() => topic ? { ...topicConfigOnly(topic), enabled: topic.enabled } : newTopicConfig());
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [json, setJson] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const patch = <K extends keyof RadarTopicConfig>(key: K, next: RadarTopicConfig[K]) => setValue((old) => ({ ...old, [key]: next }));
  const fields: Array<[keyof Pick<RadarTopicConfig, 'queries' | 'includeTerms' | 'excludeTerms' | 'priorityTerms' | 'methodTerms'>, string, string]> = [
    ['queries', l('检索式（每行一条，最多 4 条）', 'Search queries (one per line, up to 4)'), l('例如：urban heat adaptation', 'Example: urban heat adaptation')],
    ['includeTerms', l('相关词（命中任一，用于筛选与排序）', 'Relevance terms (match any; filter and rank)'), l('每行一个词或短语；留空则保留检索结果', 'One term per line; leave empty to keep search results')],
    ['excludeTerms', l('排除词', 'Excluded terms'), l('命中即排除新候选', 'Exclude new candidates matching any term')],
    ['priorityTerms', l('优先阅读词', 'Priority terms'), l('与你当前研究最重要的问题有关的词', 'Terms for questions most important to you')],
    ['methodTerms', l('关注的方法', 'Methods of interest'), l('例如：field experiment', 'Example: field experiment')],
  ];
  const weightLabels: Record<RankingKey, string> = { relevance: l('相关性', 'Relevance'), priority: l('研究重点', 'Priority'), methods: l('方法价值', 'Methods'), recency: l('发表时间', 'Recency') };
  return <dialog ref={dialog} className="pq-radar-dialog" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="radar-topic-title">
    <form onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError('');
      try { await onSave({ ...value, ...(topic ? { id: topic.id } : {}) }); }
      catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
      finally { setBusy(false); }
    }}>
      <header><h2 id="radar-topic-title">{topic ? l('编辑主题', 'Edit topic') : l('新建主题', 'New topic')}</h2><button type="button" className="pq-button" disabled={busy} onClick={onClose}>{l('关闭', 'Close')}</button></header>
      <div className="pq-radar-form-body">
        <p className="pq-radar-muted">{l('保存主题不会导入论文。查新向所选来源发送检索式和时间范围，不上传文库内容。', 'Saving does not import papers. Checks send queries and date filters to selected sources; library content stays local.')}</p>
        <label>{l('主题名称', 'Topic name')}<input autoFocus required maxLength={100} className="pq-input" value={value.name} onChange={(e) => patch('name', e.target.value)} /></label>
        <div className="pq-radar-form-grid">{fields.map(([key, label, placeholder]) => <label key={key} className={key === 'queries' ? 'pq-radar-form-wide' : ''}>{label}
          <textarea className="pq-input" aria-label={label} rows={key === 'queries' ? 3 : 2} required={key === 'queries'} placeholder={placeholder} value={value[key].join('\n')}
            onChange={(event) => patch(key, event.target.value.split('\n'))} />
        </label>)}</div>
        <fieldset><legend>{l('元数据来源', 'Metadata sources')}</legend><div className="pq-radar-inline">{(['crossref', 'openalex'] as const).map((source) => <label key={source} className="pq-radar-check"><input type="checkbox" checked={value.sources.includes(source)} onChange={(e) => patch('sources', e.target.checked ? [...value.sources, source] : value.sources.filter((item) => item !== source))} />{source === 'crossref' ? 'Crossref' : 'OpenAlex'}</label>)}</div>
          <p className="pq-radar-muted">{l('OpenAlex 复用文库设置中的可选 API Key。每条检索式、每个来源最多取 50 条，达到上限会提示。', 'OpenAlex uses the optional key in Library settings. Each query retrieves up to 50 records per source; capped results are labelled.')}</p></fieldset>
        <div className="pq-radar-form-grid"><label>{l('检索最近多少天', 'Publication window (days)')}<input className="pq-input" type="number" min={7} max={3650} value={value.lookbackDays} onChange={(e) => patch('lookbackDays', Number(e.target.value))} /></label>
          <label>{l('检查间隔', 'Check interval')}<select className="pq-input" value={value.intervalHours} onChange={(e) => patch('intervalHours', Number(e.target.value))}>{[6, 12, 24, 168].map((hours) => <option key={hours} value={hours}>{hours === 168 ? l('每周', 'Weekly') : l(`每 ${hours} 小时`, `Every ${hours} hours`)}</option>)}</select></label></div>
        <label className="pq-radar-check"><input type="checkbox" checked={value.enabled} onChange={(e) => patch('enabled', e.target.checked)} />{l('应用打开时自动检查；错过的计划在下次启动补查一次', 'Check while the app is open; catch up once after restarting')}</label>
        <fieldset><legend>{l('阅读排序权重（每项 0–100）', 'Reading priority weights (0–100 each)')}</legend><div className="pq-radar-weight-inputs">{(Object.keys(weightLabels) as RankingKey[]).map((key) => <label key={key}>{weightLabels[key]}<input className="pq-input" type="number" min={0} max={100} value={value.weights[key]} onChange={(e) => patch('weights', { ...value.weights, [key]: Number(e.target.value) })} /></label>)}</div>
          <p className="pq-radar-muted">{l('分数说明阅读优先级，不代表论文质量。每项都会显示命中词和分值。', 'Scores express reading priority, not research quality. Matched terms and contributions are shown for each paper.')}</p></fieldset>
        <div className="pq-radar-inline"><button className="pq-button" type="button" onClick={() => setJson(JSON.stringify(topicConfigOnly(value), null, 2))}>{l('导出配置', 'Export configuration')}</button><button className="pq-button" type="button" onClick={() => setJson('')}>{l('导入配置', 'Import configuration')}</button></div>
        {json !== null ? <section><label>{l('主题配置 JSON（复制或粘贴）', 'Topic JSON (copy or paste)')}<textarea className="pq-input pq-radar-json" aria-label={l('主题配置 JSON（复制或粘贴）', 'Topic JSON (copy or paste)')} rows={7} value={json} onChange={(e) => setJson(e.target.value)} /></label><div className="pq-radar-inline"><button type="button" className="pq-button" onClick={() => { try { setValue(parseTopicConfig(json)); setJson(null); setError(''); } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); } }}>{l('载入表单', 'Load into form')}</button><button type="button" className="pq-button" onClick={() => setJson(null)}>{l('收起', 'Hide')}</button></div><p className="pq-radar-muted">{l('导入后自动检查默认关闭，保存前可再次开启。', 'Imported schedules start disabled. You may enable them before saving.')}</p></section> : null}
        {error ? <p role="alert" className="pq-radar-error">{error}</p> : null}
      </div>
      <footer><button type="button" className="pq-button" disabled={busy} onClick={onClose}>{l('取消', 'Cancel')}</button><button className="pq-button-primary" type="submit" disabled={busy}>{busy ? l('正在保存…', 'Saving…') : l('保存主题', 'Save topic')}</button></footer>
    </form>
  </dialog>;
}
