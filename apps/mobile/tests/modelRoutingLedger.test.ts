import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {ModelInvocationApi} from '../src/modelRouting/api.ts';
import {MobileModelRouter} from '../src/modelRouting/router.ts';
import {createModelRouteProvider} from '../src/modelRouting/config.ts';
import {emptyModelLedger,beginModelRecord,checkedModelStatus,observeModelRecord,readModelLedger,verifyModelLedger,releaseModelRecord,compactModelRecord,MODEL_LEDGER_LIMITS} from '../src/modelRouting/ledger.ts';
import type {ModelInvocationLedger,ModelLedgerOwner} from '../src/modelRouting/ledger.ts';
import {prepareModelInferenceRequest,prepareModelInferenceOutput} from '../../../packages/sync-core/src/modelInference.ts';
import type {ModelInferenceRequest,ModelInferenceStatus,ModelInferenceJob} from '../../../packages/sync-core/src/modelInference.ts';
import {canonicalJson} from '../../../packages/sync-core/src/validation.ts';
const profile={id:'chat-default',revision:1,digest:'a'.repeat(64),kind:'chat' as const,model:'synthetic',maxInputBytes:192*1024,maxOutputTokens:2048,stream:false as const};
const signal=()=>new AbortController().signal;
function owner(){
 let ledger=emptyModelLedger(),live=true,fail:'none'|'before'|'after'='none';const abort=new AbortController();
 const result:ModelLedgerOwner={signal:abort.signal,current:()=>live&&!abort.signal.aborted,read:()=>structuredClone(ledger),refresh:async()=>structuredClone(ledger),update:async reducer=>{if(!live||abort.signal.aborted)throw Error('retired');if(fail==='before'){fail='none';throw Error('Disk unavailable');}const next=readModelLedger(reducer(structuredClone(ledger)));ledger=next;if(fail==='after'){fail='none';throw Error('Acknowledgement lost');}return structuredClone(ledger);}};
 return{result,get:()=>structuredClone(ledger),set:(v:ModelInvocationLedger)=>{ledger=v;},fail:(value:typeof fail)=>{fail=value;},retire:()=>{live=false;abort.abort();}};
}
async function status(request:ModelInferenceRequest,state:'complete'|'queued'|'running'|'uncertain'|'failed'='complete'):Promise<ModelInferenceStatus>{
 const output=state==='complete'?await prepareModelInferenceOutput({text:'Synthetic result',usage:{promptTokens:5,completionTokens:4,totalTokens:9},reportedModel:'synthetic-alias',finishReason:'stop',redacted:false}):null,at=new Date().toISOString();
 const job:ModelInferenceJob={id:request.id,state,target:request.target,profile,requesterDeviceId:randomUUID(),inputDigest:request.digest,inputBytes:Buffer.byteLength(canonicalJson(request)),outputBytes:output?Buffer.byteLength(canonicalJson(output)):0,outputDigest:output?.digest??null,createdAt:at,updatedAt:at,leaseExpiresAt:state==='running'?new Date(Date.now()+60000).toISOString():null,failure:state==='failed'?'UPSTREAM_UNAVAILABLE':null};
 return{id:request.id,status:'known',job,output};
}
async function fixture(){
 const scope={apiBaseUrl:'https://sync.fixture.test',accountId:randomUUID()},storage=owner(),config=await createModelRouteProvider(scope,{kind:'gateway'},profile),calls:{path:string;method:string}[]=[],jobs=new Map<string,ModelInferenceStatus>();
 let mode:'complete'|'queued'|'lost-create'='complete',changed=false,clock=Date.now(),computerExpiry:number|null=null,beforeCreate:()=>void=()=>{},blockedStatus:Promise<unknown>|null=null;
 const api=new ModelInvocationApi(async(path,_signal,method='GET',data)=>{
  calls.push({path,method});const tail=path.slice('/v1/model-inference'.length);
  if(tail==='/availability')return{checkedAt:new Date(clock).toISOString(),validUntil:new Date(clock+45000).toISOString(),gateway:changed?{...profile,digest:'b'.repeat(64)}:profile,computers:computerExpiry===null?[]:[{deviceId:'99999999-9999-4999-8999-999999999999',profiles:[profile],expiresAt:new Date(computerExpiry).toISOString()}]};
  if(tail==='/jobs'&&method==='POST'){beforeCreate();const request=data as ModelInferenceRequest,s=await status(request,mode==='queued'?'queued':'complete');jobs.set(request.id,s);if(mode==='lost-create')throw Error('Lost response');return{result:s,replayed:false,quota:{active:0,queued:0,retained:1,receipts:1,bytes:2000,maxActive:1,maxQueued:4,maxRetained:50,maxReceipts:2000,maxBytes:16*1024*1024}};}
  const id=tail.split('/')[2];if(tail.startsWith('/requests/')&&method==='GET'){if(blockedStatus)return blockedStatus;return jobs.get(id)??{id,status:'absent',job:null,output:null};}
  if(tail.endsWith('/cancel'))return{id,status:'cancelled',job:null,output:null};
  if(tail.endsWith('/dispatch')||tail.endsWith('/recover'))return{id,phase:'none',hasOutput:false};
  throw Error('Unexpected route '+tail);
 },()=>({}as any));
 const router=new MobileModelRouter({api,owner:storage.result,scope,polls:1,pause:async()=>{}}),input={accountScope:scope,config,requestId:randomUUID(),purpose:'pdf' as const,messages:[{role:'user',content:'Explicit evidence'}],signal:signal()};
 return{scope,storage,config,calls,jobs,router,input,mode:(v:typeof mode)=>{mode=v;},change:()=>{changed=true;},clock:(n:number)=>{clock=n;},computerExpiry:(n:number)=>{computerExpiry=n;},beforeCreate:(f:()=>void)=>{beforeCreate=f;},blockStatus:(v:Promise<unknown>)=>{blockedStatus=v;}};
}
const creates=(f:Awaited<ReturnType<typeof fixture>>)=>f.calls.filter(c=>c.path.endsWith('/jobs')&&c.method==='POST').length;

test('constructor is idle; one explicit invocation persists its exact intent before POST and full output before returning',async()=>{
 const f=await fixture();assert.equal(f.calls.length,0);f.beforeCreate(()=>{const r=f.storage.get().records[0];assert.equal(r.phase,'intent');assert.equal(r.request.id,f.input.requestId);assert.equal(r.output,null);});
 const output=await f.router.invoke(f.input);assert.equal(output.text,'Synthetic result');assert.equal(creates(f),1);const ledger=await verifyModelLedger(f.storage.get());assert.equal(ledger.records[0].output?.digest,output.digest);assert.equal(ledger.records[0].phase,'complete');assert.equal(ledger.receipts[0].outcome,'complete');assert.deepEqual(output.usage,{promptTokens:5,completionTokens:4,totalTokens:9});
});
test('failure or loss of local intent acknowledgement sends zero create requests; reopen only reads the original ID',async()=>{
 for(const failure of ['before','after'] as const){const f=await fixture();f.storage.fail(failure);await assert.rejects(f.router.invoke(f.input),{code:'REMOTE_UNCONFIRMED'});assert.equal(creates(f),0);if(failure==='after'){assert.equal(f.storage.get().records[0].phase,'intent');await assert.rejects(f.router.invoke(f.input),{code:'REMOTE_UNCONFIRMED'});assert.equal(creates(f),0);assert.equal(f.calls.at(-1)?.method,'GET');}}
});
test('lost service create ACK retains the original ID and explicit retry consumes the known result without another create',async()=>{
 const f=await fixture();f.mode('lost-create');await assert.rejects(f.router.invoke(f.input),{code:'REMOTE_UNCONFIRMED'});assert.equal(creates(f),1);assert.equal(f.storage.get().records[0].phase,'uncertain');assert.equal((await f.router.invoke(f.input)).text,'Synthetic result');assert.equal(creates(f),1);assert(!f.calls.some(c=>c.path.endsWith('/dispatch')));
});
test('received result with failed local commit is retained in root memory; retry is save-only and backup preserves it',async()=>{
 const f=await fixture();f.beforeCreate(()=>f.storage.fail('before'));await assert.rejects(f.router.invoke(f.input),{code:'REMOTE_UNCONFIRMED'});assert.deepEqual(f.router.getSnapshot().pendingIds,[f.input.requestId]);assert.equal(f.storage.get().records[0].output,null);
 const backup=await f.router.backup(f.input.requestId);assert.equal(backup.pendingSave?.status.output?.text,'Synthetic result');assert.equal(backup.unconfirmedSave,true);const count=f.calls.length;await f.router.retryLocalSave(f.input.requestId);assert.equal(f.calls.length,count);assert.equal(f.storage.get().records[0].output?.text,'Synthetic result');assert.equal(f.router.getSnapshot().pendingIds.length,0);
});
test('compacted identity receipt prevents any repeated paid call while changed input under an old ID is rejected',async()=>{
 const f=await fixture();await f.router.invoke(f.input);await assert.rejects(f.router.invoke({...f.input,messages:[{role:'user',content:'Changed input'}]}),{code:'REMOTE_PROFILE_CHANGED'});await f.router.compact(f.input.requestId);assert.equal(f.storage.get().records.length,0);assert.equal(f.storage.get().receipts.length,1);await assert.rejects(f.router.invoke(f.input),{code:'REMOTE_UNCONFIRMED'});assert.equal(creates(f),1);
});
test('unknown outcome blocks a different paid request until explicit release, retaining the original request and receipt',async()=>{
 const f=await fixture();f.mode('lost-create');await assert.rejects(f.router.invoke(f.input));const other={...f.input,requestId:randomUUID()};await assert.rejects(f.router.invoke(other),{code:'REMOTE_UNCONFIRMED'});assert.equal(creates(f),1);await f.router.release(f.input.requestId);f.mode('complete');await f.router.invoke(other);assert.equal(creates(f),2);assert.equal(f.storage.get().records.length,2);assert.equal(f.storage.get().receipts.length,2);assert.equal(f.storage.get().records[0].released,true);
});
test('four full results reserve capacity before billing, compaction frees full content and preserves anti-replay receipts',async()=>{
 const f=await fixture();for(let i=0;i<4;i++)await f.router.invoke({...f.input,requestId:i?randomUUID():f.input.requestId});await assert.rejects(f.router.invoke({...f.input,requestId:randomUUID()}),{code:'REMOTE_CAPACITY'});assert.equal(creates(f),4);await f.router.compact(f.input.requestId);await f.router.invoke({...f.input,requestId:randomUUID()});assert.equal(creates(f),5);assert.equal(f.storage.get().records.length,4);assert.equal(f.storage.get().receipts.length,5);
});
test('availability cannot substitute profile, target or stale/future presence; inspection never creates a job',async()=>{
 const f=await fixture();assert.deepEqual(await f.router.inspect(f.input),['synthetic']);assert.equal(creates(f),0);f.change();await assert.rejects(f.router.invoke(f.input),{code:'REMOTE_PROFILE_CHANGED'});assert.equal(f.storage.get().receipts.length,0);assert.equal(creates(f),0);
 for(const delta of [-60000,60000]){const other=await fixture();other.clock(Date.now()+delta);await assert.rejects(other.router.invoke(other.input),{code:'REMOTE_UNAVAILABLE'});assert.equal(creates(other),0);}
});
test('a changed business source after response can retain root-owned output without returning it to the retired caller',async()=>{
 const f=await fixture();let current=true;f.beforeCreate(()=>{current=false;});await assert.rejects(f.router.invoke({...f.input,current:()=>current}),{code:'CANCELLED'});assert.equal(f.storage.get().records[0].output?.text,'Synthetic result');assert.equal(creates(f),1);
});
test('retired root prevents late result persistence and A-B-A cannot revive the captured owner',async()=>{
 const f=await fixture();f.beforeCreate(()=>f.storage.retire());await assert.rejects(f.router.invoke(f.input),{code:'REMOTE_AUTH_REQUIRED'});assert.equal(f.storage.get().records[0].output,null);assert.equal(f.router.current(),false);await assert.rejects(f.router.backup(f.input.requestId),{code:'REMOTE_AUTH_REQUIRED'});assert.equal(creates(f),1);
});
test('queued invocation and later reopen poll GET only; explicit cancel reserves the original ID without new model execution',async()=>{
 const f=await fixture();f.mode('queued');await assert.rejects(f.router.invoke(f.input),{code:'REMOTE_PENDING'});assert.equal(creates(f),1);await assert.rejects(f.router.invoke(f.input),{code:'REMOTE_PENDING'});assert.equal(creates(f),1);assert(!f.calls.some(c=>c.path.endsWith('/dispatch')));await f.router.cancel(f.input.requestId,signal());assert.equal(f.storage.get().records[0].phase,'cancelled');assert.equal(creates(f),1);
});
test('full original binding rejects self-consistent statuses for another target/profile/model or input digest',async()=>{
 const f=await fixture(),r=await prepareModelInferenceRequest({id:f.input.requestId,target:f.config.execution!.target,profileRef:f.config.execution!.profileRef,model:f.config.model,messages:f.input.messages as any,maxOutputTokens:2048}),s=await status(r);
 for(const edit of [(j:any)=>j.target={kind:'computer',deviceId:randomUUID()},(j:any)=>j.profile.digest='b'.repeat(64),(j:any)=>j.profile.model='different',(j:any)=>j.inputDigest='c'.repeat(64)]){const changed=structuredClone(s);edit(changed.job);await assert.rejects(checkedModelStatus(r,changed));}
});
test('synchronous ledger decoder enforces closed shape but asynchronous verification detects stored SHA tampering and never bills',async()=>{
 const f=await fixture();await f.router.invoke(f.input);const corrupt=f.storage.get();corrupt.records[0].output!.text='Tampered';assert.equal(readModelLedger(corrupt).records[0].output!.text,'Tampered');await assert.rejects(verifyModelLedger(corrupt));f.storage.set(corrupt);const count=f.calls.length;await assert.rejects(f.router.invoke({...f.input,requestId:randomUUID()}),{code:'REMOTE_UNCONFIRMED'});assert.equal(f.calls.length,count);
 for(const edit of [(l:any)=>l.apiKey='never',(l:any)=>l.records[0].request.endpoint='never',(l:any)=>l.receipts.push(l.receipts[0]),(l:any)=>l.records[0].output.usage={promptTokens:2,completionTokens:2,totalTokens:5}]){const value=f.storage.get();edit(value);assert.throws(()=>readModelLedger(value));}
});
test('stored complete result survives later absent/removed service observations; local result content is never silently pruned',async()=>{
 const f=await fixture();await f.router.invoke(f.input);f.jobs.delete(f.input.requestId);const r=await f.router.refresh(f.input.requestId,signal());assert.equal(r.output?.text,'Synthetic result');assert.equal(r.phase,'complete');assert.equal(f.storage.get().receipts[0].outcome,'complete');
});
test('pending status wait is bounded by original abort, with no replay or dispatch after cancellation',async()=>{
 const f=await fixture();f.mode('queued');await assert.rejects(f.router.invoke(f.input));f.blockStatus(new Promise(()=>{}));const abort=new AbortController(),pending=f.router.invoke({...f.input,signal:abort.signal});setTimeout(()=>abort.abort(),15);await assert.rejects(pending,{code:'CANCELLED'});assert.equal(creates(f),1);assert(!f.calls.some(c=>c.path.endsWith('/dispatch')));
});

test('a weaker service query cannot discard a known memory-only result after local save failure',async()=>{
 const f=await fixture();f.beforeCreate(()=>f.storage.fail('before'));await assert.rejects(f.router.invoke(f.input));f.jobs.delete(f.input.requestId);await f.router.refresh(f.input.requestId,signal());assert.equal(f.storage.get().records[0].output?.text,'Synthetic result');assert.equal(f.router.getSnapshot().pendingIds.length,0);assert.equal(creates(f),1);
});
test('a saved route copied from another account fails its deterministic identity check before account HTTP',async()=>{
 const f=await fixture(),foreign=await createModelRouteProvider({...f.scope,accountId:randomUUID()},{kind:'gateway'},profile);await assert.rejects(f.router.invoke({...f.input,config:foreign}),{code:'CONFIG_INVALID'});assert.equal(f.calls.length,0);
});
test('conflicting complete observations never replace retained output or become a recovery candidate',async()=>{
 const f=await fixture();await f.router.invoke(f.input);const previous=f.jobs.get(f.input.requestId)!,output=await prepareModelInferenceOutput({text:'Conflicting output',usage:null,reportedModel:null,finishReason:'stop',redacted:false});f.jobs.set(f.input.requestId,{...previous,job:{...previous.job!,outputDigest:output.digest,outputBytes:Buffer.byteLength(canonicalJson(output))},output});
 await assert.rejects(f.router.refresh(f.input.requestId,signal()),{code:'INVALID_RESPONSE'});assert.equal(f.storage.get().records[0].output?.text,'Synthetic result');assert.equal(f.router.getSnapshot().pendingIds.length,0);
});
test('an explicit queued gateway dispatch uses the original job only, while concurrent dispatch and generation are excluded',async()=>{
 const f=await fixture();f.mode('queued');await assert.rejects(f.router.invoke(f.input));const count=creates(f);let release!:(value:unknown)=>void;f.blockStatus(new Promise(resolve=>{release=resolve;}));const pending=f.router.dispatchQueued(f.input.requestId,signal());await assert.rejects(f.router.dispatchQueued(f.input.requestId,signal()),{code:'REMOTE_PENDING'});await assert.rejects(f.router.invoke({...f.input,requestId:randomUUID()}),{code:'REMOTE_PENDING'});release(f.jobs.get(f.input.requestId));await pending;assert.equal(f.calls.filter(c=>c.path.endsWith('/dispatch')).length,1);assert.equal(creates(f),count);
});

test('a future computer expiry cannot extend presence beyond the independently observed availability window',async()=>{
 const f=await fixture();f.computerExpiry(Date.now()+3600000);await assert.rejects(f.router.inventory(signal()),{code:'REMOTE_UNAVAILABLE'});await assert.rejects(f.router.invoke(f.input),{code:'REMOTE_UNAVAILABLE'});assert.equal(creates(f),0);assert.equal(f.storage.get().receipts.length,0);
});
