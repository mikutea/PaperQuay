import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { parseLibraryArchive, planLibraryImport, materializeLibraryImport } from '../apps/mobile/src/library/libraryTransfer.ts';
import { validateRichNoteData } from '../packages/sync-core/src/richNote.ts';

const require = createRequire(import.meta.url);
const { createNoteStore } = require('../electron/backend/noteStore.cjs');
const { DatabaseSync } = require('../electron/backend/nodeSqlite.cjs');
const { createRichNoteExportCommands } = require('../electron/backend/richNoteExport.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
// Real decoding for this synthetic RGBA fixture only. Production uses Electron
// nativeImage; this seam does not claim to exercise Chromium's decoder.
function decodeFixturePng(bytes, expected) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8, idat = [], width, height, ended = false;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); assert.equal(body[8], 8); assert.equal(body[9], 6); }
    if (type === 'IDAT') idat.push(body);
    if (type === 'IEND') ended = true;
    offset += length + 12;
  }
  assert.equal(ended, true); assert.equal(offset, bytes.length); assert.equal(expected.mediaType, 'image/png');
  assert.equal(width, 1); assert.equal(height, 1); assert.equal(expected.width, width); assert.equal(expected.height, height);
  assert.deepEqual(inflateSync(Buffer.concat(idat)), Buffer.from([0, 255, 255, 255, 255]));
}
const hash = createHash('sha256').update(png).digest('hex');
const dataUri = `data:image/png;base64,${png.toString('base64')}`;
const text = value => ({ type: 'paragraph', content: [{ type: 'text', text: value, marks: [{ type: 'bold' }] }] });
const document = (source = dataUri) => ({ type: 'doc', content: [text('中文与数学'),
  { type: 'blockMath', attrs: { latex: 'E=mc^2' } },
  { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2, rowspan: 1, colwidth: [100, 120], align: 'center' }, content: [text('合并')] }] }] },
  { type: 'paragraph', content: [{ type: 'wikiLink', attrs: { id: 'peer-note', label: '同包记录' } }, { type: 'paperReference', attrs: { paperId: 'missing-paper', label: '未导入文献' } }] },
  { type: 'image', attrs: { src: source, alt: '原始字节', title: null, width: 1, height: 1 } },
] });
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'paperquay-rich-export-')));
  const appPaths = { dataDir: root, notesDatabasePath: path.join(root, 'notes.sqlite') };
  const noteStore = createNoteStore(appPaths), file = path.join(root, 'export.json');
  const jobs = [];
  t.after(() => {
    for (const job of jobs) job.close();
    noteStore.close();
    const resolved = path.resolve(root), temporary = realpathSync.native(tmpdir());
    assert.equal(path.dirname(resolved), temporary); assert.ok(path.basename(resolved).startsWith('paperquay-rich-export-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  const papers = [{ id: 'paper-local', title: '关联题录', doi: '10.1000/synthetic', year: '2026', publication: null,
    abstractText: null, authors: [{ name: 'Synthetic Author' }], keywords: ['合成'], attachments: [{ path: 'C:/private/never-open.pdf' }] },
  { id: 'unrelated-paper', title: 'UNRELATED_LIBRARY_CONTENT', authors: [], keywords: [] }];
  const context = { noteStore, store: { load: () => ({ papers, settings: { token: 'PRIVATE_CONFIG_SENTINEL' } }) } };
  noteStore.createNote({ id: 'peer-note', paperId: 'global-notes', title: '同包记录', contentJson: { type: 'doc', content: [text('同包正文')] } });
  noteStore.createNote({ id: 'main-note', paperId: 'paper-local', type: 'highlight', title: '完整结构', contentJson: document(),
    contentHtml: '<img src="file:///C:/private/derived-cache.png">', content: 'DO_NOT_EXPORT_DERIVED_BODY', tags: ['中文'],
    anchors: [{ id: 'anchor1', label: 'P2', excerpt: '旧定位', createdAt: 100, source: 'pdf', pageIndex: 1, paperId: 'paper-local' }],
    linkedNoteIds: ['peer-note'], color: '#fef08a', isFavorite: true, isPinned: true });
  const initial = noteStore.listAllNotes({ includeDeleted: true });
  const command = options => {
    const job = createRichNoteExportCommands(context, { decodeImage: decodeFixturePng, showSaveDialog: async () => ({ canceled: false, filePath: file }), ...options });
    jobs.push(job); return args => job.commands.notes_export_rich_archive(args);
  };
  return { root, appPaths, noteStore, context, file, command, initial };
}
function safeResponse(result, fixture) {
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /private|PRIVATE_CONFIG_SENTINEL|DO_NOT_EXPORT_DERIVED_BODY|file:|data:|blob:|token/i);
  assert.ok(!json.includes(fixture.root)); assert.ok(!Object.hasOwn(result, 'path')); assert.ok(!Object.hasOwn(result, 'filePath'));
}

test('actual saved noteStore → native controlled write → mobile v2 import preserves structure, byte hashes and historical metadata', async t => {
  const f = fixture(t), before = JSON.stringify(f.initial);
  f.noteStore.listAllNotes = () => { throw new Error('must use selected point reads'); };
  const result = await f.command()({ noteIds: ['main-note', 'peer-note'] });
  assert.equal(result.status, 'exported'); assert.equal(result.noteCount, 2); assert.equal(result.paperCount, 1); safeResponse(result, f);
  const json = readFileSync(f.file, 'utf8'), archive = parseLibraryArchive(json);
  assert.equal(archive.version, 2); assert.equal(archive.exportReport.requestedNotes, 2);
  assert.equal(archive.exportReport.sourceIds, 'export-only-aliases'); assert.equal(archive.exportReport.aliases.length, 3);
  const source = archive.notes.find(note => note.title === '完整结构');
  assert.equal(source.format, 'tiptap-json'); assert.equal(source.assets[0].sha256, hash);
  assert.equal(source.assets[0].base64, png.toString('base64')); assert.equal(source.document.content[4].attrs.src, `asset:sha256:${hash}`);
  assert.deepEqual(source.document.content[2], document().content[2]); assert.equal(source.metadata.isFavorite, true);
  assert.equal(source.metadata.anchors[0].verification, 'unverified'); assert.ok(!Object.hasOwn(source.metadata.anchors[0], 'attachmentVersionId'));
  assert.doesNotMatch(json, /DO_NOT_EXPORT_DERIVED_BODY|PRIVATE_CONFIG_SENTINEL|UNRELATED_LIBRARY_CONTENT|C:\/private|data:image|file:\/\//);
  const plan = planLibraryImport(archive, []); let next = 100;
  const imported = materializeLibraryImport(plan, () => `00000000-0000-4000-8000-${(next++).toString(16).padStart(12, '0')}`);
  const rich = imported.edits.find(edit => edit.entityType === 'note' && edit.data.title === source.title).data;
  assert.deepEqual(validateRichNoteData(rich), rich);
  const peer = imported.edits.find(edit => edit.entityType === 'note' && edit.data.title === '同包记录');
  assert.equal(rich.document.content[3].content[0].attrs.id, peer.entityId);
  assert.notEqual(peer.entityId, archive.notes.find(note => note.title === '同包记录').sourceId);
  assert.ok(rich.metadata.unresolvedReferences.some(item => item.kind === 'paper' && item.label === '未导入文献'));
  // Reads/export do not alter the actual notes database, including derived caches.
  assert.equal(JSON.stringify(f.initial.map(note => f.noteStore.getNote({ id: note.id }))), before);
});

test('the valid synthetic PNG has matching chunk CRCs/pixels and malformed CRC input is a whole-note skip', async t => {
  decodeFixturePng(png, { mediaType: 'image/png', width: 1, height: 1 });
  const malformed = Buffer.from(png); malformed[malformed.length - 20] ^= 1;
  assert.throws(() => decodeFixturePng(malformed, { mediaType: 'image/png', width: 1, height: 1 }));
  const f = fixture(t); f.noteStore.updateNote({ id: 'main-note', patch: { contentJson: document(`data:image/png;base64,${malformed.toString('base64')}`) } });
  let dialogs = 0;
  const result = await f.command({ showSaveDialog: async () => { dialogs++; return { canceled: false, filePath: f.file }; } })({ noteIds: ['main-note'] });
  assert.equal(result.status, 'nothing-exportable'); assert.equal(result.skipped[0].code, 'IMAGE_DECODE_FAILED');
  assert.equal(dialogs, 0); assert.equal(existsSync(f.file), false);
});

test('data aliases are deterministic export-only UUIDs; each kind has its own namespace', async t => {
  const f = fixture(t), run = f.command(); await run({ noteIds: ['main-note', 'peer-note'] });
  const first = readFileSync(f.file, 'utf8'); await run({ noteIds: ['main-note', 'peer-note'] });
  assert.equal(readFileSync(f.file, 'utf8'), first);
  const archive = parseLibraryArchive(first);
  assert.ok(archive.exportReport.aliases.every(alias => alias.sourceId !== alias.originalId));
});

test('expired blob/path/http/unknown structure and old text notes are whole-note skips with a complete report', async t => {
  const f = fixture(t), cases = [
    ['blob-note', document('blob:expired'), 'EXPIRED_BLOB_IMAGE'],
    ['path-note', document('C:/private/old.png'), 'LOCAL_IMAGE_UNSUPPORTED'],
    ['remote-note', document('https://external.test/chart.png'), 'REMOTE_IMAGE_UNSUPPORTED'],
    ['unknown-note', { type: 'doc', content: [{ type: 'video', attrs: { src: 'private' } }] }, 'UNSUPPORTED_RICH_NOTE'],
    ['hash-note', document(`asset:sha256:${hash}`), 'HASH_IMAGE_UNAVAILABLE'],
  ];
  for (const [id, contentJson] of cases) f.noteStore.createNote({ id, paperId: 'global-notes', title: id, contentJson });
  f.noteStore.createNote({ id: 'legacy-note', paperId: 'global-notes', title: '旧文本', content: 'LEGACY_MUST_NOT_FLATTEN' });
  const result = await f.command()({ noteIds: ['peer-note', ...cases.map(([id]) => id), 'legacy-note', 'missing-note'] });
  assert.equal(result.status, 'exported'); assert.equal(result.noteCount, 1); assert.equal(result.skipped.length, 7);
  for (let i = 0; i < cases.length; i++) assert.ok(result.skipped.some(entry => entry.index === i + 1 && entry.code === cases[i][2]));
  assert.ok(result.skipped.some(entry => entry.code === 'UNSUPPORTED_NOTE_FORMAT'));
  assert.ok(result.skipped.some(entry => entry.code === 'SAVED_NOTE_UNAVAILABLE'));
  const archive = parseLibraryArchive(readFileSync(f.file, 'utf8'));
  assert.deepEqual(archive.exportReport.skipped, result.skipped);
  assert.doesNotMatch(JSON.stringify(archive), /expired|private\/old|external\.test|LEGACY_MUST_NOT_FLATTEN/);
  safeResponse(result, f);
});

test('only unsupported notes produce no dialog/file; a selected missing primary paper is not silently detached', async t => {
  const f = fixture(t); let dialogs = 0;
  f.noteStore.createNote({ id: 'orphan-note', paperId: 'missing-main', title: '失去题录', contentJson: { type: 'doc', content: [text('原文')] } });
  const result = await f.command({ showSaveDialog: async () => { dialogs++; throw new Error('must not open'); } })({ noteIds: ['orphan-note'] });
  assert.equal(result.status, 'nothing-exportable'); assert.equal(dialogs, 0); assert.equal(existsSync(f.file), false);
  assert.equal(result.skipped[0].code, 'UNMAPPED_NOTE_PAPER');
});

test('trusted content-addressed reader receives only hash; byte mismatch rejects the entire note', async t => {
  const f = fixture(t); f.noteStore.updateNote({ id: 'main-note', patch: { contentJson: document(`asset:sha256:${hash}`) } });
  let reads = 0;
  const run = f.command({ readContentAddressedAsset: async expected => { assert.equal(expected, hash); reads++; return png; } });
  assert.equal((await run({ noteIds: ['main-note'] })).status, 'exported'); assert.equal(reads, 2);
  assert.equal(parseLibraryArchive(readFileSync(f.file, 'utf8')).notes[0].assets[0].sha256, hash);
  const previous = readFileSync(f.file);
  const invalid = await f.command({ readContentAddressedAsset: async () => Buffer.from('other bytes') })({ noteIds: ['main-note'] });
  assert.equal(invalid.status, 'nothing-exportable'); assert.equal(invalid.skipped[0].code, 'INVALID_IMAGE_DATA');
  assert.deepEqual(readFileSync(f.file), previous);
});

test('native dialog cancel and whole-content fence do not create a file or overwrite a prior good package', async t => {
  const f = fixture(t);
  const cancelled = await f.command({ showSaveDialog: async () => ({ canceled: true, filePath: f.file }) })({ noteIds: ['main-note'] });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(existsSync(f.file), false);
  await f.command()({ noteIds: ['main-note'] }); const previous = readFileSync(f.file);
  const changed = await f.command({ showSaveDialog: async () => {
    const db = new DatabaseSync(f.appPaths.notesDatabasePath);
    try { const changedDoc = document(); changedDoc.content[0] = text('相同 updatedAt 的新正文');
      db.prepare('UPDATE notes SET content_json = ? WHERE id = ?').run(JSON.stringify(changedDoc), 'main-note');
    } finally { db.close(); }
    return { canceled: false, filePath: f.file };
  } })({ noteIds: ['main-note'] });
  assert.equal(changed.status, 'source-changed'); assert.deepEqual(readFileSync(f.file), previous); safeResponse(changed, f);
});

test('changing associated bibliography while dialog is open invalidates the capture', async t => {
  const f = fixture(t);
  const result = await f.command({ showSaveDialog: async () => { f.context.store.load().papers[0].title = '修改后的题录'; return { canceled: false, filePath: f.file }; } })({ noteIds: ['main-note'] });
  assert.equal(result.status, 'source-changed'); assert.equal(existsSync(f.file), false);
});

test('closing while picker is open retires the write; overlapping jobs return busy', async t => {
  const f = fixture(t); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), picker = new Promise(resolve => { release = resolve; });
  const job = createRichNoteExportCommands(f.context, { decodeImage: decodeFixturePng, showSaveDialog: async () => { entered(); return picker; } });
  const pending = job.commands.notes_export_rich_archive({ noteIds: ['main-note'] }); await ready;
  assert.equal((await job.commands.notes_export_rich_archive({ noteIds: ['peer-note'] })).status, 'busy');
  job.close(); release({ canceled: false, filePath: f.file });
  assert.equal((await pending).status, 'failed'); assert.equal(existsSync(f.file), false);
});

test('controlled native writer rejects a linked destination parent without touching target', async t => {
  const f = fixture(t), real = path.join(f.root, 'real'), link = path.join(f.root, 'linked');
  mkdirSync(real); symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.command({ showSaveDialog: async () => ({ canceled: false, filePath: path.join(link, 'export.json') }) })({ noteIds: ['main-note'] });
  assert.equal(result.status, 'failed'); assert.equal(existsSync(path.join(real, 'export.json')), false); safeResponse(result, f);
});

test('invalid arguments, extra renderer paths and thrown private errors become fixed safe statuses', async t => {
  const f = fixture(t), run = f.command();
  for (const args of [{ noteIds: [] }, { noteIds: ['main-note', 'main-note'] }, { noteIds: ['../secret'] }, { noteIds: ['main-note'], filePath: 'C:/private' }]) {
    const result = await run(args); assert.equal(result.code, 'INVALID_NOTE_SELECTION'); safeResponse(result, f);
  }
  const result = await f.command({ showSaveDialog: async () => { throw new Error(`PRIVATE_CONFIG_SENTINEL ${f.root}`); } })({ noteIds: ['main-note'] });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'EXPORT_FAILED'); safeResponse(result, f);
});
