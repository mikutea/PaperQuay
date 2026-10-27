import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
  createAccountState,
  entityKey,
  getVisibleEntity,
  queueLocalEdit,
  rebindDevice,
  resumeAfterRestart,
  type AccountSyncState,
  type AttachmentVersionData,
  type LocalEdit,
  type PaperData,
  type SyncRecord,
} from '../../../packages/sync-core/src/index.ts';
import type { AccountIdentity } from '../src/api.ts';
import { ClientError } from '../src/errors.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController } from '../src/sync/workspace.ts';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_DEVICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PAPER = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const ATTACHMENT = '33333333-3333-4333-8333-333333333333';
const NEW_VERSION = '44444444-4444-4444-8444-444444444444';
const NOTE = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-10-27T02:00:00.000Z';
const scope = { apiBaseUrl: 'https://sync.example.test', accountId: ACCOUNT };
const paper: PaperData = {
  title: 'Paper before queued edit', doi: null, year: null, publication: null,
  abstractText: null, authors: [], keywords: [],
};
const version: AttachmentVersionData = {
  paperId: PAPER, attachmentId: ATTACHMENT, sha256: 'a'.repeat(64), sizeBytes: 1024,
  mediaType: 'application/pdf', fileName: 'paper.pdf', pageCount: null,
};
const pageCountEdit: LocalEdit = {
  entityType: 'attachmentVersion', entityId: VERSION, mutation: 'put',
  data: { ...version, pageCount: 12 },
};
const noteEdit: LocalEdit = {
  entityType: 'note', entityId: NOTE, mutation: 'put',
  data: { paperId: null, title: 'Note', body: 'Saved body', format: 'markdown' },
};

function record<T extends 'paper' | 'attachmentVersion'>(
  entityType: T,
  entityId: string,
  data: T extends 'paper' ? PaperData : AttachmentVersionData,
): SyncRecord<T> {
  return {
    entityType, entityId, schemaVersion: 1, revision: 1, deletedAt: null,
    updatedAt: NOW, modifiedByDeviceId: DEVICE, data,
  } as SyncRecord<T>;
}

async function setup(t: TestContext) {
  const store = new AccountStore({ decode: decodeWorkspace, indexedDB: new IDBFactory() });
  t.after(() => store.close());
  const initial = createAccountState(ACCOUNT, DEVICE);
  initial.serverRecords[entityKey('paper', PAPER)] = record('paper', PAPER, paper);
  initial.serverRecords[entityKey('attachmentVersion', VERSION)] = record('attachmentVersion', VERSION, version);
  await store.update(scope, () => ({ sync: initial, pendingResolutions: {} }));
  const binding = { accountId: ACCOUNT, key: 'original-subject' };
  let allocatedIds = 0;
  const controller = new WorkspaceController({
    apiBaseUrl: scope.apiBaseUrl,
    store,
    online: false,
    now: () => NOW,
    makeId: () => { allocatedIds += 1; return crypto.randomUUID(); },
    binding: { key: () => binding.key },
    api: {
      async register(): Promise<AccountIdentity> {
        return { accountId: binding.accountId, device: {
          id: DEVICE, name: 'Guard test', platform: 'web', createdAt: NOW,
          lastSeenAt: NOW, revokedAt: null,
        } };
      },
      async push() { throw new Error('Unexpected offline push'); },
      async pull() { throw new Error('Unexpected offline pull'); },
      async devices() { return []; },
      async conflicts() { return { conflicts: [], nextCursor: 'done', hasMore: false }; },
      async resolveConflict() { throw new Error('Unexpected conflict resolution'); },
      async revokeDevice() {},
    },
  });
  await controller.bind('Guard test');
  assert.equal(controller.getSnapshot().status, 'ready');
  let syncStarts = 0;
  const syncNow = controller.syncNow;
  controller.syncNow = () => { syncStarts += 1; return syncNow(); };
  return { store, controller, binding, allocatedIds: () => allocatedIds, syncStarts: () => syncStarts };
}

function queueInStore(env: Awaited<ReturnType<typeof setup>>, edit: LocalEdit) {
  return env.store.update(scope, (current) => ({
    ...current!,
    sync: queueLocalEdit(current!.sync, edit, { opId: crypto.randomUUID(), clientCreatedAt: NOW }),
  }));
}

// Represents a trusted caller's dependency check; the workspace has no PDF dependency.
function unchangedSource(state: Readonly<AccountSyncState>): void {
  const currentPaper = getVisibleEntity(state, 'paper', PAPER);
  const currentVersion = getVisibleEntity(state, 'attachmentVersion', VERSION);
  const data = currentVersion?.data as AttachmentVersionData | null | undefined;
  if (!currentPaper || currentPaper.deleted || !data || currentVersion!.deleted ||
    data.paperId !== version.paperId || data.attachmentId !== version.attachmentId ||
    data.sha256 !== version.sha256 || data.sizeBytes !== version.sizeBytes)
    throw new ClientError('EDIT_CHANGED');
}

test('save guard reads the latest queued transaction state before appending the saved edit', async (t) => {
  const env = await setup(t);
  const displayed = env.controller.getSnapshot().workspace!;
  const queued = queueInStore(env, {
    entityType: 'paper', entityId: PAPER, mutation: 'put',
    data: { ...paper, title: 'Title committed ahead of save' },
  });
  let checkedState: Readonly<AccountSyncState> | undefined;
  let guardCalls = 0;
  const saving = env.controller.save(pageCountEdit, 1, (state) => {
    guardCalls += 1;
    checkedState = structuredClone(state);
    assert.equal(env.controller.getSnapshot().workspace, displayed);
    assert.equal(displayed.sync.outbox.length, 0);
    assert.equal((getVisibleEntity(state, 'paper', PAPER)!.data as PaperData).title, 'Title committed ahead of save');
    unchangedSource(state);
  });
  const preceding = await queued;
  await saving;
  assert.equal(guardCalls, 1);
  assert.deepEqual(checkedState, preceding.sync);
  assert.equal(env.allocatedIds(), 1);
  assert.equal(env.syncStarts(), 1);
  const committed = await env.store.read(scope);
  assert.deepEqual(env.controller.getSnapshot().workspace, committed);
  assert.equal(committed!.sync.outbox.length, 2);
  assert.equal((getVisibleEntity(committed!.sync, 'attachmentVersion', VERSION)!.data as AttachmentVersionData).pageCount, 12);
});

test('queued parent deletion or version identity change rejects the whole save without a success publication', async (t) => {
  const cases: { name: string; preceding: LocalEdit; edit: LocalEdit; expectedRevision: number }[] = [
    {
      name: 'paper deleted before adding a new attachment',
      preceding: { entityType: 'paper', entityId: PAPER, mutation: 'delete', data: null },
      edit: { ...pageCountEdit, entityId: NEW_VERSION }, expectedRevision: 0,
    },
    {
      name: 'version deleted before updating its page count',
      preceding: { entityType: 'attachmentVersion', entityId: VERSION, mutation: 'delete', data: null },
      edit: pageCountEdit, expectedRevision: 1,
    },
    {
      name: 'version bytes changed without a server revision increment',
      preceding: { entityType: 'attachmentVersion', entityId: VERSION, mutation: 'put',
        data: { ...version, sha256: 'b'.repeat(64) } },
      edit: pageCountEdit, expectedRevision: 1,
    },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const env = await setup(t);
    const displayed = env.controller.getSnapshot().workspace!;
    const publications: unknown[] = [];
    env.controller.subscribe(() => publications.push(env.controller.getSnapshot().workspace));
    const queued = queueInStore(env, scenario.preceding);
    let guardCalls = 0;
    const saving = env.controller.save(scenario.edit, scenario.expectedRevision, (state) => {
      guardCalls += 1;
      assert.equal(env.controller.getSnapshot().workspace, displayed);
      unchangedSource(state);
    });
    const rejected = assert.rejects(saving, { code: 'EDIT_CHANGED' });
    const preceding = await queued;
    await rejected;
    assert.equal(guardCalls, 1);
    assert.deepEqual(await env.store.read(scope), preceding);
    assert.equal(env.controller.getSnapshot().workspace, displayed);
    assert.equal(env.controller.getSnapshot().error?.code, 'EDIT_CHANGED');
    assert.ok(publications.length > 0);
    assert.ok(publications.every((workspace) => workspace === displayed));
    assert.equal(env.allocatedIds(), 0);
    assert.equal(env.syncStarts(), 0);
  });
});

test('an arbitrary guard exception rolls back the save and retains the storage error boundary', async (t) => {
  const env = await setup(t);
  const before = await env.store.read(scope);
  const displayed = env.controller.getSnapshot().workspace;
  await assert.rejects(env.controller.save(noteEdit, 0, () => {
    throw new Error('private dependency details');
  }), (error: unknown) => error instanceof ClientError && error.code === 'STORAGE_FAILED' &&
    !error.message.includes('private dependency details'));
  assert.deepEqual(await env.store.read(scope), before);
  assert.equal(env.controller.getSnapshot().workspace, displayed);
  assert.equal(env.allocatedIds(), 0);
  assert.equal(env.syncStarts(), 0);
});

test('legacy save calls remain compatible and revision mismatches still reject before the guard', async (t) => {
  const env = await setup(t);
  await env.controller.save(noteEdit, 0);
  await env.controller.save(pageCountEdit);
  const before = await env.store.read(scope);
  assert.equal(before!.sync.outbox.length, 2);
  let guardCalls = 0;
  await assert.rejects(env.controller.save(pageCountEdit, 2, () => { guardCalls += 1; }), { code: 'EDIT_CHANGED' });
  assert.equal(guardCalls, 0);
  assert.deepEqual(await env.store.read(scope), before);
  assert.equal(env.allocatedIds(), 2);
  assert.equal(env.syncStarts(), 2);
});

test('an account switch rejects a queued guarded save before calling its validator', async (t) => {
  const env = await setup(t);
  const before = await env.store.read(scope);
  let guardCalls = 0;
  const saving = env.controller.save(noteEdit, 0, () => { guardCalls += 1; });
  const rejected = assert.rejects(saving, { code: 'ACCOUNT_CHANGED' });
  env.controller.deactivate();
  env.binding.accountId = OTHER_ACCOUNT;
  env.binding.key = 'replacement-subject';
  await env.controller.bind('Replacement');
  await rejected;
  assert.equal(guardCalls, 0);
  assert.deepEqual(await env.store.read(scope), before);
  assert.equal(env.controller.getSnapshot().identity?.accountId, OTHER_ACCOUNT);
  assert.equal(env.controller.getSnapshot().workspace!.sync.outbox.length, 0);
  assert.equal(env.allocatedIds(), 0);
  assert.equal(env.syncStarts(), 0);
});

test('binding, device, and generation guards remain ahead of the new save validator', async (t) => {
  for (const change of ['binding', 'device', 'generation'] as const) await t.test(change, async (t) => {
    const env = await setup(t);
    const before = await env.store.read(scope);
    const preceding = change === 'binding' ? Promise.resolve(before!) : env.store.update(scope, (current) => ({
      ...current!, sync: change === 'device' ? rebindDevice(current!.sync, OTHER_DEVICE) : resumeAfterRestart(current!.sync),
    }));
    let guardCalls = 0;
    const saving = env.controller.save(noteEdit, 0, () => { guardCalls += 1; });
    const rejected = assert.rejects(saving, { code: 'ACCOUNT_CHANGED' });
    if (change === 'binding') env.binding.key = 'replacement-subject';
    const latest = await preceding;
    await rejected;
    assert.equal(guardCalls, 0);
    assert.deepEqual(await env.store.read(scope), latest);
    assert.equal(env.allocatedIds(), 0);
    assert.equal(env.syncStarts(), 0);
  });
});
