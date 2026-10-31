import {canonicalJson} from '../../../../packages/sync-core/src/index.ts';
import type {AiClient} from '../ai/client.ts';
import {aiFailure} from '../ai/errors.ts';
import {parseAiProvider} from '../ai/provider.ts';
import type {AiAccountScope,AiProviderConfig,AiUsage,AiFailure} from '../ai/types.ts';
import {reviewCore} from './core.ts';
import {ReviewError,REVIEW_LIMITS,validateReviewProject,validateReviewBlueprint,validateReviewPart,withReviewPart,type ReviewProject,type ReviewAttempt} from './model.ts';
import {prepareReviewRequest,reviewProjectIdentity,type ReviewRequest} from './requests.ts';
export interface ReviewPlan {id:string;projectId:string;revision:number;identity:string;provider:AiProviderConfig;requests:ReviewRequest[]}
export interface ReviewWriterSnapshot {busy:boolean;currentKey:string|null;completed:number;total:number;text:string;failure:AiFailure|null;problem:ReviewError['code']|null;pendingSave:boolean;storageFailure:boolean}
export interface ReviewWriterStore {get():ReviewProject|null;save(value:ReviewProject,expected:{id:string;revision:number},guard:()=>boolean):Promise<ReviewProject>}
export class ReviewWriter {
 private snapshot:ReviewWriterSnapshot={busy:false,currentKey:null,completed:0,total:0,text:'',failure:null,problem:null,pendingSave:false,storageFailure:false};
 private listeners=new Set<()=>void>();private ready:ReviewPlan|null=null;private abort:AbortController|null=null;private epoch=0;
 private pending:{value:ReviewProject;expected:{id:string;revision:number}}|null=null;
 constructor(private client:Pick<AiClient,'generateReview'>,private now:()=>string=()=>new Date().toISOString(),private id:()=>string=()=>crypto.randomUUID()){}
 getSnapshot=()=>this.snapshot;subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 private publish(patch:Partial<ReviewWriterSnapshot>){this.snapshot={...this.snapshot,...patch};for(const f of this.listeners)f();}
 invalidate=()=>{this.ready=null;};
 dispose=()=>{this.epoch++;this.ready=null;this.abort?.abort();this.abort=null;this.pending=null;this.publish({busy:false,currentKey:null,text:'',failure:null,problem:null,pendingSave:false,storageFailure:false});};
 cancel=()=>{this.ready=null;this.abort?.abort();};
 async prepare(project:ReviewProject,provider:AiProviderConfig,keys:(string|null)[]):Promise<ReviewPlan>{
  if(this.snapshot.busy||this.pending)throw new ReviewError('PENDING');this.ready=null;const token=this.epoch,p=validateReviewProject(project),config=parseAiProvider(provider,true);
  if(!keys.length||keys.length>41||new Set(keys).size!==keys.length||keys.includes(null)&&keys.length!==1)throw new ReviewError('INVALID');
  const requests:ReviewRequest[]=[];for(const key of keys)requests.push(await prepareReviewRequest(p,key));
  if(token!==this.epoch)throw new ReviewError('CHANGED');const plan={id:this.id(),projectId:p.id,revision:p.revision,identity:reviewProjectIdentity(p),provider:config,requests};this.ready=plan;return structuredClone(plan);
 }
 private currentPlan(plan:ReviewPlan){return this.ready&&canonicalJson(this.ready)===canonicalJson(plan);}
 async start(input:{plan:ReviewPlan;scope:AiAccountScope;store:ReviewWriterStore;current():boolean;revalidate(project:ReviewProject,signal:AbortSignal):Promise<void>}):Promise<void>{
  if(this.snapshot.busy||this.pending||!this.currentPlan(input.plan)||!input.current())return;
  const plan=structuredClone(this.ready!);this.ready=null;const abort=new AbortController(),token=++this.epoch;this.abort=abort;
  const owner=()=>token===this.epoch&&input.current();let project=input.store.get();
  const check=()=>{if(!owner()||!project||project.id!==plan.projectId||reviewProjectIdentity(project)!==plan.identity)throw new ReviewError('CHANGED');const saved=input.store.get();if(!saved||saved.id!==project.id||saved.revision!==project.revision||canonicalJson(saved)!==canonicalJson(project))throw new ReviewError('CHANGED');};
  this.publish({busy:true,currentKey:null,completed:0,total:plan.requests.length,text:'',failure:null,problem:null,pendingSave:false,storageFailure:false});
  try{
   check();if(project!.revision!==plan.revision)throw new ReviewError('CHANGED');await input.revalidate(project!,abort.signal);check();if(abort.signal.aborted)return;
   for(const request of plan.requests){
    check();if(abort.signal.aborted)break;
    const attempt:ReviewAttempt={id:this.id(),kind:request.kind,key:request.key,status:'uncertain',provider:{id:plan.provider.id,endpoint:plan.provider.endpoint,model:plan.provider.model},startedAt:this.now(),finishedAt:null,text:'',outputClipped:false,usage:null,failure:null};
    const expected={id:project!.id,revision:project!.revision},intent=validateReviewProject({...project,revision:project!.revision+1,updatedAt:this.now(),attempt});
    try{project=await input.store.save(intent,expected,owner);}catch(error){if(owner())this.publish({storageFailure:true});throw error;}check();if(abort.signal.aborted)break;
    this.publish({currentKey:request.key??'blueprint',text:''});let raw='',usage:AiUsage|null=null,next:ReviewProject;
    try{
     const result=await this.client.generateReview({accountScope:input.scope,config:plan.provider,request,requestId:attempt.id,signal:abort.signal,current:()=>{try{check();return!abort.signal.aborted;}catch{return false;}},
      onText:text=>{check();raw=text;this.publish({text});},onUsage:value=>{check();usage=value;}});
     check();raw=result.text;usage=result.usage??usage;
     if(result.finishReason==='length')throw new Error('OUTPUT_TRUNCATED');if(result.finishReason==='content_filter')throw new Error('CONTENT_FILTERED');
     let value:unknown;try{value=JSON.parse(raw);}catch{throw new ReviewError('INVALID');}
     const completed={...attempt,status:'complete' as const,finishedAt:this.now(),text:raw.slice(0,REVIEW_LIMITS.outputCharacters),outputClipped:raw.length>REVIEW_LIMITS.outputCharacters,usage};
     if(request.kind==='blueprint'){
      const blueprint=validateReviewBlueprint(value,project!.sources,project!.settings);next={...project!,...(project!.blueprint?{previousDraft:{blueprint:project!.blueprint,parts:project!.parts,attempt:project!.attempt}}:{}),blueprint,parts:reviewCore.emptyReviewGeneratedPartsForBlueprint(blueprint),attempt:completed};
     }else{
      const part=validateReviewPart(value,new Set(request.sourceIds),new Set(request.figureIds));next={...project!,parts:withReviewPart(project!,request.key!,part),attempt:completed};
     }
    }catch(error){
     if(!owner())return;let problem:ReviewError['code']|null=null,failure:AiFailure|null=null;
     if(error instanceof ReviewError)problem=error.code;else if(error instanceof Error&&['OUTPUT_TRUNCATED','CONTENT_FILTERED'].includes(error.message))failure={code:error.message as 'OUTPUT_TRUNCATED'|'CONTENT_FILTERED'};else failure=aiFailure(error);
     const status=abort.signal.aborted?'cancelled' as const:problem?'invalid' as const:'failed' as const;
     next={...project!,attempt:{...attempt,status,finishedAt:this.now(),text:raw.slice(0,REVIEW_LIMITS.outputCharacters),outputClipped:raw.length>REVIEW_LIMITS.outputCharacters,usage,failure}};
     this.publish({failure,problem});
    }
    check();next=validateReviewProject({...next,revision:project!.revision+1,updatedAt:this.now()});const expectedResult={id:project!.id,revision:project!.revision};
    try{project=await input.store.save(next,expectedResult,owner);}
    catch(error){if(!owner())return;this.pending={value:next,expected:expectedResult};this.publish({pendingSave:true,storageFailure:true});throw error;}
    if(next.attempt?.status!=='complete')break;
    this.publish({completed:this.snapshot.completed+1});
    if(request.kind==='blueprint')break; // Its new blueprint changes identity and requires a fresh writing preview.
   }
  }catch(error){if(owner())this.publish(this.snapshot.storageFailure?{failure:null,problem:null}:error instanceof ReviewError?{problem:error.code}:{failure:aiFailure(error)});}
  finally{if(token===this.epoch){this.abort=null;this.publish({busy:false,currentKey:null});}}
 }
 async retrySave(store:ReviewWriterStore,current:()=>boolean):Promise<void>{
  if(this.snapshot.busy||!this.pending||!current())return;const pending=this.pending,token=this.epoch;this.publish({busy:true,failure:null,problem:null,storageFailure:false});
  const guard=()=>token===this.epoch&&current();try{
   const saved=store.get();if(!saved)throw new ReviewError('CHANGED');
   if(canonicalJson(saved)!==canonicalJson(pending.value))await store.save(pending.value,pending.expected,guard);
   if(!guard())return;this.pending=null;this.publish({pendingSave:false,text:'',completed:this.snapshot.completed+(pending.value.attempt?.status==='complete'?1:0)});
  }catch(error){if(guard())this.publish(error instanceof ReviewError?{problem:error.code}:{storageFailure:true});}
  finally{if(token===this.epoch)this.publish({busy:false});}
 }
 pendingBackup():ReviewProject|null{return this.pending?structuredClone(this.pending.value):null;}
}
