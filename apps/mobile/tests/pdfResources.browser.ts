import { browserPdfRuntime } from '../src/pdf/browserRuntime.ts';
import { openVerifiedPdf } from '../src/pdf/engine.ts';
import expected from './fixtures/pdf-scanned/expected.json';
import jpx from './fixtures/pdf-scanned/jpx.pdf?url&inline';
import jbig2 from './fixtures/pdf-scanned/jbig2.pdf?url&inline';
import ccitt from './fixtures/pdf-scanned/ccitt.pdf?url&inline';

type Mode = 'wasm' | 'no-wasm' | 'instantiate-fails' | 'webassembly-missing';
const sources = { jpx, jbig2, ccitt };

async function sha256(bytes: Uint8ClampedArray) {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Scan render exceeded 10 seconds')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function run(mode: Mode) {
  const outcomes = [];
  for (const fixture of expected.fixtures) {
    const bytes = Uint8Array.from(atob(sources[fixture.name as keyof typeof sources].split(',')[1]), (value) => value.charCodeAt(0));
    // Fresh workers on reopen must decode again from the loaded app bundle while offline.
    for (const attempt of ['first-open', 'reopen']) {
      const runtime = browserPdfRuntime();
      if (mode === 'no-wasm') runtime.options = { ...runtime.options, useWasm: false };
      const pdf = await bounded(openVerifiedPdf(bytes, { runtime }));
      try {
        for (const index of attempt === 'first-open' ? [0, 1] : [1]) {
          const page = await pdf.page(index);
          const viewport = page.getViewport({ scale: 1 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width; canvas.height = viewport.height;
          const context = canvas.getContext('2d', { willReadFrequently: true })!;
          const label = `${mode} / ${fixture.name} / ${attempt} / page ${index + 1}`;
          const frame = document.createElement('figure');
          const caption = document.createElement('figcaption'); caption.textContent = label;
          frame.append(canvas, caption); document.body.append(frame);
          try {
            await bounded(page.render({ canvas, canvasContext: context, viewport }).promise);
            const resourceError = runtime.resourceError?.();
            if (resourceError) throw resourceError;
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let nonwhitePixels = 0;
            for (let offset = 0; offset < pixels.length; offset += 4) {
              if (pixels[offset] !== 255 || pixels[offset + 1] !== 255 || pixels[offset + 2] !== 255) nonwhitePixels++;
            }
            const rgbaSha256 = await sha256(pixels);
            const samples = fixture.pages[index].samples.map(([x, y]) => {
              const offset = (y * canvas.width + x) * 4;
              return [x, y, ...pixels.slice(offset, offset + 4)];
            });
            outcomes.push({ label, rgbaSha256, nonwhitePixels, samples,
              expectedSha256: fixture.pages[index].rgbaSha256,
              passed: rgbaSha256 === fixture.pages[index].rgbaSha256 });
          } catch (error) {
            outcomes.push({ label, passed: false, error: error instanceof Error ? error.message : String(error) });
          } finally { page.cleanup(); }
        }
      } finally { await pdf.close(); }
    }
  }
  return outcomes;
}

Object.assign(window, { pdfResourcesRun: run });
