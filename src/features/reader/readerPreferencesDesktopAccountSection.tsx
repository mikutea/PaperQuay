import type { PreferencesSectionKey } from './readerShared';
import { DesktopGraphExchangePanel } from './desktopGraphExchangePanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileSearch, FileText, GitBranch, Laptop, LogIn, LogOut, RefreshCw, Sparkles } from 'lucide-react';
import { desktopAccount, type DesktopAccountConfig, type DesktopAccountStatus, type DesktopPdfCandidate, type DesktopRemoteVersion, type DesktopModelRecord } from '../../services/desktopAccount';
import { SettingsField, SettingsInput, SettingsSelect } from './readerPreferencesPrimitives';
import type { ReaderPreferencesLocalizer } from './readerPreferencesTypes';

const EMPTY_CONFIG: DesktopAccountConfig = { apiBaseUrl: '', oidcIssuer: '', oidcClientId: '', deviceName: 'PaperQuay Desktop' };
const buttonClass = 'pq-button inline-flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50';
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
    DESKTOP_PARSED_REPARSE_REQUIRED: ['此 PDF 没有可验证的解析来源。请重新运行云端解析；手动或旧缓存不能直接导出。', 'This PDF has no verified parse provenance. Run cloud parsing again; manual and old caches cannot be exported.'],
    DESKTOP_PARSED_PROVENANCE_UNAVAILABLE: ['系统安全存储不可用，解析内容仍保留，但暂不能导出可验证解析包。', 'Secure storage is unavailable. Parsed content is preserved, but verified export is unavailable.'],
    DESKTOP_PARSED_PROVENANCE_INVALID: ['解析来源证据无法验证，请重新运行云端解析。', 'Parse provenance cannot be verified. Run cloud parsing again.'],
    DESKTOP_PARSED_OUTPUT_CHANGED: ['解析产物或图片已变化，请重新解析后再导出。', 'Parsed output or an image changed. Parse the PDF again before exporting.'],
    DESKTOP_PARSED_RESOURCE_UNAVAILABLE: ['解析资源当前不可读取，请检查缓存目录授权。', 'Parse resources are unavailable. Check cache directory access.'],
    DESKTOP_PARSED_RESOURCE_INVALID: ['解析图片引用不在本次已验证产物中，未导出。', 'A parsed image is outside the verified output. Nothing was exported.'],
    DESKTOP_PARSED_OUTPUT_INVALID: ['解析结构或图片不符合可移植格式，未导出。', 'The parsed structure or image is not supported by the portable format. Nothing was exported.'],
    DESKTOP_PARSED_TABLE_UNSUPPORTED: ['此解析表格不能完整转换，请重新解析。', 'This parsed table cannot be converted completely. Parse it again.'],
    DESKTOP_PARSED_PAGE_MISMATCH: ['解析页码与 PDF 版本不一致，未导出。', 'The parse pages do not match this PDF version. Nothing was exported.'],
    DESKTOP_PARSED_PDF_INVALID: ['无法核验 PDF 的实际页数，未导出。', 'The PDF page count could not be verified. Nothing was exported.'],
    DESKTOP_PARSED_PACKAGE_TOO_LARGE: ['解析包超过 16 MiB 或图片容量限制，未导出。', 'The parse package exceeds 16 MiB or its image limits. Nothing was exported.'],
    DESKTOP_PARSED_SAVE_FAILED: ['解析包未能安全保存，请重新选择保存位置。', 'The parse package could not be saved safely. Choose a save location again.'],
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
    EXTERNAL_OUTCOME_UNKNOWN: ['外部服务是否受理尚不确定，已停止重发。请先核对服务记录。', 'The external outcome is unknown. Resubmission stopped; check the service records first.'],
    SOURCE_UNAVAILABLE: ['这篇文献的文件或排版结果不可用。请重新添加文献并完成解析。', 'This paper’s file or formatted content is unavailable. Add it again and complete document parsing.'],
    PROFILE_CHANGED: ['服务配置或私有凭据已变化，旧任务已停止。请检查设置后重新确认。', 'Service configuration or private credentials changed. The old execution stopped; review settings and confirm again.'],
    REMOTE_CONFIGURATION_CHANGED: ['服务配置已变化，任务已停止。请检查设置后重新确认开启。', 'Service configuration changed. Tasks stopped; review settings before enabling again.'],
    REMOTE_BINDING_CHANGED: ['账号、文库或关联文件已变化，任务已停止。', 'The account, library or linked files changed. Tasks stopped.'],
    REMOTE_MINERU_CACHE_FULL: ['远程解析缓存已达到本机容量限制。请在缓存管理中处理，再显式恢复任务。', 'Remote parse storage reached its local limit. Manage cache storage, then explicitly resume the task.'],
    REMOTE_JOURNAL_FULL: ['本机执行记录已达到容量限制。请先停止任务并清理已完成记录。', 'Local execution journals reached their limit. Stop tasks and clear completed journals.'],
    REMOTE_JOURNAL_CORRUPT: ['本机执行记录无法验证，已停止重发，避免重复计费。', 'A local execution journal could not be verified. Resubmission stopped to avoid duplicate charges.'],
    REMOTE_CREDENTIAL_STORAGE_UNAVAILABLE: ['无法保存本机安全记录，请检查存储空间和系统加密。暂不能开启远程任务。', 'Private local records cannot be saved. Check disk space and OS encryption before enabling remote tasks.'],
    MODEL_BACKUP_SAVE_FAILED: ['备份未能安全保存，请重新选择保存位置。','The backup could not be saved safely. Choose a save location again.'],
    MODEL_INFERENCE_DISABLED: ['当前同步服务尚未开启模型调用。','Model invocations are disabled on this sync service.'],
    MODEL_CONFIGURATION_CHANGED: ['模型配置已变化，请重新选择并确认。','Model configuration changed. Select and confirm it again.'],
    MODEL_SECURE_STORAGE_UNAVAILABLE: ['系统加密存储不可用，暂不能提供模型。','OS encrypted storage is unavailable. Model execution cannot start.'],
    MODEL_LOCAL_CAPACITY: ['本机模型记录已满。请先备份，再清理已保存记录。','Local model history is full. Back up and clear saved records first.'],
    MODEL_SAVE_UNCONFIRMED: ['结果保存尚未确认，请在执行记录中备份或仅重试保存。','Result persistence is unconfirmed. Back up or retry saving in history.'],
    MODEL_PROFILE_UNAVAILABLE: ['当前模型预设不可用，请检查模型设置。','The selected model preset is unavailable. Check model settings.'],
    MODEL_BINDING_CHANGED: ['账号、设备或文库已变化，操作已停止。','The account, device or library changed. The operation stopped.'],
    REMOTE_TASKS_DISABLED: ['当前服务尚未开启远程任务。', 'Remote tasks are disabled on this service.'],
    REMOTE_TASK_LEASE_CHANGED: ['任务状态已变化，这台电脑已停止处理。请在手机上查看任务进度。', 'The task status changed and this computer stopped processing it. Check its progress on your phone.'],
    REMOTE_TASK_ARTIFACT_LIMIT: ['结果超过任务容量限制，未上传，请缩小处理范围或检查服务输出。', 'The result exceeds the task limit and was not uploaded. Reduce the scope or inspect the service output.'],
  };
  const value = labels[code];
  return value ? l(...value) : l('操作未完成，请检查登录、服务连接和所选文件后重试。', 'The operation did not complete. Check your sign-in, connection, and selected file.');
}

function extractCode(error: unknown): string {
  const value = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
  return value.match(/\b[A-Z][A-Z_]{3,70}\b/)?.[0] || 'UNKNOWN';
}

export function ReaderPreferencesDesktopAccountSection({ l, onNavigate }: { l: ReaderPreferencesLocalizer; onNavigate?: (section: PreferencesSectionKey) => void }) {
  const [activeTask, setActiveTask] = useState<'files' | 'ai' | 'processing' | 'relations' | null>(null);
  const [connectionExpanded, setConnectionExpanded] = useState(false);
  const [candidateSearch, setCandidateSearch] = useState('');
  const taskPanel = useRef<HTMLElement | null>(null);
  const overview = useRef<HTMLHeadingElement | null>(null);
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
  const [remoteConsent, setRemoteConsent] = useState(false);
  const [clearRemoteConfirmed, setClearRemoteConfirmed] = useState(false);
  const [modelConsent,setModelConsent]=useState(false);
  const [modelPresetId,setModelPresetId]=useState('');
  const [clearModelsConfirmed,setClearModelsConfirmed]=useState(false);
  const [modelRecords,setModelRecords]=useState<DesktopModelRecord[]>([]);
  const modelOwner=useRef<string|null>(null);
  const alive = useRef(false);
  const sequence = useRef(0);
  const initialized = useRef(false);
  const activeAccount = useRef<string | null>(null);
  const latestAction = useRef(0);

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await desktopAccount.status();
      if (!alive.current || request !== sequence.current) return;
      const accountKey = next.graphExchange?.scopeKey || (next.account ? JSON.stringify([next.config?.apiBaseUrl, next.account.accountId, next.account.deviceId]) : null);
      if (activeAccount.current !== accountKey) {
        activeAccount.current = accountKey; latestAction.current += 1;
        setPending(false); setError(null); setNotice('');
        setVersions([]); setMoreVersions(false); setVersionId(''); setCandidateKey('');
      }
      setStatus(next);
      const owner=next.modelInference?.configurationToken??null;if(modelOwner.current!==owner){modelOwner.current=owner;setModelRecords([]);}
      if(next.account&&next.auth.status==='signed-in'){const history=await desktopAccount.modelRecords();if(alive.current&&request===sequence.current&&owner===modelOwner.current)setModelRecords(history.items);}else setModelRecords([]);

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
    const action = ++latestAction.current, owner = activeAccount.current;
    const current = () => alive.current && action === latestAction.current && owner === activeAccount.current;
    setPending(true); setError(null); setNotice('');
    try {
      await operation();
      if (current()) { if (success) setNotice(success); await reload(); }
    } catch (failure) { if (current()) setError(extractCode(failure)); }
    finally { if (current()) setPending(false); }
  };
  const signedIn = status?.auth.status === 'signed-in' && !!status.account;
  const remote = status?.remoteTasks;
  const models=status?.modelInference;
  useEffect(()=>{setModelConsent(false);setClearModelsConfirmed(false);},[status?.account?.accountId,models?.configurationToken]);
  useEffect(()=>{if(!models?.presets.some(p=>p.id===modelPresetId))setModelPresetId('');},[models?.presets,modelPresetId]);
  useEffect(() => { setRemoteConsent(false); setClearRemoteConfirmed(false); }, [status?.account?.accountId, remote?.configurationToken]);
  const signingIn = status?.auth.status === 'signing-in';
  const busy = pending || !!status?.busy;
  const candidate = candidates.find((item) => `${item.localPaperId}:${item.localAttachmentId}` === candidateKey);
  const hasPublished = status?.bindings.some((binding) => binding.publicationStatus === 'published');
  const message = errorLabel(error || status?.auth.errorCode || status?.errorCode, l);
  const bindingLabels = {
    'pending-paper': l('等待同步题录', 'Waiting for metadata'),
    'pending-version': l('等待同步附件版本', 'Waiting for file version'),
    published: l('已添加，可开启共享', 'Added; ready to share'),
    blocked: l('需要处理', 'Needs attention'),
    'source-changed': l('文件已变化', 'File changed'),
  };

  const configDirty = !!status?.config && Object.keys(config).some(key => config[key as keyof DesktopAccountConfig] !== status.config?.[key as keyof DesktopAccountConfig]);
  const connecting = !!status && !signedIn && (signingIn || !!status.busy || status.auth.status === 'signed-in');
  const visibleCandidates = candidates.filter(item => !candidateSearch.trim() || (item.title + ' ' + item.fileName).toLocaleLowerCase().includes(candidateSearch.trim().toLocaleLowerCase()));
  const tasks = [
    { key: 'files' as const, title: l('在手机上读电脑里的文献', 'Read this computer’s papers on my phone'), detail: l('添加文献，再开启文件共享', 'Add papers, then enable file access'), icon: FileText },
    { key: 'ai' as const, title: l('在手机上用这台电脑的 AI', 'Use this computer’s AI on my phone'), detail: l('选择一个 AI 服务供自己的设备使用', 'Choose an AI service for your own devices'), icon: Sparkles },
    { key: 'processing' as const, title: l('让电脑帮忙处理文献', 'Let this computer prepare papers'), detail: l('把 PDF 转成可阅读、可问答的内容', 'Prepare PDFs for reading and questions'), icon: FileSearch },
    { key: 'relations' as const, title: l('同步文献之间的关系', 'Sync relationships between papers'), detail: l('把关系带到账号，或带到这台电脑', 'Move relationships to your account or this computer'), icon: GitBranch },
  ];
  useEffect(() => { if (!signedIn) setActiveTask(null); }, [signedIn]);
  useEffect(() => { if (activeTask) taskPanel.current?.focus({ preventScroll: true }); else overview.current?.focus({ preventScroll: true }); }, [activeTask]);
  return <div className="space-y-5" data-desktop-account>
    <section className="rounded-[var(--pq-radius-md)] border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-5">
      <div className="flex flex-wrap items-start gap-4">
        <Laptop className="mt-1 h-6 w-6 shrink-0 text-[var(--pq-accent)]" />
        <div className="min-w-0 flex-1"><h2 className="text-lg font-semibold text-[var(--pq-text)]">{l('账号与多设备', 'Account and devices')}</h2>
          <p className="mt-1 text-sm leading-6 text-[var(--pq-text-muted)]">{signedIn ? l('已连接：' + (status.auth.displayName || status.account?.deviceName || '当前账号'), 'Connected: ' + (status.auth.displayName || status.account?.deviceName || 'Current account')) : connecting ? l('正在连接账号服务…', 'Connecting to your account…') : !status ? l('正在读取账号设置…', 'Loading account settings…') : l('连接同一个账号，在电脑、手机和平板间接续阅读。', 'Connect the same account to continue reading across your computer, phone and tablet.')}</p>
        </div>
        {signedIn ? <button type="button" className={buttonClass} onClick={() => void run(desktopAccount.signOut)}><LogOut className="h-4 w-4" />{l('退出账号', 'Sign out')}</button>
          : connecting ? <button type="button" className={buttonClass} onClick={() => void run(desktopAccount.cancelSignIn)}>{l('取消连接', 'Cancel connection')}</button>
          : <button type="button" className={buttonClass} disabled={!status || busy} onClick={() => { if (!status?.config || configDirty) setConnectionExpanded(true); else void run(desktopAccount.signIn); }}><LogIn className="h-4 w-4" />{!status?.config ? l('设置账号连接', 'Set up account connection') : configDirty ? l('检查连接信息', 'Review connection details') : l('连接账号', 'Connect account')}</button>}
      </div>
      {signedIn ? <p className="mt-3 text-xs text-[var(--pq-text-muted)]">{l('共享 PDF、提供 AI 和处理文献分别控制，需要时再开启。', 'PDF access, AI and document preparation can each be enabled when needed.')}</p> : status && !connecting ? <p className="mt-3 text-xs leading-5 text-[var(--pq-text-muted)]">{l('需要你自己的同步服务。连接信息由管理员提供；尚未配置时仍可正常使用本机文库。', 'This requires your own sync service. An administrator provides the connection details. Your local library works without it.')}</p> : null}
      {status?.config ? <button type="button" className="mt-2 min-h-11 text-sm text-[var(--pq-accent)]" onClick={() => setConnectionExpanded(value => !value)}>{connectionExpanded ? l('收起连接信息', 'Hide connection details') : l('查看或更改连接信息', 'View or change connection details')}</button> : null}
    </section>
    {message ? <div role="alert" className="rounded-xl bg-[var(--pq-error-bg)] px-4 py-3 text-sm text-[var(--pq-error)]">{message}</div> : null}
    {notice ? <p role="status" className="text-sm text-[var(--pq-text-muted)]">{notice}</p> : null}
    {connectionExpanded ? <details className="rounded-2xl border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-4" open>
      <summary className="cursor-pointer text-sm font-medium text-[var(--pq-text)]">{l('连接信息', 'Connection details')}</summary>
      <form className="mt-4 grid gap-3" onSubmit={(event) => { event.preventDefault(); void run(async () => { await desktopAccount.configure(config); await desktopAccount.signIn(); }); }}>
        <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('这些信息由同步服务管理员提供。手机和电脑需要连接同一项服务。', 'Your sync service administrator provides these details. Use the same service on your phone and computer.')}</p>
        {([
          ['apiBaseUrl', l('同步服务地址', 'Sync service URL'), 'https://sync.example.com'],
          ['oidcIssuer', l('登录服务网址', 'Sign-in service URL'), 'https://id.example.com/realms/paperquay'],
          ['oidcClientId', l('登录应用编号', 'Sign-in application ID'), 'paperquay-desktop'],
          ['deviceName', l('这台电脑的名称', 'This computer’s name'), l('我的电脑', 'My computer')],
        ] as const).map(([key, label, placeholder]) => <label key={key} className="grid min-w-0 gap-1 text-sm text-[var(--pq-text)]">{label}
          <SettingsInput required autoComplete="off" maxLength={key.endsWith('Url') || key === 'oidcIssuer' ? 2048 : key === 'deviceName' ? 80 : 255} value={config[key]} placeholder={placeholder}
            disabled={signedIn || signingIn || busy} onChange={(event) => setConfig((previous) => ({ ...previous, [key]: event.target.value }))} />
        </label>)}
        <div><button type="submit" className={buttonClass} disabled={signedIn || signingIn || busy || Object.values(config).some((value) => !value.trim())}>{l('保存并连接账号', 'Save and connect')}</button></div>
      </form>
    </details> : null}
    {!activeTask ? <section><h3 ref={overview} tabIndex={-1} className="mb-3 text-sm font-medium text-[var(--pq-text-muted)]">{l('你想做什么？', 'What would you like to do?')}</h3>
      <nav aria-label={l('多设备任务', 'Device tasks')} className="divide-y divide-[var(--pq-border)] overflow-hidden rounded-[var(--pq-radius-md)] border border-[var(--pq-border)] bg-[var(--pq-surface-1)]">
        {tasks.map(task => <button key={task.key} type="button" data-account-task={task.key} onClick={() => { setActiveTask(task.key); setError(null); setNotice(''); }} className="flex min-h-20 w-full items-center gap-4 p-4 text-left transition-colors hover:bg-[var(--pq-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--pq-accent)] motion-reduce:transition-none"><task.icon className="h-5 w-5 shrink-0 text-[var(--pq-accent)]" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-[var(--pq-text)]">{task.title}</span><span className="mt-1 block text-xs leading-5 text-[var(--pq-text-muted)]">{task.detail}</span></span><ChevronRight className="h-4 w-4 shrink-0 text-[var(--pq-text-faint)]" /></button>)}
      </nav></section> : <section ref={taskPanel} tabIndex={-1} aria-label={tasks.find(task => task.key === activeTask)?.title} className="space-y-4 focus:outline-none">
      <button type="button" className={buttonClass} onClick={() => setActiveTask(null)}><ChevronLeft className="h-4 w-4" />{l('返回多设备任务', 'Back to device tasks')}</button>
      <h3 className="text-lg font-semibold text-[var(--pq-text)]">{tasks.find(task => task.key === activeTask)?.title}</h3>
      {!signedIn ? <div className="space-y-3 rounded-xl bg-[var(--pq-surface-1)] p-4"><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('先连接手机和电脑共同使用的账号，再继续这一步。', 'Connect the account used by both your phone and computer to continue.')}</p><button type="button" className={buttonClass} disabled={connecting} onClick={() => { if (status?.config && !configDirty) void run(desktopAccount.signIn); else setConnectionExpanded(true); }}>{l('连接账号', 'Connect account')}</button></div> : <>
      {activeTask === 'files' ? status?.capability ? <div className="space-y-4"><SettingsField label={l('先添加要在手机上读的文献', 'First, add papers to read on your phone')} description={l('把选中文献加入账号，PDF 仍保存在电脑。接下来开启共享，手机才能读取文件。', 'Add the selected paper to your account. Its PDF stays on this computer. Then enable access so your phone can read it.')}>
      <SettingsInput aria-label={l('搜索要共享的文献', 'Search papers to share')} value={candidateSearch} onChange={event => { setCandidateSearch(event.target.value); setCandidateKey(''); setVersionId(''); }} placeholder={l('输入题名或文件名', 'Search by title or file name')} />
      <div className="flex flex-wrap gap-2">
        <SettingsSelect aria-label={l('选择本机 PDF', 'Select local PDF')} className="min-w-0 flex-1" value={candidateKey} disabled={!signedIn || busy}
          onChange={(event) => { setCandidateKey(event.target.value); setVersionId(''); }}>
          <option value="">{l('选择本机 PDF…', 'Select a local PDF…')}</option>
          {visibleCandidates.map((item) => <option key={`${item.localPaperId}:${item.localAttachmentId}`} value={`${item.localPaperId}:${item.localAttachmentId}`}>{item.title || item.fileName}{item.publicationStatus === 'published' ? l('（已添加）', ' (Added)') : ''}</option>)}
        </SettingsSelect>
        <button type="button" className={buttonClass} disabled={busy} aria-label={l('刷新本机 PDF 列表', 'Refresh local PDF list')} onClick={() => void run(reload)}><RefreshCw className="h-4 w-4" /></button>
      </div>
      <div><button type="button" className={buttonClass} disabled={!signedIn || !status?.capability || !candidate || busy || candidate.publicationStatus === 'published'}
        onClick={() => candidate && void run(() => desktopAccount.publish(candidate.localPaperId, candidate.localAttachmentId))}>{l('添加这篇文献', 'Add this paper')}</button></div>
      {status && candidates.length === 0 ? <p className="text-sm text-[var(--pq-text-muted)]">{l('当前文库没有可选择的 PDF。', 'There are no selectable PDFs in this library.')}</p> : null}
      {moreCandidates ? <p className="text-xs text-[var(--pq-text-muted)]">{l('当前最多显示前 2,000 份本机 PDF。', 'The first 2,000 local PDFs are shown.')}</p> : null}
      <details className="rounded-xl border border-[var(--pq-border)] p-3">
        <summary className="cursor-pointer text-sm text-[var(--pq-text-muted)]">{l('手机账号中已有这篇文献？', 'Already have this paper in your phone account?')}</summary>
        <p className="mt-3 text-xs leading-5 text-[var(--pq-text-muted)]">{l('账号中已有同一份 PDF 时，可直接关联，文件内容必须完全一致。', 'If the account already has this PDF, link it directly. The contents must match exactly.')}</p>
        <div className="mt-3 space-y-2">
          <button type="button" className={buttonClass} disabled={!signedIn || !status?.capability || busy} onClick={() => void run(async () => {
            const accountId = activeAccount.current; const result = await desktopAccount.remoteVersions();
            if (alive.current && accountId === activeAccount.current) { setVersions(result.items); setMoreVersions(!!result.hasMore); setVersionId(''); }
          })}>{l('查看账号中的文献', 'View papers in my account')}</button>
          <SettingsSelect aria-label={l('选择已有附件版本', 'Select existing file version')} value={versionId} disabled={!signedIn || busy} onChange={(event) => setVersionId(event.target.value)}>
            <option value="">{l('选择已有附件版本…', 'Select an existing version…')}</option>
            {versions.map((item) => <option key={item.attachmentVersionId} value={item.attachmentVersionId}>{item.title} · {item.fileName} · {sizeLabel(item.sizeBytes)}</option>)}
          </SettingsSelect>
          {moreVersions ? <p className="text-xs text-[var(--pq-text-muted)]">{l('当前最多加载前 1,000 个附件版本。', 'The first 1,000 file versions are loaded.')}</p> : null}
          <button type="button" className={buttonClass} disabled={!signedIn || !candidate || !versionId || busy} onClick={() => candidate && void run(() => desktopAccount.bind(candidate.localPaperId, candidate.localAttachmentId, versionId))}>{l('关联这份 PDF', 'Link this PDF')}</button>
        </div>
      </details>
    </SettingsField>
<SettingsField label={l('允许手机读取已添加的 PDF', 'Allow your phone to read added PDFs')} description={l('打开后，手机可在这台电脑运行时读取已添加的文献。关闭只停止文件传输。', 'When enabled, your phone can read these papers while this app is running. Turning this off stops file transfers only.')}>
      <button type="button" role="switch" aria-checked={!!status?.enabled} aria-label={l('允许同账号设备取文件', 'Allow your devices to fetch files')}
        disabled={!status?.enabled && (!signedIn || !status.capability || !hasPublished || busy)}
        onClick={() => void run(() => desktopAccount.setEnabled(!status?.enabled))}
        className="flex min-h-14 w-full items-center justify-between gap-4 rounded-xl border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-3 text-left disabled:opacity-50">
        <span className="min-w-0 text-sm text-[var(--pq-text)]">{status?.enabled ? l('已开启，正在等待取文件请求', 'Enabled, waiting for file requests') : l('尚未开启', 'Not enabled')}</span>
        <span className={`relative h-6 w-11 shrink-0 rounded-full ${status?.enabled ? 'bg-[var(--pq-accent)]' : 'bg-[var(--pq-border-strong)]'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white ${status?.enabled ? 'left-6' : 'left-1'}`} /></span>
      </button>
      {signedIn && !status.capability ? <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('当前服务尚未提供此功能。', 'This service does not offer this feature yet.')}</p> : null}
      <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-[var(--pq-text-muted)]">{l('传输方式与隐私', 'Transfer and privacy details')}</summary>      {status?.capability ? <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{status.capability.direct
        ? l('优先尝试设备直连，失败后使用临时中继。中继服务会转发文件，但不保存 PDF。', 'Try a direct device connection first, then use the temporary relay if needed. The relay forwards the file without storing the PDF.')
        : l('通过临时中继传输。中继服务会转发文件，但不保存 PDF。', 'Files use the temporary relay, which forwards them without storing the PDF.')}</p> : null}
</details>
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
{!hasPublished ? <p className="text-sm text-[var(--pq-text-muted)]">{l('先添加一篇文献，上方的共享开关就可以开启。', 'Add a paper first to enable file access above.')}</p> : null}<section aria-label={l('共享文献列表', 'Shared papers')} className="space-y-2">
      <h3 className="text-sm font-medium text-[var(--pq-text)]">{l('手机可读取的文献', 'Papers available to your phone')} · {status?.bindings.length || 0}</h3>
      {status?.bindings.map((binding) => <article key={binding.bindingId} className="rounded-xl border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-3">
        <div className="flex items-start gap-2"><FileText className="mt-1 h-4 w-4 shrink-0 text-[var(--pq-text-muted)]" /><div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium text-[var(--pq-text)]">{binding.title}</p>
          <p className="mt-1 break-all text-xs text-[var(--pq-text-muted)]">{binding.fileName} · {sizeLabel(binding.sizeBytes)}</p>
        </div></div>
        <div className="mt-3 flex flex-wrap items-center gap-2"><span className="mr-auto text-xs text-[var(--pq-text-muted)]">{bindingLabels[binding.publicationStatus]}</span>
          {binding.publicationStatus !== 'published' ? <button type="button" className={buttonClass} disabled={!signedIn || busy} onClick={() => void run(() => desktopAccount.retry(binding.bindingId))}>{l('重试同步', 'Retry sync')}</button> : null}
          <button type="button" className={buttonClass} disabled={!signedIn || busy || binding.publicationStatus !== 'published'}
            onClick={() => void run(async () => {
              const owner = activeAccount.current; const result = await desktopAccount.exportParsed(binding.bindingId);
              if (alive.current && owner === activeAccount.current && result.status === 'exported') setNotice(l('解析包已导出，可在手机或平板中导入。', 'Parsed document exported. Import it on your phone or tablet.'));
            })}>{l('导出给手机的排版结果', 'Export formatted content for my phone')}</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(() => desktopAccount.unbind(binding.bindingId))}>{l('移出共享列表', 'Remove from shared papers')}</button>
        </div>
        {binding.errorCode ? <p className="mt-2 text-xs leading-5 text-[var(--pq-error)]">{errorLabel(binding.errorCode, l)}</p> : null}
      </article>)}
      <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('移出列表不会删除 PDF 或账号题录；正在进行的文献处理会暂停。', 'Removing a paper keeps its PDF and account metadata. Document preparation will pause.')}</p>
      <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('解析包需要本机重新云端解析时保存的来源证据。旧缓存或手动 JSON 请先重新解析。', 'Parsed document export requires provenance saved during a new cloud parse on this computer. Parse old caches or manually imported JSON again first.')}</p>
    </section></div> : <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('这个同步服务暂未提供电脑文件共享。请联系管理员开启，然后重新连接账号。', 'This service does not offer desktop file sharing yet. Ask the administrator to enable it, then reconnect your account.')}</p> : null}
      {activeTask === 'ai' ? models?.capability ? <SettingsField label={l('在手机上使用这台电脑的 AI', 'Use this computer’s AI on your phone')}
      description={l('让同账号设备使用这里选定的聊天模型。电脑会把请求中的文本发送到该模型服务，可能产生费用。每次启动后默认关闭。', 'Let your devices use the chat model selected here. This computer sends the requested text to that model service and charges may apply. Disabled after restart.')}>
      <div data-desktop-models className="space-y-3">
        <div role="status" className="text-sm text-[var(--pq-text)]">{models?.enabled
          ? models.busy ? l('正在运行模型', 'Running a model request') : l('已开启，等待同账号请求', 'Enabled, waiting for your requests')
          : l('已关闭', 'Disabled')}</div>
        <label className="grid gap-2 text-sm text-[var(--pq-text)]">{l('手机要使用的 AI', 'AI to use on your phone')}
          <SettingsSelect className="min-h-11" aria-label={l('手机要使用的 AI', 'AI to use on your phone')} value={modelPresetId} disabled={!!models?.enabled || !!models?.busy || busy} onChange={event => {setModelPresetId(event.target.value);setModelConsent(false);}}>
            <option value="">{l('选择已保存的聊天模型', 'Choose a saved chat model')}</option>
            {models?.presets.map(preset=><option key={preset.id} value={preset.id}>{preset.label} · {preset.model}</option>)}
          </SettingsSelect>
        </label>
        {!models?.presets.length ? <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('先添加一个可供其他设备使用的 AI 服务。', 'Add an AI service that your other devices can use.')}</p> : null}
        {!models?.presets.length && onNavigate ? <button type="button" className={buttonClass} onClick={() => onNavigate('models')}>{l('添加 AI 服务', 'Add an AI service')}</button> : null}
        <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('使用时会把手机选中的文字发送给这个 AI，可能产生费用。地址和访问密钥保存在电脑上。', 'The text selected on your phone is sent to this AI and charges may apply. The service address and access key stay on this computer.')}</p>
        {!models?.enabled ? <label className="flex min-h-11 items-start gap-3 text-sm leading-6 text-[var(--pq-text-muted)]"><input className="mt-1 h-5 w-5 shrink-0" type="checkbox" checked={modelConsent} onChange={event=>setModelConsent(event.target.checked)} />
          {l('允许同账号设备将文本交给所选模型，并了解内容发送与费用。', 'Allow my devices to send text to the selected model; I understand the data transfer and possible charges.')}</label> : null}
        <button type="button" role="switch" aria-checked={!!models?.enabled} aria-label={l('允许这台电脑运行模型', 'Allow models on this computer')}
          className={buttonClass+' min-h-11'} disabled={!models?.enabled&&(!signedIn||!models?.capability||!modelPresetId||!modelConsent||busy||!!models?.busy)}
          onClick={()=>{setModelConsent(false);void run(()=>desktopAccount.setModelsEnabled(!models?.enabled,modelPresetId,models?.configurationToken??undefined));}}>
          {models?.enabled?l('停止让手机使用', 'Stop phone access'):l('允许手机使用这个 AI', 'Allow this AI on my phone')}</button>
        {signedIn&&!models?.capability?<p className="text-xs text-[var(--pq-text-muted)]">{l('当前同步服务尚未开启模型调用。', 'Model invocations are disabled on this sync service.')}</p>:null}
        {models?.errorCode?<p role="alert" className="text-sm leading-6 text-[var(--pq-error)]">{errorLabel(models.errorCode,l)}</p>:null}
        <details className="rounded-xl border border-[var(--pq-border)] p-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-[var(--pq-text)]">{l('查看使用记录与未保存内容', 'Usage history and unsaved work')}</summary>
          <p className="my-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('重新打开记录不会重新调用模型。“仅重试保存”只提交已收到的结果；若只有执行意图，会将原任务标记为结果未知。备份包含当次提示词和结果，请妥善保存。', 'Opening history never reruns a model. “Retry saving only” submits received output; an intent without output is marked unknown. Backups contain that request’s prompt and result.')}</p>
          {modelRecords.length?<ul className="divide-y divide-[var(--pq-border)]">{modelRecords.map(record=><li key={record.id} className="space-y-2 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2"><span className="min-w-0 break-words text-sm font-medium text-[var(--pq-text)]">{record.model}</span><span className="text-xs text-[var(--pq-text-muted)]">{record.stage==='acknowledged'?l('已保存','Saved'):record.hasOutput?l('结果待保存','Result awaiting save'):l('执行结果未知','Outcome unknown')}</span></div>
            <p className="break-all text-xs text-[var(--pq-text-muted)]">{new Date(record.createdAt).toLocaleString()}</p>
            {!record.canRecover&&record.stage!=='acknowledged'?<p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('原登录会话已变化，当前可备份这份记录。','The original sign-in session changed. You can back up this record.')}</p>:null}
            <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass+' min-h-11'} disabled={busy} onClick={()=>void run(async()=>{
              const owner=modelOwner.current,result=await desktopAccount.exportModelBackup(record.id);if(!alive.current||owner!==modelOwner.current)return;
              if(result.status==='exported')setNotice(l('本次请求与结果已备份。','Request and result backed up.'));
            })}>{l('备份本次请求与结果','Back up request and result')}</button>
            {record.canRecover?<button type="button" className={buttonClass+' min-h-11'} disabled={busy||!!models?.busy} onClick={()=>void run(()=>desktopAccount.retryModelSave(record.id))}>{l('继续保存到本机','Continue saving locally')}</button>:null}</div>
          </li>)}</ul>:<p className="py-3 text-sm text-[var(--pq-text-muted)]">{l('当前账号和文库暂无本机模型执行记录。','No local model history for this account and library.')}</p>}
          <div className="mt-3 border-t border-[var(--pq-border)] pt-3">
            <label className="flex min-h-11 items-start gap-3 text-xs leading-5 text-[var(--pq-text-muted)]"><input className="mt-0.5 h-5 w-5 shrink-0" type="checkbox" checked={clearModelsConfirmed} onChange={event=>setClearModelsConfirmed(event.target.checked)} />{l('确认清理本机已保存记录及结果副本，保留结果未确认的记录。','Clear local saved records and result copies, preserving all unconfirmed records.')}</label>
            <button type="button" className={buttonClass+' min-h-11 mt-2'} disabled={!signedIn||!!models?.enabled||!!models?.busy||busy||!clearModelsConfirmed} onClick={()=>{setClearModelsConfirmed(false);void run(()=>desktopAccount.clearCompletedModels());}}>{l('清理已保存的本机记录','Clear saved local records')}</button>
          </div>
        </details>
      </div>
    </SettingsField> : <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('这个同步服务暂未提供电脑 AI。请联系管理员开启，然后重新连接账号。', 'This service does not offer computer AI yet. Ask the administrator to enable it, then reconnect your account.')}</p> : null}
      {activeTask === 'processing' ? remote?.capability ? <div className="space-y-4">{!hasPublished ? <div className="rounded-xl bg-[var(--pq-surface-1)] p-4"><p className="text-sm text-[var(--pq-text-muted)]">{l('先添加需要处理的文献。AI 聊天可单独开启。', 'Add the papers to prepare first. AI chat can be enabled separately.')}</p><button type="button" className={buttonClass+' mt-2'} onClick={() => setActiveTask('files')}>{l('添加文献', 'Add papers')}</button></div> : null}<SettingsField label={l('让电脑帮手机整理文献内容', 'Let this computer prepare papers for your phone')}
      description={l('仅处理下方已关联的 PDF，使用本机当前保存的 MinerU 与 embedding 服务。这会发送 PDF 或解析文本，并可能产生服务费用；重启后保持关闭。', 'Only linked PDFs below are processed, using the MinerU and embedding services saved on this computer. PDFs or parsed text are sent and service charges may apply. This stays off after restart.')}>
      <div data-desktop-remote-tasks className="space-y-3">
        <div role="status" className="text-sm text-[var(--pq-text)]">{remote?.enabled
          ? remote.busy ? l('正在处理远程任务', 'Processing a remote task') : l('已开启，正在等待同账号任务', 'Enabled, waiting for your account’s tasks')
          : l('已关闭', 'Disabled')}</div>
        <ul className="space-y-1 text-xs text-[var(--pq-text-muted)]">
          {remote?.profiles.map((profile) => <li key={profile.id}>{profile.kind === 'parse' ? l('解析', 'Parse') : l('用于文献问答的检索', 'Search for paper questions')} · {profile.model}</li>)}
        </ul>
        {!remote?.profiles.some((profile) => profile.kind === 'parse') ? <p className="text-xs text-[var(--pq-text-muted)]">{l('还没有连接文献解析服务。', 'A document parsing service is not connected yet.')}</p> : null}
        {onNavigate ? <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} onClick={() => onNavigate('mineru')}>{l('设置文献解析', 'Set up document parsing')}</button><button type="button" className={buttonClass} onClick={() => onNavigate('models')}>{l('设置文献检索 AI', 'Set up search AI')}</button></div> : null}
        {!remote?.profiles.some((profile) => profile.kind === 'index') ? <p className="text-xs text-[var(--pq-text-muted)]">{remote?.unavailable.index === 'REMOTE_INDEX_INPUT_UNSUPPORTED'
          ? l('文献检索设置暂不兼容，请到 AI 服务检查检索选项。', 'Remote indexing currently supports plain input. Check embedding settings.')
          : l('文献问答的检索服务还没设置好，请先到 AI 服务完成配置。', 'Indexing requires saved embedding credentials, a model, and an explicit dimension.')}</p> : null}
        <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('向量任务只接受与目标版本一致的已验证解析包。停止会中止本机等待及后续请求；已受理的云任务可能仍继续并计费。', 'Indexing requires a verified parsed package for the exact file version. Stopping aborts local waiting and further requests; cloud work already accepted may continue and incur charges.')}</p>
        {!remote?.enabled ? <label className="flex items-start gap-2 text-xs leading-5 text-[var(--pq-text-muted)]"><input type="checkbox" checked={remoteConsent} onChange={(event) => setRemoteConsent(event.target.checked)} />
          {l('允许使用当前服务处理所选文献，并已了解内容发送与费用。', 'Allow these services to process selected papers; I understand the data transfer and possible charges.')}</label> : null}
        <button type="button" role="switch" aria-checked={!!remote?.enabled} aria-label={l('允许远程解析与向量任务', 'Allow remote parse and vector tasks')}
          className={buttonClass} disabled={!remote?.enabled && (!signedIn || !remote?.capability || !remote.profiles.length || !hasPublished || busy || !!remote.busy || !remoteConsent)}
          onClick={() => { const next = !remote?.enabled; setRemoteConsent(false); void run(() => desktopAccount.setRemoteTasksEnabled(next, remote?.configurationToken || undefined)); }}>
          {remote?.enabled ? l('停止处理文献', 'Stop preparing papers') : l('允许电脑处理这些文献', 'Allow this computer to prepare these papers')}</button>
        {signedIn && !remote?.capability ? <p className="text-xs text-[var(--pq-text-muted)]">{l('当前服务尚未开启远程任务。', 'Remote tasks are disabled on this service.')}</p> : null}
        {remote?.errorCode ? <p role="alert" className="text-xs leading-5 text-[var(--pq-error)]">{errorLabel(remote.errorCode, l)}</p> : null}
        <details className="rounded-xl border border-[var(--pq-border)] p-3"><summary className="cursor-pointer text-xs text-[var(--pq-text-muted)]">{l('清理本机已完成任务记录', 'Clear completed local task journals')}</summary>
          <p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('仅清理当前账号、服务和文库已完成的执行记录及其本机结果副本。保留 PDF、解析缓存、旧索引和服务端结果。请先停止远程任务。', 'Only completed execution journals and their local result copies for this account, service and library are cleared. PDFs, parsed caches, existing indexes and server results remain. Stop remote tasks first.')}</p>
          <label className="mt-2 flex items-start gap-2 text-xs text-[var(--pq-text-muted)]"><input type="checkbox" checked={clearRemoteConfirmed} onChange={(event) => setClearRemoteConfirmed(event.target.checked)} />{l('确认清理已完成的本机执行记录', 'Confirm clearing completed local journals')}</label>
          <button type="button" className={`${buttonClass} mt-2`} disabled={!signedIn || !!remote?.enabled || !!remote?.busy || busy || !clearRemoteConfirmed}
            onClick={() => { setClearRemoteConfirmed(false); void run(async () => { const owner = activeAccount.current; const result = await desktopAccount.clearCompletedRemoteJournals();
              if (alive.current && owner === activeAccount.current) setNotice(l(`已清理 ${result.removed} 条本机执行记录。`, `Cleared ${result.removed} local task journals.`)); }); }}>{l('清理已完成记录', 'Clear completed journals')}</button>
        </details>
      </div>
    </SettingsField></div> : <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('这个同步服务暂未提供文献处理。请联系管理员开启，然后重新连接账号。', 'This service does not offer document preparation yet. Ask the administrator to enable it, then reconnect your account.')}</p> : null}
      {activeTask === 'relations' ? <DesktopGraphExchangePanel l={l} accountActive={signedIn} ownerKey={status?.graphExchange?.scopeKey ?? null} /> : null}
      </>}
    </section>}
  </div>;
}
