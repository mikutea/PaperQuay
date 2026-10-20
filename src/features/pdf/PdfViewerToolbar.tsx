import type { Dispatch, SetStateAction, ReactNode } from 'react';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Download,
  Highlighter,
  Loader2,
  MousePointer2,
  PenTool,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import {
  getPdfAnnotationColorValue,
  PDF_ANNOTATION_COLOR_PRESETS,
  type PdfAnnotationColorTool,
  type PdfAnnotationToolColors,
} from './annotationColors';
import {
  getPdfAnnotationColorLabel,
  getPercentProgress,
} from './pdfViewerUtils';

type Localize = (zh: string, en: string) => string;

export type AnnotationEditorTool = 'none' | 'highlight' | 'freetext' | 'ink';

type ToolbarToolKey = 'select' | 'highlight' | 'freetext' | 'ink';

interface ToolbarTool {
  key: ToolbarToolKey;
  label: string;
  icon: ReactNode;
}

interface PdfViewerToolbarProps {
  annotationColors: PdfAnnotationToolColors;
  canShowReadingHeatmapBar: boolean;
  currentPage: number;
  documentError: string;
  editorTool: AnnotationEditorTool;
  enableReadingHeatmap: boolean;
  hasLiveTextSelection: boolean;
  hasSelectedEditor: boolean;
  hideToolbar: boolean;
  l: Localize;
  loading: boolean;
  onAnnotationToolColorChange: (tool: PdfAnnotationColorTool, value: string) => void;
  onCreateHighlight: () => void | Promise<void>;
  onDeleteSelected: () => void;
  onEditorToolChange: Dispatch<SetStateAction<AnnotationEditorTool>>;
  onSave: () => void | Promise<void>;
  onScrollToPage: (pageIndex: number) => void;
  onToggleReadingHeatmapBar: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  pageCount: number;
  readingHeatmapToggleLabel: string;
  saveMessage: string;
  saving: boolean;
  showReadingHeatmapBar: boolean;
  translating: boolean;
  translationProgressCompleted: number;
  translationProgressTotal: number;
  zoomLabel: string;
}

export function PdfViewerToolbar({
  annotationColors,
  canShowReadingHeatmapBar,
  currentPage,
  documentError,
  editorTool,
  enableReadingHeatmap,
  hasLiveTextSelection,
  hasSelectedEditor,
  hideToolbar,
  l,
  loading,
  onAnnotationToolColorChange,
  onCreateHighlight,
  onDeleteSelected,
  onEditorToolChange,
  onSave,
  onScrollToPage,
  onToggleReadingHeatmapBar,
  onZoomIn,
  onZoomOut,
  pageCount,
  readingHeatmapToggleLabel,
  saveMessage,
  saving,
  showReadingHeatmapBar,
  translating,
  translationProgressCompleted,
  translationProgressTotal,
  zoomLabel,
}: PdfViewerToolbarProps) {
  const activeColorTool = editorTool === 'none' ? 'highlight' : editorTool;
  const activeToolColor = annotationColors[activeColorTool];
  const colorToolLabel = activeColorTool === 'highlight' ? l('高亮颜色', 'Highlight color')
    : activeColorTool === 'freetext' ? l('文字颜色', 'Text color') : l('手写颜色', 'Ink color');
  const translationProgressRatio = getPercentProgress(
    translationProgressCompleted,
    translationProgressTotal,
  );
  const toolbarTools: ToolbarTool[] = [
    {
      key: 'select',
      label: l('选择联动', 'Select & Link'),
      icon: <MousePointer2 className="h-4 w-4" strokeWidth={1.8} />,
    },
    {
      key: 'highlight',
      label: l('高亮', 'Highlight'),
      icon: <Highlighter className="h-4 w-4" strokeWidth={1.8} />,
    },
    {
      key: 'freetext',
      label: l('文本', 'Text'),
      icon: <Type className="h-4 w-4" strokeWidth={1.8} />,
    },
    {
      key: 'ink',
      label: l('手写', 'Ink'),
      icon: <PenTool className="h-4 w-4" strokeWidth={1.8} />,
    },
  ];

  const getToolLabel = (key: ToolbarToolKey) => {
    if (key === 'select') return l('选择联动', 'Select & Link');
    if (key === 'highlight') return l('高亮：点击后拖选文字，也可先选文字再点击', 'Highlight: select this tool and drag over text, or highlight selected text');
    if (key === 'freetext') return l('文本批注', 'Text Annotation');
    return l('手写批注', 'Ink Annotation');
  };

  return (
    <div className={cn(
      'max-h-[40%] shrink-0 overflow-y-auto border-b border-slate-200/80 bg-white/78 px-4 py-3 backdrop-blur-xl dark:border-white/10 dark:bg-[var(--pq-bg-primary)]',
      hideToolbar && 'hidden',
    )}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-1 dark:border-white/10 dark:bg-[var(--pq-surface-1)]">
          {toolbarTools.map((item) => (
            <button
              key={item.key}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (item.key === 'highlight') {
                  if (hasLiveTextSelection && editorTool === 'none') void onCreateHighlight();
                  else onEditorToolChange((current) => current === 'highlight' ? 'none' : 'highlight');
                  return;
                }

                if (item.key === 'select') {
                  onEditorToolChange('none');
                  return;
                }

                const editableTool = item.key;
                onEditorToolChange((current) => (current === editableTool ? 'none' : editableTool));
              }}
              disabled={loading || saving}
              aria-pressed={item.key === 'select' ? editorTool === 'none' : editorTool === item.key}
              title={getToolLabel(item.key)}
              aria-label={getToolLabel(item.key)}
              className={cn(
                'inline-flex h-10 w-10 items-center justify-center rounded-xl border text-slate-500 transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-55',
                ((item.key === 'select' && editorTool === 'none') ||
                  (item.key !== 'select' &&
                    editorTool === item.key))
                  ? 'border-indigo-200 bg-white text-indigo-600 shadow-[0_8px_18px_rgba(79,70,229,0.12)] dark:border-indigo-400/30 dark:bg-[var(--pq-surface-2)] dark:text-indigo-400 dark:shadow-[0_8px_18px_rgba(79,70,229,0.18)]'
                  : 'border-transparent bg-transparent hover:border-slate-200 hover:bg-white hover:text-slate-800 dark:hover:border-white/15 dark:hover:bg-[var(--pq-surface-2)] dark:hover:text-[var(--pq-text)]',
              )}
            >
              {item.icon}
            </button>
          ))}
        </div>

        <div className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white/86 px-2.5 py-2 dark:border-white/10 dark:bg-[var(--pq-surface-1)]">
          <span className="text-xs text-slate-500 dark:text-[var(--pq-text-muted)]">{colorToolLabel}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {PDF_ANNOTATION_COLOR_PRESETS.map((preset) => {
              const colorValue = getPdfAnnotationColorValue(preset, activeColorTool);
              const active = colorValue.toLowerCase() === activeToolColor.toLowerCase();
              const colorLabel = getPdfAnnotationColorLabel(preset.id, l);

              return (
                <button
                  key={`${activeColorTool}-${preset.id}`}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onAnnotationToolColorChange(activeColorTool, colorValue)}
                  className={cn(
                    'h-6 w-6 rounded-full border-2 transition-all duration-200',
                    active
                      ? 'scale-110 border-slate-900 shadow-[0_0_0_2px_rgba(255,255,255,0.9)] dark:border-[var(--pq-text)] dark:shadow-[0_0_0_2px_rgba(255,255,255,0.12)]'
                      : 'border-white hover:scale-105 hover:border-slate-300 dark:border-[var(--pq-border)] dark:hover:border-[var(--pq-border-strong)]',
                  )}
                  style={{ backgroundColor: colorValue }}
                  title={`${colorToolLabel} · ${colorLabel}`}
                  aria-label={`${colorToolLabel} · ${colorLabel}`}
                  aria-pressed={active}
                />
              );
            })}
          </div>
          <label
            className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:bg-white dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-muted)] dark:hover:border-white/15 dark:hover:bg-[var(--pq-surface-2)]"
            title={`${colorToolLabel} · ${l('自定义颜色', 'Custom color')}`}
          >
            <input
              type="color"
              aria-label={`${colorToolLabel} · ${l('自定义颜色', 'Custom color')}`}
              value={activeToolColor}
              onChange={(event) => onAnnotationToolColorChange(activeColorTool, event.target.value)}
              className="sr-only"
            />
            <span
              className="h-4 w-4 rounded-full border border-white shadow-sm"
              style={{ backgroundColor: activeToolColor }}
            />
            {l('自定义', 'Custom')}
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-faint)]">
            {l(`Page ${currentPage}/${Math.max(pageCount, 1)}`, `Page ${currentPage}/${Math.max(pageCount, 1)}`)}
          </div>
          <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-faint)]">
            {zoomLabel}
          </div>
          <button
            type="button"
            onClick={() => onScrollToPage(Math.max(0, currentPage - 2))}
            className="inline-flex items-center rounded-xl border border-slate-200 bg-white p-2 text-slate-600 transition-all duration-200 hover:bg-slate-50 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-muted)] dark:hover:bg-[var(--pq-surface-2)]"
            title={l('Previous page', 'Previous page')}
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={1.9} />
          </button>
          <button
            type="button"
            onClick={() => onScrollToPage(Math.min(Math.max(pageCount - 1, 0), currentPage))}
            className="inline-flex items-center rounded-xl border border-slate-200 bg-white p-2 text-slate-600 transition-all duration-200 hover:bg-slate-50 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-muted)] dark:hover:bg-[var(--pq-surface-2)]"
            title={l('Next page', 'Next page')}
          >
            <ChevronRight className="h-4 w-4" strokeWidth={1.9} />
          </button>
          <button
            type="button"
            onClick={onZoomOut}
            className="inline-flex items-center rounded-xl border border-slate-200 bg-white p-2 text-slate-600 transition-all duration-200 hover:bg-slate-50 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-muted)] dark:hover:bg-[var(--pq-surface-2)]"
            title={l('缩小', 'Zoom out')}
          >
            <ZoomOut className="h-4 w-4" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            onClick={onZoomIn}
            className="inline-flex items-center rounded-xl border border-slate-200 bg-white p-2 text-slate-600 transition-all duration-200 hover:bg-slate-50 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-muted)] dark:hover:bg-[var(--pq-surface-2)]"
            title={l('放大', 'Zoom in')}
          >
            <ZoomIn className="h-4 w-4" strokeWidth={1.8} />
          </button>
          {enableReadingHeatmap ? (
            <button
              type="button"
              onClick={onToggleReadingHeatmapBar}
              disabled={!canShowReadingHeatmapBar}
              className={cn(
                'inline-flex items-center rounded-xl border p-2 transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-55',
                showReadingHeatmapBar
                  ? 'border-[var(--pq-accent-border)] bg-[var(--pq-accent-bg)] text-[var(--pq-accent)] shadow-[0_8px_18px_var(--pq-accent-shadow)] dark:border-[var(--pq-accent-border)] dark:bg-[var(--pq-accent-bg)] dark:text-[var(--pq-accent-text)]'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-muted)] dark:hover:bg-[var(--pq-surface-2)]',
              )}
              title={readingHeatmapToggleLabel}
              aria-label={readingHeatmapToggleLabel}
            >
              <Activity className="h-4 w-4" strokeWidth={1.8} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDeleteSelected}
            disabled={!hasSelectedEditor || loading || saving}
            className={cn(
              'inline-flex items-center rounded-xl border px-3 py-2 text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60',
              hasSelectedEditor && !loading && !saving
                ? 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-400 dark:hover:bg-rose-400/20'
                : 'border-slate-200 bg-white text-slate-400 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-faint)]',
            )}
            title={l('删除当前选中的 PDF 批注', 'Delete the selected PDF annotation')}
          >
            <Trash2 className="mr-2 h-4 w-4" strokeWidth={1.8} />
            {l('Delete Selected', 'Delete Selected')}
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={saving || loading}
            className="inline-flex items-center rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-[var(--pq-accent)] dark:text-[var(--pq-text)] dark:hover:bg-[var(--pq-accent-hover)]"
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.8} />
            ) : (
              <Download className="mr-2 h-4 w-4" strokeWidth={1.8} />
            )}
            {saving ? l('正在导出...', 'Exporting...') : l('导出批注 PDF', 'Export Annotated PDF')}
          </button>
        </div>
      </div>

      {saveMessage ? <div className="mt-2 text-xs text-emerald-600">{saveMessage}</div> : null}
      {documentError ? <div className="mt-2 text-xs text-rose-600">{documentError}</div> : null}
      {translating && translationProgressTotal > 0 ? (
        <div className="mt-3 rounded-2xl border border-indigo-100 bg-indigo-50/80 px-3 py-2.5 dark:border-indigo-400/20 dark:bg-indigo-400/10">
          <div className="flex items-center justify-between gap-3 text-xs font-medium text-indigo-700 dark:text-indigo-400">
            <span>{l('MinerU block translation progress', 'MinerU block translation progress')}</span>
            <span>
              {translationProgressCompleted}/{translationProgressTotal}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-indigo-100 dark:bg-indigo-500/20">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all duration-300 dark:bg-indigo-400"
              style={{ width: `${translationProgressRatio}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
