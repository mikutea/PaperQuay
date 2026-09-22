import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  BookOpenText,
  ChevronRight,
  CheckCircle2,
  FileText,
  Languages,
  Loader2,
  Pencil,
  Save,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import { useAppLocale, useLocaleText } from '../../../i18n/uiLanguage';
import { useWheelScrollDelegate } from '../../../hooks/useWheelScrollDelegate';
import type {
  LiteraturePaper,
  LiteraturePaperTaskKind,
  LiteraturePaperTaskState,
  UpdatePaperRequest,
} from '../../../types/library';
import type { PdfReadingHeatmap } from '../../../types/reader';
import {
  loadPaperHistory,
  PAPER_READING_HEATMAP_UPDATED_EVENT,
} from '../../../utils/paperHistory';
import {
  isPaperPipelineActionDisabled,
  isPaperPipelineBusy,
} from '../../reader/paperTaskState';
import {
  paperAuthors,
  paperPdfPath,
} from '../literatureUi';
import LiteratureReadingTimeChart from './LiteratureReadingTimeChart';

interface LiteraturePaperDetailsProps {
  selectedPaper: LiteraturePaper | null;
  saving: boolean;
  onOpenPaper: (paper: LiteraturePaper) => void;
  onSavePaper: (request: UpdatePaperRequest) => void;
  actionState?: LiteraturePaperTaskState | null;
  onRunMineruParse?: (paper: LiteraturePaper) => void;
  onTranslatePaper?: (paper: LiteraturePaper) => void;
  onGenerateSummary?: (paper: LiteraturePaper) => void;
}

interface PaperEditDraft {
  title: string;
  authors: string;
  year: string;
  publication: string;
  doi: string;
  url: string;
  abstractText: string;
  keywords: string;
  tags: string;
  userNote: string;
  citation: string;
}

type OverviewSectionKey =
  | 'overview'
  | 'background'
  | 'problem'
  | 'approach'
  | 'experiment'
  | 'findings'
  | 'conclusion'
  | 'limitations'
  | 'takeaways'
  | 'keywords';

interface ParsedOverviewSection {
  key: OverviewSectionKey;
  title: string;
  content: string;
}

function resolveOverviewSectionKey(title: string): OverviewSectionKey {
  const normalized = title
    .trim()
    .toLocaleLowerCase()
    .replace(/[：:]/g, '');

  if (/keyword|keywords/.test(normalized)) {
    return 'keywords';
  }

  if (/finding|result/.test(normalized)) {
    return 'findings';
  }

  if (/takeaway|insight|contribution/.test(normalized)) {
    return 'takeaways';
  }

  if (/limitation|weakness|constraint/.test(normalized)) {
    return 'limitations';
  }

  if (/conclusion|summary/.test(normalized)) {
    return 'conclusion';
  }

  if (/experiment|validation|evaluation|setup/.test(normalized)) {
    return 'experiment';
  }

  if (/approach|method|model|framework/.test(normalized)) {
    return 'approach';
  }

  if (/problem|question/.test(normalized)) {
    return 'problem';
  }

  if (/background|motivation/.test(normalized)) {
    return 'background';
  }

  return 'overview';
}

function parseOverviewSections(value: string): ParsedOverviewSection[] {
  const normalized = value.replace(/\r\n?/g, '\n').trim();

  if (!normalized) {
    return [];
  }

  const sections: ParsedOverviewSection[] = [];
  let currentTitle = 'Overview';
  let currentKey: OverviewSectionKey = 'overview';
  let currentLines: string[] = [];

  const flush = () => {
    const content = currentLines.join('\n').trim();

    if (!content) {
      currentLines = [];
      return;
    }

    const existingSection = sections.find((section) => section.key === currentKey);

    if (existingSection) {
      existingSection.content = `${existingSection.content}\n${content}`.trim();
    } else {
      sections.push({
        key: currentKey,
        title: currentTitle,
        content,
      });
    }

    currentLines = [];
  };

  for (const line of normalized.split('\n')) {
    const heading = line.match(/^#{1,4}\s+(.+?)\s*$/);

    if (heading) {
      flush();
      currentTitle = heading[1].trim();
      currentKey = resolveOverviewSectionKey(currentTitle);
      continue;
    }

    currentLines.push(line);
  }

  flush();

  return sections.length > 0
    ? sections
    : [
        {
          key: 'overview',
          title: 'Overview',
          content: normalized,
        },
      ];
}

function overviewSectionLabel(
  key: OverviewSectionKey,
  fallbackTitle: string,
  l: <T>(zh: T, en: T) => T,
): string {
  const labels: Record<OverviewSectionKey, string> = {
    overview: l('概览', 'Overview'),
    background: l('背景', 'Background'),
    problem: l('问题', 'Problem'),
    approach: l('方法', 'Approach'),
    experiment: l('实验', 'Experiments'),
    findings: l('发现', 'Findings'),
    conclusion: l('结论', 'Conclusion'),
    limitations: l('局限', 'Limitations'),
    takeaways: l('要点', 'Takeaways'),
    keywords: l('关键词', 'Keywords'),
  };

  return labels[key] || fallbackTitle;
}

function splitOverviewListItems(content: string, key: OverviewSectionKey): string[] {
  const normalized = content.replace(/\r\n?/g, '\n').trim();

  if (!normalized) {
    return [];
  }

  if (key === 'keywords') {
    return normalized
      .split(/[,;\n]/)
      .map((item) => item.replace(/^[-*\s]*/, '').trim())
      .filter(Boolean);
  }

  return normalized
    .split(/\n+/)
    .map((item) => item.replace(/^(\d+[.)]\s*|[-*\s]*)/, '').trim())
    .filter(Boolean);
}

function latestReadingHeatmapForPaper(paperId: string | null | undefined): PdfReadingHeatmap | null {
  if (!paperId) {
    return null;
  }

  const history = loadPaperHistory(`native-library:${paperId}`);

  return Object.values(history?.pdfReadingHeatmaps ?? {})
    .filter((heatmap) => heatmap.totalMs > 0)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}

function draftFromPaper(paper: LiteraturePaper | null): PaperEditDraft {
  return {
    title: paper?.title ?? '',
    authors: paper?.authors.map((author) => author.name).join(', ') ?? '',
    year: paper?.year ?? '',
    publication: paper?.publication ?? '',
    doi: paper?.doi ?? '',
    url: paper?.url ?? '',
    abstractText: paper?.abstractText ?? '',
    keywords: paper?.keywords.join(', ') ?? '',
    tags: paper?.tags.map((tag) => tag.name).join(', ') ?? '',
    userNote: paper?.userNote ?? '',
    citation: paper?.citation ?? '',
  };
}

function splitList(value: string): string[] {
  return value
    .split(/[;,，；]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function inputValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function FieldLabel({ children }: { children: string }) {
  return (
    <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-[#8d8d8d]">
      {children}
    </div>
  );
}

function TextInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="pq-input h-10 w-full px-3 text-sm placeholder:text-[var(--pq-text-faint)]"
    />
  );
}

function TextArea({
  value,
  rows = 4,
  placeholder,
  onChange,
}: {
  value: string;
  rows?: number;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="pq-input w-full resize-none px-3 py-2 text-sm leading-6 placeholder:text-[var(--pq-text-faint)]"
    />
  );
}

function ActionButton({
  children,
  icon,
  disabled,
  primary = false,
  onClick,
}: {
  children: ReactNode;
  icon: ReactNode;
  disabled?: boolean;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        primary
          ? 'pq-button-primary w-full px-4 py-2.5 text-sm'
          : 'pq-button px-3 py-2.5 text-sm'
      }
    >
      <span className="mr-2">{icon}</span>
      {children}
    </button>
  );
}

function ProcessingActionTile({
  title,
  description,
  icon,
  dataTour,
  disabled,
  active,
  busy,
  onClick,
}: {
  title: ReactNode;
  description: ReactNode;
  icon: ReactNode;
  dataTour?: string;
  disabled?: boolean;
  active?: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-tour={dataTour}
      onClick={onClick}
      disabled={disabled}
      className={[
        'group flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition hover:border-[var(--pq-accent-border)] hover:bg-white/88 disabled:cursor-not-allowed disabled:opacity-55',
        active
          ? 'border-[var(--pq-accent-border-strong)] bg-[var(--pq-accent-soft)] ring-1 ring-[var(--pq-accent-ring)]'
          : 'border-[var(--pq-border)] bg-white/72 dark:bg-white/6',
      ].join(' ')}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--pq-accent-ring)] bg-[var(--pq-accent-soft)] text-[var(--pq-accent)] transition group-hover:bg-white/80">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-800 dark:text-[#e8e8e8]">
          {title}
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-4 text-slate-500 dark:text-[#a0a0a0]">
          {description}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--pq-text-faint)] transition group-hover:translate-x-0.5 group-hover:text-[var(--pq-accent)]" strokeWidth={2} />
    </button>
  );
}

function TaskStatusPanel({
  state,
}: {
  state: LiteraturePaperTaskState;
}) {
  const total = typeof state.total === 'number' ? state.total : 0;
  const completed = typeof state.completed === 'number' ? state.completed : 0;
  const hasProgress = total > 0;
  const ratio = hasProgress ? Math.min(100, Math.max(0, (completed / total) * 100)) : 45;
  const tone =
    state.status === 'error'
      ? 'rose'
      : state.status === 'success'
        ? 'emerald'
        : 'teal';
  const StatusIcon =
    state.status === 'error'
      ? AlertCircle
      : state.status === 'success'
        ? CheckCircle2
        : Loader2;

  return (
    <div
      className={[
        'rounded-lg border px-3.5 py-3',
        tone === 'rose'
          ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-300/25 dark:bg-rose-300/10 dark:text-rose-200'
          : '',
        tone === 'emerald'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-300/25 dark:bg-emerald-300/10 dark:text-emerald-200'
          : '',
        tone === 'teal'
          ? 'border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-300/25 dark:bg-teal-300/10 dark:text-teal-100'
          : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/80 dark:bg-white/10">
          <StatusIcon
            className={['h-4 w-4', state.status === 'running' ? 'animate-spin' : ''].join(' ')}
            strokeWidth={2}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="truncate text-sm font-semibold">{state.label}</div>
            {hasProgress && state.status !== 'error' ? (
              <div className="shrink-0 text-xs font-semibold">
                {state.kind === 'overview' ? `${Math.round(ratio)}%` : `${completed}/${total}`}
              </div>
            ) : null}
          </div>
          <div className="mt-1 line-clamp-2 text-xs leading-5 opacity-80">
            {state.message}
          </div>
          {state.status !== 'error' ? (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/10">
              <div
                className={[
                  'h-full rounded-full transition-all duration-300',
                  state.status === 'running' && !hasProgress ? 'animate-pulse' : '',
                  tone === 'emerald' ? 'bg-emerald-500' : 'bg-teal-500',
                ].join(' ')}
                style={{ width: `${ratio}%` }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function LiteraturePaperDetails({
  selectedPaper,
  saving,
  onOpenPaper,
  onSavePaper,
  actionState,
  onRunMineruParse,
  onTranslatePaper,
  onGenerateSummary,
}: LiteraturePaperDetailsProps) {
  const l = useLocaleText();
  const locale = useAppLocale();
  const rootRef = useRef<HTMLElement | null>(null);
  const handleWheelCapture = useWheelScrollDelegate({ rootRef });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PaperEditDraft>(() => draftFromPaper(selectedPaper));
  const [activeOverviewKey, setActiveOverviewKey] = useState<OverviewSectionKey>('overview');
  const [readingHeatmap, setReadingHeatmap] = useState<PdfReadingHeatmap | null>(() =>
    latestReadingHeatmapForPaper(selectedPaper?.id),
  );

  useEffect(() => {
    setEditing(false);
    setDraft(draftFromPaper(selectedPaper));
    setReadingHeatmap(latestReadingHeatmapForPaper(selectedPaper?.id));
  }, [selectedPaper?.id]);

  useEffect(() => {
    const handleHeatmapUpdated = () => {
      setReadingHeatmap(latestReadingHeatmapForPaper(selectedPaper?.id));
    };

    window.addEventListener(PAPER_READING_HEATMAP_UPDATED_EVENT, handleHeatmapUpdated);

    return () => {
      window.removeEventListener(PAPER_READING_HEATMAP_UPDATED_EVENT, handleHeatmapUpdated);
    };
  }, [selectedPaper?.id]);

  const patchDraft = (patch: Partial<PaperEditDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const handleSave = () => {
    if (!selectedPaper) {
      return;
    }

    onSavePaper({
      paperId: selectedPaper.id,
      title: draft.title.trim() || selectedPaper.title,
      authors: splitList(draft.authors),
      year: inputValue(draft.year),
      publication: inputValue(draft.publication),
      doi: inputValue(draft.doi),
      url: inputValue(draft.url),
      abstractText: inputValue(draft.abstractText),
      keywords: splitList(draft.keywords),
      tags: splitList(draft.tags),
      userNote: inputValue(draft.userNote),
      citation: inputValue(draft.citation),
    });
    setEditing(false);
  };

  const handleToggleFavorite = () => {
    if (!selectedPaper) {
      return;
    }

    onSavePaper({
      paperId: selectedPaper.id,
      isFavorite: !selectedPaper.isFavorite,
    });
  };

  const hasPdf = selectedPaper ? Boolean(paperPdfPath(selectedPaper)) : false;
  const activeTaskKind: LiteraturePaperTaskKind | null =
    actionState?.status === 'running' ? actionState.kind : null;
  const pipelineBusy = isPaperPipelineBusy(actionState);
  const aiSummary = selectedPaper?.aiSummary?.trim() ?? '';
  const overviewSections = useMemo(() => parseOverviewSections(aiSummary), [aiSummary]);
  const activeOverviewSection =
    overviewSections.find((section) => section.key === activeOverviewKey) ?? overviewSections[0];

  useEffect(() => {
    if (overviewSections.length === 0) {
      setActiveOverviewKey('overview');
      return;
    }

    if (!overviewSections.some((section) => section.key === activeOverviewKey)) {
      setActiveOverviewKey(overviewSections[0].key);
    }
  }, [activeOverviewKey, overviewSections]);

  return (
    <aside
      ref={rootRef}
      onWheelCapture={handleWheelCapture}
      className="pq-library-pane flex h-full min-h-0 flex-col overflow-hidden border-l"
    >
      <header className="pq-toolbar px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8f94] dark:text-[#a0a0a0]">
              {l('文献详情', 'Paper Details')}
            </div>
            <div className="mt-0.5 text-base font-semibold">
              {selectedPaper ? l('已选择文献', 'Selected Paper') : l('未选择', 'No Selection')}
            </div>
          </div>
        </div>
      </header>

      <div
        data-wheel-scroll-target
        className="h-0 min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-4"
      >
        {selectedPaper ? (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold leading-7">{selectedPaper.title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-[#a0a0a0]">
                  {paperAuthors(selectedPaper, locale)}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={handleToggleFavorite}
                  disabled={saving}
                  className={
                    selectedPaper.isFavorite
                      ? 'pq-icon-button h-9 w-9 border border-amber-300/70 bg-amber-100 text-amber-700 disabled:opacity-60 dark:border-amber-300/25 dark:bg-amber-300/14 dark:text-amber-200'
                      : 'pq-icon-button h-9 w-9 border border-[var(--pq-border)] bg-white/65 text-[var(--pq-text-faint)] disabled:opacity-60'
                  }
                  title={selectedPaper.isFavorite ? l('取消收藏', 'Remove from favorites') : l('加入收藏', 'Add to favorites')}
                  aria-label={selectedPaper.isFavorite ? l('取消收藏', 'Remove from favorites') : l('加入收藏', 'Add to favorites')}
                >
                  <Star className="h-4 w-4" fill={selectedPaper.isFavorite ? 'currentColor' : 'none'} strokeWidth={1.9} />
                </button>

                <button
                  type="button"
                  onClick={() => setEditing((current) => !current)}
                  disabled={saving}
                  className="pq-button px-3 py-2 text-xs"
                >
                  {editing ? (
                    <X className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.9} />
                  ) : (
                    <Pencil className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.9} />
                  )}
                  {editing ? l('取消', 'Cancel') : l('编辑', 'Edit')}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <ActionButton
                primary
                disabled={!hasPdf}
                icon={<BookOpenText className="h-4 w-4" strokeWidth={1.9} />}
                onClick={() => onOpenPaper(selectedPaper)}
              >
                {l('打开阅读', 'Open Reader')}
              </ActionButton>

              <section className="pq-card p-3">
                <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
                  <div>
                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400 dark:text-[#8d8d8d]">
                      {l('文档处理', 'Document Pipeline')}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-[#a0a0a0]">
                      {l('解析、翻译和生成概览', 'Parse, translate, and generate overview')}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <ProcessingActionTile
                    dataTour="overview-mineru-parse"
                    disabled={isPaperPipelineActionDisabled({
                      hasPdf,
                      hasHandler: Boolean(onRunMineruParse),
                      actionState,
                    })}
                    active={activeTaskKind === 'mineru'}
                    busy={pipelineBusy && activeTaskKind === 'mineru'}
                    icon={<Sparkles className="h-4 w-4" strokeWidth={1.9} />}
                    onClick={() => onRunMineruParse?.(selectedPaper)}
                    title={l('MinerU 解析', 'MinerU Parse')}
                    description={l('提取结构化文本和版面块', 'Extract structured text and layout blocks')}
                  />
                  <ProcessingActionTile
                    dataTour="overview-translate-document"
                    disabled={isPaperPipelineActionDisabled({
                      hasPdf,
                      hasHandler: Boolean(onTranslatePaper),
                      actionState,
                    })}
                    active={activeTaskKind === 'translation'}
                    busy={pipelineBusy && activeTaskKind === 'translation'}
                    icon={<Languages className="h-4 w-4" strokeWidth={1.9} />}
                    onClick={() => onTranslatePaper?.(selectedPaper)}
                    title={l('全文翻译', 'Full Translation')}
                    description={l('将结构化内容翻译为双语文本', 'Translate structured blocks into bilingual text')}
                  />
                  <ProcessingActionTile
                    dataTour="generate-summary"
                    disabled={isPaperPipelineActionDisabled({
                      hasPdf,
                      hasHandler: Boolean(onGenerateSummary),
                      actionState,
                    })}
                    active={activeTaskKind === 'overview'}
                    busy={pipelineBusy && activeTaskKind === 'overview'}
                    icon={<FileText className="h-4 w-4" strokeWidth={1.9} />}
                    onClick={() => onGenerateSummary?.(selectedPaper)}
                    title={l('概览生成', 'Generate Overview')}
                    description={l('生成研究问题、方法和结论概览', 'Generate questions, methods, and findings')}
                  />
                </div>

                {actionState ? (
                  <div className="mt-3">
                    <TaskStatusPanel state={actionState} />
                  </div>
                ) : null}
              </section>
            </div>

            {editing ? (
              <div className="pq-card space-y-4 p-4">
                <label>
                  <FieldLabel>{l('标题', 'Title')}</FieldLabel>
                  <TextInput
                    value={draft.title}
                    onChange={(value) => patchDraft({ title: value })}
                  />
                </label>

                <label>
                  <FieldLabel>{l('作者', 'Authors')}</FieldLabel>
                  <TextInput
                    value={draft.authors}
                    placeholder={l('多个作者用逗号分隔', 'Separate with commas')}
                    onChange={(value) => patchDraft({ authors: value })}
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label>
                    <FieldLabel>{l('年份', 'Year')}</FieldLabel>
                    <TextInput
                      value={draft.year}
                      onChange={(value) => patchDraft({ year: value })}
                    />
                  </label>
                  <label>
                    <FieldLabel>DOI</FieldLabel>
                    <TextInput
                      value={draft.doi}
                      onChange={(value) => patchDraft({ doi: value })}
                    />
                  </label>
                </div>

                <label>
                  <FieldLabel>{l('期刊 / 会议', 'Journal / Conference')}</FieldLabel>
                  <TextInput
                    value={draft.publication}
                    onChange={(value) => patchDraft({ publication: value })}
                  />
                </label>

                <label>
                  <FieldLabel>URL</FieldLabel>
                  <TextInput
                    value={draft.url}
                    onChange={(value) => patchDraft({ url: value })}
                  />
                </label>

                <label>
                  <FieldLabel>{l('摘要', 'Abstract')}</FieldLabel>
                  <TextArea
                    value={draft.abstractText}
                    onChange={(value) => patchDraft({ abstractText: value })}
                  />
                </label>

                <label>
                  <FieldLabel>{l('关键词', 'Keywords')}</FieldLabel>
                  <TextInput
                    value={draft.keywords}
                    placeholder={l('多个关键词用逗号分隔', 'Separate with commas')}
                    onChange={(value) => patchDraft({ keywords: value })}
                  />
                </label>

                <label>
                  <FieldLabel>{l('标签', 'Tags')}</FieldLabel>
                  <TextInput
                    value={draft.tags}
                    placeholder={l('多个标签用逗号分隔，例如：Zotero, 综述, 待读', 'Separate with commas, e.g. Zotero, Review, To read')}
                    onChange={(value) => patchDraft({ tags: value })}
                  />
                </label>

                <label>
                  <FieldLabel>{l('用户笔记', 'User Note')}</FieldLabel>
                  <TextArea
                    value={draft.userNote}
                    rows={5}
                    onChange={(value) => patchDraft({ userNote: value })}
                  />
                </label>

                <label>
                  <FieldLabel>{l('引用信息', 'Citation')}</FieldLabel>
                  <TextArea
                    value={draft.citation}
                    rows={3}
                    onChange={(value) => patchDraft({ citation: value })}
                  />
                </label>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="pq-button-primary px-4 py-2.5 text-sm disabled:opacity-60"
                  >
                    <Save className="mr-2 h-4 w-4" strokeWidth={1.9} />
                    {saving ? l('正在保存...', 'Saving...') : l('保存修改', 'Save Changes')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(draftFromPaper(selectedPaper));
                      setEditing(false);
                    }}
                    disabled={saving}
                    className="pq-button px-4 py-2.5 text-sm disabled:opacity-60"
                  >
                    {l('放弃', 'Discard')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <dl className="pq-card p-4 text-sm">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-[#8d8d8d]">
                      {l('期刊 / 会议', 'Journal / Conference')}
                    </dt>
                    <dd className="mt-2 text-slate-700 dark:text-[#e0e0e0]">
                      {selectedPaper.publication || l('未设置', 'Not set')}
                    </dd>
                  </div>
                </dl>

                <LiteratureReadingTimeChart heatmap={readingHeatmap} />

                {selectedPaper.keywords.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedPaper.keywords.map((keyword) => (
                      <span
                        key={keyword}
                        className="pq-chip px-3 py-1 text-xs font-medium"
                      >
                        {keyword}
                      </span>
                    ))}
                  </div>
                ) : null}

                {selectedPaper.tags.length > 0 ? (
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400 dark:text-[#8d8d8d]">
                      {l('标签', 'Tags')}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedPaper.tags.map((tag) => (
                        <span
                          key={tag.id}
                          className="rounded-full border border-[var(--pq-accent-ring)] bg-[var(--pq-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--pq-accent)]"
                        >
                          {tag.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                <section className="pq-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400 dark:text-[#8d8d8d]">
                      {l('AI 概览', 'AI Overview')}
                    </div>
                    {overviewSections.length > 0 ? (
                      <span className="rounded-full border border-[var(--pq-accent-ring)] bg-[var(--pq-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--pq-accent)]">
                        {l(`${overviewSections.length} 个部分`, `${overviewSections.length} sections`)}
                      </span>
                    ) : null}
                  </div>
                  {activeOverviewSection ? (
                    <div className="mt-3 space-y-3">
                      <div className="flex flex-wrap gap-2">
                        {overviewSections.map((section) => {
                          const label = overviewSectionLabel(section.key, section.title, l);

                          return (
                            <button
                              key={section.key}
                              type="button"
                              onClick={() => setActiveOverviewKey(section.key)}
                              className={
                                activeOverviewSection.key === section.key
                                  ? 'rounded-full border border-[var(--pq-accent-border)] bg-[var(--pq-accent-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--pq-accent)] transition'
                                  : 'rounded-full border border-[var(--pq-border)] bg-white/58 px-3 py-1.5 text-xs font-semibold text-[var(--pq-text-muted)] transition hover:border-[var(--pq-border-strong)] hover:bg-white hover:text-[var(--pq-text)]'
                              }
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>

                      <div className="rounded-xl border border-[var(--pq-border)] bg-white/54 px-4 py-4 dark:bg-white/5">
                        <div className="text-sm font-semibold text-slate-800 dark:text-[#e0e0e0]">
                          {overviewSectionLabel(
                            activeOverviewSection.key,
                            activeOverviewSection.title,
                            l,
                          )}
                        </div>
                        {[
                          'findings',
                          'takeaways',
                          'keywords',
                        ].includes(activeOverviewSection.key) ||
                        splitOverviewListItems(
                          activeOverviewSection.content,
                          activeOverviewSection.key,
                        ).length > 1 ? (
                          <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600 dark:text-[#cfcfcf]">
                            {splitOverviewListItems(
                              activeOverviewSection.content,
                              activeOverviewSection.key,
                            ).map((item) => (
                              <li key={item} className="flex gap-2">
                                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--pq-accent)]" />
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-[#cfcfcf]">
                            {activeOverviewSection.content}
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 rounded-xl border border-dashed border-[var(--pq-border)] bg-white/48 px-4 py-4 text-sm leading-6 text-[var(--pq-text-muted)]">
                      {l('生成概览后，结果会显示在这里。', 'After generating an overview, the result will appear here.')}
                    </div>
                  )}
                </section>

                {selectedPaper.userNote ? (
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400 dark:text-[#8d8d8d]">
                      {l('用户笔记', 'User Note')}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-[#a0a0a0]">
                      {selectedPaper.userNote}
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="pq-card border-dashed p-8 text-center text-sm text-[var(--pq-text-muted)]">
            {l('选择一篇文献查看详情。', 'Select a paper to view details.')}
          </div>
        )}
      </div>
    </aside>
  );
}

