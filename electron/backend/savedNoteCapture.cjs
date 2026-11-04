const { createHash } = require('node:crypto');
const { crc32 } = require('node:zlib');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const localId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
  && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^(?:(?:standalone|file|https?):|[a-z]:)/i.test(value);
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

/** Read-only saved truth and verified self-contained image bytes. No paths or URLs are fetched. */
function createSavedNoteCapture(context, options = {}) {
  const core = () => options.core || require('../generated/desktopSyncCore.cjs');
  const converter = () => options.converter || require('../generated/desktopRichNoteArchive.cjs');
  async function capture(noteIds, scope, check) {
    const adapter = converter(), shared = core(), { accountId, libraryBindingId } = scope;
    if (!Array.isArray(noteIds) || noteIds.length < 1 || noteIds.length > adapter.DESKTOP_NOTE_EXPORT_LIMITS.notes || !noteIds.every(localId) || new Set(noteIds).size !== noteIds.length) fail('INVALID_NOTE_SELECTION');
    shared.createDesktopIdentityMap(accountId, libraryBindingId);
    const notes = [], papers = [], resources = [], skippedNotes = {};
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
    const fingerprint = sha256(Buffer.from(shared.canonicalJson({ notes, papers, assetFingerprints, skippedNotes })));
    return { papers, notes, richNoteResources: resources, skippedNotes, fingerprint };
  }

  return { capture };
}
module.exports = { createSavedNoteCapture };
