import type {ServiceCapabilitySnapshot} from '../api.ts';
import {ClientError,describeError} from '../errors.ts';
import {RemoteTaskClient,RemoteTaskError,describeRemoteTaskError,type RemoteTaskContext} from '../remote/client.ts';
import type {RemoteTaskProvider} from '../../../../packages/sync-core/src/remoteTasks.ts';
export interface FeatureInspection {
 status:'idle'|'loading'|'ready'|'error';checkedAt:string|null;service:ServiceCapabilitySnapshot|null;
 providers:RemoteTaskProvider[];providersCheckedAt:string|null;providersError:string;
 batch:'unknown'|'supported'|'unsupported';batchError:string;error:string;
}
const initial=():FeatureInspection=>({status:'idle',checkedAt:null,service:null,providers:[],providersCheckedAt:null,providersError:'',batch:'unknown',batchError:'',error:''});
function message(error:unknown){return error instanceof ClientError?describeError(error):error instanceof RemoteTaskError?describeRemoteTaskError(error):'本次检查未能完成，请稍后重新检查。';}
export class FeatureInspector {
 private snapshot=initial();private listeners=new Set<()=>void>();private generation=0;private abort:AbortController|null=null;private disposed=false;
 constructor(private options:{readService(signal:AbortSignal):Promise<ServiceCapabilitySnapshot>;remote?:RemoteTaskContext;current():boolean;now?:()=>number;timeoutMs?:number}){
  if(options.timeoutMs!==undefined&&(!Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>30000))throw new Error('Invalid inspection timeout');
 }
 getSnapshot=()=>this.snapshot;subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private publish(snapshot:FeatureInspection){this.snapshot=snapshot;for(const listener of this.listeners)listener();}
 activate=()=>{this.disposed=false;};
 async inspect(){
  if(this.disposed||!this.options.current()||this.snapshot.status==='loading')return;
  const abort=new AbortController(),generation=++this.generation;this.abort=abort;
  const now=this.options.now??Date.now,current=()=>!this.disposed&&generation===this.generation&&!abort.signal.aborted&&this.options.current();
  const check=()=>{if(!current())throw new ClientError('ACCOUNT_CHANGED');};
  const wait=<T>(promise:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
   const cancelled=()=>{abort.signal.removeEventListener('abort',cancelled);reject(new ClientError('REQUEST_TIMEOUT',true));};
   abort.signal.addEventListener('abort',cancelled,{once:true});promise.then(value=>{abort.signal.removeEventListener('abort',cancelled);resolve(value);},error=>{abort.signal.removeEventListener('abort',cancelled);reject(error);});if(abort.signal.aborted)cancelled();
  });
  const timer=setTimeout(()=>abort.abort(),this.options.timeoutMs??15000);
  // Old online evidence is not reused while a fresh check is unresolved or fails.
  this.publish({...initial(),status:'loading'});
  try{
   const service=await wait(this.options.readService(abort.signal));check();
   let providers:RemoteTaskProvider[]=[],providersCheckedAt:string|null=null,providersError='',batch:FeatureInspection['batch']='unknown',batchError='';
   if(service.remoteTasks&&this.options.remote){
    const client=new RemoteTaskClient({...this.options.remote,getCapability:()=>service.remoteTasks}),call={signal:abort.signal,current};
    // Both are read-only: lookup of a fresh random ID does not reserve a receipt.
    const rows=await wait(Promise.allSettled([client.providers(call),client.lookupRequest(crypto.randomUUID(),call)]));check();
    if(rows[0].status==='fulfilled'){providers=rows[0].value;providersCheckedAt=new Date(now()).toISOString();}else providersError=message(rows[0].reason);
    if(rows[1].status==='fulfilled')batch='supported';else{batch=rows[1].reason instanceof RemoteTaskError&&rows[1].reason.code==='BATCH_UNSUPPORTED'?'unsupported':'unknown';batchError=message(rows[1].reason);}
   }
   this.publish({status:'ready',checkedAt:new Date(now()).toISOString(),service,providers,providersCheckedAt,providersError,batch,batchError,error:''});
  }catch(error){if(!this.disposed&&generation===this.generation&&this.options.current())this.publish({...initial(),status:'error',error:abort.signal.aborted?'本次检查已超时或停止，未采用未完成的结果。':message(error)});}
  finally{clearTimeout(timer);if(generation===this.generation)this.abort=null;}
 }
 stop=()=>{this.generation++;this.abort?.abort();this.abort=null;this.publish({...initial(),error:'已停止本次检查。未读取到的服务与电脑能力仍需重新核对。'});};
 dispose=()=>{this.disposed=true;this.generation++;this.abort?.abort();this.abort=null;this.snapshot=initial();};
}
