import { validateEntityData } from '../../../../packages/sync-core/src/index.ts';
import { normalizeServiceUrl } from '../config.ts';
import { ClientError, describeError } from '../errors.ts';
import { checkCompletePdfBytes, sha256 } from './acquisition.ts';
import { PdfError } from './errors.ts';
import { PDF_LIMITS, type PdfVersion } from './types.ts';

export interface CloudPdfCapability { maxFileBytes: number; maxAccountBytes: number; maxCopies: number }
export interface CloudPdfCopy {
  attachmentVersionId: string;
  paperId: string;
  sha256: string;
  sizeBytes: number;
  fileName: string;
  createdAt: string;
  available: boolean;
}
export interface CloudPdfQuota { usedBytes: number; maxBytes: number; usedCopies: number; maxCopies: number }
export interface CloudPdfContext {
  apiBaseUrl: string;
  getAccessToken: () => Promise<string>;
  getCloudPdfCapability: () => CloudPdfCapability | null;
}
export interface CloudPdfOptions {
  signal: AbortSignal;
  /** Capture the account, device/login binding and operation epoch, not merely the selected UUID. */
  isCurrent: () => boolean;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  onProgress?: (loaded: number, total: number) => void;
}
export interface CloudPdfStatus { copy: CloudPdfCopy | null; quota: CloudPdfQuota }
export interface CloudPdfList { copies: CloudPdfCopy[]; quota: CloudPdfQuota }
export interface CloudPdfUpload { copy: CloudPdfCopy; replayed: boolean; quota: CloudPdfQuota }
export interface CloudPdfDeletion { attachmentVersionId: string; deleted: boolean; quota: CloudPdfQuota }

const messages = {
  STORAGE_DISABLED: '当前账号服务尚未开放 PDF 云副本。',
  CAPABILITY_CHANGED: '云副本服务配置已变化，请刷新后再试。',
  NOT_FOUND: '此版本尚无云副本，请刷新状态后重试。',
  VERSION_UNAVAILABLE: '此附件版本尚未同步或已删除，请先同步文库。',
  QUOTA_EXCEEDED: '云副本空间或数量已满，请先清理不需要的云副本。',
  RATE_LIMITED: '云副本服务正在处理其他传输，请稍后重新操作。',
  CHANGED: '云副本状态已变化，请刷新后再试。',
  CANCELLED: '已取消等待。上传或删除可能已在服务端完成，请刷新云副本列表确认。',
  TIMEOUT: '云副本操作超时。上传或删除可能已在服务端完成，请刷新云副本列表确认。',
  NETWORK: '暂时无法连接云副本服务。上传或删除可能已在服务端完成，请刷新云副本列表确认。',
  INVALID_RESPONSE: '云副本服务返回的数据无效，本次未采用返回内容。',
  FAILED: '云副本操作未完成，请刷新状态后重试。',
} as const;
export type CloudPdfErrorCode = keyof typeof messages;
export class CloudPdfError extends Error {
  readonly code: CloudPdfErrorCode;
  readonly retryAfterSeconds?: number;
  constructor(code: CloudPdfErrorCode, retryAfterSeconds?: number) {
    super(messages[code]);
    this.name = 'CloudPdfError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
export function describeCloudPdfError(error: unknown): string {
  if (error instanceof CloudPdfError || error instanceof PdfError) return error.message;
  if (error instanceof ClientError) return describeError(error);
  return messages.FAILED;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_ACCOUNT_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_COPIES = 512;
// 512 entries can each contain a 255-character multibyte filename plus identity metadata.
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ITEM_JSON_BYTES = 16 * 1024;
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
function invalid(): never { throw new CloudPdfError('INVALID_RESPONSE'); }
function versionId(value: string): string {
  if (!UUID.test(value)) throw new PdfError('VERSION_MISMATCH');
  return value;
}
function capability(value: CloudPdfCapability | null): CloudPdfCapability {
  if (!value) throw new CloudPdfError('STORAGE_DISABLED');
  if (!integer(value.maxFileBytes, 1, PDF_LIMITS.maxFileBytes)
    || !integer(value.maxAccountBytes, 1, MAX_ACCOUNT_BYTES)
    || !integer(value.maxCopies, 1, MAX_COPIES)) invalid();
  return { maxFileBytes: value.maxFileBytes, maxAccountBytes: value.maxAccountBytes, maxCopies: value.maxCopies };
}
function copy(value: unknown): CloudPdfCopy {
  if (!isObject(value) || typeof value.attachmentVersionId !== 'string' || !UUID.test(value.attachmentVersionId)
    || typeof value.paperId !== 'string' || !UUID.test(value.paperId)
    || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)
    || !integer(value.sizeBytes, 1, PDF_LIMITS.maxFileBytes)
    || typeof value.fileName !== 'string' || value.fileName.length < 1 || value.fileName.length > 255
    || value.fileName === '.' || value.fileName === '..' || /[\\/:\x00-\x1f\x7f]/.test(value.fileName)
    || typeof value.createdAt !== 'string' || value.createdAt.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.available !== 'boolean') invalid();
  return { attachmentVersionId: value.attachmentVersionId, paperId: value.paperId, sha256: value.sha256,
    sizeBytes: value.sizeBytes, fileName: value.fileName, createdAt: value.createdAt, available: value.available };
}
function quota(value: unknown): CloudPdfQuota {
  if (!isObject(value) || !integer(value.usedBytes, 0, MAX_ACCOUNT_BYTES)
    || !integer(value.maxBytes, 1, MAX_ACCOUNT_BYTES) || !integer(value.usedCopies, 0, MAX_COPIES)
    || !integer(value.maxCopies, 1, MAX_COPIES)
    || (value.usedCopies === 0 ? value.usedBytes !== 0 : value.usedBytes < value.usedCopies)) invalid();
  // A reduced server limit must not prevent listing/deleting existing copies.
  return { usedBytes: value.usedBytes, maxBytes: value.maxBytes, usedCopies: value.usedCopies, maxCopies: value.maxCopies };
}
function expectedVersion(value: PdfVersion, limits: CloudPdfCapability): PdfVersion {
  versionId(value.entityId);
  if (!validateEntityData('attachmentVersion', value.data).ok) throw new PdfError('VERSION_MISMATCH');
  if (value.data.sizeBytes > Math.min(limits.maxFileBytes, PDF_LIMITS.maxFileBytes)) throw new PdfError('TOO_LARGE');
  return { entityId: value.entityId, data: { ...value.data } };
}
function matchCopy(value: CloudPdfCopy, version: PdfVersion): void {
  if (value.attachmentVersionId !== version.entityId || value.paperId !== version.data.paperId
    || value.sha256 !== version.data.sha256 || value.sizeBytes !== version.data.sizeBytes) invalid();
}
function checkUsage(item: CloudPdfCopy | null, usage: CloudPdfQuota): void {
  if (item && (usage.usedCopies < 1 || usage.usedBytes < item.sizeBytes)) invalid();
}
function disposeBody(response: Response | undefined): void {
  if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
}

interface Operation {
  capability: CloudPdfCapability;
  signal: AbortSignal;
  check: () => void;
  wait: <T>(pending: Promise<T>, late?: (value: T) => void) => Promise<T>;
  request: (path: string, method: string, accept: string, body?: Uint8Array) => Promise<Response>;
  progress: (loaded: number, total: number) => void;
}
async function run<T>(context: CloudPdfContext, options: CloudPdfOptions,
  use: (operation: Operation) => Promise<T>, transfer = false): Promise<T> {
  const baseUrl = normalizeServiceUrl(context.apiBaseUrl);
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener('abort', onAbort, { once: true });
  const duration = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
    ? Math.min(options.timeoutMs!, PDF_LIMITS.operationTimeoutMs)
    : transfer ? PDF_LIMITS.operationTimeoutMs : PDF_LIMITS.requestTimeoutMs;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration);
  let initialCapability: CloudPdfCapability;
  const check = () => {
    if (controller.signal.aborted) throw new CloudPdfError(timedOut ? 'TIMEOUT' : 'CANCELLED');
    if (!options.isCurrent()) throw new ClientError('ACCOUNT_CHANGED');
    const latest = capability(context.getCloudPdfCapability());
    if (initialCapability && (latest.maxFileBytes !== initialCapability.maxFileBytes
      || latest.maxAccountBytes !== initialCapability.maxAccountBytes || latest.maxCopies !== initialCapability.maxCopies))
      throw new CloudPdfError('CAPABILITY_CHANGED');
  };
  const wait = <V>(pending: Promise<V>, late?: (value: V) => void): Promise<V> => new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true; controller.signal.removeEventListener('abort', abort);
      reject(new CloudPdfError(timedOut ? 'TIMEOUT' : 'CANCELLED'));
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
    pending.then((value) => {
      if (settled) { late?.(value); return; }
      settled = true; controller.signal.removeEventListener('abort', abort);
      try { check(); resolve(value); } catch (error) { late?.(value); reject(error); }
    }, (error: unknown) => {
      if (settled) return;
      settled = true; controller.signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
  try {
    check();
    initialCapability = capability(context.getCloudPdfCapability());
    const operation: Operation = {
      capability: initialCapability, signal: controller.signal, check, wait,
      progress: (loaded, total) => { check(); options.onProgress?.(loaded, total); check(); },
      request: async (path, method, accept, body) => {
        check();
        const token = await wait(context.getAccessToken());
        check();
        if (typeof token !== 'string' || token.length > 65_536 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token))
          throw new ClientError('AUTH_REQUIRED');
        const url = `${baseUrl}${path}`;
        const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
        const response = await wait(fetcher(url, { method, body: body as BodyInit | undefined,
          headers: { Authorization: `Bearer ${token}`, Accept: accept,
            ...(body ? { 'Content-Type': 'application/pdf' } : {}) },
          redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
          mode: 'cors', signal: controller.signal }), disposeBody);
        if (response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect'
          || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) {
          disposeBody(response); invalid();
        }
        return response;
      },
    };
    const result = await use(operation);
    check();
    return result;
  } catch (error) {
    check();
    if (error instanceof CloudPdfError || error instanceof PdfError || error instanceof ClientError) throw error;
    throw new CloudPdfError('NETWORK');
  } finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', onAbort);
  }
}

function contentLength(response: Response, maximum: number, required = false): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null && !required) return null;
  if (raw === null || !/^\d+$/.test(raw)) invalid();
  const length = Number(raw);
  if (!integer(length, 1, maximum)) invalid();
  return length;
}
async function readBytes(response: Response, maximum: number, operation: Operation,
  expectedLength?: number): Promise<Uint8Array> {
  if (!response.body) invalid();
  const declared = contentLength(response, maximum, expectedLength !== undefined);
  if (expectedLength !== undefined && declared !== expectedLength) throw new PdfError('VERSION_MISMATCH');
  const buffer = new Uint8Array(expectedLength ?? declared ?? maximum);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  operation.signal.addEventListener('abort', cancel, { once: true });
  let count = 0;
  try {
    while (true) {
      operation.check();
      const { done, value } = await operation.wait(reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array) || count + value.byteLength > buffer.byteLength) invalid();
      buffer.set(value, count); count += value.byteLength;
      if (expectedLength !== undefined) operation.progress(count, expectedLength);
    }
    operation.check();
    if ((declared !== null && count !== declared) || (expectedLength !== undefined && count !== expectedLength))
      throw expectedLength === undefined ? new CloudPdfError('INVALID_RESPONSE') : new PdfError('INCOMPLETE');
    return count === buffer.byteLength ? buffer : buffer.subarray(0, count);
  } finally {
    operation.signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
async function readJson(response: Response, operation: Operation, maximum = MAX_ITEM_JSON_BYTES): Promise<unknown> {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') invalid();
  const bytes = await readBytes(response, maximum, operation);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return invalid(); }
}
async function responseError(response: Response, operation: Operation): Promise<never> {
  let code: string | undefined;
  try {
    const body = await readJson(response, operation);
    if (isObject(body) && isObject(body.error) && typeof body.error.code === 'string') code = body.error.code;
  } catch {
    operation.check();
    // Authentication must still expire safely when a proxy returns an HTML error page.
  }
  operation.check();
  if (response.status === 401 || response.status === 403) {
    throw new ClientError(code === 'SESSION_REVOKED' || code === 'DEVICE_REVOKED' ? 'SESSION_REVOKED' : 'AUTH_REQUIRED');
  }
  if (response.status === 404)
    throw new CloudPdfError(code === 'CLOUD_PDF_NOT_FOUND' ? 'NOT_FOUND' : 'VERSION_UNAVAILABLE');
  if (response.status === 410) throw new CloudPdfError('VERSION_UNAVAILABLE');
  if (response.status === 413) throw new PdfError('TOO_LARGE');
  if (response.status === 415) throw new PdfError('NOT_PDF');
  if (response.status === 422 && code === 'PDF_INTEGRITY_MISMATCH') throw new PdfError('VERSION_MISMATCH');
  if (response.status === 409 && code === 'CLOUD_PDF_QUOTA_EXCEEDED') throw new CloudPdfError('QUOTA_EXCEEDED');
  if (response.status === 409 && code === 'CLOUD_PDF_CHANGED') throw new CloudPdfError('CHANGED');
  if (response.status === 429) {
    const retry = response.headers.get('retry-after');
    const seconds = retry !== null && /^\d+$/.test(retry) ? Number(retry) : undefined;
    throw new CloudPdfError('RATE_LIMITED', integer(seconds, 1, 86_400) ? seconds : undefined);
  }
  if (response.status === 503 && code === 'CLOUD_PDF_STORAGE_DISABLED') throw new CloudPdfError('STORAGE_DISABLED');
  throw new CloudPdfError('FAILED');
}
async function jsonRequest(operation: Operation, path: string, method = 'GET',
  bytes?: Uint8Array, maximum = MAX_ITEM_JSON_BYTES): Promise<unknown> {
  const response = await operation.request(path, method, 'application/json', bytes);
  try {
    if (response.status !== 200) return await responseError(response, operation);
    return await readJson(response, operation, maximum);
  } finally { disposeBody(response); }
}

/** Metadata is read only on caller request; this module never starts background transfers. */
export function listCloudPdfCopies(context: CloudPdfContext, options: CloudPdfOptions): Promise<CloudPdfList> {
  return run(context, options, async (operation) => {
    const body = await jsonRequest(operation, '/v1/cloud-pdfs', 'GET', undefined, MAX_JSON_BYTES);
    if (!isObject(body) || !Array.isArray(body.copies) || body.copies.length > MAX_COPIES) invalid();
    const copies = body.copies.map(copy); const usage = quota(body.quota);
    if (new Set(copies.map((item) => item.attachmentVersionId)).size !== copies.length
      || usage.usedCopies !== copies.length || usage.usedBytes !== copies.reduce((sum, item) => sum + item.sizeBytes, 0)) invalid();
    return { copies, quota: usage };
  });
}
export function inspectCloudPdfCopy(context: CloudPdfContext, version: PdfVersion,
  options: CloudPdfOptions): Promise<CloudPdfStatus> {
  return run(context, options, async (operation) => {
    const expected = expectedVersion(version, operation.capability);
    const body = await jsonRequest(operation, `/v1/cloud-pdfs/${expected.entityId}`);
    if (!isObject(body)) invalid();
    const item = body.copy === null ? null : copy(body.copy); const usage = quota(body.quota);
    if (item) matchCopy(item, expected);
    checkUsage(item, usage);
    return { copy: item, quota: usage };
  });
}
export function uploadCloudPdfCopy(context: CloudPdfContext, version: PdfVersion, bytes: Uint8Array,
  options: CloudPdfOptions): Promise<CloudPdfUpload> {
  return run(context, options, async (operation) => {
    const expected = expectedVersion(version, operation.capability);
    if (bytes instanceof Uint8Array && bytes.byteLength > Math.min(operation.capability.maxFileBytes, PDF_LIMITS.maxFileBytes))
      throw new PdfError('TOO_LARGE');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected.data.sizeBytes) throw new PdfError('VERSION_MISMATCH');
    // Own the verified bytes so caller edits during token refresh cannot change the upload.
    const payload = new Uint8Array(bytes);
    checkCompletePdfBytes(payload);
    if (await operation.wait(sha256(payload)) !== expected.data.sha256) throw new PdfError('VERSION_MISMATCH');
    operation.progress(0, payload.byteLength);
    const body = await jsonRequest(operation, `/v1/cloud-pdfs/${expected.entityId}`, 'PUT', payload);
    if (!isObject(body) || typeof body.replayed !== 'boolean') invalid();
    const item = copy(body.copy); const usage = quota(body.quota);
    matchCopy(item, expected); checkUsage(item, usage);
    if (!item.available) invalid();
    // Fetch does not expose upload progress: completion is reported only after the server reply.
    operation.progress(payload.byteLength, payload.byteLength);
    return { copy: item, replayed: body.replayed, quota: usage };
  }, true);
}
export function downloadCloudPdfCopy(context: CloudPdfContext, version: PdfVersion,
  options: CloudPdfOptions): Promise<Uint8Array> {
  return run(context, options, async (operation) => {
    const expected = expectedVersion(version, operation.capability);
    const response = await operation.request(`/v1/cloud-pdfs/${expected.entityId}/content`, 'GET', 'application/pdf');
    try {
      if (response.status !== 200) return await responseError(response, operation);
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf'
        || response.headers.has('content-range')
        || (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity')) invalid();
      const bytes = await readBytes(response, expected.data.sizeBytes, operation, expected.data.sizeBytes);
      checkCompletePdfBytes(bytes);
      if (await operation.wait(sha256(bytes)) !== expected.data.sha256) throw new PdfError('VERSION_MISMATCH');
      return bytes;
    } finally { disposeBody(response); }
  }, true);
}
/** Deletion also accepts a listed tombstone; it never removes local cache or sync metadata. */
export function deleteCloudPdfCopy(context: CloudPdfContext, attachmentVersionId: string,
  options: CloudPdfOptions): Promise<CloudPdfDeletion> {
  return run(context, options, async (operation) => {
    const id = versionId(attachmentVersionId);
    const body = await jsonRequest(operation, `/v1/cloud-pdfs/${id}`, 'DELETE');
    if (!isObject(body) || body.attachmentVersionId !== id || typeof body.deleted !== 'boolean') invalid();
    return { attachmentVersionId: id, deleted: body.deleted, quota: quota(body.quota) };
  });
}
