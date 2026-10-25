import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson, ENTITY_TYPES, SYNC_LIMITS, validateEntityData, validateOperation,
  validatePullResponse, validatePushRequest, validatePushResponse, validatePushResult, validateRecord,
} from '../packages/sync-core/src/index.ts';
import type { EntityDataMap, SyncOperation, SyncRecord } from '../packages/sync-core/src/index.ts';

const id = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const at = '2026-10-24T06:00:00.000Z';
const data: EntityDataMap = {
  paper: { title: 'A paper', doi: '10.1000/example', year: '2026', publication: null, abstractText: null, authors: ['Author'], keywords: [] },
  attachmentVersion: { paperId: id(1), attachmentId: id(2), sha256: 'a'.repeat(64), sizeBytes: 1024, mediaType: 'application/pdf', fileName: 'paper.pdf', pageCount: 5 },
  note: { paperId: id(1), title: 'Note', body: '# Reading\n\nAn offline note.', format: 'markdown' },
  annotation: { paperId: id(1), attachmentVersionId: id(3), kind: 'highlight', color: '#ffaa00', comment: '', anchor: { pageIndex: 0, coordinateSpace: 'pdf-crop-box-unrotated-normalized', quads: [[0.1, 0.1, 0.6, 0.1, 0.6, 0.2, 0.1, 0.2]], quote: { exact: 'a quote', prefix: '', suffix: '' } } },
  readingPosition: { paperId: id(1), attachmentVersionId: id(3), pageIndex: 2, offsetRatio: 0.4, furthestPageIndex: 3, furthestOffsetRatio: 0.1, sessionId: id(4), deviceSequence: 6, observedAt: at },
};
const operation = (entityType: keyof EntityDataMap = 'note'): SyncOperation => ({ opId: id(10), entityType, entityId: id(11), mutation: 'put', baseRevision: 0, schemaVersion: 1, data: data[entityType], clientCreatedAt: at } as SyncOperation);
const record = (entityType: keyof EntityDataMap = 'note'): SyncRecord => ({ entityType, entityId: id(11), schemaVersion: 1, revision: 1, deletedAt: null, updatedAt: at, modifiedByDeviceId: id(12), data: data[entityType] } as SyncRecord);

test('all protocol entities accept the explicit whitelist and tombstones require null data', () => {
  for (const type of ENTITY_TYPES) {
    assert.equal(validateEntityData(type, data[type]).ok, true, type);
    assert.equal(validateOperation(operation(type)).ok, true, type);
    assert.equal(validateRecord(record(type)).ok, true, type);
    assert.equal(validateOperation({ ...operation(type), mutation: 'delete', data: null }).ok, true);
    assert.equal(validateRecord({ ...record(type), deletedAt: at, data: null }).ok, true);
    assert.equal(validateRecord({ ...record(type), deletedAt: at }).ok, false);
    assert.equal(validateRecord({ ...record(type), data: null }).ok, false);
  }
  assert.equal(validateOperation({ ...operation(), mutation: 'restore', baseRevision: 0 }).ok, false);
  assert.equal(validateOperation({ ...operation(), mutation: 'restore', baseRevision: 2 }).ok, true);
});

test('wire payloads reject account identity, paths, credentials, and unknown nested fields without echoing them', () => {
  const secret = 'SENTINEL_TOKEN_DO_NOT_LOG';
  const path = 'C:\\Users\\private\\paper.pdf';
  const samples = [
    { ...operation(), accountId: id(20) },
    { ...operation(), data: { ...data.note, apiKey: secret } },
    { ...operation('annotation'), data: { ...data.annotation, anchor: { ...data.annotation.anchor, [path]: secret } } },
    { ...operation('attachmentVersion'), data: { ...data.attachmentVersion, fileName: path } },
  ];
  for (const sample of samples) {
    const result = validateOperation(sample);
    assert.equal(result.ok, false);
    const diagnostic = JSON.stringify(result);
    assert.equal(diagnostic.includes(secret), false);
    assert.equal(diagnostic.includes('private'), false);
    assert.equal(diagnostic.includes('accountId'), false);
  }
  assert.equal(validatePushRequest({ protocolVersion: 1, deviceId: id(12), accountId: id(20), operations: [operation()] }).ok, false);
  assert.equal(validateRecord({ ...record(), accountId: id(20) }).ok, false);
});

test('PDF anchors require normalized coordinates and exact content-version identity', () => {
  for (const coordinate of [-0.01, 1.01, Infinity, NaN]) {
    const annotation = structuredClone(data.annotation);
    annotation.anchor.quads[0][0] = coordinate;
    assert.equal(validateEntityData('annotation', annotation).ok, false);
  }
  assert.equal(validateEntityData('annotation', { ...data.annotation, attachmentVersionId: '/local/paper.pdf' }).ok, false);
  assert.equal(validateEntityData('annotation', { ...data.annotation, anchor: { ...data.annotation.anchor, coordinateSpace: 'viewport-pixels' } }).ok, false);
  assert.equal(validateEntityData('annotation', { ...data.annotation, anchor: { ...data.annotation.anchor, quads: [] } }).ok, false);
  assert.equal(validateEntityData('annotation', { ...data.annotation, anchor: { ...data.annotation.anchor, quads: [[0, 0, 1, 1]] } }).ok, false);
  for (const name of ['.', '..', '/file.pdf', 'a\\b.pdf', 'file:stream', 'a\u0000b']) {
    assert.equal(validateEntityData('attachmentVersion', { ...data.attachmentVersion, fileName: name }).ok, false, name);
  }
  assert.equal(validateEntityData('attachmentVersion', { ...data.attachmentVersion, sha256: 'A'.repeat(64) }).ok, false);
});

test('reading checkpoints retain furthest progress while allowing a lower current page', () => {
  assert.equal(validateEntityData('readingPosition', { ...data.readingPosition, pageIndex: 0, offsetRatio: 0 }).ok, true);
  assert.equal(validateEntityData('readingPosition', { ...data.readingPosition, pageIndex: 4 }).ok, false);
  assert.equal(validateEntityData('readingPosition', { ...data.readingPosition, furthestPageIndex: 2, furthestOffsetRatio: 0.3 }).ok, false);
  assert.equal(validateEntityData('readingPosition', { ...data.readingPosition, deviceSequence: 0.5 }).ok, false);
  assert.equal(validateOperation({ ...operation('readingPosition'), data: { ...data.readingPosition, pageIndex: 4 } }).ok, false);
  assert.equal(validateRecord({ ...record('readingPosition'), data: { ...data.readingPosition, pageIndex: 4 } }).ok, false);
});

test('invalid timestamps, identities, oversized fields, accessors, and non-JSON objects fail closed', () => {
  for (const clientCreatedAt of ['2026-02-29T12:00:00Z', '2026-02-30T12:00:00Z', '2026-10-24', '2026-10-24T24:01:00Z', '2026-10-24T12:00:00+99:99']) {
    assert.equal(validateOperation({ ...operation(), clientCreatedAt }).ok, false, clientCreatedAt);
  }
  assert.equal(validateOperation({ ...operation(), clientCreatedAt: '2024-02-29T12:00:00+08:00' }).ok, true);
  for (const opId of ['', 'local-id', id(10).toUpperCase().replace('0000000a', '0000000A'), '00000000-0000-0000-0000-000000000000']) {
    assert.equal(validateOperation({ ...operation(), opId }).ok, false, opId);
  }
  assert.equal(validateEntityData('note', { ...data.note, body: 'x'.repeat(SYNC_LIMITS.maxNoteBodyLength + 1) }).ok, false);
  let calls = 0;
  const getter = { ...data.note };
  Object.defineProperty(getter, 'body', { enumerable: true, get() { calls += 1; return 'secret'; } });
  assert.equal(validateEntityData('note', getter).ok, false);
  assert.equal(calls, 0);
  assert.equal(validateEntityData('note', Object.assign(Object.create({ inherited: true }), data.note)).ok, false);
  assert.equal(validateEntityData('paper', { ...data.paper, authors: new Array(1) }).ok, false);
  const authors = ['A'] as string[] & { token?: string };
  authors.token = 'SECRET';
  assert.equal(validateEntityData('paper', { ...data.paper, authors }).ok, false);
});

test('batch and receipt validation rejects ambiguous IDs and incomplete error/cursor contracts', () => {
  const request = { protocolVersion: 1, deviceId: id(12), operations: [operation()] };
  assert.equal(validatePushRequest(request).ok, true);
  assert.equal(validatePushRequest({ ...request, operations: [] }).ok, false);
  assert.equal(validatePushRequest({ ...request, operations: [operation(), operation()] }).ok, false);
  assert.equal(validatePushRequest({ ...request, operations: new Array(SYNC_LIMITS.maxBatchOperations + 1).fill(operation()) }).ok, false);
  const conflict = { opId: id(10), status: 'conflict', replayed: true, conflictId: id(13) };
  assert.equal(validatePushResult(conflict).ok, true);
  assert.equal(validatePushResult({ ...conflict, conflictId: undefined }).ok, false);
  assert.equal(validatePushResult({ opId: id(10), status: 'rejected', replayed: false, code: 'DEPENDENCY_PENDING', retryable: true }).ok, true);
  assert.equal(validatePushResult({ opId: id(10), status: 'rejected', replayed: false, code: 'DEPENDENCY_PENDING' }).ok, false);
  assert.equal(validatePushResponse({ protocolVersion: 1, results: [conflict, conflict] }).ok, false);
  assert.equal(validatePullResponse({ protocolVersion: 1, records: [record()], nextCursor: 'cursor', hasMore: false }).ok, true);
  assert.equal(validatePullResponse({ protocolVersion: 1, records: [], nextCursor: null, hasMore: true }).ok, false);
});

test('canonical payload identity ignores key order but rejects lossy JavaScript values', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: [1, null], c: true } }), canonicalJson({ a: { c: true, d: [1, null] }, b: 2 }));
  const repeated = { a: 1 };
  assert.equal(canonicalJson([repeated, repeated]), '[{"a":1},{"a":1}]');
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const candidate of [undefined, NaN, Infinity, new Date(), new Array(1), cycle, { a: undefined }, { a: () => 1 }]) {
    assert.throws(() => canonicalJson(candidate), /INVALID_JSON/);
  }
  let invoked = false;
  assert.throws(() => canonicalJson({ get a() { invoked = true; return 1; } }), /INVALID_JSON/);
  assert.equal(invoked, false);
});
