import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createAccountState, entityKey, getVisibleEntity, queueLocalEdit, type SyncRecord } from '../../../packages/sync-core/src/index.ts';
import { conversationFixture, extendedId as id } from '../../../tests/fixtures/extendedSync.ts';
import { appendAiConversation, conversationRecord } from '../../../packages/ai-core/src/conversation.ts';
import { createAiSyncBridge } from '../src/integration/aiSync.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController, type StoredWorkspace } from '../src/sync/workspace.ts';
import { ClientError } from '../src/errors.ts';
const at = '2026-10-28T01:00:00.000Z', account = id(1), device = id(2), paper = id(90), version = id(91), conversationId = id(50);
const scope = { apiBaseUrl: 'https://sync.example.invalid/v1', accountId: account };
function record(kind: SyncRecord['entityType'], entityId: string, data: unknown): SyncRecord {
  return { entityType: kind, entityId, data, revision: 1, schemaVersion: 1, deletedAt: null, updatedAt: at, modifiedByDeviceId: device } as SyncRecord;
}
async function fixture() {
  const store = new AccountStore<StoredWorkspace>({ decode: decodeWorkspace, indexedDB: new IDBFactory() });
  const sync = createAccountState(account, device), conversation = conversationFixture();
  for (const row of [
    record('paper', paper, { title: '合成材料', doi: null, year: null, publication: null, abstractText: null, authors: [], keywords: [] }),
    record('attachmentVersion', version, { paperId: paper, attachmentId: id(89), sha256: 'a'.repeat(64), sizeBytes: 2048, mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount: 8 }),
    record('aiConversation', conversationId, conversation),
  ]) sync.serverRecords[entityKey(row.entityType, row.entityId)] = row;
  await store.update(scope, () => ({ sync, pendingResolutions: {}, aiConversationsVersion: 1 }));
  const identity = { accountId: account, device: { id: device, name: 'synthetic', platform: 'web' as const, createdAt: at, lastSeenAt: at, revokedAt: null } };
  const controller = new WorkspaceController({ store, apiBaseUrl: scope.apiBaseUrl, online: false, now: () => at,
    supportsAiConversations: () => true, binding: { key: () => 'synthetic-binding' }, api: {
      async register() { return identity; }, async devices() { return []; },
      async push() { throw new Error('Unexpected offline push'); }, async pull() { throw new Error('Unexpected offline pull'); },
      async conflicts() { return { conflicts: [], nextCursor: 'done', hasMore: false }; },
      async resolveConflict() { throw new Error('Unexpected resolution'); }, async revokeDevice() {},
    } });
  await controller.bind('合成会话设备');
  return { store, controller, conversation, close: () => { controller.deactivate(); store.close(); } };
}

test('synced conversation and template commit exact snapshots through real IndexedDB and retain offline outbox entries', async t => {
  const f = await fixture(); t.after(f.close);
  const bridge = createAiSyncBridge(f.controller, scope); assert.equal(bridge.enabled, true); assert.equal(bridge.conversations.length, 1);
  const second = conversationRecord(f.conversation, 0); second.id = id(93); second.createdAt = '2026-10-28T00:00:02.000Z'; second.updatedAt = '2026-10-28T00:00:03.000Z'; second.question = '第二轮问题';
  const next = appendAiConversation(f.conversation, second);
  assert.equal(await bridge.saveConversation(next, bridge.conversations[0]), conversationId);
  const templateId = await createAiSyncBridge(f.controller, scope).saveTemplate({ version: 1, title: '方法问题', action: 'ask', question: '作者如何验证？' });
  const stored = await f.store.read(scope); assert.equal(stored!.sync.outbox.length, 2);
  assert.deepEqual(getVisibleEntity(stored!.sync, 'aiConversation', conversationId)!.data, next);
  assert.equal((getVisibleEntity(stored!.sync, 'aiTemplate', templateId)!.data as any).question, '作者如何验证？');
  assert.equal(createAiSyncBridge(f.controller, scope).templates.length, 1);
});

test('queued continuation rechecks same-revision local edits, parent content and account at the storage transaction', async t => {
  for (const change of ['local-body', 'retained-conflict', 'pending-resolution', 'version', 'deactivate', 'unchanged'] as const) await t.test(change, async t => {
    const f = await fixture(); t.after(f.close);
    const bridge = createAiSyncBridge(f.controller, scope), previous = bridge.conversations[0];
    const update = f.store.update.bind(f.store);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(f.store, 'update', async (...args: Parameters<typeof f.store.update>) => { enter(); await gate; return update(...args); });
    const saving = bridge.saveConversation({ ...previous.data, title: '待保存的标题' }, previous);
    const settled = change === 'unchanged' ? saving : assert.rejects(saving, error => error instanceof ClientError && ['ACCOUNT_CHANGED', 'EDIT_CHANGED'].includes(error.code));
    await entered;
    if (change === 'local-body') await update(scope, current => ({ ...current!, sync: queueLocalEdit(current!.sync,
      { entityType: 'aiConversation', entityId: conversationId, mutation: 'put', data: { ...f.conversation, title: '另一个窗口的草稿' } },
      { opId: crypto.randomUUID(), clientCreatedAt: at }) }));
    if (change === 'version') await update(scope, current => {
      const row = current!.sync.serverRecords[entityKey('attachmentVersion', version)];
      return { ...current!, sync: { ...current!.sync, serverRecords: { ...current!.sync.serverRecords, [entityKey('attachmentVersion', version)]: { ...row, data: { ...row.data!, sha256: 'b'.repeat(64) } } as SyncRecord } } };
    });
    if (change === 'retained-conflict' || change === 'pending-resolution') await update(scope, current => {
      const conflictId = id(97), attempted = { opId: id(98), entityType: 'aiConversation' as const, entityId: conversationId, mutation: 'put' as const,
        baseRevision: 1, schemaVersion: 1 as const, clientCreatedAt: at, data: { ...f.conversation, title: '另一设备的未决会话' } };
      if (change === 'retained-conflict') return { ...current!, sync: { ...current!.sync, conflicts: { ...current!.sync.conflicts,
        [conflictId]: { conflictId, attempted, current: current!.sync.serverRecords[entityKey('aiConversation',conversationId)] } } } };
      return { ...current!, pendingResolutions: { ...current!.pendingResolutions, [conflictId]: { entityType:'aiConversation', entityId:conversationId,
        request:{opId:id(99),expectedRevision:1,choice:'current'} } } };
    });
    if (change === 'deactivate') f.controller.deactivate();
    release(); await settled;
    const stored = await f.store.read(scope), row = getVisibleEntity(stored!.sync, 'aiConversation', conversationId)!;
    assert.equal((row.data as any).title, change === 'unchanged' ? '待保存的标题' : change === 'local-body' ? '另一个窗口的草稿' : f.conversation.title);
  });
});

test('delete uses the reviewed data as well as revision and cannot erase a newer unsent template', async t => {
  const f = await fixture(); t.after(f.close);
  const bridge = createAiSyncBridge(f.controller, scope), template = { version: 1 as const, title: '旧标题', action: 'ask' as const, question: '旧问题' };
  const templateId = await bridge.saveTemplate(template), first = createAiSyncBridge(f.controller, scope).templates[0];
  await createAiSyncBridge(f.controller, scope).saveTemplate({ ...template, title: '新标题' }, first);
  await assert.rejects(bridge.remove('aiTemplate', first), error => error instanceof ClientError && error.code === 'EDIT_CHANGED');
  assert.equal((getVisibleEntity((await f.store.read(scope))!.sync, 'aiTemplate', templateId)!.data as any).title, '新标题');
  await createAiSyncBridge(f.controller, scope).remove('aiTemplate', createAiSyncBridge(f.controller, scope).templates[0]);
  assert.equal(createAiSyncBridge(f.controller, scope).templates.length, 0);
});
