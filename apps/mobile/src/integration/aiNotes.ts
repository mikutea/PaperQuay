import { getVisibleEntity, type AccountSyncState, type NoteData } from '../../../../packages/sync-core/src/index.ts';
import type { AiSaveContext } from '../ai/types.ts';
import type { PdfAiContext } from '../pdf/types.ts';
import { ClientError } from '../errors.ts';
import type { WorkspaceController, WorkspaceSnapshot } from '../sync/workspace.ts';

/** Re-check at the persistence boundary, even if a retired UI callback arrives. */
export function assertAiNoteTarget(snapshot: WorkspaceSnapshot, apiBaseUrl: string, context: PdfAiContext | null,
  source: AiSaveContext, note: NoteData, transactionSync?: Readonly<AccountSyncState>): void {
  const sync = transactionSync ?? snapshot.workspace?.sync;
  const version = sync ? getVisibleEntity(sync, 'attachmentVersion', source.attachmentVersionId) : null;
  const paper = sync ? getVisibleEntity(sync, 'paper', source.paperId) : null;
  if (snapshot.status !== 'ready' || !snapshot.workspace || !context || !sync || !paper || paper.deleted ||
    snapshot.identity?.accountId !== source.accountScope.accountId || sync.accountId !== source.accountScope.accountId || apiBaseUrl !== source.accountScope.apiBaseUrl ||
    note.paperId !== source.paperId || context.paperId !== source.paperId || context.attachmentVersionId !== source.attachmentVersionId ||
    context.sha256 !== source.sha256 || context.textSource?.packageDigest !== source.parsedPackageDigest || !version || version.deleted || !version.data || !('sha256' in version.data) ||
    version.data.paperId !== source.paperId || version.data.sha256 !== source.sha256)
    throw new ClientError('ACCOUNT_CHANGED');
}

/** Re-read both the live text source and the transaction's workspace when a
 * queued save finally executes; neither a rendered snapshot nor a PDF hash
 * alone identifies a replaced parsed package. */
export async function saveAiResultNote(
  controller: Pick<WorkspaceController, 'getSnapshot' | 'save'>, apiBaseUrl: string,
  currentContext: () => PdfAiContext | null, source: AiSaveContext, note: NoteData,
): Promise<void> {
  const capturedSource = structuredClone(source), capturedNote = structuredClone(note);
  assertAiNoteTarget(controller.getSnapshot(), apiBaseUrl, currentContext(), capturedSource, capturedNote);
  await controller.save({ entityType: 'note', entityId: crypto.randomUUID(), mutation: 'put', data: capturedNote }, undefined,
    (sync) => assertAiNoteTarget(controller.getSnapshot(), apiBaseUrl, currentContext(), capturedSource, capturedNote, sync));
}
