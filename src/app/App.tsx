import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import {
  Bot,
  BookOpenCheck,
  FilePlus2,
  GitBranch,
  Library,
  Minus,
  Moon,
  NotebookText,
  Settings2,
  Square,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import Reader from '../features/reader/Reader';
import AgentWorkspace from '../features/agent/AgentWorkspace';
import NotesWorkspace from '../features/notes/NotesWorkspace';
import ReviewWritingWorkspace from '../features/review/ReviewWritingWorkspace';
import KnowledgeGraphWorkspace from '../features/graph/KnowledgeGraphWorkspace';
import TabBar from '../components/tabs/TabBar';
import StartupUpdateNotice from '../components/StartupUpdateNotice';
import {
  emitOpenPreferences,
  emitOpenStandalonePdf,
  JUMP_TO_NOTE_ANCHOR_EVENT,
  OPEN_LIBRARY_PAPER_EVENT,
  UI_LANGUAGE_CHANGED_EVENT,
} from './appEvents';
import { PAPERQUAY_ICON_URL } from './appIcon';
import { AppLocaleProvider } from '../i18n/uiLanguage';
import { getCurrentWindow } from '../platform/electron/window';
import { useThemeStore } from '../stores/useThemeStore';
import { HOME_TAB_ID, useTabsStore } from '../stores/useTabsStore';

type AppWorkspaceKey = 'library' | 'agent' | 'notes' | 'review' | 'graph';
type UiLanguage = 'zh-CN' | 'en-US';

interface AppWorkspaceItem {
  key: AppWorkspaceKey;
  icon: LucideIcon;
  labelZh: string;
  labelEn: string;
}

const ACTIVE_WORKSPACE_STORAGE_KEY = 'paperquay-active-workspace-v1';
const SETTINGS_STORAGE_KEY = 'paper-reader-settings-v3';

const workspaces: AppWorkspaceItem[] = [
  { key: 'library', icon: Library, labelZh: '\u6587\u5e93', labelEn: 'Library' },
  { key: 'agent', icon: Bot, labelZh: 'Agent', labelEn: 'Agent' },
  { key: 'review', icon: BookOpenCheck, labelZh: '综述', labelEn: 'Review' },
  { key: 'graph', icon: GitBranch, labelZh: '图谱', labelEn: 'Graph' },
  { key: 'notes', icon: NotebookText, labelZh: '\u7b14\u8bb0', labelEn: 'Notes' },
];

interface WorkspaceErrorBoundaryProps {
  children: ReactNode;
  name: string;
  resetKey: string;
}

interface WorkspaceErrorBoundaryState {
  error: Error | null;
}

class WorkspaceErrorBoundary extends Component<WorkspaceErrorBoundaryProps, WorkspaceErrorBoundaryState> {
  state: WorkspaceErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[paperquay] ${this.props.name} workspace crashed`, error, info);
  }

  componentDidUpdate(previousProps: WorkspaceErrorBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-0 items-center justify-center rounded-[var(--pq-radius-md)] border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-6">
          <div className="max-w-xl rounded-[var(--pq-radius-md)] border border-[var(--pq-border)] bg-[var(--pq-surface)] p-4 shadow-[var(--pq-shadow-sm)]">
            <div className="text-sm font-semibold text-[var(--pq-text)]">
              {this.props.name} workspace failed to load
            </div>
            <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap rounded-[var(--pq-radius-sm)] bg-[var(--pq-bg-secondary)] p-3 text-xs leading-5 text-[var(--pq-text-muted)]">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              className="pq-button mt-3 h-8 px-3 text-xs"
              onClick={() => this.setState({ error: null })}
            >
              Reload workspace
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function loadUiLanguage(): UiLanguage {
  try {
    const rawValue = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = rawValue ? JSON.parse(rawValue) : null;
    return parsed?.uiLanguage === 'en-US' ? 'en-US' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

function loadInitialWorkspace(): AppWorkspaceKey {
  const stored = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  return stored === 'agent' || stored === 'notes' || stored === 'review' || stored === 'graph' ? stored : 'library';
}

function isMacPlatform() {
  const bridgePlatform = window.paperquay?.platform;

  if (bridgePlatform) {
    return bridgePlatform === 'darwin';
  }

  return /Mac|Macintosh/i.test(`${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`);
}

function App() {
  const appWindow = getCurrentWindow();
  const isMac = isMacPlatform();
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const closeTab = useTabsStore((state) => state.closeTab);
  const reorderTab = useTabsStore((state) => state.reorderTab);
  const setActiveTab = useTabsStore((state) => state.setActiveTab);
  const openAgentTab = useTabsStore((state) => state.openAgentTab);
  const openNotesTab = useTabsStore((state) => state.openNotesTab);
  const openReviewTab = useTabsStore((state) => state.openReviewTab);
  const openGraphTab = useTabsStore((state) => state.openGraphTab);
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(loadUiLanguage);
  const resolvedTheme = useThemeStore((state) => state.resolved);
  const toggleTheme = useThemeStore((state) => state.toggle);
  const isEnglish = uiLanguage === 'en-US';
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs],
  );
  const activeWorkspace: AppWorkspaceKey =
    activeTab?.type === 'agent'
      ? 'agent'
      : activeTab?.type === 'review'
        ? 'review'
      : activeTab?.type === 'graph'
        ? 'graph'
      : activeTab?.type === 'notes' || activeTab?.type === 'note'
        ? 'notes'
        : 'library';
  const activeWorkspaceItem = workspaces.find((workspace) => workspace.key === activeWorkspace) ?? workspaces[0];
  const activeWorkspaceLabel = isEnglish ? activeWorkspaceItem.labelEn : activeWorkspaceItem.labelZh;

  useEffect(() => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, activeWorkspace);
  }, [activeWorkspace]);

  useEffect(() => {
    const initialWorkspace = loadInitialWorkspace();

    if (initialWorkspace === 'agent') {
      openAgentTab();
      return;
    }

    if (initialWorkspace === 'notes') {
      openNotesTab();
      return;
    }

    if (initialWorkspace === 'review') {
      openReviewTab();
      return;
    }

    if (initialWorkspace === 'graph') {
      openGraphTab();
    }
  }, [openAgentTab, openGraphTab, openNotesTab, openReviewTab]);

  useEffect(() => {
    const handleLanguageChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ language?: UiLanguage }>).detail;
      setUiLanguage(detail?.language === 'en-US' ? 'en-US' : 'zh-CN');
    };

    window.addEventListener(UI_LANGUAGE_CHANGED_EVENT, handleLanguageChanged);
    return () => {
      window.removeEventListener(UI_LANGUAGE_CHANGED_EVENT, handleLanguageChanged);
    };
  }, []);

  const dispatchReaderAction = (action: () => void) => {
    setActiveTab(HOME_TAB_ID);
    window.setTimeout(action, 0);
  };

  const handleOpenStandalonePdf = () => {
    dispatchReaderAction(emitOpenStandalonePdf);
  };

  useEffect(() => {
    const handleJumpToReader = () => {
      window.setTimeout(() => {
        const { activeTabId: nextActiveTabId, tabs: nextTabs } = useTabsStore.getState();
        const nextActiveTab = nextTabs.find((tab) => tab.id === nextActiveTabId);

        if (!nextActiveTab || nextActiveTab.type === 'agent' || nextActiveTab.type === 'notes' || nextActiveTab.type === 'note' || nextActiveTab.type === 'review' || nextActiveTab.type === 'graph') {
          setActiveTab(HOME_TAB_ID);
        }
      }, 0);
    };

    window.addEventListener(JUMP_TO_NOTE_ANCHOR_EVENT, handleJumpToReader);
    window.addEventListener(OPEN_LIBRARY_PAPER_EVENT, handleJumpToReader);
    return () => {
      window.removeEventListener(JUMP_TO_NOTE_ANCHOR_EVENT, handleJumpToReader);
      window.removeEventListener(OPEN_LIBRARY_PAPER_EVENT, handleJumpToReader);
    };
  }, [setActiveTab]);

  const handleOpenPreferences = () => {
    emitOpenPreferences();
  };

  const handleWindowMinimize = () => {
    void appWindow.minimize().catch(console.error);
  };

  const handleWindowToggleMaximize = () => {
    void appWindow.toggleMaximize().catch(console.error);
  };

  const handleWindowClose = () => {
    void appWindow.close().catch(console.error);
  };

  const themeTitle = resolvedTheme === 'dark'
    ? (isEnglish ? 'Switch to light mode' : '切换到浅色模式')
    : (isEnglish ? 'Switch to dark mode' : '切换到深色模式');
  const openPdfLabel = isEnglish ? 'Open PDF' : '\u6253\u5f00 PDF';
  const settingsLabel = isEnglish ? 'Settings' : '\u8bbe\u7f6e';
  const minimizeWindowLabel = isEnglish ? 'Minimize window' : '\u6700\u5c0f\u5316\u7a97\u53e3';
  const minimizeLabel = isEnglish ? 'Minimize' : '\u6700\u5c0f\u5316';
  const maximizeWindowLabel = isEnglish ? 'Maximize or restore window' : '\u6700\u5927\u5316\u6216\u8fd8\u539f\u7a97\u53e3';
  const maximizeLabel = isEnglish ? 'Maximize / Restore' : '\u6700\u5927\u5316 / \u8fd8\u539f';
  const closeWindowLabel = isEnglish ? 'Close window' : '\u5173\u95ed\u7a97\u53e3';
  const closeLabel = isEnglish ? 'Close' : '\u5173\u95ed';

  return (
    <AppLocaleProvider value={uiLanguage}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--pq-bg)] text-[var(--pq-text)] antialiased">
        <header className={['pq-titlebar flex h-10 shrink-0 items-center pr-0', isMac ? 'pl-[82px]' : 'pl-3'].join(' ')}>
          {!isMac ? (
            <div
              className="flex min-w-0 items-center gap-2"
              data-window-drag-region
              onDoubleClick={handleWindowToggleMaximize}
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--pq-surface-1)] shadow-[var(--pq-shadow-soft)] ring-1 ring-[var(--pq-border)]">
                <img
                  src={PAPERQUAY_ICON_URL}
                  alt="PaperQuay"
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              </div>
              <div className="truncate text-[13px] font-semibold tracking-normal text-[var(--pq-text)]">
                PaperQuay
              </div>
              <div className="hidden h-4 w-px bg-[var(--pq-border)] sm:block" />
              <div className="pq-tab-surface hidden h-6 items-center px-2.5 text-xs font-medium text-[var(--pq-text-muted)] sm:flex">
                {activeWorkspaceLabel}
              </div>
            </div>
          ) : null}

          <div
            className="mx-3 min-w-8 flex-1 self-stretch"
            data-window-drag-region
            onDoubleClick={isMac ? undefined : handleWindowToggleMaximize}
          />

          <div className="flex h-full items-center">
            <button
              type="button"
              onClick={handleOpenStandalonePdf}
              data-tour="open-pdf"
              className="pq-icon-button h-8 w-8 cursor-default"
              title={openPdfLabel}
              aria-label={openPdfLabel}
            >
              <FilePlus2 className="h-4 w-4" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={handleOpenPreferences}
              data-tour="settings"
              className="pq-icon-button h-8 w-8 cursor-default"
              title={settingsLabel}
              aria-label={settingsLabel}
            >
              <Settings2 className="h-4 w-4" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className="pq-icon-button h-8 w-8 cursor-default"
              title={themeTitle}
              aria-label={themeTitle}
            >
              {resolvedTheme === 'dark' ? (
                <Moon className="h-4 w-4" strokeWidth={1.8} />
              ) : (
                <Sun className="h-4 w-4" strokeWidth={1.8} />
              )}
            </button>
            {!isMac ? (
              <div className="ml-1 flex h-full items-center border-l border-[var(--pq-border)]">
                <button
                  type="button"
                  onClick={handleWindowMinimize}
                  className="pq-icon-button h-full w-11 cursor-default rounded-none"
                  aria-label={minimizeWindowLabel}
                  title={minimizeLabel}
                >
                  <Minus className="h-4 w-4" strokeWidth={1.9} />
                </button>
                <button
                  type="button"
                  onClick={handleWindowToggleMaximize}
                  className="pq-icon-button h-full w-11 cursor-default rounded-none"
                  aria-label={maximizeWindowLabel}
                  title={maximizeLabel}
                >
                  <Square className="h-3.5 w-3.5" strokeWidth={1.9} />
                </button>
                <button
                  type="button"
                  onClick={handleWindowClose}
                  className="inline-flex h-full w-11 cursor-default items-center justify-center text-[var(--pq-text-muted)] transition hover:bg-[#e81123] hover:text-white"
                  aria-label={closeWindowLabel}
                  title={closeLabel}
                >
                  <X className="h-4 w-4" strokeWidth={1.9} />
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActiveTab}
          onClose={closeTab}
          onReorder={reorderTab}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="pq-app-rail z-10 flex w-[52px] shrink-0 flex-col items-center py-2.5">
            <nav className="flex flex-1 flex-col items-center gap-2">
              {workspaces.map((workspace) => {
                const Icon = workspace.icon;
                const active = workspace.key === activeWorkspace;
                const label = isEnglish ? workspace.labelEn : workspace.labelZh;

                return (
                  <button
                    key={workspace.key}
                    type="button"
                    data-tour={`workspace-${workspace.key}`}
                    onClick={() => {
                      if (workspace.key === 'library') {
                        setActiveTab(HOME_TAB_ID);
                        return;
                      }

                      if (workspace.key === 'agent') {
                        openAgentTab();
                        return;
                      }

                      if (workspace.key === 'review') {
                        openReviewTab();
                        return;
                      }

                      if (workspace.key === 'graph') {
                        openGraphTab();
                        return;
                      }

                      openNotesTab();
                    }}
                    title={label}
                    aria-label={label}
                    className={[
                      'pq-nav-item relative h-9 w-9 cursor-default',
                      active ? 'active' : '',
                    ].join(' ')}
                  >
                    {active ? (
                      <span className="absolute -left-[8px] h-4 w-0.5 rounded-r-full bg-[var(--pq-accent)]" />
                    ) : null}
                    <Icon className="h-[18px] w-[18px]" strokeWidth={1.9} />
                  </button>
                );
              })}
            </nav>
          </aside>

          <main className="min-w-0 flex-1 overflow-hidden p-1.5">
            <div className="h-full min-h-0 overflow-hidden" hidden={activeWorkspace !== 'library'}>
              <WorkspaceErrorBoundary name="Library" resetKey={activeWorkspace}>
                <Reader workspaceActive={activeWorkspace === 'library'} />
              </WorkspaceErrorBoundary>
            </div>

            <div className="h-full min-h-0 overflow-hidden rounded-[var(--pq-radius-md)]" hidden={activeWorkspace !== 'agent'}>
              <WorkspaceErrorBoundary name="Agent" resetKey={activeWorkspace}>
                <AgentWorkspace />
              </WorkspaceErrorBoundary>
            </div>

            <div className="h-full min-h-0 overflow-hidden rounded-[var(--pq-radius-md)]" hidden={activeWorkspace !== 'notes'}>
              <WorkspaceErrorBoundary name="Notes" resetKey={activeWorkspace}>
                <NotesWorkspace />
              </WorkspaceErrorBoundary>
            </div>

            <div className="h-full min-h-0 overflow-hidden rounded-[var(--pq-radius-md)]" hidden={activeWorkspace !== 'review'}>
              <WorkspaceErrorBoundary name="Review" resetKey={activeWorkspace}>
                <ReviewWritingWorkspace />
              </WorkspaceErrorBoundary>
            </div>

            <div className="h-full min-h-0 overflow-hidden rounded-[var(--pq-radius-md)]" hidden={activeWorkspace !== 'graph'}>
              <WorkspaceErrorBoundary name="Graph" resetKey={activeWorkspace}>
                <KnowledgeGraphWorkspace />
              </WorkspaceErrorBoundary>
            </div>
          </main>
        </div>
      </div>
      <StartupUpdateNotice />
    </AppLocaleProvider>
  );
}

export default App;
