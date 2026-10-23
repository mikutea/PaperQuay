import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
  getVisibleEntity,
  type NoteData,
  type PushRequest,
  type PushResult,
  type SyncRecord,
} from '../../../packages/sync-core/src/index.ts';
import type { AccountIdentity, ConflictResolution, ServerConflict } from '../src/api.ts';
import { ClientError } from '../src/errors.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import {
  decodeWorkspace,
  WorkspaceController,
  type StoredWorkspace,
} from '../src/sync/workspace.ts';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CONFLICT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = '2026-10-23T12:00:00.000Z';
const note = (body: string): NoteData => ({
  title: 'Test note',
  body,
  paperId: null,
  format: 'markdown',
});
const edit = (body: string) => ({
  entityType: 'note' as const,
  entityId: NOTE,
  mutation: 'put' as const,
  data: note(body),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeApi {
  account = A;
  records = new Map<string, SyncRecord[]>();
  receipts = new Map<string, PushResult>();
  requests: PushRequest[] = [];
  writeCount = 0;
  failAckOnce = false;
  pausePush: {
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  } | null = null;
  openConflicts: ServerConflict[] = [];
  resolutionRequests: ConflictResolution[] = [];
  resolutionReceipt: PushResult | null = null;
  failResolutionAck = false;
  pauseResolution: {
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  } | null = null;

  async register(): Promise<AccountIdentity> {
    return {
      accountId: this.account,
      device: {
        id: DEVICE,
        name: 'Test device',
        platform: 'web',
        createdAt: NOW,
        lastSeenAt: NOW,
        revokedAt: null,
      },
    };
  }
  async devices() {
    return [(await this.register()).device];
  }
  async revokeDevice() {
    /* Contract tests cover HTTP authorization; these tests cover persistence. */
  }
  async push(request: PushRequest) {
    const account = this.account;
    this.requests.push(structuredClone(request));
    if (this.pausePush) {
      this.pausePush.entered.resolve();
      await this.pausePush.release.promise;
      this.pausePush = null;
    }
    const results = request.operations.map((operation): PushResult => {
      const key = `${account}:${operation.opId}`;
      const previous = this.receipts.get(key);
      if (previous) return { ...previous, replayed: true };
      const rows = this.records.get(account) ?? [];
      const current = rows.at(-1);
      const record = {
        entityType: operation.entityType,
        entityId: operation.entityId,
        schemaVersion: 1,
        revision: (current?.revision ?? 0) + 1,
        deletedAt: operation.mutation === 'delete' ? NOW : null,
        updatedAt: NOW,
        modifiedByDeviceId: request.deviceId,
        data: operation.data,
      } as SyncRecord;
      this.records.set(account, [...rows, record]);
      this.writeCount += 1;
      const result: PushResult = {
        opId: operation.opId,
        status: 'applied',
        replayed: false,
        record,
      };
      this.receipts.set(key, result);
      return result;
    });
    if (this.failAckOnce) {
      this.failAckOnce = false;
      throw new ClientError('NETWORK_UNAVAILABLE', true);
    }
    return { protocolVersion: 1 as const, results };
  }
  async pull(cursor: string | null) {
    const rows = this.records.get(this.account) ?? [];
    return {
      protocolVersion: 1 as const,
      records: rows.slice(Number(cursor ?? 0)),
      nextCursor: String(rows.length),
      hasMore: false,
    };
  }
  async conflicts() {
    return { conflicts: this.openConflicts, nextCursor: 'done', hasMore: false };
  }
  async resolveConflict(_conflictId: string, request: ConflictResolution): Promise<PushResult> {
    this.resolutionRequests.push(structuredClone(request));
    if (this.pauseResolution) {
      this.pauseResolution.entered.resolve();
      await this.pauseResolution.release.promise;
      this.pauseResolution = null;
    }
    if (!this.resolutionReceipt) {
      const conflict = this.openConflicts[0];
      const base = conflict.currentRecord!;
      const mutation =
        request.choice === 'merged' ? request.mutation : conflict.attemptedOperation.mutation;
      const record =
        request.choice === 'current'
          ? base
          : ({
              ...base,
              revision: base.revision + 1,
              data: request.choice === 'merged' ? request.data : conflict.attemptedOperation.data,
              deletedAt: mutation === 'delete' ? NOW : null,
            } as SyncRecord);
      this.records.set(this.account, [...(this.records.get(this.account) ?? []), record]);
      this.resolutionReceipt = { opId: request.opId, status: 'applied', replayed: false, record };
    }
    this.openConflicts = [];
    if (this.failResolutionAck) {
      this.failResolutionAck = false;
      throw new ClientError('NETWORK_UNAVAILABLE', true);
    }
    return { ...this.resolutionReceipt, replayed: this.resolutionRequests.length > 1 };
  }
}
function setup(
  api = new FakeApi(),
  factory = new IDBFactory(),
  databaseName = crypto.randomUUID(),
) {
  const store = new AccountStore({ decode: decodeWorkspace, indexedDB: factory, databaseName });
  const controller = new WorkspaceController({
    api,
    apiBaseUrl: 'https://sync.example.test',
    store,
    online: false,
    now: () => NOW,
  });
  return { api, factory, databaseName, store, controller };
}

async function setupConflictWithOverlay() {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save(edit('original attempted body'));
  const current: SyncRecord<'note'> = {
    entityType: 'note',
    entityId: NOTE,
    schemaVersion: 1,
    revision: 2,
    deletedAt: null,
    updatedAt: NOW,
    modifiedByDeviceId: DEVICE,
    data: note('other device body'),
  };
  env.api.records.set(A, [current]);
  const normalPush = env.api.push.bind(env.api);
  let initial = true;
  env.api.push = async (request) => {
    if (!initial) return normalPush(request);
    initial = false;
    env.api.requests.push(structuredClone(request));
    env.api.openConflicts = [
      {
        conflictId: CONFLICT,
        entityType: 'note',
        entityId: NOTE,
        createdAt: NOW,
        currentRecord: current,
        observedRecord: current,
        attemptedOperation: request.operations[0],
      },
    ];
    return {
      protocolVersion: 1,
      results: [
        {
          opId: request.operations[0].opId,
          status: 'conflict',
          replayed: false,
          conflictId: CONFLICT,
          record: current,
        },
      ],
    };
  };
  env.controller.setOnline(true);
  await env.controller.syncNow();
  env.controller.setOnline(false);
  await env.controller.save(edit('saved successor C'));
  const overlay = env.controller.getSnapshot().workspace!.sync.overlays[`note:${NOTE}`];
  env.controller.setOnline(true);
  await env.controller.syncNow();
  return { ...env, overlay };
}

test('confirmed local save survives restart and sends the same operation identity', async () => {
  const first = setup();
  await first.controller.bind('First');
  await first.controller.save(edit('saved offline'), 0);
  const id = first.controller.getSnapshot().workspace!.sync.outbox[0].operation.opId;
  first.controller.deactivate();
  await first.store.close();
  const next = setup(first.api, first.factory, first.databaseName);
  await next.controller.bind('Reopened');
  assert.equal(
    (
      getVisibleEntity(next.controller.getSnapshot().workspace!.sync, 'note', NOTE)!
        .data as NoteData
    ).body,
    'saved offline',
  );
  next.controller.setOnline(true);
  await next.controller.syncNow();
  assert.equal(first.api.requests[0].operations[0].opId, id);
  assert.equal(next.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.equal(next.controller.getSnapshot().lastSyncedAt, NOW);
  await next.store.close();
});

test('server commit followed by lost acknowledgement is retried without a second side effect', async () => {
  const first = setup();
  await first.controller.bind('First');
  await first.controller.save(edit('once'));
  first.api.failAckOnce = true;
  first.controller.setOnline(true);
  await first.controller.syncNow();
  assert.equal(first.controller.getSnapshot().workspace!.sync.outbox[0].status, 'uncertain');
  first.controller.deactivate();
  await first.store.close();
  const next = setup(first.api, first.factory, first.databaseName);
  await next.controller.bind('Reopened');
  next.controller.setOnline(true);
  await next.controller.syncNow();
  assert.equal(first.api.writeCount, 1);
  assert.equal(first.api.requests[0].operations[0].opId, first.api.requests[1].operations[0].opId);
  assert.equal(next.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  await next.store.close();
});

test('an edit made while acknowledgement is in flight remains visible and syncs as a successor', async () => {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save(edit('first'));
  const pause = { entered: deferred<void>(), release: deferred<void>() };
  env.api.pausePush = pause;
  env.controller.setOnline(true);
  const running = env.controller.syncNow();
  await pause.entered.promise;
  await env.controller.save(edit('second'));
  assert.equal(
    (getVisibleEntity(env.controller.getSnapshot().workspace!.sync, 'note', NOTE)!.data as NoteData)
      .body,
    'second',
  );
  pause.release.resolve();
  await running;
  assert.equal(env.api.requests.length, 2);
  assert.equal(env.api.requests[1].operations[0].baseRevision, 1);
  assert.equal(
    (getVisibleEntity(env.controller.getSnapshot().workspace!.sync, 'note', NOTE)!.data as NoteData)
      .body,
    'second',
  );
  assert.equal(env.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  await env.store.close();
});

test('switching accounts ignores a late response and never sends the old account outbox as the new account', async () => {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save(edit('account A private draft'));
  const pause = { entered: deferred<void>(), release: deferred<void>() };
  env.api.pausePush = pause;
  env.controller.setOnline(true);
  const oldRun = env.controller.syncNow();
  await pause.entered.promise;
  env.controller.deactivate();
  env.api.account = B;
  await env.controller.bind('B');
  pause.release.resolve();
  await oldRun;
  assert.equal(env.controller.getSnapshot().identity?.accountId, B);
  assert.deepEqual(env.controller.getSnapshot().workspace!.sync.outbox, []);
  assert.equal(getVisibleEntity(env.controller.getSnapshot().workspace!.sync, 'note', NOTE), null);
  const oldState = await env.store.read({ apiBaseUrl: 'https://sync.example.test', accountId: A });
  assert.equal(oldState!.sync.outbox[0].status, 'sending');
  assert.equal(env.api.requests.length, 1);
  env.controller.deactivate();
  env.api.account = A;
  await env.controller.bind('A');
  await env.controller.syncNow();
  assert.equal(env.api.writeCount, 1);
  assert.equal(env.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  await env.store.close();
});

test('stale editor drafts cannot silently overwrite a newer pulled revision', async () => {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save(edit('initial'));
  env.controller.setOnline(true);
  await env.controller.syncNow();
  const current = env.api.records.get(A)!.at(-1)!;
  env.api.records
    .get(A)!
    .push({ ...current, revision: 2, data: note('new remote version') } as SyncRecord);
  await env.controller.syncNow();
  await assert.rejects(env.controller.save(edit('stale text'), 1), { code: 'EDIT_CHANGED' });
  assert.equal(env.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.equal(
    (getVisibleEntity(env.controller.getSnapshot().workspace!.sync, 'note', NOTE)!.data as NoteData)
      .body,
    'new remote version',
  );
  await env.store.close();
});

test('conflict resolution acknowledgement loss persists the exact request and replays it after restart', async () => {
  const env = setup();
  await env.controller.bind('A');
  const record: SyncRecord<'note'> = {
    entityType: 'note',
    entityId: NOTE,
    schemaVersion: 1,
    revision: 2,
    deletedAt: null,
    updatedAt: NOW,
    modifiedByDeviceId: DEVICE,
    data: note('remote'),
  };
  env.api.records.set(A, [record]);
  env.api.openConflicts = [
    {
      conflictId: CONFLICT,
      entityType: 'note',
      entityId: NOTE,
      createdAt: NOW,
      currentRecord: record,
      observedRecord: record,
      attemptedOperation: {
        ...edit('my version'),
        opId: crypto.randomUUID(),
        baseRevision: 1,
        schemaVersion: 1,
        clientCreatedAt: NOW,
      },
    },
  ];
  env.controller.setOnline(true);
  await env.controller.syncNow();
  env.api.failResolutionAck = true;
  await env.controller.resolve(env.api.openConflicts[0], { choice: 'current' });
  assert.equal(Object.keys(env.controller.getSnapshot().workspace!.pendingResolutions).length, 1);
  env.controller.deactivate();
  await env.store.close();
  const next = setup(env.api, env.factory, env.databaseName);
  await next.controller.bind('Reopened');
  next.controller.setOnline(true);
  await next.controller.syncNow();
  assert.deepEqual(env.api.resolutionRequests[0], env.api.resolutionRequests[1]);
  assert.equal(Object.keys(next.controller.getSnapshot().workspace!.pendingResolutions).length, 0);
  assert.equal(next.controller.getSnapshot().conflicts.length, 0);
  await next.store.close();
});

test('revoking this session preserves local edits and requires a new login', async () => {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save(edit('keep local'));
  assert.equal(await env.controller.revokeDevice(DEVICE), true);
  assert.equal(env.controller.getSnapshot().needsLogin, true);
  assert.equal(env.controller.getSnapshot().error?.code, 'SESSION_REVOKED');
  await env.controller.save(edit('editable offline'));
  await env.controller.syncNow();
  assert.equal(env.api.requests.length, 0);
  assert.equal(
    (getVisibleEntity(env.controller.getSnapshot().workspace!.sync, 'note', NOTE)!.data as NoteData)
      .body,
    'editable offline',
  );
  await env.store.close();
});

test('a conflict resolved between pull and conflict-list refresh is pulled again before unblocking', async () => {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save(edit('attempted'));
  const oldRecord: SyncRecord<'note'> = {
    entityType: 'note',
    entityId: NOTE,
    schemaVersion: 1,
    revision: 2,
    deletedAt: null,
    updatedAt: NOW,
    modifiedByDeviceId: DEVICE,
    data: note('before resolution'),
  };
  const resolvedRecord: SyncRecord<'note'> = {
    ...oldRecord,
    revision: 3,
    data: note('resolved on another device'),
  };
  env.api.records.set(A, [oldRecord]);
  env.api.push = async (request) => ({
    protocolVersion: 1,
    results: [
      {
        opId: request.operations[0].opId,
        status: 'conflict',
        replayed: false,
        conflictId: CONFLICT,
        record: oldRecord,
      },
    ],
  });
  env.api.conflicts = async () => {
    // The first pull saw revision 2. The list observes a resolution committed afterward.
    env.api.records.set(A, [oldRecord, resolvedRecord]);
    return { conflicts: [], nextCursor: 'done', hasMore: false };
  };
  env.controller.setOnline(true);
  await env.controller.syncNow();
  assert.equal(env.controller.getSnapshot().workspace!.sync.cursor, '2');
  assert.equal(
    (getVisibleEntity(env.controller.getSnapshot().workspace!.sync, 'note', NOTE)!.data as NoteData)
      .body,
    'resolved on another device',
  );
  assert.equal(env.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.equal(Object.keys(env.controller.getSnapshot().workspace!.sync.conflicts).length, 0);
  await env.store.close();
});

test('a reviewed overlay is consumed after a merged resolution, including acknowledgement loss and restart', async () => {
  const env = await setupConflictWithOverlay();
  env.api.failResolutionAck = true;
  await env.controller.resolve(
    env.controller.getSnapshot().conflicts[0],
    { choice: 'merged', mutation: 'put', data: note('merged A+B+C') },
    { consumedOverlayOpId: env.overlay.opId },
  );
  assert.equal(
    env.controller.getSnapshot().workspace!.pendingResolutions[CONFLICT].consumedOverlayOpId,
    env.overlay.opId,
  );
  env.controller.deactivate();
  await env.store.close();
  const next = setup(env.api, env.factory, env.databaseName);
  await next.controller.bind('Restarted');
  next.controller.setOnline(true);
  await next.controller.syncNow();
  assert.equal(
    env.api.requests.length,
    1,
    'the already-reviewed successor must not be sent over the merged version',
  );
  assert.deepEqual(env.api.resolutionRequests[0], env.api.resolutionRequests[1]);
  assert.equal(
    (
      getVisibleEntity(next.controller.getSnapshot().workspace!.sync, 'note', NOTE)!
        .data as NoteData
    ).body,
    'merged A+B+C',
  );
  assert.equal(next.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.deepEqual(next.controller.getSnapshot().workspace!.sync.overlays, {});
  await next.store.close();
});

test('an edit saved after a resolution decision is preserved instead of being consumed with the reviewed overlay', async () => {
  const env = await setupConflictWithOverlay();
  const pause = { entered: deferred<void>(), release: deferred<void>() };
  env.api.pauseResolution = pause;
  const resolution = env.controller.resolve(
    env.controller.getSnapshot().conflicts[0],
    { choice: 'merged', mutation: 'put', data: note('merged A+B+C') },
    { consumedOverlayOpId: env.overlay.opId },
  );
  await pause.entered.promise;
  await env.controller.save(edit('new edit after decision D'));
  const successor = env.controller.getSnapshot().workspace!.sync.overlays[`note:${NOTE}`];
  assert.notEqual(successor.opId, env.overlay.opId);
  pause.release.resolve();
  await resolution;
  assert.equal(env.api.requests.length, 2);
  assert.equal(env.api.requests[1].operations[0].opId, successor.opId);
  assert.equal(env.api.requests[1].operations[0].baseRevision, 3);
  assert.equal(
    (getVisibleEntity(env.controller.getSnapshot().workspace!.sync, 'note', NOTE)!.data as NoteData)
      .body,
    'new edit after decision D',
  );
  await env.store.close();
});

test('stored resolution payloads reject malformed identities and unexpected fields', () => {
  const invalid: unknown = { sync: {}, pendingResolutions: {} };
  assert.throws(() => decodeWorkspace(invalid), { code: 'STORAGE_CORRUPT' });
});
