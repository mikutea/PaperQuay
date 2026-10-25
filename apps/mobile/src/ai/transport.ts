import { AiError } from './errors.ts';
import type { AiLimits, AiTransport } from './types.ts';
import { AI_LIMITS } from './types.ts';

/** Standard WebView fetch: native HTTP patching must remain disabled. */
export const fetchAiTransport: AiTransport = Object.freeze({
  kind: 'fetch' as const,
  supportsStreaming: true,
  redirectPolicy: 'error' as const,
  request: (input: Parameters<AiTransport['request']>[0]) => fetch(input.url, {
    method: input.method, headers: input.headers, body: input.body, signal: input.signal,
    redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
  }),
});

/** Tests may shorten limits, but no caller can raise the production caps. */
export function boundedAiLimits(overrides: Partial<AiLimits> = {}): AiLimits {
  const limits = { ...AI_LIMITS } as AiLimits;
  for (const name of Object.keys(AI_LIMITS) as (keyof AiLimits)[]) {
    if (overrides[name] !== undefined) {
      if (!Number.isSafeInteger(overrides[name]) || overrides[name]! < 1) throw new AiError('CONFIG_INVALID');
      limits[name] = Math.min(limits[name], overrides[name]!);
    }
  }
  return limits;
}

/** Bounds even a transport or SecretStore promise which fails to honor AbortSignal. */
export class AiRequestGuard {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  #external?: AbortSignal;
  #timer: ReturnType<typeof setTimeout>;
  #reason: AiError | null = null;
  #externalAbort = () => this.stop(new AiError('CANCELLED'));
  constructor(signal: AbortSignal | undefined, timeoutMs: number) {
    this.#external = signal;
    this.#timer = setTimeout(() => this.stop(new AiError('TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', this.#externalAbort, { once: true });
    if (signal?.aborted) this.#externalAbort();
  }
  stop(reason: AiError): void {
    if (this.signal.aborted) return;
    this.#reason = reason;
    this.controller.abort();
  }
  check(): void { if (this.signal.aborted) throw this.#reason ?? new AiError('CANCELLED'); }
  wait<T>(promise: Promise<T>, idleMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.signal.removeEventListener('abort', aborted);
      };
      const aborted = () => { cleanup(); reject(this.#reason ?? new AiError('CANCELLED')); };
      this.signal.addEventListener('abort', aborted, { once: true });
      if (idleMs !== undefined) timer = setTimeout(() => this.stop(new AiError('IDLE_TIMEOUT')), idleMs);
      // Always observe the original promise, including after an early abort.
      promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
      if (this.signal.aborted) aborted();
    });
  }
  close(): void {
    clearTimeout(this.#timer);
    this.#external?.removeEventListener('abort', this.#externalAbort);
  }
}

export function cancelResponseBody(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
}

export function ensureDirectResponse(response: Response): void {
  if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    cancelResponseBody(response);
    throw new AiError('REDIRECT_BLOCKED');
  }
}

export async function readAiBody(response: Response, guard: AiRequestGuard, maxBytes: number, idleMs: number): Promise<string> {
  if (!response.body) throw new AiError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await guard.wait(reader.read(), idleMs);
      guard.check();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new AiError('RESPONSE_TOO_LARGE');
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    guard.check();
    if (error instanceof AiError) throw error;
    throw new AiError('INVALID_RESPONSE');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
