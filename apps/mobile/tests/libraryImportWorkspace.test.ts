import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  canonicalJson, entityKey, listVisibleEntities, queueLocalCreates, rebindDevice, resumeAfterRestart, SYNC_LIMITS,
  type NoteData, type PaperData, type PushRequest, type PushResult, type SyncRecord,
} from '../../../packages/sync-core/src/index.ts';
import type { AccountIdentity } from '../src/api.ts';
import { ClientError } from '../src/errors.ts';
import { planLibraryImport, type LibraryArchive } from '../src/library/libraryTransfer.ts';
import { AccountStore, type AccountStorage } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController, type StoredWorkspace } from '../src/sync/workspace.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const A = id(1), B = id(2), DEVICE = id(3);
const NOW = '2026-10-26T10:00:00.000Z';
const scope = (accountId = A) => ({ apiBaseUrl: 'https://sync.example.test', accountId });
const identity = (accountId = A): AccountIdentity => ({ accountId, device: { id: DEVICE, name: 'Import test', platform: 'web', createdAt: NOW, lastSeenAt: NOW, revokedAt: null } });
const paperData = (): PaperData => ({ title: 'Imported paper', doi: '10.1000/import-test', year: '2026', publication: null, abstractText: null, authors: ['Researcher'], keywords: ['library'] });
function archive(): LibraryArchive {
  return { format: 'paperquay-library', version: 1, papers: [{ ref: 'p1', data: paperData() }], notes: [{ ref: 'n1', paperRef: 'p1', title: 'Imported note', body: '# Note\n\nPreserve this body.', format: 'markdown' }] };
}
function withOrganization(): LibraryArchive {
  const value = archive();
  value.papers[0].data.organization = { favorite: true, readingStatus: 'reading', tags: ['One'], collections: ['My collection'], queueRank: 3 };
  return value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class Api {
  account = A;
  records: SyncRecord[] = [];
  requests: PushRequest[] = [];
  receipts = new Map<string, PushResult>();
  failAckOnce = false;
  beforePush?: () => void;
  async register() { return identity(this.account); }
  async devices() { return [identity(this.account).device]; }
  async revokeDevice() {}
  async conflicts() { return { conflicts: [], nextCursor: 'done', hasMore: false }; }
  async resolveConflict(): Promise<never> { throw new Error('Unexpected conflict'); }
  async pull(cursor: string | null) { return { protocolVersion: 1 as const, records: this.records.slice(Number(cursor ?? 0)), nextCursor: String(this.records.length), hasMore: false }; }
  async push(request: PushRequest) {
    this.beforePush?.();
    this.requests.push(structuredClone(request));
    const results = request.operations.map((operation): PushResult => {
      const previous = this.receipts.get(operation.opId);
      if (previous) return { ...previous, replayed: true };
      if (operation.entityType === 'note' && operation.data?.paperId)
        assert.ok(this.records.some((record) => record.entityType === 'paper' && record.entityId === operation.data!.paperId), 'A linked paper must be sent before its note.');
      const record = { entityType: operation.entityType, entityId: operation.entityId, schemaVersion: 1, revision: 1, deletedAt: null, updatedAt: NOW, modifiedByDeviceId: request.deviceId, data: operation.data } as SyncRecord;
      const result: PushResult = { opId: operation.opId, status: 'applied', replayed: false, record };
      this.records.push(record); this.receipts.set(operation.opId, result);
      return result;
    });
    if (this.failAckOnce) { this.failAckOnce = false; throw new ClientError('NETWORK_UNAVAILABLE', true); }
    return { protocolVersion: 1 as const, results };
  }
}

function setup(t: TestContext, options: {
  api?: Api; factory?: IDBFactory; databaseName?: string; online?: boolean;
  organization?: () => boolean; makeId?: () => string;
  binding?: { key?: () => string | null; read?: () => Promise<AccountIdentity | null> };
  wrap?: (store: AccountStore<StoredWorkspace>) => AccountStorage<StoredWorkspace>;
} = {}) {
  const api = options.api ?? new Api(); const factory = options.factory ?? new IDBFactory();
  const databaseName = options.databaseName ?? crypto.randomUUID();
  const store = new AccountStore({ decode: decodeWorkspace, indexedDB: factory, databaseName });
  const controller = new WorkspaceController({ api, apiBaseUrl: scope().apiBaseUrl, store: options.wrap?.(store) ?? store,
    online: options.online ?? false, now: () => NOW, makeId: options.makeId,
    supportsPaperOrganization: options.organization, binding: options.binding,
  });
  t.after(async () => { controller.deactivate(); await store.close(); });
  return { api, factory, databaseName, store, controller };
}
function review(controller: WorkspaceController, input: LibraryArchive, selection?: readonly string[]) {
  return planLibraryImport(input, listVisibleEntities(controller.getSnapshot().workspace!.sync), selection);
}
function linkedEntities(workspace: StoredWorkspace) {
  const papers = listVisibleEntities(workspace.sync, 'paper');
  const notes = listVisibleEntities(workspace.sync, 'note');
  assert.equal(papers.length, 1); assert.equal(notes.length, 1);
  assert.equal((notes[0].data as NoteData).paperId, papers[0].entityId);
  return { paper: papers[0], note: notes[0] };
}

test('a complete paper-note import publishes and starts automatic synchronization only after COMMIT', async (t) => {
  const f = setup(t, { online: true }); await f.controller.bind('A');
  const input = archive(); const plan = review(f.controller, input);
  let committed = false; const savedCounts: number[] = [];
  const original = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    this.transaction.addEventListener('complete', () => { committed = true; });
    return original.apply(this, args);
  });
  const unsubscribe = f.controller.subscribe(() => {
    const sync = f.controller.getSnapshot().workspace!.sync;
    const rows = listVisibleEntities(sync);
    if (rows.length) { assert.equal(committed, true); savedCounts.push(rows.length); }
  });
  f.api.beforePush = () => { assert.equal(committed, true); };
  const summary = await f.controller.importLibrary(input, undefined, plan.signature);
  assert.equal(summary.selectedPapers, 1); assert.equal(summary.selectedNotes, 1);
  await f.controller.syncNow(); unsubscribe();
  assert.ok(savedCounts.length > 0); assert.ok(savedCounts.every((count) => count === 2));
  assert.deepEqual(f.api.requests.flatMap((request) => request.operations.map((op) => op.entityType)), ['paper', 'note']);
  const stored = (await f.store.read(scope()))!;
  linkedEntities(stored); assert.equal(stored.sync.outbox.length, 0);
});

test('invalid middle archive data or a late generated operation identity rolls back every imported item', async (t) => {
  let next = 100; let failAt = Number.POSITIVE_INFINITY;
  const f = setup(t, { makeId: () => ++next === failAt ? 'invalid-id' : id(next) });
  await f.controller.bind('A');
  const input = archive(); input.notes.push({ ref: 'n2', paperRef: null, title: 'Another', body: 'Another body', format: 'markdown' });
  const plan = review(f.controller, input); const before = canonicalJson(await f.store.read(scope()));
  const invalid = structuredClone(input); (invalid.notes[0] as unknown as { title: number }).title = 5;
  await assert.rejects(f.controller.importLibrary(invalid, undefined, plan.signature), { code: 'IMPORT_INVALID' });
  assert.equal(next, 100);
  // Three entity IDs are allocated first. Reject the second operation identity
  // after another valid operation has already been examined in the batch.
  failAt = 105;
  await assert.rejects(f.controller.importLibrary(input, undefined, plan.signature), { code: 'IMPORT_INVALID' });
  assert.equal(canonicalJson(await f.store.read(scope())), before);
  assert.equal(f.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.equal(f.api.requests.length, 0);
});

test('an actual IndexedDB transaction abort saves nothing and allows the same reviewed import to be retried once', async (t) => {
  const f = setup(t); await f.controller.bind('A');
  const input = archive(); const plan = review(f.controller, input);
  const before = canonicalJson(await f.store.read(scope()));
  const original = IDBObjectStore.prototype.put; let abortNext = true;
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    const request = original.apply(this, args);
    if (abortNext) { abortNext = false; this.transaction.abort(); }
    return request;
  });
  await assert.rejects(f.controller.importLibrary(input, undefined, plan.signature), { code: 'STORAGE_FAILED' });
  assert.equal(canonicalJson(await f.store.read(scope())), before);
  assert.equal(f.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.equal(f.api.requests.length, 0);
  await f.controller.importLibrary(input, undefined, plan.signature);
  const stored = (await f.store.read(scope()))!; linkedEntities(stored);
  assert.equal(f.controller.getSnapshot().error, null);
  await assert.rejects(f.controller.importLibrary(input, undefined, plan.signature), { code: 'IMPORT_CHANGED' });
  assert.deepEqual(await f.store.read(scope()), stored);
});

test('the commit re-plans against the latest stored library and rejects a duplicate that arrived after preview', async (t) => {
  const f = setup(t); await f.controller.bind('A');
  const input = archive(); const plan = review(f.controller, input);
  const changed = await f.store.update(scope(), (value) => ({ ...value!, sync: queueLocalCreates(value!.sync,
    [{ entityType: 'paper', entityId: id(50), mutation: 'put', data: paperData() }],
    [{ opId: id(51), clientCreatedAt: NOW }],
  ) }));
  await assert.rejects(f.controller.importLibrary(input, undefined, plan.signature), { code: 'IMPORT_CHANGED' });
  assert.deepEqual(await f.store.read(scope()), changed);
  assert.equal(f.controller.getSnapshot().workspace!.sync.outbox.length, 0, 'The controller must not publish an uncommitted planned import.');
});

test('insufficient pending-operation capacity reports an import error without saving a partial batch', async (t) => {
  const f = setup(t); await f.controller.bind('A');
  const full = await f.store.update(scope(), (value) => ({ ...value!, sync: { ...value!.sync,
    outbox: Array.from({ length: SYNC_LIMITS.maxLocalOperations - 1 }, (_, index) => ({
      operation: { entityType: 'note' as const, entityId: id(index + 100), mutation: 'put' as const, baseRevision: 0, schemaVersion: 1 as const,
        data: { paperId: null, title: 'Existing unrelated note', body: String(index), format: 'markdown' as const }, opId: id(index + 100_000), clientCreatedAt: NOW },
      originDeviceId: DEVICE, status: 'queued' as const, attempts: 0, errorCode: null, conflictId: null,
    })),
  } }));
  const input = archive(); const plan = planLibraryImport(input, listVisibleEntities(full.sync));
  await assert.rejects(f.controller.importLibrary(input, undefined, plan.signature), { code: 'IMPORT_CAPACITY' });
  assert.deepEqual(await f.store.read(scope()), full);
  assert.equal(f.api.requests.length, 0);
});

test('changed selection, changed related revision, and missing note dependencies cannot bypass review', async (t) => {
  const f = setup(t); await f.controller.bind('A');
  const input = archive(); const original = review(f.controller, input);
  await assert.rejects(f.controller.importLibrary(input, ['paper:p1'], original.signature), { code: 'IMPORT_CHANGED' });
  const existing: SyncRecord<'paper'> = { entityType: 'paper', entityId: id(50), schemaVersion: 1, revision: 1, deletedAt: null, updatedAt: NOW, modifiedByDeviceId: DEVICE, data: paperData() };
  await f.store.update(scope(), (value) => ({ ...value!, sync: { ...value!.sync, serverRecords: { [entityKey('paper', existing.entityId)]: existing } } }));
  await f.controller.bind('refresh');
  const matched = review(f.controller, input);
  assert.equal(matched.summary.selectedPapers, 0); assert.equal(matched.summary.selectedNotes, 1);
  const changed = await f.store.update(scope(), (value) => ({ ...value!, sync: { ...value!.sync, serverRecords: { [entityKey('paper', existing.entityId)]: { ...existing, revision: 2 } } } }));
  await assert.rejects(f.controller.importLibrary(input, undefined, matched.signature), { code: 'IMPORT_CHANGED' });
  assert.deepEqual(await f.store.read(scope()), changed);
  await f.controller.bind('refresh after update');
  const beforeBlocked = await f.store.read(scope());
  const missing = archive(); missing.notes[0].paperRef = 'p999';
  const blocked = review(f.controller, missing, ['note:n1']);
  await assert.rejects(f.controller.importLibrary(missing, ['note:n1'], blocked.signature), { code: 'IMPORT_INVALID' });
  assert.deepEqual(await f.store.read(scope()), beforeBlocked);
});

test('concurrent confirmations of an explicit copy create exactly one batch', async (t) => {
  const f = setup(t); await f.controller.bind('A');
  const input = archive(); const first = review(f.controller, input);
  await f.controller.importLibrary(input, undefined, first.signature);
  const selection = ['paper:p1', 'note:n1']; const copy = review(f.controller, input, selection);
  const results = await Promise.allSettled([
    f.controller.importLibrary(input, selection, copy.signature),
    f.controller.importLibrary(input, selection, copy.signature),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'IMPORT_CHANGED');
  const stored = (await f.store.read(scope()))!;
  assert.equal(stored.sync.outbox.length, 4);
  const papers = listVisibleEntities(stored.sync, 'paper'); const notes = listVisibleEntities(stored.sync, 'note');
  assert.equal(papers.length, 2); assert.equal(notes.length, 2);
  assert.equal(new Set(notes.map((row) => (row.data as NoteData).paperId)).size, 2);
});

test('organization is preserved when supported and a known old API remains blocked after going offline', async (t) => {
  const f = setup(t, { organization: () => false, online: true }); await f.controller.bind('old API');
  await f.store.update(scope(), (value) => ({ ...value!, paperOrganizationVersion: 1 }));
  const input = withOrganization(); const plan = review(f.controller, input);
  const before = canonicalJson(await f.store.read(scope()));
  await assert.rejects(f.controller.importLibrary(input, undefined, plan.signature), { code: 'IMPORT_UNSUPPORTED' });
  f.controller.setOnline(false);
  await assert.rejects(f.controller.importLibrary(input, undefined, plan.signature), { code: 'IMPORT_UNSUPPORTED' });
  assert.equal(canonicalJson(await f.store.read(scope())), before);
  const supported = setup(t, { organization: () => true }); await supported.controller.bind('new API');
  await supported.controller.importLibrary(input, undefined, review(supported.controller, input).signature);
  const saved = linkedEntities((await supported.store.read(scope()))!);
  assert.deepEqual((saved.paper.data as PaperData).organization, input.papers[0].data.organization);
});

test('offline binding accepts organization only from previously confirmed local capability', async (t) => {
  for (const supportedBefore of [false, true]) {
    const first = setup(t, { organization: () => supportedBefore }); await first.controller.bind('seed');
    first.controller.deactivate(); await first.store.close();
    const restored = setup(t, { factory: first.factory, databaseName: first.databaseName, binding: { read: async () => identity() } });
    await restored.controller.bind('offline');
    assert.equal(restored.controller.getSnapshot().needsLogin, true);
    const input = withOrganization(); const signature = review(restored.controller, input).signature;
    if (supportedBefore) {
      await restored.controller.importLibrary(input, undefined, signature);
      const saved = linkedEntities((await restored.store.read(scope()))!);
      assert.deepEqual((saved.paper.data as PaperData).organization, input.papers[0].data.organization);
    } else await assert.rejects(restored.controller.importLibrary(input, undefined, signature), { code: 'IMPORT_UNSUPPORTED' });
    assert.equal(restored.api.requests.length, 0);
  }
});

test('offline reopen retains IDs, links, and outbox identities; a lost acknowledgement replays without duplicate creation', async (t) => {
  const first = setup(t); await first.controller.bind('seed');
  const input = archive(); const reviewed = review(first.controller, input).signature;
  await first.controller.importLibrary(input, undefined, reviewed);
  const original = (await first.store.read(scope()))!; linkedEntities(original);
  first.controller.deactivate(); await first.store.close();
  const restored = setup(t, { factory: first.factory, databaseName: first.databaseName, api: first.api, binding: { read: async () => identity() } });
  await restored.controller.bind('offline');
  const local = (await restored.store.read(scope()))!; linkedEntities(local);
  assert.deepEqual(local.sync.outbox.map((entry) => entry.operation), original.sync.outbox.map((entry) => entry.operation));
  await assert.rejects(restored.controller.importLibrary(input, undefined, reviewed), { code: 'IMPORT_CHANGED' });
  restored.controller.setOnline(true); await restored.controller.bind('reconnect', true);
  restored.api.failAckOnce = true; await restored.controller.syncNow();
  assert.equal(restored.api.records.length, 1);
  assert.equal(restored.controller.getSnapshot().workspace!.sync.outbox[0].status, 'uncertain');
  await restored.controller.syncNow();
  assert.equal(restored.api.records.length, 2);
  assert.equal(restored.api.requests[0].operations[0].opId, restored.api.requests[1].operations[0].opId);
  const synced = (await restored.store.read(scope()))!; linkedEntities(synced); assert.equal(synced.sync.outbox.length, 0);
});

test('a late import cannot write after account switching, or overwrite the newly bound account snapshot', async (t) => {
  let binding = 'api-a:subject-a'; let gate: ReturnType<typeof deferred> | undefined;
  const entered = deferred();
  const f = setup(t, { binding: { key: () => binding }, wrap: (base) => ({
    read: (key) => base.read(key), remove: (key) => base.remove(key), close: () => base.close(),
    update: async (key, reducer, guard) => { const pending = gate; if (pending) { entered.resolve(); await pending.promise; } return base.update(key, reducer, guard); },
  }) });
  await f.controller.bind('A'); const input = archive(); const signature = review(f.controller, input).signature;
  const previous = (await f.store.read(scope()))!;
  const pendingGate = deferred(); gate = pendingGate;
  const pending = f.controller.importLibrary(input, undefined, signature); await entered.promise;
  gate = undefined; f.controller.deactivate(); binding = 'api-a:subject-b'; f.api.account = B;
  await f.controller.bind('B'); pendingGate.resolve();
  await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
  assert.deepEqual(await f.store.read(scope(A)), previous);
  assert.equal((await f.store.read(scope(B)))!.sync.outbox.length, 0);
  assert.equal(f.controller.getSnapshot().identity!.accountId, B);
  assert.equal(f.controller.getSnapshot().error, null);
});

test('API or subject binding changes and device/generation changes reject queued imports before persistence', async (t) => {
  for (const change of ['api', 'subject', 'device', 'generation'] as const) {
    let binding = 'api-a:subject-a'; const entered = deferred(); const release = deferred(); let pause = false;
    const f = setup(t, { binding: { key: () => binding }, wrap: (base) => ({
      read: (key) => base.read(key), remove: (key) => base.remove(key), close: () => base.close(),
      update: async (key, reducer, guard) => { if (pause) { entered.resolve(); await release.promise; } return base.update(key, reducer, guard); },
    }) });
    await f.controller.bind('A'); const input = archive(); const signature = review(f.controller, input).signature;
    pause = true; const pending = f.controller.importLibrary(input, undefined, signature); await entered.promise;
    if (change === 'api') binding = 'api-b:subject-a';
    if (change === 'subject') binding = 'api-a:subject-b';
    if (change === 'device' || change === 'generation')
      await f.store.update(scope(), (value) => ({ ...value!, sync: change === 'device' ? rebindDevice(value!.sync, id(55)) : resumeAfterRestart(value!.sync) }));
    const before = await f.store.read(scope()); release.resolve();
    await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
    assert.deepEqual(await f.store.read(scope()), before);
    assert.equal(f.api.requests.length, 0);
  }
});
