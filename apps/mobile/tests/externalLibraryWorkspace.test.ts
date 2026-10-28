import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  canonicalJson, createAccountState, entityKey, listVisibleEntities, queueLocalEdit,
  type PaperData, type PushRequest, type PushResult, type SyncRecord,
} from '../../../packages/sync-core/src/index.ts';
import type { AccountIdentity } from '../src/api.ts';
import { planExternalLibraryImport, type ExternalLibraryDecision, type ExternalLibrarySnapshot } from '../src/library/externalLibrary.ts';
import { AccountStore, type AccountStorage } from '../src/storage/accountStore.ts';
import { AccountSqliteDatabase, SqliteAccountStore, type AccountSqliteDriver } from '../src/storage/sqliteAccountStore.ts';
import { decodeWorkspace, externalLibraryEntities, WorkspaceController, type StoredWorkspace } from '../src/sync/workspace.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const A = id(1), B = id(2), DEVICE = id(3), NOW = '2026-10-28T04:00:00.000Z';
const scope = (accountId = A) => ({ apiBaseUrl: 'https://sync.example.test', accountId });
const identity = (accountId = A): AccountIdentity => ({ accountId,
  device: { id: DEVICE, name: 'External library test', platform: 'web', createdAt: NOW, lastSeenAt: NOW, revokedAt: null } });
const paper = (title = 'Source title', doi = '10.1234/external'): PaperData => ({ title, doi, authors: ['Author'],
  year: '2026', publication: 'Source journal', abstractText: 'Source abstract', keywords: ['research'] });
function snapshot(version = 1): ExternalLibrarySnapshot {
  return { format: 'paperquay-external-library', version: 1, source: { kind: 'external', key: 'research', name: '研究来源' },
    items: [{ key: 'item-one', version, data: paper() }] };
}
class Api {
  account = A; records: SyncRecord[] = []; requests: PushRequest[] = []; beforePush?: () => void; rejectWrites = false;
  async register() { return identity(this.account); }
  async devices() { return [identity(this.account).device]; }
  async conflicts() { return { conflicts: [], nextCursor: 'done', hasMore: false }; }
  async revokeDevice() {}
  async resolveConflict(): Promise<never> { throw new Error('Unexpected resolution'); }
  async pull(cursor: string | null) { return { protocolVersion: 1 as const, records: this.records.slice(Number(cursor ?? 0)), nextCursor: String(this.records.length), hasMore: false }; }
  async push(request: PushRequest) {
    this.beforePush?.(); this.requests.push(structuredClone(request));
    const results = request.operations.map((op): PushResult => {
      if (this.rejectWrites) return { opId: op.opId, status: 'rejected', replayed: false, code: 'ACCOUNT_STORAGE_LIMIT', retryable: false };
      const previous = this.records.slice().reverse().find((entry) => entry.entityType === op.entityType && entry.entityId === op.entityId);
      assert.equal(op.baseRevision, previous?.revision ?? 0);
      const record = { entityType: op.entityType, entityId: op.entityId, schemaVersion: 1, revision: op.baseRevision + 1,
        deletedAt: op.mutation === 'delete' ? NOW : null, updatedAt: NOW, modifiedByDeviceId: DEVICE, data: op.data } as SyncRecord;
      this.records.push(record); return { opId: op.opId, status: 'applied', replayed: false, record };
    });
    return { protocolVersion: 1 as const, results };
  }
}
function setup(t: TestContext, options: { makeId?: () => string; store?: AccountStorage<StoredWorkspace>; factory?: IDBFactory; name?: string; api?: Api } = {}) {
  const api = options.api ?? new Api(); const factory = options.factory ?? new IDBFactory(); const name = options.name ?? crypto.randomUUID();
  const store = options.store ?? new AccountStore({ decode: decodeWorkspace, indexedDB: factory, databaseName: name });
  const controller = new WorkspaceController({ api, apiBaseUrl: scope().apiBaseUrl, store, online: false,
    supportsPaperOrganization: () => true, now: () => NOW, makeId: options.makeId });
  t.after(async () => { controller.deactivate(); await store.close().catch(() => undefined); });
  return { api, factory, name, store, controller };
}
function review(controller: WorkspaceController, input: ExternalLibrarySnapshot, decisions?: readonly ExternalLibraryDecision[]) {
  const value = controller.getSnapshot().workspace!;
  return planExternalLibraryImport(input, value.externalLibraries, externalLibraryEntities(value), decisions);
}
function reviewScope(controller: WorkspaceController) {
  const sync = controller.getSnapshot().workspace!.sync;
  return JSON.stringify([sync.accountId, sync.deviceId, sync.generation]);
}
async function importSnapshot(f: ReturnType<typeof setup>, input = snapshot(), decisions?: readonly ExternalLibraryDecision[]) {
  const plan = review(f.controller, input, decisions);
  return f.controller.importExternalLibrary(input, decisions, plan.signature, reviewScope(f.controller));
}
async function synchronize(f: ReturnType<typeof setup>) {
  f.controller.setOnline(true); await f.controller.syncNow(); f.controller.setOnline(false);
  assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.controller.getSnapshot().workspace!.sync.outbox.length, 0);
}
function mappedId(value: StoredWorkspace) { return value.externalLibraries!.sources[0].mappings[0].paperId; }
function localPaper(value: StoredWorkspace, paperId = mappedId(value)) { return listVisibleEntities(value.sync, 'paper').find((entry) => entry.entityId === paperId)!; }

test('source mapping, paper and outbox commit together; only normal paper data travels over sync', async (t) => {
  const f = setup(t); await f.controller.bind('A');
  let committed = false;
  const original = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    this.transaction.addEventListener('complete', () => { committed = true; }); return original.apply(this, args);
  });
  const unsubscribe = f.controller.subscribe(() => {
    if (f.controller.getSnapshot().workspace?.externalLibraries) assert.equal(committed, true);
  });
  await importSnapshot(f); unsubscribe();
  const stored = (await f.store.read(scope()))!;
  assert.equal(stored.externalLibraries!.sources[0].mappings.length, 1);
  assert.equal(stored.sync.outbox[0].operation.entityId, mappedId(stored));
  f.api.beforePush = () => assert.equal(committed, true);
  await synchronize(f);
  assert.deepEqual(f.api.requests[0].operations[0].data, paper());
  assert.equal(JSON.stringify(f.api.requests).includes('externalLibraries'), false);
  assert.equal(JSON.stringify(f.api.requests).includes('item-one'), false);
});

test('repeat snapshot survives IndexedDB reopening with the same paper ID and no duplicate operation', async (t) => {
  const f = setup(t); await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const before = (await f.store.read(scope()))!; f.controller.deactivate(); await f.store.close();
  const reopened = setup(t, { factory: f.factory, name: f.name, api: f.api }); await reopened.controller.bind('A re-open');
  const summary = await importSnapshot(reopened);
  const stored = (await reopened.store.read(scope()))!;
  assert.equal(summary.unchanged, 1); assert.equal(summary.plannedWrites, 0);
  assert.equal(mappedId(stored), mappedId(before)); assert.equal(stored.sync.outbox.length, 0);
  assert.equal(listVisibleEntities(stored.sync, 'paper').length, 1);
});

test('three-way update retains local-only fields and organization while applying source-only changes', async (t) => {
  const f = setup(t); await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const paperId = mappedId(f.controller.getSnapshot().workspace!);
  const organization = { favorite: true, readingStatus: 'reading' as const, tags: ['my tag'], collections: ['my collection'], queueRank: 1 };
  await f.controller.save({ entityType: 'paper', entityId: paperId, mutation: 'put', data: { ...paper(), title: 'My title', organization } });
  await synchronize(f);
  const next = snapshot(2); next.items[0].data.abstractText = 'Source changed abstract';
  next.items.push({ key: 'item-two', version: 1, data: paper('Second source', '10.1234/second') });
  await importSnapshot(f, next);
  const stored = (await f.store.read(scope()))!;
  assert.deepEqual(localPaper(stored).data, { ...paper(), title: 'My title', abstractText: 'Source changed abstract', organization });
  assert.equal(stored.sync.outbox.length, 2); assert.deepEqual(stored.sync.outbox.map((entry) => entry.operation.baseRevision), [2, 0]);
  assert.equal(stored.externalLibraries!.sources[0].mappings.length, 2);
  await synchronize(f);
});

test('a field conflict requires an explicit decision, advances source baseline and never overwrites classification', async (t) => {
  const f = setup(t); await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const paperId = mappedId(f.controller.getSnapshot().workspace!);
  await f.controller.save({ entityType: 'paper', entityId: paperId, mutation: 'put', data: { ...paper(), title: 'My title' } });
  await synchronize(f);
  const next = snapshot(2); next.items[0].data.title = 'New source title';
  const blocked = review(f.controller, next); assert.equal(blocked.rows[0].blockedReason, 'FIELD_CONFLICT');
  await assert.rejects(f.controller.importExternalLibrary(next, undefined, blocked.signature, reviewScope(f.controller)), { code: 'IMPORT_INVALID' });
  await importSnapshot(f, next, [{ itemKey: 'item-one', action: 'import', resolution: 'prefer-local' }]);
  const stored = (await f.store.read(scope()))!;
  assert.equal((localPaper(stored).data as PaperData).title, 'My title'); assert.equal(stored.sync.outbox.length, 0);
  assert.equal(stored.externalLibraries!.sources[0].mappings[0].baseline.title, 'New source title');
  assert.equal(review(f.controller, next).rows[0].action, 'unchanged');
});

test('late operation identity failure rolls back mixed updates, creates and every mapping', async (t) => {
  let serial = 100; let failAt = Infinity;
  const f = setup(t, { makeId: () => ++serial === failAt ? 'invalid' : id(serial) });
  await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const next = snapshot(2); next.items[0].data.title = 'Updated source';
  next.items.push({ key: 'item-two', version: 1, data: paper('New', '10.1234/new') });
  const before = canonicalJson(await f.store.read(scope()));
  failAt = serial + 3; // New paper ID, update operation ID, then invalid create operation ID.
  const plan = review(f.controller, next);
  await assert.rejects(f.controller.importExternalLibrary(next, undefined, plan.signature, reviewScope(f.controller)), { code: 'IMPORT_INVALID' });
  assert.equal(canonicalJson(await f.store.read(scope())), before);
});

test('an actual IndexedDB abort leaves mappings and papers unchanged and the same preview can retry', async (t) => {
  const f = setup(t); await f.controller.bind('A');
  const input = snapshot(); const plan = review(f.controller, input); const before = canonicalJson(await f.store.read(scope()));
  const original = IDBObjectStore.prototype.put; let abortNext = true;
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    const request = original.apply(this, args); if (abortNext) { abortNext = false; this.transaction.abort(); } return request;
  });
  await assert.rejects(f.controller.importExternalLibrary(input, undefined, plan.signature, reviewScope(f.controller)), { code: 'STORAGE_FAILED' });
  assert.equal(canonicalJson(await f.store.read(scope())), before); assert.equal(f.api.requests.length, 0);
  await f.controller.importExternalLibrary(input, undefined, plan.signature, reviewScope(f.controller));
  assert.equal(f.controller.getSnapshot().error, null); assert.equal(listVisibleEntities((await f.store.read(scope()))!.sync).length, 1);
});

test('concurrent confirmation creates the batch once and refreshes the second stale preview', async (t) => {
  const f = setup(t); await f.controller.bind('A'); const input = snapshot(); const plan = review(f.controller, input);
  const results = await Promise.allSettled([1, 2].map(() => f.controller.importExternalLibrary(input, undefined, plan.signature, reviewScope(f.controller))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'IMPORT_CHANGED');
  const stored = (await f.store.read(scope()))!;
  assert.equal(listVisibleEntities(stored.sync).length, 1); assert.equal(stored.sync.outbox.length, 1);
  assert.deepEqual(f.controller.getSnapshot().workspace, stored);
});

test('transaction detects a same-revision local edit from another tab and refreshes the visible preview', async (t) => {
  const f = setup(t); await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const next = snapshot(2); next.items[0].data.abstractText = 'New source abstract'; const plan = review(f.controller, next);
  const paperId = mappedId(f.controller.getSnapshot().workspace!);
  const changed = await f.store.update(scope(), (value) => ({ ...value!, sync: queueLocalEdit(value!.sync,
    { entityType: 'paper', entityId: paperId, mutation: 'put', data: { ...paper(), title: 'Other tab' } }, { opId: id(400), clientCreatedAt: NOW }) }));
  await assert.rejects(f.controller.importExternalLibrary(next, undefined, plan.signature, reviewScope(f.controller)), { code: 'IMPORT_CHANGED' });
  assert.deepEqual(await f.store.read(scope()), changed);
  assert.equal(review(f.controller, next).rows[0].blockedReason, 'TARGET_PENDING');
});

test('preview binds selection and source version even when the resulting paper data is unchanged', async (t) => {
  const f = setup(t); await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const input = snapshot(2); const plan = review(f.controller, input);
  await assert.rejects(f.controller.importExternalLibrary(input, [{ itemKey: 'item-one', action: 'skip' }], plan.signature, reviewScope(f.controller)), { code: 'IMPORT_CHANGED' });
  await assert.rejects(f.controller.importExternalLibrary(snapshot(3), undefined, plan.signature, reviewScope(f.controller)), { code: 'IMPORT_CHANGED' });
  assert.equal((await f.store.read(scope()))!.externalLibraries!.sources[0].mappings[0].itemVersion, 1);
});

test('retained conflicts and in-flight resolutions block mapping-only adoption as well as paper writes', async (t) => {
  const f = setup(t); await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const stored = (await f.store.read(scope()))!; const paperId = mappedId(stored); const record = stored.sync.serverRecords[entityKey('paper', paperId)];
  const attempted = { entityType: 'paper' as const, entityId: paperId, schemaVersion: 1 as const, mutation: 'put' as const,
    opId: id(400), baseRevision: record.revision, clientCreatedAt: NOW, data: paper() };
  await f.store.update(scope(), (value) => ({ ...value!, sync: { ...value!.sync, conflicts: { [id(401)]: { conflictId: id(401), attempted, current: record } } } }));
  await f.controller.bind('reload conflict');
  const blocked = review(f.controller, snapshot(2)); assert.equal(blocked.rows[0].blockedReason, 'TARGET_PENDING');
  await assert.rejects(f.controller.importExternalLibrary(snapshot(2), undefined, blocked.signature, reviewScope(f.controller)), { code: 'IMPORT_INVALID' });
  await f.store.update(scope(), (value) => ({ ...value!, sync: { ...value!.sync, conflicts: {} }, pendingResolutions: {
    [id(401)]: { entityType: 'paper', entityId: paperId, request: { opId: id(402), expectedRevision: record.revision, choice: 'current' } },
  } }));
  await f.controller.bind('reload resolution');
  assert.equal(review(f.controller, snapshot(2)).rows[0].blockedReason, 'TARGET_PENDING');
});

test('a deleted mapped paper remains deleted; omitting its source item does not remove other mappings', async (t) => {
  const f = setup(t); await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const paperId = mappedId(f.controller.getSnapshot().workspace!);
  await f.controller.save({ entityType: 'paper', entityId: paperId, mutation: 'delete', data: null }); await synchronize(f);
  const blocked = review(f.controller, snapshot(2)); assert.equal(blocked.rows[0].blockedReason, 'TARGET_DELETED');
  await assert.rejects(f.controller.importExternalLibrary(snapshot(2), undefined, blocked.signature, reviewScope(f.controller)), { code: 'IMPORT_INVALID' });
  const input = snapshot(); input.items = [{ key: 'other', version: 1, data: paper('Other', '10.1234/other') }];
  await importSnapshot(f, input); const stored = (await f.store.read(scope()))!;
  assert.equal(localPaper(stored, paperId).deleted, true); assert.equal(stored.externalLibraries!.sources[0].mappings.length, 2);
});

test('server rejection preserves the imported source baseline and pending payload and blocks the next source version', async (t) => {
  const f = setup(t); await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const next = snapshot(2); next.items[0].data.title = 'Source version two';
  await importSnapshot(f, next); f.api.rejectWrites = true;
  f.controller.setOnline(true); await f.controller.syncNow(); f.controller.setOnline(false);
  const stored = (await f.store.read(scope()))!;
  assert.equal(stored.externalLibraries!.sources[0].mappings[0].itemVersion, 2);
  assert.equal(stored.sync.outbox.length, 1); assert.equal(stored.sync.outbox[0].status, 'rejected');
  assert.deepEqual(stored.sync.outbox[0].operation.data, next.items[0].data);
  const third = snapshot(3); third.items[0].data.title = 'Source version three';
  const plan = review(f.controller, third); assert.equal(plan.rows[0].blockedReason, 'TARGET_PENDING');
  await assert.rejects(f.controller.importExternalLibrary(third, undefined, plan.signature, reviewScope(f.controller)), { code: 'IMPORT_INVALID' });
  assert.deepEqual(await f.store.read(scope()), stored);
});

test('account switch invalidates an already reviewed snapshot and isolates mapping registries', async (t) => {
  const f = setup(t); await f.controller.bind('A'); const input = snapshot(); const old = review(f.controller, input); const oldScope = reviewScope(f.controller);
  await importSnapshot(f); f.api.account = B; await f.controller.bind('B');
  assert.equal(f.controller.getSnapshot().workspace!.externalLibraries, undefined);
  assert.equal(f.controller.getSnapshot().identity!.accountId, B);
  await assert.rejects(f.controller.importExternalLibrary(input, undefined, old.signature, oldScope), { code: 'ACCOUNT_CHANGED' });
  assert.equal(f.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  await importSnapshot(f, input);
  assert.notEqual(mappedId((await f.store.read(scope(A)))!), mappedId((await f.store.read(scope(B)))!));
});

test('clearing this device drops its mapping registry without sending deletes to the server', async (t) => {
  const f = setup(t); await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const requests = f.api.requests.length; await f.controller.clearLocalData();
  const stored = (await f.store.read(scope()))!;
  assert.equal(stored.externalLibraries, undefined); assert.equal(f.api.requests.length, requests);
});

test('old workspace snapshots remain readable and unknown/corrupt registry fields are rejected', () => {
  const old: StoredWorkspace = { sync: createAccountState(A, DEVICE), pendingResolutions: {} };
  assert.equal(decodeWorkspace(old), old); assert.ok(decodeWorkspace({ ...old, paperOrganizationVersion: 1 }));
  assert.throws(() => decodeWorkspace({ ...old, unexpected: true }), { code: 'STORAGE_CORRUPT' });
  assert.throws(() => decodeWorkspace({ ...old, externalLibraries: { version: 2, sources: [] } }), { code: 'STORAGE_CORRUPT' });
  assert.throws(() => decodeWorkspace({ ...old, externalLibraries: { version: 1, sources: [], token: 'sentinel' } }), { code: 'STORAGE_CORRUPT' });
});

class Driver implements AccountSqliteDriver {
  readonly db: DatabaseSync; failCommit = false;
  constructor(path: string) { this.db = new DatabaseSync(path); }
  async execute(sql: string) { this.db.exec(sql); }
  async query(sql: string, values: string[]) { return this.db.prepare(sql).all(...values) as Record<string, unknown>[]; }
  async run(sql: string, values: string[]) { this.db.prepare(sql).run(...values); }
  async begin() { this.db.exec('BEGIN IMMEDIATE'); }
  async commit() { if (this.failCommit) throw new Error('synthetic disk full'); this.db.exec('COMMIT'); }
  async rollback() { this.db.exec('ROLLBACK'); }
  async close() { this.db.close(); }
}
test('real SQLite reopens mapping and outbox atomically and preserves both on a failed mixed update', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'paperquay-external-sqlite-')); const path = join(directory, 'accounts.sqlite');
  const databases: AccountSqliteDatabase[] = [];
  const open = () => {
    const driver = new Driver(path); const database = new AccountSqliteDatabase(driver); databases.push(database);
    return { driver, database, store: new SqliteAccountStore({ database, decode: decodeWorkspace }) };
  };
  t.after(async () => {
    for (const database of databases) await database.close().catch(() => undefined);
    for (const suffix of ['', '-wal', '-shm']) await unlink(path + suffix).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  });
  const first = open(); const f = setup(t, { store: first.store }); await f.controller.bind('A'); await importSnapshot(f); await synchronize(f);
  const before = canonicalJson(await first.store.read(scope()));
  const next = snapshot(2); next.items[0].data.title = 'Changed source';
  next.items.push({ key: 'new-item', version: 1, data: paper('Second', '10.1234/second') });
  first.driver.failCommit = true;
  const plan = review(f.controller, next);
  await assert.rejects(f.controller.importExternalLibrary(next, undefined, plan.signature, reviewScope(f.controller)), { code: 'STORAGE_FAILED' });
  assert.equal(canonicalJson(await first.store.read(scope())), before);
  first.driver.failCommit = false; f.controller.deactivate(); await first.store.close(); await first.database.close();
  const second = open(); const reopened = setup(t, { store: second.store, api: f.api }); await reopened.controller.bind('reopened');
  assert.equal(mappedId(reopened.controller.getSnapshot().workspace!), mappedId(JSON.parse(before)));
  await importSnapshot(reopened, next);
  assert.equal((await second.store.read(scope()))!.sync.outbox.length, 2);
  assert.equal((await second.store.read(scope()))!.externalLibraries!.sources[0].mappings.length, 2);
});
