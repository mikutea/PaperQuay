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
  directAttemptMs: number;
  directAuthorizationMs: number;
  directReceiptMs: number;
}
const defaults: DesktopPdfTimings = {
  requestTtlMs: SERVER_LIMITS.desktopPdfRequestTtlMs,
  pollTimeoutMs: SERVER_LIMITS.desktopPdfPollTimeoutMs,
  presenceTtlMs: SERVER_LIMITS.desktopPdfPresenceTtlMs,
  claimTimeoutMs: SERVER_LIMITS.desktopPdfClaimTimeoutMs,
  recheckIntervalMs: SERVER_LIMITS.desktopPdfRecheckIntervalMs,
  recheckTimeoutMs: SERVER_LIMITS.desktopPdfRecheckTimeoutMs,
  directAttemptMs: SERVER_LIMITS.desktopPdfDirectAttemptMs,
  directAuthorizationMs: SERVER_LIMITS.desktopPdfDirectAuthorizationMs,
  directReceiptMs: SERVER_LIMITS.desktopPdfDirectReceiptMs,
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
export function desktopPdfCapability(stunUrls: readonly string[]) {
  return { ...DESKTOP_PDF_CAPABILITY, direct: { transport: 'webrtc-data-v1',
    attemptMs: SERVER_LIMITS.desktopPdfDirectAttemptMs, maxSdpBytes: SERVER_LIMITS.desktopPdfDirectMaxSdpBytes,
    stunUrls: [...stunUrls] } };
}

/** Bounded signaling only; the server never interprets candidates as network destinations. */
function checkedSdp(value: string): string {
  if (!value || Buffer.byteLength(value, 'utf8') > SERVER_LIMITS.desktopPdfDirectMaxSdpBytes
    || /[^\x20-\x7e\r\n]/.test(value)) throw new ApiError('VALIDATION_FAILED');
  const lines = value.split(/\r?\n/).filter(Boolean);
  const media = lines.filter((line) => line.startsWith('m='));
  const candidates = lines.filter((line) => line.startsWith('a=candidate:'));
  if (lines[0] !== 'v=0' || lines.length > 512 || lines.some((line) => line.length > 1024)
    || media.length !== 1 || !/^m=application [0-9]+ (?:UDP\/DTLS\/SCTP|DTLS\/SCTP) webrtc-datachannel$/.test(media[0])
    || candidates.length > SERVER_LIMITS.desktopPdfDirectMaxCandidates
    || candidates.some((line) => /\btyp\s+relay(?:\s|$)/i.test(line))) throw new ApiError('VALIDATION_FAILED');
  return value;
}

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
function inUse(): ApiError { return new ApiError('DESKTOP_PDF_REQUEST_IN_USE', 409); }
function directFallback(): ApiError { return new ApiError('DESKTOP_PDF_DIRECT_FALLBACK', 409); }
function safeFailure(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE', 503);
}

interface ProviderJob {
  requestId: string; attachmentVersionId: string; sha256: string; sizeBytes: number; expiresAt: string;
  direct?: { offer: string; expiresAt: string };
}
interface PollResult { request: ProviderJob | null }
interface Provider {
  key: string; account: string; identity: VerifiedIdentity; deviceId?: string;
  presentUntil: number; working: boolean; stopped: boolean; poll?: Deferred<PollResult>;
  direct: boolean;
}
interface Assignment { key: string; identity: VerifiedIdentity; deviceId: string }
interface Consumer { request: FastifyRequest; reply: FastifyReply }
type DirectRole = 'consumer' | 'provider';
interface DirectTransfer {
  state: 'direct' | 'relay'; offer?: string; answer?: string;
  expiresAtMs: number; deadlineAt: number; timer?: ReturnType<typeof setTimeout>;
  providerFinalChecked: boolean; busyRoles: Set<DirectRole>;
}
interface DirectReceipt {
  id: string; account: string; identity: VerifiedIdentity; provider: VerifiedIdentity; target: DesktopPdfTarget;
  consumerDeviceId: string; providerDeviceId: string;
  expiresAtMs: number; directExpiresAtMs: number; until: number; deadlineAt: number;
  pendingChecks: number; busyRoles: Set<DirectRole>;
}
interface DirectStatus {
  state: 'direct' | 'relay' | 'complete'; answer: string | null;
  expiresAt: string; directExpiresAt: string; authorizedUntil: string | null; relayReady: boolean;
}
interface Lease {
  id: string; account: string; identity: VerifiedIdentity; target?: DesktopPdfTarget; consumerDeviceId?: string;
  expiresAtMs: number; deadlineAt: number; timer: ReturnType<typeof setTimeout>;
  state: 'creating' | 'waiting' | 'assigned' | 'uploading' | 'ended';
  consumer?: Consumer; assignment?: Assignment; tried: Set<string>;
  ready: Deferred<void>; delivered: Deferred<void>; output?: PassThrough;
  providerRequest?: FastifyRequest; providerReply?: FastifyReply;
  claimTimer?: ReturnType<typeof setTimeout>; recheckTimer?: ReturnType<typeof setInterval>;
  pendingChecks: number; uploadWorking: boolean; checking: boolean; dispatching: boolean;
  direct?: DirectTransfer;
}
interface ByteWindow { until: number; bytes: number }

/** Single-process, expiring rendezvous only. No file bytes or transfer state go to a database or disk. */
class DesktopPdfBroker {
  readonly repository: DesktopPdfRepository;
  readonly timings: DesktopPdfTimings;
  private readonly providers = new Map<string, Provider>();
  private readonly leases = new Map<string, Lease>();
  private readonly accountLeases = new Set<string>();
  private readonly receipts = new Map<string, DirectReceipt>();
  private readonly receiptReservations = new Set<string>();
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
    if (lease.direct?.state === 'direct' && (Date.now() >= lease.direct.expiresAtMs || performance.now() >= lease.direct.deadlineAt)) {
      this.toRelay(lease);
    }
  }
  private release(lease: Lease): void {
    if (lease.state !== 'ended' || lease.pendingChecks || lease.uploadWorking) return;
    if (this.leases.get(lease.id) !== lease) return;
    this.leases.delete(lease.id);
    this.accountLeases.delete(lease.account);
    this.receiptReservations.delete(lease.id);
  }
  private end(lease: Lease, error?: ApiError): void {
    if (lease.state === 'ended') return;
    lease.state = 'ended';
    clearTimeout(lease.timer); clearTimeout(lease.claimTimer); clearInterval(lease.recheckTimer);
    if (lease.direct) {
      clearTimeout(lease.direct.timer); lease.direct.offer = undefined; lease.direct.answer = undefined;
      lease.direct.providerFinalChecked = false;
    }
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
    for (const receipt of this.receipts.values()) {
      if ((receipt.until <= Date.now() || receipt.deadlineAt <= now) && !receipt.pendingChecks) this.receipts.delete(receipt.id);
    }
  }

  private startRechecks(lease: Lease): void {
    lease.recheckTimer ??= setInterval(() => { void this.recheck(lease); }, this.timings.recheckIntervalMs);
  }
  /** Irreversible local state change. Existing content endpoints still perform their own fresh authorization. */
  private toRelay(lease: Lease): void {
    if (lease.state === 'ended' || !lease.direct || lease.direct.state === 'relay') return;
    lease.direct.state = 'relay'; clearTimeout(lease.direct.timer);
    lease.direct.offer = undefined; lease.direct.answer = undefined; lease.direct.providerFinalChecked = false;
    this.receiptReservations.delete(lease.id);
    this.dispatch();
  }
  private directRole(identity: VerifiedIdentity, consumer: VerifiedIdentity, provider?: VerifiedIdentity): DirectRole {
    if (sameSession(identity, consumer)) return 'consumer';
    if (provider && sameSession(identity, provider)) return 'provider';
    throw new ApiError('NOT_FOUND', 404);
  }
  private directLease(identity: VerifiedIdentity, id: string): { lease: Lease; role: DirectRole } {
    const lease = this.leases.get(id);
    if (!lease || lease.state === 'ended' || !lease.direct) throw new ApiError('NOT_FOUND', 404);
    const role = this.directRole(identity, lease.identity, lease.assignment?.identity);
    this.assertLease(lease); return { lease, role };
  }
  private receipt(identity: VerifiedIdentity, id: string): { receipt: DirectReceipt; role: DirectRole } | undefined {
    const receipt = this.receipts.get(id);
    if (!receipt) return undefined;
    const role = this.directRole(identity, receipt.identity, receipt.provider);
    this.assertReceipt(receipt); return { receipt, role };
  }
  private discardReceipt(receipt: DirectReceipt): void {
    receipt.until = 0; receipt.deadlineAt = 0;
    if (!receipt.pendingChecks && this.receipts.get(receipt.id) === receipt) this.receipts.delete(receipt.id);
  }
  private assertReceipt(receipt: DirectReceipt): void {
    if (this.closed || this.receipts.get(receipt.id) !== receipt || Date.now() >= receipt.until || performance.now() >= receipt.deadlineAt) {
      this.discardReceipt(receipt); throw new ApiError('NOT_FOUND', 404);
    }
    checkedExpiry(receipt.identity); checkedExpiry(receipt.provider);
  }
  private async validateDirect(lease: Lease): Promise<void> {
    const assignment = lease.assignment;
    try {
      const access = await this.checked(lease, () => this.repository.checkDesktopPdfTransfer(lease.identity, assignment?.identity ?? null, lease.target!));
      if (access.consumerDeviceId !== lease.consumerDeviceId || (assignment && access.providerDeviceId !== assignment.deviceId)) throw changed();
    } catch (error) { this.end(lease, safeFailure(error)); throw error; }
    if (lease.assignment !== assignment) throw inUse();
  }
  private async directAction<T>(lease: Lease, role: DirectRole, identity: VerifiedIdentity,
    request: FastifyRequest, reply: FastifyReply, action: () => T): Promise<T> {
    const direct = lease.direct!;
    if (direct.busyRoles.has(role)) throw inUse();
    direct.busyRoles.add(role);
    try {
      await this.validateDirect(lease);
      checkedExpiry(identity);
      if (this.directRole(identity, lease.identity, lease.assignment?.identity) !== role) throw new ApiError('NOT_FOUND', 404);
      if (connectionClosed(request, reply)) throw changed();
      return action();
    } finally { direct.busyRoles.delete(role); }
  }
  private async receiptAction<T>(receipt: DirectReceipt, role: DirectRole, identity: VerifiedIdentity,
    request: FastifyRequest, reply: FastifyReply, action: () => T): Promise<T> {
    if (receipt.busyRoles.has(role)) throw inUse();
    receipt.busyRoles.add(role); receipt.pendingChecks++;
    const work = Promise.resolve().then(() => this.repository.checkDesktopPdfTransfer(receipt.identity, receipt.provider, receipt.target));
    const settled = () => {
      receipt.pendingChecks--;
      if (!receipt.pendingChecks && (Date.now() >= receipt.until || performance.now() >= receipt.deadlineAt)) this.receipts.delete(receipt.id);
    };
    void work.then(settled, settled);
    try {
      try {
        const access = await this.checked(undefined, () => work);
        this.assertReceipt(receipt);
        if (access.consumerDeviceId !== receipt.consumerDeviceId || access.providerDeviceId !== receipt.providerDeviceId) throw changed();
      } catch (error) { this.discardReceipt(receipt); throw error; }
      checkedExpiry(identity);
      if (connectionClosed(request, reply)) throw changed();
      return action();
    } finally { receipt.busyRoles.delete(role); }
  }
  private authorizationUntil(lease: Lease, identity: VerifiedIdentity): string {
    return new Date(Math.min(Date.now() + this.timings.directAuthorizationMs, lease.direct!.expiresAtMs,
      lease.expiresAtMs, checkedExpiry(identity))).toISOString();
  }
  private receiptStatus(receipt: DirectReceipt): DirectStatus {
    return { state: 'complete', answer: null, expiresAt: new Date(receipt.expiresAtMs).toISOString(),
      directExpiresAt: new Date(receipt.directExpiresAtMs).toISOString(), authorizedUntil: null, relayReady: false };
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

  async poll(identity: VerifiedIdentity, request: FastifyRequest, reply: FastifyReply, direct = false): Promise<PollResult> {
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
      provider = { key, account, identity: { ...identity }, presentUntil: 0, working: false, stopped: false, direct };
      this.providers.set(key, provider);
    }
    const entry = provider;
    entry.identity = { ...identity }; entry.working = true; entry.stopped = false; entry.direct = direct;
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
    for (const receipt of this.receipts.values()) if (receipt.account === account
      && (receipt.consumerDeviceId === deviceId || receipt.providerDeviceId === deviceId)) this.discardReceipt(receipt);
  }

  async create(identity: VerifiedIdentity, versionId: string, request: FastifyRequest, reply: FastifyReply, offer?: string) {
    this.assertOpen(); const expiry = checkedExpiry(identity);
    if (offer !== undefined) checkedSdp(offer);
    this.sweep();
    const remaining = Math.min(this.timings.requestTtlMs, expiry - Date.now());
    if (remaining < Math.min(2000, this.timings.requestTtlMs)) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
    const account = accountKey(identity);
    if (this.accountLeases.has(account) || this.leases.size >= SERVER_LIMITS.desktopPdfMaxTransfers) throw busy();
    if (offer !== undefined && this.receipts.size + this.receiptReservations.size >= SERVER_LIMITS.desktopPdfDirectMaxReceipts) throw busy();
    const lease: Lease = {
      id: randomUUID(), account, identity: { ...identity }, expiresAtMs: Date.now() + remaining, deadlineAt: performance.now() + remaining,
      state: 'creating', tried: new Set(), ready: deferred<void>(), delivered: deferred<void>(), pendingChecks: 0,
      uploadWorking: false, checking: false, dispatching: false, timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    lease.timer = setTimeout(() => this.end(lease, timeout()), remaining);
    this.leases.set(lease.id, lease); this.accountLeases.add(account);
    if (offer !== undefined) {
      const directRemaining = Math.min(remaining, this.timings.directAttemptMs);
      lease.direct = { state: 'direct', offer, expiresAtMs: Math.min(lease.expiresAtMs, Date.now() + directRemaining),
        deadlineAt: Math.min(lease.deadlineAt, performance.now() + directRemaining), providerFinalChecked: false, busyRoles: new Set() };
      lease.direct.timer = setTimeout(() => this.toRelay(lease), directRemaining);
      this.receiptReservations.add(lease.id);
    }
    const disconnected = () => { if (!reply.raw.writableFinished) this.end(lease, changed()); };
    reply.raw.once('close', disconnected); request.raw.once('aborted', disconnected);
    try {
      lease.target = await this.checked(lease, () => this.repository.getDesktopPdfVersion(identity, versionId));
      if (connectionClosed(request, reply)) throw changed();
      const access = await this.checked(lease, () => this.repository.checkDesktopPdfTransfer(identity, null, lease.target!));
      lease.consumerDeviceId = access.consumerDeviceId;
      if (connectionClosed(request, reply)) throw changed();
      const candidates = this.candidates(lease);
      if (!candidates.length) throw unavailable();
      this.charge(account, lease.target.version.data.sizeBytes);
      lease.state = 'waiting';
      if (lease.direct) {
        if (!candidates.some((provider) => provider.direct)) this.toRelay(lease);
        this.startRechecks(lease); this.dispatch();
      }
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

  async directStatus(identity: VerifiedIdentity, id: string, request: FastifyRequest, reply: FastifyReply): Promise<DirectStatus> {
    const completed = this.receipt(identity, id);
    if (completed) return this.receiptAction(completed.receipt, completed.role, identity, request, reply, () => this.receiptStatus(completed.receipt));
    const { lease, role } = this.directLease(identity, id);
    try {
      return await this.directAction(lease, role, identity, request, reply, () => ({
        state: lease.direct!.state, answer: lease.direct!.state === 'direct' ? lease.direct!.answer ?? null : null,
        expiresAt: new Date(lease.expiresAtMs).toISOString(), directExpiresAt: new Date(lease.direct!.expiresAtMs).toISOString(),
        authorizedUntil: lease.direct!.state === 'direct' ? this.authorizationUntil(lease, identity) : null,
        relayReady: lease.direct!.state === 'relay' && lease.state === 'assigned' && Boolean(lease.consumer && lease.output),
      }));
    } catch (error) {
      // Completion may win while this poll is checking the database. Its short
      // receipt is installed before the active lease is removed.
      const receipt = this.receipt(identity, id);
      if (receipt) return this.receiptAction(receipt.receipt, receipt.role, identity, request, reply, () => this.receiptStatus(receipt.receipt));
      throw error;
    }
  }

  async directAnswer(identity: VerifiedIdentity, id: string, sdp: string, request: FastifyRequest, reply: FastifyReply): Promise<{ accepted: true }> {
    const { lease, role } = this.directLease(identity, id);
    if (role !== 'provider') throw new ApiError('NOT_FOUND', 404);
    checkedSdp(sdp);
    return this.directAction(lease, role, identity, request, reply, () => {
      if (lease.direct!.state !== 'direct') throw directFallback();
      if (lease.direct!.answer !== undefined && lease.direct!.answer !== sdp) throw inUse();
      lease.direct!.answer = sdp; return { accepted: true };
    });
  }

  async directAuthorize(identity: VerifiedIdentity, id: string, request: FastifyRequest, reply: FastifyReply): Promise<{ authorizedUntil: string }> {
    const { lease, role } = this.directLease(identity, id);
    if (role !== 'provider') throw new ApiError('NOT_FOUND', 404);
    return this.directAction(lease, role, identity, request, reply, () => {
      if (lease.direct!.state !== 'direct') throw directFallback();
      if (!lease.direct!.answer) throw inUse();
      lease.direct!.providerFinalChecked = true;
      return { authorizedUntil: this.authorizationUntil(lease, identity) };
    });
  }

  async directComplete(identity: VerifiedIdentity, id: string, summary: { sha256: string; sizeBytes: number },
    request: FastifyRequest, reply: FastifyReply): Promise<{ received: true }> {
    const matches = (target: DesktopPdfTarget) => {
      if (summary.sha256 !== target.version.data.sha256 || summary.sizeBytes !== target.version.data.sizeBytes) {
        throw new ApiError('PDF_INTEGRITY_MISMATCH', 422);
      }
    };
    const completed = this.receipt(identity, id);
    if (completed) {
      if (completed.role !== 'consumer') throw new ApiError('NOT_FOUND', 404);
      matches(completed.receipt.target);
      return this.receiptAction(completed.receipt, completed.role, identity, request, reply, () => ({ received: true }));
    }
    const { lease, role } = this.directLease(identity, id);
    if (role !== 'consumer') throw new ApiError('NOT_FOUND', 404);
    matches(lease.target!);
    return this.directAction(lease, role, identity, request, reply, () => {
      const direct = lease.direct!;
      if (direct.state !== 'direct') throw directFallback();
      if (!lease.assignment || !direct.providerFinalChecked) throw inUse();
      const span = Math.min(this.timings.directReceiptMs, lease.expiresAtMs - Date.now(), lease.deadlineAt - performance.now());
      const receipt: DirectReceipt = {
        id: lease.id, account: lease.account, identity: { ...lease.identity }, provider: { ...lease.assignment.identity },
        target: structuredClone(lease.target!), consumerDeviceId: lease.consumerDeviceId!, providerDeviceId: lease.assignment.deviceId,
        expiresAtMs: lease.expiresAtMs, directExpiresAtMs: direct.expiresAtMs, until: Date.now() + span,
        // Preserve in-flight role ownership across the atomic completion. A
        // provider status check can still be waiting on the database here.
        deadlineAt: performance.now() + span, pendingChecks: 0, busyRoles: direct.busyRoles,
      };
      // No await between the final mode check, receipt installation and lease
      // termination. A competing fallback cannot also win this transition.
      this.receipts.set(id, receipt); this.receiptReservations.delete(id); this.end(lease);
      return { received: true };
    });
  }

  async directToRelay(identity: VerifiedIdentity, id: string, request: FastifyRequest, reply: FastifyReply): Promise<{ state: 'relay' }> {
    const completed = this.receipt(identity, id);
    if (completed) return this.receiptAction(completed.receipt, completed.role, identity, request, reply, () => { throw inUse(); });
    const { lease, role } = this.directLease(identity, id);
    try {
      return await this.directAction(lease, role, identity, request, reply, () => {
        this.toRelay(lease); return { state: 'relay' };
      });
    } catch (error) {
      const receipt = this.receipt(identity, id);
      if (receipt) return this.receiptAction(receipt.receipt, receipt.role, identity, request, reply, () => { throw inUse(); });
      throw error;
    }
  }

  async consume(identity: VerifiedIdentity, id: string, request: FastifyRequest, reply: FastifyReply): Promise<PassThrough> {
    const lease = this.owned(identity, id);
    if (lease.direct?.state === 'direct') throw inUse();
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
      this.startRechecks(lease);
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
      if (lease.state !== 'waiting' || lease.dispatching) continue;
      const direct = lease.direct?.state === 'direct';
      if (!direct && (!lease.consumer || !lease.output)) continue;
      let candidates = this.candidates(lease);
      if (!candidates.length) { this.end(lease, unavailable()); continue; }
      if (direct) {
        candidates = candidates.filter((provider) => provider.direct);
        if (!candidates.length) { this.toRelay(lease); continue; }
      }
      const provider = candidates.find((item) => item.poll && !item.working);
      if (!provider) continue;
      lease.dispatching = true; lease.state = 'assigned'; lease.tried.add(provider.key);
      lease.assignment = { key: provider.key, identity: { ...provider.identity }, deviceId: provider.deviceId! };
      void this.checked(lease, () => this.repository.checkDesktopPdfTransfer(lease.identity, lease.assignment!.identity, lease.target!)).then(() => {
        this.assertLease(lease);
        if (!provider.poll || provider.stopped || !this.present(provider)) throw unavailable();
        if (direct && lease.direct!.state !== 'direct' && (!lease.consumer || !lease.output)) {
          // The direct deadline elapsed while assignment validation was pending.
          // No job was delivered; wait for the consumer to attach its relay GET.
          lease.assignment = undefined; lease.state = 'waiting'; lease.tried.delete(provider.key); return;
        }
        const data = lease.target!.version.data;
        provider.poll.resolve({ request: { requestId: lease.id, attachmentVersionId: lease.target!.version.entityId,
          sha256: data.sha256, sizeBytes: data.sizeBytes, expiresAt: new Date(lease.expiresAtMs).toISOString(),
          ...(lease.direct?.state === 'direct' ? { direct: { offer: lease.direct.offer!, expiresAt: new Date(lease.direct.expiresAtMs).toISOString() } } : {}) } });
        provider.poll = undefined;
        if (lease.direct?.state === 'direct') return;
        const remaining = Math.max(1, lease.deadlineAt - performance.now());
        const requestEndsFirst = remaining <= this.timings.claimTimeoutMs;
        lease.claimTimer = setTimeout(() => {
          if (lease.state !== 'assigned') return;
          if (requestEndsFirst) { this.end(lease, timeout()); return; }
          lease.assignment = undefined; lease.state = 'waiting'; this.dispatch();
        }, Math.min(this.timings.claimTimeoutMs, remaining));
      }).catch((error: unknown) => {
        this.end(lease, error instanceof ApiError ? error : new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE', 503));
      }).finally(() => { lease.dispatching = false; this.dispatch(); });
    }
  }

  decline(identity: VerifiedIdentity, id: string): void {
    const lease = this.assigned(identity, id);
    if (lease.state !== 'assigned') throw new ApiError('DESKTOP_PDF_REQUEST_IN_USE', 409);
    this.toRelay(lease);
    clearTimeout(lease.claimTimer); lease.assignment = undefined; lease.state = 'waiting';
    this.dispatch();
  }

  async admitUpload(identity: VerifiedIdentity, id: string, request: FastifyRequest, reply: FastifyReply): Promise<Lease> {
    const lease = this.assigned(identity, id);
    if (lease.state !== 'assigned') throw new ApiError('DESKTOP_PDF_REQUEST_IN_USE', 409);
    if (lease.direct?.state === 'direct' || !lease.consumer || !lease.output) throw inUse();
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
    this.byteWindows.clear(); this.receipts.clear();
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
  direct: { type: 'object', additionalProperties: false, required: ['offer', 'expiresAt'], properties: {
    offer: { type: 'string', maxLength: SERVER_LIMITS.desktopPdfDirectMaxSdpBytes }, expiresAt: time,
  } },
} };
const sdpSchema = { type: 'string', minLength: 1, maxLength: SERVER_LIMITS.desktopPdfDirectMaxSdpBytes };
const signalBodyLimit = SERVER_LIMITS.desktopPdfDirectMaxSdpBytes * 2 + 1024;
const directStatusSchema = { type: 'object', additionalProperties: false,
  required: ['state', 'answer', 'expiresAt', 'directExpiresAt', 'authorizedUntil', 'relayReady'], properties: {
    state: { enum: ['direct', 'relay', 'complete'] }, answer: { anyOf: [sdpSchema, { type: 'null' }] },
    expiresAt: time, directExpiresAt: time, authorizedUntil: { anyOf: [time, { type: 'null' }] }, relayReady: { type: 'boolean' },
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
    desktop.post<{ Body: { direct?: true } }>('/v1/desktop-pdfs/provider/poll', {
      onRequest, schema: { body: { ...empty, properties: { direct: { const: true } } }, querystring: empty, response: { 200: {
        type: 'object', additionalProperties: false, required: ['request'], properties: { request: { anyOf: [jobSchema, { type: 'null' }] } },
      } } },
    }, async (request, reply) => broker!.poll(currentIdentity(request), request, reply, request.body.direct === true));
    desktop.delete('/v1/desktop-pdfs/provider', { onRequest, schema: { querystring: empty } }, async (request) => {
      await repository().desktopPdfSession(currentIdentity(request));
      broker!.stopProvider(currentIdentity(request)); return { stopped: true };
    });
    desktop.post<{ Body: { attachmentVersionId: string; direct?: { offer: string } } }>('/v1/desktop-pdfs/requests', {
      bodyLimit: signalBodyLimit,
      onRequest, schema: { querystring: empty, body: { type: 'object', additionalProperties: false, required: ['attachmentVersionId'],
        properties: { attachmentVersionId: uuid, direct: { type: 'object', additionalProperties: false, required: ['offer'], properties: { offer: sdpSchema } } } }, response: { 201: requestSchema } },
    }, async (request, reply) => {
      const result = await broker!.create(currentIdentity(request), request.body.attachmentVersionId, request, reply, request.body.direct?.offer);
      return reply.code(201).send(result);
    });
    desktop.get<{ Params: { id: string } }>('/v1/desktop-pdfs/requests/:id/direct', {
      onRequest, schema: { params, querystring: empty, response: { 200: directStatusSchema } },
    }, async (request, reply) => broker!.directStatus(currentIdentity(request), request.params.id, request, reply));
    desktop.post<{ Params: { id: string }; Body: { sdp: string } }>('/v1/desktop-pdfs/requests/:id/direct/answer', {
      onRequest, bodyLimit: signalBodyLimit, schema: { params, querystring: empty, body: {
        type: 'object', additionalProperties: false, required: ['sdp'], properties: { sdp: sdpSchema },
      } },
    }, async (request, reply) => broker!.directAnswer(currentIdentity(request), request.params.id, request.body.sdp, request, reply));
    desktop.post<{ Params: { id: string } }>('/v1/desktop-pdfs/requests/:id/direct/authorize', {
      onRequest, bodyLimit: 1024, schema: { params, querystring: empty, body: empty },
    }, async (request, reply) => broker!.directAuthorize(currentIdentity(request), request.params.id, request, reply));
    desktop.post<{ Params: { id: string }; Body: { sha256: string; sizeBytes: number } }>('/v1/desktop-pdfs/requests/:id/direct/complete', {
      onRequest, bodyLimit: 1024, schema: { params, querystring: empty, body: { type: 'object', additionalProperties: false,
        required: ['sha256', 'sizeBytes'], properties: { sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          sizeBytes: { type: 'integer', minimum: 1, maximum: SERVER_LIMITS.desktopPdfMaxFileBytes } } } },
    }, async (request, reply) => broker!.directComplete(currentIdentity(request), request.params.id, request.body, request, reply));
    desktop.post<{ Params: { id: string } }>('/v1/desktop-pdfs/requests/:id/direct/fallback', {
      onRequest, bodyLimit: 1024, schema: { params, querystring: empty, body: empty },
    }, async (request, reply) => broker!.directToRelay(currentIdentity(request), request.params.id, request, reply));
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
