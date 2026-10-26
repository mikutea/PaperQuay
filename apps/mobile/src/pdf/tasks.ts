import { accountScopeKey, type AccountScope } from '../storage/accountStore.ts';

const active = new Map<string, Set<AbortController>>();

/** Account removal aborts downloads and document work before clearing persisted bytes. */
export function registerPdfTask(scope: AccountScope, controller: AbortController): () => void {
  const key = accountScopeKey(scope);
  const tasks = active.get(key) ?? new Set<AbortController>();
  tasks.add(controller); active.set(key, tasks);
  return () => { tasks.delete(controller); if (!tasks.size && active.get(key) === tasks) active.delete(key); };
}

export function cancelPdfTasks(scope: AccountScope): void {
  const key = accountScopeKey(scope); const tasks = active.get(key);
  active.delete(key);
  for (const task of tasks ?? []) task.abort();
}
