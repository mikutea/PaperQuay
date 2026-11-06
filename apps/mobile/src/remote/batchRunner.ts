import type { WorkspaceController } from '../sync/workspace.ts';
import { ClientError, describeError } from '../errors.ts';
import { RemoteTaskError, describeRemoteTaskError, type RemoteTaskClient, type RemoteTaskCall } from './client.ts';
import { RemoteBatchError, type RemoteBatchFailure } from './batch.ts';
import type { RemoteTask, RemoteTaskQuota, RemoteTaskRequestStatus } from '../../../../packages/sync-core/src/remoteTasks.ts';
type Workspace=Pick<WorkspaceController,'getSnapshot'|'markRemoteBatchAttempt'|'acknowledgeRemoteBatchRequest'|'recordRemoteBatchFailure'|'stopRemoteBatch'>;
type Client=Pick<RemoteTaskClient,'lookupRequest'|'cancelRequest'|'create'>;
export interface RemoteBatchRunSnapshot { action:'submit'|'cancel'|'refresh'|null; requestId:string|null; error:string; notice:string }
function message(error:unknown):string{
 if(error instanceof ClientError)return describeError(error);
 if(error instanceof RemoteTaskError)return describeRemoteTaskError(error);
 if(error instanceof RemoteBatchError)return '批次或来源已经变化，此次操作已停止。请重新核对。';
 return '批次操作未能确认，请查询当前状态后使用原请求重试。';
}
function failure(error:unknown):RemoteBatchFailure{
 if(error instanceof ClientError)return error.code==='ACCOUNT_CHANGED'?'CHANGED':error.code==='EDIT_CHANGED'?'VERSION_UNAVAILABLE':'FAILED';
 if(error instanceof RemoteTaskError){const code=error.code;if(code==='BATCH_UNSUPPORTED')return'UNSUPPORTED';if(['NETWORK','TIMEOUT','AUTH_REQUIRED','CAPACITY','PROVIDER_UNAVAILABLE','PROFILE_CHANGED','VERSION_UNAVAILABLE','CANCELLED','CHANGED','INVALID_RESPONSE'].includes(code))return code as RemoteBatchFailure;}
 return'FAILED';
}
export class RemoteBatchRunner {
 private snapshot:RemoteBatchRunSnapshot={action:null,requestId:null,error:'',notice:''};private listeners=new Set<()=>void>();
 private generation=0;private abort:AbortController|null=null;private disposed=false;
 constructor(private options:{workspace:Workspace;client:Client;current():boolean;onTask?(task:RemoteTask,quota?:RemoteTaskQuota):void}){}
 activate=()=>{this.disposed=false;};
 getSnapshot=()=>this.snapshot;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private publish(change:Partial<RemoteBatchRunSnapshot>){this.snapshot={...this.snapshot,...change};for(const listener of this.listeners)listener();}
 private batch(id:string){const state=this.options.workspace.getSnapshot(),batch=state.workspace?.remoteBatch;if(state.status!=='ready'||!batch||batch.id!==id)throw new RemoteBatchError('CHANGED');return batch;}
 private async run(id:string,action:NonNullable<RemoteBatchRunSnapshot['action']>,work:(call:RemoteTaskCall,check:()=>void)=>Promise<void>){
  if(this.disposed||!this.options.current())return;
  if(this.snapshot.action&&(action!=='cancel'||this.snapshot.action==='cancel'))return;
  this.abort?.abort();const abort=new AbortController(),token=++this.generation;this.abort=abort;
  const current=()=>{try{return !this.disposed&&token===this.generation&&!abort.signal.aborted&&this.options.current()&&Boolean(this.batch(id));}catch{return false;}};
  const check=()=>{if(!current())throw new RemoteTaskError('CHANGED');};const call={signal:abort.signal,current};
  this.publish({action,requestId:null,error:'',notice:''});
  try{check();await work(call,check);check();}
  catch(error){if(token===this.generation&&!this.disposed){const requestId=this.snapshot.requestId;if(current()&&requestId)await this.options.workspace.recordRemoteBatchFailure(id,requestId,failure(error),current).catch(()=>undefined);if(token===this.generation)this.publish({error:message(error)});}}
  finally{if(token===this.generation&&!this.disposed){this.abort=null;this.publish({action:null});}}
 }
 submit(id:string){return this.run(id,'submit',async(call,check)=>{
  for(let index=0;index<this.batch(id).items.length;index++){
   check();let batch=this.batch(id);if(batch.cancelRequested)throw new RemoteTaskError('CANCELLED');let item=batch.items[index];
   if(!['pending','uncertain'].includes(item.state))continue;
   this.publish({requestId:item.request.requestId});
   if(item.state==='uncertain'){
    const status=await this.options.client.lookupRequest(item.request.requestId,call);check();
    if(status.status!=='absent'){await this.options.workspace.acknowledgeRemoteBatchRequest(id,status,false,call.current);check();if(status.task)this.options.onTask?.(status.task);continue;}
   }
   batch=await this.options.workspace.markRemoteBatchAttempt(id,item.request.requestId,call.current);check();
   if(batch.cancelRequested)throw new RemoteTaskError('CANCELLED');item=batch.items[index];
   const result=await this.options.client.create(item.request,call);check();
   const status:RemoteTaskRequestStatus={requestId:item.request.requestId,status:'known',task:result.task};
   const persisted=await this.options.workspace.acknowledgeRemoteBatchRequest(id,status,false,call.current);check();
   if(!persisted.cancelRequested)this.options.onTask?.(result.task,result.quota);
  }
  this.publish({requestId:null,notice:'本批次的创建请求已逐项确认。后台任务的完成、失败和取消状态请刷新查看。'});
 });}
 cancel(id:string){return this.run(id,'cancel',async(call,check)=>{
  await this.options.workspace.stopRemoteBatch(id,call.current);check();
  for(let index=0;index<this.batch(id).items.length;index++){
   check();const item=this.batch(id).items[index];if(item.cancelAcknowledged)continue;
   this.publish({requestId:item.request.requestId});
   const status=await this.options.client.cancelRequest(item.request.requestId,call);check();
   await this.options.workspace.acknowledgeRemoteBatchRequest(id,status,true,call.current);check();if(status.task)this.options.onTask?.(status.task);
  }
  this.publish({requestId:null,notice:'全部创建请求的取消或阻止创建已确认。已运行任务可能仍在处理取消，已发生的外部费用不会撤回；请刷新查看最终状态。'});
 });}
 refresh(id:string){return this.run(id,'refresh',async(call,check)=>{
  let absent=0;
  for(const item of this.batch(id).items){
   check();if(item.state==='pending'&&!this.batch(id).cancelRequested)continue;this.publish({requestId:item.request.requestId});
   const status=await this.options.client.lookupRequest(item.request.requestId,call);check();
   if(status.status==='absent'){if(item.state==='submitted')throw new RemoteTaskError('INVALID_RESPONSE');absent++;continue;}
   await this.options.workspace.acknowledgeRemoteBatchRequest(id,status,false,call.current);check();if(status.task)this.options.onTask?.(status.task);
  }
  this.publish({requestId:null,notice:absent?'部分请求尚无回执。继续提交或取消仍使用原请求 ID；本次查询没有创建任务。':'已核对本批次回执；本次查询没有创建或恢复任务。'});
 });}
 resetFeedback=()=>{if(!this.snapshot.action)this.publish({error:'',notice:'',requestId:null});};
 stopWaiting=()=>{this.generation++;this.abort?.abort();this.abort=null;this.publish({action:null,requestId:null,notice:'已停止本次等待。批次记录与原请求 ID 保留；已创建的后台任务仍可能运行。'});};
 dispose=()=>{this.generation++;this.abort?.abort();this.abort=null;this.disposed=true;this.snapshot={...this.snapshot,action:null,requestId:null};};
}
