import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { createAccountState, entityKey, queueLocalEdit, type SyncRecord } from '../../../packages/sync-core/src/index.ts';
import type { RemoteTaskRequest } from '../../../packages/sync-core/src/remoteTasks.ts';
import { AccountStore } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController, type StoredWorkspace } from '../src/sync/workspace.ts';
import { ClientError } from '../src/errors.ts';
const account='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',device='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',paper='cccccccc-cccc-4ccc-8ccc-cccccccccccc',version='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const scope={accountId:account,apiBaseUrl:'https://sync.example.invalid'},at='2026-10-28T00:00:00.000Z';
const request=():RemoteTaskRequest=>({requestId:randomUUID(),kind:'parse',versionId:version,providerDeviceId:randomUUID(),profileRef:{id:'mineru',revision:1,digest:'a'.repeat(64)}});
async function fixture(){
  const store=new AccountStore<StoredWorkspace>({decode:decodeWorkspace,indexedDB:new IDBFactory()});
  const sync=createAccountState(account,device);
  for(const record of [
    {entityType:'paper',entityId:paper,data:{title:'合成文献',doi:null,year:null,publication:null,abstractText:null,authors:[],keywords:[]}},
    {entityType:'attachmentVersion',entityId:version,data:{paperId:paper,attachmentId:randomUUID(),sha256:'b'.repeat(64),sizeBytes:512,mediaType:'application/pdf',fileName:'synthetic.pdf',pageCount:1}},
  ])sync.serverRecords[entityKey(record.entityType as any,record.entityId)]={...record,schemaVersion:1,revision:1,deletedAt:null,updatedAt:at,modifiedByDeviceId:device} as SyncRecord;
  await store.update(scope,()=>({sync,pendingResolutions:{}}));
  const options={store,apiBaseUrl:scope.apiBaseUrl,online:false,binding:{key:()=> 'synthetic-remote'},api:{
    async register(){return{accountId:account,device:{id:device,name:'合成设备',platform:'web' as const,createdAt:at,lastSeenAt:at,revokedAt:null}};},
    async devices(){return[];},async push(){throw new Error('unexpected offline sync');},async pull(){throw new Error('unexpected offline sync');},async conflicts(){return{conflicts:[],nextCursor:'done',hasMore:false};},async resolveConflict(){throw new Error();},async revokeDevice(){},
  }};
  const controller=new WorkspaceController(options);await controller.bind('合成远程任务');return{store,controller,options};
}
test('create intent is durably stored before transport, survives account-store restart and only exact explicit replay can reuse it',async t=>{
  const f=await fixture();t.after(async()=>{f.controller.deactivate();await f.store.close();});
  const first=request();assert.deepEqual(await f.controller.prepareRemoteTask(first),first);
  assert.deepEqual((await f.store.read(scope))!.remoteTaskIntent!.request,first);
  f.controller.deactivate();const restarted=new WorkspaceController(f.options);await restarted.bind('重开的合成设备');t.after(()=>restarted.deactivate());
  assert.deepEqual(restarted.getSnapshot().workspace!.remoteTaskIntent!.request,first);
  assert.deepEqual(await restarted.prepareRemoteTask(first),first);
  await assert.rejects(restarted.prepareRemoteTask(request()),error=>error instanceof ClientError&&error.code==='REMOTE_REQUEST_PENDING');
  await assert.rejects(restarted.prepareRemoteTask({...first,providerDeviceId:randomUUID()}),error=>error instanceof ClientError&&error.code==='REMOTE_REQUEST_PENDING');
  await restarted.clearRemoteTaskIntent(randomUUID());assert.ok(restarted.getSnapshot().workspace!.remoteTaskIntent);
  await restarted.clearRemoteTaskIntent(first.requestId);assert.equal(restarted.getSnapshot().workspace!.remoteTaskIntent,undefined);
});
test('a queued intent rechecks target deletion and account lifetime inside the actual IndexedDB transaction',async t=>{
  for(const change of ['delete-target','account','unchanged'] as const)await t.test(change,async t=>{
    const f=await fixture();t.after(async()=>{f.controller.deactivate();await f.store.close();});const update=f.store.update.bind(f.store);
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    t.mock.method(f.store,'update',async(...args:Parameters<typeof f.store.update>)=>{enter();await gate;return update(...args);});
    const pending=f.controller.prepareRemoteTask(request());const settled=change==='unchanged'?pending:assert.rejects(pending,error=>error instanceof ClientError&&['EDIT_CHANGED','ACCOUNT_CHANGED'].includes(error.code));
    await entered;
    if(change==='delete-target')await update(scope,current=>({...current!,sync:queueLocalEdit(current!.sync,{entityType:'attachmentVersion',entityId:version,mutation:'delete',data:null},{opId:randomUUID(),clientCreatedAt:at})}));
    if(change==='account')f.controller.deactivate();release();await settled;
    assert.equal(Boolean((await f.store.read(scope))!.remoteTaskIntent),change==='unchanged');
  });
});
test('persisted create intent rejects transport authority and account clear cannot leave an automatic replay behind',async t=>{
  const f=await fixture();t.after(async()=>{f.controller.deactivate();await f.store.close();});const first=request();await f.controller.prepareRemoteTask(first);
  const workspace=f.controller.getSnapshot().workspace!;
  assert.throws(()=>decodeWorkspace({...workspace,remoteTaskIntent:{version:1,request:{...first,headers:{Authorization:'Bearer synthetic'}}}}),error=>error instanceof ClientError&&error.code==='STORAGE_CORRUPT');
  await f.controller.clearLocalData();assert.equal(f.controller.getSnapshot().workspace!.remoteTaskIntent,undefined);
});
