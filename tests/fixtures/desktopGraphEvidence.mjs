import { createHash } from 'node:crypto';
// Synthetic metadata/cache provenance only. No real paper text, paths or account are opened.
export const scopeKey = 'fixture-graph-evidence-account-library';
const uuid = i => 'e0000000-0000-4000-8000-' + String(i).padStart(12, '0');
const canonical = value => JSON.stringify(value, function (_key, item) { return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item; });
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const evidenceStatus = (patch = {}) => ({ scopeKey, busy: false, errorCode: null, ...patch });
export const evidencePaper = (localPaperId = 'local-one', patch = {}) => ({ localPaperId, title: '村庄公共空间的日常使用', bound: true, versionCount: 1, ...patch });
export const evidenceSource = (index = 1, patch = {}) => ({ paperId: uuid(index), title: index === 1 ? '村庄公共空间的日常使用' : '乡村步行空间与邻里交流', metadataDigest: digest('metadata-' + index), versions: [{ versionId: uuid(100 + index), sha256: digest('synthetic-pdf-' + index), sizeBytes: 4096 * index }], ...patch });
export const citationEdge = (patch = {}) => {
  const body = { sourcePaperId: uuid(1), targetPaperId: uuid(2), kind: 'citation', description: '参考文献缓存记录：乡村步行空间与邻里交流（2021），第 8 条。', score: null, provenance: { kind: 'reference-cache', referenceDigest: digest('reference-cache'), fetchedAt: Date.parse('2026-10-19T02:00:00.000Z'), pdfVersionVerified: false }, ...patch };
  return { id: digest(body), ...body };
};
export const similarityEdge = (patch = {}) => {
  const body = { sourcePaperId: uuid(1), targetPaperId: uuid(2), kind: 'similarity', description: '本机已保存的公共空间主题相似线索。', score: 0.9123456789012345, provenance: { kind: 'vector-cache', method: 'mean-chunk-cosine-v1', dimension: 3, modelDigest: digest('same-model'), sourceCacheDigest: digest('first-cache'), targetCacheDigest: digest('second-cache'), indexedAt: Date.parse('2026-10-20T03:00:00.000Z'), pdfVersionVerified: false }, ...patch };
  return { id: digest(body), ...body };
};
export function evidenceSnapshot(patch = {}) {
  const body = { format: 'paperquay-graph-evidence', version: 1, serviceId: digest('fixture-service'), accountId: uuid(1000), producer: { deviceId: uuid(1001), libraryBindingId: uuid(1002) }, createdAt: '2026-11-04T11:10:00.000Z', sources: [evidenceSource(1), evidenceSource(2)], edges: [citationEdge(), similarityEdge()], coverage: { referenceCache: true, vectorCache: true, versionPolicy: 'historical-cache-unverified-pdf' }, ...patch };
  delete body.digest; return { ...body, digest: digest(body) };
}
export function evidencePreview(patch = {}) {
  const snapshot = patch.snapshot || evidenceSnapshot(), skipped = patch.skipped || [];
  return { token: 'fixture-evidence-token', scopeKey, snapshot, skipped, counts: { sources: snapshot.sources.length, citations: snapshot.edges.filter(row => row.kind === 'citation').length, similarities: snapshot.edges.filter(row => row.kind === 'similarity').length, skipped: skipped.length }, ...patch };
}
export function createGraphEvidenceFixture(options = {}) {
  const calls = [], overrides = new Map();
  const current = { status: evidenceStatus(options.status), papers: options.papers || [evidencePaper(), evidencePaper('local-two', { title: '乡村步行空间与邻里交流' }), evidencePaper('unlinked', { title: '尚未关联的文献', bound: false, versionCount: 0 })], serial: 0 };
  const copy = value => structuredClone(value), window = new EventTarget();
  window.paperquay = { invoke: async (command, args) => {
    calls.push({ command, args: copy(args) }); if (overrides.has(command)) return overrides.get(command)(args);
    if (command === 'desktop_graph_evidence_status') return copy(current.status);
    if (command === 'desktop_graph_evidence_list') return { scopeKey: current.status.scopeKey, papers: copy(current.papers) };
    if (command === 'desktop_graph_evidence_preview') {
      const sources = args.localPaperIds.map(id => { const index = current.papers.findIndex(row => row.localPaperId === id), paper = current.papers[index]; return evidenceSource(index + 1, { title: paper.title, versions: paper.versionCount ? evidenceSource(index + 1).versions : [] }); });
      const ids = new Set(sources.map(row => row.paperId));
      const edges = [args.includeReferences && citationEdge(), args.includeSimilarity && similarityEdge()].filter(row => row && ids.has(row.sourcePaperId) && ids.has(row.targetPaperId));
      return evidencePreview({ token: 'fixture-evidence-token-' + ++current.serial, scopeKey: current.status.scopeKey, snapshot: evidenceSnapshot({ sources, edges, coverage: { referenceCache: args.includeReferences, vectorCache: args.includeSimilarity, versionPolicy: 'historical-cache-unverified-pdf' } }), ...options.preview });
    }
    if (command === 'desktop_graph_evidence_export') return { saved: true };
    throw Error('Unexpected fixture command: ' + command);
  } };
  return { window, calls, overrides, current };
}
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
