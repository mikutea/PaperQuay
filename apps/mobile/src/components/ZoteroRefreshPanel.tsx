import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ExternalLibraryError, type ExternalLibraryDecision, type ExternalLibraryImportPlan,
  type ExternalLibraryResolution, type ExternalLibrarySummary } from '../library/externalLibrary.ts';
import { ZoteroClient, ZoteroClientError, validateZoteroApiKey, validateZoteroConfig, validateZoteroCursor,
  zoteroSecretNamespace, ZOTERO_SECRET_KEY, type ZoteroAccountScope, type ZoteroCredential,
  type ZoteroLibraryConfig } from '../library/zoteroClient.ts';
import { refreshZoteroLibrary, type ZoteroRefreshResult } from '../library/zoteroRefresh.ts';
import type { SecretStore } from '../platform/secretStore.ts';

export interface ZoteroRefreshPanelProps {
  scopeKey: string; accountScope: ZoteroAccountScope; accountCurrent: () => boolean; secretStore: SecretStore;
  initialConfig?: ZoteroLibraryConfig;
  getCursor: (config: ZoteroLibraryConfig) => number | null;
  /** Always calculate from the current account registry and visible paper state. */
  preview: (result: ZoteroRefreshResult, decisions: readonly ExternalLibraryDecision[]) => ExternalLibraryImportPlan;
  /** Compare expectedCursor and signature again inside the papers/mappings/outbox/cursor transaction. */
  onAdopt: (result: ZoteroRefreshResult, decisions: readonly ExternalLibraryDecision[], signature: string,
    scopeKey: string) => Promise<ExternalLibrarySummary>;
  paperLabel?: (paperId: string) => string;
  onBusyChange?: (busy: boolean) => void;
  client?: ZoteroClient;
}
interface Review {
  result: ZoteroRefreshResult; baseSignature: string; plan: ExternalLibraryImportPlan; decisions: ExternalLibraryDecision[];
}
const fields: Record<string, string> = { title: '标题', authors: '作者', year: '年份', doi: 'DOI', publication: '出版来源', abstractText: '摘要', keywords: '关键词' };
const actions: Record<string, string> = { create: '新增文献', link: '关联已有文献', update: '更新题录', unchanged: '保留当前题录', skip: '跳过', blocked: '需要处理' };
const reasons: Record<string, string> = {
  DUPLICATE_CHOICE_REQUIRED: '发现重复题录，请明确关联、另存副本或跳过。', FIELD_CONFLICT: '来源和本地均有改动，请选择冲突字段的处理方式。',
  SOURCE_VERSION_REUSED: '来源在相同版本号下提供了不同内容，不能采用。', TARGET_MISSING: '关联文献在当前文库中不可用。',
  TARGET_DELETED: '关联文献已删除，本次不恢复它。', TARGET_PENDING: '关联文献仍有待同步内容或冲突，请先处理。',
  TARGET_ALREADY_LINKED: '候选文献已经关联其他来源条目。', INVALID_LINK_TARGET: '关联候选已经改变。',
};
function display(value: unknown) { return value == null || value === '' ? '未提供' : Array.isArray(value) ? value.join('；') || '未提供' : String(value); }
function errorMessage(error: unknown): string {
  if (error instanceof ZoteroClientError) {
    const messages: Record<ZoteroClientError['code'], string> = {
      INVALID_CONFIG: '请填写有效的个人库或群组库 ID 和名称。', INVALID_CURSOR: '本机保存的来源版本与服务器不一致，需重新建立来源版本后再更新。',
      INVALID_KEY: 'Zotero 密钥格式不正确，请使用 Zotero 的专用 API 密钥。', MISSING_KEY: '本次没有可用的 Zotero 密钥，请输入或先保存专用密钥。',
      SECRET_UNAVAILABLE: '无法读取本设备的安全密钥存储。', CANCELLED: '已取消本次读取，文库和来源版本没有变化。',
      CHANGED: '账号、来源或已保存版本已变化，本次读取已取消。', TIMEOUT: '读取超过时间上限，本轮内容已丢弃，可稍后重试。',
      NETWORK: '无法连接 Zotero，请检查网络后重试。', AUTHORIZATION: 'Zotero 拒绝访问，请核对文库 ID 和密钥的读取权限。',
      NOT_FOUND: 'Zotero 未找到此文库，请核对文库 ID。', HTTP_ERROR: 'Zotero 暂未完成本次请求，请稍后重试。',
      INVALID_RESPONSE: '来源数据或分页版本无法完整核验，本轮内容已丢弃。', LIMIT: '本轮超过 500 条变更、4 MiB 或请求上限，不能部分采用。',
      INVALID_METADATA: '来源题录不符合文献规范，请先在 Zotero 中补全空标题、修正 DOI 或作者后重试。本轮未采用，来源版本未变。',
      VERSION_CHANGED: '读取期间 Zotero 文库持续变化，有界重试后仍不一致；本轮内容已丢弃。',
      RATE_LIMIT: 'Zotero 要求暂缓请求，请在提示时间后重试。', INVALID_RESULT: '此预览已不可用，请重新读取来源。',
    };
    return messages[error.code];
  }
  if (error instanceof ExternalLibraryError) return '当前题录或来源映射无法完成比较，请重新比较后再采用。';
  return '本次操作未完成，请重新核对当前预览后重试。';
}

/** The owner provides account transactions; this component never persists a cursor or modifies Zotero. */
export function ZoteroRefreshPanel(props: ZoteroRefreshPanelProps) {
  const prefix = useId(), fallbackClient = useRef<ZoteroClient>();
  if (!fallbackClient.current) fallbackClient.current = new ZoteroClient();
  const client = props.client ?? fallbackClient.current;
  const [kind, setKind] = useState<'user' | 'group'>(props.initialConfig?.kind ?? 'user');
  const [libraryId, setLibraryId] = useState(props.initialConfig?.libraryId ?? '');
  const [name, setName] = useState(props.initialConfig?.name ?? 'Zotero 文库');
  const [credentialMode, setCredentialMode] = useState<'public' | 'memory' | 'stored'>('public');
  const keyInput = useRef<HTMLInputElement | null>(null);
  const bindKeyInput = useCallback((node: HTMLInputElement | null) => {
    if (keyInput.current && keyInput.current !== node) keyInput.current.value = '';
    keyInput.current = node;
  }, []);
  const [review, setReview] = useState<Review | null>(null);
  const reviewRef = useRef<Review | null>(null);
  const [phase, setPhase] = useState<'reading' | 'adopting' | 'secret' | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const alive = useRef(true), sequence = useRef(0), busy = useRef(false), requestAbort = useRef<AbortController | null>(null);
  const selectionKey = JSON.stringify([kind, libraryId, name, credentialMode]);
  const live = useRef({ props, selectionKey, epoch: 0 });
  const epoch = live.current.epoch + Number(live.current.props.scopeKey !== props.scopeKey || live.current.selectionKey !== selectionKey
    || live.current.props.accountScope.apiBaseUrl !== props.accountScope.apiBaseUrl || live.current.props.accountScope.accountId !== props.accountScope.accountId);
  live.current = { props, selectionKey, epoch };
  const current = () => {
    try { return alive.current && live.current.epoch === epoch && live.current.props.scopeKey === props.scopeKey && live.current.props.accountCurrent(); }
    catch { return false; }
  };
  function markBusy(next: typeof phase) { busy.current = next !== null; setPhase(next); live.current.props.onBusyChange?.(next !== null); }
  function replaceReview(value: Review | null) { reviewRef.current = value; setReview(value); }
  function resetReview() { replaceReview(null); setError(null); setNotice(null); setRetryAt(null); }
  function config() { return validateZoteroConfig({ kind, libraryId, name }); }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; requestAbort.current?.abort(); requestAbort.current = null;
      if (keyInput.current) keyInput.current.value = ''; live.current.props.onBusyChange?.(false); };
  }, []);
  useEffect(() => {
    sequence.current++; requestAbort.current?.abort(); requestAbort.current = null;
    if (busy.current) { busy.current = false; setPhase(null); live.current.props.onBusyChange?.(false); }
    if (keyInput.current) keyInput.current.value = '';
    setKind(props.initialConfig?.kind ?? 'user'); setLibraryId(props.initialConfig?.libraryId ?? '');
    setName(props.initialConfig?.name ?? 'Zotero 文库'); setCredentialMode('public'); resetReview();
  }, [props.scopeKey, props.accountScope.apiBaseUrl, props.accountScope.accountId,
    props.initialConfig?.kind, props.initialConfig?.libraryId, props.initialConfig?.name]);

  let stale = false, cursorChanged = false;
  if (review) {
    try {
      cursorChanged = props.getCursor(review.result.config) !== review.result.expectedCursor;
      stale = cursorChanged || props.preview(review.result, []).signature !== review.baseSignature;
    } catch { stale = true; }
  }
  async function read() {
    if (busy.current || !current()) return;
    const token = ++sequence.current, controller = new AbortController(); requestAbort.current = controller;
    let credential: ZoteroCredential = { mode: 'public' };
    markBusy('reading'); resetReview();
    try {
      const selected = config(), expectedCursor = validateZoteroCursor(live.current.props.getCursor(selected));
      if (credentialMode === 'memory') {
        const value = keyInput.current?.value.trim() ?? ''; if (keyInput.current) keyInput.current.value = '';
        credential = { mode: 'memory', apiKey: validateZoteroApiKey(value) };
      } else if (credentialMode === 'stored') credential = { mode: 'stored', store: props.secretStore, accountScope: props.accountScope };
      const valid = () => current() && token === sequence.current && live.current.props.getCursor(selected) === expectedCursor;
      const result = await refreshZoteroLibrary(client, selected, { expectedCursor, credential, signal: controller.signal, current: valid });
      if (!valid()) return;
      setRetryAt(result.retry.notBefore);
      if (result.unchanged) { setNotice('Zotero 文库没有新的变化；本地题录和来源版本没有改动。'); return; }
      const plan = live.current.props.preview(result, []);
      replaceReview({ result, baseSignature: plan.signature, plan, decisions: [] });
    } catch (cause) {
      if (current() && token === sequence.current) { setError(errorMessage(cause)); if (cause instanceof ZoteroClientError) setRetryAt(cause.retryAt); }
    } finally {
      credential = { mode: 'public' };
      if (alive.current && token === sequence.current) { requestAbort.current = null; markBusy(null); }
    }
  }
  async function keyAction(remove: boolean) {
    if (busy.current || !current()) return;
    const token = ++sequence.current; markBusy('secret'); setError(null); setNotice(null);
    try {
      const namespace = zoteroSecretNamespace(props.accountScope, config());
      const value = remove ? null : validateZoteroApiKey(keyInput.current?.value.trim() ?? '');
      if (keyInput.current) keyInput.current.value = '';
      if (!current()) return;
      if (remove) await props.secretStore.remove(namespace, ZOTERO_SECRET_KEY);
      else await props.secretStore.set(namespace, ZOTERO_SECRET_KEY, value!);
      if (current() && token === sequence.current) setNotice(remove ? '已移除此账号在本设备上保存的该 Zotero 文库密钥。'
        : props.secretStore.persistence === 'system' ? '该文库密钥已写入本设备的系统安全存储。' : '该文库密钥仅保存在当前应用内存中，刷新即清除。');
    } catch (cause) { if (current() && token === sequence.current) setError(errorMessage(cause)); }
    finally { if (alive.current && token === sequence.current) { if (keyInput.current) keyInput.current.value = ''; markBusy(null); } }
  }
  function isFresh(value: Review): boolean {
    if (!current() || busy.current || reviewRef.current !== value) return false;
    try { return live.current.props.getCursor(value.result.config) === value.result.expectedCursor
      && live.current.props.preview(value.result, []).signature === value.baseSignature; } catch { return false; }
  }
  function decide(itemKey: string, action: string) {
    if (!review || !isFresh(review)) return;
    const decisions = review.decisions.filter(decision => decision.itemKey !== itemKey);
    if (action.startsWith('link:')) decisions.push({ itemKey, action: 'link', paperId: action.slice(5) });
    else if (action === 'skip' || action === 'copy') decisions.push({ itemKey, action });
    try { const plan = live.current.props.preview(review.result, decisions); replaceReview({ ...review, decisions, plan }); setError(null); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  function resolve(itemKey: string, resolution: '' | ExternalLibraryResolution) {
    if (!review || !isFresh(review)) return;
    const previous = review.decisions.find(decision => decision.itemKey === itemKey);
    const decisions = review.decisions.filter(decision => decision.itemKey !== itemKey);
    decisions.push(previous?.action === 'link' ? { itemKey, action: 'link', paperId: previous.paperId, ...(resolution ? { resolution } : {}) }
      : { itemKey, action: 'import', ...(resolution ? { resolution } : {}) });
    try { const plan = live.current.props.preview(review.result, decisions); replaceReview({ ...review, decisions, plan }); setError(null); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  function recompare() {
    if (!review || !current() || busy.current) return;
    try {
      if (live.current.props.getCursor(review.result.config) !== review.result.expectedCursor) throw new ZoteroClientError('CHANGED');
      const plan = live.current.props.preview(review.result, []);
      replaceReview({ ...review, plan, baseSignature: plan.signature, decisions: [] }); setError(null); setNotice(null);
    } catch (cause) { setError(errorMessage(cause)); }
  }
  async function adopt() {
    if (!review || review.plan.summary.blocked > 0 || !isFresh(review)) return;
    let fresh: ExternalLibraryImportPlan;
    try { fresh = live.current.props.preview(review.result, review.decisions); } catch { return; }
    if (fresh.signature !== review.plan.signature) return;
    const token = ++sequence.current; markBusy('adopting'); setError(null); setNotice(null);
    try {
      const summary = await live.current.props.onAdopt(review.result, review.decisions, review.plan.signature, props.scopeKey);
      if (!current() || token !== sequence.current) return;
      replaceReview(null); setNotice(`已采用本轮更新：新增 ${summary.newPapers} 篇、关联 ${summary.linkedPapers} 篇、更新 ${summary.updatedPapers} 篇。来源版本与题录一起保存。`);
    } catch (cause) { if (current() && token === sequence.current) setError(errorMessage(cause)); }
    finally { if (alive.current && token === sequence.current) markBusy(null); }
  }
  const plan = review?.plan;
  return <section className="zotero-refresh" aria-label="Zotero 只读增量更新" aria-busy={phase !== null}>
    <h3>从 Zotero 读取更新</h3>
    <p className="muted">填写个人库或群组库的数字 ID，读取题录后核对变化，再明确采用到 PaperQuay。</p>
    <div className="zotero-refresh-config">
      <div className="field"><label htmlFor={`${prefix}-kind`}>文库类型</label><select id={`${prefix}-kind`} value={kind} disabled={phase !== null}
        onChange={event => { if (!busy.current) { setKind(event.target.value as 'user' | 'group'); resetReview(); } }}>
        <option value="user">个人库</option><option value="group">群组库</option></select></div>
      <div className="field"><label htmlFor={`${prefix}-id`}>Zotero 文库 ID</label><input id={`${prefix}-id`} inputMode="numeric" maxLength={16} value={libraryId}
        disabled={phase !== null} onChange={event => { if (!busy.current) { setLibraryId(event.target.value); resetReview(); } }} /></div>
      <div className="field"><label htmlFor={`${prefix}-name`}>本机显示名称</label><input id={`${prefix}-name`} maxLength={256} value={name}
        disabled={phase !== null} onChange={event => { if (!busy.current) { setName(event.target.value); resetReview(); } }} /></div>
      <div className="field"><label htmlFor={`${prefix}-credential`}>读取凭据</label><select id={`${prefix}-credential`} value={credentialMode} disabled={phase !== null}
        onChange={event => { if (!busy.current) { setCredentialMode(event.target.value as typeof credentialMode); if (keyInput.current) keyInput.current.value = ''; resetReview(); } }}>
        <option value="public">公开文库，不使用密钥</option><option value="memory">只在本次读取使用输入的密钥</option><option value="stored">使用本设备为此文库保存的密钥</option></select></div>
    </div>
    <details className="zotero-refresh-secrets"><summary>输入或管理专用 Zotero 密钥</summary>
      <label htmlFor={`${prefix}-key`}>专用 Zotero API 密钥</label>
      <input ref={bindKeyInput} id={`${prefix}-key`} aria-label="专用 Zotero API 密钥" type="password" maxLength={64} autoComplete="off"
        spellCheck={false} disabled={phase !== null} />
      <p className="zotero-refresh-hint">建议使用仅有目标文库读取权限的专用密钥。密钥按当前 PaperQuay 账号和 Zotero 文库隔离；{props.secretStore.persistence === 'system' ? '保存到本设备系统安全存储。' : '此环境只保存在内存，刷新即清除。'}</p>
      <div className="zotero-refresh-buttons"><button type="button" className="secondary" disabled={phase !== null} onClick={() => void keyAction(false)}>保存此文库密钥</button>
        <button type="button" className="secondary" disabled={phase !== null} onClick={() => void keyAction(true)}>移除此文库密钥</button></div>
    </details>
    <p className="zotero-refresh-hint">只向 Zotero 官方 API 发起读取。每轮最多 500 条变更和 4 MiB；笔记、附件、标签分类不导入，远端删除或放入回收站均保留本地文献。读取完成只生成预览。</p>
    <div className="zotero-refresh-buttons"><button type="button" className="secondary" disabled={phase !== null} onClick={() => void read()}>{review ? '重新读取来源' : '读取 Zotero 更新'}</button>
      {phase === 'reading' && <button type="button" className="secondary" onClick={() => requestAbort.current?.abort()}>取消读取</button>}</div>
    {phase === 'reading' && <p role="status">正在核验分页与来源版本…</p>}
    {retryAt !== null && <p className="zotero-refresh-hint">最早重试时间：{new Date(retryAt).toLocaleString()}</p>}
    {review && plan && <section className="zotero-refresh-preview" aria-label="Zotero 更新预览">
      <h4>{review.result.config.name}</h4>
      <p>来源版本 {review.result.expectedCursor ?? '首次读取'} → {review.result.nextCursor}；新增 {plan.summary.newPapers}、更新 {plan.summary.updatedPapers}、待处理 {plan.summary.blocked}。</p>
      {review.result.retry.versionRestarts > 0 && <p className="zotero-refresh-hint">读取期间来源变化，已丢弃不一致轮次并重读 {review.result.retry.versionRestarts} 次；当前各页版本一致。</p>}
      {review.result.ignored.length + review.result.deletedKeys.length > 0 && <details><summary>未导入或删除提示</summary>
        <p>{review.result.ignored.length} 条附件、笔记、附属条目或回收站条目未导入；{review.result.deletedKeys.length} 条远端删除记录只作提示，本地文献保留。</p>
        <ul>{review.result.ignored.map(item => <li key={item.key}>{item.key} · {{ attachment: '附件', note: '笔记', annotation: '批注', child: '附属条目', trashed: '回收站', unsupported: '暂不支持' }[item.reason]}</li>)}
          {review.result.deletedKeys.map(key => <li key={key}>{key} · 远端删除，本地保留</li>)}</ul>
      </details>}
      {review.result.warnings.length > 0 && <p className="zotero-refresh-hint">仅转换当前支持的题录字段：作者保留显示名称，日期只保留年份；卷期页、文献类型、标签分类和附件不随本轮更新。来源 HTML 标记按普通文字显示。</p>}
      {stale && <div role="alert" className="inline-error"><p>{cursorChanged ? '来源版本已被其他操作更新，请重新读取来源。' : '本地文库在预览后已变化，请重新比较；原冲突选择会清除。'}</p>
        {!cursorChanged && <button type="button" className="secondary" disabled={phase !== null} onClick={recompare}>重新比较当前文库</button>}</div>}
      <div className="zotero-refresh-rows">{plan.rows.map((row, index) => {
        const decision = review.decisions.find(item => item.itemKey === row.itemKey);
        const choice = decision?.action === 'link' ? `link:${decision.paperId}` : decision?.action === 'skip' || decision?.action === 'copy' ? decision.action : 'default';
        return <article className="zotero-refresh-row" key={row.itemKey}>
          <h5>{row.title}</h5><p>{actions[row.action]} · {row.itemKey} · 来源条目版本 {row.itemVersion}</p>
          {row.blockedReason && <p className="inline-error">{reasons[row.blockedReason]}</p>}
          <label htmlFor={`${prefix}-choice-${index}`}>处理「{row.title}」</label>
          <select id={`${prefix}-choice-${index}`} value={choice} disabled={phase !== null || stale} onChange={event => decide(row.itemKey, event.target.value)}>
            <option value="default">按预览采用</option><option value="skip">本轮跳过</option>
            {!row.mapped && row.duplicates && <><option value="copy">另存副本</option>{row.duplicates.existingIds.map((paperId, duplicateIndex) =>
              <option key={paperId} value={`link:${paperId}`}>关联：{props.paperLabel?.(paperId) ?? `已有候选 ${duplicateIndex + 1}`}</option>)}</>}
          </select>
          {row.fields.some(field => field.conflict) && row.action !== 'skip' && <><label htmlFor={`${prefix}-resolution-${index}`}>冲突字段的处理</label>
            <select id={`${prefix}-resolution-${index}`} value={row.resolution ?? ''} disabled={phase !== null || stale}
              onChange={event => resolve(row.itemKey, event.target.value as '' | ExternalLibraryResolution)}>
              <option value="">请核对后选择</option><option value="prefer-local">保留本地冲突字段</option><option value="prefer-source">采用来源冲突字段</option></select></>}
          <details><summary>核对题录字段</summary><dl>{row.fields.map(field => <div key={field.field}>
            <dt>{fields[field.field]}{field.conflict ? ' · 冲突' : ''}</dt><dd>来源：{display(field.source)}</dd><dd>当前：{display(field.local)}</dd>
            {field.conflict && <dd>上次来源：{display(field.base)}</dd>}<dd>采用后：{display(field.result)}</dd></div>)}</dl></details>
        </article>;
      })}</div>
      <p className="zotero-refresh-hint">采用会同时保存已审核题录、来源映射和本轮版本。明确跳过的条目仅在后续来源再次变化时进入增量更新。</p>
      <button type="button" className="primary" disabled={phase !== null || stale || plan.summary.blocked > 0} onClick={() => void adopt()}>确认采用这轮更新</button>
    </section>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="zotero-refresh-notice" role="status">{notice}</p>}
  </section>;
}
