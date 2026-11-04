import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountState } from '../../../packages/sync-core/src/state.ts';
import { listVisibleEntities } from '../../../packages/sync-core/src/index.ts';
import { researchContextFromRetrieval } from '../src/research/fromRetrieval.ts';
import { validateResearchContext, buildResearchMessages } from '../src/research/context.ts';
import { researchResultMarkdown } from '../src/research/session.ts';
import { agentContextsFromRetrieval } from '../src/agent/fromRetrieval.ts';
import { captureAgentTargets } from '../src/agent/proposals.ts';
import { validateAgentContexts } from '../src/agent/context.ts';
import { createAgentConversation, prepareAgentConversationRequest, beginAgentModelTurn, finishAgentModelTurn, approveAgentContextRequest } from '../src/agent/conversation.ts';
import { agentModelMessages } from '../src/agent/modelProtocol.ts';
import { modelEvidenceFromTurn, validateAgentEvidence } from '../src/agent/evidence.ts';
import { defaultAiProvider } from '../src/ai/provider.ts';
import { reviewFingerprint } from '../src/review/fingerprint.ts';
import { retrievalTextDigest } from '../src/retrieval/provenance.ts';
import { retrievalFixture, retrievalReceipt, retrievalRecords, retrievalScope, retrievalDevice, retrievalAt } from './retrievalFixtures.ts';
function synced(f: ReturnType<typeof retrievalFixture>) {
  const state = createAccountState(retrievalScope.accountId, retrievalDevice);
  state.serverRecords = Object.fromEntries(retrievalRecords(f).map(row => [row.entityType + ':' + row.entityId, row])); return state;
}
test('remote snippets keep original chunk numbers, exact pages, hashes and omitted coverage in the actual Research payload', async () => {
  const f = retrievalFixture(), receipt = await retrievalReceipt(f), sync = synced(f), row = receipt.result.evidence.at(-1)!;
  const context = await researchContextFromRetrieval({ receipt, evidenceIds: [row.id], sync, question: 'What is the scope of the evidence?' });
  assert.equal(context.mode, 'remote-search'); assert.equal(context.sources[0].kind, 'remote-index'); assert.equal(context.evidence[0].chunkIndex, row.chunkIndex);
  assert.equal(context.evidence[0].id, 'S1E' + (row.chunkIndex + 1)); assert.equal(context.evidence[0].text, row.text); assert.equal(context.evidence[0].pageIndex, row.pageIndex);
  assert.equal(context.omittedChunks, f.source.chunkCount - 1); assert.equal(context.sources[0].remoteRetrieval!.resultDigest, receipt.resultDigest);
  assert.deepEqual(await validateResearchContext(context), context); const messages = await buildResearchMessages(context), wire = JSON.parse(messages[1].content);
  assert.equal(wire.evidence[0].text, row.text); assert.equal(wire.sources[0].remoteRetrieval.source.artifactDigest, f.source.artifactDigest);
  assert(messages[0].content.includes('远程关键词检索片段')); assert(messages[0].content.includes('不是语义相似度或可信度'));
  const markdown = researchResultMarkdown({ id: crypto.randomUUID(), context, provider: { id: 'synthetic', endpoint: 'https://model.example.test', model: 'synthetic' }, text: '[S1E' + (row.chunkIndex + 1) + '] Evidence', status: 'complete', startedAt: retrievalAt, finishedAt: retrievalAt, usage: null, failure: null, cost: 'unknown' });
  assert(markdown.includes(receipt.resultDigest)); assert(markdown.includes(f.source.artifactDigest)); assert(markdown.includes('远程关键词检索片段'));
});
test('unknown or empty selections and changed local source heads never become adopted remote evidence', async () => {
  const f = retrievalFixture(), receipt = await retrievalReceipt(f), sync = synced(f), options = { receipt, sync, question: 'Evidence scope' };
  await assert.rejects(researchContextFromRetrieval({ ...options, evidenceIds: [] })); await assert.rejects(researchContextFromRetrieval({ ...options, evidenceIds: ['R9C99'] }));
  const ids = receipt.result.evidence.map(row => row.id); await assert.rejects(researchContextFromRetrieval({ ...options, evidenceIds: [ids[0], ids[0]] }));
  sync.serverRecords['attachmentVersion:' + f.source.target.attachmentVersionId].revision++;
  await assert.rejects(researchContextFromRetrieval({ ...options, evidenceIds: ids }), { code: 'SOURCE_CHANGED' });
});
test('recomputing an outer context digest cannot hide modified text, page or remote provenance', async () => {
  const f = retrievalFixture(), receipt = await retrievalReceipt(f), context = await researchContextFromRetrieval({ receipt, evidenceIds: receipt.result.evidence.map(row => row.id), sync: synced(f), question: 'Evidence scope' });
  for (const alter of [(value: typeof context) => { value.evidence[0].text += ' forged'; }, (value: typeof context) => { value.evidence[0].pageIndex = 1 - value.evidence[0].pageIndex!; },
    (value: typeof context) => { value.sources[0].remoteRetrieval!.source.target.sha256 = 'f'.repeat(64); }]) {
    const changed = structuredClone(context); alter(changed); const { digest: _digest, ...body } = changed; changed.digest = retrievalTextDigest(JSON.stringify(body)); await assert.rejects(validateResearchContext(changed));
  }
});
test('Agent context adoption includes only whole approved excerpts and persists remote source proof in model evidence', async () => {
  const f = retrievalFixture(['urban '.repeat(350), 'urban '.repeat(350), 'urban '.repeat(350)]), receipt = await retrievalReceipt(f), sync = synced(f), entities = listVisibleEntities(sync);
  const targets = captureAgentTargets(entities, [f.source.target.paperId]), contexts = agentContextsFromRetrieval({ receipt, evidenceIds: receipt.result.evidence.map(row => row.id), sync, targets });
  assert.equal(contexts.length, 1); assert.equal(contexts[0].kind, 'remote-index'); assert(contexts[0].text.length <= 4000); assert(contexts[0].omittedCharacters > 0);
  assert.equal(contexts[0].remoteRetrieval!.evidence.length, 2); assert.deepEqual(validateAgentContexts(contexts, targets), contexts);
  const provider = { ...defaultAiProvider(), id: 'retrieval-context-qa', endpoint: 'https://model.example.test/v1', model: 'synthetic', requiresKey: false, stream: false }, at = Date.parse(retrievalAt);
  let conversation = createAgentConversation(targets, crypto.randomUUID(), at), request = prepareAgentConversationRequest(conversation, 'Need source evidence', 'auto', crypto.randomUUID(), at + 1);
  conversation = beginAgentModelTurn(conversation, request, provider);
  conversation = finishAgentModelTurn(conversation, request.id, { text: JSON.stringify({ kind: 'context-request', summary: 'Need evidence', mode: 'pdf-text', reason: 'Metadata is insufficient', paperIds: [targets[0].id] }), usage: null, failure: null }, at + 2);
  conversation = approveAgentContextRequest(conversation, contexts); assert.equal(conversation.turns.length, 1, 'approval does not create or run a model turn');
  request = prepareAgentConversationRequest(conversation, 'Explain the approved excerpts', 'auto', crypto.randomUUID(), at + 3);
  const wire = JSON.parse(agentModelMessages(request)[1].content); assert.equal(wire.approvedContextExcerpts[0].text, contexts[0].text);
  assert.equal(wire.approvedContextExcerpts[0].remoteRetrieval.resultDigest, receipt.resultDigest);
  conversation = beginAgentModelTurn(conversation, request, provider); conversation = finishAgentModelTurn(conversation, request.id, { text: JSON.stringify({ kind: 'answer', answer: 'Based on the excerpts.' }), usage: null, failure: null }, at + 4);
  const evidence = modelEvidenceFromTurn(conversation, conversation.turns.at(-1)!); assert.equal(evidence.contexts[0].remoteRetrieval!.source.artifactDigest, f.source.artifactDigest);
  assert.deepEqual(validateAgentEvidence(JSON.parse(JSON.stringify([evidence]))), [evidence]); assert(!JSON.stringify(evidence).includes(contexts[0].text), 'durable model source proof does not duplicate all context text');
});
test('Agent remote text and source mismatch cannot be hidden by updating its local context fingerprint', async () => {
  const f = retrievalFixture(), receipt = await retrievalReceipt(f), sync = synced(f), targets = captureAgentTargets(listVisibleEntities(sync), [f.source.target.paperId]);
  const contexts = agentContextsFromRetrieval({ receipt, evidenceIds: receipt.result.evidence.map(row => row.id), sync, targets }), changed = structuredClone(contexts[0]);
  changed.text = changed.text.slice(1); changed.omittedCharacters++; const { digest: _digest, ...body } = changed; changed.digest = reviewFingerprint(body);
  assert.throws(() => validateAgentContexts([changed], targets));
});

test('Agent omission includes unselected index text and the unseen portion of an excerpted chunk', async () => {
  const f = retrievalFixture(['urban '.repeat(900), 'Other material '.repeat(200), 'Additional source coverage']), receipt = await retrievalReceipt(f), sync = synced(f), targets = captureAgentTargets(listVisibleEntities(sync), [f.source.target.paperId]);
  const context = agentContextsFromRetrieval({ receipt, evidenceIds: [receipt.result.evidence[0].id], sync, targets })[0];
  assert.equal(context.text.length, 1800); assert.equal(context.totalCharacters, f.source.textCharacters + 2 * (f.source.chunkCount - 1));
  assert.equal(context.omittedCharacters, context.totalCharacters - 1800); assert(context.omittedCharacters > 5000);
  const changed = { ...context, totalCharacters: context.text.length, omittedCharacters: 0 }; const { digest: _digest, ...body } = changed; changed.digest = reviewFingerprint(body);
  assert.throws(() => validateAgentContexts([changed], targets));
});

for (const entityType of ['paper', 'attachmentVersion'] as const) {
  for (const blockedBy of ['retained-conflict', 'pending-resolution'] as const) {
    test(`selected ${entityType} ${blockedBy} blocks both remote context adapters even with no outbox or visible pending edit`, async () => {
      const f = retrievalFixture(), receipt = await retrievalReceipt(f), sync = synced(f), targets = captureAgentTargets(listVisibleEntities(sync), [f.source.target.paperId]);
      const entityId = entityType === 'paper' ? f.source.target.paperId : f.source.target.attachmentVersionId, record = sync.serverRecords[entityType + ':' + entityId], conflictId = crypto.randomUUID();
      const pendingResolutions: Record<string, { entityType: string; entityId: string }> = {};
      if (blockedBy === 'retained-conflict') sync.conflicts[conflictId] = { conflictId, attempted: { opId: crypto.randomUUID(), entityType, entityId, mutation: 'put', data: record.data, baseRevision: 1, schemaVersion: 1, clientCreatedAt: retrievalAt }, current: record } as any;
      else pendingResolutions[conflictId] = { entityType, entityId };
      const input = { receipt, evidenceIds: receipt.result.evidence.map(row => row.id), sync, pendingResolutions };
      await assert.rejects(researchContextFromRetrieval({ ...input, question: 'Evidence scope' }), { code: 'SOURCE_CHANGED' });
      assert.throws(() => agentContextsFromRetrieval({ ...input, targets }), { code: 'SOURCE_CHANGED' }); assert.equal(sync.outbox.length, 0);
    });
  }
}
