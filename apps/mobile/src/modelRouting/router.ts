import {AiError} from '../ai/errors.ts';
import type {AiAccountScope,AiModelRoutingTransport,AiProviderConfig} from '../ai/types.ts';
import {aiAccountKey} from '../ai/provider.ts';
import {validateModelRouteConfig} from './config.ts';
import {ModelServiceError} from './errors.ts';
import type {ModelInvocationApi,ModelGatewayCandidate} from './api.ts';
import {canonicalJson} from '../../../../packages/sync-core/src/validation.ts';
import {prepareModelInferenceRequest,validateModelInferenceAvailability} from '../../../../packages/sync-core/src/modelInference.ts';
import type {ModelInferenceRequest,ModelInferenceStatus,ModelInferenceProfile,ModelInferenceAvailability} from '../../../../packages/sync-core/src/modelInference.ts';
import {beginModelRecord,checkedModelStatus,verifyModelLedger,observeModelRecord,markModelUncertain,releaseModelRecord,compactModelRecord} from './ledger.ts';
import type {ModelLedgerOwner,ModelInvocationRecord,ModelPurpose} from './ledger.ts';
import {waitForModelCall} from './wire.ts';
type InvocationInput=Parameters<AiModelRoutingTransport['invoke']>[0];
export interface ModelPendingSave {request:ModelInferenceRequest;status:ModelInferenceStatus}
export function describeModelRoutingError(error:unknown):AiError {
 if(error instanceof AiError)return error;
 const code=error&&typeof error==='object'&&'code'in error?error.code:null;
 if(['AUTH_REQUIRED','SESSION_REVOKED','ACCOUNT_CHANGED'].includes(String(code)))return new AiError('REMOTE_AUTH_REQUIRED');
 if(error instanceof ModelServiceError){
  if(['MODEL_INFERENCE_CHANGED','MODEL_INFERENCE_PROFILE_UNAVAILABLE','MODEL_INFERENCE_LEASE_CHANGED'].includes(error.code))return new AiError('REMOTE_PROFILE_CHANGED');
  if(['MODEL_INFERENCE_HISTORY_FULL','MODEL_INFERENCE_STORAGE_FULL','MODEL_INFERENCE_QUEUE_FULL','MODEL_INFERENCE_ACTIVE','MODEL_INFERENCE_BUSY','MODEL_GATEWAY_BUSY'].includes(error.code))return new AiError('REMOTE_CAPACITY');
  if(error.code==='MODEL_INFERENCE_LIMIT')return new AiError('INPUT_TOO_LARGE');
  if(error.code==='MODEL_RESPONSE_INVALID')return new AiError('INVALID_RESPONSE');
  return new AiError('REMOTE_UNAVAILABLE');
 }
 return new AiError('REMOTE_UNCONFIRMED');
}
function ref(profile:ModelInferenceProfile){return{id:profile.id,revision:profile.revision,digest:profile.digest};}
/** Session-owned consumer. Constructing, mounting or reading it never starts a model. */
export class MobileModelRouter implements AiModelRoutingTransport {
 #api:ModelInvocationApi;#owner:ModelLedgerOwner;#scope:AiAccountScope;#now:()=>number;#pause:(signal:AbortSignal)=>Promise<void>;#polls:number;
 #busy=false;#pending=new Map<string,ModelPendingSave>();#listeners=new Set<()=>void>();#snapshot={revision:0,pendingIds:[] as string[]};
 constructor(options:{api:ModelInvocationApi;owner:ModelLedgerOwner;scope:AiAccountScope;now?:()=>number;pause?:(signal:AbortSignal)=>Promise<void>;polls?:number}){
  this.#api=options.api;this.#owner=options.owner;this.#scope={...options.scope};aiAccountKey(this.#scope);this.#now=options.now??Date.now;
  this.#pause=options.pause??(signal=>new Promise((resolve,reject)=>{let timer:ReturnType<typeof setTimeout>;const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);resolve();},stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(new AiError('CANCELLED'));};if(signal.aborted){reject(new AiError('CANCELLED'));return;}timer=setTimeout(done,1000);signal.addEventListener('abort',stop,{once:true});}));
  this.#polls=options.polls??110;if(!Number.isSafeInteger(this.#polls)||this.#polls<1||this.#polls>110)throw new AiError('CONFIG_INVALID');
 }
 subscribe=(f:()=>void)=>{this.#listeners.add(f);return()=>{this.#listeners.delete(f);};};
 getSnapshot=()=>this.#snapshot;
 current=()=>this.#owner.current();
 #publish(){this.#snapshot={revision:this.#snapshot.revision+1,pendingIds:[...this.#pending.keys()]};for(const f of this.#listeners)f();}
 #check(signal?:AbortSignal,current?:()=>boolean){if(!this.#owner.current())throw new AiError('REMOTE_AUTH_REQUIRED');if(signal?.aborted||current&&!current())throw new AiError('CANCELLED');}
 async #config(scope:AiAccountScope,config:AiProviderConfig){if(aiAccountKey(scope)!==aiAccountKey(this.#scope))throw new AiError('REMOTE_AUTH_REQUIRED');return validateModelRouteConfig(this.#scope,config);}
 async #call<T>(signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  this.#check(signal);const abort=new AbortController(),stop=()=>abort.abort();
  signal.addEventListener('abort',stop,{once:true});this.#owner.signal.addEventListener('abort',stop,{once:true});
  if(signal.aborted||this.#owner.signal.aborted)abort.abort();
  try{return await waitForModelCall(work(abort.signal),abort.signal);}
  catch(e){if(!this.#owner.current())throw new AiError('REMOTE_AUTH_REQUIRED');if(signal.aborted)throw new AiError('CANCELLED');throw e;}
  finally{signal.removeEventListener('abort',stop);this.#owner.signal.removeEventListener('abort',stop);}
 }
 async inventory(signal:AbortSignal):Promise<ModelInferenceAvailability>{
  this.#check(signal);const start=this.#now(),value=validateModelInferenceAvailability(await this.#call(signal,s=>this.#api.availability(s)));this.#check(signal);const end=this.#now(),checked=Date.parse(value.checkedAt),until=Date.parse(value.validUntil);
  // Arrival time alone does not prove presence; stale/future server observations cannot authorize a paid call.
  if(end<start||end-start>45000||checked>end+5000||until<=end||checked<end-45000||value.computers.some(c=>Date.parse(c.expiresAt)>checked+45000))throw new AiError('REMOTE_UNAVAILABLE');return value;
 }
 async #profile(config:AiProviderConfig,signal:AbortSignal,current?:()=>boolean):Promise<ModelInferenceProfile>{
  this.#check(signal,current);const available=await this.inventory(signal);this.#check(signal,current);const execution=config.execution!;
  const computer=execution.target.kind==='computer'?available.computers.find(c=>c.deviceId===(execution.target as {deviceId:string}).deviceId):null;
  const profile=execution.target.kind==='gateway'?available.gateway:computer&&Date.parse(computer.expiresAt)>this.#now()?computer.profiles.find(p=>canonicalJson(ref(p))===canonicalJson(execution.profileRef)):null;
  if(!profile||canonicalJson(ref(profile))!==canonicalJson(execution.profileRef)||profile.model!==config.model||profile.maxOutputTokens<config.maxOutputTokens)throw new AiError('REMOTE_PROFILE_CHANGED');return profile;
 }
 async inspect(input:Parameters<AiModelRoutingTransport['inspect']>[0]):Promise<string[]>{try{const config=await this.#config(input.accountScope,input.config);await this.#profile(config,input.signal,input.current);return[config.model];}catch(e){throw describeModelRoutingError(e);}}
 async #record(id:string){this.#check();const ledger=await verifyModelLedger(this.#owner.read());this.#check();const record=ledger.records.find(r=>r.request.id===id);if(!record)throw new AiError('REMOTE_UNCONFIRMED');return record;}
 async #save(request:ModelInferenceRequest,value:unknown):Promise<ModelInvocationRecord>{
  let status=await checkedModelStatus(request,value);this.#check();const retained=this.#pending.get(request.id);
  if(retained?.status.output){if(status.output&&status.output.digest!==retained.status.output.digest)throw new AiError('INVALID_RESPONSE');status=await checkedModelStatus(request,retained.status);this.#check();}
  try{await this.#owner.update(ledger=>observeModelRecord(ledger,request.id,status,this.#now()));this.#check();this.#pending.delete(request.id);this.#publish();}
  catch(e){if(e instanceof AiError)throw e;if(this.#owner.current()){if(!this.#pending.has(request.id)&&this.#pending.size>=4)throw new AiError('REMOTE_CAPACITY');this.#pending.set(request.id,{request:structuredClone(request),status});this.#publish();}throw e;}
  return this.#record(request.id);
 }
 #result(record:ModelInvocationRecord){if(record.output)return structuredClone(record.output);if(record.phase==='failed')throw new AiError('REMOTE_UNAVAILABLE');if(['cancelled','removed'].includes(record.phase))throw new AiError('CANCELLED');throw new AiError(record.phase==='waiting'?'REMOTE_PENDING':'REMOTE_UNCONFIRMED');}
 async invoke(input:InvocationInput){
  if(this.#busy)throw new AiError('REMOTE_PENDING');this.#busy=true;let intended:ModelInferenceRequest|null=null;
  try{
   this.#check(input.signal,input.current);const config=await this.#config(input.accountScope,input.config),execution=config.execution!;
   const request=await prepareModelInferenceRequest({id:input.requestId,target:execution.target,profileRef:execution.profileRef,model:config.model,messages:input.messages as ModelInferenceRequest['messages'],maxOutputTokens:config.maxOutputTokens});
   this.#check(input.signal,input.current);const ledger=await verifyModelLedger(this.#owner.read());this.#check(input.signal,input.current);
   const receipt=ledger.receipts.find(r=>r.id===request.id);let record=ledger.records.find(r=>r.request.id===request.id),created=false;
   if(receipt){
    if(receipt.inputDigest!==request.digest||receipt.purpose!==input.purpose)throw new AiError('REMOTE_PROFILE_CHANGED');
    if(!record)throw new AiError('REMOTE_UNCONFIRMED');
    if(record.output){this.#check(input.signal,input.current);return this.#result(record);}
   }else{
    if(this.#pending.size)throw new AiError('REMOTE_UNCONFIRMED');
    const profile=await this.#profile(config,input.signal,input.current);if(new TextEncoder().encode(JSON.stringify(request.messages)).length>profile.maxInputBytes)throw new AiError('CONTEXT_TOO_LARGE');
    this.#check(input.signal,input.current);
    // A missing or lost local acknowledgement ALWAYS means zero create POSTs.
    try{await this.#owner.update(value=>{this.#check(input.signal,input.current);const next=beginModelRecord(value,request,input.purpose,this.#now());created=next.created;return next.ledger;});}
    catch(e){if(this.#owner.current()&&!input.signal.aborted)await waitForModelCall(this.#owner.refresh(),input.signal).then(()=>{if(this.#owner.current())this.#publish();}).catch(()=>{});if(e instanceof AiError)throw e;throw new AiError('REMOTE_UNCONFIRMED');}
    intended=request;this.#publish();this.#check(input.signal,input.current);
   }
   intended=request;
   if(created){const response=await this.#call(input.signal,s=>this.#api.create(request,s));record=await this.#save(request,response.result);}
   else record=await this.#save(request,await this.#call(input.signal,s=>this.#api.status(request.id,s)));
   // Existing/replayed queued jobs are NEVER auto-dispatched. Only GETs are used while waiting.
   for(let i=0;i<this.#polls;i++){
    this.#check(input.signal,input.current);if(record.output||['failed','cancelled','removed','uncertain'].includes(record.phase))return this.#result(record);
    await waitForModelCall(this.#pause(input.signal),input.signal);this.#check(input.signal,input.current);record=await this.#save(request,await this.#call(input.signal,s=>this.#api.status(request.id,s)));
   }
   throw new AiError('REMOTE_PENDING');
  }catch(e){
   if(intended&&this.#owner.current())await this.#owner.update(v=>markModelUncertain(v,intended!.id,this.#now())).catch(()=>{});
   if(this.#owner.current())this.#publish();
   throw describeModelRoutingError(e);
  }finally{this.#busy=false;}
 }
 /** Read only local storage after an ambiguous local ACK. Never creates a job or writes the workspace. */
 async refreshLocal(signal:AbortSignal){try{await this.#call(signal,()=>this.#owner.refresh());this.#check(signal);this.#publish();}catch(e){throw describeModelRoutingError(e);}}
 /** Explicit status inspection only; no job creation or gateway dispatch. */
 async refresh(id:string,signal:AbortSignal){try{const r=await this.#record(id);this.#check(signal);return await this.#save(r.request,await this.#call(signal,s=>this.#api.status(id,s)));}catch(e){throw describeModelRoutingError(e);}}
 async retryLocalSave(id:string){try{this.#check();const pending=this.#pending.get(id);if(!pending)throw new AiError('REMOTE_UNCONFIRMED');const record=await this.#record(id);if(canonicalJson(record.request)!==canonicalJson(pending.request))throw new AiError('REMOTE_PROFILE_CHANGED');await this.#save(record.request,pending.status);}catch(e){throw describeModelRoutingError(e);}}
 async cancel(id:string,signal:AbortSignal){try{const r=await this.#record(id);this.#check(signal);return await this.#save(r.request,await this.#call(signal,s=>this.#api.cancel(id,s)));}catch(e){throw describeModelRoutingError(e);}}
 async dispatchQueued(id:string,signal:AbortSignal){
  if(this.#busy)throw new AiError('REMOTE_PENDING');this.#busy=true;
  try{const r=await this.refresh(id,signal);this.#check(signal);if(r.request.target.kind!=='gateway'||r.job?.state!=='queued'||r.output)throw new AiError('REMOTE_UNCONFIRMED');await this.#call(signal,s=>this.#api.dispatch(id,s));this.#check(signal);return await this.refresh(id,signal);}catch(e){throw describeModelRoutingError(e);}finally{this.#busy=false;}
 }
 async retryGatewaySave(id:string,signal:AbortSignal){try{const r=await this.#record(id);this.#check(signal);if(r.request.target.kind!=='gateway')throw new AiError('REMOTE_UNAVAILABLE');await this.#call(signal,s=>this.#api.retrySave(id,s));this.#check(signal);return this.refresh(id,signal);}catch(e){throw describeModelRoutingError(e);}}
 async gatewayCandidate(id:string,signal:AbortSignal):Promise<ModelGatewayCandidate>{try{const r=await this.#record(id);this.#check(signal);const candidate=await this.#call(signal,s=>this.#api.candidate(id,s));this.#check(signal);if(canonicalJson(candidate.request)!==canonicalJson(r.request))throw new AiError('REMOTE_PROFILE_CHANGED');return candidate;}catch(e){throw describeModelRoutingError(e);}}
 async release(id:string){this.#check();if(this.#busy)throw new AiError('REMOTE_PENDING');await this.#owner.update(v=>releaseModelRecord(v,id));this.#publish();}
 async compact(id:string){this.#check();if(this.#busy||this.#pending.has(id))throw new AiError('REMOTE_PENDING');await this.#owner.update(v=>compactModelRecord(v,id));this.#publish();}
 async readActivity(){this.#check();const ledger=await verifyModelLedger(this.#owner.read());this.#check();return ledger;}
 async backup(id:string){const record=await this.#record(id),pending=this.#pending.get(id);this.#check();if(pending)await checkedModelStatus(record.request,pending.status);this.#check();return structuredClone({format:'paperquay-model-invocation',version:1,record,...(pending?{pendingSave:pending}:{}),unconfirmedSave:Boolean(pending)});}
}
