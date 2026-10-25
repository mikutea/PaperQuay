import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { PostgresSyncStore } from '../../src/store.ts';
import type { VerifiedIdentity } from '../../src/auth.ts';
import type { ResolveRequest, SessionView } from '../../src/types.ts';
import type { EntityDataMap, PushResult, SyncOperation } from '../../../packages/sync-core/src/index.ts';
import { identity, operation, paper } from '../fixtures.ts';

const databaseUrl = process.env.PAPERQUAY_DATABASE_URL;
if (!databaseUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1') {
  throw new Error('Set PAPERQUAY_DATABASE_URL to an isolated migrated database and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const store = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 53) });
before(async () => { assert.equal(await store.ready(), true, 'Apply all migrations and runtime grants before integration tests.'); });
after(async () => { await pool.end(); });

async function session() {
  const who = identity();
  const view = await store.registerDevice(who, { name: 'Synthetic restoration session', platform: 'web' });
  const peerIdentity = { ...who, sessionId: randomUUID() };
  const peerView = await store.registerDevice(peerIdentity, { name: 'Synthetic competing session', platform: 'web' });
  return { who, view, peerIdentity, peerView };
}

async function push(who: VerifiedIdentity, view: SessionView, op: SyncOperation): Promise<PushResult> {
  return (await store.push(who, { protocolVersion: 1, deviceId: view.device.id, operations: [op] })).results[0];
}

for (const entityType of ['paper', 'note'] as const) {
  test(`a competing ${entityType} restore can explicitly adopt the local version after the current record is live`, async () => {
    const { who, view, peerIdentity, peerView } = await session();
    const baseData = (entityType === 'paper' ? paper('Original paper') :
      { paperId: null, title: 'Original note', body: 'Original body', format: 'markdown' }) as EntityDataMap[typeof entityType];
    const localData = (entityType === 'paper' ? { ...paper('Local restored paper'), authors: ['Local author'], keywords: ['local'], abstractText: 'Local abstract' } :
      { paperId: null, title: 'Local restored note', body: 'Local restored body', format: 'markdown' }) as EntityDataMap[typeof entityType];
    const initial = operation(entityType, baseData);
    assert.equal((await push(who, view, initial)).status, 'applied');
    const deleted = await push(who, view, operation(entityType, null, { entityId: initial.entityId, mutation: 'delete', baseRevision: 1 }));
    assert.equal(deleted.record?.revision, 2);
    assert.ok(deleted.record?.deletedAt);

    const localRestore = operation(entityType, localData, { entityId: initial.entityId, mutation: 'restore', baseRevision: 2 });
    const peerRestore = operation(entityType, baseData, { entityId: initial.entityId, mutation: 'restore', baseRevision: 2 });
    assert.equal((await push(peerIdentity, peerView, peerRestore)).record?.revision, 3);
    const conflict = await push(who, view, localRestore);
    assert.equal(conflict.status, 'conflict');
    assert.ok(conflict.conflictId);
    const [reviewed] = (await store.listConflicts(who, undefined, 100)).conflicts;
    assert.equal(reviewed.currentRecord.deletedAt, null);
    assert.equal(reviewed.currentRecord.revision, 3);
    assert.deepEqual(reviewed.attemptedOperation, localRestore);

    // Replaying the original restore intent cannot write an already live entity.
    const oldChoice = await store.resolveConflict(who, conflict.conflictId, { opId: randomUUID(), expectedRevision: 3, choice: 'attempted' });
    assert.equal(oldChoice.code, 'ENTITY_NOT_DELETED');
    assert.equal((await store.listConflicts(who, undefined, 100)).conflicts.length, 1);
    const choice: ResolveRequest = { opId: randomUUID(), expectedRevision: reviewed.currentRecord.revision,
      choice: 'merged', mutation: 'put', data: localData };
    const result = await store.resolveConflict(who, conflict.conflictId, choice);
    assert.equal(result.status, 'applied');
    assert.equal(result.record?.revision, 4);
    assert.equal(result.record?.deletedAt, null);
    assert.deepEqual(result.record?.data, localData);
    assert.equal((await store.listConflicts(who, undefined, 100)).conflicts.length, 0);
    const replay = await store.resolveConflict(who, conflict.conflictId, choice);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.record, result.record);
    assert.deepEqual((await store.pull(peerIdentity, undefined, 100)).records.at(-1), result.record);
  });
}

test('a reviewed live restore conflict rechecks CAS if another device deletes it before the choice arrives', async () => {
  const { who, view, peerIdentity, peerView } = await session();
  const initial = operation('paper', paper('Original'));
  await push(who, view, initial);
  await push(who, view, operation('paper', null, { entityId: initial.entityId, mutation: 'delete', baseRevision: 1 }));
  const localRestore = operation('paper', paper('Local complete restored value'), { entityId: initial.entityId, mutation: 'restore', baseRevision: 2 });
  await push(peerIdentity, peerView, operation('paper', paper('Peer restore'), { entityId: initial.entityId, mutation: 'restore', baseRevision: 2 }));
  const conflict = await push(who, view, localRestore);
  assert.ok(conflict.conflictId);
  const deletedAgain = await push(peerIdentity, peerView, operation('paper', null, { entityId: initial.entityId, mutation: 'delete', baseRevision: 3 }));
  assert.equal(deletedAgain.record?.revision, 4);
  const staleChoice = await store.resolveConflict(who, conflict.conflictId, { opId: randomUUID(), expectedRevision: 3,
    choice: 'merged', mutation: 'put', data: localRestore.data });
  assert.equal(staleChoice.status, 'conflict');
  assert.deepEqual(staleChoice.record, deletedAgain.record);
  assert.equal((await store.listConflicts(who, undefined, 100)).conflicts.length, 1);
  // After reviewing the tombstone, the explicit restore intent is still valid.
  const restored = await store.resolveConflict(who, conflict.conflictId, { opId: randomUUID(), expectedRevision: 4, choice: 'attempted' });
  assert.equal(restored.status, 'applied');
  assert.equal(restored.record?.revision, 5);
  assert.equal(restored.record?.deletedAt, null);
  assert.deepEqual(restored.record?.data, localRestore.data);
});

test('a note attempted before its new paper can retry after the paper is created and tombstoned, then unlink', async () => {
  const { who, view } = await session();
  const parent = operation('paper', paper('Locally cancelled paper'));
  const note = operation('note', { paperId: parent.entityId, title: 'Preserved linked note', body: 'Offline body', format: 'markdown' });
  const deferred = await push(who, view, note);
  assert.equal(deferred.code, 'DEPENDENCY_NOT_READY');
  assert.equal(deferred.retryable, true);
  assert.equal((await push(who, view, parent)).status, 'applied');
  const tombstone = await push(who, view, operation('paper', null, { entityId: parent.entityId, mutation: 'delete', baseRevision: 1 }));
  assert.ok(tombstone.record?.deletedAt);
  const exactRetry = await push(who, view, note);
  assert.equal(exactRetry.status, 'applied');
  assert.equal(exactRetry.replayed, false);
  assert.deepEqual(exactRetry.record?.data, note.data);
  assert.equal((await push(who, view, note)).replayed, true);
  const unlink = operation('note', { ...note.data!, paperId: null, body: 'Latest local overlay survives' },
    { entityId: note.entityId, baseRevision: exactRetry.record!.revision });
  const saved = await push(who, view, unlink);
  assert.equal(saved.status, 'applied');
  assert.deepEqual(saved.record?.data, unlink.data);
  const records = (await store.pull(who, undefined, 100)).records;
  assert.deepEqual(records.at(-1), saved.record);
  assert.equal(records.filter((record) => record.entityType === 'paper').at(-1)?.deletedAt, tombstone.record?.deletedAt);
});
