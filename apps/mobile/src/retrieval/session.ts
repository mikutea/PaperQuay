import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../../../../packages/sync-core/src/validation.ts';
import { REMOTE_RETRIEVAL_LIMITS, validateRemoteRetrievalRequest, validateRemoteRetrievalResult,
  type RemoteRetrievalRequest, type RemoteRetrievalReceipt, type RemoteRetrievalStatus } from '../../../../packages/sync-core/src/remoteRetrieval.ts';
import { getVisibleEntity, type AccountSyncState, type AttachmentVersionData } from '../../../../packages/sync-core/src/index.ts';
import { reviewFingerprint } from '../review/fingerprint.ts';
import { RetrievalError } from './client.ts';
const hash = /^[0-9a-f]{64}$/, encoder = new TextEncoder();
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export interface RetrievalSession {
  version: 1; revision: number; createdAt: string; request: RemoteRetrievalRequest;
  status: 'prepared' | 'uncertain' | 'absent' | 'complete' | 'removed'; receipt: RemoteRetrievalReceipt | null;
}
/** Synchronous integrity verification keeps receipt checks inside IndexedDB's
 * write transaction. The networking layer verifies the same SHA-256 contract. */
export function readStoredRetrievalReceipt(value: unknown): RemoteRetrievalReceipt {
  if (!exact(value, ['version', 'request', 'requestDigest', 'result', 'resultDigest', 'createdAt']) || value.version !== 1) throw new RetrievalError('INVALID');
  const request = validateRemoteRetrievalRequest(value.request), result = validateRemoteRetrievalResult(value.result, request);
  if (!hash.test(String(value.requestDigest)) || reviewFingerprint(request) !== value.requestDigest || result.requestDigest !== value.requestDigest
    || !hash.test(String(value.resultDigest)) || reviewFingerprint(result) !== value.resultDigest
    || typeof value.createdAt !== 'string' || new Date(value.createdAt).toISOString() !== value.createdAt) throw new RetrievalError('INVALID');
  for (const row of result.evidence) if (bytesToHex(sha256(encoder.encode(row.text))) !== row.excerptDigest) throw new RetrievalError('INVALID');
  return { version: 1, request, requestDigest: value.requestDigest as string, result, resultDigest: value.resultDigest as string, createdAt: value.createdAt };
}
export function readRetrievalSession(value: unknown): RetrievalSession {
  if (encoder.encode(canonicalJson(value)).length > REMOTE_RETRIEVAL_LIMITS.resultBytes + REMOTE_RETRIEVAL_LIMITS.requestBytes + 16384) throw new RetrievalError('LIMIT');
  if (!exact(value, ['version', 'revision', 'createdAt', 'request', 'status', 'receipt']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !['prepared', 'uncertain', 'absent', 'complete', 'removed'].includes(String(value.status)) || typeof value.createdAt !== 'string' || new Date(value.createdAt).toISOString() !== value.createdAt) throw new RetrievalError('INVALID');
  const request = validateRemoteRetrievalRequest(value.request), receipt = value.receipt === null ? null : readStoredRetrievalReceipt(value.receipt);
  if (receipt && canonicalJson(receipt.request) !== canonicalJson(request) || value.status === 'complete' && !receipt || ['prepared', 'uncertain', 'absent'].includes(String(value.status)) && receipt) throw new RetrievalError('INVALID');
  return { version: 1, revision: Number(value.revision), createdAt: value.createdAt, request, status: value.status as RetrievalSession['status'], receipt };
}
export function createRetrievalSession(request: RemoteRetrievalRequest, createdAt: string): RetrievalSession {
  return readRetrievalSession({ version: 1, revision: 1, createdAt, request, status: 'prepared', receipt: null });
}
export function beginRetrievalSession(input: RetrievalSession): RetrievalSession {
  const session = readRetrievalSession(input); if (!['prepared', 'absent', 'uncertain'].includes(session.status)) throw new RetrievalError('CHANGED');
  return readRetrievalSession({ ...session, revision: session.revision + 1, status: 'uncertain' });
}
export function receiveRetrievalSession(input: RetrievalSession, receiptInput: RemoteRetrievalReceipt): RetrievalSession {
  const session = readRetrievalSession(input), receipt = readStoredRetrievalReceipt(receiptInput);
  if (canonicalJson(receipt.request) !== canonicalJson(session.request) || !['uncertain', 'complete'].includes(session.status)) throw new RetrievalError('CHANGED');
  if (session.receipt) { if (session.receipt.resultDigest !== receipt.resultDigest) throw new RetrievalError('INVALID'); return session; }
  return readRetrievalSession({ ...session, revision: session.revision + 1, status: 'complete', receipt });
}
export function applyRetrievalStatus(input: RetrievalSession, result: RemoteRetrievalStatus): RetrievalSession {
  const session = readRetrievalSession(input);
  if (result.requestId !== session.request.requestId || result.requestDigest !== null && result.requestDigest !== reviewFingerprint(session.request)) throw new RetrievalError('INVALID');
  if (result.status === 'complete') return receiveRetrievalSession(session, result.receipt!);
  if (result.status === 'absent') {
    if (!['uncertain', 'absent'].includes(session.status)) throw new RetrievalError('CHANGED');
    return readRetrievalSession({ ...session, revision: session.revision + 1, status: 'absent', receipt: null });
  }
  return readRetrievalSession({ ...session, revision: session.revision + 1, status: 'removed' });
}
export type RetrievalPendingResolutions = Readonly<Record<string, { entityType: string; entityId: string }>>;
export function assertRetrievalSourcesCurrent(request: RemoteRetrievalRequest, sync: Readonly<AccountSyncState>, pendingResolutions: RetrievalPendingResolutions = {}): void {
  for (const { target } of validateRemoteRetrievalRequest(request).sources) {
    const selected = (type: string, id: string) => type === 'paper' && id === target.paperId || type === 'attachmentVersion' && id === target.attachmentVersionId;
    if (Object.values(sync.conflicts).some(row => selected(row.attempted.entityType, row.attempted.entityId) || row.current && selected(row.current.entityType, row.current.entityId))
      || Object.values(pendingResolutions).some(row => selected(row.entityType, row.entityId))) throw new RetrievalError('SOURCE_CHANGED');
    const paper = getVisibleEntity(sync as AccountSyncState, 'paper', target.paperId), version = getVisibleEntity(sync as AccountSyncState, 'attachmentVersion', target.attachmentVersionId);
    const data = version?.data as AttachmentVersionData | null;
    if (!paper?.data || paper.deleted || paper.pending || paper.revision !== target.paperRevision || !data || version!.deleted || version!.pending || version!.revision !== target.versionRevision
      || data.paperId !== target.paperId || data.sha256 !== target.sha256 || data.sizeBytes !== target.sizeBytes || data.pageCount !== target.pageCount || data.fileName !== target.fileName) throw new RetrievalError('SOURCE_CHANGED');
  }
}
