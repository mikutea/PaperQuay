import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import * as core from '../packages/sync-core/src/modelInference.ts';
import {canonicalJson} from '../packages/sync-core/src/validation.ts';
const require=createRequire(import.meta.url),{createComputerModelWorker}=require('../electron/backend/computerModelWorker.cjs');
const clone=<T>(v:T):T=>structuredClone(v);
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
async function fixture(t:import('node:test').TestContext){
 const scope={service:'https://sync.fixture.test',accountId:randomUUID(),deviceId:randomUUID(),libraryId:randomUUID()},profile:core.ModelInferenceProfile={id:'chat-default',revision:1,digest:'a'.repeat(64),kind:'chat',model:'synthetic',maxInputBytes:192*1024,maxOutputTokens:2048,stream:false},snapshot={scope,profiles:[profile],generation:'b'.repeat(64)},rows=new Map<string,any>(),server=new Map<string,any>(),calls:string[]=[];
 let captureWait:Promise<void>|null=null;let modelCalls=0,claimCalls=0,completeCalls=0,intentMode:'ok'|'before'|'after'='ok',outputWriteFail=false,saveMode:'ok'|'before'|'after'|'rate'='ok',hold:ReturnType<typeof deferred<Response>>|null=null,claimLost=false,maxRecords=16,onHeartbeat:(()=>void)|null=null;
 const journal={list:async()=>clone([...rows.values()]),capacity:async()=>({retained:rows.size,maxRetained:maxRecords}),put:async(_s:any,row:any)=>{if(row.stage==='intent'&&intentMode==='before')throw Error('intent failure');if(row.stage==='outcome'&&outputWriteFail)throw Error('output disk failure');rows.set(row.id,clone(row));if(row.stage==='intent'&&intentMode==='after')throw Error('lost intent ack');return clone(row);}};
 const result=(id:string)=>{const r=server.get(id);return r?{id,status:'known' as const,job:clone(r.job),output:clone(r.output)}:{id,status:'absent' as const,job:null,output:null};};
 const api=async(_snapshot:any,input:any)=>{calls.push(input.path);if(input.path.endsWith('/provider'))return{provider:{deviceId:scope.deviceId,profiles:[profile],expiresAt:new Date(Date.now()+45000).toISOString()}};
 if(input.path.endsWith('/provider/claim')){claimCalls++;const row=[...server.values()].find(r=>r.job.state==='queued');if(!row)return{claim:null};row.job.state='running';row.job.leaseExpiresAt=new Date(Date.now()+60000).toISOString();row.lease={fence:randomUUID()};if(claimLost)throw Error('lost server claim acknowledgement');return{claim:{job:clone(row.job),request:clone(row.request),lease:row.lease}};}
 const id=input.path.split('/').at(-2)!,row=server.get(id);if(input.path.endsWith('/heartbeat')){onHeartbeat?.();return{job:clone(row.job)};}
 if(input.path.endsWith('/complete')){completeCalls++;if(saveMode==='rate')throw Object.assign(Error('RATE_LIMITED'),{code:'RATE_LIMITED'});if(saveMode==='before')throw Error('save failure');assert.deepEqual(input.body.lease,row.lease);const replayed=row.job.state==='complete';row.output=clone(input.body.output);row.job.state='complete';row.job.outputDigest=row.output.digest;row.job.outputBytes=Buffer.byteLength(canonicalJson(row.output));row.job.leaseExpiresAt=null;if(saveMode==='after')throw Error('lost save ack');return{result:result(id),replayed};}
 if(input.path.endsWith('/fail')){row.job.state=input.body.code==='OUTCOME_UNKNOWN'?'uncertain':'failed';row.job.failure=input.body.code;row.job.leaseExpiresAt=null;return{job:clone(row.job)};}throw Error('unexpected path');};
 const wire=()=>new Response(JSON.stringify({model:'synthetic-v1',choices:[{index:0,message:{role:'assistant',content:'Synthetic result synthetic-private-key'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
 const create=()=>createComputerModelWorker({core,journal,capture:async()=>{if(captureWait)await captureWait;return clone(snapshot);},check:async(s:any)=>assert.equal(s.scope.accountId,scope.accountId),getPrivate:async()=>({endpoint:'https://private.fixture.test/v1',model:'synthetic',apiKey:'synthetic-private-key',requiresKey:true,tokenParameter:'max_tokens',maxOutputTokens:2048}),api,fetch:async()=>{modelCalls++;return hold?hold.promise:wire();}});
 const worker=create();t.after(()=>worker.stop());
 const add=async()=>{const request=await core.prepareModelInferenceRequest({id:randomUUID(),target:{kind:'computer',deviceId:scope.deviceId},profileRef:{id:profile.id,revision:profile.revision,digest:profile.digest},model:profile.model,messages:[{role:'user',content:'Synthetic explicitly approved evidence'}],maxOutputTokens:1024}),at=new Date().toISOString();server.set(request.id,{request,lease:null,output:null,job:{id:request.id,state:'queued',target:request.target,profile,requesterDeviceId:randomUUID(),inputDigest:request.digest,inputBytes:Buffer.byteLength(canonicalJson(request)),outputBytes:0,outputDigest:null,createdAt:at,updatedAt:at,leaseExpiresAt:null,failure:null}});return request;};
 const request=await add();return{worker,create,scope,snapshot,profile,rows,server,calls,result,request,add,wire,counts:()=>({modelCalls,claimCalls,completeCalls}),setCaptureWait:(p:Promise<void>)=>{captureWait=p;},setIntent:(v:typeof intentMode)=>{intentMode=v;},setOutputFail:(v:boolean)=>{outputWriteFail=v;},setSave:(v:typeof saveMode)=>{saveMode=v;},setClaimLost:()=>{claimLost=true;},setCapacity:(v:number)=>{maxRecords=v;},hold:()=>{hold=deferred<Response>();return hold;},onHeartbeat:(f:()=>void)=>{onHeartbeat=f;}};
}
test('computer model worker is idle until explicit start and overlapping polls execute one claimed model call',async t=>{
 const f=await fixture(t);assert.deepEqual(f.counts(),{modelCalls:0,claimCalls:0,completeCalls:0});await f.worker.start({manual:true});await Promise.all([f.worker.runOnce(),f.worker.runOnce(),f.worker.runOnce()]);assert.deepEqual(f.counts(),{modelCalls:1,claimCalls:1,completeCalls:1});assert.equal(f.result(f.request.id).job!.state,'complete');assert.equal(f.rows.get(f.request.id).stage,'acknowledged');assert(!JSON.stringify(f.rows.get(f.request.id)).includes('synthetic-private-key'));assert.equal(f.rows.get(f.request.id).outcome.output.redacted,true);
});
test('a failed or lost local intent acknowledgement makes zero upstream calls and never replays after reopening',async t=>{
 for(const mode of ['before','after']as const){const f=await fixture(t);f.setIntent(mode);await f.worker.start({manual:true});await f.worker.runOnce();assert.equal(f.counts().modelCalls,0);assert.equal(f.result(f.request.id).job!.state,'running');await f.worker.stop();const reopened=f.create();t.after(()=>reopened.stop());f.setIntent('ok');await reopened.start({manual:true});await reopened.runOnce();assert.equal(f.counts().modelCalls,0);if(mode==='after'){await reopened.retrySave(f.request.id);assert.equal(f.result(f.request.id).job!.state,'uncertain');assert.equal(f.counts().modelCalls,0);}}
});
test('server claim acknowledgement loss never calls upstream or automatically reclaims a running request',async t=>{
 const f=await fixture(t);f.setClaimLost();await f.worker.start({manual:true});await assert.rejects(f.worker.runOnce());assert.equal(f.counts().modelCalls,0);assert.equal(f.result(f.request.id).job!.state,'running');assert.equal(f.worker.snapshot().running,false);
});
test('received output remains available when local persistence fails; explicit recovery only saves',async t=>{
 const f=await fixture(t);f.setOutputFail(true);await f.worker.start({manual:true});await f.worker.runOnce();assert.equal(f.counts().modelCalls,1);assert.equal(f.worker.snapshot().errorCode,'MODEL_SAVE_UNCONFIRMED');assert.equal((await f.worker.records(f.scope))[0].outcome.output.text.includes('Synthetic result'),true);
 await f.worker.runOnce();assert.equal(f.counts().modelCalls,1);f.setOutputFail(false);await f.worker.retrySave(f.request.id);assert.equal(f.counts().modelCalls,1);assert.equal(f.result(f.request.id).job!.state,'complete');
});
test('service save failure survives worker restart and keeps the exact output and fence without model execution',async t=>{
 const f=await fixture(t);f.setSave('before');await f.worker.start({manual:true});await f.worker.runOnce();const received=clone(f.rows.get(f.request.id));assert.equal(received.stage,'outcome');await f.worker.stop();f.setSave('ok');const reopened=f.create();t.after(()=>reopened.stop());await reopened.start({manual:true});await reopened.runOnce();assert.equal(f.counts().modelCalls,1);await reopened.retrySave(f.request.id);assert.equal(f.counts().modelCalls,1);assert.equal(f.rows.get(f.request.id).outcome.output.digest,received.outcome.output.digest);assert.equal(f.rows.get(f.request.id).claim.lease.fence,received.claim.lease.fence);
});
test('lost service completion acknowledgement safely resends only the retained exact result',async t=>{
 const f=await fixture(t);f.setSave('after');await f.worker.start({manual:true});await f.worker.runOnce();assert.equal(f.result(f.request.id).job!.state,'complete');f.setSave('ok');await f.worker.retrySave(f.request.id);assert.deepEqual(f.counts(),{modelCalls:1,claimCalls:1,completeCalls:2});
});
test('journal capacity and changed credential generation prevent any new upstream charge',async t=>{
 const full=await fixture(t);full.setCapacity(0);await full.worker.start({manual:true});await assert.rejects(full.worker.runOnce(),{code:'MODEL_LOCAL_CAPACITY'});assert.equal(full.counts().claimCalls,0);assert.equal(full.counts().modelCalls,0);
 const changed=await fixture(t);await changed.worker.start({manual:true});changed.snapshot.generation='c'.repeat(64);await assert.rejects(changed.worker.runOnce(),{code:'MODEL_BINDING_CHANGED'});assert.equal(changed.counts().modelCalls,0);
});
test('owner retirement during an issued request never applies output to another account or runs a second model',async t=>{
 const f=await fixture(t),hold=f.hold();await f.worker.start({manual:true});const pending=f.worker.runOnce();for(let i=0;i<300&&f.counts().modelCalls===0;i++)await new Promise(r=>setTimeout(r,2));assert.equal(f.counts().modelCalls,1);const stopping=f.worker.stop();await pending;await stopping;hold.resolve(f.wire());assert.equal(f.result(f.request.id).job!.state,'running');assert.equal(f.rows.get(f.request.id).stage,'outcome');assert.equal(f.rows.get(f.request.id).outcome.failure,'OUTCOME_UNKNOWN');assert.equal(f.counts().completeCalls,0);
});

test('stop waits for pending startup capture and a late reply cannot publish or restart the worker',async t=>{
 const f=await fixture(t),late=deferred<void>();f.setCaptureWait(late.promise);const started=f.worker.start({manual:true});const stopped=f.worker.stop();late.resolve();
 await assert.rejects(started,{code:'DESKTOP_OPERATION_CANCELLED'});await stopped;assert.equal(f.worker.snapshot().running,false);assert.equal(f.calls.length,0);assert.equal(f.counts().modelCalls,0);
});

test('throttled result persistence retains the exact output and never repeats model execution',async t=>{
 const f=await fixture(t);f.setSave('rate');await f.worker.start({manual:true});await f.worker.runOnce();
 assert.equal(f.worker.snapshot().running,true);assert.equal(f.worker.snapshot().errorCode,'MODEL_SAVE_UNCONFIRMED');
 const before=await f.worker.records(f.scope);await f.worker.runOnce();assert.equal(f.counts().modelCalls,1);assert.equal(f.counts().claimCalls,1);
 assert.deepEqual(await f.worker.records(f.scope),before);f.setSave('ok');await f.worker.retrySave(f.request.id);
 assert.equal(f.counts().modelCalls,1);assert.equal(f.result(f.request.id).job!.state,'complete');assert.equal(f.rows.get(f.request.id).stage,'acknowledged');
});
