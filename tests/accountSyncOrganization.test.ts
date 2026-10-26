import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPullPage, createAccountState, entityKey, getSyncContext, getVisibleEntity,
  projectLegacyPaper, queueLocalEdit, validateEntityData, type PaperData, type PaperOrganization, type SyncRecord } from '../packages/sync-core/src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const organization: PaperOrganization = { favorite: true, readingStatus: 'reading', tags: ['fieldwork'], collections: ['thesis'], queueRank: 12 };
const paper: PaperData = { title: 'A paper', authors: [], keywords: [], year: '2026', doi: null, publication: null, abstractText: null };
const record = (data: PaperData): SyncRecord<'paper'> => ({ entityType: 'paper', entityId: id(3), schemaVersion: 1, revision: 2,
  data, deletedAt: null, updatedAt: '2026-10-25T10:00:00.000Z', modifiedByDeviceId: id(2) });
const receive = (state: ReturnType<typeof createAccountState>, row: SyncRecord) => applyPullPage(state, getSyncContext(state), {
  fromCursor: state.cursor, response: { protocolVersion: 1, records: [row], nextCursor: 'current', hasMore: false },
});

test('paper organization is optional for M1 but validates closed and bounded M2 fields', () => {
  assert.equal(validateEntityData('paper', paper).ok, true);
  assert.equal(validateEntityData('paper', { ...paper, organization }).ok, true);
  for (const invalid of [null, {}, { ...organization, apiKey: 'private' }, { ...organization, queueRank: -1 },
    { ...organization, queueRank: 0.5 }, { ...organization, queueRank: Number.MAX_SAFE_INTEGER + 1 },
    { ...organization, readingStatus: 'done' }, { ...organization, tags: [''] },
    { ...organization, tags: ['x'.repeat(81)] }, { ...organization, tags: Array(65).fill('tag') },
    { ...organization, collections: Array(33).fill('collection') }]) {
    assert.equal(validateEntityData('paper', { ...paper, organization: invalid }).ok, false);
  }
});

test('legacy projection strips only paper organization and leaves the stored record intact', () => {
  const original = record({ ...paper, organization });
  const legacy = projectLegacyPaper(original);
  assert.deepEqual(legacy, record(paper));
  assert.deepEqual(original.data?.organization, organization);
  assert.equal(projectLegacyPaper(legacy), legacy);
});

test('a full feed hydration adds same-revision organization while retaining pending edits', () => {
  const cached = receive(createAccountState(id(1), id(2)), record(paper));
  const pending = queueLocalEdit(cached, { entityType: 'paper', entityId: id(3), mutation: 'put', data: { ...paper, title: 'Local draft' } },
    { opId: id(4), clientCreatedAt: '2026-10-25T10:01:00.000Z' });
  const hydrated = receive(pending, record({ ...paper, organization }));
  assert.deepEqual(hydrated.outbox, pending.outbox);
  assert.equal((getVisibleEntity(hydrated, 'paper', id(3))?.data as PaperData).title, 'Local draft');
  assert.deepEqual((hydrated.serverRecords[entityKey('paper', id(3))].data as PaperData).organization, organization);
  assert.throws(() => receive(hydrated, record({ ...paper, organization: { ...organization, favorite: false } })), /REVISION_COLLISION/);
  assert.throws(() => receive(cached, record({ ...paper, title: 'Unexpected same revision', organization })), /REVISION_COLLISION/);
  assert.throws(() => receive(hydrated, record(paper)), /REVISION_COLLISION/);
});
