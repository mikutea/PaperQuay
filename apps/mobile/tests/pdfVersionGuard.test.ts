import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
  createAccountState, entityKey, getVisibleEntity, queueLocalEdit,
  type AccountSyncState, type AttachmentVersionData, type SyncRecord,
} from '../../../packages/sync-core/src/index.ts';
import { ClientError } from '../src/errors.ts';
import type { AccountIdentity } from '../src/api.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController } from '../src/sync/workspace.ts';
import { PdfError } from '../src/pdf/errors.ts';
import type { PdfVersion } from '../src/pdf/types.ts';
import { assertPdfTarget, capturePdfVersion, pdfVersionWriteGuard } from '../src/pdf/versionGuard.ts';

const now = '2026-10-27T08:00:00.000Z';
const code = (expected: string) => (error: unknown) => error instanceof PdfError && error.code === expected;
function model() {
  const state = createAccountState(crypto.randomUUID(), crypto.randomUUID());
  const paperId = crypto.randomUUID();
  const version: PdfVersion = { entityId: crypto.randomUUID(), data: {
    paperId, attachmentId: crypto.randomUUID(), sha256: 'a'.repeat(64), sizeBytes: 1024,
    mediaType: 'application/pdf', fileName: 'original.pdf', pageCount: null,
  } };
  const metadata = { schemaVersion: 1 as const, revision: 1, deletedAt: null,
    updatedAt: now, modifiedByDeviceId: state.deviceId };
  state.serverRecords[entityKey('paper', paperId)] = { ...metadata, entityType: 'paper', entityId: paperId,
    data: { title: 'Paper', authors: [], keywords: [], year: null, doi: null, publication: null, abstractText: null } };
  state.serverRecords[entityKey('attachmentVersion', version.entityId)] = {
    ...metadata, entityType: 'attachmentVersion', entityId: version.entityId, data: structuredClone(version.data),
  };
  const updateVersion = (patch: Partial<AttachmentVersionData>) => {
    const key = entityKey('attachmentVersion', version.entityId);
    const record = state.serverRecords[key] as SyncRecord<'attachmentVersion'>;
    state.serverRecords[key] = { ...record, data: { ...record.data!, ...patch }, revision: record.revision + 1 };
  };
  return { state, paperId, version, updateVersion };
}

test('capturing a version owns an independent identity snapshot', () => {
  const { version } = model();
  const before = structuredClone(version);
  const captured = capturePdfVersion(version);
  assert.deepEqual(captured, before);
  assert.notEqual(captured, version);
  assert.notEqual(captured.data, version.data);
  version.entityId = crypto.randomUUID();
  version.data.sha256 = 'b'.repeat(64);
  version.data.fileName = 'renamed.pdf';
  assert.deepEqual(captured, before);
});

test('live filenames and newly known page counts are returned without changing the expected snapshot', () => {
  const env = model();
  const before = structuredClone(env.version);
  env.updateVersion({ fileName: 'renamed.pdf', pageCount: 12 });
  const stateBefore = structuredClone(env.state);
  const result = assertPdfTarget(env.state, env.paperId, env.version, 12)!;
  assert.equal(result.revision, 2);
  assert.equal((result.data as AttachmentVersionData).fileName, 'renamed.pdf');
  assert.equal((result.data as AttachmentVersionData).pageCount, 12);
  assert.deepEqual(env.version, before);
  assert.deepEqual(env.state, stateBefore);
  assert.equal(assertPdfTarget(env.state, env.paperId), null);
});

test('missing account state and retired paper or attachment targets are rejected explicitly', async (t) => {
  for (const missing of [null, undefined]) assert.throws(() => assertPdfTarget(missing, crypto.randomUUID()), code('ACCOUNT_CHANGED'));
  for (const target of ['paper', 'attachmentVersion'] as const) for (const change of ['missing', 'tombstone'] as const) {
    await t.test(`${target} ${change}`, () => {
      const env = model();
      const key = entityKey(target, target === 'paper' ? env.paperId : env.version.entityId);
      const record = env.state.serverRecords[key];
      if (change === 'missing') delete env.state.serverRecords[key];
      else env.state.serverRecords[key] = { ...record, data: null, deletedAt: now, revision: 2 };
      assert.throws(() => assertPdfTarget(env.state, env.paperId, env.version), code('TARGET_CHANGED'));
    });
  }
});

test('attachment identity changes are rejected even when the version entity id remains the same', async (t) => {
  const patches: [string, Partial<AttachmentVersionData>][] = [
    ['paper', { paperId: crypto.randomUUID() }], ['attachment', { attachmentId: crypto.randomUUID() }],
    ['hash', { sha256: 'b'.repeat(64) }], ['size', { sizeBytes: 1025 }],
  ];
  for (const [name, patch] of patches) await t.test(name, () => {
    const env = model(); env.updateVersion(patch);
    assert.throws(() => assertPdfTarget(env.state, env.paperId, env.version), code('TARGET_CHANGED'));
  });
  const env = model();
  const wrongParent = capturePdfVersion(env.version); wrongParent.data.paperId = crypto.randomUUID();
  assert.throws(() => assertPdfTarget(env.state, env.paperId, wrongParent), code('TARGET_CHANGED'));
  // Stored metadata is schema validated; an incompatible captured media identity also cannot match it.
  const wrongMedia = { ...env.version, data: { ...env.version.data, mediaType: 'application/octet-stream' } } as unknown as PdfVersion;
  assert.throws(() => assertPdfTarget(env.state, env.paperId, wrongMedia), code('TARGET_CHANGED'));
});

test('known page counts must agree with both the captured version and parsed document', () => {
  const env = model();
  env.updateVersion({ pageCount: 12 });
  const known = { ...env.version, data: { ...env.version.data, pageCount: 12 } };
  assert.doesNotThrow(() => assertPdfTarget(env.state, env.paperId, known, 12));
  assert.throws(() => assertPdfTarget(env.state, env.paperId, env.version, 11), code('TARGET_CHANGED'));
  env.updateVersion({ pageCount: 13 });
  assert.throws(() => assertPdfTarget(env.state, env.paperId, known), code('TARGET_CHANGED'));
  assert.throws(() => assertPdfTarget(env.state, env.paperId, known, 13), code('TARGET_CHANGED'));
});

test('guards use pending local edits and overlays rather than only the server record', () => {
  const env = model();
  const identity = () => ({ opId: crypto.randomUUID(), clientCreatedAt: now });
  const renamed = queueLocalEdit(env.state, { entityType: 'attachmentVersion', entityId: env.version.entityId,
    mutation: 'put', data: { ...env.version.data, fileName: 'pending-name.pdf' } }, identity());
  assert.equal((assertPdfTarget(renamed, env.paperId, env.version)!.data as AttachmentVersionData).fileName, 'pending-name.pdf');
  renamed.outbox[0] = { ...renamed.outbox[0], status: 'sending', attempts: 1 };
  const changed = queueLocalEdit(renamed, { entityType: 'attachmentVersion', entityId: env.version.entityId,
    mutation: 'put', data: { ...env.version.data, attachmentId: crypto.randomUUID() } }, identity());
  assert.equal(getVisibleEntity(changed, 'attachmentVersion', env.version.entityId)!.status, 'overlay');
  assert.throws(() => assertPdfTarget(changed, env.paperId, env.version), code('TARGET_CHANGED'));
  const deleted = queueLocalEdit(env.state, { entityType: 'paper', entityId: env.paperId, mutation: 'delete', data: null }, identity());
  assert.throws(() => assertPdfTarget(deleted, env.paperId, env.version), code('TARGET_CHANGED'));
});

test('transaction guards preserve captured identity and expose only controlled edit-change failures', () => {
  const env = model();
  const guard = pdfVersionWriteGuard(env.paperId, env.version, env.version.entityId);
  env.version.data.sha256 = 'b'.repeat(64);
  assert.doesNotThrow(() => guard(env.state));
  env.updateVersion({ sha256: 'b'.repeat(64) });
  assert.throws(() => guard(env.state), (error: unknown) => error instanceof ClientError && error.code === 'EDIT_CHANGED');
  assert.throws(() => guard(null as unknown as AccountSyncState), { code: 'EDIT_CHANGED' });
});

test('page-count write guards reject newer pending names or page counts at the same server revision', async (t) => {
  for (const patch of [{ fileName: 'new-local-name.pdf' }, { pageCount: 12 }]) await t.test(Object.keys(patch)[0], () => {
    const env = model();
    const guard = pdfVersionWriteGuard(env.paperId, env.version, env.version.entityId);
    const pending = queueLocalEdit(env.state, { entityType: 'attachmentVersion', entityId: env.version.entityId,
      mutation: 'put', data: { ...env.version.data, ...patch } }, { opId: crypto.randomUUID(), clientCreatedAt: now });
    const before = structuredClone(pending);
    assert.equal(getVisibleEntity(pending, 'attachmentVersion', env.version.entityId)!.revision, 1);
    // A read may use this identity, but a stale write must not replace the user's pending data.
    assert.doesNotThrow(() => assertPdfTarget(pending, env.paperId, env.version));
    assert.throws(() => guard(pending), { code: 'EDIT_CHANGED' });
    assert.deepEqual(pending, before);
    const refreshed = { entityId: env.version.entityId,
      data: getVisibleEntity(pending, 'attachmentVersion', env.version.entityId)!.data as AttachmentVersionData };
    assert.doesNotThrow(() => pdfVersionWriteGuard(env.paperId, refreshed, env.version.entityId)(pending));
  });
});

test('queued page-count persistence cannot overwrite a pending rename or page-count correction', async (t) => {
  for (const patch of [{ fileName: 'new-local-name.pdf' }, { pageCount: 12 }]) await t.test(Object.keys(patch)[0], async (t) => {
    const env = model();
    const scope = { apiBaseUrl: 'https://sync.example.invalid', accountId: env.state.accountId };
    const store = new AccountStore({ decode: decodeWorkspace, indexedDB: new IDBFactory() });
    t.after(() => store.close());
    await store.update(scope, () => ({ sync: env.state, pendingResolutions: {} }));
    const controller = new WorkspaceController({ store, apiBaseUrl: scope.apiBaseUrl, online: false, api: {
      async register(): Promise<AccountIdentity> {
        return { accountId: scope.accountId, device: { id: env.state.deviceId, name: 'Write guard', platform: 'web',
          createdAt: now, lastSeenAt: now, revokedAt: null } };
      },
      async push() { throw new Error('Unexpected offline push'); },
      async pull() { throw new Error('Unexpected offline pull'); },
      async devices() { return []; },
      async conflicts() { return { conflicts: [], nextCursor: 'done', hasMore: false }; },
      async resolveConflict() { throw new Error('Unexpected conflict resolution'); },
      async revokeDevice() {},
    } });
    await controller.bind('Write guard');
    const displayed = controller.getSnapshot().workspace;
    const preceding = store.update(scope, (current) => ({ ...current!, sync: queueLocalEdit(current!.sync,
      { entityType: 'attachmentVersion', entityId: env.version.entityId, mutation: 'put', data: { ...env.version.data, ...patch } },
      { opId: crypto.randomUUID(), clientCreatedAt: now }) }));
    const saving = controller.save({ entityType: 'attachmentVersion', entityId: env.version.entityId,
      mutation: 'put', data: { ...env.version.data, pageCount: 13 } }, 1,
    pdfVersionWriteGuard(env.paperId, env.version, env.version.entityId));
    const rejected = assert.rejects(saving, { code: 'EDIT_CHANGED' });
    const latest = await preceding;
    await rejected;
    assert.deepEqual(await store.read(scope), latest, 'the existing pending operation and its identity must survive intact');
    assert.equal(controller.getSnapshot().workspace, displayed, 'a rejected page-count write must not publish a saved workspace');
    assert.equal(controller.getSnapshot().error?.code, 'EDIT_CHANGED');
  });
});

test('new-version transaction guards require a live parent and an unused version id', () => {
  const env = model(); const creatingId = crypto.randomUUID();
  const guard = pdfVersionWriteGuard(env.paperId, undefined, creatingId);
  assert.doesNotThrow(() => guard(env.state));
  const collision = queueLocalEdit(env.state, { entityType: 'attachmentVersion', entityId: creatingId,
    mutation: 'put', data: env.version.data }, { opId: crypto.randomUUID(), clientCreatedAt: now });
  assert.throws(() => guard(collision), { code: 'EDIT_CHANGED' });
  const existing = pdfVersionWriteGuard(env.paperId, undefined, env.version.entityId);
  assert.throws(() => existing(env.state), { code: 'EDIT_CHANGED' });
  const key = entityKey('attachmentVersion', env.version.entityId);
  env.state.serverRecords[key] = { ...env.state.serverRecords[key], data: null, deletedAt: now };
  assert.throws(() => existing(env.state), { code: 'EDIT_CHANGED' });
  delete env.state.serverRecords[entityKey('paper', env.paperId)];
  assert.throws(() => guard(env.state), { code: 'EDIT_CHANGED' });
});
