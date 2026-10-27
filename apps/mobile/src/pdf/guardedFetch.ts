import { PdfError } from './errors.ts';

/** Check the live reader before dispatch and before exposing a response body. */
export function guardedPdfFetch(check: () => void, fetcher: typeof fetch = (...args) => globalThis.fetch(...args)): typeof fetch {
  return (input, init) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let settled = false;
    const dispose = (response: Response) => {
      if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
    };
    const clean = () => signal?.removeEventListener('abort', abort);
    const fail = (error: unknown) => { if (!settled) { settled = true; clean(); reject(error); } };
    const abort = () => fail(new PdfError('CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      check();
      if (signal?.aborted) { abort(); return; }
      void fetcher(input, init).then((response) => {
        if (settled) { dispose(response); return; }
        try { check(); }
        catch (error) { dispose(response); fail(error); return; }
        settled = true; clean(); resolve(response);
      }, fail);
    } catch (error) { fail(error); }
  });
}
