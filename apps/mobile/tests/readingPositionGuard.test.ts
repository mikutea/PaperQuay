import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
  createAccountState, entityKey, getVisibleEntity, queueLocalEdit, rebindDevice, resumeAfterRestart,
  type LocalEdit, type ReadingPositionData,
} from '../../../packages/sync-core/src/index.ts';
import type { AccountIdentity } from '../src/api.ts';
import { ClientError } from '../src/errors.ts';
import { ownReadingPosition, ReadingCheckpointWriter, type PositionStatus, type ReaderController } from '../src/pdf/position.ts';
import type { PdfVersion } from '../src/pdf/types.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController } from '../src/sync/workspace.ts';

const NOW = '2026-10-27T12:00:00.000Z';
const controlled = (code: string) => (error: unknown) => error instanceof ClientError && error.code === code;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(t: TestContext) {
  const scope = { apiBaseUrl: 'https://sync.example.invalid', accountId: crypto.randomUUID() };
  const initial = createAccountState(scope.accountId, crypto.randomUUID());
  const version: PdfVersion = { entityId: crypto.randomUUID(), data: {
    paperId: crypto.randomUUID(), attachmentId: crypto.randomUUID(), sha256: 'a'.repeat(64), sizeBytes: 1024,
    mediaType: 'application/pdf', fileName: 'position.pdf', pageCount: 12,
  } };
  const metadata = { schemaVersion: 1 as const, revision: 1, deletedAt: null,
    updatedAt: NOW, modifiedByDeviceId: initial.deviceId };
  initial.serverRecords[entityKey('paper', version.data.paperId)] = { ...metadata, entityType: 'paper', entityId: version.data.paperId,
    data: { title: 'Position paper', authors: [], keywords: [], year: null, doi: null, publication: null, abstractText: null } };
  initial.serverRecords[entityKey('attachmentVersion', version.entityId)] = {
    ...metadata, entityType: 'attachmentVersion', entityId: version.entityId, data: structuredClone(version.data),
  };
  const store = new AccountStore({ decode: decodeWorkspace, indexedDB: new IDBFactory() });
  await store.update(scope, () => ({ sync: initial, pendingResolutions: {} }));
  const binding = { accountId: scope.accountId, key: 'initial-subject' };
  let allocatedOpIds = 0;
  const controller = new WorkspaceController({ store, apiBaseUrl: scope.apiBaseUrl, online: false,
    now: () => NOW, makeId: () => { allocatedOpIds++; return crypto.randomUUID(); },
    binding: { key: () => binding.key }, api: {
      async register(): Promise<AccountIdentity> {
        return { accountId: binding.accountId, device: { id: initial.deviceId, name: 'Position guard', platform: 'web',
          createdAt: NOW, lastSeenAt: NOW, revokedAt: null } };
      },
      async push() { throw new Error('Unexpected offline push'); },
      async pull() { throw new Error('Unexpected offline pull'); },
      async devices() { return []; },
      async conflicts() { return { conflicts: [], nextCursor: 'done', hasMore: false }; },
      async resolveConflict() { throw new Error('Unexpected conflict resolution'); },
      async revokeDevice() {},
    } });
  await controller.bind('Position guard');
  assert.equal(controller.getSnapshot().status, 'ready');
  let saves = 0;
  const hooks: { afterSave?: () => Promise<void> } = {};
  const save = controller.save.bind(controller);
  t.mock.method(controller, 'save', async (...args: Parameters<ReaderController['save']>) => {
    saves++; await save(...args); await hooks.afterSave?.();
  });
  const statuses: PositionStatus[] = [];
  const writer = new ReadingCheckpointWriter(controller, scope, version,
    { now: () => NOW, debounceMs: 30_000, onStatus: (status) => statuses.push(status) });
  t.after(async () => { writer.stop(); await store.close(); });
  return { scope, store, controller, version, writer, statuses, binding, hooks,
    saves: () => saves, allocatedOpIds: () => allocatedOpIds };
}
function queueInStore(env: Awaited<ReturnType<typeof setup>>, edit: LocalEdit) {
  return env.store.update(env.scope, (current) => ({ ...current!, sync: queueLocalEdit(current!.sync, edit,
    { opId: crypto.randomUUID(), clientCreatedAt: NOW }) }));
}

test('queued target changes reject a position checkpoint before any outbox identity is allocated', async (t) => {
  for (const change of ['paper-deleted', 'version-deleted', 'hash', 'parent', 'attachment'] as const) await t.test(change, async (t) => {
    const env = await setup(t); const version = env.version;
    const displayed = env.controller.getSnapshot().workspace;
    const preceding = queueInStore(env, change === 'paper-deleted'
      ? { entityType: 'paper', entityId: version.data.paperId, mutation: 'delete', data: null }
      : change === 'version-deleted'
        ? { entityType: 'attachmentVersion', entityId: version.entityId, mutation: 'delete', data: null }
        : { entityType: 'attachmentVersion', entityId: version.entityId, mutation: 'put', data: { ...version.data,
          ...(change === 'hash' ? { sha256: 'b'.repeat(64) } : change === 'parent'
            ? { paperId: crypto.randomUUID() } : { attachmentId: crypto.randomUUID() }),
        } });
    env.writer.record({ pageIndex: 3, offsetRatio: 0.2 });
    const saving = env.writer.flush();
    assert.equal(env.saves(), 1, 'the checkpoint must already be queued behind the target edit');
    const rejected = assert.rejects(saving, controlled('EDIT_CHANGED'));
    const latest = await preceding;
    await rejected;
    assert.deepEqual(await env.store.read(env.scope), latest);
    assert.equal(latest.sync.outbox.some((entry) => entry.operation.entityType === 'readingPosition'), false);
    assert.equal(env.allocatedOpIds(), 0);
    assert.equal(env.controller.getSnapshot().workspace, displayed);
    assert.equal(env.statuses.includes('saved'), false);
    assert.equal(env.statuses.at(-1), 'error');
  });
});

test('stopping a writer rejects its queued transaction without restoring a dirty checkpoint or publishing completion', async (t) => {
  const env = await setup(t); const before = await env.store.read(env.scope);
  env.writer.record({ pageIndex: 3, offsetRatio: 0.4 });
  const saving = env.writer.flush();
  assert.equal(env.saves(), 1);
  const rejected = assert.rejects(saving, controlled('EDIT_CHANGED'));
  env.writer.stop();
  const stoppedStatuses = [...env.statuses];
  await rejected;
  assert.deepEqual(await env.store.read(env.scope), before);
  assert.equal(env.allocatedOpIds(), 0);
  assert.deepEqual(env.statuses, stoppedStatuses, 'a retired writer must not notify error or saved');
  env.writer.record({ pageIndex: 4, offsetRatio: 0 });
  await env.writer.flush();
  assert.equal(env.saves(), 1, 'stopped work must never be retried');
  assert.deepEqual(env.statuses, stoppedStatuses);
});

test('a stopped writer ignores completion notifications even if persistence finished before stop', async (t) => {
  const env = await setup(t); const committed = deferred(); const release = deferred();
  env.hooks.afterSave = async () => { committed.resolve(); await release.promise; };
  env.writer.record({ pageIndex: 2, offsetRatio: 0.5 });
  const saving = env.writer.flush();
  await committed.promise;
  env.writer.stop(); const stoppedStatuses = [...env.statuses];
  release.resolve(); await saving;
  const state = (await env.store.read(env.scope))!.sync;
  assert.equal(state.outbox.filter((entry) => entry.operation.entityType === 'readingPosition').length, 1);
  assert.deepEqual(env.statuses, stoppedStatuses, 'late completion cannot change a retired reader dirty state');
});

test('a live tombstone fails the preflight before a position save is dispatched', async (t) => {
  const env = await setup(t);
  await env.controller.save({ entityType: 'attachmentVersion', entityId: env.version.entityId, mutation: 'delete', data: null });
  const before = await env.store.read(env.scope);
  const saves = env.saves(); const allocated = env.allocatedOpIds();
  env.writer.record({ pageIndex: 3, offsetRatio: 0 });
  await assert.rejects(env.writer.flush(), controlled('EDIT_CHANGED'));
  assert.deepEqual(await env.store.read(env.scope), before);
  assert.equal(env.saves(), saves);
  assert.equal(env.allocatedOpIds(), allocated);
});

test('external version mutation cannot retarget a pending writer or alter its captured page bounds', async (t) => {
  const env = await setup(t); const captured = structuredClone(env.version);
  env.version.entityId = crypto.randomUUID();
  env.version.data.paperId = crypto.randomUUID();
  env.version.data.sha256 = 'b'.repeat(64);
  env.version.data.pageCount = 0;
  env.writer.record({ pageIndex: 3, offsetRatio: 0.2 });
  await env.writer.flush();
  const own = ownReadingPosition((await env.store.read(env.scope))!.sync, captured)!;
  assert.equal((own.data as ReadingPositionData).paperId, captured.data.paperId);
  assert.equal((own.data as ReadingPositionData).attachmentVersionId, captured.entityId);
  assert.equal((own.data as ReadingPositionData).pageIndex, 3);
  assert.equal(env.allocatedOpIds(), 1);
});

test('mutating the caller version to match queued replacement bytes cannot bypass the transaction guard', async (t) => {
  const env = await setup(t);
  const preceding = queueInStore(env, { entityType: 'attachmentVersion', entityId: env.version.entityId,
    mutation: 'put', data: { ...env.version.data, sha256: 'b'.repeat(64) } });
  env.writer.record({ pageIndex: 3, offsetRatio: 0.1 });
  const saving = env.writer.flush();
  const rejected = assert.rejects(saving, controlled('EDIT_CHANGED'));
  env.version.data.sha256 = 'b'.repeat(64);
  const latest = await preceding; await rejected;
  assert.equal(env.saves(), 1);
  assert.equal(env.allocatedOpIds(), 0);
  assert.deepEqual(await env.store.read(env.scope), latest);
});

test('offline checkpoints preserve the latest point and furthest progress while a filename edit is queued', async (t) => {
  const env = await setup(t);
  env.controller.requireLogin();
  const preceding = queueInStore(env, { entityType: 'attachmentVersion', entityId: env.version.entityId,
    mutation: 'put', data: { ...env.version.data, fileName: 'renamed-offline.pdf' } });
  env.writer.record({ pageIndex: 9, offsetRatio: 0.8 });
  const saving = env.writer.flush();
  env.writer.record({ pageIndex: 2, offsetRatio: 0.1 });
  const renamed = await preceding;
  await saving;
  const state = (await env.store.read(env.scope))!.sync;
  const own = ownReadingPosition(state, env.version)!;
  const data = own.data as ReadingPositionData;
  assert.equal(data.pageIndex, 2); assert.equal(data.furthestPageIndex, 9);
  assert.equal(data.deviceSequence, 2); assert.equal(env.saves(), 2);
  assert.equal(env.statuses.at(-1), 'saved');
  assert.equal(env.controller.getSnapshot().needsLogin, true);
  assert.deepEqual(state.outbox.find((entry) => entry.operation.entityType === 'attachmentVersion'), renamed.sync.outbox[0]);
  assert.equal(state.outbox.filter((entry) => entry.operation.entityType === 'readingPosition').length, 1);
});

test('queued device or generation changes cannot persist a checkpoint under the old reader identity', async (t) => {
  for (const change of ['device', 'generation'] as const) await t.test(change, async (t) => {
    const env = await setup(t);
    const preceding = env.store.update(env.scope, (current) => ({ ...current!, sync: change === 'device'
      ? rebindDevice(current!.sync, crypto.randomUUID()) : resumeAfterRestart(current!.sync) }));
    env.writer.record({ pageIndex: 3, offsetRatio: 0 });
    const rejected = assert.rejects(env.writer.flush(), controlled('ACCOUNT_CHANGED'));
    const latest = await preceding; await rejected;
    assert.equal(env.saves(), 1);
    assert.equal(env.allocatedOpIds(), 0);
    assert.deepEqual(await env.store.read(env.scope), latest);
  });
});

test('an account replacement rejects the queued old checkpoint without writing either account', async (t) => {
  const env = await setup(t); const before = await env.store.read(env.scope);
  env.writer.record({ pageIndex: 3, offsetRatio: 0 });
  const saving = env.writer.flush();
  const rejected = assert.rejects(saving, controlled('ACCOUNT_CHANGED'));
  env.controller.deactivate(); env.binding.accountId = crypto.randomUUID(); env.binding.key = 'replacement-subject';
  await env.controller.bind('Replacement'); await rejected;
  assert.deepEqual(await env.store.read(env.scope), before);
  assert.equal(env.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.equal(env.allocatedOpIds(), 0);
  assert.equal(env.statuses.includes('saved'), false);
});
