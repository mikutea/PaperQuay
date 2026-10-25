import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { PostgresSyncStore } from '../../src/store.ts';
import { SERVER_LIMITS } from '../../src/config.ts';
import type { VerifiedIdentity } from '../../src/auth.ts';
import type { SessionView } from '../../src/types.ts';
import type { NoteData, PushResponse, SyncOperation } from '../../../packages/sync-core/src/index.ts';
import { identity, operation } from '../fixtures.ts';

const databaseUrl = process.env.PAPERQUAY_DATABASE_URL;
if (!databaseUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1') {
  throw new Error('Set PAPERQUAY_DATABASE_URL to an isolated migrated database and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
interface SqlCounts {
  transactions: number; entityReads: number; receiptReads: number;
  entities: number; changes: number; receipts: number; conflicts: number; sequenceUpdates: number;
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
      if (/^update paperquay\.accounts set last_(?:conflict_)?seq\b/.test(sql)) activeTrace.sequenceUpdates++;
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
    entities: 0, changes: 0, receipts: 0, conflicts: 0, sequenceUpdates: 0 };
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
