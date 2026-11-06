import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import pg from 'pg';
import { PostgresSyncStore } from '../../src/store.ts';
import { ApiError } from '../../src/errors.ts';
import { buildApp } from '../../src/app.ts';
import type { VerifiedIdentity } from '../../src/auth.ts';
import type { RemoteTaskAccountRunner } from '../../src/remote-task-store.ts';
import type { RemoteRetrievalRepository } from '../../src/remote-retrieval-store.ts';
import { identity, operation, paper, version, testConfig } from '../fixtures.ts';
import { retrievalFixture, retrievalHash } from '../../../tests/remoteRetrievalFixtures.ts';
import { validateRemoteRetrievalReceipt, REMOTE_RETRIEVAL_LIMITS as L } from '../../../packages/sync-core/src/remoteRetrieval.ts';
import type { RemoteRetrievalRequest } from '../../../packages/sync-core/src/remoteRetrieval.ts';

const databaseUrl=process.env.PAPERQUAY_DATABASE_URL;
if(!databaseUrl||process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES!=='1')throw new Error('Use the owned isolated migrated database with explicit test writes.');
const pool=new pg.Pool({connectionString:databaseUrl,max:8}),sync=new PostgresSyncStore({pool,cursorSecret:Buffer.alloc(32,59)});
const retrieval=sync.remoteRetrieval(),remote=sync.remoteTasks();
const account:RemoteTaskAccountRunner=async(who,work)=>{
  const client=await pool.connect();try{
    await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SELECT set_config('paperquay.issuer',$1,true),set_config('paperquay.subject',$2,true)",[who.issuer,who.subject]);
    const owner=(await client.query<{id:string}>('SELECT id FROM paperquay.accounts WHERE issuer=$1 AND subject=$2 FOR UPDATE',[who.issuer,who.subject])).rows[0];
    if(!owner)throw new ApiError('DEVICE_NOT_REGISTERED',403);await client.query("SELECT set_config('paperquay.account_id',$1,true)",[owner.id]);
    const device=(await client.query<{id:string;revoked_at:Date|null}>('SELECT id,revoked_at FROM paperquay.devices WHERE account_id=$1 AND session_id=$2',[owner.id,who.sessionId])).rows[0];
    if(!device||device.revoked_at)throw new ApiError('SESSION_REVOKED',403);const result=await work({client,account:owner,device});await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
};
before(async()=>{assert.equal(await sync.ready(),true,'Apply migration 012 and scoped runtime grants to the owned test clone.');const role=(await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);});
after(async()=>{await pool.end();});
const profile={id:'retrieval-fixture-index',kind:'index' as const,revision:1,digest:'c'.repeat(64),model:'synthetic-embedding'};
async function fixture(){
  const who=identity(),computer={...identity(),subject:who.subject},consumer=await sync.registerDevice(who,{name:'Synthetic retrieval consumer',platform:'web'}),provider=await sync.registerDevice(computer,{name:'Synthetic index producer',platform:'linux'});
  await remote.publishProvider(computer,[profile]);return{who,computer,consumer,provider};
}
async function index(f:Awaited<ReturnType<typeof fixture>>,texts?:string[]){
  const a=retrievalFixture(texts),parent=operation('paper',paper('Synthetic retrieval document'),{entityId:a.artifact.paperId}),attachment=operation('attachmentVersion',version(parent.entityId,2),{entityId:a.artifact.attachmentVersionId});
  for(const op of[parent,attachment])assert.equal((await sync.push(f.who,{protocolVersion:1,deviceId:f.consumer.device.id,operations:[op]})).results[0].status,'applied');
  const created=await remote.createTask(f.who,{requestId:randomUUID(),kind:'index',versionId:attachment.entityId,providerDeviceId:f.provider.device.id,
    profileRef:{id:profile.id,revision:profile.revision,digest:profile.digest},indexSourceDigest:a.artifact.parseDigest});
  const claim=(await remote.claimTask(f.computer)).claim!;assert.equal(claim.task.id,created.task.id);
  await remote.completeTask(f.computer,created.task.id,claim.lease,a.bytes);
  const source=(await retrieval.source(f.who,created.task.id)).source;
  const request:RemoteRetrievalRequest={...a.request,sources:[source]};return{...a,source,request,taskId:created.task.id,parent,attachment};
}
test('real index artifacts support lexical retrieval without an online computer; receipts preserve exact sources and terms',async()=>{
  const f=await fixture(),a=await index(f),b=await index(f,['URBAN evidence']);await remote.withdrawProvider(f.computer);
  const request={...a.request,sources:[a.source,b.source],topK:2};const first=await retrieval.retrieve(f.who,request);
  assert.equal(first.replayed,false);assert.deepEqual(first.receipt.result.evidence.map(e=>e.score),[2,1]);assert.equal(first.receipt.result.stats.scannedChunks,4);
  assert.deepEqual(await validateRemoteRetrievalReceipt(first.receipt),first.receipt);
  assert.equal((await retrieval.retrieve(f.who,request)).replayed,true);assert.deepEqual((await retrieval.lookup(f.who,request.requestId)).receipt,first.receipt);
  const fresh=sync.remoteRetrieval();assert.deepEqual((await fresh.lookup(f.who,request.requestId)).receipt,first.receipt);
  const empty=await retrieval.retrieve(f.who,{...request,requestId:randomUUID(),query:'UnmatchedToken'});assert.equal(empty.receipt.result.evidence.length,0);
  assert.equal((await remote.getTask(f.who,a.taskId)).task.state,'succeeded');
});
test('source listing is independently paged, account scoped and includes only currently verifiable source artifacts',async()=>{
  const f=await fixture(),a=await index(f),b=await index(f),other=await fixture(),foreign=await index(other);
  const first=await retrieval.listSources(f.who,{limit:1});assert.equal(first.sources.length,1);assert.equal(first.hasMore,true);assert.ok(first.nextCursor);
  const second=await retrieval.listSources(f.who,{limit:1,cursor:first.nextCursor!});assert.equal(second.sources.length,1);assert.equal(second.hasMore,false);assert.equal(second.nextCursor,null);
  assert.deepEqual([...first.sources,...second.sources].map(s=>s.taskId).sort(),[a.taskId,b.taskId].sort());assert(!first.sources.some(s=>s.taskId===foreign.taskId));
  await remote.deleteTask(f.who,a.taskId);assert.deepEqual((await retrieval.listSources(f.who)).sources.map(s=>s.taskId),[b.taskId]);
  assert.equal((await retrieval.listSources(other.who)).sources[0].taskId,foreign.taskId);
});
test('source pins reject tampered hash, parse, model, dimension, manifest or current revision before creating a receipt',async()=>{
  const f=await fixture(),a=await index(f);
  for(const source of[{...a.source,artifactDigest:'d'.repeat(64)},{...a.source,parseDigest:'d'.repeat(64)},{...a.source,model:'other'},
    {...a.source,dimension:3},{...a.source,chunker:{...a.source.chunker,revision:2}},{...a.source,contentHash:'d'.repeat(64)},
    {...a.source,target:{...a.source.target,sha256:'d'.repeat(64)}}]){
    const request={...a.request,requestId:randomUUID(),sources:[source]};await assert.rejects(retrieval.retrieve(f.who,request),{code:'REMOTE_RETRIEVAL_SOURCE_CHANGED'});
    assert.equal((await retrieval.lookup(f.who,request.requestId)).status,'absent');
  }
  const created=await retrieval.retrieve(f.who,a.request);
  const update=operation('paper',{...a.parent.data!,title:'Renamed after preview'},{entityId:a.parent.entityId,baseRevision:1});assert.equal((await sync.push(f.who,{protocolVersion:1,deviceId:f.consumer.device.id,operations:[update]})).results[0].status,'applied');
  await assert.rejects(retrieval.retrieve(f.who,a.request),{code:'REMOTE_RETRIEVAL_SOURCE_CHANGED'});await assert.rejects(retrieval.lookup(f.who,a.request.requestId),{code:'REMOTE_RETRIEVAL_SOURCE_CHANGED'});
  const current=(await retrieval.source(f.who,a.taskId)).source;assert.equal(current.target.paperRevision,2);assert.equal(current.artifactDigest,created.receipt.request.sources[0].artifactDigest);
  assert.equal((await retrieval.retrieve(f.who,{...a.request,requestId:randomUUID(),sources:[current]})).receipt.request.sources[0].target.paperRevision,2);
});
test('deleted papers, versions and artifacts cannot lend historical text to a new or stale request',async()=>{
  for(const kind of['paper','attachmentVersion','artifact']as const){
    const f=await fixture(),a=await index(f);await retrieval.retrieve(f.who,a.request);
    if(kind==='artifact')await remote.deleteTask(f.who,a.taskId);else{const op=operation(kind,null,{entityId:kind==='paper'?a.parent.entityId:a.attachment.entityId,baseRevision:1,mutation:'delete'});assert.equal((await sync.push(f.who,{protocolVersion:1,deviceId:f.consumer.device.id,operations:[op]})).results[0].status,'applied');}
    await assert.rejects(retrieval.source(f.who,a.taskId),{code:'REMOTE_RETRIEVAL_SOURCE_UNAVAILABLE'});await assert.rejects(retrieval.lookup(f.who,a.request.requestId),{code:'REMOTE_RETRIEVAL_SOURCE_UNAVAILABLE'});
    assert.equal((await retrieval.listSources(f.who)).sources.length,0);assert.equal((await retrieval.remove(f.who,a.request.requestId)).status,'removed');
  }
});
test('tenant isolation, RLS, session revocation and immutable request-ID tombstones hold in the actual runtime role',async()=>{
  const f=await fixture(),a=await index(f),other=await fixture();const first=await retrieval.retrieve(f.who,a.request);
  await assert.rejects(retrieval.source(other.who,a.taskId),{code:'REMOTE_RETRIEVAL_SOURCE_UNAVAILABLE'});await assert.rejects(retrieval.retrieve(other.who,a.request),{code:'REMOTE_RETRIEVAL_SOURCE_UNAVAILABLE'});
  assert.equal((await retrieval.lookup(other.who,a.request.requestId)).status,'absent');
  await account(other.who,async c=>{assert.equal((await c.client.query('SELECT 1 FROM paperquay.remote_retrieval_requests WHERE account_id=$1',[f.consumer.accountId])).rowCount,0);
    assert.equal((await c.client.query("UPDATE paperquay.remote_retrieval_requests SET state='removed',request_payload=NULL,result_payload=NULL WHERE account_id=$1",[f.consumer.accountId])).rowCount,0);});
  await assert.rejects(retrieval.retrieve(f.who,{...a.request,query:'different query'}),{code:'REMOTE_RETRIEVAL_REQUEST_REUSED'});
  await assert.rejects(account(f.who,c=>c.client.query("UPDATE paperquay.remote_retrieval_requests SET request_payload='{}' WHERE account_id=$1 AND request_id=$2",[c.account.id,a.request.requestId])),{code:'23514'});
  await assert.rejects(account(f.who,c=>c.client.query('DELETE FROM paperquay.remote_retrieval_requests WHERE account_id=$1',[c.account.id])),{code:'42501'});
  assert.equal((await retrieval.remove(f.who,a.request.requestId)).status,'removed');assert.equal((await retrieval.lookup(f.who,a.request.requestId)).requestDigest,first.receipt.requestDigest);
  await assert.rejects(retrieval.retrieve(f.who,a.request),{code:'REMOTE_RETRIEVAL_REMOVED'});await assert.rejects(retrieval.retrieve(f.who,{...a.request,query:'different query'}),{code:'REMOTE_RETRIEVAL_REQUEST_REUSED'});
  const row=await account(f.who,async c=>(await c.client.query('SELECT request_payload,result_payload,request_digest,result_digest FROM paperquay.remote_retrieval_requests WHERE account_id=$1 AND request_id=$2',[c.account.id,a.request.requestId])).rows[0]);
  assert.equal(row.request_payload,null);assert.equal(row.result_payload,null);assert.equal(row.result_digest,first.receipt.resultDigest);
  await sync.revokeDevice(f.who,f.consumer.device.id);await assert.rejects(retrieval.listSources(f.who),{code:'SESSION_REVOKED'});
});
test('actual HTTP routes recover a lost commit reply using GET or exact POST without changing the saved result',async t=>{
  const f=await fixture(),a=await index(f);await remote.withdrawProvider(f.computer);let lose=true;
  const repo:RemoteRetrievalRepository={...retrieval,retrieve:async(...args)=>{const result=await retrieval.retrieve(...args);if(lose){lose=false;throw new ApiError('SERVICE_TEMPORARILY_UNAVAILABLE',503);}return result;}};
  const app=await buildApp({config:testConfig({PAPERQUAY_REMOTE_RETRIEVAL_ENABLED:'1'}),repository:sync,remoteRetrievalRepository:repo,
    verifyToken:async header=>{if(header!=='Bearer synthetic')throw new ApiError('AUTHENTICATION_REQUIRED',401);return f.who;},rateLimitEnabled:false});t.after(()=>app.close());
  const headers={authorization:'Bearer synthetic'},url='/v1/remote-retrieval/requests';
  const capability=(await app.inject('/v1/capabilities')).json();assert.equal(capability.features.remoteRetrieval,1);assert.equal(capability.features.remoteTasks,undefined);assert.equal(capability.remoteRetrieval.mode,'lexical-v1');
  assert.equal((await app.inject({url:'/v1/remote-tasks/jobs',headers})).statusCode,503);
  assert.equal((await app.inject({url:'/v1/remote-retrieval/sources?limit=8',headers})).json().sources[0].taskId,a.taskId);
  assert.equal((await app.inject({method:'POST',url,headers,payload:a.request})).statusCode,503);
  const recovered=(await app.inject({url:url+'/'+a.request.requestId,headers})).json();assert.equal(recovered.status,'complete');await validateRemoteRetrievalReceipt(recovered.receipt);
  const replay=(await app.inject({method:'POST',url,headers,payload:a.request})).json();assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,recovered.receipt);
  const count=await account(f.who,async c=>(await c.client.query('SELECT count(*) AS count FROM paperquay.remote_retrieval_requests WHERE account_id=$1',[c.account.id])).rows[0].count);assert.equal(Number(count),1);
});
test('PostgreSQL independently enforces receipt, retained and byte quotas and preflight creates no unknown partial result',async()=>{
  for(const mode of['receipts','retained','bytes']as const){
    const f=await fixture(),a=await index(f),count=mode==='receipts'?L.receipts:mode==='retained'?L.retained:41,state=mode==='receipts'?'removed':'complete';
    const input=state==='removed'?null:'{}',output=state==='removed'?null:mode==='bytes'?JSON.stringify({text:'X'.repeat(200000)}):'{}';
    await account(f.who,c=>c.client.query(`INSERT INTO paperquay.remote_retrieval_requests(account_id,request_id,requester_device_id,request_digest,state,request_payload,result_payload,result_digest)
      SELECT $1,gen_random_uuid(),$2,$3,$4,$5::jsonb,$6::jsonb,$3 FROM generate_series(1,$7)`,[c.account.id,c.device.id,'d'.repeat(64),state,input,output,count]));
    await assert.rejects(retrieval.retrieve(f.who,a.request),{code:'REMOTE_RETRIEVAL_STORAGE_FULL'});assert.equal((await retrieval.lookup(f.who,a.request.requestId)).status,'absent');
    await assert.rejects(account(f.who,c=>c.client.query(`INSERT INTO paperquay.remote_retrieval_requests(account_id,request_id,requester_device_id,request_digest,state,request_payload,result_payload,result_digest)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$4)`,[c.account.id,randomUUID(),c.device.id,'e'.repeat(64),state,input,output])),{code:'23514'});
  }
});
test('a corrupted or mismatched artifact manifest is excluded and cannot be searched even if its row is marked successful',async()=>{
  const f=await fixture(),a=await index(f);
  // The artifact table disallows updates. Replace a terminal artifact in this isolated fixture through its allowed delete/insert path.
  const wrong=Buffer.from(JSON.stringify({...a.artifact,model:'wrong-model'}));
  await account(f.who,async c=>{const row=(await c.client.query('SELECT completion_fence FROM paperquay.remote_task_artifacts WHERE account_id=$1 AND job_id=$2',[c.account.id,a.taskId])).rows[0];
    await c.client.query('DELETE FROM paperquay.remote_task_artifacts WHERE account_id=$1 AND job_id=$2',[c.account.id,a.taskId]);
    await c.client.query('INSERT INTO paperquay.remote_task_artifacts(account_id,job_id,digest,size_bytes,content,completion_fence)VALUES($1,$2,$3,$4,$5,$6)',[c.account.id,a.taskId,retrievalHash(wrong),wrong.length,wrong,row.completion_fence]);});
  await assert.rejects(retrieval.source(f.who,a.taskId),{code:'REMOTE_RETRIEVAL_SOURCE_INVALID'});assert.equal((await retrieval.listSources(f.who)).sources.length,0);
  await assert.rejects(retrieval.retrieve(f.who,a.request),{code:'REMOTE_RETRIEVAL_SOURCE_CHANGED'});
});
