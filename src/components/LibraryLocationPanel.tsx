import { useEffect, useState } from 'react';
import { useLocaleText } from '../i18n/uiLanguage';
import { activateLibraryLocation, getLibraryLocation, selectLibraryLocation, type LibraryLocation, type LibraryLocationCandidate } from '../services/libraryLocation';

export default function LibraryLocationPanel({ compact = false }: { compact?: boolean }) {
  const l = useLocaleText();
  const [location, setLocation] = useState<LibraryLocation | null>(null);
  const [candidate, setCandidate] = useState<LibraryLocationCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void getLibraryLocation().then((value) => { if (active) setLocation(value); })
      .catch((error) => { if (active) setMessage(String(error)); });
    return () => { active = false; };
  }, []);

  const choose = async () => {
    setBusy(true); setMessage('');
    try { setCandidate(await selectLibraryLocation()); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const activate = async () => {
    if (!candidate) return;
    setBusy(true); setMessage('');
    try {
      const result = await activateLibraryLocation(candidate.token);
      if (result.unchanged) setMessage(l('这就是当前文库。', 'This is already the active library.'));
      if (result.restarting) setMessage(l('正在重启并打开已有文库…', 'Restarting to open the existing library…'));
      setCandidate(null);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return (
    <section aria-label={l('文库位置', 'Library Location')} className="shrink-0 space-y-3 rounded-2xl border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-4 text-sm text-[var(--pq-text)]">
      <div className="font-medium">{compact ? l('没有看到以前的文献？', 'Missing your previous papers?') : l('当前文库位置', 'Current Library Location')}</div>
      <p className="text-xs leading-5 text-[var(--pq-text-muted)]">
        {l('此处是数据库、笔记和文库配置的位置，不是下面的 PDF 存储文件夹。升级不需要卸载或重新导入论文。', 'This is the database, notes and library configuration location, separate from the PDF storage folder. Upgrades do not require uninstalling or re-importing papers.')}
      </p>
      {location ? <p className="break-all font-mono text-xs" data-testid="library-location-path">{location.dataDirectory}</p> : null}
      <button type="button" disabled={busy} onClick={() => void choose()} className="pq-button px-3 py-2 disabled:opacity-50">
        {l('打开已有文库…', 'Open Existing Library…')}
      </button>
      {candidate ? <div className="space-y-2 rounded-xl bg-[var(--pq-surface-2)] p-3">
        <p className="break-all font-mono text-xs">{candidate.dataDirectory}</p>
        <p>{l(`${candidate.paperCount} 篇文献，${candidate.attachmentCount} 个附件`, `${candidate.paperCount} papers, ${candidate.attachmentCount} attachments`)}</p>
        <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('只切换位置并记住选择；不会合并、覆盖或删除任一文库。请先保存编辑内容。', 'Only switches and remembers the location. Neither library is merged, overwritten or deleted. Save your edits first.')}</p>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void activate()} className="pq-button px-3 py-2">{l('切换并重启', 'Switch and Restart')}</button>
          <button type="button" disabled={busy} onClick={() => setCandidate(null)} className="pq-button px-3 py-2">{l('取消', 'Cancel')}</button>
        </div>
      </div> : null}
      {message ? <p role="status" className="break-words text-xs text-[var(--pq-text-muted)]">{message}</p> : null}
    </section>
  );
}
