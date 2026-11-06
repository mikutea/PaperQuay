import { canonicalJson } from '../../../../packages/sync-core/src/validation.ts';
import { REMOTE_RETRIEVAL_LIMITS, parseRemoteRetrievalJson, remoteRetrievalId,
  validateRemoteRetrievalCapability, validateRemoteRetrievalRequest, validateRemoteRetrievalSource,
  validateRemoteRetrievalReceipt, validateRemoteRetrievalStatus,
  type RemoteRetrievalCapability, type RemoteRetrievalRequest, type RemoteRetrievalSource,
  type RemoteRetrievalReceipt, type RemoteRetrievalStatus } from '../../../../packages/sync-core/src/remoteRetrieval.ts';
import { normalizeServiceUrl } from '../config.ts';

export interface RetrievalContext {
  apiBaseUrl: string; getAccessToken(): Promise<string>; getCapability(): RemoteRetrievalCapability | null;
  identityKey?(): string | null;
}
export interface RetrievalCall { signal?: AbortSignal; current?: () => boolean }
export type RetrievalErrorCode = 'DISABLED' | 'CHANGED' | 'CANCELLED' | 'TIMEOUT' | 'NETWORK' | 'INVALID' | 'AUTH_REQUIRED'
  | 'SOURCE_UNAVAILABLE' | 'SOURCE_CHANGED' | 'LIMIT' | 'REUSED' | 'REMOVED' | 'CAPACITY' | 'BUSY' | 'FAILED';
const descriptions: Record<RetrievalErrorCode, string> = {
  DISABLED: '当前账号服务尚未开启远程检索。', CHANGED: '账号、所选版本或检索内容已变化，请重新预览。',
  CANCELLED: '已停止本次等待。检索结果可用原请求另行查询。', TIMEOUT: '等待超时。请先查询原请求的结果。',
  NETWORK: '暂时无法连接账号服务。请先查询原请求，避免另建重复记录。', INVALID: '检索结果未通过完整性核验，未采用内容。',
  AUTH_REQUIRED: '登录已过期，请重新登录后查询原请求。', SOURCE_UNAVAILABLE: '所选索引已不可用，请重新检查可用来源。',
  SOURCE_CHANGED: '文献、PDF 或索引版本已变化。旧结果保留供核对，请重新选择当前来源。',
  LIMIT: '本次检索超过来源或文本限制，请缩小范围。', REUSED: '原请求标识对应的内容不同，已停止发送。',
  REMOVED: '此检索结果已从服务端清理，原请求不会再次执行。', CAPACITY: '检索记录已满。请明确清理已保存的服务端结果，或联系管理员处理回执额度。',
  BUSY: '账号服务正在忙，请稍后手动重试。', FAILED: '本次远程检索未完成，请检查账号服务后重试。',
};
export class RetrievalError extends Error { constructor(readonly code: RetrievalErrorCode) { super(descriptions[code]); this.name = 'RetrievalError'; } }
export const describeRetrievalError = (error: unknown): string => {
  if (error instanceof RetrievalError) return descriptions[error.code];
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['EDIT_CHANGED','ACCOUNT_CHANGED'].includes(code)) return descriptions.CHANGED;
  if (code.startsWith('STORAGE_')) return '本机记录尚未确认保存。请刷新本机记录，或仅重试保存已有结果；不要另建请求。';
  return descriptions.FAILED;
};
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function httpError(status: number, code: unknown): RetrievalError {
  if (status === 401 || status === 403) return new RetrievalError('AUTH_REQUIRED');
  const codes: Record<string, RetrievalErrorCode> = { REMOTE_RETRIEVAL_DISABLED: 'DISABLED', REMOTE_RETRIEVAL_INVALID: 'INVALID',
    REMOTE_RETRIEVAL_LIMIT: 'LIMIT', REMOTE_RETRIEVAL_SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE', REMOTE_RETRIEVAL_SOURCE_CHANGED: 'SOURCE_CHANGED',
    REMOTE_RETRIEVAL_SOURCE_INVALID: 'INVALID', REMOTE_RETRIEVAL_RECEIPT_INVALID: 'INVALID', REMOTE_RETRIEVAL_REQUEST_REUSED: 'REUSED',
    REMOTE_RETRIEVAL_REMOVED: 'REMOVED', REMOTE_RETRIEVAL_STORAGE_FULL: 'CAPACITY', REMOTE_RETRIEVAL_BUSY: 'BUSY', REMOTE_RETRIEVAL_STOPPED: 'CANCELLED', REMOTE_RETRIEVAL_TIMEOUT: 'TIMEOUT' };
  return new RetrievalError(codes[String(code)] || (status === 429 ? 'BUSY' : 'FAILED'));
}

/** Only the configured account service receives authentication. Requests contain
 * fixed manifests and search text; no URL from a result is followed. */
export class RetrievalClient {
  private readonly base: string;
  constructor(private context: RetrievalContext, private fetcher: typeof fetch = (...args) => globalThis.fetch(...args), private timeoutMs = 20_000) {
    this.base = normalizeServiceUrl(context.apiBaseUrl);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RetrievalError('INVALID');
  }
  private async call<T>(path: string, method: string, body: unknown, options: RetrievalCall, decode: (value: unknown) => T | Promise<T>): Promise<T> {
    const capability = this.context.getCapability(); if (!capability) throw new RetrievalError('DISABLED');
    const cap = validateRemoteRetrievalCapability(capability), capKey = canonicalJson(cap), identity = this.context.identityKey?.();
    const controller = new AbortController(); let reason: RetrievalError | null = null;
    const stop = (code: RetrievalErrorCode) => { if (!controller.signal.aborted) { reason = new RetrievalError(code); controller.abort(); } };
    const cancelled = () => stop('CANCELLED'), timer = setTimeout(() => stop('TIMEOUT'), this.timeoutMs);
    options.signal?.addEventListener('abort', cancelled, { once: true }); if (options.signal?.aborted) cancelled();
    const check = () => {
      if (controller.signal.aborted) throw reason || new RetrievalError('CANCELLED');
      if (identity !== this.context.identityKey?.() || options.current && !options.current() || canonicalJson(this.context.getCapability()) !== capKey) { stop('CHANGED'); throw reason!; }
    };
    const wait = <V>(promise: Promise<V>): Promise<V> => new Promise((resolve, reject) => {
      const abort = () => { controller.signal.removeEventListener('abort', abort); reject(reason || new RetrievalError('CANCELLED')); };
      controller.signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { controller.signal.removeEventListener('abort', abort); resolve(value); }, error => { controller.signal.removeEventListener('abort', abort); reject(error); });
      if (controller.signal.aborted) abort();
    });
    try {
      check(); const token = await wait(this.context.getAccessToken()); check();
      if (!token || token.length > 65536 || /[\x00-\x20\x7f]/.test(token)) throw new RetrievalError('AUTH_REQUIRED');
      const url = this.base + path, response = await wait(this.fetcher(url, { method,
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }).then(response => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); return response;
      })); check();
      if (response.redirected || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400 || response.url && response.url !== url) { void response.body?.cancel().catch(() => {}); throw new RetrievalError('INVALID'); }
      const max = response.ok ? cap.maxResultBytes + cap.maxRequestBytes + 16384 : 16384;
      if (!response.body || Number(response.headers.get('content-length')) > max) {
        void response.body?.cancel().catch(() => {}); stop('INVALID'); throw reason!;
      }
      const reader = response.body.getReader(), parts: Uint8Array[] = []; let length = 0, chunks = 0, done = false;
      let value: unknown;
      try {
        for (;;) { const part = await wait(reader.read()); check(); if (part.done) { done = true; break; }
          length += part.value.length; if (length > max || ++chunks > 4096) throw new RetrievalError('LIMIT'); parts.push(part.value); }
        const bytes = new Uint8Array(length); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        try { value = parseRemoteRetrievalJson(bytes, max); } catch { throw new RetrievalError('INVALID'); }
      } finally { if (!done) void reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!response.ok) throw httpError(response.status, (value as { error?: { code?: string } })?.error?.code);
      const result = await decode(value); check(); return result;
    } catch (error) { if (error instanceof RetrievalError) throw error; check(); throw new RetrievalError(error instanceof TypeError ? 'NETWORK' : 'INVALID'); }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancelled); }
  }
  listSources(cursor: string | null, options: RetrievalCall = {}): Promise<{ sources: RemoteRetrievalSource[]; nextCursor: string | null; hasMore: boolean }> {
    const query = new URLSearchParams({ limit: '8' }); if (cursor !== null) query.set('cursor', remoteRetrievalId(cursor));
    return this.call('/v1/remote-retrieval/sources?' + query, 'GET', undefined, options, value => {
      if (!exact(value, ['sources', 'nextCursor', 'hasMore']) || !Array.isArray(value.sources) || value.sources.length > 8 || typeof value.hasMore !== 'boolean'
        || value.nextCursor !== null && typeof value.nextCursor !== 'string' || value.hasMore && value.nextCursor === null) throw new RetrievalError('INVALID');
      const sources = value.sources.map(validateRemoteRetrievalSource); if (new Set(sources.map(row => row.taskId)).size !== sources.length) throw new RetrievalError('INVALID');
      const nextCursor = value.nextCursor === null ? null : remoteRetrievalId(value.nextCursor); if (value.hasMore && nextCursor === cursor) throw new RetrievalError('INVALID');
      return { sources, nextCursor, hasMore: value.hasMore };
    });
  }
  async execute(input: RemoteRetrievalRequest, options: RetrievalCall = {}): Promise<RemoteRetrievalReceipt> {
    const request = validateRemoteRetrievalRequest(input), cap = this.context.getCapability(); if (!cap) throw new RetrievalError('DISABLED');
    if (request.sources.length > cap.maxSources || new TextEncoder().encode(request.query).length > cap.maxQueryBytes || request.topK > cap.maxTopK
      || request.sources.reduce((n, row) => n + row.artifactBytes, 0) > cap.maxSourceBytes || request.sources.reduce((n, row) => n + row.chunkCount, 0) > cap.maxChunks
      || request.sources.reduce((n, row) => n + row.textCharacters, 0) > cap.maxSourceCharacters || request.sources.reduce((n, row) => n + row.dimension * row.chunkCount, 0) > cap.maxVectorElements) throw new RetrievalError('LIMIT');
    return this.call('/v1/remote-retrieval/requests', 'POST', request, options, async value => {
      if (!exact(value, ['replayed', 'receipt']) || typeof value.replayed !== 'boolean') throw new RetrievalError('INVALID');
      const receipt = await validateRemoteRetrievalReceipt(value.receipt); if (canonicalJson(receipt.request) !== canonicalJson(request)) throw new RetrievalError('INVALID'); return receipt;
    });
  }
  status(requestId: string, options: RetrievalCall = {}): Promise<RemoteRetrievalStatus> {
    const id = remoteRetrievalId(requestId); return this.call('/v1/remote-retrieval/requests/' + id, 'GET', undefined, options, async value => {
      const result = await validateRemoteRetrievalStatus(value); if (result.requestId !== id) throw new RetrievalError('INVALID'); return result;
    });
  }
  remove(requestId: string, options: RetrievalCall = {}): Promise<RemoteRetrievalStatus> {
    const id = remoteRetrievalId(requestId); return this.call('/v1/remote-retrieval/requests/' + id, 'DELETE', undefined, options, async value => {
      const result = await validateRemoteRetrievalStatus(value); if (result.requestId !== id || result.status !== 'removed') throw new RetrievalError('INVALID'); return result;
    });
  }
}
