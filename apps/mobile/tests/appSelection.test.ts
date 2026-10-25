import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { IDBFactory } from 'fake-indexeddb';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { createAccountState, entityKey, type SyncRecord } from '../../../packages/sync-core/src/index.ts';
import { ConnectedApp } from '../src/App.tsx';
import { SyncApi } from '../src/api.ts';
import { OidcSession, type AuthSnapshot } from '../src/auth/oidc.ts';
import { EntityEditor } from '../src/components/EntityEditor.tsx';
import { parseAppConfig } from '../src/config.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController, type StoredWorkspace, type WorkspaceSnapshot } from '../src/sync/workspace.ts';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FIRST = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SECOND = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const NOW = '2026-10-25T08:00:00.000Z';
type EntityType = 'paper' | 'note';

function record(type: EntityType, id: string, title: string): SyncRecord<'paper' | 'note'> {
  const common = {
    entityId: id,
    schemaVersion: 1 as const,
    revision: 1,
    deletedAt: null,
    updatedAt: NOW,
    modifiedByDeviceId: DEVICE,
  };
  return type === 'paper'
    ? {
        ...common,
        entityType: 'paper',
        data: {
          title, authors: ['Author'], year: '2026', doi: null,
          publication: null, keywords: [], abstractText: null,
        },
      }
    : {
        ...common,
        entityType: 'note',
        data: { title, body: 'Saved note body', paperId: null, format: 'markdown' },
      };
}

function text(node: ReactTestInstance | string | number): string {
  return typeof node === 'object' ? node.children.map(text).join('') : String(node);
}

function installBrowser() {
  const names = ['window', 'document', 'location', 'sessionStorage'] as const;
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const confirmations: string[] = [];
  let acceptConfirmation = true;
  const location = new URL('https://app.example.test/');
  const window = Object.assign(new EventTarget(), {
    location,
    innerWidth: 1194,
    confirm: (message: string) => {
      confirmations.push(message);
      return acceptConfirmation;
    },
  });
  const values = {
    window,
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    location,
    sessionStorage: new InMemoryWebStorage(),
  };
  for (const name of names)
    Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  return {
    confirmations,
    storage: values.sessionStorage,
    accept: (value: boolean) => { acceptConfirmation = value; },
    beforeUnload: () => {
      const event = new Event('beforeunload', { cancelable: true });
      Object.defineProperty(event, 'returnValue', { writable: true, value: 'not-set' });
      window.dispatchEvent(event);
      return { blocked: event.defaultPrevented, returnValue: Reflect.get(event, 'returnValue') };
    },
    restore: () => {
      for (const name of names) {
        const original = originals.get(name);
        if (original) Object.defineProperty(globalThis, name, original);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

async function setup(context: TestContext, type: EntityType = 'paper') {
  const browser = installBrowser();
  const input = {
    apiBaseUrl: 'https://sync.example.test',
    oidcAuthority: 'https://id.example.test/realms/paperquay',
    oidcClientId: 'paperquay-mobile',
  };
  const config = parseAppConfig(input, 'https://app.example.test');
  const store = new AccountStore<StoredWorkspace>({ decode: decodeWorkspace, indexedDB: new IDBFactory() });
  const controller = new WorkspaceController({
    apiBaseUrl: config.apiBaseUrl,
    api: new SyncApi(config.apiBaseUrl, async () => { throw new Error('Unexpected API request'); }),
    store,
  });
  const auth = new OidcSession(config, browser.storage);
  const authSnapshot: AuthSnapshot = { status: 'signed-in', displayName: 'Test account' };
  const sync = createAccountState(ACCOUNT, DEVICE);
  for (const entry of [
    record('paper', FIRST, 'Paper A'), record('paper', SECOND, 'Paper B'),
    record('note', FIRST, 'Note A'), record('note', SECOND, 'Note B'),
  ]) sync.serverRecords[entityKey(entry.entityType, entry.entityId)] = entry;
  const snapshot: WorkspaceSnapshot = {
    status: 'ready', identity: null, workspace: { sync, pendingResolutions: {} },
    syncing: false, online: true, needsLogin: false, devices: [], conflicts: [],
    lastSyncedAt: NOW, error: null,
  };
  context.mock.method(auth, 'getSnapshot', () => authSnapshot);
  context.mock.method(controller, 'getSnapshot', () => snapshot);
  context.mock.method(controller, 'bind', async () => {});
  context.mock.method(controller, 'syncNow', async () => {});
  context.mock.method(controller, 'deactivate', () => {});
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ConnectedApp, {
      runtime: { config, auth, controller }, configInput: input,
      configError: null, onConfigure: async () => {},
    }));
  });
  const button = (label: string, root = renderer.root) => {
    const found = root.findAllByType('button').find((entry) => text(entry) === label);
    assert.ok(found, `Missing button: ${label}`);
    return found;
  };
  const navigate = (label: string) => act(() => {
    button(label, renderer.root.findByProps({ className: 'sidebar' })).props.onClick();
  });
  if (type === 'note') navigate('笔记');
  const row = (title: string) => {
    const found = renderer.root.findAllByType('button').find((entry) =>
      entry.props.className?.split(' ').includes('entity-row') &&
      text(entry.findByProps({ className: 'entity-title' })) === title);
    assert.ok(found, `Missing record: ${title}`);
    return found;
  };
  return {
    ...browser, renderer, navigate,
    editor: () => renderer.root.findByType(EntityEditor),
    title: () => renderer.root.findByProps({ id: 'entity-title' }).props.value as string,
    select: (title: string) => act(() => row(title).props.onClick()),
    selectTyped: (nextType: EntityType, id: string) => act(() => {
      // Exercise the actual list-to-parent callback without section navigation
      // first unmounting the editor and masking a type/id identity regression.
      const list = renderer.root.findByProps({ className: 'list-pane' }).parent;
      assert.equal(typeof list?.props.onSelect, 'function');
      list!.props.onSelect(nextType, id);
    }),
    create: () => act(() => button(type === 'paper' ? '添加文献' : '新建笔记').props.onClick()),
    edit: (title: string) => act(() => {
      renderer.root.findByProps({ id: 'entity-title' }).props.onChange({ target: { value: title } });
    }),
    close: async () => {
      act(() => renderer.unmount());
      await store.close();
      browser.restore();
    },
  };
}

for (const type of ['paper', 'note'] as const) {
  test(`the side-by-side App keeps a ${type} draft guarded after reselecting its row and continuing to edit`, async (context) => {
    const env = await setup(context, type);
    const first = type === 'paper' ? 'Paper A' : 'Note A';
    const second = type === 'paper' ? 'Paper B' : 'Note B';
    try {
      env.select(first);
      const editor = env.editor();
      env.edit('Unsaved before reselect');
      assert.equal(env.beforeUnload().blocked, true);
      env.select(first); // An accepting confirm stub reproduces the original data-loss path.
      assert.equal(env.editor(), editor);
      assert.equal(env.title(), 'Unsaved before reselect');
      env.edit('Later typing must still be protected');
      assert.deepEqual(env.beforeUnload(), { blocked: true, returnValue: '' });
      assert.equal(env.confirmations.length, 0, 'reselecting the current record must be a no-op');

      env.accept(false);
      env.select(second);
      assert.equal(env.confirmations.length, 1);
      assert.equal(env.editor().props.entityId, FIRST);
      assert.equal(env.title(), 'Later typing must still be protected');
      assert.equal(env.beforeUnload().blocked, true);

      env.accept(true);
      env.select(second);
      assert.equal(env.confirmations.length, 2);
      assert.equal(env.editor().props.entityId, SECOND);
      assert.equal(env.title(), second);
      assert.equal(env.beforeUnload().blocked, false);
    } finally { await env.close(); }
  });

  test(`creating another ${type} draft remains a guarded new selection`, async (context) => {
    const env = await setup(context, type);
    try {
      env.create();
      const firstId = env.editor().props.entityId;
      assert.equal(env.editor().props.entity, undefined);
      env.edit('Unsaved new draft');
      env.accept(false);
      env.create();
      assert.equal(env.confirmations.length, 1);
      assert.equal(env.editor().props.entityId, firstId);
      assert.equal(env.title(), 'Unsaved new draft');
      assert.equal(env.beforeUnload().blocked, true);

      env.accept(true);
      env.create();
      assert.equal(env.confirmations.length, 2);
      assert.notEqual(env.editor().props.entityId, firstId);
      assert.equal(env.editor().props.entity, undefined);
      assert.equal(env.title(), '');
      assert.equal(env.beforeUnload().blocked, false);
    } finally { await env.close(); }
  });
}

test('the App treats a paper and note sharing an id as different editor selections', async (context) => {
  const env = await setup(context);
  try {
    env.select('Paper A');
    env.edit('Paper draft with a shared id');
    env.accept(false);
    env.selectTyped('note', FIRST);
    assert.equal(env.confirmations.length, 1);
    assert.equal(env.editor().props.type, 'paper');
    assert.equal(env.title(), 'Paper draft with a shared id');
    assert.equal(env.beforeUnload().blocked, true);

    env.accept(true);
    env.selectTyped('note', FIRST);
    assert.equal(env.confirmations.length, 2);
    assert.equal(env.editor().props.type, 'note');
    assert.equal(env.editor().props.entityId, FIRST);
    assert.equal(env.title(), 'Note A');
    assert.equal(env.beforeUnload().blocked, false);
  } finally { await env.close(); }
});

test('returning to the current App section still confirms before unmounting a dirty editor', async (context) => {
  const env = await setup(context, 'note');
  try {
    env.select('Note A');
    env.edit('Draft before returning to its section');
    env.accept(false);
    env.navigate('笔记');
    assert.equal(env.confirmations.length, 1);
    assert.equal(env.title(), 'Draft before returning to its section');
    assert.equal(env.beforeUnload().blocked, true);

    env.accept(true);
    env.navigate('笔记');
    assert.equal(env.confirmations.length, 2);
    assert.equal(env.renderer.root.findAllByType(EntityEditor).length, 0);
    assert.equal(env.beforeUnload().blocked, false);
  } finally { await env.close(); }
});
