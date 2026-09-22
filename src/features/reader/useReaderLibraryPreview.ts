import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { updateLibraryPaper } from '../../services/library';
import {
  summarizeDocumentOpenAICompatible,
} from '../../services/summary';
import {
  HOME_TAB_ID,
} from '../../stores/useTabsStore';
import type {
  PaperSummary,
  PositionedMineruBlock,
  QaModelPreset,
  ReaderSettings,
  WorkspaceItem,
} from '../../types/reader';
import type {
  LiteraturePaperTaskKind,
  LiteraturePaperTaskState,
} from '../../types/library';
import { getFileNameFromPath } from '../../utils/text';
import { loadPaperHistory } from '../../utils/paperHistory';
import {
  flattenMineruPages,
  parseMineruPages,
} from '../../services/mineru';
import {
  resolveSummaryOutputLanguage,
} from '../../services/summarySource';
import {
  buildLibraryPreviewSummaryRequest,
  hasExistingMineruOutput,
  loadReaderLibraryPreviewBlocks,
  readExistingMineruJson,
  readSavedPreviewSummary,
  writeMineruParseCache,
  writePreviewSummaryCache,
} from './readerLibraryPreview';
import { countTranslatedBlocks } from './readerTranslation';
import {
  enqueueOverviewWrite,
  persistOverviewIfCurrent,
  saveVerifiedLibraryOverview,
  selectUsableOverview,
  shouldPreferRetainedOverview,
  shouldWriteOverviewCache,
  sourceKeyAfterOverviewFailure,
} from './readerBatchResults';
import { readTranslationCache } from './readerTranslationCache';
import { mapPreviewItemsWithConcurrency } from './readerPreviewWork';
import type {
  LibraryPreviewSyncPayload,
  ReaderDocumentTranslationSnapshot,
} from './documentReaderShared';
import {
  EMPTY_LIBRARY_PREVIEW_STATE,
  formatPaperSummaryForLibrary,
  getModelRuntimeConfig,
  textSignature,
  type LibraryPreviewLoadResult,
  type LibraryPreviewOutcome,
  type LibraryPreviewState,
  type MineruCacheManifest,
  type PreferencesSectionKey,
} from './readerShared';

type LocaleTextFn = <T,>(zh: T, en: T) => T;

type CreatePaperTaskState = (
  kind: LiteraturePaperTaskKind,
  status: LiteraturePaperTaskState['status'],
  message: string,
  completed?: number | null,
  total?: number | null,
) => LiteraturePaperTaskState;

export interface UseReaderLibraryPreviewOptions {
  activeTabId: string | null;
  allKnownItems: WorkspaceItem[];
  createPaperTaskState: CreatePaperTaskState;
  l: LocaleTextFn;
  selectedLibraryItem: WorkspaceItem | null;
  setError: (value: string) => void;
  setPreferencesOpen: (value: boolean) => void;
  setPreferredPreferencesSection: (value: PreferencesSectionKey | undefined) => void;
  setStatusMessage: (value: string) => void;
  settings: ReaderSettings;
  summaryModelPreset: QaModelPreset | null | undefined;
}

export interface UseReaderLibraryPreviewResult {
  findExistingMineruJson: (item: WorkspaceItem) => Promise<Awaited<ReturnType<typeof readExistingMineruJson>>>;
  generateLibraryPreview: (
    item: WorkspaceItem,
    force?: boolean,
    options?: { allowGenerate?: boolean },
  ) => Promise<LibraryPreviewOutcome>;
  handleLibraryPreviewSync: (payload: LibraryPreviewSyncPayload) => void;
  itemParseStatusMap: Record<string, boolean | undefined>;
  libraryPreviewStates: Record<string, LibraryPreviewState>;
  libraryTranslationSnapshots: Record<string, ReaderDocumentTranslationSnapshot>;
  loadLibraryPreviewBlocks: (item: WorkspaceItem) => Promise<LibraryPreviewLoadResult>;
  saveLibraryMineruParseCache: (options: {
    item: WorkspaceItem;
    pdfPath: string;
    sourceKind: MineruCacheManifest['sourceKind'];
    contentJsonText?: string | null;
    middleJsonText?: string | null;
    markdownText?: string | null;
    batchId?: string;
    dataId?: string;
    fileName?: string;
    zipEntries?: string[];
  }) => Promise<Awaited<ReturnType<typeof writeMineruParseCache>>>;
  setItemParseStatusMap: Dispatch<SetStateAction<Record<string, boolean | undefined>>>;
  setLibraryPreviewStates: Dispatch<SetStateAction<Record<string, LibraryPreviewState>>>;
  setLibraryTranslationSnapshots: Dispatch<SetStateAction<Record<string, ReaderDocumentTranslationSnapshot>>>;
  syncLibraryParsedState: (
    item: WorkspaceItem,
    jsonText: string,
    jsonPath: string,
    status: string,
  ) => {
    pages: ReturnType<typeof parseMineruPages>;
    blocks: ReturnType<typeof flattenMineruPages>;
  };
  updateLibraryPreviewOperation: (
    item: WorkspaceItem,
    operation: LiteraturePaperTaskState | null,
    patch?: Partial<Omit<LibraryPreviewState, 'operation'>>,
  ) => void;
}

export function useReaderLibraryPreview({
  activeTabId,
  allKnownItems,
  createPaperTaskState,
  l,
  selectedLibraryItem,
  setPreferencesOpen,
  setPreferredPreferencesSection,
  settings,
  summaryModelPreset,
}: UseReaderLibraryPreviewOptions): UseReaderLibraryPreviewResult {
  const libraryPreviewRequestIdRef = useRef<Record<string, number>>({});
  const savedNativeSummaryKeysRef = useRef<Set<string>>(new Set());
  const pendingNativeSummarySavesRef = useRef<Map<string, Promise<void>>>(new Map());
  const nativeOverviewWriteChainsRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const overviewCacheWriteChainsRef = useRef<Map<string, Promise<unknown>>>(new Map());

  const [libraryPreviewStates, setLibraryPreviewStates] = useState<
    Record<string, LibraryPreviewState>
  >({});
  const [itemParseStatusMap, setItemParseStatusMap] = useState<Record<string, boolean | undefined>>(
    {},
  );
  const [libraryTranslationSnapshots, setLibraryTranslationSnapshots] = useState<
    Record<string, ReaderDocumentTranslationSnapshot>
  >({});

  const notLoadedText = l('未加载', 'Not Loaded');
  const noPdfLoadedText = l('未加载 PDF', 'No PDF Loaded');
  const noJsonLoadedText = l('未加载 JSON', 'No JSON Loaded');

  const updateLibraryPreviewOperation = useCallback(
    (
      item: WorkspaceItem,
      operation: LiteraturePaperTaskState | null,
      patch: Partial<Omit<LibraryPreviewState, 'operation'>> = {},
    ) => {
      setLibraryPreviewStates((current) => ({
        ...current,
        [item.workspaceId]: {
          ...(current[item.workspaceId] ?? EMPTY_LIBRARY_PREVIEW_STATE),
          ...patch,
          operation,
        },
      }));
    },
    [],
  );

  const persistNativeLibraryOverview = useCallback(
    async (item: WorkspaceItem, summary: PaperSummary, sourceKey: string) => {
      if (item.source !== 'native-library') {
        return;
      }

      const summaryText = formatPaperSummaryForLibrary(summary);

      const saveKey = `${item.itemKey}::${sourceKey || 'overview'}::${textSignature(summaryText)}`;

      if (savedNativeSummaryKeysRef.current.has(saveKey)) {
        return;
      }

      let pendingSave = pendingNativeSummarySavesRef.current.get(saveKey);
      if (!pendingSave) {
        pendingSave = enqueueOverviewWrite(nativeOverviewWriteChainsRef.current, item.itemKey, async () => {
          const updatedPaper = await saveVerifiedLibraryOverview(
            summaryText,
            () => updateLibraryPaper({
              paperId: item.itemKey,
              aiSummary: summaryText,
            }),
          );
          savedNativeSummaryKeysRef.current.add(saveKey);
          window.dispatchEvent(
            new CustomEvent('paperquay:native-summary-updated', {
              detail: {
                paperId: updatedPaper.id,
                aiSummary: updatedPaper.aiSummary,
              },
            }),
          );
        });
        pendingNativeSummarySavesRef.current.set(saveKey, pendingSave);
      }

      try {
        await pendingSave;
      } finally {
        if (pendingNativeSummarySavesRef.current.get(saveKey) === pendingSave) {
          pendingNativeSummarySavesRef.current.delete(saveKey);
        }
      }
    },
    [],
  );

  const handleLibraryPreviewSync = useCallback((payload: LibraryPreviewSyncPayload) => {
    if (payload.summary) {
      void persistNativeLibraryOverview(
        payload.item,
        payload.summary,
        payload.sourceKey ?? 'overview',
      ).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setLibraryPreviewStates((current) => {
          if (payload.sourceKey && current[payload.item.workspaceId]?.sourceKey !== payload.sourceKey) {
            return current;
          }
          return {
            ...current,
            [payload.item.workspaceId]: {
              ...(current[payload.item.workspaceId] ?? EMPTY_LIBRARY_PREVIEW_STATE),
              loading: false,
              error: message,
              operation: createPaperTaskState('overview', 'error', message),
              statusMessage: message,
            },
          };
        });
      });
    }

    if (payload.item.source === 'native-library' && payload.hasBlocks) {
      window.dispatchEvent(
        new CustomEvent('paperquay:native-mineru-status-updated', {
          detail: {
            paperId: payload.item.itemKey,
            mineruParsed: true,
          },
        }),
      );
    }

    setItemParseStatusMap((current) => ({
      ...current,
      [payload.item.workspaceId]: payload.hasBlocks,
    }));

    setLibraryPreviewStates((current) => {
      const existingState = current[payload.item.workspaceId];
      const hasSummary = Object.prototype.hasOwnProperty.call(payload, 'summary');
      const hasLoading = Object.prototype.hasOwnProperty.call(payload, 'loading');
      const hasError = Object.prototype.hasOwnProperty.call(payload, 'error');
      const hasOperation = Object.prototype.hasOwnProperty.call(payload, 'operation');

      return {
        ...current,
        [payload.item.workspaceId]: {
          summary: hasSummary ? payload.summary ?? null : existingState?.summary ?? null,
          loading: hasLoading ? Boolean(payload.loading) : false,
          error: hasError ? payload.error ?? '' : '',
          operation: hasOperation ? payload.operation ?? null : existingState?.operation ?? null,
          hasBlocks: payload.hasBlocks,
          blockCount: payload.blockCount,
          currentPdfName: payload.currentPdfName,
          currentJsonName: payload.currentJsonName,
          statusMessage: payload.statusMessage,
          sourceKey: payload.sourceKey,
        },
      };
    });
  }, [createPaperTaskState, persistNativeLibraryOverview]);

  const findExistingMineruJson = useCallback(
    async (item: WorkspaceItem) =>
      readExistingMineruJson(item, {
        autoLoadSiblingJson: settings.autoLoadSiblingJson,
        mineruCacheDir: settings.mineruCacheDir,
      }),
    [settings.autoLoadSiblingJson, settings.mineruCacheDir],
  );

  useEffect(() => {
    if (allKnownItems.length === 0) {
      setItemParseStatusMap({});
      return;
    }

    let cancelled = false;

    void (async () => {
      const nextEntries = await mapPreviewItemsWithConcurrency(
        allKnownItems,
        8,
        async (item) => [
          item.workspaceId,
          await hasExistingMineruOutput(item, {
            autoLoadSiblingJson: settings.autoLoadSiblingJson,
            mineruCacheDir: settings.mineruCacheDir,
          }),
        ] as const,
        () => !cancelled,
      );

      if (cancelled) {
        return;
      }

      setItemParseStatusMap((current) => ({
        ...current,
        ...Object.fromEntries(nextEntries),
      }));
    })();

    return () => {
      cancelled = true;
    };
  }, [allKnownItems, settings.autoLoadSiblingJson, settings.mineruCacheDir]);

  useEffect(() => {
    if (allKnownItems.length === 0 || !settings.mineruCacheDir.trim()) {
      return undefined;
    }

    let cancelled = false;

    void (async () => {
      const restoredEntries = (
        await mapPreviewItemsWithConcurrency(
          allKnownItems,
          8,
          async (item) => {
            const cachedTranslation = await readTranslationCache({
              item,
              mineruCacheDir: settings.mineruCacheDir,
              targetLanguage: settings.translationTargetLanguage,
            }).catch(() => null);

            if (!cachedTranslation) {
              return null;
            }

            const count = countTranslatedBlocks(cachedTranslation.translations);

            if (count === 0) {
              return null;
            }

            return {
              item,
              count,
              blockSourceFingerprints: cachedTranslation.blockSourceFingerprints,
              sourceFingerprint: cachedTranslation.sourceFingerprint,
              translations: cachedTranslation.translations,
            };
          },
          () => !cancelled,
        )
      ).filter((entry): entry is {
        item: WorkspaceItem;
        count: number;
        blockSourceFingerprints: Record<string, string>;
        sourceFingerprint: string;
        translations: ReaderDocumentTranslationSnapshot['translations'];
      } => Boolean(entry));

      if (cancelled || restoredEntries.length === 0) {
        return;
      }

      const restoredAt = Date.now();

      setLibraryTranslationSnapshots((current) => {
        let changed = false;
        const next = { ...current };

        for (const entry of restoredEntries) {
          const previousSnapshot = current[entry.item.workspaceId] ?? null;
          const previousCount =
            previousSnapshot?.targetLanguage === settings.translationTargetLanguage
              ? countTranslatedBlocks(previousSnapshot.translations)
              : 0;

          if (previousCount >= entry.count) {
            continue;
          }

          next[entry.item.workspaceId] = {
            targetLanguage: settings.translationTargetLanguage,
            translations: entry.translations,
            blockSourceFingerprints: entry.blockSourceFingerprints,
            sourceFingerprint: entry.sourceFingerprint,
            updatedAt: restoredAt,
          };
          changed = true;
        }

        return changed ? next : current;
      });

      setLibraryPreviewStates((current) => {
        let changed = false;
        const next = { ...current };

        for (const entry of restoredEntries) {
          const previousState = current[entry.item.workspaceId] ?? EMPTY_LIBRARY_PREVIEW_STATE;

          if (previousState.operation?.status === 'running') {
            continue;
          }

          const message = l(
            `已加载缓存全文翻译 ${entry.count} 条`,
            `Loaded ${entry.count} cached full-document translations`,
          );

          next[entry.item.workspaceId] = {
            ...previousState,
            loading: false,
            error: '',
            operation: createPaperTaskState(
              'translation',
              'success',
              message,
              entry.count,
              null,
            ),
            currentPdfName:
              previousState.currentPdfName ||
              (entry.item.localPdfPath ? getFileNameFromPath(entry.item.localPdfPath) : noPdfLoadedText),
            currentJsonName: previousState.currentJsonName || notLoadedText,
            statusMessage: previousState.statusMessage || message,
          };
          changed = true;
        }

        return changed ? next : current;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    allKnownItems,
    createPaperTaskState,
    l,
    noPdfLoadedText,
    notLoadedText,
    settings.mineruCacheDir,
    settings.translationTargetLanguage,
  ]);

  const saveLibraryMineruParseCache = useCallback(
    async (options: {
      item: WorkspaceItem;
      pdfPath: string;
      sourceKind: MineruCacheManifest['sourceKind'];
      contentJsonText?: string | null;
      middleJsonText?: string | null;
      markdownText?: string | null;
      batchId?: string;
      dataId?: string;
      fileName?: string;
      zipEntries?: string[];
    }) =>
      writeMineruParseCache({
        ...options,
        mineruCacheDir: settings.mineruCacheDir,
      }),
    [settings.mineruCacheDir],
  );

  const syncLibraryParsedState = useCallback(
    (
      item: WorkspaceItem,
      jsonText: string,
      jsonPath: string,
      status: string,
    ) => {
      const pages = parseMineruPages(jsonText);
      const blocks = flattenMineruPages(pages);
      const currentJsonName = getFileNameFromPath(jsonPath);
      const currentPdfName = item.localPdfPath
        ? getFileNameFromPath(item.localPdfPath)
        : noPdfLoadedText;

      setItemParseStatusMap((current) => ({
        ...current,
        [item.workspaceId]: true,
      }));
      setLibraryPreviewStates((current) => {
        const previousState = current[item.workspaceId] ?? EMPTY_LIBRARY_PREVIEW_STATE;

        return {
          ...current,
          [item.workspaceId]: {
            ...previousState,
            loading: false,
            error: '',
            hasBlocks: blocks.length > 0,
            blockCount: blocks.length,
            currentPdfName,
            currentJsonName,
            statusMessage: status,
            sourceKey:
              previousState.sourceKey || `${item.workspaceId}::${currentJsonName}::${blocks.length}`,
          },
        };
      });

      return {
        pages,
        blocks,
      };
    },
    [noPdfLoadedText],
  );

  const loadLibraryPreviewBlocks = useCallback(
    async (item: WorkspaceItem): Promise<LibraryPreviewLoadResult> =>
      loadReaderLibraryPreviewBlocks({
        item,
        settings,
        l,
        noJsonLoadedText,
        noPdfLoadedText,
        notLoadedText,
      }),
    [l, noJsonLoadedText, noPdfLoadedText, notLoadedText, settings],
  );

  const resolveLibraryPreviewSummaryRequest = useCallback(
    async (
      item: WorkspaceItem,
      blocks: PositionedMineruBlock[],
    ) =>
      buildLibraryPreviewSummaryRequest({
        item,
        blocks,
        settings,
        l,
      }),
    [l, settings],
  );

  const tryLoadSavedPreviewSummary = useCallback(
    async (item: WorkspaceItem, sourceKey: string) =>
      readSavedPreviewSummary({
        item,
        mineruCacheDir: settings.mineruCacheDir,
        sourceKey,
      }),
    [settings.mineruCacheDir],
  );

  const savePreviewSummary = useCallback(
    async (
      item: WorkspaceItem,
      sourceKey: string,
      summary: PaperSummary,
    ) => {
      if (!shouldWriteOverviewCache(item.source, settings.mineruCacheDir)) {
        return;
      }
      await enqueueOverviewWrite(overviewCacheWriteChainsRef.current, item.itemKey, async () => {
        await writePreviewSummaryCache({
          item,
          mineruCacheDir: settings.mineruCacheDir,
          sourceKey,
          summary,
        });
        const verified = await readSavedPreviewSummary({
          item,
          mineruCacheDir: settings.mineruCacheDir,
          sourceKey,
        });
        if (JSON.stringify(verified) !== JSON.stringify(summary)) {
          throw new Error('The saved overview cache could not be verified.');
        }
      });
    },
    [settings.mineruCacheDir],
  );

  const generateLibraryPreview = useCallback(
    async (
      item: WorkspaceItem,
      force = false,
      options?: {
        allowGenerate?: boolean;
      },
    ): Promise<LibraryPreviewOutcome> => {
      const allowGenerate = options?.allowGenerate ?? true;
      const cachedState = libraryPreviewStates[item.workspaceId];

      if (!force && cachedState) {
        if (cachedState.loading) {
          return 'skipped';
        }

        if (cachedState.hasBlocks && !allowGenerate && !cachedState.summary) {
          setLibraryPreviewStates((current) => ({
            ...current,
            [item.workspaceId]: {
              ...cachedState,
              loading: false,
              error: '',
              statusMessage:
                cachedState.statusMessage ||
                l(
                  '结构化内容已就绪，可以手动生成概览。',
                  'Structured content is ready. You can generate the overview manually.',
                ),
            },
          }));
          return 'loaded';
        }
      }

      const requestId = (libraryPreviewRequestIdRef.current[item.workspaceId] ?? 0) + 1;
      libraryPreviewRequestIdRef.current[item.workspaceId] = requestId;
      const isCurrentRequest = () => libraryPreviewRequestIdRef.current[item.workspaceId] === requestId;
      const persistIfCurrent = async (
        summary: PaperSummary,
        sourceKey: string,
        cacheAlreadyVerified = false,
      ): Promise<boolean> => persistOverviewIfCurrent({
        isCurrent: isCurrentRequest,
        cacheAlreadyVerified,
        summaryText: formatPaperSummaryForLibrary(summary),
        saveCache: () => savePreviewSummary(item, sourceKey, summary),
        saveNative: () => persistNativeLibraryOverview(item, summary, sourceKey),
      });

      setLibraryPreviewStates((current) => ({
        ...current,
        [item.workspaceId]: {
          summary: force ? null : current[item.workspaceId]?.summary ?? null,
          loading: true,
          error: '',
          operation: allowGenerate
            ? createPaperTaskState(
                'overview',
                'running',
                l(
                  '正在整理预览内容并生成 AI 概览...',
                  'Preparing the preview and generating the AI overview...',
                ),
                15,
                100,
              )
            : current[item.workspaceId]?.operation ?? null,
          hasBlocks: current[item.workspaceId]?.hasBlocks ?? false,
          blockCount: current[item.workspaceId]?.blockCount ?? 0,
          currentPdfName: item.localPdfPath ? getFileNameFromPath(item.localPdfPath) : noPdfLoadedText,
          currentJsonName: current[item.workspaceId]?.currentJsonName ?? notLoadedText,
          statusMessage: l(
            '正在整理预览内容并生成 AI 概览...',
            'Preparing the preview and generating the AI overview...',
          ),
          sourceKey: current[item.workspaceId]?.sourceKey ?? '',
        },
      }));

      let availableSummary: PaperSummary | null = null;
      let resolvedSourceKey = '';
      try {
        const previewContext = await loadLibraryPreviewBlocks(item);
        const summaryRequest = await resolveLibraryPreviewSummaryRequest(item, previewContext.blocks);
        const {
          summaryInputs,
          sourceKey,
          documentText,
          errorMessage,
        } = summaryRequest;
        resolvedSourceKey = sourceKey;
        const historySummary = selectUsableOverview(
          loadPaperHistory(item.workspaceId)?.paperSummarySourceKey === sourceKey
            ? loadPaperHistory(item.workspaceId)?.paperSummary ?? null
            : null,
          formatPaperSummaryForLibrary,
        );
        const cachedSummary = selectUsableOverview(
          force ? null : await tryLoadSavedPreviewSummary(item, sourceKey),
          formatPaperSummaryForLibrary,
        );
        const reusableStateSummary = selectUsableOverview(
          cachedState?.summary,
          formatPaperSummaryForLibrary,
        );
        const preferRetainedSummary = shouldPreferRetainedOverview({
          hasUsableSummary: Boolean(reusableStateSummary),
          retainedSourceKey: cachedState?.sourceKey ?? '',
          resolvedSourceKey: sourceKey,
          operation: cachedState?.operation,
        });

        if (libraryPreviewRequestIdRef.current[item.workspaceId] !== requestId) {
          return 'skipped';
        }

        if (errorMessage && !documentText.trim() && summaryInputs.length === 0) {
          setLibraryPreviewStates((current) => ({
            ...current,
            [item.workspaceId]: {
              summary: null,
              loading: false,
              error: '',
              operation: allowGenerate
                ? createPaperTaskState('overview', 'error', errorMessage, 100, 100)
                : current[item.workspaceId]?.operation ?? null,
              hasBlocks: false,
              blockCount: 0,
              currentPdfName: previewContext.currentPdfName,
              currentJsonName: previewContext.currentJsonName,
              statusMessage: errorMessage,
              sourceKey,
            },
          }));
          return 'skipped';
        }

        if (!force && historySummary && !preferRetainedSummary) {
          availableSummary = historySummary;
          if (!await persistIfCurrent(historySummary, sourceKey)) return 'skipped';
          setLibraryPreviewStates((current) => ({
            ...current,
            [item.workspaceId]: {
              summary: historySummary,
              loading: false,
              error: '',
              operation: allowGenerate
                ? createPaperTaskState(
                    'overview',
                    'success',
                    l('已从阅读历史恢复概览', 'Overview restored from reading history'),
                    100,
                    100,
                  )
                : current[item.workspaceId]?.operation ?? null,
              hasBlocks: Boolean(documentText.trim()) || previewContext.blocks.length > 0,
              blockCount: previewContext.blocks.length,
              currentPdfName: previewContext.currentPdfName,
              currentJsonName: previewContext.currentJsonName,
              statusMessage: l('已从阅读历史恢复概览', 'Overview restored from reading history'),
              sourceKey,
            },
          }));
          return 'loaded';
        }

        if (!force && cachedSummary && !preferRetainedSummary) {
          availableSummary = cachedSummary;
          if (!await persistIfCurrent(cachedSummary, sourceKey, true)) return 'skipped';
          setLibraryPreviewStates((current) => ({
            ...current,
            [item.workspaceId]: {
              summary: cachedSummary,
              loading: false,
              error: '',
              operation: allowGenerate
                ? createPaperTaskState(
                    'overview',
                    'success',
                    l('已加载缓存概览', 'Loaded the cached overview'),
                    100,
                    100,
                  )
                : current[item.workspaceId]?.operation ?? null,
              hasBlocks: Boolean(documentText.trim()) || previewContext.blocks.length > 0,
              blockCount: previewContext.blocks.length,
              currentPdfName: previewContext.currentPdfName,
              currentJsonName: previewContext.currentJsonName,
              statusMessage: l('已加载缓存概览', 'Loaded the cached overview'),
              sourceKey,
            },
          }));
          return 'loaded';
        }

        if (!force && reusableStateSummary && cachedState?.sourceKey === sourceKey) {
          availableSummary = reusableStateSummary;
          if (!await persistIfCurrent(reusableStateSummary, sourceKey)) return 'skipped';
          setLibraryPreviewStates((current) => ({
            ...current,
            [item.workspaceId]: {
              ...cachedState,
              loading: false,
              operation: allowGenerate
                ? createPaperTaskState(
                    'overview', 'success', l('已验证并保存当前概览', 'Current overview verified and saved'), 100, 100,
                  )
                : cachedState.operation ?? null,
            },
          }));
          return 'loaded';
        }

        if (!summaryModelPreset || !summaryModelPreset.apiKey.trim() || !summaryModelPreset.baseUrl.trim()) {
          setLibraryPreviewStates((current) => ({
            ...current,
            [item.workspaceId]: {
              summary: null,
              loading: false,
              error: '',
              operation: allowGenerate
                ? createPaperTaskState(
                    'overview',
                    'error',
                    l(
                      '概览模型尚未配置完成，请检查 Base URL、模型名称和 API Key。',
                      'The overview model is not configured yet. Check the Base URL, model name, and API key.',
                    ),
                    100,
                    100,
                  )
                : current[item.workspaceId]?.operation ?? null,
              hasBlocks: Boolean(documentText.trim()) || previewContext.blocks.length > 0,
              blockCount: previewContext.blocks.length,
              currentPdfName: previewContext.currentPdfName,
              currentJsonName: previewContext.currentJsonName,
              statusMessage: l(
                '概览模型尚未配置完成，请检查 Base URL、模型名称和 API Key。',
                'The overview model is not configured yet. Check the Base URL, model name, and API key.',
              ),
              sourceKey,
            },
          }));
          setPreferredPreferencesSection('models');
          setPreferencesOpen(true);
          return 'skipped';
        }

        if (!allowGenerate) {
          setLibraryPreviewStates((current) => ({
            ...current,
            [item.workspaceId]: {
              summary: null,
              loading: false,
              error: '',
              operation: current[item.workspaceId]?.operation ?? null,
              hasBlocks: Boolean(documentText.trim()) || previewContext.blocks.length > 0,
              blockCount: previewContext.blocks.length,
              currentPdfName: previewContext.currentPdfName,
              currentJsonName: previewContext.currentJsonName,
              statusMessage: previewContext.blocks.length > 0
                ? l(
                    '结构化内容已就绪，可以手动生成概览。',
                    'Structured content is ready. You can generate the overview manually.',
                  )
                : previewContext.statusMessage,
              sourceKey,
            },
          }));
          return 'skipped';
        }

        setLibraryPreviewStates((current) => ({
          ...current,
          [item.workspaceId]: {
            ...(current[item.workspaceId] ?? EMPTY_LIBRARY_PREVIEW_STATE),
            operation: createPaperTaskState(
              'overview',
              'running',
              l('正在调用概览模型生成结构化结果...', 'Calling the overview model for a structured result...'),
              55,
              100,
            ),
            statusMessage: l('正在调用概览模型生成结构化结果...', 'Calling the overview model for a structured result...'),
          },
        }));

        const summary = await summarizeDocumentOpenAICompatible({
          baseUrl: summaryModelPreset.baseUrl,
          apiKey: summaryModelPreset.apiKey.trim(),
          model: summaryModelPreset.model,
          apiMode: summaryModelPreset.apiMode,
          temperature: getModelRuntimeConfig(settings, 'summary').temperature,
          reasoningEffort: getModelRuntimeConfig(settings, 'summary').reasoningEffort,
          title: item.title,
          authors: item.creators || undefined,
          year: item.year || undefined,
          outputLanguage: resolveSummaryOutputLanguage(settings),
          blocks: summaryInputs,
          documentText,
        });

        if (libraryPreviewRequestIdRef.current[item.workspaceId] !== requestId) {
          return 'skipped';
        }

        if (!selectUsableOverview(summary, formatPaperSummaryForLibrary)) {
          throw new Error('The generated overview contains no usable content.');
        }
        availableSummary = summary;
        if (!await persistIfCurrent(summary, sourceKey)) return 'skipped';

        setLibraryPreviewStates((current) => ({
          ...current,
          [item.workspaceId]: {
            summary,
            loading: false,
            error: '',
            operation: createPaperTaskState(
              'overview',
              'success',
              l('AI 概览已生成', 'AI overview generated'),
              100,
              100,
            ),
            hasBlocks: Boolean(documentText.trim()) || previewContext.blocks.length > 0,
            blockCount: previewContext.blocks.length,
            currentPdfName: previewContext.currentPdfName,
            currentJsonName: previewContext.currentJsonName,
            statusMessage: l('AI 概览已生成', 'AI overview generated'),
            sourceKey,
          },
        }));
        return 'generated';
      } catch (nextError) {
        if (libraryPreviewRequestIdRef.current[item.workspaceId] !== requestId) {
          return 'skipped';
        }

        setLibraryPreviewStates((current) => ({
          ...current,
          [item.workspaceId]: {
            summary: availableSummary,
            loading: false,
            error:
              nextError instanceof Error
                ? nextError.message
                : l('生成预览概览失败', 'Failed to generate the preview overview'),
            operation: createPaperTaskState(
              'overview',
              'error',
              nextError instanceof Error
                ? nextError.message
                : l('生成预览概览失败', 'Failed to generate the preview overview'),
              100,
              100,
            ),
            hasBlocks: libraryPreviewStates[item.workspaceId]?.hasBlocks ?? false,
            blockCount: libraryPreviewStates[item.workspaceId]?.blockCount ?? 0,
            currentPdfName:
              libraryPreviewStates[item.workspaceId]?.currentPdfName ??
              (item.localPdfPath ? getFileNameFromPath(item.localPdfPath) : noPdfLoadedText),
            currentJsonName: libraryPreviewStates[item.workspaceId]?.currentJsonName ?? notLoadedText,
            statusMessage: l('生成预览概览失败', 'Failed to generate the preview overview'),
            sourceKey: sourceKeyAfterOverviewFailure(
              Boolean(availableSummary),
              resolvedSourceKey,
              current[item.workspaceId]?.sourceKey ?? '',
            ),
          },
        }));
        return 'failed';
      }
    },
    [
      createPaperTaskState,
      l,
      libraryPreviewStates,
      loadLibraryPreviewBlocks,
      noPdfLoadedText,
      notLoadedText,
      persistNativeLibraryOverview,
      resolveLibraryPreviewSummaryRequest,
      savePreviewSummary,
      setPreferencesOpen,
      setPreferredPreferencesSection,
      settings,
      summaryModelPreset,
      tryLoadSavedPreviewSummary,
    ],
  );

  const generateLibraryPreviewRef = useRef(generateLibraryPreview);

  useEffect(() => {
    generateLibraryPreviewRef.current = generateLibraryPreview;
  }, [generateLibraryPreview]);

  useEffect(() => {
    if (activeTabId !== HOME_TAB_ID || !selectedLibraryItem) {
      return;
    }

    void generateLibraryPreviewRef.current(selectedLibraryItem, false, { allowGenerate: false });
  }, [activeTabId, selectedLibraryItem]);

  return {
    findExistingMineruJson,
    generateLibraryPreview,
    handleLibraryPreviewSync,
    itemParseStatusMap,
    libraryPreviewStates,
    libraryTranslationSnapshots,
    loadLibraryPreviewBlocks,
    saveLibraryMineruParseCache,
    setItemParseStatusMap,
    setLibraryPreviewStates,
    setLibraryTranslationSnapshots,
    syncLibraryParsedState,
    updateLibraryPreviewOperation,
  };
}
