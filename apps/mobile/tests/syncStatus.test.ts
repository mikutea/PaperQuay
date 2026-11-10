import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson, createAccountState, getSyncContext, preparePush, queueLocalEdit, rebindDevice,
} from '../../../packages/sync-core/src/index.ts';
import type { WorkspaceSnapshot } from '../src/sync/workspace.ts';
import { syncSummary } from '../src/viewState.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-11-10T08:00:00.000Z';
function snapshot(sent = false): WorkspaceSnapshot {
  const old = queueLocalEdit(createAccountState(id(1), id(2)), {
    entityType: 'readingPosition', entityId: id(3), mutation: 'put', data: {
      paperId: id(4), attachmentVersionId: id(5), pageIndex: 1, offsetRatio: 0.2,
      furthestPageIndex: 1, furthestOffsetRatio: 0.2, sessionId: id(6), deviceSequence: 1, observedAt: at,
    },
  }, { opId: id(7), clientCreatedAt: at });
  return { status: 'ready', identity: null,
    workspace: { sync: rebindDevice(sent ? preparePush(old, getSyncContext(old)).state : old, id(8)), pendingResolutions: {} },
    syncing: false, online: true, needsLogin: false, devices: [], conflicts: [], lastSyncedAt: at, error: null };
}
function addNote(state: WorkspaceSnapshot) {
  state.workspace!.sync = queueLocalEdit(state.workspace!.sync, {
    entityType: 'note', entityId: id(9), mutation: 'put',
    data: { title: 'Current note', body: 'Saved locally', format: 'markdown', paperId: null },
  }, { opId: id(10), clientCreatedAt: at });
}

test('rebound checkpoints are described as local without deleting or relabelling their stored operations', () => {
  for (const sent of [false, true]) {
    const state = snapshot(sent), before = canonicalJson(state.workspace!.sync);
    const result = syncSummary(state, 0);
    assert.equal(result.label, '旧阅读位置已保留在本机');
    assert.equal(result.needsAttention, false);
    assert.equal(result.icon, 'device');
    assert.equal(result.pending, 0);
    assert.equal(result.retained.length, 1);
    assert.deepEqual(result.blocked, []);
    assert.equal(canonicalJson(state.workspace!.sync), before);
    const prepared = preparePush(state.workspace!.sync, getSyncContext(state.workspace!.sync));
    assert.deepEqual(prepared.request.operations, []);
    assert.equal(prepared.state.outbox[0].status, 'device-blocked');
  }
});

test('current-device note work is counted and sent while the old checkpoint remains local', () => {
  const state = snapshot(); addNote(state);
  const result = syncSummary(state, 0);
  assert.equal(result.label, '1 项待同步');
  assert.equal(result.pending, 1);
  assert.equal(result.retained.length, 1);
  const prepared = preparePush(state.workspace!.sync, getSyncContext(state.workspace!.sync));
  assert.deepEqual(prepared.request.operations.map(op => op.entityType), ['note']);
});

test('a rejected current note still raises attention alongside a retained checkpoint', () => {
  const state = snapshot(); addNote(state);
  const entry = state.workspace!.sync.outbox.find(e => e.operation.entityType === 'note')!;
  entry.status = 'rejected'; entry.errorCode = 'INVALID_NOTE';
  const result = syncSummary(state, 0);
  assert.equal(result.label, '部分改动同步受阻');
  assert.equal(result.needsAttention, true);
  assert.equal(result.icon, 'warning');
  assert.deepEqual(result.blocked, [entry]);
  assert.equal(result.retained.length, 1);
});

test('only a foreign-origin DEVICE_CHANGED checkpoint is treated as retained', () => {
  for (const variant of ['queued', 'rejected', 'other-code', 'current-origin'] as const) {
    const state = snapshot(), entry = state.workspace!.sync.outbox[0];
    if (variant === 'queued' || variant === 'rejected') entry.status = variant;
    if (variant === 'other-code') entry.errorCode = 'UNKNOWN';
    if (variant === 'current-origin') entry.originDeviceId = state.workspace!.sync.deviceId;
    const result = syncSummary(state, 0);
    assert.equal(result.retained.length, 0, variant);
    assert.equal(result.pending, 1, variant);
    assert.equal(result.needsAttention, variant !== 'queued', variant);
  }
});

test('login, conflict and in-progress states retain priority over the local-position notice', () => {
  const state = snapshot(); state.syncing = true;
  assert.equal(syncSummary(state, 0).label, '同步中');
  assert.equal(syncSummary(state, 0).icon, 'sync');
  assert.equal(syncSummary(state, 2).label, '2 项冲突待处理');
  assert.equal(syncSummary(state, 2).icon, 'warning');
  state.needsLogin = true;
  assert.equal(syncSummary(state, 2).label, '请重新登录');
  assert.equal(syncSummary(state, 2).needsAttention, true);
});

test('offline counts and pending conflict resolutions exclude only retained old positions', () => {
  const state = snapshot(); state.online = false;
  assert.equal(syncSummary(state, 0).label, '离线 · 旧阅读位置已保留在本机');
  state.workspace!.pendingResolutions[id(11)] = {
    entityType: 'note', entityId: id(9), request: { opId: id(12), expectedRevision: 1, choice: 'current' },
  };
  assert.equal(syncSummary(state, 0).label, '离线 · 1 项待同步');
  state.online = true;
  assert.equal(syncSummary(state, 0).label, '1 项待同步');
});

test('empty workspaces keep normal first-sync and synced labels', () => {
  const state = snapshot(); state.workspace!.sync.outbox = [];
  assert.equal(syncSummary(state, 0).label, '已同步');
  state.lastSyncedAt = null;
  assert.equal(syncSummary(state, 0).label, '等待首次同步');
});
