import {
  decodeRemoteIndexArtifact, REMOTE_TASK_LIMITS, validateRemoteTask, validateRemoteTaskId,
  validateRemoteTaskProvider, validateRemoteTaskQuota, validateRemoteTaskRequest, validateRemoteTaskResume,
  type RemoteTask, type RemoteTaskCapability, type RemoteTaskProvider, type RemoteTaskQuota, type RemoteTaskRequest, type RemoteTaskResume,
} from '../../../../packages/sync-core/src/remoteTasks.ts';
import { decodeParsedDocument } from '../../../../packages/sync-core/src/parsedDocument.ts';
import { normalizeServiceUrl } from '../config.ts';

export interface RemoteTaskContext {
  apiBaseUrl: string;
  getAccessToken(): Promise<string>;
  getCapability(): RemoteTaskCapability | null;
  identityKey?(): string | null;
}
export type RemoteTaskErrorCode = 'DISABLED' | 'CHANGED' | 'CANCELLED' | 'TIMEOUT' | 'NETWORK' | 'INVALID_RESPONSE' | 'AUTH_REQUIRED'
  | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'PROFILE_CHANGED' | 'VERSION_UNAVAILABLE' | 'CAPACITY' | 'ACTIVE' | 'REMOVED' | 'FAILED';
const descriptions: Record<RemoteTaskErrorCode,string> = {
  DISABLED:'此同步服务尚未启用远程任务。', CHANGED:'账号、文库或任务目标已变化，此次操作已停止。', CANCELLED:'本次读取已取消；已创建的后台任务仍可在任务列表中查询。',
  TIMEOUT:'连接超时。任务创建结果可能尚未确认，请查询任务或重试同一请求。', NETWORK:'无法连接同步服务。任务创建结果可能尚未确认，请查询任务或重试同一请求。',
  INVALID_RESPONSE:'服务返回的任务或产物不完整，未采用该结果。', AUTH_REQUIRED:'登录已过期或已被撤销，请重新登录后查询任务。',
  RATE_LIMITED:'服务当前繁忙或请求频率过高，请稍后手动刷新。', PROVIDER_UNAVAILABLE:'所选电脑当前离线或未开启远程执行，请在电脑上明确开启后刷新。',
  PROFILE_CHANGED:'电脑上的模型配置已经变化，请刷新并重新选择。', VERSION_UNAVAILABLE:'此文献版本或解析来源已变化，请重新选择有效版本。',
  CAPACITY:'任务记录、幂等回执或产物额度已满。请明确清理已结束的任务，或联系管理员处理保留的回执额度。',
  ACTIVE:'任务仍在执行或等待取消，暂不可删除。', REMOVED:'此请求对应的任务已经清理；旧请求不会再次执行。', FAILED:'远程任务操作未完成，请刷新查看当前状态。',
};
export class RemoteTaskError extends Error {
  constructor(readonly code: RemoteTaskErrorCode) { super(descriptions[code]); this.name='RemoteTaskError'; }
}
export const describeRemoteTaskError = (error: unknown): string => error instanceof RemoteTaskError ? descriptions[error.code] : descriptions.FAILED;
export interface RemoteTaskCall { signal?: AbortSignal; current?: () => boolean }
const exact = (value: unknown, keys: string[]): value is Record<string,unknown> => Boolean(value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',')===[...keys].sort().join(','));

class Guard {
  readonly controller=new AbortController(); readonly signal=this.controller.signal;
  private reason: RemoteTaskError|null=null; private readonly timer:ReturnType<typeof setTimeout>;
  private externalAbort=()=>this.stop('CANCELLED'); private readonly identity:string|null|undefined;
  constructor(private context:RemoteTaskContext,private options:RemoteTaskCall,timeoutMs:number) {
    this.identity=context.identityKey?.(); this.timer=setTimeout(()=>this.stop('TIMEOUT'),timeoutMs);
    options.signal?.addEventListener('abort',this.externalAbort,{once:true}); if(options.signal?.aborted)this.externalAbort();
  }
  stop(code:RemoteTaskErrorCode) { if(!this.signal.aborted){this.reason=new RemoteTaskError(code);this.controller.abort();} }
  check() {
    if(this.signal.aborted)throw this.reason??new RemoteTaskError('CANCELLED');
    if(this.context.identityKey?.()!==this.identity || this.options.current && !this.options.current()){this.stop('CHANGED');throw this.reason!;}
    if(!this.context.getCapability()){this.stop('DISABLED');throw this.reason!;}
  }
  wait<T>(promise:Promise<T>):Promise<T>{
    return new Promise((resolve,reject)=>{
      const abort=()=>{this.signal.removeEventListener('abort',abort);reject(this.reason??new RemoteTaskError('CANCELLED'));};
      this.signal.addEventListener('abort',abort,{once:true});
      promise.then(value=>{this.signal.removeEventListener('abort',abort);resolve(value);},error=>{this.signal.removeEventListener('abort',abort);reject(error);});
      if(this.signal.aborted)abort();
    });
  }
  close(){clearTimeout(this.timer);this.options.signal?.removeEventListener('abort',this.externalAbort);}
}
async function readBytes(response:Response,limit:number,guard:Guard):Promise<Uint8Array>{
  if(!response.body || Number(response.headers.get('content-length'))>limit)throw new RemoteTaskError('INVALID_RESPONSE');
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let length=0,finished=false;
  try{
    for(;;){const part=await guard.wait(reader.read());guard.check();if(part.done){finished=true;break;}
      length+=part.value.byteLength;if(length>limit)throw new RemoteTaskError('INVALID_RESPONSE');parts.push(part.value);}
    const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}return bytes;
  }finally{if(!finished)void reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
function httpError(status:number,code:unknown):RemoteTaskError{
  if(status===401||status===403)return new RemoteTaskError('AUTH_REQUIRED');
  if(code==='REMOTE_TASKS_DISABLED')return new RemoteTaskError('DISABLED');
  if(code==='REMOTE_TASK_PROVIDER_UNAVAILABLE')return new RemoteTaskError('PROVIDER_UNAVAILABLE');
  if(code==='REMOTE_TASK_PROFILE_CHANGED')return new RemoteTaskError('PROFILE_CHANGED');
  if(typeof code==='string'&&['REMOTE_TASK_VERSION_UNAVAILABLE','REMOTE_TASK_VERSION_CHANGED','REMOTE_TASK_SOURCE_UNAVAILABLE','REMOTE_TASK_TARGET_UNSUPPORTED','REMOTE_TASK_ARTIFACT_TARGET_MISMATCH'].includes(code))return new RemoteTaskError('VERSION_UNAVAILABLE');
  if(typeof code==='string'&&/^(REMOTE_TASK_(?:QUEUE_FULL|HISTORY_FULL|ARTIFACT_QUOTA)|ACCOUNT_STORAGE_LIMIT)$/.test(code))return new RemoteTaskError('CAPACITY');
  if(code==='REMOTE_TASK_ACTIVE')return new RemoteTaskError('ACTIVE');
  if(code==='REMOTE_TASK_GONE')return new RemoteTaskError('REMOVED');
  if(status===429)return new RemoteTaskError('RATE_LIMITED');return new RemoteTaskError('FAILED');
}

/** Only the configured same-account service receives its Bearer. No URL from a
 * task, provider, artifact or model configuration becomes a request target. */
export class RemoteTaskClient {
  private readonly base:string;
  constructor(private context:RemoteTaskContext,private fetcher:typeof fetch=(...args)=>globalThis.fetch(...args),private timeoutMs=30_000){
    this.base=normalizeServiceUrl(context.apiBaseUrl);
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000)throw new RemoteTaskError('FAILED');
  }
  private async call<T>(path:string,method:string,body:unknown,options:RemoteTaskCall,decode:(response:Response,guard:Guard)=>Promise<T>):Promise<T>{
    const guard=new Guard(this.context,options,this.timeoutMs);
    try{
      guard.check();const token=await guard.wait(this.context.getAccessToken());guard.check();
      if(typeof token!=='string'||!token||token.length>65536||/[\x00-\x20\x7f]/.test(token))throw new RemoteTaskError('AUTH_REQUIRED');
      const url=this.base+path;
      const response=await guard.wait(this.fetcher(url,{method,headers:{Authorization:'Bearer '+token,Accept:path.endsWith('/artifact')?'application/octet-stream':'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:guard.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'}).then(response=>{
          if(guard.signal.aborted)void response.body?.cancel().catch(()=>undefined);return response;
        }));
      guard.check();
      if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400||response.url&&response.url!==url){void response.body?.cancel().catch(()=>undefined);throw new RemoteTaskError('INVALID_RESPONSE');}
      if(!response.ok){
        let code:unknown;try{const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBytes(response,16384,guard)));code=data?.error?.code;}catch{guard.check();}
        throw httpError(response.status,code);
      }
      const result=await decode(response,guard);guard.check();return result;
    }catch(error){guard.check();if(error instanceof RemoteTaskError)throw error;throw new RemoteTaskError('NETWORK');}
    finally{guard.close();}
  }
  private json<T>(path:string,method:string,body:unknown,options:RemoteTaskCall,decode:(value:unknown)=>T):Promise<T>{
    return this.call(path,method,body,options,async(response,guard)=>{
      try{return decode(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBytes(response,2*1024*1024,guard))));}
      catch(error){guard.check();if(error instanceof RemoteTaskError)throw error;throw new RemoteTaskError('INVALID_RESPONSE');}
    });
  }
  providers(options:RemoteTaskCall={}):Promise<RemoteTaskProvider[]>{return this.json('/v1/remote-tasks/providers','GET',undefined,options,value=>{
    if(!exact(value,['providers'])||!Array.isArray(value.providers)||value.providers.length>100)throw new RemoteTaskError('INVALID_RESPONSE');
    const values=value.providers.map(validateRemoteTaskProvider);if(new Set(values.map(value=>value.deviceId)).size!==values.length)throw new RemoteTaskError('INVALID_RESPONSE');return values;
  });}
  list(options:RemoteTaskCall={}):Promise<{tasks:RemoteTask[];quota:RemoteTaskQuota}>{return this.json('/v1/remote-tasks/jobs','GET',undefined,options,value=>{
    if(!exact(value,['tasks','quota'])||!Array.isArray(value.tasks)||value.tasks.length>REMOTE_TASK_LIMITS.retained)throw new RemoteTaskError('INVALID_RESPONSE');
    const tasks=value.tasks.map(validateRemoteTask),quota=validateRemoteTaskQuota(value.quota);
    if(new Set(tasks.map(value=>value.id)).size!==tasks.length||tasks.length!==quota.retained)throw new RemoteTaskError('INVALID_RESPONSE');return{tasks,quota};
  });}
  create(input:RemoteTaskRequest,options:RemoteTaskCall={}):Promise<{task:RemoteTask;replayed:boolean;deduplicated:boolean;quota:RemoteTaskQuota}>{
    const request=validateRemoteTaskRequest(input);
    return this.json('/v1/remote-tasks/jobs','POST',request,options,value=>{
      if(!exact(value,['task','replayed','deduplicated','quota'])||typeof value.replayed!=='boolean'||typeof value.deduplicated!=='boolean')throw new RemoteTaskError('INVALID_RESPONSE');
      const task=validateRemoteTask(value.task),quota=validateRemoteTaskQuota(value.quota);
      if(task.kind!==request.kind||task.target.attachmentVersionId!==request.versionId
        // The server verifies the exact original request digest before replaying
        // its receipt. Explicit provider changes do not change that receipt.
        ||task.providerDeviceId!==request.providerDeviceId&&!value.replayed
        ||task.profile.id!==request.profileRef.id||task.profile.revision!==request.profileRef.revision||task.profile.digest!==request.profileRef.digest
        ||task.indexSourceDigest!==(request.indexSourceDigest??null))throw new RemoteTaskError('INVALID_RESPONSE');
      return{task,replayed:value.replayed,deduplicated:value.deduplicated,quota};
    });
  }
  update(id:string,action:'cancel'|'resume',options:RemoteTaskCall={},resume:RemoteTaskResume={}):Promise<RemoteTask>{
    const body=action==='resume'?validateRemoteTaskResume(resume):{};
    validateRemoteTaskId(id);return this.json(`/v1/remote-tasks/jobs/${id}/${action}`,'POST',body,options,value=>{
      if(!exact(value,['task']))throw new RemoteTaskError('INVALID_RESPONSE');const task=validateRemoteTask(value.task);if(task.id!==id)throw new RemoteTaskError('INVALID_RESPONSE');return task;
    });
  }
  remove(id:string,options:RemoteTaskCall={}):Promise<RemoteTaskQuota>{
    validateRemoteTaskId(id);return this.json(`/v1/remote-tasks/jobs/${id}`,'DELETE',undefined,options,value=>{
      if(!exact(value,['deleted','quota'])||typeof value.deleted!=='boolean')throw new RemoteTaskError('INVALID_RESPONSE');return validateRemoteTaskQuota(value.quota);
    });
  }
  artifact(task:RemoteTask,options:RemoteTaskCall={}){
    const selected=validateRemoteTask(task);
    if(selected.state!=='succeeded'||!selected.artifact)throw new RemoteTaskError('INVALID_RESPONSE');
    return this.call(`/v1/remote-tasks/jobs/${selected.id}/artifact`,'GET',undefined,options,async(response,guard)=>{
      if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/octet-stream'
        ||response.headers.get('x-paperquay-artifact-digest')!==selected.artifact!.digest)throw new RemoteTaskError('INVALID_RESPONSE');
      const bytes=await readBytes(response,Math.min(selected.artifact!.sizeBytes,REMOTE_TASK_LIMITS.artifactBytes),guard);guard.check();
      if(bytes.byteLength!==selected.artifact!.sizeBytes)throw new RemoteTaskError('INVALID_RESPONSE');
      let value;try{value=selected.kind==='parse'?await decodeParsedDocument(bytes):await decodeRemoteIndexArtifact(bytes);}catch{throw new RemoteTaskError('INVALID_RESPONSE');}
      guard.check();const doc=value.document;
      if(value.digest!==selected.artifact!.digest||doc.paperId!==selected.target.paperId||doc.attachmentVersionId!==selected.target.attachmentVersionId
        ||doc.pdf.sha256!==selected.target.sha256||doc.pdf.sizeBytes!==selected.target.sizeBytes||selected.target.pageCount!==null&&doc.pdf.pageCount!==selected.target.pageCount
        ||'parseDigest'in doc&&(doc.parseDigest!==selected.indexSourceDigest||doc.model!==selected.profile.model)
        ||'parser'in doc&&doc.parser.model!==selected.profile.model)throw new RemoteTaskError('INVALID_RESPONSE');
      return{...value,bytes};
    });
  }
}
