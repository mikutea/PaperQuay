import type { NoteChangedEventDetail } from '../../app/appEvents';
import type { Note } from '../../types/notes';

interface WorkspaceSnapshot {
  notes: Pick<Note, 'id' | 'linkedNoteIds'>[];
  search: string;
  tag: string | null;
  loading: boolean;
}

/** updateWorkspaceNote already applies its confirmed record and refreshes tags.
 * It also refreshes backlinks on the old and new link targets. Queries still
 * need a database read to refresh membership; editor saves do not need the
 * entire library when the previous and confirmed link lists are known. */
export function canUseWorkspaceNoteUpdate(
  detail: NoteChangedEventDetail,
  state: WorkspaceSnapshot,
  editorSourceId: string,
): boolean {
  if (detail.action !== 'updated' || detail.sourceId !== editorSourceId || state.search || state.tag || state.loading) return false;
  if (!detail.note || typeof detail.note !== 'object') return false;
  const updated = detail.note as Partial<Note>;
  if (updated.id !== detail.noteId || typeof updated.updatedAt !== 'number' || !Number.isFinite(updated.updatedAt) || updated.deletedAt != null) return false;
  const previous = state.notes.find((note) => note.id === detail.noteId);
  return Boolean(previous
    && Array.isArray(previous.linkedNoteIds)
    && Array.isArray(updated.linkedNoteIds));
}
