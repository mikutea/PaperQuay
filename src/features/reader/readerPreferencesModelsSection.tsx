import clsx from 'clsx';
import { Plus, RefreshCw, Settings2, TestTube2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type {
  ModelReasoningEffort,
  ModelRuntimeConfig,
  ModelRuntimeRole,
  OpenAICompatibleApiMode,
  OpenAICompatibleModelListResult,
  OpenAICompatibleTestResult,
  QaModelPreset,
  ReaderSettings,
} from '../../types/reader';
import {
  getModelRuntimeConfig,
  MODEL_API_MODE_OPTIONS,
  MODEL_REASONING_OPTIONS,
  normalizeModelRuntimeConfig,
  normalizeModelTemperature,
  resolveModelPreset,
} from './readerShared';
import {
  SettingsField,
  SettingsInput,
  SettingsSelect,
} from './readerPreferencesPrimitives';
import type {
  ReaderPreferencesLocalizer,
  ReaderSettingsChangeHandler,
} from './readerPreferencesTypes';
import { ReaderPreferencesAccountModel } from './readerPreferencesAccountModel';

const modelPresetActionClassName =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--pq-border)] bg-[var(--pq-surface-1)] px-3 text-xs font-medium text-[var(--pq-text)] transition enabled:hover:bg-[var(--pq-hover)] disabled:cursor-not-allowed disabled:opacity-50';

type ModelPresetSettingKey =
  | 'translationModelPresetId'
  | 'selectionTranslationModelPresetId'
  | 'summaryModelPresetId'
  | 'reviewModelPresetId'
  | 'agentModelPresetId'
  | 'qaActivePresetId';

interface ModelRoleBinding {
  key: string;
  runtimeRole: ModelRuntimeRole;
  settingKey: ModelPresetSettingKey;
  title: string;
  description: string;
}

interface ReaderPreferencesModelsSectionProps {
  active: boolean;
  l: ReaderPreferencesLocalizer;
  uiLanguage: ReaderSettings['uiLanguage'];
  settings: ReaderSettings;
  qaModelPresets: QaModelPreset[];
  onSettingChange: ReaderSettingsChangeHandler;
  onListLlmModels: (preset: QaModelPreset) => Promise<OpenAICompatibleModelListResult>;
  onTestLlmConnection: (preset?: QaModelPreset) => Promise<OpenAICompatibleTestResult>;
  onQaModelPresetAdd: () => void;
  onQaModelPresetRemove: (presetId: string) => void;
  onQaModelPresetChange: (presetId: string, patch: Partial<QaModelPreset>) => void;
}

function buildModelRoleBindings(l: ReaderPreferencesLocalizer): ModelRoleBinding[] {
  return [
    {
      key: 'translation',
      runtimeRole: 'translation',
      settingKey: 'translationModelPresetId',
      title: l('文档翻译', 'Document Translation'),
      description: l('Full translation, batch translation, and MinerU block translation.', 'Full translation, batch translation, and MinerU block translation.',
      ),
    },
    {
      key: 'selection-translation',
      runtimeRole: 'selectionTranslation',
      settingKey: 'selectionTranslationModelPresetId',
      title: l('划词翻译', 'Selection Translation'),
      description: l('Quick translation for selected text in the reader.', 'Quick translation for selected text in the reader.',
      ),
    },
    {
      key: 'summary',
      runtimeRole: 'summary',
      settingKey: 'summaryModelPresetId',
      title: l('论文概览', 'Paper Overview'),
      description: l('Paper overview, library preview overview, and batch overview generation.', 'Paper overview, library preview overview, and batch overview generation.',
      ),
    },
    {
      key: 'review',
      runtimeRole: 'review',
      settingKey: 'reviewModelPresetId',
      title: l('综述写作', 'Review Writing'),
      description: l(
        '用于论文综述蓝图规划、分段写作和 Word 导出数据生成。',
        'Used for review blueprint planning, paragraph drafting, and Word export data generation.',
      ),
    },
    {
      key: 'agent',
      runtimeRole: 'agent',
      settingKey: 'agentModelPresetId',
      title: 'Agent 工具调用模型',
      description: l('Used for tool selection, parameter generation, and batch library operations.', 'Used for tool selection, parameter generation, and batch library operations.',
      ),
    },
    {
      key: 'qa',
      runtimeRole: 'qa',
      settingKey: 'qaActivePresetId',
      title: l('问答默认模型', 'Default QA Model'),
      description: l('Default model for the paper QA assistant.', 'Default model for the paper QA assistant.',
      ),
    },
  ];
}

function formatRuntimeConfig(
  l: ReaderPreferencesLocalizer,
  runtimeConfig: ModelRuntimeConfig,
): string {
  const temperatureLabel =
    typeof runtimeConfig.temperature === 'number'
      ? `Temp ${runtimeConfig.temperature}`
      : l('Temp 默认', 'Temp default');
  const reasoningLabel =
    runtimeConfig.reasoningEffort && runtimeConfig.reasoningEffort !== 'auto'
      ? `${l('Reasoning', 'Reasoning')} ${runtimeConfig.reasoningEffort}`
      : l('推理自动', 'Reasoning auto');

  return `${temperatureLabel} · ${reasoningLabel}`;
}

export function ReaderPreferencesModelsSection({
  active,
  l,
  uiLanguage,
  settings,
  qaModelPresets,
  onSettingChange,
  onListLlmModels,
  onTestLlmConnection,
  onQaModelPresetAdd,
  onQaModelPresetRemove,
  onQaModelPresetChange,
}: ReaderPreferencesModelsSectionProps) {
  const [presetModelListLoadingMap, setPresetModelListLoadingMap] = useState<Record<string, boolean>>({});
  const [presetModelListResultMap, setPresetModelListResultMap] = useState<
    Record<string, OpenAICompatibleModelListResult | null>
  >({});
  const [presetModelListErrorMap, setPresetModelListErrorMap] = useState<Record<string, string>>({});
  const [presetTestLoadingMap, setPresetTestLoadingMap] = useState<Record<string, boolean>>({});
  const [presetTestResultMap, setPresetTestResultMap] = useState<
    Record<string, OpenAICompatibleTestResult | null>
  >({});
  const [expandedModelConfigKey, setExpandedModelConfigKey] = useState<string | null>(null);
  const modelRoleBindings = buildModelRoleBindings(l);

  const handleListModelPresetModels = async (preset: QaModelPreset) => {
    setPresetModelListLoadingMap((current) => ({
      ...current,
      [preset.id]: true,
    }));
    setPresetModelListErrorMap((current) => ({
      ...current,
      [preset.id]: '',
    }));

    try {
      const result = await onListLlmModels(preset);
      setPresetModelListResultMap((current) => ({
        ...current,
        [preset.id]: result,
      }));
    } catch (nextError) {
      setPresetModelListErrorMap((current) => ({
        ...current,
        [preset.id]:
          nextError instanceof Error
            ? nextError.message
            : l('读取模型列表失败', 'Failed to load the model list'),
      }));
    } finally {
      setPresetModelListLoadingMap((current) => ({
        ...current,
        [preset.id]: false,
      }));
    }
  };

  const handleTestModelPreset = async (preset: QaModelPreset) => {
    setPresetTestLoadingMap((current) => ({
      ...current,
      [preset.id]: true,
    }));
    setPresetTestResultMap((current) => ({
      ...current,
      [preset.id]: null,
    }));

    try {
      const result = await onTestLlmConnection(preset);
      setPresetTestResultMap((current) => ({
        ...current,
        [preset.id]: result,
      }));
    } catch (nextError) {
      setPresetTestResultMap((current) => ({
        ...current,
        [preset.id]: {
          ok: false,
          endpoint: preset.baseUrl.trim(),
          model: preset.model.trim(),
          latencyMs: 0,
          message: nextError instanceof Error ? nextError.message : l('模型测试失败', 'Model test failed'),
        },
      }));
    } finally {
      setPresetTestLoadingMap((current) => ({
        ...current,
        [preset.id]: false,
      }));
    }
  };

  const handleModelRuntimeConfigChange = (
    role: ModelRuntimeRole,
    patch: Partial<ModelRuntimeConfig>,
  ) => {
    const currentConfig = getModelRuntimeConfig(settings, role);

    onSettingChange('modelRuntimeConfigs', {
      ...settings.modelRuntimeConfigs,
      [role]: normalizeModelRuntimeConfig({
        ...currentConfig,
        ...patch,
      }),
    });
  };

  if (!active) {
    return null;
  }

  return (
    <>
      <ReaderPreferencesAccountModel l={l} presets={qaModelPresets} activePresetId={settings.qaActivePresetId} />
      <SettingsField
        label={l('模型预设', 'Model Presets')}
        description={l(
          '为翻译、概览和问答配置 OpenAI 兼容模型。',
          'Configure OpenAI-compatible models for translation, overview, and QA.',
        )}
      >
        <div className="space-y-3">
          {qaModelPresets.map((preset) => {
            const modelListResult = presetModelListResultMap[preset.id];
            const loadedModels = modelListResult?.models ?? [];
            const selectedModelInList = loadedModels.some((model) => model.id === preset.model);
            const modelListError = presetModelListErrorMap[preset.id];

            return (
              <div
                key={preset.id}
                className="rounded-2xl border border-[var(--pq-border)] bg-[var(--pq-surface-2)] p-4"
              >
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 truncate text-sm font-semibold text-[var(--pq-text)]">
                  {preset.label || preset.model || l('未命名预设', 'Unnamed Preset')}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">
                  <button
                    type="button"
                    onClick={() => void handleListModelPresetModels(preset)}
                    disabled={!preset.baseUrl.trim() || Boolean(presetModelListLoadingMap[preset.id])}
                    className={modelPresetActionClassName}
                    title={l('读取模型列表', 'Load model list')}
                  >
                    <RefreshCw
                      className={clsx('h-3.5 w-3.5', presetModelListLoadingMap[preset.id] && 'animate-spin')}
                      strokeWidth={1.9}
                    />
                    <span>
                      {presetModelListLoadingMap[preset.id]
                        ? l('读取中…', 'Loading…')
                        : l('读取模型', 'Load Models')}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleTestModelPreset(preset)}
                    disabled={
                      !preset.baseUrl.trim() ||
                      !preset.model.trim() ||
                      !preset.apiKey.trim() ||
                      Boolean(presetTestLoadingMap[preset.id])
                    }
                    className={modelPresetActionClassName}
                    title={l('测试模型连接', 'Test model connection')}
                  >
                    <TestTube2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                    <span>
                      {presetTestLoadingMap[preset.id]
                        ? l('测试中…', 'Testing…')
                        : l('测试', 'Test')}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onQaModelPresetRemove(preset.id)}
                    disabled={qaModelPresets.length <= 1}
                    className={clsx(modelPresetActionClassName, 'enabled:hover:text-[var(--pq-danger)]')}
                    title={l('删除模型预设', 'Delete model preset')}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                    <span>{l('删除', 'Delete')}</span>
                  </button>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="text-xs font-medium text-[var(--pq-text-muted)]">
                    {l('显示名称', 'Display Name')}
                  </div>
                  <SettingsInput
                    value={preset.label}
                    onChange={(event) =>
                      onQaModelPresetChange(preset.id, { label: event.target.value })
                    }
                    placeholder={l('例如：DeepSeek Chat', 'Example: DeepSeek Chat')}
                  />
                </div>
                <div className="space-y-2">
                  <div className="text-xs font-medium text-[var(--pq-text-muted)]">
                    {l('模型名称', 'Model Name')}
                  </div>
                  {loadedModels.length > 0 ? (
                    <SettingsSelect
                      value={selectedModelInList ? preset.model : ''}
                      onChange={(event) => {
                        if (event.target.value) {
                          onQaModelPresetChange(preset.id, { model: event.target.value });
                        }
                      }}
                    >
                      <option value="">
                        {preset.model && !selectedModelInList
                          ? l(`当前手动填写：${preset.model}`, `Manual value: ${preset.model}`)
                          : l('选择已读取的模型', 'Select a loaded model')}
                      </option>
                      {loadedModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.id}
                        </option>
                      ))}
                    </SettingsSelect>
                  ) : null}
                  <SettingsInput
                    value={preset.model}
                    onChange={(event) =>
                      onQaModelPresetChange(preset.id, { model: event.target.value })
                    }
                    placeholder="gpt-4o-mini / deepseek-chat / qwen-plus"
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <div className="text-xs font-medium text-[var(--pq-text-muted)]">
                    {l('地址', 'Endpoint')}
                  </div>
                  <SettingsInput
                    value={preset.baseUrl}
                    onChange={(event) =>
                      onQaModelPresetChange(preset.id, { baseUrl: event.target.value })
                    }
                    placeholder="https://api.openai.com"
                  />
                </div>
                <div className="space-y-2">
                  <div className="text-xs font-medium text-[var(--pq-text-muted)]">
                    {l('接口格式', 'API Format')}
                  </div>
                  <SettingsSelect
                    value={preset.apiMode}
                    onChange={(event) =>
                      onQaModelPresetChange(preset.id, {
                        apiMode: event.target.value as OpenAICompatibleApiMode,
                      })
                    }
                  >
                    {MODEL_API_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {l(option.labelZh, option.labelEn)}
                      </option>
                    ))}
                  </SettingsSelect>
                  <div className="text-xs leading-5 text-[var(--pq-text-muted)]">
                    {
                      MODEL_API_MODE_OPTIONS.find((option) => option.value === preset.apiMode)?.[
                        uiLanguage === 'en-US' ? 'descriptionEn' : 'descriptionZh'
                      ]
                    }
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="text-xs font-medium text-[var(--pq-text-muted)]">API Key</div>
                  <SettingsInput
                    value={preset.apiKey}
                    onChange={(event) =>
                      onQaModelPresetChange(preset.id, { apiKey: event.target.value })
                    }
                    type="password"
                    placeholder={l(
                      '输入该模型预设的 API Key',
                      'Enter the API key for this preset',
                    )}
                  />
                </div>
              </div>

              {!preset.baseUrl.trim() || !preset.model.trim() || !preset.apiKey.trim() ? (
                <div className="mt-3 rounded-xl border border-[var(--pq-border)] bg-[var(--pq-warning-bg)] px-3 py-2 text-xs leading-5 text-[var(--pq-text)]">
                  {l(
                    '请填写地址、模型名称和 API Key，再测试或使用此预设。',
                    'Fill in the base URL, model name, and API key before testing or using this preset.',
                  )}
                </div>
              ) : null}

              {modelListResult ? (
                <div className="mt-3 break-words rounded-xl border border-[var(--pq-accent-border)] bg-[var(--pq-accent-bg)] px-3 py-2 text-xs leading-5 text-[var(--pq-text)]">
                  {l(
                    `已从 ${modelListResult.endpoint} 读取 ${loadedModels.length} 个模型。`,
                    `Loaded ${loadedModels.length} models from ${modelListResult.endpoint}.`,
                  )}
                </div>
              ) : null}

              {modelListError ? (
                <div className="mt-3 break-words rounded-xl border border-[var(--pq-border)] bg-[var(--pq-error-bg)] px-3 py-2 text-xs leading-5 text-[var(--pq-text)]">
                  {modelListError}
                </div>
              ) : null}

              {presetTestResultMap[preset.id] ? (
                <div
                  className={clsx(
                    'mt-3 rounded-xl border border-[var(--pq-border)] px-3 py-2 text-xs leading-5 text-[var(--pq-text)]',
                    presetTestResultMap[preset.id]?.ok
                      ? 'bg-[var(--pq-success-bg)]'
                      : 'bg-[var(--pq-error-bg)]',
                  )}
                >
                  <div className="font-medium">
                    {presetTestResultMap[preset.id]?.ok
                      ? l('连接成功', 'Connection Succeeded')
                      : l('连接失败', 'Connection Failed')}
                    {presetTestResultMap[preset.id]?.latencyMs
                      ? ` · ${presetTestResultMap[preset.id]!.latencyMs} ms`
                      : ''}
                  </div>
                  <div className="mt-1 break-all">
                    {l('端点', 'Endpoint')}:{' '}
                    {presetTestResultMap[preset.id]?.endpoint || l('不可用', 'Unavailable')}
                  </div>
                  <div className="mt-1 break-all">
                    {l('模型', 'Model')}:{' '}
                    {presetTestResultMap[preset.id]?.responseModel ||
                      presetTestResultMap[preset.id]?.model ||
                      l('不可用', 'Unavailable')}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap">
                    {presetTestResultMap[preset.id]?.message}
                  </div>
                </div>
              ) : null}
              </div>
            );
          })}

          <button
            type="button"
            onClick={onQaModelPresetAdd}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--pq-border-strong)] bg-[var(--pq-surface-1)] px-4 text-sm font-medium text-[var(--pq-text)] transition hover:bg-[var(--pq-hover)]"
          >
            <Plus className="h-4 w-4" strokeWidth={1.9} />
            <span>{l('新增模型预设', 'Add Model Preset')}</span>
          </button>
        </div>
      </SettingsField>

      <SettingsField
        label={l('功能角色绑定', 'Feature Role Binding')}
        description={l('Choose default presets for document translation, selection translation, overview, review writing, QA, and Agent tool use.', 'Choose default presets for document translation, selection translation, overview, review writing, QA, and Agent tool use.',
        )}
      >
        <div className="space-y-3">
          {modelRoleBindings.map((binding) => {
            const selectedPresetId = settings[binding.settingKey];
            const selectedPreset = resolveModelPreset(qaModelPresets, selectedPresetId);
            const runtimeConfig = getModelRuntimeConfig(settings, binding.runtimeRole);
            const expanded = expandedModelConfigKey === binding.key;

            return (
              <div
                key={binding.key}
                className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-white/10 dark:bg-[var(--pq-sidebar)]"
              >
                <div className="grid gap-3 lg:grid-cols-[minmax(150px,220px)_minmax(0,1fr)_auto] lg:items-center">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-[var(--pq-text)]">
                      {binding.title}
                    </div>
                    <div className="mt-1 text-xs leading-5 text-slate-500 dark:text-[var(--pq-text-faint)]">
                      {binding.description}
                    </div>
                  </div>
                  <SettingsSelect
                    value={selectedPresetId}
                    onChange={(event) => onSettingChange(binding.settingKey, event.target.value)}
                  >
                    {qaModelPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label || preset.model}
                      </option>
                    ))}
                  </SettingsSelect>
                  <button
                    type="button"
                    onClick={() => setExpandedModelConfigKey(expanded ? null : binding.key)}
                    disabled={!selectedPreset}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-muted)] dark:hover:bg-[var(--pq-surface-2)]"
                  >
                    <Settings2 className="h-4 w-4" strokeWidth={1.8} />
                    {l('配置', 'Configure')}
                  </button>
                </div>
                <div className="mt-2 text-[11px] leading-5 text-slate-400 dark:text-[var(--pq-text-faint)]">
                  {selectedPreset
                    ? `${selectedPreset.label || selectedPreset.model} · ${formatRuntimeConfig(l, runtimeConfig)}`
                    : l('未选择模型预设', 'No model preset selected')}
                </div>

                {expanded && selectedPreset ? (
                  <div className="mt-3 grid gap-3 rounded-2xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[var(--pq-surface-1)] md:grid-cols-2">
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-slate-500 dark:text-[var(--pq-text-faint)]">
                        {l('温度', 'Temperature')}
                      </div>
                      <SettingsInput
                        type="number"
                        min={0}
                        max={2}
                        step={0.05}
                        value={runtimeConfig.temperature ?? ''}
                        onChange={(event) =>
                          handleModelRuntimeConfigChange(binding.runtimeRole, {
                            temperature: normalizeModelTemperature(event.target.value),
                          })
                        }
                        placeholder={l('默认', 'Default')}
                      />
                      <div className="text-[11px] leading-5 text-slate-400 dark:text-[var(--pq-text-faint)]">
                        {l('Leave blank to use each feature default; 0.1-0.3 is recommended for translation/overview.', 'Leave blank to use each feature default; 0.1-0.3 is recommended for translation/overview.',
                        )}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-slate-500 dark:text-[var(--pq-text-faint)]">
                        {l('Reasoning Effort', 'Reasoning Effort')}
                      </div>
                      <SettingsSelect
                        value={runtimeConfig.reasoningEffort ?? 'auto'}
                        onChange={(event) =>
                          handleModelRuntimeConfigChange(binding.runtimeRole, {
                            reasoningEffort: event.target.value as ModelReasoningEffort,
                          })
                        }
                      >
                        {MODEL_REASONING_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {l(option.labelZh, option.labelEn)}
                          </option>
                        ))}
                      </SettingsSelect>
                      <div className="text-[11px] leading-5 text-slate-400 dark:text-[var(--pq-text-faint)]">
                        {
                          MODEL_REASONING_OPTIONS.find(
                            (option) => option.value === (runtimeConfig.reasoningEffort ?? 'auto'),
                          )?.[uiLanguage === 'en-US' ? 'descriptionEn' : 'descriptionZh']
                        }
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </SettingsField>
    </>
  );
}

