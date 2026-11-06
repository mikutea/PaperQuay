import { listVisibleEntities, type AccountSyncState, type PaperData } from '../../../../packages/sync-core/src/index.ts';
import type { RemoteRetrievalReceipt, RemoteRetrievalEvidence } from '../../../../packages/sync-core/src/remoteRetrieval.ts';
import { readStoredRetrievalReceipt, assertRetrievalSourcesCurrent, type RetrievalPendingResolutions } from '../retrieval/session.ts';
import { retrievalProvenance, retrievalTextDigest } from '../retrieval/provenance.ts';
import { RetrievalError } from '../retrieval/client.ts';
import { validateResearchContext, type ResearchContext } from './context.ts';

export function selectedRetrievalEvidence(receipt: RemoteRetrievalReceipt, evidenceIds: readonly string[]): RemoteRetrievalEvidence[] {
  if (!evidenceIds.length || evidenceIds.length > 24 || new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some(id => !receipt.result.evidence.some(row => row.id === id))) throw new RetrievalError('INVALID');
  return receipt.result.evidence.filter(row => evidenceIds.includes(row.id));
}
export async function researchContextFromRetrieval(input: { receipt: RemoteRetrievalReceipt; evidenceIds: readonly string[]; sync: Readonly<AccountSyncState>; pendingResolutions?: RetrievalPendingResolutions; question: string }): Promise<ResearchContext> {
  const receipt = readStoredRetrievalReceipt(input.receipt), selected = selectedRetrievalEvidence(receipt, input.evidenceIds), sourceIndices = [...new Set(selected.map(row => row.sourceIndex))];
  assertRetrievalSourcesCurrent({ ...receipt.request, sources: sourceIndices.map(index => receipt.request.sources[index]) }, input.sync, input.pendingResolutions);
  const entities = listVisibleEntities(input.sync as AccountSyncState), sourceMap = new Map(sourceIndices.map((index, position) => [index, position]));
  const sources = sourceIndices.map(index => {
    const source = receipt.request.sources[index], rows = selected.filter(row => row.sourceIndex === index), paper = entities.find(row => row.entityType === 'paper' && row.entityId === source.target.paperId)!;
    return { paperId: source.target.paperId, title: (paper.data as PaperData).title, revision: source.target.paperRevision, kind: 'remote-index' as const,
      attachmentVersionId: source.target.attachmentVersionId, sha256: source.target.sha256, packageDigest: source.parseDigest, totalPages: source.target.pageCount,
      totalChunks: source.chunkCount, selectedChunks: rows.length, remoteRetrieval: retrievalProvenance(receipt, index, rows) };
  });
  const evidence = selected.map(row => { const sourceIndex = sourceMap.get(row.sourceIndex)!; return { id: 'S' + (sourceIndex + 1) + 'E' + (row.chunkIndex + 1), sourceIndex, chunkIndex: row.chunkIndex, score: row.score, pageIndex: row.pageIndex, text: row.text }; });
  const body = { version: 1 as const, question: input.question, mode: 'remote-search' as const, sources, evidence, omittedChunks: sources.reduce((n, source) => n + source.totalChunks, 0) - evidence.length };
  return validateResearchContext({ ...body, digest: retrievalTextDigest(JSON.stringify(body)) });
}
