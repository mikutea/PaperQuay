import * as library from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PdfRuntime } from './engine.ts';

// Vite emits only local, version-matched resources. A PDF cannot select an arbitrary fetch URL.
const resources = import.meta.glob('../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*', {
  query: '?url', import: 'default', eager: true,
}) as Record<string, string>;
const byKind: Record<string, Map<string, string>> = {
  cMapUrl: new Map(), standardFontDataUrl: new Map(), wasmUrl: new Map(),
};
for (const [path, url] of Object.entries(resources)) {
  const parts = path.split('/');
  const directory = parts[parts.length - 2];
  const filename = parts[parts.length - 1];
  const kind = directory === 'cmaps' ? 'cMapUrl' : directory === 'standard_fonts' ? 'standardFontDataUrl' : 'wasmUrl';
  byKind[kind].set(filename, url);
}
class LocalBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = byKind[kind]?.get(filename);
    if (!url) throw new Error('PDF resource unavailable');
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('PDF resource unavailable');
    return new Uint8Array(await response.arrayBuffer());
  }
}

export function browserPdfRuntime(): PdfRuntime {
  library.GlobalWorkerOptions.workerSrc = workerUrl;
  return { library, options: { useWorkerFetch: false, BinaryDataFactory: LocalBinaryDataFactory,
    cMapPacked: true, useSystemFonts: true } };
}
