import { PdfError } from './errors.ts';

/** PDF.js needs this API even in its legacy build; a reload cannot supply it. */
export function assertPdfRuntimeSupported(): void {
  if (typeof Reflect.get(Promise, 'withResolvers') !== 'function') {
    throw new PdfError('READER_UNSUPPORTED');
  }
}
