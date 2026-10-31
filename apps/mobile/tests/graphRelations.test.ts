import test from'node:test';import assert from'node:assert/strict';import{IDBFactory}from'fake-indexeddb';
import{AccountStore}from'../src/storage/accountStore.ts';import{WorkspaceController,decodeWorkspace}from'../src/sync/workspace.ts';
import{canonicalJson,createAccountState,listVisibleEntities,type GraphRelationData,type SyncRecord}from'../../../packages/sync-core/src/index.ts';
import{planGraphRelation,assertGraphRelationPlan}from'../src/graph/relations.ts';import{buildMobileGraph,defaultGraphSelection,graphProjection}from'../src/graph/model.ts';
import{id,scope,now,entities,paper}from'./reviewFixtures.ts';
const data=():GraphRelationData=>({source:{entityType:'paper',entityId:id(2)},target:{entityType:'note',entityId:id(3)},relationType:'custom_relation',label:'方法补充',description:'人工建立的合成关系',confidence:null,weight:.58,createdAt:'2026-10-31T00:00:00.000Z',updatedAt:null});
const relation=()=>({entityType:'graphRelation' as const,entityId:id(70),data:data(),revision:1,deleted:false,pending:false,status:'synced' as const});
async function setup(t:any){const store=new AccountStore({decode:decodeWorkspace,indexedDB:new IDBFactory(),databaseName:crypto.randomUUID()}),sync=createAccountState(scope.accountId,id(20));sync.cursor='retained-cursor';
 for(const e of entities)sync.serverRecords[e.entityType+':'+e.entityId]={entityType:e.entityType,entityId:e.entityId,data:e.data,revision:1,schemaVersion:1,deletedAt:null,updatedAt:now,modifiedByDeviceId:id(20)} as SyncRecord;
 await store.update(scope,()=>({sync,pendingResolutions:{}}));let supported=true;
 const api={register:async()=>({accountId:scope.accountId,device:{id:id(20),name:'Graph edit synthetic',platform:'web' as const,createdAt:now,lastSeenAt:now,revokedAt:null}}),devices:async()=>[],conflicts:async()=>({conflicts:[],nextCursor:'done',hasMore:false}),push:async()=>{throw Error('Offline fixture must not POST');},pull:async()=>{throw Error('Offline fixture must not GET');},revokeDevice:async()=>{},resolveConflict:async()=>{throw Error('Unused');}};
 const c=new WorkspaceController({apiBaseUrl:scope.apiBaseUrl,store,api,online:false,supportsGraphRelations:()=>supported});
 await c.bind('Graph edit synthetic');t.after(async()=>{c.deactivate();await store.close();});return{c,store,setSupported:(v:boolean)=>supported=v};}
test('typed graph projection retains custom and saved AI source, unknown confidence, scope and deleted endpoint boundaries',()=>{
 const r=relation(),all=[...entities,r],result=buildMobileGraph(all,defaultGraphSelection()),edge=result.snapshot.edges.find(e=>e.id===r.entityId)!;
 assert.equal(edge.source,'paper:'+id(2));assert.equal(edge.target,'note:'+id(3));assert.equal(edge.type,'custom_relation');assert.equal(edge.confidence,undefined);
 assert.equal(buildMobileGraph(all,{...defaultGraphSelection(),includeCustomRelations:false}).snapshot.edges.some(e=>e.id===r.entityId),false);
 const ai=structuredClone(r);ai.data.relationType='ai_suggested';ai.data.confidence=.72;assert.equal(buildMobileGraph([...entities,ai],defaultGraphSelection()).snapshot.edges.find(e=>e.id===r.entityId)!.confidence,.72);
 assert.equal(buildMobileGraph([{...entities[0],deleted:true},entities[1],r],defaultGraphSelection()).snapshot.edges.some(e=>e.id===r.entityId),false);
 const missing=structuredClone(r);missing.data.source.entityId=id(3);assert.equal(buildMobileGraph([...entities,missing],defaultGraphSelection()).snapshot.edges.some(e=>e.id===r.entityId),false,'note UUID cannot stand in for a paper');
 assert.notEqual(graphProjection(all,{tag:'',collection:''}).identity,graphProjection([...entities,{...r,data:{...r.data,label:'Changed'}}],{tag:'',collection:''}).identity);
});
test('a graph draft captures exact material and relation state, including pending edits; delete remains possible after an endpoint disappears',()=>{
 const plan=planGraphRelation(entities,id(70),data());assertGraphRelationPlan(plan,entities);const changed=structuredClone(entities);changed[1].data={...changed[1].data!,title:'Changed source'} as any;assert.throws(()=>assertGraphRelationPlan(plan,changed),{code:'EDIT_CHANGED'});
 assert.throws(()=>planGraphRelation([{...entities[0],pending:true},entities[1]],id(70),data()),{code:'EDIT_CHANGED'});
 const r=relation();assert.throws(()=>planGraphRelation([...entities,r],id(70),{...r.data,source:r.data.target,target:r.data.source}),{code:'EDIT_CHANGED'});
 assert.equal(planGraphRelation([r],r.entityId,null).edit.mutation,'delete');
});
test('relation count limit is explicit and never silently clips saved user text or creates a partial graph draft',()=>{
 const rows=Array.from({length:512},(_,n)=>({...relation(),entityId:id(n+100)}));assert.throws(()=>planGraphRelation([...entities,...rows],id(90),data()),{code:'GRAPH_COLLECTION_LIMIT'});
 assert.equal((planGraphRelation([...entities,...rows],rows[0].entityId,{...data(),label:'Edited'}).edit.data as GraphRelationData).label,'Edited');
});
test('actual IndexedDB transaction persists one relation with endpoint guards, and stale drafts cannot overwrite a pending row',async t=>{
 const{c,store}=await setup(t);assert.equal(c.getSnapshot().workspace!.sync.cursor,null,'first feature opt-in restarts hidden feed once');assert.equal(c.getSnapshot().workspace!.graphRelationsVersion,1);
 const plan=planGraphRelation(listVisibleEntities(c.getSnapshot().workspace!.sync),id(70),data());await c.saveGraphRelation(plan);
 const saved=(await store.read(scope))!;assert.equal(saved.sync.outbox.length,1);assert.equal(saved.sync.outbox[0].operation.entityType,'graphRelation');assert.deepEqual(saved.sync.outbox[0].operation.data,data());assert.equal(decodeWorkspace(saved).graphRelationsVersion,1);
 const before=canonicalJson(saved);await assert.rejects(c.saveGraphRelation(plan),{code:'EDIT_CHANGED'});assert.equal(canonicalJson(await store.read(scope)),before);
});
test('a changed endpoint is detected from the transaction read rather than a stale component snapshot, with no partial relation write',async t=>{
 const{c,store}=await setup(t),plan=planGraphRelation(listVisibleEntities(c.getSnapshot().workspace!.sync),id(70),data());
 await store.update(scope,previous=>{const next=structuredClone(previous!);const row=next.sync.serverRecords['paper:'+id(2)];row.data={...paper,title:'Other tab update'};row.revision++;return next;});
 await assert.rejects(c.saveGraphRelation(plan),{code:'EDIT_CHANGED'});assert.equal((await store.read(scope))!.sync.outbox.length,0);
});
test('graph offline capability survives cached activation; unsupported service retains outbox and blocks editing',async t=>{
 const{c,store,setSupported}=await setup(t);await c.saveGraphRelation(planGraphRelation(listVisibleEntities(c.getSnapshot().workspace!.sync),id(70),data()));setSupported(false);await c.bind('Legacy connection');
 const saved=(await store.read(scope))!;assert.equal(saved.sync.outbox.length,1);assert.equal(saved.graphRelationsVersion,undefined);
 await assert.rejects(c.saveGraphRelation(planGraphRelation(entities,id(71),data())),{code:'SYNC_FEATURE_UNAVAILABLE'});assert.equal((await store.read(scope))!.sync.outbox.length,1);
});
test('invalidated graph callback and account epoch cannot write through a captured save intent',async t=>{
 const{c,store}=await setup(t),plan=planGraphRelation(entities,id(70),data());await assert.rejects(c.saveGraphRelation(plan,()=>false),{code:'ACCOUNT_CHANGED'});assert.equal((await store.read(scope))!.sync.outbox.length,0);
 c.deactivate();await assert.rejects(c.saveGraphRelation(plan),{code:'ACCOUNT_CHANGED'});
});
