import { AgentError } from './guards.ts';
import { AgentMetadataClient, AgentMetadataSourceError } from './metadataClient.ts';
import { validateAgentMetadataRequest, type AgentMetadataRequest } from './metadataRequest.ts';
import { finishAgentMetadataQuery, validateAgentMetadataSession, type AgentMetadataSession } from './metadataSession.ts';
export interface AgentMetadataStore {
 get():AgentMetadataSession|null;
 begin(request:AgentMetadataRequest,expected:{id:string;revision:number},guard:()=>boolean):Promise<AgentMetadataSession>;
 save(next:AgentMetadataSession,expected:{id:string;revision:number},guard:()=>boolean):Promise<AgentMetadataSession>;
}
export interface AgentMetadataRunnerSnapshot {
 phase:'idle'|'saving-intent'|'requesting'|'saving-result';candidate:AgentMetadataSession|null;
 failure:{code:string;retryAt?:number|null}|null;
}
interface Run {abort:AbortController;token:number;owner():boolean;started:AgentMetadataSession|null}
/** Query recovery saves only a retained result; construction, reopening, or retrying persistence performs no HTTP. */
export class AgentMetadataRunner {
 #client:Pick<AgentMetadataClient,'lookup'>;#store:AgentMetadataStore;#listeners=new Set<()=>void>();#token=0;#active:Run|null=null;#disposed=false;
 #snapshot:AgentMetadataRunnerSnapshot={phase:'idle',candidate:null,failure:null};
 constructor(client:Pick<AgentMetadataClient,'lookup'>,store:AgentMetadataStore){this.#client=client;this.#store=store;}
 activate(){if(this.#disposed){this.#disposed=false;this.#token++;}}
 subscribe=(listener:()=>void)=>{this.#listeners.add(listener);return()=>this.#listeners.delete(listener);};
 getSnapshot=()=>this.#snapshot;
 #publish(update:Partial<AgentMetadataRunnerSnapshot>){if(this.#disposed)return;this.#snapshot={...this.#snapshot,...update};for(const l of this.#listeners)l();}
 #owner(run:Run){return !this.#disposed&&this.#active===run&&this.#token===run.token&&run.owner();}
 async start(options:{request:AgentMetadataRequest;expected:{id:string;revision:number};owner():boolean;sourceCurrent():boolean}):Promise<void>{
  if(this.#disposed||this.#active||this.#snapshot.candidate)throw new AgentError('PENDING');const request=validateAgentMetadataRequest(options.request),run:Run={abort:new AbortController(),token:++this.#token,owner:options.owner,started:null};if(!run.owner()||!options.sourceCurrent())throw new AgentError('CHANGED');this.#active=run;this.#publish({phase:'saving-intent',candidate:null,failure:null});
  try{
   run.started=await this.#store.begin(request,options.expected,()=>this.#owner(run)&&!run.abort.signal.aborted&&options.sourceCurrent());if(!this.#owner(run))return;
   const current=()=>this.#owner(run)&&this.#store.get()?.id===run.started!.id&&this.#store.get()?.records.at(-1)?.request.id===request.id&&this.#store.get()?.records.at(-1)?.status==='uncertain';
   let candidate:AgentMetadataSession;
   try{if(run.abort.signal.aborted||!current())throw new AgentMetadataSourceError('ABORTED');this.#publish({phase:'requesting'});const response=await this.#client.lookup(request,{signal:run.abort.signal,current,authorize:()=>current()&&options.sourceCurrent()});candidate=finishAgentMetadataQuery(run.started,request.id,{response});}
   catch(error){const failure=error instanceof AgentMetadataSourceError?error:new AgentMetadataSourceError('NETWORK_FAILED');if(!this.#owner(run))return;this.#publish({failure:{code:failure.code,retryAt:failure.retryAt}});candidate=finishAgentMetadataQuery(run.started,request.id,{failure:failure.code,retryAt:failure.retryAt});}
   if(!this.#owner(run))return;this.#publish({phase:'saving-result',candidate});
   try{await this.#store.save(candidate,{id:run.started.id,revision:run.started.revision},()=>this.#owner(run));if(this.#owner(run))this.#publish({candidate:null});}catch{if(this.#owner(run))this.#publish({failure:{code:'SAVE_UNCONFIRMED'}});}
  }catch{if(this.#owner(run))this.#publish({failure:{code:'SAVE_UNCONFIRMED'}});}
  finally{if(this.#active===run){this.#active=null;if(!this.#disposed)this.#publish({phase:'idle'});}}
 }
 stop(){this.#active?.abort.abort();}
 async retrySave(owner:()=>boolean):Promise<void>{
  if(this.#disposed||this.#active)throw new AgentError('PENDING');const candidate=this.#snapshot.candidate;if(!candidate||!owner())throw new AgentError('CHANGED');const run:Run={abort:new AbortController(),token:++this.#token,owner,started:null};this.#active=run;this.#publish({phase:'saving-result',failure:null});
  try{await this.#store.save(validateAgentMetadataSession(candidate),{id:candidate.id,revision:candidate.revision-1},()=>this.#owner(run));if(this.#owner(run))this.#publish({candidate:null});}catch{if(this.#owner(run))this.#publish({failure:{code:'SAVE_UNCONFIRMED'}});}finally{if(this.#active===run){this.#active=null;if(!this.#disposed)this.#publish({phase:'idle'});}}
 }
 discardCandidate(){if(this.#active)throw new AgentError('PENDING');this.#publish({candidate:null,failure:null});}
 dispose(){this.#disposed=true;this.#token++;this.#active?.abort.abort();this.#active=null;this.#snapshot={phase:'idle',candidate:null,failure:null};this.#listeners.clear();}
}
