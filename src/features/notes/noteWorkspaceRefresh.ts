import type { NoteChangedEventDetail } from '../../app/appEvents';
import type { Note } from '../../types/notes';

interface WorkspaceSnapshot {
  notes: Pick<Note, 'id' | 'linkedNoteIds'>[];
  search: string;
  tag: string | null;
}

/** updateWorkspaceNote already applies its confirmed record and refreshes tags.
 * Queries and link targets still need a database read to refresh membership or
 * backlink metadata; ordinary editor saves do not need the entire library. */
export function canUseWorkspaceNoteUpdate(
  detail: NoteChangedEventDetail,
  state: WorkspaceSnapshot,
  editorSourceId: string,
): boolean {
  if (detail.action !== 'updated' || detail.sourceId !== editorSourceId || state.search || state.tag) return false;
  if (!detail.note || typeof detail.note !== 'object') return false;
  const updated = detail.note as Partial<Note>;
  if (updated.id !== detail.noteId || typeof updated.updatedAt !== 'number' || !Number.isFinite(updated.updatedAt) || updated.deletedAt != null) return false;
  const previous = state.notes.find((note) => note.id === detail.noteId);
  return Boolean(previous
    && Array.isArray(previous.linkedNoteIds) && previous.linkedNoteIds.length === 0
    && Array.isArray(updated.linkedNoteIds) && updated.linkedNoteIds.length === 0);
}
