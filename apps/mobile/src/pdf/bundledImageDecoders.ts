const decoderNames = ['openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js'] as const;
export type BundledImageDecoders = Record<(typeof decoderNames)[number], string>;

/** PDF.js imports JS fallbacks directly; BinaryDataFactory only supplies binary resources. */
export function createBundledImageDecoderUrl(sources: BundledImageDecoders): string {
  const modules = Object.fromEntries(decoderNames.map((name) => [name,
    URL.createObjectURL(new Blob([sources[name]], { type: 'text/javascript' })),
  ]));
  // PDF.js appends its fixed fallback filename to wasmUrl. A fragment preserves that
  // name without fetching a path below a Blob URL; both imports remain in-memory.
  // Only the two build-selected, version-matched decoders can be selected.
  const dispatcher = `
const modules = ${JSON.stringify(modules)};
export default async function () {
  const name = new URL(import.meta.url).hash.slice(2);
  if (!Object.prototype.hasOwnProperty.call(modules, name)) {
    throw new Error('Unknown bundled PDF image decoder');
  }
  const module = await import(modules[name]);
  return module.default();
}
`;
  return `${URL.createObjectURL(new Blob([dispatcher], { type: 'text/javascript' }))}#/`;
}
