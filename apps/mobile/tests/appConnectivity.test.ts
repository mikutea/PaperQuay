import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { IDBFactory } from 'fake-indexeddb';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { ConnectedApp } from '../src/App.tsx';
import { type AccountIdentity } from '../src/api.ts';
import { OidcSession, type AuthSnapshot } from '../src/auth/oidc.ts';
import { parseAppConfig } from '../src/config.ts';
import { ClientError } from '../src/errors.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController, type StoredWorkspace } from '../src/sync/workspace.ts';

const account = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const device = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const now = '2026-11-09T08:00:00.000Z';
const identity: AccountIdentity = { accountId: account, device: {
  id: device, name: 'Connection regression', platform: 'android', createdAt: now, lastSeenAt: now, revokedAt: null,
} };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(t: TestContext, options: { read?: () => Promise<AccountIdentity | null>; registerFails?: boolean } = {}) {
  const names = ['window', 'document', 'location', 'navigator', 'sessionStorage'] as const;
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let online = false, registrations = 0, bindingReads = 0;
  const location = new URL('https://app.example.test/'), storage = new InMemoryWebStorage();
  const window = Object.assign(new EventTarget(), { location, innerWidth: 900, confirm: () => true });
  const values = { window, document: Object.assign(new EventTarget(), { visibilityState: 'visible' }), location,
    navigator: { get onLine() { return online; } }, sessionStorage: storage };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  const input = { apiBaseUrl: 'https://sync.example.test', oidcAuthority: 'https://id.example.test/realms/paperquay', oidcClientId: 'paperquay-mobile' };
  const config = parseAppConfig(input, location.origin);
  const auth = new OidcSession(config, storage);
  let snapshot: AuthSnapshot = { status: 'signed-in', displayName: 'Restored authentication' };
  const authListeners = new Set<() => void>();
  t.mock.method(auth, 'subscribe', (listener: () => void) => { authListeners.add(listener); return () => authListeners.delete(listener); });
  t.mock.method(auth, 'getSnapshot', () => snapshot);
  t.mock.method(auth, 'getSubject', () => ({ issuer: config.oidcAuthority, subject: account }));
  t.mock.method(auth, 'initialize', async () => {});
  const store = new AccountStore<StoredWorkspace>({ decode: decodeWorkspace, indexedDB: new IDBFactory(), databaseName: crypto.randomUUID() });
  const api = {
    async register() { registrations++; if (options.registerFails) throw new ClientError('NETWORK_UNAVAILABLE', true); return identity; },
    async pull() { return { protocolVersion: 1 as const, records: [], nextCursor: '0', hasMore: false }; },
    async conflicts() { return { conflicts: [], nextCursor: 'done', hasMore: false }; },
    async devices() { return [identity.device]; },
    async push(): Promise<never> { throw new Error('No local operation should be sent'); },
    async resolveConflict(): Promise<never> { throw new Error('No conflict should be resolved'); },
    async revokeDevice() {},
  };
  const controller = new WorkspaceController({ apiBaseUrl: config.apiBaseUrl, api, store, online: false, now: () => now,
    binding: { read: async () => { bindingReads++; return options.read ? options.read() : null; } },
  });
  let renderer: ReactTestRenderer | undefined;
  t.after(async () => {
    if (renderer) await act(async () => renderer!.unmount());
    controller.deactivate(); await store.close();
    for (const name of names) { const descriptor = previous.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  });
  await act(async () => { renderer = create(createElement(ConnectedApp, {
    runtime: { config, auth, controller }, configInput: input, configError: null, onConfigure: async () => {},
  })); });
  return { controller, registrations: () => registrations, bindingReads: () => bindingReads,
    signedOut: async () => { await act(async () => { snapshot = { status: 'signed-out' }; authListeners.forEach(listener => listener()); }); },
    connected: async () => { await act(async () => { online = true; window.dispatchEvent(new Event('online')); await tick(); }); },
    settle: async () => { for (let i = 0; i < 5; i++) await act(async () => { await tick(); }); },
  };
}

test('restored authentication binds automatically when an initially unknown connection comes online', async t => {
  const f = await setup(t);
  assert.equal(f.controller.getSnapshot().status, 'error');
  assert.equal(f.controller.getSnapshot().error?.code, 'NETWORK_UNAVAILABLE');
  assert.equal(f.controller.getSnapshot().needsLogin, false);
  assert.equal(f.registrations(), 0);
  await f.connected(); await f.settle();
  assert.equal(f.controller.getSnapshot().status, 'ready');
  assert.equal(f.controller.getSnapshot().identity?.accountId, account);
  assert.equal(f.registrations(), 1);
});

test('online arrival during an unfinished offline binding retries once after that binding completes', async t => {
  const cached = deferred<AccountIdentity | null>();
  const f = await setup(t, { read: () => cached.promise });
  assert.equal(f.controller.getSnapshot().status, 'binding'); assert.equal(f.bindingReads(), 1);
  await f.connected(); assert.equal(f.registrations(), 0);
  await act(async () => { cached.resolve(null); await tick(); }); await f.settle();
  assert.equal(f.controller.getSnapshot().status, 'ready'); assert.equal(f.registrations(), 1);
});

test('an unavailable service after the connection recovers does not cause an automatic binding loop', async t => {
  const f = await setup(t, { registerFails: true });
  await f.connected(); await f.settle();
  assert.equal(f.controller.getSnapshot().status, 'error');
  assert.equal(f.controller.getSnapshot().error?.code, 'NETWORK_UNAVAILABLE');
  assert.equal(f.registrations(), 1);
});

test('sign-out during the initial offline read cannot bind the previous account when connectivity returns', async t => {
  const cached = deferred<AccountIdentity | null>();
  const f = await setup(t, { read: () => cached.promise });
  assert.equal(f.controller.getSnapshot().status, 'binding');
  await f.signedOut(); await f.connected();
  await act(async () => { cached.resolve(null); await tick(); }); await f.settle();
  assert.equal(f.controller.getSnapshot().status, 'signed-out'); assert.equal(f.registrations(), 0);
});
