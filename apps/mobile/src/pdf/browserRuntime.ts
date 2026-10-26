import * as library from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw';
import type { PdfRuntime } from './engine.ts';
import { bundledPdfResources } from './bundledResources.ts';
import { createOwnedPdfWorker } from './ownedWorker.ts';

// The lazy reader chunk includes this finite, version-matched resource set. Later pages and
// new document workers must also work after the browser goes offline, without a service worker.
const resources = import.meta.glob([
  '../../node_modules/pdfjs-dist/cmaps/*.bcmap',
  '../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  '../../node_modules/pdfjs-dist/wasm/*.wasm',
], {
  query: '?url&inline', import: 'default', eager: true,
}) as Record<string, string>;
// One Blob URL per loaded app page, not one per document. The module retains its source for
// every reopen; each PDF still owns and destroys its own worker rather than sharing PDF state.
let workerUrl: string | undefined;

export function browserPdfRuntime(): PdfRuntime {
  const bundled = bundledPdfResources(resources);
  return {
    library,
    createWorker() {
      workerUrl ??= URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      return createOwnedPdfWorker(library, new Worker(workerUrl, { type: 'module' }));
    },
    resourceError: bundled.error,
    options: { useWorkerFetch: false, BinaryDataFactory: bundled.BinaryDataFactory,
      cMapPacked: true, useSystemFonts: true },
  };
}
