import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopGraphMapping, DESKTOP_GRAPH_LIMITS, type DesktopGraphScope } from '../packages/sync-core/src/desktopGraph.ts';
import { createDesktopGraphExchangeState, readDesktopGraphExchangeState, stageDesktopGraphPull, acceptDesktopGraphRecords, projectAcceptedDesktopGraphRecords, withDesktopGraphSync, stageDesktopGraphResolution, acknowledgeDesktopGraphResolution, type DesktopGraphExchangeState } from '../packages/sync-core/src/desktopGraphState.ts';
import { queueLocalEdit, preparePush, applyPushResults, getSyncContext, resumeAfterRestart, applyPullPage } from '../packages/sync-core/src/state.ts';
import type { GraphRelationData } from '../packages/sync-core/src/graphRelation.ts';
import type { PullResponse, SyncRecord, SyncOperation } from '../packages/sync-core/src/types.ts';
const id = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const scope: DesktopGraphScope = { serviceKey: 'a'.repeat(64), accountId: id(1), libraryBindingId: id(2) };
const now = '2026-10-31T00:00:00.000Z';
const data = (label = 'Original'): GraphRelationData => ({ source: { entityType: 'paper', entityId: id(10) }, target: { entityType: 'note', entityId: id(11) }, relationType: 'ai_suggested', label, description: 'Exact\ntext', confidence: null, weight: .7, createdAt: '1970-01-01T00:00:00.000Z', updatedAt: null });
const record = (revision = 1, label = 'Original'): SyncRecord<'graphRelation'> => ({ entityType: 'graphRelation', entityId: id(70), schemaVersion: 1, revision, deletedAt: null, updatedAt: now, modifiedByDeviceId: id(20), data: data(label) });
const paper = (entityId = id(10), revision = 1, deleted = false): SyncRecord<'paper'> => ({ entityType: 'paper', entityId, schemaVersion: 1, revision, deletedAt: deleted ? now : null, updatedAt: now, modifiedByDeviceId: id(20), data: deleted ? null : { title: 'PRIVATE_TITLE_SENTINEL', doi: null, year: null, publication: null, abstractText: 'PRIVATE_BODY_SENTINEL', authors: [], keywords: [] } });
const note = (): SyncRecord<'note'> => ({ entityType: 'note', entityId: id(11), schemaVersion: 1, revision: 1, deletedAt: null, updatedAt: now, modifiedByDeviceId: id(20), data: { paperId: null, title: 'PRIVATE_NOTE', body: 'PRIVATE_NOTE_BODY', format: 'markdown' } });
const page = (records: SyncRecord[] = [], nextCursor: string | null = 'cursor', hasMore = false): PullResponse => ({ protocolVersion: 1, records, nextCursor, hasMore });
const mapping = () => createDesktopGraphMapping({ scope, bindings: [{ entityType: 'paper', localId: 'paper', entityId: id(10) }, { entityType: 'note', localId: 'note', entityId: id(11) }], live: { paperIds: ['paper'], noteIds: ['note'] } });
const fresh = () => createDesktopGraphExchangeState(scope, id(20));
const pulled = () => stageDesktopGraphPull(fresh(), [page([record()])], mapping(), now);
const operation = (label = 'Attempted'): SyncOperation<'graphRelation'> => ({ entityType: 'graphRelation', entityId: id(70), opId: id(80), schemaVersion: 1, baseRevision: 1, mutation: 'put', data: data(label), clientCreatedAt: now });
function conflicted(local = true): DesktopGraphExchangeState {
  let state = pulled();
  if (local) {
    state = withDesktopGraphSync(state, queueLocalEdit(state.sync, { entityType: 'graphRelation', entityId: id(70), mutation: 'put', data: data('Attempted') }, { opId: id(80), clientCreatedAt: now }));
    const sent = preparePush(state.sync, getSyncContext(state.sync));
    return withDesktopGraphSync(state, applyPushResults(sent.state, sent.context, { protocolVersion: 1, results: [{ opId: id(80), status: 'conflict', replayed: false, conflictId: id(90), record: record(2, 'Remote') }] }, sent.opIds));
  }
  state.sync.conflicts[id(90)] = { conflictId: id(90), attempted: operation(), current: record(2, 'Remote') };
  state.sync.serverRecords['graphRelation:' + id(70)] = record(2, 'Remote');
  return readDesktopGraphExchangeState(state, scope);
}

test('private state is closed, scoped, detached, and preserves unknown values and epoch zero', () => {
  const state = pulled(), decoded = readDesktopGraphExchangeState(state, scope);
  (decoded.sync.serverRecords['graphRelation:' + id(70)].data as GraphRelationData).label = 'Changed';
  assert.equal((state.sync.serverRecords['graphRelation:' + id(70)] as SyncRecord<'graphRelation'>).data!.label, 'Original');
  assert.equal(record().data!.confidence, null); assert.equal(record().data!.updatedAt, null);
  for (const changed of [{ ...scope, accountId: id(4) }, { ...scope, libraryBindingId: id(4) }, { ...scope, serviceKey: 'b'.repeat(64) }]) assert.throws(() => readDesktopGraphExchangeState(state, changed), { code: 'GRAPH_MAPPING_CHANGED' });
  assert.throws(() => readDesktopGraphExchangeState({ ...state, credentials: 'never' }, scope), { code: 'GRAPH_STATE_INVALID' });
  const foreign = structuredClone(state); foreign.sync.serverRecords['paper:' + id(10)] = paper();
  assert.throws(() => readDesktopGraphExchangeState(foreign, scope), { code: 'GRAPH_STATE_INVALID' });
});

test('immutable graph bindings are checked across accepted history, server head, links and pending drafts', () => {
  const state = acceptDesktopGraphRecords(pulled(), [id(70)]), changed = structuredClone(state);
  changed.sync.serverRecords['graphRelation:' + id(70)] = { ...record(2), data: { ...data(), createdAt: now } };
  assert.throws(() => readDesktopGraphExchangeState(changed, scope), { code: 'GRAPH_STATE_INVALID' });
  assert.throws(() => stageDesktopGraphPull(state, [page([{ ...record(2), data: { ...data(), target: { entityType: 'paper', entityId: id(12) } } }])], mapping(), now), { code: 'GRAPH_STATE_INVALID' });
  assert.equal(state.revision, 3);
});

test('complete pull keeps only required parent heads and graph DTOs, including parents preceding a new relation', () => {
  const state = fresh(), before = structuredClone(state);
  const staged = stageDesktopGraphPull(state, [page([paper(), note(), paper(id(12))], 'page1', true), page([record()], 'page2')], mapping(), now);
  assert.deepEqual(state, before); assert.equal(staged.sync.cursor, 'page2'); assert.equal(staged.accepted.length, 0);
  assert.equal(Object.keys(staged.sync.serverRecords).length, 1);
  assert.deepEqual(staged.parentHeads, [{ entityType: 'paper', entityId: id(10), revision: 1, deleted: false }, { entityType: 'note', entityId: id(11), revision: 1, deleted: false }]);
  assert.doesNotMatch(JSON.stringify(staged), /PRIVATE_(TITLE|BODY|NOTE)/);
});

test('parent tombstone hides accepted relation and live parent permits projection without restoring any material', () => {
  const state = acceptDesktopGraphRecords(pulled(), [id(70)]);
  const deleted = stageDesktopGraphPull(state, [page([paper(id(10), 2, true)], 'parents2')], mapping(), now);
  assert.equal(projectAcceptedDesktopGraphRecords(deleted, mapping())[0].kind, 'unmapped');
  const restored = stageDesktopGraphPull(deleted, [page([paper(id(10), 3)], 'parents3')], mapping(), now);
  assert.equal(projectAcceptedDesktopGraphRecords(restored, mapping())[0].kind, 'mapped');
  assert.deepEqual(restored.accepted, state.accepted);
  assert.throws(() => stageDesktopGraphPull(deleted, [page([paper(id(10), 2, false)])], mapping(), now), { code: 'GRAPH_STATE_INVALID' });
});

test('pull rejects incomplete/over-budget pages and getters without partially advancing the cursor', () => {
  const state = fresh(); let reads = 0;
  const getter = Object.defineProperty(page(), 'records', { enumerable: true, get() { reads++; return []; } });
  for (const pages of [[], [getter], [page([], 'more', true)], [page(), page()], new Array(1), Array.from({ length: DESKTOP_GRAPH_LIMITS.pullPages + 1 }, () => page())]) assert.throws(() => stageDesktopGraphPull(state, pages, mapping(), now));
  const huge = page(); (huge as any).padding = 'x'.repeat(DESKTOP_GRAPH_LIMITS.privateBytes);
  assert.throws(() => stageDesktopGraphPull(state, [huge], mapping(), now), { code: 'GRAPH_STATE_FULL' });
  assert.equal(reads, 0); assert.equal(state.sync.cursor, null); assert.equal(state.revision, 1);
});

test('pull and restart preserve outbox identity and CAS basis; accepting pending work is blocked', () => {
  let state = pulled();
  state = withDesktopGraphSync(state, queueLocalEdit(state.sync, { entityType: 'graphRelation', entityId: id(70), mutation: 'put', data: data('Draft') }, { opId: id(80), clientCreatedAt: now }));
  const sent = preparePush(state.sync, getSyncContext(state.sync));
  state = withDesktopGraphSync(state, resumeAfterRestart(sent.state));
  const staged = stageDesktopGraphPull(state, [page([record(2, 'Remote')], 'newer')], mapping(), now);
  assert.equal(staged.sync.outbox[0].status, 'uncertain'); assert.equal(staged.sync.outbox[0].operation.opId, id(80)); assert.equal(staged.sync.outbox[0].operation.baseRevision, 1);
  assert.throws(() => acceptDesktopGraphRecords(staged, [id(70)]), { code: 'GRAPH_PENDING' });
  assert.equal(staged.accepted.length, 0);
});

test('adoption changes only selected accepted records and does not rewrite the existing accepted snapshot during check', () => {
  const first = acceptDesktopGraphRecords(pulled(), [id(70)]), staged = stageDesktopGraphPull(first, [page([record(2, 'Remote')])], mapping(), now);
  assert.equal(staged.accepted[0].data!.label, 'Original');
  const accepted = acceptDesktopGraphRecords(staged, [id(70)]);
  assert.equal(accepted.accepted[0].data!.label, 'Remote'); assert.equal(staged.accepted[0].revision, 1);
  assert.throws(() => acceptDesktopGraphRecords(staged, [id(70), id(70)]));
  assert.throws(() => acceptDesktopGraphRecords(staged, [id(99)]));
});

test('remote conflicts without a local outbox survive restart and materialize one stable resolution request', () => {
  const state = conflicted(false); let calls = 0;
  const decision = { conflictId: id(90), expectedRevision: 2, choice: 'current' as const };
  const staged = stageDesktopGraphResolution(state, decision, () => { calls++; return id(91); });
  const reopened = readDesktopGraphExchangeState(JSON.parse(JSON.stringify(staged)), scope);
  const same = stageDesktopGraphResolution(reopened, decision, () => { calls++; return id(92); });
  assert.equal(calls, 1); assert.equal(same.pendingResolutions[0].request.opId, id(91)); assert.equal(same.sync.outbox.length, 0);
  assert.throws(() => stageDesktopGraphResolution(same, { ...decision, choice: 'attempted' }, () => id(92)), { code: 'GRAPH_PENDING' });
  assert.throws(() => acknowledgeDesktopGraphResolution(same, id(90), { opId: id(92), status: 'applied', replayed: false, record: record(2, 'Remote') }));
  const applied = acknowledgeDesktopGraphResolution(same, id(90), { opId: id(91), status: 'applied', replayed: true, record: record(2, 'Remote') });
  assert.equal(applied.pendingResolutions.length, 0); assert.equal(Object.keys(applied.sync.conflicts).length, 0); assert.equal(applied.accepted.length, 0);
});

test('terminal resolution receipt retains merged draft, then an explicit new decision uses a fresh opId and latest revision', () => {
  const state = stageDesktopGraphResolution(conflicted(), { conflictId: id(90), choice: 'merged', expectedRevision: 2, mutation: 'put', data: data('Merged draft') }, () => id(91));
  const rejected = acknowledgeDesktopGraphResolution(state, id(90), { opId: id(91), status: 'conflict', replayed: false, conflictId: id(90), record: record(3, 'Changed again') });
  assert.equal(rejected.pendingResolutions[0].lastResult!.status, 'conflict');
  const draft = rejected.pendingResolutions[0].request;
  assert.equal(draft.choice === 'merged' && draft.data!.label, 'Merged draft');
  assert.throws(() => stageDesktopGraphResolution(rejected, { conflictId: id(90), choice: 'current', expectedRevision: 2 }, () => id(92)), { code: 'GRAPH_MAPPING_CHANGED' });
  const next = stageDesktopGraphResolution(rejected, { conflictId: id(90), choice: 'current', expectedRevision: 3 }, () => id(92));
  assert.equal(next.pendingResolutions[0].request.opId, id(92)); assert.equal(next.pendingResolutions[0].lastResult, null);
  assert.throws(() => acknowledgeDesktopGraphResolution(rejected, id(90), { opId: id(91), status: 'applied', replayed: true, record: record(3, 'Changed again') }));
});

test('retryable resolution keeps original id and later edits are retained unless the exact reviewed overlay was consumed', () => {
  let state = conflicted();
  state = withDesktopGraphSync(state, queueLocalEdit(state.sync, { entityType: 'graphRelation', entityId: id(70), mutation: 'put', data: data('Later draft') }, { opId: id(82), clientCreatedAt: now }));
  const decision = { conflictId: id(90), choice: 'current' as const, expectedRevision: 2, consumedOverlayOpId: id(82) };
  state = stageDesktopGraphResolution(state, decision, () => id(91));
  const failed = acknowledgeDesktopGraphResolution(state, id(90), { opId: id(91), status: 'rejected', replayed: false, code: 'SERVICE_TEMPORARILY_UNAVAILABLE', retryable: true });
  assert.equal(stageDesktopGraphResolution(failed, decision, () => { throw Error('new identity'); }).pendingResolutions[0].request.opId, id(91));
  const consumed = acknowledgeDesktopGraphResolution(failed, id(90), { opId: id(91), status: 'applied', replayed: true, record: record(2, 'Remote') });
  assert.equal(consumed.sync.outbox.length, 0);
  const later = withDesktopGraphSync(failed, queueLocalEdit(failed.sync, { entityType: 'graphRelation', entityId: id(70), mutation: 'put', data: data('Even later') }, { opId: id(83), clientCreatedAt: now }));
  const retained = acknowledgeDesktopGraphResolution(later, id(90), { opId: id(91), status: 'applied', replayed: true, record: record(2, 'Remote') });
  assert.equal(retained.sync.outbox[0].operation.opId, id(83)); assert.equal(retained.sync.outbox[0].operation.baseRevision, 2);
});

test('resolution never accepts a mismatched target, immutable rebind, stale revision or conflicting request id', () => {
  const state = conflicted();
  assert.throws(() => stageDesktopGraphResolution(state, { conflictId: id(90), choice: 'current', expectedRevision: 1 }, () => id(91)));
  assert.throws(() => stageDesktopGraphResolution(state, { conflictId: id(90), choice: 'current', expectedRevision: 2 }, () => id(80)));
  assert.throws(() => stageDesktopGraphResolution(state, { conflictId: id(90), choice: 'merged', expectedRevision: 2, mutation: 'put', data: { ...data(), createdAt: now } }, () => id(91)));
  const pending = stageDesktopGraphResolution(state, { conflictId: id(90), choice: 'current', expectedRevision: 2 }, () => id(91));
  assert.throws(() => acknowledgeDesktopGraphResolution(pending, id(90), { opId: id(91), status: 'applied', replayed: false, record: { ...record(2), entityId: id(71) } }));
  assert.equal(pending.pendingResolutions.length, 1); assert.equal(state.pendingResolutions.length, 0);
});

test('a stale remote attempt with a changed immutable binding stays reviewable and can keep the current relation', () => {
  const state = conflicted(false), attempted = state.sync.conflicts[id(90)].attempted;
  if (attempted.entityType !== 'graphRelation' || !attempted.data) throw Error();
  attempted.data.createdAt = now;
  const retained = readDesktopGraphExchangeState(state, scope);
  assert.equal((retained.sync.conflicts[id(90)].attempted.data as GraphRelationData).createdAt, now);
  assert.throws(() => stageDesktopGraphResolution(retained, { conflictId: id(90), choice: 'attempted', expectedRevision: 2 }, () => id(91)), { code: 'INVALID_DESKTOP_GRAPH_RELATION' });
  const staged = stageDesktopGraphResolution(retained, { conflictId: id(90), choice: 'current', expectedRevision: 2 }, () => id(91));
  assert.equal(staged.pendingResolutions[0].request.choice, 'current');
});

test('resolution uses the newest known conflict head even when it was returned after the pull page', () => {
  const state = conflicted(false);
  state.sync.conflicts[id(90)].current = record(3, 'New between requests');
  assert.throws(() => stageDesktopGraphResolution(state, { conflictId: id(90), choice: 'current', expectedRevision: 2 }, () => id(91)), { code: 'GRAPH_MAPPING_CHANGED' });
  const staged = stageDesktopGraphResolution(state, { conflictId: id(90), choice: 'current', expectedRevision: 3 }, () => id(91));
  assert.equal(staged.pendingResolutions[0].request.expectedRevision, 3);
});
