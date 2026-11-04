import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopNoteState, readDesktopNoteState, withDesktopNoteFeatures, withDesktopNoteSync, stageDesktopNotePull,
  confirmedDesktopNoteBindings, bindDesktopAccountNote, stageDesktopNotePublication, acceptDesktopNotes,
  adoptDesktopNoteCopy, stageDesktopNoteCopyIntents, completeDesktopNoteCopies, stageDesktopNoteResolution, applyDesktopNoteResolution,
  DESKTOP_NOTE_LIMITS, type DesktopNoteCopyIntent, type DesktopNoteExchangeState } from '../packages/sync-core/src/desktopNoteState.ts';
import { applyPushResults, getSyncContext, preparePush, queueLocalEdit, resumeAfterRestart } from '../packages/sync-core/src/state.ts';
import type { MarkdownNoteData, SyncRecord } from '../packages/sync-core/src/types.ts';
import { createRichNoteData } from '../packages/sync-core/src/richNote.ts';
const id = (value: number) => '00000000-0000-4000-8000-' + value.toString(16).padStart(12, '0');
const now = '2026-11-04T10:00:00.000Z', scope = { serviceKey: 'a'.repeat(64), accountId: id(1), libraryBindingId: id(2) };
const data = (body = 'Saved truth'): MarkdownNoteData => ({ title: 'A note', paperId: null, format: 'markdown', body });
const record = (revision = 1, body = 'Saved truth', deletedAt: string | null = null): SyncRecord<'note'> => ({
  entityType: 'note', entityId: id(10), schemaVersion: 1, revision, data: deletedAt ? null : data(body), deletedAt, updatedAt: now, modifiedByDeviceId: id(3),
});
const initial = () => createDesktopNoteState(scope, id(3));
const pull = (state: DesktopNoteExchangeState, row = record()) => stageDesktopNotePull(state, [{ protocolVersion: 1, records: [row], nextCursor: 'c' + row.revision, hasMore: false }], now);
const alias = (name: string) => JSON.stringify(['note', name]);
const copyIntent = (entityId = id(10), localNoteId = 'remote-copy-1', revision = 1): DesktopNoteCopyIntent => ({
  entityId, localNoteId, revision, paperBindings: [{ entityId: id(40), localId: 'paper-at-adoption' }], noteBindings: [{ entityId, localId: localNoteId }],
});
function queued() { return stageDesktopNotePublication(initial(), [{ localNoteId: 'local-note', entityId: id(10), data: data() }], () => id(20), now); }
function acknowledge(state: DesktopNoteExchangeState) {
  const prepared = preparePush(state.sync, getSyncContext(state.sync), 1);
  return withDesktopNoteSync(state, applyPushResults(prepared.state, prepared.context, { protocolVersion: 1, results: [{ opId: prepared.opIds[0], status: 'applied', replayed: false, record: record() }] }, prepared.opIds));
}
test('note snapshots are closed, scoped and detached, retaining no unrelated entity bodies', () => {
  const state = initial(), copied = readDesktopNoteState(state, scope); copied.sync.cursor = 'different'; assert.equal(state.sync.cursor, null);
  for (const changed of [{ ...scope, accountId: id(8) }, { ...scope, libraryBindingId: id(8) }, { ...scope, serviceKey: 'b'.repeat(64) }]) {
    assert.throws(() => readDesktopNoteState(state, changed), /NOTE_SCOPE_CHANGED/);
  }
  assert.throws(() => readDesktopNoteState({ ...state, extra: 'secret' }, scope), /NOTE_STATE_INVALID/);
  assert.throws(() => readDesktopNoteState({ ...state, identityMap: { ...state.identityMap, aliases: { '["paper","paper"]': id(9) } } }, scope), /NOTE_STATE_INVALID/);
});

test('a late pull failure leaves the previous cursor, accepted revision and queued publication intact', () => {
  const accepted = acceptDesktopNotes(acknowledge(queued()), [id(10)]);
  const state = stageDesktopNotePublication(accepted, [{ localNoteId: 'local-note', entityId: id(10), data: data('Local next revision') }], () => id(21), now);
  const before = structuredClone(state);
  assert.throws(() => stageDesktopNotePull(state, [
    { protocolVersion: 1, records: [record(2, 'Remote next revision')], nextCursor: 'c2', hasMore: true },
    { protocolVersion: 1, records: [record(2, 'Different content at the same revision')], nextCursor: 'c3', hasMore: false },
  ], now), /REVISION_COLLISION/);
  assert.deepEqual(state, before);
});
test('checking filters note bodies but consumes complete feed pages and never adopts them', () => {
  const source = record(), before = structuredClone(source);
  const paper: SyncRecord<'paper'> = { ...source, entityType: 'paper', entityId: id(11), data: { title: 'Private paper', authors: [], keywords: [], doi: null, year: null, publication: null, abstractText: 'Not copied into note state' } };
  const state = stageDesktopNotePull(initial(), [
    { protocolVersion: 1, records: [paper], nextCursor: 'c1', hasMore: true },
    { protocolVersion: 1, records: [source], nextCursor: 'c2', hasMore: false },
  ], now);
  assert.equal(state.sync.cursor, 'c2'); assert.equal(state.accepted.length, 0);
  assert.deepEqual(Object.keys(state.sync.serverRecords), ['note:' + id(10)]); assert.deepEqual(source, before);
  assert.throws(() => stageDesktopNotePull(initial(), [{ protocolVersion: 1, records: [source], nextCursor: 'c1', hasMore: true }], now), /NOTE_STATE_INVALID/);
});
test('feature changes reset only the feed while preserving existing drafts and original requests', () => {
  const state = queued(); state.sync.cursor = 'old';
  const enabled = withDesktopNoteFeatures(state, true); assert.equal(enabled.sync.cursor, null);
  assert.deepEqual(enabled.sync.outbox, state.sync.outbox); assert.equal(withDesktopNoteFeatures(enabled, true).revision, enabled.revision);
  enabled.sync.cursor = 'rich-feed'; const disabled = withDesktopNoteFeatures(enabled, false);
  assert.equal(disabled.sync.cursor, null); assert.deepEqual(disabled.sync.outbox, state.sync.outbox);
});
test('a new publication persists a separate mapping and is not a graph binding until a receipt is confirmed', () => {
  const state = queued(); assert.equal(state.identityMap.aliases[alias('local-note')], id(10));
  assert.equal(state.sync.outbox[0].operation.opId, id(20)); assert.deepEqual(confirmedDesktopNoteBindings(state), []);
  const confirmed = acknowledge(state); assert.deepEqual(confirmedDesktopNoteBindings(confirmed), [{ localNoteId: 'local-note', entityId: id(10) }]);
  const changed = stageDesktopNotePublication(confirmed, [{ localNoteId: 'local-note', entityId: id(10), data: data('Changed') }], () => id(21), now);
  assert.deepEqual(confirmedDesktopNoteBindings(changed), []);
});
test('remote note identity requires explicit binding, never a colliding allocation or reused local alias', () => {
  const state = pull(initial());
  assert.throws(() => stageDesktopNotePublication(state, [{ localNoteId: 'local-note', entityId: id(10), data: data('Local') }], () => id(20), now), /NOTE_BINDING_REQUIRED/);
  const bound = bindDesktopAccountNote(state, 'local-note', id(10));
  assert.throws(() => bindDesktopAccountNote(bound, 'another-note', id(10)), /NOTE_BINDING_CONFLICT/);
  assert.throws(() => bindDesktopAccountNote(bound, 'local-note', id(11)), /NOTE_REMOTE_UNAVAILABLE/);
  const publication = stageDesktopNotePublication(bound, [{ localNoteId: 'local-note', entityId: id(10), data: data('Local') }], () => id(20), now);
  assert.equal(publication.sync.outbox[0].operation.baseRevision, 1);
});
test('unchanged content creates no operation and pending publications cannot be silently replaced', () => {
  const bound = bindDesktopAccountNote(pull(initial()), 'local-note', id(10));
  assert.equal(stageDesktopNotePublication(bound, [{ localNoteId: 'local-note', entityId: id(10), data: data() }], () => { throw Error('No allocation'); }, now).sync.outbox.length, 0);
  assert.throws(() => stageDesktopNotePublication(queued(), [{ localNoteId: 'local-note', entityId: id(10), data: data('Other') }], () => id(21), now), /NOTE_PENDING/);
});
test('rich notes require negotiated support and deletion cannot become an implicit restoration', () => {
  const rich = createRichNoteData({ document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich truth' }] }] }, title: 'Rich', paperId: null,
    metadata: { type: 'standalone', anchors: [], tags: [], color: '#fef08a', isFavorite: false, isPinned: false,
      linkedNoteIds: [], linkedPaperIds: [], createdAt: Date.parse(now), updatedAt: Date.parse(now), unresolvedReferences: [] }, assets: [] });
  const rows = [{ localNoteId: 'local-note', entityId: id(10), data: rich }];
  assert.throws(() => stageDesktopNotePublication(initial(), rows, () => id(20), now), /NOTE_RICH_UNAVAILABLE/);
  assert.equal(stageDesktopNotePublication(withDesktopNoteFeatures(initial(), true), rows, () => id(20), now).sync.outbox.length, 1);
  let deleted = acknowledge(queued()); deleted = pull(deleted, record(2, '', now));
  assert.throws(() => stageDesktopNotePublication(deleted, [{ localNoteId: 'local-note', entityId: id(10), data: data() }], () => id(21), now), /NOTE_RESTORE_REQUIRED/);
  const restored = stageDesktopNotePublication(deleted, [{ localNoteId: 'local-note', entityId: id(10), data: data(), mutation: 'restore' }], () => id(21), now);
  assert.equal(restored.sync.outbox[0].operation.mutation, 'restore');
  assert.throws(() => stageDesktopNotePublication(initial(), [{ ...rows[0], data: data(), mutation: 'restore' }], () => id(21), now), /NOTE_RESTORE_REQUIRED/);
});
test('unknown sends survive restart with the exact approved identity and payload', () => {
  const state = queued(), prepared = preparePush(state.sync, getSyncContext(state.sync), 1);
  const resumed = pull(withDesktopNoteSync(state, resumeAfterRestart(prepared.state)), record(2, 'Remote changed while delivery was unknown'));
  const again = preparePush(resumed.sync, getSyncContext(resumed.sync), 1);
  assert.deepEqual(again.request.operations, prepared.request.operations); assert.equal(resumed.sync.outbox[0].status, 'uncertain');
  assert.equal(resumed.identityMap.aliases[alias('local-note')], id(10));
  assert.deepEqual(confirmedDesktopNoteBindings(resumed), []);
  assert.throws(() => acceptDesktopNotes(resumed, [id(10)]), /NOTE_PENDING/);
});
test('acceptance is a separate choice and retains the checked revision until another explicit adoption', () => {
  const checked = pull(initial()), accepted = acceptDesktopNotes(checked, [id(10)]);
  const newer = pull(accepted, record(2, 'New remote revision'));
  assert.equal((newer.accepted[0].data as MarkdownNoteData).body, 'Saved truth');
  assert.equal((acceptDesktopNotes(newer, [id(10)]).accepted[0].data as MarkdownNoteData).body, 'New remote revision');
  assert.throws(() => acceptDesktopNotes(queued(), [id(10)]), /NOTE_REMOTE_UNAVAILABLE/);
});

test('saved adoption snapshots must come from a known checked revision', () => {
  const state = acceptDesktopNotes(pull(initial()), [id(10)]);
  for (const accepted of [[record(2, 'Unchecked future')], [record(1, 'Changed accepted body')], [{ ...record(), entityId: id(11) }]]) {
    assert.throws(() => readDesktopNoteState({ ...state, accepted }, scope), /NOTE_STATE_INVALID/);
  }
  const newer = pull(state, record(2, 'New remote revision'));
  assert.deepEqual(readDesktopNoteState(newer, scope).accepted, state.accepted);
});

test('explicit adoption atomically moves an account binding to a new copy and is idempotent after restart', () => {
  const original = acceptDesktopNotes(acknowledge(queued()), [id(10)]), checked = pull(original, record(2, 'Accepted remote copy'));
  const adopted = adoptDesktopNoteCopy(checked, id(10), 'remote-copy-2');
  assert.deepEqual(adopted.identityMap.aliases, { [alias('remote-copy-2')]: id(10) });
  assert.equal(adopted.accepted[0].revision, 2);
  assert.equal((adopted.accepted[0].data as MarkdownNoteData).body, 'Accepted remote copy');
  assert.deepEqual(confirmedDesktopNoteBindings(adopted), [{ localNoteId: 'remote-copy-2', entityId: id(10) }]);
  assert.deepEqual(checked.identityMap.aliases, { [alias('local-note')]: id(10) });
  assert.equal(checked.accepted[0].revision, 1);
  const reopened = readDesktopNoteState(JSON.parse(JSON.stringify(adopted)), scope);
  assert.deepEqual(adoptDesktopNoteCopy(reopened, id(10), 'remote-copy-2'), reopened);
  const newer = pull(adopted, record(3, 'Unaccepted remote edit'));
  assert.deepEqual(newer.accepted, adopted.accepted); assert.deepEqual(newer.identityMap, adopted.identityMap);
});

test('adoption rejects another note copy binding and all pending or conflicted note targets atomically', () => {
  let state = pull(pull(initial()), { ...record(), entityId: id(11) });
  state = bindDesktopAccountNote(state, 'another-copy', id(11));
  const before = structuredClone(state);
  assert.throws(() => adoptDesktopNoteCopy(state, id(10), 'another-copy'), /NOTE_BINDING_CONFLICT/);
  assert.deepEqual(state, before);
  const pending = stageDesktopNotePublication(acknowledge(queued()), [{ localNoteId: 'local-note', entityId: id(10), data: data('Pending') }], () => id(21), now);
  assert.throws(() => adoptDesktopNoteCopy(pending, id(10), 'remote-copy'), /NOTE_PENDING/);
  assert.throws(() => adoptDesktopNoteCopy(conflicted(), id(10), 'remote-copy'), /NOTE_PENDING/);
});

test('accepting a tombstone retains the existing local-copy binding and requires a new explicit adoption after restoration', () => {
  const adopted = adoptDesktopNoteCopy(pull(initial()), id(10), 'remote-copy-1');
  const deleted = pull(adopted, record(2, '', now));
  assert.deepEqual(deleted.accepted, adopted.accepted);
  const accepted = adoptDesktopNoteCopy(deleted, id(10), 'unused-deleted-copy');
  assert.deepEqual(accepted.identityMap, adopted.identityMap); assert.equal(accepted.accepted[0].deletedAt, now);
  assert.deepEqual(confirmedDesktopNoteBindings(accepted), []);
  assert.deepEqual(adoptDesktopNoteCopy(accepted, id(10), 'unused-deleted-copy'), accepted);
  const restored = pull(accepted, record(3, 'Explicit remote restoration'));
  assert.equal(restored.accepted[0].deletedAt, now);
  const adoptedAgain = adoptDesktopNoteCopy(restored, id(10), 'remote-copy-3');
  assert.deepEqual(adoptedAgain.identityMap.aliases, { [alias('remote-copy-3')]: id(10) });
  assert.equal(adoptedAgain.accepted[0].deletedAt, null);
});

test('unfinished copy intents survive restart with the exact adopted body and frozen peer identities', () => {
  let adopted = adoptDesktopNoteCopy(pull(pull(initial()), { ...record(), entityId: id(11) }), id(10), 'remote-copy-1');
  adopted = bindDesktopAccountNote(adopted, 'peer-before-adoption', id(11));
  const entry = copyIntent(); entry.noteBindings.push({ entityId: id(11), localId: 'peer-before-adoption' });
  const expected = structuredClone(entry), staged = stageDesktopNoteCopyIntents(adopted, [entry]);
  entry.paperBindings[0].localId = 'caller-changed';
  const reopened = readDesktopNoteState(JSON.parse(JSON.stringify(staged)), scope);
  assert.deepEqual(reopened.pendingCopies, [expected]);
  const reboundPeer = adoptDesktopNoteCopy(reopened, id(11), 'peer-after-adoption');
  const later = pull(reboundPeer, record(2, 'New remote revision after interrupted local save'));
  assert.deepEqual(later.pendingCopies, [expected]);
  assert.equal(later.identityMap.aliases[alias('peer-after-adoption')], id(11));
  assert.equal((later.accepted.find(row => row.entityId === id(10))!.data as MarkdownNoteData).body, 'Saved truth');
  assert.deepEqual(stageDesktopNoteCopyIntents(later, [expected]), later);
  assert.throws(() => stageDesktopNoteCopyIntents(later, [{ ...expected, paperBindings: [{ entityId: id(40), localId: 'new-paper-binding' }] }]), /NOTE_COPY_SAVE_UNCONFIRMED/);
});

test('unfinished local saves block new adoption, rebinding and publication until the same copy is confirmed', () => {
  const adopted = adoptDesktopNoteCopy(pull(initial()), id(10), 'remote-copy-1'), staged = stageDesktopNoteCopyIntents(adopted, [copyIntent()]);
  assert.deepEqual(adoptDesktopNoteCopy(staged, id(10), 'remote-copy-1'), staged);
  assert.deepEqual(confirmedDesktopNoteBindings(staged), []);
  assert.throws(() => adoptDesktopNoteCopy(staged, id(10), 'replacement-copy'), /NOTE_COPY_SAVE_UNCONFIRMED/);
  assert.throws(() => stageDesktopNotePublication(staged, [{ localNoteId: 'remote-copy-1', entityId: id(10), data: data('Local edit') }], () => id(20), now), /NOTE_COPY_SAVE_UNCONFIRMED/);
  const newer = pull(staged, record(2, 'Newer account head'));
  assert.throws(() => adoptDesktopNoteCopy(newer, id(10), 'remote-copy-1'), /NOTE_COPY_SAVE_UNCONFIRMED/);
  assert.throws(() => adoptDesktopNoteCopy(newer, id(10), 'remote-copy-2'), /NOTE_COPY_SAVE_UNCONFIRMED/);
  assert.throws(() => acceptDesktopNotes(newer, [id(10)]), /NOTE_COPY_SAVE_UNCONFIRMED/);
  assert.equal(newer.accepted[0].revision, 1); assert.deepEqual(newer.pendingCopies, staged.pendingCopies);
  const completed = completeDesktopNoteCopies(newer, ['remote-copy-1']);
  const accepted = adoptDesktopNoteCopy(completed, id(10), 'remote-copy-2');
  assert.equal(accepted.accepted[0].revision, 2); assert.equal(accepted.identityMap.aliases[alias('remote-copy-2')], id(10));
});

test('a remote tombstone cannot discard the source of an interrupted local copy save', () => {
  const staged = stageDesktopNoteCopyIntents(adoptDesktopNoteCopy(pull(initial()), id(10), 'remote-copy-1'), [copyIntent()]);
  const deleted = pull(staged, record(2, '', now)), before = structuredClone(deleted);
  assert.throws(() => adoptDesktopNoteCopy(deleted, id(10), 'unused-deleted-copy'), /NOTE_COPY_SAVE_UNCONFIRMED/);
  assert.throws(() => acceptDesktopNotes(deleted, [id(10)]), /NOTE_COPY_SAVE_UNCONFIRMED/);
  assert.deepEqual(deleted, before); assert.equal((deleted.accepted[0].data as MarkdownNoteData).body, 'Saved truth');
  const completed = completeDesktopNoteCopies(deleted, ['remote-copy-1']);
  const accepted = adoptDesktopNoteCopy(completed, id(10), 'unused-deleted-copy');
  assert.equal(accepted.accepted[0].deletedAt, now); assert.deepEqual(accepted.identityMap, staged.identityMap);
});

test('copy intent batches are atomic and persisted sources, identities and binding lists are strictly validated', () => {
  const adopted = adoptDesktopNoteCopy(pull(initial()), id(10), 'remote-copy-1'), entry = copyIntent();
  assert.throws(() => stageDesktopNoteCopyIntents(adopted, [entry, copyIntent(id(11), 'missing-copy')]), /NOTE_STATE_INVALID/);
  assert.deepEqual(adopted.pendingCopies, []);
  const invalid = [
    { ...entry, revision: 2 }, { ...entry, localNoteId: 'unbound-copy' }, { ...entry, entityId: id(11) }, { ...entry, extra: 'not-an-identity' },
    { ...entry, paperBindings: [{ entityId: id(40), localId: 'paper-1' }, { entityId: id(40), localId: 'paper-2' }] },
    { ...entry, noteBindings: [{ entityId: id(10), localId: 'same-copy' }, { entityId: id(11), localId: 'same-copy' }] },
    { ...entry, noteBindings: [{ entityId: id(10), localId: '../outside' }] },
    { ...entry, paperBindings: [{ entityId: 'not-an-account-id', localId: 'paper' }] },
  ];
  for (const value of invalid) assert.throws(() => readDesktopNoteState({ ...adopted, pendingCopies: [value] }, scope), /NOTE_STATE_INVALID/);
  assert.throws(() => readDesktopNoteState({ ...adopted, pendingCopies: [entry, entry] }, scope), /NOTE_STATE_INVALID/);
  const deleted = adoptDesktopNoteCopy(pull(adopted, record(2, '', now)), id(10), 'unused-deleted-copy');
  assert.throws(() => readDesktopNoteState({ ...deleted, pendingCopies: [{ ...entry, revision: 2 }] }, scope), /NOTE_STATE_INVALID/);
  const overLimit = { ...entry, paperBindings: Array.from({ length: DESKTOP_NOTE_LIMITS.copyBindings + 1 }, (_, index) => ({ entityId: id(index + 100), localId: 'paper-' + index })) };
  assert.throws(() => stageDesktopNoteCopyIntents(adopted, [overLimit]), /NOTE_STATE_FULL/);
});

test('only explicit confirmed local IDs clear copy intents and a repeated completion leaves other copies intact', () => {
  let adopted = adoptDesktopNoteCopy(pull(pull(initial()), { ...record(), entityId: id(11) }), id(10), 'remote-copy-1');
  adopted = adoptDesktopNoteCopy(adopted, id(11), 'second-copy-1');
  const staged = stageDesktopNoteCopyIntents(adopted, [copyIntent(), copyIntent(id(11), 'second-copy-1')]);
  const completed = completeDesktopNoteCopies(staged, ['remote-copy-1']);
  assert.deepEqual(completed.pendingCopies, [copyIntent(id(11), 'second-copy-1')]);
  assert.deepEqual(completed.accepted, staged.accepted); assert.deepEqual(completed.identityMap, staged.identityMap);
  assert.deepEqual(confirmedDesktopNoteBindings(completed), [{ localNoteId: 'remote-copy-1', entityId: id(10) }]);
  assert.deepEqual(completeDesktopNoteCopies(completed, ['remote-copy-1']), completed);
  assert.deepEqual(completeDesktopNoteCopies(completed, []), completed);
  assert.deepEqual(completeDesktopNoteCopies(completed, ['unrelated-local-note']), completed);
  assert.equal(completeDesktopNoteCopies(completed, ['second-copy-1']).pendingCopies.length, 0);
});

function conflicted() {
  const original = queued(), prepared = preparePush(original.sync, getSyncContext(original.sync), 1);
  const sync = applyPushResults(prepared.state, prepared.context, { protocolVersion: 1, results: [{ opId: id(20), status: 'conflict', replayed: false, conflictId: id(30), record: record(4, 'Remote') }] }, prepared.opIds);
  return withDesktopNoteSync(original, sync);
}
test('conflict resolution retains original request and preserves a later overlay edit', () => {
  let state = conflicted();
  state = withDesktopNoteSync(state, queueLocalEdit(state.sync, { entityType: 'note', entityId: id(10), mutation: 'put', data: data('First overlay') }, { opId: id(21), clientCreatedAt: now }));
  const pending = stageDesktopNoteResolution(state, id(30), 'current', 4, id(31));
  assert.throws(() => stageDesktopNoteResolution(pending, id(30), 'attempted', 4, id(32)), /NOTE_PENDING/);
  const edited = withDesktopNoteSync(pending, queueLocalEdit(pending.sync, { entityType: 'note', entityId: id(10), mutation: 'put', data: data('Later overlay') }, { opId: id(22), clientCreatedAt: now }));
  const resolved = applyDesktopNoteResolution(edited, id(30), { opId: id(31), status: 'applied', replayed: false, record: record(4, 'Remote') });
  assert.equal(resolved.pendingResolutions.length, 0); assert.equal(resolved.sync.outbox[0].operation.opId, id(22));
  assert.equal((resolved.sync.outbox[0].operation.data as MarkdownNoteData).body, 'Later overlay');
});
test('a confirmed resolution conflict can be reviewed again without retrying a now obsolete expected revision', () => {
  const first = stageDesktopNoteResolution(conflicted(), id(30), 'attempted', 4, id(31));
  const changed = applyDesktopNoteResolution(first, id(30), { opId: id(31), status: 'conflict', replayed: false, conflictId: id(30), record: record(5, 'Later remote') });
  assert.throws(() => stageDesktopNoteResolution(changed, id(30), 'current', 4, id(32)), /NOTE_CONFLICT_CHANGED/);
  assert.throws(() => stageDesktopNoteResolution(changed, id(30), 'current', 5, id(31)), /NOTE_CONFLICT_CHANGED/);
  const reviewed = stageDesktopNoteResolution(changed, id(30), 'current', 5, id(32));
  assert.equal(reviewed.pendingResolutions[0].request.opId, id(32));
  assert.equal((reviewed.sync.conflicts[id(30)].attempted.data as MarkdownNoteData).body, 'Saved truth');
});

test('a retryable resolution keeps its original request across restart and newer remote edits', () => {
  const staged = stageDesktopNoteResolution(conflicted(), id(30), 'current', 4, id(31));
  const retryable = applyDesktopNoteResolution(staged, id(30), { opId: id(31), status: 'rejected', replayed: false, code: 'SERVICE_TEMPORARILY_UNAVAILABLE', retryable: true });
  const reopened = readDesktopNoteState(JSON.parse(JSON.stringify(retryable)), scope);
  const newer = pull(withDesktopNoteSync(reopened, resumeAfterRestart(reopened.sync)), record(5, 'Newer head'));
  assert.deepEqual(newer.pendingResolutions[0].request, staged.pendingResolutions[0].request);
  assert.throws(() => stageDesktopNoteResolution(newer, id(30), 'attempted', 5, id(32)), /NOTE_PENDING/);
  const applied = applyDesktopNoteResolution(newer, id(30), { opId: id(31), status: 'applied', replayed: true, record: record(4, 'Remote') });
  assert.equal(applied.pendingResolutions.length, 0); assert.equal(applied.sync.serverRecords['note:' + id(10)].revision, 5);
});

test('terminal resolution receipts allow exact replays but cannot turn into a different result', () => {
  const staged = stageDesktopNoteResolution(conflicted(), id(30), 'attempted', 4, id(31));
  const result = { opId: id(31), status: 'conflict' as const, replayed: false, conflictId: id(30), record: record(5, 'Later remote') };
  const terminal = applyDesktopNoteResolution(staged, id(30), result);
  const replayed = applyDesktopNoteResolution(terminal, id(30), { ...result, replayed: true });
  assert.equal(replayed.sync.serverRecords['note:' + id(10)].revision, 5);
  assert.deepEqual(replayed.pendingResolutions[0].request, staged.pendingResolutions[0].request);
  assert.throws(() => applyDesktopNoteResolution(replayed, id(30), { opId: id(31), status: 'applied', replayed: true, record: record(5, 'Later remote') }), /NOTE_STATE_INVALID/);
  assert.throws(() => applyDesktopNoteResolution(replayed, id(30), { ...result, replayed: true, record: record(6, 'Different receipt') }), /NOTE_STATE_INVALID/);
});

test('resolution cannot consume a pending operation identity or clear a conflict with a missing, old or mismatched receipt', () => {
  const state = conflicted();
  assert.throws(() => stageDesktopNoteResolution(state, id(30), 'current', 4, id(20)), /NOTE_STATE_INVALID/);
  const staged = stageDesktopNoteResolution(state, id(30), 'current', 4, id(31)), before = structuredClone(staged);
  for (const extra of [{}, { record: record(3, 'Outdated') }, { record: { ...record(4), entityId: id(11) } }]) {
    assert.throws(() => applyDesktopNoteResolution(staged, id(30), { opId: id(31), status: 'applied', replayed: false, ...extra }), /NOTE_STATE_INVALID/);
  }
  assert.deepEqual(staged, before);
  const wrongStoredTarget = structuredClone(staged);
  wrongStoredTarget.pendingResolutions[0].lastResult = { opId: id(31), status: 'conflict', replayed: false, conflictId: id(30), record: { ...record(5), entityId: id(11) } };
  assert.throws(() => readDesktopNoteState(wrongStoredTarget, scope), /NOTE_STATE_INVALID/);
});
