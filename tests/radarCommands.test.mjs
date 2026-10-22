import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAppPaths, createLibraryStore } = require('../electron/backend/libraryStore.cjs');
const { createRadarController } = require('../electron/backend/radarCommands.cjs');
const { createRadarStore } = require('../electron/backend/radarStore.cjs');
const { createSourceAccess } = require('../electron/backend/sourceAccess.cjs');
const native = require('../electron/backend/nativeFs.cjs');
const record = (patch = {}) => ({ source: 'crossref', sourceId: '10.1234/battery', title: 'Battery recycling', doi: '10.1234/battery',
  year: '2026', authors: ['Ada Researcher'], publication: 'Research Journal', url: 'https://doi.org/10.1234/battery', abstractText: '', keywords: [], ...patch });
const report = { source: 'crossref', query: 'battery', received: 1, total: 1, limited: false, error: null };
function fixture(t, options = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-radar-')));
  const appPaths = createAppPaths({ getPath: () => path.join(root, 'profile') });
  const store = createLibraryStore(appPaths), persistence = createRadarStore(appPaths);
  const context = { appPaths, store }; let now = Date.UTC(2026, 9, 22);
  const controller = createRadarController(context, { persistence, clock: () => now,
    discover: async () => ({ records: [record()], reports: [report] }), ...options });
  const commands = controller.commands;
  const topic = commands.radar_save_topic({ topic: { name: 'Batteries', queries: ['battery'], sources: ['crossref'], enabled: options.enabled === true } });
  t.after(() => { controller.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, context, appPaths, store, persistence, controller, commands, topic, advance: (delta = 60001) => { now += delta; } };
}

test('discovery keeps candidates separate; repeated import is idempotent and queue choices survive restart', async (t) => {
  const f = fixture(t); await f.commands.radar_run({ topicId: f.topic.id });
  assert.equal(f.store.load().papers.length, 0);
  const candidate = f.commands.radar_get_snapshot().candidates[0];
  const paper = f.commands.radar_import_candidate({ candidateId: candidate.id });
  assert.equal(f.commands.radar_import_candidate({ candidateId: candidate.id }).id, paper.id);
  assert.equal(f.store.load().papers.length, 1); assert.equal(paper.attachments.length, 0);
  f.commands.radar_set_queue({ paperId: paper.id, status: 'later', pinned: true });
  f.controller.close();
  const reopened = createRadarController(f.context); t.after(() => reopened.close());
  const snapshot = reopened.commands.radar_get_snapshot();
  assert.equal(snapshot.queue[0].status, 'later'); assert.equal(snapshot.queue[0].pinned, true);
  assert.equal(snapshot.candidates[0].paperId, paper.id);
  assert.equal(f.store.load().papers[0].readingProgress, 0);
});

test('a candidate-record failure after library commit can be retried without duplicating the paper', async (t) => {
  const f = fixture(t); await f.commands.radar_run({ topicId: f.topic.id });
  const id = f.commands.radar_get_snapshot().candidates[0].id;
  const update = f.persistence.update;
  f.persistence.update = () => { throw new Error('fixture disk failure'); };
  assert.throws(() => f.commands.radar_import_candidate({ candidateId: id }), /fixture disk failure/);
  assert.equal(f.store.load().papers.length, 1);
  f.persistence.update = update;
  f.commands.radar_import_candidate({ candidateId: id });
  assert.equal(f.store.load().papers.length, 1);
});

test('sparse records remain linked after a failed candidate write and never duplicate on retry', async (t) => {
  const f = fixture(t, { discover: async () => ({ records: [record({ doi: '', year: '', authors: [], source: 'openalex', sourceId: 'https://openalex.org/W1' })], reports: [report] }) });
  await f.commands.radar_run({ topicId: f.topic.id });
  const id = f.persistence.load().candidates[0].id, update = f.persistence.update;
  f.persistence.update = () => { throw new Error('fixture disk failure'); };
  assert.throws(() => f.commands.radar_import_candidate({ candidateId: id }), /fixture disk failure/);
  f.persistence.update = update;
  const committed = f.store.load().papers[0];
  assert.equal(f.commands.radar_get_snapshot().candidates[0].paperId, committed.id);
  assert.equal(f.commands.radar_import_candidate({ candidateId: id }).id, committed.id);
  assert.equal(f.store.load().papers.length, 1);
});

test('overlapping runs are rejected and cancelled results never enter the inbox', async (t) => {
  let complete;
  const f = fixture(t, { discover: () => new Promise((resolve) => { complete = resolve; }) });
  const pending = f.commands.radar_run({ topicId: f.topic.id });
  await assert.rejects(f.commands.radar_run({ topicId: f.topic.id }), /already running/);
  f.commands.radar_cancel(); complete({ records: [record()], reports: [report] }); await pending;
  const snapshot = f.commands.radar_get_snapshot();
  assert.equal(snapshot.candidates.length, 0); assert.equal(snapshot.activeTopicId, null);
  assert.equal(snapshot.topics[0].lastRun.status, 'cancelled');
});

for (const change of ['edit', 'delete', 'close']) test('a running check cannot commit after topic ' + change, async (t) => {
  let complete;
  const f = fixture(t, { discover: () => new Promise((resolve) => { complete = resolve; }) });
  const pending = f.commands.radar_run({ topicId: f.topic.id });
  if (change === 'edit') f.commands.radar_save_topic({ topic: { ...f.topic, queries: ['new question'] } });
  if (change === 'delete') f.commands.radar_delete_topic({ topicId: f.topic.id });
  if (change === 'close') f.controller.close();
  complete({ records: [record()], reports: [report] }); await pending;
  assert.equal(f.persistence.load().candidates.length, 0);
  if (change === 'edit') assert.equal(f.persistence.load().topics[0].lastRun, null);
});

test('schedules are opt-in, catch up once and respect rate-limit cooldown across restart', async (t) => {
  let calls = 0;
  const f = fixture(t, { discover: async () => { calls++; return { records: [], reports: [{ ...report, error: 'HTTP 429', retryAt: Date.UTC(2026, 9, 23) }] }; } });
  await f.controller.tick(); assert.equal(calls, 0);
  f.commands.radar_save_topic({ topic: { ...f.topic, enabled: true, intervalHours: 6 } });
  await f.controller.tick(); await f.controller.tick(); assert.equal(calls, 1);
  f.advance(3600000); await assert.rejects(f.commands.radar_run({ topicId: f.topic.id }), /cooldown/);
  assert.equal(f.persistence.load().topics[0].nextRunAt, Date.UTC(2026, 9, 23));
  f.advance(3 * 86400000); await f.controller.tick(); await f.controller.tick(); assert.equal(calls, 2);
});

test('removing a rate-limited source unblocks the remaining source and its obsolete schedule', async (t) => {
  let calls = 0;
  const f = fixture(t, { discover: async () => ({ records: [], reports: ++calls === 1
    ? [{ ...report, source: 'openalex', error: 'HTTP 429', retryAt: Date.UTC(2026, 9, 23) }] : [report] }) });
  f.commands.radar_save_topic({ topic: { ...f.topic, sources: ['crossref', 'openalex'], enabled: true, intervalHours: 6 } });
  await f.commands.radar_run({ topicId: f.topic.id }); f.advance();
  const updated = f.commands.radar_save_topic({ topic: { ...f.topic, sources: ['crossref'], enabled: true, intervalHours: 6 } });
  assert.equal(updated.retryAt, 0); assert.equal(updated.nextRunAt, null);
  await f.controller.tick(); assert.equal(calls, 2);
  assert.equal(f.persistence.load().topics[0].lastRun.status, 'success');
});

test('a completed check preserves concurrent queue choices and a failed source reports partial coverage', async (t) => {
  let complete;
  const f = fixture(t, { discover: () => new Promise((resolve) => { complete = resolve; }) });
  const first = f.commands.radar_run({ topicId: f.topic.id }); complete({ records: [record()], reports: [report] }); await first;
  const paper = f.commands.radar_import_candidate({ candidateId: f.persistence.load().candidates[0].id }); f.advance();
  const pending = f.commands.radar_run({ topicId: f.topic.id });
  f.commands.radar_set_queue({ paperId: paper.id, status: 'read' });
  complete({ records: [record()], reports: [report, { ...report, source: 'openalex', error: 'HTTP 503' }] }); await pending;
  const snapshot = f.commands.radar_get_snapshot();
  assert.equal(snapshot.queue[0].status, 'read'); assert.equal(snapshot.topics[0].lastRun.status, 'partial');
  assert.equal(snapshot.candidates.length, 1);
});

test('topic deletion preserves library papers and queue states', async (t) => {
  const f = fixture(t); await f.commands.radar_run({ topicId: f.topic.id });
  const paper = f.commands.radar_import_candidate({ candidateId: f.persistence.load().candidates[0].id });
  f.commands.radar_set_queue({ paperId: paper.id, pinned: true });
  f.commands.radar_delete_topic({ topicId: f.topic.id });
  assert.equal(f.store.load().papers.length, 1); assert.equal(f.persistence.load().queue[0].pinned, true);
  assert.equal(f.persistence.load().candidates.length, 0);
});

test('malformed persisted data is rejected and preserved rather than silently reset', async (t) => {
  const f = fixture(t), file = f.persistence.filePath;
  for (const content of ['{broken', JSON.stringify({ version: 1, topics: [null], candidates: [], queue: [] })]) {
    fs.writeFileSync(file, content);
    assert.throws(() => f.commands.radar_get_snapshot(), /preserved/);
    assert.throws(() => f.commands.radar_save_topic({ topic: f.topic }), /preserved/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('radar subscriptions are isolated by both profile and active library', (t) => {
  const f = fixture(t);
  const otherLibrary = createRadarStore({ ...f.appPaths, dataDir: path.join(f.root, 'other-library') });
  const otherProfile = createRadarStore({ ...f.appPaths, configPath: path.join(f.root, 'other-profile', 'settings.json') });
  assert.equal(otherLibrary.load().topics.length, 0); assert.equal(otherProfile.load().topics.length, 0);
});

test('PDF attachment authorizes before reads, preserves the source and rolls back a failed commit', async (t) => {
  const f = fixture(t); await f.commands.radar_run({ topicId: f.topic.id });
  const paper = f.commands.radar_import_candidate({ candidateId: f.persistence.load().candidates[0].id });
  const source = path.join(f.root, 'selected.pdf'); fs.writeFileSync(source, '%PDF-1.4\nradar fixture\n%%EOF');
  const access = createSourceAccess({ showMessageBox: async () => ({ response: 0 }) });
  f.context.approveImportSources = access.authorize;
  const open = native.openRead; let reads = 0;
  native.openRead = async (...args) => { reads++; return open(...args); }; t.after(() => { native.openRead = open; });
  await assert.rejects(f.commands.radar_attach_pdf({ paperId: paper.id, sourcePath: source }), /canceled/);
  assert.equal(reads, 0); access.rememberPicked([source]);
  const save = f.store.saveSync;
  f.store.saveSync = () => { throw new Error('fixture failed commit'); };
  await assert.rejects(f.commands.radar_attach_pdf({ paperId: paper.id, sourcePath: source }), /fixture failed commit/);
  assert.equal(f.store.load().papers[0].attachments.length, 0);
  const storage = f.store.load().settings.storageDir;
  assert.equal(fs.existsSync(storage) ? fs.readdirSync(storage).length : 0, 0);
  f.store.saveSync = save;
  const attached = await f.commands.radar_attach_pdf({ paperId: paper.id, sourcePath: source });
  assert.deepEqual(fs.readFileSync(attached.attachments[0].storedPath), fs.readFileSync(source));
  assert.equal(f.commands.radar_get_snapshot().queue[0].evidence, 'pdf-available');
});

test('PDF attachment rejects invalid documents and detects library changes during approval', async (t) => {
  const f = fixture(t); await f.commands.radar_run({ topicId: f.topic.id });
  const paper = f.commands.radar_import_candidate({ candidateId: f.persistence.load().candidates[0].id });
  const source = path.join(f.root, 'selected.pdf'); fs.writeFileSync(source, 'not a PDF');
  await assert.rejects(f.commands.radar_attach_pdf({ paperId: paper.id, sourcePath: source }), /complete PDF/);
  fs.writeFileSync(source, '%PDF-1.4\nfixture\n%%EOF');
  f.context.approveImportedAttachments = async () => ({ commit(callback) {
    const current = f.store.load(); current.papers = []; f.store.saveSync(current); callback();
  } });
  await assert.rejects(f.commands.radar_attach_pdf({ paperId: paper.id, sourcePath: source }), /library changed/);
  assert.equal(fs.readdirSync(f.store.load().settings.storageDir).length, 0);
  assert.equal(fs.existsSync(source), true);
});

test('a missing PDF can be replaced with identical bytes while preserving non-PDF attachments and the source', async (t) => {
  const f = fixture(t); await f.commands.radar_run({ topicId: f.topic.id });
  const paper = f.commands.radar_import_candidate({ candidateId: f.persistence.load().candidates[0].id });
  const source = path.join(f.root, 'source.pdf'); fs.writeFileSync(source, '%PDF-1.4\nreplacement fixture\n%%EOF');
  const first = await f.commands.radar_attach_pdf({ paperId: paper.id, sourcePath: source });
  const oldPdf = first.attachments[0], notes = path.join(f.root, 'notes.txt'); fs.writeFileSync(notes, 'keep these notes');
  const library = f.store.load(), target = library.papers[0];
  target.attachments[0].missing = true;
  target.attachments.push({ ...oldPdf, id: 'other-attachment', kind: 'text', storedPath: notes, originalPath: notes, relativePath: '', fileName: 'notes.txt', contentHash: 'notes-hash' });
  f.store.saveSync(library); fs.unlinkSync(oldPdf.storedPath);
  assert.equal(f.commands.radar_get_snapshot().candidates[0].hasPdf, false);
  const result = await f.commands.radar_attach_pdf({ paperId: paper.id, sourcePath: source });
  const pdf = result.attachments.find((item) => item.kind === 'pdf');
  assert.equal(result.attachments.length, 2); assert.notEqual(pdf.id, oldPdf.id); assert.equal(pdf.missing, false);
  assert.deepEqual(fs.readFileSync(pdf.storedPath), fs.readFileSync(source));
  assert.equal(fs.readFileSync(notes, 'utf8'), 'keep these notes');
  assert.equal(f.commands.radar_get_snapshot().candidates[0].hasPdf, true);
});
