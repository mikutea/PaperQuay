import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import {
  createAccountState,
  type LocalEdit,
  type SyncRecord,
} from '../../../packages/sync-core/src/index.ts';
import { ConflictsView } from '../src/App.tsx';
import type { ServerConflict } from '../src/api.ts';
import { ClientError } from '../src/errors.ts';
import type { WorkspaceSnapshot } from '../src/sync/workspace.ts';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CONFLICT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
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

function text(node: ReactTestInstance | string | number): string {
  return typeof node === 'object' ? node.children.map(text).join('') : String(node);
}
function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const found = renderer.root.findAllByType('button').find((entry) => text(entry) === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

function setup(conflicts = [conflict()]) {
  let snapshot: WorkspaceSnapshot = {
    status: 'ready',
    identity: null,
    workspace: { sync: createAccountState(ACCOUNT, DEVICE), pendingResolutions: {} },
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
  const saves: LocalEdit[] = [];
  const recoveries: string[] = [];
  const controller = {
    getSnapshot: () => snapshot,
    syncNow: async () => {},
    resolve: async (entry: ServerConflict) => {
      resolutions.push(entry.conflictId);
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
    update: (conflicts: ServerConflict[], error: ClientError | null = null) =>
      act(() => {
        snapshot = { ...snapshot, conflicts, error };
        renderer.update(createElement(ConflictsView, { ...props, state: snapshot }));
      }),
    close: () => act(() => renderer.unmount()),
  };
}

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
