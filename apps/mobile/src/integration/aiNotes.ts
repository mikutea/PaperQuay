import { getVisibleEntity, type NoteData } from '../../../../packages/sync-core/src/index.ts';
import type { AiSaveContext } from '../ai/types.ts';
import type { PdfAiContext } from '../pdf/types.ts';
import { ClientError } from '../errors.ts';
import type { WorkspaceSnapshot } from '../sync/workspace.ts';

/** Re-check at the persistence boundary, even if a retired UI callback arrives. */
export function assertAiNoteTarget(snapshot: WorkspaceSnapshot, apiBaseUrl: string, context: PdfAiContext | null,
  source: AiSaveContext, note: NoteData): void {
  const sync = snapshot.workspace?.sync;
  const version = sync ? getVisibleEntity(sync, 'attachmentVersion', source.attachmentVersionId) : null;
  const paper = sync ? getVisibleEntity(sync, 'paper', source.paperId) : null;
  if (snapshot.status !== 'ready' || !context || !sync || !paper || paper.deleted ||
    snapshot.identity?.accountId !== source.accountScope.accountId || sync.accountId !== source.accountScope.accountId || apiBaseUrl !== source.accountScope.apiBaseUrl ||
    note.paperId !== source.paperId || context.paperId !== source.paperId || context.attachmentVersionId !== source.attachmentVersionId ||
    context.sha256 !== source.sha256 || !version || version.deleted || !version.data || !('sha256' in version.data) ||
    version.data.paperId !== source.paperId || version.data.sha256 !== source.sha256)
    throw new ClientError('ACCOUNT_CHANGED');
}
