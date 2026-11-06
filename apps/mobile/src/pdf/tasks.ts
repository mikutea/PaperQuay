import { accountScopeKey, type AccountScope } from '../storage/accountStore.ts';
import { PdfError } from './errors.ts';

const active = new Map<string, Set<AbortController>>();

/** Retire the UI promptly even when a platform read or queued save is still settling.
 * The work must still guard each continuation and any transactional write. */
export function waitForPdfTask<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const clean = () => signal.removeEventListener('abort', abort);
    const fail = (error: unknown) => { if (!settled) { settled = true; clean(); reject(error); } };
    const abort = () => fail(new PdfError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      void work().then((value) => { if (!settled) { settled = true; clean(); resolve(value); } }, fail);
    } catch (error) { fail(error); }
  });
}

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
