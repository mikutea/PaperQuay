import { canonicalJson, validateEntityData } from './validation.ts';
import { inspectModelInferenceJson, ModelInferenceValidationError } from './modelInference.ts';
import type { PaperData } from './types.ts';

export const GRAPH_EVIDENCE_LIMITS = Object.freeze({ sources: 16, edges: 512, versions: 16, bytes: 1024 * 1024,
  titleCharacters: 2048, descriptionCharacters: 2048, dimension: 32768 });
export interface GraphEvidenceVersion { versionId: string; sha256: string; sizeBytes: number }
export interface GraphEvidenceSource { paperId: string; title: string; metadataDigest: string; versions: GraphEvidenceVersion[] }
export interface GraphReferenceProvenance {
  kind: 'reference-cache'; referenceDigest: string; fetchedAt: number | null; pdfVersionVerified: false;
}
export interface GraphVectorProvenance {
  kind: 'vector-cache'; method: 'mean-chunk-cosine-v1'; dimension: number; modelDigest: string;
  sourceCacheDigest: string; targetCacheDigest: string; indexedAt: number; pdfVersionVerified: false;
}
type EdgeBase = { id: string; sourcePaperId: string; targetPaperId: string; description: string | null };
export type GraphEvidenceEdge = EdgeBase & (
  { kind: 'citation'; score: null; provenance: GraphReferenceProvenance }
  | { kind: 'similarity'; score: number; provenance: GraphVectorProvenance }
);
export interface GraphEvidenceSnapshot {
  format: 'paperquay-graph-evidence'; version: 1; serviceId: string; accountId: string;
  producer: { deviceId: string; libraryBindingId: string }; createdAt: string;
  sources: GraphEvidenceSource[]; edges: GraphEvidenceEdge[];
  coverage: { referenceCache: boolean; vectorCache: boolean; versionPolicy: 'historical-cache-unverified-pdf' };
  digest: string;
}
export class GraphEvidenceError extends Error {
  readonly code: string;
  constructor(code = 'GRAPH_EVIDENCE_INVALID') { super(code); this.name = 'GraphEvidenceError'; this.code = code; }
}
const L = GRAPH_EVIDENCE_LIMITS, encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, HASH = /^[0-9a-f]{64}$/;
function fail(code = 'GRAPH_EVIDENCE_INVALID'): never { throw new GraphEvidenceError(code); }
function inspect(value: unknown): void {
  try { inspectModelInferenceJson(value, L.bytes); }
  catch (error) { if (error instanceof ModelInferenceValidationError && error.code === 'MODEL_INFERENCE_LIMIT') fail('GRAPH_EVIDENCE_LIMIT'); fail(); }
  if (encoder.encode(canonicalJson(value)).length > L.bytes) fail('GRAPH_EVIDENCE_LIMIT');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(row => !row.enumerable || !('value' in row))) fail();
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1
    || Object.keys(value).length !== value.length || Object.values(Object.getOwnPropertyDescriptors(value)).some(row => !('value' in row))) fail();
  if (value.length > maximum) fail('GRAPH_EVIDENCE_LIMIT'); return value;
}
function text(value: unknown, maximum: number, required = true): string {
  if (typeof value !== 'string' || required && !value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail();
  if (value.length > maximum) fail('GRAPH_EVIDENCE_LIMIT'); try { encodeURIComponent(value); } catch { fail(); } return value;
}
function id(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value; }
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) fail(); return value; }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) fail(); if (Number(value) > maximum) fail('GRAPH_EVIDENCE_LIMIT'); return Number(value);
}
function stamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); return value;
}
function source(value: unknown): GraphEvidenceSource {
  const row = object(value, ['paperId', 'title', 'metadataDigest', 'versions']);
  const versions = array(row.versions, L.versions).map(value => {
    const version = object(value, ['versionId', 'sha256', 'sizeBytes']);
    return { versionId: id(version.versionId), sha256: hash(version.sha256), sizeBytes: integer(version.sizeBytes, 1) };
  });
  if (new Set(versions.map(row => row.versionId)).size !== versions.length) fail();
  return { paperId: id(row.paperId), title: text(row.title, L.titleCharacters), metadataDigest: hash(row.metadataDigest), versions };
}
function edge(value: unknown): GraphEvidenceEdge {
  const row = object(value, ['id', 'sourcePaperId', 'targetPaperId', 'kind', 'description', 'score', 'provenance']);
  const base = { id: hash(row.id), sourcePaperId: id(row.sourcePaperId), targetPaperId: id(row.targetPaperId),
    description: row.description === null ? null : text(row.description, L.descriptionCharacters, false) };
  if (base.sourcePaperId === base.targetPaperId) fail();
  if (row.kind === 'citation') {
    const p = object(row.provenance, ['kind', 'referenceDigest', 'fetchedAt', 'pdfVersionVerified']);
    if (row.score !== null || p.kind !== 'reference-cache' || p.pdfVersionVerified !== false) fail();
    return { ...base, kind: 'citation', score: null, provenance: { kind: 'reference-cache', referenceDigest: hash(p.referenceDigest),
      fetchedAt: p.fetchedAt === null ? null : integer(p.fetchedAt), pdfVersionVerified: false } };
  }
  if (row.kind !== 'similarity' || typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < -1 || row.score > 1) fail();
  const p = object(row.provenance, ['kind', 'method', 'dimension', 'modelDigest', 'sourceCacheDigest', 'targetCacheDigest', 'indexedAt', 'pdfVersionVerified']);
  if (p.kind !== 'vector-cache' || p.method !== 'mean-chunk-cosine-v1' || p.pdfVersionVerified !== false) fail();
  return { ...base, kind: 'similarity', score: row.score, provenance: { kind: 'vector-cache', method: 'mean-chunk-cosine-v1',
    dimension: integer(p.dimension, 1, L.dimension), modelDigest: hash(p.modelDigest), sourceCacheDigest: hash(p.sourceCacheDigest),
    targetCacheDigest: hash(p.targetCacheDigest), indexedAt: integer(p.indexedAt), pdfVersionVerified: false } };
}
/** Closed synchronous shape only. Verify both envelope and edge hashes with
 * verifyGraphEvidence before trusting an imported package; storage may use an
 * equivalent synchronous SHA-256 over these same canonical objects. */
export function readGraphEvidence(value: unknown): GraphEvidenceSnapshot {
  inspect(value); const row = object(value, ['format', 'version', 'serviceId', 'accountId', 'producer', 'createdAt', 'sources', 'edges', 'coverage', 'digest']);
  if (row.format !== 'paperquay-graph-evidence' || row.version !== 1) fail();
  const producer = object(row.producer, ['deviceId', 'libraryBindingId']);
  const sources = array(row.sources, L.sources).map(source), edges = array(row.edges, L.edges).map(edge), ids = new Set(sources.map(row => row.paperId));
  if (ids.size !== sources.length || new Set(edges.map(row => row.id)).size !== edges.length
    || edges.some(row => !ids.has(row.sourcePaperId) || !ids.has(row.targetPaperId))) fail();
  const versions = sources.flatMap(row => row.versions.map(value => value.versionId)); if (new Set(versions).size !== versions.length) fail();
  const coverage = object(row.coverage, ['referenceCache', 'vectorCache', 'versionPolicy']);
  if (typeof coverage.referenceCache !== 'boolean' || typeof coverage.vectorCache !== 'boolean' || coverage.versionPolicy !== 'historical-cache-unverified-pdf'
    || edges.some(row => row.kind === 'citation' ? !coverage.referenceCache : !coverage.vectorCache)) fail();
  return { format: 'paperquay-graph-evidence', version: 1, serviceId: hash(row.serviceId), accountId: id(row.accountId),
    producer: { deviceId: id(producer.deviceId), libraryBindingId: id(producer.libraryBindingId) }, createdAt: stamp(row.createdAt), sources, edges,
    coverage: { referenceCache: coverage.referenceCache, vectorCache: coverage.vectorCache, versionPolicy: 'historical-cache-unverified-pdf' }, digest: hash(row.digest) };
}
/** Canonical base metadata: preserve validated wire values, remove only the
 * independent organization field. No local object fields or content truncation. */
export function graphEvidenceMetadata(value: unknown): Omit<PaperData, 'organization'> {
  inspect(value); const checked = validateEntityData('paper', value); if (!checked.ok) fail();
  const { organization: _organization, ...base } = checked.value; return structuredClone(base);
}
async function digestBytes(bytes: Uint8Array): Promise<string> {
  const result = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, '0')).join('');
}
/** Generic canonical JSON SHA-256. Callers explicitly omit digest/id when
 * hashing the envelope/edge; this function never silently removes fields. */
export async function graphEvidenceDigest(value: unknown): Promise<string> { inspect(value); return digestBytes(encoder.encode(canonicalJson(value))); }
export async function verifyGraphEvidence(value: unknown): Promise<GraphEvidenceSnapshot> {
  const snapshot = readGraphEvidence(value), { digest, ...body } = snapshot;
  const checks = await Promise.all([graphEvidenceDigest(body), ...snapshot.edges.map(({ id: _id, ...edge }) => graphEvidenceDigest(edge))]);
  if (checks[0] !== digest || snapshot.edges.some((row, index) => row.id !== checks[index + 1])) fail('GRAPH_EVIDENCE_INTEGRITY');
  return snapshot;
}
export function normalizeGraphEvidenceServiceUrl(value: unknown): string {
  if (typeof value !== 'string') fail('GRAPH_EVIDENCE_SCOPE_CHANGED');
  try {
    const url = new URL(value), loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback) || url.username || url.password || url.search || url.hash) fail('GRAPH_EVIDENCE_SCOPE_CHANGED');
    return url.toString().replace(/\/+$/, '');
  } catch { return fail('GRAPH_EVIDENCE_SCOPE_CHANGED'); }
}
export async function graphEvidenceServiceId(apiBaseUrl: unknown): Promise<string> { return digestBytes(encoder.encode(normalizeGraphEvidenceServiceUrl(apiBaseUrl))); }
export async function assertGraphEvidenceScope(value: unknown, scope: { apiBaseUrl: string; accountId: string }): Promise<GraphEvidenceSnapshot> {
  const snapshot = await verifyGraphEvidence(value);
  if (snapshot.accountId !== id(scope.accountId) || snapshot.serviceId !== await graphEvidenceServiceId(scope.apiBaseUrl)) fail('GRAPH_EVIDENCE_SCOPE_CHANGED');
  return snapshot;
}
