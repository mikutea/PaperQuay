import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyPushResults,
  createAccountState,
  getSyncContext,
  getVisibleEntity,
  preparePush,
  queueLocalEdit,
  type LocalEdit,
} from '../../../packages/sync-core/src/index.ts';
import { entityStatus, hasEntityConflict } from '../src/viewState.ts';

test('a saved successor overlay retains the underlying conflict label and action eligibility', () => {
  const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const deviceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const entityId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const conflictId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const now = '2026-10-23T12:00:00.000Z';
  const edit: LocalEdit = {
    entityType: 'note',
    entityId,
    mutation: 'put',
    data: { title: 'note', body: 'A', paperId: null, format: 'markdown' },
  };
  let state = createAccountState(accountId, deviceId);
  state = queueLocalEdit(state, edit, { opId: crypto.randomUUID(), clientCreatedAt: now });
  const context = getSyncContext(state);
  const prepared = preparePush(state, context, 1);
  state = applyPushResults(prepared.state, context, {
    protocolVersion: 1,
    results: [
      {
        opId: prepared.opIds[0],
        status: 'conflict',
        replayed: false,
        conflictId,
        record: {
          entityType: 'note',
          entityId,
          schemaVersion: 1,
          revision: 2,
          deletedAt: null,
          updatedAt: now,
          modifiedByDeviceId: deviceId,
          data: { title: 'note', body: 'B', paperId: null, format: 'markdown' },
        },
      },
    ],
  });
  state = queueLocalEdit(
    state,
    { ...edit, data: { title: 'note', body: 'C', paperId: null, format: 'markdown' } },
    { opId: crypto.randomUUID(), clientCreatedAt: now },
  );
  const visible = getVisibleEntity(state, 'note', entityId)!;
  assert.equal(visible.status, 'overlay');
  assert.equal(hasEntityConflict(state, visible), true);
  assert.equal(entityStatus(visible, hasEntityConflict(state, visible)), '需要处理冲突');
});
