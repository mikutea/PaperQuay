/** Coalesce edits while retaining an explicit, awaitable save before shutdown. */
export function createDebouncedSave<T>(options: {
  delayMs: number;
  save: (value: T) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  let pending: { value: T } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function flush(): Promise<void> {
    clearTimer();
    if (running) return running;
    if (!pending) return Promise.resolve();

    const operation = (async () => {
      while (pending) {
        const next = pending;
        pending = undefined;
        try {
          await options.save(next.value);
        } catch (error) {
          // A retry must retain the most recent edit, not restore an old value
          // over a newer snapshot received while the failed write was running.
          pending ??= next;
          throw error;
        }
      }
    })();
    running = operation;
    const cleanup = () => { if (running === operation) running = undefined; };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  return {
    schedule(value: T) {
      pending = { value };
      clearTimer();
      timer = setTimeout(() => { void flush().catch(options.onError); }, options.delayMs);
    },
    flush,
  };
}
