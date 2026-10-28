import { inspectParsedImage } from '../../../../packages/sync-core/src/parsedDocument.ts';
import { RICH_NOTE_LIMITS, type RichNoteAsset } from '../../../../packages/sync-core/src/richNote.ts';

export class RichNoteImageError extends Error {
  constructor() { super('RICH_IMAGE_UNAVAILABLE'); this.name = 'RichNoteImageError'; }
}
const fail = (): never => { throw new RichNoteImageError(); };
const current = (signal: AbortSignal) => { if (signal.aborted) fail(); };
export interface RichNoteImageRuntime {
  create(blob: Blob): string;
  revoke(url: string): void;
  decode(url: string, signal: AbortSignal): Promise<{ width: number; height: number }>;
}
export const browserRichNoteImages: RichNoteImageRuntime = {
  create: (blob) => URL.createObjectURL(blob), revoke: (url) => URL.revokeObjectURL(url),
  decode: (url, signal) => new Promise((resolve, reject) => {
    const image = new Image(); let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return; finished = true;
      const size = { width: image.naturalWidth, height: image.naturalHeight };
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      image.onload = null; image.onerror = null; image.removeAttribute('src');
      ok ? resolve(size) : reject(new RichNoteImageError());
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), 10_000);
    signal.addEventListener('abort', abort, { once: true });
    image.onload = () => finish(true); image.onerror = () => finish(false);
    if (signal.aborted) abort(); else image.src = url;
  }),
};
function bytes(asset: RichNoteAsset): Uint8Array {
  if (asset.sizeBytes < 1 || asset.sizeBytes > RICH_NOTE_LIMITS.assetBytes) fail();
  if (typeof asset.base64 !== 'string' || asset.base64.length !== Math.ceil(asset.sizeBytes / 3) * 4) fail();
  let raw: string; try { raw = atob(asset.base64); } catch { return fail(); }
  if (raw.length !== asset.sizeBytes) fail();
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
function checkSize(actual: { width: number; height: number }, asset: Pick<RichNoteAsset, 'width' | 'height'>): void {
  if (!Number.isSafeInteger(actual.width) || !Number.isSafeInteger(actual.height) || actual.width < 1 || actual.height < 1
    || actual.width !== asset.width || actual.height !== asset.height || actual.width * actual.height > RICH_NOTE_LIMITS.assetPixels) fail();
}

/** Component-owned decoded URLs. replace/close immediately retire older async work. */
export class RichNoteImagePool {
  private urls = new Map<string, string>();
  private listeners = new Set<() => void>();
  private pending = new Set<Map<string, string>>();
  private controller: AbortController | null = null;
  private epoch = 0;
  private disposed = false;
  constructor(private readonly runtime: RichNoteImageRuntime = browserRichNoteImages) {}
  get(id: string): string | undefined { return this.urls.get(id); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(); }
  private release(urls: Map<string, string>) { for (const url of urls.values()) this.runtime.revoke(url); urls.clear(); }
  async replace(assets: readonly RichNoteAsset[]): Promise<boolean> {
    if (this.disposed) return false;
    const epoch = ++this.epoch; this.controller?.abort();
    for (const urls of this.pending) this.release(urls);
    this.controller = new AbortController(); const signal = this.controller.signal;
    this.release(this.urls); this.emit();
    const next = new Map<string, string>();
    this.pending.add(next);
    try {
      if (assets.length > RICH_NOTE_LIMITS.assets || new Set(assets.map((asset) => asset.id)).size !== assets.length) fail();
      let pixels = 0;
      for (const asset of assets) {
        current(signal);
        const data = bytes(asset), info = inspectParsedImage(data);
        checkSize(info, asset);
        if (info.mediaType !== asset.mediaType || (pixels += info.width * info.height) > RICH_NOTE_LIMITS.totalAssetPixels) fail();
        const blob = new Blob([new Uint8Array(data)], { type: asset.mediaType });
        const url = this.runtime.create(blob);
        if (!url.startsWith('blob:')) { this.runtime.revoke(url); fail(); }
        next.set(asset.id, url);
        const decoded = await this.runtime.decode(url, signal); current(signal); checkSize(decoded, asset);
      }
      current(signal);
      if (this.disposed || epoch !== this.epoch) { this.release(next); return false; }
      this.urls = next; this.emit(); return true;
    } catch {
      this.release(next);
      if (this.disposed || epoch !== this.epoch || signal.aborted) return false;
      throw new RichNoteImageError();
    } finally { this.pending.delete(next); }
  }
  close(): void { if (this.disposed) return; this.disposed = true; this.epoch++; this.controller?.abort(); this.release(this.urls); for (const urls of this.pending) this.release(urls); this.emit(); this.listeners.clear(); }
}

/** Local file picker bytes only. Returned resource URIs never contain a filename. */
export async function readRichNoteImage(file: Blob, signal: AbortSignal, runtime: RichNoteImageRuntime = browserRichNoteImages): Promise<RichNoteAsset> {
  current(signal);
  if (file.size < 1 || file.size > RICH_NOTE_LIMITS.assetBytes) fail();
  try {
    const data = new Uint8Array(await file.arrayBuffer()); current(signal);
    if (data.byteLength !== file.size) fail();
    const info = inspectParsedImage(data);
    if (info.width * info.height > RICH_NOTE_LIMITS.assetPixels) fail();
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer); current(signal);
    const sha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    const url = runtime.create(new Blob([new Uint8Array(data)], { type: info.mediaType }));
    let released = false; const release = () => { if (!released) { released = true; runtime.revoke(url); } };
    signal.addEventListener('abort', release, { once: true });
    try { if (!url.startsWith('blob:')) fail(); current(signal); const decoded = await runtime.decode(url, signal); current(signal); checkSize(decoded, info); }
    finally { signal.removeEventListener('abort', release); release(); }
    let raw = ''; for (let i = 0; i < data.length; i += 16_384) raw += String.fromCharCode(...data.subarray(i, i + 16_384));
    return { id: sha256, mediaType: info.mediaType, base64: btoa(raw), sha256, sizeBytes: data.length, width: info.width, height: info.height };
  } catch { return fail(); }
}
