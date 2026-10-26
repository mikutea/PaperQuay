import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
  const store = useMemo(localConfigStore, []);
  const [config, setConfig] = useState(() => store?.load(props.accountScope) ?? defaultAiProvider());
  const [settingsOpen, setSettingsOpen] = useState(!config.model || !props.context);
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
  const password = useRef<HTMLInputElement>(null);
  const lifecycle = useRef(0);
  const secretAbort = useRef<AbortController | null>(null);
  const controller = useMemo(() => new AiSessionController(new AiClient(props.secretStore, props.transport)), [props.secretStore, props.transport]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const prepared = useMemo(() => {
    try { return { context: prepareAiContext(props.context), failure: null }; }
    catch (error) { return { context: null, failure: aiFailure(error, 'CONTEXT_INVALID') }; }
  }, [props.context]);
  const parsed = useMemo(() => {
    try { return parseAiProvider(config); } catch { return null; }
  }, [config]);
  const contextIdentity = prepared.context?.identity ?? (props.context ? 'invalid' : 'missing');
  const configIdentity = JSON.stringify(config);

  useLayoutEffect(() => () => {
    lifecycle.current++; secretAbort.current?.abort(); controller.dispose();
  }, [controller]);
  useLayoutEffect(() => {
    lifecycle.current++; setSaving(false); setNotice('');
    if (parsed) controller.bind(props.accountScope, parsed, props.context);
    else controller.credentialsChanged();
  }, [controller, props.accountScope.accountId, props.accountScope.apiBaseUrl, contextIdentity, configIdentity]);

  useEffect(() => {
    const abort = new AbortController();
    const guard = new AiRequestGuard(abort.signal, AI_LIMITS.probeTimeoutMs);
    setKeyState('checking');
    void (async () => {
      try {
        if (!parsed) { setKeyState('missing'); return; }
        const namespace = await guard.wait(aiSecretNamespace(props.accountScope, parsed));
        guard.check();
        const value = await guard.wait(props.secretStore.get(namespace, AI_SECRET_KEY));
        guard.check(); setKeyState(value ? 'present' : 'missing');
      } catch { if (!abort.signal.aborted) setKeyState('failed'); }
      finally { guard.close(); }
    })();
    return () => { abort.abort(); guard.close(); };
  }, [props.secretStore, props.accountScope.accountId, props.accountScope.apiBaseUrl, parsed?.endpoint, parsed?.id, secretRevision]);

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
      controller.bind(props.accountScope, safe, props.context);
      setLocalFailure(null);
      return safe;
    } catch (error) { setLocalFailure(aiFailure(error, 'SETTINGS_STORAGE_FAILED')); return null; }
  }

  async function changeKey(remove: boolean) {
    const safe = saveConfig();
    if (!safe) return;
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
      if (secretAbort.current !== abort || abort.signal.aborted) return;
      setSecretRevision((current) => current + 1);
      setNotice(remove ? '已移除此服务在本设备上的密钥。' : props.secretStore.persistence === 'system' ? '密钥已写入本设备的系统安全存储。' : '密钥仅存于当前应用内存，刷新后需要重新输入。');
    } catch (error) {
      if (!abort.signal.aborted && secretAbort.current === abort) setLocalFailure(aiFailure(error, 'SECRET_STORAGE_FAILED'));
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
  return <section className="ai-workspace" aria-label="阅读辅助">
    <header className="ai-heading">
      <div><span className="ai-eyebrow">阅读辅助</span><h2>从正在读的内容开始</h2></div>
      <span className="ai-device-badge">本设备配置</span>
    </header>

    <details className="ai-settings" open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
      <summary>模型服务 <span>{config.model || '尚未选择模型'}</span></summary>
      <div className="ai-settings-content">
        <p className="ai-muted">直接连接你配置的模型服务。只有点击测试或发送才会联网；密钥与 AI 会话不进入文库同步。</p>
        <label htmlFor={id + '-endpoint'}>API 基础地址</label>
        <input id={id + '-endpoint'} type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          placeholder="https://api.example.com/v1" value={config.endpoint} onChange={(event) => editConfig({ endpoint: event.target.value })} />
        <p className="ai-field-help">填写包含 /v1 等前缀的基础地址，不包含 /chat/completions、账号或查询参数。</p>
        {parsed?.endpoint.startsWith('http:') && <p className="ai-warning">此地址使用 HTTP，文字和密钥不受 HTTPS 加密保护，也可能被浏览器或系统网络策略阻止。</p>}
        {!parsed && <p className="ai-error" role="alert">{describeAiError({ code: 'CONFIG_INVALID' })}</p>}
        <div className="ai-model-row">
          <div><label htmlFor={id + '-model'}>模型 ID</label>
            <input id={id + '-model'} list={id + '-models'} autoCapitalize="none" autoCorrect="off" spellCheck={false}
              placeholder="输入模型 ID，或先测试连接" value={config.model} onChange={(event) => editConfig({ model: event.target.value })} />
            <datalist id={id + '-models'}>{snapshot.models.map((model) => <option key={model} value={model} />)}</datalist></div>
          <button type="button" className="secondary" disabled={busy || secretBusy || !parsed}
            onClick={() => { if (saveConfig()) void controller.probe(); }}>{snapshot.busy === 'probe' ? '正在测试…' : '测试连接 / 获取模型'}</button>
        </div>
        {snapshot.connection === 'reachable' && <p className="ai-success" role="status">已连通模型列表接口，获取 {snapshot.models.length} 个模型。推理权限与费用仍需向服务商确认。</p>}
        <div className="ai-key-header"><label htmlFor={id + '-key'}>API 密钥</label>
          <span>{keyState === 'present' ? '本设备已配置' : keyState === 'checking' ? '正在检查存储…' : keyState === 'failed' ? '存储暂不可用' : '尚未配置'}</span></div>
        <input id={id + '-key'} ref={password} type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          placeholder="输入新密钥；已保存的密钥不会回显" disabled={secretBusy} onChange={(event) => setHasKeyDraft(event.target.value.length > 0)} />
        <div className="ai-key-actions">
          <button type="button" className="secondary" disabled={secretBusy || !hasKeyDraft || !parsed} onClick={() => void changeKey(false)}>{secretBusy ? '正在处理…' : '保存本设备密钥'}</button>
          <button type="button" className="text-button" disabled={secretBusy || keyState !== 'present' || !parsed} onClick={() => void changeKey(true)}>移除密钥</button>
          <span className="ai-field-help">{props.secretStore.persistence === 'system' ? '使用系统 Keychain / Keystore。' : 'Web 版仅保存在内存，刷新即清除。'}</span>
        </div>
        <div className="ai-options">
          <label><input type="checkbox" checked={config.requiresKey} onChange={(event) => editConfig({ requiresKey: event.target.checked })} />服务需要 API 密钥</label>
          <label><input type="checkbox" checked={config.stream} onChange={(event) => editConfig({ stream: event.target.checked })} />流式输出</label>
          <label><input type="checkbox" checked={config.includeUsage} disabled={!config.stream} onChange={(event) => editConfig({ includeUsage: event.target.checked })} />请求用量统计</label>
        </div>
        {!config.requiresKey && <p className="ai-field-help">将不发送 Authorization，仅适用于你明确配置的免密服务。</p>}
        {config.stream && props.transport?.supportsStreaming === false && <p className="ai-field-help">当前传输不支持流式读取，将等待完整响应后显示。</p>}
        <details className="ai-advanced"><summary>兼容与输出设置</summary><div className="ai-model-row">
          <div><label htmlFor={id + '-tokens'}>最大输出 tokens</label><input id={id + '-tokens'} type="number" min={64} max={8192} step={1} value={config.maxOutputTokens}
            onChange={(event) => editConfig({ maxOutputTokens: Number(event.target.value) })} /></div>
          <div><label htmlFor={id + '-parameter'}>输出上限参数</label><select id={id + '-parameter'} value={config.tokenParameter}
            onChange={(event) => editConfig({ tokenParameter: event.target.value as AiProviderConfig['tokenParameter'] })}>
            <option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens（部分兼容服务）</option>
          </select></div>
        </div><p className="ai-field-help">参数不兼容时请手动更改。失败请求不会自动重试。</p></details>
        <button type="button" className="text-button" disabled={secretBusy || !parsed} onClick={() => { if (saveConfig()) setNotice(store ? '模型设置已保存在当前账号的本机。' : '模型设置仅保留在当前页面。'); }}>保存模型设置</button>
      </div>
    </details>

    <div className="ai-context">
      <div className="ai-context-top"><h3>本次发送范围</h3><span>{context?.scopeLabel ?? '尚未选择文字'}</span></div>
      {context ? <>
        <p className="ai-context-title">{context.source.label}</p>
        <div className="ai-context-facts"><span>第 {context.pageIndices.map((page) => page + 1).join('、')} 页</span><span>{context.characters.toLocaleString()} 字符</span><span>{(context.bytes / 1024).toFixed(1)} KiB</span></div>
        <p className="ai-field-help">{context.completeDocument ? '已取得各页可提取文本；图像和未识别的扫描内容不在本次输入中。' : '仅根据这里列出的文字作答，不代表已阅读全文。'}</p>
        <details className="ai-context-preview"><summary>查看将发送的原文</summary>{context.source.pages.map((page) => <div key={page.pageIndex}><h4>第 {page.pageIndex + 1} 页</h4><pre>{page.text || '此页没有可提取文本。'}</pre></div>)}</details>
      </> : <p className="ai-muted">{describeAiError(prepared.failure ?? { code: 'CONTEXT_MISSING' })}</p>}
    </div>

    <form className="ai-composer" onSubmit={(event) => { event.preventDefault(); setNotice(''); if (saveConfig(true)) { setVisibleRequestId(null); void controller.start(action, question); } }}>
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
          : <button key="send" type="submit" className="primary" disabled={!context || !parsed?.model || secretBusy || (config.requiresKey && keyState !== 'present') || (action === 'ask' && !question.trim())}>发送并{actionName}</button>}
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
      <pre className="ai-output">{result.text || (result.status === 'running' ? '正在等待模型响应…' : '服务没有返回可显示的文字。')}</pre>
      {!!result.citations.length && <div className="ai-citations" aria-label="本次文本的引用页面"><span>返回原文</span>{result.citations.map((citation) => <button key={citation.pageNumber} type="button" className="secondary"
        onClick={() => { if (controller.hasResult(result.requestId)) props.onNavigateCitation(citation.target); }}>第 {citation.pageNumber} 页</button>)}</div>}
      {!!result.unverifiedPageNumbers.length && <p className="ai-warning">模型提及了本次未提供的第 {result.unverifiedPageNumbers.join('、')} 页；这些引用未经核验，不能跳转。</p>}
      <p className="ai-field-help">页码按钮只定位本次提供的页面，引用内容仍需你核对。</p>
      <div className="ai-usage"><span>{result.usage ? `输入 ${result.usage.promptTokens} · 输出 ${result.usage.completionTokens} · 合计 ${result.usage.totalTokens} tokens` : '用量未知：服务商尚未返回完整统计'}</span><span>费用未知，以服务商账单为准</span></div>
      <button type="button" className="secondary" disabled={!result.text.trim() || result.status === 'running' || saving} onClick={() => void saveNote(result.requestId)}>{saving ? '正在保存…' : result.status === 'complete' ? '保存为文献笔记' : '将部分结果保存为笔记'}</button>
    </section>}
  </section>;
}
