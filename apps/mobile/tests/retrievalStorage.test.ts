import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { AccountStore } from '../src/storage/accountStore.ts';
import { WorkspaceController, decodeWorkspace, type StoredWorkspace } from '../src/sync/workspace.ts';
import { ClientError } from '../src/errors.ts';
import { canonicalJson } from '../../../packages/sync-core/src/validation.ts';
import { RetrievalClient } from '../src/retrieval/client.ts';
import { RetrievalRunner } from '../src/retrieval/runner.ts';
import { createRetrievalSession, readRetrievalSession, receiveRetrievalSession } from '../src/retrieval/session.ts';
import { retrievalFixture, retrievalCapability, retrievalReceipt, retrievalRecords, retrievalScope as scope, retrievalDevice, retrievalAt } from './retrievalFixtures.ts';
async function setup(t: TestContext) {
  const f = retrievalFixture(), indexedDB = new IDBFactory(), name = crypto.randomUUID();
  const store = new AccountStore<StoredWorkspace>({ decode: decodeWorkspace, indexedDB, databaseName: name });
  let network = 0; const api = { register: async () => ({ accountId: scope.accountId, device: { id: retrievalDevice, name: 'Retrieval QA', platform: 'web' as const, createdAt: retrievalAt, lastSeenAt: retrievalAt, revokedAt: null } }),
    devices: async () => [], revokeDevice: async () => {}, conflicts: async () => ({ conflicts: [], nextCursor: '', hasMore: false }),
    push: async () => { network++; throw Error('No sync service'); }, pull: async () => { network++; throw Error('No sync service'); }, resolveConflict: async () => { throw Error('No sync service'); } };
  const controller = new WorkspaceController({ api, store, apiBaseUrl: scope.apiBaseUrl, online: false, now: () => retrievalAt }); await controller.bind('Retrieval QA');
  const rows = retrievalRecords(f); await store.update(scope, value => ({ ...value!, sync: { ...value!.sync, serverRecords: Object.fromEntries(rows.map(row => [row.entityType + ':' + row.entityId, row])) } }));
  await controller.refreshRetrievalSession(); const session = await controller.saveRetrievalSession(createRetrievalSession(f.request, retrievalAt), null);
  const receipt = await retrievalReceipt(f); let calls = 0;
  const client = new RetrievalClient({ apiBaseUrl: scope.apiBaseUrl, getAccessToken: async () => 'synthetic-retrieval-only', getCapability: retrievalCapability, identityKey: () => 'A' }, async (url, input) => {
    calls++; if (input?.method === 'POST') { assert.equal((await store.read(scope))!.retrievalSession!.status, 'uncertain'); return Response.json({ replayed: false, receipt }); }
    return Response.json({ requestId: f.request.requestId, status: 'complete', requestDigest: receipt.requestDigest, receipt });
  });
  const runner = new RetrievalRunner(client, controller, () => controller.getSnapshot().status === 'ready');
  t.after(async () => { runner.dispose(); controller.deactivate(); await store.close(); });
  return { f, store, indexedDB, name, controller, session, runner, receipt, calls: () => calls, network: () => network };
}
test('private retrieval intent and receipt commit to actual IndexedDB without a library or outbox mutation', async t => {
  const a = await setup(t), before = canonicalJson(a.controller.getSnapshot().workspace!.sync);
  await a.runner.execute(a.session); const saved = (await a.store.read(scope))!.retrievalSession!;
  assert.equal(saved.status, 'complete'); assert.deepEqual(saved.receipt, a.receipt); assert.equal(a.calls(), 1); assert.equal(a.network(), 0);
  assert.equal(canonicalJson(a.controller.getSnapshot().workspace!.sync), before); assert.equal(a.runner.getSnapshot().candidate, null);
  const reopened = new AccountStore<StoredWorkspace>({ decode: decodeWorkspace, indexedDB: a.indexedDB, databaseName: a.name });
  assert.deepEqual((await reopened.read(scope))!.retrievalSession, saved); await reopened.close(); assert.equal(a.calls(), 1);
});
test('lost intent persistence acknowledgement sends zero requests and leaves the exact original request queryable', async t => {
  const a = await setup(t), update = a.store.update.bind(a.store); let lost = true;
  a.store.update = async (...args) => { const value = await update(...args); if (lost && value.retrievalSession?.status === 'uncertain') { lost = false; throw new ClientError('STORAGE_FAILED'); } return value; };
  await a.runner.execute(a.session); assert.equal(a.calls(), 0); assert.equal((await a.store.read(scope))!.retrievalSession!.status, 'uncertain');
  await a.controller.refreshRetrievalSession(); const current = a.controller.getSnapshot().workspace!.retrievalSession!;
  await a.runner.query(current); assert.equal(a.calls(), 1); assert.equal(a.controller.getSnapshot().workspace!.retrievalSession!.status, 'complete');
});
test('a received result with an unconfirmed save is retained for save-only retry, including a lost committed reply', async t => {
  const a = await setup(t), update = a.store.update.bind(a.store); let lost = true;
  a.store.update = async (...args) => { const value = await update(...args); if (lost && value.retrievalSession?.status === 'complete') { lost = false; throw new ClientError('STORAGE_FAILED'); } return value; };
  await a.runner.execute(a.session); assert.equal(a.calls(), 1); assert(a.runner.getSnapshot().candidate); assert.equal((await a.store.read(scope))!.retrievalSession!.status, 'complete');
  await a.runner.retrySave(); assert.equal(a.calls(), 1); assert.equal(a.runner.getSnapshot().candidate, null); assert.deepEqual((await a.store.read(scope))!.retrievalSession!.receipt, a.receipt);
});
test('changed source revisions and stale expected sessions stop before sending, while an already received diagnostic can be retained', async t => {
  const a = await setup(t);
  await a.store.update(scope, value => { const key = 'paper:' + a.f.source.target.paperId; return { ...value!, sync: { ...value!.sync, serverRecords: { ...value!.sync.serverRecords, [key]: { ...value!.sync.serverRecords[key], revision: 2 } } } }; });
  await a.runner.execute(a.session); assert.equal(a.calls(), 0); assert.equal((await a.store.read(scope))!.retrievalSession!.status, 'prepared');
  const mutated = { ...a.session, revision: a.session.revision + 1, request: { ...a.session.request, query: 'different' } };
  await assert.rejects(a.controller.saveRetrievalSession(mutated, { requestId: a.session.request.requestId, revision: a.session.revision }));
});
test('unknown requests cannot be dropped or replaced by a new request, and a retired account guard cannot save diagnostics', async t => {
  const a = await setup(t), begun = await a.controller.beginRetrievalRequest({ requestId: a.session.request.requestId, revision: a.session.revision });
  await assert.rejects(a.controller.clearRetrievalSession({ requestId: begun.request.requestId, revision: begun.revision }));
  await assert.rejects(a.controller.saveRetrievalSession(createRetrievalSession({ ...a.f.request, requestId: crypto.randomUUID() }, retrievalAt), { requestId: begun.request.requestId, revision: begun.revision }));
  const candidate = receiveRetrievalSession(begun, a.receipt), before = canonicalJson(await a.store.read(scope));
  await assert.rejects(a.controller.saveRetrievalSession(candidate, { requestId: begun.request.requestId, revision: begun.revision }, () => false));
  assert.equal(canonicalJson(await a.store.read(scope)), before); assert.equal(a.calls(), 0);
});
test('stored receipt integrity rejects changed snippet text or provenance even if outer session fields look valid', async t => {
  const a = await setup(t), begun = await a.controller.beginRetrievalRequest({ requestId: a.session.request.requestId, revision: a.session.revision });
  const valid = receiveRetrievalSession(begun, a.receipt), changed = structuredClone(valid); changed.receipt!.result.evidence[0].text = 'Forged text';
  assert.throws(() => readRetrievalSession(changed)); const shifted = structuredClone(valid); shifted.receipt!.request.sources[0].target.versionRevision++;
  assert.throws(() => readRetrievalSession(shifted)); assert.equal(a.calls(), 0);
});

for (const entityType of ['paper', 'attachmentVersion'] as const) {
  test(`transactional retrieval begin rejects a selected ${entityType} resolution retained outside the outbox`, async t => {
    const a = await setup(t), entityId = entityType === 'paper' ? a.f.source.target.paperId : a.f.source.target.attachmentVersionId;
    await a.store.update(scope, value => ({ ...value!, pendingResolutions: { [crypto.randomUUID()]: { entityType, entityId,
      request: { opId: crypto.randomUUID(), choice: 'current', expectedRevision: 1 } } } }));
    await a.runner.execute(a.session); assert.equal(a.calls(), 0); assert.equal((await a.store.read(scope))!.retrievalSession!.status, 'prepared');
    assert.equal((a.runner.getSnapshot().error as { code: string }).code, 'EDIT_CHANGED');
  });
}
