import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson, createAccountState, entityKey, getSyncContext, listVisibleEntities,
  markPushUncertain, preparePush, queueLocalCreates, queueLocalEdit, resumeAfterRestart,
  SYNC_LIMITS, validateClientState,
  type AccountSyncState, type EditIdentity, type LocalEdit, type NoteData, type PaperData,
  type SyncOperation, type SyncRecord,
} from '../packages/sync-core/src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-26T08:00:00.000Z';
const initial = () => createAccountState(id(1), id(2));
const identity = (n: number): EditIdentity => ({ opId: id(n), clientCreatedAt: at });
const note = (n: number, paperId: string | null = null): LocalEdit => ({ entityType: 'note', entityId: id(n), mutation: 'put', data: { paperId, title: 'Note', body: `Body ${n}`, format: 'markdown' } });
const paper = (n: number): LocalEdit => ({ entityType: 'paper', entityId: id(n), mutation: 'put', data: { title: 'Paper', doi: null, year: null, publication: null, abstractText: null, authors: [], keywords: [] } });
const operation = (n: number, op = n + 100_000): SyncOperation => ({ ...note(n), ...identity(op), schemaVersion: 1, baseRevision: 0 });
const record = (n: number, deleted = false): SyncRecord<'note'> => ({ entityType: 'note', entityId: id(n), schemaVersion: 1, revision: 1, deletedAt: deleted ? at : null, updatedAt: at, modifiedByDeviceId: id(2), data: deleted ? null : note(n).data as NoteData });
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('batch creation preserves old work and paper-note order, detaches inputs, and survives uncertain restart', () => {
  let state = queueLocalEdit(initial(), note(20), identity(200));
  state = preparePush(state, getSyncContext(state)).state;
  state = queueLocalEdit(state, note(20), identity(201));
  state.serverRecords[entityKey('note', id(30))] = record(30, true);
  state.conflicts[id(300)] = { conflictId: id(300), attempted: operation(31, 205), current: record(31) };
  state = freeze(state);
  const before = canonicalJson(state);
  const edits = [paper(40), note(41, id(40)), note(42, id(40))];
  const next = queueLocalCreates(state, edits, [identity(202), identity(203), identity(204)]);
  assert.equal(canonicalJson(state), before);
  assert.deepEqual(next.outbox.slice(1).map((entry) => [entry.operation.entityType, entry.operation.baseRevision, entry.status, entry.attempts]), [
    ['paper', 0, 'queued', 0], ['note', 0, 'queued', 0], ['note', 0, 'queued', 0],
  ]);
  assert.deepEqual(next.overlays, state.overlays);
  assert.deepEqual(next.serverRecords, state.serverRecords);
  assert.deepEqual(next.conflicts, state.conflicts);
  (edits[0].data as PaperData).title = 'Changed caller input';
  (edits[1].data as NoteData).paperId = null;
  assert.equal((next.outbox[1].operation.data as PaperData).title, 'Paper');
  assert.equal((next.outbox[2].operation.data as NoteData).paperId, id(40));
  const prepared = preparePush(next, getSyncContext(next));
  const interrupted = markPushUncertain(prepared.state, prepared.context, prepared.opIds);
  const restored = resumeAfterRestart(JSON.parse(JSON.stringify(interrupted)));
  assert.deepEqual(restored.outbox.map((entry) => entry.operation), interrupted.outbox.map((entry) => entry.operation));
  assert.equal((listVisibleEntities(restored, 'note').find((row) => row.entityId === id(42))!.data as NoteData).paperId, id(40));
  assert.equal(validateClientState(restored).ok, true);
});

test('invalid middle edits, identities, and non-create intents leave the original object untouched', () => {
  const state = freeze(queueLocalEdit(initial(), note(20), identity(200)));
  const before = canonicalJson(state);
  const invalid: LocalEdit[] = [
    { ...note(41), data: { ...note(41).data, title: 42 } } as unknown as LocalEdit,
    { ...note(41), mutation: 'delete', data: null },
    { ...note(41), mutation: 'restore' },
    { ...note(41), baseRevision: 1 } as unknown as LocalEdit,
  ];
  for (const middle of invalid)
    assert.throws(() => queueLocalCreates(state, [paper(40), middle, note(42)], [identity(201), identity(202), identity(203)]), /INVALID_EDIT/);
  assert.throws(() => queueLocalCreates(state, [paper(40), note(41)], [identity(201), { ...identity(202), clientCreatedAt: 'not-a-date' }]), /INVALID_EDIT_IDENTITY/);
  assert.throws(() => queueLocalCreates(state, [paper(40)], []), /INVALID_CREATE_BATCH/);
  assert.equal(canonicalJson(state), before);
});

test('new entity keys cannot collide with records, tombstones, pending operations, overlays, conflicts, or their own batch', () => {
  const states: AccountSyncState[] = [];
  for (const deleted of [false, true]) {
    const state = initial(); state.serverRecords[entityKey('note', id(40))] = record(40, deleted); states.push(state);
  }
  const pending = queueLocalEdit(initial(), note(40), identity(200)); states.push(pending);
  const sending = preparePush(pending, getSyncContext(pending)).state;
  states.push(queueLocalEdit(sending, note(40), identity(201)));
  const conflictOnly = initial();
  conflictOnly.conflicts[id(300)] = { conflictId: id(300), attempted: operation(40, 202), current: record(40, true) };
  states.push(conflictOnly);
  for (const state of states) {
    const before = canonicalJson(state);
    assert.equal(validateClientState(state).ok, true);
    assert.throws(() => queueLocalCreates(freeze(state), [note(41), note(40)], [identity(203), identity(204)]), /ENTITY_ALREADY_EXISTS/);
    assert.equal(canonicalJson(state), before);
  }
  assert.throws(() => queueLocalCreates(initial(), [note(40), note(40)], [identity(203), identity(204)]), /ENTITY_ALREADY_EXISTS/);
});

test('operation IDs cannot be reused across current outbox, overlays, conflicts, or the same batch', () => {
  const queued = queueLocalEdit(initial(), note(20), identity(200));
  const prepared = preparePush(queued, getSyncContext(queued)).state;
  const state = queueLocalEdit(prepared, note(20), identity(201));
  state.conflicts[id(300)] = { conflictId: id(300), attempted: operation(30, 202), current: record(30) };
  const before = canonicalJson(state);
  for (const op of [200, 201, 202])
    assert.throws(() => queueLocalCreates(freeze(state), [note(40)], [identity(op)]), /OP_ID_REUSED/);
  assert.throws(() => queueLocalCreates(state, [note(40), note(41)], [identity(203), identity(203)]), /OP_ID_REUSED/);
  assert.equal(canonicalJson(state), before);
});

test('large imports clone the combined state once rather than clone the growing library per item', (t) => {
  const clone = t.mock.method(globalThis, 'structuredClone', structuredClone);
  const edits = Array.from({ length: 1000 }, (_, index) => note(index + 100));
  const result = queueLocalCreates(initial(), edits, edits.map((_, index) => identity(index + 10_000)));
  assert.equal(result.outbox.length, 1000);
  assert.equal(clone.mock.callCount(), 1);
  assert.equal(validateClientState(result).ok, true);
});

test('outbox capacity is checked for the complete batch and accepts the exact final slot', () => {
  const state = initial();
  state.outbox = Array.from({ length: SYNC_LIMITS.maxLocalOperations - 1 }, (_, index) => ({
    operation: operation(index + 100), originDeviceId: state.deviceId, status: 'queued' as const,
    attempts: 0, errorCode: null, conflictId: null,
  }));
  assert.throws(() => queueLocalCreates(state, [note(90_000), note(90_001)], [identity(190_000), identity(190_001)]), /LOCAL_CAPACITY_EXCEEDED/);
  assert.equal(state.outbox.length, SYNC_LIMITS.maxLocalOperations - 1);
  const full = queueLocalCreates(state, [note(90_000)], [identity(190_000)]);
  assert.equal(full.outbox.length, SYNC_LIMITS.maxLocalOperations);
  assert.equal(validateClientState(full).ok, true);
});

test('entity capacity counts both the server mirror and already pending new entities', () => {
  const state = initial();
  for (let index = 0; index < SYNC_LIMITS.maxLocalEntities - 1; index += 1) {
    const value = record(index + 100, true);
    state.serverRecords[entityKey('note', value.entityId)] = value;
  }
  state.outbox = [{ operation: operation(200_000, 300_000), originDeviceId: state.deviceId, status: 'queued', attempts: 0, errorCode: null, conflictId: null }];
  assert.throws(() => queueLocalCreates(state, [note(200_001)], [identity(300_001)]), /LOCAL_CAPACITY_EXCEEDED/);
  assert.equal(Object.keys(state.serverRecords).length, SYNC_LIMITS.maxLocalEntities - 1);
  assert.equal(state.outbox.length, 1);
});
