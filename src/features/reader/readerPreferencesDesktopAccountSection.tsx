import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Laptop, LogIn, LogOut, RefreshCw } from 'lucide-react';
import { desktopAccount, type DesktopAccountConfig, type DesktopAccountStatus, type DesktopPdfCandidate, type DesktopRemoteVersion } from '../../services/desktopAccount';
import { SettingsField, SettingsInput, SettingsSelect } from './readerPreferencesPrimitives';
import type { ReaderPreferencesLocalizer } from './readerPreferencesTypes';

const EMPTY_CONFIG: DesktopAccountConfig = { apiBaseUrl: '', oidcIssuer: '', oidcClientId: '', deviceName: '' };
const buttonClass = 'pq-button inline-flex min-h-10 items-center justify-center gap-2 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50';
const sizeLabel = (size: number) => `${(size / 1024 / 1024).toFixed(size < 1024 * 1024 ? 2 : 1)} MiB`;

function errorLabel(code: string | undefined | null, l: ReaderPreferencesLocalizer): string {
  if (!code) return '';
  const labels: Record<string, [string, string]> = {
    DESKTOP_CONFIG_REQUIRED: ['先填写并保存账号服务设置。', 'Save your account service settings first.'],
    DESKTOP_CONFIG_INVALID: ['请检查服务地址、客户端 ID 和电脑名称。', 'Check the service URLs, client ID, and computer name.'],
    DESKTOP_ACCOUNT_IN_USE: ['此配置目录已有另一个账号会话，请先关闭另一个窗口。', 'Another account session is using this profile. Close that app instance first.'],
    DESKTOP_FEATURE_UNAVAILABLE: ['当前服务尚未开启在线电脑取文件。', 'This service has not enabled desktop file transfer.'],
    DESKTOP_NO_PUBLISHED_FILES: ['先添加至少一份 PDF，并等待题录同步完成。', 'Add a PDF and wait for its metadata to sync.'],
    DESKTOP_SOURCE_UNAVAILABLE: ['本机文件当前不可读取，请检查文件后重试。', 'The local file is unavailable. Check the file and retry.'],
    DESKTOP_SOURCE_NOT_APPROVED: ['该文件的读取授权已变化，请在文库中重新选择。', 'File access changed. Select it again in the library.'],
    DESKTOP_SOURCE_CHANGED: ['本机 PDF 已变化，请重新添加当前文件版本。', 'The local PDF changed. Add its current version again.'],
    DESKTOP_LIBRARY_CHANGED: ['文库位置或数据库已变化，请重新选择要提供的 PDF。', 'The library location or database changed. Select the PDFs again.'],
    DESKTOP_FILE_TOO_LARGE: ['文件超过 64 MiB，暂不支持在线读取。', 'Files larger than 64 MiB are not supported.'],
    DESKTOP_STORAGE_INVALID: ['账号状态文件无法校验，已停止提供文件。', 'Account state could not be verified. File access has stopped.'],
    DESKTOP_STORAGE_UNAVAILABLE: ['无法保存账号状态，请检查本机存储。', 'Cannot save account state. Check local storage.'],
    DESKTOP_STORAGE_FULL: ['本机账号状态已达到容量限制。', 'Local account state reached its capacity limit.'],
    DESKTOP_PUBLICATION_BLOCKED: ['题录同步需要处理，请检查版本或重新关联。', 'Metadata sync needs attention. Check the version or link an existing one.'],
    DESKTOP_REQUEST_TIMEOUT: ['连接超时，请检查网络后重试。', 'The connection timed out. Check the network and retry.'],
    DESKTOP_SERVICE_FAILED: ['服务暂时不可用，请稍后重试。', 'The service is unavailable. Try again later.'],
    DESKTOP_INVALID_RESPONSE: ['服务返回的内容无法校验，操作已停止。', 'The service response could not be verified. The operation stopped.'],
    DESKTOP_OPERATION_CANCELLED: ['操作已取消。', 'The operation was cancelled.'],
    ACCOUNT_CONFIGURATION_INVALID: ['请检查服务地址、身份服务地址和客户端 ID。', 'Check the service URLs and client ID.'],
    AUTH_SIGN_IN_FAILED: ['登录未完成，请重新打开浏览器登录。', 'Sign-in did not complete. Try signing in again.'],
    AUTHENTICATION_REQUIRED: ['登录已失效，请重新登录。', 'Your session expired. Sign in again.'],
    AUTH_SESSION_CHANGED: ['登录身份已变化，请重新登录并确认账号。', 'Your identity changed. Sign in again and check the account.'],
    SESSION_REVOKED: ['此设备的登录已被撤销，请重新登录。', 'This device session was revoked. Sign in again.'],
    DESKTOP_PDF_TRANSFER_DISABLED: ['服务端尚未开启在线电脑取文件。', 'This service has not enabled desktop file transfer.'],
    DESKTOP_PDF_UNAVAILABLE: ['这份 PDF 当前不可读取，请检查本机文件。', 'This PDF is unavailable. Check the local file.'],
    ATTACHMENT_VERSION_UNAVAILABLE: ['账号中的附件版本已不可用，请重新选择。', 'This attachment version is no longer available. Select another version.'],
    DESKTOP_PDF_CHANGED: ['PDF 内容已变化，请重新添加当前文件版本。', 'The PDF changed. Add the current version again.'],
    PDF_INTEGRITY_MISMATCH: ['文件内容与所选版本不一致，未建立关联。', 'The file does not match the selected version. No link was created.'],
    REQUEST_TOO_LARGE: ['文件超过 64 MiB，暂不支持在线读取。', 'Files larger than 64 MiB are not supported.'],
    DESKTOP_PDF_TRANSFER_BUSY: ['传输暂时繁忙，请稍后再试。', 'File transfer is busy. Try again shortly.'],
    DESKTOP_PDF_TIMEOUT: ['本次取文件已超时，可以重新尝试。', 'This transfer timed out. Try again.'],
    LIBRARY_CHANGED: ['文库已变化，请重新检查可读取的文件。', 'The library changed. Review the available files.'],
    NETWORK_ERROR: ['暂时无法连接服务，请检查网络后重试。', 'Cannot reach the service. Check your connection and retry.'],
  };
  const value = labels[code];
  return value ? l(...value) : l('操作未完成，请检查登录、服务连接和所选文件后重试。', 'The operation did not complete. Check your sign-in, connection, and selected file.');
}

function extractCode(error: unknown): string {
  const value = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
  return value.match(/\b[A-Z][A-Z_]{3,70}\b/)?.[0] || 'UNKNOWN';
}

export function ReaderPreferencesDesktopAccountSection({ l }: { l: ReaderPreferencesLocalizer }) {
  const [status, setStatus] = useState<DesktopAccountStatus | null>(null);
  const [config, setConfig] = useState<DesktopAccountConfig>(EMPTY_CONFIG);
  const [candidates, setCandidates] = useState<DesktopPdfCandidate[]>([]);
  const [moreCandidates, setMoreCandidates] = useState(false);
  const [candidateKey, setCandidateKey] = useState('');
  const [versions, setVersions] = useState<DesktopRemoteVersion[]>([]);
  const [moreVersions, setMoreVersions] = useState(false);
  const [versionId, setVersionId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const alive = useRef(false);
  const sequence = useRef(0);
  const initialized = useRef(false);
  const activeAccount = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await desktopAccount.status();
      if (!alive.current || request !== sequence.current) return;
      setStatus(next);
      const accountKey = next.account?.accountId || null;
      if (activeAccount.current !== accountKey) {
        activeAccount.current = accountKey;
        setVersions([]); setMoreVersions(false); setVersionId(''); setCandidateKey('');
      }
      if (!initialized.current) { setConfig(next.config || EMPTY_CONFIG); initialized.current = true; }
      const local = await desktopAccount.candidates();
      if (alive.current && request === sequence.current) { setCandidates(local.items); setMoreCandidates(!!local.hasMore); }
    } catch (failure) { if (alive.current && request === sequence.current) setError(extractCode(failure)); }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    let unsubscribe: (() => void) | undefined;
    void desktopAccount.onChanged(() => { void reload(); }).then((stop) => {
      if (alive.current) unsubscribe = stop; else stop();
    }).catch(() => { /* initial read reports an unavailable desktop bridge */ });
    return () => { alive.current = false; sequence.current += 1; unsubscribe?.(); };
  }, [reload]);

  const run = async (operation: () => Promise<unknown>, success = '') => {
    setPending(true); setError(null); setNotice('');
    try {
      await operation();
      if (alive.current) { setNotice(success); await reload(); }
    } catch (failure) { if (alive.current) setError(extractCode(failure)); }
    finally { if (alive.current) setPending(false); }
  };
  const signedIn = status?.auth.status === 'signed-in' && !!status.account;
  const signingIn = status?.auth.status === 'signing-in';
  const busy = pending || !!status?.busy;
  const candidate = candidates.find((item) => `${item.localPaperId}:${item.localAttachmentId}` === candidateKey);
  const hasPublished = status?.bindings.some((binding) => binding.publicationStatus === 'published');
  const message = errorLabel(error || status?.auth.errorCode || status?.errorCode, l);
  const bindingLabels = {
    'pending-paper': l('等待同步题录', 'Waiting for metadata'),
    'pending-version': l('等待同步附件版本', 'Waiting for file version'),
    published: l('可提供', 'Available'),
    blocked: l('需要处理', 'Needs attention'),
    'source-changed': l('文件已变化', 'File changed'),
  };

  return <div className="space-y-4" data-desktop-account>
    <div className="rounded-2xl border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium text-[var(--pq-text)]"><Laptop className="h-5 w-5 shrink-0" />{l('让同账号设备读取这台电脑的 PDF', 'Read this computer’s PDFs on your devices')}</div>
          <p className="mt-2 text-sm leading-6 text-[var(--pq-text-muted)]">{l('选择已导入文库的 PDF，将题录和附件版本同步到账号。开启后，手机或平板可在这台电脑保持运行时取文件。', 'Select imported PDFs to sync their metadata and file versions. After enabling access, your phone or tablet can fetch them while this app is running.')}</p>
        </div>
        <span className="rounded-full border border-[var(--pq-border)] px-3 py-1 text-xs text-[var(--pq-text-muted)]">{l('开发预览', 'Development preview')}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="mr-auto min-w-0 break-words text-sm text-[var(--pq-text)]">{signedIn
          ? l(`已登录：${status.auth.displayName || status.account?.deviceName || '当前账号'}`, `Signed in: ${status.auth.displayName || status.account?.deviceName || 'Current account'}`)
          : signingIn ? l('等待系统浏览器完成登录…', 'Waiting for sign-in in your browser…') : l('尚未登录', 'Signed out')}</span>
        {signingIn ? <button type="button" className={buttonClass} onClick={() => void run(desktopAccount.cancelSignIn)}>{l('取消登录', 'Cancel sign-in')}</button>
          : signedIn ? <button type="button" className={buttonClass} onClick={() => void run(desktopAccount.signOut)}><LogOut className="h-4 w-4" />{l('退出账号', 'Sign out')}</button>
            : <button type="button" className={buttonClass} disabled={!status?.config || busy} onClick={() => void run(desktopAccount.signIn)}><LogIn className="h-4 w-4" />{l('在浏览器中登录', 'Sign in with browser')}</button>}
      </div>
      <p className="mt-3 text-xs leading-5 text-[var(--pq-text-muted)]">{l('每次启动需重新登录并开启。本操作不会创建云端长期副本。', 'Sign in and enable access after each restart. This does not create a permanent cloud copy.')}</p>
    </div>

    {message ? <div role="alert" className="rounded-xl bg-[var(--pq-error-bg)] px-4 py-3 text-sm text-[var(--pq-error)]">{message}</div> : null}
    {notice ? <p role="status" className="text-sm text-[var(--pq-text-muted)]">{notice}</p> : null}
    {!status && !message ? <p role="status" className="text-sm text-[var(--pq-text-muted)]">{l('正在读取账号设置…', 'Loading account settings…')}</p> : null}

    <details className="rounded-2xl border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-4" open={!status?.config || undefined}>
      <summary className="cursor-pointer text-sm font-medium text-[var(--pq-text)]">{l('账号服务设置', 'Account service settings')}</summary>
      <form className="mt-4 grid gap-3" onSubmit={(event) => { event.preventDefault(); void run(() => desktopAccount.configure(config), l('设置已保存，可以登录。', 'Settings saved. You can now sign in.')); }}>
        <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('使用与你的手机或平板一致的同步服务。登录期间请先退出账号再修改。', 'Use the same sync service as your phone or tablet. Sign out before changing these settings.')}</p>
        {([
          ['apiBaseUrl', l('同步服务地址', 'Sync service URL'), 'https://sync.example.com'],
          ['oidcIssuer', l('身份服务地址', 'Identity provider URL'), 'https://id.example.com/realms/paperquay'],
          ['oidcClientId', l('桌面客户端 ID', 'Desktop client ID'), 'paperquay-desktop'],
          ['deviceName', l('这台电脑的名称', 'This computer’s name'), l('我的电脑', 'My computer')],
        ] as const).map(([key, label, placeholder]) => <label key={key} className="grid min-w-0 gap-1 text-sm text-[var(--pq-text)]">{label}
          <SettingsInput required autoComplete="off" maxLength={key.endsWith('Url') || key === 'oidcIssuer' ? 2048 : key === 'deviceName' ? 80 : 255} value={config[key]} placeholder={placeholder}
            disabled={signedIn || signingIn || busy} onChange={(event) => setConfig((previous) => ({ ...previous, [key]: event.target.value }))} />
        </label>)}
        <div><button type="submit" className={buttonClass} disabled={signedIn || signingIn || busy || Object.values(config).some((value) => !value.trim())}>{l('保存服务设置', 'Save service settings')}</button></div>
      </form>
    </details>

    <SettingsField label={l('在线取文件', 'File access while online')} description={l('仅提供下方明确添加的 PDF，每个文件最多 64 MiB。关闭会停止正在进行的传输。', 'Only the PDFs added below are available, up to 64 MiB each. Turning this off stops active transfers.')}>
      <button type="button" role="switch" aria-checked={!!status?.enabled} aria-label={l('允许同账号设备取文件', 'Allow your devices to fetch files')}
        disabled={!status?.enabled && (!signedIn || !status.capability || !hasPublished || busy)}
        onClick={() => void run(() => desktopAccount.setEnabled(!status?.enabled))}
        className="flex min-h-14 w-full items-center justify-between gap-4 rounded-xl border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-3 text-left disabled:opacity-50">
        <span className="min-w-0 text-sm text-[var(--pq-text)]">{status?.enabled ? l('已开启，正在等待取文件请求', 'Enabled, waiting for file requests') : l('已关闭', 'Disabled')}</span>
        <span className={`relative h-6 w-11 shrink-0 rounded-full ${status?.enabled ? 'bg-[var(--pq-accent)]' : 'bg-[var(--pq-border-strong)]'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white ${status?.enabled ? 'left-6' : 'left-1'}`} /></span>
      </button>
      {signedIn && !status.capability ? <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('当前服务尚未提供此功能。', 'This service does not offer this feature yet.')}</p> : null}
      {status?.capability ? <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{status.capability.direct
        ? l('优先尝试设备直连，失败后使用临时中继。中继服务会转发文件，但不保存 PDF。', 'Try a direct device connection first, then use the temporary relay if needed. The relay forwards the file without storing the PDF.')
        : l('通过临时中继传输。中继服务会转发文件，但不保存 PDF。', 'Files use the temporary relay, which forwards them without storing the PDF.')}</p> : null}
      {status?.transfers.map((transfer) => <div key={transfer.transferId} data-desktop-transfer={transfer.transport || 'reading'} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--pq-border)] p-3">
        <p role="status" className="text-sm text-[var(--pq-text)]">{transfer.status === 'reading' ? l('正在校验本机 PDF', 'Checking the local PDF')
          : transfer.status === 'connecting' ? transfer.transport === 'http-relay-v1'
            ? l('直连未建立，等待临时中继', 'Direct connection unavailable; waiting for the relay')
            : l('正在建立设备直连', 'Connecting directly to your device')
          : transfer.transport === 'webrtc-data-v1' ? l('正在通过设备直连发送 PDF', 'Sending PDF directly to your device')
            : l('正在通过临时中继发送 PDF', 'Sending PDF through the temporary relay')} · {sizeLabel(transfer.sizeBytes)}</p>
        <button type="button" className={buttonClass} onClick={() => void run(() => desktopAccount.cancel(transfer.transferId))}>{l('取消传输', 'Cancel transfer')}</button>
      </div>)}
    </SettingsField>

    <SettingsField label={l('添加可读取的 PDF', 'Add an available PDF')} description={l('先在文库中导入文件，再选择需要在其他设备上读取的附件。只同步选中文献的题录和附件版本。', 'Import a PDF into the library, then select the attachment to read on your other devices. Only the selected paper’s metadata and file version are synced.')}>
      <div className="flex flex-wrap gap-2">
        <SettingsSelect aria-label={l('选择本机 PDF', 'Select local PDF')} className="min-w-0 flex-1" value={candidateKey} disabled={!signedIn || busy}
          onChange={(event) => { setCandidateKey(event.target.value); setVersionId(''); }}>
          <option value="">{l('选择本机 PDF…', 'Select a local PDF…')}</option>
          {candidates.map((item) => <option key={`${item.localPaperId}:${item.localAttachmentId}`} value={`${item.localPaperId}:${item.localAttachmentId}`}>{item.title} · {item.fileName} · {sizeLabel(item.sizeBytes)}</option>)}
        </SettingsSelect>
        <button type="button" className={buttonClass} disabled={busy} aria-label={l('刷新本机 PDF 列表', 'Refresh local PDF list')} onClick={() => void run(reload)}><RefreshCw className="h-4 w-4" /></button>
      </div>
      <div><button type="button" className={buttonClass} disabled={!signedIn || !status?.capability || !candidate || busy || candidate.publicationStatus === 'published'}
        onClick={() => candidate && void run(() => desktopAccount.publish(candidate.localPaperId, candidate.localAttachmentId))}>{l('添加并同步题录', 'Add and sync metadata')}</button></div>
      {status && candidates.length === 0 ? <p className="text-sm text-[var(--pq-text-muted)]">{l('当前文库没有可选择的 PDF。', 'There are no selectable PDFs in this library.')}</p> : null}
      {moreCandidates ? <p className="text-xs text-[var(--pq-text-muted)]">{l('当前最多显示前 2,000 份本机 PDF。', 'The first 2,000 local PDFs are shown.')}</p> : null}
      <details className="rounded-xl border border-[var(--pq-border)] p-3">
        <summary className="cursor-pointer text-sm text-[var(--pq-text-muted)]">{l('关联账号中已有的附件版本', 'Link an existing account file version')}</summary>
        <p className="mt-3 text-xs leading-5 text-[var(--pq-text-muted)]">{l('账号中已有同一份 PDF 时，可直接关联，文件内容必须完全一致。', 'If the account already has this PDF, link it directly. The contents must match exactly.')}</p>
        <div className="mt-3 space-y-2">
          <button type="button" className={buttonClass} disabled={!signedIn || !status?.capability || busy} onClick={() => void run(async () => {
            const accountId = activeAccount.current; const result = await desktopAccount.remoteVersions();
            if (alive.current && accountId === activeAccount.current) { setVersions(result.items); setMoreVersions(!!result.hasMore); setVersionId(''); }
          })}>{l('加载账号中的版本', 'Load account versions')}</button>
          <SettingsSelect aria-label={l('选择已有附件版本', 'Select existing file version')} value={versionId} disabled={!signedIn || busy} onChange={(event) => setVersionId(event.target.value)}>
            <option value="">{l('选择已有附件版本…', 'Select an existing version…')}</option>
            {versions.map((item) => <option key={item.attachmentVersionId} value={item.attachmentVersionId}>{item.title} · {item.fileName} · {sizeLabel(item.sizeBytes)}</option>)}
          </SettingsSelect>
          {moreVersions ? <p className="text-xs text-[var(--pq-text-muted)]">{l('当前最多加载前 1,000 个附件版本。', 'The first 1,000 file versions are loaded.')}</p> : null}
          <button type="button" className={buttonClass} disabled={!signedIn || !candidate || !versionId || busy} onClick={() => candidate && void run(() => desktopAccount.bind(candidate.localPaperId, candidate.localAttachmentId, versionId))}>{l('校验并关联', 'Verify and link')}</button>
        </div>
      </details>
    </SettingsField>

    <section aria-label={l('已添加的 PDF', 'Added PDFs')} className="space-y-2">
      <h3 className="text-sm font-medium text-[var(--pq-text)]">{l('已添加的 PDF', 'Added PDFs')} · {status?.bindings.length || 0}</h3>
      {status?.bindings.map((binding) => <article key={binding.bindingId} className="rounded-xl border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-3">
        <div className="flex items-start gap-2"><FileText className="mt-1 h-4 w-4 shrink-0 text-[var(--pq-text-muted)]" /><div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium text-[var(--pq-text)]">{binding.title}</p>
          <p className="mt-1 break-all text-xs text-[var(--pq-text-muted)]">{binding.fileName} · {sizeLabel(binding.sizeBytes)}</p>
        </div></div>
        <div className="mt-3 flex flex-wrap items-center gap-2"><span className="mr-auto text-xs text-[var(--pq-text-muted)]">{bindingLabels[binding.publicationStatus]}</span>
          {binding.publicationStatus !== 'published' ? <button type="button" className={buttonClass} disabled={!signedIn || busy} onClick={() => void run(() => desktopAccount.retry(binding.bindingId))}>{l('重试同步', 'Retry sync')}</button> : null}
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(() => desktopAccount.unbind(binding.bindingId))}>{l('停止提供', 'Remove access')}</button>
        </div>
        {binding.errorCode ? <p className="mt-2 text-xs leading-5 text-[var(--pq-error)]">{errorLabel(binding.errorCode, l)}</p> : null}
      </article>)}
      <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('停止提供会移除这台电脑的关联；保留本机文件及账号中的题录。', 'Removing access unlinks this computer and preserves the local file and account metadata.')}</p>
    </section>
  </div>;
}
