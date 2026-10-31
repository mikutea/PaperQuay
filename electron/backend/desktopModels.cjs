const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const nativeFs=require('./nativeFs.cjs');
const {createModelCredentialStore,createModelJournal}=require('./modelInferenceStorage.cjs');
const {createComputerModelWorker}=require('./computerModelWorker.cjs');
const {normalizeRemoteScope}=require('./remoteTaskJournal.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha=v=>createHash('sha256').update(v).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
function createDesktopModels(context,options){
 const core=options.core,root=path.join(path.dirname(context.appPaths.configPath),'account-sync','model-inference'),journal=options.journal||createModelJournal(path.join(root,'journal'),options),epochs=options.epochs||createModelCredentialStore(path.join(root,'credential-epochs'),options);
 let capability=null,available=[],privateConfigs=new Map(),configurationToken=null,configSignature=null,visibleScope=null,errorCode=null,enabled=false,starting=false,recovering=false,active=null,intent=0,stopping=Promise.resolve(),refreshTail=Promise.resolve(),normalizer=null;
 const sessions=new Map(),recoveryWorkers=new Set(),notify=()=>{try{options.onChange?.();}catch{}};
 const key=scope=>sha(JSON.stringify(normalizeRemoteScope(scope)));
 function base(){const c=options.getContext();if(!c?.account||!c.library||!c.config)fail('AUTHENTICATION_REQUIRED');options.checkContext(c);return c;}
 function scope(c){return{service:c.config.apiBaseUrl,accountId:c.account.accountId,deviceId:c.account.deviceId,libraryId:c.library.libraryBindingId};}
 async function read(){if(options.readConfiguration)return options.readConfiguration();for(const destination of [context.appPaths.configPath,context.appPaths.legacyConfigPath].filter(Boolean)){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode((await nativeFs.read(destination,{maxBytes:4*1024*1024,singleLink:true})).bytes));}catch(e){if(e.code!=='ENOENT')fail('MODEL_CONFIGURATION_INVALID');}}return{};}
 async function configurations(source){normalizer||=(await import('../../packages/model-inference/index.mjs')).normalizePrivateModelConfiguration;
  const presets=source?.secrets?.qaModelPresets;if(!Array.isArray(presets)||presets.length>64)return new Map();const result=new Map();
  for(const p of presets){if(!p||typeof p.id!=='string'||!p.id.length||p.id.length>128||result.has(p.id)||p.apiMode&&p.apiMode!=='chat_completions')continue;try{const c=normalizer({endpoint:p.baseUrl,model:p.model,apiKey:p.apiKey,requiresKey:true,tokenParameter:'max_tokens',maxOutputTokens:2048});result.set(p.id,{configuration:c,label:typeof p.label==='string'&&p.label.trim()?p.label.trim().slice(0,128):c.model});}catch{}}
  return result;
 }
 function publicError(e){return typeof e?.code==='string'&&/^(?:MODEL_[A-Z_]{1,64}|PROFILE_CHANGED|AUTHENTICATION_REQUIRED|SESSION_REVOKED|DESKTOP_OPERATION_CANCELLED)$/.test(e.code)?e.code:'MODEL_EXECUTION_FAILED';}
 async function refresh(){
  const task=refreshTail.then(async()=>{const c=base(),configs=await configurations(await read());options.checkContext(c);const signature=sha(JSON.stringify([scope(c),[...configs.entries()]]));
   if(signature===configSignature&&configurationToken)return;
   const changed=active&&(key(scope(c))!==key(active.scope)||JSON.stringify(configs.get(active.presetId)?.configuration)!==JSON.stringify(active.configuration));
   privateConfigs=configs;visibleScope=key(scope(c));available=[...configs].map(([id,v])=>({id,label:v.label,model:v.configuration.model,maxOutputTokens:2048}));configSignature=signature;configurationToken=randomUUID();
   if(changed){errorCode='MODEL_CONFIGURATION_CHANGED';void stop();}notify();
  });refreshTail=task.catch(()=>{});return task;
 }
 async function capture(session){await refresh();const c=base();if(key(scope(c))!==key(session.scope)||c.epoch!==session.accountEpoch)fail('MODEL_BINDING_CHANGED');if(JSON.stringify(privateConfigs.get(session.presetId)?.configuration)!==JSON.stringify(session.configuration))fail('PROFILE_CHANGED');return{scope:session.scope,profiles:[session.profile],generation:session.generation};}
 function checkSnapshot(session,snapshot){const c=base();if(c.epoch!==session.accountEpoch||key(scope(c))!==key(snapshot.scope))fail('MODEL_BINDING_CHANGED');}
 async function stop(){
  enabled=false;intent++;const owned=active;active=null;const halt=Promise.allSettled([owned?.worker.stop(),...[...recoveryWorkers].map(w=>w.stop())]);const previous=stopping;
  stopping=(async()=>{await Promise.allSettled([previous,halt]);if(owned)await options.withdrawPresence?.(owned.scope).catch(()=>{});notify();})();notify();return stopping;
 }
 async function collect(){const c=base(),s=scope(c),rows=new Map((await journal.list(s)).map(r=>[r.id,r]));
  for(const session of sessions.values())if(session.scope.service===s.service&&session.scope.accountId===s.accountId&&session.scope.libraryId===s.libraryId){for(const row of await session.worker.records(session.scope))rows.set(row.id,row);}options.checkContext(c);return{scope:s,rows:[...rows.values()]};
 }
 const result={
  status(){const state=active?.worker.snapshot(),current=options.getContext(),visible=!!current?.account&&!!current?.library&&!!current?.config&&key(scope(current))===visibleScope;return{enabled,running:!!state?.running,busy:starting||recovering||!!state?.busy,capability:capability&&structuredClone(capability),presets:capability&&visible?structuredClone(available):[],profiles:active?[structuredClone(active.profile)]:[],configurationToken:capability&&visible?configurationToken:null,errorCode:errorCode||state?.errorCode||null,unconfirmed:[...sessions.values()].filter(s=>s.scope.accountId===options.getContext()?.account?.accountId&&s.scope.service===options.getContext()?.config?.apiBaseUrl&&s.scope.libraryId===options.getContext()?.library?.libraryBindingId).reduce((n,s)=>n+s.worker.snapshot().unconfirmed,0)};},
  setCapability(value){capability=value?core.validateModelInferenceCapability(value):null;if(!capability&&(enabled||starting)){errorCode='MODEL_INFERENCE_DISABLED';void stop();}},
  async refreshStatus(){try{if(capability&&options.getContext()?.account)await refresh();}catch(e){available=[];errorCode=publicError(e);}},
  async setEnabled(args){
   if(typeof args?.enabled!=='boolean')fail('DESKTOP_ARGUMENT_INVALID');if(!args.enabled){if(!exact(args,['enabled']))fail('DESKTOP_ARGUMENT_INVALID');await stop();return;}
   if(!exact(args,['enabled','consent','configurationToken','presetId'])||args.consent!==true||!UUID.test(args.configurationToken)||typeof args.presetId!=='string')fail('DESKTOP_ARGUMENT_INVALID');
   if(starting||recovering)fail('MODEL_WORKER_BUSY');if(enabled){if(active?.presetId===args.presetId&&args.configurationToken===configurationToken)return;fail('MODEL_WORKER_BUSY');}
   const requested=++intent;starting=true;notify();
   try{
    await stopping;await refresh();const c=base(),s=scope(c),selected=privateConfigs.get(args.presetId);if(requested!==intent)fail('DESKTOP_OPERATION_CANCELLED');if(!capability)fail('MODEL_INFERENCE_DISABLED');if(args.configurationToken!==configurationToken)fail('MODEL_CONFIGURATION_CHANGED');if(!selected)fail('MODEL_PROFILE_UNAVAILABLE');
    await options.ensureTokenLifetime(Date.now()+120000);options.checkContext(c);if(requested!==intent)fail('DESKTOP_OPERATION_CANCELLED');
    const epoch=await epochs.update(s,selected.configuration),body={id:'chat-default',revision:epoch.revision,kind:'chat',model:selected.configuration.model,maxInputBytes:core.MODEL_INFERENCE_LIMITS.inputBytes,maxOutputTokens:2048,stream:false},profile=core.validateModelInferenceProfile({...body,digest:sha(JSON.stringify({public:body,epoch:epoch.epoch}))});
    const previous=sessions.get(key(s));if(previous?.worker.snapshot().unconfirmed)fail('MODEL_SAVE_UNCONFIRMED');
    if(!previous&&sessions.size>=4){const disposable=[...sessions].find(([,v])=>!v.worker.snapshot().unconfirmed);if(!disposable)fail('MODEL_LOCAL_CAPACITY');await disposable[1].worker.stop();sessions.delete(disposable[0]);}
    const session={scope:s,presetId:args.presetId,configuration:structuredClone(selected.configuration),profile,accountEpoch:c.epoch,generation:sha(JSON.stringify([c.epoch,c.library.anchor,profile])),worker:null};
    session.worker=(options.createWorker||createComputerModelWorker)({core,journal,fetch:options.fetch,timings:options.timings,capture:()=>capture(session),check:snapshot=>checkSnapshot(session,snapshot),getPrivate:async(_profile,snapshot)=>{await capture(session);checkSnapshot(session,snapshot);await options.ensureTokenLifetime(Date.now()+120000);return structuredClone(session.configuration);},api:(snapshot,input)=>{checkSnapshot(session,snapshot);return options.api(snapshot,input);},onState:state=>{if(!starting&&enabled&&active===session&&!state.running){errorCode=state.errorCode||'MODEL_WORKER_STOPPED';void stop();}notify();}});
    sessions.set(key(s),session);active=session;enabled=true;errorCode=null;await session.worker.start(options.manual?{manual:true}:{});
    if(requested!==intent)fail('DESKTOP_OPERATION_CANCELLED');
   }catch(e){errorCode=publicError(e);await stop();throw Object.assign(new Error(errorCode),{code:errorCode});}finally{starting=false;notify();}
  },
  async configurationWillChange(content){if(!enabled&&!starting)return;let changed=true;try{const next=await configurations(JSON.parse(content));changed=!active||JSON.stringify(next.get(active.presetId)?.configuration)!==JSON.stringify(active.configuration);}catch{}if(changed){errorCode='MODEL_CONFIGURATION_CHANGED';await stop();}},
  async listRecords(){const {scope:s,rows}=await collect();return{items:rows.map(r=>({id:r.id,stage:r.stage,model:r.claim.request.model,createdAt:r.createdAt,hasOutput:!!r.outcome?.output,canRecover:r.deviceId===s.deviceId&&r.stage!=='acknowledged',failure:r.outcome?.failure??null}))};},
  async backup(args){if(!exact(args,['id'])||!UUID.test(args.id))fail('DESKTOP_ARGUMENT_INVALID');const {rows}=await collect(),row=rows.find(r=>r.id===args.id);if(!row)fail('MODEL_INFERENCE_NOT_FOUND');return{format:'paperquay-computer-model-backup',version:1,record:structuredClone(row)};},
  async retrySave(args){
   if(recovering)fail('MODEL_WORKER_BUSY');recovering=true;notify();try{
   if(!exact(args,['id'])||!UUID.test(args.id))fail('DESKTOP_ARGUMENT_INVALID');if(starting||active?.worker.snapshot().busy)fail('MODEL_WORKER_BUSY');
   const c=base(),{scope:s,rows}=await collect(),row=rows.find(r=>r.id===args.id);if(!row||row.deviceId!==s.deviceId)fail('MODEL_BINDING_CHANGED');const remembered=sessions.get(key(s));
   if(remembered){if(active===remembered)return await remembered.worker.retrySave(args.id);await stop();remembered.accountEpoch=c.epoch;remembered.generation=sha(JSON.stringify([c.epoch,row.claim.job.profile]));}
   // Recovery does not need a current model key or publish/claim work. A manual worker only submits saved bytes.
   const recovery=(options.createWorker||createComputerModelWorker)({core,journal,capture:async()=>({scope:s,profiles:[row.claim.job.profile],generation:sha(JSON.stringify([c.epoch,row.claim.job.profile]))}),check:()=>options.checkContext(c),getPrivate:async()=>fail('MODEL_RECOVERY_ONLY'),api:(snapshot,input)=>{options.checkContext(c);return options.api(snapshot,input);}});
   // A memory-only candidate belongs to its original worker; persist it before constructing a recovery-only worker.
   if(remembered){const held=(await remembered.worker.records(s)).find(r=>r.id===row.id);if(held?.stage!=='acknowledged')await journal.put(s,held);}
   recoveryWorkers.add(recovery);try{await recovery.start({manual:true,recoveryOnly:true});await recovery.retrySave(args.id);await remembered?.worker.records(s);errorCode=null;}
   finally{await recovery.stop();recoveryWorkers.delete(recovery);notify();}
   }finally{recovering=false;notify();}
  },
  async clearAcknowledged(args){if(!exact(args,['confirmed'])||args.confirmed!==true)fail('DESKTOP_ARGUMENT_INVALID');if(enabled||starting||recovering)fail('MODEL_WORKER_BUSY');const c=base(),outcome=await journal.clearAcknowledged(scope(c));options.checkContext(c);return outcome;},
  stop,async settled(){await Promise.allSettled([stopping,refreshTail,journal.settled(),epochs.settled(),...[...sessions.values()].map(s=>s.worker.settled()),...[...recoveryWorkers].map(w=>w.settled())]);},
  async runOnce(){if(!active)fail('MODEL_WORKER_STOPPED');return active.worker.runOnce();}
 };
 return result;
}
module.exports={createDesktopModels};
