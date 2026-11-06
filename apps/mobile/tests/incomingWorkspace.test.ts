import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  canonicalJson, listVisibleEntities, rebindDevice, resumeAfterRestart, SYNC_LIMITS,
  type NoteData,
} from '../../../packages/sync-core/src/index.ts';
import { createRichNoteData } from '../../../packages/sync-core/src/richNote.ts';
import type { AccountIdentity } from '../src/api.ts';
import { ClientError } from '../src/errors.ts';
import { appendIncomingReceipt, INCOMING_RECEIPT_LIMIT, prepareIncomingImport,
  type PreparedIncomingImport } from '../src/library/incomingReceipt.ts';
import { prepareIncomingShareSource } from '../src/library/incomingShare.ts';
import { exportLibraryArchive, parseLibraryArchive, planLibraryImport, type LibraryArchive } from '../src/library/libraryTransfer.ts';
import { AccountStore, type AccountStorage } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController, type StoredWorkspace } from '../src/sync/workspace.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const A = id(1), B = id(2), DEVICE = id(3), SOURCE = 90;
const NOW = '2026-10-29T10:00:00.000Z';
const scope = (accountId = A) => ({ apiBaseUrl: 'https://sync.example.test', accountId });
const identity = (accountId = A): AccountIdentity => ({ accountId, device: {
  id: DEVICE, name: 'Incoming receipt test', platform: 'web', createdAt: NOW, lastSeenAt: NOW, revokedAt: null,
} });
function archive(body = 'Preserve the complete incoming note.'): LibraryArchive {
  return parseLibraryArchive(JSON.stringify({ format: 'paperquay-library', version: 1,
    papers: [{ ref: 'p1', data: { title: 'Incoming paper', doi: '10.1000/incoming', year: '2026',
      publication: null, abstractText: null, authors: ['Researcher'], keywords: [] } }],
    notes: [{ ref: 'n1', paperRef: 'p1', title: 'Incoming note', body, format: 'markdown' }],
  }));
}
async function prepared(value = archive(), selection?: readonly string[], sourceId = SOURCE): Promise<PreparedIncomingImport> {
  const text = JSON.stringify(value);
  const source = await prepareIncomingShareSource({ version: 1, id: id(sourceId), name: 'incoming.json', kind: 'file',
    mediaType: 'application/json', sizeBytes: new TextEncoder().encode(text).length, createdAt: 1_793_225_600_000, text });
  return prepareIncomingImport(source, value, selection);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(t: TestContext, options: {
  factory?: IDBFactory; databaseName?: string; online?: boolean;
  organization?: () => boolean; rich?: () => boolean;
  wrap?: (store: AccountStore<StoredWorkspace>) => AccountStorage<StoredWorkspace>;
} = {}) {
  const factory = options.factory ?? new IDBFactory(), databaseName = options.databaseName ?? crypto.randomUUID();
  const store = new AccountStore({ decode: decodeWorkspace, indexedDB: factory, databaseName });
  const binding = { key: 'api-a:subject-a', account: A };
  let allocated = 0, syncStarts = 0;
  const controller = new WorkspaceController({ apiBaseUrl: scope().apiBaseUrl,
    store: options.wrap?.(store) ?? store, online: options.online ?? false, now: () => NOW,
    makeId: () => id(100_000 + ++allocated), supportsPaperOrganization: options.organization, supportsRichNotes: options.rich,
    binding: { key: () => binding.key }, api: {
      register: async () => identity(binding.account), devices: async () => [], revokeDevice: async () => {},
      conflicts: async () => ({ conflicts: [], nextCursor: 'done', hasMore: false }),
      push: async () => { throw new Error('No HTTP or server calls in incoming receipt tests'); },
      pull: async () => { throw new Error('No HTTP or server calls in incoming receipt tests'); },
      resolveConflict: async () => { throw new Error('No conflict resolution expected'); },
    },
  });
  t.after(async () => { controller.deactivate(); await store.close(); });
  await controller.bind('Incoming receipt test'); assert.equal(controller.getSnapshot().status, 'ready');
  controller.syncNow = async () => { syncStarts++; };
  return { factory, databaseName, store, controller, binding, allocated: () => allocated, syncStarts: () => syncStarts };
}
function review(controller: WorkspaceController, request: PreparedIncomingImport) {
  return planLibraryImport(request.archive, listVisibleEntities(controller.getSnapshot().workspace!.sync), request.selection ?? undefined);
}
function commit(controller: WorkspaceController, request: PreparedIncomingImport, signature = review(controller, request).signature) {
  return controller.importLibrary(request.archive, request.selection ?? undefined, signature, request);
}
function assertBatch(value: StoredWorkspace) {
  const papers = listVisibleEntities(value.sync, 'paper'), notes = listVisibleEntities(value.sync, 'note');
  assert.equal(papers.length, 1); assert.equal(notes.length, 1); assert.equal(value.sync.outbox.length, 2);
  assert.equal((notes[0].data as NoteData).paperId, papers[0].entityId);
  assert.equal(value.incomingReceipts?.length, 1);
}

test('incoming receipt, linked entities and outbox publish together only after the real IDB COMMIT', async t => {
  const f = await setup(t), request = await prepared(), plan = review(f.controller, request);
  let committed = false; const publications: StoredWorkspace[] = [];
  const original = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    const row = args[0] as { state: StoredWorkspace };
    assertBatch(row.state);
    this.transaction.addEventListener('complete', () => { committed = true; });
    return original.apply(this, args);
  });
  f.controller.subscribe(() => {
    const value = f.controller.getSnapshot().workspace;
    if (value?.incomingReceipts?.length) { assert.equal(committed, true); publications.push(value); }
  });
  f.controller.syncNow = async () => { assert.equal(committed, true); assertBatch(f.controller.getSnapshot().workspace!); };
  const summary = await commit(f.controller, request, plan.signature), saved = (await f.store.read(scope()))!;
  assertBatch(saved); assert.ok(publications.length > 0);
  assert.deepEqual(summary, plan.summary); assert.deepEqual(saved.incomingReceipts, appendIncomingReceipt([], request, summary));
  assert.deepEqual(f.controller.getSnapshot().workspace, saved);
});

test('exact replay returns the original summary before a now-duplicate plan or stale signature can rebuild it', async t => {
  const f = await setup(t), request = await prepared(), firstPlan = review(f.controller, request);
  const summary = await commit(f.controller, request, firstPlan.signature), saved = (await f.store.read(scope()))!;
  assert.notEqual(review(f.controller, request).signature, firstPlan.signature);
  assert.equal(review(f.controller, request).summary.selectedNotes, 0);
  const allocations = f.allocated();
  assert.deepEqual(await commit(f.controller, request, 'old or unavailable review signature'), summary);
  assert.equal(f.allocated(), allocations); assert.deepEqual(await f.store.read(scope()), saved);
  summary.selectedNotes = 0;
  assert.equal((await f.store.read(scope()))!.incomingReceipts![0].summary.selectedNotes, 1, 'Returned summaries cannot mutate storage.');
});

test('two concurrent confirmations of one source commit one batch and both return the saved summary', async t => {
  const f = await setup(t), request = await prepared(), plan = review(f.controller, request);
  const results = await Promise.all([commit(f.controller, request, plan.signature), commit(f.controller, request, plan.signature)]);
  assert.deepEqual(results, [plan.summary, plan.summary]); assertBatch((await f.store.read(scope()))!); assert.equal(f.allocated(), 4);
});

test('an actual transaction abort stores neither receipt nor creates, and a retry still commits only once', async t => {
  const f = await setup(t), request = await prepared(), signature = review(f.controller, request).signature;
  const before = await f.store.read(scope()), displayed = f.controller.getSnapshot().workspace;
  const original = IDBObjectStore.prototype.put; let abortNext = true;
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    const result = original.apply(this, args); if (abortNext) { abortNext = false; this.transaction.abort(); } return result;
  });
  await assert.rejects(commit(f.controller, request, signature), { code: 'STORAGE_FAILED' });
  assert.deepEqual(await f.store.read(scope()), before); assert.equal(f.controller.getSnapshot().workspace, displayed); assert.equal(f.syncStarts(), 0);
  const summary = await commit(f.controller, request, signature); assertBatch((await f.store.read(scope()))!);
  assert.deepEqual(await commit(f.controller, request, signature), summary); assertBatch((await f.store.read(scope()))!);
  assert.equal(f.controller.getSnapshot().error, null);
});

test('a lost result after COMMIT is recovered from the receipt without materializing a second batch', async t => {
  let loseResult = false;
  const f = await setup(t, { wrap: base => ({
    read: key => base.read(key), remove: key => base.remove(key), close: () => base.close(),
    update: async (key, reducer, guard) => {
      const value = await base.update(key, reducer, guard);
      if (loseResult) { loseResult = false; throw new ClientError('STORAGE_FAILED'); } return value;
    },
  }) });
  const request = await prepared(), plan = review(f.controller, request), displayed = f.controller.getSnapshot().workspace;
  loseResult = true; await assert.rejects(commit(f.controller, request, plan.signature), { code: 'STORAGE_FAILED' });
  const saved = (await f.store.read(scope()))!; assertBatch(saved); assert.equal(f.controller.getSnapshot().workspace, displayed);
  assert.equal(f.syncStarts(), 0); const allocations = f.allocated();
  assert.deepEqual(await commit(f.controller, request, plan.signature), plan.summary);
  assert.equal(f.allocated(), allocations); assert.deepEqual(await f.store.read(scope()), saved);
  assert.deepEqual(f.controller.getSnapshot().workspace, saved); assert.equal(f.controller.getSnapshot().error, null);
});

test('the same source ID with changed source bytes or changed requested selection cannot reuse or replace its receipt', async t => {
  const f = await setup(t), request = await prepared(); await commit(f.controller, request);
  const before = await f.store.read(scope()), allocations = f.allocated();
  const changedBytes = await prepared(archive('different source bytes'));
  const changedSelection = await prepared(archive(), ['paper:p1', 'note:n1']);
  assert.notEqual(changedBytes.sourceDigest, request.sourceDigest);
  assert.equal(changedSelection.sourceDigest, request.sourceDigest); assert.notEqual(changedSelection.requestDigest, request.requestDigest);
  for (const changed of [changedBytes, changedSelection]) await assert.rejects(commit(f.controller, changed), { code: 'IMPORT_CHANGED' });
  assert.deepEqual(await f.store.read(scope()), before); assert.equal(f.allocated(), allocations);
});

test('prepared archive and normalized selection retain review signatures and reject caller substitution or cloned brands', async t => {
  const f = await setup(t), raw = archive(), selected = ['paper:p1', 'note:n1'];
  for (const choices of [undefined, selected] as const) {
    const request = await prepared(raw, choices);
    assert.equal(planLibraryImport(raw, [], choices).signature, review(f.controller, request).signature);
  }
  const request = await prepared(raw, selected), plan = review(f.controller, request), before = await f.store.read(scope());
  assert.deepEqual(request.selection, ['note:n1', 'paper:p1']);
  await assert.rejects(f.controller.importLibrary(raw, request.selection!, plan.signature, request), { code: 'IMPORT_CHANGED' });
  await assert.rejects(f.controller.importLibrary(request.archive, selected, plan.signature, request), { code: 'IMPORT_CHANGED' });
  await assert.rejects(f.controller.importLibrary(request.archive, request.selection!, plan.signature, { ...request }), { code: 'IMPORT_INVALID' });
  assert.deepEqual(await f.store.read(scope()), before); assert.equal(f.allocated(), 0);
  raw.notes[0].body = 'later unsaved edit'; selected.pop();
  await commit(f.controller, request, plan.signature);
  const saved = (await f.store.read(scope()))!; assertBatch(saved);
  assert.equal((listVisibleEntities(saved.sync, 'note')[0].data as NoteData).body, 'Preserve the complete incoming note.');
});

test('receipts remain private to the target account and each account can explicitly import the source once', async t => {
  const f = await setup(t), request = await prepared(); await commit(f.controller, request);
  const accountA = (await f.store.read(scope(A)))!;
  f.binding.account = B; f.binding.key = 'api-a:subject-b'; await f.controller.bind('B');
  assert.equal(f.controller.getSnapshot().workspace!.incomingReceipts, undefined);
  await commit(f.controller, request); const accountB = (await f.store.read(scope(B)))!;
  assertBatch(accountA); assertBatch(accountB); assert.deepEqual(await f.store.read(scope(A)), accountA);
  assert.notEqual(accountA.sync.outbox[0].operation.entityId, accountB.sync.outbox[0].operation.entityId);
  assert.equal(accountA.sync.accountId, A); assert.equal(accountB.sync.accountId, B);
});

test('queued incoming imports reject account, API, device and generation changes without writing a receipt', async t => {
  for (const change of ['account', 'api', 'device', 'generation'] as const) await t.test(change, async t => {
    let pause = false; const entered = deferred(), release = deferred();
    const f = await setup(t, { wrap: base => ({
      read: key => base.read(key), remove: key => base.remove(key), close: () => base.close(),
      update: async (key, reducer, guard) => { if (pause) { pause = false; entered.resolve(); await release.promise; } return base.update(key, reducer, guard); },
    }) });
    const request = await prepared(), signature = review(f.controller, request).signature;
    pause = true; const pending = commit(f.controller, request, signature); await entered.promise;
    if (change === 'account') { f.binding.account = B; f.binding.key = 'api-a:subject-b'; await f.controller.bind('B'); }
    if (change === 'api') f.binding.key = 'api-b:subject-a';
    if (change === 'device' || change === 'generation') await f.store.update(scope(), value => ({ ...value!,
      sync: change === 'device' ? rebindDevice(value!.sync, id(55)) : resumeAfterRestart(value!.sync),
    }));
    const before = await f.store.read(scope()); release.resolve(); await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
    assert.deepEqual(await f.store.read(scope()), before); assert.equal(f.allocated(), 0); assert.equal(f.syncStarts(), 0);
    if (change === 'account') {
      assert.equal((await f.store.read(scope(B)))!.incomingReceipts, undefined);
      assert.equal(f.controller.getSnapshot().identity!.accountId, B); assert.equal(f.controller.getSnapshot().error, null);
    }
  });
});

test('1024 stored receipts reject a new source atomically without eviction, while exact replay remains available', async t => {
  const f = await setup(t), request = await prepared(), plan = review(f.controller, request);
  const one = appendIncomingReceipt([], request, plan.summary)[0];
  const full = Array.from({ length: INCOMING_RECEIPT_LIMIT }, (_, i) => ({ ...one, sourceId: id(i + 1000), summary: { ...one.summary } }));
  const before = await f.store.update(scope(), value => ({ ...value!, incomingReceipts: full }));
  await assert.rejects(commit(f.controller, request, plan.signature), { code: 'IMPORT_RECEIPT_FULL' });
  assert.deepEqual(await f.store.read(scope()), before); assert.equal(f.syncStarts(), 0);
  const withReceipt = await f.store.update(scope(), value => ({ ...value!, incomingReceipts: [one, ...full.slice(1)] }));
  const allocations = f.allocated(); assert.deepEqual(await commit(f.controller, request, 'stale'), plan.summary);
  assert.deepEqual(await f.store.read(scope()), withReceipt); assert.equal(f.allocated(), allocations);
  assert.equal(f.controller.getSnapshot().error, null);
});

test('outbox capacity failure rolls back the whole incoming batch and leaves no success receipt', async t => {
  const f = await setup(t), request = await prepared();
  const full = await f.store.update(scope(), value => ({ ...value!, sync: { ...value!.sync,
    outbox: Array.from({ length: SYNC_LIMITS.maxLocalOperations - 1 }, (_, i) => ({
      operation: { entityType: 'note' as const, entityId: id(i + 200_000), mutation: 'put' as const, baseRevision: 0, schemaVersion: 1 as const,
        data: { paperId: null, title: 'Existing note', body: String(i), format: 'markdown' as const }, opId: id(i + 300_000), clientCreatedAt: NOW },
      originDeviceId: DEVICE, status: 'queued' as const, attempts: 0, errorCode: null, conflictId: null,
    })),
  } }));
  const signature = planLibraryImport(request.archive, listVisibleEntities(full.sync), request.selection ?? undefined).signature;
  await assert.rejects(commit(f.controller, request, signature), { code: 'IMPORT_CAPACITY' });
  assert.deepEqual(await f.store.read(scope()), full); assert.equal(f.syncStarts(), 0);
});

function richArchive(): LibraryArchive {
  const data = createRichNoteData({ paperId: null, title: 'Rich receipt note',
    document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich text', marks: [{ type: 'bold' }] }] }] },
    assets: [], metadata: { type: 'standalone', anchors: [], tags: [], color: '#fef08a', isFavorite: false, isPinned: false,
      linkedNoteIds: [], linkedPaperIds: [], createdAt: 100, updatedAt: 200, unresolvedReferences: [] },
  });
  return exportLibraryArchive([{ entityType: 'note', entityId: id(70), data, revision: 1, deleted: false, pending: false, status: 'synced' }]).archive;
}
test('new incoming imports enforce content capability before committing, but a saved receipt survives a later downgrade', async t => {
  for (const feature of ['organization', 'rich'] as const) await t.test(feature, async t => {
    let supported = false;
    const f = await setup(t, { online: true, organization: () => feature === 'organization' && supported, rich: () => feature === 'rich' && supported });
    const raw = feature === 'rich' ? richArchive() : archive();
    if (feature === 'organization') raw.papers[0].data.organization = { favorite: true, readingStatus: 'reading', tags: [], collections: [], queueRank: null };
    const request = await prepared(raw), plan = review(f.controller, request), before = await f.store.read(scope());
    await assert.rejects(commit(f.controller, request, plan.signature), { code: 'IMPORT_UNSUPPORTED' });
    assert.deepEqual(await f.store.read(scope()), before); assert.equal(f.allocated(), 0);
    supported = true; const summary = await commit(f.controller, request, plan.signature), saved = await f.store.read(scope());
    supported = false; const allocations = f.allocated();
    assert.deepEqual(await commit(f.controller, request, plan.signature), summary);
    assert.deepEqual(await f.store.read(scope()), saved); assert.equal(f.allocated(), allocations);
  });
});

test('receipt JSON round trips through storage and a reopened account preserves replay and outbox identities', async t => {
  const first = await setup(t), request = await prepared(), plan = review(first.controller, request);
  await commit(first.controller, request, plan.signature);
  const saved = (await first.store.read(scope()))!, json = JSON.stringify(saved);
  assert.deepEqual(decodeWorkspace(JSON.parse(json)), saved);
  assert.doesNotMatch(JSON.stringify(saved.incomingReceipts), /incoming\.json|Preserve|10\.1000|accountId|apiBaseUrl|sourceText|archive/);
  await first.store.update(scope(), () => JSON.parse(json)); first.controller.deactivate(); await first.store.close();
  const reopened = await setup(t, { factory: first.factory, databaseName: first.databaseName }), fresh = await prepared();
  const restored = (await reopened.store.read(scope()))!;
  assert.deepEqual(restored.incomingReceipts, saved.incomingReceipts);
  assert.deepEqual(restored.sync.outbox.map(entry => entry.operation), saved.sync.outbox.map(entry => entry.operation));
  assert.deepEqual(await commit(reopened.controller, fresh, plan.signature), plan.summary);
  assert.equal(reopened.allocated(), 0); assert.deepEqual(await reopened.store.read(scope()), restored);
});

test('workspace decoding rejects malformed or expanded receipt state and the rejected transaction preserves existing data', async t => {
  const f = await setup(t), request = await prepared(); await commit(f.controller, request);
  const saved = (await f.store.read(scope()))!, one = saved.incomingReceipts![0];
  const invalid: unknown[] = [null, {}, [one, one], [{ ...one, sourceDigest: 'not-a-hash' }], [{ ...one, sourceText: 'private body' }],
    [{ ...one, summary: { ...one.summary, selectedNotes: 0, skipped: 99 } }],
    Array.from({ length: INCOMING_RECEIPT_LIMIT + 1 }, (_, i) => ({ ...one, sourceId: id(i + 1000) }))];
  for (const incomingReceipts of invalid) {
    const polluted = { ...saved, incomingReceipts };
    assert.throws(() => decodeWorkspace(polluted), { code: 'STORAGE_CORRUPT' });
    await assert.rejects(f.store.update(scope(), () => polluted as StoredWorkspace), { code: 'STORAGE_CORRUPT' });
  }
  assert.throws(() => decodeWorkspace({ ...saved, incomingReceiptsBackup: [] }), { code: 'STORAGE_CORRUPT' });
  assert.deepEqual(await f.store.read(scope()), saved);
});

test('legacy three-argument imports and old workspace JSON stay compatible without manufacturing receipts', async t => {
  const f = await setup(t), raw = archive();
  const initial = (await f.store.read(scope()))!; assert.equal(initial.incomingReceipts, undefined);
  assert.deepEqual(decodeWorkspace(JSON.parse(JSON.stringify(initial))), initial);
  const plan = planLibraryImport(raw, []); await f.controller.importLibrary(raw, undefined, plan.signature);
  const saved = (await f.store.read(scope()))!; assert.equal(saved.incomingReceipts, undefined); assert.equal(saved.sync.outbox.length, 2);
  await assert.rejects(f.controller.importLibrary(raw, undefined, plan.signature), { code: 'IMPORT_CHANGED' });
  assert.equal(canonicalJson(await f.store.read(scope())), canonicalJson(saved));
});
