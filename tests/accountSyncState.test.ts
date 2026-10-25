import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyConflictResolution, applyRemoteConflictResolution, applyPullPage, applyPushResults, canonicalJson, createAccountState,
  entityKey, getSyncContext, getVisibleEntity, listVisibleEntities, markPushUncertain,
  preparePush, queueLocalEdit, rebindDevice, resumeAfterRestart, validateClientState,
} from '../packages/sync-core/src/index.ts';
import type { AccountSyncState, LocalEdit, NoteData, PaperData, PushResult, ReadingPositionData, SyncRecord } from '../packages/sync-core/src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-24T06:00:00.000Z';
const account = id(1), device = id(2), noteId = id(3), readingId = id(4), conflictId = id(5);
const note = (body: string): NoteData => ({ paperId: null, title: 'Note', body, format: 'markdown' });
const edit = (body: string, entityId = noteId): LocalEdit => ({ entityType: 'note', entityId, mutation: 'put', data: note(body) });
const identity = (n: number) => ({ opId: id(n), clientCreatedAt: at });
const record = (revision: number, body = `remote-${revision}`, entityId = noteId): SyncRecord<'note'> => ({ entityType: 'note', entityId, schemaVersion: 1, revision, deletedAt: null, updatedAt: at, modifiedByDeviceId: device, data: note(body) });
const reading: ReadingPositionData = { paperId: id(7), attachmentVersionId: id(8), pageIndex: 2, offsetRatio: 0.2, furthestPageIndex: 2, furthestOffsetRatio: 0.2, sessionId: id(9), deviceSequence: 1, observedAt: at };
const paperId = id(7);
const paper = (title = 'Offline paper'): PaperData => ({ title, doi: null, year: null, publication: null, abstractText: null, authors: [], keywords: [] });
const paperEdit = (title = 'Offline paper'): LocalEdit => ({ entityType: 'paper', entityId: paperId, mutation: 'put', data: paper(title) });
const paperDelete: LocalEdit = { entityType: 'paper', entityId: paperId, mutation: 'delete', data: null };
const paperRecord = (revision: number, deleted = false): SyncRecord<'paper'> => ({ entityType: 'paper', entityId: paperId,
  schemaVersion: 1, revision, deletedAt: deleted ? at : null, updatedAt: at, modifiedByDeviceId: device, data: deleted ? null : paper() });
const linkedEdit = (body: string, entityId = noteId): LocalEdit => ({ entityType: 'note', entityId, mutation: 'put', data: { ...note(body), paperId } });
const initial = () => createAccountState(account, device);
function receive(state: AccountSyncState, records: SyncRecord[], cursor = 'cursor-1'): AccountSyncState {
  return applyPullPage(state, getSyncContext(state), { fromCursor: state.cursor, response: { protocolVersion: 1, records, nextCursor: cursor, hasMore: false } });
}
function reply(state: AccountSyncState, result: PushResult): AccountSyncState {
  return applyPushResults(state, getSyncContext(state), { protocolVersion: 1, results: [result] }, [result.opId]);
}
function send(state: AccountSyncState) { return preparePush(state, getSyncContext(state)); }
function sendOne(state: AccountSyncState, opId: string) {
  const entry = state.outbox.find((candidate) => candidate.operation.opId === opId);
  assert.ok(entry, 'The expected pending operation must remain available to send.');
  return preparePush({ ...state, outbox: [entry, ...state.outbox.filter((candidate) => candidate !== entry)] }, getSyncContext(state), 1);
}
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

test('deleting an unsent paper retains its creation and tombstone while multiple linked notes finish syncing', () => {
  let state = queueLocalEdit(initial(), paperEdit(), identity(20));
  state = queueLocalEdit(state, linkedEdit('First note'), identity(21));
  state = freeze(queueLocalEdit(state, linkedEdit('Second note', id(50)), identity(22)));
  const before = canonicalJson(state);
  const originalCreate = canonicalJson(state.outbox[0].operation);
  let deleted = queueLocalEdit(state, paperDelete, identity(23));
  assert.deepEqual(deleted.outbox.map((entry) => entry.operation.opId), [id(20), id(21), id(22)]);
  assert.equal(canonicalJson(deleted.outbox[0].operation), originalCreate);
  assert.equal(deleted.overlays[entityKey('paper', paperId)].opId, id(23));
  assert.equal(getVisibleEntity(deleted, 'paper', paperId)?.deleted, true);
  assert.equal(visibleBody(deleted), 'First note');
  assert.equal(canonicalJson(state), before);
  assert.deepEqual(queueLocalEdit(deleted, paperDelete, identity(23)), deleted);
  deleted = resumeAfterRestart(JSON.parse(JSON.stringify(deleted)) as AccountSyncState);

  let prepared = sendOne(deleted, id(20));
  let synced = reply(prepared.state, { opId: id(20), status: 'applied', replayed: false, record: paperRecord(1) });
  const removal = synced.outbox.find((entry) => entry.operation.opId === id(23))!;
  assert.equal(removal.operation.mutation, 'delete');
  assert.equal(removal.operation.baseRevision, 1);
  // Notes deliberately remain valid even if the paper tombstone reaches the service first.
  prepared = sendOne(synced, id(23));
  synced = reply(prepared.state, { opId: id(23), status: 'applied', replayed: false, record: paperRecord(2, true) });
  for (const [opNumber, entityId, body] of [[21, noteId, 'First note'], [22, id(50), 'Second note']] as const) {
    prepared = sendOne(synced, id(opNumber));
    synced = reply(prepared.state, { opId: id(opNumber), status: 'applied', replayed: false,
      record: { ...record(1, body, entityId), data: { ...note(body), paperId } } });
    assert.equal((getVisibleEntity(synced, 'note', entityId)?.data as NoteData).body, body);
  }
  assert.equal(synced.outbox.length, 0);
  assert.equal(getVisibleEntity(synced, 'paper', paperId)?.deleted, true);
  assert.equal(validateClientState(synced).ok, true);
});

test('a tried linked note retains its original dependency despite unlink overlays, paper deletion and restarts', () => {
  for (const deleteBeforeAttempt of [false, true]) {
    let state = queueLocalEdit(initial(), linkedEdit('Already attempted'), identity(21));
    state = queueLocalEdit(state, paperEdit(), identity(20));
    if (deleteBeforeAttempt) state = queueLocalEdit(state, paperDelete, identity(23));
    const attempted = sendOne(state, id(21));
    const originalOperation = canonicalJson(attempted.request.operations[0]);
    const variants = [
      attempted.state,
      markPushUncertain(attempted.state, attempted.context, attempted.opIds),
      reply(attempted.state, { opId: id(21), status: 'rejected', replayed: false, code: 'DEPENDENCY_NOT_READY', retryable: true }),
    ];
    for (const variant of variants) {
      let local = queueLocalEdit(variant, edit('Unlinked newer draft'), identity(22));
      local = queueLocalEdit(freeze(local), paperDelete, identity(23));
      assert.ok(local.outbox.some((entry) => entry.operation.opId === id(20)), 'The original attempted note still needs this paper even when its latest overlay is unlinked.');
      assert.equal(canonicalJson(local.outbox.find((entry) => entry.operation.opId === id(21))!.operation), originalOperation);
      assert.equal((local.overlays[entityKey('note', noteId)].data as NoteData).paperId, null);
      local = resumeAfterRestart(JSON.parse(JSON.stringify(local)) as AccountSyncState);
      local = queueLocalEdit(local, edit('Newest draft after restart'), identity(24));

      let prepared = sendOne(local, id(20));
      local = reply(prepared.state, { opId: id(20), status: 'applied', replayed: false, record: paperRecord(1) });
      prepared = sendOne(local, id(23));
      local = reply(prepared.state, { opId: id(23), status: 'applied', replayed: false, record: paperRecord(2, true) });
      prepared = sendOne(local, id(21));
      assert.equal(canonicalJson(prepared.request.operations[0]), originalOperation);
      local = reply(prepared.state, { opId: id(21), status: 'applied', replayed: false,
        record: { ...record(1, 'Already attempted'), data: { ...note('Already attempted'), paperId } } });
      assert.equal(local.outbox[0].operation.opId, id(24));
      assert.equal(local.outbox[0].operation.baseRevision, 1);
      assert.equal((local.outbox[0].operation.data as NoteData).paperId, null);
      assert.equal(visibleBody(local), 'Newest draft after restart');
      prepared = sendOne(local, id(24));
      local = reply(prepared.state, { opId: id(24), status: 'applied', replayed: false, record: record(2, 'Newest draft after restart') });
      assert.equal(local.outbox.length, 0);
      assert.equal(visibleBody(local), 'Newest draft after restart');
      assert.equal(validateClientState(local).ok, true);
    }
  }
});

test('a linked note overlay alone keeps its unsent paper dependency and uses the original note acknowledgement revision', () => {
  let state = queueLocalEdit(receive(initial(), [record(1, 'Unlinked server note')]), edit('Unlinked in-flight edit'), identity(21));
  state = sendOne(state, id(21)).state;
  state = queueLocalEdit(state, paperEdit(), identity(20));
  state = queueLocalEdit(state, linkedEdit('New linked draft'), identity(22));
  state = queueLocalEdit(state, paperDelete, identity(23));
  assert.ok(state.outbox.some((entry) => entry.operation.opId === id(20)));
  assert.equal((state.overlays[entityKey('note', noteId)].data as NoteData).paperId, paperId);
  state = receive(state, [record(3, 'Newer remote note')], 'cursor-3');
  state = reply(state, { opId: id(21), status: 'applied', replayed: false, record: record(2, 'Unlinked in-flight edit') });
  const linked = state.outbox.find((entry) => entry.operation.opId === id(22))!;
  assert.equal(linked.operation.baseRevision, 2, 'The dependent overlay must not be silently rebased to a newer pull.');
  assert.equal((linked.operation.data as NoteData).paperId, paperId);
  assert.equal(state.serverRecords[entityKey('note', noteId)].revision, 3);
  assert.equal(visibleBody(state), 'New linked draft');
  assert.equal(validateClientState(state).ok, true);
});

test('new edits supersede a retained unsent create-delete sequence and unused paper creations still cancel', () => {
  const unreferenced = queueLocalEdit(queueLocalEdit(initial(), paperEdit(), identity(20)), paperDelete, identity(23));
  assert.equal(unreferenced.outbox.length, 0);
  assert.equal(getVisibleEntity(unreferenced, 'paper', paperId), null);
  let state = queueLocalEdit(initial(), paperEdit(), identity(20));
  state = queueLocalEdit(state, linkedEdit('Linked draft'), identity(21));
  state = queueLocalEdit(state, paperDelete, identity(23));
  assert.equal(getVisibleEntity(state, 'paper', paperId)?.deleted, true);
  state = queueLocalEdit(state, paperEdit('Kept and edited before sync'), identity(24));
  assert.equal(getVisibleEntity(state, 'paper', paperId)?.deleted, false);
  assert.equal(state.overlays[entityKey('paper', paperId)], undefined);
  assert.equal(state.outbox.find((entry) => entry.operation.entityType === 'paper')!.operation.opId, id(24));
  state = queueLocalEdit(state, paperDelete, identity(25));
  assert.equal(state.overlays[entityKey('paper', paperId)].opId, id(25));
  state = queueLocalEdit(state, edit('Unlinked before either attempt'), identity(26));
  state = queueLocalEdit(state, paperDelete, identity(27));
  assert.deepEqual(state.outbox.map((entry) => entry.operation.opId), [id(26)]);
  assert.equal(state.overlays[entityKey('paper', paperId)], undefined);
  assert.equal(visibleBody(state), 'Unlinked before either attempt');
  assert.equal(getVisibleEntity(state, 'paper', paperId), null);
  assert.equal(validateClientState(state).ok, true);
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

test('remote resolution queues later local content against its original base and produces a real new conflict', () => {
  let state = queueLocalEdit(conflicted(), edit('local-after-conflict'), identity(21));
  state = receive(state, [record(3, 'remote-merge')], 'cursor-3');
  const before = freeze(state);
  state = applyRemoteConflictResolution(before, getSyncContext(before), { conflictId, record: record(3, 'remote-merge') });
  assert.equal(before.outbox[0].status, 'conflict');
  assert.equal(before.overlays[entityKey('note', noteId)].opId, id(21));
  assert.deepEqual(state.conflicts, {});
  assert.deepEqual(state.overlays, {});
  assert.equal(state.outbox[0].status, 'queued');
  assert.equal(state.outbox[0].operation.opId, id(21));
  assert.equal(state.outbox[0].operation.baseRevision, 1);
  assert.equal(visibleBody(state), 'local-after-conflict');
  assert.deepEqual(applyRemoteConflictResolution(state, getSyncContext(state), { conflictId, record: record(3, 'remote-merge') }), state);

  // An additional remote update after closure still cannot be adopted as this edit's CAS basis.
  state = receive(state, [record(4, 'another-remote-edit')], 'cursor-4');
  const pending = send(state);
  assert.equal(pending.request.operations[0].baseRevision, 1);
  assert.equal((pending.request.operations[0].data as NoteData).body, 'local-after-conflict');
  state = queueLocalEdit(pending.state, edit('typed-during-retry'), identity(22));
  state = reply(state, { opId: id(21), status: 'conflict', replayed: false, conflictId: id(6), record: record(4, 'another-remote-edit') });
  assert.equal(state.outbox[0].status, 'conflict');
  assert.equal(state.outbox[0].conflictId, id(6));
  assert.equal((state.conflicts[id(6)].attempted.data as NoteData).body, 'local-after-conflict');
  assert.equal((state.conflicts[id(6)].current?.data as NoteData).body, 'another-remote-edit');
  assert.equal(visibleBody(state), 'typed-during-retry');
  assert.equal(send(state).opIds.length, 0);
  assert.equal(validateClientState(state).ok, true);
});

test('remote closure without a later local edit clears normally and preserves a newer pulled mirror', () => {
  const state = receive(conflicted(), [record(4, 'newer-than-resolution')], 'cursor-4');
  const closed = applyRemoteConflictResolution(state, getSyncContext(state), { conflictId, record: record(3, 'remote-merge') });
  assert.equal(closed.outbox.length, 0);
  assert.deepEqual(closed.conflicts, {});
  assert.equal(visibleBody(closed), 'newer-than-resolution');
  assert.equal(closed.cursor, 'cursor-4');
  const absent = applyRemoteConflictResolution(state, getSyncContext(state), { conflictId, record: null });
  assert.equal(absent.outbox.length, 0);
  assert.equal(visibleBody(absent), 'newer-than-resolution');
  assert.throws(() => applyRemoteConflictResolution(state, getSyncContext(state), { conflictId, record: record(3, 'wrong-entity', id(99)) }), /MISMATCHED_CONFLICT_RESOLUTION/);
});

test('remote keep-current preserves delete intent without silently rebasing it onto the retained record', () => {
  const deletion: LocalEdit = { entityType: 'note', entityId: noteId, mutation: 'delete', data: null };
  const state = queueLocalEdit(conflicted(), deletion, identity(21));
  const closed = applyRemoteConflictResolution(state, getSyncContext(state), { conflictId, record: record(2, 'other-device') });
  assert.equal(closed.outbox[0].operation.mutation, 'delete');
  assert.equal(closed.outbox[0].operation.baseRevision, 1);
  assert.equal(getVisibleEntity(closed, 'note', noteId)?.deleted, true);
  const pending = send(closed);
  const retained = reply(pending.state, { opId: id(21), status: 'conflict', replayed: false, conflictId: id(6), record: record(2, 'other-device') });
  assert.equal(retained.outbox[0].conflictId, id(6));
  assert.equal(retained.serverRecords[entityKey('note', noteId)].deletedAt, null);
});

test('remote closure preserves restore overlays after a create collision without an invalid zero restore revision', () => {
  const tombstone: SyncRecord<'note'> = { ...record(2), deletedAt: at, data: null };
  const prepared = send(queueLocalEdit(initial(), edit('colliding-create'), identity(20)));
  let state = reply(prepared.state, { opId: id(20), status: 'conflict', replayed: false, conflictId, record: tombstone });
  state = queueLocalEdit(state, { ...edit('explicit-local-restore'), mutation: 'restore' }, identity(21));
  const closed = applyRemoteConflictResolution(state, getSyncContext(state), { conflictId, record: tombstone });
  assert.equal(closed.outbox[0].operation.mutation, 'restore');
  assert.equal(closed.outbox[0].operation.baseRevision, 1);
  assert.equal(validateClientState(closed).ok, true);
  const pending = send(closed);
  const conflict = reply(pending.state, { opId: id(21), status: 'conflict', replayed: false, conflictId: id(6), record: tombstone });
  assert.equal(conflict.outbox[0].status, 'conflict');
  assert.equal(visibleBody(conflict), 'explicit-local-restore');
  assert.equal(conflict.serverRecords[entityKey('note', noteId)].deletedAt, at);
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

test('ordinary edits coalesced into an unsent restore retain its explicit restoration intent and latest content', () => {
  const tombstone: SyncRecord<'note'> = { ...record(2), deletedAt: at, data: null };
  const restored = freeze(queueLocalEdit(receive(initial(), [tombstone]), { ...edit('restore-draft'), mutation: 'restore' }, identity(20)));
  const updated = queueLocalEdit(restored, edit('edited-before-sync'), identity(21));
  assert.equal(updated.outbox[0].operation.mutation, 'restore');
  assert.equal(updated.outbox[0].operation.baseRevision, 2);
  assert.equal(updated.outbox[0].operation.opId, id(21));
  assert.equal((updated.outbox[0].operation.data as NoteData).body, 'edited-before-sync');
  assert.equal((restored.outbox[0].operation.data as NoteData).body, 'restore-draft');
  assert.deepEqual(queueLocalEdit(updated, edit('edited-before-sync'), identity(21)), updated);
  assert.throws(() => queueLocalEdit(updated, edit('changed-with-same-id'), identity(21)), /OP_ID_REUSED/);
  const pending = send(updated);
  assert.equal(pending.request.operations[0].mutation, 'restore');
  assert.deepEqual(queueLocalEdit(pending.state, edit('edited-before-sync'), identity(21)), pending.state);
  const saved = reply(pending.state, { opId: id(21), status: 'applied', replayed: false, record: record(3, 'edited-before-sync') });
  assert.equal(saved.outbox.length, 0);
  assert.equal(visibleBody(saved), 'edited-before-sync');
  assert.equal(getVisibleEntity(saved, 'note', noteId)?.deleted, false);
  assert.equal(validateClientState(saved).ok, true);
});

test('deleting an edited unsent restore keeps the server tombstone instead of restoring it', () => {
  const tombstone: SyncRecord<'note'> = { ...record(2), deletedAt: at, data: null };
  let state = queueLocalEdit(receive(initial(), [tombstone]), { ...edit('restore-draft'), mutation: 'restore' }, identity(20));
  state = queueLocalEdit(state, edit('edited-before-delete'), identity(21));
  state = queueLocalEdit(state, { entityType: 'note', entityId: noteId, mutation: 'delete', data: null }, identity(22));
  const pending = send(state);
  assert.equal(pending.request.operations[0].mutation, 'delete');
  assert.equal(pending.request.operations[0].baseRevision, 2);
  assert.equal(pending.request.operations[0].opId, id(22));
  const saved = reply(pending.state, { opId: id(22), status: 'applied', replayed: false, record: tombstone });
  assert.equal(saved.outbox.length, 0);
  assert.equal(getVisibleEntity(saved, 'note', noteId)?.deleted, true);
  assert.equal(saved.serverRecords[entityKey('note', noteId)].revision, 2);
});

test('edits after any restore send attempt stay overlays and never change the original operation identity or payload', () => {
  const tombstone: SyncRecord<'note'> = { ...record(2), deletedAt: at, data: null };
  const original = send(queueLocalEdit(receive(initial(), [tombstone]), { ...edit('sent-restore'), mutation: 'restore' }, identity(20)));
  const originalOperation = canonicalJson(original.request.operations[0]);
  const variants = [
    original.state,
    markPushUncertain(original.state, original.context, original.opIds),
    reply(original.state, { opId: id(20), status: 'rejected', replayed: false, code: 'SERVICE_TEMPORARILY_UNAVAILABLE', retryable: true }),
  ];
  for (const state of variants) {
    let later = queueLocalEdit(state, edit('typed-after-attempt'), identity(21));
    assert.equal(canonicalJson(later.outbox[0].operation), originalOperation);
    assert.equal(later.overlays[entityKey('note', noteId)].mutation, 'put');
    assert.equal(visibleBody(later), 'typed-after-attempt');
    later = resumeAfterRestart(later);
    const replay = send(later);
    assert.equal(canonicalJson(replay.request.operations[0]), originalOperation);
    const restored = reply(replay.state, { opId: id(20), status: 'applied', replayed: true, record: record(3, 'sent-restore') });
    assert.equal(restored.outbox[0].operation.mutation, 'put');
    assert.equal(restored.outbox[0].operation.baseRevision, 3);
    assert.equal(restored.outbox[0].operation.opId, id(21));
    assert.equal(visibleBody(restored), 'typed-after-attempt');
    const pending = send(restored);
    const saved = reply(pending.state, { opId: id(21), status: 'applied', replayed: false, record: record(4, 'typed-after-attempt') });
    assert.equal(saved.outbox.length, 0);
    assert.equal(visibleBody(saved), 'typed-after-attempt');
  }
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
