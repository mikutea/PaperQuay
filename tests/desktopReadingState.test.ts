import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../packages/sync-core/src/index.ts';
import type { DesktopReadingState, ReadingPositionData, SyncRecord } from '../packages/sync-core/src/index.ts';

const id = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const at = '2026-11-04T12:00:00.000Z', scope = { serviceKey: 'a'.repeat(64), accountId: id(1), libraryBindingId: id(2) };
const source = { bindingId: id(4), localPaperId: 'native-paper', localAttachmentId: 'native-pdf', paperId: id(5), attachmentVersionId: id(6),
  sha256: 'b'.repeat(64), sizeBytes: 400, pageCount: 12, title: 'Presentation title', fileName: 'paper.pdf' };
const capture = (pageIndex = 2, offsetRatio = .3, observedAt = at) => ({ bindingId: source.bindingId, sha256: source.sha256, sizeBytes: source.sizeBytes,
  pageCount: source.pageCount, pageIndex, offsetRatio, observedAt });
const point = (pageIndex = 1, furthestPageIndex = pageIndex, observedAt = at) => ({ pageIndex, offsetRatio: .2, furthestPageIndex, furthestOffsetRatio: .7, observedAt });
const data = (pageIndex = 2, furthestPageIndex = pageIndex, deviceSequence = 1): ReadingPositionData => ({ paperId: source.paperId,
  attachmentVersionId: source.attachmentVersionId, pageIndex, offsetRatio: .3, furthestPageIndex, furthestOffsetRatio: .6,
  sessionId: id(7), deviceSequence, observedAt: at });
const record = (revision = 1, value: ReadingPositionData | null = data(), deviceId = id(3), entityId = id(8)): SyncRecord<'readingPosition'> => ({
  entityType: 'readingPosition', entityId, schemaVersion: 1, revision, deletedAt: value === null ? at : null, data: value, modifiedByDeviceId: deviceId, updatedAt: at,
});
const empty = () => core.createDesktopReadingState(scope, id(3));
const pull = (state = empty(), row = record()) => core.stageDesktopReadingPull(state,
  [{ protocolVersion: 1 as const, records: [row], nextCursor: 'cursor-' + row.revision, hasMore: false }], at);
const stage = (state = empty(), current = capture()) => core.stageDesktopReadingPublication(state, source, current,
  { opId: id(10), entityId: state.checkpoints[0]?.entityId ?? id(8), sessionId: id(11) }, at);
function acknowledged(state = stage()) {
  const prepared = core.preparePush(state.sync, core.getSyncContext(state.sync), 1), candidate = core.withDesktopReadingSync(state, prepared.state);
  return core.applyDesktopReadingPush(candidate, prepared.context, { protocolVersion: 1, results: [{ opId: id(10), status: 'applied', replayed: false,
    record: record(1, prepared.request.operations[0].data as ReadingPositionData) }] }, prepared.opIds);
}
function conflicted() {
  const state = stage(pull()), prepared = core.preparePush(state.sync, core.getSyncContext(state.sync));
  return core.applyDesktopReadingPush(core.withDesktopReadingSync(state, prepared.state), prepared.context, { protocolVersion: 1,
    results: [{ opId: id(10), status: 'conflict', replayed: false, conflictId: id(20), record: record(2, data(4, 6, 2)) }] }, prepared.opIds);
}

test('reading ledger is closed, scoped, detached, and contains only bound reading state', () => {
  const state = empty(); assert.deepEqual(state.drafts, []);
  const copy = core.readDesktopReadingState(state, scope); copy.sync.cursor = 'different'; assert.equal(state.sync.cursor, null);
  for (const changed of [{ ...scope, serviceKey: 'f'.repeat(64) }, { ...scope, accountId: id(40) }, { ...scope, libraryBindingId: id(40) }])
    assert.throws(() => core.readDesktopReadingState(state, changed), /READING_SCOPE_CHANGED/);
  for (const changed of [{ ...state, extras: [] }, Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'drafts'))])
    assert.throws(() => core.readDesktopReadingState(changed, scope), /READING_STATE_INVALID/);
  const mixed = structuredClone(state); mixed.sync.serverRecords['note:' + id(30)] = { ...record(), entityType: 'note', entityId: id(30), data: { title: 'Private', body: 'unrelated', format: 'markdown', paperId: null } } as never;
  assert.throws(() => core.readDesktopReadingState(mixed, scope), /READING_STATE_INVALID/);
  const unbound = structuredClone(stage()); unbound.intents = []; assert.throws(() => core.readDesktopReadingState(unbound, scope), /READING_STATE_INVALID/);
  const hidden = structuredClone(pull()); hidden.checkpoints = []; assert.throws(() => core.readDesktopReadingState(hidden, scope), /READING_STATE_INVALID/);
});

test('complete content proof and normalized actual geometry are strict without reading getters', () => {
  for (const changed of [{ ...capture(), pageIndex: 12 }, { ...capture(), offsetRatio: NaN }, { ...capture(), offsetRatio: 1.01 },
    { ...capture(), pageCount: 0 }, { ...capture(), sizeBytes: core.DESKTOP_READING_LIMITS.pdfBytes + 1 }, { ...capture(), observedAt: '2026-02-30T00:00:00.000Z' },
    { ...capture(), path: 'private.pdf' }, { ...capture(), sha256: 'B'.repeat(64) }]) assert.throws(() => core.readDesktopReadingCapture(changed));
  let read = false; const accessor = { ...capture() }; Object.defineProperty(accessor, 'pageIndex', { enumerable: true, get() { read = true; return 0; } });
  assert.throws(() => core.readDesktopReadingCapture(accessor)); assert.equal(read, false);
  for (const changed of [{ ...source, fileName: '../private.pdf' }, { ...source, pageCount: 0 }, { ...source, url: 'private' }])
    assert.throws(() => core.readVerifiedDesktopReadingSource(changed), /READING_SOURCE_CHANGED/);
  assert.equal(core.sameDesktopReadingSource(source, { ...source, title: 'Renamed', fileName: 'renamed.pdf' }), true);
  for (const field of ['bindingId', 'localPaperId', 'localAttachmentId', 'paperId', 'attachmentVersionId', 'sha256', 'sizeBytes', 'pageCount'] as const)
    assert.equal(core.sameDesktopReadingSource(source, { ...source, [field]: field === 'sizeBytes' || field === 'pageCount' ? 1 : 'changed' }), false);
});

test('session drafts follow observation order, retain all furthest evidence, and never queue a wire operation', () => {
  const baseline = pull(empty(), record(1, data(3, 8)));
  const started = core.stageDesktopReadingDraft(baseline, source, capture(2), id(50));
  assert.equal(started.drafts[0].capture.pageIndex, 2); assert.equal(started.drafts[0].furthestPageIndex, 8); assert.equal(started.sync.outbox.length, 0);
  const ahead = core.recordDesktopReadingDraft(started, source, id(50), point(9, 10));
  const backward = core.recordDesktopReadingDraft(ahead, source, id(50), point(1, 1, '2026-11-04T11:00:00.000Z'));
  assert.equal(backward.drafts[0].capture.pageIndex, 1); assert.equal(backward.drafts[0].capture.observedAt, '2026-11-04T11:00:00.000Z');
  assert.equal(backward.drafts[0].furthestPageIndex, 10); assert.equal(backward.sync.outbox.length, 0);
  const nextSession = core.stageDesktopReadingDraft(backward, { ...source, title: 'Renamed' }, capture(0), id(51));
  assert.equal(nextSession.drafts.length, 1); assert.equal(nextSession.drafts[0].furthestPageIndex, 10); assert.equal(nextSession.drafts[0].sessionId, id(51));
  assert.throws(() => core.recordDesktopReadingDraft(nextSession, source, id(50), point()), /READING_TRACKING_CHANGED/);
  for (const invalid of [{ ...point(), furthestPageIndex: 0 }, { ...point(), pageIndex: 12 }, { ...point(), observedAt: 'invalid' }, { ...point(), sha256: source.sha256 }])
    assert.throws(() => core.recordDesktopReadingDraft(nextSession, source, id(51), invalid));
  assert.equal(started.drafts[0].capture.pageIndex, 2, 'reducers do not mutate retained input');
});

test('explicit publication keeps the fresh recent point while incorporating compatible local furthest only', () => {
  const local = core.recordDesktopReadingDraft(core.stageDesktopReadingDraft(pull(), source, capture(), id(50)), source, id(50), point(7, 10));
  const queued = stage(local, capture(1, .1)), original = structuredClone(queued.sync.outbox[0].operation);
  assert.equal((original.data as ReadingPositionData).pageIndex, 1); assert.equal((original.data as ReadingPositionData).furthestPageIndex, 10);
  assert.equal((original.data as ReadingPositionData).deviceSequence, 2);
  const later = core.recordDesktopReadingDraft(queued, source, id(50), point(11, 11));
  assert.deepEqual(later.sync.outbox[0].operation, original); assert.equal(later.drafts[0].furthestPageIndex, 11);
  assert.throws(() => stage(later), /READING_PENDING/);
  const rebound = core.withDesktopReadingSync(later, core.rebindDevice(later.sync, id(60)));
  assert.equal(core.desktopReadingLocalDraft(rebound, source), null); assert.equal(rebound.drafts[0].originDeviceId, id(3));
  const newDevice = core.stageDesktopReadingDraft(rebound, source, capture(0), id(61));
  assert.equal(newDevice.drafts.length, 2); assert.equal(core.desktopReadingLocalDraft(newDevice, source)!.furthestPageIndex, 0);
  const published = core.stageDesktopReadingPublication(newDevice, source, capture(0), { opId: id(62), entityId: id(63), sessionId: id(61) }, at);
  assert.equal(published.sync.outbox.length, 2); assert.equal(published.sync.outbox[0].status, 'device-blocked');
  assert.equal((published.sync.outbox[1].operation.data as ReadingPositionData).furthestPageIndex, 0);
});

test('wire receipts cannot change author, original recent data, entity, or immutable version', () => {
  const staged = stage(), prepared = core.preparePush(staged.sync, core.getSyncContext(staged.sync)), state = core.withDesktopReadingSync(staged, prepared.state);
  const response = (row: SyncRecord<'readingPosition'>) => ({ protocolVersion: 1 as const, results: [{ opId: id(10), status: 'applied' as const, replayed: false, record: row }] });
  for (const row of [record(1, data(), id(90)), record(1, { ...(prepared.request.operations[0].data as ReadingPositionData), pageIndex: 0 }),
    record(1, prepared.request.operations[0].data as ReadingPositionData, id(3), id(90))])
    assert.throws(() => core.applyDesktopReadingPush(state, prepared.context, response(row), prepared.opIds));
  const accepted = acknowledged(); assert.equal(accepted.sync.outbox.length, 0); assert.equal(accepted.intents.length, 0); assert.deepEqual(accepted.checkpoints[0].source, source);
  for (const changed of [record(2, data(0, 1, 2)), record(2, data(0, 8, 1)), record(2, { ...data(0, 8, 2), attachmentVersionId: id(90) }), record(2, data(0, 8, 2), id(90))])
    assert.throws(() => pull(accepted, changed), /READING_STATE_INVALID/);
});

test('known own tombstone restores explicitly with old sequence and furthest while tracking cannot restore it', () => {
  const accepted = acknowledged(), deleted = pull(accepted, record(2, null));
  assert.equal(core.desktopReadingPlan(deleted, source).publicationAction, 'restore');
  const tracked = core.stageDesktopReadingDraft(deleted, source, capture(0), id(50));
  assert.equal(tracked.sync.outbox.length, 0); assert.equal(tracked.sync.serverRecords['readingPosition:' + id(8)].deletedAt, at);
  const restore = core.stageDesktopReadingPublication(tracked, source, capture(0), { opId: id(40), entityId: id(8), sessionId: id(50) }, at);
  assert.equal(restore.sync.outbox[0].operation.mutation, 'restore'); assert.equal(restore.sync.outbox[0].operation.baseRevision, 2);
  assert.equal((restore.sync.outbox[0].operation.data as ReadingPositionData).deviceSequence, 2);
  assert.equal((restore.sync.outbox[0].operation.data as ReadingPositionData).furthestPageIndex, 2);
  const unboundKnown = pull(pull(), record(2, null)); assert.equal(core.desktopReadingPlan(unboundKnown, source).publicationReason, 'READING_TOMBSTONE_UNBOUND');
  const unknown = pull(empty(), record(2, null)); assert.equal(core.desktopReadingPlan(unknown, source).publicationAction, 'create', 'unproven tombstones are never guessed');
  const trackedLive = core.stageDesktopReadingDraft(pull(), source, capture(0), id(51)), trackedDeleted = pull(trackedLive, record(2, null));
  assert.equal(core.desktopReadingPlan(trackedDeleted, source).publicationAction, 'restore', 'a prior explicitly verified tracking source is retained with known live history');
});

test('foreign checkpoints remain read-only and conflicting creator/version heads are rejected', () => {
  const foreign = pull(empty(), record(1, data(), id(90)));
  assert.equal(core.desktopReadingPlan(foreign, source).publicationAction, 'create');
  assert.throws(() => core.stageDesktopReadingPublication(foreign, source, capture(), { opId: id(10), entityId: id(8), sessionId: id(11) }, at), /READING_PREVIEW_STALE/);
  assert.throws(() => pull(pull(), record(1, data(), id(3), id(90))), /READING_STATE_INVALID/);
  assert.throws(() => core.stageDesktopReadingDraft(empty(), { ...source, sha256: 'c'.repeat(64) }, capture(), id(50)), /READING_SELECTION_INVALID/);
  const drafted = core.stageDesktopReadingDraft(empty(), source, capture(), id(50));
  assert.throws(() => core.stageDesktopReadingDraft(drafted, { ...source, pageCount: 13 }, { ...capture(), pageCount: 13 }, id(51)), /READING_SOURCE_CHANGED/);
});

test('original conflict requests remain frozen through unknown and terminal resolution receipts', () => {
  const conflict = conflicted(), original = structuredClone(conflict.sync.outbox[0].operation);
  const pending = core.stageDesktopReadingResolution(conflict, id(20), 'current', 2, id(21));
  assert.throws(() => core.stageDesktopReadingResolution(pending, id(20), 'attempted', 2, id(22)), /READING_PENDING/);
  const current = record(2, data(4, 6, 2));
  assert.throws(() => core.applyDesktopReadingResolution(pending, id(20), { opId: id(21), status: 'applied', replayed: false, record: record(3, data(4, 6, 3)) }));
  assert.throws(() => core.applyDesktopReadingResolution(pending, id(20), { opId: id(21), status: 'applied', replayed: false, record: { ...current, data: data(3, 6, 2) } }));
  const rejected = core.applyDesktopReadingResolution(pending, id(20), { opId: id(21), status: 'rejected', replayed: false, code: 'ACCOUNT_CHANGE_LIMIT', retryable: false });
  assert.deepEqual(rejected.sync.outbox[0].operation, original); assert.equal(rejected.pendingResolutions[0].request.opId, id(21));
  assert.throws(() => core.applyDesktopReadingResolution(rejected, id(20), { opId: id(21), status: 'rejected', replayed: true, code: 'DIFFERENT', retryable: false }));
  const replacement = core.stageDesktopReadingResolution(rejected, id(20), 'current', 2, id(22));
  const resolved = core.applyDesktopReadingResolution(replacement, id(20), { opId: id(22), status: 'applied', replayed: true, record: current });
  assert.equal(resolved.sync.outbox.length, 0); assert.equal(resolved.intents.length, 0); assert.equal(resolved.pendingResolutions.length, 0);
  const rebound = core.withDesktopReadingSync(conflict, core.rebindDevice(conflict.sync, id(90)));
  assert.throws(() => core.stageDesktopReadingResolution(rebound, id(20), 'current', 2, id(21)), /READING_DEVICE_CHANGED/);
  const changedAttempt = structuredClone(conflict); changedAttempt.sync.conflicts[id(20)].attempted.data = data(1, 8, 2);
  // Changing only the outbox status cannot make two different bodies with one opId
  // a valid imported conflict. Both copies must match the original exactly.
  changedAttempt.sync.outbox[0].status = 'uncertain'; changedAttempt.sync.outbox[0].conflictId = null;
  assert.throws(() => core.readDesktopReadingState(changedAttempt, scope), /READING_STATE_INVALID/);
  const unresolved = structuredClone(pending); unresolved.sync.outbox[0].status = 'uncertain'; unresolved.sync.outbox[0].conflictId = null;
  assert.throws(() => core.readDesktopReadingState(unresolved, scope), /READING_STATE_INVALID/);
});

test('strict row and byte budgets reject rather than clip preserved private drafts', () => {
  const state = core.stageDesktopReadingDraft(empty(), source, capture(), id(50));
  const duplicate = { ...state, drafts: [state.drafts[0], state.drafts[0]] }; assert.throws(() => core.readDesktopReadingState(duplicate, scope));
  const excess = { ...state, drafts: Array.from({ length: core.DESKTOP_READING_LIMITS.positions + 1 }, () => state.drafts[0]) };
  assert.throws(() => core.readDesktopReadingState(excess, scope), /READING_STATE_FULL/);
  assert.throws(() => core.readDesktopReadingState({ ...empty(), padding: 'x'.repeat(core.DESKTOP_READING_LIMITS.privateBytes) }, scope), /READING_STATE_FULL/);
  const checked: DesktopReadingState = core.readDesktopReadingState(state, scope); assert.equal(checked.drafts.length, 1);
});
