// Actual browser / worker regression. Uses an installed Playwright via PLAYWRIGHT_MODULE
// when it is not available in this checkout; no package installation or app dist build.
// Run: node tests/pdfResources.browser.mjs [--baseline] [--artifacts=<absolute path>]
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifactsArg = process.argv.find((argument) => argument.startsWith('--artifacts='))?.slice(12);
const artifacts = artifactsArg ? resolve(artifactsArg) : await mkdtemp(join(tmpdir(), 'paperquay-pdf-resources-'));
await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(join(tmpdir(), 'paperquay-pdf-resources-build-'));
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
await build({
  configFile: false, root: appRoot, logLevel: 'warn',
  build: { target: ['es2022', 'safari15'], outDir: output, emptyOutDir: true,
    lib: { entry: join(appRoot, 'tests/pdfResources.browser.ts'), formats: ['es'], fileName: () => 'regression.js' } },
});
const bundle = await readFile(join(output, 'regression.js'));
const html = '<!doctype html><meta charset="utf-8"><title>Original scan decoding regression</title><style>body{font:14px system-ui;display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;width:220px}canvas{width:192px;height:192px;image-rendering:pixelated;border:1px solid #777}figcaption{padding:6px}</style><script type="module" src="/regression.js"></script>';
const server = createServer((request, response) => {
  if (request.url === '/regression.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(bundle); }
  else if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); }
  else { response.writeHead(404); response.end(); }
});
await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
const browser = await playwright.chromium.launch({ channel: process.env.PDF_RESOURCES_BROWSER || 'chrome', headless: true });
const modes = ['wasm', 'no-wasm', 'instantiate-fails', 'webassembly-missing'];
const reports = [];
try {
  for (const mode of modes) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addInitScript(({ mode }) => {
      const OriginalWorker = globalThis.Worker;
      const instrumentation = { liveWorkers: 0, createdWorkers: 0 };
      Object.assign(globalThis, { pdfResourcesWorkers: instrumentation });
      if (mode === 'webassembly-missing') Object.defineProperty(globalThis, 'WebAssembly', { value: undefined, configurable: true });
      globalThis.Worker = class extends OriginalWorker {
        constructor(url, options) {
          let wrapper;
          const prelude = mode === 'instantiate-fails' ? 'WebAssembly.instantiate = async () => { throw new Error("WASM intentionally unavailable in regression"); };'
            : mode === 'webassembly-missing' ? 'globalThis.WebAssembly = undefined;' : '';
          if (prelude) {
            wrapper = URL.createObjectURL(new Blob([`${prelude}\nawait import(${JSON.stringify(String(url))});`], { type: 'text/javascript' }));
          }
          super(wrapper || url, options);
          instrumentation.liveWorkers++; instrumentation.createdWorkers++;
          const terminate = this.terminate.bind(this);
          let terminated = false;
          this.terminate = () => {
            if (terminated) return;
            terminated = true; instrumentation.liveWorkers--;
            if (wrapper) URL.revokeObjectURL(wrapper);
            terminate();
          };
        }
      };
    }, { mode });
    const page = await context.newPage();
    const messages = [];
    page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') messages.push(message.text()); });
    page.on('pageerror', (error) => messages.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => typeof window.pdfResourcesRun === 'function');
    await context.setOffline(true);
    const offlineRequests = [];
    context.on('request', (request) => { if (/^https?:/.test(request.url())) offlineRequests.push(request.url()); });
    const results = await page.evaluate((mode) => window.pdfResourcesRun(mode), mode);
    const workers = await page.evaluate(() => window.pdfResourcesWorkers);
    reports.push({ mode, offlineRequests, workers, results, messages });
    await page.screenshot({ path: join(artifacts, `${mode}.png`), fullPage: true });
    await context.close();
    console.log(JSON.stringify({ mode, passed: results.filter((result) => result.passed).length, total: results.length, offlineRequests, workers,
      failures: results.filter((result) => !result.passed).map(({ label, error, nonwhitePixels }) => ({ label, error, nonwhitePixels })) }));
  }
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ browser: browser.version(), reports }, null, 2));
  console.log(`Artifacts: ${artifacts}`);
  if (!process.argv.includes('--baseline')) {
    assert(reports.every((report) => report.results.every((result) => result.passed)), 'Every rendered pixel must match the original artwork');
    assert(reports.every((report) => report.offlineRequests.length === 0), 'No HTTP request may be attempted after going offline');
    assert(reports.every((report) => report.workers.liveWorkers === 0 && report.workers.createdWorkers === 6), 'Every reopen must create and dispose its real worker');
  }
} finally {
  await browser.close();
  await new Promise((resolveClosed) => server.close(resolveClosed));
  assert.equal(dirname(resolve(output)), resolve(tmpdir()));
  assert(basename(output).startsWith('paperquay-pdf-resources-build-'));
  await rm(output, { recursive: true, force: true });
}
