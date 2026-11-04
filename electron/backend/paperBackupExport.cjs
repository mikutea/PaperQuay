const path = require('node:path');
const nativeFs = require('./nativeFs.cjs');
const MAX_BACKUP_BYTES = 32 * 1024 * 1024 + 4096;
const fail = code => { throw Object.assign(Error(code), { code }); };
function createPaperBackupExporter(options = {}) {
  const files = options.files || nativeFs;
  return { async save(backup, { event, check = () => {} } = {}) {
    check(); if (backup?.format !== 'paperquay-desktop-paper-backup' || backup.version !== 1) fail('PAPER_BACKUP_INVALID');
    const bytes = Buffer.from(JSON.stringify(backup)); if (bytes.length > MAX_BACKUP_BYTES) fail('PAPER_BACKUP_TOO_LARGE');
    const settings = { title: '备份账号题录与阅读安排 / Back up paper details and reading plans', defaultPath: 'PaperQuay-papers-' + new Date().toISOString().slice(0, 10) + '.json', filters: [{ name: 'PaperQuay paper backup', extensions: ['json'] }] };
    let chosen;
    if (options.showSaveDialog) chosen = await options.showSaveDialog(settings);
    else { const { dialog, BrowserWindow } = require('electron'), window = event?.sender && BrowserWindow.fromWebContents(event.sender); chosen = window ? await dialog.showSaveDialog(window, settings) : await dialog.showSaveDialog(settings); }
    check(); if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' }; const destination = chosen.filePath;
    if (!path.isAbsolute(destination) || destination.includes('\0')) fail('PAPER_BACKUP_SAVE_FAILED');
    const pinned = files.inspectSync(destination); if (pinned.linkPath || path.resolve(pinned.actual) !== path.resolve(destination)) fail('PAPER_BACKUP_SAVE_FAILED');
    check(); try { await files.write(destination, bytes, { mode: 0o600 }); } catch { fail('PAPER_BACKUP_SAVE_FAILED'); }
    return { status: 'exported', bytes: bytes.length };
  } };
}
module.exports = { createPaperBackupExporter, MAX_BACKUP_BYTES };
