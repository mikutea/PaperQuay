import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopGraphMapping, desktopGraphRelationToWire, type DesktopGraphScope } from '../packages/sync-core/src/desktopGraph.ts';
import { createDesktopGraphExchangeState, readDesktopGraphExchangeState, stageDesktopGraphPull, acceptDesktopGraphRecords, withDesktopGraphSync, projectAcceptedDesktopGraphRecords, type DesktopGraphExchangeState } from '../packages/sync-core/src/desktopGraphState.ts';
import { prepareDesktopGraphReview, materializeDesktopGraphPublication } from '../packages/sync-core/src/desktopGraphReview.ts';
import { preparePush, applyPushResults, getSyncContext, resumeAfterRestart, queueLocalEdit } from '../packages/sync-core/src/state.ts';
import type { GraphRelationData } from '../packages/sync-core/src/graphRelation.ts';
import type { SyncRecord } from '../packages/sync-core/src/types.ts';
const id = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const scope: DesktopGraphScope = { serviceKey: 'a'.repeat(64), accountId: id(1), libraryBindingId: id(2) };
const now = '2026-10-31T00:00:00.000Z';
const mapping = () => createDesktopGraphMapping({ scope, bindings: [{ entityType: 'paper', localId: 'paper-a', entityId: id(10) }, { entityType: 'paper', localId: 'paper-b', entityId: id(11) }], live: { paperIds: ['paper-a', 'paper-b'], noteIds: [] } });
const raw = (localId = 'relation', label = 'Original') => ({ id: localId, source: 'paper:paper-a', target: 'paper:paper-b', type: 'ai_suggested', label, description: 'Unchanged\noriginal text', confidence: null, weight: .72, createdAt: 0, updatedAt: null });
const wire = (label = 'Original') => desktopGraphRelationToWire(raw('relation', label), mapping(), scope).data;
const record = (revision = 1, label = 'Original'): SyncRecord<'graphRelation'> => ({ entityType: 'graphRelation', entityId: id(70), schemaVersion: 1, revision, deletedAt: null, updatedAt: now, modifiedByDeviceId: id(20), data: wire(label) });
const fresh = () => createDesktopGraphExchangeState(scope, id(20));
const identity = (n = 70) => ({ entityId: id(n), opId: id(n + 100), clientCreatedAt: now });
function staged(records: SyncRecord[] = [record()]) { return stageDesktopGraphPull(fresh(), [{ protocolVersion: 1, records, nextCursor: 'cursor', hasMore: false }], mapping(), now); }
function linked(label = 'Original'): DesktopGraphExchangeState {
  const state = staged();
  state.links.push({ localRelationId: 'relation', entityId: id(70), lastLocalData: wire(label) });
  return readDesktopGraphExchangeState(state, scope);
}
const only = (state: DesktopGraphExchangeState, relations: unknown[] = [raw()]) => prepareDesktopGraphReview(state, relations, mapping()).rows[0];

test('local preview retains raw drafts and exact zero/unknown values, and closed unsupported drafts stay blocked', () => {
  const source = raw(), before = structuredClone(source), review = prepareDesktopGraphReview(fresh(), [source], mapping());
  assert.equal(review.rows[0].kind, 'create'); assert.equal(review.rows[0].data!.createdAt, '1970-01-01T00:00:00.000Z');
  assert.equal(review.rows[0].data!.confidence, null); assert.equal(review.rows[0].data!.updatedAt, null); assert.deepEqual(source, before);
  const custom = { ...raw(), customField: { original: 'retained' } }, blocked = only(fresh(), [custom]);
  assert.equal(blocked.kind, 'blocked'); assert.equal(blocked.reasonCode, 'INVALID_DESKTOP_GRAPH_RELATION'); assert.deepEqual(blocked.raw, custom);
  const missing = raw() as any; delete missing.createdAt;
  assert.equal(only(fresh(), [missing]).kind, 'blocked');
});

test('missing endpoints, duplicate local ids and immutable binding changes never become publications or deletions', () => {
  assert.equal(only(fresh(), [{ ...raw(), source: 'paper:' + id(10) }]).reasonCode, 'UNMAPPED_GRAPH_ENDPOINT');
  const state = linked(), duplicated = prepareDesktopGraphReview(state, [raw(), raw()], mapping());
  assert.equal(duplicated.rows.length, 2); assert(duplicated.rows.every(row => row.reasonCode === 'DUPLICATE_LOCAL_RELATION'));
  for (const patch of [{ source: 'paper:paper-b', target: 'paper:paper-a' }, { createdAt: 1 }, { type: 'custom_relation' }]) assert.equal(only(state, [{ ...raw(), ...patch }]).reasonCode, 'IMMUTABLE_GRAPH_BINDING_CHANGED');
});

test('only a successfully read empty local store proposes explicit deletion; missing and invalid stores keep links', () => {
  const state = linked();
  for (const sourceStatus of ['missing', 'invalid'] as const) {
    const review = prepareDesktopGraphReview(state, [], mapping(), { sourceStatus });
    assert.equal(review.rows[0].kind, 'blocked'); assert.equal(review.rows[0].reasonCode, sourceStatus === 'missing' ? 'GRAPH_SOURCE_MISSING' : 'GRAPH_SOURCE_INVALID');
    assert.throws(() => materializeDesktopGraphPublication(state, review, [review.rows[0].rowId], () => identity()), { code: 'GRAPH_PENDING' });
  }
  const unidentified = raw() as any; delete unidentified.id;
  const corruptRow = prepareDesktopGraphReview(state, [unidentified], mapping());
  assert.equal(corruptRow.rows.find(row => row.entityId === id(70))!.reasonCode, 'GRAPH_SOURCE_INVALID');
  assert(corruptRow.rows.every(row => row.kind === 'blocked'));
  const review = prepareDesktopGraphReview(state, [], mapping()); assert.equal(review.rows[0].kind, 'delete');
  const deletion = materializeDesktopGraphPublication(state, review, [review.rows[0].rowId], () => identity());
  assert.equal(deletion.sync.outbox[0].operation.mutation, 'delete'); assert.equal(deletion.sync.outbox[0].operation.baseRevision, 1);
  assert.equal(deletion.links.length, 1); assert.equal(state.sync.outbox.length, 0);
});

test('preview distinguishes create, update, explicit restore, delete, same and remote-only changes', () => {
  assert.equal(only(fresh()).kind, 'create'); assert.equal(only(linked()).kind, 'same');
  assert.equal(only(linked(), [raw('relation', 'Edited')]).kind, 'update'); assert.equal(only(linked(), []).kind, 'delete');
  const deleted = linked(); deleted.sync.serverRecords['graphRelation:' + id(70)] = { ...record(2), deletedAt: now, data: null };
  assert.equal(only(deleted).kind, 'restore'); assert.equal(only(deleted, []).kind, 'same');
  const remote = linked(); remote.sync.serverRecords['graphRelation:' + id(70)] = record(2, 'Remote');
  assert.equal(only(remote).reasonCode, 'REMOTE_GRAPH_CHANGED');
  const both = only(remote, [raw('relation', 'Edited')]); assert.equal(both.kind, 'update'); assert.equal(both.server!.data!.label, 'Remote');
  assert.equal((both.raw as ReturnType<typeof raw>).label, 'Edited');
});

test('pending work and retained conflicts block publication even if newer local drafts differ', () => {
  const source = linked();
  const queued = withDesktopGraphSync(source, queueLocalEdit(source.sync, { entityType: 'graphRelation', entityId: id(70), mutation: 'put', data: wire('In outbox') }, { opId: id(80), clientCreatedAt: now }));
  for (const state of [queued, withDesktopGraphSync(queued, resumeAfterRestart(preparePush(queued.sync, getSyncContext(queued.sync)).state))]) assert.equal(only(state, [raw('relation', 'Later edit')]).reasonCode, 'GRAPH_PENDING');
  const retained = linked(); retained.sync.conflicts[id(90)] = { conflictId: id(90), attempted: { entityType: 'graphRelation', entityId: id(70), opId: id(80), schemaVersion: 1, baseRevision: 1, mutation: 'put', data: wire('Attempt'), clientCreatedAt: now }, current: record() };
  const review = prepareDesktopGraphReview(retained, [raw()], mapping()); assert.equal(review.rows[0].reasonCode, 'GRAPH_PENDING'); assert.equal(review.incoming[0].kind, 'pending'); assert.equal(review.conflicts.length, 1);
});

test('incoming review separates unaccepted/new, changed, deleted and unmapped records without adopting them', () => {
  const state = staged(), first = prepareDesktopGraphReview(state, [], mapping());
  assert.equal(first.incoming[0].kind, 'new'); assert.equal(first.incoming[0].canAccept, true); assert.equal(state.accepted.length, 0);
  const accepted = acceptDesktopGraphRecords(state, [id(70)]); assert.equal(prepareDesktopGraphReview(accepted, [], mapping()).incoming[0].kind, 'same');
  const next = stageDesktopGraphPull(accepted, [{ protocolVersion: 1, records: [record(2, 'Remote')], nextCursor: 'next', hasMore: false }], mapping(), now);
  assert.equal(prepareDesktopGraphReview(next, [], mapping()).incoming[0].kind, 'update');
  const projection = projectAcceptedDesktopGraphRecords(next, mapping())[0]; assert.equal(projection.kind === 'mapped' && projection.relation.label, 'Original');
  const emptyMapping = createDesktopGraphMapping({ scope, bindings: [], live: { paperIds: [], noteIds: [] } });
  const unmapped = prepareDesktopGraphReview(next, [], emptyMapping).incoming[0]; assert.equal(unmapped.kind, 'unmapped'); assert.equal(unmapped.canAccept, false);
  const deleted = stageDesktopGraphPull(next, [{ protocolVersion: 1, records: [{ ...record(3), deletedAt: now, data: null }], nextCursor: 'deleted', hasMore: false }], mapping(), now);
  assert.equal(prepareDesktopGraphReview(deleted, [], mapping()).incoming[0].kind, 'delete'); assert.equal(deleted.accepted[0].deletedAt, null);
});

test('server-deleted parents block publishing and adopting live graph records despite local mapped materials', () => {
  const state = staged(); state.parentHeads = [{ entityType: 'paper', entityId: id(10), revision: 2, deleted: true }];
  const review = prepareDesktopGraphReview(state, [raw('new')], mapping());
  assert.equal(review.rows[0].reasonCode, 'DELETED_GRAPH_ENDPOINT'); assert.equal(review.incoming[0].kind, 'unmapped'); assert.equal(review.incoming[0].canAccept, false);
});

test('publication atomically saves links with exact stable operation identities before any ACK; restart uses the same outbox', () => {
  const state = fresh(), source = [raw()], review = prepareDesktopGraphReview(state, source, mapping()); let calls = 0;
  const published = materializeDesktopGraphPublication(state, review, [review.rows[0].rowId], () => { calls++; return identity(); });
  assert.equal(calls, 1); assert.equal(published.links[0].entityId, id(70)); assert.equal(published.sync.outbox[0].operation.opId, id(170)); assert.equal(published.sync.outbox[0].operation.baseRevision, 0); assert.equal((published.sync.outbox[0].operation.data as GraphRelationData).confidence, null);
  assert.equal(state.links.length, 0); assert.deepEqual(source, [raw()]); assert.equal(published.accepted.length, 0);
  const push = preparePush(published.sync, getSyncContext(published.sync)), reopened = withDesktopGraphSync(published, resumeAfterRestart(push.state));
  assert.equal(reopened.sync.outbox[0].status, 'uncertain'); assert.deepEqual(reopened.sync.outbox[0].operation, published.sync.outbox[0].operation);
  const pendingReview = prepareDesktopGraphReview(reopened, source, mapping());
  assert.throws(() => materializeDesktopGraphPublication(reopened, pendingReview, [pendingReview.rows[0].rowId], () => { calls++; return identity(71); }), { code: 'GRAPH_PENDING' }); assert.equal(calls, 1);
  const replay = preparePush(reopened.sync, getSyncContext(reopened.sync));
  const acked = withDesktopGraphSync(reopened, applyPushResults(replay.state, replay.context, { protocolVersion: 1, results: [{ opId: id(170), status: 'applied', replayed: true, record: record() }] }, replay.opIds));
  assert.equal(acked.sync.outbox.length, 0); assert.equal(only(acked).kind, 'same'); assert.equal(acked.accepted.length, 0);
});

test('restore is explicit and a failed later batch identity never leaks a partial first publication', () => {
  const deleted = linked(); deleted.sync.serverRecords['graphRelation:' + id(70)] = { ...record(2), deletedAt: now, data: null };
  const review = prepareDesktopGraphReview(deleted, [raw()], mapping());
  assert.equal(deleted.sync.outbox.length, 0);
  const restored = materializeDesktopGraphPublication(deleted, review, [review.rows[0].rowId], () => identity());
  assert.equal(restored.sync.outbox[0].operation.mutation, 'restore'); assert.equal(restored.sync.outbox[0].operation.baseRevision, 2);
  const state = fresh(), batch = prepareDesktopGraphReview(state, [raw('a'), raw('b')], mapping());
  assert.throws(() => materializeDesktopGraphPublication(state, batch, batch.rows.map(row => row.rowId), () => identity()));
  assert.equal(state.sync.outbox.length, 0); assert.equal(state.links.length, 0);
});

test('stale or serialized reviews cannot publish and editing an exposed row cannot alter a prepared draft', () => {
  const state = fresh(), review = prepareDesktopGraphReview(state, [raw()], mapping());
  assert.throws(() => materializeDesktopGraphPublication(state, structuredClone(review), [review.rows[0].rowId], () => identity()), { code: 'GRAPH_MAPPING_CHANGED' });
  const changed = withDesktopGraphSync(state, resumeAfterRestart(state.sync));
  assert.throws(() => materializeDesktopGraphPublication(changed, review, [review.rows[0].rowId], () => identity()), { code: 'GRAPH_MAPPING_CHANGED' });
  review.rows[0].data!.label = 'Tampered';
  const result = materializeDesktopGraphPublication(state, review, [review.rows[0].rowId], () => identity());
  assert.equal((result.sync.outbox[0].operation.data as GraphRelationData).label, 'Original');
  assert.throws(() => materializeDesktopGraphPublication(state, review, [review.rows[0].rowId, review.rows[0].rowId], () => identity()));
});

test('source identity tracks missing/corrupt status and raw changes while mapping identity tracks explicit endpoint binding', () => {
  const state = fresh(), a = prepareDesktopGraphReview(state, [raw()], mapping()), b = prepareDesktopGraphReview(state, [raw('relation', 'Edit')], mapping());
  assert.notEqual(a.sourceIdentity, b.sourceIdentity); assert.equal(a.mappingIdentity, b.mappingIdentity);
  const absent = prepareDesktopGraphReview(state, [], mapping(), { sourceStatus: 'missing' }), empty = prepareDesktopGraphReview(state, [], mapping()); assert.notEqual(absent.sourceIdentity, empty.sourceIdentity);
});
