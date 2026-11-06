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
const { createDesktopGraphExchange } = require('../electron/backend/desktopGraphExchange.cjs');
const at = '2026-10-31T05:00:00.000Z';
const CONFIG = { apiBaseUrl: 'https://sync.example.test', oidcIssuer: 'https://login.example.test', oidcClientId: 'desktop' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const raw = (id = 'local-1', patch = {}) => ({ id, source: 'paper:first', target: 'paper:second', type: 'ai_suggested',
  label: 'Supports', description: 'Explicit local draft.\nExact second line.', confidence: null, weight: 0.58, createdAt: 0, updatedAt: null, ...patch });

function fixture(t, settings = {}) {
  const prefix = path.join(os.tmpdir(), 'paperquay-desktop-graph-'), temp = fs.mkdtempSync(prefix);
  const context = { appPaths: { configPath: path.join(temp, 'profile', 'config.json'), dataDir: path.join(temp, 'library') } };
  fs.mkdirSync(context.appPaths.dataDir, { recursive: true });
  const sourceFile = path.join(context.appPaths.dataDir, 'paperquay-knowledge-graph-relations.json');
  const source = Buffer.from(JSON.stringify({ version: 1, relations: settings.rows || [raw()], retainedExtension: { untouched: 'local-only' } }, null, 2));
  fs.writeFileSync(sourceFile, source);
  let snapshot = { config: CONFIG, account: { accountId: randomUUID(), deviceId: randomUUID() }, epoch: 1,
    library: { libraryBindingId: randomUUID(), anchor: { identity: 'fixture-anchor' } } };
  let material = { bindings: [{ entityType: 'paper', localId: 'first', entityId: randomUUID() },
    { entityType: 'paper', localId: 'second', entityId: randomUUID() }], live: { paperIds: ['first', 'second'], noteIds: ['note-a'] } };
  if (settings.contextMaterials) snapshot.library.material = material;
  const records = new Map(), receipts = new Map(), conflicts = new Map(), calls = [], managers = [];
  let route = null, writes = null, manager;
  function makeRecord(entityId, data, revision = 1) { return { entityType: 'graphRelation', entityId, schemaVersion: 1, revision,
    deletedAt: data === null ? at : null, updatedAt: at, modifiedByDeviceId: snapshot.account.deviceId, data }; }
  const fetcher = async (url, init) => {
    const parsed = new URL(url), body = init.body === undefined ? undefined : JSON.parse(init.body);
    const call = { url: parsed, method: init.method || 'GET', body, signal: init.signal }; calls.push(call);
    if (route) { const response = await route(call); if (response !== undefined) return response; }
    if (parsed.pathname === '/v1/sync/pull') return Response.json({ protocolVersion: 1, records: [...records.values()], nextCursor: 'checked', hasMore: false });
    if (parsed.pathname === '/v1/conflicts') return Response.json({ conflicts: [...conflicts.values()], nextCursor: 'checked', hasMore: false });
    if (parsed.pathname === '/v1/sync/push') {
      assert.equal(body.operations.length, 1, 'each HTTP request holds one graph intent');
      const op = body.operations[0]; assert.equal(op.entityType, 'graphRelation');
      const saved = readState(); assert.equal(saved.sync.outbox.find(row => row.operation.opId === op.opId)?.status, 'sending', 'durable preparation precedes HTTP');
      if (receipts.has(op.opId)) return Response.json({ protocolVersion: 1, results: [{ ...receipts.get(op.opId), replayed: true }] });
      const record = makeRecord(op.entityId, op.data, (records.get(op.entityId)?.revision || 0) + 1); records.set(op.entityId, record);
      const result = { opId: op.opId, status: 'applied', replayed: false, record }; receipts.set(op.opId, result);
      return Response.json({ protocolVersion: 1, results: [result] });
    }
    if (/^\/v1\/conflicts\/[a-f0-9-]+\/resolve$/.test(parsed.pathname)) {
      const conflictId = parsed.pathname.split('/')[3], conflict = conflicts.get(conflictId);
      if (receipts.has(body.opId)) return Response.json({ ...receipts.get(body.opId), replayed: true });
      const prior = records.get(conflict.entityId), record = body.choice === 'current' ? prior
        : makeRecord(conflict.entityId, body.choice === 'merged' ? body.data : conflict.attemptedOperation.data, prior.revision + 1);
      const result = { opId: body.opId, status: 'applied', replayed: false, record }; records.set(record.entityId, record);
      receipts.set(body.opId, result); conflicts.delete(conflictId); return Response.json(result);
    }
    throw Error('Unexpected fixture route ' + parsed.pathname);
  };
  const checkContext = captured => {
    if (captured.epoch !== snapshot.epoch || captured.account.accountId !== snapshot.account.accountId
      || captured.account.deviceId !== snapshot.account.deviceId || captured.library.libraryBindingId !== snapshot.library.libraryBindingId
      || captured.library.anchor.identity !== snapshot.library.anchor.identity) throw Object.assign(Error('Changed fixture context'), { code: 'DESKTOP_OPERATION_CANCELLED' });
  };
  const create = () => {
    manager = createDesktopGraphExchange(context, { core, now: () => Date.parse(at), getContext: () => snapshot, checkContext,
      getMaterialBindings: value => settings.contextMaterials ? value.library.material : material, fs: { ...nativeFs, writeSync(file, bytes, options) {
        if (writes) return writes(file, bytes, options); return nativeFs.writeSync(file, bytes, options);
      } }, api: async (_captured, input) => {
        const response = await fetcher(CONFIG.apiBaseUrl + input.path, { method: input.method, body: input.body === undefined ? undefined : JSON.stringify(input.body), signal: input.signal });
        return response.json();
      } });
    managers.push(manager); manager.setCapability(true); return manager;
  };
  const privateFiles = () => { const dir = path.join(temp, 'profile', 'account-sync', 'graph'); return fs.existsSync(dir) ? fs.readdirSync(dir).map(file => path.join(dir, file)) : []; };
  const readState = () => JSON.parse(fs.readFileSync(privateFiles()[0], 'utf8'));
  create();
  t.after(async () => {
    for (const owned of managers) owned.close(); await Promise.all(managers.map(owned => owned.settled()));
    const target = path.resolve(temp), allowed = path.resolve(os.tmpdir());
    assert.ok(target.startsWith(path.resolve(prefix)) && path.dirname(target) === allowed, 'delete only this fixture mkdtemp directory');
    fs.rmSync(target, { recursive: true, force: true });
  });
  const wire = patch => ({ source: { entityType: 'paper', entityId: material.bindings[0].entityId }, target: { entityType: 'paper', entityId: material.bindings[1].entityId },
    relationType: 'ai_suggested', label: 'Remote supports', description: 'Account-only relation', confidence: null, weight: 0.58, createdAt: '1970-01-01T00:00:00.000Z', updatedAt: null, ...patch });
  return { context, sourceFile, source, calls, records, receipts, conflicts, makeRecord, wire, privateFiles, readState, create,
    get manager() { return manager; }, get snapshot() { return snapshot; }, get material() { return material; },
    setSnapshot(value) { snapshot = value; }, setMaterial(value) { material = value; }, setRoute(value) { route = value; }, setWrites(value) { writes = value; },
    putSource(rows) { fs.writeFileSync(sourceFile, JSON.stringify({ version: 1, relations: rows, retainedExtension: { untouched: 'local-only' } })); },
    async publish() { const preview = await manager.preview(); return manager.publish({ token: preview.token, keys: preview.localRows.filter(row => row.action === 'create').map(row => row.key) }); },
    async adopt(id) { const preview = await manager.preview(); return manager.adopt({ token: preview.token, ids: [id] }); },
  };
}

test('graph checking is explicit and read only; publication writes only the account overlay', async t => {
  const f = fixture(t); const key = f.manager.status().scopeKey;
  assert.ok(key); assert.equal(f.manager.status().loaded, false); await f.manager.refreshStatus();
  assert.equal(f.calls.length, 0); assert.deepEqual(f.privateFiles(), []);
  const p = await f.manager.preview(); assert.equal(p.scopeKey, key); assert.equal(p.localRows[0].action, 'create');
  assert.deepEqual(f.calls.map(row => row.method), ['GET', 'GET']); assert.deepEqual(f.privateFiles(), []);
  assert.equal(p.localRows[0].local.confidence, null); assert.equal(p.localRows[0].local.createdAt, '1970-01-01T00:00:00.000Z');
  await f.manager.publish({ token: p.token, keys: [p.localRows[0].key] });
  assert.equal(f.manager.status().pending, 0); assert.equal(f.manager.status().accepted, 0);
  assert.equal(f.readState().links.length, 1); assert.deepEqual(fs.readFileSync(f.sourceFile), f.source);
  const entityId = f.readState().links[0].entityId; await f.adopt(entityId);
  assert.equal(f.manager.projection().relations[0].id, 'account-graph:' + entityId);
  assert.deepEqual(f.manager.projection().suppressedLocalIds, ['local-1']); assert.deepEqual(fs.readFileSync(f.sourceFile), f.source);
});

test('lost network ACK retains one opId across restart and never retries until explicit continue', async t => {
  const f = fixture(t); let lost = true;
  f.setRoute(async call => {
    if (call.method !== 'POST' || !lost) return; lost = false;
    const op = call.body.operations[0], record = f.makeRecord(op.entityId, op.data); f.records.set(op.entityId, record);
    f.receipts.set(op.opId, { opId: op.opId, status: 'applied', replayed: false, record });
    throw Object.assign(Error('Response lost'), { code: 'NETWORK_ERROR' });
  });
  await assert.rejects(f.publish(), { code: 'NETWORK_ERROR' });
  const pending = f.readState().sync.outbox[0]; assert.equal(pending.status, 'uncertain');
  f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus();
  const before = f.calls.length; await Promise.resolve(); assert.equal(f.calls.length, before);
  await f.manager.continue();
  const requests = f.calls.filter(row => row.method === 'POST').map(row => row.body.operations[0]);
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]); assert.equal(requests[0].opId, pending.operation.opId);
  assert.equal(f.manager.status().pending, 0); assert.equal(f.records.size, 1); assert.deepEqual(fs.readFileSync(f.sourceFile), f.source);
});

test('lost local save ACK is reconciled from bytes without repeating any HTTP request', async t => {
  const f = fixture(t); let lose = true;
  f.setWrites((file, bytes, options) => {
    const state = JSON.parse(bytes); nativeFs.writeSync(file, bytes, options);
    if (lose && state.links.length && state.sync.outbox.length === 0) { lose = false; throw Error('Write completion lost'); }
  });
  await assert.rejects(f.publish(), { code: 'GRAPH_SAVE_UNCONFIRMED' });
  assert.equal(f.manager.status().saveUnconfirmed, true); assert.equal(f.readState().sync.outbox.length, 0);
  const calls = f.calls.length, backup = await f.manager.backup();
  assert.ok(backup.unconfirmedState); assert.equal(backup.format, 'paperquay-desktop-graph-backup');
  assert.equal(JSON.stringify(backup).includes(f.context.appPaths.dataDir), false);
  await f.manager.retrySave(); assert.equal(f.calls.length, calls); assert.equal(f.manager.status().saveUnconfirmed, false);
  assert.equal(f.manager.status().pending, 0);
});

test('an unconfirmed intent cannot send; retrySave persists only local state', async t => {
  const f = fixture(t); let failWrite = true;
  f.setWrites((file, bytes, options) => { if (failWrite) throw Error('Disk unavailable'); return nativeFs.writeSync(file, bytes, options); });
  await assert.rejects(f.publish(), { code: 'GRAPH_SAVE_UNCONFIRMED' }); assert.equal(f.calls.filter(row => row.method === 'POST').length, 0);
  await assert.rejects(f.manager.continue(), { code: 'GRAPH_SAVE_UNCONFIRMED' });
  failWrite = false; const calls = f.calls.length; await f.manager.retrySave(); assert.equal(f.calls.length, calls);
  await f.manager.continue(); assert.equal(f.manager.status().pending, 0);
});

test('preview tokens reject local source, binding and A-B-A epoch changes before publishing', async t => {
  for (const mode of ['source', 'binding', 'epoch']) {
    const f = fixture(t), p = await f.manager.preview();
    if (mode === 'source') f.putSource([raw('local-1', { label: 'Changed after review' })]);
    if (mode === 'binding') f.setMaterial({ ...f.material, bindings: f.material.bindings.slice(0, 1) });
    if (mode === 'epoch') { const old = f.snapshot; f.setSnapshot({ ...old, epoch: old.epoch + 1, account: { ...old.account, accountId: randomUUID() } }); f.manager.invalidate(); f.setSnapshot({ ...old, epoch: old.epoch + 2 }); f.manager.setCapability(true); }
    await assert.rejects(f.manager.publish({ token: p.token, keys: [p.localRows[0].key] }), { code: 'GRAPH_PREVIEW_STALE' });
    assert.equal(f.calls.filter(row => row.method === 'POST').length, 0); assert.deepEqual(f.privateFiles(), []);
  }
});

test('binding commits in the same login epoch invalidate old preview mappings and hide retired endpoints', async t => {
  const f = fixture(t, { contextMaterials: true }), id = randomUUID();
  f.records.set(id, f.makeRecord(id, f.wire())); await f.adopt(id);
  const p = await f.manager.preview(); assert.equal(f.manager.projection().relations.length, 1);
  f.setSnapshot({ ...f.snapshot, library: { ...f.snapshot.library, material: { ...f.material, bindings: f.material.bindings.slice(0, 1) } } });
  assert.equal(f.manager.projection().relations.length, 0);
  await assert.rejects(f.manager.publish({ token: p.token, keys: [p.localRows[0].key] }), { code: 'GRAPH_PREVIEW_STALE' });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('an ACK received after account switch is retained only in its original account file', async t => {
  const f = fixture(t), entered = deferred(), release = deferred(), original = f.snapshot;
  f.setRoute(async call => {
    if (call.method !== 'POST') return;
    const op = call.body.operations[0], record = f.makeRecord(op.entityId, op.data); entered.resolve(); await release.promise;
    return Response.json({ protocolVersion: 1, results: [{ opId: op.opId, status: 'applied', replayed: false, record }] });
  });
  const publish = f.publish(); await entered.promise;
  f.setSnapshot({ ...original, epoch: original.epoch + 1, account: { ...original.account, accountId: randomUUID() } }); f.manager.invalidate();
  assert.deepEqual(f.manager.projection(), { relations: [], suppressedLocalIds: [] }); release.resolve();
  await assert.rejects(publish, { code: 'DESKTOP_OPERATION_CANCELLED' });
  assert.equal(f.privateFiles().length, 1); assert.equal(f.readState().scope.accountId, original.account.accountId); assert.equal(f.readState().sync.outbox.length, 0);
  f.setSnapshot({ ...original, epoch: original.epoch + 2 }); f.manager.setCapability(true); await f.manager.refreshStatus();
  assert.equal(f.manager.status().pending, 0); assert.equal(f.manager.status().accepted, 0);
});

test('unknown notes remain unmapped and incoming bodies are retained without creating materials', async t => {
  const f = fixture(t, { rows: [raw('note-local', { target: 'note:note-a' })] });
  const mapped = randomUUID(), unknown = randomUUID();
  f.records.set(mapped, f.makeRecord(mapped, f.wire()));
  f.records.set(unknown, f.makeRecord(unknown, f.wire({ target: { entityType: 'note', entityId: randomUUID() } })));
  const p = await f.manager.preview(); assert.equal(p.localRows[0].reason, 'UNMAPPED_GRAPH_ENDPOINT');
  assert.equal(p.incoming.find(row => row.entityId === unknown).state, 'unmapped');
  await assert.rejects(f.manager.adopt({ token: p.token, ids: [unknown] }), { code: 'UNMAPPED_GRAPH_ENDPOINT' });
  await f.manager.adopt({ token: p.token, ids: [mapped] });
  assert.equal(Object.keys(f.readState().sync.serverRecords).length, 2); assert.equal(f.readState().accepted.length, 1);
  assert.equal(f.manager.projection().relations.length, 1); assert.deepEqual(f.material.live, { paperIds: ['first', 'second'], noteIds: ['note-a'] });
  f.setMaterial({ ...f.material, live: { paperIds: ['first'], noteIds: ['note-a'] } }); assert.equal(f.manager.projection().relations.length, 0);
  assert.deepEqual(fs.readFileSync(f.sourceFile), f.source);
});

test('missing and damaged local source files never become delete selections', async t => {
  const f = fixture(t); await f.publish();
  fs.unlinkSync(f.sourceFile); let p = await f.manager.preview(); assert.equal(p.localRows[0].action, 'blocked'); assert.equal(p.localRows[0].reason, 'GRAPH_SOURCE_MISSING');
  fs.writeFileSync(f.sourceFile, '{broken'); p = await f.manager.preview(); assert.equal(p.localRows[0].action, 'blocked'); assert.equal(p.localRows[0].reason, 'GRAPH_SOURCE_INVALID');
  f.putSource([]); p = await f.manager.preview(); assert.equal(p.localRows[0].action, 'delete');
});

test('one explicit publication sends at most 32 one-operation requests', async t => {
  const f = fixture(t, { rows: Array.from({ length: 33 }, (_, i) => raw('local-' + i)) });
  await f.publish(); assert.equal(f.calls.filter(row => row.method === 'POST').length, 32); assert.equal(f.manager.status().pending, 1);
  const remaining = f.readState().sync.outbox[0].operation.opId; await f.manager.continue();
  assert.equal(f.calls.filter(row => row.method === 'POST').length, 33); assert.equal(f.calls.at(-1).body.operations[0].opId, remaining);
  assert.equal(f.manager.status().pending, 0); assert.deepEqual(fs.readFileSync(f.sourceFile), f.source);
});

test('accepted account edits preserve source and unknown score; repeated pending deletion preserves intent', async t => {
  const f = fixture(t), id = randomUUID(); f.records.set(id, f.makeRecord(id, f.wire())); await f.adopt(id);
  await assert.rejects(f.manager.updateRelation({ id: 'account-graph:' + id, source: 'paper:second', label: 'Changed' }), { code: 'GRAPH_BINDING_IMMUTABLE' });
  await f.manager.updateRelation({ id: 'account-graph:' + id, label: 'Changed', createdAt: 0 });
  assert.equal(f.manager.projection().relations[0].label, 'Changed'); assert.equal(f.readState().accepted[0].data.confidence, null);
  let failing = true; f.setRoute(call => { if (call.method === 'POST' && failing) throw Object.assign(Error('Lost network'), { code: 'NETWORK_ERROR' }); });
  await assert.rejects(f.manager.deleteRelation({ id: 'account-graph:' + id }), { code: 'NETWORK_ERROR' });
  assert.equal(f.manager.projection().relations.length, 0); const operation = f.readState().sync.outbox[0].operation, count = f.calls.length;
  await assert.rejects(f.manager.deleteRelation({ id: 'account-graph:' + id }), { code: 'GRAPH_PENDING' });
  assert.equal(f.calls.length, count); assert.deepEqual(f.readState().sync.outbox[0].operation, operation);
  failing = false; await f.manager.continue(); assert.equal(f.readState().accepted[0].deletedAt, at); assert.deepEqual(fs.readFileSync(f.sourceFile), f.source);
});

for (const outcome of ['rejected', 'conflict']) {
  test(`a ${outcome} account deletion shows its accepted row and never reports a completed deletion`, async t => {
    const f = fixture(t), id = randomUUID(); f.records.set(id, f.makeRecord(id, f.wire())); await f.adopt(id);
    f.setRoute(call => {
      if (call.url.pathname !== '/v1/sync/push') return;
      const operation = call.body.operations[0];
      return Response.json({ protocolVersion: 1, results: [outcome === 'rejected'
        ? { opId: operation.opId, status: 'rejected', replayed: false, code: 'GRAPH_LIMIT', retryable: false }
        : { opId: operation.opId, status: 'conflict', replayed: false, conflictId: randomUUID(), record: f.makeRecord(id, f.wire({ label: 'Newer server draft' }), 2) }] });
    });
    const expected = outcome === 'rejected' ? 'GRAPH_OPERATION_REJECTED' : 'GRAPH_CONFLICT';
    await assert.rejects(f.manager.deleteRelation({ id: 'account-graph:' + id }), { code: expected });
    assert.equal(f.manager.projection().relations.length, 1); assert.equal(f.manager.projection().relations[0].label, 'Remote supports');
    const saved = f.readState().sync.outbox[0].operation, count = f.calls.length;
    await assert.rejects(f.manager.deleteRelation({ id: 'account-graph:' + id }), { code: expected });
    assert.deepEqual(f.readState().sync.outbox[0].operation, saved); assert.equal(f.calls.length, count); assert.equal(f.manager.status().continuable, 0);
  });
}

test('a rejected account edit remains visible with its accepted content and cannot silently queue a fresh replacement', async t => {
  const f = fixture(t), id = randomUUID(); f.records.set(id, f.makeRecord(id, f.wire())); await f.adopt(id);
  f.setRoute(call => {
    if (call.url.pathname !== '/v1/sync/push') return;
    return Response.json({ protocolVersion: 1, results: [{ opId: call.body.operations[0].opId, status: 'rejected', replayed: false, code: 'GRAPH_LIMIT', retryable: false }] });
  });
  await assert.rejects(f.manager.updateRelation({ id: 'account-graph:' + id, label: 'Rejected draft' }), { code: 'GRAPH_OPERATION_REJECTED' });
  const op = f.readState().sync.outbox[0].operation;
  await assert.rejects(f.manager.updateRelation({ id: 'account-graph:' + id, label: 'Another draft' }), { code: 'GRAPH_OPERATION_REJECTED' });
  assert.deepEqual(f.readState().sync.outbox[0].operation, op); assert.deepEqual(f.readState().sync.overlays, {});
  assert.equal(f.manager.projection().relations[0].label, 'Remote supports');
});

test('editing or deleting an accepted row cannot use a newer unaccepted head as its CAS basis', async t => {
  const f = fixture(t), first = randomUUID(), second = randomUUID();
  f.records.set(first, f.makeRecord(first, f.wire())); await f.adopt(first);
  f.records.set(first, f.makeRecord(first, f.wire({ description: 'Unaccepted remote evidence' }), 2));
  f.records.set(second, f.makeRecord(second, f.wire({ label: 'Second relation' }))); await f.adopt(second);
  assert.equal(f.readState().accepted.find(row => row.entityId === first).revision, 1);
  assert.equal(f.readState().sync.serverRecords['graphRelation:' + first].revision, 2);
  const count = f.calls.length;
  await assert.rejects(f.manager.updateRelation({ id: 'account-graph:' + first, label: 'Edited old view' }), { code: 'GRAPH_PREVIEW_STALE' });
  await assert.rejects(f.manager.deleteRelation({ id: 'account-graph:' + first }), { code: 'GRAPH_PREVIEW_STALE' });
  assert.equal(f.calls.length, count); assert.equal(f.manager.status().pending, 0);
  await f.adopt(first); await f.manager.updateRelation({ id: 'account-graph:' + first, label: 'Reviewed edit' });
  assert.equal(f.records.get(first).data.description, 'Unaccepted remote evidence');
});

test('a later explicit account edit keeps earlier uncertain fields while replaying the first operation unchanged', async t => {
  const f = fixture(t), id = randomUUID(); f.records.set(id, f.makeRecord(id, f.wire())); await f.adopt(id);
  f.setRoute(call => { if (call.method === 'POST') throw Object.assign(Error('Unknown request outcome'), { code: 'NETWORK_ERROR' }); });
  await assert.rejects(f.manager.updateRelation({ id: 'account-graph:' + id, label: 'First explicit edit' }), { code: 'NETWORK_ERROR' });
  const first = f.readState().sync.outbox[0].operation;
  await assert.rejects(f.manager.updateRelation({ id: 'account-graph:' + id, description: 'Second explicit edit' }), { code: 'NETWORK_ERROR' });
  const saved = f.readState(), overlay = saved.sync.overlays['graphRelation:' + id];
  assert.deepEqual(saved.sync.outbox[0].operation, first); assert.equal(overlay.data.label, 'First explicit edit');
  assert.equal(overlay.data.description, 'Second explicit edit'); assert.equal(overlay.data.confidence, null);
  f.setRoute(null); await f.manager.continue();
  assert.equal(f.records.get(id).data.label, 'First explicit edit'); assert.equal(f.records.get(id).data.description, 'Second explicit edit');
});

test('capability loss preserves pending intent and storage recovery does not depend on network capability', async t => {
  const f = fixture(t); f.setRoute(call => { if (call.method === 'POST') throw Object.assign(Error('Network'), { code: 'NETWORK_ERROR' }); });
  await assert.rejects(f.publish(), { code: 'NETWORK_ERROR' }); const pending = f.readState().sync.outbox[0].operation;
  f.manager.setCapability(false); const count = f.calls.length;
  await assert.rejects(f.manager.continue(), { code: 'GRAPH_FEATURE_UNAVAILABLE' }); await f.manager.retrySave();
  assert.equal(f.calls.length, count); assert.deepEqual(f.readState().sync.outbox[0].operation, pending);
  f.manager.setCapability(true); assert.equal(f.calls.length, count); f.setRoute(null); await f.manager.continue();
  assert.equal(f.calls.at(-1).body.operations[0].opId, pending.opId);
});

async function conflictingPublication(f) {
  await f.publish(); const entityId = f.readState().links[0].entityId;
  f.putSource([raw('local-1', { label: 'Later local draft', updatedAt: Date.parse(at) })]);
  const conflictId = randomUUID(); let conflictOnce = true;
  f.setRoute(call => {
    if (call.url.pathname !== '/v1/sync/push' || !conflictOnce) return; conflictOnce = false;
    const operation = call.body.operations[0], current = f.makeRecord(entityId, f.wire({ label: 'Concurrent account draft' }), 2);
    f.records.set(entityId, current);
    f.conflicts.set(conflictId, { conflictId, entityId, entityType: 'graphRelation', createdAt: at,
      attemptedOperation: operation, observedRecord: current, currentRecord: current });
    return Response.json({ protocolVersion: 1, results: [{ opId: operation.opId, status: 'conflict', replayed: false, conflictId, record: current }] });
  });
  const p = await f.manager.preview(); await f.manager.publish({ token: p.token, keys: [p.localRows[0].key] });
  f.setRoute(null); return { conflictId, entityId };
}

test('conflict decisions preserve both drafts and replay the original resolution after an unknown ACK', async t => {
  const f = fixture(t), { conflictId, entityId } = await conflictingPublication(f);
  const p = await f.manager.preview(), shown = p.conflicts[0];
  assert.equal(shown.attempted.data.label, 'Later local draft'); assert.equal(shown.current.data.label, 'Concurrent account draft');
  let lose = true;
  f.setRoute(call => {
    if (!call.url.pathname.endsWith('/resolve') || !lose) return; lose = false;
    const saved = f.readState().pendingResolutions[0]; assert.equal(saved.request.opId, call.body.opId, 'resolution intent is durable before HTTP');
    const record = f.makeRecord(entityId, f.conflicts.get(conflictId).attemptedOperation.data, 3);
    f.records.set(entityId, record); f.receipts.set(call.body.opId, { opId: call.body.opId, status: 'applied', replayed: false, record }); f.conflicts.delete(conflictId);
    throw Object.assign(Error('Lost resolution response'), { code: 'NETWORK_ERROR' });
  });
  await assert.rejects(f.manager.resolve({ conflictId, expectedRevision: 2, choice: 'attempted' }), { code: 'NETWORK_ERROR' });
  const request = f.readState().pendingResolutions[0].request;
  f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus();
  const before = f.calls.length; await f.manager.retrySave(); assert.equal(f.calls.length, before);
  const checked = await f.manager.preview(); assert.equal(checked.pendingResolutions[0].opId, request.opId);
  assert.equal(checked.conflicts.length, 1, 'an absent server conflict must not drop this still-unknown decision');
  await f.manager.continue(); assert.equal(f.readState().pendingResolutions.length, 0); assert.equal(f.manager.status().conflicts, 0);
  const sent = f.calls.filter(call => call.url.pathname.endsWith('/resolve')).map(call => call.body);
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]); assert.equal(sent[0].opId, request.opId);
  assert.equal(f.readState().sync.serverRecords['graphRelation:' + entityId].data.label, 'Later local draft');
});

test('a terminal resolution receipt stays reviewable and a new explicit decision uses the new revision', async t => {
  const f = fixture(t), { conflictId, entityId } = await conflictingPublication(f); let rejectOnce = true;
  f.setRoute(call => {
    if (!call.url.pathname.endsWith('/resolve') || !rejectOnce) return; rejectOnce = false;
    const record = f.makeRecord(entityId, f.wire({ label: 'Newest concurrent draft' }), 3); f.records.set(entityId, record);
    f.conflicts.get(conflictId).currentRecord = record;
    return Response.json({ opId: call.body.opId, status: 'conflict', replayed: false, conflictId, record });
  });
  await f.manager.resolve({ conflictId, expectedRevision: 2, choice: 'attempted' });
  assert.equal(f.readState().pendingResolutions[0].lastResult.status, 'conflict'); assert.equal(f.manager.status().continuable, 0);
  const before = f.calls.length; await f.manager.continue(); assert.equal(f.calls.length, before);
  const p = await f.manager.preview(); assert.equal(p.conflicts[0].expectedRevision, 3);
  await f.manager.resolve({ conflictId, expectedRevision: 3, choice: 'current' });
  const requests = f.calls.filter(call => call.url.pathname.endsWith('/resolve')).map(call => call.body);
  assert.equal(requests.length, 2); assert.notEqual(requests[0].opId, requests[1].opId); assert.equal(requests[1].expectedRevision, 3);
  assert.equal(f.manager.status().conflicts, 0); assert.equal(f.readState().pendingResolutions.length, 0);
});

test('a complete conflict check reconciles a decision made elsewhere without sending a new write', async t => {
  const f = fixture(t), { entityId } = await conflictingPublication(f);
  f.conflicts.clear(); f.records.set(entityId, f.makeRecord(entityId, f.wire({ label: 'Explicit remote resolution' }), 3));
  const requests = f.calls.filter(call => call.method === 'POST').length, p = await f.manager.preview();
  assert.equal(p.conflicts.length, 0); assert.equal(p.pendingRows.length, 0);
  await f.manager.adopt({ token: p.token, ids: [entityId] });
  assert.equal(f.manager.status().conflicts, 0); assert.equal(f.manager.status().pending, 0);
  assert.equal(f.manager.projection().relations[0].label, 'Explicit remote resolution');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, requests);
  assert.equal(JSON.parse(fs.readFileSync(f.sourceFile, 'utf8')).relations[0].label, 'Later local draft');
});

test('conflict review displays the newest observed body and its exact decision revision', async t => {
  const f = fixture(t), { entityId, conflictId } = await conflictingPublication(f);
  const latest = f.makeRecord(entityId, f.wire({ label: 'Head changed between reads' }), 3);
  f.conflicts.get(conflictId).currentRecord = latest;
  let p = await f.manager.preview(); assert.equal(p.conflicts[0].expectedRevision, 3); assert.equal(p.conflicts[0].current.data.label, latest.data.label);
  f.records.set(entityId, f.makeRecord(entityId, f.wire({ label: 'Pull has newer head' }), 4));
  p = await f.manager.preview(); assert.equal(p.conflicts[0].expectedRevision, 4); assert.equal(p.conflicts[0].current.data.label, 'Pull has newer head');
});

test('externally changed private bytes are preserved and the unsaved candidate remains exportable', async t => {
  const f = fixture(t); await f.publish();
  f.putSource([raw('local-1', { label: 'Explicit newer draft', updatedAt: Date.parse(at) })]);
  const p = await f.manager.preview(), file = f.privateFiles()[0], external = f.readState(); external.revision += 10;
  const externalBytes = Buffer.from(JSON.stringify(external)); fs.writeFileSync(file, externalBytes); const calls = f.calls.length;
  await assert.rejects(f.manager.publish({ token: p.token, keys: [p.localRows[0].key] }), { code: 'GRAPH_STORAGE_CHANGED' });
  assert.deepEqual(fs.readFileSync(file), externalBytes); assert.equal(f.calls.length, calls);
  const backup = await f.manager.backup(); assert.equal(backup.unconfirmedState.sync.outbox[0].operation.data.label, 'Explicit newer draft');
  await assert.rejects(f.manager.retrySave(), { code: 'GRAPH_STORAGE_CHANGED' }); assert.deepEqual(fs.readFileSync(file), externalBytes); assert.equal(f.calls.length, calls);
});

test('stopping an in-flight preview prevents staging and does not publish or save it', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  f.setRoute(async call => {
    if (call.url.pathname !== '/v1/sync/pull') return; entered.resolve(); await release.promise;
    return Response.json({ protocolVersion: 1, records: [], nextCursor: 'checked', hasMore: false });
  });
  const checking = f.manager.preview(); await entered.promise; const stopping = f.manager.stop(); release.resolve();
  await assert.rejects(checking, { code: 'DESKTOP_OPERATION_CANCELLED' }); await stopping;
  assert.equal(f.calls.length, 1); assert.deepEqual(f.privateFiles(), []); assert.deepEqual(fs.readFileSync(f.sourceFile), f.source);
});
