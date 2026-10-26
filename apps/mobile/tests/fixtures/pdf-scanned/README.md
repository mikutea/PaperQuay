# Original scan fixtures

These three tiny, two-page PDFs contain original geometric artwork and are dedicated to the public domain under CC0-1.0. No downloaded paper or third-party image is included. `generate.py` contains the artwork, PDF assembly, and explicit license notice.

- `jpx.pdf`: lossless RGB JPEG2000; generated with Pillow's OpenJPEG encoder.
- `jbig2.pdf`: embedded JBIG2 generic regions with MMR coding.
- `ccitt.pdf`: CCITT Group 4 monochrome image streams.

`expected.json` records encoder versions, fixture byte hashes, exact RGBA pixel hashes, and sampled pixels. It is generated from the original artwork, not from the decoder being tested. Normal tests use the checked-in PDFs; Python/Pillow are only needed to regenerate them.

From `apps/mobile`, run the ordinary Node regression with `node --import tsx --test tests/pdfResources.test.ts`. It uses the explicitly pinned `@napi-rs/canvas` development dependency and the installed version of PDF.js, both with WASM enabled and disabled.

`node tests/pdfResources.browser.mjs` builds a separate temporary regression entry, starts an ephemeral loopback server and uses an installed Playwright browser. Set `PLAYWRIGHT_MODULE` to an existing Playwright ESM entry if the project has no local Playwright package. `--artifacts=<absolute path>` selects an external evidence directory. It tests loaded-app offline first render, later pages, and fresh-Worker reopen with normal WASM, disabled WASM, rejected instantiation, and no WebAssembly global. `--baseline` only permits recording failed results; it does not disable or revert the production fix.

Passing these small fixtures does not establish support for every JBIG2 segment variant, full color-management fidelity, all WebViews, or very large scanned files.
