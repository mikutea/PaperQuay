import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createAccountState, entityKey, type LocalEdit, type NoteData, type SyncRecord, type VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import { EntityEditor } from '../src/components/EntityEditor.tsx';
import { ClientError } from '../src/errors.ts';
import type { WorkspaceSnapshot } from '../src/sync/workspace.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const data = (body: string): NoteData => ({ title: 'Note', body, paperId: null, format: 'markdown' });
const record = (body: string, revision = 2): SyncRecord<'note'> => ({ entityType: 'note', entityId: id(3), data: data(body), revision,
  schemaVersion: 1, deletedAt: null, updatedAt: '2026-10-25T10:00:00.000Z', modifiedByDeviceId: id(2) });
function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function setup(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const originals = new Map(['window', 'document'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = Object.assign(new EventTarget(), { confirm: () => true });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  let current: VisibleEntity = { ...record('Original'), deleted: false, pending: false, status: 'synced' };
  const sync = createAccountState(id(1), id(2));
  sync.serverRecords[entityKey('note', id(3))] = record('Original');
  const snapshot: WorkspaceSnapshot = { status: 'ready', identity: null, workspace: { sync, pendingResolutions: {} },
    syncing: false, online: false, needsLogin: false, devices: [], conflicts: [], lastSyncedAt: null, error: null };
  const calls: { edit: LocalEdit; revision?: number; gate: ReturnType<typeof deferred> }[] = [];
  const controller = { getSnapshot: () => snapshot, save: async (edit: LocalEdit, revision?: number) => {
    const gate = deferred(); calls.push({ edit: structuredClone(edit), revision, gate }); await gate.promise;
  } };
  const dirty: boolean[] = [];
  const onDirty = (value: boolean) => { dirty.push(value); };
  const element = () => createElement(EntityEditor, { type: 'note', entityId: id(3), entity: current, papers: [], controller,
    hasConflict: false, onBack: () => {}, onConflicts: () => {}, onDirty });
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(element()); });
  context.after(() => {
    act(() => renderer.unmount()); context.mock.timers.reset();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { renderer, calls, dirty, doc, win,
    edit: (body: string) => act(() => renderer.root.findByProps({ id: 'note-body' }).props.onChange({ target: { value: body } })),
    tick: async (ms = 600) => { await act(async () => context.mock.timers.tick(ms)); },
    finish: async (index: number, error?: Error) => { await act(async () => error ? calls[index].gate.reject(error) : calls[index].gate.resolve()); },
    remote: (body: string, revision: number) => {
      sync.serverRecords[entityKey('note', id(3))] = record(body, revision);
      current = { ...record(body, revision), deleted: false, pending: false, status: 'synced' };
      act(() => renderer.update(element()));
    },
  };
}

test('autosave debounces rapid input and confirms saved only after the local commit', async (context) => {
  const env = setup(context);
  env.edit('One'); await env.tick(400); env.edit('Two'); await env.tick(599);
  assert.equal(env.calls.length, 0);
  await env.tick(1);
  assert.equal(env.calls.length, 1);
  assert.equal((env.calls[0].edit.data as NoteData).body, 'Two');
  assert.equal(env.dirty.at(-1), true);
  assert.equal(env.renderer.root.findByType('fieldset').props.disabled, false);
  await env.finish(0);
  assert.equal(env.dirty.at(-1), false);
});

test('typing during an autosave preserves the newer draft and schedules a successor', async (context) => {
  const env = setup(context);
  env.edit('First'); await env.tick(); env.edit('Newer'); await env.finish(0);
  assert.equal(env.dirty.at(-1), true);
  assert.equal(env.renderer.root.findByProps({ id: 'note-body' }).props.value, 'Newer');
  await env.tick();
  assert.equal(env.calls.length, 2);
  assert.equal((env.calls[1].edit.data as NoteData).body, 'Newer');
  await env.finish(1); assert.equal(env.dirty.at(-1), false);
});

test('a failed local commit keeps the draft and requires an edit or explicit retry instead of looping', async (context) => {
  const env = setup(context);
  env.edit('Keep me'); await env.tick(); await env.finish(0, new ClientError('STORAGE_FAILED'));
  await env.tick(60_000);
  assert.equal(env.calls.length, 1);
  assert.equal(env.dirty.at(-1), true);
  assert.equal(env.renderer.root.findAllByProps({ role: 'alert' }).length, 1);
  env.edit('Retry me'); await env.tick(); await env.finish(1);
  assert.equal(env.dirty.at(-1), false);
});

test('backgrounding flushes a dirty note before its normal debounce deadline', async (context) => {
  const env = setup(context);
  env.edit('Before background');
  await act(async () => { env.doc.visibilityState = 'hidden'; env.doc.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(env.calls.length, 1);
  await env.finish(0);
  env.edit('Before pagehide');
  await act(async () => { env.win.dispatchEvent(new Event('pagehide')); });
  assert.equal(env.calls.length, 2);
  await env.finish(1);
});

test('an own acknowledged autosave advances the draft base while a different remote body requires comparison', async (context) => {
  const env = setup(context);
  env.edit('First'); await env.tick(); env.edit('Successor'); await env.finish(0);
  env.remote('First', 3); await env.tick();
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[1].revision, 3);
  await env.finish(1);
  env.edit('Keep local'); env.remote('Another device wrote this', 4); await env.tick(5000);
  assert.equal(env.calls.length, 2);
  assert.equal(env.renderer.root.findByProps({ id: 'note-body' }).props.value, 'Keep local');
  assert.equal(env.renderer.root.findAllByProps({ className: 'draft-review' }).length, 1);
});
