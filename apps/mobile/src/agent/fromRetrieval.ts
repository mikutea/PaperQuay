import { listVisibleEntities, type AccountSyncState } from '../../../../packages/sync-core/src/index.ts';
import type { RemoteRetrievalReceipt } from '../../../../packages/sync-core/src/remoteRetrieval.ts';
import { selectedRetrievalEvidence } from '../research/fromRetrieval.ts';
import { readStoredRetrievalReceipt, assertRetrievalSourcesCurrent, type RetrievalPendingResolutions } from '../retrieval/session.ts';
import { retrievalProvenance } from '../retrieval/provenance.ts';
import { reviewFingerprint } from '../review/fingerprint.ts';
import { validateCapturedAgentTargets, assertAgentTargetsCurrent, AgentError, type AgentTarget } from './proposals.ts';
import { validateAgentContexts, assertAgentContextsCurrent, agentContextDependencyHash, AGENT_CONTEXT_LIMITS, type AgentContext } from './context.ts';

/** Adopt only whole verified excerpts. A per-paper text limit never turns a
 * truncated passage into evidence for a larger source range. */
export function agentContextsFromRetrieval(input: { receipt: RemoteRetrievalReceipt; evidenceIds: readonly string[]; sync: Readonly<AccountSyncState>; pendingResolutions?: RetrievalPendingResolutions; targets: readonly AgentTarget[] }): AgentContext[] {
  const receipt = readStoredRetrievalReceipt(input.receipt), selected = selectedRetrievalEvidence(receipt, input.evidenceIds), indices = [...new Set(selected.map(row => row.sourceIndex))];
  const targets = validateCapturedAgentTargets(input.targets), entities = listVisibleEntities(input.sync as AccountSyncState); assertAgentTargetsCurrent({ targets }, entities);
  assertRetrievalSourcesCurrent({ ...receipt.request, sources: indices.map(index => receipt.request.sources[index]) }, input.sync, input.pendingResolutions);
  const contexts = indices.map(index => {
    const source = receipt.request.sources[index], target = targets.find(value => value.id === source.target.paperId); if (!target) throw new AgentError('INVALID');
    const rows = selected.filter(row => row.sourceIndex === index), included = [] as typeof rows; let length = 0;
    for (const row of rows) { const next = length + (included.length ? 2 : 0) + row.text.length; if (next > AGENT_CONTEXT_LIMITS.charactersPerSource) break; included.push(row); length = next; }
    if (!included.length) throw new AgentError('LIMIT');
    const text = included.map(row => row.text).join('\n\n'), totalCharacters = source.textCharacters + 2 * (source.chunkCount - 1), selection = { paperId: target.id, versionId: source.target.attachmentVersionId };
    const body = { paperId: target.id, paperHash: target.hash, selection, dependencyHash: agentContextDependencyHash(entities, selection), kind: 'remote-index' as const,
      sha256: source.target.sha256, packageDigest: source.parseDigest, totalPages: source.target.pageCount, text, pages: [...new Set(included.map(row => row.pageIndex))],
      totalCharacters, omittedCharacters: totalCharacters - text.length, remoteRetrieval: retrievalProvenance(receipt, index, included) };
    return { ...body, digest: reviewFingerprint(body) };
  });
  const checked = validateAgentContexts(contexts, targets); assertAgentContextsCurrent(checked, entities); return checked;
}
