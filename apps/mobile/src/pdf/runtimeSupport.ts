import { PdfError } from './errors.ts';

/** Report an unsupported runtime if it cannot provide the method after setup. */
export function assertPdfRuntimeSupported(): void {
  if (typeof Reflect.get(Promise, 'withResolvers') !== 'function') {
    throw new PdfError('READER_UNSUPPORTED');
  }
}
