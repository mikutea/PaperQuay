import { accountScopeKey, type AccountScope } from '../storage/accountStore.ts';
import { PdfError, throwIfAborted } from './errors.ts';
import type { PdfCache, PdfCacheEntry, PdfVersion } from './types.ts';
import {
  assertVersionBytes, cacheKey, decodeCacheRecord, defaultCacheLimits, newCacheRecord, planCacheWrite,
  type CacheLimits, type CacheRecord,
} from './cachePolicy.ts';

/** Metadata, content and eviction commit together; failed writes never evict an older copy. */
export class WebPdfCache implements PdfCache {
  private readonly database: Promise<IDBDatabase>;
  private readonly limits: CacheLimits;
  private readonly now: () => number;

  constructor(options: { indexedDB?: IDBFactory; databaseName?: string; limits?: Partial<CacheLimits>; now?: () => number } = {}) {
    this.limits = { ...defaultCacheLimits, ...options.limits };
    this.now = options.now ?? Date.now;
    this.database = new Promise((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) { reject(new PdfError('CACHE_UNAVAILABLE')); return; }
      let request: IDBOpenDBRequest;
      try { request = factory.open(options.databaseName ?? 'paperquay-mobile-pdf-v1', 1); }
      catch { reject(new PdfError('CACHE_UNAVAILABLE')); return; }
      request.onupgradeneeded = () => {
        request.result.createObjectStore('metadata', { keyPath: 'key' }).createIndex('scope', 'scopeKey');
        request.result.createObjectStore('content');
      };
      request.onerror = request.onblocked = () => reject(new PdfError('CACHE_UNAVAILABLE'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    void this.database.catch(() => undefined);
  }

  private async transaction<T>(write: boolean,
    action: (metadata: IDBObjectStore, content: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void,
  ): Promise<T> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['metadata', 'content'], write ? 'readwrite' : 'readonly', write ? { durability: 'strict' } : undefined);
      let value: T; let failure: unknown;
      const fail = (error: unknown) => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(value!);
      tx.onerror = tx.onabort = () => reject(failure instanceof PdfError ? failure : new PdfError('CACHE_UNAVAILABLE'));
      try { action(tx.objectStore('metadata'), tx.objectStore('content'), (result) => { value = result; }, fail); }
      catch (error) { fail(error); }
    });
  }

  async list(scope: AccountScope): Promise<PdfCacheEntry[]> {
    return this.transaction(false, (metadata, _content, done, fail) => {
      const request = metadata.index('scope').getAll(accountScopeKey(scope));
      request.onsuccess = () => {
        try { done(request.result.map((value) => decodeCacheRecord(value).entry).sort((a, b) => b.lastUsedAt - a.lastUsedAt)); }
        catch (error) { fail(error); }
      };
    });
  }

  async read(scope: AccountScope, version: PdfVersion): Promise<Uint8Array | null> {
    const key = cacheKey(scope, version.entityId);
    const saved = await this.transaction<{ record: CacheRecord; blob: Blob } | null>(true, (metadata, content, done, fail) => {
      const request = metadata.get(key);
      request.onsuccess = () => {
        if (!request.result) { done(null); return; }
        try {
          const record = decodeCacheRecord(request.result);
          if (record.entry.sha256 !== version.data.sha256 || record.entry.sizeBytes !== version.data.sizeBytes) {
            throw new PdfError('CACHE_CORRUPT');
          }
          const body = content.get(key);
          body.onsuccess = () => {
            if (!(body.result instanceof Blob)) { fail(new PdfError('CACHE_CORRUPT')); return; }
            metadata.put({ ...record, entry: { ...record.entry, lastUsedAt: this.now() } });
            done({ record, blob: body.result });
          };
        } catch (error) { fail(error); }
      };
    });
    if (!saved) return null;
    const bytes = new Uint8Array(await saved.blob.arrayBuffer());
    try { await assertVersionBytes(version, bytes); }
    catch { throw new PdfError('CACHE_CORRUPT'); }
    return bytes;
  }

  async put(scope: AccountScope, version: PdfVersion, bytes: Uint8Array,
    options: { pinned?: boolean; sourceUrl?: string; signal?: AbortSignal } = {}): Promise<void> {
    throwIfAborted(options.signal);
    await assertVersionBytes(version, bytes);
    throwIfAborted(options.signal);
    const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
    return this.transaction(true, (metadata, content, done, fail) => {
      const request = metadata.getAll();
      request.onsuccess = () => {
        try {
          throwIfAborted(options.signal);
          const all = request.result.map(decodeCacheRecord);
          const record = newCacheRecord(scope, version, this.now(), all.find((item) => item.key === cacheKey(scope, version.entityId)), options);
          const plan = planCacheWrite(all, record, this.limits);
          for (const removed of plan.removed) { metadata.delete(removed.key); content.delete(removed.key); }
          metadata.put(record); content.put(blob, record.key); done(undefined);
        } catch (error) { fail(error); }
      };
    });
  }

  async setPinned(scope: AccountScope, versionId: string, pinned: boolean): Promise<void> {
    return this.transaction(true, (metadata, content, done, fail) => {
      const request = metadata.getAll();
      request.onsuccess = () => {
        try {
          const all = request.result.map(decodeCacheRecord);
          const old = all.find((item) => item.key === cacheKey(scope, versionId));
          if (!old) throw new PdfError('CACHE_MISSING');
          const record = { ...old, entry: { ...old.entry, pinned, lastUsedAt: this.now() } };
          const plan = planCacheWrite(all, record, this.limits);
          for (const removed of plan.removed) { metadata.delete(removed.key); content.delete(removed.key); }
          metadata.put(record); done(undefined);
        } catch (error) { fail(error); }
      };
    });
  }

  async remove(scope: AccountScope, versionId: string): Promise<void> {
    return this.transaction(true, (metadata, content, done) => {
      const key = cacheKey(scope, versionId); metadata.delete(key); content.delete(key); done(undefined);
    });
  }

  async clear(scope: AccountScope, options: { includePinned?: boolean } = {}): Promise<void> {
    return this.transaction(true, (metadata, content, done, fail) => {
      const request = metadata.index('scope').getAll(accountScopeKey(scope));
      request.onsuccess = () => {
        try {
          for (const value of request.result) {
            const record = decodeCacheRecord(value);
            if (options.includePinned || !record.entry.pinned) { metadata.delete(record.key); content.delete(record.key); }
          }
          done(undefined);
        } catch (error) { fail(error); }
      };
    });
  }

  async close(): Promise<void> { (await this.database).close(); }
}
