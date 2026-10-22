import { Bot, FileText, Library, NotebookText, Radar, X } from 'lucide-react';
import type { DragEvent, MouseEvent } from 'react';
import { useLocaleText } from '../../i18n/uiLanguage';
import type { AppTab } from '../../stores/useTabsStore';
import { cn } from '../../utils/cn';

export type TabDropPosition = 'before' | 'after';

interface TabItemProps {
  tab: AppTab;
  active: boolean;
  dragging: boolean;
  dropPosition: TabDropPosition | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>, tabId: string) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>, tabId: string) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>, tabId: string) => void;
  onDrop: (event: DragEvent<HTMLDivElement>, tabId: string) => void;
  onDragEnd: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>, tab: AppTab) => void;
}

function TabItem({
  tab,
  active,
  dragging,
  dropPosition,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onContextMenu,
}: TabItemProps) {
  const l = useLocaleText();
  const title = tab.type === 'radar' ? l('文献雷达', 'Literature radar') : tab.title;
  const Icon =
    tab.type === 'radar' ? Radar : tab.type === 'library'
      ? Library
      : tab.type === 'agent'
        ? Bot
        : tab.type === 'notes' || tab.type === 'note'
          ? NotebookText
          : FileText;
  const closable = tab.type !== 'library';
  const isHomeTab = tab.type === 'library';

  const handleClose = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClose(tab.id);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onClick={() => onSelect(tab.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(tab.id);
        }
      }}
      onDragStart={(event) => onDragStart(event, tab.id)}
      onDragOver={(event) => onDragOver(event, tab.id)}
      onDragLeave={(event) => onDragLeave(event, tab.id)}
      onDrop={(event) => onDrop(event, tab.id)}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => onContextMenu(event, tab)}
      className={cn(
        'group relative mr-1 flex h-8 min-w-0 cursor-default items-center gap-2 rounded-t-[var(--pq-radius-sm)] border px-3 text-[13px] transition',
        isHomeTab ? 'w-[164px] flex-none' : 'min-w-[128px] max-w-[220px] flex-1 basis-0',
        dragging ? 'opacity-45' : '',
        active
          ? 'border-[var(--pq-border)] border-b-[var(--pq-surface-1)] bg-[var(--pq-surface-1)] text-[var(--pq-text)] shadow-[0_1px_0_rgba(255,255,255,0.64)_inset]'
          : 'border-transparent bg-transparent text-[var(--pq-text-muted)] hover:bg-[var(--pq-hover)] hover:text-[var(--pq-text)]',
      )}
    >
      {dropPosition === 'before' ? (
        <span className="pointer-events-none absolute -left-0.5 bottom-1 top-1 w-0.5 rounded-full bg-[var(--pq-accent)]" />
      ) : null}
      {dropPosition === 'after' ? (
        <span className="pointer-events-none absolute -right-0.5 bottom-1 top-1 w-0.5 rounded-full bg-[var(--pq-accent)]" />
      ) : null}
      <span
        className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center',
          active ? 'text-[var(--pq-accent)]' : 'text-[var(--pq-text-faint)] group-hover:text-[var(--pq-text-muted)]',
        )}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{title}</span>
      {tab.type === 'note' && tab.externalUpdate ? (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--pq-accent)]"
          title={l('此笔记有外部更新', 'This note has external updates')}
          aria-label={l('此笔记有外部更新', 'This note has external updates')}
        />
      ) : null}
      {closable ? (
        <button
          type="button"
          draggable={false}
          onClick={handleClose}
          className={cn(
            'inline-flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded text-[var(--pq-text-faint)] transition hover:bg-[var(--pq-hover)] hover:text-[var(--pq-text)]',
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
          aria-label={l(`关闭 ${title}`, `Close ${title}`)}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

export default TabItem;
