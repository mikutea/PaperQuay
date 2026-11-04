import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as core from '../packages/sync-core/src/index.ts';
const require = createRequire(import.meta.url);
const nativeFs = require('../electron/backend/nativeFs.cjs');
const { createLibraryStore, normalizeAuthor, normalizeTag } = require('../electron/backend/libraryStore.cjs');
const { createDesktopPaperExchange } = require('../electron/backend/desktopPaperExchange.cjs');
const at = '2026-11-04T12:00:00.000Z';
const config = { apiBaseUrl: 'https://sync.example.test', oidcIssuer: 'https://login.example.test', oidcClientId: 'desktop' };
const data = (title = 'Account title', organization) => ({ title, year: '2026', publication: 'Evidence Journal', doi: '10.1234/evidence', abstractText: 'Account abstract',
  authors: ['Existing author', 'New author'], keywords: ['Account keyword'], ...(organization ? { organization } : {}) });
const organization = { favorite: true, readingStatus: 'reading', tags: ['Account tag'], collections: ['Same-name child'], queueRank: 3 };
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-paper-exchange-'));
  const context = { appPaths: { dataDir: path.join(temp, 'library'), configPath: path.join(temp, 'profile', 'config.json'),
    libraryPath: path.join(temp, 'library', 'library.json'), libraryDatabasePath: path.join(temp, 'library', 'library.sqlite') } };
  context.store = createLibraryStore(context.appPaths);
  let snapshot = { config, account: { accountId: randomUUID(), deviceId: randomUUID() }, epoch: 1, library: { libraryBindingId: randomUUID() } };
  const records = new Map(), events = [], receipts = new Map(), conflicts = new Map(), calls = [], managers = [];
  let route = null, writer = null, manager, bound = [], lockHeld = true;
  const record = (entityId, value = data(), revision = 1) => ({ entityType: 'paper', entityId, schemaVersion: 1, revision,
    deletedAt: value === null ? at : null, updatedAt: at, modifiedByDeviceId: snapshot.account.deviceId, data: value });
  const put = row => { records.set(row.entityId, row); events.push(row); return row; };
  const files = () => { const root = path.join(temp, 'profile', 'account-sync', 'papers'); return fs.existsSync(root) ? fs.readdirSync(root).filter(file => file.endsWith('.json')).map(file => path.join(root, file)) : []; };
  const readState = () => JSON.parse(fs.readFileSync(files()[0], 'utf8'));
  function local(localPaperId = 'local-paper', entityId = randomUUID(), remote = data()) {
    const library = context.store.load();
    if (!library.categories.some(row => row.id === 'local-parent')) library.categories.push({ id: 'local-parent', name: 'Parent', parentId: null, sortOrder: 0, isSystem: false, systemKey: null, createdAt: 10, updatedAt: 10 },
      { id: 'local-child', name: 'Same-name child', parentId: 'local-parent', sortOrder: 0, isSystem: false, systemKey: null, createdAt: 10, updatedAt: 10 });
    library.papers.push({ id: localPaperId, title: 'Local title', year: '2020', publication: 'Local journal', doi: '10.1234/local', url: 'https://local.example.test/private-paper',
      abstractText: 'Local abstract', keywords: ['Local keyword'], importedAt: 10, updatedAt: 20, lastReadAt: 18, readingProgress: .73, isFavorite: false,
      userNote: 'Private user note', aiSummary: 'Private summary', citation: 'Private citation', source: 'local', sortOrder: library.papers.length,
      authors: [{ ...normalizeAuthor('Existing author', 0), givenName: 'Existing', familyName: 'author' }], tags: [{ ...normalizeTag('Local tag'), color: 'red' }], categoryIds: ['local-child'],
      attachments: [{ id: 'attachment-' + localPaperId, paperId: localPaperId, kind: 'pdf', storedPath: 'fixture-private-path.pdf', originalPath: 'fixture-private-original.pdf', relativePath: 'fixture.pdf',
        fileName: 'fixture.pdf', mimeType: 'application/pdf', fileSize: 400, contentHash: 'a'.repeat(64), createdAt: 10, missing: false }] });
    context.store.saveSync(library); bound.push({ entityType: 'paper', localId: localPaperId, entityId }); if (remote !== undefined) put(record(entityId, remote));
    return { localPaperId, entityId };
  }
  function create() {
    manager = createDesktopPaperExchange(context, { core, now: () => Date.parse(at), getContext: () => snapshot,
      checkContext(value) { if (!lockHeld) throw Object.assign(Error('Writer lock is not held'), { code: 'ACCOUNT_STATE_IN_USE' });
        if (value.epoch !== snapshot.epoch || value.account.accountId !== snapshot.account.accountId || value.library.libraryBindingId !== snapshot.library.libraryBindingId) throw Object.assign(Error('Changed owner'), { code: 'DESKTOP_OPERATION_CANCELLED' }); },
      getMaterialBindings: () => ({ bindings: bound, live: { paperIds: context.store.load().papers.map(row => row.id), noteIds: [] } }),
      fs: { ...nativeFs, writeSync(file, bytes, options) { return writer ? writer(file, bytes, options) : nativeFs.writeSync(file, bytes, options); } },
      api: async (_owner, input) => {
        calls.push(structuredClone({ path: input.path, method: input.method || 'GET', body: input.body, paperOrganization: input.paperOrganization }));
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
          const previous = records.get(op.entityId);
          if (op.baseRevision !== previous.revision) {
            const conflictId = randomUUID(), result = { opId: op.opId, status: 'conflict', record: previous, replayed: false, conflictId };
            conflicts.set(conflictId, { conflictId, entityId: op.entityId, entityType: 'paper', createdAt: at, attemptedOperation: op, observedRecord: previous, currentRecord: previous });
            receipts.set(op.opId, result); return { protocolVersion: 1, results: [result] };
          }
          const current = put(record(op.entityId, op.data, previous.revision + 1));
          const result = { opId: op.opId, status: 'applied', record: current, replayed: false }; receipts.set(op.opId, result); return { protocolVersion: 1, results: [result] };
        }
        if (/^\/v1\/conflicts\/[^/]+\/resolve$/.test(url.pathname)) {
          const request = input.body, conflictId = url.pathname.split('/')[3]; assert.equal(readState().pendingResolutions.find(row => row.conflictId === conflictId).request.opId, request.opId);
          if (receipts.has(request.opId)) return { ...receipts.get(request.opId), replayed: true };
          const conflict = conflicts.get(conflictId), previous = records.get(conflict.entityId);
          const current = request.choice === 'current' ? previous : put(record(conflict.entityId, conflict.attemptedOperation.data, previous.revision + 1));
          const result = { opId: request.opId, status: 'applied', replayed: false, record: current }; receipts.set(request.opId, result); conflicts.delete(conflictId); return result;
        }
        throw Error('Unexpected fixture request ' + input.path);
      } });
    managers.push(manager); manager.setCapability(true, true); return manager;
  }
  create();
  t.after(async () => {
    for (const owned of managers) owned.close(); await Promise.all(managers.map(owned => owned.settled())); context.store.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('paperquay-paper-exchange-')); fs.rmSync(temp, { recursive: true, force: true });
  });
  return { context, records, receipts, conflicts, calls, put, record, local, create, files, readState,
    get manager() { return manager; }, get snapshot() { return snapshot; }, get bindings() { return bound; },
    setBindings(value) { bound = value; }, setSnapshot(value) { snapshot = value; }, setRoute(value) { route = value; }, setWriter(value) { writer = value; }, setLock(value) { lockHeld = value; } };
}
const posts = f => f.calls.filter(row => row.method === 'POST');

test('read-only preview uses confirmed attachment identities and publishes only the selected whitelist', async t => {
  const f = fixture(t), local = f.local(), before = f.context.store.load(); await f.manager.refreshStatus(); assert.equal(f.calls.length, 0);
  const list = await f.manager.list(); assert.equal(list.papers[0].boundEntityId, local.entityId);
  const preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); assert.equal(preview.localRows[0].action, 'update');
  assert.equal(preview.localRows[0].local.organization.readingStatus, 'unread', 'does not infer discrete status from .73 reading progress');
  assert.deepEqual(preview.localRows[0].local.organization.collections, []); assert.deepEqual(f.files(), []); assert.deepEqual(f.context.store.load(), before);
  await f.manager.publish({ token: preview.token }); assert.equal(posts(f).length, 1); const op = posts(f)[0].body.operations[0];
  assert.equal(op.entityId, local.entityId); assert.equal(op.baseRevision, 1); assert.equal(op.data.title, 'Local title'); assert.equal(op.data.organization.tags[0], 'Local tag');
  assert.ok(!JSON.stringify(op).includes('fixture-private')); assert.ok(!JSON.stringify(op).includes('Private user note')); assert.deepEqual(f.context.store.load(), before);
});

test('a same-title or same-UUID local paper is not a confirmed binding', async t => {
  const f = fixture(t), sameId = randomUUID(), local = f.local(sameId, sameId, data('Local title')); f.setBindings([]);
  const preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); assert.equal(preview.localRows[0].reason, 'PAPER_BINDING_REQUIRED'); assert.equal(preview.incoming[0].canAccept, false);
  await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'PAPER_SELECTION_INVALID' });
  await assert.rejects(f.manager.adopt({ token: preview.token, ids: [local.entityId] }), { code: 'PAPER_BINDING_REQUIRED' }); assert.deepEqual(f.files(), []); assert.equal(posts(f).length, 0);
});

test('desktop organization editing saves a private choice and requires a new preview before publication', async t => {
  const f = fixture(t), local = f.local('local-paper', randomUUID(), data('Account title', organization)), before = f.context.store.load();
  let preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); assert.equal(preview.localRows[0].organizationSource, 'account');
  await f.manager.updateOrganization({ token: preview.token, localPaperId: local.localPaperId, readingStatus: 'read', queued: false, collections: ['Separate collection'] });
  assert.equal(posts(f).length, 0); assert.deepEqual(f.context.store.load(), before); await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'PAPER_PREVIEW_STALE' });
  preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); assert.equal(preview.localRows[0].organizationSource, 'desktop-choice'); assert.equal(preview.localRows[0].local.organization.queueRank, null);
  await f.manager.publish({ token: preview.token }); assert.equal(f.records.get(local.entityId).data.organization.readingStatus, 'read');
  assert.deepEqual(f.records.get(local.entityId).data.organization.collections, ['Separate collection']); assert.deepEqual(f.context.store.load().categories, before.categories);
});

test('read queue editing assigns an internal rank and does not reorder the desktop library', async t => {
  const f = fixture(t), local = f.local(), second = f.local('second-paper', randomUUID(), data('Second', { ...organization, queueRank: 19 }));
  const before = f.context.store.load(); let preview = await f.manager.preview({ localPaperIds: [local.localPaperId] });
  await f.manager.updateOrganization({ token: preview.token, localPaperId: local.localPaperId, readingStatus: 'reading', queued: true, collections: [] });
  assert.equal(f.readState().organizations[0].value.queueRank, 20); assert.deepEqual(f.context.store.load(), before); assert.equal(posts(f).length, 0);
  preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); await f.manager.publish({ token: preview.token }); assert.equal(f.records.get(local.entityId).data.organization.queueRank, 20);
  assert.equal(f.records.get(second.entityId).data.organization.queueRank, 19);
});

test('actual SQLite adoption updates metadata, tags and favorite while preserving paths, hierarchy, progress and references', async t => {
  const f = fixture(t), local = f.local('local-paper', randomUUID(), data('Adopted title', organization));
  f.context.store.saveReferences(local.localPaperId, [{ id: 'reference-one', seq: 1, title: 'Private reference', doi: '10.1234/reference', fetchedAt: 11 }]);
  const before = f.context.store.load(), references = f.context.store.loadReferences(local.localPaperId);
  const preview = await f.manager.preview({ localPaperIds: [] }); assert.equal(preview.incoming[0].canAccept, true);
  const result = await f.manager.adopt({ token: preview.token, ids: [local.entityId] }); assert.deepEqual(result.localPaperIds, [local.localPaperId]); assert.equal(posts(f).length, 0);
  const after = f.context.store.load(), saved = after.papers[0]; assert.equal(saved.title, 'Adopted title'); assert.equal(saved.isFavorite, true); assert.equal(saved.tags[0].name, 'Account tag');
  for (const key of ['attachments', 'categoryIds', 'readingProgress', 'lastReadAt', 'userNote', 'aiSummary', 'citation', 'url', 'source', 'sortOrder', 'importedAt']) assert.deepEqual(saved[key], before.papers[0][key], key);
  assert.equal(saved.authors[0].givenName, 'Existing'); assert.deepEqual(after.categories, before.categories); assert.deepEqual(f.context.store.loadReferences(local.localPaperId), references);
  const backup = await f.manager.backup(); assert.equal(backup.state.adoptions[0].before.title, 'Local title'); assert.equal(backup.state.adoptions[0].before.tags[0].color, 'red');
  assert.equal(backup.state.adoptions[0].phase, 'applied'); assert.deepEqual(backup.state.organizations[0].value, { readingStatus: 'reading', queueRank: 3, collections: ['Same-name child'] });
  assert.ok(!JSON.stringify(backup).includes('fixture-private')); assert.ok(!JSON.stringify(backup).includes('Private user note'));
});

test('a local metadata edit after preview invalidates publication and adoption', async t => {
  const f = fixture(t), local = f.local(), preview = await f.manager.preview({ localPaperIds: [local.localPaperId] });
  const library = f.context.store.load(); library.papers[0].title = 'Concurrent desktop edit'; f.context.store.saveSync(library);
  await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'PAPER_PREVIEW_STALE' });
  await assert.rejects(f.manager.adopt({ token: preview.token, ids: [local.entityId] }), { code: 'PAPER_PREVIEW_STALE' }); assert.equal(posts(f).length, 0); assert.deepEqual(f.files(), []);
});

test('SQLite preflights an entire adoption batch under one transaction and leaves every earlier row unchanged on a race', async t => {
  const f = fixture(t), first = f.local(), second = f.local('second-paper'), originalApply = f.context.store.compareAndApplyPaperMetadata;
  const preview = await f.manager.preview({ localPaperIds: [] }); const before = f.context.store.load();
  f.context.store.compareAndApplyPaperMetadata = rows => {
    assert.equal(f.readState().adoptions.filter(row => row.phase === 'pending').length, 2, 'intent durable before SQLite mutation');
    const library = f.context.store.load(); library.papers.find(row => row.id === second.localPaperId).title = 'Raced with adoption'; f.context.store.saveSync(library); return originalApply(rows);
  };
  await assert.rejects(f.manager.adopt({ token: preview.token, ids: [first.entityId, second.entityId] }), { code: 'PAPER_SOURCE_CHANGED' });
  assert.deepEqual(f.context.store.load().papers.find(row => row.id === first.localPaperId), before.papers.find(row => row.id === first.localPaperId)); assert.equal(f.manager.status().adoptionPending, 2);
  assert.equal(f.readState().adoptions[1].before.title, 'Local title');
});

test('an unrelated field change after preview survives the narrow compare-and-apply transaction', async t => {
  const f = fixture(t), local = f.local(), preview = await f.manager.preview({ localPaperIds: [] });
  const library = f.context.store.load(); library.papers[0].userNote = 'New unrelated note'; library.papers[0].attachments[0].storedPath = 'new-fixture-path.pdf'; f.context.store.saveSync(library);
  await f.manager.adopt({ token: preview.token, ids: [local.entityId] }); const saved = f.context.store.load().papers[0]; assert.equal(saved.userNote, 'New unrelated note'); assert.equal(saved.attachments[0].storedPath, 'new-fixture-path.pdf');
});

test('adoption recovery reuses the frozen account revision after restart, with no network request', async t => {
  const f = fixture(t), local = f.local(), apply = f.context.store.compareAndApplyPaperMetadata; let failWrite = true;
  f.context.store.compareAndApplyPaperMetadata = rows => { if (failWrite) throw Error('Synthetic transaction failure'); return apply(rows); };
  const preview = await f.manager.preview({ localPaperIds: [] }); await assert.rejects(f.manager.adopt({ token: preview.token, ids: [local.entityId] }), { code: 'PAPER_ADOPTION_UNCONFIRMED' });
  f.put(f.record(local.entityId, data('Later account title'), 2)); f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus(); failWrite = false;
  const calls = f.calls.length; await f.manager.resumeAdoptions(); assert.equal(f.calls.length, calls); assert.equal(f.context.store.load().papers[0].title, 'Account title'); assert.equal(f.readState().accepted[0].revision, 1);
});

test('a lost SQLite commit acknowledgement is settled by exact readback without repeating writes', async t => {
  const f = fixture(t), local = f.local(), apply = f.context.store.compareAndApplyPaperMetadata; let writes = 0;
  f.context.store.compareAndApplyPaperMetadata = rows => { writes++; apply(rows); throw Error('Lost SQLite acknowledgement'); };
  const preview = await f.manager.preview({ localPaperIds: [] }); await f.manager.adopt({ token: preview.token, ids: [local.entityId] });
  assert.equal(writes, 1); assert.equal(f.manager.status().adoptionPending, 0); assert.equal(f.context.store.load().papers[0].title, 'Account title');
});

test('unknown publication outcomes keep the original operation and replay it after restart', async t => {
  const f = fixture(t), local = f.local(); let lost = true;
  f.setRoute(input => { if (input.path === '/v1/sync/push' && lost) { lost = false; throw Error('Outcome unknown'); } });
  const preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); await assert.rejects(f.manager.publish({ token: preview.token }));
  const original = posts(f)[0].body.operations[0]; assert.equal(f.readState().sync.outbox[0].status, 'uncertain'); f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus();
  const count = f.calls.length; assert.equal(posts(f).length, 1); await f.manager.continue(); assert.ok(f.calls.length > count); assert.deepEqual(posts(f)[1].body.operations[0], original); assert.equal(f.receipts.size, 1);
});

test('unconfirmed receipt saving is retried without publishing again', async t => {
  const f = fixture(t), local = f.local(); let failSave = true;
  f.setWriter((file, bytes, options) => { const state = JSON.parse(bytes); if (failSave && state.sync.serverRecords['paper:' + local.entityId]?.revision === 2) { failSave = false; throw Error('Lost private save'); } return nativeFs.writeSync(file, bytes, options); });
  const preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'PAPER_SAVE_UNCONFIRMED' });
  assert.equal(f.manager.status().saveUnconfirmed, true); const count = posts(f).length; await f.manager.retrySave(); assert.equal(posts(f).length, count); assert.equal(f.manager.status().saveUnconfirmed, false);
});

test('confirmed identity removal blocks both stale preview and an unknown operation continuation', async t => {
  const f = fixture(t), local = f.local(), preview = await f.manager.preview({ localPaperIds: [local.localPaperId] });
  f.setBindings([]); await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'PAPER_PREVIEW_STALE' });
  f.setBindings([{ entityType: 'paper', localId: local.localPaperId, entityId: local.entityId }]); f.setRoute(input => { if (input.path === '/v1/sync/push') throw Error('Unknown'); });
  const next = await f.manager.preview({ localPaperIds: [local.localPaperId] }); await assert.rejects(f.manager.publish({ token: next.token })); const count = posts(f).length;
  f.setBindings([]); await assert.rejects(f.manager.continue(), { code: 'PAPER_BINDING_CHANGED' }); assert.equal(posts(f).length, count);
});

test('account tombstones remain visible without deleting or restoring local papers', async t => {
  const f = fixture(t), local = f.local(), before = f.context.store.load(); f.put(f.record(local.entityId, null, 2));
  const preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); assert.equal(preview.incoming[0].state, 'deleted'); assert.equal(preview.incoming[0].canAccept, false); assert.equal(preview.localRows[0].action, 'blocked');
  await assert.rejects(f.manager.adopt({ token: preview.token, ids: [local.entityId] }), { code: 'PAPER_REMOTE_UNAVAILABLE' }); assert.deepEqual(f.context.store.load(), before); assert.equal(posts(f).length, 0);
});

test('slow preview cancellation and account changes expose no stale material or private state', async t => {
  const f = fixture(t); f.local(); const gate = defer(), entered = defer();
  f.setRoute(async input => { if (input.path.startsWith('/v1/sync/pull')) { entered.resolve(); await gate.promise; return { protocolVersion: 1, records: [], nextCursor: '0', hasMore: false }; } });
  const pending = f.manager.preview({ localPaperIds: [] }); await entered.promise; const stopping = f.manager.stop(); f.setSnapshot({ ...f.snapshot, account: { ...f.snapshot.account, accountId: randomUUID() }, epoch: 2 }); gate.resolve();
  await assert.rejects(pending, { code: 'DESKTOP_OPERATION_CANCELLED' }); await stopping; assert.deepEqual(f.files(), []); assert.equal(f.manager.status().loaded, false);
});

test('the outer account writer lock is required even for recovery and local organization writes', async t => {
  const f = fixture(t), local = f.local(), preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); f.setLock(false);
  await assert.rejects(f.manager.updateOrganization({ token: preview.token, localPaperId: local.localPaperId, readingStatus: 'read', queued: false, collections: [] }), { code: 'ACCOUNT_STATE_IN_USE' });
  await assert.rejects(f.manager.resumeAdoptions(), { code: 'ACCOUNT_STATE_IN_USE' }); assert.deepEqual(f.files(), []); assert.equal(posts(f).length, 0);
});

test('conflicting publication displays both versions and resolves only after an explicit durable decision', async t => {
  const f = fixture(t), local = f.local(); let preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); f.put(f.record(local.entityId, data('Concurrent account edit'), 2));
  await f.manager.publish({ token: preview.token }); assert.equal(f.manager.status().conflicts, 1); preview = await f.manager.preview({ localPaperIds: [] });
  assert.equal(preview.conflicts[0].attempted.data.title, 'Local title'); assert.equal(preview.conflicts[0].current.data.title, 'Concurrent account edit');
  await f.manager.resolve({ conflictId: preview.conflicts[0].conflictId, choice: 'attempted', expectedRevision: 2 });
  assert.equal(f.manager.status().conflicts, 0); assert.equal(f.records.get(local.entityId).data.title, 'Local title'); assert.equal(f.context.store.load().papers[0].title, 'Local title');
});

test('undo restores the exact local whitelist and organization choice while preserving the real account receipt', async t => {
  const f = fixture(t), local = f.local('local-paper', randomUUID(), data('Adopted title', organization)), before = f.context.store.load();
  let preview = await f.manager.preview({ localPaperIds: [local.localPaperId] });
  await f.manager.updateOrganization({ token: preview.token, localPaperId: local.localPaperId, readingStatus: 'unread', queued: false, collections: ['Earlier local choice'] });
  preview = await f.manager.preview({ localPaperIds: [] }); await f.manager.adopt({ token: preview.token, ids: [local.entityId] });
  preview = await f.manager.preview({ localPaperIds: [] }); const history = preview.adoptions[0]; assert.equal(history.label, 'Adopted title');
  assert.equal(history.before.title, 'Local title'); assert.equal(history.after.title, 'Adopted title'); assert.deepEqual(history.beforeOrganization.collections, ['Earlier local choice']);
  const remote = structuredClone(f.records.get(local.entityId)), count = f.calls.length;
  await f.manager.restoreAdoption({ adoptionId: history.adoptionId }); assert.deepEqual(f.context.store.load(), before); assert.equal(f.calls.length, count);
  const state = f.readState(); assert.equal(state.adoptions[0].phase, 'restored'); assert.deepEqual(state.organizations[0].value, { readingStatus: 'unread', queueRank: null, collections: ['Earlier local choice'] });
  assert.deepEqual(f.records.get(local.entityId), remote); assert.deepEqual(state.accepted[0], remote); assert.equal(posts(f).length, 0);
  const save = f.context.store.compareAndApplyPaperMetadata; f.context.store.compareAndApplyPaperMetadata = () => { throw Error('Repeated undo must not write'); };
  await f.manager.restoreAdoption({ adoptionId: history.adoptionId }); f.context.store.compareAndApplyPaperMetadata = save;
});

test('undo refuses later desktop metadata or private organization edits without staging a write', async t => {
  const f = fixture(t), local = f.local('local-paper', randomUUID(), data('Adopted title', organization)); let preview = await f.manager.preview({ localPaperIds: [] });
  await f.manager.adopt({ token: preview.token, ids: [local.entityId] }); const adoptionId = f.readState().adoptions[0].adoptionId;
  const adopted = f.context.store.load(), changed = structuredClone(adopted); changed.papers[0].title = 'A later desktop edit'; f.context.store.saveSync(changed);
  await assert.rejects(f.manager.restoreAdoption({ adoptionId }), { code: 'PAPER_SOURCE_CHANGED' }); assert.equal(f.readState().adoptions[0].phase, 'applied');
  f.context.store.saveSync(adopted); preview = await f.manager.preview({ localPaperIds: [local.localPaperId] });
  await f.manager.updateOrganization({ token: preview.token, localPaperId: local.localPaperId, readingStatus: 'read', queued: false, collections: [] });
  await assert.rejects(f.manager.restoreAdoption({ adoptionId }), { code: 'PAPER_ORGANIZATION_CHANGED' }); assert.equal(f.readState().adoptions[0].phase, 'applied');
  assert.equal(f.context.store.load().papers[0].title, 'Adopted title'); assert.equal(posts(f).length, 0);
});

test('undo journals an exact reverse change before SQLite and resumes safely after restart', async t => {
  const f = fixture(t), local = f.local('local-paper', randomUUID(), data('Adopted title', organization)), before = f.context.store.load();
  const preview = await f.manager.preview({ localPaperIds: [] }); await f.manager.adopt({ token: preview.token, ids: [local.entityId] }); const adoptionId = f.readState().adoptions[0].adoptionId;
  const apply = f.context.store.compareAndApplyPaperMetadata; let reject = true;
  f.context.store.compareAndApplyPaperMetadata = changes => {
    assert.equal(f.readState().adoptions[0].phase, 'restoring'); assert.equal(changes[0].before.title, 'Adopted title'); assert.equal(changes[0].after.title, 'Local title');
    if (reject) throw Error('Synthetic undo transaction failure'); return apply(changes);
  };
  await assert.rejects(f.manager.restoreAdoption({ adoptionId }), { code: 'PAPER_ADOPTION_UNCONFIRMED' }); assert.equal(f.manager.status().restorationPending, 1);
  f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus(); reject = false;
  const count = f.calls.length; await f.manager.resumeAdoptions(); assert.equal(f.calls.length, count); assert.deepEqual(f.context.store.load(), before);
  assert.equal(f.readState().adoptions[0].phase, 'restored'); assert.equal(f.readState().organizations.length, 0);
});

test('a saved SQLite undo with a lost private acknowledgement only retries the private receipt', async t => {
  const f = fixture(t), local = f.local(), before = f.context.store.load(), preview = await f.manager.preview({ localPaperIds: [] });
  await f.manager.adopt({ token: preview.token, ids: [local.entityId] }); const adoptionId = f.readState().adoptions[0].adoptionId; let failSave = true;
  f.setWriter((file, bytes, options) => { const state = JSON.parse(bytes); if (failSave && state.adoptions[0]?.phase === 'restored') { failSave = false; throw Error('Unconfirmed undo receipt'); } return nativeFs.writeSync(file, bytes, options); });
  await assert.rejects(f.manager.restoreAdoption({ adoptionId }), { code: 'PAPER_SAVE_UNCONFIRMED' }); assert.deepEqual(f.context.store.load(), before);
  const apply = f.context.store.compareAndApplyPaperMetadata; f.context.store.compareAndApplyPaperMetadata = () => { throw Error('Must not rewrite SQLite'); };
  const calls = f.calls.length; await f.manager.retrySave(); assert.equal(f.calls.length, calls); assert.equal(f.readState().adoptions[0].phase, 'restored'); f.context.store.compareAndApplyPaperMetadata = apply;
});

test('the private file is compare-and-swapped and external changes are preserved', async t => {
  const f = fixture(t), local = f.local(); let preview = await f.manager.preview({ localPaperIds: [local.localPaperId] });
  await f.manager.updateOrganization({ token: preview.token, localPaperId: local.localPaperId, readingStatus: 'reading', queued: false, collections: [] });
  preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); const file = f.files()[0], edited = JSON.parse(fs.readFileSync(file, 'utf8')); edited.revision += 1; fs.writeFileSync(file, JSON.stringify(edited));
  await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'PAPER_STORAGE_CHANGED' }); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), edited); assert.equal(posts(f).length, 0);
  await assert.rejects(f.manager.retrySave(), { code: 'PAPER_STORAGE_CHANGED' }); assert.equal(posts(f).length, 0);
  const backup = await f.manager.backup(); assert.equal(backup.unconfirmedState.sync.outbox.length, 1);
});

test('an account round trip restores only the original owner retained receipt', async t => {
  const f = fixture(t), local = f.local(), firstOwner = f.snapshot; let failSave = true;
  f.setWriter((file, bytes, options) => { const state = JSON.parse(bytes); if (failSave && state.sync.serverRecords['paper:' + local.entityId]?.revision === 2) { failSave = false; throw Error('Retained owner receipt'); } return nativeFs.writeSync(file, bytes, options); });
  const preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'PAPER_SAVE_UNCONFIRMED' });
  f.manager.invalidate(); f.setSnapshot({ ...firstOwner, epoch: 2, account: { ...firstOwner.account, accountId: randomUUID() } }); f.manager.setCapability(true, true); await f.manager.refreshStatus();
  assert.equal(f.manager.status().saveUnconfirmed, false); assert.equal(f.manager.status().pending, 0); assert.equal((await f.manager.backup()).state.sync.serverRecords['paper:' + local.entityId], undefined);
  f.manager.invalidate(); f.setSnapshot({ ...firstOwner, epoch: 3 }); f.manager.setCapability(true, true); await f.manager.refreshStatus(); assert.equal(f.manager.status().saveUnconfirmed, true);
  const count = posts(f).length; await f.manager.retrySave(); assert.equal(posts(f).length, count); assert.equal(f.manager.status().saveUnconfirmed, false);
});

test('a failed later pull page is read-only and leaves the previously durable draft and cursor intact', async t => {
  const f = fixture(t), local = f.local(); let preview = await f.manager.preview({ localPaperIds: [local.localPaperId] });
  await f.manager.updateOrganization({ token: preview.token, localPaperId: local.localPaperId, readingStatus: 'read', queued: false, collections: [] }); const before = f.readState();
  f.put(f.record(local.entityId, data('Second revision'), 2)); f.put(f.record(local.entityId, data('Third revision'), 3)); let pages = 0;
  f.setRoute(input => { if (input.path.startsWith('/v1/sync/pull') && ++pages === 2) return { protocolVersion: 1, records: [], nextCursor: false, hasMore: false }; });
  await assert.rejects(f.manager.preview({ localPaperIds: [local.localPaperId] }), { code: 'PAPER_STATE_INVALID' }); assert.deepEqual(f.readState(), before); assert.equal(posts(f).length, 0);
});

test('capability loss never sends an existing organization operation or changes local fields', async t => {
  const f = fixture(t), local = f.local(); f.setRoute(input => { if (input.path === '/v1/sync/push') throw Error('Unknown'); });
  const before = f.context.store.load(), preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); await assert.rejects(f.manager.publish({ token: preview.token }));
  f.manager.setCapability(true, false); const count = posts(f).length; await assert.rejects(f.manager.continue(), { code: 'PAPER_ORGANIZATION_UNAVAILABLE' });
  assert.equal(posts(f).length, count); assert.deepEqual(f.context.store.load(), before);
});

test('an actually committed publication with a lost acknowledgement replays one immutable receipt', async t => {
  const f = fixture(t), local = f.local(); let lose = true;
  f.setRoute(input => {
    if (input.path === '/v1/sync/push' && lose) {
      lose = false; const op = input.body.operations[0]; assert.equal(f.readState().sync.outbox[0].operation.opId, op.opId);
      const record = f.put(f.record(local.entityId, op.data, 2)); f.receipts.set(op.opId, { opId: op.opId, status: 'applied', record, replayed: false }); throw Error('Server committed; acknowledgement lost');
    }
  });
  const preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); await assert.rejects(f.manager.publish({ token: preview.token }));
  const original = posts(f)[0].body.operations[0]; f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus(); await f.manager.continue();
  assert.equal(f.records.get(local.entityId).revision, 2); assert.equal(f.receipts.size, 1); assert.deepEqual(posts(f)[1].body.operations[0], original); assert.equal(f.manager.status().pending, 0);
});

test('unknown conflict decisions survive restart with the original resolution opId', async t => {
  const f = fixture(t), local = f.local(); const preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); f.put(f.record(local.entityId, data('Concurrent title'), 2));
  await f.manager.publish({ token: preview.token }); const conflictId = [...f.conflicts.keys()][0]; let lose = true;
  f.setRoute(input => {
    if (input.path.includes('/resolve') && lose) {
      lose = false; const request = input.body, conflict = f.conflicts.get(conflictId), record = f.put(f.record(local.entityId, conflict.attemptedOperation.data, 3));
      f.receipts.set(request.opId, { opId: request.opId, status: 'applied', record, replayed: false }); f.conflicts.delete(conflictId); throw Error('Resolution acknowledgement lost');
    }
  });
  await assert.rejects(f.manager.resolve({ conflictId, choice: 'attempted', expectedRevision: 2 })); const request = f.readState().pendingResolutions[0].request;
  f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus(); await f.manager.continue();
  assert.equal(f.records.get(local.entityId).revision, 3); const attempts = posts(f).filter(row => row.path.includes('/resolve')); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].body, request); assert.deepEqual(attempts[1].body, request);
  assert.equal(f.manager.status().pending, 0); assert.equal(f.manager.status().conflicts, 0);
});

test('a retained receipt is reconciled with a new registered device only after it is saved', async t => {
  const f = fixture(t), local = f.local(), first = f.snapshot; let rejectSave = true;
  f.setWriter((file, bytes, options) => { const state = JSON.parse(bytes); if (rejectSave && state.sync.serverRecords['paper:' + local.entityId]?.revision === 2) { rejectSave = false; throw Error('Retained receipt'); } return nativeFs.writeSync(file, bytes, options); });
  let preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'PAPER_SAVE_UNCONFIRMED' });
  const deviceId = randomUUID(); f.manager.invalidate(); f.setSnapshot({ ...first, epoch: 2, account: { ...first.account, deviceId } }); f.manager.setCapability(true, true); await f.manager.refreshStatus();
  const count = posts(f).length; await f.manager.retrySave(); assert.equal(posts(f).length, count);
  const library = f.context.store.load(); library.papers[0].title = 'New local edit'; library.papers[0].updatedAt++; f.context.store.saveSync(library);
  preview = await f.manager.preview({ localPaperIds: [local.localPaperId] }); await f.manager.publish({ token: preview.token }); assert.equal(posts(f).at(-1).body.deviceId, deviceId);
});

test('duplicate wire author and tag names preserve every occurrence without reusing another occurrence personal details', async t => {
  const f = fixture(t), remote = { ...data('Two authors with the same display name', { ...organization, tags: ['Local tag', 'Local tag'] }), authors: ['Existing author', 'Existing author'] };
  const local = f.local('local-paper', randomUUID(), remote), before = f.context.store.load();
  const preview = await f.manager.preview({ localPaperIds: [] }); await f.manager.adopt({ token: preview.token, ids: [local.entityId] });
  const saved = f.context.store.load().papers[0]; assert.deepEqual(saved.authors.map(row => row.name), remote.authors); assert.equal(saved.authors[0].givenName, 'Existing'); assert.equal(saved.authors[1].givenName, null);
  assert.notEqual(saved.authors[0].id, saved.authors[1].id); assert.deepEqual(saved.authors.map(row => row.sortOrder), [0, 1]);
  assert.deepEqual(saved.tags.map(row => row.name), ['Local tag', 'Local tag']); assert.equal(saved.tags[0].color, 'red'); assert.equal(saved.tags[1].color, null); assert.notEqual(saved.tags[0].id, saved.tags[1].id);
  await f.manager.restoreAdoption({ adoptionId: f.readState().adoptions[0].adoptionId }); assert.deepEqual(f.context.store.load(), before);
});

test('matching repeated names consumes the original occurrences in order instead of copying the first match', async t => {
  const f = fixture(t), remote = { ...data('Three matching author occurrences'), authors: ['Existing author', 'Existing author', 'Existing author'] }, local = f.local('local-paper', randomUUID(), remote);
  const library = f.context.store.load(); library.papers[0].authors.push({ ...normalizeAuthor('Existing author', 1), id: 'distinct-second-author', givenName: 'Second', familyName: 'person' }); f.context.store.saveSync(library);
  const preview = await f.manager.preview({ localPaperIds: [] }); await f.manager.adopt({ token: preview.token, ids: [local.entityId] });
  const authors = f.context.store.load().papers[0].authors; assert.deepEqual(authors.map(row => row.givenName), ['Existing', 'Second', null]); assert.deepEqual(authors.map(row => row.sortOrder), [0, 1, 2]); assert.equal(new Set(authors.map(row => row.id)).size, 3);
  assert.equal(authors[1].id, 'distinct-second-author');
});
