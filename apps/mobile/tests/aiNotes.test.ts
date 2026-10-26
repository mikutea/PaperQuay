import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountState, entityKey, getVisibleEntity, queueLocalEdit, validateClientState,
  type AttachmentVersionData, type NoteData, type PaperData, type SyncRecord } from '../../../packages/sync-core/src/index.ts';
import type { AiSaveContext } from '../src/ai/types.ts';
import { ClientError } from '../src/errors.ts';
import { assertAiNoteTarget } from '../src/integration/aiNotes.ts';
import type { PdfAiContext } from '../src/pdf/types.ts';
import type { WorkspaceSnapshot } from '../src/sync/workspace.ts';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAPER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ATTACHMENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const NOW = '2026-10-25T00:00:00.000Z';
const API = 'https://sync.example.invalid/v1';
const HASH = 'a'.repeat(64);
const paperData: PaperData = { title: '合成目标文献', doi: null, year: null, publication: null, abstractText: null, authors: [], keywords: [] };
const attachmentData: AttachmentVersionData = { paperId: PAPER, attachmentId: ATTACHMENT, sha256: HASH,
  sizeBytes: 2048, mediaType: 'application/pdf', fileName: 'fixture.pdf', pageCount: 3 };

interface Fixture {
  snapshot: WorkspaceSnapshot;
  apiBaseUrl: string;
  context: PdfAiContext | null;
  source: AiSaveContext;
  note: NoteData;
}
function fixture(): Fixture {
  const sync = createAccountState(ACCOUNT, DEVICE);
  const paper: SyncRecord<'paper'> = { entityType: 'paper', entityId: PAPER, schemaVersion: 1, revision: 1,
    deletedAt: null, updatedAt: NOW, modifiedByDeviceId: DEVICE, data: structuredClone(paperData) };
  const version: SyncRecord<'attachmentVersion'> = { entityType: 'attachmentVersion', entityId: VERSION, schemaVersion: 1, revision: 1,
    deletedAt: null, updatedAt: NOW, modifiedByDeviceId: DEVICE, data: structuredClone(attachmentData) };
  sync.serverRecords[entityKey('paper', PAPER)] = paper;
  sync.serverRecords[entityKey('attachmentVersion', VERSION)] = version;
  assert.equal(validateClientState(sync).ok, true);
  return {
    snapshot: { status: 'ready', identity: { accountId: ACCOUNT, device: { id: DEVICE, name: 'Synthetic device', platform: 'web',
      createdAt: NOW, lastSeenAt: NOW, revokedAt: null } }, workspace: { sync, pendingResolutions: {} },
    syncing: false, online: false, needsLogin: false, devices: [], conflicts: [], lastSyncedAt: null, error: null },
    apiBaseUrl: API,
    context: { paperId: PAPER, attachmentVersionId: VERSION, sha256: HASH, scope: 'page', totalPages: 3,
      pages: [{ pageIndex: 1, text: '合成阅读材料' }], complete: true, label: '合成目标文献' },
    source: { accountScope: { apiBaseUrl: API, accountId: ACCOUNT }, requestId: crypto.randomUUID(), paperId: PAPER,
      attachmentVersionId: VERSION, sha256: HASH },
    note: { paperId: PAPER, title: '合成 AI 笔记', body: '来自明确版本的合成结果。', format: 'markdown' },
  };
}
function check(value: Fixture): void {
  assertAiNoteTarget(value.snapshot, value.apiBaseUrl, value.context, value.source, value.note);
}
const changed = (error: unknown) => error instanceof ClientError && error.code === 'ACCOUNT_CHANGED';

test('AI note persistence accepts the exact live account/service/paper/version/hash target without mutating it', () => {
  const value = fixture(); const before = structuredClone(value);
  assert.doesNotThrow(() => check(value));
  assert.deepEqual(value, before);
});

test('AI note persistence rejects any account, service, paper, version or content-hash mismatch', () => {
  const cases: { name: string; change(value: Fixture): void }[] = [
    { name: 'current account', change: (v) => { v.snapshot.identity!.accountId = OTHER; } },
    { name: 'source account', change: (v) => { v.source.accountScope.accountId = OTHER; } },
    { name: 'workspace account', change: (v) => { v.snapshot.workspace!.sync.accountId = OTHER; } },
    { name: 'current API', change: (v) => { v.apiBaseUrl = 'https://other-sync.example.invalid/v1'; } },
    { name: 'source API', change: (v) => { v.source.accountScope.apiBaseUrl = 'https://other-sync.example.invalid/v1'; } },
    { name: 'note paper', change: (v) => { v.note.paperId = OTHER; } },
    { name: 'detached note', change: (v) => { v.note.paperId = null; } },
    { name: 'context paper', change: (v) => { v.context!.paperId = OTHER; } },
    { name: 'source paper', change: (v) => { v.source.paperId = OTHER; } },
    { name: 'context version', change: (v) => { v.context!.attachmentVersionId = OTHER; } },
    { name: 'source version', change: (v) => { v.source.attachmentVersionId = OTHER; } },
    { name: 'context hash', change: (v) => { v.context!.sha256 = 'b'.repeat(64); } },
    { name: 'source hash', change: (v) => { v.source.sha256 = 'b'.repeat(64); } },
    { name: 'live attachment hash', change: (v) => {
      (v.snapshot.workspace!.sync.serverRecords[entityKey('attachmentVersion', VERSION)].data as AttachmentVersionData).sha256 = 'b'.repeat(64);
    } },
    { name: 'live attachment parent', change: (v) => {
      (v.snapshot.workspace!.sync.serverRecords[entityKey('attachmentVersion', VERSION)].data as AttachmentVersionData).paperId = OTHER;
    } },
  ];
  for (const scenario of cases) { const value = fixture(); scenario.change(value); assert.throws(() => check(value), changed, scenario.name); }
});

test('AI note persistence rejects an invalidated context, missing identity/workspace and every non-ready workspace status', () => {
  const cases: { name: string; change(value: Fixture): void }[] = [
    { name: 'invalidated context', change: (v) => { v.context = null; } },
    { name: 'missing identity', change: (v) => { v.snapshot.identity = null; } },
    { name: 'missing workspace', change: (v) => { v.snapshot.workspace = null; } },
    ...(['signed-out', 'binding', 'error'] as const).map((status) => ({ name: status, change: (v: Fixture) => { v.snapshot.status = status; } })),
  ];
  for (const scenario of cases) { const value = fixture(); scenario.change(value); assert.throws(() => check(value), changed, scenario.name); }
});

test('AI note persistence rejects missing and remotely or locally deleted papers and attachments', () => {
  for (const entityType of ['paper', 'attachmentVersion'] as const) {
    const entityId = entityType === 'paper' ? PAPER : VERSION;
    for (const deletion of ['missing', 'remote', 'local'] as const) {
      const value = fixture(); const sync = value.snapshot.workspace!.sync; const key = entityKey(entityType, entityId);
      if (deletion === 'missing') delete sync.serverRecords[key];
      else if (deletion === 'remote') {
        sync.serverRecords[key] = { ...sync.serverRecords[key], data: null, deletedAt: NOW, revision: 2 };
      } else {
        value.snapshot.workspace!.sync = queueLocalEdit(sync, { entityType, entityId, mutation: 'delete', data: null },
          { opId: crypto.randomUUID(), clientCreatedAt: NOW });
      }
      assert.equal(validateClientState(value.snapshot.workspace!.sync).ok, true);
      assert.throws(() => check(value), changed, entityType + ': ' + deletion);
    }
  }
});

test('AI note persistence accepts a valid visible attachment before its create reaches the server', () => {
  const value = fixture(); const sync = value.snapshot.workspace!.sync;
  delete sync.serverRecords[entityKey('attachmentVersion', VERSION)];
  value.snapshot.workspace!.sync = queueLocalEdit(sync, { entityType: 'attachmentVersion', entityId: VERSION, mutation: 'put', data: attachmentData },
    { opId: crypto.randomUUID(), clientCreatedAt: NOW });
  const state = value.snapshot.workspace!.sync;
  assert.equal(validateClientState(state).ok, true);
  assert.equal(state.serverRecords[entityKey('attachmentVersion', VERSION)], undefined);
  const visible = getVisibleEntity(state, 'attachmentVersion', VERSION);
  assert.equal(visible?.pending, true); assert.equal(visible?.revision, 0);
  assert.doesNotThrow(() => check(value));
});

test('AI note persistence checks the current visible attachment overlay rather than an older matching server record', () => {
  const value = fixture();
  value.snapshot.workspace!.sync = queueLocalEdit(value.snapshot.workspace!.sync,
    { entityType: 'attachmentVersion', entityId: VERSION, mutation: 'put', data: { ...attachmentData, sha256: 'b'.repeat(64) } },
    { opId: crypto.randomUUID(), clientCreatedAt: NOW });
  assert.equal(validateClientState(value.snapshot.workspace!.sync).ok, true);
  assert.equal((value.snapshot.workspace!.sync.serverRecords[entityKey('attachmentVersion', VERSION)].data as AttachmentVersionData).sha256, HASH);
  assert.throws(() => check(value), changed);
});
