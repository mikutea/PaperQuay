import { randomUUID } from 'node:crypto';
import { retrievalFixture } from '../../../tests/remoteRetrievalFixtures.ts';
import { remoteRetrievalDigest, runRemoteLexicalRetrieval, REMOTE_RETRIEVAL_LIMITS as L, type RemoteRetrievalCapability, type RemoteRetrievalReceipt } from '../../../packages/sync-core/src/remoteRetrieval.ts';
export { retrievalFixture };
export const retrievalAt = '2026-11-04T10:00:00.000Z';
export const retrievalScope = { apiBaseUrl: 'https://sync.example.test', accountId: '00000000-0000-4000-8000-000000000001' };
export const retrievalDevice = '00000000-0000-4000-8000-000000000020';
export function retrievalCapability(): RemoteRetrievalCapability {
  return { protocolVersion: 1, mode: 'lexical-v1', execution: 'server', externalModelCalls: false,
    maxSources: L.sources, maxQueryBytes: L.queryBytes, maxTopK: L.topK, maxExcerptCharacters: L.excerptCharacters,
    maxRequestBytes: L.requestBytes, maxResultBytes: L.resultBytes, maxSourceBytes: L.sourceBytes, maxChunks: L.chunks,
    maxSourceCharacters: L.sourceCharacters, maxVectorElements: L.vectorElements, maxDurationMs: L.durationMs,
    maxRetained: L.retained, maxReceipts: L.receipts, maxAccountBytes: L.accountBytes };
}
export async function retrievalReceipt(f = retrievalFixture()): Promise<RemoteRetrievalReceipt> {
  const result = await runRemoteLexicalRetrieval(f.request, [f.artifact]);
  return { version: 1, request: f.request, requestDigest: await remoteRetrievalDigest(f.request), result, resultDigest: await remoteRetrievalDigest(result), createdAt: retrievalAt };
}
export function retrievalRecords(f: ReturnType<typeof retrievalFixture>) {
  const head = { schemaVersion: 1 as const, revision: 1, updatedAt: retrievalAt, deletedAt: null, modifiedByDeviceId: retrievalDevice };
  return [
    { ...head, entityType: 'paper' as const, entityId: f.source.target.paperId, data: { title: 'Urban community evidence', authors: ['Synthetic researcher'], year: '2026', publication: null, abstractText: 'Metadata only', doi: null, keywords: ['urban'] } },
    { ...head, entityType: 'attachmentVersion' as const, entityId: f.source.target.attachmentVersionId, data: { paperId: f.source.target.paperId, attachmentId: randomUUID(), sha256: f.source.target.sha256,
      sizeBytes: f.source.target.sizeBytes, mediaType: 'application/pdf' as const, fileName: f.source.target.fileName, pageCount: f.source.target.pageCount } },
  ];
}
