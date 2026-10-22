import { create } from 'zustand';

export type AppTabType = 'library' | 'reader' | 'agent' | 'notes' | 'note' | 'review' | 'graph' | 'radar';

export interface BaseAppTab {
  id: string;
  type: AppTabType;
  title: string;
}

export interface LibraryTab extends BaseAppTab {
  id: 'home';
  type: 'library';
}

export interface ReaderTab extends BaseAppTab {
  type: 'reader';
  documentId: string;
}

export interface AgentTab extends BaseAppTab {
  id: 'agent';
  type: 'agent';
}

export interface NotesTab extends BaseAppTab {
  id: 'notes';
  type: 'notes';
}

export interface ReviewTab extends BaseAppTab {
  id: 'review';
  type: 'review';
}

export interface GraphTab extends BaseAppTab {
  id: 'graph';
  type: 'graph';
}

export interface RadarTab extends BaseAppTab {
  id: 'radar';
  type: 'radar';
}

export interface NoteTab extends BaseAppTab {
  type: 'note';
  noteId: string;
  externalUpdate?: boolean;
}

export type AppTab = LibraryTab | ReaderTab | AgentTab | NotesTab | NoteTab | ReviewTab | GraphTab | RadarTab;

interface TabsState {
  tabs: AppTab[];
  activeTabId: string;
  openTab: (documentId: string, title: string) => string;
  openAgentTab: () => string;
  openNotesTab: () => string;
  openReviewTab: () => string;
  openGraphTab: () => string;
  openRadarTab: () => string;
  openNoteTab: (noteId: string, title: string) => string;
  updateNoteTabTitle: (noteId: string, title: string) => void;
  setNoteTabExternalUpdate: (noteId: string, externalUpdate: boolean) => void;
  reorderTab: (sourceTabId: string, targetTabId: string, position: 'before' | 'after') => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setHomeTabTitle: (title: string) => void;
}

export const HOME_TAB_ID = 'home';
export const AGENT_TAB_ID = 'agent';
export const NOTES_TAB_ID = 'notes';
export const REVIEW_TAB_ID = 'review';
export const GRAPH_TAB_ID = 'graph';

export function getHomeTabTitle(locale: 'zh-CN' | 'en-US') {
  return locale === 'en-US' ? 'My Library' : '我的文库';
}

function createHomeTab(title = getHomeTabTitle('zh-CN')): LibraryTab {
  return {
    id: HOME_TAB_ID,
    type: 'library',
    title,
  };
}

function createReaderTabId(documentId: string): string {
  return `reader:${documentId}`;
}

function createNoteTabId(noteId: string): string {
  return `note:${noteId}`;
}

function createAgentTab(): AgentTab {
  return {
    id: AGENT_TAB_ID,
    type: 'agent',
    title: 'Agent',
  };
}

function createNotesTab(): NotesTab {
  return {
    id: NOTES_TAB_ID,
    type: 'notes',
    title: '笔记',
  };
}

function createReviewTab(): ReviewTab {
  return {
    id: REVIEW_TAB_ID,
    type: 'review',
    title: '论文综述',
  };
}

function createGraphTab(): GraphTab {
  return {
    id: GRAPH_TAB_ID,
    type: 'graph',
    title: '知识图谱',
  };
}

export const useTabsStore = create<TabsState>()((set, get) => ({
  tabs: [createHomeTab()],
  activeTabId: HOME_TAB_ID,
  openTab: (documentId, title) => {
    const nextTabId = createReaderTabId(documentId);
    const existingTab = get().tabs.find((tab) => tab.id === nextTabId);

    if (existingTab) {
      set({ activeTabId: existingTab.id });
      return existingTab.id;
    }

    const nextTab: ReaderTab = {
      id: nextTabId,
      type: 'reader',
      title,
      documentId,
    };

    set((state) => ({
      tabs: [...state.tabs, nextTab],
      activeTabId: nextTab.id,
    }));

    return nextTab.id;
  },
  openAgentTab: () => {
    const existingTab = get().tabs.find((tab) => tab.id === AGENT_TAB_ID);

    if (existingTab) {
      set({ activeTabId: existingTab.id });
      return existingTab.id;
    }

    const nextTab = createAgentTab();

    set((state) => ({
      tabs: [...state.tabs, nextTab],
      activeTabId: nextTab.id,
    }));

    return nextTab.id;
  },
  openNotesTab: () => {
    const existingTab = get().tabs.find((tab) => tab.id === NOTES_TAB_ID);

    if (existingTab) {
      set({ activeTabId: existingTab.id });
      return existingTab.id;
    }

    const nextTab = createNotesTab();

    set((state) => ({
      tabs: [...state.tabs, nextTab],
      activeTabId: nextTab.id,
    }));

    return nextTab.id;
  },
  openReviewTab: () => {
    const existingTab = get().tabs.find((tab) => tab.id === REVIEW_TAB_ID);

    if (existingTab) {
      set({ activeTabId: existingTab.id });
      return existingTab.id;
    }

    const nextTab = createReviewTab();

    set((state) => ({
      tabs: [...state.tabs, nextTab],
      activeTabId: nextTab.id,
    }));

    return nextTab.id;
  },
  openGraphTab: () => {
    const existingTab = get().tabs.find((tab) => tab.id === GRAPH_TAB_ID);

    if (existingTab) {
      set({ activeTabId: existingTab.id });
      return existingTab.id;
    }

    const nextTab = createGraphTab();

    set((state) => ({
      tabs: [...state.tabs, nextTab],
      activeTabId: nextTab.id,
    }));

    return nextTab.id;
  },
  openRadarTab: () => {
    const existing = get().tabs.find((tab) => tab.id === 'radar');
    if (existing) { set({ activeTabId: existing.id }); return existing.id; }
    const nextTab: RadarTab = { id: 'radar', type: 'radar', title: '文献雷达' };
    set((state) => ({ tabs: [...state.tabs, nextTab], activeTabId: nextTab.id }));
    return nextTab.id;
  },
  openNoteTab: (noteId, title) => {
    const nextTabId = createNoteTabId(noteId);
    const normalizedTitle = title.trim() || '未命名笔记';
    const existingTab = get().tabs.find((tab) => tab.id === nextTabId);

    if (existingTab) {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === nextTabId ? { ...tab, title: normalizedTitle } : tab,
        ),
        activeTabId: existingTab.id,
      }));
      return existingTab.id;
    }

    const nextTab: NoteTab = {
      id: nextTabId,
      type: 'note',
      title: normalizedTitle,
      noteId,
    };

    set((state) => ({
      tabs: [...state.tabs, nextTab],
      activeTabId: nextTab.id,
    }));

    return nextTab.id;
  },
  updateNoteTabTitle: (noteId, title) => {
    const tabId = createNoteTabId(noteId);
    const normalizedTitle = title.trim() || '未命名笔记';

    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId && tab.type === 'note' && tab.title !== normalizedTitle
          ? { ...tab, title: normalizedTitle }
          : tab,
      ),
    }));
  },
  setNoteTabExternalUpdate: (noteId, externalUpdate) => {
    const tabId = createNoteTabId(noteId);

    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId && tab.type === 'note' && Boolean(tab.externalUpdate) !== externalUpdate
          ? { ...tab, externalUpdate }
          : tab,
      ),
    }));
  },
  reorderTab: (sourceTabId, targetTabId, position) => {
    if (sourceTabId === targetTabId) {
      return;
    }

    set((state) => {
      const sourceIndex = state.tabs.findIndex((tab) => tab.id === sourceTabId);
      const targetIndex = state.tabs.findIndex((tab) => tab.id === targetTabId);

      if (sourceIndex === -1 || targetIndex === -1) {
        return state;
      }

      const sourceTab = state.tabs[sourceIndex];
      const nextTabs = state.tabs.filter((tab) => tab.id !== sourceTabId);
      const nextTargetIndex = nextTabs.findIndex((tab) => tab.id === targetTabId);

      if (nextTargetIndex === -1) {
        return state;
      }

      const insertIndex = position === 'after' ? nextTargetIndex + 1 : nextTargetIndex;
      nextTabs.splice(insertIndex, 0, sourceTab);

      return {
        tabs: nextTabs,
      };
    });
  },
  closeTab: (tabId) => {
    if (tabId === HOME_TAB_ID) {
      return;
    }

    const { tabs, activeTabId } = get();
    const closingIndex = tabs.findIndex((tab) => tab.id === tabId);

    if (closingIndex === -1) {
      return;
    }

    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    const fallbackTab = nextTabs[Math.max(closingIndex - 1, 0)] ?? createHomeTab();

    set({
      tabs: nextTabs.length > 0 ? nextTabs : [createHomeTab()],
      activeTabId: activeTabId === tabId ? fallbackTab.id : activeTabId,
    });
  },
  setActiveTab: (tabId) => {
    if (!get().tabs.some((tab) => tab.id === tabId)) {
      return;
    }

    set({ activeTabId: tabId });
  },
  setHomeTabTitle: (title) => {
    set((state) => {
      const homeTab = state.tabs.find((tab) => tab.id === HOME_TAB_ID && tab.type === 'library');

      if (homeTab?.title === title) {
        return state;
      }

      return {
        tabs: state.tabs.map((tab) =>
          tab.id === HOME_TAB_ID && tab.type === 'library' ? { ...tab, title } : tab,
        ),
      };
    });
  },
}));
