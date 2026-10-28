import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { createAccountState, entityKey, type PaperData, type SyncRecord } from '../../../packages/sync-core/src/index.ts';
import { ExternalLibraryPanel } from '../src/components/ExternalLibraryPanel.tsx';
import { materializeExternalLibraryImport, planExternalLibraryImport, type ExternalLibrarySnapshot } from '../src/library/externalLibrary.ts';
import { type StoredWorkspace, type WorkspaceController, type WorkspaceSnapshot } from '../src/sync/workspace.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-10-28T04:00:00.000Z';
const paper = (title: string): PaperData => ({ title, doi: '10.1234/ui', authors: ['Author'], year: '2026', publication: null, abstractText: null, keywords: [] });
function input(title = 'Incoming', version = 2): ExternalLibrarySnapshot {
  return { format: 'paperquay-external-library', version: 1, source: { kind: 'external', key: 'ui-source', name: 'UI source' },
    items: [{ key: 'item-one', version, data: paper(title) }] };
}
function record(title: string, revision = 2): SyncRecord<'paper'> {
  return { entityType: 'paper', entityId: id(10), schemaVersion: 1, revision, updatedAt: NOW, deletedAt: null, modifiedByDeviceId: id(2), data: paper(title) };
}
function fixture(mapped = true) {
  const sync = createAccountState(id(1), id(2)); sync.serverRecords[entityKey('paper', id(10))] = record('Local first');
  const seedPlan = planExternalLibraryImport(input('Base', 1), undefined, []);
  const registry = materializeExternalLibraryImport(seedPlan, () => id(10)).newRegistry;
  let state: WorkspaceSnapshot = { status: 'ready', identity: null, workspace: { sync, pendingResolutions: {}, ...(mapped ? { externalLibraries: registry } : {}) },
    syncing: false, online: true, needsLogin: false, devices: [], conflicts: [], lastSyncedAt: null, error: null };
  const listeners = new Set<() => void>(); const calls: unknown[][] = [];
  let accountActive = true;
  const controller = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    importExternalLibrary: async (...args: unknown[]) => { calls.push(args); return { newPapers: 0, linkedPapers: 0, updatedPapers: 1 }; },
  } as unknown as WorkspaceController;
  const publish = (title: string, revision = 3) => {
    state = { ...state, workspace: { ...state.workspace!, sync: { ...state.workspace!.sync,
      serverRecords: { [entityKey('paper', id(10))]: record(title, revision) } } } };
    listeners.forEach((listener) => listener());
  };
  const props = { controller, scopeKey: JSON.stringify([id(1), id(2), 1]), accountCurrent: () => accountActive, onBusyChange: () => undefined };
  return { props, calls, publish, signOut: () => { accountActive = false; } };
}
function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}
function button(view: ReactTestRenderer, label: string) {
  return view.root.findAllByType('button').find((node) => text(node) === label)!;
}
async function upload(view: ReactTestRenderer, snapshot = input()) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  await act(async () => { await view.root.findByProps({ 'aria-label': '选择外部文库快照' }).props.onChange({ currentTarget: {
    files: [{ name: 'snapshot.json', size: bytes.length, arrayBuffer: async () => bytes.buffer }], value: 'snapshot.json',
  } }); });
}
function selectFor(view: ReactTestRenderer, label: string) {
  const node = view.root.findAllByType('label').find((entry) => text(entry) === label)!;
  return view.root.findAllByType('select').find((entry) => entry.props.id === node.props.htmlFor)!;
}

test('a reviewed conflict decision cannot silently apply to a later local revision', async () => {
  const f = fixture(); let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(ExternalLibraryPanel, f.props)); });
  try {
    await upload(view);
    await act(async () => selectFor(view, '冲突字段的处理').props.onChange({ target: { value: 'prefer-source' } }));
    assert.equal(button(view, '确认保存这次更新').props.disabled, false);
    await act(async () => f.publish('Local changed after decision'));
    assert.equal(button(view, '确认保存这次更新').props.disabled, true);
    assert.ok(view.root.findAllByProps({ role: 'alert' }).some((node) => text(node).includes('预览已过期')));
    await act(async () => button(view, '确认保存这次更新').props.onClick());
    assert.equal(f.calls.length, 0);
    await act(async () => button(view, '重新比较当前文库').props.onClick());
    assert.equal(selectFor(view, '冲突字段的处理').props.value, '');
    assert.equal(button(view, '确认保存这次更新').props.disabled, true);
    assert.ok(view.root.findAllByType('dd').some((node) => text(node) === 'Local changed after decision'));
    await act(async () => selectFor(view, '冲突字段的处理').props.onChange({ target: { value: 'prefer-local' } }));
    await act(async () => button(view, '确认保存这次更新').props.onClick());
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][3], f.props.scopeKey);
    assert.deepEqual(f.calls[0][1], [{ itemKey: 'item-one', action: 'import', resolution: 'prefer-local' }]);
  } finally { await act(async () => view.unmount()); }
});

test('a reviewed duplicate link is cleared after the target changes rather than adopting a new preview signature', async () => {
  const f = fixture(false); let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(ExternalLibraryPanel, f.props)); });
  try {
    await upload(view);
    await act(async () => selectFor(view, '处理「Incoming」').props.onChange({ target: { value: `link:${id(10)}` } }));
    await act(async () => selectFor(view, '冲突字段的处理').props.onChange({ target: { value: 'prefer-source' } }));
    await act(async () => f.publish('Later local duplicate'));
    assert.equal(button(view, '确认保存这次更新').props.disabled, true);
    await act(async () => button(view, '重新比较当前文库').props.onClick());
    assert.equal(selectFor(view, '处理「Incoming」').props.value, 'default');
    assert.equal(button(view, '确认保存这次更新').props.disabled, true);
    assert.equal(f.calls.length, 0);
  } finally { await act(async () => view.unmount()); }
});

test('changing account discards a file read that completes late', async () => {
  const f = fixture(); let view!: ReactTestRenderer; let release!: (value: ArrayBuffer) => void;
  await act(async () => { view = create(React.createElement(ExternalLibraryPanel, f.props)); });
  const bytes = new TextEncoder().encode(JSON.stringify(input()));
  const waiting = new Promise<ArrayBuffer>((done) => { release = done; });
  await act(async () => view.root.findByProps({ 'aria-label': '选择外部文库快照' }).props.onChange({ currentTarget: {
    files: [{ name: 'later.json', size: bytes.length, arrayBuffer: () => waiting }], value: 'later.json',
  } }));
  f.signOut(); await act(async () => { release(bytes.buffer); await waiting; });
  assert.equal(view.root.findAllByProps({ 'aria-label': '外部文库更新预览' }).length, 0);
  assert.equal(f.calls.length, 0); await act(async () => view.unmount());
});
