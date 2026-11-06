import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_EVIDENCE_LIMITS, graphEvidenceDigest, graphEvidenceMetadata, graphEvidenceServiceId,
  normalizeGraphEvidenceServiceUrl, readGraphEvidence, verifyGraphEvidence, assertGraphEvidenceScope,
} from '../packages/sync-core/src/graphEvidence.ts';

const id = (value: number) => 'f0000000-0000-4000-8000-' + String(value).padStart(12, '0');
const hash = (value = 'a') => value.repeat(64);
async function fixture() {
  const citation = { sourcePaperId: id(1), targetPaperId: id(2), kind: 'citation' as const, description: 'A cached reference', score: null,
    provenance: { kind: 'reference-cache' as const, referenceDigest: hash(), fetchedAt: 0, pdfVersionVerified: false as const } };
  const similarity = { sourcePaperId: id(1), targetPaperId: id(2), kind: 'similarity' as const, description: null, score: .875,
    provenance: { kind: 'vector-cache' as const, method: 'mean-chunk-cosine-v1' as const, dimension: 4, modelDigest: hash('b'),
      sourceCacheDigest: hash('c'), targetCacheDigest: hash('d'), indexedAt: 0, pdfVersionVerified: false as const } };
  const body = { format: 'paperquay-graph-evidence' as const, version: 1 as const,
    serviceId: await graphEvidenceServiceId('https://sync.example.test/'), accountId: id(10), producer: { deviceId: id(11), libraryBindingId: id(12) },
    createdAt: '2026-11-04T12:00:00.000Z', sources: [1, 2].map(value => ({ paperId: id(value), title: 'Paper ' + value, metadataDigest: hash(),
      versions: [{ versionId: id(value + 20), sha256: hash('b'), sizeBytes: 42 }] })),
    edges: [{ id: await graphEvidenceDigest(citation), ...citation }, { id: await graphEvidenceDigest(similarity), ...similarity }],
    coverage: { referenceCache: true, vectorCache: true, versionPolicy: 'historical-cache-unverified-pdf' as const } };
  return { ...body, digest: await graphEvidenceDigest(body) };
}

test('graph evidence keeps both kinds of historical proof and verifies canonical edge and envelope hashes', async () => {
  const value = await fixture(), checked = await verifyGraphEvidence(value);
  assert.deepEqual(checked, value); assert.notEqual(checked, value);
  assert.equal(checked.edges[0].provenance.pdfVersionVerified, false);
  assert.equal(checked.edges[1].provenance.pdfVersionVerified, false);
  assert.equal(await graphEvidenceDigest({ b: 2, a: 1 }), await graphEvidenceDigest({ a: 1, b: 2 }));
});

test('a rehashed envelope cannot conceal a changed edge and a changed envelope cannot retain its old digest', async () => {
  const value = await fixture(); value.edges[0].description = 'Edited claim';
  const { digest: _digest, ...body } = value; value.digest = await graphEvidenceDigest(body);
  await assert.rejects(verifyGraphEvidence(value), { code: 'GRAPH_EVIDENCE_INTEGRITY' });
  const second = await fixture(); second.sources[0].title = 'Edited source label';
  await assert.rejects(verifyGraphEvidence(second), { code: 'GRAPH_EVIDENCE_INTEGRITY' });
});

test('closed graph shape rejects local paths, raw vectors, accessors, sparse arrays and unknown provenance claims', async () => {
  const value = await fixture();
  for (const mutate of [
    (row: any) => { row.path = 'fixture-private-path'; },
    (row: any) => { row.edges[1].provenance.embedding = [1, 0]; },
    (row: any) => { row.edges[0].provenance.pdfVersionVerified = true; },
    (row: any) => { row.sources[0].versions[0].fileName = 'fixture.pdf'; },
    (row: any) => { delete row.sources[0]; },
    (row: any) => { Object.defineProperty(row, 'accountId', { enumerable: true, get() { throw Error('Getter must not run'); } }); },
  ]) { const input = structuredClone(value); mutate(input); assert.throws(() => readGraphEvidence(input), { code: 'GRAPH_EVIDENCE_INVALID' }); }
});

test('endpoints, source and version identities, and coverage must agree without invented graph relationships', async () => {
  const value = await fixture();
  for (const mutate of [
    (row: any) => { row.edges[0].targetPaperId = id(99); },
    (row: any) => { row.edges[0].targetPaperId = row.edges[0].sourcePaperId; },
    (row: any) => { row.sources[1].paperId = row.sources[0].paperId; },
    (row: any) => { row.sources[1].versions[0].versionId = row.sources[0].versions[0].versionId; },
    (row: any) => { row.edges.push(row.edges[0]); },
    (row: any) => { row.coverage.referenceCache = false; },
    (row: any) => { row.edges[1].score = Number.NaN; },
    (row: any) => { row.edges[1].score = 1.01; },
    (row: any) => { row.edges[0].kind = 'custom'; },
  ]) { const input = structuredClone(value); mutate(input); assert.throws(() => readGraphEvidence(input), { code: 'GRAPH_EVIDENCE_INVALID' }); }
});

test('bounded packages fail explicitly instead of truncating sources, descriptions or byte content', async () => {
  const value = await fixture();
  const title = structuredClone(value); title.sources[0].title = 'x'.repeat(GRAPH_EVIDENCE_LIMITS.titleCharacters + 1);
  assert.throws(() => readGraphEvidence(title), { code: 'GRAPH_EVIDENCE_LIMIT' });
  const dimension = structuredClone(value); (dimension.edges[1].provenance as any).dimension = GRAPH_EVIDENCE_LIMITS.dimension + 1;
  assert.throws(() => readGraphEvidence(dimension), { code: 'GRAPH_EVIDENCE_LIMIT' });
  await assert.rejects(graphEvidenceDigest('x'.repeat(GRAPH_EVIDENCE_LIMITS.bytes + 1)), { code: 'GRAPH_EVIDENCE_LIMIT' });
  const sources = structuredClone(value); sources.sources = Array.from({ length: 17 }, (_, index) => ({ ...value.sources[0], paperId: id(index + 100), versions: [] }));
  assert.throws(() => readGraphEvidence(sources), { code: 'GRAPH_EVIDENCE_LIMIT' });
});

test('metadata digests preserve validated paper values while independently excluding organization choices', async () => {
  const body = { title: ' Exact title ', year: '2026', publication: 'Journal', doi: '10.1234/fixture', abstractText: 'Fixture abstract', authors: ['Author'], keywords: ['Key'] };
  assert.deepEqual(graphEvidenceMetadata(body), body);
  assert.deepEqual(graphEvidenceMetadata({ ...body, organization: { favorite: true, readingStatus: 'read', tags: ['Private tag'], collections: ['Private collection'], queueRank: null } }), body);
  assert.throws(() => graphEvidenceMetadata({ ...body, storedPath: 'private.pdf' }), { code: 'GRAPH_EVIDENCE_INVALID' });
});

test('service and account guards normalize only the service URL and never accept a different service or owner', async () => {
  const value = await fixture();
  assert.deepEqual(await assertGraphEvidenceScope(value, { apiBaseUrl: 'https://sync.example.test///', accountId: id(10) }), value);
  await assert.rejects(assertGraphEvidenceScope(value, { apiBaseUrl: 'https://other.example.test', accountId: id(10) }), { code: 'GRAPH_EVIDENCE_SCOPE_CHANGED' });
  await assert.rejects(assertGraphEvidenceScope(value, { apiBaseUrl: 'https://sync.example.test', accountId: id(99) }), { code: 'GRAPH_EVIDENCE_SCOPE_CHANGED' });
  for (const url of ['http://remote.example.test', 'https://user:secret@example.test', 'https://sync.example.test?key=fixture', 'file:///tmp/fixture', 'https://sync.example.test#fragment'])
    assert.throws(() => normalizeGraphEvidenceServiceUrl(url), { code: 'GRAPH_EVIDENCE_SCOPE_CHANGED' });
  assert.equal(normalizeGraphEvidenceServiceUrl('http://127.0.0.1:4311/'), 'http://127.0.0.1:4311');
});
