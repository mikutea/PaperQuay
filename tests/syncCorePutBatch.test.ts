import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson, createAccountState, entityKey, getSyncContext, markPushUncertain,
  preparePush, queueLocalEdit, queueLocalPuts, SYNC_LIMITS, SyncStateError, validateClientState,
  type AccountSyncState, type EditIdentity, type LocalEdit, type NoteData, type OutboxStatus,
  type PaperData, type ReadingPositionData, type SyncOperation, type SyncRecord,
} from '../packages/sync-core/src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-28T06:00:00.000Z';
const initial = () => createAccountState(id(1), id(2));
const identity = (n: number): EditIdentity => ({ opId: id(n), clientCreatedAt: at });
const note = (n: number, body = `Body ${n}`): LocalEdit => ({ entityType: 'note', entityId: id(n), mutation: 'put', data: { paperId: null, title: 'Note', body, format: 'markdown' } });
const paper = (n: number, title = 'Paper'): LocalEdit => ({ entityType: 'paper', entityId: id(n), mutation: 'put', data: { title, doi: null, year: null, publication: null, abstractText: null, authors: [], keywords: [] } });
const operation = (n: number, op = n + 100_000): SyncOperation => ({ ...note(n), ...identity(op), schemaVersion: 1, baseRevision: 0 });
const record = (n: number, revision = 1, deleted = false): SyncRecord<'note'> => ({ entityType: 'note', entityId: id(n), schemaVersion: 1, revision, deletedAt: deleted ? at : null, updatedAt: at, modifiedByDeviceId: id(2), data: deleted ? null : note(n).data as NoteData });
const readingData = (): ReadingPositionData => ({ paperId: id(40), attachmentVersionId: id(41), pageIndex: 2, offsetRatio: 0.2, furthestPageIndex: 3, furthestOffsetRatio: 0.1, sessionId: id(42), deviceSequence: 1, observedAt: at });
const reading = (n: number): Extract<LocalEdit, { entityType: 'readingPosition' }> => ({ entityType: 'readingPosition', entityId: id(n), mutation: 'put', data: readingData() });
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function fails(code: string, run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof SyncStateError && error.code === code);
}

test('mixed puts preserve unrelated work, use actual server revisions, and detach all inputs', () => {
  let state = queueLocalEdit(initial(), note(20), identity(200));
  state = preparePush(state, getSyncContext(state)).state;
  state = queueLocalEdit(state, note(20, 'Overlay'), identity(201));
  state.serverRecords[entityKey('paper', id(40))] = { ...record(40, 7), entityType: 'paper', data: paper(40).data as PaperData };
  state.serverRecords[entityKey('note', id(41))] = record(41, 3);
  state.conflicts[id(300)] = { conflictId: id(300), attempted: operation(30, 205), current: record(30) };
  state = freeze(state);
  const before = canonicalJson(state);
  const linked = note(43);
  (linked.data as NoteData).paperId = id(42);
  const edits = [paper(40, 'Updated paper'), paper(42, 'New paper'), note(41, 'Updated note'), linked];
  const identities = [identity(202), identity(203), identity(204), identity(206)];
  const next = queueLocalPuts(state, edits, identities);
  assert.equal(canonicalJson(state), before);
  assert.deepEqual(next.outbox.slice(1).map((entry) => [entry.operation.entityId, entry.operation.baseRevision, entry.status, entry.attempts, entry.originDeviceId]), [
    [id(40), 7, 'queued', 0, id(2)], [id(42), 0, 'queued', 0, id(2)],
    [id(41), 3, 'queued', 0, id(2)], [id(43), 0, 'queued', 0, id(2)],
  ]);
  assert.deepEqual(next.outbox[0], state.outbox[0]);
  assert.deepEqual(next.overlays, state.overlays);
  assert.deepEqual(next.conflicts, state.conflicts);
  assert.deepEqual(next.serverRecords, state.serverRecords);
  (edits[0].data as PaperData).title = 'Caller changed';
  (linked.data as NoteData).paperId = null;
  identities[0].opId = id(999);
  assert.equal((next.outbox[1].operation.data as PaperData).title, 'Updated paper');
  assert.equal((next.outbox[4].operation.data as NoteData).paperId, id(42));
  assert.equal(next.outbox[1].operation.opId, id(202));
  (next.serverRecords[entityKey('note', id(41))].data as NoteData).body = 'Next state changed';
  assert.equal(canonicalJson(state), before);
  assert.equal(validateClientState(next).ok, true);
});

test('empty batches retain identity and invalid state is still rejected', () => {
  const state = freeze(initial());
  assert.equal(queueLocalPuts(state, [], []), state);
  fails('INVALID_CLIENT_STATE', () => queueLocalPuts({ ...state, formatVersion: 2 } as unknown as AccountSyncState, [], []));
});

test('late malformed edits, identities, and reading semantics roll back the complete mixed batch', () => {
  const state = initial();
  state.serverRecords[entityKey('note', id(40))] = record(40, 8);
  freeze(state);
  const before = canonicalJson(state);
  const invalid: LocalEdit[] = [
    { ...note(42), data: { ...note(42).data, title: 42 } } as unknown as LocalEdit,
    { ...note(42), mutation: 'delete', data: null },
    { ...note(42), mutation: 'restore' },
    { ...note(42), baseRevision: 99 } as unknown as LocalEdit,
    { ...note(42), opId: id(203) } as unknown as LocalEdit,
    { ...reading(42), data: { ...readingData(), furthestPageIndex: 1 } },
  ];
  for (const last of invalid) {
    const edits = freeze([note(40, 'Updated'), note(41), last]);
    fails('INVALID_EDIT', () => queueLocalPuts(state, edits, [identity(201), identity(202), identity(203)]));
    assert.equal(canonicalJson(state), before);
  }
  fails('INVALID_EDIT_IDENTITY', () => queueLocalPuts(state, [note(40, 'Updated'), note(41)], [identity(201), { ...identity(202), clientCreatedAt: 'not-a-date' }]));
  assert.equal(canonicalJson(state), before);
});

test('batch containers reject sparse, accessor, and decorated arrays before reading rows', () => {
  let calls = 0;
  const edits = [note(40)];
  Object.defineProperty(edits, '0', { enumerable: true, get() { calls += 1; return note(40); } });
  const identities = [identity(201)];
  Object.defineProperty(identities, '0', { enumerable: true, get() { calls += 1; return identity(201); } });
  const decorated = Object.assign([note(40)], { extra: 'not-an-edit' });
  for (const [rows, ids] of [
    [edits, [identity(201)]], [[note(40)], identities],
    [new Array(1), [identity(201)]], [[note(40)], new Array(1)],
    [decorated, [identity(201)]], [[note(40)], []],
    [null, []], [[], {}],
  ] as [unknown, unknown][]) {
    fails('INVALID_PUT_BATCH', () => queueLocalPuts(initial(), rows as LocalEdit[], ids as EditIdentity[]));
  }
  const oversized = new Array(SYNC_LIMITS.maxLocalOperations + 1);
  Object.defineProperty(oversized, '0', { enumerable: true, get() { calls += 1; return note(40); } });
  fails('LOCAL_CAPACITY_EXCEEDED', () => queueLocalPuts(initial(), oversized, new Array(oversized.length)));
  assert.equal(calls, 0);
});

test('edit and identity accessors and prototype fields cannot be hidden by operation construction', () => {
  let calls = 0;
  const accessorEdit = note(40);
  Object.defineProperty(accessorEdit, 'entityId', { enumerable: true, get() { calls += 1; return id(40); } });
  const accessorData = note(40);
  Object.defineProperty(accessorData.data, 'body', { enumerable: true, get() { calls += 1; return 'Hidden'; } });
  const accessorIdentity = identity(201);
  Object.defineProperty(accessorIdentity, 'opId', { enumerable: true, get() { calls += 1; return id(201); } });
  const prototypeField = note(40);
  Object.defineProperty(prototypeField.data, '__proto__', { enumerable: true, value: { polluted: true } });
  for (const invalid of [accessorEdit, accessorData, prototypeField, Object.assign(Object.create({ inherited: true }), note(40))])
    fails('INVALID_EDIT', () => queueLocalPuts(initial(), [invalid], [identity(201)]));
  fails('INVALID_EDIT_IDENTITY', () => queueLocalPuts(initial(), [note(40)], [accessorIdentity]));
  assert.equal(calls, 0);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  // Null-prototype JSON data is accepted by the existing schema validator.
  const plain = Object.assign(Object.create(null), note(40));
  plain.data = Object.assign(Object.create(null), plain.data);
  const next = queueLocalPuts(initial(), [plain], [Object.assign(Object.create(null), identity(201))]);
  assert.equal(next.outbox[0].operation.entityId, id(40));
});

test('every pending status and overlay blocks an otherwise valid target', () => {
  const statuses: OutboxStatus[] = ['queued', 'sending', 'uncertain', 'rejected', 'device-blocked', 'conflict'];
  for (const status of statuses) {
    const state = initial();
    state.serverRecords[entityKey('note', id(40))] = record(40, 5);
    const attempted = { ...operation(40, 200), baseRevision: 5 };
    state.outbox = [{ operation: attempted, originDeviceId: state.deviceId, status, attempts: status === 'queued' ? 0 : 1,
      errorCode: status === 'device-blocked' ? 'DEVICE_CHANGED' : null, conflictId: status === 'conflict' ? id(300) : null }];
    if (status === 'conflict') state.conflicts[id(300)] = { conflictId: id(300), attempted, current: record(40, 6) };
    if (status === 'sending') state.overlays[entityKey('note', id(40))] = { ...note(40, 'Overlay'), ...identity(201) };
    assert.equal(validateClientState(state).ok, true, status);
    const before = canonicalJson(state);
    fails('TARGET_HAS_PENDING_EDITS', () => queueLocalPuts(freeze(state), [note(41), note(40)], [identity(202), identity(203)]));
    assert.equal(canonicalJson(state), before, status);
  }
});

test('invisible pending deletion and retained conflicts block imports without an outbox-visible entity', () => {
  const deleted = initial();
  deleted.outbox = [{ operation: { ...operation(40, 200), mutation: 'delete', data: null }, originDeviceId: deleted.deviceId,
    status: 'queued', attempts: 0, errorCode: null, conflictId: null }];
  const states = [deleted];
  for (const current of [null, record(40), record(40, 1, true)]) {
    const state = initial();
    state.conflicts[id(300)] = { conflictId: id(300), attempted: operation(40, 200), current };
    states.push(state);
  }
  for (const state of states) {
    const before = canonicalJson(state);
    assert.equal(validateClientState(state).ok, true);
    fails('TARGET_HAS_PENDING_EDITS', () => queueLocalPuts(freeze(state), [note(41), note(40)], [identity(202), identity(203)]));
    assert.equal(canonicalJson(state), before);
  }
});

test('puts never restore tombstones or accept a duplicate target within the same batch', () => {
  const state = initial();
  state.serverRecords[entityKey('note', id(40))] = record(40, 9, true);
  const before = canonicalJson(state);
  fails('RESTORE_REQUIRED', () => queueLocalPuts(freeze(state), [note(41), note(40)], [identity(201), identity(202)]));
  assert.equal(canonicalJson(state), before);
  for (const existing of [false, true]) {
    const clean = initial();
    if (existing) clean.serverRecords[entityKey('note', id(40))] = record(40, 5);
    fails('INVALID_PUT_BATCH', () => queueLocalPuts(freeze(clean), [note(40), note(40, 'Second')], [identity(201), identity(202)]));
    assert.equal(clean.outbox.length, 0);
  }
});

test('operation identities remain unique across outbox, overlays, retained conflicts, and the batch', () => {
  const queued = queueLocalEdit(initial(), note(20), identity(200));
  const prepared = preparePush(queued, getSyncContext(queued));
  const uncertain = markPushUncertain(prepared.state, prepared.context, prepared.opIds);
  const state = queueLocalEdit(uncertain, note(20, 'Overlay'), identity(201));
  state.conflicts[id(300)] = { conflictId: id(300), attempted: operation(30, 202), current: null };
  freeze(state);
  const before = canonicalJson(state);
  for (const op of [200, 201, 202])
    fails('OP_ID_REUSED', () => queueLocalPuts(state, [note(40), note(41)], [identity(203), identity(op)]));
  fails('OP_ID_REUSED', () => queueLocalPuts(state, [note(40), note(41)], [identity(203), identity(203)]));
  assert.equal(canonicalJson(state), before);
});

test('equal content is still a fresh CAS put and targets are distinguished by entity type', () => {
  const state = initial();
  state.serverRecords[entityKey('note', id(40))] = record(40, 15);
  const next = queueLocalPuts(freeze(state), [note(40), paper(40)], [identity(201), identity(202)]);
  assert.deepEqual(next.outbox.map((entry) => [entry.operation.entityType, entry.operation.baseRevision]), [['note', 15], ['paper', 0]]);
  assert.deepEqual(next.outbox[0].operation.data, state.serverRecords[entityKey('note', id(40))].data);
});

test('existing reading positions remain owned by their device and new positions use revision zero', () => {
  for (const owner of [id(2), id(3)]) {
    const state = initial();
    state.serverRecords[entityKey('readingPosition', id(50))] = { ...record(50, 7), entityType: 'readingPosition', data: readingData(), modifiedByDeviceId: owner };
    const before = canonicalJson(state);
    if (owner !== state.deviceId) {
      fails('READING_DEVICE_MISMATCH', () => queueLocalPuts(freeze(state), [note(40), reading(50)], [identity(201), identity(202)]));
    } else {
      const next = queueLocalPuts(freeze(state), [reading(50), reading(51)], [identity(201), identity(202)]);
      assert.deepEqual(next.outbox.map((entry) => entry.operation.baseRevision), [7, 0]);
      assert.ok(next.outbox.every((entry) => entry.originDeviceId === state.deviceId));
    }
    assert.equal(canonicalJson(state), before);
  }
});

test('inherited record properties do not turn a new entity into an update', () => {
  const key = entityKey('note', id(40));
  Object.defineProperty(Object.prototype, key, { configurable: true, value: record(40, 99) });
  try {
    const next = queueLocalPuts(initial(), [note(40)], [identity(201)]);
    assert.equal(next.outbox[0].operation.baseRevision, 0);
    assert.equal(Object.hasOwn(next.serverRecords, key), false);
  } finally { delete (Object.prototype as Record<string, unknown>)[key]; }
});

test('large mixed batches clone the library once instead of once for each edit', (t) => {
  const state = initial();
  const edits = Array.from({ length: 1000 }, (_, index) => note(index + 100));
  for (let index = 0; index < 500; index += 1) state.serverRecords[entityKey('note', id(index + 100))] = record(index + 100, 4);
  const clone = t.mock.method(globalThis, 'structuredClone', structuredClone);
  const next = queueLocalPuts(state, edits, edits.map((_, index) => identity(index + 10_000)));
  assert.equal(next.outbox.length, 1000);
  assert.equal(clone.mock.callCount(), 1);
  assert.ok(next.outbox.slice(0, 500).every((entry) => entry.operation.baseRevision === 4));
  assert.ok(next.outbox.slice(500).every((entry) => entry.operation.baseRevision === 0));
});

test('outbox capacity includes the complete batch and accepts exactly the last available slot', () => {
  const state = initial();
  state.outbox = Array.from({ length: SYNC_LIMITS.maxLocalOperations - 1 }, (_, index) => ({
    operation: operation(index + 100), originDeviceId: state.deviceId, status: 'queued' as const,
    attempts: 0, errorCode: null, conflictId: null,
  }));
  fails('LOCAL_CAPACITY_EXCEEDED', () => queueLocalPuts(state, [note(90_000), note(90_001)], [identity(190_000), identity(190_001)]));
  assert.equal(state.outbox.length, SYNC_LIMITS.maxLocalOperations - 1);
  const full = queueLocalPuts(state, [note(90_000)], [identity(190_000)]);
  assert.equal(full.outbox.length, SYNC_LIMITS.maxLocalOperations);
  assert.equal(state.outbox.length, SYNC_LIMITS.maxLocalOperations - 1);
});

test('entity capacity includes invisible work and allows clean updates without reserving a new entity', () => {
  const state = initial();
  for (let index = 0; index < SYNC_LIMITS.maxLocalEntities - 2; index += 1) {
    const value = record(index + 100, 5, index !== 0);
    state.serverRecords[entityKey('note', value.entityId)] = value;
  }
  state.outbox = [{ operation: operation(200_000, 300_000), originDeviceId: state.deviceId, status: 'queued', attempts: 0, errorCode: null, conflictId: null }];
  state.conflicts[id(400_000)] = { conflictId: id(400_000), attempted: operation(200_001, 300_001), current: null };
  fails('LOCAL_CAPACITY_EXCEEDED', () => queueLocalPuts(state, [note(100, 'Update'), note(200_002)], [identity(300_002), identity(300_003)]));
  const next = queueLocalPuts(state, [note(100, 'Update')], [identity(300_002)]);
  assert.equal(next.outbox.length, 2);
  assert.equal(next.outbox[1].operation.baseRevision, 5);
  assert.equal(Object.keys(state.serverRecords).length, SYNC_LIMITS.maxLocalEntities - 2);
  assert.equal(state.outbox.length, 1);
});
