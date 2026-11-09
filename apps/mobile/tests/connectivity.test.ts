import assert from 'node:assert/strict';
import test from 'node:test';
import { initialOnline, observeConnectivity, type ConnectivityRuntime } from '../src/platform/connectivity.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(native = true) {
  const events = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let online = true, removed = 0, reads = 0;
  let status = { connected: false };
  let change: (status: { connected: boolean }) => void = () => {};
  const values: boolean[] = [];
  const environment: ConnectivityRuntime = {
    native, available: true, online: () => online, events, document: document as ConnectivityRuntime['document'],
    network: {
      async getStatus() { reads++; return status; },
      async addListener(_event, listener) { change = listener; return { async remove() { removed++; } }; },
    },
  };
  return { environment, values, events, document, setOnline: (value: boolean) => { online = value; },
    setStatus: (connected: boolean) => { status = { connected }; },
    change: (connected: boolean) => change({ connected }), removed: () => removed, reads: () => reads,
    start: () => observeConnectivity(value => values.push(value), environment) };
}

test('native airplane mode wins over a WebView reporting online; browser events cannot override it', async () => {
  const f = fixture();
  assert.equal(f.environment.online(), true);
  assert.equal(initialOnline(f.environment), false);
  const stop = f.start(); await settle();
  assert.equal(f.values.at(-1), false);
  f.events.dispatchEvent(new Event('online')); assert.equal(f.values.at(-1), false);
  f.change(true); assert.equal(f.values.at(-1), true);
  f.change(false); assert.equal(f.values.at(-1), false);
  stop(); await settle(); assert.equal(f.removed(), 1);
});

test('a stale native status response cannot undo a newer disconnection event', async () => {
  const f = fixture(), read = deferred<{ connected: boolean }>();
  f.environment.network.getStatus = () => read.promise;
  const stop = f.start(); await settle();
  f.change(true); f.change(false); read.resolve({ connected: true }); await settle();
  assert.deepEqual(f.values, [false, true, false]); stop();
});

test('foreground reads refresh native connectivity before reconnecting and ignore an older overlapping read', async () => {
  const f = fixture(), first = deferred<{ connected: boolean }>(), second = deferred<{ connected: boolean }>();
  const queue = [first, second]; f.environment.network.getStatus = () => queue.shift()!.promise;
  const stop = f.start(); await settle();
  f.document.dispatchEvent(new Event('visibilitychange'));
  second.resolve({ connected: false }); await settle(); first.resolve({ connected: true }); await settle();
  assert.equal(f.values.at(-1), false); assert(!f.values.includes(true)); stop();
});

test('cleanup removes a late listener and fences its callbacks without querying a disposed workspace', async () => {
  const f = fixture(), attached = deferred<{ remove(): Promise<void> }>();
  let retained: ((status: { connected: boolean }) => void) | undefined;
  f.environment.network.addListener = (_event, listener) => { retained = listener; return attached.promise; };
  let removed = 0; const stop = f.start(); stop();
  attached.resolve({ async remove() { removed++; } }); await settle(); retained?.({ connected: true });
  assert.equal(removed, 1); assert.equal(f.reads(), 0); assert.deepEqual(f.values, [false]);
});

test('failed native reads stay offline and retry on foreground without a browser-online fallback', async () => {
  const f = fixture(); f.environment.network.getStatus = async () => { throw new Error('OS connection read failed'); };
  const stop = f.start(); await settle(); assert.equal(f.values.at(-1), false);
  f.environment.network.getStatus = async () => ({ connected: true });
  f.document.dispatchEvent(new Event('visibilitychange')); await settle(); assert.equal(f.values.at(-1), true); stop();
});

test('browser connectivity keeps online/offline events and refreshes on foreground; native API is unused', async () => {
  const f = fixture(false); assert.equal(initialOnline(f.environment), true);
  const stop = f.start(); assert.deepEqual(f.values, [true]);
  f.setOnline(false); f.events.dispatchEvent(new Event('offline')); assert.equal(f.values.at(-1), false);
  f.setOnline(true); f.document.dispatchEvent(new Event('visibilitychange')); assert.equal(f.values.at(-1), true);
  stop(); f.events.dispatchEvent(new Event('offline')); await settle();
  assert.equal(f.reads(), 0); assert.equal(f.removed(), 0);
});

test('an absent native plugin never treats a WebView online flag as an OS connection', async () => {
  const f = fixture(); f.environment.available = false;
  const stop = f.start(); f.document.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.deepEqual(f.values, [false]); assert.equal(f.reads(), 0); stop();
});

test('a native read completing after disposal cannot reconnect the previous workspace', async () => {
  const f = fixture(), read = deferred<{ connected: boolean }>();
  f.environment.network.getStatus = () => read.promise;
  const stop = f.start(); await settle(); stop(); read.resolve({ connected: true }); await settle();
  assert.deepEqual(f.values, [false]); assert.equal(f.removed(), 1);
});

test('an active local Wi-Fi link remains usable without public Internet validation', async () => {
  const f = fixture();
  f.environment.network.getStatus = async () => ({ connected: false, connectionType: 'wifi' });
  const stop = f.start(); await settle(); assert.equal(f.values.at(-1), true);
  f.change(false); assert.equal(f.values.at(-1), false); stop();
});
