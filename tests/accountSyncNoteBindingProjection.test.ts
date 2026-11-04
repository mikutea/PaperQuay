import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopIdentityMap, projectDesktopLibrary, type DesktopProjectionInput } from '../packages/sync-core/src/desktopProjection.ts';
import { richNoteUnresolvedId, type RichNoteData } from '../packages/sync-core/src/richNote.ts';
const id = (value: number) => '00000000-0000-4000-8000-' + value.toString(16).padStart(12, '0');
function input(): DesktopProjectionInput {
  const identityMap = createDesktopIdentityMap(id(1), id(2));
  identityMap.aliases[JSON.stringify(['note', 'published-peer'])] = id(20);
  return { accountId: id(1), libraryBindingId: id(2), identityMap, papers: [], notes: [{
    id: 'new-note', paperId: 'global-notes', type: 'standalone', title: 'New note',
    contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'A confirmed peer: ' }, { type: 'wikiLink', attrs: { id: 'published-peer', label: 'Peer' } },
    ] }] }, anchors: [], tags: [], linkedNoteIds: ['published-peer'], linkedPaperIds: [], createdAt: 100, updatedAt: 200,
  }] };
}
function projected(value: DesktopProjectionInput) {
  let allocation = 50;
  const result = projectDesktopLibrary(value, () => id(allocation++));
  assert.equal(result.skipped.length, 0); assert.equal(result.entities.length, 1);
  return result.entities[0].data as RichNoteData;
}
test('a selected note may refer to an already confirmed account peer without republishing or recapturing it', () => {
  const value = input(), before = structuredClone(value);
  const data = projected({ ...value, confirmedNotes: [{ localNoteId: 'published-peer', entityId: id(20) }] });
  assert.equal(data.document.content![0].content![1].attrs!.id, id(20));
  assert.deepEqual(data.metadata.linkedNoteIds, [id(20)]);
  assert.equal(data.metadata.unresolvedReferences.length, 0);
  assert.deepEqual(value, before);
});
test('a local alias or equal-looking UUID alone never turns an unconfirmed peer into an account reference', () => {
  const value = input(), data = projected(value);
  assert.equal(data.document.content![0].content![1].attrs!.id, richNoteUnresolvedId('note', 'published-peer'));
  const raw = structuredClone(value.notes![0]) as any;
  raw.contentJson.content[0].content[1].attrs.id = id(20); raw.linkedNoteIds = [id(20)];
  const equal = projected({ ...value, notes: [raw] });
  assert.equal(equal.document.content![0].content![1].attrs!.id, richNoteUnresolvedId('note', id(20)));
});
test('confirmation must match the current private identity map and remain one-to-one', () => {
  for (const confirmedNotes of [
    [{ localNoteId: 'published-peer', entityId: id(21) }],
    [{ localNoteId: 'unmapped', entityId: id(20) }],
    [{ localNoteId: 'published-peer', entityId: id(20) }, { localNoteId: 'published-peer', entityId: id(20) }],
  ]) assert.throws(() => projected({ ...input(), confirmedNotes }), /INVALID_CONFIRMED_NOTE_BINDING/);
});

test('a historical unresolved note token remains separate from an explicitly confirmed local reference with the same source id', () => {
  const value = input(), raw = structuredClone(value.notes![0]) as any, token = richNoteUnresolvedId('note', 'published-peer');
  raw.contentJson.content[0].content.push({ type: 'wikiLink', attrs: { id: token, label: 'Historical peer' } });
  raw.linkedNoteIds.push(token);
  raw.unresolvedReferences = [{ kind: 'note', id: token, label: 'Historical peer', reason: 'historical-unverified' }];
  const data = projected({ ...value, notes: [raw], confirmedNotes: [{ localNoteId: 'published-peer', entityId: id(20) }] });
  assert.equal(data.document.content![0].content![1].attrs!.id, id(20));
  assert.equal(data.document.content![0].content![2].attrs!.id, token);
  assert.deepEqual(data.metadata.linkedNoteIds, [id(20), token]);
  assert.deepEqual(data.metadata.unresolvedReferences, raw.unresolvedReferences);
});

test('persisted unresolved descriptions prevent a bare historical source id from becoming an unrelated current binding', () => {
  const value = input(), raw = structuredClone(value.notes![0]) as any;
  raw.unresolvedReferences = [{ kind: 'note', id: 'published-peer', label: 'Prior account peer', reason: 'missing' }];
  const data = projected({ ...value, notes: [raw], confirmedNotes: [{ localNoteId: 'published-peer', entityId: id(20) }] });
  assert.equal(data.document.content![0].content![1].attrs!.id, richNoteUnresolvedId('note', 'published-peer'));
  assert.deepEqual(data.metadata.unresolvedReferences, [{ ...raw.unresolvedReferences[0], id: richNoteUnresolvedId('note', 'published-peer') }]);
});

test('a verified paper mapping is not reinterpreted as another local paper id during the second projection phase', () => {
  const value = input(), raw = structuredClone(value.notes![0]) as any, token = richNoteUnresolvedId('paper', 'paper-local');
  value.identityMap.aliases[JSON.stringify(['paper', 'paper-local'])] = id(60);
  value.identityMap.aliases[JSON.stringify(['paper', id(60)])] = id(61);
  raw.contentJson.content[0].content.push({ type: 'paperReference', attrs: { paperId: 'paper-local', label: 'Explicit paper' } },
    { type: 'paperReference', attrs: { paperId: token, label: 'Historical paper' } });
  raw.linkedPaperIds = ['paper-local', token];
  const papers = ['paper-local', id(60)].map(local => ({ id: local, title: local, authors: [], keywords: [], doi: null, year: null, publication: null, abstractText: null }));
  const result = projectDesktopLibrary({ ...value, notes: [raw], papers }, () => id(50));
  assert.deepEqual(result.skipped, []);
  const data = result.entities.find(row => row.entityType === 'note')!.data as RichNoteData;
  assert.equal(data.document.content![0].content![2].attrs!.paperId, id(60));
  assert.equal(data.document.content![0].content![3].attrs!.paperId, token);
  assert.deepEqual(data.metadata.linkedPaperIds, [id(60), token]);
});
