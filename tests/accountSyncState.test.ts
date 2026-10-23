import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyConflictResolution, applyPullPage, applyPushResults, canonicalJson, createAccountState,
  entityKey, getSyncContext, getVisibleEntity, listVisibleEntities, markPushUncertain,
  preparePush, queueLocalEdit, rebindDevice, resumeAfterRestart, validateClientState,
} from '../packages/sync-core/src/index.ts';
import type { AccountSyncState, LocalEdit, NoteData, PushResult, ReadingPositionData, SyncRecord } from '../packages/sync-core/src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-24T06:00:00.000Z';
const account = id(1), device = id(2), noteId = id(3), readingId = id(4), conflictId = id(5);
const note = (body: string): NoteData => ({ paperId: null, title: 'Note', body, format: 'markdown' });
const edit = (body: string, entityId = noteId): LocalEdit => ({ entityType: 'note', entityId, mutation: 'put', data: note(body) });
const identity = (n: number) => ({ opId: id(n), clientCreatedAt: at });
const record = (revision: number, body = `remote-${revision}`, entityId = noteId): SyncRecord<'note'> => ({ entityType: 'note', entityId, schemaVersion: 1, revision, deletedAt: null, updatedAt: at, modifiedByDeviceId: device, data: note(body) });
const reading: ReadingPositionData = { paperId: id(7), attachmentVersionId: id(8), pageIndex: 2, offsetRatio: 0.2, furthestPageIndex: 2, furthestOffsetRatio: 0.2, sessionId: id(9), deviceSequence: 1, observedAt: at };
const initial = () => createAccountState(account, device);
function receive(state: AccountSyncState, records: SyncRecord[], cursor = 'cursor-1'): AccountSyncState {
  return applyPullPage(state, getSyncContext(state), { fromCursor: state.cursor, response: { protocolVersion: 1, records, nextCursor: cursor, hasMore: false } });
}
function reply(state: AccountSyncState, result: PushResult): AccountSyncState {
  return applyPushResults(state, getSyncContext(state), { protocolVersion: 1, results: [result] }, [result.opId]);
}
function send(state: AccountSyncState) { return preparePush(state, getSyncContext(state)); }
function visibleBody(state: AccountSyncState): string | undefined { return (getVisibleEntity(state, 'note', noteId)?.data as NoteData | null)?.body; }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function conflicted(): AccountSyncState {
  const prepared = send(queueLocalEdit(receive(initial(), [record(1)]), edit('local-attempt'), identity(20)));
  return reply(prepared.state, { opId: id(20), status: 'conflict', replayed: false, conflictId, record: record(2, 'other-device') });
}

test('unsent edits coalesce immutably and an unsent create-delete cancels without a tombstone', () => {
  const empty = freeze(initial());
  const first = freeze(queueLocalEdit(empty, edit('draft-1'), identity(20)));
  const latest = queueLocalEdit(first, edit('draft-2'), identity(21));
  assert.equal((first.outbox[0].operation.data as NoteData).body, 'draft-1');
  assert.equal(latest.outbox.length, 1);
  assert.equal(latest.outbox[0].operation.opId, id(21));
  assert.equal(visibleBody(latest), 'draft-2');
  assert.equal(getVisibleEntity(latest, 'note', noteId)?.pending, true);
  assert.deepEqual(queueLocalEdit(latest, edit('draft-2'), identity(21)), latest);
  assert.throws(() => queueLocalEdit(latest, edit('different'), identity(21)), /OP_ID_REUSED/);
  const canceled = queueLocalEdit(latest, { entityType: 'note', entityId: noteId, mutation: 'delete', data: null }, identity(22));
  assert.equal(canceled.outbox.length, 0);
  assert.equal(getVisibleEntity(canceled, 'note', noteId), null);
  assert.equal(empty.outbox.length, 0);
});

test('an acknowledgement never overwrites the edit made while its request was in flight', () => {
  const prepared = send(queueLocalEdit(initial(), edit('sent'), identity(20)));
  const later = freeze(queueLocalEdit(prepared.state, edit('typed-during-send'), identity(21)));
  const next = reply(later, { opId: id(20), status: 'applied', replayed: false, record: record(1, 'sent') });
  assert.equal(visibleBody(next), 'typed-during-send');
  assert.equal(next.outbox.length, 1);
  assert.equal(next.outbox[0].operation.opId, id(21));
  assert.equal(next.outbox[0].operation.baseRevision, 1);
  assert.equal(next.outbox[0].attempts, 0);
  assert.deepEqual(next.overlays, {});
  assert.equal(next.cursor, null);
  assert.equal(visibleBody(later), 'typed-during-send');
  const duplicateAck = reply(next, { opId: id(20), status: 'applied', replayed: true, record: record(1, 'sent') });
  assert.deepEqual(duplicateAck, next);
});

test('a newer pull before an acknowledgement cannot silently rebase an unseen local edit', () => {
  const prepared = send(queueLocalEdit(receive(initial(), [record(1)]), edit('sent-at-1'), identity(20)));
  let state = queueLocalEdit(prepared.state, edit('later-local'), identity(21));
  state = receive(state, [record(3, 'other-device-at-3')], 'cursor-3');
  state = reply(state, { opId: id(20), status: 'applied', replayed: false, record: record(2, 'sent-at-1') });
  assert.equal(state.serverRecords[entityKey('note', noteId)].revision, 3);
  assert.equal(state.outbox[0].operation.baseRevision, 2);
  assert.equal(visibleBody(state), 'later-local');
  assert.equal(state.cursor, 'cursor-3');
});

test('lost responses and process restarts replay exactly the same operation before newer edits', () => {
  const prepared = send(queueLocalEdit(initial(), edit('first'), identity(20)));
  const oldContext = getSyncContext(prepared.state);
  let state = queueLocalEdit(prepared.state, edit('newest'), identity(21));
  state = markPushUncertain(state, oldContext, prepared.opIds, 'NETWORK_ERROR');
  state = resumeAfterRestart(JSON.parse(JSON.stringify(state)) as AccountSyncState);
  const replay = send(state);
  assert.equal(canonicalJson(replay.request), canonicalJson(prepared.request));
  assert.equal(visibleBody(replay.state), 'newest');
  assert.equal(replay.state.outbox[0].attempts, 2);
  assert.throws(() => applyPushResults(replay.state, oldContext, { protocolVersion: 1, results: [] }), /IDENTITY_CHANGED/);
  const applied = reply(replay.state, { opId: id(20), status: 'applied', replayed: true, record: record(1, 'first') });
  assert.equal(applied.outbox[0].operation.opId, id(21));
  assert.equal(visibleBody(applied), 'newest');
  assert.equal(validateClientState(applied).ok, true);
});

test('retryable dependency errors keep the original operation and its newer overlay', () => {
  const prepared = send(queueLocalEdit(initial(), edit('blocked-create'), identity(20)));
  const state = queueLocalEdit(prepared.state, edit('later-edit'), identity(21));
  const deferred = reply(state, { opId: id(20), status: 'rejected', replayed: false, code: 'DEPENDENCY_PENDING', retryable: true });
  assert.equal(deferred.outbox[0].status, 'queued');
  assert.equal(visibleBody(deferred), 'later-edit');
  const retry = send(deferred);
  assert.equal(canonicalJson(retry.request), canonicalJson(prepared.request));
  assert.equal((retry.request.operations[0].data as NoteData).body, 'blocked-create');
});

test('permanent rejection stays visible for recovery and cannot turn into a changed receipt', () => {
  const prepared = send(queueLocalEdit(initial(), edit('recover-me'), identity(20)));
  const rejected = reply(prepared.state, { opId: id(20), status: 'rejected', replayed: false, code: 'INVALID_REFERENCE', retryable: false });
  assert.equal(getVisibleEntity(rejected, 'note', noteId)?.status, 'rejected');
  assert.equal(visibleBody(rejected), 'recover-me');
  assert.equal(send(rejected).opIds.length, 0);
  assert.throws(() => reply(rejected, { opId: id(20), status: 'rejected', replayed: true, code: 'DEPENDENCY_PENDING', retryable: true }), /RECEIPT_CHANGED/);
});

test('a replayed conflict preserves both attempted content and the latest local overlay', () => {
  const first = conflicted();
  const latest = queueLocalEdit(first, edit('new-local-after-conflict'), identity(21));
  const replay = reply(latest, { opId: id(20), status: 'conflict', replayed: true, conflictId, record: record(2, 'other-device') });
  assert.equal(replay.outbox[0].status, 'conflict');
  assert.equal((replay.conflicts[conflictId].attempted.data as NoteData).body, 'local-attempt');
  assert.equal(visibleBody(replay), 'new-local-after-conflict');
  assert.equal(send(replay).opIds.length, 0);
  assert.throws(() => reply(replay, { opId: id(20), status: 'conflict', replayed: true, conflictId: id(6), record: record(2, 'other-device') }), /RECEIPT_CHANGED/);
});

test('conflict resolution consumes only the edit explicitly included in the saved request', () => {
  const chosen = queueLocalEdit(conflicted(), edit('chosen-for-merge'), identity(21));
  const later = queueLocalEdit(chosen, edit('typed-during-resolution'), identity(22));
  const resolved = applyConflictResolution(later, getSyncContext(later), { conflictId, record: record(3, 'chosen-for-merge'), consumedOverlayOpId: id(21) });
  assert.equal(visibleBody(resolved), 'typed-during-resolution');
  assert.equal(resolved.outbox[0].operation.opId, id(22));
  assert.equal(resolved.outbox[0].operation.baseRevision, 3);
  assert.deepEqual(resolved.conflicts, {});
  const exact = applyConflictResolution(chosen, getSyncContext(chosen), { conflictId, record: record(3, 'chosen-for-merge'), consumedOverlayOpId: id(21) });
  assert.equal(exact.outbox.length, 0);
  assert.equal(visibleBody(exact), 'chosen-for-merge');
});

test('resolving a conflict with no server record preserves a newer independently pulled mirror', () => {
  const prepared = send(queueLocalEdit(initial(), edit('local-create'), identity(20)));
  let state = reply(prepared.state, { opId: id(20), status: 'conflict', replayed: false, conflictId });
  state = queueLocalEdit(state, edit('newer-local'), identity(21));
  state = receive(state, [record(2, 'newer-remote')], 'cursor-newer');
  const resolved = applyConflictResolution(state, getSyncContext(state), { conflictId, record: null });
  assert.equal(resolved.serverRecords[entityKey('note', noteId)].revision, 2);
  assert.equal(resolved.outbox[0].operation.baseRevision, 0);
  assert.equal(visibleBody(resolved), 'newer-local');
});

test('invalid pull pages leave mirror and cursor unchanged and stale pages cannot rewind progress', () => {
  const state = freeze(receive(initial(), [record(1)], 'cursor-1'));
  const before = canonicalJson(state);
  assert.throws(() => receive(state, [record(2), { ...record(3, 'bad', id(50)), revision: 0 }], 'cursor-2'), /INVALID_PULL_RESPONSE/);
  assert.equal(canonicalJson(state), before);
  assert.throws(() => applyPullPage(state, getSyncContext(state), { fromCursor: null, response: { protocolVersion: 1, records: [], nextCursor: null, hasMore: false } }), /STALE_PULL_CURSOR/);
  assert.throws(() => applyPullPage(state, getSyncContext(state), { fromCursor: 'cursor-1', response: { protocolVersion: 1, records: [], nextCursor: 'cursor-1', hasMore: true } }), /INVALID_PULL_RESPONSE/);
  assert.throws(() => receive(state, [record(1, 'changed-same-revision')]), /REVISION_COLLISION/);
  const progressed = receive(state, [record(2)], 'cursor-2');
  assert.equal(progressed.cursor, 'cursor-2');
  assert.equal(visibleBody(progressed), 'remote-2');
  assert.equal(canonicalJson(state), before);
});

test('invalid or incomplete acknowledgements are atomic and cannot acknowledge unsent edits', () => {
  const queued = queueLocalEdit(initial(), edit('draft'), identity(20));
  assert.throws(() => reply(queued, { opId: id(20), status: 'applied', replayed: false, record: record(1) }), /UNSENT_ACKNOWLEDGEMENT/);
  const prepared = send(queueLocalEdit(queued, edit('another', id(50)), identity(21)));
  const before = canonicalJson(prepared.state);
  assert.throws(() => applyPushResults(prepared.state, prepared.context, { protocolVersion: 1, results: [{ opId: id(20), status: 'applied', replayed: false, record: record(1) }] }, prepared.opIds), /INCOMPLETE_PUSH_RESPONSE/);
  assert.throws(() => applyPushResults(prepared.state, prepared.context, { protocolVersion: 1, results: [
    { opId: id(20), status: 'applied', replayed: false, record: record(1) },
    { opId: id(21), status: 'applied', replayed: false },
  ] }, prepared.opIds), /INVALID_APPLIED_RECORD/);
  assert.equal(canonicalJson(prepared.state), before);
  assert.throws(() => reply(prepared.state, { opId: id(20), status: 'applied', replayed: false, record: record(1, 'wrong', id(99)) }), /MISMATCHED_ACKNOWLEDGEMENT/);
});

test('account, device and runtime-generation scopes reject late callbacks', () => {
  const prepared = send(queueLocalEdit(initial(), edit('account-A'), identity(20)));
  const otherAccount = createAccountState(id(100), device);
  const response = { protocolVersion: 1 as const, results: [{ opId: id(20), status: 'applied' as const, replayed: false, record: record(1) }] };
  for (const other of [otherAccount, resumeAfterRestart(prepared.state), rebindDevice(prepared.state, id(101))]) {
    assert.throws(() => applyPushResults(other, prepared.context, response), /IDENTITY_CHANGED/);
    assert.throws(() => markPushUncertain(other, prepared.context, prepared.opIds), /IDENTITY_CHANGED/);
    assert.throws(() => applyPullPage(other, prepared.context, { fromCursor: null, response: { protocolVersion: 1, records: [record(1)], nextCursor: 'wrong-account', hasMore: false } }), /IDENTITY_CHANGED/);
  }
  assert.equal(otherAccount.outbox.length, 0);
  assert.equal(otherAccount.cursor, null);
});

test('new device sessions preserve ordinary pending edits but block another device reading checkpoint', () => {
  let state = queueLocalEdit(initial(), edit('saved-note'), identity(20));
  state = queueLocalEdit(state, { entityType: 'readingPosition', entityId: readingId, mutation: 'put', data: reading }, identity(21));
  const original = send(state);
  const rebound = rebindDevice(original.state, id(100));
  const pending = rebound.outbox.find((entry) => entry.operation.entityType === 'readingPosition')!;
  assert.equal(pending.status, 'device-blocked');
  assert.equal(pending.errorCode, 'DEVICE_CHANGED');
  assert.equal(getVisibleEntity(rebound, 'readingPosition', readingId)?.pending, true);
  const resumed = send(rebound);
  assert.deepEqual(resumed.opIds, [id(20)]);
  assert.equal(resumed.request.deviceId, id(100));
  assert.equal(resumed.request.operations[0].opId, id(20));
  const restored = rebindDevice(rebound, device);
  assert.equal(restored.outbox.find((entry) => entry.operation.entityType === 'readingPosition')?.status, 'uncertain');
});

test('tombstones require explicit restore and keep old offline edits pending for conflict handling', () => {
  const tombstone = { ...record(2), deletedAt: at, data: null };
  const deleted = receive(initial(), [tombstone]);
  assert.throws(() => queueLocalEdit(deleted, edit('accidental-resurrection'), identity(20)), /RESTORE_REQUIRED/);
  const restored = queueLocalEdit(deleted, { ...edit('explicit-restore'), mutation: 'restore' }, identity(21));
  assert.equal(restored.outbox[0].operation.baseRevision, 2);
  assert.equal(getVisibleEntity(restored, 'note', noteId)?.deleted, false);
  assert.throws(() => queueLocalEdit(initial(), { ...edit('no-tombstone'), mutation: 'restore' }, identity(22)), /NO_TOMBSTONE/);
  let offline = queueLocalEdit(receive(initial(), [record(1)]), edit('offline-edit'), identity(23));
  offline = receive(offline, [tombstone], 'cursor-2');
  assert.equal(offline.outbox[0].operation.baseRevision, 1);
  assert.equal(visibleBody(offline), 'offline-edit');
});

test('a repeated delete accepts only a compatible same-revision tombstone acknowledgement', () => {
  const tombstone: SyncRecord<'note'> = { ...record(2), deletedAt: at, data: null };
  const deletion: LocalEdit = { entityType: 'note', entityId: noteId, mutation: 'delete', data: null };
  const prepared = send(queueLocalEdit(receive(initial(), [tombstone]), deletion, identity(20)));
  const accepted = reply(prepared.state, { opId: id(20), status: 'applied', replayed: false, record: tombstone });
  assert.equal(accepted.outbox.length, 0);
  assert.equal(accepted.serverRecords[entityKey('note', noteId)].revision, 2);
  assert.equal(getVisibleEntity(accepted, 'note', noteId)?.deleted, true);
  assert.throws(() => reply(prepared.state, { opId: id(20), status: 'applied', replayed: true,
    record: { ...tombstone, deletedAt: '2026-10-24T07:00:00.000Z' } }), /REVISION_COLLISION/);
  assert.throws(() => reply({ ...prepared.state, serverRecords: {} }, { opId: id(20), status: 'applied', replayed: false, record: tombstone }), /INVALID_APPLIED_RECORD/);
  const live = send(queueLocalEdit(receive(initial(), [record(2)]), deletion, identity(21)));
  assert.throws(() => reply(live.state, { opId: id(21), status: 'applied', replayed: false, record: tombstone }), /REVISION_COLLISION/);
  const update = send(queueLocalEdit(receive(initial(), [record(2)]), edit('edit'), identity(22)));
  assert.throws(() => reply(update.state, { opId: id(22), status: 'applied', replayed: false, record: record(2) }), /INVALID_APPLIED_RECORD/);
});

test('persisted state validation rejects extra secrets, mismatched keys, duplicate operations, and orphan overlays', () => {
  const state = queueLocalEdit(initial(), edit('draft'), identity(20));
  assert.equal(validateClientState(JSON.parse(JSON.stringify(state))).ok, true);
  assert.equal(validateClientState({ ...state, accessToken: 'PRIVATE' }).ok, false);
  assert.equal(validateClientState({ ...state, serverRecords: { wrong: record(1) } }).ok, false);
  assert.equal(validateClientState({ ...state, outbox: [state.outbox[0], state.outbox[0]] }).ok, false);
  const overlay = { ...edit('orphan'), ...identity(21) };
  assert.equal(validateClientState({ ...initial(), overlays: { [entityKey('note', noteId)]: overlay } }).ok, false);
  assert.equal(validateClientState({ ...state, outbox: [{ ...state.outbox[0], status: 'sending' }] }).ok, false);
  const visible = listVisibleEntities(state, 'note');
  assert.equal(visible.length, 1);
  (visible[0].data as NoteData).body = 'external-mutation';
  assert.equal(visibleBody(state), 'draft');
});
