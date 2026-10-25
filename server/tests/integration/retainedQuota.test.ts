import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { PostgresSyncStore } from '../../src/store.ts';
import type { VerifiedIdentity } from '../../src/auth.ts';
import type { ResolveRequest, SessionView } from '../../src/types.ts';
import type { NoteData, PushResult, SyncOperation } from '../../../packages/sync-core/src/index.ts';
import { identity, operation } from '../fixtures.ts';

const databaseUrl = process.env.PAPERQUAY_DATABASE_URL;
if (!databaseUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1') {
  throw new Error('Set PAPERQUAY_DATABASE_URL to an isolated migrated database and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
// Different quota configurations deliberately share this one integration-test pool.
pool.setMaxListeners(64);
const cursorSecret = Buffer.alloc(32, 43);
const store = new PostgresSyncStore({ pool, cursorSecret });
const independentStores: PostgresSyncStore[] = [];

before(async () => { assert.equal(await store.ready(), true, 'Apply all migrations and runtime grants before quota integration tests.'); });
after(async () => {
  await Promise.all(independentStores.map((target) => target.close()));
  await pool.end();
});

interface Fixture { who: VerifiedIdentity; view: SessionView }
interface TableState { rows: number; bytes: string; digest: string }
interface RetainedState {
  retained: string; lastSeq: string; conflictSeq: string; entityCount: number; receiptCount: number;
  entities: TableState; changes: TableState; receipts: TableState; conflicts: TableState;
  closedConflicts: number; deviceDigest: string;
}

function capped(limit: number, independent = false): PostgresSyncStore {
  const target = new PostgresSyncStore({
    ...(independent ? { connectionString: databaseUrl } : { pool }), cursorSecret, maxAccountRetainedBytes: limit,
  });
  if (independent) independentStores.push(target);
  return target;
}

async function session(): Promise<Fixture> {
  const who = identity();
  const view = await store.registerDevice(who, { name: 'Synthetic retained quota session', platform: 'web' });
  return { who, view };
}

function note(body: string): NoteData {
  return { paperId: null, title: 'Synthetic retained quota note', body, format: 'markdown' };
}

async function push(fixture: Fixture, op: SyncOperation, target = store): Promise<PushResult> {
  return (await target.push(fixture.who, {
    protocolVersion: 1, deviceId: fixture.view.device.id, operations: [op],
  })).results[0];
}

function quota(result: PushResult, opId: string): void {
  assert.deepEqual(result, { opId, status: 'rejected', replayed: false, code: 'ACCOUNT_STORAGE_LIMIT', retryable: true });
}

function used(state: RetainedState): number { return Number(state.retained); }

/** Independent SQL oracle over saved rows. No quota counter or production helper is used to compute bytes. */
async function retained(fixture: Fixture): Promise<RetainedState> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('paperquay.issuer',$1,true), set_config('paperquay.subject',$2,true), set_config('paperquay.account_id',$3,true)",
      [fixture.who.issuer, fixture.who.subject, fixture.view.accountId]);
    const account = await client.query<{ retained: string; lastSeq: string; conflictSeq: string; entityCount: number; receiptCount: number }>(
      `SELECT retained_bytes::text AS retained, last_seq::text AS "lastSeq", last_conflict_seq::text AS "conflictSeq",
        entity_count AS "entityCount", receipt_count AS "receiptCount" FROM paperquay.accounts WHERE id=$1`, [fixture.view.accountId]);
    assert.equal(account.rowCount, 1, 'The SQL oracle must run within the synthetic identity RLS scope.');
    const table = async (name: string, payload: string, ordering: string): Promise<TableState> => {
      const result = await client.query<TableState>(`SELECT count(*)::integer AS rows,
        coalesce(sum(512::bigint + ${payload}),0)::text AS bytes,
        coalesce(md5(jsonb_agg(to_jsonb(saved) ORDER BY ${ordering})::text),'empty') AS digest
        FROM paperquay.${name} AS saved WHERE account_id=$1`, [fixture.view.accountId]);
      return result.rows[0];
    };
    const entities = await table('entities', "octet_length(convert_to(data::text,'UTF8'))", 'entity_type,entity_id');
    const changes = await table('changes', "octet_length(convert_to(record::text,'UTF8'))", 'seq');
    const receipts = await table('operation_receipts', "octet_length(convert_to(result::text,'UTF8'))", 'op_id');
    const conflicts = await table('conflicts', "octet_length(convert_to(attempted_operation::text,'UTF8')) + octet_length(convert_to(observed_record::text,'UTF8'))", 'seq');
    const closed = await client.query<{ count: number }>('SELECT count(*)::integer AS count FROM paperquay.conflicts WHERE account_id=$1 AND resolved_at IS NOT NULL', [fixture.view.accountId]);
    const device = await client.query<{ digest: string }>(`SELECT md5(jsonb_agg(to_jsonb(saved) ORDER BY id)::text) AS digest
      FROM paperquay.devices AS saved WHERE account_id=$1`, [fixture.view.accountId]);
    const state = { ...account.rows[0], entities, changes, receipts, conflicts,
      closedConflicts: closed.rows[0].count, deviceDigest: device.rows[0].digest };
    const measured = [entities, changes, receipts, conflicts].reduce((total, saved) => total + BigInt(saved.bytes), 0n);
    assert.equal(BigInt(state.retained), measured, 'The durable byte counter must equal all retained rows after every checked operation.');
    assert.equal(state.entityCount, entities.rows);
    assert.equal(state.receiptCount, receipts.rows);
    await client.query('COMMIT');
    return state;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function creationCost(body: string): Promise<number> {
  const fixture = await session();
  assert.equal((await push(fixture, operation('note', note(body)))).status, 'applied');
  return used(await retained(fixture));
}

async function conflictFixture(currentBody = 'Current body', attemptedBody = 'Offline body') {
  const fixture = await session();
  const initial = operation('note', note(currentBody));
  const current = await push(fixture, initial);
  assert.equal(current.status, 'applied');
  const attempted = operation('note', note(attemptedBody), { entityId: initial.entityId });
  const conflict = await push(fixture, attempted);
  assert.equal(conflict.status, 'conflict');
  assert.ok(conflict.conflictId);
  await retained(fixture);
  return { ...fixture, initial, attempted, current, conflictId: conflict.conflictId };
}

test('retained quota measures UTF-8 and every UPSERT exactly once, including shrinking data and tombstones', async () => {
  const fixture = await session();
  const initial = operation('note', note('a'.repeat(4096)));
  assert.equal((await push(fixture, initial)).status, 'applied');
  let state = await retained(fixture);
  let revision = 1;
  const bodies = ['测🧪'.repeat(4096), 'x', '中文'.repeat(6144), 'short', '🧪'.repeat(2048), 'final'];
  for (const body of bodies) {
    const op = operation('note', note(body), { entityId: initial.entityId, baseRevision: revision++ });
    const result = await push(fixture, op);
    assert.equal(result.status, 'applied');
    assert.equal(result.record?.revision, revision);
    const next = await retained(fixture);
    assert.equal(next.entities.rows, 1);
    assert.equal(next.changes.rows, revision);
    assert.equal(next.receipts.rows, revision);
    assert.ok(BigInt(next.entities.bytes) >= BigInt(Buffer.byteLength(body, 'utf8') + 512));
    if (body === 'x' || body === 'short' || body === 'final') assert.ok(used(next) < used(state), 'Replacing a large current body must release only that entity copy.');
    state = next;
  }
  const deleted = operation('note', null, { entityId: initial.entityId, baseRevision: revision, mutation: 'delete' });
  assert.equal((await push(fixture, deleted)).status, 'applied');
  const tombstone = await retained(fixture);
  assert.equal(tombstone.entities.bytes, state.entities.bytes, 'A tombstone still retains its entity body.');
  assert.equal(tombstone.changes.rows, state.changes.rows + 1);
  const restored = operation('note', note('Restored 中文'), { entityId: initial.entityId, baseRevision: ++revision, mutation: 'restore' });
  assert.equal((await push(fixture, restored)).status, 'applied');
  await retained(fixture);
});

test('the exact multi-byte limit succeeds, one byte less rolls back, and full accounts still replay and isolate tenants', async () => {
  const body = '多字节🧪'.repeat(512);
  const cost = await creationCost(body);
  const tooSmall = await session();
  const denied = operation('note', note(body));
  const empty = await retained(tooSmall);
  quota(await push(tooSmall, denied, capped(cost - 1)), denied.opId);
  assert.deepEqual(await retained(tooSmall), empty);

  const fixture = await session();
  const exact = capped(cost);
  const first = operation('note', note(body));
  const applied = await push(fixture, first, exact);
  assert.equal(applied.status, 'applied');
  assert.equal(used(await retained(fixture)), cost);
  const next = operation('note', note('A new write at the cap'));
  const before = await retained(fixture);
  quota(await push(fixture, next, exact), next.opId);
  assert.deepEqual(await retained(fixture), before);
  const replay = await push(fixture, first, exact);
  assert.equal(replay.status, 'applied');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.record, applied.record);
  const afterReplay = await retained(fixture);
  assert.equal(afterReplay.retained, before.retained);
  assert.equal(afterReplay.receipts.digest, before.receipts.digest);
  assert.equal((await push(fixture, { ...first, data: note('Different data under the same opId') }, exact)).code, 'IDEMPOTENCY_MISMATCH');
  assert.equal(used(await retained(fixture)), cost);
  assert.equal((await exact.pull(fixture.who, undefined, 100)).records.length, 1);

  const other = await session();
  assert.equal((await push(other, { ...first, opId: randomUUID() }, exact)).status, 'applied');
  assert.equal(used(await retained(other)), cost);
  assert.equal(used(await retained(fixture)), cost);
});

test('a receipt that exceeds the final byte rolls back the earlier entity, feed, counters and device touch', async () => {
  const body = 'Second copy 中文🧪'.repeat(128);
  const calibration = await session();
  const first = operation('note', note('Base'));
  assert.equal((await push(calibration, first)).status, 'applied');
  const calibratedBefore = await retained(calibration);
  assert.equal((await push(calibration, operation('note', note(body), { entityId: first.entityId, baseRevision: 1 }))).status, 'applied');
  const calibratedAfter = await retained(calibration);
  const delta = used(calibratedAfter) - used(calibratedBefore);
  const receiptCopy = Number(calibratedAfter.receipts.bytes) - Number(calibratedBefore.receipts.bytes);
  assert.ok(receiptCopy > 1);

  const fixture = await session();
  const initial = operation('note', note('Base'));
  assert.equal((await push(fixture, initial)).status, 'applied');
  const before = await retained(fixture);
  assert.equal(used(before), used(calibratedBefore));
  const update = operation('note', note(body), { entityId: initial.entityId, baseRevision: 1 });
  const limit = used(before) + delta - 1;
  assert.ok(limit >= used(before) + delta - receiptCopy, 'The entity and change fit; only the final receipt copy exceeds the cap.');
  quota(await push(fixture, update, capped(limit)), update.opId);
  assert.deepEqual(await retained(fixture), before);
  const retry = await push(fixture, update, capped(limit + 1));
  assert.equal(retry.status, 'applied');
  assert.equal(retry.replayed, false);
  assert.equal(retry.record?.revision, 2);
  assert.equal(used(await retained(fixture)), limit + 1);
});

test('two independent connections cannot spend the same retained-byte headroom', async () => {
  const body = 'Concurrent 中文'.repeat(512);
  const cost = await creationCost(body);
  const limit = cost + Math.floor(cost / 2);
  const fixture = await session();
  const left = capped(limit, true); const right = capped(limit, true);
  const ops = [operation('note', note(body)), operation('note', note(body))];
  const results = await Promise.all([push(fixture, ops[0], left), push(fixture, ops[1], right)]);
  assert.equal(results.filter((result) => result.status === 'applied').length, 1);
  assert.equal(results.filter((result) => result.code === 'ACCOUNT_STORAGE_LIMIT' && result.retryable).length, 1);
  const state = await retained(fixture);
  assert.equal(used(state), cost);
  assert.ok(used(state) <= limit);
  assert.deepEqual([state.entities.rows, state.changes.rows, state.receipts.rows], [1, 1, 1]);
  assert.equal(state.lastSeq, '1');
  const loser = results.findIndex((result) => result.status === 'rejected');
  const retry = await push(fixture, ops[loser], capped(cost * 2));
  assert.equal(retry.status, 'applied');
  assert.equal(retry.replayed, false);
  assert.equal(used(await retained(fixture)), cost * 2);
});

test('a large stale conflict attempt is charged even when its response is small, and a full account replays the conflict', async () => {
  const fixture = await session();
  const initial = operation('note', note('Small current body'));
  assert.equal((await push(fixture, initial)).status, 'applied');
  const before = await retained(fixture);
  const largeBody = '文'.repeat(100000);
  const stale = operation('note', note(largeBody), { entityId: initial.entityId });
  quota(await push(fixture, stale, capped(used(before) + 8192)), stale.opId);
  assert.deepEqual(await retained(fixture), before);
  const conflict = await push(fixture, stale);
  assert.equal(conflict.status, 'conflict');
  const after = await retained(fixture);
  assert.equal(after.entities.digest, before.entities.digest);
  assert.equal(after.changes.digest, before.changes.digest);
  assert.ok(Number(after.conflicts.bytes) > Buffer.byteLength(largeBody, 'utf8'));
  assert.ok(Number(after.receipts.bytes) - Number(before.receipts.bytes) < 8192);
  const replay = await push(fixture, stale, capped(used(after)));
  assert.equal(replay.status, 'conflict');
  assert.equal(replay.replayed, true);
  assert.equal(replay.conflictId, conflict.conflictId);
  const replayed = await retained(fixture);
  assert.equal(replayed.retained, after.retained);
  assert.equal(replayed.conflicts.digest, after.conflicts.digest);
  assert.equal(replayed.receipts.digest, after.receipts.digest);
});

function resolution(choice: 'current' | 'attempted' | 'merged'): ResolveRequest {
  return choice === 'merged'
    ? { opId: randomUUID(), expectedRevision: 1, choice, mutation: 'put', data: note('Merged 中文🧪'.repeat(128)) }
    : { opId: randomUUID(), expectedRevision: 1, choice };
}

for (const choice of ['current', 'attempted', 'merged'] as const) {
  test(`quota rejection of ${choice} resolution preserves the open conflict and retries/replays the exact request`, async () => {
    const calibration = await conflictFixture('Current 中文', 'Attempted 🧪'.repeat(128));
    const calibratedBefore = await retained(calibration);
    assert.equal((await store.resolveConflict(calibration.who, calibration.conflictId, resolution(choice))).status, 'applied');
    const calibratedAfter = await retained(calibration);
    const delta = used(calibratedAfter) - used(calibratedBefore);
    const receiptCopy = Number(calibratedAfter.receipts.bytes) - Number(calibratedBefore.receipts.bytes);
    assert.ok(delta > 0 && receiptCopy > 1);

    const fixture = await conflictFixture('Current 中文', 'Attempted 🧪'.repeat(128));
    const cursor = (await store.pull(fixture.who, undefined, 100)).nextCursor!;
    const before = await retained(fixture);
    assert.equal(used(before), used(calibratedBefore));
    const request = resolution(choice);
    const limit = used(before) + delta - 1;
    assert.ok(limit >= used(before) + delta - receiptCopy);
    quota(await capped(limit).resolveConflict(fixture.who, fixture.conflictId, request), request.opId);
    assert.deepEqual(await retained(fixture), before, 'A late receipt failure must also roll back conflict closure.');
    assert.equal((await store.listConflicts(fixture.who, undefined, 100)).conflicts.length, 1);
    assert.equal((await store.pull(fixture.who, cursor, 100)).records.length, 0);

    const exact = capped(limit + 1);
    const applied = await exact.resolveConflict(fixture.who, fixture.conflictId, request);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.replayed, false);
    assert.equal(applied.record?.revision, choice === 'current' ? 1 : 2);
    const after = await retained(fixture);
    assert.equal(used(after), limit + 1);
    assert.equal(after.closedConflicts, 1);
    assert.equal(after.conflicts.rows, 1, 'Resolved conflict history is retained.');
    assert.equal((await exact.pull(fixture.who, cursor, 100)).records.length, 1);
    const replay = await exact.resolveConflict(fixture.who, fixture.conflictId, request);
    assert.equal(replay.status, 'applied');
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.record, applied.record);
    const replayed = await retained(fixture);
    assert.equal(replayed.retained, after.retained);
    assert.equal(replayed.receipts.digest, after.receipts.digest);
    assert.equal(replayed.changes.digest, after.changes.digest);
    assert.equal(replayed.conflicts.digest, after.conflicts.digest);
  });
}

test('a stale expected revision cannot bypass the quota through a conflict-resolution receipt', async () => {
  const fixture = await conflictFixture();
  assert.equal((await push(fixture, operation('note', note('New current version'), { entityId: fixture.initial.entityId, baseRevision: 1 }))).status, 'applied');
  const before = await retained(fixture);
  const request: ResolveRequest = { opId: randomUUID(), expectedRevision: 1, choice: 'attempted' };
  quota(await capped(used(before) + 1).resolveConflict(fixture.who, fixture.conflictId, request), request.opId);
  assert.deepEqual(await retained(fixture), before);
  const conflict = await store.resolveConflict(fixture.who, fixture.conflictId, request);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.replayed, false);
  assert.equal(conflict.record?.revision, 2);
  const after = await retained(fixture);
  assert.equal(after.closedConflicts, 0);
  assert.equal(after.entities.digest, before.entities.digest);
  assert.equal(after.changes.digest, before.changes.digest);
  assert.equal(after.conflicts.digest, before.conflicts.digest);
  assert.equal(after.receipts.rows, before.receipts.rows + 1);
  const replay = await capped(used(after)).resolveConflict(fixture.who, fixture.conflictId, request);
  assert.equal(replay.status, 'conflict');
  assert.equal(replay.replayed, true);
  assert.equal(used(await retained(fixture)), used(after));
});

test('permanent restore-required rejection receipts consume quota without closing the conflict', async () => {
  const fixture = await session();
  const initial = operation('note', note('Retained behind tombstone 中文'));
  assert.equal((await push(fixture, initial)).status, 'applied');
  assert.equal((await push(fixture, operation('note', null, { entityId: initial.entityId, baseRevision: 1, mutation: 'delete' }))).status, 'applied');
  const conflict = await push(fixture, operation('note', note('Stale implicit resurrection'), { entityId: initial.entityId, baseRevision: 1 }));
  assert.equal(conflict.status, 'conflict');
  const before = await retained(fixture);
  const request: ResolveRequest = { opId: randomUUID(), expectedRevision: 2, choice: 'attempted' };
  quota(await capped(used(before) + 1).resolveConflict(fixture.who, conflict.conflictId!, request), request.opId);
  assert.deepEqual(await retained(fixture), before);
  const rejected = await store.resolveConflict(fixture.who, conflict.conflictId!, request);
  assert.equal(rejected.code, 'RESTORE_REQUIRED');
  assert.equal(rejected.retryable, false);
  const after = await retained(fixture);
  assert.equal(after.closedConflicts, 0);
  assert.equal(after.entities.digest, before.entities.digest);
  assert.equal(after.changes.digest, before.changes.digest);
  assert.equal(after.conflicts.digest, before.conflicts.digest);
  assert.equal(after.receipts.rows, before.receipts.rows + 1);
  const replay = await capped(used(after)).resolveConflict(fixture.who, conflict.conflictId!, request);
  assert.equal(replay.code, 'RESTORE_REQUIRED');
  assert.equal(replay.replayed, true);
  assert.equal(used(await retained(fixture)), used(after));
});

test('already-closed conflict rejections are bounded and the earlier successful resolve remains replayable', async () => {
  const fixture = await conflictFixture();
  const original = resolution('current');
  assert.equal((await store.resolveConflict(fixture.who, fixture.conflictId, original)).status, 'applied');
  const before = await retained(fixture);
  const extra = resolution('current');
  quota(await capped(used(before) + 1).resolveConflict(fixture.who, fixture.conflictId, extra), extra.opId);
  assert.deepEqual(await retained(fixture), before);
  const replay = await capped(used(before)).resolveConflict(fixture.who, fixture.conflictId, original);
  assert.equal(replay.status, 'applied');
  assert.equal(replay.replayed, true);
  const rejected = await store.resolveConflict(fixture.who, fixture.conflictId, extra);
  assert.equal(rejected.code, 'CONFLICT_ALREADY_RESOLVED');
  assert.equal(rejected.retryable, false);
  const after = await retained(fixture);
  assert.equal(after.closedConflicts, 1);
  assert.equal(after.conflicts.digest, before.conflicts.digest);
  assert.equal(after.changes.digest, before.changes.digest);
  assert.equal(after.receipts.rows, before.receipts.rows + 1);
});
