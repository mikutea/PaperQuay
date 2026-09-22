export function createDeferredAutoTranslationRetry() {
  const busyWorkspaceIds = new Set<string>();
  return {
    defer(workspaceId: string) {
      busyWorkspaceIds.add(workspaceId);
    },
    canAttempt(workspaceId: string) {
      return !busyWorkspaceIds.has(workspaceId);
    },
    release(workspaceId: string) {
      return busyWorkspaceIds.delete(workspaceId);
    },
  };
}
