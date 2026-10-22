import { useLocaleText } from '../../i18n/uiLanguage';
import type { PaperRanking, RankingKey } from '../../types/radar';

export default function RankingDetails({ ranking }: { ranking: PaperRanking }) {
  const l = useLocaleText();
  const labels: Record<RankingKey, string> = { relevance: l('相关性', 'Relevance'), priority: l('研究重点', 'Priority'), methods: l('方法价值', 'Methods'), recency: l('发表时间', 'Recency') };
  return <details className="pq-radar-reasons"><summary>{l(`为什么排在这里 · ${ranking.score} 分`, `Why this position · ${ranking.score} points`)}</summary>
    {ranking.excluded ? <p>{l('不符合当前主题的相关词或排除词条件。', 'Does not match the current topic filters.')}</p> : null}
    {ranking.reasons.map((reason) => <div key={reason.key} className="pq-radar-reason"><span>{labels[reason.key]}</span><meter min={0} max={Math.max(1, reason.max)} value={reason.points} aria-label={labels[reason.key]} /><strong>{reason.points}/{reason.max}</strong><span>{reason.matched.join('、') || l('无命中或未配置', 'No match or not configured')}</span></div>)}
  </details>;
}
