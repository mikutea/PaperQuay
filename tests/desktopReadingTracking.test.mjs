import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const bundle = await build({ entryPoints: ['src/services/desktopReadingTracking.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
const loaded = { exports: {} }; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports);
const { createDesktopReadingTracking } = loaded.exports;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(done => setImmediate(done)); };
const at = '2026-11-04T12:00:00.000Z';
function fixture() {
  const source = { bindingId: 'binding', localPaperId: 'local-paper', localAttachmentId: 'local-attachment', paperId: 'paper', attachmentVersionId: 'version', sha256: 'a'.repeat(64), sizeBytes: 10, pageCount: 16, title: 'Synthetic paper', fileName: 'fixture.pdf' };
  const capture = { bindingId: source.bindingId, sha256: source.sha256, sizeBytes: source.sizeBytes, pageCount: source.pageCount, pageIndex: 0, offsetRatio: .1, observedAt: at };
  const preview = { token: 'explicit-token', scopeKey: 'owner-A-epoch-1', source, capture };
  const calls = [], overrides = {}, timers = new Map(), pointListeners = new Set(), changeListeners = new Set();
  const current = { active: true, point: { pageIndex: 0, offsetRatio: .1, observedAt: at }, geometryReads: 0, byteReads: 0, trackingId: null, saved: null, furthest: { pageIndex: 11, offsetRatio: .8 } };
  const status = () => ({ scopeKey: preview.scopeKey, supported: true, busy: false, revision: 1, pending: 0, continuable: 0, conflicts: 0, saveUnconfirmed: false, errorCode: null,
    tracking: current.trackingId ? { trackingId: current.trackingId, bindingId: source.bindingId, attachmentVersionId: source.attachmentVersionId } : null });
  const invoke = async (name, input, fallback) => { calls.push({ name, input: structuredClone(input) }); return overrides[name] ? overrides[name](input) : fallback(); };
  const startResult = () => { current.trackingId = 'tracking-one'; return { status: status(), trackingId: current.trackingId, source, capture, furthestPageIndex: current.furthest.pageIndex, furthestOffsetRatio: current.furthest.offsetRatio }; };
  const service = {
    startTracking: input => invoke('start', input, startResult),
    recordTracked: input => invoke('record', input, () => { current.saved = structuredClone(input.point); return status(); }),
    stopTracking: input => invoke('stop', input, () => { if (current.trackingId === input.trackingId) current.trackingId = null; return status(); }),
    status: () => invoke('status', undefined, status),
    onChanged: async listener => { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
  };
  const reader = { id: 'loaded-document', isCurrent: () => current.active, currentPoint: () => { current.geometryReads++; return structuredClone(current.point); },
    capture: async () => { current.byteReads++; return capture; }, resume: async () => assert.fail('Tracking must never jump'), dispose() {},
    subscribePosition: listener => { pointListeners.add(listener); return () => { pointListeners.delete(listener); }; },
  };
  const controller = createDesktopReadingTracking({ reader, localPaperId: source.localPaperId, isCurrent: () => current.active, service,
    schedule(callback) { const id = Symbol(); timers.set(id, callback); return id; }, cancel(id) { timers.delete(id); } });
  return { controller, current, preview, calls, overrides, status, startResult, timers, pointListeners, changeListeners,
    point(pageIndex, offsetRatio = .1) { const point = { pageIndex, offsetRatio, observedAt: at }; current.point = point; for (const listener of [...pointListeners]) listener(point); },
    change(scope = preview.scopeKey) { for (const listener of [...changeListeners]) listener({ readingScopeKey: scope }); },
    async tick() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await settle(); },
  };
}

test('controller construction is inert and explicit start uses the checked loaded document without another byte read or publication', async () => {
  const f = fixture(); assert.deepEqual(f.calls, []); assert.equal(f.current.geometryReads, 0); assert.equal(f.pointListeners.size, 0);
  await f.controller.start(f.preview); assert.deepEqual(f.calls.map(row => row.name), ['start']); assert.equal(f.current.byteReads, 0);
  assert.equal(f.controller.snapshot().phase, 'recording'); assert.equal(f.pointListeners.size, 1); await f.controller.dispose();
  assert.deepEqual(f.calls.map(row => row.name), ['start', 'stop']); assert.equal(f.pointListeners.size, 0); assert.equal(f.changeListeners.size, 0);
});
test('throttled actual observations keep the latest backward point and the furthest intermediate point, and deduplicate stationary events', async () => {
  const f = fixture(); await f.controller.start(f.preview); f.point(14, .7); f.point(3, .25); assert.equal(f.timers.size, 1);
  await f.tick(); const record = f.calls.find(row => row.name === 'record');
  assert.deepEqual(record.input, { trackingId: 'tracking-one', sequence: 1, point: { pageIndex: 3, offsetRatio: .25, furthestPageIndex: 14, furthestOffsetRatio: .7, observedAt: at } });
  f.point(3, .25); await f.tick(); assert.equal(f.calls.filter(row => row.name === 'record').length, 1); await f.controller.stop();
  assert.equal(f.controller.snapshot().phase, 'stopped'); await f.controller.dispose();
});
test('returning to the previously saved point during an in-flight save cannot lose the latest recent location', async () => {
  const f = fixture(), response = deferred(); await f.controller.start(f.preview);
  f.overrides.record = async input => { if (input.sequence === 1) await response.promise; f.current.saved = structuredClone(input.point); return f.status(); };
  f.point(2); await f.tick(); assert.equal(f.calls.filter(row => row.name === 'record').length, 1);
  f.point(0); await f.tick(); response.resolve(); await settle(); await f.controller.dispose();
  const records = f.calls.filter(row => row.name === 'record'); assert.deepEqual(records.map(row => row.input.sequence), [1, 2]);
  assert.equal(f.current.saved.pageIndex, 0); assert.equal(f.current.saved.furthestPageIndex, 11);
  assert.equal(f.controller.snapshot().recent.pageIndex, 0);
});
test('explicit stop samples the current actual point once and flushes it before ending the exact runtime session', async () => {
  const f = fixture(); await f.controller.start(f.preview); f.current.point = { pageIndex: 5, offsetRatio: .6, observedAt: at };
  await f.controller.stop(); assert.deepEqual(f.calls.map(row => row.name), ['start', 'record', 'stop']); assert.equal(f.current.saved.pageIndex, 5);
  assert.equal(f.controller.snapshot().phase, 'stopped'); assert.equal(f.pointListeners.size, 0); assert.equal(f.current.byteReads, 0); await f.controller.dispose();
});
test('unmount flushes only the last observed event and never measures retired or hidden geometry', async () => {
  const f = fixture(); await f.controller.start(f.preview); f.point(4, .3); const reads = f.current.geometryReads;
  f.current.active = false; f.current.point = { pageIndex: 15, offsetRatio: 1, observedAt: at }; await f.controller.dispose();
  assert.equal(f.current.geometryReads, reads); assert.equal(f.current.saved.pageIndex, 4); assert.equal(f.controller.snapshot().phase, 'stopped');
});
test('account A-B-A while start is awaiting a native receipt permanently revokes that start and stops only its returned tracking id', async () => {
  const f = fixture(), pending = deferred(); f.overrides.start = () => pending.promise;
  const start = f.controller.start(f.preview), rejected = assert.rejects(start, { code: 'READING_READER_CHANGED' }); await settle();
  f.change('owner-B-epoch-2'); f.change('owner-A-epoch-3'); pending.resolve(f.startResult()); await rejected;
  assert.equal(f.controller.snapshot().phase, 'error'); assert.equal(f.pointListeners.size, 0);
  assert.deepEqual(f.calls.filter(row => row.name === 'stop').map(row => row.input), [{ trackingId: 'tracking-one' }]); await f.controller.dispose();
});
test('account invalidation during a point save discards late success and never sends observations to the next owner', async () => {
  const f = fixture(), pending = deferred(); await f.controller.start(f.preview); f.overrides.record = () => pending.promise;
  f.point(7); await f.tick(); f.change('owner-B-epoch-2'); f.change('owner-A-epoch-3'); f.point(2); pending.resolve(f.status()); await settle();
  assert.equal(f.controller.snapshot().phase, 'error'); assert.equal(f.controller.snapshot().errorCode, 'AUTH_SESSION_CHANGED');
  assert.equal(f.controller.snapshot().recent, null); assert.equal(f.controller.snapshot().furthest, null);
  assert.equal(f.calls.filter(row => row.name === 'record').length, 1); assert.equal(f.pointListeners.size, 0); await f.controller.dispose();
});
test('save-unconfirmed stops local observation and leaves recovery to the separate save-only path', async () => {
  const f = fixture(); await f.controller.start(f.preview);
  f.overrides.record = () => ({ ...f.status(), saveUnconfirmed: true, errorCode: 'READING_SAVE_UNCONFIRMED' });
  f.point(2); await f.tick(); f.point(3); await f.tick(); assert.equal(f.calls.filter(row => row.name === 'record').length, 1);
  assert.equal(f.controller.snapshot().phase, 'error'); assert.equal(f.controller.snapshot().errorCode, 'READING_SAVE_UNCONFIRMED'); assert.equal(f.pointListeners.size, 0); await f.controller.dispose();
});
test('capability loss on a same-owner change stops the session while preserving its last confirmed local point', async () => {
  const f = fixture(); await f.controller.start(f.preview); f.point(3); await f.tick();
  f.overrides.status = () => ({ ...f.status(), supported: false, tracking: null }); f.change(); await settle(); f.point(4); await f.tick();
  assert.equal(f.controller.snapshot().phase, 'error'); assert.equal(f.current.saved.pageIndex, 3); assert.equal(f.calls.filter(row => row.name === 'record').length, 1); await f.controller.dispose();
});
test('a retired loaded document or different local paper cannot enable tracking and cannot read or publish', async () => {
  const f = fixture(); f.current.active = false; await assert.rejects(f.controller.start(f.preview), { code: 'READING_READER_CHANGED' });
  f.current.active = true; await assert.rejects(f.controller.start({ ...f.preview, source: { ...f.preview.source, localPaperId: 'another-paper' } }), { code: 'READING_SOURCE_CHANGED' });
  assert.deepEqual(f.calls, []); assert.equal(f.current.byteReads, 0); await f.controller.dispose();
});
test('stopping while start is awaiting a receipt prevents late auto-enable and preserves the original runtime identity', async () => {
  const f = fixture(), pending = deferred(); f.overrides.start = () => pending.promise;
  const start = f.controller.start(f.preview), rejected = assert.rejects(start, { code: 'READING_READER_CHANGED' }); await settle();
  const stop = f.controller.stop(); pending.resolve(f.startResult()); await rejected; await stop;
  assert.equal(f.controller.snapshot().phase, 'stopped'); assert.equal(f.pointListeners.size, 0); assert.equal(f.calls.filter(row => row.name === 'stop').length, 1); await f.controller.dispose();
});
test('an explicit local stop IPC failure retains the tracking id for a user retry and never claims it stopped', async () => {
  const f = fixture(); await f.controller.start(f.preview);
  f.overrides.stop = () => { throw Object.assign(Error('IPC_UNAVAILABLE'), { code: 'IPC_UNAVAILABLE' }); };
  await assert.rejects(f.controller.stop(), { code: 'IPC_UNAVAILABLE' }); assert.equal(f.controller.snapshot().phase, 'error');
  assert.equal(f.current.trackingId, 'tracking-one'); await assert.rejects(f.controller.start(f.preview), { code: 'READING_TRACKING_ACTIVE' });
  delete f.overrides.stop; await f.controller.stop(); assert.equal(f.current.trackingId, null); assert.equal(f.calls.filter(row => row.name === 'stop').length, 2);
  assert.equal(f.controller.snapshot().phase, 'stopped'); assert.equal(f.controller.snapshot().errorCode, null); await f.controller.dispose();
});
test('teardown during a pending explicit stop absorbs its later bridge failure and detaches every observer', async () => {
  const f = fixture(), pending = deferred(); await f.controller.start(f.preview); f.overrides.stop = () => pending.promise;
  const stopped = f.controller.stop(), rejected = assert.rejects(stopped, { code: 'IPC_UNAVAILABLE' }); await settle();
  const disposed = f.controller.dispose(); pending.reject(Object.assign(Error('IPC_UNAVAILABLE'), { code: 'IPC_UNAVAILABLE' }));
  await rejected; await assert.doesNotReject(disposed); assert.equal(f.pointListeners.size, 0); assert.equal(f.changeListeners.size, 0);
});
test('a stopped session keeps its display owner so account replacement clears the old recent point and timestamp', async () => {
  const f = fixture(); await f.controller.start(f.preview); f.point(3, .25); await f.tick(); await f.controller.stop();
  assert.equal(f.controller.snapshot().recent.pageIndex, 3); f.change('owner-B-epoch-2');
  assert.deepEqual(f.controller.snapshot(), { phase: 'stopped', errorCode: null, recent: null, furthest: null });
  f.change('owner-A-epoch-3'); assert.equal(f.controller.snapshot().recent, null); assert.equal(f.calls.filter(row => row.name === 'start').length, 1); await f.controller.dispose();
});
test('an old scope save error and its displayed points cannot survive a later account change after observation stopped', async () => {
  const f = fixture(); await f.controller.start(f.preview); f.overrides.record = () => { throw Object.assign(Error('READING_SAVE_UNCONFIRMED'), { code: 'READING_SAVE_UNCONFIRMED' }); };
  f.point(4, .5); await f.tick(); assert.equal(f.controller.snapshot().phase, 'error'); assert.equal(f.controller.snapshot().recent.pageIndex, 4);
  f.change('owner-B-epoch-2'); assert.deepEqual(f.controller.snapshot(), { phase: 'stopped', errorCode: null, recent: null, furthest: null }); await f.controller.dispose();
});
test('a late rejected stop cannot overwrite the next account state after its display owner was cleared', async () => {
  const f = fixture(), pending = deferred(); await f.controller.start(f.preview); f.overrides.stop = () => pending.promise;
  const stopped = f.controller.stop(), rejected = assert.rejects(stopped, { code: 'IPC_UNAVAILABLE' }); await settle();
  f.change('owner-B-epoch-2'); const nextOwner = f.controller.snapshot(); assert.equal(nextOwner.recent, null); assert.equal(nextOwner.furthest, null);
  pending.reject(Object.assign(Error('IPC_UNAVAILABLE'), { code: 'IPC_UNAVAILABLE' })); await rejected;
  assert.deepEqual(f.controller.snapshot(), nextOwner); await f.controller.dispose();
});
