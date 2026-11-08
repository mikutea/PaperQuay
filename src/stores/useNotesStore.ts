import { create } from 'zustand';
import type { CreateNoteRequest, ListNotesRequest, Note, NoteTagSummary, UpdateNoteRequest } from '../types/notes';
import {
  createNote,
  deleteNote,
  listNoteTags,
  listNoteBacklinks,
  listAllNotes,
  listNotes,
  type NoteMutationOptions,
  updateNote,
} from '../services/notes';

export const GLOBAL_NOTES_PAPER_ID = 'global-notes';

// This renderer has one notes store. Retire old reads when its query changes
// or a write commits, so a delayed snapshot cannot replace newer state.
let notesReadGeneration = 0;
let tagsReadGeneration = 0;
const backlinkReads = new Map<string, symbol>();

interface NotesState {
  notes: Note[];
  tags: NoteTagSummary[];
  activeNoteId: string | null;
  search: string;
  tag: string | null;
  loading: boolean;
  saving: boolean;
  error: string;
  setActiveNoteId: (noteId: string | null) => void;
  setSearch: (search: string) => void;
  setTag: (tag: string | null) => void;
  loadNotes: (request?: ListNotesRequest) => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshBacklinks: (noteIds: string[]) => Promise<void>;
  createWorkspaceNote: (draft?: Partial<CreateNoteRequest>, options?: NoteMutationOptions) => Promise<Note>;
  updateWorkspaceNote: (noteId: string, patch: UpdateNoteRequest, options?: NoteMutationOptions) => Promise<Note>;
  deleteWorkspaceNote: (noteId: string, options?: NoteMutationOptions) => Promise<void>;
}

export const useNotesStore = create<NotesState>()((set, get) => ({
  notes: [],
  tags: [],
  activeNoteId: null,
  search: '',
  tag: null,
  loading: false,
  saving: false,
  error: '',

  setActiveNoteId: (noteId) => set({ activeNoteId: noteId }),
  setSearch: (search) => {
    if (get().search === search) return;
    notesReadGeneration += 1;
    set({ search, loading: false });
  },
  setTag: (tag) => {
    if (get().tag === tag) return;
    notesReadGeneration += 1;
    set({ tag, loading: false });
  },

  async loadNotes(request = {}) {
    const generation = ++notesReadGeneration;
    const { search, tag } = get();
    set({ loading: true, error: '' });

    try {
      const query = {
        search: search || undefined,
        tag: tag || undefined,
        ...request,
      };
      const notes = request.limit === undefined ? await listAllNotes(query) : await listNotes(query);
      if (generation !== notesReadGeneration) return;

      set((state) => ({
        notes,
        activeNoteId:
          state.activeNoteId && notes.some((note) => note.id === state.activeNoteId)
            ? state.activeNoteId
            : notes[0]?.id ?? null,
      }));
    } catch (error) {
      if (generation !== notesReadGeneration) return;
      set({
        notes: [],
        activeNoteId: null,
        error: error instanceof Error ? error.message : '加载笔记失败',
      });
    } finally {
      if (generation === notesReadGeneration) set({ loading: false });
    }
  },

  async refreshTags() {
    const generation = ++tagsReadGeneration;
    try {
      const tags = await listNoteTags();
      if (generation === tagsReadGeneration) set({ tags });
    } catch {
      if (generation === tagsReadGeneration) set({ tags: [] });
    }
  },

  async refreshBacklinks(noteIds) {
    const targets = new Set(noteIds);
    if (targets.size === 0) return;
    const notes = get().notes.filter((note) => targets.has(note.id));
    await Promise.all(notes.map(async (target) => {
      const token = Symbol();
      backlinkReads.set(target.id, token);
      // A newer request for this target or a replaced note (e.g. a full list
      // read) owns its metadata. Unrelated saves keep this target usable.
      const isCurrent = () => backlinkReads.get(target.id) === token && get().notes.includes(target);
      try {
        const backlinks = await listNoteBacklinks(target.id);
        if (!isCurrent()) return;
        set((state) => ({notes: state.notes.map((note) => note === target ? {...note, backlinks} : note)}));
      } catch {
        // The write already committed. Recover metadata without reporting a
        // failed save or discarding the confirmed editor contents.
        if (isCurrent()) void get().loadNotes();
      } finally {
        if (backlinkReads.get(target.id) === token) backlinkReads.delete(target.id);
      }
    }));
  },

  async createWorkspaceNote(draft = {}, options = {}) {
    set({ saving: true, error: '' });

    try {
      const note = await createNote(
        {
          paperId: draft.paperId || GLOBAL_NOTES_PAPER_ID,
          type: draft.type || 'standalone',
          title: draft.title || '未命名笔记',
          content: draft.content ?? '',
          contentJson: draft.contentJson ?? null,
          contentHtml: draft.contentHtml ?? null,
          contentText: draft.contentText ?? '',
          excerpt: draft.excerpt ?? null,
          pdfLocation: draft.pdfLocation ?? null,
          anchors: draft.anchors ?? [],
          tags: draft.tags ?? [],
          color: draft.color || '#f3f4f6',
          linkedNoteIds: draft.linkedNoteIds ?? [],
          linkedPaperIds: draft.linkedPaperIds ?? [],
          linkedNoteTitles: draft.linkedNoteTitles ?? [],
          linkedPaperId: draft.linkedPaperId ?? null,
          folderId: draft.folderId ?? null,
          wordCount: draft.wordCount ?? 0,
          isFavorite: draft.isFavorite ?? false,
          isPinned: draft.isPinned ?? false,
        },
        options,
      );

      notesReadGeneration += 1;
      set((state) => ({
        loading: false,
        notes: [note, ...state.notes.filter((item) => item.id !== note.id)],
        activeNoteId: note.id,
      }));
      void get().refreshTags();
      return note;
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建笔记失败';
      set({ error: message });
      throw new Error(message);
    } finally {
      set({ saving: false });
    }
  },

  async updateWorkspaceNote(noteId, patch, options = {}) {
    set({ saving: true, error: '' });
    const previous = get().notes.find((note) => note.id === noteId);

    try {
      const note = await updateNote(noteId, patch, options);

      notesReadGeneration += 1;
      set((state) => ({
        loading: false,
        notes: state.notes
          .map((item) => (item.id === note.id ? note : item))
          .sort((left, right) => Number(right.isPinned) - Number(left.isPinned) || right.updatedAt - left.updatedAt),
        activeNoteId: state.activeNoteId ?? note.id,
      }));
      void get().refreshBacklinks([...(previous?.linkedNoteIds ?? []), ...(note.linkedNoteIds ?? [])]);
      void get().refreshTags();
      return note;
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存笔记失败';
      set({ error: message });
      throw new Error(message);
    } finally {
      set({ saving: false });
    }
  },

  async deleteWorkspaceNote(noteId, options = {}) {
    set({ saving: true, error: '' });

    try {
      await deleteNote(noteId, options);
      notesReadGeneration += 1;
      set((state) => {
        const notes = state.notes.filter((note) => note.id !== noteId);
        return {
          loading: false,
          notes,
          activeNoteId: state.activeNoteId === noteId ? notes[0]?.id ?? null : state.activeNoteId,
        };
      });
      void get().refreshTags();
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除笔记失败';
      set({ error: message });
      throw new Error(message);
    } finally {
      set({ saving: false });
    }
  },
}));
