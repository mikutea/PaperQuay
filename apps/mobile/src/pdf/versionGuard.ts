import {
  getVisibleEntity, type AccountSyncState, type AttachmentVersionData, type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import { ClientError } from '../errors.ts';
import { PdfError } from './errors.ts';
import type { PdfVersion } from './types.ts';

/** Keep the expected identity independent of later edits to a caller's snapshot. */
export function capturePdfVersion(version: PdfVersion): PdfVersion {
  return { entityId: version.entityId, data: { ...version.data } };
}

/** Filename edits are allowed; bytes, parent and attachment identity cannot drift. */
export function assertPdfTarget(
  state: Readonly<AccountSyncState> | null | undefined,
  paperId: string,
  expected?: PdfVersion,
  parsedPages?: number,
): VisibleEntity | null {
  if (!state) throw new PdfError('ACCOUNT_CHANGED');
  const paper = getVisibleEntity(state, 'paper', paperId);
  if (!paper?.data || paper.deleted) throw new PdfError('TARGET_CHANGED');
  if (!expected) return null;
  const record = getVisibleEntity(state, 'attachmentVersion', expected.entityId);
  const data = record?.data as AttachmentVersionData | null;
  if (!record || record.deleted || !data || expected.data.paperId !== paperId
    || data.paperId !== paperId || data.attachmentId !== expected.data.attachmentId
    || data.sha256 !== expected.data.sha256 || data.sizeBytes !== expected.data.sizeBytes
    || data.mediaType !== expected.data.mediaType
    || (data.pageCount !== null && expected.data.pageCount !== null && data.pageCount !== expected.data.pageCount)
    || (parsedPages !== undefined && data.pageCount !== null && data.pageCount !== parsedPages))
    throw new PdfError('TARGET_CHANGED');
  return record;
}

/** Runs inside WorkspaceController.save's transaction, never against a displayed snapshot. */
export function pdfVersionWriteGuard(paperId: string, expected: PdfVersion | undefined, creatingId: string) {
  const captured = expected && capturePdfVersion(expected);
  return (state: Readonly<AccountSyncState>): void => {
    try {
      const record = assertPdfTarget(state, paperId, captured);
      // Pending edits retain the server revision. Do not overwrite a newer local
      // filename or page-count edit with the snapshot used to prepare this write.
      if (captured && record?.data) {
        const live = record.data as AttachmentVersionData;
        if (live.fileName !== captured.data.fileName || live.pageCount !== captured.data.pageCount)
          throw new Error('version metadata changed');
      }
      if (!captured && getVisibleEntity(state, 'attachmentVersion', creatingId)) throw new Error('existing version');
    } catch {
      // WorkspaceController intentionally only exposes controlled client errors.
      throw new ClientError('EDIT_CHANGED');
    }
  };
}
