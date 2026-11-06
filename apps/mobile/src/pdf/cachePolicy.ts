import { validateEntityData } from '../../../../packages/sync-core/src/index.ts';
import { accountScopeKey, type AccountScope } from '../storage/accountStore.ts';
import { PDF_LIMITS, type PdfCacheEntry, type PdfVersion } from './types.ts';
import { PdfError } from './errors.ts';
import { publicPdfUrl, sha256 } from './acquisition.ts';

export interface CacheRecord { key: string; scopeKey: string; entry: PdfCacheEntry }
export interface CacheLimits { maxCacheBytes: number; maxTemporaryBytes: number; maxPinnedBytes: number; maxCacheEntries: number }
export const defaultCacheLimits: CacheLimits = PDF_LIMITS;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;

export function cacheKey(scope: AccountScope, versionId: string): string {
  if (!uuid.test(versionId)) throw new PdfError('VERSION_MISMATCH');
  return JSON.stringify([accountScopeKey(scope), versionId]);
}

export function decodeCacheRecord(value: unknown): CacheRecord {
  const record = value as CacheRecord;
  const entry = record?.entry;
  if (!record || typeof record.key !== 'string' || typeof record.scopeKey !== 'string' || !entry
    || !uuid.test(entry.versionId) || !hash.test(entry.sha256) || typeof entry.fileName !== 'string'
    || entry.fileName.length < 1 || entry.fileName.length > 255 || /[\\/:\x00-\x1f]/.test(entry.fileName)
    || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || entry.sizeBytes > PDF_LIMITS.maxFileBytes
    || !Number.isInteger(entry.pageCount) || entry.pageCount < 1 || entry.pageCount > PDF_LIMITS.maxPages
    || typeof entry.pinned !== 'boolean' || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.lastUsedAt)
    || record.key !== JSON.stringify([record.scopeKey, entry.versionId])) throw new PdfError('CACHE_CORRUPT');
  try {
    const [apiBaseUrl, accountId] = JSON.parse(record.scopeKey);
    if (accountScopeKey({ apiBaseUrl, accountId }) !== record.scopeKey) throw new Error();
    if (entry.sourceUrl !== undefined && publicPdfUrl(entry.sourceUrl) !== entry.sourceUrl) throw new Error();
  } catch { throw new PdfError('CACHE_CORRUPT'); }
  return record;
}

export async function assertVersionBytes(version: PdfVersion, bytes: Uint8Array): Promise<void> {
  if (!uuid.test(version.entityId) || !validateEntityData('attachmentVersion', version.data).ok
    || version.data.pageCount === null || version.data.pageCount > PDF_LIMITS.maxPages
    || bytes.byteLength !== version.data.sizeBytes || bytes.byteLength > PDF_LIMITS.maxFileBytes
    || await sha256(bytes) !== version.data.sha256) throw new PdfError('VERSION_MISMATCH');
}

export function newCacheRecord(scope: AccountScope, version: PdfVersion, now: number,
  previous: CacheRecord | undefined, options: { pinned?: boolean; sourceUrl?: string }): CacheRecord {
  const sourceUrl = options.sourceUrl === undefined ? previous?.entry.sourceUrl : publicPdfUrl(options.sourceUrl);
  return decodeCacheRecord({ key: cacheKey(scope, version.entityId), scopeKey: accountScopeKey(scope), entry: {
    versionId: version.entityId, sha256: version.data.sha256, sizeBytes: version.data.sizeBytes,
    pageCount: version.data.pageCount, fileName: version.data.fileName,
    pinned: options.pinned ?? previous?.entry.pinned ?? false,
    createdAt: previous?.entry.createdAt ?? now, lastUsedAt: now,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  } });
}

/** Capacity is global; eviction only removes this account's unpinned copies. */
export function planCacheWrite<T extends CacheRecord>(records: T[], incoming: T, limits: CacheLimits): {
  records: T[]; removed: T[];
} {
  const next = records.filter((record) => record.key !== incoming.key).concat(incoming);
  const removed: T[] = [];
  const candidates = next.filter((record) => record.key !== incoming.key && record.scopeKey === incoming.scopeKey && !record.entry.pinned)
    .sort((a, b) => a.entry.lastUsedAt - b.entry.lastUsedAt || a.key.localeCompare(b.key));
  const over = () => {
    let total = 0; let temporary = 0; let pinned = 0;
    for (const record of next) {
      total += record.entry.sizeBytes;
      if (record.entry.pinned) pinned += record.entry.sizeBytes;
      else temporary += record.entry.sizeBytes;
    }
    return total > limits.maxCacheBytes || temporary > limits.maxTemporaryBytes
      || pinned > limits.maxPinnedBytes || next.length > limits.maxCacheEntries;
  };
  while (over()) {
    const victim = candidates.shift();
    if (!victim) throw new PdfError('CACHE_FULL');
    next.splice(next.indexOf(victim), 1);
    removed.push(victim);
  }
  return { records: next, removed };
}
