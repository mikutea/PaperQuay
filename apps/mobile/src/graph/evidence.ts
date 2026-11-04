import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readGraphEvidence, graphEvidenceMetadata, type GraphEvidenceSnapshot, type GraphEvidenceSource, type GraphEvidenceEdge } from '../../../../packages/sync-core/src/graphEvidence.ts';
import { listVisibleEntities, type AccountSyncState, type VisibleEntity, type AttachmentVersionData } from '../../../../packages/sync-core/src/index.ts';
import { normalizeServiceUrl } from '../config.ts';
import { reviewFingerprint } from '../review/fingerprint.ts';
import type { AccountScope } from '../storage/accountStore.ts';

export type { GraphEvidenceSnapshot, GraphEvidenceSource, GraphEvidenceEdge };
export const GRAPH_EVIDENCE_FILE_BYTES = 1024 * 1024;
export class GraphEvidenceError extends Error {
  constructor(readonly code: 'INVALID' | 'LIMIT' | 'SCOPE_CHANGED' | 'SOURCE_CHANGED' | 'SELECTION' | 'CHANGED') { super(code); this.name = 'GraphEvidenceError'; }
}
const fail = (code: GraphEvidenceError['code']): never => { throw new GraphEvidenceError(code); };
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(descriptors, key)) && Object.values(descriptors).every(row => row.enumerable && 'value' in row);
};
export interface GraphEvidenceAdoption { version: 1; snapshot: GraphEvidenceSnapshot; edgeIds: string[]; adoptedAt: string }
export interface GraphEvidenceWorkspace { sync: AccountSyncState; pendingResolutions: Readonly<Record<string, { entityType: string; entityId: string }>>; graphEvidence?: GraphEvidenceAdoption }
export interface GraphEvidenceView {
  adoption: GraphEvidenceAdoption;
  edges: GraphEvidenceEdge[];
  unavailable: { paperId: string; title: string }[];
  hiddenEdges: number;
  identity: string;
}
/** The transaction and the file boundary verify the same immutable envelope. */
export function readStoredGraphEvidence(input: unknown): GraphEvidenceSnapshot {
  try {
    const snapshot = readGraphEvidence(input), { digest, ...body } = snapshot;
    if (reviewFingerprint(body) !== digest) return fail('INVALID');
    for (const edge of snapshot.edges) { const { id, ...value } = edge; if (reviewFingerprint(value) !== id) return fail('INVALID'); }
    return snapshot;
  } catch (error) { if (error instanceof GraphEvidenceError) throw error; return fail('INVALID'); }
}
export function decodeGraphEvidenceFile(bytes: Uint8Array): GraphEvidenceSnapshot {
  if (bytes.byteLength > GRAPH_EVIDENCE_FILE_BYTES) return fail('LIMIT');
  try { return readStoredGraphEvidence(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch (error) { if (error instanceof GraphEvidenceError) throw error; return fail('INVALID'); }
}
export function readGraphEvidenceAdoption(input: unknown): GraphEvidenceAdoption {
  try {
    if (!exact(input, ['version', 'snapshot', 'edgeIds', 'adoptedAt']) || input.version !== 1 || !Array.isArray(input.edgeIds) || !input.edgeIds.length
      || input.edgeIds.length > 512 || new Set(input.edgeIds).size !== input.edgeIds.length || typeof input.adoptedAt !== 'string'
      || new Date(input.adoptedAt).toISOString() !== input.adoptedAt) return fail('INVALID');
    const snapshot = readStoredGraphEvidence(input.snapshot), ids = new Set(snapshot.edges.map(row => row.id));
    if (input.edgeIds.some(id => typeof id !== 'string' || !ids.has(id))) return fail('INVALID');
    return { version: 1, snapshot, edgeIds: [...input.edgeIds].sort() as string[], adoptedAt: input.adoptedAt };
  } catch (error) { if (error instanceof GraphEvidenceError) throw error; return fail('INVALID'); }
}
export function graphEvidenceAdoptionKey(input: GraphEvidenceAdoption | undefined | null): string | null {
  if (!input) return null; const value = readGraphEvidenceAdoption(input); return reviewFingerprint({ digest: value.snapshot.digest, edgeIds: value.edgeIds });
}
export function assertGraphEvidenceAccount(snapshot: GraphEvidenceSnapshot, scope: AccountScope): void {
  const serviceId = bytesToHex(sha256(new TextEncoder().encode(normalizeServiceUrl(scope.apiBaseUrl))));
  if (snapshot.accountId !== scope.accountId || snapshot.serviceId !== serviceId) fail('SCOPE_CHANGED');
}
function sourceCurrent(source: GraphEvidenceSource, entities: readonly VisibleEntity[], blocked: Set<string>): boolean {
  const paper = entities.find(row => row.entityType === 'paper' && row.entityId === source.paperId);
  if (!paper?.data || paper.deleted || paper.pending || blocked.has('paper:' + source.paperId) || (paper.data as { title?: unknown }).title !== source.title) return false;
  try { if (reviewFingerprint(graphEvidenceMetadata(paper.data)) !== source.metadataDigest) return false; } catch { return false; }
  for (const proof of source.versions) {
    const version = entities.find(row => row.entityType === 'attachmentVersion' && row.entityId === proof.versionId), data = version?.data as AttachmentVersionData | null;
    if (!data || version!.deleted || version!.pending || blocked.has('attachmentVersion:' + proof.versionId)
      || data.paperId !== source.paperId || data.sha256 !== proof.sha256 || data.sizeBytes !== proof.sizeBytes) return false;
  }
  return true;
}
function blockedSources(workspace: GraphEvidenceWorkspace): Set<string> {
  const blocked = new Set<string>();
  for (const row of Object.values(workspace.sync.conflicts)) {
    blocked.add(row.attempted.entityType + ':' + row.attempted.entityId);
    if (row.current) blocked.add(row.current.entityType + ':' + row.current.entityId);
  }
  for (const row of Object.values(workspace.pendingResolutions)) blocked.add(row.entityType + ':' + row.entityId);
  return blocked;
}
export function inspectGraphEvidenceSources(snapshot: GraphEvidenceSnapshot, workspace: GraphEvidenceWorkspace): { available: Set<string>; unavailable: { paperId: string; title: string }[] } {
  const entities = listVisibleEntities(workspace.sync), blocked = blockedSources(workspace), available = new Set<string>(), unavailable: { paperId: string; title: string }[] = [];
  for (const source of snapshot.sources) if (sourceCurrent(source, entities, blocked)) available.add(source.paperId); else unavailable.push({ paperId: source.paperId, title: source.title });
  return { available, unavailable };
}
export function assertGraphEvidenceSelection(snapshot: GraphEvidenceSnapshot, edgeIds: readonly string[], workspace: GraphEvidenceWorkspace): void {
  if (!edgeIds.length || edgeIds.length > 512 || new Set(edgeIds).size !== edgeIds.length) fail('SELECTION');
  const selected = snapshot.edges.filter(row => edgeIds.includes(row.id)); if (selected.length !== edgeIds.length) fail('SELECTION');
  const sources = inspectGraphEvidenceSources(snapshot, workspace).available;
  if (selected.some(row => !sources.has(row.sourcePaperId) || !sources.has(row.targetPaperId))) fail('SOURCE_CHANGED');
}
export function graphEvidenceView(workspace: GraphEvidenceWorkspace | null | undefined): GraphEvidenceView | null {
  if (!workspace?.graphEvidence) return null;
  const adoption = readGraphEvidenceAdoption(workspace.graphEvidence);
  if (adoption.snapshot.accountId !== workspace.sync.accountId) fail('SCOPE_CHANGED');
  const sources = inspectGraphEvidenceSources(adoption.snapshot, workspace), selected = adoption.snapshot.edges.filter(row => adoption.edgeIds.includes(row.id));
  const edges = selected.filter(row => sources.available.has(row.sourcePaperId) && sources.available.has(row.targetPaperId));
  return { adoption, edges, unavailable: sources.unavailable, hiddenEdges: selected.length - edges.length,
    identity: reviewFingerprint({ adoptionKey: graphEvidenceAdoptionKey(adoption), visible: edges.map(row => row.id) }) };
}
export function graphEvidenceText(edge: GraphEvidenceEdge): string {
  if (edge.kind === 'citation') return '桌面参考文献缓存中的引用候选。' + (edge.description ? '缓存记录：' + edge.description + '。' : '')
    + '此关系尚未核验到当前 PDF，仍需回到原文确认。';
  return '桌面缓存向量按文档平均后计算余弦相似度：' + String(edge.score) + '。模型指纹与维度保留在来源证据中；相似不代表引用或论证成立，尚未核验到当前 PDF。';
}
export function graphEvidenceJson(input: GraphEvidenceAdoption): string { return JSON.stringify(readGraphEvidenceAdoption(input).snapshot); }
