import clsx from 'clsx';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import {
  BookOpenText,
  FilePlus2,
  GripVertical,
  RefreshCw,
  Star,
} from 'lucide-react';
import { useAppLocale, useLocaleText } from '../../../i18n/uiLanguage';
import { useWheelScrollDelegate } from '../../../hooks/useWheelScrollDelegate';
import type { ListPapersRequest, LiteraturePaper } from '../../../types/library';
import type { PdfReadingHeatmap } from '../../../types/reader';
import {
  loadPaperHistoryMap,
  PAPER_READING_HEATMAP_UPDATED_EVENT,
} from '../../../utils/paperHistory';
import { truncateMiddle } from '../../../utils/text';
import {
  paperAuthors,
  paperPdfPath,
} from '../literatureUi';
import LiteratureReadingHeatmapPreview from './LiteratureReadingHeatmapPreview';
import LibrarySearchInput from './LibrarySearchInput';

export interface LiteraturePaperListStatus {
  mineruParsed: boolean;
  overviewGenerated: boolean;
  checkingMineru?: boolean;
}

export type LiteraturePaperListSortBy = NonNullable<ListPapersRequest['sortBy']>;
export type LiteraturePaperListSortDirection = NonNullable<ListPapersRequest['sortDirection']>;

interface LiteraturePaperListProps {
  loading: boolean;
  queryPending?: boolean;
  queryError?: string;
  onRetrySearch?: () => void;
  pageIndex?: number;
  pageSize?: number;
  paperTotal?: number;
  onPageChange?: (page: number) => void;
  working: boolean;
  papers: LiteraturePaper[];
  paperStatuses: Record<string, LiteraturePaperListStatus>;
  showReadingHeatmap?: boolean;
  storageDir?: string;
  selectedPaper: LiteraturePaper | null;
  searchQuery: string;
  sortBy: LiteraturePaperListSortBy;
  sortDirection: LiteraturePaperListSortDirection;
  statusMessage: string;
  error: string;
  onSearchQueryChange: (value: string) => void;
  onSortChange: (sortBy: LiteraturePaperListSortBy, sortDirection: LiteraturePaperListSortDirection) => void;
  onImportPdfs: () => void;
  onRefresh: () => void;
  onSelectPaper: (paperId: string) => void;
  onOpenPaper: (paper: LiteraturePaper) => void;
  onPaperDragStart: (
    event: DragEvent<HTMLDivElement>,
    paper: LiteraturePaper,
  ) => void;
  onPaperReorder: (
    draggedPaperId: string,
    targetPaperId: string,
    placement: 'before' | 'after',
  ) => void;
  onPaperDropOnCategory: (paperId: string, categoryId: string) => void;
  onPaperPointerDragOverCategory: (categoryId: string | null) => void;
  onPaperContextMenu: (
    event: MouseEvent<HTMLDivElement>,
    paper: LiteraturePaper,
  ) => void;
}

export default function LiteraturePaperList({
  loading,
  queryPending = false,
  queryError = '',
  onRetrySearch,
  pageIndex = 0,
  pageSize = 100,
  paperTotal = 0,
  onPageChange,
  working,
  papers,
  paperStatuses,
  showReadingHeatmap = true,
  storageDir = '',
  selectedPaper,
  searchQuery,
  sortBy,
  sortDirection,
  statusMessage,
  error,
  onSearchQueryChange,
  onSortChange,
  onImportPdfs,
  onRefresh,
  onSelectPaper,
  onOpenPaper,
  onPaperDragStart,
  onPaperReorder,
  onPaperDropOnCategory,
  onPaperPointerDragOverCategory,
  onPaperContextMenu,
}: LiteraturePaperListProps) {
  const l = useLocaleText();
  const locale = useAppLocale();
  const pageCount = Math.max(1, Math.ceil(paperTotal / pageSize));
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { listScrollRef.current?.scrollTo({ top: 0 }); }, [pageIndex, searchQuery, sortBy, sortDirection]);
  const rootRef = useRef<HTMLElement | null>(null);
  const handleWheelCapture = useWheelScrollDelegate({ rootRef });
  const [dropIndicator, setDropIndicator] = useState<{
    paperId: string;
    placement: 'before' | 'after';
  } | null>(null);
  const [draggingPaperId, setDraggingPaperId] = useState<string | null>(null);
  const sortDragRef = useRef<{
    paperId: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const categoryDragRef = useRef<{
    paperId: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const [sortDraggingPaperId, setSortDraggingPaperId] = useState<string | null>(null);
  const [categoryDraggingPaperId, setCategoryDraggingPaperId] = useState<string | null>(null);
  const [suppressClickPaperId, setSuppressClickPaperId] = useState<string | null>(null);
  const [heatmapRevision, setHeatmapRevision] = useState(0);
  const manualSortingEnabled = sortBy === 'manual';
  const sortValue = `${sortBy}:${sortDirection}`;
  const heatmapsByPaperId = useMemo(() => {
    if (!showReadingHeatmap || papers.length === 0) {
      return {} as Record<string, PdfReadingHeatmap | null>;
    }

    const historyMap = loadPaperHistoryMap();
    const nextHeatmaps: Record<string, PdfReadingHeatmap | null> = {};

    for (const paper of papers) {
      const history = historyMap[`native-library:${paper.id}`];
      const latestHeatmap = Object.values(history?.pdfReadingHeatmaps ?? {})
        .filter((heatmap) => heatmap.totalMs > 0)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;

      nextHeatmaps[paper.id] = latestHeatmap;
    }

    return nextHeatmaps;
  }, [heatmapRevision, papers, showReadingHeatmap]);

  useEffect(() => {
    if (!showReadingHeatmap) {
      return undefined;
    }

    const handleHeatmapUpdated = () => {
      setHeatmapRevision((current) => current + 1);
    };

    window.addEventListener(PAPER_READING_HEATMAP_UPDATED_EVENT, handleHeatmapUpdated);

    return () => {
      window.removeEventListener(PAPER_READING_HEATMAP_UPDATED_EVENT, handleHeatmapUpdated);
    };
  }, [showReadingHeatmap]);

  const findPointerDropTarget = (
    clientX: number,
    clientY: number,
  ): { paperId: string; placement: 'before' | 'after' } | null => {
    const element = document.elementFromPoint(clientX, clientY);
    const row = element?.closest<HTMLElement>('[data-paper-row-id]');
    const paperId = row?.dataset.paperRowId;

    if (!row || !paperId) {
      return null;
    }

    const rect = row.getBoundingClientRect();
    const placement: 'before' | 'after' =
      clientY < rect.top + rect.height / 2 ? 'before' : 'after';

    return { paperId, placement };
  };

  const findCategoryDropTarget = (clientX: number, clientY: number): string | null => {
    const element = document.elementFromPoint(clientX, clientY);
    const target = element?.closest<HTMLElement>('[data-paperquay-category-drop-id]');

    return target?.dataset.paperquayCategoryDropId ?? null;
  };

  const handlePaperDragOver = (
    event: DragEvent<HTMLDivElement>,
    paper: LiteraturePaper,
  ) => {
    const draggedPaperId =
      draggingPaperId || event.dataTransfer.getData('application/x-paperquay-paper-id');

    if (!draggedPaperId || draggedPaperId === paper.id) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const rect = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDropIndicator({ paperId: paper.id, placement });
  };

  const handlePaperDrop = (
    event: DragEvent<HTMLDivElement>,
    paper: LiteraturePaper,
  ) => {
    const draggedPaperId =
      draggingPaperId || event.dataTransfer.getData('application/x-paperquay-paper-id');

    setDropIndicator(null);
    setDraggingPaperId(null);

    if (!draggedPaperId || draggedPaperId === paper.id) {
      return;
    }

    event.preventDefault();

    const rect = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    onPaperReorder(draggedPaperId, paper.id, placement);
  };

  const resetSortDrag = () => {
    sortDragRef.current = null;
    setDropIndicator(null);
    setSortDraggingPaperId(null);
    onPaperPointerDragOverCategory(null);
  };

  const resetCategoryDrag = () => {
    categoryDragRef.current = null;
    setCategoryDraggingPaperId(null);
    onPaperPointerDragOverCategory(null);
  };

  const handleSortPointerDown = (
    event: PointerEvent<HTMLElement>,
    paper: LiteraturePaper,
  ) => {
    if (!manualSortingEnabled) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    sortDragRef.current = {
      paperId: paper.id,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  };

  const handleSortPointerMove = (event: PointerEvent<HTMLElement>) => {
    const dragState = sortDragRef.current;

    if (!dragState) {
      return;
    }

    const distance = Math.hypot(
      event.clientX - dragState.startX,
      event.clientY - dragState.startY,
    );

    if (!dragState.active && distance < 4) {
      return;
    }

    dragState.active = true;
    setSortDraggingPaperId(dragState.paperId);

    const categoryId = findCategoryDropTarget(event.clientX, event.clientY);

    if (categoryId) {
      setDropIndicator(null);
      onPaperPointerDragOverCategory(categoryId);
      return;
    }

    onPaperPointerDragOverCategory(null);

    const target = findPointerDropTarget(event.clientX, event.clientY);

    if (!target || target.paperId === dragState.paperId) {
      setDropIndicator(null);
      return;
    }

    setDropIndicator(target);
  };

  const handleSortPointerUp = (event: PointerEvent<HTMLElement>) => {
    const dragState = sortDragRef.current;

    if (!dragState) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    const categoryId = findCategoryDropTarget(event.clientX, event.clientY);
    const target = findPointerDropTarget(event.clientX, event.clientY);

    if (dragState.active) {
      setSuppressClickPaperId(dragState.paperId);
      window.setTimeout(() => setSuppressClickPaperId(null), 0);
    }

    if (dragState.active && categoryId) {
      onPaperDropOnCategory(dragState.paperId, categoryId);
    } else if (dragState.active && target && target.paperId !== dragState.paperId) {
      onPaperReorder(dragState.paperId, target.paperId, target.placement);
    }

    resetSortDrag();
  };

  const handleCategoryPointerDown = (
    event: PointerEvent<HTMLDivElement>,
    paper: LiteraturePaper,
  ) => {
    if (event.button !== 0) {
      return;
    }

    if ((event.target as HTMLElement).closest('[data-paper-sort-handle]')) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    categoryDragRef.current = {
      paperId: paper.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  };

  const handleCategoryPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = categoryDragRef.current;

    if (!dragState) {
      return;
    }

    const distance = Math.hypot(
      event.clientX - dragState.startX,
      event.clientY - dragState.startY,
    );

    if (!dragState.active && distance < 6) {
      return;
    }

    event.preventDefault();
    dragState.active = true;
    setCategoryDraggingPaperId(dragState.paperId);
    onPaperPointerDragOverCategory(findCategoryDropTarget(event.clientX, event.clientY));
  };

  const handleCategoryPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = categoryDragRef.current;

    if (!dragState) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    const categoryId = findCategoryDropTarget(event.clientX, event.clientY);

    if (dragState.active) {
      event.preventDefault();
      setSuppressClickPaperId(dragState.paperId);
      window.setTimeout(() => setSuppressClickPaperId(null), 0);

      if (categoryId) {
        onPaperDropOnCategory(dragState.paperId, categoryId);
      }
    }

    resetCategoryDrag();
  };

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    paper: LiteraturePaper,
  ) => {
    if (event.key === 'Enter') {
      onOpenPaper(paper);
      return;
    }

    if (event.key === ' ') {
      event.preventDefault();
      onSelectPaper(paper.id);
    }
  };

  return (
    <section
      ref={rootRef}
      onWheelCapture={handleWheelCapture}
      className="pq-library-pane flex h-full min-h-0 flex-col overflow-hidden border-r"
    >
      <header className="pq-toolbar px-4 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <LibrarySearchInput value={searchQuery} onChange={onSearchQueryChange} />

          <select
            value={sortValue}
            onChange={(event) => {
              const [nextSortBy, nextDirection] = event.target.value.split(':') as [
                LiteraturePaperListSortBy,
                LiteraturePaperListSortDirection,
              ];

              onSortChange(nextSortBy, nextDirection);
            }}
            className="pq-input h-9 w-[168px] px-3 text-sm"
            title={l('排序', 'Sort')}
          >
            <option value="manual:asc">{l('手动排序', 'Manual Order')}</option>
            <option value="title:asc">{l('名称 A-Z', 'Name A-Z')}</option>
            <option value="title:desc">{l('名称 Z-A', 'Name Z-A')}</option>
            <option value="importedAt:desc">{l('添加时间 新-旧', 'Added New-Old')}</option>
            <option value="importedAt:asc">{l('添加时间 旧-新', 'Added Old-New')}</option>
            <option value="year:desc">{l('出版时间 新-旧', 'Year New-Old')}</option>
            <option value="year:asc">{l('出版时间 旧-新', 'Year Old-New')}</option>
            <option value="updatedAt:desc">{l('更新时间 新-旧', 'Updated New-Old')}</option>
            <option value="author:asc">{l('作者 A-Z', 'Author A-Z')}</option>
          </select>

          <button
            type="button"
            onClick={onImportPdfs}
            disabled={working}
            className="pq-button-primary h-9 px-3 text-sm"
          >
            <FilePlus2 className="mr-2 h-4 w-4" strokeWidth={1.9} />
            {l('导入 PDF', 'Import PDF')}
          </button>

          <button
            type="button"
            onClick={onRefresh}
            disabled={working}
            className="pq-button h-9 px-3 text-sm"
          >
            <RefreshCw className="mr-2 h-4 w-4" strokeWidth={1.9} />
            {l('刷新', 'Refresh')}
          </button>
        </div>

        <div className="mt-2 text-xs text-[var(--pq-text-muted)]">
          {error ||
            statusMessage ||
            (manualSortingEnabled
              ? l('拖动把手可调整排序；拖动条目到分类可归类。', 'Drag the handle to reorder papers; drag the row onto a category to classify it.')
              : l('当前使用自动排序；拖动条目到分类仍可归类。', 'Automatic sorting is active. Dragging a row onto a category still classifies it.'))}
        </div>
      </header>

      <div
        ref={listScrollRef}
        data-wheel-scroll-target
        style={{ containerType: 'inline-size', containerName: 'paper-list' }}
        aria-busy={loading || queryPending}
        className="h-0 min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-3"
      >
        {loading ? (
          <div className="pq-card p-6 text-sm text-[var(--pq-text-muted)]">
            {l('正在加载文献库...', 'Loading library...')}
          </div>
        ) : queryPending ? (
          <div role="status" className="pq-card p-6 text-sm text-[var(--pq-text-muted)]">
            {l('正在更新文献列表...', 'Updating papers...')}
          </div>
        ) : queryError ? (
          <div role="alert" className="pq-card p-6 text-sm">
            <p className="font-semibold">{l('未能加载文献列表', 'Could not load papers')}</p>
            <p className="mt-2 break-words text-[var(--pq-text-muted)]">{queryError}</p>
            <button type="button" onClick={onRetrySearch ?? onRefresh} className="pq-button mt-4 h-9 px-3">
              {l('重试搜索', 'Retry search')}
            </button>
          </div>
        ) : papers.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--pq-border)] bg-white/58 p-8 text-center dark:bg-white/5">
            <BookOpenText className="mx-auto h-9 w-9 text-slate-400 dark:text-[#a0a0a0]" strokeWidth={1.7} />
            <div className="mt-4 text-lg font-semibold">
              {searchQuery.trim() ? l('没有找到匹配的文献', 'No matching papers') : l('当前分类暂无文献', 'No papers in this category')}
            </div>
            <div className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500 dark:text-[#a0a0a0]">
              {searchQuery.trim() ? l('试试其他关键词，或清空搜索以查看当前分类。', 'Try another keyword or clear the search to see this category.') : l(
                '点击“导入 PDF”选择一个或多个文件。应用会把路径、附件和基础元数据保存到本地文库。',
                'Click "Import PDF" to select one or more files. The app will save paths, attachments, and basic metadata into the local library.',
              )}
            </div>
            {searchQuery.trim() ? <button type="button" onClick={() => onSearchQueryChange('')} className="pq-button mt-4 h-9 px-3 text-sm">
              {l('清空关键词', 'Clear keywords')}
            </button> : null}
          </div>
        ) : (
          <div className="space-y-2">
            {papers.map((paper) => {
              const active = selectedPaper?.id === paper.id;
              const pdfPath = paperPdfPath(paper, storageDir);
              const showBeforeIndicator =
                dropIndicator?.paperId === paper.id && dropIndicator.placement === 'before';
              const showAfterIndicator =
                dropIndicator?.paperId === paper.id && dropIndicator.placement === 'after';
              const status = paperStatuses[paper.id];
              const mineruParsed = status?.mineruParsed ?? false;
              const overviewGenerated =
                status?.overviewGenerated ?? Boolean(paper.aiSummary?.trim());

              return (
                <div key={paper.id} className="relative">
                  {showBeforeIndicator ? (
                    <div className="pointer-events-none absolute -top-1 left-3 right-3 z-10 h-0.5 rounded-full bg-[#2f7f85]" />
                  ) : null}
                  <div
                    role="button"
                    tabIndex={0}
                    data-paper-row-id={paper.id}
                    draggable={false}
                    onPointerDown={(event) => handleCategoryPointerDown(event, paper)}
                    onPointerMove={handleCategoryPointerMove}
                    onPointerUp={handleCategoryPointerUp}
                    onPointerCancel={resetCategoryDrag}
                    onDragStart={(event) => {
                      setDraggingPaperId(paper.id);
                      onPaperDragStart(event, paper);
                    }}
                    onDragOver={(event) => handlePaperDragOver(event, paper)}
                    onDragLeave={() => setDropIndicator(null)}
                    onDragEnd={() => {
                      setDropIndicator(null);
                      setDraggingPaperId(null);
                    }}
                    onDrop={(event) => handlePaperDrop(event, paper)}
                    onContextMenu={(event) => onPaperContextMenu(event, paper)}
                    onClick={() => {
                      if (suppressClickPaperId === paper.id) {
                        return;
                      }

                      onSelectPaper(paper.id);
                    }}
                    onDoubleClick={() => onOpenPaper(paper)}
                    onKeyDown={(event) => handleRowKeyDown(event, paper)}
                    className={clsx(
                      'pq-card pq-paper-row grid w-full gap-3 px-3 py-3 text-left transition',
                      manualSortingEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                      showReadingHeatmap
                        ? 'grid-cols-[28px_minmax(0,1fr)_minmax(128px,160px)_72px_96px]'
                        : 'grid-cols-[28px_minmax(0,1fr)_100px_110px]',
                      active
                        ? 'border-[var(--pq-accent-border-strong)] bg-[var(--pq-accent-soft)] ring-1 ring-[var(--pq-accent-ring)]'
                        : dropIndicator?.paperId === paper.id
                          ? 'border-[var(--pq-accent-border-strong)] bg-[var(--pq-accent-soft)]'
                          : 'hover:border-[var(--pq-accent-border)] hover:bg-white/92',
                      sortDraggingPaperId === paper.id && 'opacity-60 ring-2 ring-teal-300/60',
                      categoryDraggingPaperId === paper.id && 'opacity-70 ring-2 ring-teal-300/70',
                    )}
                  >
                    <span
                      data-paper-sort-handle
                      draggable={false}
                      title={
                        manualSortingEnabled
                          ? l('拖拽排序', 'Drag to reorder')
                          : l('切换到手动排序后可拖拽排序', 'Switch to manual order to drag-sort')
                      }
                      onPointerDown={(event) => handleSortPointerDown(event, paper)}
                      onPointerMove={handleSortPointerMove}
                      onPointerUp={handleSortPointerUp}
                      onPointerCancel={resetSortDrag}
                      className={clsx(
                        'mt-0.5 flex h-8 w-7 items-center justify-center rounded-lg text-[var(--pq-text-faint)] transition',
                        manualSortingEnabled
                          ? 'cursor-grab hover:bg-[var(--pq-accent-soft)] hover:text-[var(--pq-accent)] active:cursor-grabbing'
                          : 'cursor-not-allowed opacity-45',
                      )}
                    >
                      <GripVertical className="h-4 w-4" strokeWidth={1.8} />
                    </span>
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        {paper.isFavorite ? (
                          <Star className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-200" fill="currentColor" strokeWidth={1.8} />
                        ) : null}
                        <span className="block truncate text-sm font-semibold">
                          {paper.title}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-xs text-slate-500 dark:text-[#a0a0a0]">
                        {paperAuthors(paper, locale)}
                      </span>
                      <span className="mt-2 flex flex-wrap gap-1.5">
                        <span
                          className={clsx(
                            'rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                            status?.checkingMineru
                              ? 'border-slate-300 bg-slate-100 text-slate-500 dark:border-white/10 dark:bg-white/[0.06] dark:text-[#a0a0a0]'
                              : mineruParsed
                                ? 'border-emerald-300/55 bg-emerald-50 text-emerald-700 dark:border-emerald-300/20 dark:bg-emerald-300/10 dark:text-emerald-100'
                                : 'border-amber-300/55 bg-amber-50 text-amber-700 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100',
                          )}
                        >
                          {status?.checkingMineru
                            ? l('MinerU 检测中', 'Checking MinerU')
                            : mineruParsed
                              ? l('MinerU 已解析', 'MinerU Parsed')
                              : l('MinerU 未解析', 'MinerU Not Parsed')}
                        </span>
                        <span
                          className={clsx(
                            'rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                            overviewGenerated
                              ? 'border-sky-300/55 bg-sky-50 text-sky-700 dark:border-sky-300/20 dark:bg-sky-300/10 dark:text-sky-100'
                              : 'border-slate-300 bg-slate-100 text-slate-500 dark:border-white/10 dark:bg-white/[0.06] dark:text-[#a0a0a0]',
                          )}
                        >
                          {overviewGenerated
                            ? l('概览已生成', 'Overview Ready')
                            : l('概览未生成', 'No Overview')}
                        </span>
                      </span>
                      {paper.tags.length > 0 ? (
                        <span className="mt-2 flex flex-wrap gap-1.5">
                          {paper.tags.slice(0, 3).map((tag) => (
                            <span
                              key={tag.id}
                              className="rounded-full border border-cyan-300/45 bg-cyan-50 px-2 py-0.5 text-[10px] font-semibold text-cyan-700 dark:border-cyan-300/18 dark:bg-cyan-300/10 dark:text-cyan-100"
                            >
                              {tag.name}
                            </span>
                          ))}
                          {paper.tags.length > 3 ? (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-white/[0.06] dark:text-[#a0a0a0]">
                              +{paper.tags.length - 3}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      <span className="mt-2 block truncate text-[11px] text-slate-400 dark:text-[#8d8d8d]">
                        {pdfPath ? truncateMiddle(pdfPath, 68) : l('缺少 PDF 附件', 'Missing PDF attachment')}
                      </span>
                    </span>
                    {showReadingHeatmap ? (
                      <span className="pq-paper-heatmap min-w-0 self-center">
                        <LiteratureReadingHeatmapPreview
                          heatmap={heatmapsByPaperId[paper.id] ?? null}
                        />
                      </span>
                    ) : null}
                    <span className="text-sm text-slate-500 dark:text-[#a0a0a0]">
                      {paper.year ?? 'n.d.'}
                    </span>
                    <span className="pq-paper-date text-right text-xs text-slate-400 dark:text-[#8d8d8d]">
                      {new Date(paper.importedAt).toLocaleDateString()}
                    </span>
                  </div>
                  {showAfterIndicator ? (
                    <div className="pointer-events-none absolute -bottom-1 left-3 right-3 z-10 h-0.5 rounded-full bg-[#2f7f85]" />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {onPageChange ? (
        <nav aria-label={l('文献分页', 'Paper pagination')} className="pq-toolbar flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--pq-border)] px-4 py-2">
          <span role="status" className="text-xs text-[var(--pq-text-muted)]">
            {loading || queryPending ? l('正在更新...', 'Updating...') : queryError ? l('列表加载失败', 'List unavailable') :
              l(`第 ${paperTotal === 0 ? 0 : pageIndex * pageSize + 1}–${Math.min((pageIndex + 1) * pageSize, paperTotal)} 篇，共 ${paperTotal} 篇`,
                `${paperTotal === 0 ? 0 : pageIndex * pageSize + 1}–${Math.min((pageIndex + 1) * pageSize, paperTotal)} of ${paperTotal} papers`)}
          </span>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => onPageChange(0)} disabled={loading || queryPending || pageIndex === 0}
              className="pq-button h-8 px-2 text-xs">{l('首页', 'First')}</button>
            <button type="button" onClick={() => onPageChange(pageIndex - 1)} disabled={loading || queryPending || pageIndex === 0}
              className="pq-button h-8 px-2 text-xs">{l('上一页', 'Previous')}</button>
            <span className="min-w-12 text-center text-xs tabular-nums text-[var(--pq-text-muted)]">{pageIndex + 1} / {pageCount}</span>
            <button type="button" onClick={() => onPageChange(pageIndex + 1)} disabled={loading || queryPending || pageIndex >= pageCount - 1}
              className="pq-button h-8 px-2 text-xs">{l('下一页', 'Next')}</button>
            <button type="button" onClick={() => onPageChange(pageCount - 1)} disabled={loading || queryPending || pageIndex >= pageCount - 1}
              className="pq-button h-8 px-2 text-xs">{l('末页', 'Last')}</button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

