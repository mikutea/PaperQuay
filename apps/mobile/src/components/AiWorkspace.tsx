import {ModelRoutingPanel} from './ModelRoutingPanel.tsx';
import { Icon } from './Icon.tsx';
import { SettingsRow } from './MobileSettings.tsx';
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ACCOUNT_MODEL_ID } from '../../../../packages/ai-core/src/accountModel.ts';
import { AccountModelContext } from '../ai/accountModelSession.ts';
import { ClientError } from '../errors.ts';
import { AiArchivePanel } from './AiArchivePanel.tsx';
import { AiSyncPanel } from './AiSyncPanel.tsx';
import type { AiSyncEntry } from '../integration/aiSync.ts';
import type { AiConversationData } from '../../../../packages/ai-core/src/conversation.ts';
import { AI_CONVERSATION_LIMITS } from '../../../../packages/ai-core/src/conversation.ts';
import { AiClient } from '../ai/client.ts';
import { AI_ACTION_LABELS, aiResultNote, prepareAiContext } from '../ai/context.ts';
import { AiSessionController } from '../ai/controller.ts';
import { AiError, aiFailure, describeAiError } from '../ai/errors.ts';
import { AI_SECRET_KEY, LocalAiConfigStore, aiAccountKey, aiSecretNamespace, checkedApiKey, defaultAiProvider, parseAiProvider } from '../ai/provider.ts';
import { AiRequestGuard } from '../ai/transport.ts';
import { AI_LIMITS, type AiAction, type AiFailure, type AiProviderConfig, type AiWorkspaceProps } from '../ai/types.ts';

function localConfigStore(): LocalAiConfigStore | null {
  try { return typeof localStorage === 'undefined' ? null : new LocalAiConfigStore(localStorage); }
  catch { return null; }
}

export function AiWorkspace(props: AiWorkspaceProps) {
  let account: string;
  try { account = aiAccountKey(props.accountScope); }
  catch { return <p role="alert">当前账号范围无效，请重新登录后打开阅读辅助。</p>; }
  // Account changes discard draft questions, output and pending credential operations.
  return <AccountAiWorkspace key={account} {...props} />;
}

function AccountAiWorkspace(props: AiWorkspaceProps) {
  const id = useId();
  const accountModel = useContext(AccountModelContext);
  const settingsOnly = props.mode === 'settings';
  const readingContext = settingsOnly ? null : props.context;
  const store = useMemo(localConfigStore, []);
  const [config, setConfig] = useState(() => store?.load(props.accountScope) ?? defaultAiProvider());
  const [savedConfigIdentity, setSavedConfigIdentity] = useState(() => JSON.stringify(config));
  const savedConfig = useRef(config);
  const editingBaseline = useRef(JSON.stringify(config));
  const editingRevision = useRef<number | null>(accountModel?.snapshot.available ? accountModel.snapshot.revision : null);
  const [settingsOpen, setSettingsOpen] = useState(!config.model || !props.context);
  const [settingsView, setSettingsView] = useState<'overview' | 'external' | 'shared' | 'account'>('overview');
  const editingAccount = settingsView === 'account';
  const settingsHeading = useRef<HTMLHeadingElement>(null);
  const [action, setAction] = useState<AiAction>('explain');
  const [question, setQuestion] = useState('');
  const [localFailure, setLocalFailure] = useState<AiFailure | null>(null);
  const [notice, setNotice] = useState('');
  const [keyState, setKeyState] = useState<'checking' | 'present' | 'missing' | 'failed'>('checking');
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretRevision, setSecretRevision] = useState(0);
  const [hasKeyDraft, setHasKeyDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visibleRequestId, setVisibleRequestId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const requestConversations = useRef(new Map<string, AiSyncEntry<AiConversationData> | undefined>());
  const password = useRef<HTMLInputElement>(null);
  const lifecycle = useRef(0);
  const secretAbort = useRef<AbortController | null>(null);
  const controller = useMemo(() => new AiSessionController(new AiClient(props.secretStore, props.transport)), [props.secretStore, props.transport]);
  const archiveDraft = useMemo(() => ({ action, question }), [action, question]);
  const captureRecord = useCallback((requestId: string) => controller.historyRecord(requestId), [controller]);
  const canCaptureRecord = useCallback((requestId: string) => controller.hasResult(requestId), [controller]);
  const applyArchiveDraft = useCallback((nextAction: AiAction, nextQuestion: string) => {
    if (controller.getSnapshot().busy) return;
    setAction(nextAction); setQuestion(nextQuestion); setLocalFailure(null); setNotice('');
  }, [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const prepared = useMemo(() => {
    try { return { context: prepareAiContext(readingContext), failure: null }; }
    catch (error) { return { context: null, failure: aiFailure(error, 'CONTEXT_INVALID') }; }
  }, [readingContext]);
  const parsed = useMemo(() => {
    try { return parseAiProvider(config); } catch { return null; }
  }, [config]);
  const contextIdentity = prepared.context?.identity ?? (readingContext ? 'invalid' : 'missing');
  const configIdentity = JSON.stringify(config);
  const conversation = props.sync?.conversations.find(entry => entry.id === conversationId);
  const conversationFull = Boolean(conversation && conversation.data.turns.length >= AI_CONVERSATION_LIMITS.turns);
  useEffect(() => {
    if (conversationId && (!conversation || prepareAiContext(conversation.data.context).identity !== contextIdentity)) setConversationId(null);
  }, [conversationId, conversation, contextIdentity]);
  const selectConversation = (entry: AiSyncEntry<AiConversationData> | null) => {
    if (controller.getSnapshot().busy) return;
    if (entry) {
      if (!props.onRestoreContext && prepareAiContext(entry.data.context).identity !== contextIdentity) throw new AiError('CONTEXT_INVALID');
      props.onRestoreContext?.(structuredClone(entry.data.context));
    }
    setConversationId(entry?.id ?? null); setLocalFailure(null); setNotice('');
  };
  const continuationFor = useCallback((requestId: string) => requestConversations.current.get(requestId), []);
  function startGeneration() {
    if (settingsOnly) return;
    if (conversationFull) { setLocalFailure({ code: 'CONVERSATION_LIMIT' }); return; }
    if (!saveConfig(true)) return;
    const previous = controller.getSnapshot().result?.requestId;
    const captured = conversation ? structuredClone(conversation) : undefined;
    setVisibleRequestId(null); setNotice('');
    void controller.start(action, question, captured?.data);
    const requestId = controller.getSnapshot().result?.requestId;
    if (requestId && requestId !== previous) {
      requestConversations.current.set(requestId, captured);
      while (requestConversations.current.size > 4) requestConversations.current.delete(requestConversations.current.keys().next().value!);
    }
  }

  useLayoutEffect(() => () => {
    lifecycle.current++; secretAbort.current?.abort(); controller.dispose();
    if (password.current) password.current.value = '';
  }, [controller]);
  useLayoutEffect(() => {
    lifecycle.current++; setSaving(false); setNotice('');
    if (parsed) controller.bind(props.accountScope, parsed, readingContext);
    else controller.credentialsChanged();
  }, [controller, props.accountScope.accountId, props.accountScope.apiBaseUrl, contextIdentity, configIdentity]);

  useEffect(() => {
    const abort = new AbortController();
    const guard = new AiRequestGuard(abort.signal, AI_LIMITS.probeTimeoutMs);
    setKeyState('checking');
    void (async () => {
      try {
        if (!parsed) { setKeyState('missing'); return; }
        if(parsed.execution){setKeyState('missing');return;}
        const namespace = await guard.wait(aiSecretNamespace(props.accountScope, parsed));
        guard.check();
        const value = await guard.wait(props.secretStore.get(namespace, AI_SECRET_KEY));
        guard.check(); setKeyState(value ? 'present' : 'missing');
      } catch { if (!abort.signal.aborted) setKeyState('failed'); }
      finally { guard.close(); }
    })();
    return () => { abort.abort(); guard.close(); };
  }, [props.secretStore, props.accountScope.accountId, props.accountScope.apiBaseUrl, parsed?.endpoint, parsed?.id, secretRevision, accountModel?.snapshot.revision, accountModel?.snapshot.approved]);

  function editConfig(change: Partial<AiProviderConfig>) {
    controller.credentialsChanged();
    setLocalFailure(null); setNotice('');
    if (Object.hasOwn(change, 'endpoint')) {
      secretAbort.current?.abort(); setSecretBusy(false);
      if (password.current) password.current.value = '';
      setHasKeyDraft(false); setKeyState('checking');
    }
    setConfig((current) => ({ ...current, ...change }));
  }

  function saveConfig(requireModel = false): AiProviderConfig | null {
    try {
      const safe = parseAiProvider(config, requireModel);
      if (store) store.save(props.accountScope, safe);
      else setNotice('浏览器存储不可用，模型设置仅保留在当前页面。');
      controller.bind(props.accountScope, safe, readingContext);
      setSavedConfigIdentity(JSON.stringify(config));
      savedConfig.current = safe;
      editingBaseline.current = JSON.stringify(config);
      setLocalFailure(null);
      return safe;
    } catch (error) { setLocalFailure(aiFailure(error, 'SETTINGS_STORAGE_FAILED')); return null; }
  }

  async function changeKey(remove: boolean) {
    const safe = saveConfig();
    if (!safe) return false;
    controller.credentialsChanged();
    secretAbort.current?.abort();
    const abort = new AbortController(); secretAbort.current = abort;
    const guard = new AiRequestGuard(abort.signal, AI_LIMITS.probeTimeoutMs);
    setSecretBusy(true); setNotice(''); setLocalFailure(null);
    try {
      // Read only at the explicit click. Never put the draft or loaded key in React state.
      const value = remove ? null : checkedApiKey(password.current?.value ?? '');
      if (password.current) password.current.value = '';
      setHasKeyDraft(false);
      const namespace = await guard.wait(aiSecretNamespace(props.accountScope, safe));
      guard.check();
      await guard.wait(remove ? props.secretStore.remove(namespace, AI_SECRET_KEY) : props.secretStore.set(namespace, AI_SECRET_KEY, value!));
      guard.check();
      if (secretAbort.current !== abort || abort.signal.aborted) return false;
      setSecretRevision((current) => current + 1);
      setNotice(remove ? '已移除此服务在本设备上的密钥。' : props.secretStore.persistence === 'system' ? '设置已保存，访问密钥已存入此设备。' : '设置已保存。此环境的访问密钥仅保留到应用关闭或页面刷新。');
      return true;
    } catch (error) {
      if (!abort.signal.aborted && secretAbort.current === abort) setLocalFailure(aiFailure(error, 'SECRET_STORAGE_FAILED'));
      return false;
    } finally {
      guard.close();
      if (secretAbort.current === abort) { setSecretBusy(false); secretAbort.current = null; }
    }
  }

  async function saveNote(requestId: string) {
    const current = controller.getSnapshot();
    const result = current.result?.requestId === requestId ? current.result : current.previousResult;
    if (!result || result.requestId !== requestId || saving) return;
    const generation = lifecycle.current;
    setSaving(true); setNotice(''); setLocalFailure(null);
    try {
      const source = controller.saveContext(result.requestId);
      const note = aiResultNote(result);
      // Capture the current callback and scope before the first await.
      await props.onSaveNote(note, source);
      if (generation === lifecycle.current) setNotice('已保存为文献笔记，可在笔记中继续编辑。');
    } catch {
      if (generation === lifecycle.current) setNotice('笔记未保存，请检查当前账号和附件版本后重试。');
    } finally { if (generation === lifecycle.current) setSaving(false); }
  }

  const failure = localFailure ?? snapshot.failure;
  const result = snapshot.previousResult?.requestId === visibleRequestId ? snapshot.previousResult : snapshot.result;
  const showingPrevious = Boolean(result && result.requestId === snapshot.previousResult?.requestId);
  const busy = snapshot.busy !== null;
  const context = prepared.context;
  const actionName = AI_ACTION_LABELS[action];
  const unsavedSettings = (settingsOnly && (settingsView === 'external' || editingAccount) ? editingBaseline.current : savedConfigIdentity) !== configIdentity || hasKeyDraft;
  useLayoutEffect(() => {
    if (settingsOnly) props.onSettingsDirty?.(unsavedSettings);
  }, [settingsOnly, props.onSettingsDirty, unsavedSettings]);
  useEffect(() => () => { if (settingsOnly) props.onSettingsDirty?.(false); }, [settingsOnly, props.onSettingsDirty]);
  useEffect(() => {
    if (settingsView === 'overview' && !unsavedSettings) {
      editingRevision.current = accountModel?.snapshot.available ? accountModel.snapshot.revision : null;
    }
  }, [settingsView, unsavedSettings, accountModel?.snapshot.available, accountModel?.snapshot.revision]);
  useEffect(() => {
    if (!settingsOnly) return;
    settingsHeading.current?.focus({ preventScroll: true });
    settingsHeading.current?.closest('.main-content, .reader-sheet-content')?.scrollTo?.({ top: 0 });
  }, [settingsOnly, settingsView]);
  function clearKeyDraft() {
    secretAbort.current?.abort();
    if (password.current) password.current.value = '';
    setHasKeyDraft(false);
  }
  function openExternalSettings() {
    if (busy || secretBusy) return;
    clearKeyDraft(); setLocalFailure(null); setNotice('');
    const next = config.execution || config.id === ACCOUNT_MODEL_ID
      ? store?.loadExternal(props.accountScope) ?? defaultAiProvider() : config;
    editingBaseline.current = JSON.stringify(next); setConfig(next);
    editingRevision.current = accountModel?.snapshot.available ? accountModel.snapshot.revision : null;
    setSettingsView('external');
  }
  function cancelSettingsEdit() {
    if (busy || secretBusy) return;
    clearKeyDraft(); controller.credentialsChanged();
    setConfig(savedConfig.current); setSavedConfigIdentity(JSON.stringify(savedConfig.current)); editingBaseline.current = JSON.stringify(savedConfig.current);
    setLocalFailure(null); setNotice(''); setSettingsView('overview');
  }
  function useExternal() {
    if (busy || secretBusy) return;
    controller.credentialsChanged(); clearKeyDraft();
    const next = store?.loadExternal(props.accountScope) ?? defaultAiProvider();
    try {
      store?.save(props.accountScope, next); setConfig(next); savedConfig.current = next;
      setSavedConfigIdentity(JSON.stringify(next)); setNotice('已切换到此设备保存的 AI 服务。');
    } catch (error) { setLocalFailure(aiFailure(error)); }
  }
  function useShared(next: AiProviderConfig) {
    if (busy || secretBusy || !props.modelRouter?.current()) return;
    controller.credentialsChanged(); clearKeyDraft();
    try {
      if (!store) throw new AiError('SETTINGS_STORAGE_FAILED');
      store.save(props.accountScope, next); setConfig(next); savedConfig.current = next;
      setSavedConfigIdentity(JSON.stringify(next)); setLocalFailure(null);
      if (settingsOnly) { setSettingsView('overview'); setNotice('已保存模型选择。'); props.onSettingsSaved?.(); }
    } catch (error) { setLocalFailure(aiFailure(error)); throw error; }
  }
  async function saveSettings() {
    const generation = lifecycle.current;
    const hadKeyDraft = hasKeyDraft;
    const saved = hadKeyDraft ? await changeKey(false) : Boolean(saveConfig());
    if (!saved || lifecycle.current !== generation) return;
    if (!hadKeyDraft) setNotice(store ? '设置已保存在此设备。' : '设置仅保留在当前页面，关闭后需重新填写。');
    if (settingsOnly && config.model.trim() && (!config.requiresKey || keyState === 'present' || hadKeyDraft)) {
      setSettingsView('overview'); props.onSettingsSaved?.();
    }
  }

  function selectAccountProvider(next: AiProviderConfig, revision: number | null = null) {
    if (!store) throw new AiError('SETTINGS_STORAGE_FAILED');
    if (next.id === ACCOUNT_MODEL_ID) {
      const session = accountModel?.session;
      const current = session?.getSnapshot();
      if (!session || !current || revision !== current.revision || JSON.stringify(next) !== JSON.stringify(current.provider)) {
        throw new AiError('ACCOUNT_MODEL_CHANGED');
      }
      session.approve(revision);
      store.useAccount(props.accountScope);
    } else store.save(props.accountScope, next);
    controller.credentialsChanged();
    clearKeyDraft();
    setConfig(next);
    savedConfig.current = next;
    const identity = JSON.stringify(next);
    setSavedConfigIdentity(identity);
    editingBaseline.current = identity;
    setLocalFailure(null);
    setSettingsView('overview');
  }

  useEffect(() => {
    if (!accountModel || !store || busy || secretBusy || unsavedSettings || settingsView !== 'overview') return;
    const next = store.load(props.accountScope);
    if (next.id !== ACCOUNT_MODEL_ID && config.id !== ACCOUNT_MODEL_ID) return;
    const identity = JSON.stringify(next);
    if (identity === savedConfigIdentity) return;
    controller.credentialsChanged();
    setConfig(next);
    savedConfig.current = next;
    editingBaseline.current = identity;
    setSavedConfigIdentity(identity);
  }, [accountModel, store, busy, secretBusy, unsavedSettings, settingsView, props.accountScope,
    config.id, savedConfigIdentity, controller]);

  function openAccountSettings() {
    const next = accountModel?.snapshot.provider;
    if (!next || busy || secretBusy) return;
    clearKeyDraft();
    setLocalFailure(null);
    setNotice('');
    editingBaseline.current = JSON.stringify(next);
    editingRevision.current = accountModel?.snapshot.revision ?? null;
    setConfig(next);
    setSettingsView('account');
  }

  async function saveAccountSettings(remove = false) {
    const session = accountModel?.session;
    if (!session || busy || secretBusy) return;
    if (remove && !window.confirm('移除账号模型？各端可以继续使用各自的本机设置。')) return;
    const generation = lifecycle.current;
    setSecretBusy(true);
    try {
      const revision = editingRevision.current;
      if (revision === null || revision !== session.getSnapshot().revision) throw new ClientError('ACCOUNT_MODEL_CHANGED');
      if (remove) {
        await session.write(null, revision);
        if (lifecycle.current !== generation) return;
        const next = store?.loadLocal(props.accountScope) ?? defaultAiProvider();
        selectAccountProvider(next);
        setNotice('已移除账号模型。');
      } else {
        const provider = parseAiProvider(config, true);
        const draft = password.current?.value.trim();
        const apiKey = !provider.requiresKey ? null : draft ? checkedApiKey(draft)
          : await props.secretStore.get(await aiSecretNamespace(props.accountScope, provider), AI_SECRET_KEY);
        if (lifecycle.current !== generation) return;
        if (provider.requiresKey && !apiKey) throw new AiError('KEY_MISSING');
        const savedRevision = await session.write({ provider, apiKey }, revision);
        if (lifecycle.current !== generation) return;
        const next = session.getSnapshot().provider;
        if (!next) throw new AiError('CONFIG_INVALID');
        selectAccountProvider(next, savedRevision);
        setNotice('模型已保存到账号。');
        props.onSettingsSaved?.();
      }
    } catch (error) {
      if (lifecycle.current === generation) setLocalFailure(error instanceof ClientError && error.code === 'ACCOUNT_MODEL_CHANGED'
        ? { code: 'ACCOUNT_MODEL_CHANGED' } : aiFailure(error));
    } finally {
      if (lifecycle.current === generation) setSecretBusy(false);
    }
  }
  const settingsFailure = failure?.code === 'CANCELLED' ? '已停止获取模型列表，可以稍后重新获取。'
    : failure?.code === 'SETTINGS_STORAGE_FAILED' ? '设置未保存。请检查此设备的存储后再试，当前填写的内容仍保留。'
    : failure?.code === 'SECRET_STORAGE_FAILED' ? '访问密钥操作未完成。请重新填写密钥后保存；已有密钥不会显示在这里。'
    : failure ? describeAiError(failure) : '';
  const probeHelp = !parsed ? '先填写有效的服务地址，并检查高级设置。'
    : hasKeyDraft ? '先保存新输入的密钥，再获取模型列表。'
    : config.requiresKey && keyState !== 'present' ? keyState === 'checking' ? '正在检查已保存的密钥…'
      : keyState === 'failed' ? '暂时无法读取密钥，请稍后重新打开设置。' : '先填写访问密钥并保存，再获取模型列表。'
    : '从这个服务获取模型列表；这一步不会发送文献或问题。';
  const routingContent = <ModelRoutingPanel ledgerRevision={props.modelLedgerRevision} scope={props.accountScope} router={props.modelRouter} config={config} busy={busy||secretBusy} showActivity={!settingsOnly}
    picker={settingsOnly} onExternal={useExternal} onChange={useShared} />;
  const settingsContent = <div className="ai-settings-content">
    {!settingsOnly && routingContent}
    {config.id === ACCOUNT_MODEL_ID && !accountModel?.snapshot.approved && <div className="ai-field-help">
      <p>账号模型已更新。确认下方服务地址后，文献内容将发送到此服务。</p>
      <button type="button" className="secondary" disabled={busy || secretBusy || unsavedSettings || !accountModel?.snapshot.provider}
        onClick={() => { try { selectAccountProvider(accountModel!.snapshot.provider!, accountModel!.snapshot.revision); } catch (error) { setLocalFailure(aiFailure(error)); } }}>确认并使用账号模型</button>
    </div>}
    {!config.execution&&<>
      <label htmlFor={id + '-endpoint'}>服务地址</label>
      <input id={id + '-endpoint'} type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        aria-describedby={settingsOnly ? undefined : id + '-endpoint-help'} placeholder="https://api.example.com/v1" value={config.endpoint} onChange={(event) => editConfig({ endpoint: event.target.value })} />
      {!settingsOnly && <p id={id + '-endpoint-help'} className="ai-field-help">使用服务商提供的基础地址，例如 https://api.example.com/v1。</p>}
      {parsed?.endpoint.startsWith('http:') && <p className="ai-warning">此地址使用 HTTP，文字和密钥不受 HTTPS 加密保护，也可能被浏览器或系统网络策略阻止。</p>}
      {!parsed && <p className="ai-error" role="alert">{describeAiError({ code: 'CONFIG_INVALID' })}</p>}
      <div className="ai-key-header"><label htmlFor={id + '-key'}>访问密钥（API Key）</label>
        <span>{keyState === 'present' ? '已保存' : keyState === 'checking' ? '正在检查存储…' : keyState === 'failed' ? '暂时无法读取' : config.requiresKey ? '待填写' : '当前无需密钥'}</span></div>
      <input id={id + '-key'} ref={password} type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        placeholder={keyState === 'present' ? '留空保留已保存的密钥' : '粘贴服务商提供的密钥'} disabled={secretBusy} onChange={(event) => setHasKeyDraft(event.target.value.length > 0)} />
      <div className="ai-key-actions">
        {keyState === 'present' && !editingAccount && config.id !== ACCOUNT_MODEL_ID && <button type="button" className="text-button" disabled={secretBusy || !parsed} onClick={() => void changeKey(true)}>移除密钥</button>}
        <span className="ai-field-help">{config.id === ACCOUNT_MODEL_ID || editingAccount ? '同一账号的已登录设备可以使用此连接。' : props.secretStore.persistence === 'system' ? '本机设置使用系统安全存储。' : '本机密钥随当前浏览器会话使用。'}</span>
      </div>
      <div className="ai-model-row">
        <div><label htmlFor={id + '-model'}>模型名称</label>
          <input id={id + '-model'} list={id + '-models'} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            placeholder="填写模型名称，或获取可用模型" value={config.model} onChange={(event) => editConfig({ model: event.target.value })} />
          <datalist id={id + '-models'}>{snapshot.models.map((model) => <option key={model} value={model} />)}</datalist></div>
        {snapshot.busy === 'probe' ? <button type="button" className="secondary" onClick={() => controller.cancel()}>取消获取</button>
          : <button type="button" className="secondary" disabled={busy || secretBusy || !parsed || hasKeyDraft || (config.requiresKey && keyState !== 'present')}
            aria-describedby={id + '-probe-help'} onClick={() => { if (config.id === ACCOUNT_MODEL_ID || saveConfig()) void controller.probe(); }}>获取可用模型</button>}
      </div>
      <p id={id + '-probe-help'} className="ai-field-help">{snapshot.busy === 'probe' ? '正在获取模型列表…' : probeHelp}</p>
      {snapshot.connection === 'reachable' && <p className="ai-success" role="status">已取得 {snapshot.models.length} 个模型，请在“模型名称”中选择。能否生成回答和实际费用仍由服务商决定。</p>}
      <details className="ai-advanced"><summary>{settingsOnly ? '更多选项' : '高级兼容设置'}</summary>
        <div className="ai-options">
          <label><input type="checkbox" checked={config.requiresKey} onChange={(event) => editConfig({ requiresKey: event.target.checked })} />此服务需要访问密钥</label>
          <label><input type="checkbox" checked={config.stream} onChange={(event) => editConfig({ stream: event.target.checked })} />逐步显示回答</label>
          <label><input type="checkbox" checked={config.includeUsage} disabled={!config.stream} onChange={(event) => editConfig({ includeUsage: event.target.checked })} />请求服务商返回用量</label>
        </div>
        {!config.requiresKey && <p className="ai-field-help">不发送访问密钥，仅适用于你配置的免密服务。</p>}
        {config.stream && props.transport?.supportsStreaming === false && <p className="ai-field-help">此连接会等完整回答收到后一起显示。</p>}
        <div className="ai-model-row">
          <div><label htmlFor={id + '-tokens'}>回答长度上限（tokens）</label><input id={id + '-tokens'} type="number" min={64} max={8192} step={1} value={config.maxOutputTokens}
            onChange={(event) => editConfig({ maxOutputTokens: Number(event.target.value) })} /></div>
          {config.apiMode !== 'responses' && <div><label htmlFor={id + '-parameter'}>服务商使用的上限参数</label><select id={id + '-parameter'} value={config.tokenParameter}
            onChange={(event) => editConfig({ tokenParameter: event.target.value as AiProviderConfig['tokenParameter'] })}>
            <option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens（部分兼容服务）</option>
          </select></div>}
        </div>
        <div><label htmlFor={id + '-api-mode'}>接口类型</label>
          <select id={id + '-api-mode'} value={config.apiMode ?? 'chat_completions'}
            onChange={(event) => editConfig({ apiMode: event.target.value as AiProviderConfig['apiMode'] })}>
            <option value="chat_completions">Chat Completions</option>
            <option value="responses">Responses</option>
          </select>
        </div>
        <p className="ai-field-help">填写服务基础地址。使用 Responses 时也可填写完整的 /responses 地址。</p>
      </details>
      <div className="ai-key-actions">
        {!editingAccount && config.id !== ACCOUNT_MODEL_ID && <button type="button" className="primary" disabled={busy || secretBusy || !parsed}
          onClick={() => void saveSettings()}>{secretBusy ? '正在保存…' : '保存设置'}</button>}
        {(settingsOnly || config.id === ACCOUNT_MODEL_ID) && accountModel?.snapshot.available && <button type="button" className={editingAccount ? 'primary' : 'secondary'}
          disabled={busy || secretBusy || !parsed?.model} onClick={() => void saveAccountSettings()}>
          {secretBusy ? '正在保存…' : '保存到账号'}
        </button>}
        {editingAccount && <button type="button" className="text-button" disabled={busy || secretBusy}
          onClick={() => void saveAccountSettings(true)}>移除账号模型</button>}
      </div>
      {settingsOnly && accountModel?.snapshot.available && <p className="ai-field-help">保存到账号后，其他已登录客户端可以使用同一模型。服务端加密保存密钥。</p>}
      {(!settingsOnly || unsavedSettings || failure?.code === 'SECRET_STORAGE_FAILED') && <p className="ai-field-help" role="status">{failure?.code === 'SECRET_STORAGE_FAILED' ? '访问密钥尚未处理成功，请重新填写后保存。'
        : unsavedSettings ? '有未保存的修改。保存不会发送问题或调用模型。'
        : config.requiresKey && keyState !== 'present' ? '下一步：填写访问密钥并保存。'
        : !config.model ? '下一步：填写模型名称，或获取可用模型后选择。'
        : store ? '已保存。可回到文献中使用阅读辅助，或打开多篇文献问答。' : '仅在当前页面使用，关闭后需重新填写设置。'}</p>}
    </>}
  </div>;
  return <section className={settingsOnly ? 'ai-workspace ai-settings-page' : 'ai-workspace'} aria-label={settingsOnly ? 'AI 服务设置' : '阅读辅助'}>
    {settingsOnly ? <header className="settings-page-header">
      {settingsView === 'overview' ? props.onSettingsBack && <button type="button" className="settings-back" onClick={props.onSettingsBack}><Icon name="back" />{props.settingsBackLabel ?? '设置'}</button>
        : <button type="button" className="settings-back" disabled={busy || secretBusy} onClick={cancelSettingsEdit}><Icon name="back" />{settingsView === 'external' && unsavedSettings ? '取消修改' : 'AI 助手'}</button>}
      <h1 tabIndex={-1} ref={settingsHeading}>{settingsView === 'overview' ? 'AI 助手' : settingsView === 'external' ? '连接自己的 AI' : settingsView === 'account' ? '账号模型' : '选择共享模型'}</h1>
    </header> : <header className="ai-heading">
      <div><span className="ai-eyebrow">阅读辅助</span><h2>从正在读的内容开始</h2></div>
      <span className="ai-device-badge">本设备配置</span>
    </header>}
    {settingsOnly ? settingsView === 'overview' ? <>
      <div className="ai-current-setting"><span className="ai-current-symbol"><Icon name="sparkles" /></span><div><span>当前使用</span>
        <strong>{config.model && (config.execution || !config.requiresKey || keyState === 'present') ? config.model : '尚未设置'}</strong>
        {config.model && <small>{config.id === ACCOUNT_MODEL_ID ? '使用账号模型' : config.execution ? config.execution.target.kind === 'computer' ? '使用电脑上的模型' : '使用账号提供的模型' : config.requiresKey && keyState !== 'present' ? '还需填写访问密钥' : '使用自己的 AI 服务'}</small>}
      </div></div>
      <h2 className="settings-section-label">连接方式</h2>
      {accountModel?.snapshot.provider && <div className="ai-key-actions">
        <p className="ai-field-help">账号模型 {accountModel.snapshot.provider.model}<br />{accountModel.snapshot.provider.endpoint}</p>
        {!accountModel.snapshot.approved && <p className="ai-field-help">使用后，文献内容将发送到以上服务地址。配置更新后会再次确认。</p>}
        {(config.id !== ACCOUNT_MODEL_ID || !accountModel.snapshot.approved) && <button type="button" className="secondary" disabled={busy || secretBusy}
          onClick={() => { try { selectAccountProvider(accountModel.snapshot.provider!, accountModel.snapshot.revision); props.onSettingsSaved?.(); }
            catch (error) { setLocalFailure(aiFailure(error)); } }}>{accountModel.snapshot.approved ? '使用账号模型' : '确认并使用账号模型'}</button>}
        <button type="button" className="secondary" disabled={busy || secretBusy} onClick={openAccountSettings}>编辑账号模型</button>
      </div>}
      {accountModel?.snapshot.error && <p className="ai-field-help" role="status">{accountModel.snapshot.error}</p>}
      <div className="settings-list">
        <SettingsRow icon="device" label="使用账号或电脑上的 AI" detail={props.modelRouter ? '选择共享模型，无需填写密钥' : '当前服务暂不支持共享模型'} disabled={!props.modelRouter} onClick={() => { setNotice(''); setLocalFailure(null); setSettingsView('shared'); }} />
        <SettingsRow icon="sparkles" label="连接自己的 AI 服务" detail="使用自己的服务地址和密钥" onClick={openExternalSettings} />
      </div>
      <p className="settings-caption">设置一次，阅读问答和文献综述都能使用。</p>
    </> : settingsView === 'shared' ? routingContent : <div className="ai-settings">{settingsContent}</div>
      : <details className="ai-settings" open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
      <summary>模型服务 <span>{config.model || '尚未选择模型'}</span></summary>
      {settingsContent}
    </details>}
    {settingsOnly && failure && <p className="ai-error" role="alert">{settingsFailure}</p>}
    {settingsOnly && notice && <p className="ai-notice" role="status">{notice}</p>}

    {!settingsOnly && <>
    <div className="ai-context">
      <div className="ai-context-top"><h3>本次发送范围</h3><span>{context?.scopeLabel ?? '尚未选择文字'}</span></div>
      {context ? <>
        <p className="ai-context-title">{context.source.label}</p>
        <div className="ai-context-facts"><span>第 {context.pageIndices.map((page) => page + 1).join('、')} 页</span><span>{context.characters.toLocaleString()} 字符</span><span>{(context.bytes / 1024).toFixed(1)} KiB</span></div>
        <p className="ai-field-help">{context.coverageDescription}</p>
        <details className="ai-context-preview"><summary>查看将发送的原文</summary>{context.source.pages.map((page) => <div key={page.pageIndex}><h4>第 {page.pageIndex + 1} 页</h4><pre>{page.text || '此页没有可提取文本。'}</pre></div>)}</details>
      </> : <p className="ai-muted">{describeAiError(prepared.failure ?? { code: 'CONTEXT_MISSING' })}</p>}
    </div>

    {conversation && <p className="ai-notice" role="status">正在继续“{conversation.data.title}”：将发送已保存原文与此前 {conversation.data.turns.filter(turn => turn.result.status === 'complete').length} 轮完整问答。原文范围改变会结束本次继续。</p>}
    {conversationFull && <p role="status" className="ai-warning">此会话已达24轮上限。请在“同步会话与模板”中结束继续后另开问答。</p>}
    <form className="ai-composer" onSubmit={(event) => { event.preventDefault(); startGeneration(); }}>
      <div className="ai-action-picker" aria-label="选择辅助任务">{(Object.keys(AI_ACTION_LABELS) as AiAction[]).map((item) =>
        <button key={item} type="button" aria-pressed={action === item} disabled={busy} onClick={() => setAction(item)}>{AI_ACTION_LABELS[item]}</button>)}</div>
      <label htmlFor={id + '-question'}>{action === 'ask' ? '你的问题' : '补充要求（选填）'}</label>
      <textarea id={id + '-question'} rows={3} value={question} disabled={busy} onChange={(event) => setQuestion(event.target.value)}
        placeholder={action === 'ask' ? '例如：这项研究的方法有哪些限制？' : '例如：用中文说明，并保留专业术语。'} />
      <div className="ai-send-row"><p>点击后将上述文字发送给你配置的服务。</p>
        {busy ? <button key="cancel" type="button" className="secondary" onClick={(event) => {
          // cancel() publishes synchronously. Prevent this click from submitting if React replaces the control.
          event.preventDefault(); controller.cancel();
        }}>取消{snapshot.busy === 'probe' ? '测试' : '生成'}</button>
          : <button key="send" type="submit" className="primary" disabled={conversationFull || !context || !parsed?.model || secretBusy || (config.requiresKey && keyState !== 'present') || (action === 'ask' && !question.trim())}>发送并{actionName}</button>}
      </div>
      {config.requiresKey && keyState === 'missing' && <p className="ai-field-help">请先在“模型服务”中保存本设备的 API 密钥。</p>}
    </form>
    {failure && <p className="ai-error" role="alert">{describeAiError(failure)}</p>}
    {notice && <p className="ai-notice" role="status">{notice}</p>}

    {snapshot.previousResult && <div className="ai-result-switch" aria-label="切换内存中的结果">
      <button type="button" aria-pressed={!showingPrevious} onClick={() => setVisibleRequestId(null)}>本次结果</button>
      <button type="button" aria-pressed={showingPrevious} onClick={() => setVisibleRequestId(snapshot.previousResult!.requestId)}>上一次结果</button>
      <span>仅保留在本页，最多两条</span>
    </div>}
    {result && <section className="ai-result" aria-label="模型结果" aria-busy={result.status === 'running'}>
      <div className="ai-result-heading"><h3>{showingPrevious ? '上一次 · ' : ''}{AI_ACTION_LABELS[result.action]}结果</h3><span role="status">{result.status === 'running' ? '正在接收…' : result.status === 'complete' ? '响应完成' : result.status === 'failed' ? '未取得结果' : '部分结果'}</span></div>
      <p className="ai-result-source">{result.source.label} · {result.source.scopeLabel} · 第 {result.source.pageIndices.map((page) => page + 1).join('、')} 页<br />版本 {result.source.attachmentVersionId.slice(0, 8)} · SHA-256 {result.source.sha256.slice(0, 8)} · {result.model}</p>
      {result.source.textSource && <p className="ai-field-help">文字来自导入解析包（摘要 {result.source.textSource.packageDigest.slice(0, 12)}），未发送图片像素；请核对 PDF 原文。</p>}
      <pre className="ai-output">{result.text || (result.status === 'running' ? '正在等待模型响应…' : '服务没有返回可显示的文字。')}</pre>
      {!!result.citations.length && <div className="ai-citations" aria-label="本次文本的引用页面"><span>返回原文</span>{result.citations.map((citation) => <button key={citation.pageNumber} type="button" className="secondary"
        onClick={() => { if (controller.hasResult(result.requestId)) props.onNavigateCitation(citation.target); }}>第 {citation.pageNumber} 页</button>)}</div>}
      {!!result.unverifiedPageNumbers.length && <p className="ai-warning">模型提及了本次未提供的第 {result.unverifiedPageNumbers.join('、')} 页；这些引用未经核验，不能跳转。</p>}
      <p className="ai-field-help">页码按钮只定位本次提供的页面，引用内容仍需你核对。</p>
      <div className="ai-usage"><span>{result.usage ? `输入 ${result.usage.promptTokens} · 输出 ${result.usage.completionTokens} · 合计 ${result.usage.totalTokens} tokens` : '用量未知：服务商尚未返回完整统计'}</span><span>费用未知，以服务商账单为准</span></div>
      <button type="button" className="secondary" disabled={!result.text.trim() || result.status === 'running' || saving} onClick={() => void saveNote(result.requestId)}>{saving ? '正在保存…' : result.status === 'complete' ? '保存为文献笔记' : '将部分结果保存为笔记'}</button>
    </section>}
    <AiSyncPanel key={`sync:${props.archiveEpoch ?? 0}`} bridge={props.sync} draft={archiveDraft}
      currentResult={result?.status === 'running' ? null : result} busy={busy} activeId={conversationId}
      captureRecord={captureRecord} continuationFor={continuationFor} onSelect={selectConversation}
      onSaved={setConversationId} onApplyDraft={applyArchiveDraft} onNavigateCitation={props.onNavigateCitation} />
    <AiArchivePanel accountScope={props.accountScope} resetEpoch={props.archiveEpoch} currentContext={props.context} contextIdentity={prepared.context?.identity ?? null}
      currentResult={result?.status === 'running' ? null : result} busy={busy} draft={archiveDraft}
      captureRecord={captureRecord} canCaptureRecord={canCaptureRecord} onApplyDraft={applyArchiveDraft}
      onNavigateCitation={props.onNavigateCitation} />
    </>}
  </section>;
}
