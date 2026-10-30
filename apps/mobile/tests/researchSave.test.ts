import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { entityKey, getVisibleEntity, listVisibleEntities, queueLocalEdit, type NoteData } from '../../../packages/sync-core/src/index.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController } from '../src/sync/workspace.ts';
import { ClientError } from '../src/errors.ts';
const id=(n:number)=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const scope={apiBaseUrl:'https://sync.example.test',accountId:id(1)},now='2026-10-30T10:00:00.000Z';
const note:NoteData={title:'Research answer',body:'Actual answer with [S1E1] and exact evidence',paperId:null,format:'markdown'};
async function setup(t:TestContext){
 const store=new AccountStore({decode:decodeWorkspace,indexedDB:new IDBFactory(),databaseName:crypto.randomUUID()});
 const controller=new WorkspaceController({apiBaseUrl:scope.apiBaseUrl,store,online:false,api:{register:async()=>({accountId:scope.accountId,device:{id:id(2),name:'Research test',platform:'web',createdAt:now,lastSeenAt:now,revokedAt:null}}),
  devices:async()=>[],revokeDevice:async()=>{},conflicts:async()=>({conflicts:[],nextCursor:'done',hasMore:false}),push:async()=>{throw Error('Unexpected network');},pull:async()=>{throw Error('Unexpected network');},resolveConflict:async()=>{throw Error('Unexpected network');}}});
 t.after(async()=>{controller.deactivate();await store.close();});await controller.bind('Research test');assert.equal(controller.getSnapshot().status,'ready');return{store,controller};
}
test('research note retry, double click and restarted acknowledgement use one note and one outbox operation',async t=>{
 const {store,controller}=await setup(t);const results=await Promise.all([controller.saveNewNoteOnce(id(3),note),controller.saveNewNoteOnce(id(3),structuredClone(note))]);
 assert.deepEqual(results.sort(),[false,true]);assert.equal(await controller.saveNewNoteOnce(id(3),note),false);
 const saved=await store.read(scope);assert.equal(listVisibleEntities(saved!.sync,'note').length,1);assert.equal(saved!.sync.outbox.length,1);assert.deepEqual(getVisibleEntity(saved!.sync,'note',id(3))!.data,note);
 controller.deactivate();await controller.bind('Research test');assert.equal(await controller.saveNewNoteOnce(id(3),note),false);assert.equal((await store.read(scope))!.sync.outbox.length,1);
});
test('research save never overwrites an existing different note or restores a deleted result',async t=>{
 const {store,controller}=await setup(t);await controller.saveNewNoteOnce(id(3),note);const before=structuredClone(await store.read(scope));
 await assert.rejects(controller.saveNewNoteOnce(id(3),{...note,body:'Different output'}),e=>(e as any).code==='EDIT_CHANGED');assert.deepEqual(await store.read(scope),before);
 // A real synchronized tombstone remains in serverRecords. An unsent create/delete instead cancels the creation by design.
 await store.update(scope,value=>({...value!,sync:{...value!.sync,outbox:[],serverRecords:{...value!.sync.serverRecords,[entityKey('note',id(3))]:{entityType:'note',entityId:id(3),schemaVersion:1,revision:2,deletedAt:now,updatedAt:now,modifiedByDeviceId:id(2),data:null}}}}));
 controller.deactivate();await controller.bind('Research test');
 await assert.rejects(controller.saveNewNoteOnce(id(3),note),e=>(e as any).code==='EDIT_CHANGED');
});
test('research save checks dependencies inside the latest transaction, before creating a note',async t=>{
 const {store,controller}=await setup(t);const before=await store.read(scope);let guards=0;
 await assert.rejects(controller.saveNewNoteOnce(id(3),note,()=>{guards++;throw new ClientError('EDIT_CHANGED');}));assert.equal(guards,1);assert.deepEqual(await store.read(scope),before);
});
test('research save guard runs even for idempotent replay and account deactivation rejects old saves',async t=>{
 const {store,controller}=await setup(t);await controller.saveNewNoteOnce(id(3),note);let guards=0;const before=await store.read(scope);
 await assert.rejects(controller.saveNewNoteOnce(id(3),note,()=>{guards++;throw new ClientError('ACCOUNT_CHANGED');}));assert.equal(guards,1);assert.deepEqual(await store.read(scope),before);
 controller.deactivate();await assert.rejects(controller.saveNewNoteOnce(id(4),note));assert.deepEqual(await store.read(scope),before);
});
test('a preceding queued note cannot be silently overwritten by a stale research save',async t=>{
 const {store,controller}=await setup(t);const preceding=store.update(scope,value=>({...value!,sync:queueLocalEdit(value!.sync,{entityType:'note',entityId:id(3),mutation:'put',data:{...note,body:'Other queued content'}},{opId:crypto.randomUUID(),clientCreatedAt:now})}));
 const saving=controller.saveNewNoteOnce(id(3),note);await preceding;await assert.rejects(saving,e=>(e as any).code==='EDIT_CHANGED');assert.equal((await store.read(scope))!.sync.outbox.length,1);assert.equal((getVisibleEntity((await store.read(scope))!.sync,'note',id(3))!.data as NoteData).body,'Other queued content');
});
