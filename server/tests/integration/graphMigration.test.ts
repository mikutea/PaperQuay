import test from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{randomUUID}from'node:crypto';import pg from'pg';
const connectionString=process.env.PAPERQUAY_MIGRATION_DATABASE_URL;if(!connectionString||process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES!=='1')throw Error('Isolated migration owner required');
test('migration 011 extends the actual SQL constraint without rewriting existing JSON and the transaction can roll back the complete rehearsal',async()=>{
 const pool=new pg.Pool({connectionString,max:1}),client=await pool.connect(),schema='pq_graph_011_'+randomUUID().replaceAll('-','');assert(/^[a-z0-9_]+$/.test(schema));
 try{await client.query('BEGIN');await client.query('CREATE SCHEMA '+schema);await client.query('CREATE TABLE '+schema+'.entities(entity_type text NOT NULL CONSTRAINT entities_entity_type_check CHECK(entity_type IN (\'paper\',\'attachmentVersion\',\'note\',\'annotation\',\'readingPosition\',\'aiConversation\',\'aiTemplate\')),data jsonb NOT NULL)');
  const before={title:'既有材料',description:'Exact old content',nested:{order:[1,2,3]}};await client.query('INSERT INTO '+schema+'.entities VALUES($1,$2::jsonb)',['paper',JSON.stringify(before)]);
  await client.query('SAVEPOINT before_graph');await assert.rejects(client.query('INSERT INTO '+schema+'.entities VALUES($1,$2::jsonb)',['graphRelation','{}']),{code:'23514'});await client.query('ROLLBACK TO SAVEPOINT before_graph');
  const source=(await readFile(new URL('../../migrations/011_graph_relations.sql',import.meta.url),'utf8')).replaceAll('paperquay.',schema+'.');await client.query(source);
  assert.deepEqual((await client.query('SELECT data FROM '+schema+'.entities WHERE entity_type=$1',['paper'])).rows[0].data,before);
  await client.query('INSERT INTO '+schema+'.entities VALUES($1,$2::jsonb)',['graphRelation','{"saved":true}']);
  await client.query('SAVEPOINT invalid_type');await assert.rejects(client.query('INSERT INTO '+schema+'.entities VALUES($1,$2::jsonb)',['unknown','{}']),{code:'23514'});await client.query('ROLLBACK TO SAVEPOINT invalid_type');await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0);
 }finally{await client.query('ROLLBACK').catch(()=>{});client.release();await pool.end();}
});
