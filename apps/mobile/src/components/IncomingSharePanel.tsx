import { useEffect, useRef, useState } from 'react';
import { getIncomingShareClient, incomingShareClientMatchesOwner, IncomingShareError, type IncomingShareClient, type IncomingShareList, type IncomingShareMeta,
  type IncomingShareNotice, type IncomingShareOptions, type IncomingShareSubscription } from '../platform/incomingShare.ts';
import { prepareIncomingShareSource, type PreparedSource } from '../library/incomingShare.ts';
import { ReaderSheet } from './ReaderSheet.tsx';

export interface IncomingSharePanelProps {
  scopeKey: string;
  /** Stable accountScopeKey({apiBaseUrl, accountId}), distinct from session generation. */
  ownerKey: string;
  accountCurrent(): boolean;
  onReview(source: PreparedSource): void | Promise<void>;
  onClose(): void;
  inbox?: IncomingShareClient;
  onBusyChange?(busy: boolean): void;
}
const notices: Record<IncomingShareNotice, string> = {
  FULL: '本机待处理分享已满；新分享未替换已有来源。请核对后移除副本，再从原应用重新分享。',
  UNSUPPORTED: '有分享类型尚不支持，未自动打开来源链接或文件。请从原应用选择受支持的文本/文件重试。',
  TOO_LARGE: '有分享超过文本、文件或整箱大小限制，未自动截断。',
  INVALID: '本机待处理分享中有损坏数据。可重试；仍无法读取时，可确认清空本机副本后重新分享。',
  READ_FAILED: '未能读取分享副本，请重试或从原应用重新分享。',
  STORAGE_UNAVAILABLE: '本机分享存储不可用，请重试；现有来源不会被自动导入。',
};
function errorMessage(error: unknown): string {
  if (error instanceof IncomingShareError) {
    return ({ UNAVAILABLE: '此环境尚未提供系统分享收件箱。', INVALID: '分享数据不符合安全格式；可重试或确认清空本机副本。',
      TOO_LARGE: '分享超过大小限制，未截断或读取为其他格式。', READ_FAILED: '读取分享失败，请重试。', REMOVE_FAILED: '移除失败，待处理副本可能仍在；请刷新核对。',
      CLEAR_FAILED: '清空失败，请刷新核对本机副本。', CHANGED: '账号或分享来源已变化，请重新预览。', CRYPTO_UNAVAILABLE: '无法计算来源校验摘要，未进入导入预览。' } as const)[error.code];
  }
  return '无法处理本次分享，请重试。';
}
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const unsupported = (source: PreparedSource) => source.reason === 'MULTIPLE_DOIS'
  ? '包含多个 DOI，请手工核对；没有自动选择其中一个。'
  : source.reason === 'INVALID_FORMAT' ? '这份文件不能完整解析为受支持的结构，请手工核对或从来源重新导出；没有降格为正文导入。'
    : '普通链接或混合文本不能唯一确认为 DOI，请手工核对；没有自动打开或查询。';

/** Sources belong to the device inbox, not an account. This sheet hands a
 * verified immutable source to the existing review flow; it never imports,
 * resolves a DOI online, removes after success, or opens a source URI. */
export function IncomingSharePanel(props: IncomingSharePanelProps) {
  const inbox = props.inbox ?? getIncomingShareClient(props.ownerKey);
  // Remount state at the account/session boundary, including private previews
  // and remove confirmations. Old callbacks also test the live account guard.
  return <IncomingShareSession key={JSON.stringify([props.scopeKey, props.ownerKey])} {...props} inbox={inbox} />;
}
function IncomingShareSession(props: IncomingSharePanelProps & { inbox: IncomingShareClient }) {
  const latest = useRef(props); latest.current = props;
  const alive = useRef(false), action = useRef(0), listSequence = useRef(0), busy = useRef(false);
  const lifecycle = useRef<AbortController | null>(null), request = useRef<AbortController | null>(null);
  const [listed, setListed] = useState<IncomingShareList>({ items: [], notice: null }), [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<'read' | 'remove' | 'clear' | null>(null), [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null), [preview, setPreview] = useState<PreparedSource | null>(null);
  const [confirmation, setConfirmation] = useState<IncomingShareMeta | 'all' | null>(null);
  const current = () => {
    try { return alive.current && latest.current.scopeKey === props.scopeKey && latest.current.ownerKey === props.ownerKey && latest.current.inbox === props.inbox
      && incomingShareClientMatchesOwner(props.inbox, props.ownerKey) && latest.current.accountCurrent(); }
    catch { return false; }
  };
  const options = (controller: AbortController): IncomingShareOptions => ({ signal: controller.signal, current });
  function markBusy(value: typeof phase) { busy.current = value !== null; setPhase(value); latest.current.onBusyChange?.(value !== null); }
  async function refresh() {
    if (!current()) return;
    const controller = lifecycle.current; if (!controller) return;
    const sequence = ++listSequence.current; setLoading(true);
    try {
      const result = await props.inbox.list(options(controller));
      if (current() && sequence === listSequence.current) { setListed(result); setError(null); }
    } catch (cause) { if (current() && sequence === listSequence.current) { setListed({ items: [], notice: null }); setError(errorMessage(cause)); } }
    finally { if (current() && sequence === listSequence.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); lifecycle.current = controller;
    let subscription: IncomingShareSubscription | undefined;
    void refresh();
    void props.inbox.subscribe(() => { void refresh(); }, options(controller)).then(value => {
      if (current() && !controller.signal.aborted) subscription = value; else void value.remove();
    }).catch(() => { if (current()) setMessage('分享变更提醒不可用，可手动刷新待处理列表。'); });
    return () => {
      alive.current = false; action.current++; listSequence.current++; controller.abort(); request.current?.abort(); request.current = null;
      lifecycle.current = null; if (subscription) void subscription.remove(); latest.current.onBusyChange?.(false);
    };
  }, [props.inbox]);
  async function review(meta: IncomingShareMeta) {
    if (!current() || busy.current) return;
    const token = ++action.current, controller = new AbortController(); request.current = controller;
    const valid = () => current() && action.current === token;
    const guard = { signal: controller.signal, current: valid };
    markBusy('read'); setError(null); setMessage(null); setPreview(null); setConfirmation(null);
    try {
      const item = await props.inbox.read(meta, guard); if (!valid()) return;
      const source = await prepareIncomingShareSource(item, guard); if (!valid()) return;
      setPreview(source);
      if (!valid()) return;
      await latest.current.onReview(source); if (!valid()) return;
      setMessage(source.kind === 'unsupported' ? unsupported(source) : '已交给当前账号的导入预览；尚未导入，也未移除此本机来源。');
    } catch (cause) { if (valid()) setError(errorMessage(cause)); }
    finally { if (valid()) { request.current = null; markBusy(null); } }
  }
  async function removeConfirmed() {
    if (!current() || busy.current || !confirmation) return;
    const selected = confirmation, token = ++action.current, controller = new AbortController(); request.current = controller;
    const valid = () => current() && action.current === token;
    const guard = { signal: controller.signal, current: valid };
    markBusy(selected === 'all' ? 'clear' : 'remove'); setError(null); setMessage(null); setPreview(null);
    listSequence.current++; setLoading(false); // Retire an old list without leaving its retry control stuck loading.
    try {
      if (!valid()) return;
      if (selected === 'all') await props.inbox.clear(guard); else await props.inbox.remove(selected.id, guard);
      if (!valid()) return;
      setConfirmation(null); setMessage(selected === 'all' ? '已完成当前账号及未分配副本的本机清理，原文件和账号题录未删除。' : '已移除此待处理副本，原文件和账号题录未删除。');
      await refresh(); if (!valid()) return;
    } catch (cause) { if (valid()) setError(errorMessage(cause)); }
    finally { if (valid()) { request.current = null; markBusy(null); } }
  }
  const ready = current(), canAct = ready && props.inbox.available && !phase;
  return <ReaderSheet open title="本机待处理分享" onClose={() => {
    if (alive.current && latest.current.scopeKey === props.scopeKey && latest.current.ownerKey === props.ownerKey && latest.current.inbox === props.inbox) latest.current.onClose();
  }} className="incoming-share-sheet">
    <div className="incoming-share-panel">
      <p>本机待处理分享，选择当前账号后预览；不会自动导入或联网。副本尚未加入文库；列表只含未分配和当前账号的本机来源。</p>
      <p className="muted">首次预览会将该副本认领给当前账号；之后其他账号不能查看或移除它。未预览的来源仍未分配。</p>
      <p className="muted">最多4项；文本64 KiB、文件4 MiB、合计8 MiB。预览后仍保留本机副本，确认导入成功后可自行移除。</p>
      {!props.inbox.available && <p role="status">此环境尚未提供系统分享收件箱。这里不会改用任意文件路径或链接。</p>}
      <div className="incoming-share-actions">
        <button type="button" className="secondary" disabled={!canAct || loading} onClick={() => { if (current()) { setMessage(null); void refresh(); } }}>{loading ? '正在读取列表…' : '刷新待处理分享'}</button>
        <button type="button" className="text-button" disabled={!canAct} onClick={() => { if (current() && !busy.current) setConfirmation('all'); }}>清空本机待处理</button>
      </div>
      {ready && listed.notice && <p className="incoming-share-notice" role="status">{notices[listed.notice]}</p>}
      {ready && error && <p className="inline-error" role="alert">{error}</p>}
      {ready && message && <p role="status">{message}</p>}
      {!loading && !listed.items.length && !error && <p className="muted">暂无可列出的本机待处理分享。</p>}
      <ul className="incoming-share-list" aria-label="待处理来源">
        {(ready ? listed.items : []).map(meta => <li key={meta.id}>
          <strong>{meta.name}</strong><span className="muted">{meta.kind === 'text' ? '文本' : '文件'} · {size(meta.sizeBytes)} · {new Date(meta.createdAt).toLocaleString()}</span>
          <div className="incoming-share-actions">
            <button type="button" className="secondary" disabled={!canAct} onClick={() => { void review(meta); }}>{phase === 'read' ? '正在准备…' : '预览此分享'}</button>
            <button type="button" className="text-button" disabled={!canAct} onClick={() => { if (current() && !busy.current) setConfirmation(meta); }}>移除此待处理</button>
          </div>
        </li>)}
      </ul>
      {ready && confirmation && <section className="incoming-share-confirm" aria-label="确认移除本机副本">
        <h3>{confirmation === 'all' ? '清空当前账号及未分配的本机副本？' : `移除“${confirmation.name}”的待处理副本？`}</h3>
        <p>正常存储下只清理当前账号已认领和未分配的设备副本，不删除原文件、原应用内容或账号题录。需要时请从原应用重新分享。</p>
        {confirmation === 'all' && <p>收件箱损坏时，会先保留损坏存储原件，再重建可用收件箱；不会删除原始分享文件或文库。</p>}
        <div className="incoming-share-actions"><button type="button" className="danger" disabled={!canAct} onClick={() => { void removeConfirmed(); }}>确认移除副本</button>
          <button type="button" className="secondary" disabled={!!phase} onClick={() => { if (current()) setConfirmation(null); }}>保留副本</button></div>
      </section>}
      {ready && preview && <section className="incoming-share-preview" aria-label="来源检查结果">
        <h3>{preview.kind === 'doi' ? '单一 DOI 已识别' : preview.kind === 'archive' ? '本地格式检查完成' : '需要手工核对来源'}</h3>
        {preview.kind === 'doi' && <p>DOI：{preview.doi}。尚未查询题录。</p>}
        {preview.kind === 'archive' && <p>{preview.archive!.papers.length} 篇文献、{preview.archive!.notes.length} 条笔记；后续预览仍需确认选择与当前账号能力。</p>}
        {preview.kind === 'unsupported' && <p>{unsupported(preview)}</p>}
        {!!preview.warnings?.length && <p>题录转换存在 {preview.warnings.length} 项格式提醒，已一并交给导入预览。</p>}
      </section>}
    </div>
  </ReaderSheet>;
}
