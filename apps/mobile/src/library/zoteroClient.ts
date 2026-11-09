import { isPlainObject, SYNC_LIMITS, UUID_PATTERN } from '../../../../packages/sync-core/src/index.ts';
import type { SecretStore } from '../platform/secretStore.ts';
import {accountScopeAvailable,subscribeAccountFence} from '../privacy/browserErasure.ts';

/** Zotero Web API v3 read semantics: https://www.zotero.org/support/dev/web_api/v3/syncing */
export const ZOTERO_LIMITS = Object.freeze({ maxItems: 500, maxBytes: 4 * 1024 * 1024, pageSize: 100,
  maxItemPages: 5, maxRequests: 24, maxVersionRestarts: 2, maxRateLimitRetries: 2, deadlineMs: 30_000 });
export const ZOTERO_SECRET_KEY = 'api-key';
const ORIGIN = 'https://api.zotero.org';
const itemKey = /^[A-Z0-9]{8}$/;
const uuid = new RegExp(UUID_PATTERN);
export interface ZoteroLibraryConfig { kind: 'user' | 'group'; libraryId: string; name: string }
export interface ZoteroAccountScope { apiBaseUrl: string; accountId: string }
export type ZoteroCredential = { mode: 'public' } | { mode: 'memory'; apiKey: string }
  | { mode: 'stored'; store: SecretStore; accountScope: ZoteroAccountScope };
export type ZoteroClientErrorCode = 'INVALID_CONFIG' | 'INVALID_CURSOR' | 'INVALID_KEY' | 'MISSING_KEY' | 'SECRET_UNAVAILABLE'
  | 'CANCELLED' | 'CHANGED' | 'TIMEOUT' | 'NETWORK' | 'AUTHORIZATION' | 'NOT_FOUND' | 'HTTP_ERROR'
  | 'INVALID_RESPONSE' | 'INVALID_METADATA' | 'LIMIT' | 'VERSION_CHANGED' | 'RATE_LIMIT' | 'INVALID_RESULT';
/** Never attach response bodies, request headers, URLs, original errors, or credentials. */
export class ZoteroClientError extends Error {
  constructor(readonly code: ZoteroClientErrorCode, readonly retryAt: number | null = null) {
    super(code); this.name = 'ZoteroClientError';
  }
}
export interface ZoteroRetryInfo { attempts: number; versionRestarts: number; rateLimitRetries: number; notBefore: number | null }
export interface ZoteroDownloadStats { requests: number; bytes: number; itemPages: number; downloadedItems: number }
export interface ZoteroApiItem {
  key: string; version: number; library: { type: 'user' | 'group'; id: number; name?: string };
  data: Record<string, unknown>;
}
export interface ZoteroDownload {
  config: ZoteroLibraryConfig; expectedCursor: number | null; nextCursor: number; unchanged: boolean;
  records: ZoteroApiItem[]; deletedKeys: string[]; retry: ZoteroRetryInfo; stats: ZoteroDownloadStats;
}
export interface ZoteroDownloadOptions {
  expectedCursor: number | null; credential: ZoteroCredential; signal?: AbortSignal; current?: () => boolean;
}
export interface ZoteroClientOptions {
  fetch?: typeof fetch;
  /** Test clocks/adapters must preserve the abort and monotonic-time contracts. */
  now?: () => number; sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Tests may shorten the deadline; callers cannot expand the production maximum. */
  deadlineMs?: number;
}
function fail(code: ZoteroClientErrorCode = 'INVALID_RESPONSE'): never { throw new ZoteroClientError(code); }
function plain(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Reflect.ownKeys(value).every(key => typeof key === 'string'
    && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
export function validateZoteroConfig(value: unknown): ZoteroLibraryConfig {
  if (!closed(value, ['kind', 'libraryId', 'name']) || (value.kind !== 'user' && value.kind !== 'group')
    || typeof value.libraryId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value.libraryId)
    || !Number.isSafeInteger(Number(value.libraryId)) || typeof value.name !== 'string' || !value.name.trim()
    || value.name.length > SYNC_LIMITS.maxNameLength || /[\u0000-\u001f\u007f-\u009f]/.test(value.name)) fail('INVALID_CONFIG');
  try { encodeURIComponent(value.name); } catch { fail('INVALID_CONFIG'); }
  return { kind: value.kind, libraryId: value.libraryId, name: value.name.trim() };
}
export function zoteroSourceId(config: ZoteroLibraryConfig): string {
  const safe = validateZoteroConfig(config); return `zotero-${safe.kind}:${safe.libraryId}`;
}
export function validateZoteroCursor(cursor: unknown): number | null {
  if (cursor === null) return null;
  if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) fail('INVALID_CURSOR');
  return cursor as number;
}
export function validateZoteroApiKey(value: unknown): string {
  if (value === '' || value === null) fail('MISSING_KEY');
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{20,64}$/.test(value)) fail('INVALID_KEY');
  return value;
}
/** The PaperQuay server/account partition is independent from Zotero's source identity. */
export function zoteroSecretNamespace(scope: ZoteroAccountScope, config: ZoteroLibraryConfig): string {
  const source = zoteroSourceId(config);
  if (!closed(scope, ['apiBaseUrl', 'accountId']) || typeof scope.accountId !== 'string' || !uuid.test(scope.accountId)
    || typeof scope.apiBaseUrl !== 'string' || scope.apiBaseUrl.length > 2048) fail('INVALID_CONFIG');
  let url: URL;
  try { url = new URL(scope.apiBaseUrl); } catch { fail('INVALID_CONFIG'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('INVALID_CONFIG');
  return JSON.stringify(['paperquay-zotero-key-v1', url.href.replace(/\/$/, ''), scope.accountId, source]);
}
function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ZoteroClientError('CANCELLED')); return; }
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new ZoteroClientError('CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, milliseconds);
    signal.addEventListener('abort', stop, { once: true });
  });
}
class Operation {
  readonly controller = new AbortController(); readonly deadline: number;
  private timer: ReturnType<typeof setTimeout>; private reason: ZoteroClientErrorCode = 'CANCELLED';
  private abortExternal: () => void;
  constructor(private options: Pick<ZoteroDownloadOptions, 'signal' | 'current'>, milliseconds: number, private now: () => number) {
    this.deadline = now() + milliseconds;
    this.timer = setTimeout(() => this.abort('TIMEOUT'), milliseconds);
    this.abortExternal = () => this.abort('CANCELLED');
    options.signal?.addEventListener('abort', this.abortExternal, { once: true });
    if (options.signal?.aborted) this.abortExternal();
  }
  abort(reason: ZoteroClientErrorCode) { if (!this.controller.signal.aborted) { this.reason = reason; this.controller.abort(); } }
  guard() {
    if (this.now() >= this.deadline) this.abort('TIMEOUT');
    let current = true;
    try { current = this.options.current?.() ?? true; } catch { current = false; }
    if (!current) this.abort('CHANGED');
    if (this.controller.signal.aborted) throw new ZoteroClientError(this.reason);
  }
  /** Bounds even fetch, stream reads, and secret adapters that ignore AbortSignal. */
  wait<T>(action: () => Promise<T>, late?: (value: T) => void): Promise<T> {
    this.guard();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const stop = () => { if (!settled) { settled = true; reject(new ZoteroClientError(this.reason)); } };
      this.controller.signal.addEventListener('abort', stop, { once: true });
      let task: Promise<T>;
      try { task = action(); } catch (error) { task = Promise.reject(error); }
      Promise.resolve(task).then(value => {
        this.controller.signal.removeEventListener('abort', stop);
        if (settled) { late?.(value); return; }
        settled = true;
        try { this.guard(); resolve(value); } catch (error) { late?.(value); reject(error); }
      }, error => {
        this.controller.signal.removeEventListener('abort', stop);
        if (!settled) { settled = true; reject(error); }
      });
    });
  }
  close() {
    clearTimeout(this.timer); this.options.signal?.removeEventListener('abort', this.abortExternal);
    this.abort('CANCELLED');
  }
}
function integerHeader(headers: Headers, name: string): number {
  const value = headers.get(name);
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail();
  return Number(value);
}
function cancelBody(response: Response) { void response.body?.cancel().catch(() => undefined); }
function retryTime(value: string | null, now: number, allowDate: boolean): number | null {
  if (value === null) return null;
  let at: number;
  if (/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) at = now + Math.ceil(Number(value) * 1000);
  else if (allowDate && Number.isFinite(Date.parse(value))) at = Math.max(now, Date.parse(value));
  else fail();
  if (!Number.isSafeInteger(at) || at < 0) fail();
  return at;
}
class LibraryChanged extends Error {}

export class ZoteroClient {
  private fetcher: typeof fetch; private now: () => number; private pause: typeof sleep; private milliseconds: number;
  private notBefore = 0;
  constructor(options: ZoteroClientOptions = {}) {
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now; this.pause = options.sleep ?? sleep;
    this.milliseconds = options.deadlineMs ?? ZOTERO_LIMITS.deadlineMs;
    if (!Number.isSafeInteger(this.milliseconds) || this.milliseconds < 1 || this.milliseconds > ZOTERO_LIMITS.deadlineMs) fail('INVALID_CONFIG');
  }
  async download(input: ZoteroLibraryConfig, options: ZoteroDownloadOptions): Promise<ZoteroDownload> {
    const config = validateZoteroConfig(input), expectedCursor = validateZoteroCursor(options.expectedCursor);
    let storedScope:ZoteroAccountScope|null=null,unwatch:(()=>void)|undefined;
    const operation = new Operation({...options,current:()=>
      (options.current?.()??true)&&(!storedScope||accountScopeAvailable(storedScope))},this.milliseconds,this.now);
    const stats: ZoteroDownloadStats = { requests: 0, bytes: 0, itemPages: 0, downloadedItems: 0 };
    const retry: ZoteroRetryInfo = { attempts: 0, versionRestarts: 0, rateLimitRetries: 0, notBefore: null };
    let apiKey: string | null = null;
    try {
      operation.guard();
      const credential = options.credential;
      if (!plain(credential)) fail('INVALID_KEY');
      if (credential.mode === 'memory' && closed(credential, ['mode', 'apiKey'])) apiKey = validateZoteroApiKey(credential.apiKey);
      else if (credential.mode === 'stored' && closed(credential, ['mode', 'store', 'accountScope'])) {
        const namespace = zoteroSecretNamespace(credential.accountScope, config);
        storedScope=credential.accountScope;unwatch=subscribeAccountFence(storedScope,()=>operation.abort('CHANGED'));
        try { apiKey = validateZoteroApiKey(await operation.wait(() => credential.store.get(namespace, ZOTERO_SECRET_KEY))); }
        catch (error) { if (error instanceof ZoteroClientError) throw error; fail('SECRET_UNAVAILABLE'); }
      } else if (!(credential.mode === 'public' && closed(credential, ['mode']))) fail('INVALID_KEY');
      const prefix = `${ORIGIN}/${config.kind === 'user' ? 'users' : 'groups'}/${config.libraryId}`;
      const waitBackoff = async () => {
        operation.guard();
        while (this.notBefore > this.now()) {
          if (this.notBefore >= operation.deadline) throw new ZoteroClientError('RATE_LIMIT', this.notBefore);
          await operation.wait(() => this.pause(this.notBefore - this.now(), operation.controller.signal)); operation.guard();
        }
      };
      const request = async (url: URL, conditional = false): Promise<Response> => {
        for (;;) {
          await waitBackoff(); operation.guard();
          if (++stats.requests > ZOTERO_LIMITS.maxRequests) fail('LIMIT');
          const headers: Record<string, string> = { Accept: 'application/json', 'Zotero-API-Version': '3' };
          if (apiKey !== null) headers['Zotero-API-Key'] = apiKey;
          if (conditional && expectedCursor !== null) headers['If-Modified-Since-Version'] = String(expectedCursor);
          let response: Response;
          try { response = await operation.wait(() => this.fetcher(url.href, { method: 'GET', headers, signal: operation.controller.signal,
            credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' }), cancelBody); }
          catch (error) { if (error instanceof ZoteroClientError) throw error; fail('NETWORK'); }
          try {
            if (response.redirected || response.url && response.url !== url.href) fail();
            const backoff = retryTime(response.headers.get('Backoff'), this.now(), false);
            if (backoff !== null) this.notBefore = Math.max(this.notBefore, backoff);
            if (response.status === 429 || response.status === 503) {
              const at = retryTime(response.headers.get('Retry-After'), this.now(), true)
                ?? this.now() + 1000 * 2 ** retry.rateLimitRetries;
              this.notBefore = Math.max(this.notBefore, at);
              if (retry.rateLimitRetries >= ZOTERO_LIMITS.maxRateLimitRetries) throw new ZoteroClientError('RATE_LIMIT', this.notBefore);
              retry.rateLimitRetries++; cancelBody(response); continue;
            }
            if (response.status === 401 || response.status === 403) fail('AUTHORIZATION');
            if (response.status === 404) fail('NOT_FOUND');
            if (response.status !== 200 && response.status !== 304) fail('HTTP_ERROR');
            const apiVersion = response.headers.get('Zotero-API-Version');
            if (apiVersion !== '3' && !(response.status === 304 && apiVersion === null)) fail();
            return response;
          } catch (error) { cancelBody(response); throw error; }
        }
      };
      const readJson = async (response: Response): Promise<unknown> => {
        try {
          const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
          if (type !== 'application/json') fail();
          const length = response.headers.get('Content-Length');
          if (length !== null && (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length))
            || Number(length) > ZOTERO_LIMITS.maxBytes - stats.bytes)) fail('LIMIT');
          if (!response.body) fail();
          const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
          let value = '', finished = false;
          try {
            for (;;) {
              const part = await operation.wait(() => reader.read());
              if (part.done) { finished = true; break; }
              stats.bytes += part.value.byteLength;
              if (stats.bytes > ZOTERO_LIMITS.maxBytes) fail('LIMIT');
              value += decoder.decode(part.value, { stream: true });
            }
            value += decoder.decode(); operation.guard();
            return JSON.parse(value);
          } finally { if (!finished) void reader.cancel().catch(() => undefined); reader.releaseLock(); }
        } catch (error) {
          if (!response.body?.locked) cancelBody(response);
          if (error instanceof ZoteroClientError) throw error;
          operation.guard(); fail();
        }
      };
      const unchanged = (current: number): ZoteroDownload => {
        operation.guard(); retry.notBefore = this.notBefore > this.now() ? this.notBefore : null;
        return { config, expectedCursor, nextCursor: current, unchanged: true, records: [], deletedKeys: [], retry, stats };
      };
      for (;;) {
        retry.attempts++; stats.itemPages = 0; stats.downloadedItems = 0;
        const records: ZoteroApiItem[] = [], known = new Set<string>();
        let version: number | null = null, total: number | null = null;
        const checkVersion = (response: Response) => {
          const current = integerHeader(response.headers, 'Last-Modified-Version');
          if (expectedCursor !== null && current < expectedCursor) fail('INVALID_CURSOR');
          if (version !== null && version !== current) throw new LibraryChanged();
          version = current; return current;
        };
        try {
          for (let start = 0; total === null || start < total;) {
            if (++stats.itemPages > ZOTERO_LIMITS.maxItemPages) fail('LIMIT');
            const url = new URL(`${prefix}/items`);
            for (const [key, value] of Object.entries({ format: 'json', include: 'data', includeTrashed: '1', since: String(expectedCursor ?? 0),
              limit: String(ZOTERO_LIMITS.pageSize), start: String(start), sort: 'dateModified', direction: 'asc' })) url.searchParams.set(key, value);
            let response = await request(url, start === 0);
            try {
              let confirming304 = false;
              if (response.status === 304) {
                if (start !== 0 || expectedCursor === null) fail();
                if (response.headers.get('Last-Modified-Version') !== null) {
                  const current = checkVersion(response);
                  if (current !== expectedCursor) fail();
                  cancelBody(response); return unchanged(current);
                }
                // Zotero can omit both version headers on 304. Confirm the
                // cursor with a normal read, including rollback detection.
                cancelBody(response); response = await request(url);
                if (response.status !== 200) fail();
                confirming304 = true;
              }
              const current = checkVersion(response);
              const count = integerHeader(response.headers, 'Total-Results');
              if (count > ZOTERO_LIMITS.maxItems) fail('LIMIT');
              if (total !== null && total !== count) throw new LibraryChanged();
              total = count;
              const raw = await readJson(response);
              if (!Array.isArray(raw) || raw.length !== Math.min(ZOTERO_LIMITS.pageSize, total - start)) fail();
              if (confirming304 && current === expectedCursor) {
                if (count !== 0) fail();
                return unchanged(current);
              }
              for (const record of raw) {
                if (!plain(record) || !plain(record.library) || !plain(record.data) || typeof record.key !== 'string'
                  || !itemKey.test(record.key) || known.has(record.key) || !Number.isSafeInteger(record.version)
                  || (record.version as number) < 0 || (record.version as number) > current
                  || expectedCursor !== null && expectedCursor > 0 && (record.version as number) <= expectedCursor
                  || record.library.type !== config.kind || record.library.id !== Number(config.libraryId)
                  || record.data.key !== undefined && record.data.key !== record.key
                  || record.data.version !== undefined && record.data.version !== record.version) fail();
                known.add(record.key); records.push(record as unknown as ZoteroApiItem);
              }
              start += raw.length; stats.downloadedItems = records.length;
              // Never follow server-provided Link URLs. Construct every offset at the fixed origin.
              if (total === 0) break;
            } catch (error) { cancelBody(response); throw error; }
          }
          const deletedUrl = new URL(`${prefix}/deleted`); deletedUrl.searchParams.set('since', String(expectedCursor ?? 0));
          const response = await request(deletedUrl);
          let deletedKeys: string[];
          try {
            if (response.status !== 200) fail();
            checkVersion(response);
            const deleted = await readJson(response);
            if (!plain(deleted) || !Array.isArray(deleted.items) || deleted.items.length > ZOTERO_LIMITS.maxItems) fail();
            for (const name of ['collections', 'searches', 'tags']) if (deleted[name] !== undefined
              && (!Array.isArray(deleted[name]) || (deleted[name] as unknown[]).length > ZOTERO_LIMITS.maxItems
                || !(deleted[name] as unknown[]).every(value => typeof value === 'string'))) fail();
            deletedKeys = [];
            for (const key of deleted.items) {
              if (typeof key !== 'string' || !itemKey.test(key) || known.has(key)) fail();
              known.add(key); deletedKeys.push(key);
            }
            if (known.size > ZOTERO_LIMITS.maxItems) fail('LIMIT');
          } catch (error) { cancelBody(response); throw error; }
          operation.guard(); retry.notBefore = this.notBefore > this.now() ? this.notBefore : null;
          return { config, expectedCursor, nextCursor: version!, unchanged: false, records, deletedKeys: deletedKeys.sort(), retry, stats };
        } catch (error) {
          if (!(error instanceof LibraryChanged)) throw error;
          if (retry.versionRestarts >= ZOTERO_LIMITS.maxVersionRestarts) fail('VERSION_CHANGED');
          retry.versionRestarts++;
          await operation.wait(() => this.pause(250 * 2 ** (retry.versionRestarts - 1), operation.controller.signal));
        }
      }
    } catch (error) {
      if (error instanceof ZoteroClientError) throw error;
      operation.guard(); throw new ZoteroClientError('NETWORK');
    } finally { apiKey = null; unwatch?.(); operation.close(); }
  }
}
