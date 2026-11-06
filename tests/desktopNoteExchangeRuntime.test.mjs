import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as core from '../packages/sync-core/src/index.ts';
const require = createRequire(import.meta.url);
const nativeFs = require('../electron/backend/nativeFs.cjs');
const { createNoteStore } = require('../electron/backend/noteStore.cjs');
const { createDesktopNoteExchange } = require('../electron/backend/desktopNoteExchange.cjs');
const at = '2026-11-04T09:00:00.000Z';
const config = { apiBaseUrl: 'https://sync.example.test', oidcIssuer: 'https://login.example.test', oidcClientId: 'desktop' };
const plain = (text, title = 'Account note') => ({ paperId: null, title, body: text, format: 'markdown' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-note-exchange-'));
  const context = { appPaths: { configPath: path.join(temp, 'profile', 'config.json'), dataDir: path.join(temp, 'library'), notesDatabasePath: path.join(temp, 'library', 'notes.sqlite') },
    store: { load: () => ({ papers: [] }) } };
  context.noteStore = createNoteStore(context.appPaths);
  let snapshot = { config, account: { accountId: randomUUID(), deviceId: randomUUID() }, epoch: 1, library: { libraryBindingId: randomUUID() } };
  const records = new Map(), events = [], receipts = new Map(), conflicts = new Map(), calls = [], managers = [];
  let route = null, writer = null, manager;
  const record = (entityId, data, revision = 1) => ({ entityType: 'note', entityId, schemaVersion: 1, revision, deletedAt: data === null ? at : null,
    updatedAt: at, modifiedByDeviceId: snapshot.account.deviceId, data });
  const put = row => { records.set(row.entityId, row); events.push(row); return row; };
  const files = () => { const root = path.join(temp, 'profile', 'account-sync', 'notes'); return fs.existsSync(root) ? fs.readdirSync(root).map(file => path.join(root, file)) : []; };
  const readState = () => JSON.parse(fs.readFileSync(files()[0], 'utf8'));
  function create() {
    manager = createDesktopNoteExchange(context, { core, now: () => Date.parse(at), captureOptions: { decodeImage() {} },
      getContext: () => snapshot, checkContext(value) { if (value.epoch !== snapshot.epoch || value.account.accountId !== snapshot.account.accountId || value.library.libraryBindingId !== snapshot.library.libraryBindingId) throw Object.assign(Error('Changed owner'), { code: 'DESKTOP_OPERATION_CANCELLED' }); },
      getMaterialBindings: () => ({ bindings: [], live: { paperIds: [], noteIds: context.noteStore.listAllNotes().map(row => row.id) } }),
      fs: { ...nativeFs, writeSync(file, bytes, options) { return writer ? writer(file, bytes, options) : nativeFs.writeSync(file, bytes, options); } },
      api: async (_owner, input) => {
        calls.push(structuredClone({ path: input.path, method: input.method || 'GET', body: input.body }));
        if (route) { const value = await route(input); if (value !== undefined) return value; }
        const url = new URL(input.path, config.apiBaseUrl);
        if (url.pathname === '/v1/sync/pull') {
          const start = Number(url.searchParams.get('cursor') || '0'), page = events.slice(start, start + 1);
          return { protocolVersion: 1, records: page, nextCursor: String(start + page.length), hasMore: start + page.length < events.length };
        }
        if (url.pathname === '/v1/conflicts') {
          const start = Number(url.searchParams.get('cursor') || '0'), all = [...conflicts.values()], page = all.slice(start, start + 1);
          return { conflicts: page, nextCursor: String(start + page.length), hasMore: start + page.length < all.length };
        }
        if (url.pathname === '/v1/sync/push') {
          const op = input.body.operations[0]; assert.equal(input.body.operations.length, 1);
          assert.equal(readState().sync.outbox.find(row => row.operation.opId === op.opId).status, 'sending');
          if (receipts.has(op.opId)) return { protocolVersion: 1, results: [{ ...receipts.get(op.opId), replayed: true }] };
          const current = put(record(op.entityId, op.data, (records.get(op.entityId)?.revision || 0) + 1));
          const result = { opId: op.opId, status: 'applied', record: current, replayed: false }; receipts.set(op.opId, result);
          return { protocolVersion: 1, results: [result] };
        }
        throw Error('Unexpected fixture request ' + input.path);
      } });
    managers.push(manager); manager.setCapability(true, true); return manager;
  }
  create();
  t.after(async () => { for (const owned of managers) owned.close(); await Promise.all(managers.map(owned => owned.settled())); context.noteStore.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('paperquay-note-exchange-')); fs.rmSync(temp, { recursive: true, force: true }); });
  function local(title = 'Local saved truth', content = 'Original content', extra = {}) {
    return context.noteStore.createNote({ paperId: 'global-notes', type: 'standalone', title, content,
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: content }] }] }, ...extra });
  }
  return { context, calls, records, receipts, conflicts, put, record, files, readState, create, local,
    get manager() { return manager; }, get snapshot() { return snapshot; }, setSnapshot(value) { snapshot = value; }, setRoute(value) { route = value; }, setWriter(value) { writer = value; } };
}

test('saved-note checks are read only, publish the exact preview and reveal a graph binding only after receipt', async t => {
  const f = fixture(t), note = f.local(), before = f.context.noteStore.getNote({ id: note.id });
  await f.manager.refreshStatus(); assert.equal(f.calls.length, 0); assert.deepEqual(f.files(), []);
  const list = await f.manager.list(); assert.equal(list.notes[0].localNoteId, note.id); assert.equal(f.calls.length, 0);
  const preview = await f.manager.preview({ noteIds: [note.id] }); assert.equal(preview.localRows[0].action, 'create');
  assert.equal(preview.localRows[0].local.body, 'Original content'); assert.deepEqual(f.files(), []); assert.deepEqual(f.manager.bindings(), []);
  await f.manager.publish({ token: preview.token }); assert.equal(f.manager.status().pending, 0);
  const published = [...f.records.values()][0]; assert.equal(published.data.body, before.content);
  assert.deepEqual(f.manager.bindings(), [{ localNoteId: note.id, entityId: published.entityId }]);
  assert.deepEqual(f.context.noteStore.getNote({ id: note.id }), before);
  const same = await f.manager.preview({ noteIds: [note.id] }); assert.equal(same.localRows[0].action, 'none');
});

test('source edit after preview and old-owner callbacks cannot publish a stale or foreign payload', async t => {
  const f = fixture(t), note = f.local(), preview = await f.manager.preview({ noteIds: [note.id] });
  f.context.noteStore.updateNote({ id: note.id, patch: { title: 'Edited later' } });
  await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'NOTE_PREVIEW_STALE' });
  assert.equal(f.calls.filter(row => row.method === 'POST').length, 0); assert.deepEqual(f.files(), []);
  const next = await f.manager.preview({ noteIds: [note.id] }); f.manager.invalidate();
  f.setSnapshot({ ...f.snapshot, epoch: 2, account: { accountId: randomUUID(), deviceId: randomUUID() } }); f.manager.setCapability(true, true);
  await assert.rejects(f.manager.publish({ token: next.token }), { code: 'NOTE_PREVIEW_STALE' });
  assert.equal(f.calls.filter(row => row.method === 'POST').length, 0);
});

test('lost HTTP receipt survives restart under its original operation and never sends on open', async t => {
  const f = fixture(t), note = f.local(); let lost = true;
  f.setRoute(input => { if (input.path === '/v1/sync/push' && lost) { lost = false;
    const op = input.body.operations[0], record = f.put(f.record(op.entityId, op.data));
    f.receipts.set(op.opId, { opId: op.opId, status: 'applied', record, replayed: false }); throw Object.assign(Error('Lost ACK'), { code: 'NETWORK_UNAVAILABLE' }); } });
  const preview = await f.manager.preview({ noteIds: [note.id] }); await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'NETWORK_UNAVAILABLE' });
  const original = f.calls.find(row => row.method === 'POST').body.operations[0]; assert.equal(f.readState().sync.outbox[0].status, 'uncertain');
  f.manager.close(); await f.manager.settled(); const count = f.calls.length; f.create(); await f.manager.refreshStatus(); assert.equal(f.calls.length, count);
  await f.manager.continue(); assert.equal(f.receipts.size, 1); assert.deepEqual(f.calls.filter(row => row.method === 'POST')[1].body.operations[0], original);
});

test('unconfirmed private result saving is retried without sending the operation again', async t => {
  const f = fixture(t), note = f.local(); let lose = true;
  f.setWriter((file, bytes, options) => { const value = JSON.parse(bytes); if (lose && Object.keys(value.sync.serverRecords).length) { lose = false; throw Error('Synthetic save failure'); } return nativeFs.writeSync(file, bytes, options); });
  const preview = await f.manager.preview({ noteIds: [note.id] }); await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'NOTE_SAVE_UNCONFIRMED' });
  assert.equal(f.manager.status().saveUnconfirmed, true); assert.deepEqual(f.manager.bindings(), []);
  const posts = f.calls.filter(row => row.method === 'POST').length; await f.manager.retrySave(); assert.equal(f.calls.filter(row => row.method === 'POST').length, posts);
  assert.equal(f.manager.status().saveUnconfirmed, false); assert.equal(f.manager.bindings().length, 1);
});

test('a retained note receipt is saved before aligning a later device and newly negotiated content capability', async t => {
  const f = fixture(t), note = f.local(); let lose = true;
  f.setWriter((file, bytes, options) => { const value = JSON.parse(bytes); if (lose && Object.keys(value.sync.serverRecords).length) { lose = false; throw Error('Lost receipt save'); } return nativeFs.writeSync(file, bytes, options); });
  let preview = await f.manager.preview({ noteIds: [note.id] }); await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'NOTE_SAVE_UNCONFIRMED' });
  const originalDevice = f.snapshot.account.deviceId, nextDevice = randomUUID(), posts = f.calls.filter(row => row.method === 'POST').length;
  f.manager.invalidate(); f.setSnapshot({ ...f.snapshot, epoch: 2, account: { ...f.snapshot.account, deviceId: nextDevice } }); f.manager.setCapability(true, false);
  await f.manager.refreshStatus(); assert.equal(f.manager.status().saveUnconfirmed, true); await f.manager.retrySave();
  assert.equal(f.calls.filter(row => row.method === 'POST').length, posts); assert.equal(f.readState().sync.deviceId, originalDevice, 'the original receipt was persisted before rebinding');
  const aligned = await f.manager.backup(); assert.equal(aligned.state.sync.deviceId, nextDevice); assert.equal(aligned.state.richEnabled, false);
  preview = await f.manager.preview({ noteIds: [note.id] }); assert.equal(preview.localRows[0].reason, 'NOTE_RICH_UNAVAILABLE');
  f.manager.setCapability(true, true); f.context.noteStore.updateNote({ id: note.id, patch: { title: 'New device explicit edit' } });
  preview = await f.manager.preview({ noteIds: [note.id] }); await f.manager.publish({ token: preview.token });
  assert.equal(f.calls.filter(row => row.method === 'POST').at(-1).body.deviceId, nextDevice); assert.equal(f.receipts.size, 2);
});

test('manual association never guesses equal titles, and adoption preserves the original as a separate editable SQLite note', async t => {
  const f = fixture(t), original = f.local('Shared title'), entityId = randomUUID(); f.put(f.record(entityId, plain('Remote version', 'Shared title')));
  const preview = await f.manager.preview({ noteIds: [original.id] }); assert.equal(preview.localRows[0].action, 'create');
  assert.notEqual(preview.localRows[0].entityId, entityId); await f.manager.bind({ token: preview.token, localNoteId: original.id, entityId });
  assert.deepEqual(f.manager.bindings(), [{ localNoteId: original.id, entityId }]); assert.equal(f.context.noteStore.getNote({ id: original.id }).content, 'Original content');
  const incoming = await f.manager.preview({ noteIds: [] }), result = await f.manager.adopt({ token: incoming.token, ids: [entityId] });
  assert.equal(result.localNoteIds.length, 1); const copyId = result.localNoteIds[0]; assert.notEqual(copyId, original.id);
  assert.equal(f.context.noteStore.getNote({ id: copyId }).content, 'Remote version'); assert.equal(f.context.noteStore.getNote({ id: original.id }).content, 'Original content');
  assert.deepEqual(f.manager.bindings(), [{ localNoteId: copyId, entityId }]);
  f.context.noteStore.updateNote({ id: copyId, patch: { contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'My edited copy' }] }] }, content: 'My edited copy' } });
  const edited = await f.manager.preview({ noteIds: [copyId] }); assert.equal(edited.localRows[0].entityId, entityId); assert.equal(edited.localRows[0].action, 'update');
  await f.manager.publish({ token: edited.token }); assert.equal(f.records.get(entityId).data.body, 'My edited copy');
});

test('copy recovery uses the accepted revision and stable SQLite id even after a newer remote revision appears', async t => {
  const f = fixture(t), entityId = randomUUID(); f.put(f.record(entityId, plain('Accepted version')));
  const createNote = f.context.noteStore.createNote; let rejectSave = true;
  f.context.noteStore.createNote = request => { if (rejectSave) throw Error('Synthetic local write failure'); return createNote(request); };
  const preview = await f.manager.preview({ noteIds: [] }); await assert.rejects(f.manager.adopt({ token: preview.token, ids: [entityId] }), { code: 'NOTE_COPY_SAVE_UNCONFIRMED' });
  const frozen = f.readState().pendingCopies[0], id = frozen.localNoteId; assert.equal(f.manager.status().copyPending, 1); assert.deepEqual(f.manager.bindings(), []);
  f.put(f.record(entityId, plain('Later remote truth'), 2)); f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus();
  rejectSave = false; const calls = f.calls.length; const saved = await f.manager.resumeCopies(); assert.equal(f.calls.length, calls);
  assert.deepEqual(saved.localNoteIds, [id]); assert.equal(f.context.noteStore.getNote({ id }).content, 'Accepted version'); assert.equal(f.manager.status().copyPending, 0);
  assert.equal(f.readState().accepted[0].revision, 1);
});

test('full rich text and verified image bytes reach the local editor without fetching resource URLs', async t => {
  const f = fixture(t), entityId = randomUUID(), bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64'), hash = digest(bytes);
  const data = core.createRichNoteData({ paperId: null, title: 'Rich account truth', document: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Formula ' }, { type: 'inlineMath', attrs: { latex: 'x^2' } }] },
    { type: 'image', attrs: { src: 'asset:sha256:' + hash, alt: 'Exact pixels' } }] },
    metadata: { type: 'standalone', anchors: [], tags: ['exact'], color: '#fef08a', isFavorite: true, isPinned: false, linkedNoteIds: [], linkedPaperIds: [], createdAt: 100, updatedAt: 200, unresolvedReferences: [] },
    assets: [{ id: hash, sha256: hash, base64: bytes.toString('base64'), sizeBytes: bytes.length, mediaType: 'image/png', width: 1, height: 1 }] });
  f.put(f.record(entityId, data)); const preview = await f.manager.preview({ noteIds: [] }), result = await f.manager.adopt({ token: preview.token, ids: [entityId] });
  const saved = f.context.noteStore.getNote({ id: result.localNoteIds[0] }); assert.equal(saved.contentJson.content[1].attrs.src, 'data:image/png;base64,' + bytes.toString('base64'));
  assert.equal(saved.contentJson.content[0].content[1].attrs.latex, 'x^2'); assert.equal(saved.isFavorite, true);
  assert.ok(f.calls.every(row => row.path.startsWith('/v1/'))); assert.deepEqual(f.readState().accepted[0].data, data);
});

test('account deletion preserves the local original and returning a tombstone requires an explicit restore publication', async t => {
  const f = fixture(t), note = f.local(); let preview = await f.manager.preview({ noteIds: [note.id] });
  await f.manager.publish({ token: preview.token }); const entityId = [...f.records.keys()][0];
  preview = await f.manager.preview({ noteIds: [] }); await f.manager.delete({ token: preview.token, entityId });
  assert.equal(f.records.get(entityId).deletedAt, at); assert.equal(f.context.noteStore.getNote({ id: note.id }).content, 'Original content'); assert.deepEqual(f.manager.bindings(), []);
  const checksBefore = f.calls.filter(row => row.method === 'POST').length;
  preview = await f.manager.preview({ noteIds: [note.id] }); assert.equal(preview.localRows[0].action, 'restore');
  assert.equal(f.calls.filter(row => row.method === 'POST').length, checksBefore, 'checking does not resurrect a deleted account row');
  await f.manager.publish({ token: preview.token });
  assert.equal(f.calls.filter(row => row.method === 'POST').at(-1).body.operations[0].mutation, 'restore'); assert.equal(f.records.get(entityId).deletedAt, null);
});

test('stopping a slow preview releases no source or account state into another login', async t => {
  const f = fixture(t), gate = defer(), entered = defer(); f.setRoute(async input => { if (input.path.startsWith('/v1/sync/pull')) { entered.resolve(); await gate.promise; return { protocolVersion: 1, records: [], nextCursor: '0', hasMore: false }; } });
  const task = f.manager.preview({ noteIds: [] }); await entered.promise; const stopping = f.manager.stop(); gate.resolve();
  await assert.rejects(task, { code: 'DESKTOP_OPERATION_CANCELLED' }); await stopping; assert.deepEqual(f.files(), []);
});
