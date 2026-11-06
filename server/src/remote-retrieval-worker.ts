import { setImmediate } from 'node:timers/promises';
import { REMOTE_RETRIEVAL_LIMITS, runRemoteLexicalRetrieval } from '../../packages/sync-core/src/remoteRetrieval.ts';
import type { RemoteRetrievalRequest, RemoteRetrievalResult } from '../../packages/sync-core/src/remoteRetrieval.ts';
import type { RemoteIndexArtifact } from '../../packages/sync-core/src/remoteTasks.ts';
import { ApiError } from './errors.ts';

/** Bounded server computation over verified account artifacts. No filesystem, provider, model or network authority. */
export async function runRemoteRetrieval(request: RemoteRetrievalRequest, artifacts: readonly RemoteIndexArtifact[],
  options: { signal?: AbortSignal; now?: () => number } = {}): Promise<RemoteRetrievalResult> {
  const now = options.now ?? (() => performance.now()), deadline = now() + REMOTE_RETRIEVAL_LIMITS.durationMs;
  const check = () => {
    if (options.signal?.aborted) throw new ApiError('REMOTE_RETRIEVAL_STOPPED', 409);
    if (now() > deadline) throw new ApiError('REMOTE_RETRIEVAL_TIMEOUT', 408);
  };
  check();
  return runRemoteLexicalRetrieval(request, artifacts, { check, yield: async () => { await setImmediate(); check(); } });
}
