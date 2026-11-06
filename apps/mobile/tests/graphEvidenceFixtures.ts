import { IDBFactory } from 'fake-indexeddb';
import { graphEvidenceMetadata, graphEvidenceServiceId, type GraphEvidenceSnapshot, type GraphEvidenceEdge } from '../../../packages/sync-core/src/graphEvidence.ts';
import { createAccountState, type SyncRecord } from '../../../packages/sync-core/src/index.ts';
import { reviewFingerprint } from '../src/review/fingerprint.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import { WorkspaceController, decodeWorkspace, type StoredWorkspace } from '../src/sync/workspace.ts';
import type { TestContext } from 'node:test';
export const gid = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
export const graphScope = { apiBaseUrl: 'https://sync.example.test', accountId: gid(1) }, graphAt = '2026-11-04T11:00:00.000Z';
export const graphPaper = (title: string) => ({ title, doi: '10.1234/' + title.length, authors: ['Synthetic researcher'], year: '2026', publication: null, abstractText: 'Synthetic abstract', keywords: ['Evidence'] });
export async function graphEvidenceFixture() {
  const sync = createAccountState(graphScope.accountId, gid(20));
  const records: SyncRecord[] = [2, 3].map(n => ({ entityType: 'paper', entityId: gid(n), data: graphPaper(n === 2 ? 'First evidence paper' : 'Second evidence study'), schemaVersion: 1, revision: 1,
    deletedAt: null, updatedAt: graphAt, modifiedByDeviceId: gid(20) }));
  for (const n of [2, 3]) records.push({ entityType: 'attachmentVersion', entityId: gid(n + 10), schemaVersion: 1, revision: 1, deletedAt: null, updatedAt: graphAt, modifiedByDeviceId: gid(20),
    data: { paperId: gid(n), attachmentId: gid(n + 30), sha256: String(n).repeat(64), sizeBytes: 512, mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount: 2 } });
  sync.serverRecords = Object.fromEntries(records.map(row => [row.entityType + ':' + row.entityId, row]));
  const sources = records.filter(row => row.entityType === 'paper').map(row => ({ paperId: row.entityId, title: row.data!.title as string, metadataDigest: reviewFingerprint(graphEvidenceMetadata(row.data)),
    versions: [{ versionId: gid(Number.parseInt(row.entityId.slice(-2), 16) + 10), sha256: String(Number.parseInt(row.entityId.slice(-2), 16)).repeat(64), sizeBytes: 512 }] }));
  const unsigned: Omit<GraphEvidenceEdge, 'id'>[] = [{ sourcePaperId: gid(2), targetPaperId: gid(3), kind: 'citation', description: 'Reference cache candidate', score: null,
    provenance: { kind: 'reference-cache', referenceDigest: 'a'.repeat(64), fetchedAt: 0, pdfVersionVerified: false } },
  { sourcePaperId: gid(3), targetPaperId: gid(2), kind: 'similarity', description: null, score: .9,
    provenance: { kind: 'vector-cache', method: 'mean-chunk-cosine-v1', dimension: 4, modelDigest: 'b'.repeat(64), sourceCacheDigest: 'c'.repeat(64), targetCacheDigest: 'd'.repeat(64), indexedAt: 0, pdfVersionVerified: false } }];
  const body = { format: 'paperquay-graph-evidence' as const, version: 1 as const, serviceId: await graphEvidenceServiceId(graphScope.apiBaseUrl), accountId: graphScope.accountId,
    producer: { deviceId: gid(20), libraryBindingId: gid(21) }, createdAt: graphAt, sources, edges: unsigned.map(row => ({ ...row, id: reviewFingerprint(row) })) as GraphEvidenceEdge[],
    coverage: { referenceCache: true, vectorCache: true, versionPolicy: 'historical-cache-unverified-pdf' as const } };
  const snapshot: GraphEvidenceSnapshot = { ...body, digest: reviewFingerprint(body) }; return { sync, records, snapshot };
}
export async function setupGraphEvidence(t: TestContext) {
  const f = await graphEvidenceFixture(), indexedDB = new IDBFactory(), name = crypto.randomUUID();
  const store = new AccountStore<StoredWorkspace>({ decode: decodeWorkspace, indexedDB, databaseName: name });
  await store.update(graphScope, () => ({ sync: f.sync, pendingResolutions: {} })); let calls = 0;
  const controller = new WorkspaceController({ apiBaseUrl: graphScope.apiBaseUrl, store, online: false, now: () => graphAt, api: {
    register: async () => ({ accountId: graphScope.accountId, device: { id: gid(20), name: 'Graph evidence fixture', platform: 'web' as const, createdAt: graphAt, lastSeenAt: graphAt, revokedAt: null } }),
    devices: async () => [], revokeDevice: async () => {}, conflicts: async () => ({ conflicts: [], nextCursor: '', hasMore: false }),
    push: async () => { calls++; throw Error('No network expected'); }, pull: async () => { calls++; throw Error('No network expected'); }, resolveConflict: async () => { calls++; throw Error('No network expected'); },
  } }); await controller.bind('Graph evidence fixture');
  t.after(async () => { controller.deactivate(); await store.close(); });
  return { ...f, store, indexedDB, name, controller, calls: () => calls };
}
