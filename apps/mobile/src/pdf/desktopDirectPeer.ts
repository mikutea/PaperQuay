import type { PdfVersion } from './types.ts';

export interface DesktopDirectCapability {
  transport: 'webrtc-data-v1';
  attemptMs: 6000;
  maxSdpBytes: 32768;
  stunUrls: string[];
}
export type DesktopPeerFactory = (configuration: RTCConfiguration) => RTCPeerConnection;
export type DesktopTransferState = 'direct-connecting' | 'relay-fallback' | 'relay' | 'direct-received' | 'relay-received';

const CHANNEL = 'paperquay-pdf-v1';
const CONTROL_BYTES = 1024;
const CHUNK_BYTES = 16384;
const GATHER_MS = 1500;
const encoder = new TextEncoder();
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',');

/** This error contains no SDP, network address, browser exception or file content. */
export class DesktopDirectError extends Error {
  constructor(readonly reason: 'FAILED' | 'TIMEOUT' | 'INVALID_SIGNAL' | 'INVALID_FRAME' | 'CLOSED' | 'AUTHORIZATION_EXPIRED' | 'COMPLETE_UNCONFIRMED') {
    super('设备直连未完成。'); this.name = 'DesktopDirectError';
  }
}

export function validDesktopStunUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256 || value !== value.trim()) return false;
  const match = /^stuns?:(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) return false;
  if (!match[1].startsWith('[') && match[1].split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part))) return false;
  try { return Boolean(new URL(`https://${match[1]}`).hostname); } catch { return false; }
}
export function isDesktopDirectCapability(value: unknown): value is DesktopDirectCapability {
  return object(value) && value.transport === 'webrtc-data-v1' && value.attemptMs === 6000 && value.maxSdpBytes === 32768
    && Array.isArray(value.stunUrls) && value.stunUrls.length <= 2 && value.stunUrls.every(validDesktopStunUrl)
    && value.stunUrls.join(',').length <= 256;
}
export function validDesktopSdp(value: unknown, maximum = 32768): value is string {
  if (typeof value !== 'string' || !value || value.length > maximum || !/^[\x20-\x7e\r\n]+$/.test(value)) return false;
  const lines = value.split(/\r?\n/);
  return lines[0] === 'v=0' && lines.filter((line) => line.startsWith('m=')).length === 1
    && lines.some((line) => /^m=application /.test(line))
    && lines.filter((line) => line.startsWith('a=candidate:')).length <= 32
    && !lines.some((line) => /^a=candidate:.*\styp\s+relay(?:\s|$)/i.test(line));
}

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Events can fail before the caller starts waiting for an offer or bytes.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export interface DesktopDirectPeer {
  prepareOffer(): Promise<string>;
  bindRequest(requestId: string): void;
  authorize(until: number, deadline: number): void;
  acceptAnswer(answer: string): Promise<void>;
  bytes: Promise<Uint8Array>;
  failure: Promise<never>;
  acknowledge(): Promise<void>;
  close(): void;
}

/** One reliable channel, one exact version and no media or renderer-selected ICE server. */
export function createDesktopDirectPeer(capability: DesktopDirectCapability, version: PdfVersion, options: {
  signal: AbortSignal;
  check: () => void;
  onProgress?: (loaded: number, total: number) => void;
  createPeerConnection?: DesktopPeerFactory;
}): DesktopDirectPeer | null {
  const factory = options.createPeerConnection ?? (typeof globalThis.RTCPeerConnection === 'function'
    ? (configuration: RTCConfiguration) => new globalThis.RTCPeerConnection(configuration) : undefined);
  if (!factory) return null;
  if (!isDesktopDirectCapability(capability)) throw new DesktopDirectError('INVALID_SIGNAL');
  options.check();
  const expected = { entityId: version.entityId, sha256: version.data.sha256, sizeBytes: version.data.sizeBytes };
  let pc: RTCPeerConnection;
  try { pc = factory({ iceServers: capability.stunUrls.map((url) => ({ urls: url })), iceTransportPolicy: 'all', bundlePolicy: 'max-bundle' }); }
  catch { throw new DesktopDirectError('FAILED'); }
  let channel: RTCDataChannel;
  try {
    channel = pc.createDataChannel(CHANNEL, { ordered: true, protocol: CHANNEL });
    channel.binaryType = 'arraybuffer';
  } catch { pc.close(); throw new DesktopDirectError('FAILED'); }
  const complete = deferred<Uint8Array>(), failed = deferred<never>();
  let closed = false, received = false, metadata = false, requestId: string | undefined, answer: string | undefined;
  let buffer: Uint8Array | undefined, count = 0, authorizedUntil = 0, directDeadline = 0;
  let permitTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, name: string, listener: EventListener) => {
    target.addEventListener(name, listener); listeners.push(() => target.removeEventListener(name, listener));
  };
  const stop = (error: unknown) => {
    if (closed) return;
    closed = true; buffer = undefined;
    clearTimeout(permitTimer); clearTimeout(deadlineTimer);
    for (const remove of listeners.splice(0)) remove();
    try { channel.close(); } catch { /* Already closed. */ }
    try { pc.close(); } catch { /* Already closed. */ }
    complete.reject(error); failed.reject(error);
  };
  const check = (permission = false) => {
    options.check();
    if (closed || options.signal.aborted) throw new DesktopDirectError('CLOSED');
    if (permission && (!authorizedUntil || authorizedUntil <= Date.now() || directDeadline <= Date.now()))
      throw new DesktopDirectError('AUTHORIZATION_EXPIRED');
  };
  const wait = async <T>(operation: Promise<T>, permission = false): Promise<T> => {
    const result = await Promise.race([operation, failed.promise]); check(permission); return result;
  };
  const abort = () => stop(new DesktopDirectError('CLOSED'));
  listen(options.signal, 'abort', abort);
  if (options.signal.aborted) abort();
  const connectionChanged = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)
      || ['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) stop(new DesktopDirectError('FAILED'));
  };
  listen(pc, 'connectionstatechange', connectionChanged);
  listen(pc, 'iceconnectionstatechange', connectionChanged);
  listen(pc, 'datachannel', ((event: RTCDataChannelEvent) => {
    try { event.channel.close(); } catch { /* Reject all additional channels. */ }
    stop(new DesktopDirectError('INVALID_FRAME'));
  }) as EventListener);
  listen(channel, 'error', () => stop(new DesktopDirectError('FAILED')));
  listen(channel, 'close', () => stop(new DesktopDirectError('CLOSED')));
  listen(channel, 'message', ((event: MessageEvent<unknown>) => {
    try {
      check(true);
      if (!requestId || received) throw new DesktopDirectError('INVALID_FRAME');
      if (typeof event.data === 'string') {
        if (encoder.encode(event.data).length > CONTROL_BYTES) throw new DesktopDirectError('INVALID_FRAME');
        let frame: unknown;
        try { frame = JSON.parse(event.data) as unknown; } catch { throw new DesktopDirectError('INVALID_FRAME'); }
        if (!object(frame) || frame.requestId !== requestId || frame.sha256 !== expected.sha256 || frame.sizeBytes !== expected.sizeBytes)
          throw new DesktopDirectError('INVALID_FRAME');
        if (frame.type === 'metadata' && !metadata && keys(frame, ['type', 'requestId', 'attachmentVersionId', 'sha256', 'sizeBytes'])
          && frame.attachmentVersionId === expected.entityId) {
          metadata = true; buffer = new Uint8Array(expected.sizeBytes); return;
        }
        if (frame.type === 'eof' && metadata && keys(frame, ['type', 'requestId', 'sha256', 'sizeBytes']) && count === expected.sizeBytes && buffer) {
          received = true; const bytes = buffer; buffer = undefined; complete.resolve(bytes); return;
        }
        throw new DesktopDirectError('INVALID_FRAME');
      }
      const maximum = pc.sctp?.maxMessageSize;
      if (!(event.data instanceof ArrayBuffer) || !metadata || !buffer || event.data.byteLength < 1
        || event.data.byteLength > CHUNK_BYTES || (maximum && event.data.byteLength > maximum)
        || count + event.data.byteLength > expected.sizeBytes) throw new DesktopDirectError('INVALID_FRAME');
      buffer.set(new Uint8Array(event.data), count); count += event.data.byteLength;
      options.onProgress?.(count, expected.sizeBytes); check(true);
    } catch (error) { stop(error); }
  }) as EventListener);
  return {
    bytes: complete.promise, failure: failed.promise,
    async prepareOffer() {
      const timer = setTimeout(() => stop(new DesktopDirectError('TIMEOUT')), GATHER_MS);
      try {
        check();
        const offer = await wait(pc.createOffer());
        await wait(pc.setLocalDescription(offer));
        if (pc.iceGatheringState !== 'complete') {
          await wait(new Promise<void>((resolve) => {
            const changed = () => { if (pc.iceGatheringState === 'complete') resolve(); };
            listen(pc, 'icegatheringstatechange', changed); changed();
          }));
        }
        check(); const sdp = pc.localDescription?.sdp;
        if (!validDesktopSdp(sdp, capability.maxSdpBytes)) throw new DesktopDirectError('INVALID_SIGNAL');
        return sdp;
      } catch (error) { stop(error); throw error instanceof DesktopDirectError ? error : new DesktopDirectError('FAILED'); }
      finally { clearTimeout(timer); }
    },
    bindRequest(id) { check(); if (requestId) throw new DesktopDirectError('INVALID_FRAME'); requestId = id; },
    authorize(until, deadline) {
      check(); const now = Date.now();
      if (!Number.isFinite(until) || until <= now || until > now + 2000 || until > deadline
        || !Number.isFinite(deadline) || deadline <= now || (directDeadline && directDeadline !== deadline))
        throw new DesktopDirectError('AUTHORIZATION_EXPIRED');
      authorizedUntil = until;
      if (!directDeadline) { directDeadline = deadline; deadlineTimer = setTimeout(() => stop(new DesktopDirectError('TIMEOUT')), deadline - now); }
      clearTimeout(permitTimer);
      permitTimer = setTimeout(() => stop(new DesktopDirectError('AUTHORIZATION_EXPIRED')), until - now);
    },
    async acceptAnswer(value) {
      check(true);
      if (!validDesktopSdp(value, capability.maxSdpBytes) || (answer !== undefined && answer !== value)) throw new DesktopDirectError('INVALID_SIGNAL');
      if (answer !== undefined) return;
      answer = value;
      try { await wait(pc.setRemoteDescription({ type: 'answer', sdp: value }), true); }
      catch (error) { stop(error); throw error instanceof DesktopDirectError ? error : new DesktopDirectError('FAILED'); }
    },
    async acknowledge() {
      check(true);
      if (!received || !requestId || channel.readyState !== 'open') throw new DesktopDirectError('CLOSED');
      const frame = JSON.stringify({ type: 'ack', requestId, sha256: expected.sha256, sizeBytes: expected.sizeBytes });
      if (encoder.encode(frame).length > CONTROL_BYTES) throw new DesktopDirectError('INVALID_FRAME');
      channel.bufferedAmountLowThreshold = 0;
      try { channel.send(frame); } catch { throw new DesktopDirectError('FAILED'); }
      if (channel.bufferedAmount > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let drained: (() => void) | undefined;
        try {
          await wait(new Promise<void>((resolve, reject) => {
            drained = () => { if (channel.bufferedAmount === 0) resolve(); };
            channel.addEventListener('bufferedamountlow', drained);
            timer = setTimeout(() => reject(new DesktopDirectError('TIMEOUT')), 250); drained();
          }), true);
        } finally { clearTimeout(timer); if (drained) channel.removeEventListener('bufferedamountlow', drained); }
      }
      check(true);
    },
    close() { stop(new DesktopDirectError('CLOSED')); },
  };
}
