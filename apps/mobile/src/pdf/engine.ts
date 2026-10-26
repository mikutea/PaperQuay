import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, PDFWorker } from 'pdfjs-dist';
import type { DocumentInitParameters, TextItem } from 'pdfjs-dist/types/src/display/api.d.ts';
import { checkCompletePdfBytes, sha256 } from './acquisition.ts';
import { PdfError, boundedSignal, throwIfAborted } from './errors.ts';
import { PDF_LIMITS, type PdfVersion } from './types.ts';
import type { CropBox } from './geometry.ts';
import { boundedTextContent } from './textContent.ts';
import type { PdfWorkerLease } from './ownedWorker.ts';

export interface PdfPageInfo { cropBox: CropBox; width: number; height: number; rotation: number; userUnit: number }
export interface PdfOutlineItem { title: string; pageIndex: number | null; depth: number }
export interface PdfSearchMatch { pageIndex: number; excerpt: string; offset: number }
export interface PdfRuntime {
  library: typeof import('pdfjs-dist');
  options?: Partial<DocumentInitParameters>;
  createWorker?: () => PdfWorkerLease;
  resourceError?: () => PdfError | null;
}

async function destroyPdfTask(task: PDFDocumentLoadingTask | undefined, dispose: () => void): Promise<void> {
  if (!task) { dispose(); return; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A crashed worker cannot acknowledge document termination. Do not retain it indefinitely.
    await Promise.race([
      task.destroy().catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, PDF_LIMITS.teardownTimeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer); dispose();
  }
}

export class VerifiedPdf {
  readonly document: PDFDocumentProxy;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly pages: PdfPageInfo[];
  readonly pageCount: number;
  private disposed = false;
  private closing: Promise<void> | undefined;
  private readonly textCache = new Map<number, string>();
  private readonly detachAbort: () => void;

  constructor(document: PDFDocumentProxy, hash: string, size: number, pages: PdfPageInfo[], signal?: AbortSignal,
    private readonly runtime?: { dispose: () => void; resourceError?: () => PdfError | null }) {
    this.document = document; this.sha256 = hash; this.sizeBytes = size; this.pages = pages; this.pageCount = pages.length;
    const abort = () => { void this.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    this.detachAbort = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) abort();
  }

  async page(index: number): Promise<PDFPageProxy> {
    if (this.disposed) throw new PdfError('CANCELLED');
    if (!Number.isInteger(index) || index < 0 || index >= this.pageCount) throw new PdfError('INVALID_PDF');
    const page = await this.document.getPage(index + 1);
    if (this.disposed) throw new PdfError('CANCELLED');
    return page;
  }

  async text(pageIndex: number, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    if (this.disposed) throw new PdfError('CANCELLED');
    const cached = this.textCache.get(pageIndex);
    if (cached !== undefined) {
      this.textCache.delete(pageIndex); this.textCache.set(pageIndex, cached); return cached;
    }
    const page = await this.page(pageIndex);
    try {
      const content = await boundedTextContent(page, signal);
      throwIfAborted(signal);
      if (this.disposed) throw new PdfError('CANCELLED');
      const resourceError = this.runtime?.resourceError?.();
      if (resourceError) throw resourceError;
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const run = item as TextItem;
        text += run.str + (run.hasEOL ? '\n' : ' ');
        if (text.length > PDF_LIMITS.maxTextPageCharacters) throw new PdfError('TEXT_LIMIT');
      }
      text = text.trim();
      this.textCache.set(pageIndex, text);
      while (this.textCache.size > 8) this.textCache.delete(this.textCache.keys().next().value!);
      return text;
    } finally { page.cleanup(); }
  }

  async documentText(signal?: AbortSignal, onProgress?: (pageCount: number) => void): Promise<{ pageIndex: number; text: string }[]> {
    const pages: { pageIndex: number; text: string }[] = [];
    let count = 0;
    for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
      throwIfAborted(signal);
      const text = await this.text(pageIndex, signal);
      count += text.length;
      if (count > PDF_LIMITS.maxDocumentTextCharacters) throw new PdfError('TEXT_LIMIT');
      pages.push({ pageIndex, text });
      onProgress?.(pageIndex + 1);
    }
    if (!pages.some((page) => page.text.trim())) throw new PdfError('NO_TEXT');
    return pages;
  }

  async search(query: string, signal?: AbortSignal, onProgress?: (pageCount: number) => void): Promise<{
    matches: PdfSearchMatch[]; limited: boolean;
  }> {
    const needle = query.trim().slice(0, 200).toLocaleLowerCase();
    if (!needle) return { matches: [], limited: false };
    const matches: PdfSearchMatch[] = [];
    for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
      const text = await this.text(pageIndex, signal);
      const lower = text.toLocaleLowerCase();
      let offset = lower.indexOf(needle);
      while (offset >= 0) {
        if (matches.length === PDF_LIMITS.maxSearchResults) return { matches, limited: true };
        matches.push({ pageIndex, offset, excerpt: text.slice(Math.max(0, offset - 36), offset + needle.length + 72) });
        offset = lower.indexOf(needle, offset + Math.max(needle.length, 1));
      }
      onProgress?.(pageIndex + 1);
    }
    return { matches, limited: false };
  }

  async outline(signal?: AbortSignal): Promise<PdfOutlineItem[]> {
    const outline = await this.document.getOutline();
    if (!outline) return [];
    const output: PdfOutlineItem[] = [];
    const visit = async (items: typeof outline, depth: number): Promise<void> => {
      for (const item of items) {
        throwIfAborted(signal);
        if (this.disposed) throw new PdfError('CANCELLED');
        if (output.length >= 500 || depth > 16) return;
        let pageIndex: number | null = null;
        try {
          const destination = typeof item.dest === 'string' ? await this.document.getDestination(item.dest) : item.dest;
          if (Array.isArray(destination) && destination.length) {
            const first = destination[0];
            const index = typeof first === 'number' ? first : await this.document.getPageIndex(first);
            if (Number.isInteger(index) && index >= 0 && index < this.pageCount) pageIndex = index;
          }
        } catch { /* A broken or external destination is displayed without a navigation action. */ }
        output.push({ title: String(item.title).slice(0, 500), pageIndex, depth });
        if (item.items?.length) await visit(item.items, depth + 1);
      }
    };
    await visit(outline, 0);
    return output;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true; this.detachAbort(); this.textCache.clear();
    return this.closing = destroyPdfTask(this.document.loadingTask, () => this.runtime?.dispose());
  }
}

/** The caller keeps bytes for cache persistence; only a bounded copy transfers to PDF.js. */
export async function openVerifiedPdf(bytes: Uint8Array, options: {
  expected?: PdfVersion;
  signal?: AbortSignal;
  runtime?: PdfRuntime;
} = {}): Promise<VerifiedPdf> {
  throwIfAborted(options.signal);
  checkCompletePdfBytes(bytes);
  const hash = await sha256(bytes);
  throwIfAborted(options.signal);
  if (options.expected && (options.expected.data.sha256 !== hash || options.expected.data.sizeBytes !== bytes.length)) {
    throw new PdfError('VERSION_MISMATCH');
  }
  const library = options.runtime?.library ?? await import('pdfjs-dist/legacy/build/pdf.mjs');
  throwIfAborted(options.signal);
  const bounded = boundedSignal(options.signal, PDF_LIMITS.operationTimeoutMs);
  let task: PDFDocumentLoadingTask | undefined;
  let worker: PDFWorker | undefined;
  let ownedWorker: PdfWorkerLease | undefined;
  let workerDisposed = false;
  const disposeWorker = () => {
    if (workerDisposed || !ownedWorker) return;
    workerDisposed = true; ownedWorker.dispose();
  };
  let destroying: Promise<void> | undefined;
  const destroyTask = () => destroying ??= destroyPdfTask(task, disposeWorker);
  let rejectAbort!: (error: PdfError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  // The same cancellation promise also covers a worker that never finishes initialization.
  void aborted.catch(() => undefined);
  const abort = () => {
    rejectAbort(bounded.error());
    // Keep an initialized worker alive until its document transport has acknowledged teardown.
    void destroyTask();
  };
  bounded.signal.addEventListener('abort', abort, { once: true });
  try {
    if (options.runtime?.createWorker) {
      try {
        ownedWorker = options.runtime.createWorker();
        throwIfAborted(bounded.signal);
        worker = await Promise.race([ownedWorker.ready, aborted]);
      } catch {
        if (bounded.signal.aborted) throw bounded.error();
        throw new PdfError('READER_UNAVAILABLE');
      }
    }
    throwIfAborted(bounded.signal);
    task = library.getDocument({ ...options.runtime?.options, ...(worker ? { worker } : {}), data: bytes.slice(),
      verbosity: 0, enableXfa: false, stopAtErrors: true, disableAutoFetch: true, disableStream: true,
      maxImageSize: 32 * 1024 * 1024, canvasMaxAreaInBytes: 16 * 1024 * 1024,
    });
    const document = await Promise.race([task.promise, aborted]);
    if (!Number.isInteger(document.numPages) || document.numPages < 1) throw new PdfError('INVALID_PDF');
    if (document.numPages > PDF_LIMITS.maxPages) throw new PdfError('TOO_MANY_PAGES');
    if (options.expected?.data.pageCount != null && options.expected.data.pageCount !== document.numPages) {
      throw new PdfError('VERSION_MISMATCH');
    }
    const pages: PdfPageInfo[] = [];
    for (let index = 0; index < document.numPages; index++) {
      throwIfAborted(bounded.signal);
      const page = await Promise.race([document.getPage(index + 1), aborted]);
      const viewport = page.getViewport({ scale: 1 });
      if (page.view.length !== 4 || !page.view.every(Number.isFinite) || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
        || viewport.width <= 0 || viewport.height <= 0 || viewport.width > 20_000 || viewport.height > 20_000) {
        throw new PdfError('INVALID_PDF');
      }
      pages.push({ cropBox: [page.view[0], page.view[1], page.view[2], page.view[3]], width: viewport.width, height: viewport.height,
        rotation: page.rotate, userUnit: page.userUnit });
      page.cleanup();
    }
    if (bounded.signal.aborted) throw bounded.error();
    const resourceError = options.runtime?.resourceError?.();
    if (resourceError) throw resourceError;
    return new VerifiedPdf(document, hash, bytes.length, pages, options.signal,
      { dispose: disposeWorker, resourceError: options.runtime?.resourceError });
  } catch (error) {
    await destroyTask();
    disposeWorker();
    if (bounded.signal.aborted) throw bounded.error();
    const resourceError = options.runtime?.resourceError?.();
    if (resourceError) throw resourceError;
    if (error instanceof PdfError) throw error;
    if (error instanceof Error && error.name === 'PasswordException') throw new PdfError('PASSWORD');
    throw new PdfError('INVALID_PDF');
  } finally {
    bounded.signal.removeEventListener('abort', abort);
    bounded.close();
  }
}
