import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  entityKey,
  listVisibleEntities,
  type EntityData,
  type NoteData,
  type PaperData,
  type PendingEdit,
  type VisibleEntity,
} from '../../../packages/sync-core/src/index.ts';
import { SyncApi, type ServerConflict } from './api.ts';
import { OidcSession } from './auth/oidc.ts';
import { parseAppConfig, type AppConfig, type PublicConfigInput } from './config.ts';
import { ContentPreview, EntityEditor } from './components/EntityEditor.tsx';
import { Icon } from './components/Icon.tsx';
import { ClientError, describeError } from './errors.ts';
import { assertM1WebRuntime } from './platform.ts';
import { AccountStore } from './storage/accountStore.ts';
import {
  decodeWorkspace,
  WorkspaceController,
  type StoredWorkspace,
  type WorkspaceSnapshot,
} from './sync/workspace.ts';
import { entityStatus, hasEntityConflict } from './viewState.ts';

const CONFIG_KEY = 'paperquay.mobile.public-config.v1';
const DEVICE_NAME_KEY = 'paperquay.mobile.device-name.v1';
type Section = 'library' | 'notes' | 'account' | 'conflicts';
interface Runtime {
  config: AppConfig;
  auth: OidcSession;
  controller: WorkspaceController;
}
function initialConfig(): PublicConfigInput {
  try {
    const local = localStorage.getItem(CONFIG_KEY);
    if (local) {
      const input = JSON.parse(local) as PublicConfigInput;
      parseAppConfig(input, location.origin);
      return input;
    }
  } catch {
    /* Invalid public settings are replaced by the configured defaults. */
  }
  return {
    apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
    oidcAuthority: import.meta.env.VITE_OIDC_AUTHORITY ?? '',
    oidcClientId: import.meta.env.VITE_OIDC_CLIENT_ID ?? '',
  };
}
function makeRuntime(input: PublicConfigInput): Runtime {
  assertM1WebRuntime();
  const config = parseAppConfig(input, location.origin);
  const auth = new OidcSession(config, sessionStorage);
  const controller = new WorkspaceController({
    apiBaseUrl: config.apiBaseUrl,
    api: new SyncApi(config.apiBaseUrl, auth.getAccessToken),
    store: new AccountStore<StoredWorkspace>({ decode: decodeWorkspace }),
    online: navigator.onLine,
  });
  return { config, auth, controller };
}

export function App() {
  const [input, setInput] = useState(initialConfig);
  const [runtime, setRuntime] = useState<Runtime | null>(() => {
    try {
      return makeRuntime(input);
    } catch {
      return null;
    }
  });
  const [configError, setConfigError] = useState<string | null>(null);
  async function configure(next: PublicConfigInput) {
    try {
      const parsed = parseAppConfig(next, location.origin);
      const clean = {
        apiBaseUrl: parsed.apiBaseUrl,
        oidcAuthority: parsed.oidcAuthority,
        oidcClientId: parsed.oidcClientId,
      };
      const replacement = makeRuntime(clean);
      if (runtime) {
        runtime.controller.deactivate();
        await runtime.auth.clearLocalSession();
      }
      localStorage.setItem(CONFIG_KEY, JSON.stringify(clean));
      setInput(clean);
      setRuntime(replacement);
      setConfigError(null);
    } catch (error) {
      setConfigError(describeError(error));
    }
  }
  if (!runtime)
    return (
      <div className="login-page">
        <Brand />
        <main className="login-panel">
          <span className="eyebrow">你的研究，随身继续</span>
          <h1>连接你的 PaperQuay</h1>
          <p className="muted">填写自托管服务提供的地址，然后使用账号登录。</p>
          <ConfigForm input={input} onSave={configure} />
          {configError && <ErrorMessage message={configError} />}
        </main>
      </div>
    );
  return (
    <ConnectedApp
      key={JSON.stringify(runtime.config)}
      runtime={runtime}
      configInput={input}
      onConfigure={configure}
      configError={configError}
    />
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Icon name="library" />
      </span>
      <span>PaperQuay</span>
    </div>
  );
}
function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="error-banner" role="alert">
      <Icon name="warning" />
      <span>{message}</span>
    </div>
  );
}

function ConnectedApp({
  runtime,
  configInput,
  onConfigure,
  configError,
}: {
  runtime: Runtime;
  configInput: PublicConfigInput;
  onConfigure: (input: PublicConfigInput) => Promise<void>;
  configError: string | null;
}) {
  const { auth, controller } = runtime;
  const authState = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [section, setSection] = useState<Section>('library');
  const [selection, setSelection] = useState<{ type: 'paper' | 'note'; id: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState(() => {
    try {
      return sessionStorage.getItem(DEVICE_NAME_KEY)?.slice(0, 80) || '我的 Web 浏览器';
    } catch {
      return '我的 Web 浏览器';
    }
  });
  const dirtyChanged = useCallback((value: boolean) => setDirty(value), []);

  useEffect(() => {
    if (location.pathname === '/auth/callback') {
      const callback = location.href;
      // Remove one-time authorization parameters before loading other application UI.
      history.replaceState(null, '', '/');
      void auth.completeSignIn(callback).catch((error) => setUiError(describeError(error)));
    }
    const onOnline = () => controller.setOnline(true);
    const onOffline = () => controller.setOnline(false);
    const onFocus = () => {
      if (document.visibilityState === 'visible') void controller.syncNow();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onFocus);
      controller.deactivate();
    };
  }, [auth, controller]);

  useEffect(() => {
    if (authState.status === 'signed-in')
      void controller.bind(deviceName).then(() => controller.syncNow());
    else if (authState.status === 'error') controller.requireLogin(authState.error);
    else if (authState.status === 'signed-out' || authState.status === 'signing-in') {
      controller.deactivate();
      setSelection(null);
      setDirty(false);
    }
  }, [authState.status, auth, controller]);
  useEffect(() => {
    if (!dirty) return;
    const confirmClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', confirmClose);
    return () => window.removeEventListener('beforeunload', confirmClose);
  }, [dirty]);

  function canLeave(): boolean {
    return !dirty || window.confirm('当前编辑还没有保存。放弃这些未保存的文字？');
  }
  function navigate(next: Section) {
    if (!canLeave()) return;
    setSection(next);
    setSelection(null);
    setDirty(false);
    setUiError(null);
  }
  function select(type: 'paper' | 'note', id: string) {
    if (!canLeave()) return;
    setSelection({ type, id });
    setDirty(false);
    setUiError(null);
  }
  async function login() {
    if (!canLeave()) return;
    const revoked = state.error?.code === 'SESSION_REVOKED';
    controller.deactivate();
    setSelection(null);
    setDirty(false);
    setUiError(null);
    try {
      if (revoked) await auth.signOut();
      else await auth.signIn();
    } catch (error) {
      setUiError(describeError(error));
    }
  }
  async function logout() {
    if (!canLeave()) return;
    controller.deactivate();
    setSelection(null);
    setDirty(false);
    try {
      await auth.signOut();
    } catch (error) {
      setUiError(describeError(error));
    }
  }
  const entities = useMemo(
    () => (state.workspace ? listVisibleEntities(state.workspace.sync) : []),
    [state.workspace],
  );
  const papers = entities.filter((entity) => entity.entityType === 'paper');
  const notes = entities.filter((entity) => entity.entityType === 'note');
  const conflictCount = new Set([
    ...state.conflicts.map((conflict) => conflict.conflictId),
    ...Object.keys(state.workspace?.sync.conflicts ?? {}),
  ]).size;
  const nav = (
    <>
      <NavButton
        active={section === 'library'}
        label="文库"
        icon="library"
        onClick={() => navigate('library')}
      />
      <NavButton
        active={section === 'notes'}
        label="笔记"
        icon="note"
        onClick={() => navigate('notes')}
      />
      <NavButton
        active={section === 'account' || section === 'conflicts'}
        label="账号"
        icon="account"
        onClick={() => navigate('account')}
      />
    </>
  );
  const ready = state.status === 'ready' && state.workspace;
  const error = uiError ?? configError ?? (state.error ? describeError(state.error) : null);

  if (!ready)
    return (
      <div className="login-page">
        <Brand />
        <main className="login-panel">
          <span className="eyebrow">文献与想法，随时接续</span>
          <h1>{state.status === 'binding' ? '正在打开你的文库' : '登录到你的文库'}</h1>
          <p className="muted">使用你的 PaperQuay 账号，继续整理文献和 Markdown 笔记。</p>
          {state.status === 'binding' ? (
            <p className="connecting" role="status">
              <Icon name="sync" className="spin" />
              正在确认设备并读取本地改动…
            </p>
          ) : (
            <>
              <label className="field">
                此设备的名称
                <input
                  value={deviceName}
                  onChange={(event) => {
                    setDeviceName(event.target.value);
                    try {
                      sessionStorage.setItem(DEVICE_NAME_KEY, event.target.value.slice(0, 80));
                    } catch {
                      /* The name remains editable even when optional preferences cannot be stored. */
                    }
                  }}
                  maxLength={80}
                />
              </label>
              <button
                className="primary full-width"
                disabled={authState.status === 'signing-in'}
                onClick={() => void login()}
              >
                {authState.status === 'signing-in'
                  ? '正在前往登录…'
                  : state.error?.code === 'SESSION_REVOKED'
                    ? '退出旧会话'
                    : '登录'}
              </button>
            </>
          )}
          {error && <ErrorMessage message={error} />}
          <details className="service-settings">
            <summary>服务设置</summary>
            <ConfigForm input={configInput} onSave={onConfigure} />
          </details>
          <p className="privacy-note">
            内容按账号保存在此浏览器。刷新后需重新登录；已确认保存的改动会保留。
          </p>
        </main>
      </div>
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="主导航">{nav}</nav>
        <div className="sidebar-account">
          <Icon name="account" />
          <div>
            <strong>{authState.displayName || '我的账号'}</strong>
            <span>{state.needsLogin ? '请重新登录' : '已连接'}</span>
          </div>
        </div>
      </aside>
      <header className="mobile-header">
        <Brand />
        <button className="icon-button" aria-label="账号设置" onClick={() => navigate('account')}>
          <Icon name="account" />
        </button>
      </header>
      <main className={`main-content section-${section}`}>
        {error && (
          <div className="global-message">
            <ErrorMessage message={error} />
            {state.needsLogin && (
              <button className="text-button" onClick={() => void login()}>
                {state.error?.code === 'SESSION_REVOKED' ? '退出旧会话' : '重新登录'}
              </button>
            )}
          </div>
        )}
        {(section === 'library' || section === 'notes') && (
          <div className={`workspace-grid ${selection ? 'has-selection' : ''}`}>
            <EntityList
              type={section === 'library' ? 'paper' : 'note'}
              entities={section === 'library' ? papers : notes}
              selection={selection?.id}
              state={state}
              conflicts={conflictCount}
              onSelect={select}
              onCreate={(type) => select(type, crypto.randomUUID())}
              onSync={() => void controller.syncNow()}
              onConflicts={() => navigate('conflicts')}
            />
            {selection ? (
              <EntityEditor
                key={`${selection.type}:${selection.id}`}
                type={selection.type}
                entityId={selection.id}
                entity={entities.find(
                  (entity) =>
                    entity.entityId === selection.id && entity.entityType === selection.type,
                )}
                hasConflict={hasEntityConflict(state.workspace!.sync, {
                  entityType: selection.type,
                  entityId: selection.id,
                })}
                papers={papers}
                controller={controller}
                onBack={() => {
                  if (canLeave()) {
                    setSelection(null);
                    setDirty(false);
                  }
                }}
                onDirty={dirtyChanged}
                onConflicts={() => navigate('conflicts')}
              />
            ) : (
              <div className="editor-placeholder">
                <Icon name={section === 'library' ? 'library' : 'note'} />
                <h2>{section === 'library' ? '打开一篇文献' : '让想法在这里展开'}</h2>
                <p>
                  {section === 'library'
                    ? '查看和补充题录信息，也可以为它关联笔记。'
                    : '选择一条笔记继续写作，或记录新的想法。'}
                </p>
              </div>
            )}
          </div>
        )}
        {section === 'account' && (
          <AccountView
            state={state}
            displayName={authState.displayName}
            conflicts={conflictCount}
            config={runtime.config}
            onConflicts={() => navigate('conflicts')}
            onSync={() => void controller.syncNow()}
            onLogout={() => void logout()}
            onLogin={() => void login()}
            onClear={async () => {
              if (
                window.confirm(
                  '清除此账号在本浏览器的本地副本？尚未同步的改动将丢失，服务器上的内容会在下次同步时重新下载。',
                )
              ) {
                try {
                  await controller.clearLocalData();
                } catch (problem) {
                  setUiError(describeError(problem));
                }
              }
            }}
            onRevoke={async (id) => {
              if (!window.confirm('撤销这个登录会话？该会话的下一次请求将被拒绝。')) return;
              try {
                const current = await controller.revokeDevice(id);
                if (current) {
                  controller.deactivate();
                  await auth.signOut();
                }
              } catch (problem) {
                setUiError(describeError(problem));
              }
            }}
          />
        )}
        {section === 'conflicts' && (
          <ConflictsView
            state={state}
            controller={controller}
            onBack={() => navigate('account')}
            onDirty={dirtyChanged}
            onRecovered={(id) => {
              setDirty(false);
              setSection('notes');
              setSelection({ type: 'note', id });
              setUiError(null);
            }}
          />
        )}
      </main>
      <nav className="bottom-nav" aria-label="主导航">
        {nav}
      </nav>
    </div>
  );
}

function NavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: 'library' | 'note' | 'account';
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`nav-button ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

function SyncStatus({
  state,
  conflicts,
  onSync,
  onConflicts,
}: {
  state: WorkspaceSnapshot;
  conflicts: number;
  onSync: () => void;
  onConflicts: () => void;
}) {
  const pending =
    (state.workspace?.sync.outbox.length ?? 0) +
    Object.keys(state.workspace?.pendingResolutions ?? {}).length;
  const blocked = state.workspace?.sync.outbox.some(
    (entry) => entry.status === 'rejected' || entry.status === 'device-blocked',
  );
  const label = state.needsLogin
    ? '请重新登录'
    : conflicts
      ? `${conflicts} 项冲突待处理`
      : !state.online
        ? pending
          ? `离线 · ${pending} 项待同步`
          : '离线 · 本地内容可用'
        : state.syncing
          ? '同步中'
          : blocked
            ? '部分改动同步受阻'
            : pending
              ? `${pending} 项待同步`
              : state.lastSyncedAt
                ? '已同步'
                : '等待首次同步';
  return (
    <div
      className={`sync-status ${conflicts || blocked || state.needsLogin ? 'needs-attention' : ''}`}
    >
      <span role="status">
        <Icon
          name={
            !state.online
              ? 'offline'
              : conflicts || blocked
                ? 'warning'
                : state.syncing
                  ? 'sync'
                  : 'check'
          }
          className={state.syncing ? 'spin' : ''}
        />
        {label}
      </span>
      <button
        className="text-button"
        disabled={state.syncing || (!conflicts && (state.needsLogin || !state.online))}
        onClick={conflicts ? onConflicts : onSync}
      >
        {conflicts ? '查看冲突' : '同步'}
      </button>
    </div>
  );
}

function EntityList({
  type,
  entities,
  selection,
  state,
  conflicts,
  onSelect,
  onCreate,
  onSync,
  onConflicts,
}: {
  type: 'paper' | 'note';
  entities: VisibleEntity[];
  selection?: string;
  state: WorkspaceSnapshot;
  conflicts: number;
  onSelect: (type: 'paper' | 'note', id: string) => void;
  onCreate: (type: 'paper' | 'note') => void;
  onSync: () => void;
  onConflicts: () => void;
}) {
  const [query, setQuery] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const noun = type === 'paper' ? '文献' : '笔记';
  const visible = entities.filter((entity) => (showDeleted ? entity.deleted : !entity.deleted));
  const filtered = visible.filter((entity) => {
    const data = entity.data;
    const values =
      data && 'authors' in data
        ? [
            data.title,
            ...data.authors,
            ...data.keywords,
            data.year,
            data.doi,
            data.publication,
            data.abstractText,
          ]
        : data && 'body' in data
          ? [data.title, data.body]
          : [];
    return (
      !query.trim() ||
      values.some((value) => value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    );
  });
  return (
    <section className="list-pane" aria-label={type === 'paper' ? '文库' : '笔记列表'}>
      <div className="list-heading">
        <h1>{type === 'paper' ? '文库' : '笔记'}</h1>
        <button className="add-button" onClick={() => onCreate(type)}>
          <Icon name="plus" />
          <span>{type === 'paper' ? '添加文献' : '新建笔记'}</span>
        </button>
      </div>
      <SyncStatus state={state} conflicts={conflicts} onSync={onSync} onConflicts={onConflicts} />
      <label className="search-box">
        <Icon name="search" />
        <span className="sr-only">搜索{noun}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`搜索${noun}`}
        />
      </label>
      <div className="list-meta">
        <span>
          {filtered.length} {type === 'paper' ? '篇文献' : '条笔记'}
        </span>
        <label>
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(event) => setShowDeleted(event.target.checked)}
          />
          已删除
        </label>
      </div>
      <div className="entity-list">
        {!filtered.length && (
          <div className="empty-state">
            <Icon name={type === 'paper' ? 'library' : 'note'} />
            <h2>
              {query
                ? '没有找到匹配内容'
                : showDeleted
                  ? '没有已删除的内容'
                  : type === 'paper'
                    ? '从第一篇文献开始'
                    : '记下一个新想法'}
            </h2>
            <p>
              {query
                ? '换一个标题、作者或关键词试试。'
                : showDeleted
                  ? '删除的记录会在这里保留状态。'
                  : `添加${noun}后，内容会先保存在此设备。`}
            </p>
            {!query && !showDeleted && (
              <button className="secondary" onClick={() => onCreate(type)}>
                {type === 'paper' ? '添加文献' : '新建笔记'}
              </button>
            )}
          </div>
        )}
        {filtered.map((entity) => {
          const data = entity.data as PaperData | NoteData | null;
          return (
            <button
              key={entity.entityId}
              className={`entity-row ${type === 'paper' ? 'paper-row' : ''} ${selection === entity.entityId ? 'selected' : ''}`}
              onClick={() => onSelect(type, entity.entityId)}
              aria-pressed={selection === entity.entityId}
            >
              {type === 'paper' && <Icon name="note" className="row-document-icon" />}
              <span className="entity-copy">
                <span className="entity-title">
                  {data?.title || (entity.deleted ? '已删除的内容' : '未命名笔记')}
                </span>
                {data && 'authors' in data ? (
                  <>
                    <span className="entity-subtitle">
                      {data.authors.slice(0, 3).join(' · ') || '作者未填写'}
                      {data.year ? ` · ${data.year}` : ''}
                    </span>
                    {data.publication && <span className="entity-source">{data.publication}</span>}
                    {data.abstractText && (
                      <span className="paper-excerpt">{data.abstractText}</span>
                    )}
                  </>
                ) : data && 'body' in data ? (
                  <span className="note-excerpt">
                    {data.body.replace(/[#*_`>]/g, '').slice(0, 130) || '暂无正文'}
                  </span>
                ) : null}
                <span className={`row-state ${entity.pending ? 'pending' : ''}`}>
                  {entity.deleted
                    ? '已删除'
                    : entityStatus(
                        entity,
                        Boolean(state.workspace && hasEntityConflict(state.workspace.sync, entity)),
                      )}
                </span>
              </span>
              {type === 'paper' && <Icon name="chevron" className="row-chevron" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ConfigForm({
  input,
  onSave,
}: {
  input: PublicConfigInput;
  onSave: (input: PublicConfigInput) => Promise<void>;
}) {
  const [form, setForm] = useState(input);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="config-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onSave(form).finally(() => setBusy(false));
      }}
    >
      <label className="field">
        同步服务地址
        <input
          type="url"
          required
          value={form.apiBaseUrl ?? ''}
          onChange={(event) => setForm({ ...form, apiBaseUrl: event.target.value })}
          placeholder="https://sync.example.com"
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <label className="field">
        账号服务地址
        <input
          type="url"
          required
          value={form.oidcAuthority ?? ''}
          onChange={(event) => setForm({ ...form, oidcAuthority: event.target.value })}
          placeholder="https://id.example.com/realms/paperquay"
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <label className="field">
        客户端标识
        <input
          required
          value={form.oidcClientId ?? ''}
          onChange={(event) => setForm({ ...form, oidcClientId: event.target.value })}
          placeholder="paperquay-mobile"
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <button className="secondary" disabled={busy} type="submit">
        {busy ? '正在保存…' : '保存服务设置'}
      </button>
    </form>
  );
}

function AccountView({
  state,
  displayName,
  conflicts,
  config,
  onConflicts,
  onSync,
  onLogout,
  onLogin,
  onClear,
  onRevoke,
}: {
  state: WorkspaceSnapshot;
  displayName?: string;
  conflicts: number;
  config: AppConfig;
  onConflicts: () => void;
  onSync: () => void;
  onLogout: () => void;
  onLogin: () => void;
  onClear: () => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const action = (task: () => Promise<void>) => {
    setBusy(true);
    void task().finally(() => setBusy(false));
  };
  const blocked =
    state.workspace?.sync.outbox.filter((entry) =>
      ['rejected', 'device-blocked'].includes(entry.status),
    ) ?? [];
  return (
    <div className="account-page">
      <header className="page-heading">
        <h1>账号</h1>
        <span className="eyebrow">{displayName || '我的 PaperQuay'}</span>
      </header>
      <section className="account-section">
        <h2>同步状态</h2>
        <SyncStatus state={state} conflicts={conflicts} onSync={onSync} onConflicts={onConflicts} />
        {state.lastSyncedAt && (
          <p className="muted">上次完成：{new Date(state.lastSyncedAt).toLocaleString('zh-CN')}</p>
        )}
        {state.needsLogin && (
          <button className="primary" onClick={onLogin}>
            {state.error?.code === 'SESSION_REVOKED' ? '退出旧会话' : '重新登录'}
          </button>
        )}
        {blocked.map((entry) => (
          <p key={entry.operation.opId} className="inline-error">
            {entry.operation.entityType === 'note' ? '笔记' : '记录'}
            已保存在此设备，同步受阻。错误码：{entry.errorCode || 'REJECTED'}
          </p>
        ))}
      </section>
      <section className="account-section">
        <h2>登录设备</h2>
        <p className="muted">撤销会使该登录会话的下一次请求失效。</p>
        {!state.devices.length && <p className="muted">同步后会显示设备列表。</p>}
        <ul className="device-list">
          {state.devices.map((device) => (
            <li key={device.id}>
              <Icon name="device" />
              <div className="device-info">
                <strong>
                  {device.name}
                  {device.id === state.identity?.device.id && (
                    <span className="device-badge">当前设备</span>
                  )}
                </strong>
                <span>
                  {device.revokedAt
                    ? '已撤销'
                    : `最近活动 ${new Date(device.lastSeenAt).toLocaleString('zh-CN')}`}
                </span>
              </div>
              {!device.revokedAt && (
                <button
                  className="text-button danger-text"
                  disabled={busy || state.needsLogin || !state.online}
                  onClick={() => action(() => onRevoke(device.id))}
                >
                  撤销
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="account-section">
        <h2>此设备上的内容</h2>
        <p className="muted">清理只影响此浏览器的账号副本。未同步改动也会被清除。</p>
        <button
          className="secondary danger-text"
          disabled={busy || state.syncing}
          onClick={() => action(onClear)}
        >
          清除此账号的本机副本
        </button>
      </section>
      <section className="account-section">
        <h2>服务连接</h2>
        <dl className="service-info">
          <dt>同步服务</dt>
          <dd>{new URL(config.apiBaseUrl).host}</dd>
          <dt>账号服务</dt>
          <dd>{new URL(config.oidcAuthority).host}</dd>
        </dl>
        <p className="muted">退出后可以更换服务。已保存的本机内容按账号和服务分别保留。</p>
        <button className="secondary" onClick={onLogout}>
          <Icon name="logout" />
          退出登录
        </button>
      </section>
    </div>
  );
}

export function ConflictsView({
  state,
  controller,
  onBack,
  onDirty,
  onRecovered,
}: {
  state: WorkspaceSnapshot;
  controller: Pick<WorkspaceController, 'resolve' | 'save' | 'getSnapshot' | 'syncNow'>;
  onBack: () => void;
  onDirty: (dirty: boolean) => void;
  onRecovered: (noteId: string) => void;
}) {
  const [selected, setSelected] = useState<ServerConflict | null>(null);
  const [mergedTitle, setMergedTitle] = useState('');
  const [mergedBody, setMergedBody] = useState('');
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const [reviewedOverlay, setReviewedOverlay] = useState<PendingEdit | null>(null);
  const [mergeDirty, setMergeDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftSession = useRef<object | null>(null);
  const conflict =
    state.conflicts.find((entry) => entry.conflictId === selected?.conflictId) ??
    selected ??
    state.conflicts[0];
  const closed = Boolean(
    conflict && !state.conflicts.some((entry) => entry.conflictId === conflict.conflictId),
  );
  const latestOverlay = conflict
    ? (state.workspace?.sync.overlays[entityKey(conflict.entityType, conflict.entityId)] ?? null)
    : null;
  useEffect(() => {
    // Keep the selected conflict snapshot when a remote refresh removes its ID.
    // Only an explicit selection or completed local decision may replace this draft.
    if (conflict && !closed) setSelected(conflict);
  }, [conflict, closed]);
  useLayoutEffect(() => {
    // Invalidate during commit before an old request can affect a replacement draft or page.
    const session = {};
    draftSession.current = session;
    const data = latestOverlay?.data ?? conflict?.attemptedOperation.data;
    setMergedTitle(data && 'title' in data ? data.title : '');
    setMergedBody(data && 'body' in data ? data.body : '');
    setReviewedRevision(conflict?.currentRecord?.revision ?? 0);
    setReviewedOverlay(latestOverlay);
    setMergeDirty(false);
    setBusy(false);
    onDirty(false);
    setError(null);
    return () => {
      if (draftSession.current === session) draftSession.current = null;
    };
  }, [conflict?.conflictId, controller]);
  async function resolve(choice: 'current' | 'attempted' | 'merged' | 'restore') {
    const session = draftSession.current;
    if (!session || !conflict || closed) return;
    if (
      !controller.getSnapshot().conflicts.some((entry) => entry.conflictId === conflict.conflictId)
    ) {
      setError('此冲突已在服务端关闭。合并草稿仍保留。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const reviewed = { consumedOverlayOpId: reviewedOverlay?.opId };
      if (choice === 'current') await controller.resolve(conflict, { choice }, reviewed);
      else if (choice === 'attempted' && reviewedOverlay)
        await controller.resolve(
          conflict,
          { choice: 'merged', mutation: reviewedOverlay.mutation, data: reviewedOverlay.data },
          reviewed,
        );
      else if (choice === 'attempted') await controller.resolve(conflict, { choice }, reviewed);
      else {
        const source = reviewedOverlay ? reviewedOverlay.data : conflict.attemptedOperation.data;
        if (!source) throw new ClientError('CONFLICT_CHANGED');
        const data: EntityData =
          'body' in source ? { ...source, title: mergedTitle, body: mergedBody } : source;
        await controller.resolve(
          conflict,
          { choice: 'merged', mutation: choice === 'restore' ? 'restore' : 'put', data },
          reviewed,
        );
      }
      if (draftSession.current !== session) return;
      const after = controller.getSnapshot();
      if (
        !after.error &&
        !after.workspace?.pendingResolutions[conflict.conflictId] &&
        !after.conflicts.some((entry) => entry.conflictId === conflict.conflictId)
      ) {
        setMergeDirty(false);
        onDirty(false);
        setSelected(null);
      }
    } catch (problem) {
      if (draftSession.current === session) setError(describeError(problem));
    } finally {
      if (draftSession.current === session) setBusy(false);
    }
  }
  const pending = conflict && state.workspace?.pendingResolutions[conflict.conflictId];
  const changedSinceReview =
    !closed && Boolean(conflict) && reviewedRevision !== (conflict?.currentRecord?.revision ?? 0);
  const localChangedSinceReview = !closed && latestOverlay?.opId !== reviewedOverlay?.opId;
  const myVersion = reviewedOverlay ?? conflict?.attemptedOperation;
  const tombstone = Boolean(conflict?.currentRecord?.deletedAt);
  const note = myVersion?.entityType === 'note' && myVersion.data?.format === 'markdown';
  const blocked =
    closed ||
    busy ||
    Boolean(pending) ||
    state.needsLogin ||
    !state.online ||
    changedSinceReview ||
    localChangedSinceReview;
  const markMergeDirty = () => {
    setMergeDirty(true);
    onDirty(true);
  };
  async function recoverDraft() {
    const session = draftSession.current;
    if (
      !session ||
      !closed ||
      busy ||
      pending ||
      !note ||
      !myVersion?.data ||
      !('body' in myVersion.data)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const id = crypto.randomUUID();
      await controller.save({
        entityType: 'note',
        entityId: id,
        mutation: 'put',
        data: { ...myVersion.data, title: mergedTitle, body: mergedBody },
      });
      if (draftSession.current !== session) return;
      setMergeDirty(false);
      onDirty(false);
      onRecovered(id);
    } catch (problem) {
      if (draftSession.current === session) setError(describeError(problem));
    } finally {
      if (draftSession.current === session) setBusy(false);
    }
  }
  return (
    <div className="conflicts-page">
      <header className="page-heading">
        <button className="text-button" onClick={onBack}>
          <Icon name="back" />
          账号
        </button>
        <h1>处理同步冲突</h1>
        <p className="muted">
          比较当前版本与本机保存的版本，再选择或合并。保留当前版本会放弃下方显示的本机版本；决定之后的新改动仍会保留。
        </p>
      </header>
      {!conflict ? (
        <div className="empty-state">
          <Icon name="check" />
          <h2>
            {Object.keys(state.workspace?.sync.conflicts ?? {}).length
              ? '需要连接服务查看最新冲突'
              : '没有待处理的冲突'}
          </h2>
          <button
            className="secondary"
            onClick={() => void controller.syncNow()}
            disabled={state.syncing || state.needsLogin || !state.online}
          >
            刷新同步状态
          </button>
        </div>
      ) : (
        <>
          {(state.conflicts.length > 1 || (closed && state.conflicts.length > 0)) && (
            <label className="field">
              选择冲突
              <select
                value={conflict.conflictId}
                onChange={(event) => {
                  if (!mergeDirty || window.confirm('放弃尚未保存的合并草稿，查看另一项冲突？'))
                    setSelected(
                      state.conflicts.find((entry) => entry.conflictId === event.target.value) ??
                        selected,
                    );
                }}
              >
                {closed && <option value={conflict.conflictId}>已关闭 · 当前合并草稿</option>}
                {state.conflicts.map((entry) => (
                  <option value={entry.conflictId} key={entry.conflictId}>
                    {entry.attemptedOperation.data && 'title' in entry.attemptedOperation.data
                      ? entry.attemptedOperation.data.title || '未命名笔记'
                      : '记录冲突'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {closed && (
            <div className="draft-review" role="status">
              <p>
                此冲突已在服务端关闭。
                {note ? '合并草稿仍保留，可继续编辑并另存为新笔记。' : '下方保留关闭前的比较内容。'}
              </p>
              {note && (
                <button
                  className="secondary"
                  disabled={busy || Boolean(pending)}
                  onClick={() => void recoverDraft()}
                >
                  另存为新笔记
                </button>
              )}
            </div>
          )}
          <div className="conflict-columns">
            <section>
              <h2>{closed ? '关闭前比较的版本' : '当前版本'}</h2>
              <p className="muted">版本 {conflict.currentRecord?.revision ?? 0}</p>
              <ContentPreview data={conflict.currentRecord?.data ?? null} deleted={tombstone} />
              <button
                className="secondary"
                disabled={blocked}
                onClick={() => void resolve('current')}
              >
                保留当前版本
              </button>
            </section>
            <section>
              <h2>我的版本</h2>
              <p className="muted">
                {reviewedOverlay
                  ? '冲突后在本机保存的最新版本'
                  : `原提交 · 基于版本 ${conflict.attemptedOperation.baseRevision}`}
              </p>
              <ContentPreview
                data={myVersion?.data ?? null}
                deleted={myVersion?.mutation === 'delete'}
              />
              {reviewedOverlay && (
                <details className="original-attempt">
                  <summary>查看产生冲突的原提交</summary>
                  <ContentPreview
                    data={conflict.attemptedOperation.data}
                    deleted={conflict.attemptedOperation.mutation === 'delete'}
                  />
                </details>
              )}
              {!tombstone && (
                <button
                  className="secondary"
                  disabled={blocked}
                  onClick={() => void resolve('attempted')}
                >
                  使用我的版本
                </button>
              )}
            </section>
          </div>
          {changedSinceReview && (
            <div className="draft-review">
              <p>当前版本再次更新。合并草稿仍然保留，请重新比较上方内容。</p>
              <button
                className="secondary"
                onClick={() => setReviewedRevision(conflict.currentRecord?.revision ?? 0)}
              >
                已重新比较当前版本
              </button>
            </div>
          )}
          {localChangedSinceReview && (
            <div className="draft-review">
              <p>本机又保存了新版本。合并草稿仍然保留，请先更新右侧比较内容。</p>
              <button className="secondary" onClick={() => setReviewedOverlay(latestOverlay)}>
                查看本机新保存版本
              </button>
            </div>
          )}
          {note && (
            <section className="merge-editor">
              <h2>{closed ? '保留的合并草稿' : tombstone ? '明确恢复此笔记' : '合并双方内容'}</h2>
              <label className="field">
                笔记标题
                <input
                  value={mergedTitle}
                  onChange={(event) => {
                    setMergedTitle(event.target.value);
                    markMergeDirty();
                  }}
                  maxLength={2048}
                  disabled={busy || Boolean(pending)}
                />
              </label>
              <label className="field">
                合并后的 Markdown 正文
                <textarea
                  rows={10}
                  value={mergedBody}
                  onChange={(event) => {
                    setMergedBody(event.target.value);
                    markMergeDirty();
                  }}
                  maxLength={262144}
                  disabled={busy || Boolean(pending)}
                />
              </label>
              <button
                className="primary"
                disabled={blocked}
                onClick={() => void resolve(tombstone ? 'restore' : 'merged')}
              >
                {tombstone ? '恢复为这个新版本' : '保存合并版本'}
              </button>
            </section>
          )}
          {tombstone && !note && myVersion?.data && (
            <button className="primary" disabled={blocked} onClick={() => void resolve('restore')}>
              明确恢复我的版本
            </button>
          )}
          {pending && (
            <p role="status" className="pending-resolution">
              解决请求已保存在此设备，等待服务确认。
              <button
                className="text-button"
                onClick={() => void controller.syncNow()}
                disabled={state.syncing || state.needsLogin || !state.online}
              >
                重试确认
              </button>
            </p>
          )}
          {error && <ErrorMessage message={error} />}
        </>
      )}
    </div>
  );
}
