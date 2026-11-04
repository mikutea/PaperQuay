import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../packages/sync-core/src/index.ts';
import type { DesktopPaperExchangeState, DesktopPaperMetadata, DesktopPaperAdoption, PaperData, SyncRecord } from '../packages/sync-core/src/index.ts';

const id = (value: number) => '00000000-0000-4000-8000-' + value.toString(16).padStart(12, '0');
const at = '2026-11-04T11:00:00.000Z', scope = { serviceKey: 'a'.repeat(64), accountId: id(1), libraryBindingId: id(2) };
const data = (title = 'Account title'): PaperData => ({ title, year: null, publication: null, doi: null, abstractText: null, authors: ['Same author'], keywords: ['Evidence'] });
const organization = { favorite: true, readingStatus: 'reading' as const, tags: ['Account tag'], collections: ['Independent name'], queueRank: 4 };
const record = (revision = 1, value: PaperData | null = data()): SyncRecord<'paper'> => ({ entityType: 'paper', entityId: id(10), schemaVersion: 1,
  revision, data: value, deletedAt: value === null ? at : null, modifiedByDeviceId: id(3), updatedAt: at });
const binding = { localPaperId: 'local-paper', entityId: id(10) };
const empty = () => core.createDesktopPaperState(scope, id(3));
const pull = (state = empty(), row = record()) => core.stageDesktopPaperPull(state, [{ protocolVersion: 1, records: [row], nextCursor: 'c' + row.revision, hasMore: false }], at);
const bound = (row = record()) => core.withDesktopPaperBindings(core.withDesktopPaperFeatures(pull(empty(), row), true), [binding]);
const before = (): DesktopPaperMetadata => ({ title: 'Original title', year: null, publication: null, doi: null, abstractText: null, keywords: ['Before'], isFavorite: false, updatedAt: 100,
  authors: [{ id: 'original-author-id', name: 'Same author', givenName: 'Same', familyName: 'author', sortOrder: 0 }], tags: [{ id: 'old-tag', name: 'Old tag', color: 'blue', sortOrder: 0 }] });
function adoption(row = record()): DesktopPaperAdoption {
  const original = before(), next = { ...original, ...row.data!, authors: row.data!.authors.map((name, sortOrder) => ({ ...original.authors[0], name, sortOrder })), updatedAt: 200 };
  delete (next as Record<string, unknown>).organization;
  if (row.data!.organization) { next.tags = row.data!.organization.tags.map((name, sortOrder) => ({ id: 'tag-' + name, name, color: null as unknown as string, sortOrder })); next.isFavorite = row.data!.organization.favorite; }
  return { ...binding, adoptionId: id(20), record: row, before: original, after: next, phase: 'pending', createdAt: at, beforeOrganization: null,
    afterOrganization: row.data!.organization ? { readingStatus: row.data!.organization.readingStatus, queueRank: row.data!.organization.queueRank, collections: row.data!.organization.collections } : null };
}
function queued() { return core.stageDesktopPaperPublication(bound(), [{ ...binding, data: data('Explicit local publication') }], () => id(30), at); }

test('paper state is closed, scoped, detached and limited to paper bodies', () => {
  const state = empty(), copy = core.readDesktopPaperState(state, scope); copy.sync.cursor = 'changed'; assert.equal(state.sync.cursor, null);
  for (const changed of [{ ...scope, accountId: id(90) }, { ...scope, serviceKey: 'b'.repeat(64) }, { ...scope, libraryBindingId: id(90) }]) assert.throws(() => core.readDesktopPaperState(state, changed), /PAPER_SCOPE_CHANGED/);
  assert.throws(() => core.readDesktopPaperState({ ...state, unexpected: '/private/path' }, scope), /PAPER_STATE_INVALID/);
  const mixed = structuredClone(state); mixed.sync.serverRecords['note:' + id(9)] = { ...record(), entityType: 'note', entityId: id(9), data: { paperId: null, title: 'Private', body: 'not a paper', format: 'markdown' } };
  assert.throws(() => core.readDesktopPaperState(mixed, scope), /PAPER_STATE_INVALID/);
});

test('metadata capture contains only the update whitelist and never invokes accessors', () => {
  const raw = { id: 'local-paper', ...before(), attachments: [{ storedPath: 'private-attachment-path' }], categoryIds: ['category'], readingProgress: .7, userNote: 'Private note' };
  assert.deepEqual(core.captureDesktopPaperMetadata(raw), before()); assert.ok(!JSON.stringify(core.captureDesktopPaperMetadata(raw)).includes('private-attachment'));
  let invoked = false; Object.defineProperty(raw, 'title', { get() { invoked = true; return 'Unsafe'; } });
  assert.throws(() => core.captureDesktopPaperMetadata(raw), /PAPER_SOURCE_UNSUPPORTED/); assert.equal(invoked, false);
  assert.throws(() => core.readDesktopPaperMetadata({ ...before(), attachments: [] }), /PAPER_SOURCE_UNSUPPORTED/);
});

test('legacy projection stays unchanged and only explicit negotiated organization snapshots are emitted', () => {
  const identityMap = core.createDesktopIdentityMap(scope.accountId, scope.libraryBindingId), papers = [{ id: 'local-paper', ...before(), readingProgress: 1, categoryIds: ['same-named-child'], organization }];
  const input = { ...scope, identityMap, papers, paperOrganizations: { 'local-paper': organization } };
  const legacy = core.projectDesktopLibrary(input, () => id(10)); const explicit = core.projectDesktopLibrary({ ...input, paperOrganizationEnabled: true }, () => id(10));
  assert.equal((legacy.entities[0].data as PaperData).organization, undefined);
  assert.deepEqual((explicit.entities[0].data as PaperData).organization, organization);
  const absent = core.projectDesktopLibrary({ ...input, paperOrganizationEnabled: true, paperOrganizations: {} }, () => id(10));
  assert.equal((absent.entities[0].data as PaperData).organization, undefined, 'no inference from progress, raw organization or category IDs');
});

test('pull consumes the complete feed without adopting or retaining unrelated bodies', () => {
  const note: SyncRecord<'note'> = { ...record(), entityType: 'note', data: { title: 'Private note', paperId: null, format: 'markdown', body: 'unrelated' } };
  const state = core.stageDesktopPaperPull(empty(), [{ protocolVersion: 1, records: [note, record()], nextCursor: 'all-feed', hasMore: false }], at);
  assert.deepEqual(Object.keys(state.sync.serverRecords), ['paper:' + id(10)]); assert.equal(state.sync.cursor, 'all-feed'); assert.deepEqual(state.accepted, []);
  const original = structuredClone(state);
  assert.throws(() => core.stageDesktopPaperPull(state, [{ protocolVersion: 1, records: [record(2)], nextCursor: 'next', hasMore: true },
    { protocolVersion: 1, records: [record(2, data('Same revision changed'))], nextCursor: 'bad', hasMore: false }], at), /REVISION_COLLISION/);
  assert.deepEqual(state, original);
});

test('bindings are unique and cannot move an existing publication to a different local source', () => {
  assert.throws(() => core.withDesktopPaperBindings(empty(), [binding, { ...binding, localPaperId: 'other' }]), /PAPER_BINDING_CONFLICT/);
  assert.throws(() => core.withDesktopPaperBindings(queued(), []), /PAPER_BINDING_CHANGED/);
  assert.throws(() => core.withDesktopPaperBindings(queued(), [{ ...binding, localPaperId: 'replacement' }]), /PAPER_BINDING_CHANGED/);
  assert.throws(() => core.stageDesktopPaperPublication(pull(), [{ ...binding, data: data() }], () => id(30), at), /PAPER_BINDING_REQUIRED/);
});

test('organization choice is private, requires negotiation and never queues a publication implicitly', () => {
  const state = bound(), choice = { readingStatus: 'read' as const, queueRank: 8, collections: ['Same name is not a category ID'] };
  const next = core.updateDesktopPaperOrganization(state, binding.localPaperId, choice);
  assert.equal(next.sync.outbox.length, 0); assert.deepEqual(next.organizations[0].value, choice); assert.equal(state.organizations.length, 0);
  assert.throws(() => core.updateDesktopPaperOrganization(core.withDesktopPaperFeatures(state, false), binding.localPaperId, choice), /PAPER_ORGANIZATION_UNAVAILABLE/);
  assert.throws(() => core.updateDesktopPaperOrganization(state, binding.localPaperId, { ...choice, queueRank: -1 }), /PAPER_ORGANIZATION_INVALID/);
});

test('publication uses an existing confirmed entity and preserves its base revision and operation ID', () => {
  const state = queued(), operation = state.sync.outbox[0].operation;
  assert.equal(operation.entityId, id(10)); assert.equal(operation.baseRevision, 1); assert.equal(operation.opId, id(30)); assert.equal(operation.mutation, 'put');
  assert.throws(() => core.stageDesktopPaperPublication(state, [{ ...binding, data: data('Later edit') }], () => id(31), at), /PAPER_PENDING/);
  assert.throws(() => core.stageDesktopPaperPublication(bound(record(2, null)), [{ ...binding, data: data() }], () => id(31), at), /PAPER_REMOTE_UNAVAILABLE/);
  assert.equal(core.stageDesktopPaperPublication(bound(), [{ ...binding, data: data() }], () => { throw Error('No new operation'); }, at).sync.outbox.length, 0);
});

test('organization is never silently stripped from an account record', () => {
  const state = bound(record(1, { ...data(), organization }));
  assert.throws(() => core.stageDesktopPaperPublication(state, [{ ...binding, data: data('Metadata only') }], () => id(30), at), /PAPER_ORGANIZATION_UNAVAILABLE/);
  assert.throws(() => core.stageDesktopPaperPublication(core.withDesktopPaperFeatures(state, false), [{ ...binding, data: { ...data(), organization } }], () => id(30), at), /PAPER_ORGANIZATION_UNAVAILABLE/);
});

test('adoption freezes source and both local snapshots before acceptance', () => {
  const row = record(1, { ...data(), organization }), intent = adoption(row), staged = core.stageDesktopPaperAdoptions(bound(row), [intent]);
  assert.equal(staged.accepted.length, 0); assert.equal(staged.adoptions[0].phase, 'pending'); intent.before.title = 'Mutated outside'; assert.equal(staged.adoptions[0].before.title, 'Original title');
  const complete = core.completeDesktopPaperAdoptions(staged, [id(20)]); assert.equal(complete.adoptions[0].phase, 'applied'); assert.deepEqual(complete.accepted[0], row);
  assert.deepEqual(complete.organizations[0].value, { readingStatus: 'reading', queueRank: 4, collections: ['Independent name'] });
  assert.equal(complete.adoptions[0].before.authors[0].givenName, 'Same'); assert.equal(complete.adoptions[0].before.tags[0].color, 'blue');
});

test('adoption rejects a tombstone, guessed binding, altered preview or mismatched metadata', () => {
  assert.throws(() => core.stageDesktopPaperAdoptions(bound(record(2, null)), [adoption()]), /PAPER_REMOTE_UNAVAILABLE/);
  assert.throws(() => core.stageDesktopPaperAdoptions(pull(), [adoption()]), /PAPER_BINDING_REQUIRED/);
  const changed = adoption(); changed.after.title = 'Not the selected account title'; assert.throws(() => core.stageDesktopPaperAdoptions(bound(), [changed]), /PAPER_PREVIEW_STALE/);
  const original = adoption(); original.after.tags = []; assert.throws(() => core.stageDesktopPaperAdoptions(bound(), [original]), /PAPER_PREVIEW_STALE/);
  const staged = core.stageDesktopPaperAdoptions(bound(), [adoption()]);
  assert.throws(() => core.stageDesktopPaperPublication(staged, [{ ...binding, data: data('Conflict') }], () => id(30), at), /PAPER_ADOPTION_UNCONFIRMED/);
});

test('same-revision organization hydration keeps previous adoption evidence intact', () => {
  const original = core.completeDesktopPaperAdoptions(core.stageDesktopPaperAdoptions(bound(), [adoption()]), [id(20)]);
  const hydrated = pull(original, record(1, { ...data(), organization }));
  assert.equal(hydrated.accepted[0].data?.organization, undefined); assert.equal(hydrated.adoptions[0].record.data?.organization, undefined);
  assert.deepEqual((hydrated.sync.serverRecords['paper:' + id(10)].data as PaperData).organization, organization);
  assert.doesNotThrow(() => pull(core.withDesktopPaperFeatures(hydrated, false), record()));
  assert.throws(() => pull(core.withDesktopPaperFeatures(hydrated, false), record(2, data('Unknown organization revision'))), /PAPER_ORGANIZATION_UNAVAILABLE/);
});

test('conflict resolution retains both versions and original request while an outcome is unknown', () => {
  let state = queued(); const operation = state.sync.outbox[0].operation, current = record(2, data('Concurrent account title'));
  const prepared = core.preparePush(state.sync, core.getSyncContext(state.sync), 1);
  state = core.withDesktopPaperSync(state, core.applyPushResults(prepared.state, prepared.context, { protocolVersion: 1, results: [{ opId: operation.opId, status: 'conflict', replayed: false, conflictId: id(50), record: current }] }, prepared.opIds));
  assert.equal(state.sync.conflicts[id(50)].attempted.data?.title, 'Explicit local publication'); assert.equal(state.sync.conflicts[id(50)].current?.data?.title, 'Concurrent account title');
  assert.throws(() => core.stageDesktopPaperResolution(state, id(50), 'attempted', 1, id(51)), /PAPER_CONFLICT_CHANGED/);
  const staged = core.stageDesktopPaperResolution(state, id(50), 'attempted', 2, id(51)); assert.equal(staged.pendingResolutions[0].request.opId, id(51));
  assert.throws(() => core.stageDesktopPaperResolution(staged, id(50), 'current', 2, id(52)), /PAPER_PENDING/);
  const complete = core.applyDesktopPaperResolution(staged, id(50), { opId: id(51), status: 'applied', replayed: true, record: record(3, data('Explicit local publication')) });
  assert.equal(complete.pendingResolutions.length, 0); assert.equal(Object.keys(complete.sync.conflicts).length, 0);
});

test('local restoration is journaled and does not fabricate a remote record or operation', () => {
  const row = record(1, { ...data(), organization });
  const accepted = core.completeDesktopPaperAdoptions(core.stageDesktopPaperAdoptions(bound(row), [adoption(row)]), [id(20)]);
  const restoring = core.stageDesktopPaperRestoration(accepted, id(20)); assert.equal(restoring.adoptions[0].phase, 'restoring');
  assert.deepEqual(core.stageDesktopPaperRestoration(restoring, id(20)), restoring);
  const restored = core.completeDesktopPaperRestorations(restoring, [id(20)]); assert.equal(restored.adoptions[0].phase, 'restored'); assert.equal(restored.organizations.length, 0);
  assert.deepEqual(restored.accepted, accepted.accepted); assert.deepEqual(restored.sync, accepted.sync); assert.deepEqual(core.stageDesktopPaperRestoration(restored, id(20)), restored);
});

test('a later organization choice blocks undo while the old whitelist remains available', () => {
  const row = record(1, { ...data(), organization }), accepted = core.completeDesktopPaperAdoptions(core.stageDesktopPaperAdoptions(bound(row), [adoption(row)]), [id(20)]);
  const edited = core.updateDesktopPaperOrganization(accepted, binding.localPaperId, { readingStatus: 'read', queueRank: null, collections: ['New local choice'] });
  assert.throws(() => core.stageDesktopPaperRestoration(edited, id(20)), /PAPER_ORGANIZATION_CHANGED/); assert.equal(edited.adoptions[0].before.title, 'Original title');
});

test('old organization choices remain private evidence when the same local paper is deliberately rebound', () => {
  const first = core.updateDesktopPaperOrganization(bound(), binding.localPaperId, { readingStatus: 'read', queueRank: null, collections: ['First association'] });
  const secondRecord = { ...record(), entityId: id(11) };
  const fetched = core.stageDesktopPaperPull(first, [{ protocolVersion: 1, records: [secondRecord], nextCursor: 'second', hasMore: false }], at);
  const second = core.withDesktopPaperBindings(fetched, [{ ...binding, entityId: id(11) }]);
  const next = core.updateDesktopPaperOrganization(second, binding.localPaperId, { readingStatus: 'reading', queueRank: 0, collections: ['Second association'] });
  assert.equal(next.organizations.length, 2); assert.deepEqual(next.organizations.find(row => row.entityId === id(10))?.value.collections, ['First association']);
  assert.deepEqual(next.organizations.find(row => row.entityId === id(11))?.value.collections, ['Second association']);
});
