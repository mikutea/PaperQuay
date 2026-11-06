const {createHash}=require('node:crypto');
const {normalizeRemoteScope}=require('./remoteTaskJournal.cjs');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const sha=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>structuredClone(value);
const publicCode=error=>typeof error?.code==='string'&&/^(?:MODEL_[A-Z_]{1,64}|PROFILE_CHANGED|CANCELLED|OUTCOME_UNKNOWN|AUTHENTICATION_REQUIRED|SESSION_REVOKED|DESKTOP_OPERATION_CANCELLED|RATE_LIMITED)$/.test(error.code)?error.code:'MODEL_EXECUTION_FAILED';
const throttled=error=>error?.code==='RATE_LIMITED'||error?.statusCode===429||error?.status===429;
function createComputerModelWorker(options){
 // Model and parse/index providers share one account budget. A ten-second
 // idle poll leaves room for both supported groups and reading checkpoints.
 const core=options.core||require('../generated/desktopSyncCore.cjs'),timings={pollMs:10000,presenceMs:15000,heartbeatMs:10000,guardMs:1000,...options.timings};
 if(!['capture','check','getPrivate','api'].every(k=>typeof options[k]==='function')||!options.journal||Object.values(timings).some(v=>!Number.isSafeInteger(v)||v<1||v>15000))fail('MODEL_CONFIGURATION_INVALID');
 let runtime=null,startIntent=0,errorCode=null,tail=Promise.resolve(),pollTask=null,adapterPromise=null;
 const candidates=new Map(),operations=new Set();
 const key=(scope,id)=>sha(JSON.stringify([scope.service,scope.accountId,scope.libraryId,scope.deviceId,id]));
 const adapter=()=>adapterPromise||=options.adapter?Promise.resolve(options.adapter):import('../../packages/model-inference/index.mjs').then(m=>m.createModelInferenceAdapter({fetch:options.fetch,validateRequest:core.validateModelInferenceRequest,prepareOutput:core.prepareModelInferenceOutput,parseJson:core.parseModelInferenceJson}));
 const notify=()=>{try{options.onState?.(snapshot());}catch{}};
 function snapshot(){return{running:!!runtime&&!runtime.abort.signal.aborted,busy:!!runtime?.active,errorCode,unconfirmed:candidates.size};}
 async function capture(){const value=await options.capture();const scope=normalizeRemoteScope(value.scope),profiles=core.validateModelInferenceProfiles(value.profiles);if(!profiles.length||typeof value.generation!=='string'||!/^[0-9a-f]{64}$/.test(value.generation))fail('MODEL_CONFIGURATION_INVALID');return{scope,profiles,generation:value.generation};}
 async function binding(run){if(runtime!==run||run.abort.signal.aborted)fail('DESKTOP_OPERATION_CANCELLED');await options.check(run.snapshot);const current=await capture();if(JSON.stringify(current)!==JSON.stringify(run.snapshot))fail('MODEL_BINDING_CHANGED');if(runtime!==run||run.abort.signal.aborted)fail('DESKTOP_OPERATION_CANCELLED');}
 function pauseForRateLimit(run,error){
  if(!throttled(error))return false;
  if(runtime!==run||run.abort.signal.aborted)return true;
  const now=Date.now();
  if(run.resumeAt<=now)run.backoffMs=Math.min(300000,Math.max(60000,run.backoffMs*2));
  run.resumeAt=Math.max(run.resumeAt,now+run.backoffMs);run.presenceRequired=true;errorCode='RATE_LIMITED';notify();return true;
 }
 async function call(run,method,path,body,signal=run.abort.signal){
  try{return await options.api(run.snapshot,{method,path:'/v1/model-inference'+path,...(body===undefined?{}:{body}),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});}
  catch(error){pauseForRateLimit(run,error);throw error;}
 }
 async function advertise(run){
  if(run.presenceTask)return run.presenceTask;
  const task=(async()=>{await binding(run);await call(run,'PUT','/provider',{profiles:run.snapshot.profiles});await binding(run);run.presenceRequired=false;})();
  run.presenceTask=task;try{return await task;}finally{if(run.presenceTask===task)run.presenceTask=null;}
 }
 function track(task){operations.add(task);task.finally(()=>operations.delete(task)).catch(()=>{});return task;}
 function stopNow(run,error){if(run.abort.signal.aborted)return;errorCode=publicCode(error);run.abort.abort();for(const timer of run.timers)clearInterval(timer);run.timers.clear();notify();}
 function periodic(run,ms,work,network=false){let busy=false;const timer=setInterval(()=>{if(busy||run.abort.signal.aborted||network&&Date.now()<run.resumeAt)return;busy=true;track(Promise.resolve().then(work).catch(e=>{if(!pauseForRateLimit(run,e))stopNow(run,e);}).finally(()=>{busy=false;}));},ms);timer.unref?.();run.timers.add(timer);}
 async function persist(run,row){
  await binding(run);const result=row.outcome.output?await call(run,'POST','/jobs/'+row.id+'/complete',{lease:row.claim.lease,output:row.outcome.output}):await call(run,'POST','/jobs/'+row.id+'/fail',{lease:row.claim.lease,code:row.outcome.failure});
  await binding(run);const status=row.outcome.output?await core.validateModelInferenceStatus(result?.result):null;
  if(row.outcome.output&&!(status.id===row.id&&(status.output?.digest===row.outcome.output.digest||status.job?.state==='cancelled')))fail('MODEL_RESPONSE_INVALID');
  if(!row.outcome.output){const job=core.validateModelInferenceJob(result?.job);if(job.id!==row.id||!['failed','uncertain','cancelled'].includes(job.state))fail('MODEL_RESPONSE_INVALID');}
  const acknowledged={...row,stage:'acknowledged'};await options.journal.put(run.snapshot.scope,acknowledged);candidates.delete(key(run.snapshot.scope,row.id));errorCode=null;notify();return{saved:true};
 }
 async function execute(run){
  await binding(run);const pending=(await options.journal.list(run.snapshot.scope)).filter(r=>r.deviceId===run.snapshot.scope.deviceId&&r.stage!=='acknowledged');
  if(pending.length||[...candidates.keys()].some(k=>k===key(run.snapshot.scope,candidates.get(k).row.id))){errorCode='MODEL_SAVE_UNCONFIRMED';notify();return{worked:false};}
  const capacity=await options.journal.capacity(run.snapshot.scope);if(capacity.retained>=capacity.maxRetained)fail('MODEL_LOCAL_CAPACITY');
  const response=await call(run,'POST','/provider/claim',{});await binding(run);
  core.inspectModelInferenceJson(response,core.MODEL_INFERENCE_LIMITS.requestBytes+16384);if(!response||Object.keys(response).length!==1||!Object.hasOwn(response,'claim'))fail('MODEL_RESPONSE_INVALID');
  run.backoffMs=0;run.resumeAt=0;if(errorCode==='RATE_LIMITED'){errorCode=null;notify();}if(response.claim===null)return{worked:false};
  const claim=await core.validateModelInferenceClaim(response.claim);if(claim.request.target.kind!=='computer'||claim.request.target.deviceId!==run.snapshot.scope.deviceId||!run.snapshot.profiles.some(p=>JSON.stringify(p)===JSON.stringify(claim.job.profile)))fail('MODEL_RESPONSE_INVALID');
  const work={phase:'intent',row:{id:claim.request.id,deviceId:run.snapshot.scope.deviceId,claim,stage:'intent',outcome:null,createdAt:new Date().toISOString()},abort:new AbortController()};run.active=work;notify();
  let heartbeat=null,hbBusy=false;
  const signal=AbortSignal.any([run.abort.signal,work.abort.signal]);
  const current=()=>runtime===run&&!run.abort.signal.aborted&&!work.abort.signal.aborted&&run.active===work&&work.phase==='requesting';
  const pulse=async()=>{if(hbBusy||!current())return;hbBusy=true;try{await binding(run);const result=await call(run,'POST','/jobs/'+claim.request.id+'/heartbeat',claim.lease,signal),job=core.validateModelInferenceJob(result?.job);if(!current())return;if(job.id!==claim.request.id||job.inputDigest!==claim.request.digest||job.state!=='running')work.abort.abort();}catch{if(current())work.abort.abort();}finally{hbBusy=false;}};
  try{
   // A failed or lost local intent acknowledgement is never followed by a paid HTTP call.
   await options.journal.put(run.snapshot.scope,work.row);await binding(run);
   const config=await options.getPrivate(claim.job.profile,run.snapshot);await binding(run);
   work.phase='requesting';heartbeat=setInterval(()=>track(pulse()),timings.heartbeatMs);heartbeat.unref?.();
   try{const output=await(await adapter()).execute({request:claim.request,config,signal,current,authorize:async()=>{await binding(run);const result=await call(run,'POST','/jobs/'+claim.request.id+'/heartbeat',claim.lease,signal),job=core.validateModelInferenceJob(result?.job);return current()&&job.id===claim.request.id&&job.inputDigest===claim.request.digest&&job.state==='running';}});work.row={...work.row,stage:'outcome',outcome:{output}};}
   catch(e){const code=['UPSTREAM_REJECTED','UPSTREAM_UNAVAILABLE','OUTPUT_INVALID','OUTPUT_LIMIT','PROFILE_CHANGED','CANCELLED','OUTCOME_UNKNOWN'].includes(e?.code)?e.code:'OUTCOME_UNKNOWN';work.row={...work.row,stage:'outcome',outcome:{failure:code==='CANCELLED'&&e.sent?'OUTCOME_UNKNOWN':code}};}
   work.phase='saving';if(heartbeat)clearInterval(heartbeat);heartbeat=null;
   // Hold received bytes before either disk or service persistence; owner changes cannot apply them elsewhere.
   candidates.set(key(run.snapshot.scope,work.row.id),{scope:clone(run.snapshot.scope),row:clone(work.row)});notify();
   await options.journal.put(run.snapshot.scope,work.row);await persist(run,work.row);return{worked:true};
  }catch(e){errorCode=work.row.outcome?'MODEL_SAVE_UNCONFIRMED':publicCode(e);notify();return{worked:true};}
  finally{if(heartbeat)clearInterval(heartbeat);if(run.active===work)run.active=null;notify();}
 }
 function runOnce(){if(pollTask)return pollTask;const run=runtime;if(!run||run.abort.signal.aborted)return Promise.reject(Object.assign(new Error('MODEL_WORKER_STOPPED'),{code:'MODEL_WORKER_STOPPED'}));const task=tail.then(async()=>{if(runtime!==run||run.abort.signal.aborted||run.recovering||Date.now()<run.resumeAt)return{worked:false};if(run.presenceRequired)await advertise(run);return execute(run);}).catch(e=>{if(pauseForRateLimit(run,e))return{worked:false};stopNow(run,e);throw e;});tail=task.catch(()=>{});pollTask=track(task);task.finally(()=>{if(pollTask===task)pollTask=null;}).catch(()=>{});return pollTask;}
 async function begin(optionsValue={}){
  const requested=++startIntent;if(runtime)fail('MODEL_WORKER_BUSY');const captured=await capture();if(requested!==startIntent)fail('DESKTOP_OPERATION_CANCELLED');const run={snapshot:captured,abort:new AbortController(),timers:new Set(),active:null,resumeAt:0,backoffMs:0,presenceRequired:!optionsValue.recoveryOnly,presenceTask:null};runtime=run;errorCode=null;
  try{await binding(run);if(!optionsValue.recoveryOnly)await advertise(run);await binding(run);}
  catch(e){if(!pauseForRateLimit(run,e)||runtime!==run||run.abort.signal.aborted){stopNow(run,e);if(runtime===run)runtime=null;throw e;}}
  if(!optionsValue.manual&&!optionsValue.recoveryOnly){periodic(run,timings.presenceMs,()=>advertise(run),true);periodic(run,timings.guardMs,()=>binding(run));periodic(run,timings.pollMs,()=>runOnce(),true);}notify();
 }
 async function stop(){startIntent++;const run=runtime;if(run){run.abort.abort();for(const timer of run.timers)clearInterval(timer);run.timers.clear();}notify();await Promise.allSettled([tail,...operations]);if(runtime===run)runtime=null;notify();}
 async function recover(id){
  const run=runtime;if(!run||run.active)fail('MODEL_WORKER_BUSY');await binding(run);const stored=(await options.journal.list(run.snapshot.scope)).find(r=>r.id===id&&r.deviceId===run.snapshot.scope.deviceId),memory=candidates.get(key(run.snapshot.scope,id));let row=memory?.row??stored;if(!row||row.stage==='acknowledged')fail('MODEL_INFERENCE_NOT_FOUND');
  // An intent without a received outcome is settled explicitly as unknown, never executed again.
  if(!row.outcome)row={...row,stage:'outcome',outcome:{failure:'OUTCOME_UNKNOWN'}};
  candidates.set(key(run.snapshot.scope,id),{scope:clone(run.snapshot.scope),row:clone(row)});await options.journal.put(run.snapshot.scope,row);return persist(run,row);
 }
 async function records(scope){const captured=normalizeRemoteScope(scope),stored=await options.journal.list(captured),map=new Map(stored.map(r=>[r.id,r]));for(const entry of candidates.values())if(JSON.stringify(entry.scope)===JSON.stringify(captured)){const saved=map.get(entry.row.id);if(saved?.stage==='acknowledged'&&JSON.stringify(saved.outcome)===JSON.stringify(entry.row.outcome))candidates.delete(key(captured,entry.row.id));else map.set(entry.row.id,entry.row);}return clone([...map.values()]);}
 function retrySave(id){const run=runtime;if(!run||run.recovering||run.active)return Promise.reject(Object.assign(new Error('MODEL_WORKER_BUSY'),{code:'MODEL_WORKER_BUSY'}));run.recovering=true;const task=recover(id).finally(()=>{run.recovering=false;});return track(task);}
 function start(value){return track(begin(value));}
 return{start,stop,runOnce,retrySave,records,snapshot,async settled(){await Promise.allSettled([tail,...operations]);}};
}
module.exports={createComputerModelWorker};
