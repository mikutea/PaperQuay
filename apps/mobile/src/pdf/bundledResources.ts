import { PdfError } from './errors.ts';

const kinds: Record<string, string> = {
  cmaps: 'cMapUrl', standard_fonts: 'standardFontDataUrl', wasm: 'wasmUrl',
};

/** Only build-selected PDF.js resources may be requested; no PDF-controlled URL is fetched. */
export function bundledPdfResources(resources: Record<string, string>) {
  const byKind = new Map<string, Map<string, string>>();
  for (const [path, dataUrl] of Object.entries(resources)) {
    const parts = path.split('/');
    const kind = kinds[parts[parts.length - 2]];
    if (!kind) continue;
    let files = byKind.get(kind);
    if (!files) { files = new Map(); byKind.set(kind, files); }
    files.set(parts[parts.length - 1], dataUrl);
  }
  let failure: PdfError | null = null;
  class BinaryDataFactory {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      try {
        const dataUrl = byKind.get(kind)?.get(filename);
        const encoded = dataUrl && /^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)?.[1];
        if (!encoded) throw new Error('Missing bundled PDF resource');
        // PDF.js transfers resource buffers to its worker. Never reuse a transferred buffer.
        return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      } catch {
        failure = new PdfError('READER_RESOURCE');
        throw failure;
      }
    }
  }
  return { BinaryDataFactory, error: () => failure };
}
