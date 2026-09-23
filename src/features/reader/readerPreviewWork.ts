export async function mapPreviewItemsWithConcurrency<T, R>(
  items: readonly T[],
  maxConcurrency: number,
  mapItem: (item: T, index: number) => Promise<R>,
  shouldContinue: () => boolean = () => true,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(maxConcurrency)));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (shouldContinue() && nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapItem(items[index], index);
    }
  }));

  return results.filter((_, index) => index in results);
}

export function wasUpdatedDuringPreviewScan(
  updatedAt: number | undefined,
  scanStartedAt: number,
): boolean {
  return updatedAt !== undefined && updatedAt >= scanStartedAt;
}

export async function waitForBatchResumeOrCancel(
  isPaused: () => boolean,
  isCancelled: () => boolean,
  wait: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  while (isPaused() && !isCancelled()) {
    await wait(120);
  }
  return !isCancelled();
}
