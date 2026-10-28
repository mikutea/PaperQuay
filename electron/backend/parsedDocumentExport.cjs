const path = require('node:path');
const { createHash } = require('node:crypto');
const nativeFs = require('./nativeFs.cjs');
const { createParsedDocumentProvenance } = require('./parsedDocumentProvenance.cjs');

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Count pages from the captured PDF itself, never from OCR page dictionaries,
 * a renderer value, a filename, or an unverified attachment metadata field. */
async function inspectPdfPageCount(bytes) {
  let task, document, timer;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false,
      disableFontFace: true, stopAtErrors: true, verbosity: 0 });
    document = await Promise.race([task.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PDF inspection timed out')), 15_000);
    })]);
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > 2000)
      fail('DESKTOP_PARSED_PDF_INVALID');
    return document.numPages;
  } catch { fail('DESKTOP_PARSED_PDF_INVALID'); }
  finally { clearTimeout(timer); if (document) await document.destroy(); else await task?.destroy(); }
}

function createParsedDocumentExporter(context, options = {}) {
  const provenance = context.parsedDocumentProvenance ||= createParsedDocumentProvenance(context);
  const core = () => options.core || require('../generated/desktopSyncCore.cjs');
  const converter = () => options.converter || require('../generated/desktopParsedDocument.cjs');
  async function prepare({ binding, bytes, expectedPageCount = null, check = () => {} }) {
    check();
    const pdf = { sha256: sha(bytes), sizeBytes: bytes.length };
    if (pdf.sha256 !== binding.sha256 || pdf.sizeBytes !== binding.sizeBytes) fail('DESKTOP_SOURCE_CHANGED');
    const record = await provenance.readForPdf(pdf); check();
    const pageCount = await (options.inspectPdfPageCount || inspectPdfPageCount)(bytes); check();
    if (expectedPageCount !== null && expectedPageCount !== pageCount) fail('DESKTOP_PARSED_PAGE_MISMATCH');
    const jsonPath = path.join(record.root, record.json);
    const jsonBytes = await provenance.readFile(record, jsonPath); check();
    let assetTotalBytes = 0, assetCount = 0;
    try {
      const document = await converter().createPortableParsedDocument({
        paperId: binding.paperId, attachmentVersionId: binding.attachmentVersionId,
        pdf: { ...pdf, pageCount }, parser: record.parser, jsonPath, jsonText: jsonBytes.toString('utf8'),
        readAsset: async (file, id) => {
          check();
          const data = await provenance.readFile(record, file); check();
          assetTotalBytes += data.length; assetCount++;
          if (data.length > core().PARSED_LIMITS.maxAssetBytes || assetTotalBytes > core().PARSED_LIMITS.maxAssetTotalBytes ||
              assetCount > core().PARSED_LIMITS.maxAssets) fail('DESKTOP_PARSED_PACKAGE_TOO_LARGE');
          const dimensions = core().inspectParsedImage(new Uint8Array(data));
          return { id, ...dimensions, base64: data.toString('base64'), sha256: sha(data), sizeBytes: data.length };
        },
      });
      check();
      const verified = await core().verifyParsedDocument(document); check();
      const output = Buffer.from(JSON.stringify(verified.document));
      if (output.length > core().PARSED_LIMITS.maxPackageBytes) fail('DESKTOP_PARSED_PACKAGE_TOO_LARGE');
      return { bytes: output, blockCount: document.blocks.length, assetCount: document.assets.length };
    } catch (error) {
      if (String(error.code || '').startsWith('DESKTOP_')) throw error;
      if (error.code === 'PACKAGE_LIMIT') fail('DESKTOP_PARSED_PACKAGE_TOO_LARGE');
      fail('DESKTOP_PARSED_OUTPUT_INVALID');
    }
  }
  async function save(prepared, { fileName, event, check = () => {}, beforeWrite = async () => {} }) {
    check();
    const pickerOptions = { title: '导出解析包 / Export parsed document',
      defaultPath: String(fileName || 'paper').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-').replace(/\.pdf$/i, '').slice(0, 150) + '.paperquay-parsed.json',
      filters: [{ name: 'PaperQuay parsed document', extensions: ['json'] }] };
    let result;
    if (options.showSaveDialog) result = await options.showSaveDialog(pickerOptions);
    else {
      const { dialog, BrowserWindow } = require('electron');
      const window = event?.sender && BrowserWindow.fromWebContents(event.sender);
      result = window ? await dialog.showSaveDialog(window, pickerOptions) : await dialog.showSaveDialog(pickerOptions);
    }
    check();
    if (result.canceled || !result.filePath) return { status: 'cancelled' };
    // Revalidate session, binding, current PDF and server version after the
    // native dialog, which can stay open while sign-out/removal happens.
    await beforeWrite(); check();
    const destination = result.filePath;
    if (!path.isAbsolute(destination) || destination.includes('\0')) fail('DESKTOP_PARSED_SAVE_FAILED');
    try {
      const pinned = nativeFs.inspectSync(destination);
      if (pinned.linkPath || path.resolve(pinned.actual) !== path.resolve(destination)) fail('DESKTOP_PARSED_SAVE_FAILED');
      await nativeFs.write(destination, prepared.bytes, { mode: 0o600 });
    } catch { fail('DESKTOP_PARSED_SAVE_FAILED'); }
    return { status: 'exported', blockCount: prepared.blockCount, assetCount: prepared.assetCount };
  }
  return { prepare, save };
}

module.exports = { createParsedDocumentExporter, inspectPdfPageCount };
