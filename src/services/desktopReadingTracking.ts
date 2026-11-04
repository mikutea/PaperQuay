import type { DesktopReadingReaderAccess, DesktopReadingReaderPoint } from './desktopReadingReader';
import { desktopReadingPosition, type DesktopReadingPositionPreview, type DesktopReadingPositionStatus,
  type DesktopReadingTrackedPoint, type DesktopReadingTrackStartResult, type VerifiedDesktopReadingSource } from './desktopReadingPosition';

export interface DesktopReadingTrackingSnapshot {
  phase: 'stopped' | 'starting' | 'recording' | 'saving' | 'error'; errorCode: string | null;
  recent: DesktopReadingReaderPoint | null; furthest: { pageIndex: number; offsetRatio: number } | null;
}
export interface DesktopReadingTrackingController {
  snapshot(): DesktopReadingTrackingSnapshot; subscribe(listener: () => void): () => void;
  start(preview: DesktopReadingPositionPreview): Promise<void>; stop(): Promise<void>;
}
type Service = Pick<typeof desktopReadingPosition, 'startTracking' | 'recordTracked' | 'stopTracking' | 'status' | 'onChanged'>;
interface Options {
  reader: DesktopReadingReaderAccess; localPaperId: string; isCurrent(): boolean; service?: Service;
  intervalMs?: number; schedule?(callback: () => void, delay: number): unknown; cancel?(timer: unknown): void;
}
interface Session {
  id: string; scopeKey: string; source: VerifiedDesktopReadingSource; sequence: number;
  point: DesktopReadingTrackedPoint | null; inFlight: DesktopReadingTrackedPoint | null; lastSaved: DesktopReadingTrackedPoint; cancelled: boolean;
}
const error = (code: string): Error => Object.assign(new Error(code), { code });
const errorCode = (value: unknown): string => {
  const code = value && typeof value === 'object' && 'code' in value ? String(value.code) : String(value);
  return code.match(/\b[A-Z][A-Z_]{3,70}\b/)?.[0] || 'READING_FAILED';
};
const further = (a: { pageIndex: number; offsetRatio: number }, b: { pageIndex: number; offsetRatio: number }) =>
  a.pageIndex > b.pageIndex || a.pageIndex === b.pageIndex && a.offsetRatio >= b.offsetRatio ? a : b;
const samePoint = (a: DesktopReadingTrackedPoint, b: DesktopReadingTrackedPoint) => a.pageIndex === b.pageIndex && a.offsetRatio === b.offsetRatio
  && a.furthestPageIndex === b.furthestPageIndex && a.furthestOffsetRatio === b.furthestOffsetRatio;
const sameSource = (a: VerifiedDesktopReadingSource, b: VerifiedDesktopReadingSource) =>
  (['bindingId', 'localPaperId', 'localAttachmentId', 'paperId', 'attachmentVersionId', 'sha256', 'sizeBytes', 'pageCount'] as const).every(key => a[key] === b[key]);
function validPoint(point: DesktopReadingReaderPoint, count: number): boolean {
  return Number.isSafeInteger(point.pageIndex) && point.pageIndex >= 0 && point.pageIndex < count
    && Number.isFinite(point.offsetRatio) && point.offsetRatio >= 0 && point.offsetRatio <= 1 && typeof point.observedAt === 'string'
    && Number.isFinite(Date.parse(point.observedAt)) && new Date(point.observedAt).toISOString() === point.observedAt;
}

/** One explicitly chosen loaded-document session. Construction performs no IO. */
export function createDesktopReadingTracking(options: Options): DesktopReadingTrackingController & { dispose(): Promise<void> } {
  const service = options.service ?? desktopReadingPosition, listeners = new Set<() => void>();
  const schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const cancel = options.cancel ?? (timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  let value: DesktopReadingTrackingSnapshot = { phase: 'stopped', errorCode: null, recent: null, furthest: null };
  let disposed = false, generation = 0, session: Session | null = null, pendingScope: string | null = null, displayScope: string | null = null, timer: unknown = null, writes = Promise.resolve();
  let detachPoint: (() => void) | undefined, detachChange: (() => void) | undefined, starting: Promise<void> | null = null, stopping: Promise<void> | null = null;
  const current = () => !disposed && options.isCurrent() && options.reader.isCurrent();
  const emit = (patch: Partial<DesktopReadingTrackingSnapshot>) => { value = { ...value, ...patch }; for (const listener of [...listeners]) { try { listener(); } catch {} } };
  const clearTimer = () => { if (timer !== null) { cancel(timer); timer = null; } };
  const detach = () => { clearTimer(); detachPoint?.(); detachPoint = undefined; };
  const stopRuntime = async (target: Session | { id: string }, strict = false) => {
    try { await service.stopTracking({ trackingId: target.id }); }
    catch (failure) { if (strict) throw failure; }
  };
  function abandon(code: string, clearPoints = false) {
    generation++; detach(); const target = session; session = null;
    if (target) { target.cancelled = true; void stopRuntime(target); }
    if (clearPoints) displayScope = null;
    emit({ phase: 'error', errorCode: code, ...(clearPoints ? { recent: null, furthest: null } : {}) });
  }
  function observe(point: DesktopReadingReaderPoint) {
    const target = session;
    if (!target || target.cancelled || !current()) return;
    if (!validPoint(point, target.source.pageCount)) { abandon('READING_POSITION_UNAVAILABLE'); return; }
    const max = further(value.furthest ?? point, point);
    const next = { ...point, furthestPageIndex: max.pageIndex, furthestOffsetRatio: max.offsetRatio };
    target.point = samePoint(next, target.inFlight ?? target.lastSaved) ? null : next;
    emit({ recent: { ...point }, furthest: { pageIndex: max.pageIndex, offsetRatio: max.offsetRatio } });
    if (target.point && timer === null) timer = schedule(() => { timer = null; void flush(target); }, options.intervalMs ?? 1000);
  }
  function flush(target: Session): Promise<void> {
    const task = writes.then(async () => {
      if (target.cancelled || !target.point) return;
      const point = target.point; target.point = null;
      if (samePoint(point, target.lastSaved)) return;
      target.inFlight = point;
      emit({ phase: 'saving' });
      try {
        const result = await service.recordTracked({ trackingId: target.id, sequence: ++target.sequence, point });
        if (target.cancelled) return;
        if (result.scopeKey !== target.scopeKey || !result.supported || result.saveUnconfirmed || result.errorCode
          || result.tracking?.trackingId !== target.id) throw error(result.errorCode || (result.saveUnconfirmed ? 'READING_SAVE_UNCONFIRMED' : 'READING_READER_CHANGED'));
        target.lastSaved = point;
        if (session === target) emit({ phase: 'recording' });
      } catch (failure) {
        target.cancelled = true; if (session === target) { session = null; generation++; detach(); emit({ phase: 'error', errorCode: errorCode(failure) }); }
        await stopRuntime(target);
      } finally { target.inFlight = null; }
    });
    writes = task.catch(() => {}); return task;
  }
  async function watchChanges() {
    if (detachChange) return;
    const stop = await service.onChanged(change => {
      const target = session, scopeKey = target?.scopeKey ?? pendingScope ?? displayScope;
      if (change && scopeKey && change.readingScopeKey !== scopeKey) {
        if (target || pendingScope) abandon('AUTH_SESSION_CHANGED', true);
        else { generation++; displayScope = null; emit({ phase: 'stopped', errorCode: null, recent: null, furthest: null }); }
        return;
      }
      if (!target || target.cancelled || stopping) return;
      void service.status().then(status => {
        if (session !== target || target.cancelled) return;
        if (status.scopeKey !== target.scopeKey || !status.supported || status.saveUnconfirmed || status.tracking?.trackingId !== target.id)
          abandon(status.errorCode || (status.saveUnconfirmed ? 'READING_SAVE_UNCONFIRMED' : 'READING_READER_CHANGED'), status.scopeKey !== target.scopeKey);
      }).catch(failure => { if (session === target) abandon(errorCode(failure)); });
    });
    if (disposed) stop(); else detachChange = stop;
  }
  async function stop(readCurrent: boolean) {
    if (stopping) return stopping;
    const target = session;
    if (readCurrent && target && current()) { const point = options.reader.currentPoint(); if (point) observe(point); }
    generation++; detach();
    const pendingStart = starting;
    const task = (async () => {
      if (target) {
        await flush(target);
        try { await stopRuntime(target, readCurrent); }
        catch (failure) { if (session === target && displayScope === target.scopeKey) emit({ phase: 'error', errorCode: errorCode(failure) }); throw failure; }
        if (session === target) session = null;
        if (!target.cancelled) emit({ phase: 'stopped', errorCode: null });
      }
      if (pendingStart) await pendingStart.catch(() => {});
      if (!session && value.phase !== 'error') emit({ phase: 'stopped' });
    })();
    stopping = task; try { await task; } finally { if (stopping === task) stopping = null; }
  }
  const controller: DesktopReadingTrackingController & { dispose(): Promise<void> } = {
    snapshot: () => structuredClone(value),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async start(preview) {
      if (!current()) throw error('READING_READER_CHANGED');
      if (starting || stopping || session) throw error('READING_TRACKING_ACTIVE');
      if (preview.source.localPaperId !== options.localPaperId) throw error('READING_SOURCE_CHANGED');
      const requested = ++generation, owner = preview.scopeKey;
      pendingScope = owner; displayScope = owner;
      emit({ phase: 'starting', errorCode: null, recent: { pageIndex: preview.capture.pageIndex, offsetRatio: preview.capture.offsetRatio, observedAt: preview.capture.observedAt },
        furthest: { pageIndex: preview.capture.pageIndex, offsetRatio: preview.capture.offsetRatio } });
      const task = (async () => {
        let response: DesktopReadingTrackStartResult | null = null;
        try {
          await watchChanges(); if (requested !== generation || !current()) throw error('READING_READER_CHANGED');
          response = await service.startTracking({ token: preview.token });
          if (requested !== generation || !current()) throw error('READING_READER_CHANGED');
          if (response.status.scopeKey !== owner || !response.status.supported || response.status.saveUnconfirmed || response.status.errorCode
            || response.status.tracking?.trackingId !== response.trackingId || !sameSource(response.source, preview.source)
            || response.capture.bindingId !== preview.capture.bindingId || response.capture.sha256 !== preview.capture.sha256
            || response.capture.sizeBytes !== preview.capture.sizeBytes || response.capture.pageCount !== preview.capture.pageCount)
            throw error(response.status.errorCode || 'READING_SOURCE_CHANGED');
          const first = { pageIndex: response.capture.pageIndex, offsetRatio: response.capture.offsetRatio, observedAt: response.capture.observedAt,
            furthestPageIndex: response.furthestPageIndex, furthestOffsetRatio: response.furthestOffsetRatio };
          if (!validPoint(first, response.source.pageCount) || !validPoint({ pageIndex: first.furthestPageIndex, offsetRatio: first.furthestOffsetRatio, observedAt: first.observedAt }, response.source.pageCount)
            || further(first, { pageIndex: first.furthestPageIndex, offsetRatio: first.furthestOffsetRatio }) === first
              && (first.pageIndex !== first.furthestPageIndex || first.offsetRatio !== first.furthestOffsetRatio)) throw error('READING_POSITION_UNSUPPORTED');
          const target: Session = { id: response.trackingId, scopeKey: owner, source: response.source, sequence: 0, point: null, inFlight: null, lastSaved: first, cancelled: false };
          session = target; emit({ phase: 'recording', recent: { pageIndex: first.pageIndex, offsetRatio: first.offsetRatio, observedAt: first.observedAt }, furthest: { pageIndex: first.furthestPageIndex, offsetRatio: first.furthestOffsetRatio } });
          detachPoint = options.reader.subscribePosition(observe);
          const actual = options.reader.currentPoint(); if (actual) observe(actual);
        } catch (failure) {
          if (response) await stopRuntime({ id: response.trackingId });
          if (requested === generation && !disposed) { detach(); session = null; emit({ phase: 'error', errorCode: errorCode(failure) }); }
          throw failure;
        }
      })();
      starting = task; try { await task; } finally { if (starting === task) { starting = null; pendingScope = null; } }
    },
    stop: () => stop(true),
    async dispose() {
      if (disposed) return; disposed = true; detachChange?.(); detachChange = undefined;
      try { await stop(false); } catch { /* A pending explicit stop may fail after teardown; its state and exact runtime id are retained. */ }
      finally { listeners.clear(); }
    },
  };
  return controller;
}
