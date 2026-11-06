import type { ParsedDocumentPackage } from '../../../../packages/sync-core/src/parsedDocument.ts';
import { PdfError, throwIfAborted } from '../pdf/errors.ts';

export interface ParsedAssets { urls: ReadonlyMap<string, string>; release(): void }

/** Decode only verified package bytes. No path or remote URL enters an image element. */
export async function prepareParsedAssets(document: ParsedDocumentPackage, signal: AbortSignal): Promise<ParsedAssets> {
  const urls = new Map<string, string>();
  const release = () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); };
  try {
    for (const asset of document.assets) {
      throwIfAborted(signal);
      const raw = atob(asset.base64);
      const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: asset.mediaType }));
      urls.set(asset.id, url);
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        const finish = (failure?: unknown) => {
          clearTimeout(timer); signal.removeEventListener('abort', abort);
          image.onload = null; image.onerror = null; image.removeAttribute('src');
          failure ? reject(failure) : resolve();
        };
        const abort = () => finish(new PdfError('CANCELLED'));
        const timer = setTimeout(() => finish(new PdfError('CACHE_CORRUPT')), 10_000);
        signal.addEventListener('abort', abort, { once: true });
        image.onload = () => finish(image.naturalWidth === asset.width && image.naturalHeight === asset.height
          ? undefined : new PdfError('CACHE_CORRUPT'));
        image.onerror = () => finish(new PdfError('CACHE_CORRUPT'));
        if (signal.aborted) abort(); else image.src = url;
      });
    }
    throwIfAborted(signal);
    return { urls, release };
  } catch (error) { release(); throw error; }
}
