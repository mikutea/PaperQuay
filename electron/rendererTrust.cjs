const path = require('node:path');
const { pathToFileURL } = require('node:url');

const entryUrl = process.env.VITE_DEV_SERVER_URL || pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;

function isTrustedRendererUrl(value, expected = entryUrl) {
  try {
    const actual = new URL(value), entry = new URL(expected);
    actual.hash = ''; entry.hash = '';
    return actual.href === entry.href;
  } catch { return false; }
}

function externalHttpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

function attachRendererTrust(contents, openExternal, expected = entryUrl) {
  const external = (url) => {
    const target = externalHttpUrl(url);
    if (target) void Promise.resolve(openExternal(target)).catch(() => {});
  };
  contents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  contents.on('will-navigate', (event, legacyUrl) => {
    const url = event.url || legacyUrl;
    if (isTrustedRendererUrl(url, expected)) return;
    event.preventDefault(); external(url);
  });
  contents.on('will-frame-navigate', (event) => {
    // Keep sandboxed srcDoc previews working, but never load a foreign document
    // in a child frame. Main-frame HTTP links are handled by will-navigate.
    if (!event.isMainFrame) {
      if (!['about:blank', 'about:srcdoc'].includes(event.url)) event.preventDefault();
    } else if (!isTrustedRendererUrl(event.url, expected) && !externalHttpUrl(event.url)) {
      event.preventDefault();
    }
  });
  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame || !isTrustedRendererUrl(event.url, expected)) event.preventDefault();
  });
}

function assertTrustedRenderer(event, trustedContents, expected = entryUrl) {
  if (!trustedContents.has(event.sender) || !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(event.senderFrame.url, expected)) {
    throw new Error('IPC is restricted to the trusted PaperQuay main frame.');
  }
}

module.exports = { isTrustedRendererUrl, externalHttpUrl, attachRendererTrust, assertTrustedRenderer };
