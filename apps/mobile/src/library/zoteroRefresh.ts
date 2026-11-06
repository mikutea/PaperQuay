import { parseExternalLibrary, type ExternalLibrarySnapshot, type ExternalLibraryWarning } from './externalLibrary.ts';
import { ZoteroClient, ZoteroClientError, type ZoteroDownloadOptions, type ZoteroDownloadStats,
  type ZoteroLibraryConfig, type ZoteroRetryInfo } from './zoteroClient.ts';

export interface ZoteroIgnoredItem { key: string; reason: 'attachment' | 'note' | 'annotation' | 'child' | 'trashed' | 'unsupported' }
export interface ZoteroRefreshResult {
  config: ZoteroLibraryConfig; snapshot: ExternalLibrarySnapshot; expectedCursor: number | null; nextCursor: number;
  unchanged: boolean; deletedKeys: string[]; ignored: ZoteroIgnoredItem[]; warnings: ExternalLibraryWarning[];
  retry: ZoteroRetryInfo; stats: ZoteroDownloadStats;
}
const results = new WeakSet<object>();
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Only a completed, immutable result from this process may be adopted. Never deserialize one as authority. */
export function validateZoteroRefreshResult(value: unknown): ZoteroRefreshResult {
  if (value === null || typeof value !== 'object' || !results.has(value)) throw new ZoteroClientError('INVALID_RESULT');
  return value as ZoteroRefreshResult;
}
/** Fetch/convert only. Cursor, mappings, papers and outbox are adopted together by the owning account transaction. */
export async function refreshZoteroLibrary(client: ZoteroClient, config: ZoteroLibraryConfig,
  options: ZoteroDownloadOptions): Promise<ZoteroRefreshResult> {
  const downloaded = await client.download(config, options);
  let snapshot: ExternalLibrarySnapshot, warnings: ExternalLibraryWarning[];
  try {
    const source = { kind: `zotero-${downloaded.config.kind}`, key: downloaded.config.libraryId, name: downloaded.config.name };
    const parsed = downloaded.records.length ? parseExternalLibrary(JSON.stringify(downloaded.records))
      : parseExternalLibrary(JSON.stringify({ format: 'paperquay-external-library', version: 1, source, items: [] }));
    snapshot = { ...parsed.snapshot, source: { ...parsed.snapshot.source, name: downloaded.config.name } }; warnings = parsed.warnings;
  } catch { throw new ZoteroClientError('INVALID_RESPONSE'); }
  const imported = new Set(snapshot.items.map(item => item.key));
  const ignored: ZoteroIgnoredItem[] = downloaded.records.filter(record => !imported.has(record.key)).map(record => ({ key: record.key,
    reason: record.data.deleted === 1 || record.data.deleted === true ? 'trashed'
      : record.data.itemType === 'attachment' ? 'attachment' : record.data.itemType === 'note' ? 'note'
        : record.data.itemType === 'annotation' ? 'annotation' : record.data.parentItem ? 'child' : 'unsupported' }));
  if (options.signal?.aborted) throw new ZoteroClientError('CANCELLED');
  let current = true; try { current = options.current?.() ?? true; } catch { current = false; }
  if (!current) throw new ZoteroClientError('CHANGED');
  const result = freeze({ config: downloaded.config, snapshot, expectedCursor: downloaded.expectedCursor, nextCursor: downloaded.nextCursor,
    unchanged: downloaded.unchanged, deletedKeys: downloaded.deletedKeys, ignored, warnings, retry: downloaded.retry, stats: downloaded.stats });
  results.add(result); return result;
}
