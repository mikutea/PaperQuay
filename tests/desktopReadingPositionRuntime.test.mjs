import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as core from '../packages/sync-core/src/index.ts';
const require = createRequire(import.meta.url);
const nativeFs = require('../electron/backend/nativeFs.cjs');
const { createDesktopReadingPosition } = require('../electron/backend/desktopReadingPosition.cjs');
const at = '2026-11-04T12:00:00.000Z';
const config = { apiBaseUrl: 'https://sync.example.test', oidcIssuer: 'https://login.example.test', oidcClientId: 'desktop' };
const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fail = code => { throw Object.assign(new Error(code), { code }); };
const point = (pageIndex = 1, furthestPageIndex = pageIndex, observedAt = at) => ({ pageIndex, offsetRatio: .2, furthestPageIndex, furthestOffsetRatio: .7, observedAt });
const posts = f => f.calls.filter(row => row.method === 'POST');

// All HTTP routes are injected pure-process functions. Native private ledger files
// and attachment bytes live only beneath this test's checked temporary directory.
// This is not a PDFJS/rendered Reader or real-service acceptance fixture.
function fixture(t, limits = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-reading-position-'));
  const context = { appPaths: { configPath: path.join(temp, 'profile', 'config.json') } };
  const attachment = path.join(temp, 'source.pdf'), bytes = Buffer.from('%PDF-1.7\nSynthetic injected reading-source proof\n%%EOF\n');
  nativeFs.writeSync(attachment, bytes, { mode: 0o600 });
  let snapshot = { config, account: { accountId: randomUUID(), deviceId: randomUUID() }, epoch: 1, library: { libraryBindingId: randomUUID() } };
  const source = { bindingId: randomUUID(), localPaperId: 'native-paper', localAttachmentId: 'native-pdf', paperId: randomUUID(), attachmentVersionId: randomUUID(),
    sha256: hash(bytes), sizeBytes: bytes.length, pageCount: 12, title: 'Synthetic document', fileName: 'source.pdf' };
  let bindings = [binding(source)], route = null, verifier = null, writer = null, manager, lockHeld = true, notifications = 0;
  const calls = [], proofs = [], writes = [], managers = [], accounts = new Map();
  function binding(value) { const { pageCount: _count, ...row } = value; return row; }
  function store(owner = snapshot) {
    const key = owner.account.accountId;
    if (!accounts.has(key)) accounts.set(key, { records: new Map(), events: [], receipts: new Map(), conflicts: new Map(), identities: new Map() });
    return accounts.get(key);
  }
  function scope(owner = snapshot) { return { serviceKey: hash(JSON.stringify([owner.config.apiBaseUrl, owner.config.oidcIssuer, owner.config.oidcClientId])),
    accountId: owner.account.accountId, libraryBindingId: owner.library.libraryBindingId }; }
  const file = (owner = snapshot) => path.join(temp, 'profile', 'account-sync', 'reading-positions', hash(core.canonicalJson(scope(owner))) + '.json');
  const files = () => { const root = path.join(temp, 'profile', 'account-sync', 'reading-positions'); return fs.existsSync(root) ? fs.readdirSync(root).filter(name => name.endsWith('.json')).map(name => path.join(root, name)) : []; };
  const read = (owner = snapshot) => JSON.parse(nativeFs.readSync(file(owner), { maxBytes: core.DESKTOP_READING_LIMITS.privateBytes, singleLink: true }).bytes.toString());
  const capture = (pageIndex = 2, offsetRatio = .3, observedAt = at, proof = source) => ({ bindingId: proof.bindingId, sha256: proof.sha256,
    sizeBytes: proof.sizeBytes, pageCount: proof.pageCount, pageIndex, offsetRatio, observedAt });
  const data = (pageIndex = 2, furthestPageIndex = pageIndex, sequence = 1, proof = source) => ({ paperId: proof.paperId, attachmentVersionId: proof.attachmentVersionId,
    pageIndex, offsetRatio: .3, furthestPageIndex, furthestOffsetRatio: .6, sessionId: randomUUID(), deviceSequence: sequence, observedAt: at });
  const record = (entityId = randomUUID(), value = data(), revision = 1, deviceId = snapshot.account.deviceId) => ({ entityType: 'readingPosition', entityId,
    schemaVersion: 1, revision, deletedAt: value === null ? at : null, updatedAt: at, modifiedByDeviceId: deviceId, data: value });
  function put(row, owner = snapshot) { const current = store(owner); current.records.set(row.entityId, structuredClone(row)); current.events.push(structuredClone(row));
    if (row.data) current.identities.set(row.entityId, { deviceId: row.modifiedByDeviceId, paperId: row.data.paperId, versionId: row.data.attachmentVersionId }); return row; }
  function mutation(owner, op) {
    const state = store(owner), previous = state.records.get(op.entityId), identity = state.identities.get(op.entityId);
    const reject = code => ({ opId: op.opId, status: 'rejected', replayed: false, code, retryable: false });
    if (previous && previous.modifiedByDeviceId !== owner.account.deviceId) return reject('READING_DEVICE_MISMATCH');
    if (!previous && [...state.identities.values()].some(row => row.deviceId === owner.account.deviceId && row.versionId === op.data.attachmentVersionId)) return reject('CHECKPOINT_ALREADY_EXISTS');
    if (op.baseRevision !== (previous?.revision || 0)) {
      const conflictId = randomUUID(), result = { opId: op.opId, status: 'conflict', replayed: false, conflictId, record: previous || null };
      state.conflicts.set(conflictId, { conflictId, entityId: op.entityId, entityType: 'readingPosition', createdAt: at, attemptedOperation: structuredClone(op), observedRecord: previous || null, currentRecord: previous || null }); return result;
    }
    if (previous?.deletedAt !== null && previous && op.mutation !== 'restore') return reject('RESTORE_REQUIRED');
    if (identity && (identity.versionId !== op.data.attachmentVersionId || identity.paperId !== op.data.paperId)) return reject('READING_IDENTITY_IMMUTABLE');
    if (previous?.data && (op.data.deviceSequence <= previous.data.deviceSequence || op.data.furthestPageIndex < previous.data.furthestPageIndex
      || op.data.furthestPageIndex === previous.data.furthestPageIndex && op.data.furthestOffsetRatio < previous.data.furthestOffsetRatio)) return reject('READING_POSITION_REGRESSION');
    return { opId: op.opId, status: 'applied', replayed: false, record: put(record(op.entityId, op.data, (previous?.revision || 0) + 1, owner.account.deviceId), owner) };
  }
  async function serve(owner, input) {
    const state = store(owner), url = new URL(input.path, config.apiBaseUrl);
    if (url.pathname === '/v1/sync/pull') {
      assert.equal(url.searchParams.get('limit'), '1'); const start = Number(url.searchParams.get('cursor') || '0'), rows = state.events.slice(start, start + 1);
      return { protocolVersion: 1, records: structuredClone(rows), nextCursor: String(start + rows.length), hasMore: start + rows.length < state.events.length };
    }
    if (url.pathname === '/v1/conflicts') {
      const start = Number(url.searchParams.get('cursor') || '0'), all = [...state.conflicts.values()], rows = all.slice(start, start + 1);
      return { conflicts: structuredClone(rows), nextCursor: String(start + rows.length), hasMore: start + rows.length < all.length };
    }
    if (url.pathname === '/v1/devices') return { devices: [...new Set([owner.account.deviceId, ...[...state.records.values()].map(row => row.modifiedByDeviceId)])].map((id, index) => ({
      id, name: index ? 'Other actual device' : 'Current actual device', platform: 'windows', createdAt: at, lastSeenAt: at, revokedAt: null,
    })) };
    if (url.pathname === '/v1/sync/push') {
      assert.equal(input.body.deviceId, owner.account.deviceId); assert.equal(input.body.operations.length, 1); const op = input.body.operations[0];
      assert.ok(core.validateOperation(op).ok); const durable = read(owner), pending = durable.sync.outbox.find(row => row.operation.opId === op.opId);
      assert.equal(pending.status, 'sending'); assert.deepEqual(pending.operation, op); assert.equal(pending.originDeviceId, owner.account.deviceId);
      assert.ok(durable.intents.some(row => row.opId === op.opId && row.capture.pageIndex === op.data.pageIndex && row.capture.observedAt === op.data.observedAt));
      const prior = state.receipts.get(op.opId);
      if (prior) { assert.equal(prior.hash, core.canonicalJson(op)); return { protocolVersion: 1, results: [{ ...prior.result, replayed: true }] }; }
      const result = mutation(owner, op); state.receipts.set(op.opId, { hash: core.canonicalJson(op), result: structuredClone(result) });
      return { protocolVersion: 1, results: [result] };
    }
    if (/^\/v1\/conflicts\/[^/]+\/resolve$/.test(url.pathname)) {
      const conflictId = url.pathname.split('/')[3], request = input.body, prior = state.receipts.get(request.opId);
      assert.deepEqual(read(owner).pendingResolutions.find(row => row.conflictId === conflictId).request, request);
      if (prior) { assert.equal(prior.hash, core.canonicalJson(request)); return { ...prior.result, replayed: true }; }
      const conflict = state.conflicts.get(conflictId), current = conflict && state.records.get(conflict.entityId); let result;
      if (!conflict) result = { opId: request.opId, status: 'rejected', code: 'CONFLICT_ALREADY_RESOLVED', retryable: false, replayed: false };
      else if (current.revision !== request.expectedRevision) result = { opId: request.opId, status: 'conflict', replayed: false, conflictId, record: current };
      else if (request.choice === 'current') result = { opId: request.opId, status: 'applied', replayed: false, record: current };
      else result = mutation(owner, { ...conflict.attemptedOperation, opId: request.opId, baseRevision: request.expectedRevision });
      if (result.status === 'applied') state.conflicts.delete(conflictId);
      state.receipts.set(request.opId, { hash: core.canonicalJson(request), result: structuredClone(result) }); return structuredClone(result);
    }
    throw Error('Unexpected injected fixed route: ' + input.path);
  }
  function create() {
    manager = createDesktopReadingPosition(context, { core: { ...core, DESKTOP_READING_LIMITS: { ...core.DESKTOP_READING_LIMITS, ...limits } }, now: () => Date.parse(at),
      getContext: () => structuredClone(snapshot), checkContext(owner) {
        if (!lockHeld) fail('ACCOUNT_STATE_IN_USE');
        if (core.canonicalJson(owner) !== core.canonicalJson(snapshot)) fail('DESKTOP_OPERATION_CANCELLED');
      }, getBindings: () => structuredClone(bindings), onChange() { notifications++; },
      fs: { ...nativeFs, writeSync(filePath, value, options) { const saved = JSON.parse(Buffer.from(value).toString()); writes.push({ file: filePath, state: saved });
        return writer ? writer(filePath, value, options) : nativeFs.writeSync(filePath, value, options); } },
      async verifySource(owner, actual, signal) {
        proofs.push(structuredClone(actual)); if (verifier) { const result = await verifier(owner, actual, signal); if (result !== undefined) return result; }
        const row = bindings.find(row => row.bindingId === actual.bindingId), readBytes = nativeFs.readSync(attachment, { maxBytes: core.DESKTOP_READING_LIMITS.pdfBytes, singleLink: true }).bytes;
        if (!row || hash(readBytes) !== actual.sha256 || readBytes.length !== actual.sizeBytes) fail('READING_SOURCE_CHANGED');
        return { ...row, pageCount: actual.pageCount };
      }, async api(owner, input) {
        calls.push(structuredClone({ accountId: owner.account.accountId, deviceId: owner.account.deviceId, path: input.path, method: input.method || 'GET', body: input.body }));
        if (route) { const result = await route(owner, input); if (result !== undefined) return result; } return serve(owner, input);
      } });
    managers.push(manager); manager.setCapability(true); return manager;
  }
  create();
  t.after(async () => {
    for (const owned of managers) owned.close(); await Promise.all(managers.map(owned => owned.settled()));
    const resolved = path.resolve(temp); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('paperquay-reading-position-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { context, source, attachment, bytes, calls, proofs, writes, binding, file, files, read, capture, data, record, put, store, serve, create,
    get manager() { return manager; }, get snapshot() { return structuredClone(snapshot); }, get bindings() { return structuredClone(bindings); }, get notifications() { return notifications; },
    setBindings(value) { bindings = structuredClone(value); }, setSnapshot(value) { snapshot = structuredClone(value); }, setRoute(value) { route = value; },
    setVerifier(value) { verifier = value; }, setWriter(value) { writer = value; }, setLock(value) { lockHeld = value; } };
}

test('status and local exact-version choice read no PDF or API, while preview performs explicit read-only proof', async t => {
  const f = fixture(t); assert.equal(f.manager.status().tracking, null); await f.manager.refreshStatus();
  const list = await f.manager.versions({ localPaperId: f.source.localPaperId, sha256: f.source.sha256, sizeBytes: f.source.sizeBytes, pageCount: 12 });
  assert.equal(list.versions.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.proofs.length, 0); assert.deepEqual(f.files(), []);
  const other = { ...f.source, bindingId: randomUUID(), attachmentVersionId: randomUUID() }; f.setBindings([...f.bindings, f.binding(other)]);
  assert.equal((await f.manager.versions({ localPaperId: f.source.localPaperId, sha256: f.source.sha256, sizeBytes: f.source.sizeBytes, pageCount: 12 })).versions.length, 2);
  const remote = f.put(f.record(undefined, f.data(1, 9), 1, randomUUID()));
  const preview = await f.manager.preview({ capture: f.capture() });
  assert.equal(preview.publicationAction, 'create'); assert.equal(preview.localDraft, null); assert.equal(preview.positions[0].entityId, remote.entityId);
  assert.equal(preview.positions[0].data.pageIndex, 1); assert.equal(preview.positions[0].data.furthestPageIndex, 9); assert.equal(preview.positions[0].deviceName, 'Other actual device');
  assert.equal(f.proofs.length, 2); assert.equal(posts(f).length, 0); assert.deepEqual(f.files(), []);
});

test('publication stages exact identity before sending and backward recent never reduces own furthest', async t => {
  const f = fixture(t), first = await f.manager.preview({ capture: f.capture(8, .8) }); await f.manager.publish({ token: first.token });
  const operation = posts(f)[0].body.operations[0], saved = f.read(); assert.equal(saved.sync.outbox.length, 0); assert.equal(saved.intents.length, 0);
  assert.equal(operation.data.pageIndex, 8); assert.equal(operation.data.furthestPageIndex, 8); assert.equal(operation.data.deviceSequence, 1);
  const second = await f.manager.preview({ capture: f.capture(1, .1) }); assert.equal(second.publicationAction, 'update');
  await f.manager.publish({ token: second.token }); const next = posts(f)[1].body.operations[0];
  assert.equal(next.entityId, operation.entityId); assert.equal(next.data.pageIndex, 1); assert.equal(next.data.furthestPageIndex, 8); assert.equal(next.data.furthestOffsetRatio, .8);
  assert.equal(next.data.deviceSequence, 2); assert.equal(next.baseRevision, 1); assert.notEqual(next.opId, operation.opId);
  assert.ok(!JSON.stringify(next).includes('native-paper')); assert.ok(!JSON.stringify(next).includes('source.pdf'));
});

test('tracking requires explicit checked start; local event writes preserve draft furthest with zero network or full-source rereads', async t => {
  const f = fixture(t), preview = await f.manager.preview({ capture: f.capture(3, .4) });
  const started = await f.manager.startTracking({ token: preview.token }), apiCount = f.calls.length, proofCount = f.proofs.length;
  assert.equal(started.capture.pageIndex, 3); assert.equal(f.read().drafts[0].sessionId.length, 36); assert.equal(posts(f).length, 0);
  assert.deepEqual(f.manager.status().tracking, { trackingId: started.trackingId, bindingId: f.source.bindingId, attachmentVersionId: f.source.attachmentVersionId });
  await f.manager.recordTracked({ trackingId: started.trackingId, sequence: 1, point: point(4, 10) });
  await f.manager.recordTracked({ trackingId: started.trackingId, sequence: 2, point: point(0, 0, '2026-11-04T11:00:00.000Z') });
  assert.equal(f.read().drafts[0].capture.pageIndex, 0); assert.equal(f.read().drafts[0].furthestPageIndex, 10);
  assert.equal(f.read().drafts[0].capture.observedAt, '2026-11-04T11:00:00.000Z'); assert.equal(f.calls.length, apiCount); assert.equal(f.proofs.length, proofCount);
  const writes = f.writes.length; await f.manager.recordTracked({ trackingId: started.trackingId, sequence: 2, point: point(0, 0, '2026-11-04T11:00:00.000Z') });
  assert.equal(f.writes.length, writes, 'exact duplicate is idempotent after durable acceptance');
  await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'READING_PREVIEW_STALE' });
  const fresh = await f.manager.preview({ capture: f.capture(1, .1) }); assert.equal(fresh.localDraft.furthestPageIndex, 10);
  await f.manager.publish({ token: fresh.token }); assert.equal(posts(f)[0].body.operations[0].data.pageIndex, 1);
  assert.equal(posts(f)[0].body.operations[0].data.furthestPageIndex, 10);
});

test('session stop IDs cannot end a newer tracking session and restart never re-enables it', async t => {
  const f = fixture(t), preview = await f.manager.preview({ capture: f.capture() }), one = await f.manager.startTracking({ token: preview.token });
  const secondPreview = await f.manager.preview({ capture: f.capture(4) });
  await assert.rejects(f.manager.startTracking({ token: secondPreview.token }), { code: 'READING_TRACKING_ACTIVE' });
  const firstSessionId = f.read().drafts[0].sessionId;
  assert.equal(f.manager.status().tracking.trackingId, one.trackingId); await f.manager.stop(); assert.equal(f.manager.status().tracking.trackingId, one.trackingId, 'wait-stop is separate from local-session stop');
  await f.manager.stopTracking({ trackingId: one.trackingId }); const nextPreview = await f.manager.preview({ capture: f.capture(4) });
  const two = await f.manager.startTracking({ token: nextPreview.token }); await f.manager.stopTracking({ trackingId: one.trackingId });
  assert.equal(f.manager.status().tracking.trackingId, two.trackingId); assert.notEqual(f.read().drafts[0].sessionId, firstSessionId);
  f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus(); assert.equal(f.manager.status().tracking, null); assert.equal(f.read().drafts.length, 1);
});

test('invalid tracked sequence, geometry and source binding stop only the matching session', async t => {
  const f = fixture(t), start = async () => f.manager.startTracking({ token: (await f.manager.preview({ capture: f.capture() })).token });
  let tracking = await start();
  await assert.rejects(f.manager.recordTracked({ trackingId: tracking.trackingId, sequence: 2, point: point() }), { code: 'READING_TRACKING_SEQUENCE' });
  assert.equal(f.manager.status().tracking, null); const before = f.read().drafts[0];
  tracking = await start(); await f.manager.recordTracked({ trackingId: tracking.trackingId, sequence: 1, point: point() });
  await assert.rejects(f.manager.recordTracked({ trackingId: tracking.trackingId, sequence: 1, point: point(2) }), { code: 'READING_TRACKING_SEQUENCE' });
  assert.equal(f.manager.status().tracking, null); assert.equal(f.read().drafts[0].capture.pageIndex, 1);
  tracking = await start(); await assert.rejects(f.manager.recordTracked({ trackingId: randomUUID(), sequence: 1, point: point() }), { code: 'READING_TRACKING_CHANGED' });
  assert.equal(f.manager.status().tracking.trackingId, tracking.trackingId);
  await assert.rejects(f.manager.recordTracked({ trackingId: tracking.trackingId, sequence: 1, point: { ...point(), pageIndex: 12 } })); assert.equal(f.manager.status().tracking, null);
  tracking = await start(); const calls = f.calls.length, proofs = f.proofs.length, draft = f.read().drafts[0]; f.setBindings([]);
  await assert.rejects(f.manager.recordTracked({ trackingId: tracking.trackingId, sequence: 1, point: point(6) }), { code: 'READING_BINDING_CHANGED' });
  assert.equal(f.manager.status().tracking, null); assert.deepEqual(f.read().drafts[0], draft); assert.equal(f.calls.length, calls); assert.equal(f.proofs.length, proofs); assert.equal(before.capture.pageIndex, 2);
});

test('a tracking save failure retains the actual new point for save-only recovery and ends the live session', async t => {
  const f = fixture(t), preview = await f.manager.preview({ capture: f.capture() }), started = await f.manager.startTracking({ token: preview.token });
  const last = f.read(), calls = f.calls.length; f.setWriter(() => fail('EIO'));
  await assert.rejects(f.manager.recordTracked({ trackingId: started.trackingId, sequence: 1, point: point(4, 11) }), { code: 'READING_SAVE_UNCONFIRMED' });
  assert.equal(f.manager.status().tracking, null); assert.equal(f.manager.status().saveUnconfirmed, true); assert.deepEqual(f.read(), last);
  const backup = await f.manager.backup(); assert.equal(backup.state.drafts[0].capture.pageIndex, 2); assert.equal(backup.unconfirmedState.drafts[0].capture.pageIndex, 4);
  assert.equal(backup.unconfirmedState.drafts[0].furthestPageIndex, 11); f.setWriter(null); await f.manager.retrySave();
  assert.equal(f.read().drafts[0].capture.pageIndex, 4); assert.equal(f.manager.status().saveUnconfirmed, false); assert.equal(f.manager.status().tracking, null); assert.equal(f.calls.length, calls);
  await assert.rejects(f.manager.recordTracked({ trackingId: started.trackingId, sequence: 1, point: point(4, 11) }), { code: 'READING_TRACKING_CHANGED' });
});

test('unknown push survives restart with the original op/entity/session/payload and independent later local drafts', async t => {
  const f = fixture(t); let lost = true;
  f.setRoute(async (owner, input) => { if (input.path === '/v1/sync/push' && lost) { lost = false; await f.serve(owner, input); fail('NETWORK_ERROR'); } });
  const preview = await f.manager.preview({ capture: f.capture(4, .5) }); await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'NETWORK_ERROR' });
  const original = f.read().sync.outbox[0].operation; assert.equal(f.read().sync.outbox[0].status, 'uncertain');
  const localPreview = await f.manager.preview({ capture: f.capture(0) }); assert.equal(localPreview.publicationAction, 'blocked');
  const session = await f.manager.startTracking({ token: localPreview.token }); await f.manager.recordTracked({ trackingId: session.trackingId, sequence: 1, point: point(1, 10) });
  assert.deepEqual(f.read().sync.outbox[0].operation, original); assert.equal(f.read().drafts[0].furthestPageIndex, 10);
  f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus(); assert.equal(posts(f).length, 1); assert.equal(f.manager.status().tracking, null);
  await f.manager.continue(); assert.equal(posts(f).length, 2); assert.deepEqual(posts(f)[1].body.operations[0], original);
  assert.equal(f.read().sync.outbox.length, 0); assert.equal(f.read().drafts[0].furthestPageIndex, 10);
});

test('a staged but unsaved original is never sent until explicit save and continue', async t => {
  const f = fixture(t), preview = await f.manager.preview({ capture: f.capture() }); f.setWriter(() => fail('EIO'));
  await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'READING_SAVE_UNCONFIRMED' }); assert.equal(posts(f).length, 0);
  const pending = (await f.manager.backup()).unconfirmedState.sync.outbox[0].operation; f.setWriter(null); await f.manager.retrySave(); assert.equal(posts(f).length, 0);
  await f.manager.continue(); assert.deepEqual(posts(f)[0].body.operations[0], pending);
});

test('receipt save-only recovery never publishes a second request, including an already-written uncertain save', async t => {
  for (const afterWrite of [false, true]) {
    const f = fixture(t), preview = await f.manager.preview({ capture: f.capture() }); let failed = false;
    f.setWriter((file, bytes, options) => { const state = JSON.parse(Buffer.from(bytes).toString());
      if (!failed && state.checkpoints.length && !state.sync.outbox.length) { failed = true; if (afterWrite) nativeFs.writeSync(file, bytes, options); fail('EIO'); }
      return nativeFs.writeSync(file, bytes, options); });
    await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'READING_SAVE_UNCONFIRMED' }); assert.equal(posts(f).length, 1);
    const backup = await f.manager.backup(); assert.equal(backup.unconfirmedState.sync.outbox.length, 0); assert.equal(backup.state.sync.outbox[0].status, 'sending');
    const calls = f.calls.length, writes = f.writes.length; f.setWriter(null); await f.manager.retrySave();
    assert.equal(f.manager.status().saveUnconfirmed, false); assert.equal(f.calls.length, calls); assert.equal(posts(f).length, 1); assert.equal(f.read().sync.outbox.length, 0);
    assert.equal(f.writes.length, writes + (afterWrite ? 0 : 1));
  }
});

test('late receipt survives capability loss and A-B-A without publishing or tracking automatically', async t => {
  const f = fixture(t), entered = deferred(), release = deferred(), ownerA = f.snapshot;
  f.setRoute(async (owner, input) => { if (input.path === '/v1/sync/push') { const result = await f.serve(owner, input); entered.resolve(); await release.promise; return result; } });
  const preview = await f.manager.preview({ capture: f.capture() }), send = f.manager.publish({ token: preview.token }); await entered.promise;
  f.manager.setCapability(false); f.manager.invalidate(); f.setSnapshot({ ...ownerA, account: { accountId: randomUUID(), deviceId: randomUUID() }, epoch: 2 }); f.manager.setCapability(true);
  release.resolve(); await assert.rejects(send, { code: 'DESKTOP_OPERATION_CANCELLED' });
  await f.manager.refreshStatus(); assert.equal(f.manager.status().pending, 0); assert.equal(f.manager.status().tracking, null); assert.equal(f.read(ownerA).sync.outbox.length, 0);
  f.manager.invalidate(); f.setSnapshot({ ...ownerA, epoch: 3 }); f.manager.setCapability(true); await f.manager.refreshStatus();
  assert.equal(f.manager.status().pending, 0); assert.equal(f.manager.status().tracking, null); assert.equal(posts(f).length, 1);
});

test('a retained old-device receipt is saved before rebind, then new-device tracking and publication stay usable', async t => {
  const f = fixture(t), ownerA = f.snapshot, entered = deferred(), release = deferred(); let failReceipt = true;
  f.setWriter((file, bytes, options) => { const state = JSON.parse(Buffer.from(bytes).toString()); if (failReceipt && state.checkpoints.length && !state.sync.outbox.length) fail('EIO'); return nativeFs.writeSync(file, bytes, options); });
  f.setRoute(async (owner, input) => { if (input.path === '/v1/sync/push' && posts(f).length === 1) { const result = await f.serve(owner, input); entered.resolve(); await release.promise; return result; } });
  const preview = await f.manager.preview({ capture: f.capture() }), sending = f.manager.publish({ token: preview.token }); await entered.promise;
  const nextDevice = { ...ownerA, account: { ...ownerA.account, deviceId: randomUUID() }, epoch: 2 }; f.manager.invalidate(); f.setSnapshot(nextDevice); f.manager.setCapability(true);
  release.resolve(); await assert.rejects(sending, { code: 'READING_SAVE_UNCONFIRMED' }); await f.manager.refreshStatus();
  assert.equal(f.manager.status().saveUnconfirmed, true); failReceipt = false; const startWrites = f.writes.length; await f.manager.retrySave();
  assert.equal(f.writes[startWrites].state.sync.deviceId, ownerA.account.deviceId, 'original receipt saved before any new-device rebind');
  const current = await f.manager.preview({ capture: f.capture(1) }); assert.equal(current.publicationAction, 'create');
  const tracked = await f.manager.startTracking({ token: current.token }); assert.equal(tracked.status.errorCode, null);
  const publication = await f.manager.preview({ capture: f.capture(1) }); await f.manager.publish({ token: publication.token });
  assert.equal(posts(f).length, 2); assert.equal(posts(f)[1].deviceId, nextDevice.account.deviceId); assert.notEqual(posts(f)[1].body.operations[0].entityId, posts(f)[0].body.operations[0].entityId);
});

test('old-origin unknown operation becomes device-blocked without blocking new-device work or losing old drafts', async t => {
  const f = fixture(t), ownerA = f.snapshot;
  f.setRoute(async (owner, input) => { if (input.path === '/v1/sync/push' && posts(f).length === 1) { await f.serve(owner, input); fail('NETWORK_ERROR'); } });
  const oldPreview = await f.manager.preview({ capture: f.capture(4) }); await assert.rejects(f.manager.publish({ token: oldPreview.token })); const original = f.read().sync.outbox[0].operation;
  const oldLocal = await f.manager.preview({ capture: f.capture(6) }); await f.manager.startTracking({ token: oldLocal.token });
  const deviceB = { ...ownerA, account: { ...ownerA.account, deviceId: randomUUID() }, epoch: 2 }; f.manager.invalidate(); f.setSnapshot(deviceB); f.manager.setCapability(true); await f.manager.refreshStatus();
  const current = await f.manager.preview({ capture: f.capture(0) }); assert.equal(current.publicationAction, 'create'); assert.equal(current.localDraft, null);
  assert.equal(current.pendingRows[0].stage, 'device-blocked'); assert.equal(f.manager.status().errorCode, null);
  const track = await f.manager.startTracking({ token: current.token }); assert.equal(track.status.errorCode, null);
  const ready = await f.manager.preview({ capture: f.capture(0) }); await f.manager.publish({ token: ready.token });
  assert.equal(f.read().drafts.length, 2); assert.deepEqual(f.read().sync.outbox[0].operation, original); assert.equal(f.read().sync.outbox[0].originDeviceId, ownerA.account.deviceId);
  assert.equal(f.manager.status().errorCode, null); assert.equal(posts(f).length, 2);
  f.manager.invalidate(); f.setSnapshot({ ...ownerA, epoch: 3 }); f.manager.setCapability(true); await f.manager.refreshStatus(); await f.manager.continue();
  assert.deepEqual(posts(f)[2].body.operations[0], original); assert.equal(f.read().sync.outbox.length, 0);
});

test('resume returns the exact selected recent point without writes, and rejects a fresh changed or deleted head', async t => {
  const f = fixture(t), row = f.put(f.record(undefined, f.data(1, 9), 1, randomUUID())), preview = await f.manager.preview({ capture: f.capture() });
  const selected = { token: preview.token, entityId: row.entityId, expectedRevision: 1 }, result = await f.manager.resume(selected);
  assert.equal(result.position.pageIndex, 1); assert.equal(result.position.furthestPageIndex, 9); assert.equal(result.origin.deviceId, row.modifiedByDeviceId); assert.equal(posts(f).length, 0); assert.deepEqual(f.files(), []);
  f.put(f.record(row.entityId, f.data(0, 9, 2), 2, row.modifiedByDeviceId)); await assert.rejects(f.manager.resume(selected), { code: 'READING_PREVIEW_STALE' });
  const next = await f.manager.preview({ capture: f.capture() }); f.put(f.record(row.entityId, null, 3, row.modifiedByDeviceId));
  await assert.rejects(f.manager.resume({ token: next.token, entityId: row.entityId, expectedRevision: 2 }), { code: 'READING_PREVIEW_STALE' }); assert.deepEqual(f.files(), []);
});

test('source identity tolerates presentation drift but refuses native bytes/binding races before and after awaits', async t => {
  const f = fixture(t); f.setVerifier(async (_owner, actual) => ({ ...f.bindings[0], pageCount: actual.pageCount, title: 'Fresh display title', fileName: 'fresh-name.pdf' }));
  const preview = await f.manager.preview({ capture: f.capture() }); assert.equal(preview.source.title, 'Fresh display title'); f.setBindings([{ ...f.bindings[0], title: 'Later binding title', fileName: 'later-name.pdf' }]);
  const tracking = await f.manager.startTracking({ token: preview.token }); await f.manager.recordTracked({ trackingId: tracking.trackingId, sequence: 1, point: point() });
  await f.manager.stopTracking({ trackingId: tracking.trackingId }); const next = await f.manager.preview({ capture: f.capture() });
  f.setBindings([{ ...f.bindings[0], localAttachmentId: 'replacement-pdf' }]); await assert.rejects(f.manager.publish({ token: next.token }), { code: 'READING_BINDING_CHANGED' }); assert.equal(posts(f).length, 0);
  const race = fixture(t), entered = deferred(), release = deferred(); race.setVerifier(async (_owner, actual) => { const original = { ...race.bindings[0], pageCount: actual.pageCount }; entered.resolve(); await release.promise; return original; });
  const checking = race.manager.preview({ capture: race.capture() }); await entered.promise; race.setBindings([{ ...race.bindings[0], sha256: 'f'.repeat(64) }]); release.resolve();
  await assert.rejects(checking, { code: 'READING_BINDING_CHANGED' }); assert.equal(race.calls.length, 0); assert.deepEqual(race.files(), []);
  const changed = fixture(t); nativeFs.writeSync(changed.attachment, Buffer.from('changed complete bytes'), { mode: 0o600 });
  await assert.rejects(changed.manager.preview({ capture: changed.capture() }), { code: 'READING_SOURCE_CHANGED' }); assert.equal(changed.calls.length, 0);
});

test('capability, owner, writer lock, and current binding loss terminate tracking with preserved private draft', async t => {
  for (const cause of ['capability', 'owner', 'lock', 'binding']) {
    const f = fixture(t), start = await f.manager.startTracking({ token: (await f.manager.preview({ capture: f.capture() })).token }), before = f.read();
    if (cause === 'capability') f.manager.setCapability(false);
    if (cause === 'owner') f.setSnapshot({ ...f.snapshot, epoch: 2 });
    if (cause === 'lock') f.setLock(false);
    if (cause === 'binding') f.setBindings([]);
    assert.equal(f.manager.status().tracking, null); assert.deepEqual(f.read(), before); assert.equal(posts(f).length, 0);
    await f.manager.stopTracking({ trackingId: start.trackingId });
  }
});

test('known tombstone requires explicit restore; tracking does not restore and unknown duplicate rejection never changes entity ID', async t => {
  const f = fixture(t), published = await f.manager.preview({ capture: f.capture(7) }); await f.manager.publish({ token: published.token }); const entityId = posts(f)[0].body.operations[0].entityId;
  f.put(f.record(entityId, null, 2)); const removed = await f.manager.preview({ capture: f.capture(0) }); assert.equal(removed.publicationAction, 'restore');
  await f.manager.startTracking({ token: removed.token }); assert.equal(posts(f).length, 1); assert.equal(f.store().records.get(entityId).deletedAt, at);
  const confirmation = await f.manager.preview({ capture: f.capture(0) }); await f.manager.publish({ token: confirmation.token });
  assert.equal(posts(f)[1].body.operations[0].mutation, 'restore'); assert.equal(posts(f)[1].body.operations[0].entityId, entityId); assert.equal(posts(f)[1].body.operations[0].data.furthestPageIndex, 7);
  const unbound = fixture(t), unknownId = randomUUID(); unbound.put(unbound.record(unknownId, unbound.data(4))); unbound.put(unbound.record(unknownId, null, 2));
  unbound.store().events.splice(0, 1); const assumed = await unbound.manager.preview({ capture: unbound.capture() }); assert.equal(assumed.publicationAction, 'create');
  await unbound.manager.publish({ token: assumed.token }); const rejected = unbound.read().sync.outbox[0]; assert.equal(rejected.errorCode, 'CHECKPOINT_ALREADY_EXISTS'); assert.equal(rejected.status, 'rejected');
  await unbound.manager.continue(); assert.equal(posts(unbound).length, 1); const blocked = await unbound.manager.preview({ capture: unbound.capture() });
  assert.equal(blocked.publicationAction, 'blocked'); assert.equal(blocked.pendingRows[0].entityId, rejected.operation.entityId); await assert.rejects(unbound.manager.publish({ token: blocked.token }), { code: 'READING_PENDING' });
});

test('conflict and its unknown resolution keep original requests; unproven foreign conflicts are never sent', async t => {
  const f = fixture(t), entityId = randomUUID(); f.put(f.record(entityId, f.data(1, 3))); const preview = await f.manager.preview({ capture: f.capture(2) });
  f.put(f.record(entityId, f.data(4, 6, 2), 2)); await f.manager.publish({ token: preview.token }); const current = await f.manager.preview({ capture: f.capture(0) });
  assert.equal(current.conflicts.length, 1); assert.equal(current.conflicts[0].canResolve, true); const conflictId = current.conflicts[0].conflictId; let lost = true;
  f.setRoute(async (owner, input) => { if (input.path.endsWith('/resolve') && lost) { lost = false; await f.serve(owner, input); fail('NETWORK_ERROR'); } });
  await assert.rejects(f.manager.resolve({ conflictId, expectedRevision: 2, choice: 'current' }), { code: 'NETWORK_ERROR' });
  const original = structuredClone(f.read().pendingResolutions[0].request); f.manager.close(); await f.manager.settled(); f.create(); await f.manager.refreshStatus();
  assert.equal(f.manager.status().pending, 2); await f.manager.continue(); assert.equal(f.read().pendingResolutions.length, 0); assert.equal(f.read().sync.outbox.length, 0);
  const requests = posts(f).filter(row => row.path.endsWith('/resolve')); assert.equal(requests.length, 2); assert.deepEqual(requests[1].body, original);
  const foreign = fixture(t), foreignId = randomUUID(), owner = randomUUID(), foreignRow = foreign.put(foreign.record(foreignId, foreign.data(), 1, owner));
  const op = { opId: randomUUID(), entityType: 'readingPosition', entityId: foreignId, schemaVersion: 1, baseRevision: 0, mutation: 'put', data: foreign.data(), clientCreatedAt: at }, cid = randomUUID();
  foreign.store().conflicts.set(cid, { conflictId: cid, entityId: foreignId, entityType: 'readingPosition', createdAt: at, attemptedOperation: op, observedRecord: foreignRow, currentRecord: foreignRow });
  const view = await foreign.manager.preview({ capture: foreign.capture() }); assert.equal(view.conflicts[0].canResolve, false);
  await assert.rejects(foreign.manager.resolve({ conflictId: cid, expectedRevision: 1, choice: 'attempted' }), { code: 'READING_DEVICE_CHANGED' }); assert.equal(posts(foreign).length, 0);
});

test('malformed or altered push receipts keep the original uncertain instead of advancing or reauthoring it', async t => {
  for (const change of ['missing', 'author', 'point']) {
    const f = fixture(t); f.setRoute(async (owner, input) => {
      if (input.path === '/v1/sync/push') { const response = await f.serve(owner, input); if (change === 'missing') return { protocolVersion: 1, results: [] };
        if (change === 'author') response.results[0].record.modifiedByDeviceId = randomUUID();
        else response.results[0].record.data.pageIndex = 0; return response; }
    });
    const preview = await f.manager.preview({ capture: f.capture(4) }); await assert.rejects(f.manager.publish({ token: preview.token }));
    assert.equal(f.read().sync.outbox[0].status, 'uncertain'); assert.equal(f.read().sync.outbox[0].operation.data.pageIndex, 4); assert.equal(f.read().sync.outbox[0].errorCode, 'INVALID_RESPONSE');
    f.setRoute(null); await f.manager.continue(); assert.deepEqual(posts(f)[1].body.operations[0], posts(f)[0].body.operations[0]); assert.equal(f.read().sync.outbox.length, 0);
  }
});

test('a pulled conflict whose original push response was lost is consumed by its explicit resolution without replaying the old push', async t => {
  const f = fixture(t), entityId = randomUUID(); f.put(f.record(entityId, f.data(1, 3)));
  const preview = await f.manager.preview({ capture: f.capture(2) }); f.put(f.record(entityId, f.data(4, 6, 2), 2));
  let lost = true; f.setRoute(async (owner, input) => { if (input.path === '/v1/sync/push' && lost) { lost = false; await f.serve(owner, input); fail('NETWORK_ERROR'); } });
  await assert.rejects(f.manager.publish({ token: preview.token }), { code: 'NETWORK_ERROR' });
  assert.equal(f.read().sync.outbox[0].status, 'uncertain');
  const checked = await f.manager.preview({ capture: f.capture(0) }); assert.equal(checked.conflicts.length, 1);
  await f.manager.resolve({ conflictId: checked.conflicts[0].conflictId, expectedRevision: 2, choice: 'current' });
  assert.equal(posts(f).filter(row => row.path === '/v1/sync/push').length, 1, 'resolution consumes the original operation, including a lost conflict response');
  assert.equal(f.read().sync.outbox.length, 0); assert.equal(f.read().intents.length, 0); assert.equal(f.read().pendingResolutions.length, 0); assert.equal(f.manager.status().conflicts, 0);
});

test('recovery rechecks the frozen actual source before replaying any unknown publication', async t => {
  const f = fixture(t); let lost = true; f.setRoute(async (owner, input) => {
    if (input.path === '/v1/sync/push' && lost) { lost = false; await f.serve(owner, input); fail('NETWORK_ERROR'); }
  });
  const preview = await f.manager.preview({ capture: f.capture(4) }); await assert.rejects(f.manager.publish({ token: preview.token }));
  const original = f.read().sync.outbox[0].operation; nativeFs.writeSync(f.attachment, Buffer.from('changed complete source'), { mode: 0o600 });
  await assert.rejects(f.manager.continue(), { code: 'READING_SOURCE_CHANGED' }); assert.equal(posts(f).length, 1); assert.deepEqual(f.read().sync.outbox[0].operation, original);
  nativeFs.writeSync(f.attachment, f.bytes, { mode: 0o600 }); await f.manager.continue(); assert.equal(posts(f).length, 2); assert.deepEqual(posts(f)[1].body.operations[0], original);
});

test('resolution receipt save-only recovery uses no second resolve and preserves subsequent private drafts', async t => {
  const f = fixture(t), entityId = randomUUID(); f.put(f.record(entityId, f.data(1, 3)));
  const preview = await f.manager.preview({ capture: f.capture(2) }); f.put(f.record(entityId, f.data(4, 6, 2), 2)); await f.manager.publish({ token: preview.token });
  const current = await f.manager.preview({ capture: f.capture(0) }), tracking = await f.manager.startTracking({ token: current.token });
  await f.manager.recordTracked({ trackingId: tracking.trackingId, sequence: 1, point: point(1, 11) });
  const selected = await f.manager.preview({ capture: f.capture(0) }); f.setWriter((file, bytes, options) => {
    const state = JSON.parse(Buffer.from(bytes).toString()); if (!state.sync.outbox.length && !state.pendingResolutions.length) fail('EIO'); return nativeFs.writeSync(file, bytes, options);
  });
  await assert.rejects(f.manager.resolve({ conflictId: selected.conflicts[0].conflictId, expectedRevision: 2, choice: 'current' }), { code: 'READING_SAVE_UNCONFIRMED' });
  assert.equal(posts(f).filter(row => row.path.endsWith('/resolve')).length, 1); const pending = (await f.manager.backup()).unconfirmedState;
  assert.equal(pending.sync.outbox.length, 0); assert.equal(pending.pendingResolutions.length, 0); assert.equal(pending.drafts[0].furthestPageIndex, 11);
  f.setWriter(null); const calls = f.calls.length; await f.manager.retrySave(); assert.equal(f.calls.length, calls); assert.equal(f.read().drafts[0].furthestPageIndex, 11);
});

test('unknown old-device resolution stays private and blocked until the original device returns', async t => {
  const f = fixture(t), ownerA = f.snapshot, entityId = randomUUID(); f.put(f.record(entityId, f.data(1, 3)));
  const preview = await f.manager.preview({ capture: f.capture(2) }); f.put(f.record(entityId, f.data(4, 6, 2), 2)); await f.manager.publish({ token: preview.token });
  const current = await f.manager.preview({ capture: f.capture(0) }); let lost = true; f.setRoute(async (owner, input) => {
    if (input.path.endsWith('/resolve') && lost) { lost = false; await f.serve(owner, input); fail('NETWORK_ERROR'); }
  });
  await assert.rejects(f.manager.resolve({ conflictId: current.conflicts[0].conflictId, expectedRevision: 2, choice: 'current' }), { code: 'NETWORK_ERROR' });
  const original = f.read().pendingResolutions[0], deviceB = { ...ownerA, account: { ...ownerA.account, deviceId: randomUUID() }, epoch: 2 };
  f.manager.invalidate(); f.setSnapshot(deviceB); f.manager.setCapability(true); await f.manager.refreshStatus(); const calls = f.calls.length; await f.manager.continue();
  assert.equal(f.calls.length, calls); assert.equal(f.manager.status().errorCode, null);
  const fresh = await f.manager.preview({ capture: f.capture(0) }); assert.equal(fresh.publicationAction, 'create'); assert.equal(fresh.pendingResolutions[0].errorCode, 'READING_DEVICE_CHANGED');
  await f.manager.publish({ token: fresh.token }); assert.deepEqual(f.read().pendingResolutions[0], original); assert.equal(posts(f).filter(row => row.path.endsWith('/resolve')).length, 1);
  f.manager.invalidate(); f.setSnapshot({ ...ownerA, epoch: 3 }); f.manager.setCapability(true); await f.manager.refreshStatus(); await f.manager.continue();
  const resolves = posts(f).filter(row => row.path.endsWith('/resolve')); assert.equal(resolves.length, 2); assert.deepEqual(resolves[1].body, original.request); assert.equal(f.read().pendingResolutions.length, 0);
});

test('unavailable optional device labels remain unknown while authentication and malformed responses fail explicitly', async t => {
  for (const code of ['NOT_FOUND', 'NETWORK_UNAVAILABLE', 'DESKTOP_REQUEST_TIMEOUT']) {
    const f = fixture(t); f.put(f.record(undefined, f.data(1, 8), 1, randomUUID()));
    f.setRoute(async (_owner, input) => { if (input.path === '/v1/devices') fail(code); });
    const preview = await f.manager.preview({ capture: f.capture() }); assert.equal(preview.positions[0].deviceName, null); assert.deepEqual(f.files(), []);
  }
  const auth = fixture(t); auth.setRoute(async (_owner, input) => { if (input.path === '/v1/devices') fail('AUTHENTICATION_REQUIRED'); });
  await assert.rejects(auth.manager.preview({ capture: auth.capture() }), { code: 'AUTHENTICATION_REQUIRED' }); assert.deepEqual(auth.files(), []);
  const malformed = fixture(t); malformed.setRoute(async (_owner, input) => input.path === '/v1/devices' ? { devices: [{ id: randomUUID(), name: 'Guessed device' }] } : undefined);
  await assert.rejects(malformed.manager.preview({ capture: malformed.capture() }), { code: 'READING_STATE_INVALID' }); assert.deepEqual(malformed.files(), []);
});

test('native CAS, corruption and strict response/page/binding budgets reject without clipping or overwriting', async t => {
  const f = fixture(t), started = await f.manager.startTracking({ token: (await f.manager.preview({ capture: f.capture() })).token });
  fs.appendFileSync(f.file(), '\n'); const external = fs.readFileSync(f.file());
  await assert.rejects(f.manager.recordTracked({ trackingId: started.trackingId, sequence: 1, point: point(4) }), { code: 'READING_STORAGE_CHANGED' });
  assert.equal(f.manager.status().tracking, null); assert.equal(f.manager.status().saveUnconfirmed, true); assert.deepEqual(fs.readFileSync(f.file()), external);
  await assert.rejects(f.manager.retrySave(), { code: 'READING_STORAGE_CHANGED' }); assert.deepEqual(fs.readFileSync(f.file()), external); assert.ok((await f.manager.backup()).unconfirmedState);
  f.manager.close(); await f.manager.settled(); nativeFs.writeSync(f.file(), Buffer.from('{broken'), { mode: 0o600 }); f.create(); await assert.rejects(f.manager.refreshStatus(), { code: 'READING_STATE_INVALID' });
  const huge = fixture(t); huge.setRoute(async (_owner, input) => input.path.startsWith('/v1/sync/pull') ? { padding: 'x'.repeat(core.DESKTOP_READING_LIMITS.privateBytes) } : undefined);
  await assert.rejects(huge.manager.preview({ capture: huge.capture() }), { code: 'READING_STATE_FULL' }); assert.deepEqual(huge.files(), []);
  const pages = fixture(t, { pullPages: 2 }); let cursor = 0; pages.setRoute(async (_owner, input) => input.path.startsWith('/v1/sync/pull') ? { protocolVersion: 1, records: [], nextCursor: String(++cursor), hasMore: true } : undefined);
  await assert.rejects(pages.manager.preview({ capture: pages.capture() }), { code: 'READING_LIMIT' }); assert.equal(pages.calls.length, 2); assert.deepEqual(pages.files(), []);
  const loop = fixture(t); loop.setRoute(async (_owner, input) => input.path.startsWith('/v1/sync/pull') ? { protocolVersion: 1, records: [], nextCursor: 'same', hasMore: true } : undefined);
  await assert.rejects(loop.manager.preview({ capture: loop.capture() }), { code: 'READING_STATE_INVALID' });
  const duplicate = fixture(t); duplicate.setBindings([duplicate.bindings[0], duplicate.bindings[0]]); await assert.rejects(duplicate.manager.preview({ capture: duplicate.capture() }), { code: 'READING_BINDING_INVALID' });
});
