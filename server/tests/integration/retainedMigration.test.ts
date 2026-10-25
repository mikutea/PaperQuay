import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const migrationUrl = process.env.PAPERQUAY_MIGRATION_DATABASE_URL;
if (!migrationUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1') {
  throw new Error('Set PAPERQUAY_MIGRATION_DATABASE_URL to an isolated migration owner and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}

test('003 backfills an old account above 256 MiB without pruning history, then restores RLS and blocks growth', { timeout: 120000 }, async () => {
  const pool = new pg.Pool({ connectionString: migrationUrl, max: 1, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  // Every fixture and DDL statement lives in this rollback-only transaction.
  // The production schema and its migration checksums are never changed here.
  const schema = 'quota_migration_' + randomUUID().replaceAll('-', '');
  const accountId = randomUUID(); const deviceId = randomUUID(); const entityId = randomUUID();
  const conflictId = randomUUID(); const conflictOpId = randomUUID(); const emptyAccountId = randomUUID();
  const issuer = 'https://migration.example.test'; const subject = randomUUID();
  const versions = ['001_initial.sql', '002_receipt_quota.sql', '003_retained_bytes_quota.sql'];
  const sources = await Promise.all(versions.map(async (name) => (
    await readFile(new URL('../../migrations/' + name, import.meta.url), 'utf8')
  ).replace(/\bpaperquay\b/g, schema)));
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(sources[0]);
    await client.query(sources[1]);
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
    await client.query('SELECT set_config($1,$2,true),set_config($3,$4,true)',
      [schema + '.issuer', issuer, schema + '.subject', 'empty-' + subject]);
    await client.query(`INSERT INTO ${schema}.accounts(id,issuer,subject,epoch) VALUES ($1,$2,$3,$4)`,
      [emptyAccountId, issuer, 'empty-' + subject, randomUUID()]);
    await client.query('SELECT set_config($1,$2,true),set_config($3,$4,true)',
      [schema + '.subject', subject, schema + '.account_id', accountId]);
    await client.query(`INSERT INTO ${schema}.accounts(id,issuer,subject,epoch,last_seq,last_conflict_seq,entity_count)
      VALUES ($1,$2,$3,$4,180,1,1)`, [accountId, issuer, subject, randomUUID()]);
    await client.query(`INSERT INTO ${schema}.devices(account_id,id,session_id,name,platform)
      VALUES ($1,$2,$3,'Legacy quota fixture','web')`, [accountId, deviceId, randomUUID()]);
    await client.query(`INSERT INTO ${schema}.entities(account_id,entity_type,entity_id,schema_version,revision,data,
      updated_at,created_by_device_id,modified_by_device_id)
      VALUES ($1,'note',$2,1,180,jsonb_build_object('paperId',NULL,'title','Legacy',
        'body',repeat('文',262144),'format','markdown'),clock_timestamp(),$3,$3)`, [accountId, entityId, deviceId]);
    await client.query(`INSERT INTO ${schema}.changes(account_id,seq,entity_type,entity_id,record)
      SELECT e.account_id,g,'note',e.entity_id,jsonb_build_object('entityType','note','entityId',e.entity_id,
        'schemaVersion',1,'revision',g,'deletedAt',NULL,'updatedAt','2026-01-01T00:00:00.000Z',
        'modifiedByDeviceId',e.modified_by_device_id,'data',e.data)
      FROM ${schema}.entities e CROSS JOIN generate_series(1,180) g WHERE e.account_id=$1`, [accountId]);
    await client.query(`WITH fixture AS MATERIALIZED (
        SELECT gen_random_uuid() AS op_id,record FROM ${schema}.changes WHERE account_id=$1
      ) INSERT INTO ${schema}.operation_receipts(account_id,op_id,request_hash,result)
      SELECT $1,op_id,repeat('a',64),jsonb_build_object('opId',op_id,'status','applied','replayed',false,'record',record)
      FROM fixture`, [accountId]);
    await client.query(`INSERT INTO ${schema}.conflicts(account_id,id,seq,entity_type,entity_id,attempted_operation,
        observed_record,created_by_device_id)
      SELECT $1,$2,1,'note',$3,jsonb_build_object('opId',$4::uuid,'entityType','note','entityId',$3::uuid,
        'mutation','put','baseRevision',179,'schemaVersion',1,'data',c.record->'data',
        'clientCreatedAt','2026-01-01T00:00:00.000Z'),c.record,$5
      FROM ${schema}.changes c WHERE c.account_id=$1 AND c.seq=180`,
    [accountId, conflictId, entityId, conflictOpId, deviceId]);
    await client.query(`INSERT INTO ${schema}.operation_receipts(account_id,op_id,request_hash,result)
      SELECT $1,$2,repeat('b',64),jsonb_build_object('opId',$2::uuid,'status','conflict','replayed',false,
        'conflictId',$3::uuid,'record',c.record) FROM ${schema}.changes c WHERE c.account_id=$1 AND c.seq=180`,
    [accountId, conflictOpId, conflictId]);

    const retained = await client.query<{ bytes: string; rows: string }>(`SELECT sum(bytes)::text AS bytes,count(*)::text AS rows FROM (
      SELECT 512::bigint+octet_length(convert_to(data::text,'UTF8')) AS bytes FROM ${schema}.entities
      UNION ALL SELECT 512::bigint+octet_length(convert_to(record::text,'UTF8')) FROM ${schema}.changes
      UNION ALL SELECT 512::bigint+octet_length(convert_to(result::text,'UTF8')) FROM ${schema}.operation_receipts
      UNION ALL SELECT 512::bigint+octet_length(convert_to(attempted_operation::text,'UTF8'))
        +octet_length(convert_to(observed_record::text,'UTF8')) FROM ${schema}.conflicts
    ) retained`);
    assert.equal(retained.rows[0].rows, '363');
    assert.ok(BigInt(retained.rows[0].bytes) > 256n * 1024n * 1024n);
    await client.query(sources[2]);
    const account = await client.query<{ retained_bytes: string; receipt_count: number; last_seq: string }>(
      `SELECT retained_bytes,receipt_count,last_seq FROM ${schema}.accounts WHERE id=$1`, [accountId],
    );
    assert.deepEqual(account.rows[0], { retained_bytes: retained.rows[0].bytes, receipt_count: 181, last_seq: '180' });
    const protectedTables = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind='r'`, [schema],
    );
    assert.equal(protectedTables.rowCount, 6);
    assert.ok(protectedTables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
    assert.equal((await client.query(`SELECT seq FROM ${schema}.changes WHERE account_id=$1 ORDER BY seq`, [accountId])).rowCount, 180);
    assert.equal((await client.query(`SELECT op_id FROM ${schema}.operation_receipts WHERE account_id=$1`, [accountId])).rowCount, 181);
    assert.equal((await client.query(`SELECT id FROM ${schema}.conflicts WHERE account_id=$1 AND resolved_at IS NULL`, [accountId])).rowCount, 1);
    await client.query('SAVEPOINT rejected_growth');
    await assert.rejects(client.query(`INSERT INTO ${schema}.changes(account_id,seq,entity_type,entity_id,record)
      VALUES ($1,181,'note',$2,'{}'::jsonb)`, [accountId, entityId]),
    (error: { code?: string; constraint?: string }) => error.code === '23514' && error.constraint === 'paperquay_account_retained_bytes_limit');
    await client.query('ROLLBACK TO SAVEPOINT rejected_growth');
    assert.equal((await client.query(`SELECT retained_bytes FROM ${schema}.accounts WHERE id=$1`, [accountId])).rows[0].retained_bytes,
      retained.rows[0].bytes);
    assert.equal((await client.query(`SELECT seq FROM ${schema}.changes WHERE account_id=$1`, [accountId])).rowCount, 180);
    await client.query('SELECT set_config($1,$2,true),set_config($3,$4,true)',
      [schema + '.subject', 'empty-' + subject, schema + '.account_id', emptyAccountId]);
    assert.equal((await client.query(`SELECT retained_bytes FROM ${schema}.accounts WHERE id=$1`, [emptyAccountId])).rows[0].retained_bytes, '0');
    assert.equal((await client.query(`SELECT id FROM ${schema}.accounts WHERE id=$1`, [accountId])).rowCount, 0);
    assert.equal((await client.query(`SELECT seq FROM ${schema}.changes WHERE account_id=$1`, [accountId])).rowCount, 0);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
});
