import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ENTITY_DATA_SCHEMAS, ISO_TIMESTAMP_PATTERN, UUID_PATTERN } from '../../packages/sync-core/src/index.ts';
import type { VerifiedIdentity } from './auth.ts';
import { SERVER_LIMITS } from './config.ts';
import { ApiError } from './errors.ts';
import type { DesktopPdfRepository, DesktopPdfTarget } from './types.ts';

export interface DesktopPdfTimings {
  requestTtlMs: number;
  pollTimeoutMs: number;
  presenceTtlMs: number;
  claimTimeoutMs: number;
  recheckIntervalMs: number;
  recheckTimeoutMs: number;
}
const defaults: DesktopPdfTimings = {
  requestTtlMs: SERVER_LIMITS.desktopPdfRequestTtlMs,
  pollTimeoutMs: SERVER_LIMITS.desktopPdfPollTimeoutMs,
  presenceTtlMs: SERVER_LIMITS.desktopPdfPresenceTtlMs,
  claimTimeoutMs: SERVER_LIMITS.desktopPdfClaimTimeoutMs,
  recheckIntervalMs: SERVER_LIMITS.desktopPdfRecheckIntervalMs,
  recheckTimeoutMs: SERVER_LIMITS.desktopPdfRecheckTimeoutMs,
};
export const DESKTOP_PDF_CAPABILITY = Object.freeze({
  transport: 'http-relay-v1',
  maxFileBytes: SERVER_LIMITS.desktopPdfMaxFileBytes,
  requestTtlMs: SERVER_LIMITS.desktopPdfRequestTtlMs,
  pollTimeoutMs: SERVER_LIMITS.desktopPdfPollTimeoutMs,
  byteWindowMs: SERVER_LIMITS.desktopPdfByteWindowMs,
  accountWindowBytes: SERVER_LIMITS.desktopPdfAccountWindowBytes,
  processWindowBytes: SERVER_LIMITS.desktopPdfProcessWindowBytes,
});

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Cancellation may precede the handler attaching to either half of a transfer.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function accountKey(identity: VerifiedIdentity): string { return JSON.stringify([identity.issuer, identity.subject]); }
function sessionKey(identity: VerifiedIdentity): string { return JSON.stringify([identity.issuer, identity.subject, identity.sessionId]); }
function sameSession(left: VerifiedIdentity, right: VerifiedIdentity): boolean {
  return left.issuer === right.issuer && left.subject === right.subject
    && left.sessionId === right.sessionId && left.clientId === right.clientId;
}
function checkedExpiry(identity: VerifiedIdentity): number {
  const expiry = identity.expiresAtMs;
  if (!Number.isSafeInteger(expiry) || expiry! <= Date.now()) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
  return expiry!;
}
function currentIdentity(request: FastifyRequest): VerifiedIdentity {
  if (!request.identity) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
  checkedExpiry(request.identity);
  return request.identity;
}
function connectionClosed(request: FastifyRequest, reply: FastifyReply): boolean {
  return request.raw.aborted || reply.raw.destroyed || reply.raw.writableEnded || request.raw.socket.destroyed;
}
function busy(seconds = 1): ApiError {
  return Object.assign(new ApiError('DESKTOP_PDF_TRANSFER_BUSY', 429), { retryAfterSeconds: seconds });
}
function unavailable(): ApiError { return new ApiError('DESKTOP_PDF_UNAVAILABLE', 404); }
function changed(): ApiError { return new ApiError('DESKTOP_PDF_CHANGED', 409); }
function timeout(): ApiError { return new ApiError('DESKTOP_PDF_TIMEOUT', 408); }

interface ProviderJob {
  requestId: string; attachmentVersionId: string; sha256: string; sizeBytes: number; expiresAt: string;
}
interface PollResult { request: ProviderJob | null }
interface Provider {
  key: string; account: string; identity: VerifiedIdentity; deviceId?: string;
  presentUntil: number; working: boolean; stopped: boolean; poll?: Deferred<PollResult>;
}
interface Assignment { key: string; identity: VerifiedIdentity; deviceId: string }
interface Consumer { request: FastifyRequest; reply: FastifyReply }
interface Lease {
  id: string; account: string; identity: VerifiedIdentity; target?: DesktopPdfTarget; consumerDeviceId?: string;
  expiresAtMs: number; deadlineAt: number; timer: ReturnType<typeof setTimeout>;
  state: 'creating' | 'waiting' | 'assigned' | 'uploading' | 'ended';
  consumer?: Consumer; assignment?: Assignment; tried: Set<string>;
  ready: Deferred<void>; delivered: Deferred<void>; output?: PassThrough;
  providerRequest?: FastifyRequest; providerReply?: FastifyReply;
  claimTimer?: ReturnType<typeof setTimeout>; recheckTimer?: ReturnType<typeof setInterval>;
  pendingChecks: number; uploadWorking: boolean; checking: boolean; dispatching: boolean;
}
interface ByteWindow { until: number; bytes: number }

/** Single-process, expiring rendezvous only. No file bytes or transfer state go to a database or disk. */
class DesktopPdfBroker {
  readonly repository: DesktopPdfRepository;
  readonly timings: DesktopPdfTimings;
  private readonly providers = new Map<string, Provider>();
  private readonly leases = new Map<string, Lease>();
  private readonly accountLeases = new Set<string>();
  private readonly byteWindows = new Map<string, ByteWindow>();
  private processBytes: ByteWindow = { until: 0, bytes: 0 };
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(repository: DesktopPdfRepository, timings: Partial<DesktopPdfTimings> = {}) {
    this.repository = repository;
    this.timings = { ...defaults, ...timings };
    for (const name of Object.keys(defaults) as (keyof DesktopPdfTimings)[]) {
      const value = this.timings[name];
      if (!Number.isSafeInteger(value) || value < 1 || value > defaults[name]) throw new ApiError('CONFIGURATION_INVALID', 500);
    }
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(1000, this.timings.presenceTtlMs));
    this.sweepTimer.unref();
  }

  private assertOpen(): void { if (this.closed) throw new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE', 503); }
  private assertLease(lease: Lease): void {
    if (lease.state === 'ended') throw changed();
    if (Date.now() >= lease.expiresAtMs || performance.now() >= lease.deadlineAt) { this.end(lease, timeout()); throw timeout(); }
    checkedExpiry(lease.identity);
    if (lease.assignment) checkedExpiry(lease.assignment.identity);
  }
  private release(lease: Lease): void {
    if (lease.state !== 'ended' || lease.pendingChecks || lease.uploadWorking) return;
    if (this.leases.get(lease.id) !== lease) return;
    this.leases.delete(lease.id);
    this.accountLeases.delete(lease.account);
  }
  private end(lease: Lease, error?: ApiError): void {
    if (lease.state === 'ended') return;
    lease.state = 'ended';
    clearTimeout(lease.timer); clearTimeout(lease.claimTimer); clearInterval(lease.recheckTimer);
    const reason = error ?? changed();
    lease.ready.reject(reason); lease.delivered.reject(reason);
    if (error) {
      lease.output?.destroy(reason);
      if (lease.consumer?.reply.raw.headersSent) lease.consumer.reply.raw.destroy();
      // A completely received body may still return a bounded JSON error. An unfinished body is cut off.
      if (lease.providerRequest && !lease.providerRequest.raw.complete) lease.providerRequest.raw.destroy();
      if (lease.providerReply?.raw.headersSent) lease.providerReply.raw.destroy();
    }
    this.release(lease);
  }
  private async checked<T>(lease: Lease | undefined, action: () => Promise<T>): Promise<T> {
    if (lease) { this.assertLease(lease); lease.pendingChecks++; }
    const work = Promise.resolve().then(action);
    const settled = () => { if (lease) { lease.pendingChecks--; this.release(lease); } };
    void work.then(settled, settled);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE', 503)), this.timings.recheckTimeoutMs);
      })]);
      if (lease) this.assertLease(lease);
      return result;
    } finally { clearTimeout(timer); }
  }
  private present(provider: Provider): boolean {
    return !provider.stopped && Boolean(provider.deviceId) && provider.presentUntil > performance.now()
      && (provider.identity.expiresAtMs ?? 0) > Date.now();
  }
  private candidates(lease: Lease): Provider[] {
    if (lease.tried.size >= SERVER_LIMITS.desktopPdfMaxAccountProviders) return [];
    return [...this.providers.values()].filter((provider) => this.present(provider) && provider.account === lease.account
      && provider.identity.sessionId !== lease.identity.sessionId && !lease.tried.has(provider.key)
      && provider.identity.expiresAtMs! >= lease.expiresAtMs);
  }
  private dropProvider(provider: Provider, error = unavailable(), stopAssignments = false): void {
    provider.stopped = true;
    provider.poll?.reject(error); provider.poll = undefined;
    if (!provider.working && this.providers.get(provider.key) === provider) this.providers.delete(provider.key);
    if (stopAssignments) for (const lease of this.leases.values()) {
      if (lease.assignment?.key === provider.key) this.end(lease, error);
    }
  }
  private sweep(): void {
    for (const provider of this.providers.values()) if (!this.present(provider) && !provider.working) this.dropProvider(provider);
    const now = performance.now();
    for (const [key, window] of this.byteWindows) if (window.until <= now) this.byteWindows.delete(key);
  }
  private charge(account: string, bytes: number): void {
    this.sweep();
    const now = performance.now(); const span = SERVER_LIMITS.desktopPdfByteWindowMs;
    if (this.processBytes.until <= now) this.processBytes = { until: now + span, bytes: 0 };
    let window = this.byteWindows.get(account);
    if (!window && this.byteWindows.size >= SERVER_LIMITS.desktopPdfMaxBudgetAccounts) throw busy(Math.ceil(span / 1000));
    window ??= { until: now + span, bytes: 0 };
    if (window.bytes + bytes > SERVER_LIMITS.desktopPdfAccountWindowBytes
      || this.processBytes.bytes + bytes > SERVER_LIMITS.desktopPdfProcessWindowBytes) {
      throw busy(Math.max(1, Math.ceil(Math.max(window.until, this.processBytes.until) - now) / 1000));
    }
    window.bytes += bytes; this.processBytes.bytes += bytes;
    this.byteWindows.set(account, window);
  }

  async poll(identity: VerifiedIdentity, request: FastifyRequest, reply: FastifyReply): Promise<PollResult> {
    this.assertOpen(); const expiry = checkedExpiry(identity); this.sweep();
    if (expiry - Date.now() < this.timings.requestTtlMs) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
    // The app's ordinary idle socket timeout is shorter than a long poll.
    // This request is still bounded by its own fixed timer below.
    reply.raw.setTimeout(this.timings.pollTimeoutMs + 1000, () => reply.raw.destroy());
    const key = sessionKey(identity); const account = accountKey(identity);
    let provider = this.providers.get(key);
    if (provider?.working || provider?.poll) throw new ApiError('DESKTOP_PDF_REQUEST_IN_USE', 409);
    if (!provider) {
      if (this.providers.size >= SERVER_LIMITS.desktopPdfMaxProviders
        || [...this.providers.values()].filter((item) => item.account === account).length >= SERVER_LIMITS.desktopPdfMaxAccountProviders) throw busy();
      provider = { key, account, identity: { ...identity }, presentUntil: 0, working: false, stopped: false };
      this.providers.set(key, provider);
    }
    const entry = provider;
    entry.identity = { ...identity }; entry.working = true; entry.stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disconnected = () => { if (!reply.raw.writableFinished) this.dropProvider(entry, unavailable(), true); };
    reply.raw.once('close', disconnected); request.raw.once('aborted', disconnected);
    try {
      // Keep the provider slot while its DB work is unresolved, including after timeout/disconnect.
      const work = this.repository.desktopPdfSession(identity);
      void work.then(() => {
        entry.working = false;
        if (entry.stopped && this.providers.get(key) === entry) this.providers.delete(key);
      }, () => {
        entry.working = false;
        if (entry.stopped && this.providers.get(key) === entry) this.providers.delete(key);
      });
      const session = await this.checked(undefined, () => work);
      if (entry.stopped || connectionClosed(request, reply)) throw unavailable();
      if (!['windows', 'macos', 'linux'].includes(session.device.platform)) throw new ApiError('DESKTOP_PDF_PROVIDER_REQUIRED', 403);
      entry.deviceId = session.device.id;
      entry.presentUntil = performance.now() + Math.min(this.timings.presenceTtlMs, expiry - Date.now());
      const pending = deferred<PollResult>(); entry.poll = pending;
      timer = setTimeout(() => pending.resolve({ request: null }), Math.max(1, Math.min(this.timings.pollTimeoutMs, expiry - Date.now())));
      this.dispatch();
      return await pending.promise;
    } catch (error) { this.dropProvider(entry); throw error; }
    finally {
      clearTimeout(timer); entry.poll = undefined;
      reply.raw.removeListener('close', disconnected); request.raw.removeListener('aborted', disconnected);
    }
  }

  stopProvider(identity: VerifiedIdentity): void {
    const provider = this.providers.get(sessionKey(identity));
    if (provider) this.dropProvider(provider, unavailable(), true);
    for (const lease of this.leases.values()) if (lease.assignment && sameSession(lease.assignment.identity, identity)) this.end(lease, unavailable());
    this.dispatch();
  }
  revokeDevice(identity: VerifiedIdentity, deviceId: string): void {
    const account = accountKey(identity);
    for (const provider of this.providers.values()) if (provider.account === account && provider.deviceId === deviceId) this.dropProvider(provider, unavailable(), true);
    for (const lease of this.leases.values()) if (lease.account === account) {
      if (lease.consumerDeviceId === deviceId) this.end(lease, new ApiError('SESSION_REVOKED', 403));
      else if (lease.assignment?.deviceId === deviceId) this.end(lease, unavailable());
    }
  }

  async create(identity: VerifiedIdentity, versionId: string, request: FastifyRequest, reply: FastifyReply) {
    this.assertOpen(); const expiry = checkedExpiry(identity);
    const remaining = Math.min(this.timings.requestTtlMs, expiry - Date.now());
    if (remaining < Math.min(2000, this.timings.requestTtlMs)) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
    const account = accountKey(identity);
    if (this.accountLeases.has(account) || this.leases.size >= SERVER_LIMITS.desktopPdfMaxTransfers) throw busy();
    const lease: Lease = {
      id: randomUUID(), account, identity: { ...identity }, expiresAtMs: Date.now() + remaining, deadlineAt: performance.now() + remaining,
      state: 'creating', tried: new Set(), ready: deferred<void>(), delivered: deferred<void>(), pendingChecks: 0,
      uploadWorking: false, checking: false, dispatching: false, timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    lease.timer = setTimeout(() => this.end(lease, timeout()), remaining);
    this.leases.set(lease.id, lease); this.accountLeases.add(account);
    const disconnected = () => { if (!reply.raw.writableFinished) this.end(lease, changed()); };
    reply.raw.once('close', disconnected); request.raw.once('aborted', disconnected);
    try {
      lease.target = await this.checked(lease, () => this.repository.getDesktopPdfVersion(identity, versionId));
      if (connectionClosed(request, reply)) throw changed();
      const access = await this.checked(lease, () => this.repository.checkDesktopPdfTransfer(identity, null, lease.target!));
      lease.consumerDeviceId = access.consumerDeviceId;
      if (connectionClosed(request, reply)) throw changed();
      if (!this.candidates(lease).length) throw unavailable();
      this.charge(account, lease.target.version.data.sizeBytes);
      lease.state = 'waiting';
      return { requestId: lease.id, attachmentVersionId: versionId, expiresAt: new Date(lease.expiresAtMs).toISOString() };
    } catch (error) { this.end(lease, error instanceof ApiError ? error : new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE', 503)); throw error; }
    finally { reply.raw.removeListener('close', disconnected); request.raw.removeListener('aborted', disconnected); }
  }

  private owned(identity: VerifiedIdentity, id: string): Lease {
    const lease = this.leases.get(id);
    if (!lease || lease.state === 'ended' || !sameSession(identity, lease.identity)) throw new ApiError('NOT_FOUND', 404);
    this.assertLease(lease); return lease;
  }
  private assigned(identity: VerifiedIdentity, id: string): Lease {
    const lease = this.leases.get(id);
    if (!lease || lease.state === 'ended' || !lease.assignment || !sameSession(identity, lease.assignment.identity)) throw new ApiError('NOT_FOUND', 404);
    this.assertLease(lease); return lease;
  }
  cancel(identity: VerifiedIdentity, id: string): void { this.end(this.owned(identity, id), changed()); }

  async consume(identity: VerifiedIdentity, id: string, request: FastifyRequest, reply: FastifyReply): Promise<PassThrough> {
    const lease = this.owned(identity, id);
    if (lease.consumer) throw new ApiError('DESKTOP_PDF_REQUEST_IN_USE', 409);
    if (request.headers.range) throw new ApiError('VALIDATION_FAILED');
    reply.raw.setTimeout(Math.max(1, lease.expiresAtMs - Date.now()) + 1000, () => reply.raw.destroy());
    lease.consumer = { request, reply };
    let finished = false;
    const disconnected = () => { if (!finished && !reply.raw.writableFinished) this.end(lease, changed()); };
    reply.raw.once('close', disconnected); reply.raw.once('error', disconnected); request.raw.once('aborted', disconnected);
    reply.raw.once('finish', () => {
      finished = true;
      if (lease.state === 'uploading') lease.delivered.resolve(undefined);
      else if (lease.state !== 'ended') this.end(lease, changed());
    });
    try {
      await this.checked(lease, () => this.repository.checkDesktopPdfTransfer(lease.identity, null, lease.target!));
      if (connectionClosed(request, reply)) throw changed();
      lease.output = new PassThrough({ highWaterMark: SERVER_LIMITS.desktopPdfChunkBytes });
      lease.output.on('error', () => undefined);
      lease.recheckTimer = setInterval(() => { void this.recheck(lease); }, this.timings.recheckIntervalMs);
      this.dispatch();
      await lease.ready.promise; this.assertLease(lease);
      reply.type('application/pdf').header('Content-Length', lease.target!.version.data.sizeBytes)
        .header('Content-Disposition', 'attachment; filename="paper.pdf"').header('Accept-Ranges', 'none');
      return lease.output;
    } catch (error) { this.end(lease, error instanceof ApiError ? error : changed()); throw error; }
  }

  private async recheck(lease: Lease): Promise<void> {
    if (lease.state === 'ended' || lease.checking || lease.pendingChecks) return;
    lease.checking = true;
    try {
      await this.checked(lease, () => this.repository.checkDesktopPdfTransfer(lease.identity, lease.assignment?.identity ?? null, lease.target!));
    } catch (error) { this.end(lease, error instanceof ApiError ? error : new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE', 503)); }
    finally { lease.checking = false; }
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const lease of this.leases.values()) {
      if (lease.state !== 'waiting' || !lease.consumer || !lease.output || lease.dispatching) continue;
      const candidates = this.candidates(lease);
      if (!candidates.length) { this.end(lease, unavailable()); continue; }
      const provider = candidates.find((item) => item.poll && !item.working);
      if (!provider) continue;
      lease.dispatching = true; lease.state = 'assigned'; lease.tried.add(provider.key);
      lease.assignment = { key: provider.key, identity: { ...provider.identity }, deviceId: provider.deviceId! };
      void this.checked(lease, () => this.repository.checkDesktopPdfTransfer(lease.identity, lease.assignment!.identity, lease.target!)).then(() => {
        this.assertLease(lease);
        if (!provider.poll || provider.stopped || !this.present(provider)) throw unavailable();
        const data = lease.target!.version.data;
        provider.poll.resolve({ request: { requestId: lease.id, attachmentVersionId: lease.target!.version.entityId,
          sha256: data.sha256, sizeBytes: data.sizeBytes, expiresAt: new Date(lease.expiresAtMs).toISOString() } });
        provider.poll = undefined;
        const remaining = Math.max(1, lease.deadlineAt - performance.now());
        const requestEndsFirst = remaining <= this.timings.claimTimeoutMs;
        lease.claimTimer = setTimeout(() => {
          if (lease.state !== 'assigned') return;
          if (requestEndsFirst) { this.end(lease, timeout()); return; }
          lease.assignment = undefined; lease.state = 'waiting'; this.dispatch();
        }, Math.min(this.timings.claimTimeoutMs, remaining));
      }).catch((error: unknown) => {
        this.end(lease, error instanceof ApiError ? error : new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE', 503));
      }).finally(() => { lease.dispatching = false; });
    }
  }

  decline(identity: VerifiedIdentity, id: string): void {
    const lease = this.assigned(identity, id);
    if (lease.state !== 'assigned') throw new ApiError('DESKTOP_PDF_REQUEST_IN_USE', 409);
    clearTimeout(lease.claimTimer); lease.assignment = undefined; lease.state = 'waiting';
    this.dispatch();
  }

  async admitUpload(identity: VerifiedIdentity, id: string, request: FastifyRequest, reply: FastifyReply): Promise<Lease> {
    const lease = this.assigned(identity, id);
    if (lease.state !== 'assigned') throw new ApiError('DESKTOP_PDF_REQUEST_IN_USE', 409);
    const data = lease.target!.version.data;
    const length = request.headers['content-length'];
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/pdf'
      || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) throw new ApiError('UNSUPPORTED_CONTENT_TYPE', 415);
    if (length === undefined || !/^[0-9]+$/.test(length) || Number(length) !== data.sizeBytes) {
      throw new ApiError(Number(length) > SERVER_LIMITS.desktopPdfMaxFileBytes ? 'REQUEST_TOO_LARGE' : 'PDF_INTEGRITY_MISMATCH',
        Number(length) > SERVER_LIMITS.desktopPdfMaxFileBytes ? 413 : 422);
    }
    if (checkedExpiry(identity) < lease.expiresAtMs) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
    reply.raw.setTimeout(Math.max(1, lease.expiresAtMs - Date.now()) + 1000, () => reply.raw.destroy());
    lease.state = 'uploading'; clearTimeout(lease.claimTimer);
    lease.providerRequest = request; lease.providerReply = reply;
    const disconnected = () => { if (!reply.raw.writableFinished) this.end(lease, changed()); };
    reply.raw.once('close', disconnected); request.raw.once('aborted', disconnected);
    try {
      // A refreshed token is verified anew, but never extends the fixed transfer deadline.
      const provider = { ...identity };
      const access = await this.checked(lease, () => this.repository.checkDesktopPdfTransfer(lease.identity, provider, lease.target!));
      if (access.providerDeviceId !== lease.assignment!.deviceId || connectionClosed(request, reply)) throw changed();
      return lease;
    } catch (error) {
      lease.uploadWorking = false;
      this.end(lease, error instanceof ApiError ? error : new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE', 503));
      this.release(lease); throw error;
    }
  }

  async upload(lease: Lease, input: Readable): Promise<{ sent: true }> {
    lease.uploadWorking = true;
    const data = lease.target!.version.data;
    const broker = this;
    async function* verifiedChunks(): AsyncGenerator<Buffer> {
      const hash = createHash('sha256'); let count = 0;
      let head = Buffer.alloc(0); let tail = Buffer.alloc(0); let held: Buffer | undefined;
      for await (const item of input) {
        const raw = Buffer.isBuffer(item) ? item : Buffer.from(item);
        for (let start = 0; start < raw.byteLength; start += SERVER_LIMITS.desktopPdfChunkBytes) {
          broker.assertLease(lease);
          const chunk = raw.subarray(start, Math.min(raw.byteLength, start + SERVER_LIMITS.desktopPdfChunkBytes));
          count += chunk.byteLength;
          if (count > data.sizeBytes || count > SERVER_LIMITS.desktopPdfMaxFileBytes) throw new ApiError('PDF_INTEGRITY_MISMATCH', 422);
          hash.update(chunk);
          if (head.byteLength < 5) head = Buffer.concat([head, chunk.subarray(0, 5 - head.byteLength)]);
          if (head.byteLength === 5 && head.toString('ascii') !== '%PDF-') throw new ApiError('INVALID_PDF', 415);
          tail = chunk.byteLength >= 1024 ? Buffer.from(chunk.subarray(chunk.byteLength - 1024))
            : Buffer.concat([tail, chunk]).subarray(Math.max(0, tail.byteLength + chunk.byteLength - 1024));
          if (held) yield held;
          held = Buffer.from(chunk);
        }
      }
      if (count !== data.sizeBytes || hash.digest('hex') !== data.sha256) throw new ApiError('PDF_INTEGRITY_MISMATCH', 422);
      if (head.toString('ascii') !== '%PDF-' || !tail.includes(Buffer.from('%%EOF'))) throw new ApiError('INVALID_PDF', 415);
      // Do not release the last bytes until integrity AND live authorization have passed.
      await broker.checked(lease, () => broker.repository.checkDesktopPdfTransfer(lease.identity, lease.assignment!.identity, lease.target!));
      broker.assertLease(lease);
      if (held) yield held;
    }
    try {
      this.assertLease(lease); lease.ready.resolve(undefined);
      const source = Readable.from(verifiedChunks(), { objectMode: false, highWaterMark: SERVER_LIMITS.desktopPdfChunkBytes });
      await pipeline(source, lease.output!);
      await lease.delivered.promise;
      this.assertLease(lease); this.end(lease);
      return { sent: true };
    } catch (error) {
      const safe = error instanceof ApiError ? error : changed();
      this.end(lease, safe); input.destroy(); throw safe;
    } finally { lease.uploadWorking = false; this.release(lease); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.sweepTimer);
    for (const provider of this.providers.values()) this.dropProvider(provider, new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE', 503), true);
    for (const lease of this.leases.values()) this.end(lease, new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE', 503));
    this.byteWindows.clear();
  }
}

const uuid = { type: 'string', pattern: UUID_PATTERN };
const empty = { type: 'object', additionalProperties: false, properties: {} };
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };
const targetSchema = { type: 'object', additionalProperties: false, required: ['paper', 'version'], properties: {
  paper: { type: 'object', additionalProperties: false, required: ['entityId', 'revision', 'title'], properties: {
    entityId: uuid, revision: { type: 'integer', minimum: 1 }, title: { type: 'string' },
  } },
  version: { type: 'object', additionalProperties: false, required: ['entityId', 'revision', 'data'], properties: {
    entityId: uuid, revision: { type: 'integer', minimum: 1 }, data: ENTITY_DATA_SCHEMAS.attachmentVersion,
  } },
} };
const time = { type: 'string', pattern: ISO_TIMESTAMP_PATTERN, format: 'date-time' };
const requestSchema = { type: 'object', additionalProperties: false, required: ['requestId', 'attachmentVersionId', 'expiresAt'], properties: {
  requestId: uuid, attachmentVersionId: uuid, expiresAt: time,
} };
const jobSchema = { ...requestSchema, required: [...requestSchema.required, 'sha256', 'sizeBytes'], properties: {
  ...requestSchema.properties, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  sizeBytes: { type: 'integer', minimum: 1, maximum: SERVER_LIMITS.desktopPdfMaxFileBytes },
} };

interface DesktopRouteOptions {
  enabled: boolean; repository?: DesktopPdfRepository;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Isolated tests may shorten deadlines; process environment cannot change them. */
  timings?: Partial<DesktopPdfTimings>;
}
export interface DesktopPdfRouteControl { revokeDevice(identity: VerifiedIdentity, deviceId: string): void }

export async function registerDesktopPdfRoutes(app: FastifyInstance, options: DesktopRouteOptions): Promise<DesktopPdfRouteControl> {
  if (options.enabled && !options.repository) throw new ApiError('CONFIGURATION_INVALID', 500);
  const broker = options.enabled ? new DesktopPdfBroker(options.repository!, options.timings) : undefined;
  const repository = () => {
    if (!options.enabled || !options.repository) throw new ApiError('DESKTOP_PDF_TRANSFER_DISABLED', 503);
    return options.repository;
  };
  app.addHook('preClose', async () => { broker?.close(); });
  const admissions = new WeakMap<FastifyRequest, Lease>();
  await app.register(async (desktop) => {
    desktop.addContentTypeParser('application/pdf', (_request, payload, done) => done(null, payload));
    desktop.addHook('onError', async (_request, reply, error) => {
      if (error instanceof ApiError && error.code === 'DESKTOP_PDF_TRANSFER_BUSY') {
        const retry = (error as ApiError & { retryAfterSeconds?: number }).retryAfterSeconds ?? 1;
        reply.header('Retry-After', Math.max(1, Math.min(900, Math.ceil(retry))));
      }
    });
    const onRequest = [options.authenticate, async (request: FastifyRequest) => { repository(); currentIdentity(request); }];
    desktop.get<{ Querystring: { after?: string; limit?: string } }>('/v1/desktop-pdfs/versions', {
      onRequest, schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        after: uuid, limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
      } }, response: { 200: { type: 'object', additionalProperties: false, required: ['items', 'nextAfter', 'hasMore'], properties: {
        items: { type: 'array', maxItems: 100, items: targetSchema },
        nextAfter: { anyOf: [uuid, { type: 'null' }] }, hasMore: { type: 'boolean' },
      } } } },
    }, async (request) => {
      const limit = Number(request.query.limit ?? 25);
      if (limit > 100) throw new ApiError('VALIDATION_FAILED');
      return repository().listDesktopPdfVersions(currentIdentity(request), request.query.after, limit);
    });
    desktop.get<{ Params: { id: string } }>('/v1/desktop-pdfs/versions/:id', {
      onRequest, schema: { params, querystring: empty, response: { 200: targetSchema } },
    }, async (request) => repository().getDesktopPdfVersion(currentIdentity(request), request.params.id));
    desktop.post('/v1/desktop-pdfs/provider/poll', {
      onRequest, schema: { body: empty, querystring: empty, response: { 200: {
        type: 'object', additionalProperties: false, required: ['request'], properties: { request: { anyOf: [jobSchema, { type: 'null' }] } },
      } } },
    }, async (request, reply) => broker!.poll(currentIdentity(request), request, reply));
    desktop.delete('/v1/desktop-pdfs/provider', { onRequest, schema: { querystring: empty } }, async (request) => {
      await repository().desktopPdfSession(currentIdentity(request));
      broker!.stopProvider(currentIdentity(request)); return { stopped: true };
    });
    desktop.post<{ Body: { attachmentVersionId: string } }>('/v1/desktop-pdfs/requests', {
      onRequest, schema: { querystring: empty, body: { type: 'object', additionalProperties: false, required: ['attachmentVersionId'],
        properties: { attachmentVersionId: uuid } }, response: { 201: requestSchema } },
    }, async (request, reply) => {
      const result = await broker!.create(currentIdentity(request), request.body.attachmentVersionId, request, reply);
      return reply.code(201).send(result);
    });
    desktop.get<{ Params: { id: string } }>('/v1/desktop-pdfs/requests/:id/content', {
      onRequest, schema: { params, querystring: empty },
    }, async (request, reply) => reply.send(await broker!.consume(currentIdentity(request), request.params.id, request, reply)));
    desktop.post<{ Params: { id: string }; Body: Readable }>('/v1/desktop-pdfs/requests/:id/content', {
      bodyLimit: SERVER_LIMITS.desktopPdfMaxFileBytes,
      onRequest: [...onRequest, async (request, reply) => {
        if (!new RegExp(UUID_PATTERN).test(request.params.id) || Object.keys(request.query as object).length) throw new ApiError('VALIDATION_FAILED');
        admissions.set(request, await broker!.admitUpload(currentIdentity(request), request.params.id, request, reply));
      }], schema: { params, querystring: empty },
    }, async (request) => broker!.upload(admissions.get(request)!, request.body));
    desktop.post<{ Params: { id: string } }>('/v1/desktop-pdfs/requests/:id/unavailable', {
      onRequest, schema: { params, querystring: empty, body: empty },
    }, async (request) => { broker!.decline(currentIdentity(request), request.params.id); return { acknowledged: true }; });
    desktop.delete<{ Params: { id: string } }>('/v1/desktop-pdfs/requests/:id', {
      onRequest, schema: { params, querystring: empty },
    }, async (request) => { broker!.cancel(currentIdentity(request), request.params.id); return { cancelled: true }; });
  });
  return { revokeDevice: (identity, deviceId) => broker?.revokeDevice(identity, deviceId) };
}
