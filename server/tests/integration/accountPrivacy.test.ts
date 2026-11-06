import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import pg from 'pg';
import { PostgresSyncStore } from '../../src/store.ts';
import type { VerifiedIdentity } from '../../src/auth.ts';
import type { AccountClosureRequest } from '../../src/account-privacy.ts';
import { buildApp } from '../../src/app.ts';
import { identity, operation, paper, version, testConfig } from '../fixtures.ts';
import { retrievalFixture } from '../../../tests/remoteRetrievalFixtures.ts';

const databaseUrl=process.env.PAPERQUAY_DATABASE_URL;
if(!databaseUrl||process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES!=='1')throw new Error('Use the explicitly owned isolated migrated test database.');
const pool=new pg.Pool({connectionString:databaseUrl,max:8});
const erasureUrl=process.env.PAPERQUAY_ERASURE_DATABASE_URL;
if(!erasureUrl)throw new Error('Independent isolated erasure role required.');
const erasurePool=new pg.Pool({connectionString:erasureUrl,max:2});
const store=new PostgresSyncStore({pool,erasurePool,cursorSecret:Buffer.alloc(32,63),cloudPdfEnabled:true});
const privacy=store.privacy();
before(async()=>assert.equal(await store.ready(),true,'Apply migration 013 and scoped grants.'));
after(async()=>{await Promise.all([pool.end(),erasurePool.end()]);});
const businessTables=['devices','entities','changes','operation_receipts','conflicts','cloud_pdfs','remote_task_providers',
  'remote_tasks','remote_task_requests','remote_task_artifacts','model_inference_providers','model_inference_jobs','remote_retrieval_requests'];

async function account() {
  const who={...identity(),authenticatedAtMs:Date.now(),expiresAtMs:Date.now()+3600000};
  const second={...who,sessionId:randomUUID()};
  const view=await store.registerDevice(who,{name:'Synthetic private owner',platform:'web'});
  const peer=await store.registerDevice(second,{name:'Synthetic offline computer',platform:'linux'});
  return {who,second,view,peer};
}
type Fixture=Awaited<ReturnType<typeof account>>;
function closure(a:Fixture,eraseDevices=true):AccountClosureRequest {
  return {accountId:a.view.accountId,requestId:randomUUID(),confirmation:'注销 '+a.view.accountId,deleteCloudCopies:true,eraseDevices};
}
async function inAccount<T>(who:VerifiedIdentity,accountId:string,work:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('paperquay.issuer',$1,true),set_config('paperquay.subject',$2,true),set_config('paperquay.account_id',$3,true)",
      [who.issuer,who.subject,accountId]);
    const result=await work(client);await client.query('COMMIT');return result;
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
async function seed(a:Fixture) {
  const parent=operation('paper',paper('Private export sentinel'));
  const content=Buffer.from('%PDF-1.7\n'+'synthetic-private-byte-sentinel'.repeat(6000)+'\n%%EOF');
  const attachment=operation('attachmentVersion',{...version(parent.entityId,1),sizeBytes:content.length,
    sha256:createHash('sha256').update(content).digest('hex')});
  const note=operation('note',{paperId:parent.entityId,title:'Private note',body:'Retained private content',format:'markdown'});
  for(const op of[parent,attachment,note])assert.equal((await store.push(a.who,{protocolVersion:1,deviceId:a.view.device.id,operations:[op]})).results[0].status,'applied');
  assert.equal((await store.push(a.second,{protocolVersion:1,deviceId:a.peer.device.id,operations:[operation('note',
    {...note.data!,body:'Private losing conflict'}, {entityId:note.entityId})]})).results[0].status,'conflict');
  const prepared=await store.prepareCloudPdfUpload(a.who,attachment.entityId);
  await store.putCloudPdf(a.who,attachment.entityId,content,prepared.generation);
  // Real immutable billing/request and retrieval receipts, plus a real stored
  // index artifact, ensure closure does not merely remove visible sync rows.
  await store.modelInference().cancelInvocation(a.who,randomUUID());
  const index=retrievalFixture(),remote=store.remoteTasks(),profile={id:'privacy-index',kind:'index' as const,
    revision:1,digest:'c'.repeat(64),model:'synthetic-embedding'};
  const indexPaper=operation('paper',paper('Index private sentinel'),{entityId:index.artifact.paperId});
  const indexVersion=operation('attachmentVersion',version(indexPaper.entityId,2),{entityId:index.artifact.attachmentVersionId});
  for(const op of[indexPaper,indexVersion])assert.equal((await store.push(a.who,{protocolVersion:1,deviceId:a.view.device.id,operations:[op]})).results[0].status,'applied');
  await remote.publishProvider(a.second,[profile]);
  const created=await remote.createTask(a.who,{requestId:randomUUID(),kind:'index',versionId:indexVersion.entityId,
    providerDeviceId:a.peer.device.id,profileRef:{id:profile.id,revision:1,digest:profile.digest},indexSourceDigest:index.artifact.parseDigest});
  const claim=(await remote.claimTask(a.second)).claim!;
  await remote.completeTask(a.second,created.task.id,claim.lease,index.bytes);
  const source=(await store.remoteRetrieval().source(a.who,created.task.id)).source;
  await store.remoteRetrieval().retrieve(a.who,{...index.request,sources:[source]});
  return {parent,content,attachment,index,taskId:created.task.id};
}

test('personal export is a consistent own-account stream with complete history, conflicts and bounded binary chunks',async()=>{
  const a=await account(),data=await seed(a),other=await account();
  await store.push(other.who,{protocolVersion:1,deviceId:other.view.device.id,operations:[operation('paper',paper('Foreign sentinel never export'))]});
  const output:Buffer[]=[];for await(const part of privacy.exportData(a.who,new AbortController().signal))output.push(part);
  const rows=output.map(part=>JSON.parse(part.toString('utf8')));
  const end=rows.at(-1);assert.equal(end.kind,'complete');
  assert.equal(end.sha256,createHash('sha256').update(Buffer.concat(output.slice(0,-1))).digest('hex'));
  assert.equal(rows[0].accountId,a.view.accountId);assert.equal(rows[0].consistency,'repeatable-read');
  assert.equal(end.records,rows.filter(row=>row.kind==='record').length);assert.equal(end.files,2);
  assert(rows.some(row=>row.table==='conflicts'&&row.kind==='record'));
  assert(rows.some(row=>row.table==='model_inference_jobs'&&row.kind==='record'));
  assert(rows.some(row=>row.table==='remote_retrieval_requests'&&row.kind==='record'));
  assert(!Buffer.concat(output).toString().includes('Foreign sentinel'));
  assert(!rows.some(row=>row.kind==='record'&&['session_id','fence','completion_fence','provider_journal_key','recovery_journal_key','journal_key'].some(key=>key in row.data)));
  const binary=rows.filter(row=>row.kind==='file-chunk');assert(binary.every(row=>row.bytes<=65536));
  assert.deepEqual(Buffer.concat(binary.filter(row=>row.id===data.attachment.entityId).map(row=>Buffer.from(row.base64,'base64'))),data.content);
  assert.deepEqual(Buffer.concat(binary.filter(row=>row.id===data.taskId).map(row=>Buffer.from(row.base64,'base64'))),data.index.bytes);
  assert.equal(end.fileBytes,data.content.length+data.index.bytes.length);
});

test('closure requires recent signed authentication and separate explicit cloud deletion; other accounts remain untouched',async()=>{
  const a=await account(),b=await account(),request=closure(a);
  for(const who of[{...a.who,authenticatedAtMs:undefined},{...a.who,authenticatedAtMs:Date.now()-600000}]) {
    await assert.rejects(privacy.close(who,request),{code:'RECENT_AUTHENTICATION_REQUIRED'});
  }
  await assert.rejects(privacy.close(a.who,{...request,confirmation:'confirm'}),{code:'VALIDATION_FAILED'});
  await assert.rejects(privacy.close(b.who,request),{code:'VALIDATION_FAILED'});
  await assert.rejects(privacy.close(a.who,{...request,deleteCloudCopies:false} as never),{code:'VALIDATION_FAILED'});
  assert.equal((await privacy.status(a.who)).state,'active');assert.equal((await privacy.status(b.who)).state,'active');
});

test('atomic closure purges every application payload and blocks rebind, sync, providers and streaming access',async()=>{
  const a=await account();await seed(a);const request=closure(a);
  const closed=await privacy.close(a.who,request);assert.equal(closed.state,'closed');
  assert.equal(closed.deviceErasure.pending,2);assert.equal(closed.deviceErasure.thisDevicePending,true);
  assert.deepEqual(await privacy.close(a.who,request),closed);
  await assert.rejects(privacy.close(a.who,{...request,requestId:randomUUID()}),{code:'ACCOUNT_ALREADY_CLOSED'});
  await assert.rejects(privacy.close(a.who,{...request,eraseDevices:false}),{code:'ACCOUNT_ALREADY_CLOSED'});
  for(const read of[()=>store.me(a.who),()=>store.pull(a.who,undefined,100),()=>store.desktopPdfSession(a.who),
    ()=>store.modelInference().availability(a.who),()=>store.remoteTasks().claimTask(a.second),
    ()=>store.registerDevice({...a.who,sessionId:randomUUID()},{name:'Must stay closed',platform:'web'})]) {
    await assert.rejects(read(),{code:'ACCOUNT_CLOSED'});
  }
  await inAccount(a.who,a.view.accountId,async client=>{
    for(const table of businessTables)assert.equal(Number((await client.query('SELECT count(*) FROM paperquay.'+table+' WHERE account_id=$1',[a.view.accountId])).rows[0].count),0,table);
    const retained=(await client.query('SELECT closed_at,entity_count,receipt_count,retained_bytes,cloud_pdf_bytes FROM paperquay.accounts WHERE id=$1',[a.view.accountId])).rows[0];
    assert(retained.closed_at);assert.equal(retained.entity_count,0);assert.equal(retained.receipt_count,0);
    assert.equal(Number(retained.retained_bytes),0);assert.equal(Number(retained.cloud_pdf_bytes),0);
  });
  await assert.rejects(inAccount(a.who,a.view.accountId,client=>client.query(
    "UPDATE paperquay.accounts SET subject=set_config('paperquay.subject',$2,true) WHERE id=$1",[a.view.accountId,randomUUID()])),/ACCOUNT_CLOSURE_IMMUTABLE/);
});

test('offline erasure remains pending until that exact verified session acknowledges its own device',async()=>{
  const a=await account();await privacy.close(a.who,closure(a));
  await assert.rejects(privacy.acknowledgeErasure(a.who,a.peer.device.id),{code:'ERASURE_SESSION_MISMATCH'});
  await privacy.acknowledgeErasure(a.who,a.view.device.id);await privacy.acknowledgeErasure(a.who,a.view.device.id);
  const pending=await privacy.status(a.who);assert.equal(pending.deviceErasure.pending,1);assert.equal(pending.deviceErasure.acknowledged,1);
  assert.equal((await privacy.status(a.second)).deviceErasure.thisDevicePending,true);
  await privacy.acknowledgeErasure(a.second,a.peer.device.id);
  assert.equal((await privacy.status(a.who)).deviceErasure.pending,0);
  const b=await account();await privacy.close(b.who,closure(b,false));
  assert.deepEqual((await privacy.status(b.who)).deviceErasure,{requested:false,pending:0,acknowledged:0,thisDevicePending:false});
});

test('closure commit failure rolls back all payloads and receipts before an exact explicit retry',async()=>{
  const a=await account(),data=await seed(a),request=closure(a);
  const broken=new PostgresSyncStore({pool,erasurePool,cursorSecret:Buffer.alloc(32,63),hooks:{beforeCommit:async event=>{
    if(event.kind==='account-close')throw new Error('synthetic failure before commit');
  }}});
  await assert.rejects(broken.privacy().close(a.who,request),/synthetic failure/);
  assert.equal((await privacy.status(a.who)).state,'active');
  assert.deepEqual((await store.downloadCloudPdf(a.who,data.attachment.entityId)).content,data.content);
  assert.equal((await store.listConflicts(a.who,undefined,100)).conflicts.length,1);
  assert.equal((await privacy.close(a.who,request)).state,'closed');
});

test('forged runtime erasure context cannot alter closure or delete immutable history outside the narrow definer',async()=>{
  const a=await account();await store.modelInference().cancelInvocation(a.who,randomUUID());
  await inAccount(a.who,a.view.accountId,async client=>{
    await client.query("SELECT set_config('paperquay.erasure_account',$1,true)",[a.view.accountId]);
    assert.equal((await client.query('SELECT paperquay.erasure_context_matches($1) AS allowed',[a.view.accountId])).rows[0].allowed,false);
  });
  await assert.rejects(inAccount(a.who,a.view.accountId,client=>client.query('DELETE FROM paperquay.model_inference_jobs WHERE account_id=$1',[a.view.accountId])),{code:'42501'});
  await assert.rejects(inAccount(a.who,a.view.accountId,client=>client.query("UPDATE paperquay.accounts SET closed_at=clock_timestamp(),closure_request_id=$2 WHERE id=$1",[a.view.accountId,randomUUID()])),/ACCOUNT_CLOSURE_IMMUTABLE/);
  assert.equal((await privacy.status(a.who)).state,'active');
});

test('runtime SQL cannot erase a known account with forged GUCs and a readable session ID',async()=>{
  const a=await account(),request=closure(a);
  await inAccount(a.who,a.view.accountId,async client=>{
    const row=(await client.query('SELECT session_id FROM paperquay.devices WHERE account_id=$1 AND id=$2',[a.view.accountId,a.view.device.id])).rows[0];
    assert.equal(row.session_id,a.who.sessionId);
    assert.equal((await client.query("SELECT has_function_privilege(current_user,'paperquay.erase_account(uuid,uuid,text,boolean)','EXECUTE') AS allowed")).rows[0].allowed,false);
  });
  await assert.rejects(inAccount(a.who,a.view.accountId,client=>client.query(
    'SELECT paperquay.erase_account($1,$2,$3,$4)',[a.view.accountId,request.requestId,a.who.sessionId,true])),{code:'42501'});
  await assert.rejects(pool.query('SET ROLE paperquay_erasure'),{code:'42501'});
  assert.equal((await privacy.status(a.who)).state,'active');
  const role=(await erasurePool.query('SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolbypassrls:false,rolcreaterole:false});
  await assert.rejects(erasurePool.query('DELETE FROM paperquay.model_inference_jobs'),{code:'42501'});
  const ordinaryOnly=new PostgresSyncStore({pool,cursorSecret:Buffer.alloc(32,63)});
  await assert.rejects(ordinaryOnly.privacy().close(a.who,request),{code:'ACCOUNT_CLOSURE_UNAVAILABLE'});
  assert.equal((await privacy.close(a.who,request)).state,'closed');
});

test('a concurrent writer waits for closure and cannot recreate purged payloads after commit',async()=>{
  const a=await account();let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(done=>{entered=done;}),barrier=new Promise<void>(done=>{release=done;});
  const closer=new PostgresSyncStore({pool,erasurePool,cursorSecret:Buffer.alloc(32,63),hooks:{beforeCommit:async event=>{
    if(event.kind==='account-close'){entered();await barrier;}
  }}});
  const closing=closer.privacy().close(a.who,closure(a));await waiting;
  const writing=store.push(a.second,{protocolVersion:1,deviceId:a.peer.device.id,operations:[operation('paper',paper('Must never resurrect'))]});
  const rejected=assert.rejects(writing,{code:'ACCOUNT_CLOSED'});
  release();await closing;await rejected;
  assert.equal((await privacy.status(a.who)).state,'closed');
});

test('a TEMP catalog shadow cannot impersonate the erasure definer owner',async()=>{
  const a=await account();
  await inAccount(a.who,a.view.accountId,async client=>{
    // The disposable CI runtime has TEMP, unlike the production initializer.
    // This must still fail closed independently of that defense in depth.
    await client.query('CREATE TEMP TABLE pg_proc(oid oid,proowner oid)');
    await client.query(`INSERT INTO pg_temp.pg_proc VALUES('paperquay.erase_account(uuid,uuid,text,boolean)'::regprocedure::oid,
      (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))`);
    await client.query("SELECT set_config('paperquay.erasure_account',$1,true)",[a.view.accountId]);
    assert.equal((await client.query('SELECT paperquay.erasure_context_matches($1) AS allowed',[a.view.accountId])).rows[0].allowed,false);
    await client.query('DROP TABLE pg_temp.pg_proc');
  });
});

test('an export cannot complete after abort, expiry, session revocation or concurrent account closure',async()=>{
  for(const reason of['abort','expiry','revoke','close'] as const) {
    const a=await account();await store.push(a.who,{protocolVersion:1,deviceId:a.view.device.id,operations:[operation('paper',paper())]});
    const stop=new AbortController(),iterator=privacy.exportData(a.who,stop.signal)[Symbol.asyncIterator]();
    assert.equal(JSON.parse((await iterator.next()).value!.toString()).kind,'header');
    if(reason==='abort')stop.abort();
    if(reason==='expiry')a.who.expiresAtMs=Date.now()-1;
    if(reason==='revoke')await store.revokeDevice(a.second,a.view.device.id);
    if(reason==='close')await privacy.close(a.second,closure(a));
    if(reason==='revoke'||reason==='close')await new Promise(done=>setTimeout(done,1050));
    await assert.rejects(async()=>{for(;;){const next=await iterator.next();if(next.done)break;
      assert.notEqual(JSON.parse(next.value.toString()).kind,'complete');}});
  }
});

test('HTTP privacy endpoints reject malformed confirmations and authenticated foreign account selections',async()=>{
  const a=await account(),other=await account();
  const app=await buildApp({config:testConfig(),repository:store,accountPrivacyRepository:privacy,verifyToken:async header=>header==='Bearer owner'?a.who:other.who});
  try {
    assert.equal((await app.inject({method:'GET',url:'/v1/capabilities'})).json().features.accountPrivacy,1);
    for(const body of[{...closure(a),unexpected:true},{...closure(a),deleteCloudCopies:false},{...closure(a),eraseDevices:'yes'}]) {
      assert.equal((await app.inject({method:'POST',url:'/v1/privacy/close',headers:{authorization:'Bearer owner'},payload:body})).statusCode,400);
    }
    assert.equal((await app.inject({method:'POST',url:'/v1/privacy/close',headers:{authorization:'Bearer other'},payload:closure(a)})).statusCode,400);
    assert.equal((await privacy.status(a.who)).state,'active');
  } finally {await app.close();}
});
