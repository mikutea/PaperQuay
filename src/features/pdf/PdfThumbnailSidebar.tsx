import { forwardRef, memo, type WheelEventHandler } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '../../utils/cn';

type LocaleText = (zh: string, en: string) => string;

interface PdfThumbnailSidebarProps {
  collapsed: boolean;
  pageCount: number;
  currentPage: number;
  pageThumbnails: Record<number, string>;
  onToggleCollapsed: () => void;
  onScrollToPage: (pageIndex: number) => void;
  onWheelCapture: WheelEventHandler<HTMLElement>;
  l: LocaleText;
}

export const PdfThumbnailSidebar = memo(forwardRef<HTMLElement, PdfThumbnailSidebarProps>(function PdfThumbnailSidebar(
  {
    collapsed,
    pageCount,
    currentPage,
    pageThumbnails,
    onToggleCollapsed,
    onScrollToPage,
    onWheelCapture,
    l,
  },
  ref,
) {
  const toggleLabel = collapsed
    ? l('Show page thumbnails', 'Show page thumbnails')
    : l('Hide page thumbnails', 'Hide page thumbnails');

  return (
    <aside
      ref={ref}
      onWheelCapture={onWheelCapture}
      className={cn(
        'flex min-h-0 shrink-0 transition-[width,background-color,box-shadow] duration-300 ease-out',
        collapsed
          ? 'pointer-events-none absolute inset-y-0 left-0 z-30 w-10 border-r-0 bg-transparent'
          : 'relative w-[184px] border-r border-slate-200/80 bg-white/72 shadow-[8px_0_24px_rgba(15,23,42,0.04)] backdrop-blur-xl dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:shadow-none',
      )}
    >
      <div className="flex min-h-0 w-full">
        <div
          className={cn(
            'flex shrink-0 flex-col items-center gap-3 transition-all duration-300 ease-out',
            collapsed
              ? 'pointer-events-auto w-10 px-1 py-3'
              : 'w-10 border-r border-slate-200/70 px-1.5 py-4 dark:border-white/10',
          )}
        >
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-muted)] dark:hover:border-white/15 dark:hover:bg-[var(--pq-surface-2)]',
              collapsed && 'shadow-[0_10px_24px_rgba(15,23,42,0.16)]',
            )}
            title={toggleLabel}
            aria-label={toggleLabel}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" strokeWidth={1.8} />
            ) : (
              <PanelLeftClose className="h-4 w-4" strokeWidth={1.8} />
            )}
          </button>
        </div>

        <div
          className={cn(
            'min-h-0 overflow-hidden transition-[width,opacity] duration-300 ease-out',
            collapsed ? 'w-0 opacity-0' : 'w-36 opacity-100',
          )}
        >
          {!collapsed ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="border-b border-slate-200/70 px-2.5 py-3 text-xs font-medium text-slate-500 dark:border-[var(--pq-border)] dark:text-[var(--pq-text-faint)]">
                {l('Page Thumbnails', 'Page Thumbnails')}
              </div>
              <div
                data-wheel-scroll-target
                className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-2.5 py-3"
              >
                <div className="space-y-2.5">
                  {Array.from({ length: Math.max(pageCount, 0) }, (_, pageIndex) => {
                    const isActivePage = currentPage === pageIndex + 1;
                    const thumbnailUrl = pageThumbnails[pageIndex];

                    return (
                      <button
                        key={`thumbnail-${pageIndex}`}
                        type="button"
                        onClick={() => onScrollToPage(pageIndex)}
                        className={cn(
                          'group w-full rounded-xl border p-1.5 text-left transition-all duration-200',
                          isActivePage
                            ? 'border-indigo-200 bg-white shadow-[0_10px_24px_rgba(79,70,229,0.10)] dark:border-indigo-400/30 dark:bg-[var(--pq-surface-2)] dark:shadow-[0_10px_24px_rgba(79,70,229,0.16)]'
                            : 'border-slate-200 bg-white/70 hover:border-slate-300 hover:bg-white dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:hover:border-white/15 dark:hover:bg-[var(--pq-surface-2)]',
                        )}
                      >
                        <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-white/10 dark:bg-[var(--pq-surface-1)]">
                          {thumbnailUrl ? (
                            <img
                              data-pdf-paper-thumbnail
                              src={thumbnailUrl}
                              alt={l(
                                `第 ${pageIndex + 1} 页缩略图`,
                                `Thumbnail for page ${pageIndex + 1}`,
                              )}
                              className="block h-auto w-full"
                            />
                          ) : (
                            <div className="flex aspect-[0.74] w-full items-center justify-center bg-[linear-gradient(180deg,#f8fafc,#eef2f7)] text-xs text-slate-400 dark:bg-[linear-gradient(180deg,#242424,#1e1e1e)] dark:text-[var(--pq-text-muted)]">
                              {l('Rendering', 'Rendering')}
                            </div>
                          )}
                        </div>
                        <div className="mt-2 flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-[var(--pq-text-faint)]">
                          <span>{l(`Page ${pageIndex + 1}`, `Page ${pageIndex + 1}`)}</span>
                          {isActivePage ? (
                            <span className="text-indigo-600 dark:text-indigo-400">
                              {l('当前', 'Current')}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}));
