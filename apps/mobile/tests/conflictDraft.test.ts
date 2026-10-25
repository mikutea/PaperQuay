import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import {
  createAccountState,
  entityKey,
  type LocalEdit,
  type PendingEdit,
  type PaperData,
  type SyncRecord,
} from '../../../packages/sync-core/src/index.ts';
import { ConflictsView } from '../src/App.tsx';
import type { ServerConflict } from '../src/api.ts';
import { ClientError } from '../src/errors.ts';
import type { WorkspaceController, WorkspaceSnapshot } from '../src/sync/workspace.ts';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CONFLICT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PAPER = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-25T12:00:00.000Z';

function conflict(id = CONFLICT, title = 'First note'): ServerConflict {
  const current: SyncRecord<'note'> = {
    entityType: 'note',
    entityId: NOTE,
    schemaVersion: 1,
    revision: 2,
    deletedAt: null,
    updatedAt: NOW,
    modifiedByDeviceId: DEVICE,
    data: { title, body: 'Remote saved body', paperId: null, format: 'markdown' },
  };
  return {
    conflictId: id,
    entityType: 'note',
    entityId: NOTE,
    createdAt: NOW,
    currentRecord: current,
    observedRecord: current,
    attemptedOperation: {
      opId: crypto.randomUUID(),
      entityType: 'note',
      entityId: NOTE,
      mutation: 'put',
      baseRevision: 1,
      schemaVersion: 1,
      clientCreatedAt: NOW,
      data: { title, body: 'Original local body', paperId: null, format: 'markdown' },
    },
  };
}

function paperConflict(
  mutation: 'put' | 'delete' | 'restore' = 'restore',
  deleted = false,
): ServerConflict {
  const data: PaperData = {
    title: 'Local restored paper',
    doi: '10.1000/local',
    year: '2024',
    publication: 'Local publication',
    abstractText: 'Local abstract',
    authors: ['Local author'],
    keywords: ['local keyword'],
  };
  const current: SyncRecord<'paper'> = {
    entityType: 'paper',
    entityId: PAPER,
    schemaVersion: 1,
    revision: 3,
    deletedAt: deleted ? NOW : null,
    updatedAt: NOW,
    modifiedByDeviceId: DEVICE,
    data: deleted ? null : { ...data, title: 'Restored on another device' },
  };
  return {
    conflictId: CONFLICT,
    entityType: 'paper',
    entityId: PAPER,
    createdAt: NOW,
    currentRecord: current,
    observedRecord: current,
    attemptedOperation: {
      opId: crypto.randomUUID(),
      entityType: 'paper',
      entityId: PAPER,
      mutation,
      baseRevision: 2,
      schemaVersion: 1,
      clientCreatedAt: NOW,
      data: mutation === 'delete' ? null : data,
    },
  };
}

function text(node: ReactTestInstance | string | number): string {
  return typeof node === 'object' ? node.children.map(text).join('') : String(node);
}
function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const found = renderer.root.findAllByType('button').find((entry) => text(entry) === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

function setup(conflicts = [conflict()], overlay?: PendingEdit) {
  const sync = createAccountState(ACCOUNT, DEVICE);
  if (overlay) {
    const entry = conflicts.find(
      (item) => item.entityType === overlay.entityType && item.entityId === overlay.entityId,
    );
    assert.ok(entry);
    const key = entityKey(overlay.entityType, overlay.entityId);
    sync.outbox.push({
      operation: entry.attemptedOperation,
      originDeviceId: DEVICE,
      status: 'conflict',
      attempts: 1,
      errorCode: 'CONFLICT',
      conflictId: entry.conflictId,
    });
    sync.conflicts[entry.conflictId] = {
      conflictId: entry.conflictId,
      attempted: entry.attemptedOperation,
      current: entry.currentRecord,
    };
    if (entry.currentRecord) sync.serverRecords[key] = entry.currentRecord;
    sync.overlays[key] = overlay;
  }
  let snapshot: WorkspaceSnapshot = {
    status: 'ready',
    identity: null,
    workspace: { sync, pendingResolutions: {} },
    syncing: false,
    online: true,
    needsLogin: false,
    devices: [],
    conflicts,
    lastSyncedAt: NOW,
    error: null,
  };
  const dirty: boolean[] = [];
  const resolutions: string[] = [];
  const resolutionCalls: Parameters<WorkspaceController['resolve']>[] = [];
  const saves: LocalEdit[] = [];
  const recoveries: string[] = [];
  const controller = {
    getSnapshot: () => snapshot,
    syncNow: async () => {},
    resolve: async (...args: Parameters<WorkspaceController['resolve']>) => {
      const [entry] = args;
      resolutions.push(entry.conflictId);
      resolutionCalls.push(structuredClone(args));
    },
    save: async (edit: LocalEdit) => {
      saves.push(structuredClone(edit));
    },
  };
  const props = {
    controller,
    onBack: () => {},
    onDirty: (value: boolean) => dirty.push(value),
    onRecovered: (id: string) => recoveries.push(id),
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(ConflictsView, { ...props, state: snapshot }));
  });
  return {
    renderer,
    controller,
    dirty,
    resolutions,
    resolutionCalls,
    saves,
    recoveries,
    editDraft: () =>
      act(() => {
        renderer.root
          .findByType('input')
          .props.onChange({ target: { value: 'Unsaved merge title' } });
        renderer.root
          .findByType('textarea')
          .props.onChange({ target: { value: 'Unsaved merge body with both versions' } });
      }),
    update: (conflicts: ServerConflict[], error: ClientError | null = null, overlay?: PendingEdit) =>
      act(() => {
        snapshot = { ...snapshot, conflicts, error };
        if (overlay) {
          snapshot = {
            ...snapshot,
            workspace: {
              ...snapshot.workspace!,
              sync: {
                ...snapshot.workspace!.sync,
                overlays: {
                  ...snapshot.workspace!.sync.overlays,
                  [entityKey(overlay.entityType, overlay.entityId)]: overlay,
                },
              },
            },
          };
        }
        renderer.update(createElement(ConflictsView, { ...props, state: snapshot }));
      }),
    close: () => act(() => renderer.unmount()),
  };
}

test('using a restored paper version against a reviewed live record submits an explicit put with all metadata', async () => {
  const entry = paperConflict();
  const env = setup([entry]);
  try {
    assert.equal(button(env.renderer, '使用我的版本').props.disabled, false);
    await act(async () => button(env.renderer, '使用我的版本').props.onClick());
    assert.equal(env.resolutionCalls.length, 1);
    const [reviewed, decision] = env.resolutionCalls[0];
    assert.equal(reviewed.currentRecord?.revision, 3);
    assert.deepEqual(decision, {
      choice: 'merged',
      mutation: 'put',
      data: entry.attemptedOperation.data,
    });
  } finally {
    env.close();
  }
});

test('using a restored note version against a reviewed live record submits its saved content as a put', async () => {
  const entry = conflict();
  entry.currentRecord = { ...entry.currentRecord!, revision: 3 } as SyncRecord;
  entry.observedRecord = entry.currentRecord;
  entry.attemptedOperation = { ...entry.attemptedOperation, mutation: 'restore', baseRevision: 2 };
  const env = setup([entry]);
  try {
    await act(async () => button(env.renderer, '使用我的版本').props.onClick());
    const [reviewed, decision] = env.resolutionCalls[0];
    assert.equal(reviewed.currentRecord?.revision, 3);
    assert.deepEqual(decision, {
      choice: 'merged',
      mutation: 'put',
      data: entry.attemptedOperation.data,
    });
  } finally {
    env.close();
  }
});

test('an explicitly restored paper against a reviewed tombstone still submits restore', async () => {
  const entry = paperConflict('restore', true);
  const env = setup([entry]);
  try {
    assert.equal(
      env.renderer.root.findAllByType('button').some((item) => text(item) === '使用我的版本'),
      false,
    );
    await act(async () => button(env.renderer, '明确恢复我的版本').props.onClick());
    const [reviewed, decision] = env.resolutionCalls[0];
    assert.equal(reviewed.currentRecord?.revision, 3);
    assert.equal(reviewed.currentRecord?.deletedAt, NOW);
    assert.deepEqual(decision, {
      choice: 'merged',
      mutation: 'restore',
      data: entry.attemptedOperation.data,
    });
  } finally {
    env.close();
  }
});

for (const mutation of ['put', 'delete'] as const) {
  test(`an ordinary paper ${mutation} decision keeps its attempted-operation semantics`, async () => {
    const entry = paperConflict(mutation);
    const env = setup([entry]);
    try {
      await act(async () => button(env.renderer, '使用我的版本').props.onClick());
      const [reviewed, decision] = env.resolutionCalls[0];
      assert.equal(reviewed.currentRecord?.revision, 3);
      assert.equal(reviewed.attemptedOperation.mutation, mutation);
      assert.deepEqual(decision, { choice: 'attempted' });
    } finally {
      env.close();
    }
  });
}

function paperOverlay(
  mutation: 'put' | 'delete' | 'restore',
  title = 'Latest local paper',
): PendingEdit {
  return {
    entityType: 'paper',
    entityId: PAPER,
    mutation,
    data:
      mutation === 'delete'
        ? null
        : { ...(paperConflict().attemptedOperation.data as PaperData), title },
    opId: crypto.randomUUID(),
    clientCreatedAt: NOW,
  };
}

for (const mutation of ['put', 'delete', 'restore'] as const) {
  test(`a reviewed paper ${mutation} overlay takes priority over the original restore and keeps its consumption identity`, async () => {
    const entry = paperConflict();
    const overlay = paperOverlay(mutation);
    const env = setup([entry], overlay);
    try {
      await act(async () => button(env.renderer, '使用我的版本').props.onClick());
      const [reviewed, decision, consumed] = env.resolutionCalls[0];
      assert.equal(reviewed.currentRecord?.revision, 3);
      assert.deepEqual(decision, {
        choice: 'merged',
        mutation: mutation === 'restore' ? 'put' : mutation,
        data: overlay.data,
      });
      assert.deepEqual(consumed, { consumedOverlayOpId: overlay.opId });
    } finally {
      env.close();
    }
  });
}

test('a refreshed live revision and a newer local overlay require review before resolving with that exact pair', async () => {
  const entry = paperConflict();
  const originalOverlay = paperOverlay('restore', 'Previously reviewed local version');
  const env = setup([entry], originalOverlay);
  try {
    const currentRecord: SyncRecord<'paper'> = {
      ...(entry.currentRecord as SyncRecord<'paper'>),
      revision: 4,
      data: { ...(entry.currentRecord!.data as PaperData), title: 'New remote update' },
    };
    const latestOverlay = paperOverlay('put', 'New local version to keep');
    env.update([{ ...entry, currentRecord }], null, latestOverlay);
    assert.equal(button(env.renderer, '使用我的版本').props.disabled, true);
    act(() => button(env.renderer, '已重新比较当前版本').props.onClick());
    assert.equal(button(env.renderer, '使用我的版本').props.disabled, true);
    act(() => button(env.renderer, '查看本机新保存版本').props.onClick());
    assert.equal(button(env.renderer, '使用我的版本').props.disabled, false);
    assert.equal(env.resolutionCalls.length, 0);
    await act(async () => button(env.renderer, '使用我的版本').props.onClick());
    const [reviewed, decision, consumed] = env.resolutionCalls[0];
    assert.equal(reviewed.currentRecord?.revision, 4);
    assert.deepEqual(decision, { choice: 'merged', mutation: 'put', data: latestOverlay.data });
    assert.deepEqual(consumed, { consumedOverlayOpId: latestOverlay.opId });
    assert.notEqual(consumed?.consumedOverlayOpId, originalOverlay.opId);
  } finally {
    env.close();
  }
});

test('the actual conflict view preserves a dirty merge when the final remote conflict closes', () => {
  const env = setup();
  try {
    env.editDraft();
    env.update([]);
    assert.equal(env.renderer.root.findByType('input').props.value, 'Unsaved merge title');
    assert.equal(
      env.renderer.root.findByType('textarea').props.value,
      'Unsaved merge body with both versions',
    );
    assert.equal(env.dirty.at(-1), true);
    assert.match(text(env.renderer.root), /此冲突已在服务端关闭/);
    assert.equal(button(env.renderer, '保存合并版本').props.disabled, true);
    assert.equal(button(env.renderer, '保留当前版本').props.disabled, true);
    assert.equal(button(env.renderer, '使用我的版本').props.disabled, true);
  } finally {
    env.close();
  }
});

test('another open conflict never replaces the selected dirty merge during a list refresh', () => {
  const next = conflict(SECOND, 'Second note');
  const env = setup([conflict(), next]);
  try {
    env.editDraft();
    env.update([next]);
    assert.equal(env.renderer.root.findByType('select').props.value, CONFLICT);
    assert.equal(env.renderer.root.findByType('input').props.value, 'Unsaved merge title');
    assert.equal(
      env.renderer.root.findByType('textarea').props.value,
      'Unsaved merge body with both versions',
    );
    assert.equal(env.dirty.at(-1), true);
  } finally {
    env.close();
  }
});

test('switching away from a remotely closed dirty draft requires explicit discard confirmation', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const next = conflict(SECOND, 'Second note');
  const env = setup([conflict(), next]);
  let discard = false;
  let confirmations = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      confirm: () => {
        confirmations += 1;
        return discard;
      },
    },
  });
  try {
    env.editDraft();
    env.update([next]);
    act(() => env.renderer.root.findByType('select').props.onChange({ target: { value: SECOND } }));
    assert.equal(confirmations, 1);
    assert.equal(
      env.renderer.root.findByType('textarea').props.value,
      'Unsaved merge body with both versions',
    );
    assert.equal(env.dirty.at(-1), true);
    discard = true;
    act(() => env.renderer.root.findByType('select').props.onChange({ target: { value: SECOND } }));
    assert.equal(confirmations, 2);
    assert.equal(env.renderer.root.findByType('input').props.value, 'Second note');
    assert.doesNotMatch(text(env.renderer.root), /此冲突已在服务端关闭/);
    assert.equal(env.dirty.at(-1), false);
  } finally {
    env.close();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('a stale resolve handler refuses a conflict that closed after the button was rendered', async () => {
  const env = setup();
  try {
    env.editDraft();
    const staleResolve = button(env.renderer, '保存合并版本').props.onClick;
    env.update([]);
    await act(async () => {
      staleResolve();
    });
    assert.deepEqual(env.resolutions, []);
    assert.equal(
      env.renderer.root.findByType('textarea').props.value,
      'Unsaved merge body with both versions',
    );
    assert.equal(env.dirty.at(-1), true);
  } finally {
    env.close();
  }
});

test('a merge rejected during remote closure does not mark the unsaved draft as completed', async () => {
  const env = setup();
  try {
    env.editDraft();
    env.controller.resolve = async () => {
      env.update([], new ClientError('CONFLICT_CHANGED'));
    };
    await act(async () => {
      button(env.renderer, '保存合并版本').props.onClick();
    });
    assert.equal(
      env.renderer.root.findByType('textarea').props.value,
      'Unsaved merge body with both versions',
    );
    assert.equal(env.dirty.at(-1), true);
    assert.equal(button(env.renderer, '保存合并版本').props.disabled, true);
  } finally {
    env.close();
  }
});

test('a locally confirmed merge still clears the completed draft and shows the remaining conflict', async () => {
  const next = conflict(SECOND, 'Second note');
  const env = setup([conflict(), next]);
  try {
    env.editDraft();
    env.controller.resolve = async () => {
      env.update([next]);
    };
    await act(async () => {
      button(env.renderer, '保存合并版本').props.onClick();
    });
    assert.equal(env.renderer.root.findByType('input').props.value, 'Second note');
    assert.equal(env.dirty.at(-1), false);
    assert.doesNotMatch(text(env.renderer.root), /此冲突已在服务端关闭/);
  } finally {
    env.close();
  }
});

test('recovering a closed conflict waits for local persistence before opening the new note', async () => {
  const env = setup();
  let committed!: () => void;
  env.controller.save = async (edit) => {
    env.saves.push(structuredClone(edit));
    await new Promise<void>((resolve) => {
      committed = resolve;
    });
  };
  try {
    env.editDraft();
    env.update([]);
    act(() => {
      button(env.renderer, '另存为新笔记').props.onClick();
    });
    assert.deepEqual(env.recoveries, []);
    assert.equal(env.dirty.at(-1), true);
    assert.equal(button(env.renderer, '另存为新笔记').props.disabled, true);
    assert.equal(env.saves.length, 1);
    assert.notEqual(env.saves[0].entityId, NOTE);
    assert.deepEqual(env.saves[0].data, {
      title: 'Unsaved merge title',
      body: 'Unsaved merge body with both versions',
      paperId: null,
      format: 'markdown',
    });
    await act(async () => {
      committed();
    });
    assert.deepEqual(env.recoveries, [env.saves[0].entityId]);
    assert.equal(env.dirty.at(-1), false);
    assert.deepEqual(env.resolutions, []);
  } finally {
    env.close();
  }
});

test('a failed recovery keeps the merge text and navigation dirty guard intact', async () => {
  const env = setup();
  env.controller.save = async () => {
    throw new ClientError('STORAGE_UNAVAILABLE');
  };
  try {
    env.editDraft();
    env.update([]);
    await act(async () => {
      button(env.renderer, '另存为新笔记').props.onClick();
    });
    assert.deepEqual(env.recoveries, []);
    assert.equal(env.renderer.root.findByType('input').props.value, 'Unsaved merge title');
    assert.equal(
      env.renderer.root.findByType('textarea').props.value,
      'Unsaved merge body with both versions',
    );
    assert.equal(env.dirty.at(-1), true);
    assert.equal(button(env.renderer, '另存为新笔记').props.disabled, false);
    assert.ok(env.renderer.root.findAllByProps({ role: 'alert' }).length);
  } finally {
    env.close();
  }
});

for (const operation of ['recovery', 'resolution'] as const) {
  test(`a delayed ${operation} cannot clear parent dirty state or navigate after unmount`, async () => {
    const env = setup();
    let complete!: () => void;
    let finished = false;
    const pause = async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      finished = true;
    };
    if (operation === 'recovery') env.controller.save = pause;
    else env.controller.resolve = pause;
    try {
      env.editDraft();
      if (operation === 'recovery') env.update([]);
      act(() => {
        button(
          env.renderer,
          operation === 'recovery' ? '另存为新笔记' : '保存合并版本',
        ).props.onClick();
      });
      env.close();
      const afterUnmount = [...env.dirty];
      const snapshot = env.controller.getSnapshot();
      env.controller.getSnapshot = () => ({ ...snapshot, conflicts: [] });
      await act(async () => {
        complete();
      });
      assert.equal(finished, true, 'the already-started persistence or server request may finish');
      assert.deepEqual(env.dirty, afterUnmount);
      assert.deepEqual(env.recoveries, []);
    } finally {
      env.close();
    }
  });

  test(`a delayed ${operation} cannot change a newly selected conflict draft`, async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { confirm: () => true },
    });
    const next = conflict(SECOND, 'Second note');
    const env = setup([conflict(), next]);
    let complete!: () => void;
    const pause = async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
    };
    if (operation === 'recovery') env.controller.save = pause;
    else env.controller.resolve = pause;
    try {
      env.editDraft();
      if (operation === 'recovery') env.update([next]);
      act(() => {
        button(
          env.renderer,
          operation === 'recovery' ? '另存为新笔记' : '保存合并版本',
        ).props.onClick();
      });
      act(() =>
        env.renderer.root.findByType('select').props.onChange({ target: { value: SECOND } }),
      );
      assert.equal(env.renderer.root.findByType('textarea').props.disabled, false);
      act(() =>
        env.renderer.root
          .findByType('textarea')
          .props.onChange({ target: { value: 'A different unsaved draft' } }),
      );
      env.update([next]);
      const beforeCompletion = [...env.dirty];
      await act(async () => {
        complete();
      });
      assert.equal(
        env.renderer.root.findByType('textarea').props.value,
        'A different unsaved draft',
      );
      assert.deepEqual(env.dirty, beforeCompletion);
      assert.equal(env.dirty.at(-1), true);
      assert.deepEqual(env.recoveries, []);
    } finally {
      env.close();
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}
