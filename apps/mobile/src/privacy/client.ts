import {normalizeServiceUrl} from '../config.ts';
import {accountScopeKey,type AccountScope} from '../storage/accountStore.ts';
import {consumePersonalExport,type PersonalExportSink} from './exportStream.ts';

export class PrivacyError extends Error {
  constructor(readonly code:'AUTH_REQUIRED'|'RECENT_AUTH_REQUIRED'|'UNAVAILABLE'|'CHANGED'|'INVALID'|'FAILED'|'BUSY'|'OUTCOME_UNKNOWN') {
    super(code);this.name='PrivacyError';
  }
}
export interface AccountPrivacyStatus {
  accountId:string;state:'active'|'closed';closedAt:string|null;closureRequestId:string|null;
  deviceErasure:{requested:boolean;pending:number;acknowledged:number;thisDevicePending:boolean};
}
export interface ClosureRequest {
  accountId:string;requestId:string;confirmation:string;deleteCloudCopies:true;eraseDevices:boolean;
}
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const boundedCount=(value:unknown):value is number=>Number.isInteger(value)&&Number(value)>=0&&Number(value)<=1000;
function invalid():never{throw new PrivacyError('INVALID');}
export function privacyStatus(value:unknown):AccountPrivacyStatus {
  if(!object(value)||!uuid(value.accountId)||(value.state!=='active'&&value.state!=='closed')||!object(value.deviceErasure))invalid();
  const erasure=value.deviceErasure;
  if(typeof erasure.requested!=='boolean'||!boundedCount(erasure.pending)||!boundedCount(erasure.acknowledged)
    ||erasure.pending+erasure.acknowledged>1000||typeof erasure.thisDevicePending!=='boolean'
    ||erasure.thisDevicePending&&!erasure.pending||!erasure.requested&&(erasure.pending!==0||erasure.acknowledged!==0||erasure.thisDevicePending))invalid();
  if(value.state==='active') {
    if(value.closedAt!==null||value.closureRequestId!==null||erasure.requested)invalid();
  } else {
    if(!uuid(value.closureRequestId)||typeof value.closedAt!=='string'||value.closedAt.length!==24)invalid();
    try{if(new Date(value.closedAt).toISOString()!==value.closedAt)invalid();}catch{return invalid();}
  }
  return {accountId:value.accountId,state:value.state as 'active'|'closed',closedAt:value.closedAt as string|null,
    closureRequestId:value.closureRequestId as string|null,deviceErasure:{requested:erasure.requested,pending:erasure.pending,
      acknowledged:erasure.acknowledged,thisDevicePending:erasure.thisDevicePending}};
}
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const stop=()=>{signal.removeEventListener('abort',stop);reject(new PrivacyError('CHANGED'));};
    if(signal.aborted){void promise.catch(()=>undefined);stop();return;}
    signal.addEventListener('abort',stop,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',stop);resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});
  });
}
interface Options {
  apiBaseUrl:string;getAccessToken():Promise<string>;getIdentityKey():string|null;
  subscribeIdentity?(listener:()=>void):()=>void;
  fetcher?:typeof fetch;
}

/** Owns a monotonic authentication epoch. A -> B -> A cannot revive a pending
 * private export or mutation even when the final identity string is the same. */
export class AccountPrivacyClient {
  private readonly base:string;
  private readonly fetcher:typeof fetch;
  private key:string|null;
  private epoch=0;
  private disposed=false;
  private readonly active=new Set<AbortController>();
  private readonly unsubscribe?:()=>void;
  constructor(private readonly options:Options) {
    this.base=normalizeServiceUrl(options.apiBaseUrl);this.key=options.getIdentityKey();
    this.fetcher=options.fetcher??((input,init)=>globalThis.fetch(input,init));
    this.unsubscribe=options.subscribeIdentity?.(()=>{const next=options.getIdentityKey();if(next!==this.key){this.key=next;this.epoch++;for(const controller of this.active)controller.abort();}});
  }
  captureIdentity():()=>boolean {
    const epoch=this.epoch,key=this.options.getIdentityKey();
    return ()=>!this.disposed&&key!==null&&epoch===this.epoch&&key===this.options.getIdentityKey();
  }
  dispose(){this.disposed=true;this.epoch++;for(const controller of this.active)controller.abort();this.unsubscribe?.();}
  private operation(signal:AbortSignal,duration=30000) {
    if(this.disposed||signal.aborted)throw new PrivacyError('CHANGED');
    const key=this.options.getIdentityKey(),epoch=this.epoch;if(!key)throw new PrivacyError('AUTH_REQUIRED');
    const controller=new AbortController(),stop=()=>controller.abort();this.active.add(controller);
    signal.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(stop,duration);
    const checkOwner=()=>{if(this.disposed||this.epoch!==epoch||key!==this.options.getIdentityKey())throw new PrivacyError('CHANGED');};
    const check=()=>{checkOwner();if(controller.signal.aborted)throw new PrivacyError('CHANGED');};
    return {signal:controller.signal,check,checkOwner,wait:<T>(value:Promise<T>)=>abortable(value,controller.signal),
      release:()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);this.active.delete(controller);controller.abort();}};
  }
  private async response(path:string,operation:ReturnType<AccountPrivacyClient['operation']>,method='GET',body?:unknown) {
    const token=await operation.wait(this.options.getAccessToken());operation.check();
    if(typeof token!=='string'||!token||token.length>16384||/[\r\n]/.test(token))throw new PrivacyError('AUTH_REQUIRED');
    const pending=this.fetcher(this.base+path,{method,headers:{Authorization:'Bearer '+token,
      Accept:path.endsWith('/export')?'application/x-ndjson':'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:operation.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    const response=await operation.wait(pending.then(value=>{if(operation.signal.aborted)void value.body?.cancel().catch(()=>undefined);return value;}));
    operation.check();
    if(response.redirected||['opaque','opaqueredirect','error'].includes(response.type)||response.url&&response.url!==this.base+path){void response.body?.cancel().catch(()=>undefined);invalid();}
    return response;
  }
  private async json(path:string,signal:AbortSignal,method='GET',body?:unknown):Promise<unknown> {
    const operation=this.operation(signal);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try {
      const response=await this.response(path,operation,method,body);
      if(!response.body)invalid();reader=response.body.getReader();const parts:Uint8Array[]=[];let bytes=0;
      for(;;){const next=await operation.wait(reader.read());operation.check();if(next.done)break;bytes+=next.value.length;
        if(bytes>16384)invalid();parts.push(next.value);}
      const text=new Uint8Array(bytes);let offset=0;for(const part of parts){text.set(part,offset);offset+=part.length;}
      let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(text));}catch{return invalid();}
      if(!response.ok) {
        const code=object(value)&&object(value.error)?value.error.code:null;
        if(code==='RECENT_AUTHENTICATION_REQUIRED')throw new PrivacyError('RECENT_AUTH_REQUIRED');
        if(response.status===401||response.status===403)throw new PrivacyError('AUTH_REQUIRED');
        if(response.status===404)throw new PrivacyError('UNAVAILABLE');
        if(code==='EXPORT_BUSY')throw new PrivacyError('BUSY');
        throw new PrivacyError('FAILED');
      }
      return value;
    } catch(error) {
      operation.checkOwner();if(error instanceof PrivacyError&&error.code!=='CHANGED')throw error;
      if(method==='GET'&&signal.aborted)throw new PrivacyError('CHANGED');
      throw new PrivacyError(method==='POST'?'OUTCOME_UNKNOWN':'FAILED');
    } finally {operation.release();if(reader){void reader.cancel().catch(()=>undefined);reader.releaseLock();}}
  }
  async status(signal:AbortSignal):Promise<AccountPrivacyStatus>{return privacyStatus(await this.json('/v1/privacy/status',signal));}
  async close(request:ClosureRequest,signal:AbortSignal):Promise<AccountPrivacyStatus>{
    if(!uuid(request.accountId)||!uuid(request.requestId)||request.confirmation!=='注销 '+request.accountId
      ||request.deleteCloudCopies!==true||typeof request.eraseDevices!=='boolean')invalid();
    const result=privacyStatus(await this.json('/v1/privacy/close',signal,'POST',request));
    if(result.accountId!==request.accountId||result.state!=='closed'||result.closureRequestId!==request.requestId)invalid();return result;
  }
  async acknowledge(deviceId:string,signal:AbortSignal):Promise<void>{
    if(!uuid(deviceId))invalid();const value=await this.json('/v1/privacy/erasure-ack',signal,'POST',{deviceId});
    if(!object(value)||value.acknowledged!==true)invalid();
  }
  async exportData(scope:AccountScope,sink:PersonalExportSink,signal:AbortSignal,progress?:(bytes:number)=>void) {
    let activeOperation:ReturnType<AccountPrivacyClient['operation']>|undefined;
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try {
      if(normalizeServiceUrl(scope.apiBaseUrl)!==this.base||!uuid(scope.accountId))invalid();
      const operation=this.operation(signal,15*60_000);activeOperation=operation;
      const response=await this.response('/v1/privacy/export',operation);
      if(!response.ok){void response.body?.cancel().catch(()=>undefined);
        throw new PrivacyError(response.status===409?'BUSY':response.status===401||response.status===403?'AUTH_REQUIRED':'FAILED');}
      if(!response.body||!response.headers.get('content-type')?.startsWith('application/x-ndjson'))invalid();
      reader=response.body.getReader();
      const source=async function*(){for(;;){const next=await operation.wait(reader!.read());operation.check();if(next.done)break;yield next.value;}};
      return await consumePersonalExport(source(),scope.accountId,sink,{signal:operation.signal,current:()=>{
        try{operation.check();return true;}catch{return false;}},progress});
    } catch(error) {await sink.abort().catch(()=>undefined);throw error;}
    finally {activeOperation?.release();if(reader){void reader.cancel().catch(()=>undefined);reader.releaseLock();}}
  }
}

/** Contains no token/key/content. Persist before issuing a closure POST; never
 * infer success from elapsed time and never automatically retry the write. */
export class ClosureIntentStore {
  constructor(private readonly storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>){}
  private key(scope:AccountScope){return 'paperquay.privacy.intent.v1.'+encodeURIComponent(accountScopeKey(scope));}
  read(scope:AccountScope):ClosureRequest|null {
    const raw=this.storage.getItem(this.key(scope));if(raw===null)return null;
    if(raw.length>1024)invalid();let value:unknown;try{value=JSON.parse(raw);}catch{return invalid();}
    if(!object(value)||Object.keys(value).sort().join(',')!=='accountId,confirmation,deleteCloudCopies,eraseDevices,requestId'
      ||value.accountId!==scope.accountId||!uuid(value.requestId)||value.confirmation!=='注销 '+scope.accountId
      ||value.deleteCloudCopies!==true||typeof value.eraseDevices!=='boolean')invalid();
    return value as unknown as ClosureRequest;
  }
  save(scope:AccountScope,request:ClosureRequest):void {
    if(Object.keys(request).sort().join(',')!=='accountId,confirmation,deleteCloudCopies,eraseDevices,requestId'
      ||request.accountId!==scope.accountId||!uuid(request.requestId)||request.confirmation!=='注销 '+scope.accountId
      ||request.deleteCloudCopies!==true||typeof request.eraseDevices!=='boolean')invalid();
    const existing=this.read(scope);
    if(existing&&(existing.requestId!==request.requestId||existing.confirmation!==request.confirmation
      ||existing.eraseDevices!==request.eraseDevices||existing.deleteCloudCopies!==request.deleteCloudCopies))throw new PrivacyError('OUTCOME_UNKNOWN');
    this.storage.setItem(this.key(scope),JSON.stringify(request));
  }
  remove(scope:AccountScope){this.storage.removeItem(this.key(scope));}
}
