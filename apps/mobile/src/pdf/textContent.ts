import type { PDFPageProxy } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api.d.ts';
import { PDF_LIMITS } from './types.ts';
import { boundedSignal, PdfError, throwIfAborted } from './errors.ts';

/** Stop the worker stream at the page budget rather than buffering an unbounded text layer. */
export async function boundedTextContent(page: PDFPageProxy, signal?: AbortSignal): Promise<TextContent> {
  throwIfAborted(signal);
  const bounded = boundedSignal(signal, PDF_LIMITS.requestTimeoutMs);
  let reader: ReadableStreamDefaultReader<TextContent> | undefined;
  let cancelling: Promise<void> | undefined;
  const cancel = (reason: Error) => { cancelling ??= reader?.cancel(reason).catch(() => undefined); };
  const abort = () => { cancel(bounded.error()); };
  const result: TextContent = { items: [], styles: Object.create(null), lang: null };
  let characters = 0;
  try {
    reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
    bounded.signal.addEventListener('abort', abort, { once: true });
    while (true) {
      throwIfAborted(bounded.signal);
      const part = await reader.read();
      if (bounded.signal.aborted) throw bounded.error();
      if (part.done) break;
      for (const item of part.value.items) {
        if ('str' in item) characters += item.str.length + 1;
        if (characters > PDF_LIMITS.maxTextPageCharacters || result.items.length >= 20_000) throw new PdfError('TEXT_LIMIT');
        result.items.push(item);
      }
      Object.assign(result.styles, part.value.styles);
      if (Object.keys(result.styles).length > 20_000) throw new PdfError('TEXT_LIMIT');
      result.lang = part.value.lang ?? result.lang;
    }
    return result;
  } catch (error) {
    if (bounded.signal.aborted) { const reason = bounded.error(); cancel(reason); throw reason; }
    cancel(error instanceof Error ? error : new PdfError('INVALID_PDF'));
    throw error;
  } finally {
    bounded.signal.removeEventListener('abort', abort); bounded.close();
    // PDF.js requires an Error to send CANCEL. A stopped worker may never send CANCEL_COMPLETE.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (cancelling) await Promise.race([cancelling,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, PDF_LIMITS.teardownTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); reader?.releaseLock(); }
  }
}
