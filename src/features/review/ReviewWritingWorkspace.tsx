import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpenCheck,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  FileJson2,
  Loader2,
  Play,
  Search,
  Wand2,
} from 'lucide-react';
import { useAppLocale, useLocaleText } from '../../i18n/uiLanguage';
import { listAllLibraryPapers } from '../../services/library';
import {
  loadLibraryPaperReviewContext,
  type LibraryPaperReviewContext,
} from '../../services/libraryAgent';
import { listAllNotes } from '../../services/notes';
import { readReaderConfigFile } from '../../services/readerConfig';
import { isAccountModelPreset, loadDesktopAccountModelPreset } from '../../services/desktopAccountModel';
import {
  exportReviewDocx,
  generateReviewBlueprint,
  generateReviewJsonDraftFromBlueprint,
  listenReviewGenerationProgress,
  openReviewOutput,
  selectReviewDocxOutputPath,
  type ReviewBlueprint,
  type ReviewContextItem,
  type ReviewFigureCandidate,
  type ReviewGeneratedPart,
  type ReviewGeneratedPartsCheckpoint,
  type ReviewGenerationProgress,
  type ReviewDocxExportResult,
  type ReviewJsonDraft,
} from '../../services/reviewWriting';
import type { LiteraturePaper } from '../../types/library';
import type { Note } from '../../types/notes';
import type {
  ModelReasoningEffort,
  QaModelPreset,
  ReaderConfigFile,
  ReaderSecrets,
  ReaderSettings,
} from '../../types/reader';
import { cn } from '../../utils/cn';
import {
  DEFAULT_SETTINGS,
  getModelRuntimeConfig,
  normalizeQaModelPresets,
  normalizeReaderSettings,
  resolveModelPreset,
  SECRETS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
} from '../reader/readerShared';
import {
  paperAuthorsText,
  retrieveNotes,
  retrievePapers,
  type ScoredNote,
  type ScoredPaper,
} from './reviewRetrieval';
import {
  loadReviewEmbeddingConfig,
  semanticRerankPapers,
  type ReviewEmbeddingConfig,
} from './reviewSemantic';
import { ReviewBlueprintEditor } from './ReviewBlueprintEditor';
import { ReviewExportCard } from './ReviewExportCard';
import { ReviewIntentPanel } from './ReviewIntentPanel';

type ReviewStageId = 'intent' | 'retrieve' | 'json' | 'validate' | 'export';
type ReviewStageStatus = 'waiting' | 'ready' | 'running' | 'done' | 'error';
type ReviewSourceMode = 'all' | 'papers' | 'notes';
type LocaleText = (zh: string, en: string) => string;

const MAX_CONTEXT_TEXT_LENGTH = 2400;
const MAX_DETAILED_PAPER_CONTEXTS = 8;
const MIN_REVIEW_WRITING_CONCURRENCY = 1;
const MAX_REVIEW_WRITING_CONCURRENCY = 8;
const REVIEW_DRAFT_STORAGE_KEY = 'paperquay-review-writing-draft-v1';

const reviewTypes = [
  { id: 'systematic', zh: '系统综述', en: 'Systematic Review' },
  { id: 'narrative', zh: '叙述综述', en: 'Narrative Review' },
  { id: 'comparative', zh: '对比综述', en: 'Comparative Review' },
  { id: 'proposal', zh: '开题/课题综述', en: 'Proposal Review' },
];

const sourceModes: Array<{ id: ReviewSourceMode; zh: string; en: string }> = [
  { id: 'all', zh: '文献 + 笔记', en: 'Papers + Notes' },
  { id: 'papers', zh: '仅文献', en: 'Papers only' },
  { id: 'notes', zh: '仅笔记', en: 'Notes only' },
];

const defaultIntentZh = '围绕一个研究主题生成论文综述，要求先分析用户意图，再检索相关论文、笔记和已有摘要，生成写作蓝图并分段写作，最后合并为可套 Word 模板的数据。';
const defaultIntentEn = 'Generate a literature review for a research topic. Analyze user intent first, retrieve related papers, notes, and summaries, create a writing blueprint, draft by section, then merge data for a Word template.';

interface ReviewModelPreset extends QaModelPreset {
  temperature?: number;
  reasoningEffort?: ModelReasoningEffort;
}

function readStorageJson<T>(key: string): Partial<T> {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : {};
  } catch {
    return {};
  }
}

async function loadReviewModelConfig(): Promise<{
  presets: QaModelPreset[];
}> {
  let persisted: Partial<ReaderConfigFile> | null = null;

  try {
    persisted = await readReaderConfigFile();
  } catch {
    persisted = null;
  }

  const storedSettings = readStorageJson<ReaderSettings>(SETTINGS_STORAGE_KEY);
  const storedSecrets = readStorageJson<ReaderSecrets>(SECRETS_STORAGE_KEY);
  const settings = normalizeReaderSettings({
    ...DEFAULT_SETTINGS,
    ...(persisted?.settings ?? {}),
    ...storedSettings,
  });
  const secrets = {
    ...(persisted?.secrets ?? {}),
    ...storedSecrets,
  };
  const presets = normalizeQaModelPresets(secrets.qaModelPresets);

  return {
    presets,
  };
}

async function loadReviewModelPreset(): Promise<ReviewModelPreset | null> {
  let persisted: Partial<ReaderConfigFile> | null = null;

  try {
    persisted = await readReaderConfigFile();
  } catch {
    persisted = null;
  }

  const storedSettings = readStorageJson<ReaderSettings>(SETTINGS_STORAGE_KEY);
  const storedSecrets = readStorageJson<ReaderSecrets>(SECRETS_STORAGE_KEY);
  const settings = normalizeReaderSettings({
    ...DEFAULT_SETTINGS,
    ...(persisted?.settings ?? {}),
    ...storedSettings,
  });
  const secrets = {
    ...(persisted?.secrets ?? {}),
    ...storedSecrets,
  };
  const presets = normalizeQaModelPresets(secrets.qaModelPresets);
  const dedicated = presets.find(preset => preset.id === settings.reviewModelPresetId
    && preset.id !== settings.qaActivePresetId && preset.baseUrl.trim() && preset.apiKey.trim() && preset.model.trim());
  const preset = dedicated ?? await loadDesktopAccountModelPreset() ??
    resolveModelPreset(presets, settings.reviewModelPresetId) ??
    resolveModelPreset(presets, settings.summaryModelPresetId) ??
    resolveModelPreset(presets, settings.agentModelPresetId) ??
    resolveModelPreset(presets, settings.qaActivePresetId);

  if (!preset) {
    return null;
  }

  const runtimeConfig = getModelRuntimeConfig(settings, 'review');

  return {
    ...preset,
    temperature: runtimeConfig.temperature,
    reasoningEffort: runtimeConfig.reasoningEffort,
  };
}

function trimContextText(value: string) {
  const text = value.replace(/\n{3,}/g, '\n\n').trim();
  return text.length > MAX_CONTEXT_TEXT_LENGTH ? `${text.slice(0, MAX_CONTEXT_TEXT_LENGTH)}...` : text;
}

function clampReviewWritingConcurrency(value: number) {
  if (!Number.isFinite(value)) {
    return 3;
  }

  return Math.max(MIN_REVIEW_WRITING_CONCURRENCY, Math.min(MAX_REVIEW_WRITING_CONCURRENCY, Math.trunc(value)));
}

function reviewBlueprintTaskCount(blueprint: ReviewBlueprint | null) {
  if (!blueprint) {
    return 0;
  }

  return (
    3 +
    blueprint.sections.reduce((count, section) => count + Math.max(1, section.paragraphTasks.length), 0) +
    blueprint.comparisonTable.length +
    blueprint.researchGaps.length +
    blueprint.futureDirections.length
  );
}

function emptyReviewCheckpoint(blueprint: ReviewBlueprint): ReviewGeneratedPartsCheckpoint {
  return {
    abstract: null,
    introduction: null,
    sectionParagraphs: blueprint.sections.map((section) => (
      new Array(Math.max(1, section.paragraphTasks.length)).fill(null)
    )),
    comparisonTable: new Array(blueprint.comparisonTable.length).fill(null),
    researchGaps: new Array(blueprint.researchGaps.length).fill(null),
    futureDirections: new Array(blueprint.futureDirections.length).fill(null),
    conclusion: null,
  };
}

function normalizeReviewGeneratedPart(value: unknown): ReviewGeneratedPart | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Partial<ReviewGeneratedPart>;
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';

  if (!content) {
    return null;
  }

  return {
    content,
    citations: Array.isArray(raw.citations)
      ? raw.citations.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [],
  };
}

function normalizeReviewCheckpoint(
  value: unknown,
  blueprint: ReviewBlueprint | null,
): ReviewGeneratedPartsCheckpoint | null {
  if (!blueprint || !value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as ReviewGeneratedPartsCheckpoint;
  const checkpoint = emptyReviewCheckpoint(blueprint);
  checkpoint.abstract = normalizeReviewGeneratedPart(raw.abstract);
  checkpoint.introduction = normalizeReviewGeneratedPart(raw.introduction);
  checkpoint.conclusion = normalizeReviewGeneratedPart(raw.conclusion);

  if (Array.isArray(raw.sectionParagraphs)) {
    checkpoint.sectionParagraphs = checkpoint.sectionParagraphs?.map((section, sectionIndex) => {
      const rawSection = Array.isArray(raw.sectionParagraphs?.[sectionIndex])
        ? raw.sectionParagraphs[sectionIndex]
        : [];
      return section.map((_, paragraphIndex) => normalizeReviewGeneratedPart(rawSection[paragraphIndex]));
    });
  }

  for (const key of ['comparisonTable', 'researchGaps', 'futureDirections'] as const) {
    const target = checkpoint[key] ?? [];
    const source = Array.isArray(raw[key]) ? raw[key] : [];
    checkpoint[key] = target.map((_, index) => normalizeReviewGeneratedPart(source[index]));
  }

  return checkpoint;
}

function countCompletedReviewCheckpointParts(checkpoint: ReviewGeneratedPartsCheckpoint | null) {
  if (!checkpoint) {
    return 0;
  }

  let count = 0;
  if (checkpoint.abstract) count += 1;
  if (checkpoint.introduction) count += 1;
  if (checkpoint.conclusion) count += 1;
  for (const section of checkpoint.sectionParagraphs ?? []) {
    for (const paragraph of section) {
      if (paragraph) count += 1;
    }
  }
  for (const key of ['comparisonTable', 'researchGaps', 'futureDirections'] as const) {
    for (const part of checkpoint[key] ?? []) {
      if (part) count += 1;
    }
  }
  return count;
}

function updateReviewCheckpointPart(
  checkpoint: ReviewGeneratedPartsCheckpoint,
  progress: ReviewGenerationProgress,
): ReviewGeneratedPartsCheckpoint {
  const part = normalizeReviewGeneratedPart(progress.generatedPart);

  if (!part || !progress.taskKey) {
    return checkpoint;
  }

  const next: ReviewGeneratedPartsCheckpoint = {
    ...checkpoint,
    sectionParagraphs: checkpoint.sectionParagraphs?.map((section) => [...section]),
    comparisonTable: [...(checkpoint.comparisonTable ?? [])],
    researchGaps: [...(checkpoint.researchGaps ?? [])],
    futureDirections: [...(checkpoint.futureDirections ?? [])],
  };

  if (progress.taskKey === 'abstract') {
    next.abstract = part;
    return next;
  }
  if (progress.taskKey === 'introduction') {
    next.introduction = part;
    return next;
  }
  if (progress.taskKey === 'conclusion') {
    next.conclusion = part;
    return next;
  }

  const sectionMatch = progress.taskKey.match(/^section:(\d+):paragraph:(\d+)$/);
  if (sectionMatch) {
    const sectionIndex = Number(sectionMatch[1]);
    const paragraphIndex = Number(sectionMatch[2]);
    if (next.sectionParagraphs?.[sectionIndex]?.[paragraphIndex] !== undefined) {
      next.sectionParagraphs[sectionIndex][paragraphIndex] = part;
    }
    return next;
  }

  const indexedMatch = progress.taskKey.match(/^(comparison|researchGap|futureDirection):(\d+)$/);
  if (indexedMatch) {
    const key = indexedMatch[1];
    const index = Number(indexedMatch[2]);
    if (key === 'comparison' && next.comparisonTable?.[index] !== undefined) {
      next.comparisonTable[index] = part;
    }
    if (key === 'researchGap' && next.researchGaps?.[index] !== undefined) {
      next.researchGaps[index] = part;
    }
    if (key === 'futureDirection' && next.futureDirections?.[index] !== undefined) {
      next.futureDirections[index] = part;
    }
  }

  return next;
}

function buildPaperContextItem(
  paper: LiteraturePaper,
  index: number,
  score: number,
  detailedContext?: LibraryPaperReviewContext | null,
): ReviewContextItem {
  const id = `P${index + 1}`;
  const detailedText = detailedContext?.text?.trim();
  const figures: ReviewFigureCandidate[] = (detailedContext?.figures ?? [])
    .filter((figure) => figure.path?.trim())
    .map((figure, figureIndex) => ({
      ...figure,
      id: `${id}-F${figureIndex + 1}`,
      sourceId: id,
      sourceTitle: paper.title,
      title: figure.title || figure.caption || `${paper.title} figure ${figureIndex + 1}`,
    }));

  return {
    id,
    sourceType: detailedText ? 'paper' : paper.aiSummary?.trim() ? 'summary' : 'paper',
    title: paper.title,
    authors: paperAuthorsText(paper),
    year: paper.year ?? '',
    journal: paper.publication ?? '',
    doi: paper.doi ?? '',
    paperId: paper.id,
    score,
    figures,
    text: trimContextText([
      `Title: ${paper.title}`,
      paperAuthorsText(paper) ? `Authors: ${paperAuthorsText(paper)}` : '',
      paper.year ? `Year: ${paper.year}` : '',
      paper.publication ? `Venue: ${paper.publication}` : '',
      paper.doi ? `DOI: ${paper.doi}` : '',
      detailedText
        ? `Retrieved PaperQuay context (${detailedContext?.source || 'paper-context'}):\n${detailedText}`
        : '',
      paper.abstractText ? `Abstract:\n${paper.abstractText}` : '',
      paper.aiSummary ? `Existing PaperQuay overview:\n${paper.aiSummary}` : '',
      paper.userNote ? `User note:\n${paper.userNote}` : '',
      paper.keywords.length ? `Keywords: ${paper.keywords.join(', ')}` : '',
      figures.length
        ? `Available visual evidence:\n${figures.map((figure) => `- ${figure.id} (${figure.kind}${typeof figure.pageIndex === 'number' ? `, page ${figure.pageIndex + 1}` : ''}): ${figure.caption || figure.title || 'Untitled figure'}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n\n')),
  };
}

function buildNoteContextItem(note: Note, index: number, score: number): ReviewContextItem {
  const id = `N${index + 1}`;

  return {
    id,
    sourceType: 'note',
    title: note.title,
    noteId: note.id,
    paperId: note.linkedPaperId ?? note.paperId,
    score,
    text: trimContextText([
      `Note title: ${note.title}`,
      note.tags.length ? `Tags: ${note.tags.join(', ')}` : '',
      note.contentText || note.content || note.excerpt || '',
      note.anchors.length
        ? `Anchors:\n${note.anchors.map((anchor) => `- ${anchor.label}: ${anchor.excerpt}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n\n')),
  };
}

function validateReviewJsonDraft(draft: ReviewJsonDraft | null) {
  if (!draft) {
    return ['JSON 尚未生成。'];
  }

  const errors: string[] = [];
  if (!draft.title?.trim()) errors.push('缺少 title。');
  if (!draft.thesis?.trim()) errors.push('缺少 thesis。');
  if (!Array.isArray(draft.sections) || draft.sections.length === 0) errors.push('sections 至少需要 1 个章节。');
  if (!Array.isArray(draft.references)) errors.push('references 必须是数组。');
  if (!Array.isArray(draft.sources)) errors.push('sources 必须是数组。');

  const sourceIds = new Set(draft.sources.map((source) => source.id).filter(Boolean));
  for (const section of draft.sections ?? []) {
    for (const citation of section.citations ?? []) {
      if (sourceIds.size > 0 && !sourceIds.has(citation)) {
        errors.push(`章节“${section.heading}”引用了不存在的来源 ID：${citation}`);
      }
    }
  }

  return errors;
}

function normalizeReviewSourceMode(value: unknown): ReviewSourceMode {
  return value === 'papers' || value === 'notes' || value === 'all' ? value : 'all';
}

function loadReviewDraft(locale: 'zh-CN' | 'en-US') {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REVIEW_DRAFT_STORAGE_KEY) || '{}') as {
      query?: string;
      intent?: string;
      reviewType?: string;
      sourceMode?: string;
      targetAudience?: string;
      writingConcurrency?: number;
      contextItems?: ReviewContextItem[];
      hasRetrieved?: boolean;
      reviewBlueprint?: ReviewBlueprint;
      jsonDraft?: ReviewJsonDraft;
      outputPath?: string;
      checkpoint?: ReviewGeneratedPartsCheckpoint;
    };
    const reviewBlueprint = parsed.reviewBlueprint && typeof parsed.reviewBlueprint === 'object'
      ? parsed.reviewBlueprint
      : null;

    return {
      query: parsed.query?.trim() || '',
      intent: parsed.intent?.trim() || (locale === 'en-US' ? defaultIntentEn : defaultIntentZh),
      reviewType: parsed.reviewType?.trim() || 'systematic',
      sourceMode: normalizeReviewSourceMode(parsed.sourceMode),
      writingConcurrency: clampReviewWritingConcurrency(Number(parsed.writingConcurrency)),
      contextItems: Array.isArray(parsed.contextItems) ? parsed.contextItems : [],
      hasRetrieved: Boolean(parsed.hasRetrieved),
      reviewBlueprint,
      jsonDraft: parsed.jsonDraft && typeof parsed.jsonDraft === 'object' ? parsed.jsonDraft : null,
      outputPath: parsed.outputPath?.trim() || '',
      checkpoint: normalizeReviewCheckpoint(parsed.checkpoint, reviewBlueprint),
      targetAudience: parsed.targetAudience?.trim() || (locale === 'en-US' ? 'Graduate students and researchers' : '研究生和科研工作者'),
    };
  } catch {
    return {
      query: '',
      intent: locale === 'en-US' ? defaultIntentEn : defaultIntentZh,
      reviewType: 'systematic',
      sourceMode: 'all' as ReviewSourceMode,
      writingConcurrency: 3,
      contextItems: [],
      hasRetrieved: false,
      reviewBlueprint: null,
      jsonDraft: null,
      outputPath: '',
      checkpoint: null,
      targetAudience: locale === 'en-US' ? 'Graduate students and researchers' : '研究生和科研工作者',
    };
  }
}

function StagePill({
  active,
  index,
  isLast,
  label,
  status,
}: {
  active: boolean;
  index: number;
  isLast?: boolean;
  label: string;
  status: ReviewStageStatus;
}) {
  const done = status === 'done';
  const running = status === 'running';
  const failed = status === 'error';

  return (
    <div
      className={cn(
        'relative flex min-w-0 items-center gap-2 rounded-[var(--pq-radius-sm)] border px-3 py-2 text-xs transition',
        failed
          ? 'border-[var(--pq-error)] bg-[var(--pq-error-bg)] text-[var(--pq-error)]'
          : active
          ? 'border-[var(--pq-accent-border-strong)] bg-[var(--pq-accent-bg)] text-[var(--pq-text)]'
          : 'border-[var(--pq-border)] bg-[var(--pq-surface-1)] text-[var(--pq-text-muted)] hover:border-[var(--pq-border-strong)] hover:text-[var(--pq-text)]',
      )}
    >
      {active && !failed ? (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--pq-accent)]" />
      ) : null}
      {!isLast ? (
        <span
          className={cn(
            'pointer-events-none absolute left-[21px] top-[calc(100%-1px)] h-3 w-px',
            done && !failed ? 'bg-[var(--pq-success)]' : 'bg-[var(--pq-border-strong)]',
          )}
        />
      ) : null}
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
          failed
            ? 'bg-[var(--pq-error-bg)] text-[var(--pq-error)]'
            : done
            ? 'bg-[var(--pq-success)] text-white'
            : running
              ? 'bg-[var(--pq-accent-bg)] text-[var(--pq-accent)]'
              : 'bg-[var(--pq-bg-secondary)] text-[var(--pq-text-muted)]',
        )}
      >
        {failed ? <CircleAlert className="h-3.5 w-3.5" strokeWidth={2} /> : done ? <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} /> : running ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : index}
      </span>
      <span className="truncate font-medium">{label}</span>
    </div>
  );
}

function createReviewRequestId() {
  return `review_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function reviewProgressPercent(progress: ReviewGenerationProgress) {
  const total = Math.max(1, progress.total || 1);
  const current = progress.phase === 'done' ? total : Math.max(0, Math.min(total, progress.current || 0));
  return Math.round((current / total) * 100);
}

function describeReviewProgress(progress: ReviewGenerationProgress, l: LocaleText) {
  if (progress.status === 'error') {
    return l('生成中断', 'Generation interrupted');
  }

  switch (progress.taskKind) {
    case 'blueprint':
      return l('蓝图层：分析意图并规划章节/段落任务', 'Blueprint layer: planning sections and paragraph tasks');
    case 'abstract':
      return l('内容层：生成摘要', 'Writing layer: drafting abstract');
    case 'introduction':
      return l('内容层：生成引言', 'Writing layer: drafting introduction');
    case 'section_paragraph':
      return l(
        `内容层：第 ${progress.sectionIndex ?? '-'} / ${progress.sectionTotal ?? '-'} 节，第 ${progress.paragraphIndex ?? '-'} / ${progress.paragraphTotal ?? '-'} 段`,
        `Writing layer: section ${progress.sectionIndex ?? '-'} / ${progress.sectionTotal ?? '-'}, paragraph ${progress.paragraphIndex ?? '-'} / ${progress.paragraphTotal ?? '-'}`,
      );
    case 'comparison':
      return l(
        `内容层：生成比较分析 ${progress.itemIndex ?? '-'} / ${progress.itemTotal ?? '-'}`,
        `Writing layer: comparison ${progress.itemIndex ?? '-'} / ${progress.itemTotal ?? '-'}`,
      );
    case 'research_gap':
      return l(
        `内容层：生成研究不足 ${progress.itemIndex ?? '-'} / ${progress.itemTotal ?? '-'}`,
        `Writing layer: research gap ${progress.itemIndex ?? '-'} / ${progress.itemTotal ?? '-'}`,
      );
    case 'future_direction':
      return l(
        `内容层：生成未来方向 ${progress.itemIndex ?? '-'} / ${progress.itemTotal ?? '-'}`,
        `Writing layer: future direction ${progress.itemIndex ?? '-'} / ${progress.itemTotal ?? '-'}`,
      );
    case 'conclusion':
      return l('内容层：生成结论', 'Writing layer: drafting conclusion');
    case 'merge':
      return l('系统层：合并段落、引用和导出数据', 'System layer: merging paragraphs, citations, and export data');
    case 'done':
      return l('已完成：导出数据已合并', 'Done: export data merged');
    default:
      return l('正在生成综述', 'Generating review');
  }
}

function describeReviewProgressDetail(progress: ReviewGenerationProgress, l: LocaleText) {
  const heading = progress.heading?.trim();

  if (progress.error) {
    return progress.error;
  }

  if (progress.taskKind === 'section_paragraph' && heading) {
    return l(`当前章节：${heading}`, `Current section: ${heading}`);
  }

  if (heading) {
    return l(`当前任务：${heading}`, `Current task: ${heading}`);
  }

  if (progress.phase === 'blueprint') {
    return l('第一层只生成结构和任务说明，不直接写完整正文。', 'The first layer creates structure and task instructions, not the full prose.');
  }

  if (progress.phase === 'merge') {
    return l('正在把分段结果合并成 Word 模板可用的数据。', 'Combining drafted parts into Word-template data.');
  }

  return l('正在调用大模型生成当前部分。', 'Calling the model for the current part.');
}

function ReviewGenerationProgressPanel({
  progress,
  l,
}: {
  progress: ReviewGenerationProgress | null;
  l: LocaleText;
}) {
  if (!progress) {
    return null;
  }

  const percent = reviewProgressPercent(progress);
  const total = Math.max(1, progress.total || 1);
  const current = progress.phase === 'done' ? total : Math.max(0, Math.min(total, progress.current || 0));

  return (
    <div className={cn(
      'rounded-[var(--pq-radius-sm)] border px-3 py-3 text-xs',
      progress.status === 'error'
        ? 'border-[var(--pq-error)] bg-[var(--pq-error-bg)] text-[var(--pq-error)]'
        : 'border-[var(--pq-border)] bg-[var(--pq-surface)] text-[var(--pq-text)]',
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-semibold">
            {progress.status === 'error' ? (
              <CircleAlert className="h-4 w-4 shrink-0" strokeWidth={1.9} />
            ) : progress.phase === 'done' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--pq-success)]" strokeWidth={1.9} />
            ) : (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--pq-accent)]" strokeWidth={1.9} />
            )}
            <span className="truncate">{describeReviewProgress(progress, l)}</span>
          </div>
          <div className={cn(
            'mt-1 line-clamp-2 leading-5',
            progress.status === 'error' ? 'text-[var(--pq-error)]' : 'text-[var(--pq-text-muted)]',
          )}>
            {describeReviewProgressDetail(progress, l)}
          </div>
        </div>
        <div className="shrink-0 rounded-md bg-[var(--pq-bg-secondary)] px-2 py-1 text-[11px] font-semibold text-[var(--pq-text-muted)]">
          {current}/{total}
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--pq-bg-secondary)]">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            progress.status === 'error'
              ? 'bg-[var(--pq-error)]'
              : progress.phase === 'done'
                ? 'bg-[var(--pq-success)]'
                : 'bg-[var(--pq-accent)]',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function JsonPreview({ draft }: { draft: ReviewJsonDraft | null }) {
  const content = draft
    ? JSON.stringify(draft, null, 2)
    : '{\n  "title": "",\n  "sections": [],\n  "references": []\n}';

  return (
    <pre className="h-full min-h-[260px] overflow-auto rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-bg-secondary)] p-4 text-xs leading-5 text-[var(--pq-text-muted)]">
      {content}
    </pre>
  );
}

export default function ReviewWritingWorkspace() {
  const locale = useAppLocale();
  const l = useLocaleText();
  const loadedDraft = useMemo(() => loadReviewDraft(locale), [locale]);
  const [query, setQuery] = useState(loadedDraft.query);
  const [intent, setIntent] = useState(loadedDraft.intent);
  const [reviewType, setReviewType] = useState(loadedDraft.reviewType);
  const [sourceMode, setSourceMode] = useState<ReviewSourceMode>(loadedDraft.sourceMode);
  const [targetAudience, setTargetAudience] = useState(loadedDraft.targetAudience);
  const [papers, setPapers] = useState<LiteraturePaper[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [presets, setPresets] = useState<QaModelPreset[]>([]);
  const [contextItems, setContextItems] = useState<ReviewContextItem[]>(loadedDraft.contextItems);
  const [semanticRerank, setSemanticRerank] = useState(false);
  const [embeddingConfig, setEmbeddingConfig] = useState<ReviewEmbeddingConfig | null>(null);
  const [writingConcurrency, setWritingConcurrency] = useState(loadedDraft.writingConcurrency);
  const [reviewBlueprint, setReviewBlueprint] = useState<ReviewBlueprint | null>(loadedDraft.reviewBlueprint);
  const [hasRetrieved, setHasRetrieved] = useState(loadedDraft.hasRetrieved);
  const [jsonDraft, setJsonDraft] = useState<ReviewJsonDraft | null>(loadedDraft.jsonDraft);
  const [reviewCheckpoint, setReviewCheckpoint] = useState<ReviewGeneratedPartsCheckpoint | null>(loadedDraft.checkpoint);
  const [outputPath, setOutputPath] = useState(loadedDraft.outputPath);
  const [exportedPath, setExportedPath] = useState('');
  const [skippedExportFigures, setSkippedExportFigures] = useState<NonNullable<ReviewDocxExportResult['skippedFigures']>>([]);
  const [exportValidation, setExportValidation] = useState<ReviewDocxExportResult['validation'] | null>(null);
  const [activeStage, setActiveStage] = useState<ReviewStageId>('intent');
  const [runningStage, setRunningStage] = useState<ReviewStageId | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const [generationProgress, setGenerationProgress] = useState<ReviewGenerationProgress | null>(null);
  const activeGenerationRequestIdRef = useRef('');

  const isEnglish = locale === 'en-US';
  const semanticAvailable = embeddingConfig !== null;
  const validationErrors = useMemo(() => validateReviewJsonDraft(jsonDraft), [jsonDraft]);
  const canGenerateBlueprint = intent.trim().length > 0 && contextItems.length > 0 && presets.length > 0;
  const canGenerateDraft = Boolean(reviewBlueprint && contextItems.length > 0 && presets.length > 0);
  const canExport = Boolean(jsonDraft && validationErrors.length === 0 && outputPath);
  const completedCheckpointTasks = countCompletedReviewCheckpointParts(reviewCheckpoint);
  const hasResumeCheckpoint = Boolean(reviewBlueprint && !jsonDraft && completedCheckpointTasks > 0);
  const draftButtonLabel = hasResumeCheckpoint ? 'Continue' : 'Draft';

  const stages: Array<{ id: ReviewStageId; label: string; status: ReviewStageStatus }> = [
    {
      id: 'intent',
      label: l('用户意图', 'Intent'),
      status: intent.trim() ? 'done' : 'waiting',
    },
    {
      id: 'retrieve',
      label: l('RAG 检索', 'RAG Retrieval'),
      status: runningStage === 'retrieve' ? 'running' : contextItems.length > 0 ? 'done' : hasRetrieved ? 'error' : 'ready',
    },
    {
      id: 'json',
      label: l('分段写作', 'Layered Writing'),
      status: generationProgress?.status === 'error' ? 'error' : runningStage === 'json' ? 'running' : jsonDraft ? 'done' : reviewBlueprint ? 'ready' : contextItems.length > 0 ? 'ready' : 'waiting',
    },
    {
      id: 'validate',
      label: l('JSON 校验', 'Validation'),
      status: jsonDraft && validationErrors.length === 0 ? 'done' : jsonDraft ? 'error' : 'waiting',
    },
    {
      id: 'export',
      label: l('Word 导出', 'Word Export'),
      status: runningStage === 'export' ? 'running' : exportedPath ? 'done' : jsonDraft ? 'ready' : 'waiting',
    },
  ];

  useEffect(() => {
    setExportedPath('');
    setSkippedExportFigures([]);
    setExportValidation(null);
  }, [jsonDraft]);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        const [nextPapers, nextNotes, modelConfig] = await Promise.all([
          listAllLibraryPapers({ sortBy: 'updatedAt', sortDirection: 'desc' }),
          listAllNotes(),
          loadReviewModelConfig(),
        ]);

        if (cancelled) return;
        setPapers(nextPapers);
        setNotes(nextNotes);
        setPresets(modelConfig.presets);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    }

    void loadData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(REVIEW_DRAFT_STORAGE_KEY, JSON.stringify({
      query,
      intent,
      reviewType,
      sourceMode,
      targetAudience,
      writingConcurrency,
      contextItems,
      hasRetrieved,
      reviewBlueprint,
      jsonDraft,
      outputPath,
      checkpoint: reviewCheckpoint,
    }));
  }, [
    query,
    intent,
    reviewType,
    sourceMode,
    targetAudience,
    writingConcurrency,
    contextItems,
    hasRetrieved,
    reviewBlueprint,
    jsonDraft,
    outputPath,
    reviewCheckpoint,
  ]);

  useEffect(() => {
    let cancelled = false;

    void loadReviewEmbeddingConfig()
      .then((config) => {
        if (cancelled) return;
        setEmbeddingConfig(config);
        if (!config) {
          setSemanticRerank(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEmbeddingConfig(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void listenReviewGenerationProgress((progress) => {
      if (cancelled || progress.requestId !== activeGenerationRequestIdRef.current) {
        return;
      }

      setGenerationProgress(progress);
      if (progress.status === 'done' && progress.generatedPart) {
        setReviewCheckpoint((current) => {
          const base = normalizeReviewCheckpoint(current, reviewBlueprint)
            ?? (reviewBlueprint ? emptyReviewCheckpoint(reviewBlueprint) : null);
          return base ? updateReviewCheckpointPart(base, progress) : current;
        });
      }
      setStatusMessage(describeReviewProgress(progress, l));
    }).then((nextUnsubscribe) => {
      if (cancelled) {
        nextUnsubscribe();
        return;
      }

      unsubscribe = nextUnsubscribe;
    }).catch((listenError) => {
      if (!cancelled) {
        setError(listenError instanceof Error ? listenError.message : String(listenError));
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [l, reviewBlueprint]);

  const retrieveContext = async () => {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setError('');
      setStatusMessage(l('请输入检索关键词。', 'Enter a search keyword first.'));
      return;
    }

    setRunningStage('retrieve');
    setActiveStage('retrieve');
    setError('');
    setGenerationProgress(null);
    activeGenerationRequestIdRef.current = '';
    setReviewBlueprint(null);
    setJsonDraft(null);
    setReviewCheckpoint(null);
    setExportedPath('');
    setSkippedExportFigures([]);
    setStatusMessage(l(`正在检索“${trimmedQuery}”相关内容...`, `Searching for "${trimmedQuery}"...`));

    try {
      const includePapers = sourceMode !== 'notes';
      const includeNotes = sourceMode !== 'papers';
      const soloPapers = sourceMode === 'papers';
      const soloNotes = sourceMode === 'notes';

      let paperCandidates: ScoredPaper[] = includePapers
        ? retrievePapers(trimmedQuery, papers, { soloSource: soloPapers })
        : [];

      // Optional semantic rerank over keyword candidates (configured + enabled).
      let semanticReranked = false;
      if (semanticRerank && embeddingConfig && paperCandidates.length > 1) {
        try {
          paperCandidates = await semanticRerankPapers(trimmedQuery, paperCandidates, embeddingConfig);
          semanticReranked = true;
        } catch (rerankError) {
          console.warn('Semantic rerank failed, falling back to keyword order', rerankError);
        }
      }

      const noteCandidates: ScoredNote[] = includeNotes
        ? retrieveNotes(trimmedQuery, notes, {
            soloSource: soloNotes,
            reservedCount: paperCandidates.length,
          })
        : [];

      const detailedPaperContexts = await Promise.all(
        paperCandidates.slice(0, MAX_DETAILED_PAPER_CONTEXTS).map(async ({ paper }) => {
          try {
            const context = await loadLibraryPaperReviewContext({
              paper,
              intent: `${trimmedQuery}\n${intent}\n${reviewType}\n${targetAudience}`,
              ragEnabled: true,
            });

            return [paper.id, context] as const;
          } catch {
            return [paper.id, null] as const;
          }
        }),
      );
      const detailedContextByPaperId = new Map(detailedPaperContexts);
      const nextContextItems = [
        ...paperCandidates.map((item, index) =>
          buildPaperContextItem(
            item.paper,
            index,
            item.score,
            detailedContextByPaperId.get(item.paper.id),
          ),
        ),
        ...noteCandidates.map((item, index) => buildNoteContextItem(item.note, index, item.score)),
      ];

      setContextItems(nextContextItems);
      setHasRetrieved(true);
      setStatusMessage(
        nextContextItems.length > 0
          ? semanticReranked
            ? l(`已按语义重排检索到 ${nextContextItems.length} 个来源。`, `Retrieved ${nextContextItems.length} source(s), semantically reranked.`)
            : l(`已检索到 ${nextContextItems.length} 个来源。`, `Retrieved ${nextContextItems.length} source(s).`)
          : l('未找到相关文献，请换个关键词或先补充文库/笔记。', 'No matching sources. Try a different keyword or add papers/notes first.'),
      );
    } catch (retrieveError) {
      setError(retrieveError instanceof Error ? retrieveError.message : String(retrieveError));
    } finally {
      setRunningStage(null);
    }
  };

  const buildReviewModelOptions = async () => {
    const preset = await loadReviewModelPreset();

    if (!preset?.baseUrl.trim() || (!isAccountModelPreset(preset) && !preset.apiKey.trim()) || !preset.model.trim()) {
      throw new Error(l('请先在设置中配置可用的大模型预设。', 'Configure a usable model preset in Settings first.'));
    }

    return {
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: preset.model,
      apiMode: preset.apiMode,
      temperature: preset.temperature,
      reasoningEffort: preset.reasoningEffort,
      intent,
      reviewType: reviewTypes.find((item) => item.id === reviewType)?.[isEnglish ? 'en' : 'zh'] ?? reviewType,
      sourceScope: sourceModes.find((item) => item.id === sourceMode)?.[isEnglish ? 'en' : 'zh'] ?? sourceMode,
      targetAudience,
      outputLanguage: isEnglish ? 'English' : 'Chinese',
      contextItems,
      writingConcurrency: clampReviewWritingConcurrency(writingConcurrency),
    };
  };

  const generateBlueprintOnly = async () => {
    const requestId = createReviewRequestId();
    activeGenerationRequestIdRef.current = requestId;
    setRunningStage('json');
    setActiveStage('json');
    setError('');
    setGenerationProgress({
      requestId,
      phase: 'blueprint',
      taskKind: 'blueprint',
      status: 'running',
      current: 0,
      total: 1,
    });
    setStatusMessage(l(
      '正在生成可编辑写作大纲...',
      'Generating an editable writing outline...',
    ));

    try {
      const blueprint = await generateReviewBlueprint({
        ...(await buildReviewModelOptions()),
        requestId,
      });

      setReviewBlueprint(blueprint);
      setJsonDraft(null);
      setReviewCheckpoint(emptyReviewCheckpoint(blueprint));
      setActiveStage('json');
      setGenerationProgress((current) => current
        ? { ...current, phase: 'blueprint', taskKind: 'blueprint', status: 'done', current: current.current || 1, total: current.total }
        : null);
      setStatusMessage(l(
        '写作大纲已生成。可拖动章节、调节段落数，然后开始并发写作。',
        'Outline generated. Reorder sections, tune paragraph counts, then start concurrent drafting.',
      ));
    } catch (blueprintError) {
      const message = blueprintError instanceof Error ? blueprintError.message : String(blueprintError);
      setError(message);
      setGenerationProgress((current) => ({
        requestId,
        phase: current?.phase ?? 'blueprint',
        taskKind: current?.taskKind ?? 'blueprint',
        status: 'error',
        current: current?.current ?? 0,
        total: current?.total ?? 1,
        heading: current?.heading,
        sectionIndex: current?.sectionIndex,
        sectionTotal: current?.sectionTotal,
        paragraphIndex: current?.paragraphIndex,
        paragraphTotal: current?.paragraphTotal,
        itemIndex: current?.itemIndex,
        itemTotal: current?.itemTotal,
        error: message,
      }));
      setStatusMessage(l('大纲生成中断，请检查错误信息。', 'Outline generation stopped. Check the error message.'));
    } finally {
      setRunningStage(null);
    }
  };

  const generateDraftFromBlueprint = async () => {
    if (!reviewBlueprint) {
      setStatusMessage(l('请先生成写作大纲。', 'Generate an outline first.'));
      return;
    }

    const requestId = createReviewRequestId();
    const normalizedCheckpoint = normalizeReviewCheckpoint(reviewCheckpoint, reviewBlueprint);
    const completedCheckpointTasks = countCompletedReviewCheckpointParts(normalizedCheckpoint);
    activeGenerationRequestIdRef.current = requestId;
    setRunningStage('json');
    setActiveStage('json');
    setError('');
    setGenerationProgress({
      requestId,
      phase: 'writing',
      taskKind: 'abstract',
      status: 'running',
      current: 1 + completedCheckpointTasks,
      total: reviewBlueprintTaskCount(reviewBlueprint) + 2,
    });
    setStatusMessage(l(
      `正在按大纲并发写作，并发数 ${clampReviewWritingConcurrency(writingConcurrency)}...`,
      `Drafting from the outline with concurrency ${clampReviewWritingConcurrency(writingConcurrency)}...`,
    ));

    try {
      const draft = await generateReviewJsonDraftFromBlueprint({
        ...(await buildReviewModelOptions()),
        requestId,
        blueprint: reviewBlueprint,
        resumeParts: normalizedCheckpoint ?? undefined,
      });

      setJsonDraft(draft);
      setActiveStage('validate');
      setGenerationProgress((current) => current
        ? { ...current, phase: 'done', taskKind: 'done', status: 'done', current: current.total, total: current.total }
        : null);
      setStatusMessage(l(
        '分段写作已完成，导出数据已合并，请检查校验结果。',
        'Layered writing completed and export data merged. Check validation results.',
      ));
    } catch (generateError) {
      const message = generateError instanceof Error ? generateError.message : String(generateError);
      setError(message);
      setGenerationProgress((current) => ({
        requestId,
        phase: current?.phase ?? 'writing',
        taskKind: current?.taskKind ?? 'abstract',
        status: 'error',
        current: current?.current ?? 0,
        total: current?.total ?? 1,
        heading: current?.heading,
        sectionIndex: current?.sectionIndex,
        sectionTotal: current?.sectionTotal,
        paragraphIndex: current?.paragraphIndex,
        paragraphTotal: current?.paragraphTotal,
        itemIndex: current?.itemIndex,
        itemTotal: current?.itemTotal,
        error: message,
      }));
      setStatusMessage(l('综述生成中断，请检查错误信息。', 'Review generation stopped. Check the error message.'));
    } finally {
      setRunningStage(null);
    }
  };

  const chooseOutput = async () => {
    setError('');
    const title = jsonDraft?.title?.trim() || 'PaperQuay-literature-review';
    const path = await selectReviewDocxOutputPath(`${title}.docx`);
    if (path) {
      setOutputPath(path);
    }
  };

  const exportDocx = async () => {
    if (!jsonDraft) return;

    setRunningStage('export');
    setActiveStage('export');
    setError('');
    setStatusMessage(l('正在使用内置 Word 模板生成文档...', 'Generating the document with the built-in Word template...'));

    try {
      const result = await exportReviewDocx('', outputPath, {
        ...jsonDraft,
        outputLanguage: isEnglish ? 'English' : 'Chinese',
      });
      setExportedPath(result.outputPath);
      setSkippedExportFigures(result.skippedFigures ?? []);
      setExportValidation(result.validation);
      setStatusMessage(
        result.validation.status === 'warning'
          ? l(
              `综述已导出，后置校验有 ${result.validation.warnings.length} 条提醒。`,
              `Review exported with ${result.validation.warnings.length} post-validation warning(s).`,
            )
          : result.skippedFigures?.length
          ? l(
              `综述已导出，${result.skippedFigures.length} 张图片已跳过。`,
              `Review exported. ${result.skippedFigures.length} figure(s) were skipped.`,
            )
          : l('综述已导出。', 'Review exported.'),
      );
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setRunningStage(null);
    }
  };

  return (
    <div className="pq-saas-scope flex h-full min-h-0 overflow-hidden rounded-[var(--pq-radius-md)] bg-[var(--pq-surface-1)]">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-[var(--pq-border)] bg-[var(--pq-sidebar)]">
        <div className="border-b border-[var(--pq-border)] px-4 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--pq-accent-bg)] text-[var(--pq-accent)]">
              <BookOpenCheck className="h-4.5 w-4.5" strokeWidth={1.9} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-[var(--pq-text)]">
                {l('论文综述写作', 'Literature Review')}
              </h1>
              <p className="truncate text-xs text-[var(--pq-text-muted)]">
                {l('写作蓝图到 Word 模板', 'Blueprint to Word template')}
              </p>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
          {stages.map((stage, index) => (
            <button key={stage.id} type="button" onClick={() => setActiveStage(stage.id)} className="text-left">
              <StagePill
                active={activeStage === stage.id}
                index={index + 1}
                isLast={index === stages.length - 1}
                label={stage.label}
                status={stage.status}
              />
            </button>
          ))}

          <div className="mt-2 rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-3 text-xs leading-5 text-[var(--pq-text-muted)]">
            {l(
              '先生成可编辑大纲，调整章节顺序和段落数，再按设置的并发数分段写作。',
              'Generate an editable outline first, adjust section order and paragraph counts, then draft with the selected concurrency.',
            )}
            {hasResumeCheckpoint ? (
              <div className="mt-2 rounded-[var(--pq-radius-sm)] bg-[var(--pq-accent-bg)] px-2 py-1 text-[11px] font-medium text-[var(--pq-accent)]">
                {`${completedCheckpointTasks} writing checkpoint(s) saved. Continue to fill only unfinished tasks.`}
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--pq-border)] px-5 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--pq-text)]">
              {l('从意图到可导出的 Word 综述', 'From intent to exportable Word review')}
            </div>
            <div className="mt-0.5 truncate text-xs text-[var(--pq-text-muted)]">
              {statusMessage || l('先检索上下文，生成并调整大纲，再并发分段写作并套模板导出。', 'Retrieve context, generate and adjust the outline, then draft sections concurrently and export through a template.')}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <label className="flex h-8 items-center gap-2 rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)] px-2 text-[11px] font-medium text-[var(--pq-text-muted)]">
              <span>{l('并发', 'Concurrency')}</span>
              <input
                type="range"
                min={MIN_REVIEW_WRITING_CONCURRENCY}
                max={MAX_REVIEW_WRITING_CONCURRENCY}
                value={writingConcurrency}
                onChange={(event) => setWritingConcurrency(clampReviewWritingConcurrency(Number(event.target.value)))}
                className="w-20 accent-[var(--pq-accent)]"
                aria-label={l('第二级写作并发数', 'Second-layer writing concurrency')}
              />
              <span className="w-4 text-right font-semibold text-[var(--pq-text)]">{writingConcurrency}</span>
            </label>
            <button
              type="button"
              onClick={retrieveContext}
              disabled={!query.trim() || runningStage !== null}
              className="pq-button h-8 px-3 text-xs"
            >
              {runningStage === 'retrieve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" strokeWidth={1.8} />}
              {l('检索', 'Retrieve')}
            </button>
            <button
              type="button"
              onClick={generateBlueprintOnly}
              disabled={!canGenerateBlueprint || runningStage !== null}
              className="pq-button-primary h-8 px-3 text-xs"
            >
              {runningStage === 'json' && !reviewBlueprint ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" strokeWidth={1.8} />}
              {l('生成大纲', 'Generate Outline')}
            </button>
            <button
              type="button"
              onClick={generateDraftFromBlueprint}
              disabled={!canGenerateDraft || runningStage !== null}
              className="pq-button h-8 px-3 text-xs"
              title={draftButtonLabel}
              aria-label={draftButtonLabel}
            >
              {runningStage === 'json' && reviewBlueprint ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" strokeWidth={1.8} />}
              {l('开始写作', 'Draft')}
            </button>
          </div>
        </div>

        {error ? (
          <div className="mx-5 mt-3 rounded-[var(--pq-radius-sm)] border border-[var(--pq-error)] bg-[var(--pq-error-bg)] px-3 py-2 text-xs text-[var(--pq-error)]">
            {error}
          </div>
        ) : null}

        {generationProgress ? (
          <div className="mx-5 mt-3">
            <ReviewGenerationProgressPanel progress={generationProgress} l={l} />
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,0.9fr)_minmax(420px,1.1fr)] gap-4 overflow-hidden p-5 max-xl:grid-cols-1">
          <section className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            <ReviewIntentPanel
              intent={intent}
              isEnglish={isEnglish}
              l={l}
              onIntentChange={setIntent}
              onQueryChange={setQuery}
              onRetrieve={() => void retrieveContext()}
              onReviewTypeChange={setReviewType}
              onSemanticRerankChange={setSemanticRerank}
              onSourceModeChange={setSourceMode}
              onTargetAudienceChange={setTargetAudience}
              query={query}
              retrieveDisabled={!query.trim() || runningStage !== null}
              reviewType={reviewType}
              reviewTypes={reviewTypes}
              semanticAvailable={semanticAvailable}
              semanticRerank={semanticRerank}
              sourceMode={sourceMode}
              sourceModes={sourceModes}
              targetAudience={targetAudience}
            />

            <div className="rounded-[var(--pq-radius-md)] border border-[var(--pq-border)] bg-[var(--pq-surface)] p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--pq-text)]">
                  <Search className="h-4 w-4 text-[var(--pq-accent)]" strokeWidth={1.9} />
                  {l('检索上下文', 'Retrieved Context')}
                </div>
                <span className="pq-chip px-2 py-1 text-[11px]">{contextItems.length}</span>
              </div>
              <div className="space-y-2">
                {contextItems.length === 0 ? (
                  <div className="rounded-[var(--pq-radius-sm)] border border-dashed border-[var(--pq-border)] px-3 py-8 text-center text-xs leading-5 text-[var(--pq-text-muted)]">
                    {hasRetrieved
                      ? l('未找到相关文献。请换一个关键词，或先向文库/笔记补充内容。', 'No matching sources. Try a different keyword, or add papers/notes first.')
                      : l('输入关键词并点击“检索”，这里会显示相关论文、笔记和摘要。', 'Enter a keyword and click Retrieve to list related papers, notes, and summaries here.')}
                  </div>
                ) : contextItems.map((item) => (
                  <div
                    key={item.id}
                    className="group rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-bg-secondary)] px-3 py-2 transition hover:border-[var(--pq-accent-border)]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-[var(--pq-accent-bg)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--pq-accent)]">
                        {item.id}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--pq-text)]">
                        {item.title}
                      </span>
                      {typeof item.score === 'number' && item.score > 0 ? (
                        <span className="shrink-0 rounded-md bg-[var(--pq-surface)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--pq-text-muted)]">
                          {item.score.toFixed(1)}
                        </span>
                      ) : null}
                      <span className="shrink-0 text-[11px] text-[var(--pq-text-faint)]">
                        {item.sourceType}
                      </span>
                    </div>
                    {item.figures?.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span className="rounded-md border border-[var(--pq-border)] bg-[var(--pq-surface)] px-1.5 py-0.5 text-[10px] text-[var(--pq-text-muted)]">
                          {l(`可用图表 ${item.figures.length}`, `${item.figures.length} figure/table candidate(s)`)}
                        </span>
                        {item.figures.slice(0, 3).map((figure) => (
                          <span
                            key={figure.id}
                            className="max-w-[140px] truncate rounded-md bg-[var(--pq-accent-bg)] px-1.5 py-0.5 text-[10px] text-[var(--pq-accent)]"
                            title={figure.caption || figure.title}
                          >
                            {figure.id}
                            {typeof figure.pageIndex === 'number' ? ` · p.${figure.pageIndex + 1}` : ''}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--pq-text-muted)]">
                      {item.text}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            <ReviewBlueprintEditor
              blueprint={reviewBlueprint}
              contextItems={contextItems}
              l={l}
              onChange={(nextBlueprint) => {
                setReviewBlueprint(nextBlueprint);
                setJsonDraft(null);
                setReviewCheckpoint(null);
              }}
            />

            <div className="grid min-h-[420px] grid-rows-[auto_minmax(0,1fr)] rounded-[var(--pq-radius-md)] border border-[var(--pq-border)] bg-[var(--pq-surface)]">
              <div className="flex items-center justify-between gap-3 border-b border-[var(--pq-border)] px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--pq-text)]">
                  <FileJson2 className="h-4 w-4 text-[var(--pq-accent)]" strokeWidth={1.9} />
                  {l('导出数据', 'Export Data')}
                </div>
              </div>
              <div className="min-h-0 p-4">
                <JsonPreview draft={jsonDraft} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
              <div className="rounded-[var(--pq-radius-md)] border border-[var(--pq-border)] bg-[var(--pq-surface)] p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--pq-text)]">
                  <ClipboardCheck className="h-4 w-4 text-[var(--pq-accent)]" strokeWidth={1.9} />
                  {l('JSON 校验', 'JSON Validation')}
                </div>
                {jsonDraft ? (
                  validationErrors.length === 0 ? (
                    <div className="rounded-[var(--pq-radius-sm)] bg-[var(--pq-success-bg)] px-3 py-2 text-xs text-[var(--pq-success)]">
                      {l('校验通过，可以使用内置模板导出 Word。', 'Validation passed. Ready to export Word with the built-in template.')}
                    </div>
                  ) : (
                    <ul className="space-y-1 rounded-[var(--pq-radius-sm)] bg-[var(--pq-error-bg)] px-3 py-2 text-xs text-[var(--pq-error)]">
                      {validationErrors.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  )
                ) : (
                  <p className="text-xs leading-5 text-[var(--pq-text-muted)]">
                    {l('生成综述后会在这里检查必填字段、章节和引用 ID。', 'After review generation, required fields, sections, and citation IDs are checked here.')}
                  </p>
                )}
              </div>

              <ReviewExportCard
                canExport={canExport}
                exportedPath={exportedPath}
                isExporting={runningStage === 'export'}
                l={l}
                onChooseOutput={() => void chooseOutput()}
                onExport={() => void exportDocx()}
                onOpenOutput={() => void openReviewOutput(exportedPath)}
                outputPath={outputPath}
                skippedFigures={skippedExportFigures}
                validation={exportValidation}
              />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
