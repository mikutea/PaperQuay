import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { PostgresSyncStore } from '../../src/store.ts';
import { SERVER_LIMITS } from '../../src/config.ts';
import type { VerifiedIdentity } from '../../src/auth.ts';
import type { SessionView } from '../../src/types.ts';
import type { SyncOperation, PushResult } from '../../../packages/sync-core/src/index.ts';
import { checkpoint, identity, operation, paper, version } from '../fixtures.ts';

const databaseUrl = process.env.PAPERQUAY_DATABASE_URL;
if (!databaseUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1') {
  throw new Error('Set PAPERQUAY_DATABASE_URL to an isolated migrated database and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
const store = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 31) });
const peer = new PostgresSyncStore({ connectionString: databaseUrl, cursorSecret: Buffer.alloc(32, 31) });

before(async () => { assert.equal(await store.ready(), true, 'Apply migrations and runtime grants before integration tests.'); });
after(async () => { await peer.close(); await pool.end(); });

async function session(subject = randomUUID()) {
  const who = identity(subject);
  const view = await store.registerDevice(who, { name: 'Synthetic integration session', platform: 'web' });
  return { who, view };
}

async function push(who: VerifiedIdentity, view: SessionView, op: SyncOperation, target = store): Promise<PushResult> {
  return (await target.push(who, { protocolVersion: 1, deviceId: view.device.id, operations: [op] })).results[0];
}

async function fixtureLibrary() {
  const fixture = await session();
  const paperOp = operation('paper', paper());
  const versionOp = operation('attachmentVersion', version(paperOp.entityId));
  assert.equal((await push(fixture.who, fixture.view, paperOp)).status, 'applied');
  assert.equal((await push(fixture.who, fixture.view, versionOp)).status, 'applied');
  return { ...fixture, paperOp, versionOp };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('runtime database role is not an owner/superuser and FORCE RLS hides rows without transaction tenant state', async () => {
  const { who, view } = await session();
  await push(who, view, operation('paper', paper('RLS fixture')));
  const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; owns_table: boolean }>(`SELECT r.rolsuper, r.rolbypassrls,
    c.relowner = r.oid AS owns_table FROM pg_roles r CROSS JOIN pg_class c
    WHERE r.rolname = current_user AND c.oid = 'paperquay.entities'::regclass`);
  assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false, owns_table: false });
  const tables = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class WHERE oid IN ('paperquay.accounts'::regclass,'paperquay.devices'::regclass,'paperquay.entities'::regclass,
      'paperquay.changes'::regclass,'paperquay.operation_receipts'::regclass,'paperquay.conflicts'::regclass)`);
  assert.equal(tables.rowCount, 6);
  assert.ok(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  assert.equal((await pool.query('SELECT id FROM paperquay.accounts')).rowCount, 0);
  assert.equal((await pool.query('SELECT entity_id FROM paperquay.entities')).rowCount, 0);
  await assert.rejects(pool.query('TRUNCATE paperquay.entities'), (error: { code?: string }) => error.code === '42501');
});

test('OIDC session registration is idempotent; another issuer/sub gets a separate account', async () => {
  const { who, view } = await session();
  const again = await store.registerDevice(who, { name: 'Renamed session', platform: 'android' });
  assert.equal(again.accountId, view.accountId);
  assert.equal(again.device.id, view.device.id);
  const secondLogin = { ...who, sessionId: randomUUID() };
  const otherDevice = await store.registerDevice(secondLogin, { name: 'Second login', platform: 'ios' });
  assert.equal(otherDevice.accountId, view.accountId);
  assert.notEqual(otherDevice.device.id, view.device.id);
  const otherIssuer = { ...who, issuer: 'https://different-issuer.example.test' };
  const separate = await store.registerDevice(otherIssuer, { name: 'Separate issuer', platform: 'web' });
  assert.notEqual(separate.accountId, view.accountId);
  assert.equal((await store.listDevices(who)).devices.length, 2);
});

test('concurrent exact retries commit one entity/change and return its original receipt', async () => {
  const { who, view } = await session();
  const op = operation('paper', paper('Retry-safe'));
  const results = await Promise.all([push(who, view, op), push(who, view, op, peer)]);
  assert.ok(results.every((result) => result.status === 'applied' && result.record?.revision === 1));
  assert.equal(results.filter((result) => result.replayed).length, 1);
  assert.deepEqual(results[0].record, results[1].record);
  assert.equal((await store.pull(who, undefined, 100)).records.length, 1);
  const changed = { ...op, data: paper('Changed payload under old opId') };
  assert.equal((await push(who, view, changed)).code, 'IDEMPOTENCY_MISMATCH');
  assert.equal((await store.pull(who, undefined, 100)).records.length, 1);
});

test('parallel writes from the same base preserve the losing content in a conflict', async () => {
  const { who, view } = await session();
  const initial = operation('note', { paperId: null, title: 'Shared', body: 'Base', format: 'markdown' });
  await push(who, view, initial);
  const left = operation('note', { ...initial.data!, body: 'Left content' }, { entityId: initial.entityId, baseRevision: 1 });
  const right = operation('note', { ...initial.data!, body: 'Right content' }, { entityId: initial.entityId, baseRevision: 1 });
  const results = await Promise.all([push(who, view, left), push(who, view, right, peer)]);
  assert.equal(results.filter((result) => result.status === 'applied').length, 1);
  assert.equal(results.filter((result) => result.status === 'conflict').length, 1);
  const conflicts = await store.listConflicts(who, undefined, 100);
  assert.equal(conflicts.conflicts.length, 1);
  assert.equal(conflicts.conflicts[0].observedRecord.revision, 2);
  const losing = results[0].status === 'conflict' ? left : right;
  assert.deepEqual(conflicts.conflicts[0].attemptedOperation, losing);
  const replay = await push(who, view, losing);
  assert.equal(replay.replayed, true);
  assert.equal(replay.conflictId, conflicts.conflicts[0].conflictId);
  assert.equal((await store.listConflicts(who, undefined, 100)).conflicts.length, 1);
});

test('commit failure rolls back entity, feed and receipt; same opId succeeds on retry', async () => {
  const { who, view } = await session();
  let fail = true;
  const injected = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 31), hooks: { beforeCommit: async ({ kind }) => {
    if (kind === 'push' && fail) { fail = false; throw Object.assign(new Error('synthetic transient fault'), { code: '40001' }); }
  } } });
  const op = operation('paper', paper('Rolled back first attempt'));
  const failed = await push(who, view, op, injected);
  assert.equal(failed.retryable, true);
  assert.equal(failed.code, 'SERVICE_TEMPORARILY_UNAVAILABLE');
  assert.equal((await store.pull(who, undefined, 100)).records.length, 0);
  const retry = await push(who, view, op, injected);
  assert.equal(retry.status, 'applied');
  assert.equal(retry.replayed, false);
  assert.equal(retry.record?.revision, 1);
  assert.equal((await store.pull(who, undefined, 100)).records.length, 1);
});

test('a missing dependency creates no permanent receipt and later retry can apply', async () => {
  const { who, view } = await session();
  const parent = operation('paper', paper());
  const child = operation('attachmentVersion', version(parent.entityId));
  const first = await push(who, view, child);
  assert.equal(first.code, 'DEPENDENCY_NOT_READY');
  assert.equal(first.retryable, true);
  await push(who, view, parent);
  const retry = await push(who, view, child);
  assert.equal(retry.status, 'applied');
  assert.equal(retry.replayed, false);
});

test('tenant isolation covers IDs, reference lookup, cursors, devices and conflict resolution', async () => {
  const a = await fixtureLibrary(); const b = await session();
  const foreign = operation('attachmentVersion', version(a.paperOp.entityId));
  assert.equal((await push(b.who, b.view, foreign)).code, 'DEPENDENCY_NOT_READY');
  assert.equal((await store.pull(b.who, undefined, 100)).records.length, 0);
  const aPage = await store.pull(a.who, undefined, 100);
  await assert.rejects(store.pull(b.who, aPage.nextCursor!, 100), { code: 'CURSOR_INVALID' });
  await assert.rejects(store.revokeDevice(b.who, a.view.device.id), { code: 'NOT_FOUND' });
  await assert.rejects(store.push(b.who, { protocolVersion: 1, deviceId: a.view.device.id,
    operations: [operation('paper', paper())] }), { code: 'DEVICE_SESSION_MISMATCH' });
  const collision = operation('paper', paper('Account B content'), { entityId: a.paperOp.entityId });
  assert.equal((await push(b.who, b.view, collision)).status, 'applied');
  assert.notDeepEqual((await store.pull(b.who, undefined, 100)).records[0].data, a.paperOp.data);
  const stale = operation('paper', paper('Losing edit'), { entityId: a.paperOp.entityId, baseRevision: 0 });
  const conflict = await push(a.who, a.view, stale);
  await assert.rejects(store.resolveConflict(b.who, conflict.conflictId!, { opId: randomUUID(), expectedRevision: 1, choice: 'current' }), { code: 'NOT_FOUND' });
  assert.equal((await store.listConflicts(b.who, undefined, 100)).conflicts.length, 0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('paperquay.account_id',$1,true)", [a.view.accountId]);
    assert.equal((await client.query('SELECT entity_id FROM paperquay.entities WHERE account_id=$1', [b.view.accountId])).rowCount, 0);
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT entity_id FROM paperquay.entities')).rowCount, 0);
  } finally { client.release(); }
});

test('tombstones reject stale resurrection, preserve notes, and require explicit restore', async () => {
  const { who, view, paperOp } = await fixtureLibrary();
  const note = operation('note', { paperId: paperOp.entityId, title: 'Surviving note', body: 'Original', format: 'markdown' });
  await push(who, view, note);
  const removal = operation('paper', null, { entityId: paperOp.entityId, baseRevision: 1, mutation: 'delete' });
  const tombstone = await push(who, view, removal);
  assert.equal(tombstone.record?.data, null);
  assert.ok(tombstone.record?.deletedAt);
  const edit = operation('paper', paper('Stale offline edit'), { entityId: paperOp.entityId, baseRevision: 1 });
  const stale = await push(who, view, edit);
  assert.equal(stale.status, 'conflict');
  const implicit = await store.resolveConflict(who, stale.conflictId!, { opId: randomUUID(), expectedRevision: 2, choice: 'attempted' });
  assert.equal(implicit.code, 'RESTORE_REQUIRED');
  assert.equal((await store.listConflicts(who, undefined, 100)).conflicts.length, 1);
  assert.equal((await push(who, view, operation('note', { ...note.data!, body: 'Edited after paper deletion' },
    { entityId: note.entityId, baseRevision: 1 }))).status, 'applied');
  const restore = await store.resolveConflict(who, stale.conflictId!, { opId: randomUUID(), expectedRevision: 2,
    choice: 'merged', mutation: 'restore', data: edit.data });
  assert.equal(restore.status, 'applied');
  assert.equal(restore.record?.revision, 3);
  assert.equal(restore.record?.deletedAt, null);
});

test('conflict resolution rechecks current revision and replays lost acknowledgement after closure', async () => {
  const { who, view } = await session();
  const initial = operation('note', { paperId: null, title: 'Conflict', body: 'First', format: 'markdown' });
  await push(who, view, initial);
  const attempted = operation('note', { ...initial.data!, body: 'Offline' }, { entityId: initial.entityId });
  const conflict = await push(who, view, attempted);
  await push(who, view, operation('note', { ...initial.data!, body: 'New server version' }, { entityId: initial.entityId, baseRevision: 1 }));
  const outdatedChoice = await store.resolveConflict(who, conflict.conflictId!, { opId: randomUUID(), expectedRevision: 1, choice: 'attempted' });
  assert.equal(outdatedChoice.status, 'conflict');
  assert.equal(outdatedChoice.record?.revision, 2);
  const page = await store.listConflicts(who, undefined, 100);
  assert.equal(page.conflicts[0].observedRecord.revision, 1);
  assert.equal(page.conflicts[0].currentRecord.revision, 2);
  const resolution = { opId: randomUUID(), expectedRevision: 2, choice: 'attempted' as const };
  const applied = await store.resolveConflict(who, conflict.conflictId!, resolution);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.record?.revision, 3);
  const retry = await store.resolveConflict(who, conflict.conflictId!, resolution);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.record, applied.record);
  assert.equal((await store.listConflicts(who, undefined, 100)).conflicts.length, 0);
  assert.equal((await store.pull(who, undefined, 100)).records.length, 3);
});

test('keep-current closes a conflict without advancing entity revision or changing its author', async () => {
  const { who, view } = await session();
  const first = operation('paper', paper('Keep this value'));
  const current = await push(who, view, first);
  const stale = await push(who, view, operation('paper', paper('Conflicting value'), { entityId: first.entityId }));
  const result = await store.resolveConflict(who, stale.conflictId!, { opId: randomUUID(), expectedRevision: 1, choice: 'current' });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.record, current.record);
  assert.equal((await store.pull(who, undefined, 100)).records.length, 2);
});

test('attachment identity is immutable and annotations/checkpoints must target the exact version/page range', async () => {
  const { who, view, paperOp, versionOp } = await fixtureLibrary();
  const changedHash = operation('attachmentVersion', { ...versionOp.data!, sha256: 'b'.repeat(64) }, { entityId: versionOp.entityId, baseRevision: 1 });
  assert.equal((await push(who, view, changedHash)).code, 'IMMUTABLE_VERSION_BINDING');
  const outOfRange = operation('readingPosition', checkpoint(paperOp.entityId, versionOp.entityId, 8));
  assert.equal((await push(who, view, outOfRange)).code, 'PAGE_OUT_OF_RANGE');
  const otherPaper = operation('paper', paper('Other paper'));
  await push(who, view, otherPaper);
  const mismatched = operation('readingPosition', checkpoint(otherPaper.entityId, versionOp.entityId));
  assert.equal((await push(who, view, mismatched)).code, 'REFERENCE_MISMATCH');
  const invalidAnnotation = operation('annotation', { paperId: paperOp.entityId, attachmentVersionId: versionOp.entityId,
    kind: 'highlight', color: '#ffff00', comment: '', anchor: { pageIndex: 8,
      coordinateSpace: 'pdf-crop-box-unrotated-normalized', quads: [[0,0,0.5,0,0,0.1,0.5,0.1]], quote: null } });
  assert.equal((await push(who, view, invalidAnnotation)).code, 'PAGE_OUT_OF_RANGE');
});

test('reading positions belong to their creating login session and furthest progress is monotonic', async () => {
  const { who, view, paperOp, versionOp } = await fixtureLibrary();
  const reading = operation('readingPosition', checkpoint(paperOp.entityId, versionOp.entityId, 3));
  await push(who, view, reading);
  const backtrack = operation('readingPosition', { ...reading.data!, pageIndex: 1, offsetRatio: 0.1, deviceSequence: 2 },
    { entityId: reading.entityId, baseRevision: 1 });
  assert.equal((await push(who, view, backtrack)).status, 'applied');
  const regression = operation('readingPosition', { ...backtrack.data!, furthestPageIndex: 2, deviceSequence: 3 },
    { entityId: reading.entityId, baseRevision: 2 });
  assert.equal((await push(who, view, regression)).code, 'READING_PROGRESS_REGRESSION');
  const duplicate = operation('readingPosition', checkpoint(paperOp.entityId, versionOp.entityId));
  assert.equal((await push(who, view, duplicate)).code, 'CHECKPOINT_ALREADY_EXISTS');
  const secondWho = { ...who, sessionId: randomUUID() };
  const secondView = await store.registerDevice(secondWho, { name: 'Other session', platform: 'ios' });
  assert.equal((await push(secondWho, secondView, { ...regression, opId: randomUUID() })).code, 'CHECKPOINT_DEVICE_MISMATCH');
  assert.equal((await push(secondWho, secondView, operation('readingPosition', checkpoint(paperOp.entityId, versionOp.entityId, 1)))).status, 'applied');
});

test('paged pull has no gaps or duplicates and cannot advance through an uncommitted lower sequence', async () => {
  const { who, view } = await session();
  const committed = gate(); const release = gate();
  const delayed = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 31), hooks: { beforeCommit: async ({ kind }) => {
    if (kind === 'push') { committed.resolve(); await release.promise; }
  } } });
  const low = operation('paper', paper('First transaction'));
  const firstWrite = push(who, view, low, delayed);
  await committed.promise;
  const high = operation('paper', paper('Second transaction'));
  const secondWrite = push(who, view, high, peer);
  const pulling = peer.pull(who, undefined, 1);
  release.resolve();
  assert.equal((await firstWrite).status, 'applied');
  assert.equal((await secondWrite).status, 'applied');
  const firstPage = await pulling;
  assert.equal(firstPage.records.length, 1);
  assert.equal(firstPage.records[0].entityId, low.entityId);
  const remainder = await store.pull(who, firstPage.nextCursor!, 100);
  assert.deepEqual(remainder.records.map((record) => record.entityId), [high.entityId]);
  assert.equal(remainder.hasMore, false);
  assert.equal((await store.pull(who, remainder.nextCursor!, 100)).records.length, 0);
});

test('revocation and a waiting write serialize on the account lock, and revoked sid cannot register again', async () => {
  const { who, view } = await session();
  const admin = { ...who, sessionId: randomUUID() };
  await store.registerDevice(admin, { name: 'Revoking session', platform: 'web' });
  const revoking = gate(); const release = gate();
  const delayed = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 31), hooks: { beforeCommit: async ({ kind }) => {
    if (kind === 'revoke') { revoking.resolve(); await release.promise; }
  } } });
  const revoked = delayed.revokeDevice(admin, view.device.id);
  await revoking.promise;
  const waiting = push(who, view, operation('paper', paper('Must not commit')), peer);
  const rejectedWrite = assert.rejects(waiting, { code: 'SESSION_REVOKED' });
  release.resolve();
  await revoked; await rejectedWrite;
  await assert.rejects(store.me(who), { code: 'SESSION_REVOKED' });
  await assert.rejects(store.registerDevice(who, { name: 'Cannot re-register', platform: 'web' }), { code: 'SESSION_REVOKED' });
  assert.equal((await store.pull(admin, undefined, 100)).records.length, 0);
});

test('push/pull/conflict response budgets are bounded; deferred operations remain retryable without a permanent receipt', async () => {
  const { who, view } = await session();
  const sized = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 31), responseLimitBytes: 20000 });
  const notes = Array.from({ length: 4 }, () => operation('note', { paperId: null, title: 'Large fixture', body: 'x'.repeat(7600), format: 'markdown' }));
  for (const note of notes) assert.equal((await push(who, view, note)).status, 'applied');
  const staleDeletes = notes.map((note) => operation('note', null, { entityId: note.entityId, mutation: 'delete' }));
  const batch = await sized.push(who, { protocolVersion: 1, deviceId: view.device.id, operations: staleDeletes });
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 20000);
  assert.equal(batch.results.filter((result) => result.status === 'conflict').length, 2);
  const deferred = batch.results.filter((result) => result.code === 'RESPONSE_LIMIT_REACHED');
  assert.equal(deferred.length, 2);
  assert.ok(deferred.every((result) => result.retryable && !result.replayed));
  assert.equal((await store.listConflicts(who, undefined, 100)).conflicts.length, 2, 'Over-budget conflict writes rolled back.');
  const retry = await sized.push(who, { protocolVersion: 1, deviceId: view.device.id,
    operations: staleDeletes.filter((op) => deferred.some((result) => result.opId === op.opId)) });
  assert.ok(retry.results.every((result) => result.status === 'conflict' && !result.replayed));
  let cursor: string | undefined; const pulled: string[] = [];
  do {
    const page = await sized.pull(who, cursor, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 20000);
    pulled.push(...page.records.map((record) => record.entityId)); cursor = page.nextCursor!;
    if (!page.hasMore) break;
  } while (pulled.length <= 4);
  assert.deepEqual(pulled, notes.map((note) => note.entityId));
  cursor = undefined; const conflicts: string[] = [];
  do {
    const page = await sized.listConflicts(who, cursor, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 20000);
    conflicts.push(...page.conflicts.map((conflict) => conflict.entityId)); cursor = page.nextCursor;
    if (!page.hasMore) break;
  } while (conflicts.length <= 4);
  assert.deepEqual(conflicts, notes.map((note) => note.entityId));
  const empty = await sized.listConflicts(who, cursor, 100);
  assert.equal(empty.conflicts.length, 0); assert.equal(empty.hasMore, false);
  const tooSmall = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 31), responseLimitBytes: 4000 });
  await assert.rejects(tooSmall.pull(who, undefined, 100), { code: 'RESPONSE_RECORD_TOO_LARGE' });
  await assert.rejects(tooSmall.listConflicts(who, undefined, 100), { code: 'RESPONSE_RECORD_TOO_LARGE' });
});

test('new database connections recover receipts and signed cursors after store reconstruction', async () => {
  const { who, view } = await session();
  const first = new PostgresSyncStore({ connectionString: databaseUrl, cursorSecret: Buffer.alloc(32, 31) });
  const op = operation('paper', paper('Durable receipt'));
  const original = await push(who, view, op, first);
  const pulled = await first.pull(who, undefined, 100);
  await first.close();
  const restarted = new PostgresSyncStore({ connectionString: databaseUrl, cursorSecret: Buffer.alloc(32, 31) });
  try {
    const replay = await push(who, view, op, restarted);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.record, original.record);
    assert.equal((await restarted.pull(who, pulled.nextCursor!, 100)).records.length, 0);
  } finally { await restarted.close(); }
});

test('receipt quota stops new writes while preserving existing idempotent replay', async () => {
  const { who, view } = await session();
  const op = operation('paper', paper('Previously accepted'));
  await push(who, view, op);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('paperquay.issuer',$1,true), set_config('paperquay.subject',$2,true), set_config('paperquay.account_id',$3,true)",
      [who.issuer, who.subject, view.accountId]);
    // This account is synthetic and unique to this test; no existing account is changed.
    await client.query('UPDATE paperquay.accounts SET receipt_count=$2 WHERE id=$1', [view.accountId, SERVER_LIMITS.maxAccountReceipts]);
    await client.query('COMMIT');
  } finally { client.release(); }
  const denied = await push(who, view, operation('paper', paper('Over quota')));
  assert.equal(denied.code, 'ACCOUNT_RECEIPT_LIMIT'); assert.equal(denied.retryable, false);
  assert.equal((await push(who, view, op)).replayed, true);
  assert.equal((await store.pull(who, undefined, 100)).records.length, 1);
});
