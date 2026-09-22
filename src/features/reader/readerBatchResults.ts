import type { LibraryTranslationRunStatus } from './readerLibraryTranslationBatch';
import type { BatchProgressState, LibraryPreviewOutcome } from './readerShared';
import type { WorkspaceItemSource } from '../../types/reader';
import type { LiteraturePaperTaskState } from '../../types/library';
import { guessSiblingMarkdownPath } from '../../utils/mineruCache.ts';

function matchingJsonBackedMineruSource(readerSuffix: string, batchSuffix: string): boolean {
  const marker = '::mineru-markdown::';
  const readerMarkerIndex = readerSuffix.indexOf(marker);
  if (readerMarkerIndex < 0 ||
    batchSuffix.slice(0, readerMarkerIndex + marker.length) !==
      readerSuffix.slice(0, readerMarkerIndex + marker.length)) return false;

  const readerSource = readerSuffix.slice(readerMarkerIndex + marker.length).match(/^(.*)::(\d+)$/);
  const batchSource = batchSuffix.slice(readerMarkerIndex + marker.length).match(/^(.*)::(\d+)$/);
  if (!readerSource || !batchSource || readerSource[2] !== batchSource[2] ||
    !/(?:^|[\\/])(?:content_list(?:_v2)?|middle)\.json$/i.test(readerSource[1])) return false;

  return batchSource[1] === 'blocks' ||
    batchSource[1] === guessSiblingMarkdownPath(readerSource[1]);
}

export function overviewSourceKeysMatch({
  itemKey,
  workspaceId,
  storedKey,
  resolvedKey,
}: {
  itemKey: string;
  workspaceId: string;
  storedKey: string;
  resolvedKey: string;
}): boolean {
  if (!storedKey || !resolvedKey) return false;
  if (storedKey === resolvedKey) return true;
  const readerPrefix = `${itemKey}::`;
  const batchPrefix = `${workspaceId}::`;
  if (!storedKey.startsWith(readerPrefix) || !resolvedKey.startsWith(batchPrefix)) return false;
  const readerSuffix = storedKey.slice(readerPrefix.length);
  const batchSuffix = resolvedKey.slice(batchPrefix.length);
  // The Reader PDF key contains only a path, while the batch key includes byte length.
  // A replaced PDF cannot be proven identical from the Reader key, even at the same path.
  if (readerSuffix.includes('::pdf-text::') || batchSuffix.includes('::pdf-text::')) return false;
  return readerSuffix === batchSuffix || matchingJsonBackedMineruSource(readerSuffix, batchSuffix);
}

export function assertTranslationCacheDestination(cacheDir: string, message: string): void {
  if (!cacheDir.trim()) throw new Error(message);
}

export function shouldPreferRetainedOverview({
  hasUsableSummary,
  sourceKeysMatch,
  operation,
}: {
  hasUsableSummary: boolean;
  sourceKeysMatch: boolean;
  operation: Pick<LiteraturePaperTaskState, 'kind' | 'status'> | null | undefined;
}): boolean {
  return hasUsableSummary && sourceKeysMatch &&
    operation?.kind === 'overview' && operation.status === 'error';
}

export function shouldWriteOverviewCache(
  source: WorkspaceItemSource,
  cacheDir: string,
): boolean {
  if (cacheDir.trim()) return true;
  if (source === 'native-library') return false;
  throw new Error('The overview cache directory is not configured.');
}

export function sourceKeyAfterOverviewFailure(
  hasAvailableSummary: boolean,
  resolvedSourceKey: string,
  previousSourceKey: string,
): string {
  return hasAvailableSummary && resolvedSourceKey
    ? resolvedSourceKey
    : previousSourceKey;
}

export function selectUsableOverview<T>(
  summary: T | null | undefined,
  format: (summary: T) => string,
): T | null {
  if (!summary) return null;
  try {
    return format(summary).trim() ? summary : null;
  } catch {
    return null;
  }
}

export async function enqueueOverviewWrite<T>(
  pendingWrites: Map<string, Promise<unknown>>,
  key: string,
  write: () => Promise<T>,
): Promise<T> {
  const previousWrite = pendingWrites.get(key) ?? Promise.resolve();
  const nextWrite = previousWrite.catch(() => undefined).then(write);
  pendingWrites.set(key, nextWrite);
  try {
    return await nextWrite;
  } finally {
    if (pendingWrites.get(key) === nextWrite) pendingWrites.delete(key);
  }
}

export async function persistOverviewIfCurrent({
  isCurrent,
  cacheAlreadyVerified = false,
  summaryText,
  saveCache,
  saveNative,
}: {
  isCurrent: () => boolean;
  cacheAlreadyVerified?: boolean;
  summaryText: string;
  saveCache: () => Promise<void>;
  saveNative: () => Promise<void>;
}): Promise<boolean> {
  if (!isCurrent()) return false;
  if (!summaryText.trim()) {
    throw new Error('The generated overview contains no usable content.');
  }
  if (!cacheAlreadyVerified) {
    await saveCache();
    if (!isCurrent()) return false;
  }
  await saveNative();
  return isCurrent();
}

export function countVerifiedBatchResults(
  progress: Pick<BatchProgressState, 'succeeded' | 'reused'>,
): number {
  return progress.succeeded + (progress.reused ?? 0);
}

export function classifyOverviewBatchOutcome(
  outcome: LibraryPreviewOutcome,
): 'succeeded' | 'reused' | 'skipped' | 'failed' {
  switch (outcome) {
    case 'generated':
      return 'succeeded';
    case 'loaded':
      return 'reused';
    case 'skipped':
      return 'skipped';
    case 'failed':
      return 'failed';
  }
}

export async function saveVerifiedLibraryOverview<T extends { aiSummary?: string | null }>(
  summaryText: string,
  save: () => Promise<T>,
): Promise<T> {
  if (!summaryText.trim()) {
    throw new Error('The generated overview contains no usable content.');
  }
  const updatedPaper = await save();
  if (updatedPaper.aiSummary?.trim() !== summaryText) {
    throw new Error('The library did not confirm the saved overview.');
  }
  return updatedPaper;
}

export function resolveVerifiedTranslationStatus({
  rateLimited,
  serviceUnavailable,
  cancelled,
  cacheSaveFailed,
  translatedCount,
  totalBlocks,
  failedBlocks,
}: {
  rateLimited: boolean;
  serviceUnavailable: boolean;
  cancelled: boolean;
  cacheSaveFailed: boolean;
  translatedCount: number;
  totalBlocks: number;
  failedBlocks: number;
}): LibraryTranslationRunStatus {
  if (rateLimited) return 'rate-limited';
  if (serviceUnavailable) return 'service-unavailable';
  if (cancelled) return 'cancelled';
  if (cacheSaveFailed || translatedCount === 0) return 'failed';
  return failedBlocks > 0 || translatedCount < totalBlocks ? 'partial' : 'success';
}
