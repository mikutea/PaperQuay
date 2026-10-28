import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { PostgresSyncStore } from '../../src/store.ts';
import { buildApp } from '../../src/app.ts';
import { identity, operation, paper, version, testConfig } from '../fixtures.ts';
import { richFixture, conversationFixture } from '../../../tests/fixtures/extendedSync.ts';
import { appendAiConversation, conversationRecord } from '../../../packages/ai-core/src/conversation.ts';
import { AI_CONVERSATIONS_FEATURE, RICH_NOTES_FEATURE, type SyncOperation } from '../../../packages/sync-core/src/index.ts';
const databaseUrl=process.env.PAPERQUAY_DATABASE_URL;
if(!databaseUrl||process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES!=='1')throw new Error('Use an isolated migrated database and explicitly enable synthetic integration writes.');
const pool=new pg.Pool({connectionString:databaseUrl,max:6}),store=new PostgresSyncStore({pool,cursorSecret:Buffer.alloc(32,67)});
const features={richNotes:true,aiConversations:true};
before(async()=>assert.equal(await store.ready(),true));after(async()=>{await pool.end();});
async function fixture(){
  const who=identity(),peer={...identity(),subject:who.subject};
  const a=await store.registerDevice(who,{name:'Extended synthetic A',platform:'web'}),b=await store.registerDevice(peer,{name:'Extended synthetic B',platform:'android'});
  const push=async(op:SyncOperation,old=false)=>(await store.push(who,{protocolVersion:1,deviceId:a.device.id,operations:[op]},old?undefined:features)).results[0];
  const parent=operation('paper',paper()),attachment=operation('attachmentVersion',version(parent.entityId));
  assert.equal((await push(parent)).status,'applied');assert.equal((await push(attachment)).status,'applied');
  return{who,peer,a,b,push,parent,attachment};
}
test('real PostgreSQL retains exact rich AST and conversations across a repository restart, while HTTP capability negotiation hides unsupported content',async()=>{
  const f=await fixture(),rich=operation('note',richFixture(f.parent.entityId)),chat=operation('aiConversation',conversationFixture(f.parent.entityId,f.attachment.entityId));
  assert.equal((await f.push(rich)).status,'applied');assert.equal((await f.push(chat)).status,'applied');
  const restarted=new PostgresSyncStore({pool,cursorSecret:Buffer.alloc(32,67)});
  const rows=(await restarted.pull(f.peer,undefined,100)).records;
  assert.deepEqual(rows.find(row=>row.entityId===rich.entityId)!.data,rich.data);assert.deepEqual(rows.find(row=>row.entityId===chat.entityId)!.data,chat.data);
  const app=await buildApp({config:testConfig(),repository:restarted,verifyToken:async()=>f.peer});
  try{
    const old=await app.inject({method:'GET',url:'/v1/sync/pull',headers:{authorization:'Bearer synthetic'}});assert.equal(old.statusCode,200);
    assert.equal(old.json().records.some((row:any)=>row.entityId===rich.entityId||row.entityId===chat.entityId),false);assert.ok(old.json().nextCursor);
    const current=await app.inject({method:'GET',url:'/v1/sync/pull',headers:{authorization:'Bearer synthetic','X-PaperQuay-Features':[RICH_NOTES_FEATURE,AI_CONVERSATIONS_FEATURE].join(', ')}});
    assert.equal(current.statusCode,200);assert.deepEqual(current.json().records.find((row:any)=>row.entityId===rich.entityId).data,rich.data);
    assert.deepEqual(current.json().records.find((row:any)=>row.entityId===chat.entityId).data,chat.data);
  }finally{await app.close();}
});
test('legacy writers cannot delete or downgrade rich data or mutate conversations, including conflict resolution',async()=>{
  const f=await fixture(),rich=operation('note',richFixture(f.parent.entityId)),chat=operation('aiConversation',conversationFixture(f.parent.entityId,f.attachment.entityId));
  await f.push(rich);await f.push(chat);
  const deletion=await f.push(operation('note',null,{entityId:rich.entityId,baseRevision:1,mutation:'delete'}),true);assert.equal(deletion.code,'FEATURE_NOT_NEGOTIATED');
  const downgrade=await f.push(operation('note',{paperId:f.parent.entityId,title:'Flattened',body:'wrong body',format:'markdown'},{entityId:rich.entityId,baseRevision:1}));
  assert.equal(downgrade.code,'RICH_NOTE_DOWNGRADE_FORBIDDEN');
  assert.equal((await f.push(operation('aiConversation',null,{entityId:chat.entityId,baseRevision:1,mutation:'delete'}),true)).code,'FEATURE_NOT_NEGOTIATED');
  const modified=operation('note',{...rich.data!,title:'Current'},{entityId:rich.entityId,baseRevision:1});await f.push(modified);
  const conflict=await f.push(operation('note',{...rich.data!,title:'Offline draft'},{entityId:rich.entityId,baseRevision:1}));assert.equal(conflict.status,'conflict');
  assert.equal((await store.resolveConflict(f.who,conflict.conflictId!,{opId:randomUUID(),expectedRevision:2,choice:'attempted'})).code,'FEATURE_NOT_NEGOTIATED');
  const resolved=await store.resolveConflict(f.who,conflict.conflictId!,{opId:randomUUID(),expectedRevision:2,choice:'attempted'},features);
  assert.equal(resolved.status,'applied');assert.deepEqual((resolved.record!.data as any).document,(rich.data as ReturnType<typeof richFixture>).document);
});
test('concurrent conversation continuations retain both full drafts and require explicit CAS merge under the immutable common source',async()=>{
  const f=await fixture(),base=conversationFixture(f.parent.entityId,f.attachment.entityId),created=operation('aiConversation',base);await f.push(created);
  const next=(question:string,second:number)=>{const record=conversationRecord(base,0);record.id=randomUUID();record.question=question;
    record.createdAt=`2026-10-28T00:00:0${second}.000Z`;record.updatedAt=`2026-10-28T00:00:0${second+1}.000Z`;return record;};
  const a=next('设备A的继续问题',2),b=next('设备B的继续问题',4),dataA=appendAiConversation(base,a),dataB=appendAiConversation(base,b);
  const [left,right]=await Promise.all([f.push(operation('aiConversation',dataA,{entityId:created.entityId,baseRevision:1})),
    store.push(f.peer,{protocolVersion:1,deviceId:f.b.device.id,operations:[operation('aiConversation',dataB,{entityId:created.entityId,baseRevision:1})]},features).then(value=>value.results[0])]);
  const conflict=[left,right].find(value=>value.status==='conflict')!;assert.ok(conflict);
  const list=await store.listConflicts(f.peer,undefined,100);const saved=list.conflicts.find(value=>value.conflictId===conflict.conflictId)!;
  assert.equal((saved.attemptedOperation.data as any).turns.length,2);assert.equal((saved.currentRecord!.data as any).turns.length,2);
  const merged=appendAiConversation(appendAiConversation(base,a),b);
  const result=await store.resolveConflict(f.who,conflict.conflictId!,{opId:randomUUID(),expectedRevision:2,choice:'merged',mutation:'put',data:merged},features);
  assert.equal(result.status,'applied');assert.deepEqual((result.record!.data as any).turns.map((value:any)=>value.question),base.turns.map(value=>value.question).concat([a.question,b.question]));
  const changed={...merged,context:{...merged.context,label:'Different common source'}};
  assert.equal((await f.push(operation('aiConversation',changed,{entityId:created.entityId,baseRevision:3}))).code,'IMMUTABLE_AI_SOURCE');
});
test('sync template limits use live PostgreSQL counts, explicit deletion frees capacity, and another account cannot read these records',async()=>{
  const f=await fixture();const template={version:1 as const,title:'合成模板',action:'ask' as const,question:'一个问题'};
  const operations=Array.from({length:100},()=>operation('aiTemplate',template));
  const written=await store.push(f.who,{protocolVersion:1,deviceId:f.a.device.id,operations},features);assert.equal(written.results.filter(value=>value.status==='applied').length,100);
  const extra=await f.push(operation('aiTemplate',template));assert.equal(extra.code,'AI_COLLECTION_LIMIT');
  assert.equal((await f.push(operation('aiTemplate',null,{entityId:operations[0].entityId,baseRevision:1,mutation:'delete'}))).status,'applied');
  assert.equal((await f.push(operation('aiTemplate',template))).status,'applied');
  const other=identity();await store.registerDevice(other,{name:'Other synthetic account',platform:'web'});
  assert.deepEqual((await store.pull(other,undefined,100)).records,[]);
});
