import {createHash} from 'node:crypto';
import {createModelInferenceAdapter,ModelUpstreamError,type ModelInferenceAdapter} from '../../packages/model-inference/index.mjs';
import {validateModelInferenceRequest,prepareModelInferenceOutput,parseModelInferenceJson,type ModelInferenceClaim,type ModelInferenceOutput,type ModelInferenceStatus,type ModelInferenceFailure} from '../../packages/sync-core/src/modelInference.ts';
import {modelGatewayAuthorized,modelGatewayProfile,type ModelGatewayConfig} from './model-config.ts';
import type {ModelInferenceRepository} from './model-inference-store.ts';
import type {VerifiedIdentity} from './auth.ts';
import {ApiError} from './errors.ts';
type Repository=Pick<ModelInferenceRepository,'lookupInvocation'|'claimGateway'|'heartbeatGateway'|'completeGateway'|'failGateway'>;
type Phase='queued'|'claiming'|'requesting'|'saving'|'save-unconfirmed';
type Outcome={output:ModelInferenceOutput}|{failure:ModelInferenceFailure};
interface Work{key:string;who:VerifiedIdentity;id:string;phase:Phase;abort:AbortController;claim:ModelInferenceClaim|null;outcome:Outcome|null;stopReason:'cancel'|'shutdown'|null;retryTimer:ReturnType<typeof setTimeout>|null}
export interface ModelGatewayRecoveryInfo{id:string;phase:'none'|Phase;hasOutput:boolean}
export interface ModelGatewayDriverOptions{repository:Repository;getConfiguration():ModelGatewayConfig|null;serverSecret:Uint8Array;fetch?:typeof fetch;adapter?:ModelInferenceAdapter;heartbeatMs?:number;queueDelayMs?:number}
function fresh(who:VerifiedIdentity){return Number.isSafeInteger(who.expiresAtMs)&&Number(who.expiresAtMs)>Date.now();}
function key(who:VerifiedIdentity,id:string){return createHash('sha256').update(JSON.stringify([who.issuer,who.subject,id])).digest('hex');}
function sameProfile(a:ModelInferenceClaim['job']['profile'],b:ModelInferenceClaim['job']['profile']){return a.id===b.id&&a.revision===b.revision&&a.digest===b.digest&&a.model===b.model;}
/** A queued request can be claimed once. Persistence recovery never calls the upstream adapter. */
export class ModelGatewayDriver{
 #repository:Repository;#configuration:ModelGatewayDriverOptions['getConfiguration'];#secret:Uint8Array;#adapter:ModelInferenceAdapter;
 #works=new Map<string,Work>();#pending:string[]=[];#operations=new Set<Promise<void>>();#active=0;#closing=false;#closed=false;#closePromise:Promise<void>|null=null;#heartbeatMs:number;#queueDelayMs:number;
 constructor(options:ModelGatewayDriverOptions){
  if(!(options.serverSecret instanceof Uint8Array)||options.serverSecret.length<32||options.serverSecret.length>128)throw new ApiError('CONFIGURATION_INVALID',500);this.#repository=options.repository;this.#configuration=options.getConfiguration;this.#secret=Uint8Array.from(options.serverSecret);this.#adapter=options.adapter??createModelInferenceAdapter({fetch:options.fetch,validateRequest:validateModelInferenceRequest,prepareOutput:prepareModelInferenceOutput,parseJson:parseModelInferenceJson});this.#heartbeatMs=Math.min(options.heartbeatMs??10000,10000);this.#queueDelayMs=Math.min(options.queueDelayMs??1000,1000);if(!Number.isSafeInteger(this.#heartbeatMs)||this.#heartbeatMs<1||!Number.isSafeInteger(this.#queueDelayMs)||this.#queueDelayMs<1)throw new ApiError('CONFIGURATION_INVALID',500);
 }
 #owns(work:Work){return !this.#closed&&this.#works.get(work.key)===work;}
 #configurationFor(who:VerifiedIdentity){const c=this.#configuration();if(!c||!modelGatewayAuthorized(c,who.subject))throw new ApiError('MODEL_GATEWAY_UNAVAILABLE',503);return c;}
 #matches(work:Work){try{const c=this.#configurationFor(work.who);return Boolean(work.claim&&sameProfile(modelGatewayProfile(c,this.#secret),work.claim.job.profile));}catch{return false;}}
 #paidCurrent(work:Work){return this.#owns(work)&&!this.#closing&&work.phase==='requesting'&&!work.abort.signal.aborted&&fresh(work.who)&&this.#matches(work);}
 #drop(work:Work){if(!this.#owns(work))return;if(work.retryTimer)clearTimeout(work.retryTimer);work.retryTimer=null;this.#works.delete(work.key);this.#pending=this.#pending.filter(k=>k!==work.key);}
 #retained(){return [...this.#works.values()].filter(w=>w.outcome!==null).length;}
 #pump(){
  if(this.#closing||this.#closed)return;while(this.#active<2&&this.#active+this.#retained()<16&&this.#pending.length){const k=this.#pending.shift()!,work=this.#works.get(k);if(!work||work.phase!=='queued')continue;this.#active++;work.phase='claiming';let task!:Promise<void>;task=this.#run(work).catch(()=>{if(this.#owns(work)&&work.phase!=='save-unconfirmed')this.#drop(work);}).finally(()=>{this.#active--;this.#operations.delete(task);this.#pump();});this.#operations.add(task);}
 }
 #queueLater(work:Work){if(!this.#owns(work)||this.#closing){this.#drop(work);return;}work.phase='queued';work.retryTimer=setTimeout(()=>{work.retryTimer=null;if(this.#owns(work)&&work.phase==='queued'){this.#pending.push(work.key);this.#pump();}},this.#queueDelayMs);work.retryTimer.unref?.();}
 async #save(work:Work,who:VerifiedIdentity){
  if(!this.#owns(work)||!work.claim||!work.outcome)return;work.phase='saving';const outcome=work.outcome;
  try{if('output'in outcome){const result=await this.#repository.completeGateway(who,work.id,work.claim.lease,outcome.output);if(!this.#owns(work))return;if(result.result.output?.digest===outcome.output.digest)this.#drop(work);else work.phase='save-unconfirmed';}
   else{await this.#repository.failGateway(who,work.id,work.claim.lease,outcome.failure);if(this.#owns(work))this.#drop(work);}}
  catch{if(this.#owns(work))work.phase='save-unconfirmed';}
 }
 async #run(work:Work){
  let heartbeat:ReturnType<typeof setInterval>|null=null,hbBusy=false;
  const pulse=()=>{if(hbBusy||!this.#paidCurrent(work)||!work.claim)return;hbBusy=true;let operation!:Promise<void>;operation=(async()=>{try{const result=await this.#repository.heartbeatGateway(work.who,work.id,work.claim!.lease);if(!this.#owns(work)||work.phase!=='requesting')return;if(result.job.state!=='running'){if(result.job.state==='cancel_requested'||result.job.state==='cancelled')work.stopReason='cancel';work.abort.abort();}}catch{if(this.#owns(work)&&work.phase==='requesting')work.abort.abort();}finally{hbBusy=false;}})().finally(()=>this.#operations.delete(operation));this.#operations.add(operation);};
  try{
   if(!this.#owns(work)||this.#closing||!fresh(work.who)){this.#drop(work);return;}const claimed=await this.#repository.claimGateway(work.who,work.id);if(!this.#owns(work))return;
   if(!claimed.claim){const observed=await this.#repository.lookupInvocation(work.who,work.id);if(this.#owns(work)&&observed.job?.state==='queued')this.#queueLater(work);else this.#drop(work);return;}work.claim=claimed.claim;
   if(this.#closing){work.outcome={failure:'CANCELLED'};await this.#save(work,work.who);return;}let configuration:ModelGatewayConfig;try{configuration=this.#configurationFor(work.who);}catch{work.outcome={failure:'PROFILE_CHANGED'};await this.#save(work,work.who);return;}if(!sameProfile(modelGatewayProfile(configuration,this.#secret),work.claim.job.profile)){work.outcome={failure:'PROFILE_CHANGED'};await this.#save(work,work.who);return;}
   work.phase='requesting';heartbeat=setInterval(pulse,this.#heartbeatMs);heartbeat.unref?.();
   try{const output=await this.#adapter.execute({request:work.claim.request,config:configuration.provider,signal:work.abort.signal,current:()=>this.#paidCurrent(work),authorize:async()=>{if(!this.#paidCurrent(work))return false;const result=await this.#repository.heartbeatGateway(work.who,work.id,work.claim!.lease);if(result.job.state==='cancel_requested'||result.job.state==='cancelled')work.stopReason='cancel';return result.job.state==='running'&&this.#paidCurrent(work);}});if(!this.#owns(work))return;work.outcome={output};}
   catch(error){if(!this.#owns(work))return;const e=error instanceof ModelUpstreamError?error:new ModelUpstreamError('OUTCOME_UNKNOWN',true),failure:ModelInferenceFailure=work.stopReason==='cancel'?'CANCELLED':e.code==='CANCELLED'?(e.sent?'OUTCOME_UNKNOWN':'CANCELLED'):e.code;work.outcome={failure};}
   if(heartbeat)clearInterval(heartbeat);heartbeat=null;if(this.#owns(work))await this.#save(work,work.who);
  }catch{if(this.#owns(work)){if(work.claim){work.outcome??={failure:'OUTCOME_UNKNOWN'};await this.#save(work,work.who);}else this.#drop(work);}}
  finally{if(heartbeat)clearInterval(heartbeat);}
 }
 dispatch(who:VerifiedIdentity,id:string):Promise<ModelGatewayRecoveryInfo>{const result=this.#dispatch(who,id);let tracked!:Promise<void>;tracked=result.then(()=>{},()=>{}).finally(()=>this.#operations.delete(tracked));this.#operations.add(tracked);return result;}
 async #dispatch(who:VerifiedIdentity,id:string):Promise<ModelGatewayRecoveryInfo>{
  if(this.#closing||this.#closed)throw new ApiError('MODEL_GATEWAY_CLOSED',503);if(!fresh(who))throw new ApiError('AUTHENTICATION_REQUIRED',401);this.#configurationFor(who);const status=await this.#repository.lookupInvocation(who,id);if(this.#closing||this.#closed)throw new ApiError('MODEL_GATEWAY_CLOSED',503);if(!fresh(who))throw new ApiError('AUTHENTICATION_REQUIRED',401);this.#configurationFor(who);this.observe(who,status);const existing=this.#works.get(key(who,id));if(existing){if(existing.phase==='queued'){existing.who={...who};if(!existing.retryTimer&&!this.#pending.includes(existing.key)){this.#pending.push(existing.key);this.#pump();}}return this.inspect(who,id);}
  if(status.status!=='known'||status.job?.target.kind!=='gateway'||status.job.state!=='queued')return{id,phase:'none',hasOutput:false};if([...this.#works.values()].filter(w=>w.phase==='queued').length>=16)throw new ApiError('MODEL_GATEWAY_BUSY',429);const work:Work={key:key(who,id),who:{...who},id,phase:'queued',abort:new AbortController(),claim:null,outcome:null,stopReason:null,retryTimer:null};this.#works.set(work.key,work);this.#pending.push(work.key);this.#pump();return this.inspect(who,id);
 }
 inspect(who:VerifiedIdentity,id:string):ModelGatewayRecoveryInfo{const work=this.#works.get(key(who,id));return{id,phase:work?.phase??'none',hasOutput:Boolean(work?.outcome&&'output'in work.outcome)};}
 /** The route calls this only after an authenticated repository read; observing never dispatches an upstream call. */
 observe(who:VerifiedIdentity,status:ModelInferenceStatus){const work=this.#works.get(key(who,status.id));if(!work)return;if(work.who.sessionId===who.sessionId&&fresh(who)&&Number(who.expiresAtMs)>Number(work.who.expiresAtMs))work.who={...who};if(status.status==='removed'){work.abort.abort();this.#drop(work);return;}if(work.outcome&&'output'in work.outcome&&status.output?.digest===work.outcome.output.digest){this.#drop(work);return;}if(work.phase==='queued'&&(status.status!=='known'||status.job?.state!=='queued')){this.#drop(work);return;}if(status.job?.state==='cancel_requested'||status.job?.state==='cancelled'){work.stopReason='cancel';if(!work.outcome)work.abort.abort();}}
 async retrySave(who:VerifiedIdentity,id:string):Promise<ModelGatewayRecoveryInfo>{if(!fresh(who))throw new ApiError('AUTHENTICATION_REQUIRED',401);if(this.#closing||this.#closed)throw new ApiError('MODEL_GATEWAY_CLOSED',503);const status=await this.#repository.lookupInvocation(who,id);this.observe(who,status);const work=this.#works.get(key(who,id));if(!work)return this.inspect(who,id);if(work.phase!=='save-unconfirmed'||!work.outcome||!work.claim)throw new ApiError('MODEL_INFERENCE_ACTIVE',409);await this.#save(work,who);this.#pump();return this.inspect(who,id);}
 async candidate(who:VerifiedIdentity,id:string){if(!fresh(who))throw new ApiError('AUTHENTICATION_REQUIRED',401);const status=await this.#repository.lookupInvocation(who,id);this.observe(who,status);const work=this.#works.get(key(who,id));if(!work?.outcome||!work.claim||work.phase!=='save-unconfirmed')throw new ApiError('MODEL_INFERENCE_NOT_FOUND',404);return structuredClone({format:'paperquay-gateway-unconfirmed-result',version:1,id,request:work.claim.request,...work.outcome,unconfirmedSave:true});}
 forget(who:VerifiedIdentity,id:string){if(!fresh(who))throw new ApiError('AUTHENTICATION_REQUIRED',401);const work=this.#works.get(key(who,id));if(!work)return{forgotten:false};if(work.phase!=='save-unconfirmed')throw new ApiError('MODEL_INFERENCE_ACTIVE',409);this.#drop(work);this.#pump();return{forgotten:true};}
 cancel(who:VerifiedIdentity,status:ModelInferenceStatus){this.observe(who,status);const work=this.#works.get(key(who,status.id));if(!work)return;if(status.status==='cancelled'||status.status==='removed'||status.job?.state==='cancel_requested'||status.job?.state==='cancelled'){work.stopReason='cancel';if(!work.outcome){work.abort.abort();if(work.phase==='queued')this.#drop(work);}}}
 async settled(){while(this.#operations.size)await Promise.allSettled([...this.#operations]);}
 close():Promise<void>{if(this.#closePromise)return this.#closePromise;this.#closing=true;for(const work of this.#works.values()){if(work.retryTimer)clearTimeout(work.retryTimer);work.retryTimer=null;work.stopReason='shutdown';work.abort.abort();if(work.phase==='queued')this.#drop(work);}this.#pending=[];this.#closePromise=this.settled().then(()=>{this.#closed=true;this.#works.clear();});return this.#closePromise;}
}
