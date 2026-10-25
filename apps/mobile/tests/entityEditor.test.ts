import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import {
  createAccountState,
  type LocalEdit,
  type VisibleEntity,
} from '../../../packages/sync-core/src/index.ts';
import { EntityEditor } from '../src/components/EntityEditor.tsx';
import { ClientError } from '../src/errors.ts';
import type { WorkspaceSnapshot } from '../src/sync/workspace.ts';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FIRST = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SECOND = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
type Action = 'save' | 'delete' | 'restore';
type Outcome = 'saved' | 'failed';

function note(id = FIRST, deleted = false): VisibleEntity {
  return {
    entityType: 'note', entityId: id, revision: 2, deleted, pending: false, status: 'synced',
    data: { title: id === FIRST ? 'First note' : 'Second note', body: 'Saved body', paperId: null, format: 'markdown' },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function makeController() {
  const snapshot: WorkspaceSnapshot = {
    status: 'ready', identity: null,
    workspace: { sync: createAccountState(ACCOUNT, DEVICE), pendingResolutions: {} },
    syncing: false, online: true, needsLogin: false, devices: [], conflicts: [],
    lastSyncedAt: null, error: null,
  };
  const calls: { edit: LocalEdit; revision?: number; gate: ReturnType<typeof deferred>; outcome: 'pending' | Outcome }[] = [];
  const controller = {
    getSnapshot: () => snapshot,
    save: async (edit: LocalEdit, revision?: number) => {
      const call: (typeof calls)[number] = { edit: structuredClone(edit), revision, gate: deferred(), outcome: 'pending' };
      calls.push(call);
      try {
        await call.gate.promise;
        call.outcome = 'saved';
      } catch (error) {
        call.outcome = 'failed';
        throw error;
      }
    },
  };
  return { controller, calls };
}

function text(node: ReactTestInstance | string | number): string {
  return typeof node === 'object' ? node.children.map(text).join('') : String(node);
}

function setup(action: Action) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } });
  const first = makeController();
  let current = note(FIRST, action === 'restore');
  let controller = first.controller;
  let mount = 0;
  let closed = false;
  const dirty: boolean[] = [];
  let backs = 0;
  const onDirty = (value: boolean) => { dirty.push(value); };
  const onBack = () => { backs += 1; };
  const render = () => createElement(EntityEditor, {
    key: mount, type: 'note', entityId: current.entityId, entity: current, papers: [],
    controller,
    hasConflict: false, onDirty, onBack, onConflicts: () => {},
  });
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(render()); });
  const button = (label: string) => {
    const found = renderer.root.findAllByType('button').find((entry) => text(entry) === label);
    assert.ok(found, `Missing button: ${label}`);
    return found;
  };
  const edit = (body: string) => act(() => {
    renderer.root.findByProps({ id: 'note-body' }).props.onChange({ target: { value: body } });
  });
  const start = (operation: Action) => {
    if (operation === 'save') edit('First operation draft');
    act(() => {
      if (operation === 'save') renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
      else if (operation === 'delete') renderer.root.findByProps({ 'aria-label': '删除此条内容' }).props.onClick();
      else button('恢复此版本').props.onClick();
    });
  };
  return {
    first, renderer, dirty, edit, start, button,
    backs: () => backs,
    replace: (entity: VisibleEntity, remount: boolean, replacement = controller) => act(() => {
      current = entity;
      controller = replacement;
      if (remount) mount += 1;
      renderer.update(render());
    }),
    close: () => {
      if (!closed) { act(() => renderer.unmount()); closed = true; }
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

async function finish(call: ReturnType<typeof makeController>['calls'][number], outcome: Outcome) {
  await act(async () => {
    if (outcome === 'saved') call.gate.resolve();
    else call.gate.reject(new ClientError('STORAGE_UNAVAILABLE'));
  });
  assert.equal(call.outcome, outcome, 'the original persistence operation must still settle');
}

for (const action of ['save', 'delete', 'restore'] as const) {
  for (const remount of [true, false]) {
    test(`a delayed ${action} cannot clear B's draft after ${remount ? 'unmounting A' : 'reusing the editor for B'}`, async () => {
      const env = setup(action);
      try {
        env.start(action);
        const old = env.first.calls[0];
        assert.equal(old.edit.entityId, FIRST);
        env.replace(note(SECOND), remount);
        assert.equal(env.renderer.root.findByType('fieldset').props.disabled, false);
        env.edit('B has an unsaved draft');
        const before = [...env.dirty];
        await finish(old, 'saved');
        assert.equal(env.renderer.root.findByProps({ id: 'note-body' }).props.value, 'B has an unsaved draft');
        assert.deepEqual(env.dirty, before);
        assert.equal(env.dirty.at(-1), true);
        assert.equal(env.backs(), 0);
        assert.equal(env.renderer.root.findAllByProps({ role: 'alert' }).length, 0);
      } finally { env.close(); }
    });
  }

  test(`a delayed ${action} rejection cannot surface an error in a replacement editor`, async () => {
    const env = setup(action);
    try {
      env.start(action);
      const old = env.first.calls[0];
      env.replace(note(SECOND), false);
      env.edit('B draft survives a rejected A operation');
      const before = [...env.dirty];
      await finish(old, 'failed');
      assert.equal(env.renderer.root.findByProps({ id: 'note-body' }).props.value, 'B draft survives a rejected A operation');
      assert.deepEqual(env.dirty, before);
      assert.equal(env.dirty.at(-1), true);
      assert.equal(env.renderer.root.findAllByProps({ role: 'alert' }).length, 0);
      assert.equal(env.backs(), 0);
    } finally { env.close(); }
  });

  test(`a delayed ${action} finally cannot enable B's editor while B is saving`, async () => {
    const env = setup(action);
    try {
      env.start(action);
      const old = env.first.calls[0];
      env.replace(note(SECOND), false);
      env.start('save');
      const current = env.first.calls[1];
      assert.equal(current.edit.entityId, SECOND);
      await finish(old, 'failed');
      assert.equal(env.renderer.root.findByType('fieldset').props.disabled, true);
      assert.equal(env.renderer.root.findAllByProps({ role: 'alert' }).length, 0);
      await finish(current, 'saved');
      assert.equal(env.renderer.root.findByType('fieldset').props.disabled, false);
      assert.equal(env.dirty.at(-1), false);
    } finally { env.close(); }
  });
}

test('reopening the same record creates a new session that an old delete cannot close', async () => {
  const env = setup('delete');
  try {
    env.start('delete');
    env.replace(note(FIRST), true);
    env.edit('A reopened with a different draft');
    const before = [...env.dirty];
    await finish(env.first.calls[0], 'saved');
    assert.equal(env.renderer.root.findByProps({ id: 'note-body' }).props.value, 'A reopened with a different draft');
    assert.deepEqual(env.dirty, before);
    assert.equal(env.backs(), 0);
  } finally { env.close(); }
});

test('replacing the controller invalidates an old operation even for the same entity', async () => {
  const env = setup('save');
  const replacement = makeController();
  try {
    env.start('save');
    env.replace(note(FIRST), false, replacement.controller);
    assert.equal(env.renderer.root.findByType('fieldset').props.disabled, false);
    env.edit('Draft in the replacement controller');
    const before = [...env.dirty];
    await finish(env.first.calls[0], 'saved');
    assert.equal(env.renderer.root.findByProps({ id: 'note-body' }).props.value, 'Draft in the replacement controller');
    assert.deepEqual(env.dirty, before);
    assert.equal(replacement.calls.length, 0);
  } finally { env.close(); }
});

test('a current editor still exposes a failed save and allows retry', async () => {
  const env = setup('save');
  try {
    env.start('save');
    await finish(env.first.calls[0], 'failed');
    assert.equal(env.renderer.root.findByType('fieldset').props.disabled, false);
    assert.equal(env.renderer.root.findAllByProps({ role: 'alert' }).length, 1);
    assert.equal(env.dirty.at(-1), true);
    assert.equal(env.renderer.root.findByProps({ id: 'note-body' }).props.value, 'First operation draft');
  } finally { env.close(); }
});

test('a current editor still returns after its own delete commits', async () => {
  const env = setup('delete');
  try {
    env.start('delete');
    assert.equal(env.backs(), 0);
    await finish(env.first.calls[0], 'saved');
    assert.equal(env.backs(), 1);
    assert.equal(env.dirty.at(-1), false);
  } finally { env.close(); }
});
