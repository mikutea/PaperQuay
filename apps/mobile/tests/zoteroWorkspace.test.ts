import assert from 'node:assert/strict';
import {test,type TestContext}from'node:test';
import{IDBFactory,IDBObjectStore}from'fake-indexeddb';
import{canonicalJson,listVisibleEntities,queueLocalEdit}from'../../../packages/sync-core/src/index.ts';
import{AccountStore}from'../src/storage/accountStore.ts';
import{decodeWorkspace,externalLibraryEntities,WorkspaceController,type StoredWorkspace}from'../src/sync/workspace.ts';
import{planExternalLibraryImport}from'../src/library/externalLibrary.ts';
import{refreshZoteroLibrary}from'../src/library/zoteroRefresh.ts';
import{updateZoteroCursor}from'../src/library/zoteroState.ts';
import{ClientError}from'../src/errors.ts';
import{zoteroAccount as scope,zoteroConfig,zoteroDeleted,zoteroItem,zoteroResponse,zoteroTransport}from'./helpers/zotero.ts';
const device='00000000-0000-4000-8000-000000000002',at='2026-10-28T00:00:00.000Z';
async function fixture(t:TestContext){
  const store=new AccountStore<StoredWorkspace>({decode:decodeWorkspace,indexedDB:new IDBFactory()});
  const controller=new WorkspaceController({store,apiBaseUrl:scope.apiBaseUrl,online:false,supportsPaperOrganization:()=>true,api:{
    async register(){return{accountId:scope.accountId,device:{id:device,name:'Synthetic Zotero device',platform:'web' as const,createdAt:at,lastSeenAt:at,revokedAt:null}};},
    async devices(){return[];},async push(){throw new Error('Unexpected offline sync');},async pull(){throw new Error('Unexpected offline sync');},async conflicts(){return{conflicts:[],nextCursor:'done',hasMore:false};},async resolveConflict(){throw new Error();},async revokeDevice(){},
  }});await controller.bind('Synthetic Zotero');
  t.after(async()=>{controller.deactivate();await store.close();});
  const reviewed=async(expectedCursor:number|null=null,version=10,deleted=false)=>{
    const transport=zoteroTransport([zoteroResponse(deleted?[]:[zoteroItem(1,version)],version),zoteroDeleted(deleted?['00000001']:[],version)]);
    const result=await refreshZoteroLibrary(transport.client,zoteroConfig,{expectedCursor,credential:{mode:'public'}});
    const workspace=controller.getSnapshot().workspace!,plan=planExternalLibraryImport(result.snapshot,workspace.externalLibraries,externalLibraryEntities(workspace),[]),sync=workspace.sync;
    return{result,plan,key:JSON.stringify([sync.accountId,sync.deviceId,sync.generation]),transport};
  };return{store,controller,reviewed};
}
test('Zotero adoption commits source cursor, mappings, paper and outbox together, and reset is metadata-only with no network',async t=>{
  const f=await fixture(t),review=await f.reviewed();assert.equal(f.controller.getZoteroCursor(zoteroConfig),null);
  assert.equal((await f.store.read(scope))!.sync.outbox.length,0);
  await f.controller.adoptZoteroRefresh(review.result,[],review.plan.signature,review.key);
  const stored=(await f.store.read(scope))!;assert.equal(f.controller.getZoteroCursor(zoteroConfig),10);assert.equal(stored.zoteroLibraries!.entries[0].cursor,10);
  assert.equal(stored.externalLibraries!.sources[0].mappings.length,1);assert.equal(stored.sync.outbox.length,1);assert.equal(listVisibleEntities(stored.sync,'paper').length,1);
  assert.equal('cursor'in stored.sync.outbox[0].operation.data!,false);assert.equal('config'in stored.sync.outbox[0].operation.data!,false);
  const network=review.transport.requests.length;
  await f.controller.resetZoteroCursor(zoteroConfig);const reset=(await f.store.read(scope))!;assert.equal(f.controller.getZoteroCursor(zoteroConfig),null);
  assert.deepEqual(reset.externalLibraries,stored.externalLibraries);assert.deepEqual(reset.sync,stored.sync);assert.equal(review.transport.requests.length,network);
  assert.throws(()=>decodeWorkspace({...reset,zoteroLibraries:{version:1,entries:[{config:{...zoteroConfig,apiKey:'never persist'},cursor:10}]}}));
  await assert.rejects(f.controller.adoptZoteroRefresh(structuredClone(review.result),[],review.plan.signature,review.key),{code:'INVALID_RESULT'});
});
test('an actual IndexedDB abort does not advance the cursor or create a mapping without the paper/outbox',async t=>{
  const f=await fixture(t),review=await f.reviewed(),before=canonicalJson(await f.store.read(scope));
  const original=IDBObjectStore.prototype.put;
  const mock=t.mock.method(IDBObjectStore.prototype,'put',function(){throw new Error('Synthetic storage write failure');});
  await assert.rejects(f.controller.adoptZoteroRefresh(review.result,[],review.plan.signature,review.key),error=>error instanceof ClientError&&error.code==='STORAGE_FAILED');
  mock.mock.restore();assert.equal(IDBObjectStore.prototype.put,original);assert.equal(canonicalJson(await f.store.read(scope)),before);
});
test('queued adoption rechecks source cursor, newly competing local metadata and account inside the storage transaction',async t=>{
  for(const change of ['cursor','paper','account','unchanged'] as const)await t.test(change,async t=>{
    const f=await fixture(t),review=await f.reviewed(),update=f.store.update.bind(f.store);
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    t.mock.method(f.store,'update',async(...args:Parameters<typeof f.store.update>)=>{enter();await gate;return update(...args);});
    const saving=f.controller.adoptZoteroRefresh(review.result,[],review.plan.signature,review.key);
    const settled=change==='unchanged'?saving:assert.rejects(saving,error=>error instanceof ClientError&&['IMPORT_CHANGED','ACCOUNT_CHANGED'].includes(error.code));
    await entered;
    if(change==='cursor')await update(scope,current=>({...current!,zoteroLibraries:updateZoteroCursor(current!.zoteroLibraries,zoteroConfig,9)}));
    if(change==='paper')await update(scope,current=>({...current!,sync:queueLocalEdit(current!.sync,{entityType:'paper',entityId:crypto.randomUUID(),mutation:'put',data:review.result.snapshot.items[0].data},{opId:crypto.randomUUID(),clientCreatedAt:at})}));
    if(change==='account')f.controller.deactivate();release();await settled;
    const stored=(await f.store.read(scope))!;
    assert.equal(stored.externalLibraries?.sources.length??0,change==='unchanged'?1:0);
    assert.equal(stored.zoteroLibraries?.entries[0].cursor??null,change==='unchanged'?10:change==='cursor'?9:null);
    assert.equal(stored.sync.outbox.length,change==='unchanged'||change==='paper'?1:0);
  });
});
test('a deletion-only round advances the reviewed source version without deleting local papers or their mapping baseline',async t=>{
  const f=await fixture(t),first=await f.reviewed();await f.controller.adoptZoteroRefresh(first.result,[],first.plan.signature,first.key);
  const before=(await f.store.read(scope))!,next=await f.reviewed(10,11,true);assert.deepEqual(next.result.deletedKeys,['00000001']);
  await f.controller.adoptZoteroRefresh(next.result,[],next.plan.signature,next.key);
  const after=(await f.store.read(scope))!;assert.equal(after.zoteroLibraries!.entries[0].cursor,11);assert.deepEqual(after.sync,before.sync);assert.deepEqual(after.externalLibraries,before.externalLibraries);
});
