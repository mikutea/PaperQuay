const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSavedNoteCapture } = require('./savedNoteCapture.cjs');
const nativeFs = require('./nativeFs.cjs');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const localId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
  && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^(?:(?:standalone|file|https?):|[a-z]:)/i.test(value);
// These UUIDs identify aliases in an exchange file only. They never write a
// desktop/account mapping, and mobile always allocates fresh target IDs.
function exportAlias(kind, local) {
  const hex = sha256(Buffer.from(JSON.stringify(['paperquay-note-export-v1', kind, local]))).slice(0, 32).split('');
  hex[12] = '8'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Read-only saved-note export. No requests to a parser, model, account API or
 * image URL are made. Only current data URI bytes or an explicitly trusted
 * content-addressed reader can supply an image. The default hash reader is
 * unavailable; historical paths/blob URLs are never guessed or opened. */
function createRichNoteExportCommands(context, options = {}) {
  const core = () => options.core || require('../generated/desktopSyncCore.cjs');
  const converter = () => options.converter || require('../generated/desktopRichNoteArchive.cjs');
  const accountId = exportAlias('scope', 'export-only'), libraryBindingId = exportAlias('scope', 'saved-notes');
  let closed = false, busy = false, epoch = 0;
  const response = (status, prepared, code) => ({ status, noteCount: prepared?.summary.notes ?? 0,
    paperCount: prepared?.summary.papers ?? 0, skipped: prepared?.skipped ?? [], ...(code ? { code } : {}) });

  const savedNotes = createSavedNoteCapture(context, options);
  async function capture(noteIds, check) {
    const adapter = converter(), shared = core();
    const captured = await savedNotes.capture(noteIds, { accountId, libraryBindingId }, check);
    const identityMap = shared.createDesktopIdentityMap(accountId, libraryBindingId);
    for (const [kind, values] of [['paper', captured.papers], ['note', captured.notes]]) for (const value of values)
      if (value && localId(value.id)) identityMap.aliases[JSON.stringify([kind, value.id])] = exportAlias(kind, value.id);
    const prepared = adapter.createPortableRichNoteArchive({ accountId, libraryBindingId, identityMap,
      papers: captured.papers, notes: captured.notes, richNoteResources: captured.richNoteResources }, { skippedNotes: captured.skippedNotes });
    return { ...prepared, fingerprint: captured.fingerprint };
  }

  async function exportNotes(args = {}, event) {
    if (closed) return response('failed', null, 'EXPORT_UNAVAILABLE');
    if (busy) return response('busy');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).join(',') !== 'noteIds'
      || !Array.isArray(args.noteIds) || args.noteIds.length < 1 || args.noteIds.length > 500
      || !args.noteIds.every(localId) || new Set(args.noteIds).size !== args.noteIds.length)
      return response('failed', null, 'INVALID_NOTE_SELECTION');
    const noteIds = [...args.noteIds], operation = epoch;
    const check = () => { if (closed || operation !== epoch) fail('EXPORT_UNAVAILABLE'); };
    busy = true;
    let prepared;
    try {
      prepared = await capture(noteIds, check); check();
      if (prepared.summary.notes === 0) return response('nothing-exportable', prepared);
      const picker = { title: '导出当前已保存笔记', defaultPath: 'saved-notes.paperquay-library.json',
        filters: [{ name: 'PaperQuay library v2', extensions: ['json'] }] };
      let selected;
      if (options.showSaveDialog) selected = await options.showSaveDialog(picker);
      else {
        const { dialog, BrowserWindow } = require('electron');
        const window = event?.sender && BrowserWindow.fromWebContents(event.sender);
        selected = window ? await dialog.showSaveDialog(window, picker) : await dialog.showSaveDialog(picker);
      }
      check();
      if (selected.canceled || !selected.filePath) return response('cancelled', prepared);
      const current = await capture(noteIds, check); check();
      if (current.fingerprint !== prepared.fingerprint) return response('source-changed', prepared);
      const destination = selected.filePath;
      if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) fail('SAVE_FAILED');
      const pinned = nativeFs.inspectSync(destination);
      if (pinned.linkPath || path.resolve(pinned.actual) !== path.resolve(destination)) fail('SAVE_FAILED');
      check();
      // write() pins the parent and refuses links/reparse points. A completed
      // write remains a successful save even if close() retires a later UI ack.
      await nativeFs.write(destination, Buffer.from(prepared.json), { mode: 0o600 });
      return response('exported', prepared);
    } catch (error) {
      return response('failed', prepared, ['INVALID_NOTE_SELECTION', 'SOURCE_TOO_LARGE', 'EXPORT_UNAVAILABLE'].includes(error?.code) ? error.code : 'EXPORT_FAILED');
    } finally { busy = false; }
  }
  return { commands: { notes_export_rich_archive: exportNotes }, close() { closed = true; epoch++; } };
}

module.exports = { createRichNoteExportCommands };
