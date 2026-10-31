import {MobileModelRouter} from './modelRouting/router.ts';
import type {ModelInvocationApi} from './modelRouting/api.ts';
import {fetchAiTransport} from './ai/transport.ts';
import {
  lazy,
  Suspense,
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
import { SyncApi, type ServerConflict, type ServiceCapabilitySnapshot } from './api.ts';
import type { FeatureAction } from './capabilities/catalog.ts';
import { createAuthSession, type AuthSession } from './auth/oidc.ts';
import { parseAppConfig, type AppConfig, type PublicConfigInput } from './config.ts';
import { ContentPreview, EntityEditor } from './components/EntityEditor.tsx';
import { Icon } from './components/Icon.tsx';
import { ClientError, describeError } from './errors.ts';
import { assertPlatformReady, getPlatformCapabilities } from './platform.ts';
import { accountScopeKey, createAccountStorage } from './storage/accountStore.ts';
import { createSecretStore, type SecretStore } from './platform/secretStore.ts';
import { verifiedBinding } from './storage/verifiedBinding.ts';
import { filterPapers, organizationOf, readingStatusLabels } from './library/organization.ts';
import type { PdfAiContext, PdfCitationTarget } from './pdf/types.ts';
import type { CloudPdfContext } from './pdf/cloudCopies.ts';
import type { DesktopPdfContext } from './pdf/desktopCopies.ts';
import { saveAiResultNote } from './integration/aiNotes.ts';
import { createAiSyncBridge } from './integration/aiSync.ts';
import type { RemoteTaskContext } from './remote/client.ts';
import {
  decodeWorkspace,
  WorkspaceController,
  type StoredWorkspace,
  type WorkspaceSnapshot,
} from './sync/workspace.ts';
import { getIncomingShareClient } from './platform/incomingShare.ts';
import { assertPreparedIncomingShareSource, type PreparedSource } from './library/incomingShare.ts';
import { entityStatus, hasEntityConflict } from './viewState.ts';

const CONFIG_KEY = 'paperquay.mobile.public-config.v1';
const DEVICE_NAME_KEY = 'paperquay.mobile.device-name.v1';
type Section = 'library' | 'notes' | 'account' | 'conflicts';

interface ListViewState {
  query: string;
  showDeleted: boolean;
  favorite: boolean;
  readingStatus: '' | 'unread' | 'reading' | 'read';
  tag: string;
  collection: string;
  year: string;
  queued: boolean;
}
function createListView(): ListViewState {
  return { query: '', showDeleted: false, favorite: false, readingStatus: '', tag: '', collection: '', year: '', queued: false };
}
function createListViews() {
  return { paper: createListView(), note: createListView() };
}
function listViewScope(apiBaseUrl: string, authStatus: string, subjectKey: string, state: WorkspaceSnapshot) {
  if (state.status !== 'ready' || !state.workspace) return null;
  const { accountId, deviceId, generation } = state.workspace.sync;
  return JSON.stringify([apiBaseUrl, authStatus, subjectKey, accountId, deviceId, generation]);
}

const PaperReader = lazy(() => import('./components/PaperReader.tsx').then((module) => ({ default: module.PaperReader })));
const ReaderSheet = lazy(() => import('./components/ReaderSheet.tsx').then((module) => ({ default: module.ReaderSheet })));
const AiWorkspace = lazy(() => import('./components/AiWorkspace.tsx').then((module) => ({ default: module.AiWorkspace })));
const LibraryTransferPanel = lazy(() => import('./components/LibraryTransferPanel.tsx').then((module) => ({ default: module.LibraryTransferPanel })));
const IncomingSharePanel = lazy(() => import('./components/IncomingSharePanel.tsx').then(module => ({ default: module.IncomingSharePanel })));
const CloudPdfLibrary = lazy(() => import('./components/CloudPdfPanel.tsx').then((module) => ({ default: module.CloudPdfLibrary })));
const CapabilitySheet = lazy(() => import('./components/CapabilitySheet.tsx').then(module => ({default:module.CapabilitySheet})));
const RemoteTaskPanel = lazy(() => import('./components/RemoteTaskPanel.tsx').then(module => ({ default: module.RemoteTaskPanel })));
const ZoteroLibrarySheet = lazy(() => import('./components/ZoteroLibrarySheet.tsx').then(module => ({ default: module.ZoteroLibrarySheet })));
const AgentWorkspace = lazy(()=>import('./components/AgentWorkspace.tsx').then(module=>({default:module.AgentWorkspace})));
const RadarWorkspace = lazy(()=>import('./components/RadarWorkspace.tsx').then(module=>({default:module.RadarWorkspace})));
const KnowledgeGraphSheet = lazy(()=>import('./components/KnowledgeGraphSheet.tsx').then(module=>({default:module.KnowledgeGraphSheet})));
const ReviewWorkspace = lazy(() => import('./components/ReviewWorkspace.tsx').then(module => ({ default: module.ReviewWorkspace })));
const ResearchWorkspace = lazy(() => import('./components/ResearchWorkspace.tsx').then(module => ({ default: module.ResearchWorkspace })));
const NoteExportPanel = lazy(() => import('./components/NoteExportPanel.tsx').then(module => ({ default: module.NoteExportPanel })));
const COMPACT_READER_QUERY = '(max-width: 900px)';
function compactReaderSnapshot() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(COMPACT_READER_QUERY).matches;
}
function subscribeCompactReader(listener: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(COMPACT_READER_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
interface Runtime {
  config: AppConfig;
  auth: AuthSession;
  controller: WorkspaceController;
  secretStore?: SecretStore;
  cloudPdf?: CloudPdfContext;
  desktopPdf?: DesktopPdfContext;
  remoteTasks?: RemoteTaskContext;
  modelInvocations?:ModelInvocationApi;
  inspectCapabilities?(signal:AbortSignal):Promise<ServiceCapabilitySnapshot>;
  dispose?: () => Promise<void>;
}
function initialConfig(): PublicConfigInput {
  try {
    const local = localStorage.getItem(CONFIG_KEY);
    if (local) {
      const input = JSON.parse(local) as PublicConfigInput;
      parseAppConfig(input, location.origin, getPlatformCapabilities().native);
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
async function makeRuntime(input: PublicConfigInput): Promise<Runtime> {
  assertPlatformReady();
  const config = parseAppConfig(input, location.origin, getPlatformCapabilities().native);
  const results = await Promise.allSettled([
    createAuthSession(config), createAccountStorage<StoredWorkspace>({ decode: decodeWorkspace }), createSecretStore(),
  ]);
  const [authResult, storeResult, secretResult] = results;
  if (authResult.status !== 'fulfilled' || storeResult.status !== 'fulfilled' || secretResult.status !== 'fulfilled') {
    if (authResult.status === 'fulfilled') await authResult.value.dispose();
    if (storeResult.status === 'fulfilled') await storeResult.value.close().catch(() => undefined);
    throw results.find((result) => result.status === 'rejected')!.reason;
  }
  const auth = authResult.value;
  const store = storeResult.value;
  const secretStore = secretResult.value;
  const binding = verifiedBinding(config, secretStore, auth.getSubject);
  const api = new SyncApi(config.apiBaseUrl, auth.getAccessToken, undefined, binding.key);
  const controller = new WorkspaceController({
    apiBaseUrl: config.apiBaseUrl,
    api,
    store,
    online: navigator.onLine,
    supportsPaperOrganization: () => api.supportsPaperOrganization,
    supportsRichNotes:()=>api.supportsRichNotes,
    supportsAiConversations:()=>api.supportsAiConversations,
    supportsGraphRelations:()=>api.supportsGraphRelations,
    binding: { ...binding, prepare: (signal) => api.capabilities(signal) },
  });
  return { config, auth, controller, secretStore, modelInvocations:api.modelInvocations, inspectCapabilities:signal=>api.inspectCapabilities(signal),
    cloudPdf: { apiBaseUrl: config.apiBaseUrl, getAccessToken: auth.getAccessToken, getCloudPdfCapability: () => api.cloudPdfCapability },
    desktopPdf: { apiBaseUrl: config.apiBaseUrl, getAccessToken: auth.getAccessToken, getDesktopPdfCapability: () => api.desktopPdfCapability },
    remoteTasks: { apiBaseUrl: config.apiBaseUrl, getAccessToken: auth.getAccessToken, getCapability: () => api.remoteTaskCapability,
      identityKey: () => JSON.stringify(auth.getSubject?.() ?? null) },
    dispose: async () => {
    controller.deactivate();
    await auth.dispose();
    await store.close();
  } };
}

export function App() {
  const [input, setInput] = useState(initialConfig);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [loading, setLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    let created: Runtime | null = null;
    setLoading(true);
    setRuntime(null);
    void makeRuntime(input).then(async (next) => {
      created = next;
      if (current) setRuntime(next);
      else await next.dispose?.();
    }).catch((error) => {
      if (current && input.apiBaseUrl) setConfigError(describeError(error));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; void created?.dispose?.().catch(() => undefined); };
  }, [input]);
  async function configure(next: PublicConfigInput) {
    try {
      const parsed = parseAppConfig(next, location.origin, getPlatformCapabilities().native);
      const clean = {
        apiBaseUrl: parsed.apiBaseUrl,
        oidcAuthority: parsed.oidcAuthority,
        oidcClientId: parsed.oidcClientId,
      };
      if (runtime) {
        runtime.controller.deactivate();
        await runtime.auth.clearLocalSession();
      }
      localStorage.setItem(CONFIG_KEY, JSON.stringify(clean));
      setInput(clean);
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
          <ConnectionArtwork />
          <h1>连接你的 PaperQuay</h1>
          <p className="muted">填写自托管服务提供的地址，然后使用账号登录。</p>
          {loading ? <p role="status">正在打开此设备的数据…</p> : <ConfigForm input={input} onSave={configure} />}
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

function ConnectionArtwork() {
  return (
    <div className="connection-art" aria-hidden="true">
      <span />
      <span><Icon name="note" /></span>
    </div>
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

export function ConnectedApp({
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
  const authSubjectKey = JSON.stringify(auth.getSubject?.() ?? null);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const listScope = listViewScope(runtime.config.apiBaseUrl, authState.status, authSubjectKey, state);
  // A fresh owner also retires callbacks when a session leaves and returns to the same account.
  const listOwner = useMemo(() => ({}), [auth, controller, listScope]);
  const activeListOwner = useRef<object | null>(null);
  const [listViews, setListViews] = useState(() => ({ owner: listOwner, ...createListViews() }));
  useLayoutEffect(() => {
    activeListOwner.current = listOwner;
    setListViews({ owner: listOwner, ...createListViews() });
    return () => { activeListOwner.current = null; };
  }, [listOwner]);
  const currentListViews = listViews.owner === listOwner ? listViews : createListViews();
  function changeListView(type: 'paper' | 'note', patch: Partial<ListViewState>) {
    // Read the live stores too: identity can change before React receives its notification.
    const current = () => activeListOwner.current === listOwner && listScope !== null
      && listScope === listViewScope(runtime.config.apiBaseUrl, auth.getSnapshot().status,
        JSON.stringify(auth.getSubject?.() ?? null), controller.getSnapshot());
    if (!current()) return;
    setListViews(previous => {
      if (!current()) return previous;
      const views = previous.owner === listOwner ? previous : { owner: listOwner, ...createListViews() };
      return { ...views, [type]: { ...views[type], ...patch } };
    });
  }
  const [section, setSection] = useState<Section>('library');
  const [selection, setSelection] = useState<{ type: 'paper' | 'note'; id: string } | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [readingPanel, setReadingPanel] = useState<'notes' | 'ai' | null>(null);
  const [openedReadingPanels, setOpenedReadingPanels] = useState({ notes: false, ai: false });
  const [readingPanelHost, setReadingPanelHost] = useState<HTMLDivElement | null>(null);
  const compactReader = useSyncExternalStore(subscribeCompactReader, compactReaderSnapshot, () => false);
  const [readingNoteId, setReadingNoteId] = useState<string | null>(null);
  const [aiContext, setAiContext] = useState<PdfAiContext | null>(null);
  const [archiveEpochs, setArchiveEpochs] = useState<Record<string, number>>({});
  const liveAiContext = useRef<PdfAiContext | null>(null);
  const [citationTarget, setCitationTarget] = useState<PdfCitationTarget | null>(null);
  const [aiSettings, setAiSettings] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [incomingOpen, setIncomingOpen] = useState<string | null>(null);
  const [incomingSelection, setIncomingSelection] = useState<{ source: PreparedSource; scope: string; subject: string } | null>(null);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [capabilityOpen,setCapabilityOpen]=useState<string|null>(null);
  const [zoteroOpen, setZoteroOpen] = useState(false);
  const [noteExportOpen, setNoteExportOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [reviewOpen,setReviewOpen]=useState(false);
  const [graphOpen,setGraphOpen]=useState(false);
  const [radarOpen,setRadarOpen]=useState(false);
  const [agentOpen,setAgentOpen]=useState<string|null>(null);
  const [parsedRemoteEpoch, setParsedRemoteEpoch] = useState(0);
  const transferScope = state.status === 'ready' && state.workspace
    ? JSON.stringify([state.workspace.sync.accountId, state.workspace.sync.deviceId, state.workspace.sync.generation]) : null;
  useEffect(() => { setCloudOpen(false); }, [transferScope, authSubjectKey]);
  useEffect(() => { setRemoteOpen(false); setCapabilityOpen(null); }, [transferScope, authSubjectKey]);
  useEffect(() => { setZoteroOpen(false); setNoteExportOpen(false); setResearchOpen(false);setReviewOpen(false);setGraphOpen(false);setRadarOpen(false);setAgentOpen(null); }, [transferScope, authSubjectKey]);
  const [dirty, setDirty] = useState(false);
  const [readerDirty, setReaderDirty] = useState(false);
  const editorUnsaved = useRef(false);
  const readerUnsaved = useRef(false);
  const unsaved = useRef(false);
  const resumeSync = useRef<() => Promise<void>>(async () => {});
  const [uiError, setUiError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState(() => {
    try {
      return sessionStorage.getItem(DEVICE_NAME_KEY)?.slice(0, 80) || (getPlatformCapabilities().native ? '我的移动设备' : '我的 Web 浏览器');
    } catch {
      return '我的 Web 浏览器';
    }
  });
  const dirtyChanged = useCallback((value: boolean) => {
    editorUnsaved.current = value;
    unsaved.current = value || readerUnsaved.current;
    setDirty(value);
  }, []);
  const readerDirtyChanged = useCallback((value: boolean) => {
    readerUnsaved.current = value;
    unsaved.current = editorUnsaved.current || value;
    setReaderDirty(value);
  }, []);
  const invalidateAiContext = useCallback((parsedChange?: { attachmentVersionId: string; retainedDigest: string | null }) => {
    if (parsedChange) {
      const current = liveAiContext.current;
      if (!current?.textSource || current.attachmentVersionId !== parsedChange.attachmentVersionId
        || current.textSource.packageDigest === parsedChange.retainedDigest) return;
    }
    liveAiContext.current = null; setAiContext(null); setCitationTarget(null);
  }, []);
  const closeReadingPanel = useCallback(() => setReadingPanel(null), []);
  useLayoutEffect(() => { liveAiContext.current = aiContext; }, [aiContext]);
  useEffect(() => { setTransferOpen(false); setIncomingOpen(null); setIncomingSelection(null); }, [transferScope, authSubjectKey]);

  useEffect(() => {
    let current = true;
    const callback = location.pathname === '/auth/callback' ? location.href : null;
    if (callback) {
      // Remove one-time authorization parameters before loading other application UI.
      history.replaceState(null, '', '/');
    }
    void auth.initialize().then(async () => {
      if (current && callback) await auth.completeSignIn(callback);
    }).catch((error) => { if (current) setUiError(describeError(error)); });
    let reconnecting = false;
    const resume = async () => {
      if (reconnecting || !current || unsaved.current) return;
      if (controller.getSnapshot().needsLogin && auth.getSnapshot().status === 'signed-in') {
        reconnecting = true;
        try { await controller.bind(deviceName, true); }
        finally { reconnecting = false; }
      }
      if (current) await controller.syncNow();
    };
    resumeSync.current = resume;
    const onOnline = () => { controller.setOnline(true); void resume(); };
    const onOffline = () => controller.setOnline(false);
    const onFocus = () => {
      if (document.visibilityState === 'visible' && controller.getSnapshot().online) void resume();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      current = false;
      resumeSync.current = async () => {};
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
      setReadingId(null);
      setAiContext(null);
      setCitationTarget(null);
      dirtyChanged(false);
      readerDirtyChanged(false);
    }
  }, [authState.status, authSubjectKey, auth, controller]);
  useEffect(() => {
    if (!dirty && !readerDirty && state.online && state.needsLogin && authState.status === 'signed-in') void resumeSync.current();
  }, [dirty, readerDirty, state.online, state.needsLogin, authState.status]);
  useEffect(() => {
    if (!dirty && !readerDirty) return;
    const confirmClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', confirmClose);
    return () => window.removeEventListener('beforeunload', confirmClose);
  }, [dirty, readerDirty]);

  function canLeave(unsavedChanges = unsaved.current): boolean {
    return !unsavedChanges || window.confirm('当前改动尚未确认保存。离开可能丢失这些改动，仍然离开？');
  }
  function navigate(next: Section) {
    if (!canLeave()) return;
    setSection(next);
    setTransferOpen(false); setIncomingOpen(null); setIncomingSelection(null);
    setCloudOpen(false);
    setSelection(null);
    setReadingId(null);
    readerDirtyChanged(false);
    setAiContext(null);
    setCitationTarget(null);
    dirtyChanged(false);
    setUiError(null);
  }
  function select(type: 'paper' | 'note', id: string) {
    if (selection?.type === type && selection.id === id) return;
    if (!canLeave()) return;
    setSelection({ type, id });
    setReadingId(null);
    readerDirtyChanged(false);
    dirtyChanged(false);
    setUiError(null);
  }
  async function login() {
    if (!canLeave()) return;
    const revoked = state.error?.code === 'SESSION_REVOKED';
    controller.deactivate();
    setSelection(null);
    dirtyChanged(false);
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
    dirtyChanged(false);
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
  const readingPaper = papers.find((paper) => paper.entityId === readingId && !paper.deleted);
  const scope = state.identity ? { apiBaseUrl: runtime.config.apiBaseUrl, accountId: state.identity.accountId } : null;
  const modelRouter=useMemo(()=>scope&&state.status==='ready'&&runtime.modelInvocations?new MobileModelRouter({api:runtime.modelInvocations,scope,owner:controller.captureModelOwner(scope)}):undefined,[runtime.modelInvocations,controller,state.identity,state.status,transferScope,authSubjectKey]);
  const aiTransport=useMemo(()=>modelRouter?{...fetchAiTransport,modelRouting:modelRouter}:fetchAiTransport,[modelRouter]);
  const incomingOwner = scope ? accountScopeKey(scope) : null;
  const incomingKey = JSON.stringify([transferScope, authSubjectKey]);
  const incomingClient = useMemo(() => incomingOwner ? getIncomingShareClient(incomingOwner) : null, [incomingOwner]);
  const incomingSource = incomingSelection?.scope === transferScope && incomingSelection.subject === authSubjectKey
    ? incomingSelection.source : undefined;
  const aiSync = useMemo(() => scope ? createAiSyncBridge(controller, scope) : undefined,
    [controller, state.workspace, state.status, scope?.accountId, scope?.apiBaseUrl]);
  const organizationEnabled = state.workspace?.paperOrganizationVersion === 1;
  function leaveReader() {
    if (!canLeave()) return;
    setReadingId(null);
    readerDirtyChanged(false);
    setAiContext(null);
    setCitationTarget(null);
    dirtyChanged(false);
  }
  function openReader(id: string) {
    if (!canLeave()) return;
    setReadingId(id);
    setReadingPanel(null);
    setOpenedReadingPanels({ notes: false, ai: false });
    readerDirtyChanged(false);
    setReadingNoteId(null);
    setAiContext(null);
    setCitationTarget(null);
    dirtyChanged(false);
  }
  function showReadingPanel(panel: 'notes' | 'ai') {
    setOpenedReadingPanels((opened) => opened[panel] ? opened : { ...opened, [panel]: true });
    setReadingPanel(panel);
  }
  function toggleReadingPanel(panel: 'notes' | 'ai') {
    if (readingPanel === panel) setReadingPanel(null);
    else showReadingPanel(panel);
  }
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
          <ConnectionArtwork />
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
            {getPlatformCapabilities().native
              ? '内容按账号保存在此设备。曾经验证过的账号可以离线阅读和记录，联网后继续同步。'
              : '内容按账号保存在此浏览器。刷新后需重新登录；已确认保存的改动会保留。'}
          </p>
        </main>
      </div>
    );

  return (
    <div className={`app-shell${readingId ? ' reading-active' : ''}`}>
      <aside className="sidebar">
        <Brand />
        <nav aria-label="主导航">{nav}</nav>
        <div className="sidebar-account">
          <Icon name="account" />
          <div>
            <strong>{authState.displayName || '我的账号'}</strong>
            <span>{!state.online ? '离线' : state.needsLogin ? '请重新登录' : '已连接'}</span>
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
        {(section === 'library' || section === 'notes') && !readingId && (
          <div className={`workspace-grid ${selection ? 'has-selection' : ''}`}>
            <EntityList
              type={section === 'library' ? 'paper' : 'note'}
              view={currentListViews[section === 'library' ? 'paper' : 'note']}
              onViewChange={(patch) => changeListView(section === 'library' ? 'paper' : 'note', patch)}
              entities={section === 'library' ? papers : notes}
              selection={selection?.id}
              state={state}
              conflicts={conflictCount}
              onSelect={select}
              onCreate={(type) => select(type, crypto.randomUUID())}
              onResearch={scope && runtime.secretStore ? () => { if (canLeave()) setResearchOpen(true); } : undefined}
              onTransfer={() => { setIncomingSelection(null); setTransferOpen(true); }}
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
                    dirtyChanged(false);
                  }
                }}
                onDirty={dirtyChanged}
                onConflicts={() => navigate('conflicts')}
                organizationEnabled={organizationEnabled}
                richNotesEnabled={controller.getContentCapabilities().richNotes}
                accountSessionKey={JSON.stringify([runtime.config.apiBaseUrl, transferScope])}
                onRead={selection.type === 'paper' ? () => openReader(selection.id) : undefined}
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
        {readingId && readingPaper && scope && <div className={`reading-workspace ${readingPanel ? 'with-panel' : ''}`}>
          <div className="reading-main">
            <div className="reading-panel-tabs" aria-label="阅读工作区">
              <button className={readingPanel === 'notes' ? 'secondary active' : 'text-button'} aria-expanded={readingPanel === 'notes'} onClick={() => toggleReadingPanel('notes')}>阅读笔记</button>
              <button className={readingPanel === 'ai' ? 'secondary active' : 'text-button'} aria-expanded={readingPanel === 'ai'} onClick={() => toggleReadingPanel('ai')}>AI 助手</button>
              <button type="button" className="text-button" onClick={() => setRemoteOpen(true)}>远程解析与索引</button>
              <button type="button" className="text-button" onClick={() => setNoteExportOpen(true)}>导出笔记与批注</button>
            </div>
            <SyncStatus state={state} conflicts={conflictCount}
              onSync={() => void controller.syncNow()} onConflicts={() => navigate('conflicts')} />
            <Suspense fallback={<p className="loading-message" role="status">正在打开阅读器…</p>}>
              <PaperReader key={`${scope.apiBaseUrl}:${scope.accountId}:${state.workspace!.sync.deviceId}:${state.workspace!.sync.generation}:${authSubjectKey}:${readingId}`} scope={scope} paper={readingPaper}
                attachmentVersions={entities.filter((entity) => entity.entityType === 'attachmentVersion')}
                annotations={entities.filter((entity) => entity.entityType === 'annotation')}
                positions={entities.filter((entity) => entity.entityType === 'readingPosition')}
                controller={controller} onBack={leaveReader} jumpTo={citationTarget ?? undefined}
                cloudPdf={runtime.cloudPdf}
                desktopPdf={runtime.desktopPdf}
                parsedCacheEpoch={parsedRemoteEpoch}
                accountCurrent={() => JSON.stringify(auth.getSubject?.() ?? null) === authSubjectKey}
                compact={compactReader}
                onOpenNotes={() => showReadingPanel('notes')}
                onOpenAi={() => showReadingPanel('ai')}
                onOpenRemoteTasks={() => setRemoteOpen(true)}
                onExportNotes={() => setNoteExportOpen(true)}
                onMobilePanelOpen={closeReadingPanel}
                statusContent={<SyncStatus state={state} conflicts={conflictCount}
                  onSync={() => void controller.syncNow()} onConflicts={() => navigate('conflicts')} />}
                onDirtyChange={readerDirtyChanged}
                onContextInvalidated={invalidateAiContext}
                onAskAi={(context) => { liveAiContext.current = context; setAiContext(context); showReadingPanel('ai'); }} />
            </Suspense>
          </div>
          <div className="reading-panel-host" ref={setReadingPanelHost}>
          {readingPanelHost && <Suspense fallback={null}>
          <ReaderSheet open={readingPanel === 'notes'} title="阅读笔记" onClose={closeReadingPanel}
            keepMounted modal={compactReader} portalTarget={readingPanelHost} className="reading-notes-sheet">
          {openedReadingPanels.notes && <aside className="reading-side" aria-label="阅读笔记内容">
            <div className="reading-side-heading"><button className="secondary" onClick={() => {
              if (canLeave(editorUnsaved.current)) { setReadingNoteId(crypto.randomUUID()); dirtyChanged(false); }
            }}>新建笔记</button></div>
            <div className="related-note-list">{notes.filter((note) => !note.deleted && (note.data as NoteData).paperId === readingId).map((note) =>
              <button key={note.entityId} className={note.entityId === readingNoteId ? 'secondary active' : 'text-button'} onClick={() => {
                if (note.entityId === readingNoteId) return;
                if (canLeave(editorUnsaved.current)) { setReadingNoteId(note.entityId); dirtyChanged(false); }
              }}>{(note.data as NoteData).title}</button>)}</div>
            {readingNoteId ? <EntityEditor key={`reading-note:${readingNoteId}`} type="note" entityId={readingNoteId}
              richNotesEnabled={controller.getContentCapabilities().richNotes} accountSessionKey={JSON.stringify([runtime.config.apiBaseUrl, transferScope])}
              entity={notes.find((note) => note.entityId === readingNoteId)} defaultPaperId={readingId}
              papers={papers} controller={controller} hasConflict={hasEntityConflict(state.workspace!.sync, { entityType: 'note', entityId: readingNoteId })}
              onBack={() => { if (canLeave(editorUnsaved.current)) { setReadingNoteId(null); dirtyChanged(false); } }} onDirty={dirtyChanged}
              onConflicts={() => navigate('conflicts')} /> : <p className="muted reading-hint">选择一条关联笔记，或新建笔记。输入后会自动保存到此设备。</p>}
          </aside>}
          </ReaderSheet>
          <ReaderSheet open={readingPanel === 'ai'} title="AI 助手" onClose={closeReadingPanel}
            keepMounted modal={compactReader} portalTarget={readingPanelHost} className="reading-ai-sheet">
          {openedReadingPanels.ai && runtime.secretStore && <aside className="reading-side" aria-label="阅读 AI 助手内容">
            <Suspense fallback={<p role="status">正在打开 AI 助手…</p>}><AiWorkspace accountScope={scope} context={aiContext} archiveEpoch={archiveEpochs[accountScopeKey(scope)] ?? 0}
              secretStore={runtime.secretStore} transport={aiTransport} modelRouter={modelRouter} modelLedgerRevision={state.workspace?.modelInvocations?.revision} sync={aiSync} onRestoreContext={context => {
                const current = controller.getSnapshot();
                const version = current.workspace ? listVisibleEntities(current.workspace.sync).find(entity => entity.entityType === 'attachmentVersion' && entity.entityId === context.attachmentVersionId && !entity.deleted) : null;
                if (current.status !== 'ready' || current.identity?.accountId !== scope.accountId || context.paperId !== readingId || !version?.data || !('sha256' in version.data)
                  || version.data.paperId !== context.paperId || version.data.sha256 !== context.sha256) throw new ClientError('EDIT_CHANGED');
                liveAiContext.current = structuredClone(context); setAiContext(structuredClone(context));
              }} onSaveNote={async (note, source) => {
                await saveAiResultNote(controller, runtime.config.apiBaseUrl, () => liveAiContext.current, source, note);
              }} onNavigateCitation={(target) => {
                const version = entities.find((entity) => entity.entityType === 'attachmentVersion' && entity.entityId === target.attachmentVersionId && !entity.deleted);
                if (!version?.data || !('paperId' in version.data) || version.data.paperId !== readingId || !('sha256' in version.data) || version.data.sha256 !== target.sha256) {
                  setUiError('引用对应的 PDF 版本当前不可用。'); return;
                }
                setCitationTarget({ ...target, requestId: crypto.randomUUID() });
                if (compactReader) setReadingPanel(null);
              }} /></Suspense>
          </aside>}
          </ReaderSheet>
          </Suspense>}
          </div>
        </div>}
        {readingId && !readingPaper && <div className="empty-state"><p>这篇文献已删除或当前不可用。</p><button className="secondary" onClick={leaveReader}>返回文库</button></div>}
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
                  '清除此账号在本设备的文库副本、外部文库映射、解析包、问答记录、问题模板与全部 PDF 缓存（包括离线保留）？尚未同步的改动将丢失。服务器上的文库记录会在下次同步时重新下载，本机问答和模板没有云端副本，外部文库需要重新确认关联，解析包需重新导入；本机批次及未确认的远程请求记录也会丢失，后台任务不会因此取消，请先核对远程任务；本机原始文件不受影响。',
                )
              ) {
                try {
                  await controller.clearLocalData();
                  if (scope) {
                    const { clearPdfCache } = await import('./pdf/cache.ts');
                    await clearPdfCache(scope, { includePinned: true });
                    const { getParsedCache } = await import('./parsed/cache.ts');
                    await getParsedCache().clear(scope);
                    const { getAiArchiveStore } = await import('./ai/archiveStore.ts');
                    await getAiArchiveStore().clear(scope);
                    const clearedScope = accountScopeKey(scope);
                    setArchiveEpochs(current => ({ ...current, [clearedScope]: (current[clearedScope] ?? 0) + 1 }));
                  }
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
        {section === 'account' && scope && runtime.cloudPdf && <section className="account-ai-settings">
          <button className="secondary" onClick={() => setCloudOpen(true)}>私有云 PDF</button>
          <p className="muted">查看当前账号的云副本与可用空间。</p>
        </section>}
        {section === 'account' && scope && <section className="account-ai-settings"><button type="button" className="secondary" onClick={()=>setCapabilityOpen(incomingKey)}>功能与可用性</button><p className="muted">查看本机、服务与电脑的能力、准备条件和回退方式。</p></section>}
        {section === 'account' && scope && runtime.remoteTasks && <section className="account-ai-settings">
          <button type="button" className="secondary" onClick={() => setRemoteOpen(true)}>远程解析与索引</button>
          <p className="muted">选择同账号在线电脑执行，查询持久任务和实际产物用量。</p>
        </section>}
        {section === 'account' && scope && <section className="account-ai-settings"><button type="button" className="secondary" onClick={()=>{if(canLeave())setAgentOpen(incomingKey);}}>文库 Agent</button><p className="muted">选择文献并核对规则建议，逐项确认后整理标题、标签与集合。</p></section>}
        {section === 'account' && scope && <section className="account-ai-settings"><button type="button" className="secondary" onClick={()=>{if(canLeave())setGraphOpen(true);}}>知识图谱</button><p className="muted">浏览文献、笔记与已保存关系，核对来源后继续阅读。</p></section>}
        {section === 'account' && scope && runtime.secretStore && <section className="account-ai-settings">
          <button type="button" className="secondary" onClick={() => setZoteroOpen(true)}>Zotero 增量接入</button>
          <p className="muted">读取个人库或群组库题录，比较变化后明确采用。</p>
        </section>}
        {section === 'account' && scope && incomingClient?.available && <section className="account-ai-settings">
          <button type="button" className="secondary" onClick={() => { if (canLeave()) setIncomingOpen(incomingKey); }}>处理系统分享</button>
          <p className="muted">预览本机收到的文字与书目文件，再选择是否加入当前账号。</p>
        </section>}
        {section === 'account' && scope && <section className="account-ai-settings">
          <button type="button" className="secondary" onClick={() => setNoteExportOpen(true)}>导出笔记、批注与引用</button>
        </section>}
        {section === 'account' && scope && runtime.secretStore && <section className="account-ai-settings">
          <button type="button" className="secondary" onClick={() => { if (canLeave()) setResearchOpen(true); }}>多篇文献问答</button>
          <button type="button" className="secondary" onClick={()=>{if(canLeave())setReviewOpen(true);}}>文献综述</button>
          <p className="muted">选择多篇题录摘要或已核验解析片段，核对后发送，引用与结果可保存。</p>
        </section>}
        {section === 'account' && scope && runtime.secretStore && <section className="account-ai-settings">
          <button className="secondary" onClick={() => setAiSettings(!aiSettings)}>{aiSettings ? '收起 AI 设置' : 'AI 服务设置'}</button>
          {aiSettings && <Suspense fallback={<p role="status">正在打开设置…</p>}><AiWorkspace mode="settings" accountScope={scope} context={null} archiveEpoch={archiveEpochs[accountScopeKey(scope)] ?? 0}
            secretStore={runtime.secretStore} transport={aiTransport} modelRouter={modelRouter} modelLedgerRevision={state.workspace?.modelInvocations?.revision} sync={aiSync} onSaveNote={async () => { throw new ClientError('ACCOUNT_CHANGED'); }} onNavigateCitation={() => {}} /></Suspense>}
        </section>}
        {section === 'conflicts' && (
          <ConflictsView
            state={state}
            controller={controller}
            onBack={() => navigate('account')}
            onDirty={dirtyChanged}
            onRecovered={(id) => {
              dirtyChanged(false);
              setSection('notes');
              setSelection({ type: 'note', id });
              setUiError(null);
            }}
          />
        )}
      </main>
      {agentOpen===incomingKey&&transferScope&&scope&&<Suspense fallback={<p role="status">正在打开文库 Agent…</p>}><AgentWorkspace key={incomingKey} ai={runtime.secretStore?{scope,secretStore:runtime.secretStore,transport:aiTransport}:undefined} controller={controller} scopeKey={transferScope} accountCurrent={()=>JSON.stringify(auth.getSubject?.()??null)===authSubjectKey} onClose={()=>setAgentOpen(null)} onResearch={runtime.secretStore?()=>{if(JSON.stringify(auth.getSubject?.()??null)!==authSubjectKey||!canLeave())return;setAgentOpen(null);setResearchOpen(true);}:undefined} onOpen={paperId=>{const now=controller.getSnapshot(),sync=now.workspace?.sync;if(now.status!=='ready'||!sync||JSON.stringify([sync.accountId,sync.deviceId,sync.generation])!==transferScope||JSON.stringify(auth.getSubject?.()??null)!==authSubjectKey||!canLeave()||!listVisibleEntities(sync).some(e=>e.entityType==='paper'&&e.entityId===paperId&&!e.deleted&&e.data))return;setAgentOpen(null);openReader(paperId);}}/></Suspense>}
      {radarOpen&&transferScope&&scope&&<Suspense fallback={<p role="status">正在打开文献雷达…</p>}><RadarWorkspace key={transferScope+':'+authSubjectKey} controller={controller} scope={scope} scopeKey={transferScope} secretStore={runtime.secretStore} accountCurrent={()=>JSON.stringify(auth.getSubject?.()??null)===authSubjectKey} onClose={()=>setRadarOpen(false)} onOpen={paperId=>{const s=controller.getSnapshot(),sync=s.workspace?.sync;if(s.status!=='ready'||!sync||JSON.stringify([sync.accountId,sync.deviceId,sync.generation])!==transferScope||JSON.stringify(auth.getSubject?.()??null)!==authSubjectKey||!canLeave()||!listVisibleEntities(sync).some(e=>e.entityType==='paper'&&e.entityId===paperId&&!e.deleted&&e.data))return;setRadarOpen(false);openReader(paperId);}}/></Suspense>}
      {graphOpen&&transferScope&&<Suspense fallback={<p role="status">正在打开知识图谱…</p>}><KnowledgeGraphSheet key={transferScope+':'+authSubjectKey} controller={controller} scopeKey={transferScope} accountCurrent={()=>JSON.stringify(auth.getSubject?.()??null)===authSubjectKey} onClose={()=>setGraphOpen(false)} onOpen={node=>{const s=controller.getSnapshot(),sync=s.workspace?.sync;if(s.status!=='ready'||!sync||JSON.stringify([sync.accountId,sync.deviceId,sync.generation])!==transferScope||JSON.stringify(auth.getSubject?.()??null)!==authSubjectKey||!canLeave())return;const type=node.type==='paper'?'paper':node.type==='note'?'note':null,id=type==='paper'?node.paperId:node.noteId;if(!type||!id||!listVisibleEntities(sync).some(e=>!e.deleted&&e.data&&e.entityType===type&&e.entityId===id))return;setGraphOpen(false);if(type==='paper')openReader(id);else{setSection('notes');setSelection({type:'note',id});}}}/></Suspense>}
      {reviewOpen&&transferScope&&scope&&runtime.secretStore&&<Suspense fallback={<p className="loading-message" role="status">正在打开综述工作区…</p>}><ReviewWorkspace key={transferScope+':'+authSubjectKey} scope={scope} scopeKey={transferScope} controller={controller} secretStore={runtime.secretStore} transport={aiTransport} accountCurrent={()=>JSON.stringify(auth.getSubject?.()??null)===authSubjectKey} onClose={()=>setReviewOpen(false)}/></Suspense>}
      {researchOpen && transferScope && scope && runtime.secretStore && <Suspense fallback={<p className="loading-message" role="status">正在打开多篇问答…</p>}>
        <ResearchWorkspace key={transferScope+':'+authSubjectKey} scope={scope} scopeKey={transferScope} controller={controller} secretStore={runtime.secretStore} transport={aiTransport}
          accountCurrent={() => JSON.stringify(auth.getSubject?.() ?? null) === authSubjectKey} onClose={() => setResearchOpen(false)} />
      </Suspense>}
      {cloudOpen && transferScope && scope && runtime.cloudPdf && <Suspense fallback={<p className="loading-message" role="status">正在打开云副本…</p>}>
        <CloudPdfLibrary key={`${transferScope}:${authSubjectKey}`} context={runtime.cloudPdf} scope={scope} controller={controller}
          accountCurrent={() => JSON.stringify(auth.getSubject?.() ?? null) === authSubjectKey}
          onClose={() => setCloudOpen(false)} />
      </Suspense>}
      {incomingOpen === incomingKey && transferScope && incomingOwner && incomingClient?.available && <Suspense fallback={<p role="status">正在打开待处理分享…</p>}>
        <IncomingSharePanel key={incomingKey} scopeKey={transferScope} ownerKey={incomingOwner} inbox={incomingClient}
          accountCurrent={() => JSON.stringify(auth.getSubject?.() ?? null) === authSubjectKey}
          onClose={() => setIncomingOpen(null)} onReview={(source) => {
            const sync = controller.getSnapshot().workspace?.sync;
            if (!sync || JSON.stringify([sync.accountId,sync.deviceId,sync.generation]) !== transferScope
              || JSON.stringify(auth.getSubject?.() ?? null) !== authSubjectKey) return;
            assertPreparedIncomingShareSource(source);
            setIncomingSelection({ source, scope: transferScope, subject: authSubjectKey });
            setIncomingOpen(null); setTransferOpen(true);
          }} />
      </Suspense>}
      {transferOpen && transferScope && (!incomingSelection || incomingSource) && <Suspense fallback={<p className="loading-message" role="status">正在打开导入与导出…</p>}>
        <LibraryTransferPanel key={`${transferScope}:${authSubjectKey}:${incomingSource?.digest ?? 'file'}`} incomingSource={incomingSource} entities={entities} controller={controller} scopeKey={transferScope}
          accountCurrent={() => JSON.stringify(auth.getSubject?.() ?? null) === authSubjectKey}
          onClose={() => { setTransferOpen(false); setIncomingSelection(null); }} />
      </Suspense>}
      {capabilityOpen===incomingKey&&transferScope&&scope&&<Suspense fallback={<p role="status">正在打开功能清单…</p>}><CapabilitySheet key={incomingKey} runtime={runtime} controller={controller} scope={scope} scopeKey={transferScope} incomingShare={Boolean(incomingClient?.available)} current={()=>JSON.stringify(auth.getSubject?.()??null)===authSubjectKey} onClose={()=>setCapabilityOpen(null)} onNavigate={(action:FeatureAction)=>{
        const snapshot=controller.getSnapshot(),sync=snapshot.workspace?.sync;
        if(snapshot.status!=='ready'||!sync||JSON.stringify([sync.accountId,sync.deviceId,sync.generation])!==transferScope||JSON.stringify(auth.getSubject?.()??null)!==authSubjectKey||!canLeave())return;
        setCapabilityOpen(null);
        if(['library','notes','sync','conflicts'].includes(action)){navigate(action==='sync'?'account':action as Section);return;}
        if(action==='transfer')setTransferOpen(true);else if(action==='incoming')setIncomingOpen(incomingKey);else if(action==='cloud')setCloudOpen(true);else if(action==='remote')setRemoteOpen(true);else if(action==='zotero')setZoteroOpen(true);else if(action==='agent'){setAgentOpen(incomingKey);return;}else if(action==='radar'){setRadarOpen(true);return;}else if(action==='graph'){setGraphOpen(true);return;}else if(action==='review'){setReviewOpen(true);return;}
        if(action==='research')setResearchOpen(true);else if(action==='ai-settings')setAiSettings(true);else if(action==='exports')setNoteExportOpen(true);
      }}/></Suspense>}
      {remoteOpen && transferScope && scope && runtime.remoteTasks && <Suspense fallback={<p role="status">正在打开远程任务…</p>}>
        <RemoteTaskPanel key={`${transferScope}:${authSubjectKey}`} context={runtime.remoteTasks} scope={scope} scopeKey={transferScope}
          controller={controller} entities={entities} accountCurrent={() => JSON.stringify(auth.getSubject?.() ?? null) === authSubjectKey}
          onClose={() => setRemoteOpen(false)} onParsed={(versionId,digest) => {
            const now = controller.getSnapshot().workspace?.sync;
            if (!now || JSON.stringify([now.accountId,now.deviceId,now.generation]) !== transferScope) return;
            invalidateAiContext({ attachmentVersionId: versionId, retainedDigest: digest }); setParsedRemoteEpoch(value => value + 1);
          }} />
      </Suspense>}
      {zoteroOpen && transferScope && scope && runtime.secretStore && <Suspense fallback={<p role="status">正在打开 Zotero 来源…</p>}>
        <ZoteroLibrarySheet key={`${transferScope}:${authSubjectKey}`} scope={scope} scopeKey={transferScope} controller={controller}
          secretStore={runtime.secretStore} accountCurrent={() => JSON.stringify(auth.getSubject?.() ?? null) === authSubjectKey} onClose={() => setZoteroOpen(false)} />
      </Suspense>}
      {noteExportOpen && transferScope && <Suspense fallback={<p role="status">正在打开笔记导出…</p>}>
        <ReaderSheet open title="导出笔记、批注与引用" onClose={() => setNoteExportOpen(false)}>
          <NoteExportPanel entities={entities} initialPaperId={readingId} scopeKey={transferScope}
            accountCurrent={() => JSON.stringify(auth.getSubject?.() ?? null) === authSubjectKey} />
        </ReaderSheet>
      </Suspense>}
      <nav className="bottom-nav app-glass" data-section={section} aria-label="主导航">
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
      aria-label={label}
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
  const label = !state.online
    ? pending ? `离线 · ${pending} 项待同步` : '离线 · 本地内容可用'
    : state.needsLogin
      ? '请重新登录'
      : conflicts
      ? `${conflicts} 项冲突待处理`
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
  view,
  onViewChange,
  entities,
  selection,
  state,
  conflicts,
  onSelect,
  onCreate,
  onTransfer,
  onResearch,
  onSync,
  onConflicts,
}: {
  type: 'paper' | 'note';
  view: ListViewState;
  onViewChange: (patch: Partial<ListViewState>) => void;
  entities: VisibleEntity[];
  selection?: string;
  state: WorkspaceSnapshot;
  conflicts: number;
  onSelect: (type: 'paper' | 'note', id: string) => void;
  onCreate: (type: 'paper' | 'note') => void;
  onTransfer: () => void;
  onResearch?: () => void;
  onSync: () => void;
  onConflicts: () => void;
}) {
  const { query, showDeleted, favorite, readingStatus, tag, collection, year, queued } = view;
  const hasFilters = Boolean(favorite || readingStatus || tag || collection || year || queued);
  const hasSearchOrFilters = Boolean(query.trim() || (type === 'paper' && hasFilters));
  const noun = type === 'paper' ? '文献' : '笔记';
  const visible = entities.filter((entity) => (showDeleted ? entity.deleted : !entity.deleted));
  const filtered = type === 'paper' ? filterPapers(visible, { query, favorite, readingStatus, tag, collection, year, queued }) : visible.filter((entity) => {
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
  const paperData = type === 'paper' ? visible.filter((entity) => entity.data).map((entity) => entity.data as PaperData) : [];
  const options = (items: string[]) => [...new Set(items)].sort((a, b) => a.localeCompare(b));
  return (
    <section className="list-pane" aria-label={type === 'paper' ? '文库' : '笔记列表'}>
      <div className="list-heading">
        <h1>{type === 'paper' ? '文库' : '笔记'}</h1>
        <div className="library-list-actions">
          {onResearch && <button type="button" className="transfer-button app-glass" aria-label="多篇文献问答" onClick={onResearch}><Icon name="search" /></button>}
          <button className="transfer-button app-glass" aria-label="导入与导出" onClick={onTransfer}>
            <Icon name="transfer" /></button>
          <button className="add-button" onClick={() => onCreate(type)}>
            <span className="add-button-icon app-glass"><Icon name="plus" /></span>
            <span>{type === 'paper' ? '添加文献' : '新建笔记'}</span>
          </button>
        </div>
      </div>
      <SyncStatus state={state} conflicts={conflicts} onSync={onSync} onConflicts={onConflicts} />
      <label className="search-box">
        <Icon name="search" />
        <span className="sr-only">搜索{noun}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onViewChange({ query: event.target.value })}
          placeholder={`搜索${noun}`}
        />
      </label>
      {type === 'paper' && <details className="library-filters">
        <summary>筛选文库{hasFilters ? ' · 已启用' : ''}</summary>
        <div className="filter-checks"><label className="check-field"><input type="checkbox" checked={favorite}
          onChange={(event) => onViewChange({ favorite: event.target.checked })} />仅收藏</label>
          <label className="check-field"><input type="checkbox" checked={queued}
            onChange={(event) => onViewChange({ queued: event.target.checked })} />阅读队列</label></div>
        <div className="filter-grid">
          <label className="field">阅读状态<select value={readingStatus} onChange={(event) => onViewChange({ readingStatus: event.target.value as typeof readingStatus })}>
            <option value="">全部状态</option>{Object.entries(readingStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          <label className="field">年份<select value={year} onChange={(event) => onViewChange({ year: event.target.value })}><option value="">全部年份</option>
            {options(paperData.map((paper) => paper.year).filter((value): value is string => Boolean(value))).map((value) => <option key={value}>{value}</option>)}
          </select></label>
          <label className="field">标签<select value={tag} onChange={(event) => onViewChange({ tag: event.target.value })}><option value="">全部标签</option>
            {options(paperData.flatMap((paper) => organizationOf(paper).tags)).map((value) => <option key={value}>{value}</option>)}
          </select></label>
          <label className="field">合集<select value={collection} onChange={(event) => onViewChange({ collection: event.target.value })}><option value="">全部合集</option>
            {options(paperData.flatMap((paper) => organizationOf(paper).collections)).map((value) => <option key={value}>{value}</option>)}
          </select></label>
        </div>
        <button className="text-button" onClick={() => onViewChange({ favorite: false, readingStatus: '', tag: '', collection: '', year: '', queued: false })}>清除筛选</button>
      </details>}
      <div className="list-meta">
        <span>
          {filtered.length} {type === 'paper' ? '篇文献' : '条笔记'}
        </span>
        <label>
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(event) => onViewChange({ showDeleted: event.target.checked })}
          />
          已删除
        </label>
      </div>
      <div className="entity-list">
        {!filtered.length && (
          <div className="empty-state">
            <Icon name={type === 'paper' ? 'library' : 'note'} />
            <h2>
              {hasSearchOrFilters
                ? '没有找到匹配内容'
                : showDeleted
                  ? '没有已删除的内容'
                  : type === 'paper'
                    ? '从第一篇文献开始'
                    : '记下一个新想法'}
            </h2>
            <p>
              {hasSearchOrFilters
                ? '试试其他关键词，或清除搜索与筛选。'
                : showDeleted
                  ? '删除的记录会在这里保留状态。'
                  : `添加${noun}后，内容会先保存在此设备。`}
            </p>
            {hasSearchOrFilters && (
              <button className="secondary" onClick={() => onViewChange(createListView())}>
                清除搜索与筛选
              </button>
            )}
            {!hasSearchOrFilters && !showDeleted && (
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
              {type === 'paper' && <span className="paper-preview" aria-hidden="true">
                <Icon name="note" className="row-document-icon" />
                <span className="paper-preview-title">{data?.title || '文献'}</span>
                <span className="paper-preview-lines" />
                <span className="paper-preview-source">{data && 'authors' in data ? data.publication || data.year || 'PDF' : 'PDF'}</span>
              </span>}
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
                    {data.organization && <span className="paper-organization">
                      {data.organization.favorite ? '★ 收藏 · ' : ''}{readingStatusLabels[data.organization.readingStatus]}
                      {data.organization.queueRank !== null ? ' · 队列中' : ''}
                      {data.organization.tags.length ? ` · ${data.organization.tags.join(' / ')}` : ''}
                    </span>}
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
      <div className="config-fields">
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
      </div>
      <button className="primary" disabled={busy} type="submit">
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
      </header>
      <div className="account-profile">
        <span className="account-avatar"><Icon name="account" /></span>
        <div><strong>{displayName || '我的 PaperQuay'}</strong>
          <span>{!state.online ? '离线使用中' : state.needsLogin ? '需要重新登录' : '已连接到你的文库'}</span></div>
      </div>
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
      else if (choice === 'attempted') {
        const version = reviewedOverlay ?? conflict.attemptedOperation;
        // A concurrent restore may already have made the reviewed record live.
        const mutation =
          version.mutation === 'restore' && conflict.currentRecord?.deletedAt === null
            ? 'put'
            : version.mutation;
        if (reviewedOverlay || mutation !== version.mutation)
          await controller.resolve(
            conflict,
            { choice: 'merged', mutation, data: version.data },
            reviewed,
          );
        else await controller.resolve(conflict, { choice }, reviewed);
      } else {
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
