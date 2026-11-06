import type { PDFWorker } from 'pdfjs-dist';
import { PdfError } from './errors.ts';

export interface PdfWorkerLease {
  ready: Promise<PDFWorker>;
  dispose: () => void;
}

/** PDF.js does not own ports supplied to it, so retain and terminate the actual worker. */
export function createOwnedPdfWorker(library: Pick<typeof import('pdfjs-dist'), 'PDFWorker'>, port: Worker): PdfWorkerLease {
  let worker: PDFWorker | undefined;
  let disposed = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const portReady = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Construction can fail before the combined readiness promise exists.
  void portReady.catch(() => undefined);
  const detach = () => {
    port.removeEventListener('message', onMessage);
    port.removeEventListener('error', onError);
    port.removeEventListener('messageerror', onError);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; detach(); rejectReady(new PdfError('CANCELLED'));
    try { worker?.destroy(); } finally { port.terminate(); }
  };
  const onError = () => { rejectReady(new PdfError('READER_UNAVAILABLE')); dispose(); };
  const onMessage = (event: MessageEvent) => {
    const message = event.data;
    if (message?.sourceName !== 'worker' || message?.targetName !== 'main' || message?.action !== 'ready') return;
    // Match PDF.js's own startup transfer check before passing this worker to getDocument.
    if (!(message.data instanceof Uint8Array)) { onError(); return; }
    detach(); resolveReady();
  };
  port.addEventListener('message', onMessage);
  port.addEventListener('error', onError);
  port.addEventListener('messageerror', onError);
  try {
    worker = library.PDFWorker.create({ port, verbosity: 0 });
  } catch (error) {
    dispose(); throw error;
  }
  const ready = Promise.all([worker.promise, portReady]).then(() => {
    if (disposed) throw new PdfError('CANCELLED');
    return worker!;
  });
  void ready.catch(() => undefined);
  return { ready, dispose };
}
