import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import { desktopNoteExportSkipDescription, exportDesktopSavedNotes, type DesktopNoteExportResult } from '../../services/desktopRichNotes';
import { placeNoteExportResult } from './richNoteExportPlacement';

export function RichNoteExportButton({ noteId, disabled = false }: { noteId: string | null; disabled?: boolean }) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState<DesktopNoteExportResult | null>(null), [error, setError] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const session = useMemo(() => Symbol('saved-note-export'), [noteId]), current = useRef<symbol | null>(session);
  current.current = session;
  useEffect(() => { current.current = session; setBusy(false); setResult(null); setError(false); return () => { current.current = null; }; }, [session]);
  const open = !!result || error;
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect || !popup.current) return;
      const next = placeNoteExportResult(rect, { width: window.innerWidth, height: window.innerHeight }, popup.current.scrollHeight + 2);
      setPosition(previous => previous && previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.maxHeight === next.maxHeight
        ? previous : next);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setResult(null); setError(false); anchor.current?.focus(); } };
    update(); window.addEventListener('resize', update); window.addEventListener('scroll', update, true); document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); document.removeEventListener('keydown', escape); };
  }, [open, result, error, position?.width]);
  async function save() {
    if (!noteId || busy || disabled) return;
    const operation = session; setBusy(true); setResult(null); setError(false);
    try {
      const response = await exportDesktopSavedNotes([noteId]);
      if (operation === current.current) setResult(response);
    } catch { if (operation === current.current) setError(true); }
    finally { if (operation === current.current) setBusy(false); }
  }
  return <div className="relative shrink-0">
    <button ref={anchor} type="button" className="pq-icon-button h-8 w-8 rounded-lg" disabled={disabled || busy || !noteId}
      title="导出当前已保存笔记（完整结构 JSON）" aria-label="导出当前已保存笔记" onClick={() => void save()}>
      <Download className="h-4 w-4" strokeWidth={1.8} />
    </button>
    {open && createPortal(<div ref={popup} className="fixed z-[1000] overflow-y-auto rounded-lg border border-[var(--pq-border-subtle)] bg-[var(--pq-surface-1)] p-3 text-xs shadow-lg"
      style={{ left: position?.left ?? 8, top: position?.top ?? 8, width: position?.width ?? 288, maxHeight: position?.maxHeight,
        visibility: position ? 'visible' : 'hidden' }} role="status">
      <p>{error || result?.status === 'failed' ? '导出失败，未生成可用导出包。'
        : result?.status === 'exported' ? `已导出 ${result.noteCount} 条已保存笔记、${result.paperCount} 篇关联题录。`
        : result?.status === 'cancelled' ? '已取消保存。'
        : result?.status === 'source-changed' ? '保存框打开期间原记录发生变化，请重新导出。'
        : result?.status === 'busy' ? '已有一个笔记导出正在进行。' : '当前已保存笔记不能完整导出。'}</p>
      {result?.skipped.map((entry, index) => <p key={`${entry.entityType}:${entry.index}:${index}`} className="mt-1">
        {entry.entityType === 'note' ? '笔记' : '题录'} {entry.index + 1}：{desktopNoteExportSkipDescription(entry.code)}。
      </p>)}
      <p className="mt-2 text-[var(--pq-text-faint)]">只导出已落盘内容。包内 sourceId 是独立导出别名；未解析引用不会自动关联到账号记录。原笔记保持不变。</p>
      <button type="button" className="mt-2 underline" onClick={() => { setResult(null); setError(false); }}>关闭</button>
    </div>, document.body)}
  </div>;
}
