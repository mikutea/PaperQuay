import type { PdfSourceAttempt, PdfSourceKind, PdfSourceStatus } from '../pdf/sourceResolver.ts';

const labels: Record<PdfSourceKind, string> = { cache: '本机缓存', desktop: '在线电脑', cloud: '私有云', public: '公开链接' };
const statuses: Record<PdfSourceStatus, string> = { pending: '等待尝试', checking: '检查中', downloading: '读取中',
  verifying: '核对文件', succeeded: '文件已核验', failed: '未取得', skipped: '未使用' };
const order: PdfSourceKind[] = ['cache', 'desktop', 'cloud', 'public'];

export function PdfSourceAttempts({ attempts }: { attempts: PdfSourceAttempt[] }) {
  if (!attempts.length) return null;
  return <section className="pr-source-attempts" aria-label="全文来源尝试">
    <h4>本次来源检查</h4>
    <ol>{order.map((source) => {
      const attempt = attempts.find((item) => item.source === source);
      if (!attempt) return null;
      const transferring = attempt.status === 'downloading';
      return <li key={source} data-source={source} data-status={attempt.status}>
        <div><strong>{labels[source]}</strong><span role="status">{statuses[attempt.status]}</span></div>
        {transferring && <progress aria-label={`${labels[source]}读取进度`} max={attempt.total ?? 1}
          value={attempt.total === null ? undefined : Math.min(attempt.loaded, attempt.total)} />}
        {attempt.message && <p>{attempt.message}</p>}
      </li>;
    })}</ol>
  </section>;
}
