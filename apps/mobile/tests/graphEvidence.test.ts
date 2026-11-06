import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, listVisibleEntities, queueLocalEdit, type PaperData } from '../../../packages/sync-core/src/index.ts';
import { decodeGraphEvidenceFile, readStoredGraphEvidence, readGraphEvidenceAdoption, graphEvidenceAdoptionKey, graphEvidenceView, inspectGraphEvidenceSources, graphEvidenceJson } from '../src/graph/evidence.ts';
import { buildMobileGraph, defaultGraphSelection, exportGraph } from '../src/graph/model.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import { decodeWorkspace, type StoredWorkspace } from '../src/sync/workspace.ts';
import { ClientError } from '../src/errors.ts';
import { reviewFingerprint } from '../src/review/fingerprint.ts';
import { gid, graphScope as scope, graphAt as at, setupGraphEvidence, graphEvidenceFixture } from './graphEvidenceFixtures.ts';

test('file and stored evidence verify both canonical envelope and individual edge hashes, strict UTF8 and closed fields', async () => {
  const f = await graphEvidenceFixture(), bytes = new TextEncoder().encode(JSON.stringify(f.snapshot));
  assert.deepEqual(decodeGraphEvidenceFile(bytes), f.snapshot);
  const changed = structuredClone(f.snapshot); changed.edges[0].description = 'Changed without changing edge ID'; const { digest: _digest, ...body } = changed; changed.digest = reviewFingerprint(body);
  assert.throws(() => readStoredGraphEvidence(changed), { code: 'INVALID' });
  const unknown = { ...f.snapshot, storedPath: 'private-sentinel.pdf' }; assert.throws(() => readStoredGraphEvidence(unknown), { code: 'INVALID' });
  assert.throws(() => decodeGraphEvidenceFile(new Uint8Array([0xff])), { code: 'INVALID' });
  assert.throws(() => decodeGraphEvidenceFile(new Uint8Array(1024 * 1024 + 1)), { code: 'LIMIT' });
});
test('explicit account-local adoption stores only selected edges, survives a storage reopen, and never changes sync records or outbox', async t => {
  const f = await setupGraphEvidence(t), before = canonicalJson(f.controller.getSnapshot().workspace!.sync);
  assert.equal((await f.store.read(scope))!.graphEvidence, undefined);
  const adoption = await f.controller.adoptGraphEvidence(f.snapshot, [f.snapshot.edges[0].id], null);
  assert.deepEqual(adoption.edgeIds, [f.snapshot.edges[0].id]); assert.equal(canonicalJson(f.controller.getSnapshot().workspace!.sync), before); assert.equal(f.calls(), 0);
  const reopened = new AccountStore<StoredWorkspace>({ decode: decodeWorkspace, indexedDB: f.indexedDB, databaseName: f.name });
  assert.deepEqual((await reopened.read(scope))!.graphEvidence, adoption); assert.equal(await reopened.read({ ...scope, accountId: gid(99) }), null); await reopened.close();
  assert.deepEqual(decodeGraphEvidenceFile(new TextEncoder().encode(graphEvidenceJson(adoption))), f.snapshot);
});
test('foreign account or service files are rejected before storage, and source labels must match actual metadata', async t => {
  const f = await setupGraphEvidence(t);
  for (const update of [{ accountId: gid(99) }, { serviceId: 'f'.repeat(64) }]) {
    const { digest: _digest, ...body } = { ...f.snapshot, ...update }, input = { ...body, digest: reviewFingerprint(body) };
    assert.throws(() => f.controller.prepareGraphEvidenceFile(input), { code: 'SCOPE_CHANGED' });
    await assert.rejects(f.controller.adoptGraphEvidence(input, [input.edges[0].id], null), { code: 'SCOPE_CHANGED' });
  }
  const mislabeled = structuredClone(f.snapshot); mislabeled.sources[0].title = 'A title unsupported by its metadata proof';
  assert.equal(inspectGraphEvidenceSources(mislabeled, f.controller.getSnapshot().workspace!).available.has(gid(2)), false);
  assert.equal((await f.store.read(scope))!.graphEvidence, undefined);
});
test('a source changed behind a stale component snapshot is rejected from the actual IndexedDB transaction', async t => {
  const f = await setupGraphEvidence(t); f.controller.prepareGraphEvidenceFile(f.snapshot);
  await f.store.update(scope, value => { const next = structuredClone(value!); (next.sync.serverRecords['paper:' + gid(2)].data as PaperData).title = 'Concurrent metadata edit'; return next; });
  await assert.rejects(f.controller.adoptGraphEvidence(f.snapshot, [f.snapshot.edges[0].id], null), { code: 'EDIT_CHANGED' });
  assert.equal((await f.store.read(scope))!.graphEvidence, undefined); assert.equal(f.calls(), 0);
});
for (const entityType of ['paper', 'attachmentVersion'] as const) test(`a retained ${entityType} resolution with no outbox blocks importing dependent cached edges`, async t => {
  const f = await setupGraphEvidence(t), entityId = entityType === 'paper' ? gid(2) : gid(12);
  await f.store.update(scope, value => ({ ...value!, pendingResolutions: { [gid(80)]: { entityType, entityId, request: { opId: gid(81), expectedRevision: 1, choice: 'current' } } } }));
  await assert.rejects(f.controller.adoptGraphEvidence(f.snapshot, [f.snapshot.edges[0].id], null), { code: 'EDIT_CHANGED' }); assert.equal((await f.store.read(scope))!.graphEvidence, undefined);
});
test('rendering uses only adopted current edges, preserves the historical proof in exports, and hides stale sources without losing the receipt', async t => {
  const f = await setupGraphEvidence(t); await f.controller.adoptGraphEvidence(f.snapshot, f.snapshot.edges.map(row => row.id), null);
  let workspace = f.controller.getSnapshot().workspace!, view = graphEvidenceView(workspace)!;
  const result = buildMobileGraph(listVisibleEntities(workspace.sync), defaultGraphSelection(), view);
  assert(result.snapshot.edges.some(row => row.type === 'paper_cites_paper')); assert(result.snapshot.edges.some(row => row.type === 'related_by_embedding'));
  const exported = JSON.parse(exportGraph(result)); assert.equal(exported.edges.filter((row: any) => row.sourceProof).length, 2);
  assert(exported.edges.find((row: any) => row.type === 'paper_cites_paper').evidence.includes('尚未核验到当前 PDF')); assert.equal(exported.edges.find((row: any) => row.type === 'related_by_embedding').sourceProof.edge.provenance.modelDigest, 'b'.repeat(64));
  assert(!JSON.stringify(exported).includes('apiBaseUrl')); assert(!JSON.stringify(exported).includes('embeddingModelKey'));
  assert.equal(buildMobileGraph(listVisibleEntities(workspace.sync), { ...defaultGraphSelection(), includeReferences: false, includeEmbeddingEdges: false }, view).snapshot.edges.length, 0);
  await f.store.update(scope, value => ({ ...value!, pendingResolutions: { [gid(80)]: { entityType: 'paper', entityId: gid(2), request: { opId: gid(81), expectedRevision: 1, choice: 'current' } } } }));
  await f.controller.refreshGraphEvidence(); workspace = f.controller.getSnapshot().workspace!; view = graphEvidenceView(workspace)!;
  assert.equal(view.edges.length, 0); assert.equal(view.hiddenEdges, 2); assert.equal(workspace.graphEvidence!.snapshot.digest, f.snapshot.digest); assert.deepEqual(JSON.parse(graphEvidenceJson(workspace.graphEvidence!)), f.snapshot);
});
test('imported edges participate in search and local neighborhoods only after the normal tag/material scope', async t => {
  const f = await setupGraphEvidence(t); await f.controller.adoptGraphEvidence(f.snapshot, [f.snapshot.edges[0].id], null);
  const workspace = f.controller.getSnapshot().workspace!, view = graphEvidenceView(workspace), entities = listVisibleEntities(workspace.sync);
  assert.equal(buildMobileGraph(entities, { ...defaultGraphSelection(), search: 'First evidence paper' }, view).snapshot.nodes.length, 2);
  assert.equal(buildMobileGraph(entities, { ...defaultGraphSelection(), search: 'nothing matches this' }, view).snapshot.nodes.length, 0);
  assert.equal(buildMobileGraph(entities, { ...defaultGraphSelection(), localNodeId: 'paper:' + gid(2) }, view).snapshot.edges.length, 1);
  assert.equal(buildMobileGraph(entities, { ...defaultGraphSelection(), tag: 'missing-tag' }, view).snapshot.edges.length, 0);
});
test('lost storage acknowledgement can re-adopt the same selection without duplicate state, while replacement and removal require the exact prior receipt', async t => {
  const f = await setupGraphEvidence(t), update = f.store.update.bind(f.store); let lost = true;
  f.store.update = async (...args) => { const value = await update(...args); if (lost && value.graphEvidence) { lost = false; throw new ClientError('STORAGE_FAILED'); } return value; };
  const id = f.snapshot.edges[0].id; await assert.rejects(f.controller.adoptGraphEvidence(f.snapshot, [id], null), { code: 'STORAGE_FAILED' });
  const saved = (await f.store.read(scope))!.graphEvidence!; assert(saved);
  assert.deepEqual(await f.controller.adoptGraphEvidence(f.snapshot, [id], null), saved);
  await assert.rejects(f.controller.adoptGraphEvidence(f.snapshot, [f.snapshot.edges[1].id], null), { code: 'EDIT_CHANGED' });
  await assert.rejects(f.controller.clearGraphEvidence('a'.repeat(64)), { code: 'EDIT_CHANGED' });
  await f.controller.clearGraphEvidence(graphEvidenceAdoptionKey(saved)!); assert.equal((await f.store.read(scope))!.graphEvidence, undefined); assert.equal(f.calls(), 0);
});
test('late owner guards and pending local sources cannot write a private adoption', async t => {
  const f = await setupGraphEvidence(t); await assert.rejects(f.controller.adoptGraphEvidence(f.snapshot, [f.snapshot.edges[0].id], null, () => false), { code: 'ACCOUNT_CHANGED' });
  await f.store.update(scope, value => ({ ...value!, sync: queueLocalEdit(value!.sync, { entityType: 'paper', entityId: gid(2), mutation: 'put', data: { ...(value!.sync.serverRecords['paper:' + gid(2)].data as PaperData), title: 'A pending local edit' } }, { opId: gid(90), clientCreatedAt: at }) }));
  await assert.rejects(f.controller.adoptGraphEvidence(f.snapshot, [f.snapshot.edges[0].id], null), { code: 'EDIT_CHANGED' }); assert.equal((await f.store.read(scope))!.graphEvidence, undefined);
  f.controller.deactivate(); await assert.rejects(f.controller.adoptGraphEvidence(f.snapshot, [f.snapshot.edges[0].id], null), { code: 'ACCOUNT_CHANGED' });
});
test('stored adoption rejects unknown edge selections and tampered packages before any graph can use them', async () => {
  const f = await graphEvidenceFixture(), adoption = { version: 1, snapshot: f.snapshot, edgeIds: [f.snapshot.edges[0].id], adoptedAt: at };
  assert.deepEqual(readGraphEvidenceAdoption(adoption).snapshot, f.snapshot); assert.throws(() => readGraphEvidenceAdoption({ ...adoption, edgeIds: ['e'.repeat(64)] }));
  const broken = structuredClone(adoption); broken.snapshot.edges[0].description = 'Corrupted cached proof';
  assert.throws(() => decodeWorkspace({ sync: f.sync, pendingResolutions: {}, graphEvidence: broken }), { code: 'STORAGE_CORRUPT' });
});
