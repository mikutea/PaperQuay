import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  approveWritePath,
  getAppDefaultPaths,
} from '../../services/desktop';
import type { AppDefaultPaths } from '../../services/desktop';
import {
  readReaderConfigFile,
  writeReaderConfigFile,
} from '../../services/readerConfig';
import {
  getLibrarySettings,
  updateLibrarySettings,
} from '../../services/library';
import type {
  QaModelPreset,
  ReaderConfigFile,
  ReaderSecrets,
  ReaderSettings,
} from '../../types/reader';
import type { LibrarySettings } from '../../types/library';
import {
  LIBRARY_SETTINGS_UPDATED_EVENT,
  emitLibrarySettingsUpdated,
  type LibrarySettingsUpdatedEventDetail,
} from '../literature/libraryEvents';
import {
  emitUiLanguageChanged,
} from '../../app/appEvents';
import {
  buildLegacyModelPresets,
  CONFIG_WRITE_DEBOUNCE_MS,
  createQaPreset,
  DEFAULT_QA_PRESET,
  DEFAULT_QA_PRESET_ID,
  DEFAULT_SECRETS,
  loadSecrets,
  loadSettings,
  mergeReaderConfigWithDefaults,
  normalizeReaderSettings,
  pickLocaleText,
  READER_CONFIG_VERSION,
  resolveModelPreset,
  SECRETS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
} from './readerShared';

type LocaleTextFn = <T,>(zh: T, en: T) => T;

export interface UseReaderSettingsOptions {
  setError: (value: string) => void;
  setStatusMessage: (value: string) => void;
}

export function useReaderSettings({
  setError,
  setStatusMessage,
}: UseReaderSettingsOptions) {
  const legacyModelPresetMigrationDoneRef = useRef(false);

  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [readerSecrets, setReaderSecrets] = useState<ReaderSecrets>(DEFAULT_SECRETS);
  const [zoteroLocalDataDir, setZoteroLocalDataDir] = useState('');
  const [librarySettings, setLibrarySettings] = useState<LibrarySettings | null>(null);
  const [appDefaultPaths, setAppDefaultPaths] = useState<AppDefaultPaths | null>(null);
  const [configHydrated, setConfigHydrated] = useState(false);

  const l = useCallback<LocaleTextFn>(
    (zh, en) => pickLocaleText(settings.uiLanguage, zh, en),
    [settings.uiLanguage],
  );

  const qaModelPresets = readerSecrets.qaModelPresets;

  const translationModelPreset = useMemo(
    () => resolveModelPreset(qaModelPresets, settings.translationModelPresetId),
    [qaModelPresets, settings.translationModelPresetId],
  );
  const selectionTranslationModelPreset = useMemo(
    () =>
      resolveModelPreset(qaModelPresets, settings.selectionTranslationModelPresetId) ??
      translationModelPreset,
    [qaModelPresets, settings.selectionTranslationModelPresetId, translationModelPreset],
  );
  const summaryModelPreset = useMemo(
    () => resolveModelPreset(qaModelPresets, settings.summaryModelPresetId) ?? translationModelPreset,
    [qaModelPresets, settings.summaryModelPresetId, translationModelPreset],
  );
  const summaryConfigured = Boolean(
    summaryModelPreset?.apiKey.trim() &&
      summaryModelPreset?.baseUrl.trim() &&
      summaryModelPreset?.model.trim(),
  );

  const updateNativeLibrarySettings = useCallback(
    async (
      patch: Partial<LibrarySettings> | LibrarySettings,
      source = 'reader-preferences',
    ): Promise<LibrarySettings | null> => {
      try {
        const base = librarySettings ?? await getLibrarySettings();
        const nextSettings = await updateLibrarySettings({
          ...base,
          ...patch,
        });

        setLibrarySettings(nextSettings);

        if (Object.prototype.hasOwnProperty.call(patch, 'zoteroLocalDataDir')) {
          setZoteroLocalDataDir(nextSettings.zoteroLocalDataDir.trim());
        }

        emitLibrarySettingsUpdated(nextSettings, source);
        return nextSettings;
      } catch (nextError) {
        const message =
          nextError instanceof Error
            ? nextError.message
            : l('保存文库设置失败', 'Failed to save library settings');

        setError(message);
        setStatusMessage(message);
        return null;
      }
    },
    [l, librarySettings, setError, setStatusMessage],
  );

  const syncNativeLibraryZoteroDir = useCallback(
    async (dataDir: string, source = 'reader-settings'): Promise<LibrarySettings | null> => {
      const normalizedDataDir = dataDir.trim();

      try {
        const currentSettings = librarySettings ?? await getLibrarySettings();

        if (currentSettings.zoteroLocalDataDir.trim() === normalizedDataDir) {
          setLibrarySettings(currentSettings);
          return currentSettings;
        }

        return await updateNativeLibrarySettings(
          { zoteroLocalDataDir: normalizedDataDir },
          source,
        );
      } catch (nextError) {
        const message =
          nextError instanceof Error
            ? nextError.message
            : l('同步 Zotero 文库设置失败', 'Failed to sync Zotero library settings');

        setError(message);
        setStatusMessage(message);
        return null;
      }
    },
    [l, librarySettings, setError, setStatusMessage, updateNativeLibrarySettings],
  );

  const updateSetting = useCallback(<Key extends keyof ReaderSettings>(
    key: Key,
    value: ReaderSettings[Key],
  ) => {
    setSettings((current) => {
      if (Object.is(current[key], value)) {
        return current;
      }

      const nextSettings = normalizeReaderSettings({
        ...current,
        [key]: value,
      });

      return Object.is(current[key], nextSettings[key]) ? current : nextSettings;
    });
  }, []);

  const updateReaderSecret = useCallback(<Key extends keyof ReaderSecrets>(
    key: Key,
    value: ReaderSecrets[Key],
  ) => {
    setReaderSecrets((current) => ({
      ...current,
      [key]: value,
    }));
  }, []);

  const updateQaModelPreset = useCallback((presetId: string, patch: Partial<QaModelPreset>) => {
    setReaderSecrets((current) => ({
      ...current,
      qaModelPresets: current.qaModelPresets.map((preset) => {
        if (preset.id !== presetId) {
          return preset;
        }

        const nextModel = Object.prototype.hasOwnProperty.call(patch, 'model')
          ? patch.model ?? ''
          : preset.model;
        const hasExplicitLabel = Object.prototype.hasOwnProperty.call(patch, 'label');
        const nextLabelSource = hasExplicitLabel ? patch.label ?? '' : preset.label;
        const currentLabelCustomized = preset.labelCustomized ?? false;
        const nextLabelCustomized =
          patch.labelCustomized ??
          (hasExplicitLabel
            ? nextLabelSource.trim() !== '' && nextLabelSource.trim() !== nextModel.trim()
            : currentLabelCustomized);
        const nextLabel =
          hasExplicitLabel
            ? nextLabelSource || (!nextLabelCustomized ? nextModel : '')
            : Object.prototype.hasOwnProperty.call(patch, 'model') &&
                (!currentLabelCustomized || preset.label.trim() === preset.model.trim())
              ? nextModel
              : preset.label;

        return createQaPreset({
          ...preset,
          ...patch,
          model: nextModel,
          label: nextLabel,
          labelCustomized: nextLabelCustomized,
        });
      }),
    }));
  }, []);

  const addQaModelPreset = useCallback(() => {
    const nextPreset: QaModelPreset = createQaPreset({
      baseUrl: '',
      model: '',
      label: '',
      apiKey: '',
      labelCustomized: false,
    });

    setReaderSecrets((current) => ({
      ...current,
      qaModelPresets: [...current.qaModelPresets, nextPreset],
    }));
  }, []);

  const removeQaModelPreset = useCallback((presetId: string) => {
    const nextPresets = qaModelPresets.filter((preset) => preset.id !== presetId);

    if (nextPresets.length === 0 || nextPresets.length === qaModelPresets.length) {
      return;
    }

    setReaderSecrets((current) => ({
      ...current,
      qaModelPresets: nextPresets,
    }));

    const fallbackPresetId = nextPresets[0]?.id ?? DEFAULT_QA_PRESET_ID;

    setSettings((current) => ({
      ...current,
      qaActivePresetId:
        current.qaActivePresetId === presetId ? fallbackPresetId : current.qaActivePresetId,
      translationModelPresetId:
        current.translationModelPresetId === presetId
          ? fallbackPresetId
          : current.translationModelPresetId,
      selectionTranslationModelPresetId:
        current.selectionTranslationModelPresetId === presetId
          ? fallbackPresetId
          : current.selectionTranslationModelPresetId,
      summaryModelPresetId:
        current.summaryModelPresetId === presetId
          ? fallbackPresetId
          : current.summaryModelPresetId,
      reviewModelPresetId:
        current.reviewModelPresetId === presetId
          ? fallbackPresetId
          : current.reviewModelPresetId,
      agentModelPresetId:
        current.agentModelPresetId === presetId
          ? fallbackPresetId
          : current.agentModelPresetId,
    }));
  }, [qaModelPresets]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const defaultPaths = await getAppDefaultPaths();

        if (cancelled) {
          return;
        }

        setAppDefaultPaths(defaultPaths);
        const legacySecrets = loadSecrets();
        let nextConfig = mergeReaderConfigWithDefaults(
          null,
          loadSettings(),
          legacySecrets,
          defaultPaths,
        );

        try {
          const parsedConfig = await readReaderConfigFile(defaultPaths);
          if (parsedConfig) {
            nextConfig = mergeReaderConfigWithDefaults(
              parsedConfig,
              loadSettings(),
              legacySecrets,
              defaultPaths,
            );
          }
        } catch {
        }
        if (cancelled) {
          return;
        }

        let nativeLibrarySettings: LibrarySettings | null = null;

        try {
          nativeLibrarySettings = await getLibrarySettings();
        } catch {
        }

        const configZoteroDir = nextConfig.zoteroLocalDataDir.trim();
        const nativeZoteroDir = nativeLibrarySettings?.zoteroLocalDataDir.trim() ?? '';
        const resolvedZoteroDir = nativeZoteroDir || configZoteroDir;
        const hydratedSecrets = nextConfig.secrets ?? DEFAULT_SECRETS;

        setSettings(nextConfig.settings);
        setReaderSecrets(hydratedSecrets);
        setZoteroLocalDataDir(resolvedZoteroDir);
        setLibrarySettings(nativeLibrarySettings);
        if (nativeLibrarySettings && configZoteroDir && !nativeZoteroDir) {
          const syncedSettings = await updateLibrarySettings({
            ...nativeLibrarySettings,
            zoteroLocalDataDir: configZoteroDir,
          });

          setLibrarySettings(syncedSettings);
          emitLibrarySettingsUpdated(syncedSettings, 'reader-config-hydration');
        }
      } finally {
        if (!cancelled) {
          setConfigHydrated(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleLibrarySettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<LibrarySettingsUpdatedEventDetail>).detail;

      if (!detail?.settings || detail.source?.startsWith('reader')) {
        return;
      }

      setLibrarySettings(detail.settings);
      setZoteroLocalDataDir(detail.settings.zoteroLocalDataDir.trim());
    };

    window.addEventListener(LIBRARY_SETTINGS_UPDATED_EVENT, handleLibrarySettingsUpdated);

    return () => {
      window.removeEventListener(LIBRARY_SETTINGS_UPDATED_EVENT, handleLibrarySettingsUpdated);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    emitUiLanguageChanged(settings.uiLanguage);
  }, [settings]);

  useEffect(() => {
    const mineruCacheDir = settings.mineruCacheDir.trim();

    if (!configHydrated || !mineruCacheDir) {
      return;
    }

    void approveWritePath(mineruCacheDir).catch((error) => {
      console.error('Failed to approve the configured MinerU cache directory.', error);
    });
  }, [configHydrated, settings.mineruCacheDir]);

  useEffect(() => {
    if (qaModelPresets.some((preset) => preset.id === settings.qaActivePresetId)) {
      return;
    }

    const fallbackPresetId = qaModelPresets[0]?.id ?? DEFAULT_QA_PRESET_ID;

    setSettings((current) => ({
      ...current,
      qaActivePresetId: fallbackPresetId,
    }));
  }, [qaModelPresets, settings.qaActivePresetId]);

  useEffect(() => {
    if (!configHydrated || !appDefaultPaths) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const nextConfig: Partial<ReaderConfigFile> = {
        version: READER_CONFIG_VERSION,
        settings,
        secrets: readerSecrets,
        zoteroLocalDataDir,
        leftSidebarCollapsed: false,
      };

      void writeReaderConfigFile(nextConfig, appDefaultPaths)
        .then(() => {
          window.localStorage.removeItem(SECRETS_STORAGE_KEY);
        })
        .catch((error) => {
          console.error('Failed to persist reader config to file.', error);
        });
    }, CONFIG_WRITE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    appDefaultPaths,
    configHydrated,
    readerSecrets,
    settings,
    zoteroLocalDataDir,
  ]);

  useEffect(() => {
    if (legacyModelPresetMigrationDoneRef.current) {
      return;
    }

    legacyModelPresetMigrationDoneRef.current = true;

    const nextPresets = buildLegacyModelPresets(settings, readerSecrets);
    const hasPresetMismatch =
      nextPresets.length !== qaModelPresets.length ||
      nextPresets.some((preset, index) => qaModelPresets[index]?.id !== preset.id);
    const fallbackPresetId = nextPresets[0]?.id ?? DEFAULT_QA_PRESET_ID;
    const nextTranslationPresetId =
      resolveModelPreset(nextPresets, settings.translationModelPresetId)?.id ?? fallbackPresetId;
    const nextSelectionTranslationPresetId =
      resolveModelPreset(nextPresets, settings.selectionTranslationModelPresetId)?.id ??
      nextTranslationPresetId;
    const nextSummaryPresetId =
      resolveModelPreset(nextPresets, settings.summaryModelPresetId)?.id ?? fallbackPresetId;
    const nextReviewPresetId =
      resolveModelPreset(nextPresets, settings.reviewModelPresetId)?.id ?? nextSummaryPresetId;
    const nextAgentPresetId =
      resolveModelPreset(nextPresets, settings.agentModelPresetId)?.id ?? fallbackPresetId;
    const nextQaPresetId =
      resolveModelPreset(nextPresets, settings.qaActivePresetId)?.id ?? fallbackPresetId;
    const nextTranslationPreset =
      resolveModelPreset(nextPresets, nextTranslationPresetId) ?? DEFAULT_QA_PRESET;
    const nextSummaryPreset =
      resolveModelPreset(nextPresets, nextSummaryPresetId) ?? DEFAULT_QA_PRESET;
    const nextEmbeddingPreset =
      resolveModelPreset(nextPresets, settings.ragEmbeddingModelPresetId) ?? DEFAULT_QA_PRESET;

    if (hasPresetMismatch) {
      setReaderSecrets((current) => ({
        ...current,
        qaModelPresets: nextPresets,
        translationApiKey: nextTranslationPreset.apiKey,
        summaryApiKey: nextSummaryPreset.apiKey,
        embeddingApiKey: current.embeddingApiKey || nextEmbeddingPreset.apiKey,
      }));
    } else if (
      readerSecrets.translationApiKey !== nextTranslationPreset.apiKey ||
      readerSecrets.summaryApiKey !== nextSummaryPreset.apiKey ||
      (!readerSecrets.embeddingApiKey && nextEmbeddingPreset.apiKey)
    ) {
      setReaderSecrets((current) => ({
        ...current,
        translationApiKey: nextTranslationPreset.apiKey,
        summaryApiKey: nextSummaryPreset.apiKey,
        embeddingApiKey: current.embeddingApiKey || nextEmbeddingPreset.apiKey,
      }));
    }

    if (
      settings.translationModelPresetId !== nextTranslationPresetId ||
      settings.selectionTranslationModelPresetId !== nextSelectionTranslationPresetId ||
      settings.summaryModelPresetId !== nextSummaryPresetId ||
      settings.reviewModelPresetId !== nextReviewPresetId ||
      settings.agentModelPresetId !== nextAgentPresetId ||
      settings.qaActivePresetId !== nextQaPresetId ||
      settings.translationBaseUrl !== nextTranslationPreset.baseUrl ||
      settings.translationModel !== nextTranslationPreset.model ||
      settings.summaryBaseUrl !== nextSummaryPreset.baseUrl ||
      settings.summaryModel !== nextSummaryPreset.model ||
      !settings.embeddingBaseUrl ||
      !settings.embeddingModel
    ) {
      setSettings((current) => ({
        ...current,
        translationModelPresetId: nextTranslationPresetId,
        selectionTranslationModelPresetId: nextSelectionTranslationPresetId,
        summaryModelPresetId: nextSummaryPresetId,
        reviewModelPresetId: nextReviewPresetId,
        agentModelPresetId: nextAgentPresetId,
        qaActivePresetId: nextQaPresetId,
        translationBaseUrl: nextTranslationPreset.baseUrl,
        translationModel: nextTranslationPreset.model,
        summaryBaseUrl: nextSummaryPreset.baseUrl,
        summaryModel: nextSummaryPreset.model,
        embeddingBaseUrl: current.embeddingBaseUrl || nextEmbeddingPreset.baseUrl,
        embeddingModel: current.embeddingModel || nextEmbeddingPreset.model,
      }));
    }
  }, [
    qaModelPresets,
    readerSecrets,
    settings,
  ]);

  useEffect(() => {
    const fallbackPresetId = qaModelPresets[0]?.id ?? DEFAULT_QA_PRESET_ID;
    const nextTranslationPresetId =
      resolveModelPreset(qaModelPresets, settings.translationModelPresetId)?.id ?? fallbackPresetId;
    const nextSelectionTranslationPresetId =
      resolveModelPreset(qaModelPresets, settings.selectionTranslationModelPresetId)?.id ??
      nextTranslationPresetId;
    const nextSummaryPresetId =
      resolveModelPreset(qaModelPresets, settings.summaryModelPresetId)?.id ?? fallbackPresetId;
    const nextReviewPresetId =
      resolveModelPreset(qaModelPresets, settings.reviewModelPresetId)?.id ?? nextSummaryPresetId;
    const nextAgentPresetId =
      resolveModelPreset(qaModelPresets, settings.agentModelPresetId)?.id ?? fallbackPresetId;
    const nextQaPresetId =
      resolveModelPreset(qaModelPresets, settings.qaActivePresetId)?.id ?? fallbackPresetId;
    const nextTranslationPreset =
      resolveModelPreset(qaModelPresets, nextTranslationPresetId) ?? DEFAULT_QA_PRESET;
    const nextSummaryPreset =
      resolveModelPreset(qaModelPresets, nextSummaryPresetId) ?? DEFAULT_QA_PRESET;

    if (
      settings.translationModelPresetId !== nextTranslationPresetId ||
      settings.selectionTranslationModelPresetId !== nextSelectionTranslationPresetId ||
      settings.summaryModelPresetId !== nextSummaryPresetId ||
      settings.reviewModelPresetId !== nextReviewPresetId ||
      settings.agentModelPresetId !== nextAgentPresetId ||
      settings.qaActivePresetId !== nextQaPresetId ||
      settings.translationBaseUrl !== nextTranslationPreset.baseUrl ||
      settings.translationModel !== nextTranslationPreset.model ||
      settings.summaryBaseUrl !== nextSummaryPreset.baseUrl ||
      settings.summaryModel !== nextSummaryPreset.model
    ) {
      setSettings((current) => ({
        ...current,
        translationModelPresetId: nextTranslationPresetId,
        selectionTranslationModelPresetId: nextSelectionTranslationPresetId,
        summaryModelPresetId: nextSummaryPresetId,
        reviewModelPresetId: nextReviewPresetId,
        agentModelPresetId: nextAgentPresetId,
        qaActivePresetId: nextQaPresetId,
        translationBaseUrl: nextTranslationPreset.baseUrl,
        translationModel: nextTranslationPreset.model,
        summaryBaseUrl: nextSummaryPreset.baseUrl,
        summaryModel: nextSummaryPreset.model,
      }));
    }

    if (
      readerSecrets.translationApiKey !== nextTranslationPreset.apiKey ||
      readerSecrets.summaryApiKey !== nextSummaryPreset.apiKey
    ) {
      setReaderSecrets((current) => ({
        ...current,
        translationApiKey: nextTranslationPreset.apiKey,
        summaryApiKey: nextSummaryPreset.apiKey,
      }));
    }
  }, [
    qaModelPresets,
    readerSecrets.summaryApiKey,
    readerSecrets.translationApiKey,
    settings.agentModelPresetId,
    settings.qaActivePresetId,
    settings.reviewModelPresetId,
    settings.selectionTranslationModelPresetId,
    settings.summaryBaseUrl,
    settings.summaryModel,
    settings.summaryModelPresetId,
    settings.translationBaseUrl,
    settings.translationModel,
    settings.translationModelPresetId,
  ]);

  return {
    appDefaultPaths,
    configHydrated,
    l,
    qaModelPresets,
    readerSecrets,
    selectionTranslationModelPreset,
    setReaderSecrets,
    setSettings,
    settings,
    librarySettings,
    setZoteroLocalDataDir,
    summaryConfigured,
    summaryModelPreset,
    syncNativeLibraryZoteroDir,
    translationModelPreset,
    updateNativeLibrarySettings,
    updateQaModelPreset,
    updateReaderSecret,
    updateSetting,
    addQaModelPreset,
    removeQaModelPreset,
    zoteroLocalDataDir,
  };
}
