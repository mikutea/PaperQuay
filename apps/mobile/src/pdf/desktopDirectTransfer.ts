import { DesktopDirectError, validDesktopSdp, type DesktopDirectCapability, type DesktopDirectPeer } from './desktopDirectPeer.ts';
import type { PdfVersion } from './types.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const timestamp = (value: unknown): number => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

/** Control requests renew a short permission; receiving bytes never replaces server authorization. */
export async function receiveDesktopDirectPdf(peer: DesktopDirectPeer, version: PdfVersion, options: {
  requestId: string;
  expiresAt: number;
  requestStartedAt: number;
  capability: DesktopDirectCapability;
  signal: AbortSignal;
  check: () => void;
  assertApiFailure: () => void;
  requestJson: (path: string, method: 'GET' | 'POST', body: unknown | undefined, signal: AbortSignal) => Promise<unknown>;
  verify: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
}): Promise<Uint8Array> {
  const controller = new AbortController();
  let stopped = false, completing = false, remoteDeadline: number | undefined;
  let failure: unknown;
  let rejectFailure!: (error: unknown) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failed.catch(() => undefined);
  const stop = (error: unknown) => {
    if (stopped || failure !== undefined) return;
    failure = error; rejectFailure(error); peer.close(); controller.abort();
  };
  const abort = () => stop(new DesktopDirectError('CLOSED'));
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  // Starting before the POST is conservative: network delay never adds time to the lease's six-second attempt.
  const deadline = Math.min(options.expiresAt, options.requestStartedAt + options.capability.attemptMs);
  const timer = setTimeout(() => stop(new DesktopDirectError('TIMEOUT')), Math.max(1, deadline - Date.now()));
  const check = () => {
    options.check(); options.assertApiFailure();
    if (failure !== undefined) throw failure;
    if (controller.signal.aborted || stopped) throw new DesktopDirectError('CLOSED');
  };
  const race = async <T>(operation: Promise<T>): Promise<T> => {
    try { const result = await Promise.race([operation, failed, peer.failure]); check(); return result; }
    catch (error) { check(); throw error; }
  };
  const delay = (milliseconds: number) => new Promise<void>((resolve) => {
    if (controller.signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(waitTimer); controller.signal.removeEventListener('abort', done); resolve(); };
    const waitTimer = setTimeout(done, milliseconds);
    controller.signal.addEventListener('abort', done, { once: true });
  });
  const base = `/v1/desktop-pdfs/requests/${options.requestId}/direct`;
  const poll = (async () => {
    try {
      while (!stopped && failure === undefined) {
        check(); const startedAt = Date.now();
        const state = await options.requestJson(base, 'GET', undefined, controller.signal);
        if (stopped) return;
        check();
        if (!object(state) || !['direct', 'relay', 'complete'].includes(String(state.state))
          || (state.answer !== null && !validDesktopSdp(state.answer, options.capability.maxSdpBytes))
          || timestamp(state.expiresAt) !== options.expiresAt || !Number.isFinite(timestamp(state.directExpiresAt))
          || timestamp(state.directExpiresAt) > options.expiresAt || typeof state.relayReady !== 'boolean'
          || (state.authorizedUntil !== null && !Number.isFinite(timestamp(state.authorizedUntil))))
          throw new DesktopDirectError('INVALID_SIGNAL');
        const cutoff = timestamp(state.directExpiresAt);
        if (remoteDeadline !== undefined && remoteDeadline !== cutoff) throw new DesktopDirectError('INVALID_SIGNAL');
        remoteDeadline = cutoff;
        if (state.state === 'relay') throw new DesktopDirectError('FAILED');
        if (state.state === 'complete') {
          if (!completing) throw new DesktopDirectError('COMPLETE_UNCONFIRMED');
          return; // The POST still has to return its own verified receipt before adoption.
        }
        const until = timestamp(state.authorizedUntil);
        if (!Number.isFinite(until) || until > cutoff || until > Date.now() + 2000)
          throw new DesktopDirectError('AUTHORIZATION_EXPIRED');
        try {
          peer.authorize(Math.min(until, deadline), Math.min(cutoff, deadline));
          if (state.answer !== null) await race(peer.acceptAnswer(state.answer as string));
        } catch (error) {
          // A provider may observe the durable receipt before our POST response
          // arrives and close its channel. Only the server receipt can finish us.
          if (!completing || !(error instanceof DesktopDirectError)) throw error;
        }
        await delay(Math.max(0, 1000 - (Date.now() - startedAt)));
      }
    } catch (error) { if (!stopped) stop(error); }
  })();
  try {
    check();
    const bytes = await race(peer.bytes);
    await race(options.verify(bytes, controller.signal));
    check(); completing = true;
    const receipt = await Promise.race([options.requestJson(`${base}/complete`, 'POST', {
      sha256: version.data.sha256, sizeBytes: version.data.sizeBytes,
    }, controller.signal), failed]);
    check();
    if (!object(receipt) || receipt.received !== true) throw new DesktopDirectError('INVALID_SIGNAL');
    // The durable server receipt has won. ACK is best effort, because the
    // provider is also allowed to close after observing that same receipt.
    stopped = true; clearTimeout(timer); controller.abort();
    try { await peer.acknowledge(); } catch { /* Never downgrade an already confirmed lease for an ACK-only failure. */ }
    options.check(); options.assertApiFailure(); return bytes;
  } finally {
    stopped = true; clearTimeout(timer); options.signal.removeEventListener('abort', abort);
    controller.abort(); peer.close();
    // The transport's local abort race detaches a stalled poll; no rejected background task escapes.
    void poll.catch(() => undefined);
  }
}
