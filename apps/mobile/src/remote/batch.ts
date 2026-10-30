import { canonicalJson, getVisibleEntity, type AccountSyncState } from '../../../../packages/sync-core/src/index.ts';
import { REMOTE_TASK_LIMITS, validateRemoteTaskId, validateRemoteTaskProfiles, validateRemoteTaskRequest, validateRemoteTaskTarget, validateRemoteTaskRequestStatus,
  type RemoteTaskProfile, type RemoteTaskRequest, type RemoteTaskRequestStatus, type RemoteTaskTarget } from '../../../../packages/sync-core/src/remoteTasks.ts';
export const REMOTE_BATCH_LIMITS=Object.freeze({items:REMOTE_TASK_LIMITS.queued,bytes:128*1024});
export type RemoteBatchFailure='NETWORK'|'TIMEOUT'|'AUTH_REQUIRED'|'CAPACITY'|'PROVIDER_UNAVAILABLE'|'PROFILE_CHANGED'|'VERSION_UNAVAILABLE'|'CANCELLED'|'CHANGED'|'INVALID_RESPONSE'|'UNSUPPORTED'|'FAILED';
export interface RemoteBatchItem {
  request:RemoteTaskRequest; target:RemoteTaskTarget; label:string;
  state:'pending'|'uncertain'|'submitted'|'cancelled'|'removed';taskId:string|null;
  cancelAcknowledged:boolean; failure:RemoteBatchFailure|null;
}
export interface RemoteBatch {
  version:1;id:string;createdAt:string;providerDeviceId:string;profile:RemoteTaskProfile;
  cancelRequested:boolean;items:RemoteBatchItem[];
}
export class RemoteBatchError extends Error {constructor(readonly code:'INVALID'|'LIMIT'|'CHANGED'|'ACTIVE'){super(code);this.name='RemoteBatchError';}}
function bad(code:RemoteBatchError['code']='INVALID'):never{throw new RemoteBatchError(code);}
function object(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad();
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).some(k=>typeof k!=='string'||!keys.includes(k))||keys.some(k=>!Object.hasOwn(descriptors,k))||Object.values(descriptors).some(d=>!d.enumerable||!('value'in d)))bad();return value as Record<string,unknown>;
}
function array(value:unknown):unknown[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||!value.length||value.length>REMOTE_BATCH_LIMITS.items)bad('LIMIT');
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
 if(keys.length!==value.length+1||keys.some(key=>key!=='length'&&(typeof key!=='string'||!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))
  ||Array.from({length:value.length},(_,index)=>descriptors[String(index)]).some(d=>!d||!d.enumerable||!('value'in d)))bad();
 return value;
}
const failures:RemoteBatchFailure[]=['NETWORK','TIMEOUT','AUTH_REQUIRED','CAPACITY','PROVIDER_UNAVAILABLE','PROFILE_CHANGED','VERSION_UNAVAILABLE','CANCELLED','CHANGED','INVALID_RESPONSE','UNSUPPORTED','FAILED'];
export function validateRemoteBatch(value:unknown):RemoteBatch{
 const b=object(value,['version','id','createdAt','providerDeviceId','profile','cancelRequested','items']);
 if(b.version!==1||typeof b.cancelRequested!=='boolean'||typeof b.createdAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(b.createdAt)||!Number.isFinite(Date.parse(b.createdAt))||new Date(b.createdAt).toISOString()!==b.createdAt)bad();
 const id=validateRemoteTaskId(b.id),providerDeviceId=validateRemoteTaskId(b.providerDeviceId),profile=validateRemoteTaskProfiles([b.profile])[0];
 const items=array(b.items).map(value=>{
  const i=object(value,['request','target','label','state','taskId','cancelAcknowledged','failure']),request=validateRemoteTaskRequest(i.request),target=validateRemoteTaskTarget(i.target);
  if(typeof i.label!=='string'||!i.label.trim()||i.label.length>2048||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(i.label)||new TextDecoder().decode(new TextEncoder().encode(i.label))!==i.label
   ||!['pending','uncertain','submitted','cancelled','removed'].includes(i.state as string)||typeof i.cancelAcknowledged!=='boolean'||i.failure!==null&&!failures.includes(i.failure as RemoteBatchFailure))bad();
  if(request.providerDeviceId!==providerDeviceId||request.kind!==profile.kind||canonicalJson(request.profileRef)!==canonicalJson({id:profile.id,revision:profile.revision,digest:profile.digest})||request.versionId!==target.attachmentVersionId)bad();
  const taskId=i.taskId===null?null:validateRemoteTaskId(i.taskId);
  if((i.state==='submitted')!==(taskId!==null)||['pending','uncertain'].includes(i.state as string)&&i.cancelAcknowledged||['cancelled','removed'].includes(i.state as string)&&!i.cancelAcknowledged
   ||i.state!=='uncertain'&&i.failure!==null)bad();
  return{request,target,label:i.label,state:i.state as RemoteBatchItem['state'],taskId,cancelAcknowledged:i.cancelAcknowledged,failure:i.failure as RemoteBatchFailure|null};
 });
 if(new Set(items.map(i=>i.request.requestId)).size!==items.length||new Set(items.map(i=>i.request.versionId)).size!==items.length)bad();
 const result:RemoteBatch={version:1,id,createdAt:b.createdAt,providerDeviceId,profile,cancelRequested:b.cancelRequested,items};
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>REMOTE_BATCH_LIMITS.bytes)bad('LIMIT');return result;
}
export function validateRemoteBatchDraft(value:unknown):RemoteBatch{
 const batch=validateRemoteBatch(value);if(batch.cancelRequested||batch.items.some(i=>i.state!=='pending'||i.taskId!==null||i.cancelAcknowledged||i.failure!==null))bad();return batch;
}
export function remoteBatchIdentity(batch:RemoteBatch):string{
 return canonicalJson({id:batch.id,createdAt:batch.createdAt,providerDeviceId:batch.providerDeviceId,profile:batch.profile,items:batch.items.map(({request,target,label})=>({request,target,label}))});
}
export function assertRemoteBatchTarget(sync:Readonly<AccountSyncState>,item:RemoteBatchItem):void{
 const version=getVisibleEntity(sync as AccountSyncState,'attachmentVersion',item.request.versionId),paper=getVisibleEntity(sync as AccountSyncState,'paper',item.target.paperId);
 const data=version?.data&&'mediaType'in version.data?version.data:null;
 if(!version||version.deleted||version.revision<1||!data||!paper?.data||paper.deleted||paper.revision<1||data.paperId!==item.target.paperId||data.sha256!==item.target.sha256||data.sizeBytes!==item.target.sizeBytes
  ||data.pageCount!==null&&item.target.pageCount!==null&&data.pageCount!==item.target.pageCount)bad('CHANGED');
}
export function remoteBatchReceipt(item:RemoteBatchItem,value:unknown,profile:RemoteTaskProfile):RemoteBatchItem{
 const status=validateRemoteTaskRequestStatus(value);if(status.requestId!==item.request.requestId||status.status==='absent')bad();
 if(status.status==='known'){
  const task=status.task!,target=task.target;
  if(task.kind!==item.request.kind||target.attachmentVersionId!==item.request.versionId||target.paperId!==item.target.paperId||target.sha256!==item.target.sha256||target.sizeBytes!==item.target.sizeBytes
   ||target.pageCount!==null&&item.target.pageCount!==null&&target.pageCount!==item.target.pageCount||task.profile.id!==item.request.profileRef.id||task.profile.revision!==item.request.profileRef.revision||task.profile.digest!==item.request.profileRef.digest
   ||task.profile.model!==profile.model||task.indexSourceDigest!==(item.request.indexSourceDigest??null))bad('CHANGED');
  return{...item,state:'submitted',taskId:task.id,failure:null};
 }
 return{...item,state:status.status==='cancelled'?'cancelled':'removed',taskId:null,cancelAcknowledged:true,failure:null};
}
export function stopRemoteBatch(batch:RemoteBatch):RemoteBatch{
 return validateRemoteBatch({...batch,cancelRequested:true});
}
export function canClearRemoteBatch(batch:RemoteBatch):boolean{
 return batch.items.every(i=>i.state==='cancelled'||i.state==='removed'||i.state==='submitted'&&(!batch.cancelRequested||i.cancelAcknowledged));
}
