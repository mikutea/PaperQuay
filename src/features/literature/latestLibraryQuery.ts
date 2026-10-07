/** Ignore superseded results (including failures) without canceling backend work. */
export function createLatestLibraryQuery() {
  let revision = 0;
  return {
    invalidate() { revision++; },
    async run<T>(
      load: () => Promise<T>,
      commit: (value: T) => void,
      settled: () => void,
    ): Promise<void> {
      const request = ++revision;
      try {
        const value = await load();
        if (request === revision) commit(value);
      } catch (error) {
        if (request === revision) throw error;
      } finally {
        if (request === revision) settled();
      }
    },
  };
}
