const path = require('node:path');
const { createHash } = require('node:crypto');
const { crc32 } = require('node:zlib');
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

function decodeSavedImage(bytes, expected) {
  try {
    // This is actual Chromium/Skia decoding in the production main process.
    // It is verification only: the package retains the original bytes/hash.
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) fail('IMAGE_DECODE_FAILED');
    const dimensions = image.getSize();
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) fail('IMAGE_DECODE_FAILED');
  } catch { fail('IMAGE_DECODE_FAILED'); }
}

function verifyPngChecksums(bytes) {
  let offset = 8;
  try {
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) fail('IMAGE_DECODE_FAILED');
      offset = end;
    }
    if (offset !== bytes.length) fail('IMAGE_DECODE_FAILED');
  } catch { fail('IMAGE_DECODE_FAILED'); }
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

  async function capture(noteIds, check) {
    const adapter = converter(), shared = core(), notes = [], papers = [], resources = [], skippedNotes = {};
    const neededPapers = new Set();
    let size = 0;
    for (const id of noteIds) {
      check();
      const saved = context.noteStore.getNote({ id });
      if (saved && saved.id !== id) fail('INVALID_SAVED_SOURCE');
      const value = adapter.snapshotDesktopSavedNote(saved);
      const bytes = Buffer.from(shared.canonicalJson(value)); size += bytes.length;
      if (size > adapter.DESKTOP_NOTE_EXPORT_LIMITS.captureBytes) fail('SOURCE_TOO_LARGE');
      notes.push(value);
      for (const paperId of adapter.inspectDesktopSavedNote(value).paperIds) neededPapers.add(paperId);
    }
    const libraryPapers = context.store.load().papers;
    if (!Array.isArray(libraryPapers)) fail('INVALID_SAVED_SOURCE');
    // No attachments, history, storage paths, configuration or credentials enter
    // either the fingerprint or the package.
    for (const paper of libraryPapers) if (paper && typeof paper.id === 'string' && neededPapers.has(paper.id)) {
      if (papers.length >= 500) fail('SOURCE_TOO_LARGE');
      const value = adapter.snapshotDesktopBibliography(paper);
      size += Buffer.byteLength(shared.canonicalJson(value));
      if (size > adapter.DESKTOP_NOTE_EXPORT_LIMITS.captureBytes) fail('SOURCE_TOO_LARGE');
      papers.push(value);
    }
    const identityMap = shared.createDesktopIdentityMap(accountId, libraryBindingId);
    for (const [kind, values] of [['paper', papers], ['note', notes]]) for (const value of values)
      if (value && localId(value.id)) identityMap.aliases[JSON.stringify([kind, value.id])] = exportAlias(kind, value.id);
    const assetFingerprints = [];
    for (let index = 0; index < notes.length; index++) {
      const note = notes[index];
      if (!note) { skippedNotes[index] = 'SAVED_NOTE_UNAVAILABLE'; continue; }
      const sources = adapter.inspectDesktopSavedNote(note).imageSources;
      if (sources.length > shared.RICH_NOTE_LIMITS.assets) { skippedNotes[index] = 'IMAGE_LIMIT'; continue; }
      for (const source of sources) {
        check();
        let data;
        try {
          if (source.startsWith('data:')) {
            const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
            if (!match || match[2].length < 4 || match[2].length > Math.ceil(shared.RICH_NOTE_LIMITS.assetBytes / 3) * 4)
              fail('INVALID_IMAGE_DATA');
            data = Buffer.from(match[2], 'base64');
            if (data.toString('base64') !== match[2]) fail('INVALID_IMAGE_DATA');
            const dimensions = shared.inspectParsedImage(new Uint8Array(data));
            if (dimensions.mediaType !== match[1]) fail('INVALID_IMAGE_DATA');
          } else if (/^asset:sha256:[0-9a-f]{64}$/.test(source)) {
            if (typeof options.readContentAddressedAsset !== 'function') fail('HASH_IMAGE_UNAVAILABLE');
            const bytes = await options.readContentAddressedAsset(source.slice('asset:sha256:'.length)); check();
            if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > shared.RICH_NOTE_LIMITS.assetBytes) fail('INVALID_IMAGE_DATA');
            data = Buffer.from(bytes);
            if (sha256(data) !== source.slice('asset:sha256:'.length)) fail('INVALID_IMAGE_DATA');
          } else if (source.startsWith('blob:')) fail('EXPIRED_BLOB_IMAGE');
          else if (/^(?:https?:)?\/\//i.test(source)) fail('REMOTE_IMAGE_UNSUPPORTED');
          else fail('LOCAL_IMAGE_UNSUPPORTED');
          if (data.length < 1 || data.length > shared.RICH_NOTE_LIMITS.assetBytes) fail('IMAGE_LIMIT');
          const dimensions = shared.inspectParsedImage(new Uint8Array(data)), hash = sha256(data);
          if (dimensions.width * dimensions.height > shared.RICH_NOTE_LIMITS.assetPixels) fail('IMAGE_LIMIT');
          if (dimensions.mediaType === 'image/png') verifyPngChecksums(data);
          try { await (options.decodeImage || decodeSavedImage)(data, dimensions); check(); }
          catch { fail('IMAGE_DECODE_FAILED'); }
          const asset = { id: hash, ...dimensions, base64: data.toString('base64'), sha256: hash, sizeBytes: data.length };
          resources.push({ proof: 'verified-note-image-bytes', accountId, libraryBindingId, localNoteId: note.id, source, asset });
          assetFingerprints.push([index, source, hash]);
        } catch (error) {
          const known = ['HASH_IMAGE_UNAVAILABLE', 'INVALID_IMAGE_DATA', 'IMAGE_DECODE_FAILED', 'EXPIRED_BLOB_IMAGE', 'REMOTE_IMAGE_UNSUPPORTED', 'LOCAL_IMAGE_UNSUPPORTED', 'IMAGE_LIMIT'];
          skippedNotes[index] = known.includes(error?.code) ? error.code : 'INVALID_IMAGE_DATA';
          break;
        }
      }
    }
    check();
    const prepared = adapter.createPortableRichNoteArchive({ accountId, libraryBindingId, identityMap, papers, notes, richNoteResources: resources }, { skippedNotes });
    const fingerprint = sha256(Buffer.from(shared.canonicalJson({ notes, papers, assetFingerprints, skippedNotes })));
    return { ...prepared, fingerprint };
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
