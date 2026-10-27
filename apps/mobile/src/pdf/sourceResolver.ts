import { validateEntityData } from '../../../../packages/sync-core/src/index.ts';
import { normalizeServiceUrl } from '../config.ts';
import { ClientError } from '../errors.ts';
import { accountScopeKey, type AccountScope } from '../storage/accountStore.ts';
import { checkCompletePdfBytes, downloadPublicPdf, inspectPublicPdf, publicPdfUrl, sha256 } from './acquisition.ts';
import { CloudPdfError, downloadCloudPdfCopy, type CloudPdfContext, type CloudPdfErrorCode } from './cloudCopies.ts';
import { DesktopPdfError, downloadDesktopPdfCopy, type DesktopPdfContext } from './desktopCopies.ts';
import { PdfError } from './errors.ts';
import { PDF_LIMITS, type PdfCache, type PdfVersion } from './types.ts';

export type PdfSourceKind = 'cache' | 'desktop' | 'cloud' | 'public';
export type PdfSourceStatus = 'pending' | 'checking' | 'downloading' | 'verifying' | 'succeeded' | 'failed' | 'skipped';
export type CloudPdfUnavailableReason = 'not-configured' | 'not-enabled' | 'not-synced' | 'login-required';
export type DesktopPdfUnavailableReason = 'not-configured' | 'not-enabled' | 'not-synced' | 'login-required';
export interface PdfSourceFailure { code: string; message: string }
export interface PdfSourceProgress { source: PdfSourceKind; loaded: number; total: number | null }
export interface PdfSourceAttempt extends PdfSourceProgress {
  status: PdfSourceStatus;
  code?: string;
  message?: string;
}
export interface PdfSourceBudgets { cacheMs: number; desktopMs: number; cloudMs: number; publicMs: number; totalMs: number }
export const PDF_SOURCE_BUDGETS: Readonly<PdfSourceBudgets> = Object.freeze({ cacheMs: 5_000, desktopMs: 15_000, cloudMs: 15_000, publicMs: 30_000, totalMs: 60_000 });
export interface PdfSourceRequest {
  scope: AccountScope;
  version: PdfVersion;
  cache: Pick<PdfCache, 'peek'>;
  /** Supply only for a synced version; check must revalidate live account and version eligibility. */
  desktop?: { context: DesktopPdfContext; check: () => void };
  desktopUnavailableReason?: DesktopPdfUnavailableReason;
  /** Supply only for a synced version; check must revalidate live cloud eligibility. */
  cloud?: { context: CloudPdfContext; check: () => void };
  cloudUnavailableReason?: CloudPdfUnavailableReason;
  /** An explicitly supplied public source; never discovered from a sync entity or cache metadata. */
  publicUrl?: string;
}
export interface PdfSourceOptions {
  signal: AbortSignal;
  /** Revalidate account/device/login binding, operation epoch and the exact live paper/version. */
  check: () => void;
  onAttempt?: (attempt: PdfSourceAttempt) => void;
  onProgress?: (progress: PdfSourceProgress) => void;
  fetch?: typeof globalThis.fetch;
  /** Values may shorten the defaults, never extend their upper bounds. */
  budgets?: Partial<PdfSourceBudgets>;
}
export type PdfSourceResult = {
  status: 'resolved'; bytes: Uint8Array; fileName: string; source: PdfSourceKind; sourceUrl?: string; attempts: PdfSourceAttempt[];
} | { status: 'unavailable'; attempts: PdfSourceAttempt[] };

const sources: readonly PdfSourceKind[] = ['cache', 'desktop', 'cloud', 'public'];
const cloudMessages: Record<CloudPdfErrorCode, string> = {
  STORAGE_DISABLED: '账号服务尚未开放 PDF 云副本。',
  CAPABILITY_CHANGED: '云副本服务配置已变化，本次未采用返回内容。',
  NOT_FOUND: '此版本暂无可用云副本。',
  VERSION_UNAVAILABLE: '此附件版本在账号服务中已不可用，请先同步文库。',
  QUOTA_EXCEEDED: '云副本服务额度不足。',
  RATE_LIMITED: '云副本服务暂时繁忙，请稍后手动重试。',
  CHANGED: '云副本状态已变化，本次未采用返回内容。',
  CANCELLED: '已取消读取云副本。',
  TIMEOUT: '读取云副本超时。',
  NETWORK: '暂时无法连接云副本服务。',
  INVALID_RESPONSE: '云副本服务返回的内容无效，本次未采用返回内容。',
  FAILED: '云副本读取失败。',
};
const cloudUnavailable: Record<CloudPdfUnavailableReason, PdfSourceFailure> = {
  'not-configured': { code: 'CLOUD_NOT_CONFIGURED', message: '尚未配置云副本来源。' },
  'not-enabled': { code: 'STORAGE_DISABLED', message: cloudMessages.STORAGE_DISABLED },
  'not-synced': { code: 'CLOUD_NOT_SYNCED', message: '此版本尚未同步，暂不读取云副本。' },
  'login-required': { code: 'CLOUD_LOGIN_REQUIRED', message: '当前登录不可用于读取云副本。' },
};
const desktopUnavailable: Record<DesktopPdfUnavailableReason, PdfSourceFailure> = {
  'not-configured': { code: 'DESKTOP_NOT_CONFIGURED', message: '尚未配置在线电脑来源。' },
  'not-enabled': { code: 'TRANSFER_DISABLED', message: new DesktopPdfError('TRANSFER_DISABLED').message },
  'not-synced': { code: 'DESKTOP_NOT_SYNCED', message: '此版本尚未同步，暂不从在线电脑取文件。' },
  'login-required': { code: 'DESKTOP_LOGIN_REQUIRED', message: '当前登录不可用于从在线电脑取文件。' },
};

/** Fixed user-facing descriptions: transport messages, URLs and credentials never enter attempt records. */
export function describePdfSourceError(error: unknown, source: PdfSourceKind): PdfSourceFailure {
  if (error instanceof DesktopPdfError)
    return { code: error.code, message: new DesktopPdfError(error.code).message };
  if (error instanceof CloudPdfError && Object.hasOwn(cloudMessages, error.code))
    return { code: error.code, message: cloudMessages[error.code] };
  if (error instanceof PdfError || error instanceof ClientError) {
    const safe = error instanceof PdfError ? new PdfError(error.code) : new ClientError(error.code);
    if (typeof safe.message === 'string' && safe.message) return { code: error.code, message: safe.message };
  }
  const safe = source === 'desktop' ? new DesktopPdfError('NETWORK') : new PdfError(source === 'cache' ? 'CACHE_UNAVAILABLE' : 'NETWORK');
  return { code: safe.code, message: safe.message };
}

function duration(value: number | undefined, maximum: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.max(1, Math.min(value!, maximum)) : maximum;
}
function disposeResponse(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
}
function terminalSourceError(error: unknown): boolean {
  if (error instanceof ClientError)
    return ['AUTH_REQUIRED', 'AUTH_FAILED', 'SESSION_REVOKED', 'ACCOUNT_CHANGED'].includes(error.code);
  if (error instanceof PdfError)
    return ['CANCELLED', 'ACCOUNT_CHANGED', 'TARGET_CHANGED'].includes(error.code);
  if (error instanceof DesktopPdfError) return ['CANCELLED', 'VERSION_UNAVAILABLE', 'CHANGED'].includes(error.code);
  return error instanceof CloudPdfError && (error.code === 'CANCELLED' || error.code === 'VERSION_UNAVAILABLE');
}

interface Stage {
  signal: AbortSignal;
  check: () => void;
  wait: <T>(work: () => Promise<T>, late?: (value: T) => void) => Promise<T>;
  timedOut: () => boolean;
  close: () => void;
}

/** Explicit, sequential acquisition for one existing version; library persistence belongs to openBytes. */
export async function resolvePdfSource(input: PdfSourceRequest, options: PdfSourceOptions): Promise<PdfSourceResult> {
  const scope = Object.freeze({ ...input.scope });
  const version: PdfVersion = Object.freeze({ entityId: input.version.entityId, data: Object.freeze({ ...input.version.data }) });
  const cache = input.cache;
  const publicInput = input.publicUrl;
  const unavailableReason = input.cloudUnavailableReason ?? 'not-configured';
  const desktopUnavailableReason = input.desktopUnavailableReason ?? 'not-configured';
  const desktop = input.desktop && { check: input.desktop.check, context: {
    apiBaseUrl: input.desktop.context.apiBaseUrl,
    getAccessToken: input.desktop.context.getAccessToken.bind(input.desktop.context),
    getDesktopPdfCapability: input.desktop.context.getDesktopPdfCapability.bind(input.desktop.context),
  } };
  const cloud = input.cloud && { check: input.cloud.check, context: {
    apiBaseUrl: input.cloud.context.apiBaseUrl,
    getAccessToken: input.cloud.context.getAccessToken.bind(input.cloud.context),
    getCloudPdfCapability: input.cloud.context.getCloudPdfCapability.bind(input.cloud.context),
  } };
  const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const budgets = {
    cache: duration(options.budgets?.cacheMs, PDF_SOURCE_BUDGETS.cacheMs),
    desktop: duration(options.budgets?.desktopMs, PDF_SOURCE_BUDGETS.desktopMs),
    cloud: duration(options.budgets?.cloudMs, PDF_SOURCE_BUDGETS.cloudMs),
    public: duration(options.budgets?.publicMs, PDF_SOURCE_BUDGETS.publicMs),
    total: duration(options.budgets?.totalMs, PDF_SOURCE_BUDGETS.totalMs),
  };
  const attempts: PdfSourceAttempt[] = sources.map((source) => ({ source, status: 'pending', loaded: 0, total: version.data.sizeBytes }));
  const controller = new AbortController();
  let active = true;
  let failure: { error: unknown } | undefined;
  const stop = (error: unknown) => { failure ??= { error }; controller.abort(); };
  const check = () => {
    if (failure) throw failure.error;
    if (!active) throw new PdfError('CANCELLED');
    try { options.check(); }
    catch (error) { stop(error); throw error; }
  };
  const checkCloud = () => {
    check();
    try { cloud?.check(); }
    catch (error) { stop(error); throw error; }
  };
  const checkDesktop = () => {
    check();
    try { desktop?.check(); }
    catch (error) { stop(error); throw error; }
  };
  const abort = () => stop(new PdfError('CANCELLED'));
  if (options.signal.aborted) abort();
  else options.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new PdfError('TIMEOUT')), budgets.total);
  const snapshots = () => attempts.map((attempt) => ({ ...attempt }));
  const report = (source: PdfSourceKind, update: Partial<Omit<PdfSourceAttempt, 'source'>>) => {
    check();
    const index = sources.indexOf(source);
    const next = { ...attempts[index], ...update };
    attempts[index] = next;
    try { options.onAttempt?.({ ...next }); }
    catch (error) { stop(error); throw error; }
    check();
  };
  const stageFor = (source: PdfSourceKind): Stage => {
    const child = new AbortController();
    let stageActive = true; let timedOut = false;
    const parentAbort = () => child.abort();
    controller.signal.addEventListener('abort', parentAbort, { once: true });
    if (controller.signal.aborted) parentAbort();
    const stageTimer = setTimeout(() => { timedOut = true; child.abort(); }, budgets[source]);
    const stageCheck = () => {
      check();
      if (!stageActive) throw new PdfError('CANCELLED');
      // Losing account/version authorization must outrank a simultaneous recoverable stage timeout.
      if (source === 'desktop') checkDesktop();
      if (source === 'cloud') checkCloud();
      if (child.signal.aborted) throw new PdfError(timedOut ? 'TIMEOUT' : 'CANCELLED');
    };
    const wait = <T>(work: () => Promise<T>, late?: (value: T) => void): Promise<T> => new Promise((resolve, reject) => {
      let settled = false;
      const clean = () => child.signal.removeEventListener('abort', onAbort);
      const rejectOnce = (error: unknown) => { if (!settled) { settled = true; clean(); reject(error); } };
      const onAbort = () => {
        try { stageCheck(); rejectOnce(new PdfError('CANCELLED')); }
        catch (error) { rejectOnce(error); }
      };
      const dispose = (value: T) => { try { late?.(value); } catch { /* Best-effort disposal only. */ } };
      child.signal.addEventListener('abort', onAbort, { once: true });
      let pending: ReturnType<typeof work>;
      try { stageCheck(); pending = work(); }
      catch (error) { rejectOnce(error); return; }
      pending.then((value) => {
        if (settled) { dispose(value); return; }
        try { stageCheck(); }
        catch (error) { dispose(value); rejectOnce(error); return; }
        settled = true; clean(); resolve(value);
      }, (error: unknown) => {
        if (settled) return;
        try { stageCheck(); } catch (currentError) { error = currentError; }
        rejectOnce(error);
      });
    });
    return { signal: child.signal, check: stageCheck, wait, timedOut: () => timedOut,
      close: () => { stageActive = false; clearTimeout(stageTimer); controller.signal.removeEventListener('abort', parentAbort); child.abort(); } };
  };
  try {
    check(); accountScopeKey(scope);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(version.entityId)
      || !validateEntityData('attachmentVersion', version.data).ok) throw new PdfError('VERSION_MISMATCH');
    if (version.data.sizeBytes > PDF_LIMITS.maxFileBytes) throw new PdfError('TOO_LARGE');
    for (const source of sources) report(source, {});
    for (const source of sources) {
      check();
      if (source === 'desktop' && !desktop) { report(source, { status: 'skipped', ...desktopUnavailable[desktopUnavailableReason] }); continue; }
      if (source === 'cloud' && !cloud) { report(source, { status: 'skipped', ...cloudUnavailable[unavailableReason] }); continue; }
      if (source === 'public' && !publicInput?.trim()) {
        report(source, { status: 'skipped', code: 'NO_PUBLIC_URL', message: '未提供公开 PDF 链接。' }); continue;
      }
      const stage = stageFor(source);
      let cloudStatus: number | undefined;
      let desktopStatus: number | undefined;
      let sourceUrl: string | undefined;
      const guardedFetch: typeof fetch = async (...args) => {
        const response = await stage.wait(() => fetcher(...args), disposeResponse);
        try { stage.check(); } catch (error) { disposeResponse(response); throw error; }
        if (source === 'cloud') cloudStatus = response.status;
        if (source === 'desktop') desktopStatus = response.status;
        return response;
      };
      const progress = (loaded: number, total: number | null) => {
        stage.check();
        report(source, { status: 'downloading', loaded, total });
        try { options.onProgress?.({ source, loaded, total }); }
        catch (error) { stop(error); throw error; }
        stage.check();
      };
      try {
        stage.check(); report(source, { status: 'checking' });
        let acquired: Uint8Array | null;
        if (source === 'cache') acquired = await stage.wait(() => cache.peek(scope, version, { signal: stage.signal }));
        else if (source === 'desktop') {
          if (normalizeServiceUrl(desktop!.context.apiBaseUrl) !== normalizeServiceUrl(scope.apiBaseUrl)) {
            const error = new ClientError('ACCOUNT_CHANGED'); stop(error); throw error;
          }
          report(source, { status: 'downloading' });
          acquired = await stage.wait(() => downloadDesktopPdfCopy(desktop!.context, version, {
            signal: stage.signal, isCurrent: () => { stage.check(); return true; }, fetch: guardedFetch, cleanupFetch: fetcher,
            timeoutMs: budgets.desktop, onProgress: progress,
          }));
        }
        else if (source === 'cloud') {
          if (normalizeServiceUrl(cloud!.context.apiBaseUrl) !== normalizeServiceUrl(scope.apiBaseUrl)) {
            const error = new ClientError('ACCOUNT_CHANGED'); stop(error); throw error;
          }
          report(source, { status: 'downloading' });
          acquired = await stage.wait(() => downloadCloudPdfCopy(cloud!.context, version, {
            signal: stage.signal, isCurrent: () => { stage.check(); return true; }, fetch: guardedFetch,
            timeoutMs: budgets.cloud, onProgress: progress,
          }));
        } else {
          sourceUrl = publicPdfUrl(publicInput!);
          const probe = await stage.wait(() => inspectPublicPdf(sourceUrl!, {
            signal: stage.signal, fetch: guardedFetch, timeoutMs: budgets.public,
          }));
          if (probe.sizeBytes !== null && probe.sizeBytes !== version.data.sizeBytes) throw new PdfError('VERSION_MISMATCH');
          report(source, { status: 'downloading', total: probe.sizeBytes });
          acquired = await stage.wait(() => downloadPublicPdf(probe, {
            signal: stage.signal, fetch: guardedFetch, timeoutMs: budgets.public, onProgress: progress,
          }));
        }
        stage.check();
        if (acquired === null) throw new PdfError('CACHE_MISSING');
        report(source, { status: 'verifying' });
        if (!(acquired instanceof Uint8Array)) throw new PdfError(source === 'cache' ? 'CACHE_CORRUPT' : 'NOT_PDF');
        if (acquired.byteLength > PDF_LIMITS.maxFileBytes) throw new PdfError('TOO_LARGE');
        if (acquired.byteLength !== version.data.sizeBytes) throw new PdfError('VERSION_MISMATCH');
        const bytes = new Uint8Array(acquired);
        checkCompletePdfBytes(bytes);
        if (await stage.wait(() => sha256(bytes)) !== version.data.sha256) throw new PdfError('VERSION_MISMATCH');
        stage.check();
        report(source, { status: 'succeeded', loaded: bytes.length, total: bytes.length });
        for (const untried of sources.slice(sources.indexOf(source) + 1))
          report(untried, { status: 'skipped', code: 'NOT_NEEDED', message: '已从前面的来源获得此版本。' });
        check();
        return { status: 'resolved', bytes, fileName: version.data.fileName, source,
          ...(sourceUrl === undefined ? {} : { sourceUrl }), attempts: snapshots() };
      } catch (error) {
        // A stale identity or changed target must outrank a recoverable transport/content failure.
        check();
        if (source === 'desktop') checkDesktop();
        if (source === 'cloud') checkCloud();
        if (stage.timedOut()) error = new PdfError('TIMEOUT');
        else if (error instanceof Error && error.name === 'AbortError') error = new PdfError('CANCELLED');
        // A stalled/malformed error body cannot hide an observed authentication failure or tombstone.
        if (cloudStatus === 401 || cloudStatus === 403) {
          if (!(error instanceof ClientError && error.code === 'SESSION_REVOKED')) error = new ClientError('AUTH_REQUIRED');
        } else if (cloudStatus === 410 || (cloudStatus === 404 && !(error instanceof CloudPdfError && error.code === 'NOT_FOUND')))
          error = new CloudPdfError('VERSION_UNAVAILABLE');
        if (desktopStatus === 401 || desktopStatus === 403) {
          if (!(error instanceof ClientError && error.code === 'SESSION_REVOKED')) error = new ClientError('AUTH_REQUIRED');
        } else if (desktopStatus === 410 || (desktopStatus === 404 && !(error instanceof DesktopPdfError && error.code === 'UNAVAILABLE')))
          error = new DesktopPdfError('VERSION_UNAVAILABLE');
        else if (desktopStatus === 409 && !(error instanceof DesktopPdfError && error.code === 'REQUEST_IN_USE'))
          error = new DesktopPdfError('CHANGED');
        const description = describePdfSourceError(error, source);
        report(source, { status: (error instanceof CloudPdfError && error.code === 'STORAGE_DISABLED')
          || (error instanceof DesktopPdfError && error.code === 'TRANSFER_DISABLED') ? 'skipped' : 'failed', ...description });
        if (terminalSourceError(error)) { stop(error); throw error; }
        if (source === 'desktop') checkDesktop();
        if (source === 'cloud') checkCloud();
      } finally { stage.close(); }
    }
    check();
    return { status: 'unavailable', attempts: snapshots() };
  } finally {
    active = false; clearTimeout(timer); options.signal.removeEventListener('abort', abort); controller.abort();
  }
}
