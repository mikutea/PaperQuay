import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { PostgresSyncStore } from '../../src/store.ts';
import { SERVER_LIMITS } from '../../src/config.ts';
import type { VerifiedIdentity } from '../../src/auth.ts';
import type { ResolveRequest, SessionView } from '../../src/types.ts';
import type { NoteData, PushResponse, PushResult, SyncOperation } from '../../../packages/sync-core/src/index.ts';
import { identity, operation } from '../fixtures.ts';

const databaseUrl = process.env.PAPERQUAY_DATABASE_URL;
if (!databaseUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1') {
  throw new Error('Set PAPERQUAY_DATABASE_URL to an isolated migrated database and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
// The boundary matrix deliberately shares one pool across multiple isolated store limits.
pool.setMaxListeners(32);
interface SqlCounts {
  transactions: number; entityReads: number; receiptReads: number;
  entities: number; changes: number; receipts: number; conflicts: number; conflictUpdates: number;
  sequenceUpdates: number; parameterBytes: number;
}
let activeTrace: SqlCounts | undefined;

// Observe executed statements before pg sends them, including INSERTs later rolled back.
// Only statement categories are retained; query values and document bodies are never logged.
pool.on('connect', (client: PoolClient) => {
  const originalQuery = client.query;
  client.query = function (this: PoolClient, ...args: unknown[]) {
    if (activeTrace) {
      const first = args[0];
      const sql = (typeof first === 'string' ? first
        : first && typeof first === 'object' && 'text' in first && typeof first.text === 'string' ? first.text : '')
        .replace(/\s+/g, ' ').trim().toLowerCase();
      if (sql === 'begin') activeTrace.transactions++;
      if (/^select\b.*\bfrom paperquay\.entities\b/.test(sql)) activeTrace.entityReads++;
      if (/^select\b.*\bfrom paperquay\.operation_receipts\b/.test(sql)) activeTrace.receiptReads++;
      if (/^insert into paperquay\.entities\b/.test(sql)) activeTrace.entities++;
      if (/^insert into paperquay\.changes\b/.test(sql)) activeTrace.changes++;
      if (/^insert into paperquay\.operation_receipts\b/.test(sql)) activeTrace.receipts++;
      if (/^insert into paperquay\.conflicts\b/.test(sql)) activeTrace.conflicts++;
      if (/^update paperquay\.conflicts\b/.test(sql)) activeTrace.conflictUpdates++;
      if (/^update paperquay\.accounts set last_(?:conflict_)?seq\b/.test(sql)) activeTrace.sequenceUpdates++;
      const values: unknown[] = Array.isArray(args[1]) ? args[1]
        : first && typeof first === 'object' && 'values' in first && Array.isArray(first.values) ? first.values : [];
      // Aggregate sizes only: no parameter values survive this query wrapper.
      for (const value of values) {
        activeTrace.parameterBytes += Buffer.isBuffer(value) ? value.length
          : Buffer.byteLength(typeof value === 'string' || typeof value === 'bigint' ? String(value) : JSON.stringify(value) ?? '', 'utf8');
      }
    }
    return Reflect.apply(originalQuery, this, args);
  } as typeof client.query;
});

const cursorSecret = Buffer.alloc(32, 67);
const store = new PostgresSyncStore({ pool, cursorSecret });
before(async () => { assert.equal(await store.ready(), true, 'Apply all migrations and runtime grants before response-budget tests.'); });
after(async () => { await pool.end(); });

interface Fixture { who: VerifiedIdentity; view: SessionView }
async function session(): Promise<Fixture> {
  const who = identity();
  const view = await store.registerDevice(who, { name: 'Synthetic response budget session', platform: 'web' });
  return { who, view };
}
function note(body: string): NoteData {
  return { paperId: null, title: 'Synthetic response budget note', body, format: 'markdown' };
}
function push(fixture: Fixture, operations: SyncOperation[], target = store): Promise<PushResponse> {
  return target.push(fixture.who, { protocolVersion: 1, deviceId: fixture.view.device.id, operations });
}
async function traced<T>(action: () => Promise<T>): Promise<{ result: T; sql: SqlCounts }> {
  assert.equal(activeTrace, undefined);
  const sql: SqlCounts = { transactions: 0, entityReads: 0, receiptReads: 0,
    entities: 0, changes: 0, receipts: 0, conflicts: 0, conflictUpdates: 0, sequenceUpdates: 0, parameterBytes: 0 };
  activeTrace = sql;
  try { return { result: await action(), sql }; }
  finally { activeTrace = undefined; }
}

interface TableState { rows: number; bytes: string; digest: string }
interface Ledger {
  retained: string; lastSeq: string; conflictSeq: string; entityCount: number; receiptCount: number;
  entities: TableState; changes: TableState; receipts: TableState; conflicts: TableState; receiptIds: string[];
}

/** The oracle computes saved UTF-8 bytes independently of production quota helpers. */
async function ledger(fixture: Fixture): Promise<Ledger> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('paperquay.issuer',$1,true), set_config('paperquay.subject',$2,true), set_config('paperquay.account_id',$3,true)",
      [fixture.who.issuer, fixture.who.subject, fixture.view.accountId]);
    const account = await client.query<{ retained: string; lastSeq: string; conflictSeq: string; entityCount: number; receiptCount: number }>(
      `SELECT retained_bytes::text AS retained, last_seq::text AS "lastSeq", last_conflict_seq::text AS "conflictSeq",
        entity_count AS "entityCount", receipt_count AS "receiptCount" FROM paperquay.accounts WHERE id=$1`, [fixture.view.accountId]);
    assert.equal(account.rowCount, 1, 'The ledger must be read in the synthetic identity RLS scope.');
    const table = async (name: string, payload: string, ordering: string): Promise<TableState> => {
      const result = await client.query<TableState>(`SELECT count(*)::integer AS rows,
        coalesce(sum(512::bigint + ${payload}),0)::text AS bytes,
        coalesce(md5(string_agg(md5(to_jsonb(saved)::text), ',' ORDER BY ${ordering})),'empty') AS digest
        FROM paperquay.${name} AS saved WHERE account_id=$1`, [fixture.view.accountId]);
      return result.rows[0];
    };
    const entities = await table('entities', "octet_length(convert_to(data::text,'UTF8'))", 'entity_type,entity_id');
    const changes = await table('changes', "octet_length(convert_to(record::text,'UTF8'))", 'seq');
    const receipts = await table('operation_receipts', "octet_length(convert_to(result::text,'UTF8'))", 'op_id');
    const conflicts = await table('conflicts', "octet_length(convert_to(attempted_operation::text,'UTF8')) + octet_length(convert_to(observed_record::text,'UTF8'))", 'seq');
    const receiptIds = await client.query<{ id: string }>('SELECT op_id::text AS id FROM paperquay.operation_receipts WHERE account_id=$1 ORDER BY op_id', [fixture.view.accountId]);
    const result = { ...account.rows[0], entities, changes, receipts, conflicts, receiptIds: receiptIds.rows.map((row) => row.id) };
    assert.equal(BigInt(result.retained), [entities, changes, receipts, conflicts].reduce((sum, row) => sum + BigInt(row.bytes), 0n));
    assert.equal(result.entityCount, entities.rows);
    assert.equal(result.receiptCount, receipts.rows);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function bounded(response: PushResponse, operations: SyncOperation[], limit = SERVER_LIMITS.responseLimitBytes): void {
  assert.ok(Buffer.byteLength(JSON.stringify(response), 'utf8') <= limit, 'The complete JSON response must fit the byte limit.');
  assert.deepEqual(response.results.map((result) => result.opId), operations.map((op) => op.opId));
}

function deferredTail(response: PushResponse, committed: number): string[] {
  const tail = response.results.slice(committed);
  assert.ok(tail.length > 0);
  for (const result of tail) {
    assert.deepEqual(result, { opId: result.opId, status: 'rejected', replayed: false, code: 'RESPONSE_LIMIT_REACHED', retryable: true });
  }
  return tail.map((result) => result.opId);
}

function noRetainedWrites(sql: SqlCounts): void {
  assert.equal(sql.entities, 0);
  assert.equal(sql.changes, 0);
  assert.equal(sql.receipts, 0);
  assert.equal(sql.conflicts, 0);
  assert.equal(sql.conflictUpdates, 0);
  assert.equal(sql.sequenceUpdates, 0);
}

test('a tiny batch of 100 stale deletes never writes snapshots that exceed the default UTF-8 response budget', async () => {
  const fixture = await session();
  const initial = operation('note', note('文'.repeat(262144)));
  assert.equal((await push(fixture, [initial])).results[0].status, 'applied');
  const operations = Array.from({ length: 100 }, () => operation('note', null, { entityId: initial.entityId, mutation: 'delete' }));
  assert.ok(Buffer.byteLength(JSON.stringify(operations), 'utf8') < 32768, 'The amplification trigger must remain a small request.');
  const batch = await traced(() => push(fixture, operations));
  bounded(batch.result, operations);
  const accepted = batch.result.results.filter((result) => result.status === 'conflict');
  assert.ok(accepted.length > 0 && accepted.length < operations.length);
  assert.deepEqual(batch.result.results.slice(0, accepted.length), accepted);
  const deferredIds = deferredTail(batch.result, accepted.length);
  assert.equal(batch.sql.conflicts, accepted.length, 'Over-budget snapshots must be rejected before INSERT, including writes that a later ROLLBACK would hide.');
  assert.equal(batch.sql.receipts, accepted.length);
  assert.equal(batch.sql.sequenceUpdates, accepted.length);
  assert.equal(batch.sql.entities, 0);
  assert.equal(batch.sql.changes, 0);
  assert.ok(batch.sql.transactions <= accepted.length + 1, 'After the first budget miss the tail must not open more database transactions.');
  assert.ok(batch.sql.entityReads <= accepted.length + 1, 'After the first budget miss the tail must not repeatedly load the large current record.');
  assert.ok(batch.sql.receiptReads <= accepted.length + 1);
  const saved = await ledger(fixture);
  assert.equal(saved.entities.rows, 1);
  assert.equal(saved.changes.rows, 1);
  assert.equal(saved.conflicts.rows, accepted.length);
  assert.equal(saved.receipts.rows, accepted.length + 1);
  assert.equal(saved.lastSeq, '1');
  assert.equal(saved.conflictSeq, String(accepted.length));
  assert.ok(deferredIds.every((opId) => !saved.receiptIds.includes(opId)), 'Deferred operations must not acquire permanent rejection receipts.');

  for (let repeat = 0; repeat < 2; repeat++) {
    const replay = await traced(() => push(fixture, operations));
    bounded(replay.result, operations);
    assert.deepEqual(replay.result.results.slice(0, accepted.length), accepted.map((result) => ({ ...result, replayed: true })));
    assert.deepEqual(deferredTail(replay.result, accepted.length), deferredIds);
    noRetainedWrites(replay.sql);
    assert.ok(replay.sql.entityReads <= 1, 'A repeated tiny request may probe only the first missing receipt, not reload the remaining large entities.');
    assert.ok(replay.sql.transactions <= accepted.length + 1);
    assert.ok(replay.sql.receiptReads <= accepted.length + 1);
    assert.deepEqual(await ledger(fixture), saved);
  }

  // Include an operation at the very end, whose saved receipt will later lie behind the budget stop.
  const deferred = operations.filter((op) => deferredIds.includes(op.opId));
  const retryOperations = [deferred[0], deferred[1], deferred.at(-1)!];
  const retry = await traced(() => push(fixture, retryOperations));
  bounded(retry.result, retryOperations);
  assert.ok(retry.result.results.every((result) => result.status === 'conflict' && !result.replayed));
  assert.equal(retry.sql.conflicts, retryOperations.length);
  assert.equal(retry.sql.receipts, retryOperations.length);
  assert.equal(retry.sql.sequenceUpdates, retryOperations.length);
  assert.equal(retry.sql.transactions, retryOperations.length);
  const afterRetry = await ledger(fixture);
  assert.equal(afterRetry.conflicts.rows, saved.conflicts.rows + retryOperations.length);
  assert.equal(afterRetry.receipts.rows, saved.receipts.rows + retryOperations.length);
  assert.equal(afterRetry.changes.digest, saved.changes.digest);
  assert.equal(afterRetry.entities.digest, saved.entities.digest);

  const truncatedReceipts = await traced(() => push(fixture, operations));
  bounded(truncatedReceipts.result, operations);
  deferredTail(truncatedReceipts.result, accepted.length);
  noRetainedWrites(truncatedReceipts.sql);
  assert.equal(truncatedReceipts.sql.entityReads, 0, 'The first over-budget receipt is already saved, so no entity read is needed.');
  assert.ok(truncatedReceipts.sql.transactions <= accepted.length + 1);
  assert.ok(truncatedReceipts.sql.receiptReads <= accepted.length + 1);
  assert.deepEqual(await ledger(fixture), afterRetry);

  const exactRetry = await traced(() => push(fixture, retryOperations));
  bounded(exactRetry.result, retryOperations);
  assert.deepEqual(exactRetry.result.results, retry.result.results.map((result) => ({ ...result, replayed: true })));
  noRetainedWrites(exactRetry.sql);
  assert.equal(exactRetry.sql.entityReads, 0);
  assert.deepEqual(await ledger(fixture), afterRetry);
});

for (const mutation of ['create', 'update'] as const) {
  test(`response preflight prevents over-budget ${mutation} entity, change and receipt writes`, async () => {
    const fixture = await session();
    const target = new PostgresSyncStore({ pool, cursorSecret, responseLimitBytes: 20000 });
    const initial = Array.from({ length: 4 }, () => operation('note', note('Original body')));
    if (mutation === 'update') assert.ok((await push(fixture, initial)).results.every((result) => result.status === 'applied'));
    const before = await ledger(fixture);
    const operations = initial.map((op) => operation('note', note('文'.repeat(2500)),
      { entityId: op.entityId, baseRevision: mutation === 'update' ? 1 : 0 }));
    const batch = await traced(() => push(fixture, operations, target));
    bounded(batch.result, operations, target.responseLimitBytes);
    const accepted = batch.result.results.filter((result) => result.status === 'applied');
    assert.ok(accepted.length > 0 && accepted.length < operations.length);
    assert.deepEqual(batch.result.results.slice(0, accepted.length), accepted);
    const deferredIds = deferredTail(batch.result, accepted.length);
    assert.equal(batch.sql.entities, accepted.length, 'An entity UPSERT must not execute for the budget probe or its deferred tail.');
    assert.equal(batch.sql.changes, accepted.length);
    assert.equal(batch.sql.receipts, accepted.length);
    assert.equal(batch.sql.sequenceUpdates, accepted.length);
    assert.equal(batch.sql.conflicts, 0);
    assert.ok(batch.sql.transactions <= accepted.length + 1);
    assert.ok(batch.sql.entityReads <= accepted.length + 1);
    const saved = await ledger(fixture);
    assert.equal(saved.entities.rows, before.entities.rows + (mutation === 'create' ? accepted.length : 0));
    assert.equal(saved.changes.rows, before.changes.rows + accepted.length);
    assert.equal(saved.receipts.rows, before.receipts.rows + accepted.length);
    assert.ok(deferredIds.every((opId) => !saved.receiptIds.includes(opId)));

    const replay = await traced(() => push(fixture, operations, target));
    bounded(replay.result, operations, target.responseLimitBytes);
    assert.deepEqual(replay.result.results.slice(0, accepted.length), accepted.map((result) => ({ ...result, replayed: true })));
    assert.deepEqual(deferredTail(replay.result, accepted.length), deferredIds);
    noRetainedWrites(replay.sql);
    assert.ok(replay.sql.entityReads <= 1);
    assert.ok(replay.sql.transactions <= accepted.length + 1);
    assert.deepEqual(await ledger(fixture), saved);

    const retryOperations = operations.filter((op) => deferredIds.includes(op.opId));
    const retry = await traced(() => push(fixture, retryOperations, target));
    bounded(retry.result, retryOperations, target.responseLimitBytes);
    assert.ok(retry.result.results.every((result) => result.status === 'applied' && !result.replayed));
    assert.equal(retry.sql.entities, retryOperations.length);
    assert.equal(retry.sql.changes, retryOperations.length);
    assert.equal(retry.sql.receipts, retryOperations.length);
    const completed = await ledger(fixture);
    assert.equal(completed.entities.rows, initial.length);
    assert.equal(completed.changes.rows, before.changes.rows + operations.length);
    assert.equal(completed.receipts.rows, before.receipts.rows + operations.length);
    assert.equal(completed.conflicts.rows, 0);
  });
}

test('an individually oversized response leaves no retained write or receipt and can later proceed unchanged', async () => {
  const fixture = await session();
  const target = new PostgresSyncStore({ pool, cursorSecret, responseLimitBytes: 4096 });
  const operations = [operation('note', note('文'.repeat(2500)))];
  const before = await ledger(fixture);
  const batch = await traced(() => push(fixture, operations, target));
  bounded(batch.result, operations, target.responseLimitBytes);
  deferredTail(batch.result, 0);
  noRetainedWrites(batch.sql);
  assert.ok(batch.sql.transactions <= 1);
  assert.deepEqual(await ledger(fixture), before);
  const recovered = await push(fixture, operations);
  assert.equal(recovered.results[0].status, 'applied');
  assert.equal(recovered.results[0].replayed, false);
  assert.equal((await ledger(fixture)).receipts.rows, 1);
});

async function lastReceiptByteQuota() {
  const body = '额'.repeat(262144);
  const calibration = await session();
  const calibratedInitial = operation('note', note(body));
  assert.equal((await push(calibration, [calibratedInitial])).results[0].status, 'applied');
  const beforeCalibration = await ledger(calibration);
  const calibratedConflict = operation('note', null, { entityId: calibratedInitial.entityId, mutation: 'delete' });
  assert.equal((await push(calibration, [calibratedConflict])).results[0].status, 'conflict');
  const afterCalibration = await ledger(calibration);
  const delta = BigInt(afterCalibration.retained) - BigInt(beforeCalibration.retained);
  const conflictCopy = BigInt(afterCalibration.conflicts.bytes) - BigInt(beforeCalibration.conflicts.bytes);
  const receiptCopy = BigInt(afterCalibration.receipts.bytes) - BigInt(beforeCalibration.receipts.bytes);
  assert.equal(delta, conflictCopy + receiptCopy);
  assert.ok(receiptCopy > 1n);

  const fixture = await session();
  const initial = operation('note', note(body));
  const original = (await push(fixture, [initial])).results[0];
  assert.equal(original.status, 'applied');
  const saved = await ledger(fixture);
  assert.equal(saved.retained, beforeCalibration.retained, 'UUIDs and timestamps have fixed widths in the independently calibrated copies.');
  const limit = Number(BigInt(saved.retained) + delta - 1n);
  assert.ok(BigInt(limit) >= BigInt(saved.retained) + conflictCopy, 'The conflict snapshot fits; only its final receipt byte exceeds the limit.');
  return { fixture, initial, original, saved,
    target: new PostgresSyncStore({ pool, cursorSecret, maxAccountRetainedBytes: limit }) };
}

function storageDeferred(result: PushResult, opId: string): void {
  assert.deepEqual(result, { opId, status: 'rejected', replayed: false, code: 'ACCOUNT_STORAGE_LIMIT', retryable: true });
}

function onlyFirstQuotaRead(sql: SqlCounts): void {
  assert.deepEqual({ entityReads: sql.entityReads, conflicts: sql.conflicts, receipts: sql.receipts,
    sequenceUpdates: sql.sequenceUpdates, entities: sql.entities, changes: sql.changes, conflictUpdates: sql.conflictUpdates },
  { entityReads: 1, conflicts: 0, receipts: 0, sequenceUpdates: 0, entities: 0, changes: 0, conflictUpdates: 0 },
  'Only the first quota candidate may load its snapshot; insufficient total retained bytes must prevent all content writes, including rolled-back INSERTs.');
}

test('retained-byte exhaustion stops the 100-operation snapshot retry amplification before any retained write', async () => {
  const { fixture, initial, saved, target } = await lastReceiptByteQuota();
  const operations = Array.from({ length: 100 }, () => operation('note', null, { entityId: initial.entityId, mutation: 'delete' }));
  assert.ok(Buffer.byteLength(JSON.stringify(operations), 'utf8') < 32768);
  const batch = await traced(() => push(fixture, operations, target));
  bounded(batch.result, operations);
  batch.result.results.forEach((result, index) => storageDeferred(result, operations[index].opId));
  onlyFirstQuotaRead(batch.sql);
  assert.deepEqual(await ledger(fixture), saved, 'Rejected conflict, sequence and receipt writes must leave the byte ledger unchanged.');

  // Both the attempted operation and an untouched tail operation retain their original retry identity.
  const retryOperations = [operations[0], operations.at(-1)!];
  const recovered = await push(fixture, retryOperations);
  bounded(recovered, retryOperations);
  assert.ok(recovered.results.every((result) => result.status === 'conflict' && !result.replayed));
  assert.equal((await ledger(fixture)).conflicts.rows, 2);
});

test('quota response deferral preserves old receipt replays and resets for a later small request', async () => {
  const { fixture, initial, original, saved, target } = await lastReceiptByteQuota();
  const failing = operation('note', null, { entityId: initial.entityId, mutation: 'delete' });
  const small = operation('note', note('Fits the remaining bytes in a separate request.'));
  const tail = operation('note', null, { entityId: initial.entityId, mutation: 'delete' });
  const operations = [failing, initial, small, tail];
  const batch = await traced(() => push(fixture, operations, target));
  bounded(batch.result, operations);
  storageDeferred(batch.result.results[0], failing.opId);
  assert.deepEqual(batch.result.results[1], { ...original, replayed: true }, 'A saved large receipt must remain replayable after a preceding quota failure.');
  storageDeferred(batch.result.results[2], small.opId);
  storageDeferred(batch.result.results[3], tail.opId);
  onlyFirstQuotaRead(batch.sql);
  assert.equal(batch.sql.receiptReads, operations.length, 'Receipt lookup remains available for every operation without reading new entity bodies.');
  assert.deepEqual(await ledger(fixture), saved);

  const later = await push(fixture, [small], target);
  assert.equal(later.results[0].status, 'applied', 'The prior request must not poison new requests whose small payload still fits.');
  assert.equal(later.results[0].replayed, false, 'The earlier deferred attempt must not have created a permanent receipt.');
  const afterSmall = await ledger(fixture);
  assert.equal(afterSmall.entities.rows, saved.entities.rows + 1);
  assert.equal(afterSmall.receipts.rows, saved.receipts.rows + 1);
  assert.equal(afterSmall.conflicts.rows, 0);

  // The ordinary store simulates a later administrator budget increase, without changing database rows or permissions.
  const retryOperations = [failing, tail];
  const recovered = await push(fixture, retryOperations);
  assert.ok(recovered.results.every((result) => result.status === 'conflict' && !result.replayed));
  const complete = await ledger(fixture);
  const replay = await traced(() => push(fixture, retryOperations));
  assert.deepEqual(replay.result.results, recovered.results.map((result) => ({ ...result, replayed: true })));
  noRetainedWrites(replay.sql);
  assert.deepEqual(await ledger(fixture), complete);
});

for (const mutation of ['replace', 'delete', 'conflict'] as const) {
  test(`complete ${mutation} retained cost is checked before writes at the exact UTF-8 byte boundary`, async () => {
    const initialBody = '原'.repeat(262144);
    const nextBody = '改'.repeat(131072);
    const create = async () => {
      const fixture = await session();
      const initial = operation('note', note(initialBody));
      assert.equal((await push(fixture, [initial])).results[0].status, 'applied');
      return { fixture, initial };
    };
    const nextOperation = (entityId: string) => mutation === 'replace'
      ? operation('note', note(nextBody), { entityId, baseRevision: 1 })
      : operation('note', null, { entityId, mutation: 'delete', baseRevision: mutation === 'delete' ? 1 : 0 });

    // Derive the full cost from actual PostgreSQL rows, not from the production preflight formula.
    const calibration = await create();
    const beforeCalibration = await ledger(calibration.fixture);
    const calibrated = (await push(calibration.fixture, [nextOperation(calibration.initial.entityId)])).results[0];
    assert.equal(calibrated.status, mutation === 'conflict' ? 'conflict' : 'applied');
    const afterCalibration = await ledger(calibration.fixture);
    const entityDelta = BigInt(afterCalibration.entities.bytes) - BigInt(beforeCalibration.entities.bytes);
    const changeDelta = BigInt(afterCalibration.changes.bytes) - BigInt(beforeCalibration.changes.bytes);
    const receiptDelta = BigInt(afterCalibration.receipts.bytes) - BigInt(beforeCalibration.receipts.bytes);
    const conflictDelta = BigInt(afterCalibration.conflicts.bytes) - BigInt(beforeCalibration.conflicts.bytes);
    const completeDelta = BigInt(afterCalibration.retained) - BigInt(beforeCalibration.retained);
    assert.equal(completeDelta, entityDelta + changeDelta + receiptDelta + conflictDelta);
    assert.ok(completeDelta > 0n && receiptDelta > 1n);
    if (mutation === 'replace') {
      assert.equal(entityDelta, BigInt(Buffer.byteLength(nextBody, 'utf8') - Buffer.byteLength(initialBody, 'utf8')));
      assert.ok(entityDelta < 0n, 'The complete plan must retain a negative replacement delta rather than charging the current body twice.');
      assert.ok(changeDelta > BigInt(Buffer.byteLength(nextBody, 'utf8')));
    } else {
      assert.equal(entityDelta, 0n, 'Deleting or conflicting with a note retains its original entity body.');
    }
    if (mutation === 'conflict') assert.equal(changeDelta, 0n);
    else assert.equal(conflictDelta, 0n);

    const { fixture, initial } = await create();
    const saved = await ledger(fixture);
    assert.equal(saved.retained, beforeCalibration.retained);
    const pending = nextOperation(initial.entityId);
    const exactLimit = Number(BigInt(saved.retained) + completeDelta);
    const below = new PostgresSyncStore({ pool, cursorSecret, maxAccountRetainedBytes: exactLimit - 1 });
    const denied = await traced(() => push(fixture, [pending], below));
    storageDeferred(denied.result.results[0], pending.opId);
    if (mutation === 'delete') assert.ok(denied.sql.parameterBytes < 32768,
      'Checking a current delete must not send the retained 786432-byte body back to PostgreSQL.');
    noRetainedWrites(denied.sql);
    assert.equal(denied.sql.entityReads, 1);
    assert.deepEqual(await ledger(fixture), saved);

    const exact = new PostgresSyncStore({ pool, cursorSecret, maxAccountRetainedBytes: exactLimit });
    const accepted = await traced(() => push(fixture, [pending], exact));
    assert.equal(accepted.result.results[0].status, mutation === 'conflict' ? 'conflict' : 'applied');
    assert.equal(accepted.result.results[0].replayed, false, 'The rejected original opId must still be available at the exact limit.');
    assert.equal(accepted.sql.receipts, 1);
    assert.equal(accepted.sql.sequenceUpdates, 1);
    assert.equal(accepted.sql.entities, mutation === 'conflict' ? 0 : 1);
    assert.equal(accepted.sql.changes, mutation === 'conflict' ? 0 : 1);
    assert.equal(accepted.sql.conflicts, mutation === 'conflict' ? 1 : 0);
    const completed = await ledger(fixture);
    assert.equal(completed.retained, String(exactLimit));
    const replay = await traced(() => push(fixture, [pending], exact));
    assert.deepEqual(replay.result.results, accepted.result.results.map((result) => ({ ...result, replayed: true })));
    noRetainedWrites(replay.sql);
    assert.equal(replay.sql.entityReads, 0);
    assert.deepEqual(await ledger(fixture), completed);
  });
}

test('keep-current resolution checks its change and receipt cost before writes without retransmitting the current body', async () => {
  const createConflict = async () => {
    const fixture = await session();
    const initial = operation('note', note('留'.repeat(262144)));
    assert.equal((await push(fixture, [initial])).results[0].status, 'applied');
    const stale = operation('note', null, { entityId: initial.entityId, mutation: 'delete' });
    const conflict = (await push(fixture, [stale])).results[0];
    assert.equal(conflict.status, 'conflict');
    assert.ok(conflict.conflictId);
    return { fixture, conflictId: conflict.conflictId };
  };
  const calibration = await createConflict();
  const beforeCalibration = await ledger(calibration.fixture);
  assert.equal((await store.resolveConflict(calibration.fixture.who, calibration.conflictId,
    { opId: randomUUID(), expectedRevision: 1, choice: 'current' })).status, 'applied');
  const afterCalibration = await ledger(calibration.fixture);
  const delta = BigInt(afterCalibration.retained) - BigInt(beforeCalibration.retained);
  const changeDelta = BigInt(afterCalibration.changes.bytes) - BigInt(beforeCalibration.changes.bytes);
  const receiptDelta = BigInt(afterCalibration.receipts.bytes) - BigInt(beforeCalibration.receipts.bytes);
  assert.equal(delta, changeDelta + receiptDelta);
  assert.ok(changeDelta > 786432n && receiptDelta > 786432n);

  const { fixture, conflictId } = await createConflict();
  const saved = await ledger(fixture);
  assert.equal(saved.retained, beforeCalibration.retained);
  const request: ResolveRequest = { opId: randomUUID(), expectedRevision: 1, choice: 'current' };
  const exactLimit = Number(BigInt(saved.retained) + delta);
  const below = new PostgresSyncStore({ pool, cursorSecret, maxAccountRetainedBytes: exactLimit - 1 });
  const denied = await traced(() => below.resolveConflict(fixture.who, conflictId, request));
  storageDeferred(denied.result, request.opId);
  noRetainedWrites(denied.sql);
  assert.ok(denied.sql.parameterBytes < 32768, 'The preflight can measure the saved current JSONB directly without sending its body back as a query parameter.');
  assert.deepEqual(await ledger(fixture), saved, 'Quota denial must leave the conflict open and the feed cursor unchanged.');

  const exact = new PostgresSyncStore({ pool, cursorSecret, maxAccountRetainedBytes: exactLimit });
  const accepted = await traced(() => exact.resolveConflict(fixture.who, conflictId, request));
  assert.equal(accepted.result.status, 'applied');
  assert.equal(accepted.result.replayed, false);
  assert.equal(accepted.result.record?.revision, 1);
  assert.equal(accepted.sql.entities, 0);
  assert.equal(accepted.sql.changes, 1);
  assert.equal(accepted.sql.receipts, 1);
  assert.equal(accepted.sql.sequenceUpdates, 1);
  assert.equal(accepted.sql.conflictUpdates, 1);
  const completed = await ledger(fixture);
  assert.equal(completed.retained, String(exactLimit));
  assert.equal(completed.entities.digest, saved.entities.digest);
});

test('no-op delete resolution preflights its receipt before closing a large retained conflict', async () => {
  const createConflict = async () => {
    const fixture = await session();
    const initial = operation('note', note('删'.repeat(262144)));
    assert.equal((await push(fixture, [initial])).results[0].status, 'applied');
    const stale = operation('note', null, { entityId: initial.entityId, mutation: 'delete' });
    const conflict = (await push(fixture, [stale])).results[0];
    assert.equal(conflict.status, 'conflict');
    assert.ok(conflict.conflictId);
    const deleted = operation('note', null, { entityId: initial.entityId, baseRevision: 1, mutation: 'delete' });
    const tombstone = (await push(fixture, [deleted])).results[0];
    assert.equal(tombstone.status, 'applied');
    assert.equal(tombstone.record?.revision, 2);
    assert.ok(tombstone.record?.deletedAt);
    return { fixture, conflictId: conflict.conflictId };
  };
  const calibration = await createConflict();
  const beforeCalibration = await ledger(calibration.fixture);
  const calibrated = await store.resolveConflict(calibration.fixture.who, calibration.conflictId,
    { opId: randomUUID(), expectedRevision: 2, choice: 'attempted' });
  assert.equal(calibrated.status, 'applied');
  assert.equal(calibrated.record?.revision, 2);
  const afterCalibration = await ledger(calibration.fixture);
  const delta = BigInt(afterCalibration.retained) - BigInt(beforeCalibration.retained);
  assert.equal(delta, BigInt(afterCalibration.receipts.bytes) - BigInt(beforeCalibration.receipts.bytes));
  assert.ok(delta > 1n);
  assert.equal(afterCalibration.entities.digest, beforeCalibration.entities.digest);
  assert.equal(afterCalibration.changes.digest, beforeCalibration.changes.digest);
  assert.equal(afterCalibration.conflicts.bytes, beforeCalibration.conflicts.bytes);

  const { fixture, conflictId } = await createConflict();
  const saved = await ledger(fixture);
  assert.equal(saved.retained, beforeCalibration.retained);
  const request: ResolveRequest = { opId: randomUUID(), expectedRevision: 2, choice: 'attempted' };
  const exactLimit = Number(BigInt(saved.retained) + delta);
  const below = new PostgresSyncStore({ pool, cursorSecret, maxAccountRetainedBytes: exactLimit - 1 });
  const denied = await traced(() => below.resolveConflict(fixture.who, conflictId, request));
  storageDeferred(denied.result, request.opId);
  noRetainedWrites(denied.sql);
  assert.ok(denied.sql.parameterBytes < 32768);
  assert.deepEqual(await ledger(fixture), saved);
  assert.equal((await store.listConflicts(fixture.who, undefined, 100)).conflicts.length, 1);

  const exact = new PostgresSyncStore({ pool, cursorSecret, maxAccountRetainedBytes: exactLimit });
  const accepted = await traced(() => exact.resolveConflict(fixture.who, conflictId, request));
  assert.equal(accepted.result.status, 'applied');
  assert.equal(accepted.result.replayed, false);
  assert.equal(accepted.result.record?.revision, 2);
  assert.ok(accepted.result.record?.deletedAt);
  assert.equal(accepted.sql.entities, 0);
  assert.equal(accepted.sql.changes, 0);
  assert.equal(accepted.sql.sequenceUpdates, 0);
  assert.equal(accepted.sql.conflicts, 0);
  assert.equal(accepted.sql.conflictUpdates, 1);
  assert.equal(accepted.sql.receipts, 1);
  const completed = await ledger(fixture);
  assert.equal(completed.retained, String(exactLimit));
  assert.equal(completed.entities.digest, saved.entities.digest);
  assert.equal(completed.changes.digest, saved.changes.digest);
  assert.equal(completed.conflicts.rows, 1);
  assert.equal((await store.listConflicts(fixture.who, undefined, 100)).conflicts.length, 0);
});
