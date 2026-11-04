import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../../../../packages/sync-core/src/validation.ts';
import { validateRemoteRetrievalSource, remoteRetrievalTerms, remoteRetrievalId,
  REMOTE_RETRIEVAL_LIMITS as L, type RemoteRetrievalSource, type RemoteRetrievalEvidence, type RemoteRetrievalReceipt } from '../../../../packages/sync-core/src/remoteRetrieval.ts';
import { RetrievalError } from './client.ts';
export type RetrievalEvidenceProof = Omit<RemoteRetrievalEvidence, 'text' | 'sourceIndex'> & { excerptCharacters: number };
export interface RetrievalProvenance {
  version: 1; mode: 'lexical-v1'; requestId: string; requestDigest: string; resultDigest: string; query: string;
  sourceIndex: number; source: RemoteRetrievalSource; evidence: RetrievalEvidenceProof[];
}
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const hash = /^[0-9a-f]{64}$/, integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const fail = (): never => { throw new RetrievalError('INVALID'); };
export const retrievalTextDigest = (text: string) => bytesToHex(sha256(new TextEncoder().encode(text)));
export function readRetrievalProvenance(input: unknown): RetrievalProvenance {
  if (new TextEncoder().encode(canonicalJson(input)).length > 48 * 1024 || !exact(input, ['version', 'mode', 'requestId', 'requestDigest', 'resultDigest', 'query', 'sourceIndex', 'source', 'evidence'])
    || input.version !== 1 || input.mode !== 'lexical-v1' || !hash.test(String(input.requestDigest)) || !hash.test(String(input.resultDigest))
    || typeof input.query !== 'string' || input.query.length > L.queryCharacters || new TextEncoder().encode(input.query).length > L.queryBytes || !integer(input.sourceIndex, 0, L.sources - 1)
    || !Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > L.topK) return fail();
  const requestId = remoteRetrievalId(input.requestId), source = validateRemoteRetrievalSource(input.source), terms = remoteRetrievalTerms(input.query), seen = new Set<string>();
  const evidence = input.evidence.map(value => {
    if (!exact(value, ['id', 'chunkIndex', 'chunkId', 'pageIndex', 'excerptStart', 'excerptCharacters', 'fullTextLength', 'chunkDigest', 'excerptDigest', 'score', 'matchedTerms'])
      || !integer(value.chunkIndex, 0, source.chunkCount - 1) || value.id !== 'R' + (input.sourceIndex as number + 1) + 'C' + (value.chunkIndex + 1)
      || seen.has(String(value.id)) || typeof value.chunkId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.chunkId)
      || !integer(value.pageIndex, 0, source.target.pageCount! - 1) || !integer(value.excerptStart, 0, 8192) || !integer(value.fullTextLength, 1, 8192)
      || !integer(value.excerptCharacters, 1, L.excerptCharacters) || value.excerptStart + value.excerptCharacters > value.fullTextLength || !hash.test(String(value.chunkDigest)) || !hash.test(String(value.excerptDigest))
      || !Array.isArray(value.matchedTerms) || !value.matchedTerms.length || value.matchedTerms.some(term => typeof term !== 'string' || !terms.includes(term))
      || new Set(value.matchedTerms).size !== value.matchedTerms.length || value.score !== value.matchedTerms.length) return fail();
    seen.add(String(value.id)); return structuredClone(value) as unknown as RetrievalEvidenceProof;
  });
  return { version: 1, mode: 'lexical-v1', requestId, requestDigest: String(input.requestDigest), resultDigest: String(input.resultDigest), query: input.query,
    sourceIndex: input.sourceIndex, source, evidence };
}
export function retrievalProvenance(receipt: RemoteRetrievalReceipt, sourceIndex: number, selected: readonly RemoteRetrievalEvidence[]): RetrievalProvenance {
  return readRetrievalProvenance({ version: 1, mode: 'lexical-v1', requestId: receipt.request.requestId, requestDigest: receipt.requestDigest, resultDigest: receipt.resultDigest,
    query: receipt.request.query, sourceIndex, source: receipt.request.sources[sourceIndex], evidence: selected.map(({ text, sourceIndex: _sourceIndex, ...row }) => ({ ...row, excerptCharacters: text.length })) });
}
export function assertRetrievalExcerpt(provenance: RetrievalProvenance, chunkIndex: number, pageIndex: number, text: string): RetrievalEvidenceProof {
  const proof = provenance.evidence.find(row => row.chunkIndex === chunkIndex);
  if (!proof || proof.pageIndex !== pageIndex || text.length !== proof.excerptCharacters || retrievalTextDigest(text) !== proof.excerptDigest) return fail();
  return proof;
}
