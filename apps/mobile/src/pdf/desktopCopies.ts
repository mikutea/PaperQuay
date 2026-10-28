import { validateEntityData } from '../../../../packages/sync-core/src/index.ts';
import { normalizeServiceUrl } from '../config.ts';
import { ClientError } from '../errors.ts';
import { checkCompletePdfBytes, sha256 } from './acquisition.ts';
import { PdfError } from './errors.ts';
import { PDF_LIMITS, type PdfVersion } from './types.ts';
import { createDesktopDirectPeer, DesktopDirectError, isDesktopDirectCapability,
  type DesktopDirectCapability, type DesktopDirectPeer, type DesktopPeerFactory, type DesktopTransferState } from './desktopDirectPeer.ts';
import { receiveDesktopDirectPdf } from './desktopDirectTransfer.ts';

export type { DesktopDirectCapability, DesktopPeerFactory, DesktopTransferState } from './desktopDirectPeer.ts';

export interface DesktopPdfCapability {
  transport: 'http-relay-v1';
  maxFileBytes: number;
  requestTtlMs: number;
  pollTimeoutMs: number;
  direct?: DesktopDirectCapability;
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
  onTransferState?: (state: DesktopTransferState) => void;
  createPeerConnection?: DesktopPeerFactory;
  /** Only normalized, potentially terminal API status is exposed to the outer source deadline. */
  onApiFailure?: (failure: DesktopApiFailure | null) => void;
}
export interface DesktopApiFailure { status: number; code?: string }

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
  DIRECT_FALLBACK: '设备直连未建立，将使用临时中继。',
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
// An ASCII SDP can double in size when its characters are JSON-escaped.
const MAX_DIRECT_JSON_BYTES = 72 * 1024;
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
    && integer(value.pollTimeoutMs, 1, 20_000) && value.pollTimeoutMs <= value.requestTtlMs
    && (value.direct === undefined || isDesktopDirectCapability(value.direct));
}
function capability(value: DesktopPdfCapability | null): DesktopPdfCapability {
  if (!value) throw new DesktopPdfError('TRANSFER_DISABLED');
  if (!isDesktopPdfCapability(value)) throw new DesktopPdfError('INVALID_RESPONSE');
  return { transport: value.transport, maxFileBytes: value.maxFileBytes,
    requestTtlMs: value.requestTtlMs, pollTimeoutMs: value.pollTimeoutMs,
    ...(value.direct ? { direct: { transport: value.direct.transport, attemptMs: value.direct.attemptMs,
      maxSdpBytes: value.direct.maxSdpBytes, stunUrls: [...value.direct.stunUrls] } } : {}) };
}
export function desktopApiFailureError(failure: DesktopApiFailure | null | undefined): ClientError | DesktopPdfError | null {
  if (!failure) return null;
  if (failure.status === 401 || failure.status === 403)
    return new ClientError(failure.code === 'SESSION_REVOKED' || failure.code === 'DEVICE_REVOKED' ? 'SESSION_REVOKED' : 'AUTH_REQUIRED');
  if (failure.status === 410 || (failure.status === 404 && failure.code !== 'DESKTOP_PDF_UNAVAILABLE'))
    return new DesktopPdfError('VERSION_UNAVAILABLE');
  if (failure.status === 409 && !['DESKTOP_PDF_REQUEST_IN_USE', 'DESKTOP_PDF_DIRECT_FALLBACK'].includes(failure.code ?? ''))
    return new DesktopPdfError('CHANGED');
  return null;
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

/** Create one short-lived request. Direct and relay share its identity, deadline and cancellation. */
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
  let requestExpiresAt = 0;
  let peer: DesktopDirectPeer | null = null;
  const failures: DesktopApiFailure[] = [];
  const responses = new WeakMap<Response, DesktopApiFailure>();
  const currentFailure = () => failures.find((item) => item.status === 401 || item.status === 403)
    ?? failures.find((item) => desktopApiFailureError(item) !== null) ?? null;
  const publishFailure = () => { options.onApiFailure?.(currentFailure()); };
  const assertApiFailure = () => { const error = desktopApiFailureError(currentFailure()); if (error) throw error; };
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
      || latest.pollTimeoutMs !== initialCapability.pollTimeoutMs
      || JSON.stringify(latest.direct ?? null) !== JSON.stringify(initialCapability.direct ?? null))) throw new DesktopPdfError('CAPABILITY_CHANGED');
  };
  const checkLocal = (signal?: AbortSignal) => {
    check(); if (signal?.aborted) throw new DesktopDirectError('CLOSED');
  };
  const wait = <T>(work: () => Promise<T>, late?: (value: T) => void, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    let settled = false;
    const dispose = (value: T) => { try { late?.(value); } catch { /* Best effort resource release. */ } };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true; controller.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); reject(error);
    };
    const abort = () => {
      try { checkLocal(signal); rejectOnce(new DesktopPdfError('CANCELLED')); }
      catch (error) { rejectOnce(error); }
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    let pending: Promise<T>;
    try { checkLocal(signal); pending = work(); } catch (error) { rejectOnce(error); return; }
    pending.then((value) => {
      if (settled) { dispose(value); return; }
      try { checkLocal(signal); } catch (error) { dispose(value); rejectOnce(error); return; }
      settled = true; controller.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      try { checkLocal(signal); } catch (currentError) { error = currentError; }
      rejectOnce(error);
    });
  });
  const request = async (path: string, method: string, accept: string, body?: string, signal?: AbortSignal): Promise<Response> => {
    checkLocal(signal);
    const url = `${baseUrl}${path}`;
    const response = await wait(() => fetcher(url, {
      method, body, headers: { Authorization: `Bearer ${token!}`, Accept: accept,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      mode: 'cors', signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    }), disposeBody, signal);
    if (response.status >= 400) {
      const failure = { status: response.status }; failures.push(failure); responses.set(response, failure); publishFailure();
    }
    if (response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect'
      || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) {
      disposeBody(response); throw new DesktopPdfError('INVALID_RESPONSE');
    }
    return response;
  };
  const readBytes = async (response: Response, maximum: number, expectedLength?: number, signal?: AbortSignal): Promise<Uint8Array> => {
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
    signal?.addEventListener('abort', cancel, { once: true });
    let count = 0;
    try {
      while (true) {
        checkLocal(signal); const chunk = await wait(() => reader.read(), undefined, signal);
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array) || count + chunk.value.byteLength > bytes.length)
          throw new DesktopPdfError('INVALID_RESPONSE');
        bytes.set(chunk.value, count); count += chunk.value.byteLength;
        if (expectedLength !== undefined) { check(); options.onProgress?.(count, expectedLength); check(); }
      }
      checkLocal(signal);
      if ((declared !== null && count !== declared) || (expectedLength !== undefined && count !== expectedLength))
        throw expectedLength === undefined ? new DesktopPdfError('INVALID_RESPONSE') : new PdfError('INCOMPLETE');
      return count === bytes.length ? bytes : bytes.subarray(0, count);
    } finally {
      controller.signal.removeEventListener('abort', cancel); signal?.removeEventListener('abort', cancel); cancel(); reader.releaseLock();
    }
  };
  const readJson = async (response: Response, maximum = MAX_JSON_BYTES, signal?: AbortSignal): Promise<unknown> => {
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
      throw new DesktopPdfError('INVALID_RESPONSE');
    const bytes = await readBytes(response, maximum, undefined, signal);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new DesktopPdfError('INVALID_RESPONSE'); }
  };
  const responseError = async (response: Response, signal?: AbortSignal): Promise<never> => {
    let code: string | undefined;
    try {
      const body = await readJson(response, MAX_JSON_BYTES, signal);
      if (isObject(body) && isObject(body.error) && typeof body.error.code === 'string') code = body.error.code;
    } catch { /* Status below remains authoritative for malformed authentication or target errors. */ }
    const failure = responses.get(response);
    if (failure && ['SESSION_REVOKED', 'DEVICE_REVOKED', 'DESKTOP_PDF_UNAVAILABLE', 'DESKTOP_PDF_REQUEST_IN_USE',
      'DESKTOP_PDF_DIRECT_FALLBACK'].includes(code ?? '')) { failure.code = code; publishFailure(); }
    if (response.status === 401 || response.status === 403)
      throw new ClientError(code === 'SESSION_REVOKED' || code === 'DEVICE_REVOKED' ? 'SESSION_REVOKED' : 'AUTH_REQUIRED');
    if (response.status === 404)
      throw new DesktopPdfError(code === 'DESKTOP_PDF_UNAVAILABLE' ? 'UNAVAILABLE' : 'VERSION_UNAVAILABLE');
    if (response.status === 410) throw new DesktopPdfError('VERSION_UNAVAILABLE');
    if (response.status === 409)
      throw new DesktopPdfError(code === 'DESKTOP_PDF_REQUEST_IN_USE' ? 'REQUEST_IN_USE'
        : code === 'DESKTOP_PDF_DIRECT_FALLBACK' ? 'DIRECT_FALLBACK' : 'CHANGED');
    checkLocal(signal);
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
    let offer: string | undefined; let directFailed = false;
    if (initialCapability.direct) {
      try {
        peer = createDesktopDirectPeer(initialCapability.direct, expected, { signal: controller.signal, check,
          onProgress: options.onProgress, createPeerConnection: options.createPeerConnection });
        if (peer) { options.onTransferState?.('direct-connecting'); offer = await wait(() => peer!.prepareOffer()); }
      } catch {
        peer?.close(); peer = null; check(); directFailed = true;
      }
    }
    if (!peer) options.onTransferState?.(directFailed ? 'relay-fallback' : 'relay');
    check(); const requestStartedAt = Date.now();
    const created = await request('/v1/desktop-pdfs/requests', 'POST', 'application/json',
      JSON.stringify({ attachmentVersionId: expected.entityId, ...(offer ? { direct: { offer } } : {}) }));
    try {
      if (created.status !== 201) return await responseError(created);
      const body = await readJson(created);
      if (!isObject(body) || typeof body.requestId !== 'string' || !UUID.test(body.requestId)
        || body.attachmentVersionId !== expected.entityId || typeof body.expiresAt !== 'string' || body.expiresAt.length > 40
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.expiresAt)
        || !Number.isFinite(Date.parse(body.expiresAt))) throw new DesktopPdfError('INVALID_RESPONSE');
      requestId = body.requestId;
      requestExpiresAt = Date.parse(body.expiresAt);
      if (requestExpiresAt <= Date.now()) throw new DesktopPdfError('REQUEST_EXPIRED');
    } finally { disposeBody(created); }
    check();
    if (peer && offer && initialCapability.direct) {
      peer.bindRequest(requestId!);
      // The server reserves one control operation per role. Keep that slot
      // until its response has actually settled, even if direct has already
      // failed locally. The original fifteen-second budget still bounds it.
      let controlTail: Promise<void> = Promise.resolve();
      const serialControl = <T>(work: () => Promise<T>): Promise<T> => {
        const pending = controlTail.then(() => { check(); assertApiFailure(); return work(); });
        controlTail = pending.then(() => undefined, () => undefined); return pending;
      };
      const directJson = async (path: string, method: 'GET' | 'POST', body: unknown | undefined, signal: AbortSignal) => {
        return wait(() => serialControl(async () => {
          checkLocal(signal);
          const response = await request(path, method, 'application/json', body === undefined ? undefined : JSON.stringify(body));
          try {
            if (response.status !== 200) return await responseError(response);
            const result = await readJson(response, MAX_DIRECT_JSON_BYTES); checkLocal(signal); return result;
          } finally { disposeBody(response); }
        }), undefined, signal);
      };
      try {
        const bytes = await receiveDesktopDirectPdf(peer, expected, { requestId: requestId!, expiresAt: requestExpiresAt,
          requestStartedAt, capability: initialCapability.direct, signal: controller.signal, check, assertApiFailure,
          requestJson: directJson, verify: async (received, signal) => {
            checkLocal(signal); checkCompletePdfBytes(received);
            if (received.byteLength !== expected.data.sizeBytes || await wait(() => sha256(received), undefined, signal) !== expected.data.sha256)
              throw new PdfError('VERSION_MISMATCH');
          } });
        check(); assertApiFailure(); completed = true; options.onTransferState?.('direct-received'); check(); return bytes;
      } catch (error) {
        peer.close(); peer = null; check(); assertApiFailure();
        if (error instanceof ClientError || error instanceof PdfError && ['CANCELLED', 'ACCOUNT_CHANGED', 'TARGET_CHANGED'].includes(error.code)
          || error instanceof DesktopPdfError && ['CANCELLED', 'VERSION_UNAVAILABLE', 'CHANGED', 'REQUEST_IN_USE', 'REQUEST_EXPIRED',
            'TRANSFER_DISABLED', 'CAPABILITY_CHANGED'].includes(error.code)) throw error;
        if (error instanceof DesktopDirectError && error.reason === 'COMPLETE_UNCONFIRMED') throw new DesktopPdfError('REQUEST_IN_USE');
        options.onTransferState?.('relay-fallback'); check();
        await serialControl(async () => {
          const fallback = await request(`/v1/desktop-pdfs/requests/${requestId}/direct/fallback`, 'POST', 'application/json', '{}');
          try {
            if (fallback.status !== 200) return await responseError(fallback);
            const result = await readJson(fallback);
            if (!isObject(result) || result.state !== 'relay') throw new DesktopPdfError('INVALID_RESPONSE');
          } finally { disposeBody(fallback); }
        });
      }
    }
    check(); assertApiFailure();
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
      check(); assertApiFailure(); completed = true; options.onTransferState?.('relay-received'); check(); return bytes;
    } finally { disposeBody(response); }
  } catch (error) {
    // Caller identity/target guards outrank the response; a deadline cannot hide an observed auth/target failure.
    if (!options.isCurrent()) throw new ClientError('ACCOUNT_CHANGED');
    assertApiFailure();
    check();
    if (error instanceof DesktopPdfError || error instanceof PdfError || error instanceof ClientError) throw error;
    throw new DesktopPdfError('NETWORK');
  } finally {
    active = false; clearTimeout(timer); options.signal.removeEventListener('abort', onAbort); controller.abort(); peer?.close();
    if (!completed && requestId && token) cancelRequest(baseUrl, requestId, token, cleanupFetch);
  }
}
