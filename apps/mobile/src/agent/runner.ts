import {AiClient} from '../ai/client.ts';
import {AiError} from '../ai/errors.ts';
import type {AiAccountScope,AiFailure,AiProviderConfig,AiUsage} from '../ai/types.ts';
import {AgentError} from './proposals.ts';
import {validateAgentModelRequest,type AgentModelRequest} from './modelProtocol.ts';
import {finishAgentModelTurn,validateAgentConversation,type AgentConversation} from './conversation.ts';

export interface AgentConversationStore {
 get():AgentConversation|null;
 begin(request:AgentModelRequest,provider:AiProviderConfig,expected:{id:string;revision:number},guard:()=>boolean):Promise<AgentConversation>;
 save(next:AgentConversation,expected:{id:string;revision:number},guard:()=>boolean):Promise<AgentConversation>;
}
export interface AgentRunnerSnapshot {
 phase:'idle'|'saving-intent'|'requesting'|'saving-result';text:string;usage:AiUsage|null;
 candidate:AgentConversation|null;failure:AiFailure|{code:'SAVE_UNCONFIRMED'}|{code:'CHANGED'}|null;
}
interface Run {abort:AbortController;token:number;owner():boolean;modelCurrent():boolean;started:AgentConversation|null}
/** One explicit call, one model request. Persistence retry only saves the exact retained candidate. */
export class AgentModelRunner {
 #client:AiClient;#store:AgentConversationStore;#listeners=new Set<()=>void>();#token=0;#active:Run|null=null;#disposed=false;
 #snapshot:AgentRunnerSnapshot={phase:'idle',text:'',usage:null,candidate:null,failure:null};
 constructor(client:AiClient,store:AgentConversationStore){this.#client=client;this.#store=store;}
 activate(){if(!this.#disposed)return;this.#disposed=false;this.#token++;}
 subscribe=(listener:()=>void)=>{this.#listeners.add(listener);return()=>this.#listeners.delete(listener);};
 getSnapshot=()=>this.#snapshot;
 #publish(update:Partial<AgentRunnerSnapshot>){if(this.#disposed)return;this.#snapshot={...this.#snapshot,...update};for(const listener of this.#listeners)listener();}
 #owner(run:Run){return !this.#disposed&&this.#active===run&&this.#token===run.token&&run.owner();}
 async start(options:{request:AgentModelRequest;provider:AiProviderConfig;expected:{id:string;revision:number};scope:AiAccountScope;owner():boolean;modelCurrent():boolean}):Promise<void>{
  if(this.#disposed||this.#active||this.#snapshot.candidate)throw new AgentError('PENDING');const request=validateAgentModelRequest(options.request),run:Run={abort:new AbortController(),token:++this.#token,owner:options.owner,modelCurrent:options.modelCurrent,started:null};
  if(!run.owner()||!run.modelCurrent())throw new AgentError('CHANGED');this.#active=run;this.#publish({phase:'saving-intent',text:'',usage:null,candidate:null,failure:null});
  try{
   // Abort before an acknowledged intent means no request is sent, even if the store's reply was lost.
   run.started=await this.#store.begin(request,options.provider,options.expected,()=>this.#owner(run)&&!run.abort.signal.aborted&&run.modelCurrent());
   if(!this.#owner(run))return;const current=()=>this.#owner(run)&&!run.abort.signal.aborted&&run.modelCurrent()&&this.#store.get()?.id===run.started!.id&&this.#store.get()?.turns.at(-1)?.id===request.id&&this.#store.get()?.turns.at(-1)?.status==='uncertain';
   let text='',usage:AiUsage|null=null,failure:'transport'|'cancelled'|'invalid'|'limit'|null=null;
   try{
    if(!current())throw new AiError('CANCELLED');this.#publish({phase:'requesting'});
    const result=await this.#client.generateAgent({accountScope:options.scope,config:options.provider,request,requestId:request.id,signal:run.abort.signal,current,onText:value=>{text=value;if(this.#owner(run))this.#publish({text:value});},onUsage:value=>{usage=value;if(this.#owner(run))this.#publish({usage:value});}});text=result.text;usage=result.usage;if(result.finishReason==='length')throw new AiError('OUTPUT_TRUNCATED');if(result.finishReason==='content_filter')throw new AiError('CONTENT_FILTERED');
   }catch(error){failure=error instanceof AiError&&error.code==='CANCELLED'?'cancelled':error instanceof AgentError?'invalid':'transport';if(this.#owner(run))this.#publish({failure:error instanceof AiError?{code:error.code,...(error.retryAfterSeconds===undefined?{}:{retryAfterSeconds:error.retryAfterSeconds})}:{code:'CHANGED'}});}
   if(!this.#owner(run))return;const candidate=finishAgentModelTurn(run.started,request.id,{text,usage,failure});this.#publish({phase:'saving-result',candidate});
   try{await this.#store.save(candidate,{id:run.started.id,revision:run.started.revision},()=>this.#owner(run));if(this.#owner(run))this.#publish({candidate:null});}
   catch{if(this.#owner(run))this.#publish({failure:{code:'SAVE_UNCONFIRMED'}});}
  }catch{if(this.#owner(run))this.#publish({failure:{code:'SAVE_UNCONFIRMED'}});}
  finally{if(this.#active===run){this.#active=null;if(!this.#disposed)this.#publish({phase:'idle'});}}
 }
 stop(){this.#active?.abort.abort();}
 async retrySave(owner:()=>boolean):Promise<void>{
  if(this.#disposed||this.#active)throw new AgentError('PENDING');const candidate=this.#snapshot.candidate;if(!candidate||!owner())throw new AgentError('CHANGED');
  const run:Run={abort:new AbortController(),token:++this.#token,owner,modelCurrent:owner,started:null};this.#active=run;this.#publish({phase:'saving-result',failure:null});
  try{await this.#store.save(validateAgentConversation(candidate),{id:candidate.id,revision:candidate.revision-1},()=>this.#owner(run));if(this.#owner(run))this.#publish({candidate:null});}
  catch{if(this.#owner(run))this.#publish({failure:{code:'SAVE_UNCONFIRMED'}});}
  finally{if(this.#active===run){this.#active=null;if(!this.#disposed)this.#publish({phase:'idle'});}}
 }
 /** Explicitly discard an unsaved diagnostic candidate after the user has backed it up or decided to abandon it. */
 discardCandidate(){if(this.#active)throw new AgentError('PENDING');this.#publish({candidate:null,text:'',usage:null,failure:null});}
 dispose(){this.#disposed=true;this.#token++;this.#active?.abort.abort();this.#active=null;this.#snapshot={phase:'idle',text:'',usage:null,candidate:null,failure:null};this.#listeners.clear();}
}
