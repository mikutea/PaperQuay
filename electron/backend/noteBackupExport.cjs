const path = require('node:path');
const nativeFs = require('./nativeFs.cjs');
const MAX_BACKUP_BYTES = 32 * 1024 * 1024 + 4096;
const fail = code => { throw Object.assign(Error(code), { code }); };
function createNoteBackupExporter(options = {}) {
  const files = options.files || nativeFs;
  return { async save(backup, { event, check = () => {} } = {}) {
    check(); if (backup?.format !== 'paperquay-desktop-note-backup' || backup.version !== 1) fail('NOTE_BACKUP_INVALID');
    const bytes = Buffer.from(JSON.stringify(backup)); if (bytes.length > MAX_BACKUP_BYTES) fail('NOTE_BACKUP_TOO_LARGE');
    const settings = { title: '备份账号笔记 / Back up account notes', defaultPath: 'PaperQuay-notes-' + new Date().toISOString().slice(0, 10) + '.json', filters: [{ name: 'PaperQuay note backup', extensions: ['json'] }] };
    let chosen;
    if (options.showSaveDialog) chosen = await options.showSaveDialog(settings);
    else { const { dialog, BrowserWindow } = require('electron'), window = event?.sender && BrowserWindow.fromWebContents(event.sender); chosen = window ? await dialog.showSaveDialog(window, settings) : await dialog.showSaveDialog(settings); }
    check(); if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' }; const destination = chosen.filePath;
    if (!path.isAbsolute(destination) || destination.includes('\0')) fail('NOTE_BACKUP_SAVE_FAILED');
    const pinned = files.inspectSync(destination); if (pinned.linkPath || path.resolve(pinned.actual) !== path.resolve(destination)) fail('NOTE_BACKUP_SAVE_FAILED');
    check(); try { await files.write(destination, bytes, { mode: 0o600 }); } catch { fail('NOTE_BACKUP_SAVE_FAILED'); }
    return { status: 'exported', bytes: bytes.length };
  } };
}
module.exports = { createNoteBackupExporter, MAX_BACKUP_BYTES };
