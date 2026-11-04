const path = require('node:path');
const nativeFs = require('./nativeFs.cjs');
const fail = code => { throw Object.assign(Error(code), { code }); };
function createGraphEvidenceExporter(options = {}) {
  const files = options.files || nativeFs;
  return { async save(input, { event, check = async () => {}, checkCurrent = () => {} } = {}) {
    const core = options.core || require('../generated/desktopSyncCore.cjs');
    const snapshot = await core.verifyGraphEvidence(input), bytes = Buffer.from(JSON.stringify(snapshot));
    if (bytes.length > core.GRAPH_EVIDENCE_LIMITS.bytes) fail('GRAPH_EVIDENCE_LIMIT');
    await check();
    const settings = { title: '保存图谱来源包 / Save graph evidence', defaultPath: 'PaperQuay-graph-evidence-' + new Date().toISOString().slice(0, 10) + '.json', filters: [{ name: 'PaperQuay graph evidence', extensions: ['json'] }] };
    let chosen;
    if (options.showSaveDialog) chosen = await options.showSaveDialog(settings);
    else { const { dialog, BrowserWindow } = require('electron'), window = event?.sender && BrowserWindow.fromWebContents(event.sender); chosen = window ? await dialog.showSaveDialog(window, settings) : await dialog.showSaveDialog(settings); }
    await check();
    if (chosen.canceled || !chosen.filePath) return { saved: false, cancelled: true };
    const destination = chosen.filePath;
    if (!path.isAbsolute(destination) || destination.includes('\0')) fail('GRAPH_EVIDENCE_EXPORT_FAILED');
    const pinned = files.inspectSync(destination);
    if (pinned.linkPath || path.resolve(pinned.actual) !== path.resolve(destination)) fail('GRAPH_EVIDENCE_EXPORT_FAILED');
    // A bounded synchronous NativeFS atomic write leaves no JS event turn
    // between the last source/owner check and committing the selected file.
    checkCurrent();
    try { files.writeSync(destination, bytes, { mode: 0o600 }); } catch { fail('GRAPH_EVIDENCE_EXPORT_FAILED'); }
    return { saved: true, bytes: bytes.length, digest: snapshot.digest };
  } };
}
module.exports = { createGraphEvidenceExporter };
