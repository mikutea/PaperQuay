const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const nativeFs=require('./nativeFs.cjs');
const {normalizeRemoteScope}=require('./remoteTaskJournal.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const MAX_RECORDS=16,MAX_ROW=768*1024,MAX_BYTES=MAX_RECORDS*MAX_ROW+8192;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const sha=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k))&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>'value'in d&&d.enumerable);
function cryptoStorage(options){const secure=options.secure||require('electron').safeStorage;if(!secure?.isEncryptionAvailable?.()||secure.getSelectedStorageBackend?.()==='basic_text')fail('MODEL_SECURE_STORAGE_UNAVAILABLE');return secure;}
function partition(scope){const s=normalizeRemoteScope(scope);return{service:s.service,accountId:s.accountId,libraryId:s.libraryId};}
function createSealedFile(directory,options){
 const files=options.files||nativeFs;let tail=Promise.resolve();
 const filename=scope=>path.join(directory,sha(JSON.stringify(partition(scope)))+'.bin');
 async function read(scope,maxBytes){const secure=cryptoStorage(options);let text;try{text=secure.decryptString((await files.read(filename(scope),{maxBytes:maxBytes*2,singleLink:true})).bytes);}catch(e){if(e.code==='ENOENT')return null;fail('MODEL_SECURE_STORAGE_INVALID');}if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes)fail('MODEL_SECURE_STORAGE_INVALID');try{return JSON.parse(text);}catch{fail('MODEL_SECURE_STORAGE_INVALID');}}
 async function write(scope,value,maxBytes){const secure=cryptoStorage(options),text=JSON.stringify(value);if(Buffer.byteLength(text)>maxBytes)fail('MODEL_LOCAL_CAPACITY');try{await files.mkdir(directory);await files.write(filename(scope),secure.encryptString(text),{mode:0o600});}catch{fail('MODEL_SECURE_STORAGE_WRITE_FAILED');}}
 return{read,write,serial(work){const next=tail.then(work);tail=next.catch(()=>{});return next;},settled:()=>tail};
}
/** Credential fingerprints and random public epochs are OS encrypted. Neither a private key nor its guessable hash is public. */
function createModelCredentialStore(directory,options={}){
 const file=createSealedFile(directory,options);
 return{update(scope,configuration){scope=normalizeRemoteScope(scope);const signature=sha(JSON.stringify(configuration));return file.serial(async()=>{
 const previous=await file.read(scope,16384);
 if(previous!==null&&(!exact(previous,['format','version','signature','epoch','revision'])||previous.format!=='paperquay-model-credentials'||previous.version!==1||!HASH.test(previous.signature)||!UUID.test(previous.epoch)||!Number.isSafeInteger(previous.revision)||previous.revision<1))fail('MODEL_SECURE_STORAGE_INVALID');
 if(previous?.signature===signature)return{epoch:previous.epoch,revision:previous.revision};
 const next={format:'paperquay-model-credentials',version:1,signature,epoch:randomUUID(),revision:(previous?.revision??0)+1};if(!Number.isSafeInteger(next.revision))fail('MODEL_SECURE_STORAGE_INVALID');await file.write(scope,next,16384);return{epoch:next.epoch,revision:next.revision};
 });},settled:()=>file.settled()};
}
/** An intent must be acknowledged before upstream execution. Reopening only returns records; it never executes them. */
function createModelJournal(directory,options={}){
 const file=createSealedFile(directory,options),core=()=>options.core||require('../generated/desktopSyncCore.cjs');
 async function row(input){
 if(!exact(input,['id','deviceId','claim','stage','outcome','createdAt'])||!UUID.test(input.id)||!UUID.test(input.deviceId)||!['intent','outcome','acknowledged'].includes(input.stage)||typeof input.createdAt!=='string'||!Number.isFinite(Date.parse(input.createdAt)))fail('MODEL_SECURE_STORAGE_INVALID');
 const claim=await core().validateModelInferenceClaim(input.claim);if(claim.request.id!==input.id||claim.request.target.kind!=='computer'||claim.request.target.deviceId!==input.deviceId)fail('MODEL_SECURE_STORAGE_INVALID');
 let outcome=null;if(input.outcome!==null){if(exact(input.outcome,['output']))outcome={output:await core().validateModelInferenceOutput(input.outcome.output)};else if(exact(input.outcome,['failure'])&&core().MODEL_FAILURES.includes(input.outcome.failure))outcome={failure:input.outcome.failure};else fail('MODEL_SECURE_STORAGE_INVALID');}
 if(input.stage==='intent'?outcome!==null:outcome===null)fail('MODEL_SECURE_STORAGE_INVALID');
 const result={id:input.id,deviceId:input.deviceId,claim,stage:input.stage,outcome,createdAt:input.createdAt};if(Buffer.byteLength(JSON.stringify(result))>MAX_ROW)fail('MODEL_LOCAL_CAPACITY');return result;
 }
 async function load(scope){const value=await file.read(scope,MAX_BYTES);if(value===null)return{format:'paperquay-model-journal',version:1,scope:partition(scope),records:[]};
 if(!exact(value,['format','version','scope','records'])||value.format!=='paperquay-model-journal'||value.version!==1||JSON.stringify(value.scope)!==JSON.stringify(partition(scope))||!Array.isArray(value.records)||value.records.length>MAX_RECORDS)fail('MODEL_SECURE_STORAGE_INVALID');
 const records=[];for(const input of value.records)records.push(await row(input));if(new Set(records.map(r=>r.id)).size!==records.length)fail('MODEL_SECURE_STORAGE_INVALID');return{...value,records};
 }
 return{
 list(scope){scope=normalizeRemoteScope(scope);return file.serial(async()=>structuredClone((await load(scope)).records));},
 capacity(scope){scope=normalizeRemoteScope(scope);return file.serial(async()=>({retained:(await load(scope)).records.length,maxRetained:MAX_RECORDS}));},
 put(scope,input){scope=normalizeRemoteScope(scope);core().inspectModelInferenceJson(input,MAX_ROW);input=structuredClone(input);return file.serial(async()=>{const normalized=normalizeRemoteScope(scope),record=await row(input);if(record.deviceId!==normalized.deviceId)fail('MODEL_BINDING_CHANGED');const value=await load(scope),old=value.records.find(r=>r.id===record.id);
 if(old){if(JSON.stringify(old.claim)!==JSON.stringify(record.claim)||old.deviceId!==record.deviceId||old.createdAt!==record.createdAt)fail('MODEL_INFERENCE_CHANGED');if(old.outcome&&JSON.stringify(old.outcome)!==JSON.stringify(record.outcome))fail('MODEL_INFERENCE_CHANGED');if(['intent','outcome','acknowledged'].indexOf(record.stage)<['intent','outcome','acknowledged'].indexOf(old.stage))fail('MODEL_INFERENCE_CHANGED');value.records[value.records.indexOf(old)]=record;}else{if(record.stage!=='intent')fail('MODEL_INFERENCE_CHANGED');if(value.records.length>=MAX_RECORDS)fail('MODEL_LOCAL_CAPACITY');value.records.push(record);}
 await file.write(scope,value,MAX_BYTES);return structuredClone(record);});},
 clearAcknowledged(scope){scope=normalizeRemoteScope(scope);return file.serial(async()=>{const value=await load(scope),before=value.records.length;value.records=value.records.filter(r=>r.stage!=='acknowledged');const removed=before-value.records.length;if(removed)await file.write(scope,value,MAX_BYTES);return{removed};});},
 settled:()=>file.settled()
 };
}
module.exports={createModelCredentialStore,createModelJournal,MODEL_JOURNAL_LIMITS:Object.freeze({records:MAX_RECORDS,rowBytes:MAX_ROW,totalBytes:MAX_BYTES})};
