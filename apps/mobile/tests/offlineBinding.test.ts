import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { getVisibleEntity, type NoteData, type PushRequest, type PushResult, type SyncRecord } from '../../../packages/sync-core/src/index.ts';
import { SyncApi, type AccountIdentity } from '../src/api.ts';
import type { AuthSubject } from '../src/auth/oidc.ts';
import { parseAppConfig } from '../src/config.ts';
import { ClientError } from '../src/errors.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';
import { AccountStore, type AccountStorage } from '../src/storage/accountStore.ts';
import { verifiedBinding } from '../src/storage/verifiedBinding.ts';
import { decodeWorkspace, WorkspaceController, type StoredWorkspace } from '../src/sync/workspace.ts';

const config = parseAppConfig({ apiBaseUrl: 'https://sync.example.test', oidcAuthority: 'https://id.example.test/realms/paperquay', oidcClientId: 'paperquay-mobile' }, 'https://app.example.test');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOW = '2026-10-25T12:00:00.000Z';
const scope = (accountId = A) => ({ apiBaseUrl: config.apiBaseUrl, accountId });
const identity = (accountId = A): AccountIdentity => ({ accountId, device: { id: DEVICE, name: 'Saved device', platform: 'ios', createdAt: NOW, lastSeenAt: NOW, revokedAt: null } });
const edit = (body: string) => ({ entityType: 'note' as const, entityId: NOTE, mutation: 'put' as const, data: { title: 'Local note', body, paperId: null, format: 'markdown' } satisfies NoteData });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
class Api {
  account = A;
  requests: string[] = [];
  pushed: PushRequest[] = [];
  records: SyncRecord[] = [];
  failure?: ClientError;
  registerGate?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  async register(): Promise<AccountIdentity> {
    this.requests.push('register');
    if (this.failure) throw this.failure;
    const result = identity(this.account);
    if (this.registerGate) { this.registerGate.entered.resolve(); await this.registerGate.release.promise; }
    return result;
  }
  async push(request: PushRequest) {
    this.requests.push('push'); this.pushed.push(structuredClone(request));
    const results = request.operations.map((operation): PushResult => {
      const record = { entityType: operation.entityType, entityId: operation.entityId, schemaVersion: 1, revision: operation.baseRevision + 1,
        deletedAt: operation.mutation === 'delete' ? NOW : null, updatedAt: NOW, modifiedByDeviceId: request.deviceId, data: operation.data } as SyncRecord;
      this.records.push(record);
      return { opId: operation.opId, status: 'applied', replayed: false, record };
    });
    return { protocolVersion: 1 as const, results };
  }
  async pull(cursor: string | null) { this.requests.push('pull'); return { protocolVersion: 1 as const, records: this.records.slice(Number(cursor ?? 0)), nextCursor: String(this.records.length), hasMore: false }; }
  async conflicts() { this.requests.push('conflicts'); return { conflicts: [], nextCursor: 'done', hasMore: false }; }
  async devices() { this.requests.push('devices'); return [identity(this.account).device]; }
  async resolveConflict(): Promise<never> { throw new Error('Unexpected conflict'); }
  async revokeDevice(): Promise<void> {}
}
function fixture(t: TestContext) {
  const api = new Api(); const secrets = new MemorySecretStore(); const factory = new IDBFactory(); const databaseName = crypto.randomUUID();
  let subject: AuthSubject | null = { issuer: config.oidcAuthority, subject: 'subject-a' };
  let prepareError: ClientError | undefined;
  let writes = 0; let reads = 0;
  const stores: AccountStore<StoredWorkspace>[] = [];
  const controllers: WorkspaceController[] = [];
  const cache = verifiedBinding(config, secrets, () => subject);
  function open(online = true, wrap?: (store: AccountStore<StoredWorkspace>) => AccountStorage<StoredWorkspace>) {
    const store = new AccountStore({ decode: decodeWorkspace, indexedDB: factory, databaseName }); stores.push(store);
    const binding = { ...cache,
      prepare: async () => { api.requests.push('prepare'); if (prepareError) throw prepareError; },
      read: async () => { reads += 1; return cache.read(); },
      write: async (value: AccountIdentity) => { writes += 1; await cache.write(value); },
    };
    const controller = new WorkspaceController({ api, apiBaseUrl: config.apiBaseUrl, store: wrap?.(store) ?? store, online, now: () => NOW, binding });
    controllers.push(controller); return { controller, store };
  }
  t.after(async () => { for (const controller of controllers) controller.deactivate(); for (const store of stores) await store.close(); });
  return { api, secrets, cache, open,
    get writes() { return writes; }, get reads() { return reads; },
    set subject(value: AuthSubject | null) { subject = value; },
    set prepareError(value: ClientError | undefined) { prepareError = value; },
  };
}
function body(controller: WorkspaceController): string | undefined {
  const sync = controller.getSnapshot().workspace?.sync;
  return sync ? (getVisibleEntity(sync, 'note', NOTE)?.data as NoteData | undefined)?.body : undefined;
}
async function saveOfflineFixture(t: TestContext) {
  const f = fixture(t); const first = f.open();
  await first.controller.bind('first device');
  first.controller.setOnline(false);
  await first.controller.save(edit('last confirmed local save'));
  first.controller.deactivate(); await first.store.close();
  return f;
}

test('identity cache is written only after successful prepare/register; offline first launch cannot invent an account', async (t) => {
  const f = fixture(t);
  const offline = f.open(false); await offline.controller.bind('offline');
  assert.equal(offline.controller.getSnapshot().status, 'error');
  assert.equal(offline.controller.getSnapshot().identity, null); assert.equal(f.writes, 0); assert.deepEqual(f.api.requests, []);
  f.api.failure = new ClientError('NETWORK_UNAVAILABLE', true);
  const failed = f.open(); await failed.controller.bind('failed');
  assert.equal(f.writes, 0); assert.equal(await f.cache.read(), null);
  f.api.failure = undefined; const online = f.open(); await online.controller.bind('online');
  assert.deepEqual(f.api.requests.slice(-2), ['prepare', 'register']);
  assert.equal(f.writes, 1); assert.deepEqual(await f.cache.read(), identity());
});

test('offline restart opens the previously confirmed account and local edits without sending any network request', async (t) => {
  const f = await saveOfflineFixture(t); f.api.requests = [];
  const restarted = f.open(false); await restarted.controller.bind('restored');
  assert.equal(restarted.controller.getSnapshot().status, 'ready');
  assert.equal(restarted.controller.getSnapshot().needsLogin, true);
  assert.equal(body(restarted.controller), 'last confirmed local save');
  await restarted.controller.save(edit('second confirmed offline save'));
  assert.equal(body(restarted.controller), 'second confirmed offline save');
  await restarted.controller.syncNow(); restarted.controller.setOnline(true); await restarted.controller.syncNow();
  assert.deepEqual(f.api.requests, []); assert.equal(f.api.pushed.length, 0);
});

test('reconnection must prepare and register the device before pending offline edits can be pushed', async (t) => {
  const f = await saveOfflineFixture(t); const restarted = f.open(false); await restarted.controller.bind('restored');
  f.api.requests = [];
  restarted.controller.setOnline(true); await restarted.controller.syncNow(); assert.equal(f.api.requests.length, 0);
  await restarted.controller.bind('reconnected', true);
  assert.deepEqual(f.api.requests, ['prepare', 'register']); assert.equal(restarted.controller.getSnapshot().needsLogin, false);
  await restarted.controller.syncNow();
  assert.ok(f.api.requests.indexOf('push') > f.api.requests.indexOf('register'));
  assert.equal(f.api.pushed.length, 1); assert.equal(restarted.controller.getSnapshot().workspace?.sync.outbox.length, 0);
  assert.equal(body(restarted.controller), 'last confirmed local save');
});

test('expired authentication permits verified local access but explicit session revocation never falls back to cache', async (t) => {
  const f = await saveOfflineFixture(t);
  f.prepareError = new ClientError('AUTH_REQUIRED');
  const expired = f.open(); await expired.controller.bind('expired');
  assert.equal(expired.controller.getSnapshot().status, 'ready'); assert.equal(expired.controller.getSnapshot().needsLogin, true);
  assert.equal(body(expired.controller), 'last confirmed local save');
  expired.controller.deactivate();
  f.prepareError = undefined; f.api.failure = new ClientError('SESSION_REVOKED'); const readBefore = f.reads;
  const revoked = f.open(); await revoked.controller.bind('revoked');
  assert.equal(revoked.controller.getSnapshot().status, 'error'); assert.equal(revoked.controller.getSnapshot().identity, null);
  assert.equal(revoked.controller.getSnapshot().error?.code, 'SESSION_REVOKED'); assert.equal(f.reads, readBefore);
  assert.equal(await f.cache.read(), null);
  assert.ok(await revoked.store.read(scope()));
});

test('cached identity alone cannot create a fresh empty account during an offline restart', async (t) => {
  const f = fixture(t); await f.cache.write(identity());
  const offline = f.open(false); await offline.controller.bind('no saved workspace');
  assert.equal(offline.controller.getSnapshot().status, 'error'); assert.equal(offline.controller.getSnapshot().error?.code, 'AUTH_REQUIRED');
  assert.equal(await offline.store.read(scope()), null);
});

test('retainCurrent preserves saved data on transient registration failure and blocks network until reverified', async (t) => {
  const f = await saveOfflineFixture(t); const restored = f.open(false); await restored.controller.bind('restored');
  restored.controller.setOnline(true); f.api.failure = new ClientError('NETWORK_UNAVAILABLE', true);
  await restored.controller.bind('retry', true);
  assert.equal(restored.controller.getSnapshot().status, 'ready'); assert.equal(restored.controller.getSnapshot().identity?.accountId, A);
  assert.equal(restored.controller.getSnapshot().needsLogin, true); assert.equal(body(restored.controller), 'last confirmed local save');
  await restored.controller.syncNow(); assert.equal(f.api.pushed.length, 0);
});

test('retained local account cannot be rebound to a different register account', async (t) => {
  const f = await saveOfflineFixture(t); const restored = f.open(false); await restored.controller.bind('restored');
  restored.controller.setOnline(true); f.api.account = B;
  await restored.controller.bind('different returned account', true);
  assert.equal(restored.controller.getSnapshot().error?.code, 'ACCOUNT_CHANGED'); assert.equal(restored.controller.getSnapshot().identity, null);
  assert.equal(await restored.store.read(scope(B)), null); assert.ok(await restored.store.read(scope(A)));
});

test('late register from subject A cannot activate or cache A after subject B appears before React deactivation', async (t) => {
  const f = fixture(t); const { controller, store } = f.open();
  const gate = { entered: deferred(), release: deferred() }; f.api.registerGate = gate;
  const binding = controller.bind('A'); await gate.entered.promise;
  f.subject = { issuer: config.oidcAuthority, subject: 'subject-b' }; f.api.account = B;
  gate.release.resolve(); await binding;
  assert.equal(controller.getSnapshot().identity, null); assert.equal(controller.getSnapshot().error?.code, 'ACCOUNT_CHANGED');
  assert.equal(f.writes, 0); assert.equal(await store.read(scope(A)), null); assert.equal(await f.cache.read(), null);
  f.api.registerGate = undefined; await controller.bind('B'); assert.equal(controller.getSnapshot().identity?.accountId, B);
});

test('auth subject change while native-style storage is pending aborts activation before any local write', async (t) => {
  const f = fixture(t); const entered = deferred(); const release = deferred();
  const { controller, store } = f.open(true, (base) => ({
    read: (key) => base.read(key), remove: (key) => base.remove(key), close: () => base.close(),
    update: async (key, reducer, guard) => { entered.resolve(); await release.promise; return base.update(key, reducer, guard); },
  }));
  const binding = controller.bind('A'); await entered.promise;
  f.subject = { issuer: config.oidcAuthority, subject: 'subject-b' }; release.resolve(); await binding;
  assert.equal(controller.getSnapshot().identity, null); assert.equal(controller.getSnapshot().error?.code, 'ACCOUNT_CHANGED');
  assert.equal(await store.read(scope(A)), null); assert.equal(f.writes, 0);
});

test('late register response cannot overwrite an already bound replacement session', async (t) => {
  const f = fixture(t); const { controller } = f.open();
  const gate = { entered: deferred(), release: deferred() }; f.api.registerGate = gate;
  const old = controller.bind('A'); await gate.entered.promise;
  controller.deactivate(); f.subject = { issuer: config.oidcAuthority, subject: 'subject-b' }; f.api.account = B; f.api.registerGate = undefined;
  await controller.bind('B'); gate.release.resolve(); await old;
  assert.equal(controller.getSnapshot().identity?.accountId, B); assert.deepEqual(await f.cache.read(), identity(B));
});

test('an active sync cannot persist subject B records into A when the token await changes subject before React cleanup', async (t) => {
  let subject = 'subject-a';
  let gateNextToken = false;
  const entered = deferred(); const release = deferred();
  const calls: { path: string; subject: string }[] = [];
  const getSubject = (): AuthSubject => ({ issuer: config.oidcAuthority, subject });
  const binding = verifiedBinding(config, new MemorySecretStore(), getSubject);
  const api = new SyncApi(config.apiBaseUrl, async () => {
    if (gateNextToken) { gateNextToken = false; entered.resolve(); await release.promise; }
    return subject;
  }, async (input, init) => {
    const path = new URL(String(input)).pathname;
    const requestSubject = new Headers(init?.headers).get('Authorization')?.slice(7) ?? '';
    calls.push({ path, subject: requestSubject });
    let response: unknown;
    if (path === '/v1/devices' && init?.method === 'POST') response = identity(requestSubject === 'subject-a' ? A : B);
    else if (path === '/v1/sync/pull') response = {
      protocolVersion: 1,
      records: requestSubject === 'subject-b' ? [{
        entityType: 'note', entityId: NOTE, schemaVersion: 1, revision: 1, deletedAt: null,
        updatedAt: NOW, modifiedByDeviceId: DEVICE, data: edit('belongs only to B').data,
      }] : [],
      nextCursor: 'after-pull', hasMore: false,
    };
    else if (path === '/v1/conflicts') response = { conflicts: [], nextCursor: 'done', hasMore: false };
    else if (path === '/v1/devices') response = { devices: [] };
    else throw new Error(`Unexpected test path ${path}`);
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, binding.key);
  const store = new AccountStore({ decode: decodeWorkspace, indexedDB: new IDBFactory(), databaseName: crypto.randomUUID() });
  const controller = new WorkspaceController({ api, apiBaseUrl: config.apiBaseUrl, store, binding });
  t.after(async () => { controller.deactivate(); await store.close(); });
  await controller.bind('A');
  gateNextToken = true;
  const syncing = controller.syncNow();
  await entered.promise;
  // The controller must protect itself during the gap before React observes auth.
  subject = 'subject-b'; release.resolve(); await syncing;
  const saved = await store.read(scope(A));
  assert.equal(saved?.sync.serverRecords[`note:${NOTE}`], undefined, 'B data must never be persisted in A');
  assert.equal(saved?.sync.cursor, null, 'A cursor must not advance from a B response');
  assert.equal(controller.getSnapshot().workspace, null, 'A workspace must become inaccessible after the subject changes');
  assert.equal(controller.getSnapshot().error?.code, 'ACCOUNT_CHANGED');
  assert.equal(calls[0]?.subject, 'subject-a');
  assert.equal(calls.some((call) => call.subject === 'subject-b'), false, 'stale requests must stop before using B credentials');
});

test('an active local save rejects a changed subject without changing the previous account data', async (t) => {
  const f = await saveOfflineFixture(t); const active = f.open(false); await active.controller.bind('A');
  const before = await active.store.read(scope(A));
  f.subject = { issuer: config.oidcAuthority, subject: 'subject-b' };
  await assert.rejects(active.controller.save(edit('late edit from replacement subject')), { code: 'ACCOUNT_CHANGED' });
  assert.deepEqual(await active.store.read(scope(A)), before);
  assert.equal(active.controller.getSnapshot().workspace, null);
});

test('an active local save checks its subject again at the storage boundary', async (t) => {
  const f = fixture(t); const entered = deferred(); const release = deferred(); let gate = false;
  const active = f.open(true, (base) => ({
    read: (key) => base.read(key), remove: (key) => base.remove(key), close: () => base.close(),
    update: async (key, reducer, guard) => {
      if (gate) { entered.resolve(); await release.promise; }
      return base.update(key, reducer, guard);
    },
  }));
  await active.controller.bind('A'); active.controller.setOnline(false);
  await active.controller.save(edit('confirmed A data'));
  const before = await active.store.read(scope(A));
  gate = true;
  const saving = active.controller.save(edit('late pending edit')).then(() => null, (error: unknown) => error);
  await entered.promise;
  f.subject = { issuer: config.oidcAuthority, subject: 'subject-b' };
  release.resolve(); const error = await saving;
  assert.ok(error instanceof ClientError); assert.equal(error.code, 'ACCOUNT_CHANGED');
  assert.deepEqual(await active.store.read(scope(A)), before);
  assert.equal(active.controller.getSnapshot().workspace, null);
});

test('clearing local data rejects a changed subject before removing the previous account copy', async (t) => {
  const f = await saveOfflineFixture(t); const active = f.open(false); await active.controller.bind('A');
  const before = await active.store.read(scope(A));
  f.subject = { issuer: config.oidcAuthority, subject: 'subject-b' };
  await assert.rejects(active.controller.clearLocalData(), { code: 'ACCOUNT_CHANGED' });
  assert.deepEqual(await active.store.read(scope(A)), before);
  assert.equal(active.controller.getSnapshot().workspace, null);
});

test('clearing local data remains atomic if the subject changes while storage is pending', async (t) => {
  const f = fixture(t); const entered = deferred(); const release = deferred(); let gate = false;
  const active = f.open(true, (base) => ({
    read: (key) => base.read(key), remove: (key) => base.remove(key), close: () => base.close(),
    update: async (key, reducer, guard) => {
      if (gate) { entered.resolve(); await release.promise; }
      return base.update(key, reducer, guard);
    },
  }));
  await active.controller.bind('A'); active.controller.setOnline(false);
  await active.controller.save(edit('confirmed data must survive a canceled clear'));
  const before = await active.store.read(scope(A));
  gate = true;
  const clearing = active.controller.clearLocalData().then(() => null, (error: unknown) => error);
  await entered.promise;
  f.subject = { issuer: config.oidcAuthority, subject: 'subject-b' };
  release.resolve(); const error = await clearing;
  assert.ok(error instanceof ClientError); assert.equal(error.code, 'ACCOUNT_CHANGED');
  assert.deepEqual(await active.store.read(scope(A)), before, 'the previous account copy must not be removed before the guarded clear commits');
  assert.equal(active.controller.getSnapshot().workspace, null);
});

test('the same verified subject can still save offline after network authorization is suspended', async (t) => {
  const f = fixture(t); const active = f.open(); await active.controller.bind('A');
  active.controller.requireLogin(new ClientError('AUTH_REQUIRED'));
  f.api.requests = [];
  await active.controller.save(edit('same subject offline edit'));
  assert.equal(body(active.controller), 'same subject offline edit');
  assert.equal(active.controller.getSnapshot().needsLogin, true);
  assert.equal(active.controller.getSnapshot().identity?.accountId, A);
  await active.controller.syncNow();
  assert.deepEqual(f.api.requests, []);
  assert.equal((await active.store.read(scope(A)))?.sync.outbox.length, 1);
});
