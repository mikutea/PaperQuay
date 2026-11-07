import { invoke } from '../platform/electron/core';
import { emitNoteChanged } from '../app/appEvents';
import { clearNoteEditorDraftsForNote } from '../features/notes/noteEditorUtils';
import type {
  CreateNoteRequest,
  ListNotesRequest,
  Note,
  NoteBacklink,
  NoteTagSummary,
  UpdateNoteRequest,
} from '../types/notes';

export interface NoteMutationOptions {
  sourceId?: string;
  silent?: boolean;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return fallback;
}

export async function listNotes(request: ListNotesRequest = {}): Promise<Note[]> {
  try {
    return await invoke<Note[]>('notes_list', { request });
  } catch (error) {
    throw new Error(toErrorMessage(error, '读取笔记失败'));
  }
}

export async function listAllNotes(request: Omit<ListNotesRequest, 'limit'> = {}): Promise<Note[]> {
  try {
    return await invoke<Note[]>('notes_list_all', { request });
  } catch (error) {
    throw new Error(toErrorMessage(error, '读取完整笔记列表失败'));
  }
}

export async function getNote(id: string): Promise<Note | null> {
  try {
    return await invoke<Note | null>('notes_get', { id });
  } catch (error) {
    throw new Error(toErrorMessage(error, '读取笔记详情失败'));
  }
}

export async function createNote(request: CreateNoteRequest, options: NoteMutationOptions = {}): Promise<Note> {
  try {
    const note = await invoke<Note>('notes_create', { request });
    if (!options.silent) {
      emitNoteChanged({
        action: 'created',
        noteId: note.id,
        note,
        updatedAt: note.updatedAt,
        sourceId: options.sourceId,
      });
    }
    return note;
  } catch (error) {
    throw new Error(toErrorMessage(error, '创建笔记失败'));
  }
}

export async function updateNote(
  id: string,
  patch: UpdateNoteRequest,
  options: NoteMutationOptions = {},
): Promise<Note> {
  try {
    const note = await invoke<Note>('notes_update', { id, patch });
    if (!options.silent) {
      emitNoteChanged({
        action: 'updated',
        noteId: note.id,
        note,
        updatedAt: note.updatedAt,
        sourceId: options.sourceId,
      });
    }
    return note;
  } catch (error) {
    throw new Error(toErrorMessage(error, '保存笔记失败'));
  }
}

export async function deleteNote(id: string, options: NoteMutationOptions = {}): Promise<void> {
  try {
    await invoke('notes_delete', { id });
    clearNoteEditorDraftsForNote(id);
    if (!options.silent) {
      emitNoteChanged({
        action: 'deleted',
        noteId: id,
        sourceId: options.sourceId,
      });
    }
  } catch (error) {
    throw new Error(toErrorMessage(error, '删除笔记失败'));
  }
}

export async function listNoteTags(
  request: Pick<ListNotesRequest, 'paperId'> = {},
): Promise<NoteTagSummary[]> {
  try {
    return await invoke<NoteTagSummary[]>('notes_tags', { request });
  } catch (error) {
    throw new Error(toErrorMessage(error, '读取笔记标签失败'));
  }
}

export async function listNoteBacklinks(noteId: string): Promise<NoteBacklink[]> {
  try {
    return await invoke<NoteBacklink[]>('notes_backlinks', { noteId });
  } catch (error) {
    throw new Error(toErrorMessage(error, '读取反向链接失败'));
  }
}
