/** Public remote-work DTOs. Credentials, local paths and transport URLs never belong here. */
export const REMOTE_TASK_LIMITS = Object.freeze({
  protocolVersion: 1, artifactBytes: 16 * 1024 * 1024, accountArtifactBytes: 64 * 1024 * 1024,
  active: 1, queued: 16, retained: 200, receipts: 2000, profiles: 8,
  providerPresenceSeconds: 45, leaseSeconds: 60, attempts: 100,
  indexChunks: 10_000, indexDimension: 4096, indexVectorElements: 2_000_000,
  indexTextCharacters: 2_000_000, indexChunkCharacters: 8192,
});
export type RemoteTaskKind = 'parse' | 'index';
export type RemoteTaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'interrupted';
export interface RemoteProfileRef { id: string; revision: number; digest: string }
export interface RemoteTaskProfile extends RemoteProfileRef { kind: RemoteTaskKind; model: string }
export interface RemoteTaskProvider { deviceId: string; profiles: RemoteTaskProfile[]; expiresAt: string }
export interface RemoteTaskRequest {
  requestId: string; kind: RemoteTaskKind; versionId: string; providerDeviceId: string;
  profileRef: RemoteProfileRef; indexSourceDigest?: string;
}
/** Request-ID status is read without creating or resuming a paid job. */
export interface RemoteTaskRequestStatus {
  requestId: string;
  status: 'absent' | 'known' | 'cancelled' | 'removed';
  task: RemoteTask | null;
}
export interface RemoteTaskResume { providerDeviceId?: string; profileRef?: RemoteProfileRef }
export interface RemoteTaskTarget {
  paperId: string; attachmentVersionId: string; paperRevision: number; versionRevision: number;
  sha256: string; sizeBytes: number; pageCount: number | null; fileName: string;
}
export interface RemoteTaskLease { attempt: number; fence: string }
export type RemoteTaskFailureCode = 'EXECUTION_FAILED' | 'SOURCE_UNAVAILABLE' | 'PROFILE_CHANGED'
  | 'EXTERNAL_OUTCOME_UNKNOWN' | 'LEASE_EXPIRED' | 'SESSION_REVOKED' | 'VERSION_CHANGED';
export interface RemoteTaskFailure extends RemoteTaskLease {
  code: 'EXECUTION_FAILED' | 'SOURCE_UNAVAILABLE' | 'PROFILE_CHANGED' | 'EXTERNAL_OUTCOME_UNKNOWN';
}
export interface RemoteTaskArtifact { digest: string; sizeBytes: number; mediaType: 'application/json' }
export interface RemoteTask {
  id: string; kind: RemoteTaskKind; state: RemoteTaskState; target: RemoteTaskTarget;
  providerDeviceId: string; profile: RemoteTaskProfile; indexSourceDigest: string | null;
  /** Last lease holder which confirmed a durable local execution journal. */
  recoveryProviderDeviceId: string | null;
  attempt: number; createdAt: string; updatedAt: string; leaseExpiresAt: string | null;
  failure: RemoteTaskFailureCode | null; artifact: RemoteTaskArtifact | null;
}
export interface RemoteTaskQuota {
  active: number; queued: number; retained: number; receipts: number; artifactBytes: number;
  maxActive: number; maxQueued: number; maxRetained: number; maxReceipts: number; maxArtifactBytes: number;
}
export interface RemoteTaskCapability {
  protocolVersion: 1; transport: 'persistent-jobs-v1'; maxArtifactBytes: number; maxAccountArtifactBytes: number;
  maxActive: number; maxQueued: number; maxRetained: number; maxReceipts: number; maxProfiles: number;
  leaseSeconds: number; providerPresenceSeconds: number;
}
export interface RemoteTaskClaim { task: RemoteTask; lease: RemoteTaskLease }
export interface RemoteIndexChunk { id: string; pageIndex: number; text: string; vector: number[] }
/** The contentHash is SHA-256 of UTF-8 JSON.stringify(chunks), after validation. */
export interface RemoteIndexArtifact {
  format: 'paperquay-vector-index'; version: 1; paperId: string; attachmentVersionId: string;
  pdf: { sha256: string; sizeBytes: number; pageCount: number };
  parseDigest: string; model: string; chunker: { id: string; revision: number; digest: string };
  dimension: number; chunkCount: number; contentHash: string; chunks: RemoteIndexChunk[];
}
export class RemoteTaskValidationError extends Error {
  readonly code: 'REMOTE_TASK_INVALID' | 'REMOTE_TASK_ARTIFACT_INVALID' | 'REMOTE_TASK_ARTIFACT_LIMIT';
  constructor(code: RemoteTaskValidationError['code'] = 'REMOTE_TASK_INVALID') {
    super(code); this.name = 'RemoteTaskValidationError'; this.code = code;
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const encoder = new TextEncoder();
function invalid(): never { throw new RemoteTaskValidationError(); }
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || ![...keys, ...optional].includes(key))
    || keys.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((item) => !('value' in item) || !item.enumerable)) invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max
    || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) invalid();
  return value;
}
function uuid(value: unknown): string { const result = string(value); if (!UUID.test(result)) invalid(); return result; }
function hash(value: unknown): string { const result = string(value); if (!HASH.test(result)) invalid(); return result; }
function id(value: unknown): string { const result = string(value); if (!ID.test(result)) invalid(); return result; }
function int(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
function kind(value: unknown): RemoteTaskKind { if (value !== 'parse' && value !== 'index') invalid(); return value; }
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Object.keys(value).length !== value.length || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  // Do not invoke accessors while validating direct callers.
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !('value' in entry))) invalid();
  return value;
}
export function validateRemoteProfileRef(value: unknown): RemoteProfileRef {
  const input = object(value, ['id', 'revision', 'digest']);
  return { id: id(input.id), revision: int(input.revision, 1, Number.MAX_SAFE_INTEGER), digest: hash(input.digest) };
}
export function validateRemoteTaskProfiles(value: unknown): RemoteTaskProfile[] {
  const seen = new Set<string>();
  return array(value, REMOTE_TASK_LIMITS.profiles).map((value) => {
    const input = object(value, ['id', 'revision', 'digest', 'kind', 'model']);
    const profile = { id: id(input.id), revision: int(input.revision, 1, Number.MAX_SAFE_INTEGER),
      digest: hash(input.digest), kind: kind(input.kind), model: string(input.model) };
    if (seen.has(profile.id)) invalid(); seen.add(profile.id); return profile;
  });
}
export function validateRemoteTaskRequest(value: unknown): RemoteTaskRequest {
  const input = object(value, ['requestId', 'kind', 'versionId', 'providerDeviceId', 'profileRef'], ['indexSourceDigest']);
  const result: RemoteTaskRequest = { requestId: uuid(input.requestId), kind: kind(input.kind),
    versionId: uuid(input.versionId), providerDeviceId: uuid(input.providerDeviceId), profileRef: validateRemoteProfileRef(input.profileRef) };
  if (result.kind === 'index') result.indexSourceDigest = hash(input.indexSourceDigest);
  else if (Object.hasOwn(input, 'indexSourceDigest')) invalid();
  return result;
}
export function validateRemoteTaskLease(value: unknown): RemoteTaskLease {
  const input = object(value, ['attempt', 'fence']);
  return { attempt: int(input.attempt, 1, REMOTE_TASK_LIMITS.attempts), fence: uuid(input.fence) };
}
export function validateRemoteTaskResume(value: unknown): RemoteTaskResume {
  const input=object(value,[],['providerDeviceId','profileRef']);
  if(!Object.keys(input).length)return{};
  if(!Object.hasOwn(input,'providerDeviceId')||!Object.hasOwn(input,'profileRef'))invalid();
  return{providerDeviceId:uuid(input.providerDeviceId),profileRef:validateRemoteProfileRef(input.profileRef)};
}
export function validateRemoteTaskFailure(value: unknown): RemoteTaskFailure {
  const input = object(value, ['attempt', 'fence', 'code']);
  if (!['EXECUTION_FAILED', 'SOURCE_UNAVAILABLE', 'PROFILE_CHANGED', 'EXTERNAL_OUTCOME_UNKNOWN'].includes(input.code as string)) invalid();
  return { attempt: int(input.attempt, 1, REMOTE_TASK_LIMITS.attempts), fence: uuid(input.fence), code: input.code as RemoteTaskFailure['code'] };
}
export function validateRemoteTaskId(value: unknown): string { return uuid(value); }
function timestamp(value: unknown): string {
  const result = string(value, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || !Number.isFinite(Date.parse(result))
    || new Date(result).toISOString() !== result) invalid();
  return result;
}
export function validateRemoteTaskCapability(value: unknown): RemoteTaskCapability {
  const input = object(value, ['protocolVersion','transport','maxArtifactBytes','maxAccountArtifactBytes','maxActive','maxQueued',
    'maxRetained','maxReceipts','maxProfiles','leaseSeconds','providerPresenceSeconds']);
  if (input.protocolVersion !== 1 || input.transport !== 'persistent-jobs-v1') invalid();
  return { protocolVersion: 1, transport: 'persistent-jobs-v1',
    maxArtifactBytes: int(input.maxArtifactBytes, 1, REMOTE_TASK_LIMITS.artifactBytes),
    maxAccountArtifactBytes: int(input.maxAccountArtifactBytes, 1, REMOTE_TASK_LIMITS.accountArtifactBytes),
    maxActive: int(input.maxActive, 1, REMOTE_TASK_LIMITS.active), maxQueued: int(input.maxQueued, 1, REMOTE_TASK_LIMITS.queued),
    maxRetained: int(input.maxRetained, 1, REMOTE_TASK_LIMITS.retained), maxReceipts: int(input.maxReceipts, 1, REMOTE_TASK_LIMITS.receipts),
    maxProfiles: int(input.maxProfiles, 1, REMOTE_TASK_LIMITS.profiles), leaseSeconds: int(input.leaseSeconds, 1, REMOTE_TASK_LIMITS.leaseSeconds),
    providerPresenceSeconds: int(input.providerPresenceSeconds, 1, REMOTE_TASK_LIMITS.providerPresenceSeconds) };
}
export function validateRemoteTaskProvider(value: unknown): RemoteTaskProvider {
  const input = object(value, ['deviceId','profiles','expiresAt']);
  return { deviceId: uuid(input.deviceId), profiles: validateRemoteTaskProfiles(input.profiles), expiresAt: timestamp(input.expiresAt) };
}
export function validateRemoteTaskQuota(value: unknown): RemoteTaskQuota {
  const input = object(value, ['active','queued','retained','receipts','artifactBytes','maxActive','maxQueued','maxRetained','maxReceipts','maxArtifactBytes']);
  const maxActive = int(input.maxActive, 1, REMOTE_TASK_LIMITS.active), maxQueued = int(input.maxQueued, 1, REMOTE_TASK_LIMITS.queued),
    maxRetained = int(input.maxRetained, 1, REMOTE_TASK_LIMITS.retained), maxReceipts = int(input.maxReceipts, 1, REMOTE_TASK_LIMITS.receipts),
    maxArtifactBytes = int(input.maxArtifactBytes, 1, REMOTE_TASK_LIMITS.accountArtifactBytes);
  const result = { active: int(input.active, 0, maxActive), queued: int(input.queued, 0, maxQueued), retained: int(input.retained, 0, maxRetained),
    receipts: int(input.receipts, 0, maxReceipts), artifactBytes: int(input.artifactBytes, 0, maxArtifactBytes),
    maxActive,maxQueued,maxRetained,maxReceipts,maxArtifactBytes };
  if (result.active + result.queued > result.retained || result.retained > result.receipts) invalid();
  return result;
}
export function validateRemoteTask(value: unknown): RemoteTask {
  const input = object(value, ['id','kind','state','target','providerDeviceId','profile','indexSourceDigest','recoveryProviderDeviceId','attempt','createdAt','updatedAt','leaseExpiresAt','failure','artifact']);
  const target = validateRemoteTaskTarget(input.target);
  const selectedKind = kind(input.kind), profile = validateRemoteTaskProfiles([input.profile])[0];
  if (profile.kind !== selectedKind || !['queued','running','succeeded','failed','cancel_requested','cancelled','interrupted'].includes(input.state as string)) invalid();
  const failureCodes = ['EXECUTION_FAILED','SOURCE_UNAVAILABLE','PROFILE_CHANGED','EXTERNAL_OUTCOME_UNKNOWN','LEASE_EXPIRED','SESSION_REVOKED','VERSION_CHANGED'];
  if (input.failure !== null && !failureCodes.includes(input.failure as string)) invalid();
  const artifact = input.artifact === null ? null : object(input.artifact, ['digest','sizeBytes','mediaType']);
  if (artifact && artifact.mediaType !== 'application/json') invalid();
  const result: RemoteTask = { id: uuid(input.id), kind: selectedKind, state: input.state as RemoteTaskState,
    target,
    providerDeviceId: uuid(input.providerDeviceId), profile, indexSourceDigest: selectedKind === 'index' ? hash(input.indexSourceDigest) : null,
    recoveryProviderDeviceId: input.recoveryProviderDeviceId===null?null:uuid(input.recoveryProviderDeviceId),
    attempt: int(input.attempt,0,REMOTE_TASK_LIMITS.attempts), createdAt: timestamp(input.createdAt), updatedAt: timestamp(input.updatedAt),
    leaseExpiresAt: input.leaseExpiresAt === null ? null : timestamp(input.leaseExpiresAt), failure: input.failure as RemoteTaskFailureCode|null,
    artifact: artifact ? { digest: hash(artifact.digest), sizeBytes: int(artifact.sizeBytes,1,REMOTE_TASK_LIMITS.artifactBytes), mediaType:'application/json' } : null };
  if (selectedKind === 'parse' && input.indexSourceDigest !== null || (result.state === 'succeeded') !== Boolean(result.artifact)
    || ['running','cancel_requested'].includes(result.state) !== Boolean(result.leaseExpiresAt)
    || result.createdAt > result.updatedAt || ['running','succeeded','failed','cancel_requested'].includes(result.state) && result.attempt < 1
    || ['queued','succeeded'].includes(result.state) && result.failure !== null) invalid();
  return result;
}
export function validateRemoteIndexArtifact(value: unknown): RemoteIndexArtifact {
  try {
    const input = object(value, ['format', 'version', 'paperId', 'attachmentVersionId', 'pdf', 'parseDigest', 'model', 'chunker',
      'dimension', 'chunkCount', 'contentHash', 'chunks']);
    if (input.format !== 'paperquay-vector-index' || input.version !== 1) invalid();
    const pdf = object(input.pdf, ['sha256', 'sizeBytes', 'pageCount']);
    const chunker = object(input.chunker, ['id', 'revision', 'digest']);
    const dimension = int(input.dimension, 1, REMOTE_TASK_LIMITS.indexDimension);
    const pageCount = int(pdf.pageCount, 1, 2000);
    const chunkCount = int(input.chunkCount, 1, REMOTE_TASK_LIMITS.indexChunks);
    if (dimension * chunkCount > REMOTE_TASK_LIMITS.indexVectorElements) invalid();
    let characters = 0; const seen = new Set<string>();
    const chunks = array(input.chunks, REMOTE_TASK_LIMITS.indexChunks).map((value) => {
      const chunk = object(value, ['id', 'pageIndex', 'text', 'vector']);
      const chunkId = id(chunk.id); if (seen.has(chunkId)) invalid(); seen.add(chunkId);
      if (typeof chunk.text !== 'string' || !chunk.text.trim() || chunk.text.length > REMOTE_TASK_LIMITS.indexChunkCharacters
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(chunk.text)) invalid();
      const text = chunk.text;
      characters += text.length; if (characters > REMOTE_TASK_LIMITS.indexTextCharacters) invalid();
      const vector = array(chunk.vector, dimension).map((value) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e6) invalid();
        return Object.is(value, -0) ? 0 : value;
      });
      if (vector.length !== dimension) invalid();
      return { id: chunkId, pageIndex: int(chunk.pageIndex, 0, pageCount - 1), text, vector };
    });
    if (chunks.length !== chunkCount) invalid();
    const result: RemoteIndexArtifact = { format: 'paperquay-vector-index', version: 1, paperId: uuid(input.paperId),
      attachmentVersionId: uuid(input.attachmentVersionId), pdf: { sha256: hash(pdf.sha256), sizeBytes: int(pdf.sizeBytes, 1, 64 * 1024 * 1024), pageCount },
      parseDigest: hash(input.parseDigest), model: string(input.model),
      chunker: { id: id(chunker.id), revision: int(chunker.revision, 1, Number.MAX_SAFE_INTEGER), digest: hash(chunker.digest) },
      dimension, chunkCount, contentHash: hash(input.contentHash), chunks };
    if (encoder.encode(JSON.stringify(result)).byteLength > REMOTE_TASK_LIMITS.artifactBytes) throw new RemoteTaskValidationError('REMOTE_TASK_ARTIFACT_LIMIT');
    return result;
  } catch (error) {
    if (error instanceof RemoteTaskValidationError && error.code === 'REMOTE_TASK_ARTIFACT_LIMIT') throw error;
    throw new RemoteTaskValidationError('REMOTE_TASK_ARTIFACT_INVALID');
  }
}
export async function remoteTaskSha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Preflight depth and duplicate keys before JSON.parse; raw bytes are always bounded. */
export function decodeRemoteTaskJson(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > REMOTE_TASK_LIMITS.artifactBytes) {
    throw new RemoteTaskValidationError('REMOTE_TASK_ARTIFACT_LIMIT');
  }
  try {
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (source.charCodeAt(0) === 0xfeff) invalid();
    const stack: Array<Set<string> | null> = []; let nodes = 0;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{' || ch === '[') {
        if (++nodes > 2_200_000) invalid();
        stack.push(ch === '{' ? new Set() : null); if (stack.length > 16) invalid();
      } else if (ch === ',') { if (++nodes > 2_200_000) invalid(); }
      else if (ch === '}' || ch === ']') stack.pop();
      else if (ch === '"') {
        const start = i++;
        while (i < source.length && source[i] !== '"') { if (source[i] === '\\') i++; i++; }
        if (i >= source.length) invalid();
        let next = i + 1; while (/\s/.test(source[next] ?? '') && next < source.length) next++;
        if (source[next] === ':') {
          const keys = stack.at(-1); if (!keys) invalid();
          const key: string = JSON.parse(source.slice(start, i + 1));
          if (keys.has(key)) invalid(); keys.add(key);
        }
      }
    }
    return JSON.parse(source);
  } catch { throw new RemoteTaskValidationError('REMOTE_TASK_ARTIFACT_INVALID'); }
}
export async function decodeRemoteIndexArtifact(bytes: Uint8Array): Promise<{ document: RemoteIndexArtifact; digest: string; bytes: Uint8Array }> {
  const document = validateRemoteIndexArtifact(decodeRemoteTaskJson(bytes));
  if (await remoteTaskSha256(encoder.encode(JSON.stringify(document.chunks))) !== document.contentHash) {
    throw new RemoteTaskValidationError('REMOTE_TASK_ARTIFACT_INVALID');
  }
  const canonical = encoder.encode(JSON.stringify(document));
  return { document, digest: await remoteTaskSha256(canonical), bytes: canonical };
}

export function validateRemoteTaskTarget(value: unknown): RemoteTaskTarget {
  const target = object(value, ['paperId','attachmentVersionId','paperRevision','versionRevision','sha256','sizeBytes','pageCount','fileName']);
  const fileName = string(target.fileName, 255); if (/[\\/:]/.test(fileName)) invalid();
  return { paperId: uuid(target.paperId), attachmentVersionId: uuid(target.attachmentVersionId),
    paperRevision: int(target.paperRevision,1,Number.MAX_SAFE_INTEGER), versionRevision: int(target.versionRevision,1,Number.MAX_SAFE_INTEGER),
    sha256: hash(target.sha256), sizeBytes: int(target.sizeBytes,1,64*1024*1024), pageCount: target.pageCount===null?null:int(target.pageCount,1,2000), fileName };
}
export function validateRemoteTaskRequestStatus(value: unknown): RemoteTaskRequestStatus {
  const input = object(value, ['requestId','status','task']);
  if (!['absent','known','cancelled','removed'].includes(input.status as string)) invalid();
  const task = input.task===null?null:validateRemoteTask(input.task);
  if ((input.status==='known') !== (task!==null)) invalid();
  return { requestId: uuid(input.requestId), status: input.status as RemoteTaskRequestStatus['status'], task };
}
