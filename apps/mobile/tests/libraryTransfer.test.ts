import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntityData, LocalEdit, NoteData, PaperData, VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import {
  exportLibraryArchive, LIBRARY_TRANSFER_LIMITS, LibraryTransferError, materializeLibraryImport,
  parseLibraryArchive, planLibraryImport, type LibraryArchive, type LibraryTransferErrorCode,
} from '../src/library/libraryTransfer.ts';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const paper = (overrides: Partial<PaperData> = {}): PaperData => ({ title: 'A study', doi: '10.1234/study',
  year: '2026', publication: 'Journal', abstractText: 'Abstract', authors: ['A. Author'], keywords: ['topic'], ...overrides });
const note = (paperId: string | null = null, overrides: Partial<NoteData> = {}): NoteData => ({
  paperId, title: 'Reading note', body: '# 原文笔记\n\n保留 **Markdown** 与换行。\n', format: 'markdown', ...overrides,
});
const visible = (entityType: VisibleEntity['entityType'], entityId: string, data: EntityData | null,
  extra: Partial<VisibleEntity> = {}): VisibleEntity => ({ entityType, entityId, data, revision: 1,
  deleted: false, pending: false, status: 'synced', ...extra });
const archive = (overrides: Partial<LibraryArchive> = {}): LibraryArchive => ({ format: 'paperquay-library', version: 1,
  papers: [{ ref: 'p1', data: paper() }], notes: [{ ref: 'n1', paperRef: 'p1', title: 'Reading note',
    body: note().body, format: 'markdown' }], ...overrides });
const generator = (start = 100) => { let next = start; return () => id(next++); };
const allKeys = (value: LibraryArchive) => [...value.papers.map((entry) => `paper:${entry.ref}`), ...value.notes.map((entry) => `note:${entry.ref}`)];
const restored = (edits: LocalEdit[]) => edits.map((edit) => visible(edit.entityType, edit.entityId, edit.data));
function rejects(code: LibraryTransferErrorCode, action: () => unknown): LibraryTransferError {
  let error: unknown;
  try { action(); } catch (problem) { error = problem; }
  assert.ok(error instanceof LibraryTransferError);
  assert.equal(error.code, code);
  return error;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('portable JSON round-trips library data and Markdown with new account IDs and intact links', () => {
  const organization = { favorite: true, readingStatus: 'reading' as const, tags: ['方法'], collections: ['课题'], queueRank: 2 };
  const source = freeze([
    visible('paper', id(1), paper({ organization })),
    visible('paper', id(2), paper({ title: 'Other', doi: null })),
    visible('note', id(3), note(id(1))),
    visible('note', id(4), note(id(2), { title: 'Other note' })),
    visible('note', id(5), note(null, { title: 'Independent' })),
  ]);
  const exported = exportLibraryArchive(source);
  assert.deepEqual(exported.summary, { papers: 2, notes: 3, unresolvedNoteLinks: 0,
    omittedDeleted: 0, omittedUnsupported: 0, conflicted: 0, scope: 'visible-saved-library-and-markdown' });
  for (const entity of source) assert.ok(!exported.json.includes(entity.entityId));
  const parsed = parseLibraryArchive(exported.json);
  const plan = planLibraryImport(parsed, []);
  const result = materializeLibraryImport(plan, generator());
  assert.deepEqual(result.edits.map((edit) => edit.entityType), ['paper', 'paper', 'note', 'note', 'note']);
  assert.ok(result.edits.every((edit) => edit.mutation === 'put' && !source.some((old) => old.entityId === edit.entityId)));
  assert.equal((result.edits[2].data as NoteData).paperId, result.edits[0].entityId);
  assert.equal((result.edits[3].data as NoteData).paperId, result.edits[1].entityId);
  assert.equal((result.edits[4].data as NoteData).paperId, null);
  assert.equal((result.edits[2].data as NoteData).body, note().body);
  assert.equal(result.requiresPaperOrganization, true);
  assert.deepEqual(exportLibraryArchive(restored(result.edits)).archive, parsed);
  assert.equal(exportLibraryArchive([...source].reverse()).json, exported.json, 'source enumeration order does not change the exchange file');
});

test('export reports the visible conflicted version and omits tombstones, attachments and synchronization identity', () => {
  const secret = 'not-an-exported-credential';
  const source = [visible('paper', id(1), paper(), { status: 'conflict', pending: true }),
    visible('note', id(2), note(id(1))), visible('paper', id(3), null, { deleted: true }),
    visible('attachmentVersion', id(4), { apiKey: secret, filePath: 'C:\\private.pdf', pdfBytes: [1, 2] } as unknown as EntityData),
    visible('annotation', id(5), null), visible('readingPosition', id(6), null)];
  const result = exportLibraryArchive(source);
  assert.equal(result.summary.conflicted, 1);
  assert.equal(result.summary.omittedDeleted, 1);
  assert.equal(result.summary.omittedUnsupported, 3);
  assert.ok(!result.json.includes(secret));
  assert.ok(!result.json.includes('filePath'));
  assert.ok(!result.json.includes('revision'));
  assert.ok(!result.json.includes('attachmentVersion'));
  assert.equal(result.archive.papers[0].data.title, 'A study');
});

test('normalized DOI duplicates are skipped and their new notes link only to a unique active paper', () => {
  const value = archive({ papers: [{ ref: 'p1', data: paper({ title: 'Different metadata', doi: ' DOI:10.1234/STUDY ' }) },
    { ref: 'p2', data: paper({ doi: 'https://doi.org/10.1234%2Fstudy' }) }], notes: [
    { ref: 'n1', paperRef: 'p1', title: 'New', body: 'A note', format: 'markdown' },
    { ref: 'n2', paperRef: 'p2', title: 'New', body: 'A note', format: 'markdown' },
    { ref: 'n3', paperRef: null, title: 'New', body: 'A note', format: 'markdown' },
  ] });
  const plan = planLibraryImport(value, [visible('paper', id(1), paper())]);
  assert.deepEqual(plan.rows.map((row) => row.selected), [false, false, true, false, true]);
  assert.equal(plan.rows[0].duplicate?.reason, 'doi');
  assert.equal(plan.rows[2].association?.kind, 'existing-paper');
  assert.deepEqual(plan.rows[3].duplicate?.archiveKeys, ['note:n1']);
  const result = materializeLibraryImport(plan, generator());
  assert.equal(result.edits.length, 2);
  assert.equal((result.edits[0].data as NoteData).paperId, id(1));
  assert.equal((result.edits[1].data as NoteData).paperId, null);
});

test('same title is not an identity and a paper without a DOI requires exact bibliographic metadata equality', () => {
  const value = archive({ papers: [{ ref: 'p1', data: paper({ doi: null }) },
    { ref: 'p2', data: paper({ doi: null, year: '2025' }) },
    { ref: 'p3', data: paper({ doi: '10.5678/other' }) }], notes: [] });
  const plan = planLibraryImport(value, [visible('paper', id(1), paper({ doi: null }))]);
  assert.deepEqual(plan.rows.map((row) => row.selected), [false, true, true]);
  assert.equal(plan.rows[0].duplicate?.reason, 'exact-paper');
});

test('identical bibliography without a DOI ignores personal classification but retains it in explicit copies', () => {
  const existingOrganization = { favorite: true, readingStatus: 'read' as const, tags: ['旧标签'], collections: ['课题'], queueRank: 1 };
  const incomingOrganization = { favorite: false, readingStatus: 'unread' as const, tags: ['新标签'], collections: [], queueRank: null };
  const existing = [visible('paper', id(1), paper({ doi: null, organization: existingOrganization }))];
  const exportedMetadata = archive({ papers: [{ ref: 'p1', data: paper({ doi: null }) }], notes: [] });
  const plan = planLibraryImport(exportedMetadata, existing);
  assert.equal(plan.summary.selectedPapers, 0);
  assert.equal(plan.rows[0].duplicate?.reason, 'exact-paper');
  const incoming = archive({ papers: [{ ref: 'p1', data: paper({ doi: null, organization: incomingOrganization }) }] });
  const defaultPlan = planLibraryImport(incoming, existing);
  assert.equal(defaultPlan.summary.selectedPapers, 0);
  assert.equal(defaultPlan.rows[1].association?.kind, 'existing-paper');
  const copied = materializeLibraryImport(planLibraryImport(incoming, existing, ['paper:p1', 'note:n1']), generator());
  assert.deepEqual((copied.edits[0].data as PaperData).organization, incomingOrganization);
  assert.equal((copied.edits[1].data as NoteData).paperId, copied.edits[0].entityId);
  assert.deepEqual((existing[0].data as PaperData).organization, existingOrganization);
  const changed = structuredClone(existing);
  (changed[0].data as PaperData).organization!.tags.push('后续编辑');
  assert.notEqual(planLibraryImport(incoming, changed).signature, defaultPlan.signature);
});

test('same bibliography with different classification has explicit copy and association choices', () => {
  const organization = { favorite: false, readingStatus: 'unread' as const, tags: ['第一组'], collections: [], queueRank: null };
  const first = paper({ doi: null, organization });
  const second = paper({ doi: null, organization: { ...organization, tags: ['第二组'] } });
  const input = archive({ papers: [{ ref: 'p1', data: first }, { ref: 'p2', data: second }], notes: [
    { ref: 'n1', paperRef: 'p1', title: 'Same note', body: 'Same body', format: 'markdown' },
    { ref: 'n2', paperRef: 'p2', title: 'Same note', body: 'Same body', format: 'markdown' },
  ] });
  const defaultPlan = planLibraryImport(input, []);
  assert.deepEqual(defaultPlan.rows.map((row) => row.selected), [true, false, true, false]);
  assert.deepEqual(defaultPlan.rows[3].association, { kind: 'new-paper', paperKey: 'paper:p1', paperTitle: first.title });
  const copies = materializeLibraryImport(planLibraryImport(input, [], allKeys(input)), generator());
  assert.equal(copies.edits.length, 4);
  assert.deepEqual((copies.edits[0].data as PaperData).organization, first.organization);
  assert.deepEqual((copies.edits[1].data as PaperData).organization, second.organization);
  assert.equal((copies.edits[2].data as NoteData).paperId, copies.edits[0].entityId);
  assert.equal((copies.edits[3].data as NoteData).paperId, copies.edits[1].entityId);

  const existing = [visible('paper', id(1), first), visible('paper', id(2), second)];
  const oneSource = archive({ papers: [{ ref: 'p1', data: paper({ doi: null }) }] });
  const ambiguous = planLibraryImport(oneSource, existing);
  assert.equal(ambiguous.rows[1].blockedReason, 'AMBIGUOUS_PAPER');
  assert.equal(ambiguous.rows[1].selected, false);
  const selected = materializeLibraryImport(planLibraryImport(oneSource, existing, allKeys(oneSource)), generator());
  assert.equal(selected.edits.length, 2);
  assert.equal((selected.edits[1].data as NoteData).paperId, selected.edits[0].entityId);
});

test('duplicate source papers map notes to the single selected source copy', () => {
  const value = archive({ papers: [{ ref: 'p1', data: paper() }, { ref: 'p2', data: paper() }],
    notes: [{ ref: 'n1', paperRef: 'p2', title: 'Linked to second', body: 'Text', format: 'markdown' }] });
  const plan = planLibraryImport(value, []);
  assert.deepEqual(plan.rows.map((row) => row.selected), [true, false, true]);
  assert.deepEqual(plan.rows[2].association, { kind: 'new-paper', paperKey: 'paper:p1', paperTitle: 'A study' });
  const result = materializeLibraryImport(plan, generator());
  assert.equal((result.edits[1].data as NoteData).paperId, result.edits[0].entityId);
});

test('reimport defaults skip exact notes; explicitly selected duplicates create independent copies', () => {
  const value = archive();
  const existing = [visible('paper', id(1), paper()), visible('note', id(2), note(id(1)))];
  const defaultPlan = planLibraryImport(value, existing);
  assert.equal(defaultPlan.summary.selectedPapers + defaultPlan.summary.selectedNotes, 0);
  assert.equal(defaultPlan.summary.duplicateNotes, 1);
  rejects('EMPTY_SELECTION', () => materializeLibraryImport(defaultPlan, generator()));
  const selected = planLibraryImport(value, existing, allKeys(value));
  const result = materializeLibraryImport(selected, generator());
  assert.equal(result.edits.length, 2);
  assert.equal((result.edits[1].data as NoteData).paperId, result.edits[0].entityId);
  assert.notEqual(result.edits[0].entityId, id(1));
  assert.notEqual(result.edits[1].entityId, id(2));
});

test('ambiguous current DOI matches block association until the source paper is explicitly copied', () => {
  const existing = [visible('paper', id(1), paper()), visible('paper', id(2), paper({ title: 'Another copy' }))];
  const plan = planLibraryImport(archive(), existing);
  assert.equal(plan.rows[1].blockedReason, 'AMBIGUOUS_PAPER');
  assert.equal(plan.rows[1].defaultSelected, false);
  rejects('BLOCKED_ASSOCIATION', () => materializeLibraryImport(planLibraryImport(archive(), existing, ['note:n1']), generator()));
  const copied = materializeLibraryImport(planLibraryImport(archive(), existing, ['paper:p1', 'note:n1']), generator());
  assert.equal((copied.edits[1].data as NoteData).paperId, copied.edits[0].entityId);
});

test('missing and deselected source papers never silently detach notes', () => {
  const missing = archive({ papers: [] });
  const plan = planLibraryImport(missing, []);
  assert.equal(plan.rows[0].blockedReason, 'MISSING_PAPER');
  assert.equal(plan.summary.blockedNotes, 1);
  let allocations = 0;
  rejects('BLOCKED_ASSOCIATION', () => materializeLibraryImport(planLibraryImport(missing, [], ['note:n1']), () => { allocations++; return id(100); }));
  assert.equal(allocations, 0);
  const deselected = planLibraryImport(archive(), [], ['note:n1']);
  assert.equal(deselected.rows[1].blockedReason, 'PAPER_NOT_SELECTED');
  assert.equal(deselected.summary.selectedBlockedNotes, 1);
  rejects('BLOCKED_ASSOCIATION', () => materializeLibraryImport(deselected, generator()));
});

test('export preserves a dangling link as an anonymous ref that round-trips into an explicitly blocked row', () => {
  const value = exportLibraryArchive([visible('paper', id(40), null, { deleted: true }),
    visible('note', id(50), note(id(40))), visible('note', id(51), note(id(99), { title: 'Missing entirely' }))]);
  assert.equal(value.summary.unresolvedNoteLinks, 2);
  assert.equal(value.archive.papers.length, 0);
  assert.ok(value.archive.notes.every((entry) => entry.paperRef !== null));
  assert.ok(!value.json.includes(id(40)) && !value.json.includes(id(99)));
  const plan = planLibraryImport(parseLibraryArchive(value.json), []);
  assert.ok(plan.rows.every((row) => row.blockedReason === 'MISSING_PAPER' && !row.selected));
});

test('note identity includes its paper association, title, complete body and whitespace', () => {
  const existing = [visible('paper', id(1), paper()), visible('paper', id(2), paper({ doi: '10.5678/other' })),
    visible('note', id(3), note(id(2)))];
  const value = archive({ notes: [archive().notes[0], { ...archive().notes[0], ref: 'n2', body: note().body + '\n' },
    { ...archive().notes[0], ref: 'n3', title: 'Different title' }] });
  const plan = planLibraryImport(value, existing);
  assert.equal(plan.summary.selectedNotes, 3);
  assert.equal(plan.summary.duplicateNotes, 0);
});

test('fresh ID allocation protects tombstones, active entities of every type, and earlier creates in the same batch', () => {
  const existing = freeze([visible('paper', id(1), null, { deleted: true }), visible('annotation', id(2), null)]);
  const original = JSON.stringify(existing);
  const candidates = [id(1), id(2), id(100), id(100), id(101)];
  const result = materializeLibraryImport(planLibraryImport(archive(), existing), () => candidates.shift()!);
  assert.deepEqual(result.edits.map((edit) => edit.entityId), [id(100), id(101)]);
  assert.ok(result.edits.every((edit) => edit.mutation === 'put'));
  assert.equal((result.edits[1].data as NoteData).paperId, id(100));
  assert.equal(JSON.stringify(existing), original);
});

test('allocation failure is bounded, does not touch input, and yields no partially prepared result', () => {
  const value = freeze(archive());
  const existing = freeze([visible('paper', id(1), null, { deleted: true })]);
  const before = JSON.stringify({ value, existing });
  const plan = planLibraryImport(value, existing);
  let allocations = 0;
  rejects('ID_ALLOCATION_FAILED', () => materializeLibraryImport(plan, () => { allocations++; return id(1); }));
  assert.equal(allocations, LIBRARY_TRANSFER_LIMITS.maxIdAttempts);
  assert.equal(JSON.stringify({ value, existing }), before);
  rejects('INVALID_GENERATED_ID', () => materializeLibraryImport(plan, () => 'C:\\private\\path'));
  rejects('ID_ALLOCATION_FAILED', () => materializeLibraryImport(plan, () => { throw new Error('private allocator detail'); }));
});

test('preview signatures are deterministic and change when selection, duplicates or a referenced current revision changes', () => {
  const source = archive();
  const existing = [visible('paper', id(1), paper()), visible('note', id(2), note(null))];
  const first = planLibraryImport(source, existing);
  assert.equal(first.signature, planLibraryImport(source, [...existing].reverse()).signature);
  assert.equal(planLibraryImport(source, existing, ['paper:p1', 'note:n1']).signature,
    planLibraryImport(source, existing, ['note:n1', 'paper:p1']).signature);
  assert.notEqual(first.signature, planLibraryImport(source, existing, []).signature);
  assert.notEqual(first.signature, planLibraryImport(source, [{ ...existing[0], revision: 2 }, existing[1]]).signature);
  assert.notEqual(first.signature, planLibraryImport(source, [...existing, visible('note', id(3), note(id(1)))]).signature);
  assert.notEqual(first.signature, planLibraryImport(source, [{ ...existing[0], deleted: true, data: null }, existing[1]]).signature);
});

test('explicit duplicate copies still re-confirm changed matching records, including same-revision local edits', () => {
  const value = archive({ notes: [] });
  const saved = visible('paper', id(1), paper());
  const original = planLibraryImport(value, [saved], ['paper:p1']);
  assert.notEqual(original.signature, planLibraryImport(value, [{ ...saved, revision: 2 }], ['paper:p1']).signature);
  assert.notEqual(original.signature, planLibraryImport(value, [{ ...saved, pending: true, status: 'overlay' }], ['paper:p1']).signature);
  const changed = { ...saved, data: paper({ title: 'Updated locally, same DOI and server revision' }) };
  assert.notEqual(original.signature, planLibraryImport(value, [changed], ['paper:p1']).signature);
});

test('a plan owns a frozen snapshot and forged or mutated plans cannot generate writes', () => {
  const source = archive();
  const plan = planLibraryImport(source, []);
  source.notes[0].body = 'Changed after review';
  assert.notEqual(plan.archive.notes[0].body, source.notes[0].body);
  assert.throws(() => { plan.archive.notes[0].body = 'Tamper'; }, TypeError);
  assert.throws(() => { plan.rows[0].selected = false; }, TypeError);
  rejects('INVALID_PLAN', () => materializeLibraryImport({ ...plan }, generator()));
  const result = materializeLibraryImport(plan, generator());
  assert.equal((result.edits[1].data as NoteData).body, note().body);
});

test('all unknown fields and unsupported schemas are rejected without exposing their values in errors', () => {
  const secret = 'hidden-input-secret';
  const cases: unknown[] = [
    { ...archive(), apiKey: secret },
    { ...archive(), accountId: id(1) },
    { ...archive(), papers: [{ ...archive().papers[0], entityId: id(1) }] },
    { ...archive(), papers: [{ ref: 'p1', data: { ...paper(), filePath: secret } }] },
    { ...archive(), notes: [{ ...archive().notes[0], attachmentVersionId: id(3) }] },
    { ...archive(), notes: [{ ...archive().notes[0], coordinates: [0, 1] }] },
    { ...archive(), notes: [{ ...archive().notes[0], format: 'html' }] },
    { ...archive(), papers: [{ ref: 'p1', data: { ...paper(), organization: { favorite: false, readingStatus: 'unread', tags: [], collections: [], queueRank: null, apiKey: secret } } }] },
    JSON.parse(`{"format":"paperquay-library","version":1,"papers":[],"notes":[],"__proto__":{"polluted":"${secret}"}}`),
  ];
  for (const value of cases) {
    const error = rejects('INVALID_ARCHIVE', () => parseLibraryArchive(JSON.stringify(value)));
    assert.ok(!JSON.stringify(error).includes(secret));
  }
  rejects('UNSUPPORTED_FORMAT', () => parseLibraryArchive(JSON.stringify({ ...archive(), format: 'bibtex' })));
  rejects('UNSUPPORTED_FORMAT', () => parseLibraryArchive(JSON.stringify({ ...archive(), version: 2 })));
  rejects('INVALID_JSON', () => parseLibraryArchive('@article{paper,title={A}}'));
  rejects('INVALID_JSON', () => parseLibraryArchive('TY  - JOUR\nER  -'));
});

test('malformed fields, invalid local refs, duplicates and oversized arrays fail before planning', () => {
  for (const value of [archive({ papers: [{ ref: id(1), data: paper() }] }),
    archive({ papers: [{ ref: 'p1', data: paper() }, { ref: 'p1', data: paper({ title: 'Other' }) }] }),
    archive({ notes: [{ ...archive().notes[0], body: null } as unknown as LibraryArchive['notes'][number]] }),
    archive({ papers: [{ ref: 'p1', data: paper({ authors: [''] }) }] }),
    archive({ notes: [{ ...archive().notes[0], body: 'x'.repeat(SYNC_NOTE_LIMIT + 1) }] }),
    archive({ papers: Array.from({ length: 501 }, (_, index) => ({ ref: `p${index + 1}`, data: paper() })) }),
    archive({ notes: Array.from({ length: 501 }, (_, index) => ({ ...archive().notes[0], ref: `n${index + 1}` })) }),
  ]) rejects('INVALID_ARCHIVE', () => planLibraryImport(value, []));
});
const SYNC_NOTE_LIMIT = 262144;

test('both UTF-8 byte volume and bounded nesting are checked before importing', () => {
  rejects('ARCHIVE_TOO_LARGE', () => parseLibraryArchive(' '.repeat(LIBRARY_TRANSFER_LIMITS.maxBytes + 1)));
  const multibyte = archive({ papers: [], notes: Array.from({ length: 20 }, (_, index) => ({
    ref: `n${index + 1}`, paperRef: null, title: '', body: '文'.repeat(80000), format: 'markdown' as const,
  })) });
  const text = JSON.stringify(multibyte);
  assert.ok(text.length < LIBRARY_TRANSFER_LIMITS.maxBytes);
  rejects('ARCHIVE_TOO_LARGE', () => parseLibraryArchive(text));
  rejects('ARCHIVE_TOO_LARGE', () => planLibraryImport(multibyte, []));
  rejects('INVALID_ARCHIVE', () => parseLibraryArchive('['.repeat(17) + '0' + ']'.repeat(17)));
  const harmless = archive({ notes: [{ ...archive().notes[0], body: '[[[[ {{{{ " \\ '.repeat(100) }] });
  assert.equal(parseLibraryArchive(JSON.stringify(harmless)).notes[0].body, harmless.notes[0].body);
});

test('1000 bounded records are accepted and over-limit export refuses to emit an unimportable file', () => {
  const value = archive({ papers: Array.from({ length: 500 }, (_, index) => ({ ref: `p${index + 1}`, data: paper({ doi: null, title: `Paper ${index}` }) })),
    notes: Array.from({ length: 500 }, (_, index) => ({ ref: `n${index + 1}`, paperRef: `p${index + 1}`, title: 'Note', body: 'Body', format: 'markdown' as const })) });
  const plan = planLibraryImport(value, []);
  assert.equal(plan.summary.selectedPapers + plan.summary.selectedNotes, 1000);
  assert.equal(materializeLibraryImport(plan, generator()).edits.length, 1000);
  rejects('INVALID_ARCHIVE', () => exportLibraryArchive(Array.from({ length: 501 }, (_, index) => visible('paper', id(index + 1), paper()))));
});

test('runtime objects with accessors or sparse arrays fail without invoking getters or mutating sources', () => {
  let reads = 0;
  const value = archive();
  Object.defineProperty(value.notes[0], 'body', { enumerable: true, get() { reads++; return 'secret'; } });
  rejects('INVALID_ARCHIVE', () => planLibraryImport(value, []));
  assert.equal(reads, 0);
  const sparse = archive(); sparse.papers.length = 2;
  rejects('INVALID_ARCHIVE', () => planLibraryImport(sparse, []));
  const current = visible('paper', id(1), paper());
  Object.defineProperty(current, 'data', { enumerable: true, get() { reads++; return paper(); } });
  rejects('INVALID_EXISTING_DATA', () => planLibraryImport(archive(), [current]));
  assert.equal(reads, 0);
  const valid = freeze(archive()); const before = JSON.stringify(valid);
  rejects('INVALID_SELECTION', () => planLibraryImport(valid, [], ['paper:p1', 'paper:p1']));
  rejects('INVALID_SELECTION', () => planLibraryImport(valid, [], ['paper:p99']));
  assert.equal(JSON.stringify(valid), before);
});

test('organization capability requirements concern selected creates and never silently strip classification', () => {
  const organization = { favorite: false, readingStatus: 'read' as const, tags: ['tag'], collections: [], queueRank: null };
  const value = archive({ papers: [{ ref: 'p1', data: paper({ organization }) }] });
  const plan = planLibraryImport(value, []);
  assert.equal(plan.requiresPaperOrganization, true);
  assert.deepEqual((materializeLibraryImport(plan, generator()).edits[0].data as PaperData).organization, organization);
  assert.equal(planLibraryImport(value, [visible('paper', id(1), paper())]).requiresPaperOrganization, false);
});

test('user-authored Markdown is transported verbatim rather than guessed at or silently redacted', () => {
  const body = 'Local example `C:\\notes\\draft.md`\nLiteral API-key placeholder: example-key\n<script>literal text</script>';
  const value = exportLibraryArchive([visible('note', id(1), note(null, { body }))]);
  const parsed = parseLibraryArchive(value.json);
  const result = materializeLibraryImport(planLibraryImport(parsed, []), generator());
  assert.equal((result.edits[0].data as NoteData).body, body);
});
