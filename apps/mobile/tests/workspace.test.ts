import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
  getVisibleEntity,
  type NoteData,
  type PaperData,
  type PushRequest,
  type PushResult,
  type SyncRecord,
} from '../../../packages/sync-core/src/index.ts';
import {
  SyncApi,
  type AccountIdentity,
  type ConflictResolution,
  type ServerConflict,
} from '../src/api.ts';
import { ClientError, describeError } from '../src/errors.ts';
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
const PAPER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
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
const paperEdit = (entityId = PAPER) => ({
  entityType: 'paper' as const,
  entityId,
  mutation: 'put' as const,
  data: {
    title: 'Offline paper',
    doi: null,
    year: null,
    publication: null,
    abstractText: null,
    authors: [],
    keywords: [],
  } satisfies PaperData,
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
  pullRequests: (string | null)[] = [];
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
      const current = [...rows]
        .reverse()
        .find(
          (row) => row.entityType === operation.entityType && row.entityId === operation.entityId,
        );
      const reject = (code: string): PushResult => {
        const result: PushResult = {
          opId: operation.opId,
          status: 'rejected',
          replayed: false,
          code,
          retryable: false,
        };
        this.receipts.set(key, result);
        return result;
      };
      if (!current && (operation.baseRevision !== 0 || operation.mutation !== 'put'))
        return reject('ENTITY_NOT_FOUND');
      if (current && operation.baseRevision !== current.revision) {
        const conflictId = crypto.randomUUID();
        const result: PushResult = {
          opId: operation.opId,
          status: 'conflict',
          replayed: false,
          conflictId,
          record: current,
        };
        this.openConflicts.push({
          conflictId,
          entityType: operation.entityType,
          entityId: operation.entityId,
          createdAt: NOW,
          attemptedOperation: structuredClone(operation),
          observedRecord: current,
          currentRecord: current,
        });
        this.receipts.set(key, result);
        return result;
      }
      if (current?.deletedAt && operation.mutation === 'put') return reject('RESTORE_REQUIRED');
      if (current && !current.deletedAt && operation.mutation === 'restore')
        return reject('ENTITY_NOT_DELETED');
      if (
        operation.entityType === 'note' &&
        operation.data?.paperId &&
        !rows.some((row) => row.entityType === 'paper' && row.entityId === operation.data!.paperId)
      ) {
        return {
          opId: operation.opId,
          status: 'rejected',
          replayed: false,
          code: 'DEPENDENCY_NOT_READY',
          retryable: true,
        };
      }
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
    this.pullRequests.push(cursor);
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
      const data = request.choice === 'merged' ? request.data : conflict.attemptedOperation.data;
      const paperId = data && 'paperId' in data ? data.paperId : null;
      if (
        request.choice !== 'current' &&
        conflict.entityType === 'note' &&
        paperId &&
        !(this.records.get(this.account) ?? []).some(
          (row) => row.entityType === 'paper' && row.entityId === paperId,
        )
      )
        return {
          opId: request.opId,
          status: 'rejected',
          replayed: false,
          code: 'DEPENDENCY_NOT_READY',
          retryable: true,
        };
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

async function queuePaperAfterInterruptedPush(env: ReturnType<typeof setup>, entityId = PAPER) {
  env.controller.setOnline(false);
  await env.controller.save(paperEdit(entityId));
  const normalPush = env.api.push.bind(env.api);
  env.api.push = async (request) => {
    env.api.requests.push(structuredClone(request));
    throw new ClientError('NETWORK_UNAVAILABLE', true);
  };
  env.controller.setOnline(true);
  await env.controller.syncNow();
  assert.equal(
    env.controller.getSnapshot().workspace!.sync.outbox.find(
      (entry) => entry.operation.entityId === entityId,
    )!.status,
    'uncertain',
  );
  const paperRequest = structuredClone(env.api.requests.at(-1)!);
  env.api.push = normalPush;
  return paperRequest;
}

async function setupTombstone() {
  const env = setup();
  await env.controller.bind('A');
  const deleted: SyncRecord<'note'> = {
    entityType: 'note',
    entityId: NOTE,
    schemaVersion: 1,
    revision: 2,
    deletedAt: NOW,
    updatedAt: NOW,
    modifiedByDeviceId: DEVICE,
    data: null,
  };
  env.api.records.set(A, [deleted]);
  env.controller.setOnline(true);
  await env.controller.syncNow();
  assert.equal(env.controller.getSnapshot().error, null);
  env.controller.setOnline(false);
  return env;
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

test('an offline note linked to a later queued paper sends N, P, then the unchanged N operation', async () => {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save(edit('independent offline note'));
  await env.controller.save(paperEdit());
  await env.controller.save({
    ...edit('linked offline note'),
    data: { ...note('linked offline note'), paperId: PAPER },
  });
  const queuedNote = structuredClone(
    env.controller.getSnapshot().workspace!.sync.outbox[0].operation,
  );

  env.controller.setOnline(true);
  await env.controller.syncNow();

  assert.deepEqual(
    env.api.requests.map((request) => request.operations[0].entityType),
    ['note', 'paper', 'note'],
  );
  assert.deepEqual(env.api.requests[0].operations[0], queuedNote);
  assert.deepEqual(env.api.requests[2].operations[0], queuedNote);
  assert.equal(env.api.writeCount, 2);
  assert.equal(env.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.equal(env.controller.getSnapshot().error, null);
  assert.equal(env.controller.getSnapshot().lastSyncedAt, NOW);
  const savedNote = env.api.records.get(A)!.find((row) => row.entityType === 'note')!;
  assert.equal((savedNote.data as NoteData).paperId, PAPER);
  await env.store.close();
});

test('a permanently missing dependency remains durable after bounded retries while unrelated work progresses', async () => {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save({
    ...edit('waiting for missing paper'),
    data: { ...note('waiting for missing paper'), paperId: PAPER },
  });
  await env.controller.save(paperEdit('11111111-1111-4111-8111-111111111111'));
  const queuedNote = structuredClone(
    env.controller.getSnapshot().workspace!.sync.outbox[0].operation,
  );

  env.controller.setOnline(true);
  await env.controller.syncNow();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    env.api.requests.map((request) => request.operations[0].entityType),
    ['note', 'paper', 'note'],
  );
  assert.equal(env.api.writeCount, 1);
  const pending = env.controller.getSnapshot().workspace!.sync.outbox;
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].operation, queuedNote);
  assert.equal(pending[0].status, 'queued');
  assert.equal(pending[0].errorCode, 'DEPENDENCY_NOT_READY');
  assert.equal(env.controller.getSnapshot().syncing, false);
  assert.equal(env.controller.getSnapshot().error?.code, 'SYNC_FAILED');
  await env.store.close();
});

test('a general retryable rejection is deferred for the run without preventing independent operations', async () => {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save(edit('temporarily rejected'));
  await env.controller.save(paperEdit());
  const normalPush = env.api.push.bind(env.api);
  env.api.push = async (request) => {
    if (request.operations[0].entityType !== 'note') return normalPush(request);
    env.api.requests.push(structuredClone(request));
    return {
      protocolVersion: 1,
      results: [
        {
          opId: request.operations[0].opId,
          status: 'rejected',
          replayed: false,
          code: 'TEMPORARY_FAILURE',
          retryable: true,
        },
      ],
    };
  };

  env.controller.setOnline(true);
  await env.controller.syncNow();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    env.api.requests.map((request) => request.operations[0].entityType),
    ['note', 'paper'],
  );
  assert.equal(env.api.writeCount, 1);
  assert.equal(
    env.controller.getSnapshot().workspace!.sync.outbox[0].errorCode,
    'TEMPORARY_FAILURE',
  );
  assert.equal(env.controller.getSnapshot().syncing, false);
  assert.equal(env.controller.getSnapshot().error?.code, 'SYNC_FAILED');
  await env.store.close();
});

test('a storage quota push preserves its original request and successor across restart without automatic retries', async () => {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save(edit('original before quota rejection'));
  const original = structuredClone(
    env.controller.getSnapshot().workspace!.sync.outbox[0].operation,
  );
  const requests: PushRequest[] = [];
  const quotaApi = new SyncApi(
    'https://sync.example.test',
    async () => 'test-token',
    async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as PushRequest;
      requests.push(request);
      return new Response(JSON.stringify({
        protocolVersion: 1,
        results: [{
          opId: request.operations[0].opId,
          status: 'rejected',
          replayed: false,
          code: 'ACCOUNT_STORAGE_LIMIT',
          retryable: true,
        }],
      }), { headers: { 'content-type': 'application/json' } });
    },
  );
  const normalPush = env.api.push.bind(env.api);
  env.api.push = (request) => quotaApi.push(request, new AbortController().signal);
  env.controller.setOnline(true);
  await env.controller.syncNow();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].operations[0], original);
  assert.equal(env.controller.getSnapshot().error?.code, 'ACCOUNT_STORAGE_LIMIT');
  assert.match(describeError(env.controller.getSnapshot().error), /额度/);
  assert.match(describeError(env.controller.getSnapshot().error), /保存在此设备/);
  assert.equal(env.controller.getSnapshot().needsLogin, false);
  assert.equal(env.controller.getSnapshot().lastSyncedAt, null);
  assert.equal(env.controller.getSnapshot().workspace!.sync.outbox[0].status, 'queued');

  env.controller.setOnline(false);
  await env.controller.save(edit('successor saved while quota is full'));
  const overlay = structuredClone(
    env.controller.getSnapshot().workspace!.sync.overlays[`note:${NOTE}`],
  );
  env.controller.deactivate();
  await env.store.close();
  const next = setup(env.api, env.factory, env.databaseName);
  await next.controller.bind('Reopened');
  next.controller.setOnline(true);
  await next.controller.syncNow();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const waiting = next.controller.getSnapshot();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(waiting.workspace!.sync.outbox[0].operation, original);
  assert.deepEqual(waiting.workspace!.sync.overlays[`note:${NOTE}`], overlay);
  assert.equal(
    (getVisibleEntity(waiting.workspace!.sync, 'note', NOTE)!.data as NoteData).body,
    'successor saved while quota is full',
  );
  assert.equal(waiting.error?.code, 'ACCOUNT_STORAGE_LIMIT');
  assert.equal(waiting.lastSyncedAt, null);

  env.api.push = normalPush;
  await next.controller.syncNow();
  assert.deepEqual(env.api.requests[0].operations[0], original);
  assert.equal(env.api.requests[1].operations[0].opId, overlay.opId);
  assert.equal(
    (env.api.records.get(A)!.at(-1)!.data as NoteData).body,
    'successor saved while quota is full',
  );
  assert.equal(next.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.deepEqual(next.controller.getSnapshot().workspace!.sync.overlays, {});
  assert.equal(next.controller.getSnapshot().error, null);
  await next.store.close();
});

test('a storage quota resolution preserves its decision and later overlay until an exact retry succeeds', async () => {
  const env = await setupConflictWithOverlay();
  const requests: ConflictResolution[] = [];
  const quotaApi = new SyncApi(
    'https://sync.example.test',
    async () => 'test-token',
    async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as ConflictResolution;
      requests.push(request);
      return new Response(JSON.stringify({
        opId: request.opId,
        status: 'rejected',
        replayed: false,
        code: 'ACCOUNT_STORAGE_LIMIT',
        retryable: true,
      }), { headers: { 'content-type': 'application/json' } });
    },
  );
  const normalResolve = env.api.resolveConflict.bind(env.api);
  env.api.resolveConflict = (id, request) =>
    quotaApi.resolveConflict(id, request, new AbortController().signal);
  await env.controller.resolve(
    env.controller.getSnapshot().conflicts[0],
    { choice: 'merged', mutation: 'put', data: note('reviewed merge before quota rejection') },
    { consumedOverlayOpId: env.overlay.opId },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const pending = structuredClone(
    env.controller.getSnapshot().workspace!.pendingResolutions[CONFLICT],
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(pending.request, requests[0]);
  assert.equal(pending.consumedOverlayOpId, env.overlay.opId);
  assert.equal(env.controller.getSnapshot().error?.code, 'ACCOUNT_STORAGE_LIMIT');
  assert.match(describeError(env.controller.getSnapshot().error), /额度/);
  assert.equal(env.controller.getSnapshot().needsLogin, false);
  assert.deepEqual(
    env.controller.getSnapshot().workspace!.sync.overlays[`note:${NOTE}`],
    env.overlay,
  );

  env.controller.setOnline(false);
  await env.controller.save(edit('new successor after quota decision'));
  const successor = structuredClone(
    env.controller.getSnapshot().workspace!.sync.overlays[`note:${NOTE}`],
  );
  assert.notEqual(successor.opId, env.overlay.opId);
  env.controller.deactivate();
  await env.store.close();
  const next = setup(env.api, env.factory, env.databaseName);
  await next.controller.bind('Reopened');
  next.controller.setOnline(true);
  await next.controller.syncNow();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const waiting = next.controller.getSnapshot();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(waiting.workspace!.pendingResolutions[CONFLICT], pending);
  assert.deepEqual(waiting.workspace!.sync.overlays[`note:${NOTE}`], successor);
  assert.equal(waiting.error?.code, 'ACCOUNT_STORAGE_LIMIT');
  assert.equal(waiting.lastSyncedAt, null);
  assert.equal(waiting.workspace!.sync.outbox[0].status, 'conflict');

  env.api.resolveConflict = normalResolve;
  await next.controller.syncNow();
  assert.deepEqual(env.api.resolutionRequests[0], pending.request);
  assert.equal(env.api.requests.at(-1)!.operations[0].opId, successor.opId);
  assert.equal(env.api.records.get(A)!.at(-1)!.revision, 4);
  assert.equal(
    (env.api.records.get(A)!.at(-1)!.data as NoteData).body,
    'new successor after quota decision',
  );
  assert.deepEqual(next.controller.getSnapshot().workspace!.pendingResolutions, {});
  assert.deepEqual(next.controller.getSnapshot().workspace!.sync.overlays, {});
  assert.equal(next.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.equal(next.controller.getSnapshot().error, null);
  await next.store.close();
});

test('editing an unsent offline restore keeps the explicit restore intent and succeeds against the tombstone', async () => {
  const env = await setupTombstone();
  await env.controller.save({ ...edit('restored locally'), mutation: 'restore' }, 2);
  await env.controller.save(edit('edited before restore was sent'), 2);

  env.controller.setOnline(true);
  await env.controller.syncNow();

  assert.equal(env.api.requests.length, 1);
  assert.equal(env.api.requests[0].operations[0].mutation, 'restore');
  assert.equal(
    (env.api.requests[0].operations[0].data as NoteData).body,
    'edited before restore was sent',
  );
  assert.equal(env.api.records.get(A)!.at(-1)!.revision, 3);
  assert.equal(env.api.records.get(A)!.at(-1)!.deletedAt, null);
  assert.equal(env.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  await env.store.close();
});

test('an edit during a restore request preserves that request and syncs afterward as a put overlay', async () => {
  const env = await setupTombstone();
  await env.controller.save({ ...edit('explicit restore body'), mutation: 'restore' }, 2);
  const original = structuredClone(
    env.controller.getSnapshot().workspace!.sync.outbox[0].operation,
  );
  const pause = { entered: deferred<void>(), release: deferred<void>() };
  env.api.pausePush = pause;
  env.controller.setOnline(true);
  const running = env.controller.syncNow();
  await pause.entered.promise;
  await env.controller.save(edit('edited after restore was sent'), 2);
  const overlay = env.controller.getSnapshot().workspace!.sync.overlays[`note:${NOTE}`];
  assert.deepEqual(env.controller.getSnapshot().workspace!.sync.outbox[0].operation, original);

  pause.release.resolve();
  await running;

  assert.equal(env.api.requests.length, 2);
  assert.deepEqual(env.api.requests[0].operations[0], original);
  assert.equal(env.api.requests[1].operations[0].opId, overlay.opId);
  assert.equal(env.api.requests[1].operations[0].mutation, 'put');
  assert.equal(env.api.requests[1].operations[0].baseRevision, 3);
  assert.equal(env.api.records.get(A)!.at(-1)!.revision, 4);
  assert.equal(
    (env.api.records.get(A)!.at(-1)!.data as NoteData).body,
    'edited after restore was sent',
  );
  assert.equal(env.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  await env.store.close();
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

test('a pending resolution lets its queued paper upload before retrying the unchanged request', async () => {
  const env = await setupConflictWithOverlay();
  const paperRequest = await queuePaperAfterInterruptedPush(env);
  const pullsBefore = env.api.pullRequests.length;

  await env.controller.resolve(
    env.controller.getSnapshot().conflicts[0],
    { choice: 'merged', mutation: 'put', data: { ...note('merged with paper'), paperId: PAPER } },
    { consumedOverlayOpId: env.overlay.opId },
  );

  assert.equal(env.api.resolutionRequests.length, 2);
  assert.deepEqual(env.api.resolutionRequests[0], env.api.resolutionRequests[1]);
  assert.deepEqual(env.api.requests.at(-1), paperRequest);
  assert.equal(env.api.writeCount, 1);
  const snapshot = env.controller.getSnapshot();
  assert.deepEqual(snapshot.workspace!.pendingResolutions, {});
  assert.equal(snapshot.workspace!.sync.outbox.length, 0);
  assert.deepEqual(snapshot.workspace!.sync.overlays, {});
  assert.equal(snapshot.error, null);
  assert.ok(env.api.pullRequests.length > pullsBefore);
  assert.equal(
    (getVisibleEntity(snapshot.workspace!.sync, 'note', NOTE)!.data as NoteData).paperId,
    PAPER,
  );
  await env.store.close();
});

test('a resolution with a permanently missing dependency permits unrelated work and pull, then survives restart unchanged', async () => {
  const env = await setupConflictWithOverlay();
  await queuePaperAfterInterruptedPush(env, '11111111-1111-4111-8111-111111111111');
  const pullsBefore = env.api.pullRequests.length;
  await env.controller.resolve(
    env.controller.getSnapshot().conflicts[0],
    { choice: 'merged', mutation: 'put', data: { ...note('waiting for paper'), paperId: PAPER } },
    { consumedOverlayOpId: env.overlay.opId },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(env.api.resolutionRequests.length, 2);
  assert.equal(env.api.writeCount, 1);
  assert.ok(env.api.pullRequests.length > pullsBefore);
  const snapshot = env.controller.getSnapshot();
  const pending = structuredClone(snapshot.workspace!.pendingResolutions[CONFLICT]);
  assert.deepEqual(pending.request, env.api.resolutionRequests[0]);
  assert.deepEqual(pending.request, env.api.resolutionRequests[1]);
  assert.equal(pending.consumedOverlayOpId, env.overlay.opId);
  assert.equal(snapshot.syncing, false);
  assert.equal(snapshot.error?.code, 'SYNC_FAILED');
  assert.equal(snapshot.workspace!.sync.outbox.length, 1);
  assert.equal(snapshot.workspace!.sync.outbox[0].status, 'conflict');
  assert.equal(snapshot.workspace!.sync.overlays[`note:${NOTE}`].opId, env.overlay.opId);

  env.controller.deactivate();
  await env.store.close();
  const next = setup(env.api, env.factory, env.databaseName);
  await next.controller.bind('Reopened');
  assert.deepEqual(next.controller.getSnapshot().workspace!.pendingResolutions[CONFLICT], pending);
  await next.controller.save(paperEdit());
  next.controller.setOnline(true);
  await next.controller.syncNow();
  assert.equal(env.api.resolutionRequests.length, 4);
  for (const request of env.api.resolutionRequests) assert.deepEqual(request, pending.request);
  assert.deepEqual(next.controller.getSnapshot().workspace!.pendingResolutions, {});
  assert.equal(next.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.deepEqual(next.controller.getSnapshot().workspace!.sync.overlays, {});
  assert.equal(next.controller.getSnapshot().error, null);
  await next.store.close();
});

test('a general retryable resolution is attempted once per run while independent writes and pull continue', async () => {
  const env = await setupConflictWithOverlay();
  await queuePaperAfterInterruptedPush(env);
  const normalResolve = env.api.resolveConflict.bind(env.api);
  env.api.resolveConflict = async (_conflictId, request) => {
    env.api.resolutionRequests.push(structuredClone(request));
    return {
      opId: request.opId,
      status: 'rejected',
      replayed: false,
      code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    };
  };
  const pullsBefore = env.api.pullRequests.length;
  await env.controller.resolve(
    env.controller.getSnapshot().conflicts[0],
    { choice: 'merged', mutation: 'put', data: note('merged after temporary failure') },
    { consumedOverlayOpId: env.overlay.opId },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(env.api.resolutionRequests.length, 1);
  assert.equal(env.api.writeCount, 1);
  assert.ok(env.api.pullRequests.length > pullsBefore);
  const pending = structuredClone(
    env.controller.getSnapshot().workspace!.pendingResolutions[CONFLICT],
  );
  assert.deepEqual(pending.request, env.api.resolutionRequests[0]);
  assert.equal(pending.consumedOverlayOpId, env.overlay.opId);
  assert.equal(env.controller.getSnapshot().error?.code, 'SYNC_FAILED');
  assert.equal(
    env.controller.getSnapshot().workspace!.sync.overlays[`note:${NOTE}`].opId,
    env.overlay.opId,
  );

  env.api.resolveConflict = normalResolve;
  await env.controller.syncNow();
  assert.equal(env.api.resolutionRequests.length, 2);
  assert.deepEqual(env.api.resolutionRequests[1], pending.request);
  assert.deepEqual(env.controller.getSnapshot().workspace!.pendingResolutions, {});
  assert.equal(env.controller.getSnapshot().error, null);
  await env.store.close();
});

test('a dependency retry keeps the reviewed revision when another device edits before the paper arrives', async () => {
  const env = await setupConflictWithOverlay();
  await queuePaperAfterInterruptedPush(env);
  const normalPush = env.api.push.bind(env.api);
  const normalResolve = env.api.resolveConflict.bind(env.api);
  let concurrent: SyncRecord<'note'> | null = null;
  env.api.push = async (request) => {
    const response = await normalPush(request);
    concurrent = {
      ...(env.api.openConflicts[0].currentRecord as SyncRecord<'note'>),
      revision: 3,
      data: note('new remote edit while dependency uploaded'),
    };
    env.api.records.get(A)!.push(concurrent);
    env.api.openConflicts[0].currentRecord = concurrent;
    return response;
  };
  env.api.resolveConflict = async (conflictId, request) => {
    if (!concurrent) return normalResolve(conflictId, request);
    env.api.resolutionRequests.push(structuredClone(request));
    assert.equal(request.expectedRevision, 2);
    return {
      opId: request.opId,
      status: 'conflict',
      replayed: false,
      conflictId: crypto.randomUUID(),
      record: concurrent,
    };
  };
  await env.controller.resolve(
    env.controller.getSnapshot().conflicts[0],
    { choice: 'merged', mutation: 'put', data: { ...note('reviewed merge'), paperId: PAPER } },
    { consumedOverlayOpId: env.overlay.opId },
  );

  assert.equal(env.api.resolutionRequests.length, 2);
  assert.deepEqual(env.api.resolutionRequests[1], env.api.resolutionRequests[0]);
  assert.equal(env.api.records.get(A)!.at(-1)!.revision, 3);
  assert.equal(
    (env.api.records.get(A)!.at(-1)!.data as NoteData).body,
    'new remote edit while dependency uploaded',
  );
  const snapshot = env.controller.getSnapshot();
  assert.equal(snapshot.error?.code, 'CONFLICT_CHANGED');
  assert.deepEqual(snapshot.workspace!.pendingResolutions, {});
  assert.equal(snapshot.workspace!.sync.outbox[0].status, 'conflict');
  assert.equal(snapshot.workspace!.sync.overlays[`note:${NOTE}`].opId, env.overlay.opId);
  await env.store.close();
});

test('a full resolution budget still permits outbox and pull and rotates unattempted requests to the next run', async () => {
  const env = setup();
  await env.controller.bind('A');
  await env.controller.save(paperEdit());
  env.controller.deactivate();
  const pendingResolutions = Object.fromEntries(
    Array.from({ length: 101 }, () => [
      crypto.randomUUID(),
      {
        entityType: 'note' as const,
        entityId: NOTE,
        request: { choice: 'current' as const, opId: crypto.randomUUID(), expectedRevision: 2 },
      },
    ]),
  );
  await env.store.update({ apiBaseUrl: 'https://sync.example.test', accountId: A }, (value) => ({
    ...value!,
    pendingResolutions,
  }));
  await env.controller.bind('Reopened with pending requests');
  env.api.resolveConflict = async (_conflictId, request) => {
    env.api.resolutionRequests.push(structuredClone(request));
    return {
      opId: request.opId,
      status: 'rejected',
      replayed: false,
      code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    };
  };
  env.controller.setOnline(true);
  await env.controller.syncNow();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(env.api.resolutionRequests.length, 100);
  assert.equal(env.api.writeCount, 1);
  assert.equal(env.api.pullRequests.length, 1);
  assert.equal(env.controller.getSnapshot().lastSyncedAt, null);
  assert.equal(env.controller.getSnapshot().error?.code, 'SYNC_FAILED');
  const original = Object.values(pendingResolutions).map((pending) => pending.request);
  assert.deepEqual(env.api.resolutionRequests, original.slice(0, 100));
  env.controller.deactivate();
  await env.store.close();

  const next = setup(env.api, env.factory, env.databaseName);
  await next.controller.bind('Restarted after bounded run');
  next.controller.setOnline(true);
  await next.controller.syncNow();
  assert.equal(env.api.resolutionRequests.length, 200);
  assert.deepEqual(env.api.resolutionRequests[100], original[100]);
  assert.equal(new Set(env.api.resolutionRequests.map((request) => request.opId)).size, 101);
  assert.equal(env.api.pullRequests.length, 2);
  assert.equal(next.controller.getSnapshot().error?.code, 'SYNC_FAILED');
  assert.deepEqual(next.controller.getSnapshot().workspace!.pendingResolutions, pendingResolutions);
  await next.store.close();
});

test('successful resolutions beyond one run budget remain visibly pending without a queued outbox', async () => {
  const env = setup();
  await env.controller.bind('A');
  env.controller.deactivate();
  const pendingResolutions = Object.fromEntries(
    Array.from({ length: 101 }, () => [
      crypto.randomUUID(),
      {
        entityType: 'note' as const,
        entityId: NOTE,
        request: { choice: 'current' as const, opId: crypto.randomUUID(), expectedRevision: 2 },
      },
    ]),
  );
  await env.store.update({ apiBaseUrl: 'https://sync.example.test', accountId: A }, (value) => ({
    ...value!,
    pendingResolutions,
  }));
  const record: SyncRecord<'note'> = {
    entityType: 'note',
    entityId: NOTE,
    schemaVersion: 1,
    revision: 2,
    deletedAt: null,
    updatedAt: NOW,
    modifiedByDeviceId: DEVICE,
    data: note('current version'),
  };
  env.api.records.set(A, [record]);
  env.api.resolveConflict = async (_conflictId, request) => {
    env.api.resolutionRequests.push(structuredClone(request));
    return { opId: request.opId, status: 'applied', replayed: false, record };
  };
  await env.controller.bind('Reopened with successful pending requests');
  env.controller.setOnline(true);
  await env.controller.syncNow();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  const snapshot = env.controller.getSnapshot();
  assert.equal(env.api.resolutionRequests.length, 100);
  assert.equal(env.api.requests.length, 0);
  assert.equal(env.api.pullRequests.length, 1);
  assert.equal(Object.keys(snapshot.workspace!.pendingResolutions).length, 1);
  assert.equal(snapshot.workspace!.sync.outbox.length, 0);
  assert.equal(snapshot.syncing, false);
  assert.equal(snapshot.lastSyncedAt, null);
  assert.equal(snapshot.error?.code, 'SYNC_FAILED');

  await env.controller.syncNow();
  assert.equal(env.api.resolutionRequests.length, 101);
  assert.equal(env.api.pullRequests.length, 2);
  assert.deepEqual(env.controller.getSnapshot().workspace!.pendingResolutions, {});
  assert.equal(env.controller.getSnapshot().error, null);
  assert.equal(env.controller.getSnapshot().lastSyncedAt, NOW);
  await env.store.close();
});

test('a lost resolution acknowledgement permits independent work but remains pending after pull observes its closure', async () => {
  const env = await setupConflictWithOverlay();
  await queuePaperAfterInterruptedPush(env);
  const pullsBefore = env.api.pullRequests.length;
  env.api.failResolutionAck = true;
  await env.controller.resolve(
    env.controller.getSnapshot().conflicts[0],
    { choice: 'merged', mutation: 'put', data: note('merged before lost acknowledgement') },
    { consumedOverlayOpId: env.overlay.opId },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(env.api.resolutionRequests.length, 1);
  assert.equal(env.api.writeCount, 1);
  assert.ok(env.api.pullRequests.length > pullsBefore);
  const snapshot = env.controller.getSnapshot();
  const pending = structuredClone(snapshot.workspace!.pendingResolutions[CONFLICT]);
  assert.deepEqual(snapshot.conflicts, []);
  assert.equal(snapshot.workspace!.sync.conflicts[CONFLICT].conflictId, CONFLICT);
  assert.equal(snapshot.workspace!.sync.outbox[0].status, 'conflict');
  assert.equal(snapshot.workspace!.sync.overlays[`note:${NOTE}`].opId, env.overlay.opId);
  assert.equal(snapshot.error?.code, 'NETWORK_UNAVAILABLE');
  const recordsAfterCommit = env.api.records.get(A)!.length;

  env.controller.deactivate();
  await env.store.close();
  const next = setup(env.api, env.factory, env.databaseName);
  await next.controller.bind('Reopened');
  assert.deepEqual(next.controller.getSnapshot().workspace!.pendingResolutions[CONFLICT], pending);
  next.controller.setOnline(true);
  await next.controller.syncNow();
  assert.equal(env.api.resolutionRequests.length, 2);
  assert.deepEqual(env.api.resolutionRequests[1], pending.request);
  assert.equal(env.api.records.get(A)!.length, recordsAfterCommit);
  assert.deepEqual(next.controller.getSnapshot().workspace!.pendingResolutions, {});
  assert.deepEqual(next.controller.getSnapshot().workspace!.sync.overlays, {});
  assert.equal(next.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.equal(next.controller.getSnapshot().error, null);
  await next.store.close();
});

for (const code of ['AUTH_REQUIRED', 'SESSION_REVOKED', 'INVALID_RESPONSE'] as const) {
  test(`a resolution ${code} fails immediately without sending queued writes or pulling`, async () => {
    const env = await setupConflictWithOverlay();
    await queuePaperAfterInterruptedPush(env);
    const pushesBefore = env.api.requests.length;
    const pullsBefore = env.api.pullRequests.length;
    env.api.resolveConflict = async (_conflictId, request) => {
      env.api.resolutionRequests.push(structuredClone(request));
      throw new ClientError(code);
    };
    await env.controller.resolve(
      env.controller.getSnapshot().conflicts[0],
      { choice: 'merged', mutation: 'put', data: note('keep after error') },
      { consumedOverlayOpId: env.overlay.opId },
    );

    const snapshot = env.controller.getSnapshot();
    assert.equal(env.api.resolutionRequests.length, 1);
    assert.equal(env.api.requests.length, pushesBefore);
    assert.equal(env.api.pullRequests.length, pullsBefore);
    assert.equal(snapshot.error?.code, code);
    assert.equal(snapshot.needsLogin, code !== 'INVALID_RESPONSE');
    assert.deepEqual(
      snapshot.workspace!.pendingResolutions[CONFLICT].request,
      env.api.resolutionRequests[0],
    );
    assert.equal(snapshot.workspace!.sync.overlays[`note:${NOTE}`].opId, env.overlay.opId);
    await env.store.close();
  });
}

for (const status of ['conflict', 'rejected'] as const) {
  test(`a list refresh failure after a terminal resolution ${status} does not require login or recreate pending work`, async () => {
    const env = await setupConflictWithOverlay();
    const current = env.api.openConflicts[0].currentRecord!;
    const normalConflicts = env.api.conflicts.bind(env.api);
    env.api.resolveConflict = async (_conflictId, request) => {
      env.api.resolutionRequests.push(structuredClone(request));
      return status === 'conflict'
        ? {
            opId: request.opId,
            status,
            replayed: false,
            conflictId: crypto.randomUUID(),
            record: current,
          }
        : {
            opId: request.opId,
            status,
            replayed: false,
            code: 'RESTORE_REQUIRED',
            retryable: false,
          };
    };
    env.api.conflicts = async () => {
      throw new ClientError('NETWORK_UNAVAILABLE', true);
    };
    await env.controller.resolve(
      env.controller.getSnapshot().conflicts[0],
      { choice: 'merged', mutation: 'put', data: note('keep after terminal result') },
      { consumedOverlayOpId: env.overlay.opId },
    );

    const snapshot = env.controller.getSnapshot();
    assert.equal(snapshot.error?.code, 'NETWORK_UNAVAILABLE');
    assert.equal(snapshot.needsLogin, false);
    assert.deepEqual(snapshot.workspace!.pendingResolutions, {});
    assert.equal(snapshot.workspace!.sync.outbox[0].status, 'conflict');
    assert.equal(snapshot.workspace!.sync.overlays[`note:${NOTE}`].opId, env.overlay.opId);
    env.api.conflicts = normalConflicts;
    await env.controller.syncNow();
    assert.equal(env.api.resolutionRequests.length, 1);
    assert.equal(env.controller.getSnapshot().error, null);
    assert.equal(env.controller.getSnapshot().needsLogin, false);
    await env.store.close();
  });
}

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

test('a successor unseen by the resolving device keeps its old base and conflicts with a newer remote revision', async () => {
  const env = await setupConflictWithOverlay();
  env.controller.setOnline(false);
  const blocked = env.controller.getSnapshot().workspace!.sync.outbox[0].operation;
  const previous = env.api.records.get(A)!.at(-1)! as SyncRecord<'note'>;
  const resolved: SyncRecord<'note'> = {
    ...previous,
    revision: 3,
    data: note('device B resolved as D'),
  };
  const newest: SyncRecord<'note'> = {
    ...resolved,
    revision: 4,
    data: note('device B edited D again'),
  };
  env.api.records.get(A)!.push(resolved, newest);
  env.api.openConflicts = [];

  env.controller.setOnline(true);
  await env.controller.syncNow();
  // Reconciliation releases the successor; the controller schedules its next push.
  await env.controller.syncNow();

  assert.equal(env.api.records.get(A)!.at(-1)!.revision, 4);
  assert.equal((env.api.records.get(A)!.at(-1)!.data as NoteData).body, 'device B edited D again');
  const request = env.api.requests.at(-1)!.operations[0];
  assert.equal(request.opId, env.overlay.opId);
  assert.equal(request.baseRevision, blocked.baseRevision);
  assert.equal((request.data as NoteData).body, 'saved successor C');
  const snapshot = env.controller.getSnapshot();
  assert.equal(snapshot.workspace!.sync.outbox[0].status, 'conflict');
  assert.notEqual(snapshot.workspace!.sync.outbox[0].conflictId, CONFLICT);
  assert.equal(snapshot.conflicts.length, 1);
  assert.equal(snapshot.conflicts[0].currentRecord!.revision, 4);
  assert.equal(
    (snapshot.conflicts[0].attemptedOperation.data as NoteData).body,
    'saved successor C',
  );
  assert.equal(
    (getVisibleEntity(snapshot.workspace!.sync, 'note', NOTE)!.data as NoteData).body,
    'saved successor C',
  );
  await env.store.close();
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
