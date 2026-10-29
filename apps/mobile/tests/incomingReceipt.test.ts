import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from '../../../packages/sync-core/src/validation.ts';
import { prepareIncomingShareSource, type PreparedSource } from '../src/library/incomingShare.ts';
import { parseLibraryArchive, planLibraryImport, materializeLibraryImport, type LibraryArchive, type LibraryImportSummary } from '../src/library/libraryTransfer.ts';
import { appendIncomingReceipt, assertPreparedIncomingImport, findIncomingReceipt, INCOMING_RECEIPT_LIMIT, IncomingReceiptError,
  peekIncomingReceipt, prepareIncomingImport, validateIncomingReceipts, type IncomingImportReceipt } from '../src/library/incomingReceipt.ts';

const id = (n = 1) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function archive(body = '完整正文'): LibraryArchive {
  return parseLibraryArchive(JSON.stringify({ format: 'paperquay-library', version: 1,
    papers: [{ ref: 'p1', data: { title: 'Paper', doi: '10.1000/example', year: '2026', publication: null, authors: [], keywords: [], abstractText: null } }],
    notes: [{ ref: 'n1', paperRef: 'p1', title: 'Note', body, format: 'markdown' }] }));
}
async function source(value = archive(), n = 1): Promise<PreparedSource> {
  const text = JSON.stringify(value);
  return prepareIncomingShareSource({ version: 1, id: id(n), name: 'source.json', kind: 'file', mediaType: 'application/json',
    sizeBytes: new TextEncoder().encode(text).length, createdAt: 1_793_225_600_000, text });
}
async function textSource(text = 'https://doi.org/10.1000/Example') {
  return prepareIncomingShareSource({ version: 1, id: id(), name: 'source.txt', kind: 'text', mediaType: 'text/plain',
    sizeBytes: new TextEncoder().encode(text).length, createdAt: 1_793_225_600_000, text });
}
const summary = (value = archive()) => planLibraryImport(value, []).summary;
function fails(run: () => unknown, code = 'INVALID') {
  assert.throws(run, error => error instanceof IncomingReceiptError && error.code === code && error.message === code);
}
async function rejects(run: Promise<unknown>, code = 'INVALID') {
  await assert.rejects(run, error => error instanceof IncomingReceiptError && error.code === code && error.message === code);
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test('request hash binds a detached complete archive and normalized raw selection; default selection stays null', async () => {
  const raw = archive(), original = await source(raw), selected = ['note:n1', 'paper:p1', 'note:n1'];
  const prepared = await prepareIncomingImport(original, raw, selected);
  assert.deepEqual(prepared.selection, ['note:n1', 'paper:p1']); assert.equal(assertPreparedIncomingImport(prepared), prepared);
  assert.equal(prepared.requestDigest, createHash('sha256').update(canonicalJson({ archive: raw, selection: ['note:n1', 'paper:p1'] })).digest('hex'));
  const reordered = await prepareIncomingImport(original, raw, ['paper:p1', 'note:n1']); assert.equal(reordered.requestDigest, prepared.requestDigest);
  const defaults = await prepareIncomingImport(original, raw); assert.equal(defaults.selection, null); assert.notEqual(defaults.requestDigest, prepared.requestDigest);
  raw.notes[0].body = 'later mutation'; selected.length = 0;
  assert.equal(prepared.archive.notes[0].body, '完整正文'); assert.deepEqual(prepared.selection, ['note:n1', 'paper:p1']);
  assert.throws(() => { prepared.archive.notes[0].body = 'not allowed'; });
  fails(() => assertPreparedIncomingImport(structuredClone(prepared))); fails(() => assertPreparedIncomingImport({ ...prepared }));
});

test('successful replay is found before current duplicates/default choices have changed', async () => {
  const raw = archive(), original = await source(raw), request = await prepareIncomingImport(original, raw);
  const firstPlan = planLibraryImport(raw, []), materialized = materializeLibraryImport(firstPlan, (() => { let n = 100; return () => id(n++); })());
  const stored = appendIncomingReceipt([], request, materialized.summary);
  const current = materialized.edits.map(edit => ({ entityType: edit.entityType, entityId: edit.entityId, data: edit.data!, revision: 0, pending: true, deleted: false, status: 'overlay' as const }));
  const after = planLibraryImport(raw, current);
  assert.notDeepEqual(after.summary, firstPlan.summary);
  const reopened = await prepareIncomingImport(original, raw);
  assert.deepEqual(findIncomingReceipt(stored, reopened), firstPlan.summary); assert.deepEqual(peekIncomingReceipt(stored, original), firstPlan.summary);
  assert.deepEqual(appendIncomingReceipt(stored, reopened, firstPlan.summary), stored);
});

test('source clones and unrelated, partial or silently sanitized archives cannot become prepared requests', async () => {
  const raw = archive(), original = await source(raw);
  await rejects(prepareIncomingImport(structuredClone(original), raw));
  const changed = archive('changed'); await rejects(prepareIncomingImport(original, changed));
  await rejects(prepareIncomingImport(original, { ...raw, notes: [] }));
  let accessed = 0; const accessor = { ...raw }; Object.defineProperty(accessor, 'notes', { enumerable: true, get: () => { accessed++; return []; } });
  await rejects(prepareIncomingImport(original, accessor));
  for (const polluted of [Object.defineProperty({ ...raw }, 'privatePath', { value: '/PRIVATE' }), { ...raw, [Symbol('private')]: true },
    { ...raw, extra: 'PRIVATE' }, { ...raw, notes: new Array(1) }]) await rejects(prepareIncomingImport(original, polluted));
  assert.equal(accessed, 0);
  for (const selected of [['note:missing'], ['file:///PRIVATE'], Object.assign(['paper:p1'], { body: 'PRIVATE' }), new Array(1)])
    await rejects(prepareIncomingImport(original, raw, selected));
});

test('DOI sources accept only one matching paper and unsupported sources require an explicit matching manual DOI', async () => {
  const doi = await textSource(), raw = archive(); raw.notes = [];
  await prepareIncomingImport(doi, raw);
  await rejects(prepareIncomingImport(doi, archive()));
  await rejects(prepareIncomingImport(doi, { ...raw, papers: [...raw.papers, { ...raw.papers[0], ref: 'p2' }] }));
  const wrong = structuredClone(raw); wrong.papers[0].data.doi = '10.1000/other'; await rejects(prepareIncomingImport(doi, wrong));
  const unsupported = await textSource('https://outside.test/manual-source'); assert.equal(unsupported.kind, 'unsupported');
  await rejects(prepareIncomingImport(unsupported, raw));
  await prepareIncomingImport(unsupported, raw, undefined, { manualDoi: 'https://doi.org/10.1000/Example' });
  await rejects(prepareIncomingImport(unsupported, raw, undefined, { manualDoi: '10.1000/other' }));
  await rejects(prepareIncomingImport(unsupported, raw, undefined, { manualDoi: '10.1000/a10.2000/b' }));
  await rejects(prepareIncomingImport(unsupported, archive(), undefined, { manualDoi: '10.1000/example' }));
  await rejects(prepareIncomingImport(doi, raw, undefined, { manualDoi: '10.1000/example' }));
  await rejects(prepareIncomingImport(await source(raw), raw, undefined, { manualDoi: '10.1000/example' }));
});

test('same source ID with a changed source digest or changed request fails instead of silently creating another note', async () => {
  const raw = archive(), original = await source(raw), request = await prepareIncomingImport(original, raw), stored = appendIncomingReceipt([], request, summary(raw));
  const changed = archive('new source bytes'), changedSource = await source(changed);
  fails(() => peekIncomingReceipt(stored, changedSource), 'CHANGED');
  fails(() => findIncomingReceipt(stored, awaitable()), 'INVALID');
  function awaitable() { return { ...request }; }
  const changedRequest = await prepareIncomingImport(changedSource, changed); fails(() => findIncomingReceipt(stored, changedRequest), 'CHANGED');
  const choices = await prepareIncomingImport(original, raw, ['paper:p1', 'note:n1']); fails(() => findIncomingReceipt(stored, choices), 'CHANGED');
});

test('receipts JSON round trip has only hashes/ID/numeric summary, is detached, and rejects duplicate/extra/hidden fields', async () => {
  const raw = archive(), original = await source(raw), request = await prepareIncomingImport(original, raw), stored = appendIncomingReceipt([], request, summary(raw));
  const encoded = JSON.stringify(stored); assert.doesNotMatch(encoded, /完整正文|source\.json|10\.1000|owner|file:|https?:|manualDoi/);
  const loaded = validateIncomingReceipts(JSON.parse(encoded)); assert.deepEqual(loaded, stored); loaded[0].summary.notes = 0; assert.equal(stored[0].summary.notes, 1);
  for (const bad of [[stored[0], stored[0]], [{ ...stored[0], owner: 'PRIVATE' }], [{ ...stored[0], sourceDigest: 'PRIVATE' }],
    [Object.defineProperty({ ...stored[0] }, 'private', { value: 'PRIVATE' })], new Array(1)]) fails(() => validateIncomingReceipts(bad));
  fails(() => validateIncomingReceipts(undefined));
  fails(() => validateIncomingReceipts(new Proxy([], { ownKeys() { throw new Error('PRIVATE_PATH'); } })));
  let reads = 0; const proxy = new Proxy(stored[0], { get() { reads++; throw new Error('PRIVATE_BODY'); } });
  assert.deepEqual(validateIncomingReceipts([proxy]), stored); assert.equal(reads, 0);
});

test('summary numeric and semantic constraints reject pollution and cannot be rewritten on idempotent append', async () => {
  const raw = archive(), request = await prepareIncomingImport(await source(raw), raw), valid = summary(raw);
  let accessed = 0; const accessor = { ...valid }; Object.defineProperty(accessor, 'notes', { enumerable: true, get: () => { accessed++; return 1; } });
  for (const bad of [{ ...valid, notes: NaN }, { ...valid, papers: -1 }, { ...valid, notes: 0.5 }, { ...valid, selectedNotes: 2 },
    { ...valid, selectedBlockedNotes: 1 }, { ...valid, skipped: 99 }, { ...valid, noteRefs: ['PRIVATE'] }, accessor,
    { ...valid, selectedNotes: 0, selectedPapers: 0, skipped: 2 }]) fails(() => appendIncomingReceipt([], request, bad));
  assert.equal(accessed, 0);
  const unrelated = { ...valid, notes: 0, selectedNotes: 0 }; fails(() => appendIncomingReceipt([], request, unrelated));
  const stored = appendIncomingReceipt([], request, valid), changed = { ...valid, duplicatePapers: 1 };
  fails(() => appendIncomingReceipt(stored, request, changed), 'CHANGED'); assert.deepEqual(stored[0].summary, valid);
  const explicit = await prepareIncomingImport(await source(raw), raw, ['paper:p1']);
  fails(() => appendIncomingReceipt([], explicit, valid));
});

test('1024 receipt limit refuses new sources without eviction; full storage still supports exact replay', async () => {
  const raw = archive(), request = await prepareIncomingImport(await source(raw), raw), one = appendIncomingReceipt([], request, summary(raw))[0];
  const full: IncomingImportReceipt[] = Array.from({ length: INCOMING_RECEIPT_LIMIT }, (_, index) => ({ ...one, sourceId: id(index + 100), summary: { ...one.summary } }));
  const before = JSON.stringify(full); fails(() => appendIncomingReceipt(full, request, summary(raw)), 'FULL'); assert.equal(JSON.stringify(full), before);
  full[0] = one; assert.deepEqual(findIncomingReceipt(full, request), summary(raw)); assert.equal(appendIncomingReceipt(full, request, summary(raw)).length, 1024);
  fails(() => validateIncomingReceipts([...full, { ...one, sourceId: id(3000) }]));
});

test('peek recognizes the saved DOI source before another Crossref lookup and never needs a local plan', async () => {
  const original = await textSource(), raw = archive(); raw.notes = [];
  const request = await prepareIncomingImport(original, raw), stored = appendIncomingReceipt([], request, summary(raw));
  assert.deepEqual(peekIncomingReceipt(stored, original), summary(raw)); assert.equal(peekIncomingReceipt([], original), null);
  fails(() => peekIncomingReceipt(stored, { ...original }));
});

test('hash awaits fence abort/account changes and reject mutated archive/selection/manual DOI inputs', async () => {
  const raw = archive(), original = await source(raw), doi = await textSource(), unsupported = await textSource('manual source');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    for (const mutation of ['abort', 'account', 'archive', 'selection', 'manual'] as const) {
      const wait = gate<ArrayBuffer>(); Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async () => wait.promise } } });
      const input = structuredClone(raw), selected = ['paper:p1', 'note:n1'], controller = new AbortController(); let active = true;
      const options = { signal: controller.signal, current: () => active, ...(mutation === 'manual' ? { manualDoi: '10.1000/example' } : {}) };
      if (mutation === 'manual') { input.notes = []; selected.pop(); }
      const pending = prepareIncomingImport(mutation === 'manual' ? unsupported : original, input, selected, options);
      if (mutation === 'abort') controller.abort(); if (mutation === 'account') active = false;
      if (mutation === 'archive') input.notes[0].body = 'PRIVATE mutated body'; if (mutation === 'selection') selected.pop();
      if (mutation === 'manual') options.manualDoi = '10.1000/different';
      wait.resolve(new ArrayBuffer(32)); await rejects(pending, 'CHANGED');
    }
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async () => { throw new Error('PRIVATE_PATH'); } } } });
    const paperOnly = structuredClone(raw); paperOnly.notes = []; await rejects(prepareIncomingImport(doi, paperOnly), 'CRYPTO_UNAVAILABLE');
    await rejects(prepareIncomingImport(original, raw, undefined, { current: () => false }), 'CHANGED');
  } finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); }
});
