import assert from 'node:assert/strict';import test,{after}from'node:test';import{randomUUID}from'node:crypto';import pg from'pg';
import{PostgresSyncStore}from'../../src/store.ts';import{buildApp}from'../../src/app.ts';import{identity,operation,paper,testConfig}from'../fixtures.ts';
import{GRAPH_RELATIONS_FEATURE,GRAPH_RELATION_LIMITS,type GraphRelationData,type SyncOperation}from'../../../packages/sync-core/src/index.ts';
const url=process.env.PAPERQUAY_DATABASE_URL;if(!url||process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES!=='1')throw Error('Isolated migrated writable test database required');
const pool=new pg.Pool({connectionString:url,max:6}),store=new PostgresSyncStore({pool,cursorSecret:Buffer.alloc(32,38)}),features={richNotes:true,aiConversations:true,graphRelations:true};
after(async()=>pool.end());
async function setup(){const who=identity(),peer={...identity(),subject:who.subject},a=await store.registerDevice(who,{name:'Graph synthetic A',platform:'web'}),b=await store.registerDevice(peer,{name:'Graph synthetic B',platform:'android'});
 const push=async(op:SyncOperation,legacy=false)=>(await store.push(who,{protocolVersion:1,deviceId:a.device.id,operations:[op]},legacy?undefined:features)).results[0];
 const p=operation('paper',paper()),n=operation('note',{paperId:p.entityId,title:'Graph synthetic note',body:'Synthetic',format:'markdown'});assert.equal((await push(p)).status,'applied');assert.equal((await push(n)).status,'applied');
 const data:GraphRelationData={source:{entityType:'paper',entityId:p.entityId},target:{entityType:'note',entityId:n.entityId},relationType:'custom_relation',label:'补充方法',description:'人工建立的关系，尚未核验论证。',confidence:null,weight:.58,createdAt:'2026-10-31T00:00:00.000Z',updatedAt:null};
 return{who,peer,a,b,p,n,push,data};}
test('real PostgreSQL graph CRUD is replayable across repository restart, and legacy clients advance past hidden relations',async()=>{
 const f=await setup(),op=operation('graphRelation',f.data),written=await f.push(op);assert.equal(written.status,'applied');assert.deepEqual(written.record!.data,f.data);assert.equal((await f.push(op)).replayed,true);
 const restarted=new PostgresSyncStore({pool,cursorSecret:Buffer.alloc(32,38)});assert.deepEqual((await restarted.pull(f.peer,undefined,100)).records.find(r=>r.entityId===op.entityId)!.data,f.data);
 const app=await buildApp({config:testConfig(),repository:restarted,verifyToken:async()=>f.peer});try{
  const old=await app.inject({method:'GET',url:'/v1/sync/pull',headers:{authorization:'Bearer synthetic'}});assert.equal(old.statusCode,200);assert(!old.json().records.some((r:any)=>r.entityType==='graphRelation'));assert(old.json().nextCursor);
  const next=await app.inject({method:'GET',url:'/v1/sync/pull',headers:{authorization:'Bearer synthetic','X-PaperQuay-Features':GRAPH_RELATIONS_FEATURE}});assert.deepEqual(next.json().records.find((r:any)=>r.entityId===op.entityId).data,f.data);
 }finally{await app.close();}
 assert.equal((await f.push(operation('graphRelation',null,{entityId:op.entityId,baseRevision:1,mutation:'delete'}),true)).code,'FEATURE_NOT_NEGOTIATED');
 const edited={...f.data,label:'修订名称'};assert.equal((await f.push(operation('graphRelation',edited,{entityId:op.entityId,baseRevision:1}))).status,'applied');
 assert.equal((await f.push(operation('graphRelation',null,{entityId:op.entityId,baseRevision:2,mutation:'delete'}))).status,'applied');
 assert.equal((await f.push(operation('graphRelation',edited,{entityId:op.entityId,baseRevision:3}))).code,'RESTORE_REQUIRED');
 assert.equal((await f.push(operation('graphRelation',edited,{entityId:op.entityId,baseRevision:3,mutation:'restore'}))).status,'applied');
});
test('foreign and absent endpoints are indistinguishable; deleted endpoints never resurrect and cannot receive new/edited relations',async()=>{
 const f=await setup(),other=await setup(),missing=randomUUID();
 for(const entityId of[other.p.entityId,missing])assert.deepEqual((({code,retryable})=>({code,retryable}))(await f.push(operation('graphRelation',{...f.data,source:{entityType:'paper',entityId}}))),{code:'DEPENDENCY_NOT_READY',retryable:true});
 const op=operation('graphRelation',f.data);await f.push(op);await f.push(operation('paper',null,{entityId:f.p.entityId,baseRevision:1,mutation:'delete'}));
 assert.equal((await f.push(operation('graphRelation',{...f.data,label:'After parent delete'},{entityId:op.entityId,baseRevision:1}))).code,'REFERENCE_DELETED');
 assert.equal((await f.push(operation('graphRelation',f.data))).code,'REFERENCE_DELETED');
 assert.equal((await f.push(operation('graphRelation',null,{entityId:op.entityId,baseRevision:1,mutation:'delete'}))).status,'applied');
 assert.equal((await f.push(operation('graphRelation',f.data,{entityId:op.entityId,baseRevision:2,mutation:'restore'}))).code,'REFERENCE_DELETED');
 assert.equal((await store.pull(other.who,undefined,100)).records.some(r=>r.entityId===op.entityId),false);
});
test('graph binding/type/creation time are immutable, and simultaneous edits preserve full conflict drafts with explicit resolution',async()=>{
 const f=await setup(),op=operation('graphRelation',f.data);await f.push(op);
 for(const patch of[{source:f.data.target,target:f.data.source},{relationType:'ai_suggested'},{createdAt:'2026-10-31T00:01:00.000Z',updatedAt:null}])assert.equal((await f.push(operation('graphRelation',{...f.data,...patch} as GraphRelationData,{entityId:op.entityId,baseRevision:1}))).code,'IMMUTABLE_GRAPH_BINDING');
 const [a,b]=await Promise.all([f.push(operation('graphRelation',{...f.data,label:'Draft A'},{entityId:op.entityId,baseRevision:1})),store.push(f.peer,{protocolVersion:1,deviceId:f.b.device.id,operations:[operation('graphRelation',{...f.data,label:'Draft B'},{entityId:op.entityId,baseRevision:1})]},features).then(r=>r.results[0])]);
 const conflict=[a,b].find(r=>r.status==='conflict')!;assert.ok(conflict);
 const retained=(await store.listConflicts(f.who,undefined,100)).conflicts.find(c=>c.conflictId===conflict.conflictId)!;assert.notEqual((retained.attemptedOperation.data as GraphRelationData).label,(retained.currentRecord!.data as GraphRelationData).label);
 assert.equal((await store.resolveConflict(f.who,conflict.conflictId!,{opId:randomUUID(),expectedRevision:2,choice:'attempted'})).code,'FEATURE_NOT_NEGOTIATED');
 assert.equal((await store.resolveConflict(f.who,conflict.conflictId!,{opId:randomUUID(),expectedRevision:2,choice:'attempted'},features)).status,'applied');
});
test('live graph count quota serializes concurrent creates, deletion frees one slot and restore cannot bypass the limit',async()=>{
 const f=await setup(),ops=Array.from({length:GRAPH_RELATION_LIMITS.relations-1},()=>operation('graphRelation',f.data));
 for(let i=0;i<ops.length;i+=100){const r=await store.push(f.who,{protocolVersion:1,deviceId:f.a.device.id,operations:ops.slice(i,i+100)},features);assert(r.results.every(r=>r.status==='applied'));}
 const results=await Promise.all([f.push(operation('graphRelation',f.data)),f.push(operation('graphRelation',f.data))]);assert.equal(results.filter(r=>r.status==='applied').length,1);assert.equal(results.filter(r=>r.code==='GRAPH_COLLECTION_LIMIT').length,1);
 await f.push(operation('graphRelation',null,{entityId:ops[0].entityId,baseRevision:1,mutation:'delete'}));assert.equal((await f.push(operation('graphRelation',f.data))).status,'applied');
 assert.equal((await f.push(operation('graphRelation',f.data,{entityId:ops[0].entityId,baseRevision:2,mutation:'restore'}))).code,'GRAPH_COLLECTION_LIMIT');
});
test('UTF8 graph payload budget applies to live records and updates before writing any oversize candidate',async()=>{
 const f=await setup(),large={...f.data,description:'研'.repeat(4096)},ops=Array.from({length:180},()=>operation('graphRelation',large));let rejected=false;
 for(let i=0;i<ops.length;i+=100){const r=await store.push(f.who,{protocolVersion:1,deviceId:f.a.device.id,operations:ops.slice(i,i+100)},features);assert(r.results.every(r=>r.status==='applied'||r.code==='GRAPH_COLLECTION_LIMIT'));rejected ||=r.results.some(r=>r.code==='GRAPH_COLLECTION_LIMIT');}assert(rejected);
 const count=await pool.query('SELECT count(*) AS n,sum(octet_length(data::text)) AS bytes FROM paperquay.entities WHERE account_id=$1 AND entity_type=$2 AND deleted_at IS NULL',[f.a.accountId,'graphRelation']);assert(Number(count.rows[0].n)<GRAPH_RELATION_LIMITS.relations);assert(Number(count.rows[0].bytes)<=GRAPH_RELATION_LIMITS.accountBytes);
 assert.equal((await f.push(operation('graphRelation',null,{entityId:ops[0].entityId,baseRevision:1,mutation:'delete'}))).status,'applied');assert.equal((await f.push(operation('graphRelation',large))).status,'applied');
});
