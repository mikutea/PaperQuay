import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { createAccountState, entityKey, type SyncRecord } from '../../../../packages/sync-core/src/index.ts';
import type { RemoteTask } from '../../../../packages/sync-core/src/remoteTasks.ts';
import { AccountStore } from '../../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController, type StoredWorkspace } from '../../src/sync/workspace.ts';
import type { RemoteBatch } from '../../src/remote/batch.ts';
export const at='2026-10-30T03:00:00.000Z',account=randomUUID(),device=randomUUID();
export const scope={accountId:account,apiBaseUrl:'https://sync.example.invalid'};
export const quota={active:0,queued:1,retained:1,receipts:1,artifactBytes:0,maxActive:1,maxQueued:16,maxRetained:200,maxReceipts:2000,maxArtifactBytes:67108864};
export function draft(count=3,kind:'parse'|'index'='parse'):RemoteBatch{
 const providerDeviceId=randomUUID(),profile={id:kind==='parse'?'mineru':'embedding',revision:1,digest:'a'.repeat(64),kind,model:kind==='parse'?'vlm':'embed-3'};
 return{version:1,id:randomUUID(),createdAt:at,providerDeviceId,profile,cancelRequested:false,items:Array.from({length:count},(_,n)=>{
  const versionId=randomUUID();return{request:{requestId:randomUUID(),kind,versionId,providerDeviceId,profileRef:{id:profile.id,revision:1,digest:profile.digest},...(kind==='index'?{indexSourceDigest:'c'.repeat(64)}:{})},
   target:{paperId:randomUUID(),attachmentVersionId:versionId,paperRevision:1,versionRevision:1,sha256:'b'.repeat(64),sizeBytes:512,pageCount:1,fileName:'合成-'+n+'.pdf'},label:'合成文献 '+n,state:'pending',taskId:null,cancelAcknowledged:false,failure:null};
 })};
}
export function job(batch:RemoteBatch,index=0):RemoteTask{
 const item=batch.items[index];return{id:item.request.requestId,kind:item.request.kind,state:'queued',target:item.target,providerDeviceId:batch.providerDeviceId,profile:batch.profile,indexSourceDigest:item.request.indexSourceDigest??null,recoveryProviderDeviceId:null,attempt:0,createdAt:at,updatedAt:at,leaseExpiresAt:null,failure:null,artifact:null};
}
export async function fixture(batch=draft()){
 const store=new AccountStore<StoredWorkspace>({decode:decodeWorkspace,indexedDB:new IDBFactory()}),sync=createAccountState(account,device);
 for(const item of batch.items){const records=[{entityType:'paper',entityId:item.target.paperId,data:{title:item.label,doi:null,year:null,publication:null,abstractText:null,authors:[],keywords:[]}},
 {entityType:'attachmentVersion',entityId:item.request.versionId,data:{paperId:item.target.paperId,attachmentId:randomUUID(),sha256:item.target.sha256,sizeBytes:512,mediaType:'application/pdf',fileName:item.target.fileName,pageCount:1}}];
 for(const record of records)sync.serverRecords[entityKey(record.entityType as any,record.entityId)]={...record,schemaVersion:1,revision:1,deletedAt:null,updatedAt:at,modifiedByDeviceId:device} as SyncRecord;}
 await store.update(scope,()=>({sync,pendingResolutions:{}}));
 const binding={key:'synthetic-batch'};
 const options={store,apiBaseUrl:scope.apiBaseUrl,online:false,binding:{key:()=>binding.key},api:{async register(){return{accountId:account,device:{id:device,name:'合成设备',platform:'web' as const,createdAt:at,lastSeenAt:at,revokedAt:null}};},async devices(){return[];},async push(){throw new Error('unexpected offline push');},async pull(){throw new Error('unexpected offline pull');},async conflicts(){return{conflicts:[],nextCursor:'done',hasMore:false};},async resolveConflict(){throw new Error();},async revokeDevice(){}}};
 const controller=new WorkspaceController(options);await controller.bind('批次合成测试');return{batch,store,controller,options,binding,async close(){controller.deactivate();await store.close();}};
}
