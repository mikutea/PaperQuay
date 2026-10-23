import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson, createDesktopIdentityMap, ensureDesktopIdentity, projectDesktopLibrary,
  validateDesktopIdentityMap, validateEntityData,
} from '../packages/sync-core/src/index.ts';
import type { DesktopHistoryVersionBinding, DesktopProjectionInput, DesktopProjectionResult, VerifiedDesktopAttachment } from '../packages/sync-core/src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const account = id(1), library = id(2), device = id(3), hash = 'a'.repeat(64);
const allocate = (start = 100) => { let next = start; return () => id(next++); };
const privatePath = 'C:\\Users\\private-profile\\library\\paper.pdf';
const sourceKey = `local:${privatePath}`;
const timestamp = Date.parse('2026-10-24T06:00:00.000Z');
const attachment = () => ({ id: 'attachment-local', paperId: 'paper-local', kind: 'pdf', fileName: 'paper.pdf', filePath: privatePath, contentHash: hash, fileSize: 1024 });
const paper = () => ({ id: 'paper-local', title: ' A paper ', doi: 'https://doi.org/10.1000/EXAMPLE', year: '2026', publication: null, abstractText: 'Abstract', authors: [{ name: 'Author', internalId: 12 }], keywords: ['Topic'], attachments: [attachment()], managedDirectory: privatePath, modelKey: 'SENTINEL_KEY', webdavPassword: 'SENTINEL_PASSWORD' });
const evidence = (): VerifiedDesktopAttachment => ({ localPaperId: 'paper-local', localAttachmentId: 'attachment-local', verification: 'sha256-complete', sha256: hash, sizeBytes: 1024, pageCount: 8 });
const binding = (): DesktopHistoryVersionBinding => ({ proof: 'captured-with-verified-version', accountId: account, libraryBindingId: library, localPaperId: 'paper-local', localAttachmentId: 'attachment-local', sha256: hash, sourceKey, sourceUpdatedAt: timestamp, deviceId: device, sessionId: id(4), deviceSequence: 7, furthestPageIndex: 6, furthestOffsetRatio: 0.5 });
const history = () => ({
  workspaceId: 'native-library:paper-local', lastPdfPath: privatePath, lastMineruPath: privatePath,
  document: { sources: [{ localPath: privatePath }], providerKey: 'SENTINEL_PROVIDER' },
  qaMessages: [{ content: 'PRIVATE_QA_TEXT', attachment: { filePath: privatePath } }],
  pdfScrollPositions: { [sourceKey]: { sourceKey, page: 3, pageOffsetRatio: 0.25, scrollTop: 1500, updatedAt: timestamp } },
  annotations: [{ page: 3, rect: [20, 30, 100, 50] }], blockTextMarks: [{ blockId: 'old-block' }],
});
const input = (): DesktopProjectionInput => ({ accountId: account, libraryBindingId: library, identityMap: createDesktopIdentityMap(account, library), papers: [paper()], verifiedAttachments: [evidence()] });
const entityOf = (result: DesktopProjectionResult, type: string) => result.entities.find((entity) => entity.entityType === type);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('desktop projection reconstructs only portable fields and leaves source data unchanged', () => {
  const source = input();
  source.history = { 'native-library:paper-local': history() };
  const before = canonicalJson(source);
  const projected = projectDesktopLibrary(freeze(source), allocate());
  assert.equal(canonicalJson(source), before);
  assert.deepEqual(projected.entities.map((entity) => entity.entityType), ['paper', 'attachmentVersion']);
  assert.deepEqual(entityOf(projected, 'paper')?.data, { title: 'A paper', doi: '10.1000/example', year: '2026', publication: null, abstractText: 'Abstract', authors: ['Author'], keywords: ['Topic'] });
  const serialized = JSON.stringify(projected);
  for (const forbidden of ['private-profile', 'filePath', 'SENTINEL_', 'PRIVATE_QA_TEXT', 'lastMineruPath', 'managedDirectory', 'qaMessages']) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.ok(projected.skipped.some((skip) => skip.code === 'UNVERIFIED_HISTORY_VERSION'));
  for (const entity of projected.entities) assert.equal(validateEntityData(entity.entityType, entity.data).ok, true);
  assert.deepEqual(source.identityMap.aliases, {});
});

test('opaque IDs survive reordering and file moves only through the persisted scoped mapping', () => {
  const generate = allocate();
  const first = projectDesktopLibrary(input(), generate);
  const moved = paper();
  moved.attachments[0].filePath = 'D:\\moved\\paper.pdf';
  const second = projectDesktopLibrary({ ...input(), identityMap: first.identityMap, papers: [{ ...paper(), id: 'paper-other', attachments: [] }, moved] }, generate);
  const secondOriginal = second.entities.find((entity) => entity.entityType === 'paper' && entity.entityId === entityOf(first, 'paper')!.entityId);
  assert.ok(secondOriginal);
  assert.equal(entityOf(second, 'attachmentVersion')?.entityId, entityOf(first, 'attachmentVersion')?.entityId);
  assert.equal(validateDesktopIdentityMap(second.identityMap).ok, true);
  const privateMapping = JSON.stringify(second.identityMap);
  assert.equal(privateMapping.includes('moved'), false);
  assert.equal(privateMapping.includes('private-profile'), false);
});

test('one local identifier cannot accidentally reuse mappings across accounts or library bindings', () => {
  const generate = allocate();
  const original = projectDesktopLibrary(input(), generate);
  for (const [accountId, libraryBindingId] of [[id(10), library], [account, id(11)]]) {
    assert.throws(() => projectDesktopLibrary({ ...input(), accountId, libraryBindingId, identityMap: original.identityMap }, generate), /DESKTOP_SCOPE_MISMATCH/);
    const separate = projectDesktopLibrary({ ...input(), accountId, libraryBindingId, identityMap: createDesktopIdentityMap(accountId, libraryBindingId) }, generate);
    assert.notEqual(entityOf(original, 'paper')?.entityId, entityOf(separate, 'paper')?.entityId);
  }
  assert.throws(() => ensureDesktopIdentity(original.identityMap, 'paper', [privatePath], generate), /INVALID_LOCAL_ID/);
  assert.throws(() => ensureDesktopIdentity(original.identityMap, 'paper', ['standalone:C-drive'], generate), /INVALID_LOCAL_ID/);
});

test('an attachment requires complete hash evidence; stored metadata alone is insufficient', () => {
  const noEvidence = projectDesktopLibrary({ ...input(), verifiedAttachments: [] }, allocate());
  assert.equal(entityOf(noEvidence, 'attachmentVersion'), undefined);
  assert.ok(noEvidence.skipped.some((skip) => skip.code === 'UNVERIFIED_ATTACHMENT_HASH'));
  const mismatch = projectDesktopLibrary({ ...input(), verifiedAttachments: [{ ...evidence(), sha256: 'b'.repeat(64) }] }, allocate());
  assert.equal(entityOf(mismatch, 'attachmentVersion'), undefined);
  assert.ok(mismatch.skipped.some((skip) => skip.code === 'ATTACHMENT_EVIDENCE_MISMATCH'));
  assert.throws(() => projectDesktopLibrary({ ...input(), verifiedAttachments: [{ ...evidence(), sha256: 'unknown' }] }, allocate()), /INVALID_ATTACHMENT_EVIDENCE/);
  assert.throws(() => projectDesktopLibrary({ ...input(), verifiedAttachments: [evidence(), evidence()] }, allocate()), /DUPLICATE_ATTACHMENT_EVIDENCE/);
});

test('same-path PDF replacement creates a new version and cannot inherit an old coordinate binding', () => {
  const first = projectDesktopLibrary(input(), allocate());
  const replaced = paper(); replaced.attachments[0].contentHash = 'b'.repeat(64);
  const replacement = projectDesktopLibrary({ ...input(), identityMap: first.identityMap, papers: [replaced], verifiedAttachments: [{ ...evidence(), sha256: 'b'.repeat(64) }], history: { 'native-library:paper-local': history() }, historyBindings: [binding()] }, allocate(1000));
  assert.notEqual(entityOf(replacement, 'attachmentVersion')?.entityId, entityOf(first, 'attachmentVersion')?.entityId);
  assert.equal(entityOf(replacement, 'readingPosition'), undefined);
  assert.equal(entityOf(replacement, 'annotation'), undefined);
  assert.ok(replacement.skipped.some((skip) => skip.code === 'INVALID_HISTORY_VERSION_BINDING'));
});

test('only capture-time version evidence projects an exact reading checkpoint, never legacy pixel anchors', () => {
  const source = { ...input(), history: { 'native-library:paper-local': history() }, historyBindings: [binding()] };
  const projected = projectDesktopLibrary(freeze(source), allocate());
  const position = entityOf(projected, 'readingPosition');
  assert.ok(position);
  assert.deepEqual(position.data, { paperId: entityOf(projected, 'paper')!.entityId, attachmentVersionId: entityOf(projected, 'attachmentVersion')!.entityId, pageIndex: 2, offsetRatio: 0.25, furthestPageIndex: 6, furthestOffsetRatio: 0.5, sessionId: id(4), deviceSequence: 7, observedAt: '2026-10-24T06:00:00.000Z' });
  assert.equal(entityOf(projected, 'annotation'), undefined);
  assert.ok(projected.skipped.some((skip) => skip.code === 'UNSUPPORTED_LEGACY_ANCHOR'));
  assert.ok(projected.skipped.some((skip) => skip.code === 'UNSUPPORTED_STRUCTURED_TEXT_MARK'));
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes(sourceKey), false);
  assert.equal(serialized.includes('PRIVATE_QA_TEXT'), false);
  const stale = projectDesktopLibrary({ ...source, historyBindings: [{ ...binding(), sourceUpdatedAt: timestamp - 1000 }] }, allocate());
  assert.equal(entityOf(stale, 'readingPosition'), undefined);
  const wrongScope = projectDesktopLibrary({ ...source, historyBindings: [{ ...binding(), accountId: id(9) }] }, allocate());
  assert.equal(entityOf(wrongScope, 'readingPosition'), undefined);
});

test('standalone histories and histories without a normalized offset stay private and untouched', () => {
  const standaloneId = `standalone:${privatePath}`;
  const source = input();
  source.history = { [standaloneId]: { ...history(), workspaceId: standaloneId } };
  source.historyBindings = [binding()];
  const projected = projectDesktopLibrary(freeze(source), allocate());
  assert.equal(entityOf(projected, 'readingPosition'), undefined);
  assert.ok(projected.skipped.some((skip) => skip.code === 'UNMAPPED_HISTORY'));
  assert.equal(JSON.stringify(projected).includes('private-profile'), false);
  const legacy = history();
  delete (legacy.pdfScrollPositions[sourceKey] as { pageOffsetRatio?: number }).pageOffsetRatio;
  const noRatio = projectDesktopLibrary({ ...input(), history: { 'native-library:paper-local': legacy }, historyBindings: [binding()] }, allocate());
  assert.equal(entityOf(noRatio, 'readingPosition'), undefined);
  assert.ok(noRatio.skipped.some((skip) => skip.code === 'UNSUPPORTED_LEGACY_POSITION'));
});

test('legacy rich notes are never flattened while explicit new Markdown notes project independently', () => {
  const notes = [
    { id: 'rich-note', paperId: 'paper-local', title: 'Rich', content: 'lossy fallback', contentJson: { type: 'doc', content: [{ type: 'table' }] } },
    { id: 'old-note', paperId: 'paper-local', title: 'Old', content: 'old unknown format' },
    { id: 'new-note', paperId: 'native-library:paper-local', title: 'New', body: '**Markdown**', format: 'markdown', llmSecret: 'SENTINEL_NOTE' },
    { id: 'unbound-note', paperId: null, title: 'Standalone Markdown', body: 'new standalone', format: 'markdown' },
  ];
  const projected = projectDesktopLibrary({ ...input(), notes: freeze(notes) }, allocate());
  const visibleNotes = projected.entities.filter((entity) => entity.entityType === 'note');
  assert.equal(visibleNotes.length, 2);
  assert.ok(projected.skipped.some((skip) => skip.code === 'UNSUPPORTED_RICH_NOTE'));
  assert.ok(projected.skipped.some((skip) => skip.code === 'UNSUPPORTED_NOTE_FORMAT'));
  const serialized = JSON.stringify(visibleNotes);
  assert.equal(serialized.includes('lossy fallback'), false);
  assert.equal(serialized.includes('SENTINEL_NOTE'), false);
  assert.equal(notes[0].contentJson?.content[0].type, 'table');
});

test('source validation rejects accessor and malformed evidence containers without invoking getters', () => {
  let invoked = false;
  const source = input();
  Object.defineProperty(source, 'papers', { enumerable: true, get() { invoked = true; return []; } });
  assert.throws(() => projectDesktopLibrary(source, allocate()), /INVALID_DESKTOP_SOURCE/);
  assert.equal(invoked, false);
  assert.throws(() => projectDesktopLibrary({ ...input(), historyBindings: {} as never }, allocate()), /INVALID_DESKTOP_SOURCE/);
  assert.throws(() => projectDesktopLibrary({ ...input(), verifiedAttachments: new Array(1) }, allocate()), /INVALID_DESKTOP_SOURCE/);
  const local = paper();
  Object.defineProperty(local, 'title', { enumerable: true, get() { invoked = true; return 'secret'; } });
  const projected = projectDesktopLibrary({ ...input(), papers: [local] }, allocate());
  assert.equal(projected.entities.length, 0);
  assert.equal(invoked, false);
});

test('private identity maps reject duplicate opaque IDs, invalid aliases and reused allocations', () => {
  const original = createDesktopIdentityMap(account, library);
  const first = ensureDesktopIdentity(original, 'paper', ['paper-local'], () => id(100));
  assert.equal(validateDesktopIdentityMap(first.identityMap).ok, true);
  assert.equal(ensureDesktopIdentity(first.identityMap, 'paper', ['paper-local'], () => { throw new Error('unexpected allocation'); }).entityId, id(100));
  assert.throws(() => ensureDesktopIdentity(first.identityMap, 'paper', ['paper-other'], () => id(100)), /INVALID_ID_ALLOCATION/);
  assert.equal(validateDesktopIdentityMap({ ...first.identityMap, aliases: { ...first.identityMap.aliases, '["paper","another"]': id(100) } }).ok, false);
  assert.equal(validateDesktopIdentityMap({ ...original, aliases: { [JSON.stringify(['paper', privatePath])]: id(100) } }).ok, false);
  assert.deepEqual(original.aliases, {});
});
