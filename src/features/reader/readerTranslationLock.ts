// Library batches and open Reader tabs share a cache for each paper. Claim the
// paper synchronously before either path reads or writes that cache.
const activePaperTranslations = new Set<string>();
const releaseListeners = new Set<(workspaceId: string) => void>();

export function onPaperTranslationReleased(listener: (workspaceId: string) => void): () => void {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}

export function tryAcquirePaperTranslation(workspaceId: string): (() => void) | null {
  if (activePaperTranslations.has(workspaceId)) {
    return null;
  }

  activePaperTranslations.add(workspaceId);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activePaperTranslations.delete(workspaceId);
      for (const listener of releaseListeners) {
        listener(workspaceId);
      }
    }
  };
}
