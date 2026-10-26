import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { IDBFactory } from 'fake-indexeddb';
import { createAccountState } from '../../../packages/sync-core/src/index.ts';
import { PaperReader } from '../src/components/PaperReader.tsx';
import { getPdfCache } from '../src/pdf/cache.ts';
import type { PaperReaderProps } from '../src/pdf/types.ts';

async function microtasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function fixture() {
  const names = ['window', 'document', 'indexedDB'] as const;
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const values = {
    window: Object.assign(new EventTarget(), { confirm: () => true }),
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    indexedDB: new IDBFactory(),
  };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  const returns: string[] = [];
  const notifications: { account: string; dirty: boolean }[] = [];
  function propsFor(account: string): PaperReaderProps {
    const scope = { apiBaseUrl: 'https://sync.example.invalid', accountId: crypto.randomUUID() };
    const sync = createAccountState(scope.accountId, crypto.randomUUID());
    return {
      scope,
      paper: {
        entityType: 'paper', entityId: crypto.randomUUID(), revision: 1, deleted: false, pending: false, status: 'synced',
        data: { title: 'Synthetic paper', authors: [], year: null, doi: null, publication: null, keywords: [], abstractText: null },
      },
      attachmentVersions: [], annotations: [], positions: [],
      controller: {
        getSnapshot: () => ({
          status: 'ready', identity: null, workspace: { sync, pendingResolutions: {} }, syncing: false,
          online: true, needsLogin: false, devices: [], conflicts: [], lastSyncedAt: null, error: null,
        }),
        save: async () => { assert.fail('This lifecycle fixture must not persist anything'); },
      },
      onBack: () => returns.push(account),
      onDirtyChange: (dirty) => notifications.push({ account, dirty }),
    };
  }
  const first = propsFor('first');
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(PaperReader, { ...first, key: first.scope.accountId }));
    await getPdfCache().list(first.scope);
  });
  return {
    renderer, returns, notifications, propsFor,
    back: () => renderer.root.findByProps({ 'aria-label': '返回文库' }).props.onClick(),
    async close() {
      await act(async () => { renderer.unmount(); await new Promise<void>((resolve) => setImmediate(resolve)); });
      for (const name of names) {
        const original = originals.get(name);
        if (original) Object.defineProperty(globalThis, name, original);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('the actual reader returns once when its async continuation still belongs to the mounted reader', async () => {
  const env = await fixture();
  try {
    await act(async () => { env.back(); await microtasks(); });
    assert.deepEqual(env.returns, ['first']);
  } finally { await env.close(); }
});

test('an actual reader return cannot call its parent after unmount commit but before passive cleanup', async () => {
  const env = await fixture();
  try {
    env.back();
    // Do not wrap this commit in act: flushing passive effects would hide the race.
    env.renderer.unmount();
    const notifications = [...env.notifications];
    await microtasks();
    assert.deepEqual(env.returns, []);
    assert.deepEqual(env.notifications, notifications);
  } finally { await env.close(); }
});

test('an account replacement retires the old reader return before passive cleanup and leaves the new reader usable', async () => {
  const env = await fixture();
  try {
    env.back();
    const replacement = env.propsFor('replacement');
    // The app keys readers by account/device/generation; preserve that remount boundary.
    env.renderer.update(createElement(PaperReader, { ...replacement, key: replacement.scope.accountId }));
    const notifications = [...env.notifications];
    await microtasks();
    assert.deepEqual(env.returns, []);
    assert.deepEqual(env.notifications, notifications);
    await act(async () => { await getPdfCache().list(replacement.scope); });
    await act(async () => { env.back(); await microtasks(); });
    assert.deepEqual(env.returns, ['replacement']);
  } finally { await env.close(); }
});
