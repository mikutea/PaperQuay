/** Access to one actually loaded PDF. No pathname or legacy history is a version proof. */
export interface DesktopReadingReaderSnapshot {
  sha256: string; sizeBytes: number; pageCount: number; pageIndex: number; offsetRatio: number; observedAt: string;
}
export interface DesktopReadingResume { sha256: string; sizeBytes: number; pageCount: number; pageIndex: number; offsetRatio: number }
export type DesktopReadingReaderPoint = Pick<DesktopReadingReaderSnapshot, 'pageIndex' | 'offsetRatio' | 'observedAt'>;
export interface DesktopReadingReaderAccess {
  id: string; isCurrent(): boolean; capture(): Promise<DesktopReadingReaderSnapshot>;
  currentPoint(): DesktopReadingReaderPoint | null;
  subscribePosition(listener: (point: DesktopReadingReaderPoint) => void): () => void;
  resume(point: DesktopReadingResume, request?: { isCurrent(): boolean }): Promise<void>;
  dispose(): void;
}
export const DESKTOP_READING_PDF_BYTES = 64 * 1024 * 1024;
export type DesktopReadingReaderErrorCode = 'READING_READER_CHANGED' | 'READING_POSITION_UNAVAILABLE' | 'READING_POSITION_UNREACHABLE' | 'READING_PDF_LIMIT' | 'READING_VERSION_MISMATCH' | 'READING_HASH_UNAVAILABLE';
export class DesktopReadingReaderError extends Error {
  readonly code: DesktopReadingReaderErrorCode;
  constructor(code: DesktopReadingReaderErrorCode) {
    super(code); this.name = 'DesktopReadingReaderError'; this.code = code;
  }
}
type Point = DesktopReadingReaderPoint;
interface Options {
  id?: string; isCurrent(): boolean; pageCount(): number; readBytes(): Promise<Uint8Array>; readPoint(): Point | null;
  applyPoint(point: Pick<DesktopReadingResume, 'pageIndex' | 'offsetRatio'>): void | Promise<void>;
  subscribePosition?(listener: (point: Point) => void): () => void;
  hashBytes?(bytes: Uint8Array): Promise<string>;
}
const fail = (code: DesktopReadingReaderError['code']): never => { throw new DesktopReadingReaderError(code); };
function validPoint(point: { pageIndex: number; offsetRatio: number }, count: number): boolean {
  return Number.isSafeInteger(count) && count > 0 && count <= 100000 && Number.isSafeInteger(point.pageIndex) && point.pageIndex >= 0 && point.pageIndex < count
    && Number.isFinite(point.offsetRatio) && point.offsetRatio >= 0 && point.offsetRatio <= 1;
}
async function hashBytes(bytes: Uint8Array): Promise<string> {
  try { const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)); return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''); }
  catch { return fail('READING_HASH_UNAVAILABLE'); }
}
export function createDesktopReadingReaderAccess(options: Options): DesktopReadingReaderAccess {
  const id = options.id ?? crypto.randomUUID();
  let retired = false;
  const subscriptions = new Set<() => void>();
  const isCurrent = () => { try { return !retired && options.isCurrent() === true; } catch { return false; } };
  const check = () => { if (!isCurrent()) fail('READING_READER_CHANGED'); };
  const checkRequest = (request?: { isCurrent(): boolean }) => {
    check(); if (request) { let current = false; try { current = request.isCurrent() === true; } catch {} if (!current) fail('READING_READER_CHANGED'); }
  };
  const readPoint = (): Point | null => {
    if (!isCurrent()) return null;
    const point = options.readPoint();
    if (!point || !validPoint(point, options.pageCount()) || typeof point.observedAt !== 'string'
      || !Number.isFinite(Date.parse(point.observedAt)) || new Date(point.observedAt).toISOString() !== point.observedAt || !isCurrent()) return null;
    return { ...point };
  };
  async function proof(request?: { isCurrent(): boolean }): Promise<Pick<DesktopReadingResume, 'sha256' | 'sizeBytes' | 'pageCount'>> {
    checkRequest(request); const pageCount = options.pageCount();
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100000) fail('READING_POSITION_UNAVAILABLE');
    const bytes = await options.readBytes(); checkRequest(request);
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > DESKTOP_READING_PDF_BYTES) fail('READING_PDF_LIMIT');
    const sizeBytes = bytes.byteLength, sha256 = await (options.hashBytes ?? hashBytes)(bytes); checkRequest(request);
    if (!/^[0-9a-f]{64}$/.test(sha256)) fail('READING_HASH_UNAVAILABLE');
    if (options.pageCount() !== pageCount) fail('READING_READER_CHANGED');
    return { sha256, sizeBytes, pageCount };
  }
  return { id, isCurrent, currentPoint: readPoint,
    subscribePosition(listener) {
      check(); let subscribed = true;
      const stop = options.subscribePosition?.(point => {
        if (!subscribed || !isCurrent() || !validPoint(point, options.pageCount()) || typeof point.observedAt !== 'string'
          || !Number.isFinite(Date.parse(point.observedAt)) || new Date(point.observedAt).toISOString() !== point.observedAt) return;
        listener({ ...point });
      }) ?? (() => {});
      const unsubscribe = () => { if (!subscribed) return; subscribed = false; subscriptions.delete(unsubscribe); stop(); };
      subscriptions.add(unsubscribe); return unsubscribe;
    },
    dispose() { if (retired) return; retired = true; for (const stop of [...subscriptions]) stop(); },
    async capture() {
      const source = await proof(); check(); const point = readPoint();
      if (!point) return fail('READING_POSITION_UNAVAILABLE');
      if (!validPoint(point, source.pageCount) || typeof point.observedAt !== 'string'
        || !Number.isFinite(Date.parse(point.observedAt)) || new Date(point.observedAt).toISOString() !== point.observedAt) return fail('READING_POSITION_UNAVAILABLE');
      check(); return { ...source, pageIndex: point.pageIndex, offsetRatio: point.offsetRatio, observedAt: point.observedAt };
    },
    async resume(input, request) {
      const target = { ...input };
      if (!validPoint(target, target.pageCount) || !/^[0-9a-f]{64}$/.test(target.sha256) || !Number.isSafeInteger(target.sizeBytes) || target.sizeBytes < 1 || target.sizeBytes > DESKTOP_READING_PDF_BYTES) fail('READING_VERSION_MISMATCH');
      const source = await proof(request); checkRequest(request);
      if (source.sha256 !== target.sha256 || source.sizeBytes !== target.sizeBytes || source.pageCount !== target.pageCount) fail('READING_VERSION_MISMATCH');
      checkRequest(request); await options.applyPoint({ pageIndex: target.pageIndex, offsetRatio: target.offsetRatio }); checkRequest(request);
    },
  };
}
