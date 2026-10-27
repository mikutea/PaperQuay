import { validateEntityData } from '../../../../packages/sync-core/src/index.ts';
import { normalizeServiceUrl } from '../config.ts';
import { ClientError } from '../errors.ts';
import { checkCompletePdfBytes, sha256 } from './acquisition.ts';
import { PdfError } from './errors.ts';
import { PDF_LIMITS, type PdfVersion } from './types.ts';

export interface DesktopPdfCapability {
  transport: 'http-relay-v1';
  maxFileBytes: number;
  requestTtlMs: number;
  pollTimeoutMs: number;
}
export interface DesktopPdfContext {
  apiBaseUrl: string;
  getAccessToken: () => Promise<string>;
  getDesktopPdfCapability: () => DesktopPdfCapability | null;
}
export interface DesktopPdfOptions {
  signal: AbortSignal;
  /** Bind account, device/login, task and the exact live synced version. */
  isCurrent: () => boolean;
  fetch?: typeof globalThis.fetch;
  /** Unwrapped transport for a bounded cleanup of only the request already created by this operation. */
  cleanupFetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  onProgress?: (loaded: number, total: number) => void;
}

const messages = {
  TRANSFER_DISABLED: '账号服务尚未开放在线电脑取文件。',
  CAPABILITY_CHANGED: '电脑文件服务配置已变化，本次未采用返回内容。',
  UNAVAILABLE: '目前没有在线电脑可提供此版本。请在电脑端开启文件提供，并保持 PaperQuay 在线。',
  VERSION_UNAVAILABLE: '此附件版本或文件请求已不可用，请先同步文库。',
  CHANGED: '文献或附件版本已变化，本次文件获取已停止。',
  REQUEST_IN_USE: '此电脑文件请求已被使用，请稍后手动重试。',
  REQUEST_EXPIRED: '电脑文件请求已过期，本次未取得文件。',
  RATE_LIMITED: '电脑文件服务暂时繁忙，请稍后手动重试。',
  CANCELLED: '已取消从在线电脑读取文件。',
  TIMEOUT: '从在线电脑读取文件超时。',
  NETWORK: '暂时无法连接电脑文件服务。',
  INVALID_RESPONSE: '电脑文件服务返回的内容无效，本次未采用返回内容。',
  FAILED: '从在线电脑读取文件失败。',
} as const;
export type DesktopPdfErrorCode = keyof typeof messages;
export class DesktopPdfError extends Error {
  readonly code: DesktopPdfErrorCode;
  constructor(code: DesktopPdfErrorCode) {
    super(messages[code]); this.name = 'DesktopPdfError'; this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_OPERATION_MS = 15_000;
const CLEANUP_MS = 1_000;
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

/** Unknown optional capability fields are ignored; known bounds cannot extend this client's limits. */
export function isDesktopPdfCapability(value: unknown): value is DesktopPdfCapability {
  return isObject(value) && value.transport === 'http-relay-v1'
    && integer(value.maxFileBytes, 1, PDF_LIMITS.maxFileBytes)
    && integer(value.requestTtlMs, 2_000, 30_000)
    && integer(value.pollTimeoutMs, 1, 20_000) && value.pollTimeoutMs <= value.requestTtlMs;
}
function capability(value: DesktopPdfCapability | null): DesktopPdfCapability {
  if (!value) throw new DesktopPdfError('TRANSFER_DISABLED');
  if (!isDesktopPdfCapability(value)) throw new DesktopPdfError('INVALID_RESPONSE');
  return { transport: value.transport, maxFileBytes: value.maxFileBytes,
    requestTtlMs: value.requestTtlMs, pollTimeoutMs: value.pollTimeoutMs };
}
function disposeBody(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
}

/** Never refresh credentials or wait for cleanup. The server also expires disconnected requests. */
function cancelRequest(baseUrl: string, requestId: string, token: string, fetcher: typeof fetch): void {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CLEANUP_MS);
  try {
    void fetcher(`${baseUrl}/v1/desktop-pdfs/requests/${requestId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      mode: 'cors', signal: abort.signal,
    }).then(disposeBody, () => undefined).finally(() => clearTimeout(timer));
  } catch { clearTimeout(timer); }
}

/** Create one short-lived request and consume it once. No URL discovery, polling or automatic reissue. */
export async function downloadDesktopPdfCopy(context: DesktopPdfContext, version: PdfVersion,
  options: DesktopPdfOptions): Promise<Uint8Array> {
  const baseUrl = normalizeServiceUrl(context.apiBaseUrl);
  const expected = { entityId: version.entityId, data: { ...version.data } };
  const getToken = context.getAccessToken.bind(context);
  const getCapability = context.getDesktopPdfCapability.bind(context);
  const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const cleanupFetch = options.cleanupFetch ?? fetcher;
  const controller = new AbortController();
  let active = true; let timedOut = false; let completed = false;
  let initialCapability: DesktopPdfCapability | undefined;
  let requestId: string | undefined; let token: string | undefined;
  let observedStatus: number | undefined;
  const onAbort = () => controller.abort();
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener('abort', onAbort, { once: true });
  const duration = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
    ? Math.max(1, Math.min(options.timeoutMs!, MAX_OPERATION_MS)) : MAX_OPERATION_MS;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration);
  const check = () => {
    if (!options.isCurrent()) throw new ClientError('ACCOUNT_CHANGED');
    if (!active || controller.signal.aborted) throw new DesktopPdfError(timedOut ? 'TIMEOUT' : 'CANCELLED');
    const latest = capability(getCapability());
    if (initialCapability && (latest.transport !== initialCapability.transport
      || latest.maxFileBytes !== initialCapability.maxFileBytes || latest.requestTtlMs !== initialCapability.requestTtlMs
      || latest.pollTimeoutMs !== initialCapability.pollTimeoutMs)) throw new DesktopPdfError('CAPABILITY_CHANGED');
  };
  const wait = <T>(work: () => Promise<T>, late?: (value: T) => void): Promise<T> => new Promise((resolve, reject) => {
    let settled = false;
    const dispose = (value: T) => { try { late?.(value); } catch { /* Best effort resource release. */ } };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true; controller.signal.removeEventListener('abort', abort); reject(error);
    };
    const abort = () => {
      try { check(); rejectOnce(new DesktopPdfError('CANCELLED')); }
      catch (error) { rejectOnce(error); }
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    let pending: Promise<T>;
    try { check(); pending = work(); } catch (error) { rejectOnce(error); return; }
    pending.then((value) => {
      if (settled) { dispose(value); return; }
      try { check(); } catch (error) { dispose(value); rejectOnce(error); return; }
      settled = true; controller.signal.removeEventListener('abort', abort); resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      try { check(); } catch (currentError) { error = currentError; }
      rejectOnce(error);
    });
  });
  const request = async (path: string, method: string, accept: string, body?: string): Promise<Response> => {
    check();
    const url = `${baseUrl}${path}`;
    const response = await wait(() => fetcher(url, {
      method, body, headers: { Authorization: `Bearer ${token!}`, Accept: accept,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      mode: 'cors', signal: controller.signal,
    }), disposeBody);
    observedStatus = response.status;
    if (response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect'
      || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) {
      disposeBody(response); throw new DesktopPdfError('INVALID_RESPONSE');
    }
    return response;
  };
  const readBytes = async (response: Response, maximum: number, expectedLength?: number): Promise<Uint8Array> => {
    const raw = response.headers.get('content-length');
    if (!response.body || (raw === null && expectedLength !== undefined)
      || (raw !== null && (!/^\d+$/.test(raw) || !integer(Number(raw), 1, maximum))))
      throw new DesktopPdfError('INVALID_RESPONSE');
    const declared = raw === null ? null : Number(raw);
    if (expectedLength !== undefined && declared !== expectedLength) throw new PdfError('VERSION_MISMATCH');
    const bytes = new Uint8Array(expectedLength ?? declared ?? maximum);
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    let count = 0;
    try {
      while (true) {
        check(); const chunk = await wait(() => reader.read());
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array) || count + chunk.value.byteLength > bytes.length)
          throw new DesktopPdfError('INVALID_RESPONSE');
        bytes.set(chunk.value, count); count += chunk.value.byteLength;
        if (expectedLength !== undefined) { check(); options.onProgress?.(count, expectedLength); check(); }
      }
      check();
      if ((declared !== null && count !== declared) || (expectedLength !== undefined && count !== expectedLength))
        throw expectedLength === undefined ? new DesktopPdfError('INVALID_RESPONSE') : new PdfError('INCOMPLETE');
      return count === bytes.length ? bytes : bytes.subarray(0, count);
    } finally {
      controller.signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock();
    }
  };
  const readJson = async (response: Response): Promise<unknown> => {
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
      throw new DesktopPdfError('INVALID_RESPONSE');
    const bytes = await readBytes(response, MAX_JSON_BYTES);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new DesktopPdfError('INVALID_RESPONSE'); }
  };
  const responseError = async (response: Response): Promise<never> => {
    let code: string | undefined;
    try {
      const body = await readJson(response);
      if (isObject(body) && isObject(body.error) && typeof body.error.code === 'string') code = body.error.code;
    } catch { /* Status below remains authoritative for malformed authentication or target errors. */ }
    if (response.status === 401 || response.status === 403)
      throw new ClientError(code === 'SESSION_REVOKED' || code === 'DEVICE_REVOKED' ? 'SESSION_REVOKED' : 'AUTH_REQUIRED');
    if (response.status === 404)
      throw new DesktopPdfError(code === 'DESKTOP_PDF_UNAVAILABLE' ? 'UNAVAILABLE' : 'VERSION_UNAVAILABLE');
    if (response.status === 410) throw new DesktopPdfError('VERSION_UNAVAILABLE');
    if (response.status === 409)
      throw new DesktopPdfError(code === 'DESKTOP_PDF_REQUEST_IN_USE' ? 'REQUEST_IN_USE' : 'CHANGED');
    check();
    if (response.status === 408) throw new DesktopPdfError('REQUEST_EXPIRED');
    if (response.status === 429) throw new DesktopPdfError('RATE_LIMITED');
    if (response.status === 413) throw new PdfError('TOO_LARGE');
    if (response.status === 415) throw new PdfError('NOT_PDF');
    if (response.status === 422 && code === 'PDF_INTEGRITY_MISMATCH') throw new PdfError('VERSION_MISMATCH');
    throw new DesktopPdfError('FAILED');
  };
  try {
    check(); initialCapability = capability(getCapability());
    if (!UUID.test(expected.entityId) || !validateEntityData('attachmentVersion', expected.data).ok)
      throw new PdfError('VERSION_MISMATCH');
    if (expected.data.sizeBytes > initialCapability.maxFileBytes) throw new PdfError('TOO_LARGE');
    token = await wait(() => getToken());
    check();
    if (typeof token !== 'string' || token.length > 65_536 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token))
      throw new ClientError('AUTH_REQUIRED');
    const created = await request('/v1/desktop-pdfs/requests', 'POST', 'application/json',
      JSON.stringify({ attachmentVersionId: expected.entityId }));
    try {
      if (created.status !== 201) return await responseError(created);
      const body = await readJson(created);
      if (!isObject(body) || typeof body.requestId !== 'string' || !UUID.test(body.requestId)
        || body.attachmentVersionId !== expected.entityId || typeof body.expiresAt !== 'string' || body.expiresAt.length > 40
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.expiresAt)
        || !Number.isFinite(Date.parse(body.expiresAt))) throw new DesktopPdfError('INVALID_RESPONSE');
      requestId = body.requestId;
      if (Date.parse(body.expiresAt) <= Date.now()) throw new DesktopPdfError('REQUEST_EXPIRED');
    } finally { disposeBody(created); }
    check();
    const response = await request(`/v1/desktop-pdfs/requests/${requestId}/content`, 'GET', 'application/pdf');
    try {
      if (response.status !== 200) return await responseError(response);
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf'
        || response.headers.has('content-range')
        || (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity')
        || response.headers.get('accept-ranges')?.toLowerCase() !== 'none') throw new DesktopPdfError('INVALID_RESPONSE');
      const bytes = await readBytes(response, expected.data.sizeBytes, expected.data.sizeBytes);
      checkCompletePdfBytes(bytes);
      if (await wait(() => sha256(bytes)) !== expected.data.sha256) throw new PdfError('VERSION_MISMATCH');
      check(); completed = true; return bytes;
    } finally { disposeBody(response); }
  } catch (error) {
    // Caller identity/target guards outrank the response; a deadline cannot hide an observed auth/target failure.
    if (!options.isCurrent()) throw new ClientError('ACCOUNT_CHANGED');
    if (observedStatus === 401 || observedStatus === 403)
      throw error instanceof ClientError && error.code === 'SESSION_REVOKED' ? error : new ClientError('AUTH_REQUIRED');
    if (observedStatus === 410 || (observedStatus === 404 && !(error instanceof DesktopPdfError && error.code === 'UNAVAILABLE')))
      throw new DesktopPdfError('VERSION_UNAVAILABLE');
    if (observedStatus === 409 && !(error instanceof DesktopPdfError && error.code === 'REQUEST_IN_USE'))
      throw new DesktopPdfError('CHANGED');
    check();
    if (error instanceof DesktopPdfError || error instanceof PdfError || error instanceof ClientError) throw error;
    throw new DesktopPdfError('NETWORK');
  } finally {
    active = false; clearTimeout(timer); options.signal.removeEventListener('abort', onAbort); controller.abort();
    if (!completed && requestId && token) cancelRequest(baseUrl, requestId, token, cleanupFetch);
  }
}
