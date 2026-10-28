import assert from 'node:assert/strict';
import test from 'node:test';
import type { PaperData, VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import {
  EXTERNAL_LIBRARY_LIMITS, ExternalLibraryError, materializeExternalLibraryImport, parseExternalLibrary,
  planExternalLibraryImport, validateExternalLibraryRegistry,
  type ExternalLibraryErrorCode, type ExternalLibraryRegistry, type ExternalLibrarySnapshot,
} from '../src/library/externalLibrary.ts';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const paper = (extra: Partial<PaperData> = {}): PaperData => ({ title: 'A study', doi: '10.1234/study',
  year: '2026', publication: 'Journal', abstractText: 'Abstract', authors: ['A. Author'], keywords: ['topic'], ...extra });
const visible = (paperId: string, data: PaperData | null = paper(), extra: Partial<VisibleEntity> = {}): VisibleEntity => ({
  entityType: 'paper', entityId: paperId, data, deleted: false, revision: 1, pending: false, status: 'synced', ...extra,
});
const snapshot = (data = paper(), version = 1): ExternalLibrarySnapshot => ({ format: 'paperquay-external-library', version: 1,
  source: { kind: 'external', key: 'research-library', name: 'Research library' }, items: [{ key: 'article-1', version, data }] });
const registry = (baseline = paper(), version = 1, paperId = id(1)): ExternalLibraryRegistry => ({ version: 1, sources: [{
  ...snapshot().source, id: 'external:research-library', mappings: [{ itemKey: 'article-1', itemVersion: version, paperId, baseline }],
}] });
const zotero = (extra: Record<string, unknown> = {}) => ({ key: 'ABCD2345', version: 9,
  library: { type: 'user', id: 123, name: 'User library' }, data: { key: 'ABCD2345', version: 9,
    itemType: 'journalArticle', title: 'A study', DOI: 'https://doi.org/10.1234/STUDY', date: '2026-02-03',
    publicationTitle: 'Journal', abstractNote: '<i>Abstract</i>', creators: [
      { creatorType: 'author', firstName: 'A.', lastName: 'Author' },
      { creatorType: 'author', name: 'Institute' }, { creatorType: 'editor', firstName: 'E.', lastName: 'Editor' },
    ], tags: [{ tag: 'private' }], collections: ['PRIVATE2'], extra: 'private notes', ...extra,
  } });
const generator = (start = 100) => { let next = start; return () => id(next++); };
const restored = (edits: ReturnType<typeof materializeExternalLibraryImport>['edits']) => edits.map((edit) => visible(edit.entityId, edit.data as PaperData));
function rejects(code: ExternalLibraryErrorCode, action: () => unknown): ExternalLibraryError {
  let error: unknown;
  try { action(); } catch (problem) { error = problem; }
  assert.ok(error instanceof ExternalLibraryError);
  assert.equal(error.code, code);
  return error;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const organization = { favorite: true, readingStatus: 'reading' as const, tags: ['本地'], collections: ['课题'], queueRank: 2 };

test('versioned neutral snapshot accepts only seven metadata fields and normalizes DOI as text', () => {
  const input = snapshot(paper({ doi: ' DOI:10.1234/STUDY ' }));
  const parsed = parseExternalLibrary(JSON.stringify(input));
  assert.equal(parsed.snapshot.items[0].data.doi, '10.1234/study');
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(input.items[0].data.doi, ' DOI:10.1234/STUDY ');
  for (const extra of [{ organization }, { filePath: 'C:\\private.pdf' }, { apiKey: 'private' }, { url: 'file:///private' }]) {
    const invalid = snapshot({ ...paper(), ...extra });
    rejects('INVALID_SNAPSHOT', () => parseExternalLibrary(JSON.stringify(invalid)));
  }
  rejects('UNSUPPORTED_FORMAT', () => parseExternalLibrary(JSON.stringify({ ...input, version: 2 })));
  rejects('INVALID_SNAPSHOT', () => parseExternalLibrary(JSON.stringify({ ...input, path: 'C:\\private.json' })));
  rejects('INVALID_JSON', () => parseExternalLibrary('{"items":'));
});

test('Zotero API adapter retains scoped identifiers and text metadata, warning for every unsupported category', () => {
  const raw = zotero({ attachments: [{ path: 'C:\\secret.pdf' }], notes: [{ body: 'private note' }] });
  const parsed = parseExternalLibrary(JSON.stringify([raw]));
  assert.deepEqual(parsed.snapshot.source, { kind: 'zotero-user', key: '123', name: 'User library' });
  assert.deepEqual(parsed.snapshot.items, [{ key: 'ABCD2345', version: 9, data: {
    title: 'A study', doi: '10.1234/study', year: '2026', publication: 'Journal', abstractText: '<i>Abstract</i>',
    authors: ['A. Author', 'Institute'], keywords: [],
  } }]);
  const codes = new Set(parsed.warnings.map((entry) => entry.code));
  for (const code of ['UNSUPPORTED_FIELDS', 'TYPE_OMITTED', 'CREATOR_ROLES_OMITTED', 'AUTHOR_STRUCTURE_FLATTENED',
    'DATE_PARTS_OMITTED', 'TEXT_MARKUP_PRESERVED', 'ATTACHMENTS_OMITTED', 'CHILDREN_OMITTED', 'TAGS_OMITTED']) assert.ok(codes.has(code as never), code);
  const safe = JSON.stringify(parsed);
  for (const value of ['C:\\secret.pdf', 'private note', 'PRIVATE2', 'private notes', 'organization']) assert.ok(!safe.includes(value));
  assert.equal(parsed.warnings.every((entry) => !('message' in entry) && !('fields' in entry)), true);
});

test('Zotero children, attachments, notes, and deleted source records produce omissions, never deletes', () => {
  const records = [
    { ...zotero({ itemType: 'attachment' }), key: 'CHILD234', data: { key: 'CHILD234', version: 9, itemType: 'attachment', path: 'secret' } },
    { ...zotero(), key: 'CHILD235', data: { key: 'CHILD235', version: 9, itemType: 'note', parentItem: 'ABCD2345', note: '<script>x</script>' } },
    { ...zotero(), key: 'CHILD236', data: { key: 'CHILD236', version: 9, itemType: 'annotation' } },
    { ...zotero(), key: 'CHILD237', data: { key: 'CHILD237', version: 9, itemType: 'journalArticle', deleted: 1 } },
  ];
  const parsed = parseExternalLibrary(JSON.stringify(records));
  assert.equal(parsed.snapshot.items.length, 0);
  assert.deepEqual(parsed.warnings.map((item) => item.code), ['ATTACHMENTS_OMITTED', 'CHILDREN_OMITTED', 'UNSUPPORTED_ITEM', 'UNSUPPORTED_ITEM']);
  const plan = planExternalLibraryImport(parsed.snapshot, undefined, []);
  assert.deepEqual(materializeExternalLibraryImport(plan, generator()).edits, []);
  rejects('EMPTY_ZOTERO_SNAPSHOT', () => parseExternalLibrary('[]'));
});

test('Zotero rejects mixed user/group scopes, duplicate keys and inconsistent envelope identities', () => {
  const other = { ...zotero(), key: 'ABCD2346', data: { ...zotero().data, key: 'ABCD2346' } };
  for (const library of [{ type: 'user', id: 456 }, { type: 'group', id: 123 }]) {
    rejects('CROSS_LIBRARY_SNAPSHOT', () => parseExternalLibrary(JSON.stringify([zotero(), { ...other, library }])));
  }
  rejects('INVALID_SNAPSHOT', () => parseExternalLibrary(JSON.stringify([zotero(), zotero({ itemType: 'attachment' })])));
  for (const data of [{ key: 'ABCD2346' }, { version: 8 }, { DOI: 'https://evil.example/10.1234/study' }]) {
    rejects('INVALID_SNAPSHOT', () => parseExternalLibrary(JSON.stringify([zotero(data)])));
  }
  for (const library of [{ type: 'user', id: '123' }, { type: 'group', id: -1 }, { type: 'filesystem', id: 123 }]) {
    rejects('INVALID_SNAPSHOT', () => parseExternalLibrary(JSON.stringify([{ ...zotero(), library }])));
  }
});

test('bounds and schema prevent paths as keys, malformed DOI/text, excessive depth or counts', () => {
  for (const key of ['../paper', 'C:\\papers', 'https://example.com', '', '__proto__']) {
    const incoming = snapshot(); incoming.items[0].key = key;
    rejects('INVALID_SNAPSHOT', () => parseExternalLibrary(JSON.stringify(incoming)));
  }
  for (const doi of ['not-a-doi', '10.1234/white space', 'file:///secret', 'https://doi.org:443/10.1234/study']) {
    rejects('INVALID_SNAPSHOT', () => parseExternalLibrary(JSON.stringify(snapshot(paper({ doi })))));
  }
  for (const data of [paper({ title: ' ' }), paper({ authors: [''] }), paper({ abstractText: '\ud800' }), paper({ title: 'bad\u0000text' })]) {
    rejects('INVALID_SNAPSHOT', () => parseExternalLibrary(JSON.stringify(snapshot(data))));
  }
  const duplicate = snapshot(); duplicate.items.push(duplicate.items[0]);
  rejects('INVALID_SNAPSHOT', () => parseExternalLibrary(JSON.stringify(duplicate)));
  const many = snapshot(); many.items = Array.from({ length: 501 }, (_, index) => ({ key: `k${index}`, version: 1, data: paper() }));
  rejects('INVALID_SNAPSHOT', () => parseExternalLibrary(JSON.stringify(many)));
  rejects('INVALID_SNAPSHOT', () => parseExternalLibrary('['.repeat(17) + '0' + ']'.repeat(17)));
  rejects('SNAPSHOT_TOO_LARGE', () => parseExternalLibrary(' '.repeat(EXTERNAL_LIBRARY_LIMITS.maxBytes + 1)));
  rejects('SNAPSHOT_TOO_LARGE', () => parseExternalLibrary('"' + '汉'.repeat(Math.ceil(EXTERNAL_LIBRARY_LIMITS.maxBytes / 3)) + '"'));
});

test('registry rejects unknown payloads and accessors without invoking them, and enforces one paper per mapping', () => {
  assert.deepEqual(validateExternalLibraryRegistry(registry()), registry());
  let calls = 0;
  const malicious = { version: 1, get sources() { calls++; return []; } };
  rejects('INVALID_REGISTRY', () => validateExternalLibraryRegistry(malicious));
  assert.equal(calls, 0);
  const altered = registry(); altered.sources[0].mappings[0].baseline = paper({ organization });
  rejects('INVALID_REGISTRY', () => validateExternalLibraryRegistry(altered));
  const duplicate = registry(); duplicate.sources[0].mappings.push({ ...duplicate.sources[0].mappings[0], itemKey: 'article-2' });
  rejects('INVALID_REGISTRY', () => validateExternalLibraryRegistry(duplicate));
  const incorrectId = registry(); incorrectId.sources[0].id = 'external:path-from-file';
  rejects('INVALID_REGISTRY', () => validateExternalLibraryRegistry(incorrectId));
  rejects('INVALID_REGISTRY', () => validateExternalLibraryRegistry({ ...registry(), filePath: 'secret' }));
});

test('first import materializes fresh paper puts and local mappings, repeated imports reuse stable IDs', () => {
  const incoming = freeze(snapshot());
  const plan = planExternalLibraryImport(incoming, undefined, []);
  assert.equal(plan.summary.newPapers, 1); assert.equal(plan.summary.newMappings, 1); assert.equal(plan.summary.plannedWrites, 1);
  const result = materializeExternalLibraryImport(plan, generator());
  assert.deepEqual(result.edits, [{ entityType: 'paper', entityId: id(100), mutation: 'put', data: paper() }]);
  assert.equal(result.newRegistry.sources[0].mappings[0].paperId, id(100));
  const again = planExternalLibraryImport(incoming, result.newRegistry, restored(result.edits));
  assert.equal(again.rows[0].action, 'unchanged');
  const repeated = materializeExternalLibraryImport(again, () => { throw new Error('must not allocate'); });
  assert.deepEqual(repeated.edits, []); assert.deepEqual(repeated.newRegistry, result.newRegistry);
  const renamed = structuredClone(incoming); renamed.source.name = 'Friendly renamed library';
  const renameResult = materializeExternalLibraryImport(planExternalLibraryImport(renamed, result.newRegistry, restored(result.edits)), generator());
  assert.equal(renameResult.newRegistry.sources.length, 1); assert.equal(renameResult.newRegistry.sources[0].name, renamed.source.name);
  assert.equal(renameResult.newRegistry.sources[0].mappings[0].paperId, id(100));
});

test('three-way updates preserve locally edited fields and all organization while applying untouched source changes', () => {
  const local = freeze([visible(id(1), paper({ title: 'Local title', organization }))]);
  const incoming = snapshot(paper({ year: '2027', authors: ['New author'] }), 2);
  const plan = planExternalLibraryImport(incoming, freeze(registry()), local);
  assert.equal(plan.rows[0].action, 'update'); assert.equal(plan.summary.conflicts, 0);
  const result = materializeExternalLibraryImport(plan, generator());
  assert.deepEqual(result.edits, [{ entityType: 'paper', entityId: id(1), mutation: 'put',
    data: paper({ title: 'Local title', year: '2027', authors: ['New author'], organization }) }]);
  assert.deepEqual(result.newRegistry.sources[0].mappings[0].baseline, incoming.items[0].data);
  assert.equal('organization' in result.newRegistry.sources[0].mappings[0].baseline, false);
  assert.equal((local[0].data as PaperData).year, '2026');
});

test('divergence exposes exact base/local/source values and requires explicit preference for only conflicting fields', () => {
  const incoming = snapshot(paper({ title: 'Source title', year: '2027' }), 2);
  const local = [visible(id(1), paper({ title: 'Local title', publication: 'Local publication', organization }))];
  const blocked = planExternalLibraryImport(incoming, registry(), local);
  assert.equal(blocked.rows[0].blockedReason, 'FIELD_CONFLICT');
  assert.deepEqual(blocked.rows[0].fields.find((field) => field.field === 'title'), {
    field: 'title', base: 'A study', local: 'Local title', source: 'Source title', result: 'Local title', conflict: true,
  });
  rejects('BLOCKED_IMPORT', () => materializeExternalLibraryImport(blocked, generator()));
  for (const resolution of ['prefer-local', 'prefer-source'] as const) {
    const selected = planExternalLibraryImport(incoming, registry(), local, [{ itemKey: 'article-1', action: 'import', resolution }]);
    const result = materializeExternalLibraryImport(selected, generator());
    assert.deepEqual(result.edits[0].data, paper({ title: resolution === 'prefer-local' ? 'Local title' : 'Source title',
      year: '2027', publication: 'Local publication', organization }));
    assert.equal(result.newRegistry.sources[0].mappings[0].baseline.title, 'Source title');
    const repeated = planExternalLibraryImport(incoming, result.newRegistry, restored(result.edits));
    assert.equal(repeated.rows[0].action, 'unchanged'); assert.equal(repeated.summary.conflicts, 0);
  }
});

test('equal concurrent changes merge without conflict and prefer-local still advances source baseline', () => {
  const incoming = snapshot(paper({ title: 'Both changed' }), 2);
  const identical = planExternalLibraryImport(incoming, registry(), [visible(id(1), paper({ title: 'Both changed' }))]);
  assert.equal(identical.rows[0].action, 'unchanged'); assert.equal(identical.summary.conflicts, 0);
  const result = materializeExternalLibraryImport(identical, generator());
  assert.deepEqual(result.edits, []); assert.equal(result.newRegistry.sources[0].mappings[0].itemVersion, 2);
  const different = planExternalLibraryImport(incoming, registry(), [visible(id(1), paper({ title: 'Local choice' }))],
    [{ itemKey: 'article-1', action: 'import', resolution: 'prefer-local' }]);
  const kept = materializeExternalLibraryImport(different, generator());
  assert.deepEqual(kept.edits, []); assert.equal(kept.newRegistry.sources[0].mappings[0].baseline.title, 'Both changed');
});

test('stale versions skip, same-version metadata reuse blocks, and omission never deletes mappings or papers', () => {
  const local = [visible(id(1))];
  const stale = planExternalLibraryImport(snapshot(paper({ title: 'Old title' }), 1), registry(paper(), 2), local);
  assert.equal(stale.rows[0].skipReason, 'STALE_VERSION');
  const skipped = materializeExternalLibraryImport(stale, generator());
  assert.deepEqual(skipped.edits, []); assert.equal(skipped.newRegistry.sources[0].mappings[0].itemVersion, 2);
  const reused = planExternalLibraryImport(snapshot(paper({ title: 'Sneaky change' })), registry(), local,
    [{ itemKey: 'article-1', action: 'import', resolution: 'prefer-source' }]);
  assert.equal(reused.rows[0].blockedReason, 'SOURCE_VERSION_REUSED');
  rejects('BLOCKED_IMPORT', () => materializeExternalLibraryImport(reused, generator()));
  const missing = snapshot(); missing.items = [];
  const noDelete = materializeExternalLibraryImport(planExternalLibraryImport(missing, registry(), local), generator());
  assert.deepEqual(noDelete.edits, []); assert.deepEqual(noDelete.newRegistry, registry());
});

test('mapped tombstones, disappeared targets and every unresolved local status block import without restoration', () => {
  const incoming = snapshot(paper({ year: '2027' }), 2);
  assert.equal(planExternalLibraryImport(incoming, registry(), []).rows[0].blockedReason, 'TARGET_MISSING');
  assert.equal(planExternalLibraryImport(incoming, registry(), [visible(id(1), null, { deleted: true })]).rows[0].blockedReason, 'TARGET_DELETED');
  for (const status of ['queued', 'sending', 'uncertain', 'conflict', 'rejected', 'device-blocked', 'overlay'] as const) {
    const plan = planExternalLibraryImport(incoming, registry(), [visible(id(1), paper(), { status })]);
    assert.equal(plan.rows[0].blockedReason, 'TARGET_PENDING', status);
    rejects('BLOCKED_IMPORT', () => materializeExternalLibraryImport(plan, generator()));
  }
  assert.equal(planExternalLibraryImport(incoming, registry(), [visible(id(1), paper(), { pending: true })]).rows[0].blockedReason, 'TARGET_PENDING');
  const repeatedPending = planExternalLibraryImport(snapshot(), registry(), [visible(id(1), paper(), { pending: true })]);
  assert.equal(repeatedPending.rows[0].blockedReason, 'TARGET_PENDING');
});

test('initial duplicates remain unlinked until explicit target selection, including ambiguous DOI matches', () => {
  const local = [visible(id(1), paper({ title: 'First', organization })), visible(id(2), paper({ title: 'Second' }))];
  const initial = planExternalLibraryImport(snapshot(), undefined, local);
  assert.equal(initial.rows[0].blockedReason, 'DUPLICATE_CHOICE_REQUIRED');
  assert.deepEqual(initial.rows[0].duplicates?.existingIds, [id(1), id(2)]);
  const linkedWithoutChoice = planExternalLibraryImport(snapshot(), undefined, local, [{ itemKey: 'article-1', action: 'link', paperId: id(1) }]);
  assert.equal(linkedWithoutChoice.rows[0].blockedReason, 'FIELD_CONFLICT');
  const explicit = planExternalLibraryImport(snapshot(), undefined, local,
    [{ itemKey: 'article-1', action: 'link', paperId: id(1), resolution: 'prefer-local' }]);
  const linked = materializeExternalLibraryImport(explicit, generator());
  assert.deepEqual(linked.edits, []); assert.equal(linked.newRegistry.sources[0].mappings[0].paperId, id(1));
  assert.equal(linked.newRegistry.sources[0].mappings[0].baseline.title, 'A study');
  const later = planExternalLibraryImport(snapshot(), linked.newRegistry, local);
  assert.equal(later.rows[0].action, 'unchanged'); assert.equal(later.summary.conflicts, 0);
});

test('explicit source preference when linking preserves organization and only changes metadata', () => {
  const local = [visible(id(1), paper({ title: 'Local title', organization }))];
  const linked = materializeExternalLibraryImport(planExternalLibraryImport(snapshot(), undefined, local,
    [{ itemKey: 'article-1', action: 'link', paperId: id(1), resolution: 'prefer-source' }]), generator());
  assert.deepEqual(linked.edits, [{ entityType: 'paper', entityId: id(1), mutation: 'put', data: paper({ organization }) }]);
  assert.equal(linked.summary.linkedPapers, 1); assert.equal(linked.summary.plannedWrites, 1);
});

test('exact metadata ignores local organization, same title alone is not a duplicate, and copy is explicit', () => {
  const existing = [visible(id(1), paper({ doi: null, organization }))];
  const duplicate = snapshot(paper({ doi: null }));
  const defaultPlan = planExternalLibraryImport(duplicate, undefined, existing);
  assert.equal(defaultPlan.rows[0].duplicates?.reason, 'exact-paper');
  const copied = materializeExternalLibraryImport(planExternalLibraryImport(duplicate, undefined, existing,
    [{ itemKey: 'article-1', action: 'copy' }]), generator());
  assert.equal(copied.edits[0].entityId, id(100)); assert.equal('organization' in copied.edits[0].data!, false);
  assert.equal((existing[0].data as PaperData).organization?.favorite, true);
  const sameTitle = snapshot(paper({ doi: null, year: '2025' }));
  assert.equal(planExternalLibraryImport(sameTitle, undefined, existing).rows[0].action, 'create');
});

test('duplicate items in one snapshot require explicit copies or skips and cannot claim one target twice', () => {
  const incoming = snapshot(); incoming.items.push({ ...incoming.items[0], key: 'article-2' });
  assert.equal(planExternalLibraryImport(incoming, undefined, []).summary.blocked, 2);
  const copied = materializeExternalLibraryImport(planExternalLibraryImport(incoming, undefined, [], [
    { itemKey: 'article-1', action: 'copy' }, { itemKey: 'article-2', action: 'skip' },
  ]), generator());
  assert.equal(copied.edits.length, 1); assert.equal(copied.newRegistry.sources[0].mappings.length, 1);
  const claims = planExternalLibraryImport(incoming, undefined, [visible(id(1))], [
    { itemKey: 'article-1', action: 'link', paperId: id(1) }, { itemKey: 'article-2', action: 'link', paperId: id(1) },
  ]);
  assert.deepEqual(claims.rows.map((row) => row.blockedReason), ['TARGET_ALREADY_LINKED', 'TARGET_ALREADY_LINKED']);
  rejects('BLOCKED_IMPORT', () => materializeExternalLibraryImport(claims, generator()));
});

test('existing mappings cannot be replaced or shared and unrelated manual link targets are rejected', () => {
  for (const decision of [{ itemKey: 'article-1', action: 'copy' as const }, { itemKey: 'article-1', action: 'link' as const, paperId: id(2) }]) {
    rejects('INVALID_DECISION', () => planExternalLibraryImport(snapshot(), registry(), [visible(id(1)), visible(id(2))], [decision]));
  }
  const otherSource = snapshot(); otherSource.source.key = 'other-library';
  const shared = planExternalLibraryImport(otherSource, registry(), [visible(id(1))], [{ itemKey: 'article-1', action: 'link', paperId: id(1) }]);
  assert.equal(shared.rows[0].blockedReason, 'TARGET_ALREADY_LINKED');
  const unrelated = planExternalLibraryImport(snapshot(), undefined, [visible(id(2), paper({ doi: '10.1234/other' }))],
    [{ itemKey: 'article-1', action: 'link', paperId: id(2), resolution: 'prefer-source' }]);
  assert.equal(unrelated.rows[0].blockedReason, 'INVALID_LINK_TARGET');
  rejects('INVALID_DECISION', () => planExternalLibraryImport(snapshot(), undefined, [], [{ itemKey: 'missing', action: 'skip' }]));
});

test('source identity includes provider kind and library key, never a friendly name or filename', () => {
  const user = parseExternalLibrary(JSON.stringify([zotero()])).snapshot;
  const first = materializeExternalLibraryImport(planExternalLibraryImport(user, undefined, []), generator());
  const group = structuredClone(user); group.source.kind = 'zotero-group';
  const plan = planExternalLibraryImport(group, first.newRegistry, restored(first.edits), [{ itemKey: 'ABCD2345', action: 'copy' }]);
  const second = materializeExternalLibraryImport(plan, generator(101));
  assert.deepEqual(second.newRegistry.sources.map((source) => source.id), ['zotero-group:123', 'zotero-user:123']);
  assert.equal(new Set(second.newRegistry.sources.map((source) => source.mappings[0].paperId)).size, 2);
});

test('plan signatures detect changed source, decisions, registry, local metadata, organization and pending state', () => {
  const incoming = snapshot(paper({ year: '2027' }), 2); const state = registry(); const local = [visible(id(1))];
  const initial = planExternalLibraryImport(incoming, state, local).signature;
  for (const changed of [visible(id(1), paper({ title: 'Changed' })), visible(id(1), paper({ organization })),
    visible(id(1), paper(), { revision: 2 }), visible(id(1), paper(), { pending: true })]) {
    assert.notEqual(planExternalLibraryImport(incoming, state, [changed]).signature, initial);
  }
  const renamed = structuredClone(incoming); renamed.source.name = 'New name';
  assert.notEqual(planExternalLibraryImport(renamed, state, local).signature, initial);
  const changedRegistry = registry(paper({ title: 'Changed baseline' }));
  assert.notEqual(planExternalLibraryImport(incoming, changedRegistry, local).signature, initial);
  assert.notEqual(planExternalLibraryImport(incoming, state, local, [{ itemKey: 'article-1', action: 'skip' }]).signature, initial);
  const more = [...local, visible(id(2), paper({ doi: '10.1234/other' }))];
  assert.equal(planExternalLibraryImport(incoming, state, more).signature, planExternalLibraryImport(incoming, state, [...more].reverse()).signature);
});

test('materializer rejects fabricated plans, freezes plans, and never mutates input or outputs from previous runs', () => {
  const incoming = freeze(snapshot()); const local = freeze([visible(id(1), paper({ doi: '10.1234/other' }))]);
  const plan = planExternalLibraryImport(incoming, undefined, local);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.snapshot.items[0].data.authors));
  rejects('INVALID_PLAN', () => materializeExternalLibraryImport(structuredClone(plan), generator()));
  const first = materializeExternalLibraryImport(plan, generator(100));
  first.newRegistry.sources[0].mappings[0].baseline.title = 'Caller edit';
  (first.edits[0].data as PaperData).authors.push('Caller author');
  const second = materializeExternalLibraryImport(plan, generator(101));
  assert.equal(second.newRegistry.sources[0].mappings[0].baseline.title, 'A study');
  assert.deepEqual((second.edits[0].data as PaperData).authors, ['A. Author']);
  assert.equal(incoming.items[0].data.title, 'A study');
});

test('ID allocation avoids all existing entities and retained mappings, and fails without partial mutations', () => {
  const saved = registry(); saved.sources[0].key = 'old-library'; saved.sources[0].id = 'external:old-library';
  const existing = [visible(id(2), null, { entityType: 'note' })];
  const plan = planExternalLibraryImport(snapshot(), freeze(saved), freeze(existing));
  const ids = [id(1), id(2), id(3)];
  assert.equal(materializeExternalLibraryImport(plan, () => ids.shift()!).edits[0].entityId, id(3));
  rejects('ID_ALLOCATION_FAILED', () => materializeExternalLibraryImport(plan, () => id(1)));
  rejects('INVALID_GENERATED_ID', () => materializeExternalLibraryImport(plan, () => 'C:\\arbitrary'));
  rejects('ID_ALLOCATION_FAILED', () => materializeExternalLibraryImport(plan, () => { throw new Error('private failure text'); }));
  assert.equal(saved.sources.length, 1); assert.equal(saved.sources[0].mappings[0].paperId, id(1));
  const incoming = snapshot(); incoming.items.push({ key: 'article-2', version: 1, data: paper({ doi: '10.1234/second' }) });
  const two = planExternalLibraryImport(incoming, undefined, []);
  rejects('ID_ALLOCATION_FAILED', () => materializeExternalLibraryImport(two, () => id(5)));
  assert.equal(two.registry.sources.length, 0);
});

test('registry capacities reject further source mappings without affecting stored data', () => {
  const full: ExternalLibraryRegistry = { version: 1, sources: Array.from({ length: EXTERNAL_LIBRARY_LIMITS.maxSources }, (_, index) => ({
    kind: 'external', key: `source-${index}`, id: `external:source-${index}`, name: `Source ${index}`, mappings: [],
  })) };
  rejects('REGISTRY_TOO_LARGE', () => planExternalLibraryImport(snapshot(), full, []));
  const skipped = planExternalLibraryImport(snapshot(), full, [], [{ itemKey: 'article-1', action: 'skip' }]);
  assert.deepEqual(materializeExternalLibraryImport(skipped, generator()).edits, []);
  assert.equal(full.sources.length, EXTERNAL_LIBRARY_LIMITS.maxSources);
  const tooMany = registry(); tooMany.sources[0].mappings = Array.from({ length: EXTERNAL_LIBRARY_LIMITS.maxMappings + 1 }, (_, index) => ({
    itemKey: `key-${index}`, itemVersion: 1, paperId: id(index + 1), baseline: paper(),
  }));
  rejects('INVALID_REGISTRY', () => validateExternalLibraryRegistry(tooMany));
});

test('registry bounds apply across all sources and count baseline UTF-8 bytes', () => {
  const first = registry();
  first.sources[0].mappings = Array.from({ length: 5001 }, (_, index) => ({
    itemKey: `key-${index}`, itemVersion: 1, paperId: id(index + 1), baseline: paper(),
  }));
  const second = { ...first.sources[0], key: 'another-library', id: 'external:another-library',
    mappings: first.sources[0].mappings.map((mapping, index) => ({ ...mapping, paperId: id(index + 6000) })) };
  first.sources.push(second);
  rejects('REGISTRY_TOO_LARGE', () => validateExternalLibraryRegistry(first));
  const wide = registry();
  const baseline = paper({ abstractText: '汉'.repeat(65536) });
  wide.sources[0].mappings = Array.from({ length: 172 }, (_, index) => ({
    itemKey: `key-${index}`, itemVersion: 1, paperId: id(index + 1), baseline,
  }));
  rejects('REGISTRY_TOO_LARGE', () => validateExternalLibraryRegistry(wide));
});

test('accessor inputs never run through planner metadata, entity projections or decisions', () => {
  let calls = 0;
  const malicious = snapshot(); Object.defineProperty(malicious.items[0].data, 'title', { enumerable: true, get() { calls++; return 'secret'; } });
  rejects('INVALID_SNAPSHOT', () => planExternalLibraryImport(malicious, undefined, []));
  const entity = visible(id(1)); Object.defineProperty(entity, 'data', { enumerable: true, get() { calls++; return paper(); } });
  rejects('INVALID_EXISTING_DATA', () => planExternalLibraryImport(snapshot(), undefined, [entity]));
  const choices = [{ itemKey: 'article-1', action: 'skip' as const }];
  Object.defineProperty(choices[0], 'itemKey', { enumerable: true, get() { calls++; return 'article-1'; } });
  rejects('INVALID_DECISION', () => planExternalLibraryImport(snapshot(), undefined, [], choices));
  assert.equal(calls, 0);
});
