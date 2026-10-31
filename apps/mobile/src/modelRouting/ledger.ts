import {AiError} from '../ai/errors.ts';
import {canonicalJson} from '../../../../packages/sync-core/src/validation.ts';
import {MODEL_INFERENCE_LIMITS,inspectModelInferenceJson,modelInferenceId,validateModelInferenceTarget,validateModelProfileRef,readModelInferenceRequestShape,readModelInferenceOutputShape,validateModelInferenceJob,validateModelInferenceRequest,validateModelInferenceOutput,validateModelInferenceStatus} from '../../../../packages/sync-core/src/modelInference.ts';
import type {ModelInferenceRequest,ModelInferenceOutput,ModelInferenceTarget,ModelProfileRef,ModelInferenceJob,ModelInferenceStatus} from '../../../../packages/sync-core/src/modelInference.ts';

export const MODEL_LEDGER_LIMITS=Object.freeze({records:4,receipts:128,bytes:3*1024*1024,outputReservation:MODEL_INFERENCE_LIMITS.requestBytes});
export type ModelPurpose='pdf'|'research'|'review'|'agent';
export type ModelRecordPhase='intent'|'waiting'|'complete'|'failed'|'cancelled'|'uncertain'|'removed';
export interface ModelInvocationRecord {request:ModelInferenceRequest;purpose:ModelPurpose;createdAt:number;updatedAt:number;phase:ModelRecordPhase;released:boolean;job:ModelInferenceJob|null;output:ModelInferenceOutput|null}
export interface ModelInvocationReceipt {id:string;inputDigest:string;target:ModelInferenceTarget;profileRef:ModelProfileRef;model:string;purpose:ModelPurpose;createdAt:number;outcome:'complete'|'failed'|'cancelled'|'uncertain'|'removed'}
export interface ModelInvocationLedger {version:1;revision:number;records:ModelInvocationRecord[];receipts:ModelInvocationReceipt[]}
const phases=['intent','waiting','complete','failed','cancelled','uncertain','removed'],purposes=['pdf','research','review','agent'],outcomes=['complete','failed','cancelled','uncertain','removed'];
const bytes=(v:unknown)=>new TextEncoder().encode(canonicalJson(v)).length;
const fail=():never=>{throw new AiError('INVALID_RESPONSE');};
function exact(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return fail();const d=Object.getOwnPropertyDescriptors(v);if(Reflect.ownKeys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(d,k))||Object.values(d).some(x=>!x.enumerable||!('value'in x)))return fail();return v as Record<string,unknown>;}
function time(v:unknown):number{if(!Number.isSafeInteger(v)||Number(v)<0||Number(v)>253402300799999)return fail();return Number(v);}
function purpose(v:unknown):ModelPurpose{if(typeof v!=='string'||!purposes.includes(v))return fail();return v as ModelPurpose;}
function receiptFor(r:ModelInvocationRecord):ModelInvocationReceipt{return{id:r.request.id,inputDigest:r.request.digest,target:r.request.target,profileRef:r.request.profileRef,model:r.request.model,purpose:r.purpose,createdAt:r.createdAt,outcome:outcomes.includes(r.phase)?r.phase as ModelInvocationReceipt['outcome']:'uncertain'};}
function sameIdentity(a:ModelInvocationReceipt,b:ModelInvocationReceipt){return canonicalJson({...a,outcome:'uncertain'})===canonicalJson({...b,outcome:'uncertain'});}
function matchJob(request:ModelInferenceRequest,job:ModelInferenceJob){if(job.id!==request.id||job.inputDigest!==request.digest||canonicalJson(job.target)!==canonicalJson(request.target)||canonicalJson({id:job.profile.id,revision:job.profile.revision,digest:job.profile.digest})!==canonicalJson(request.profileRef)||job.profile.model!==request.model||job.profile.maxOutputTokens<request.maxOutputTokens||bytes(request.messages)>job.profile.maxInputBytes)return fail();}
export function emptyModelLedger():ModelInvocationLedger{return{version:1,revision:0,records:[],receipts:[]};}
/** Strict synchronous storage shape. verifyModelLedger performs the asynchronous SHA256 checks before use. */
export function readModelLedger(value:unknown):ModelInvocationLedger {
 inspectModelInferenceJson(value,MODEL_LEDGER_LIMITS.bytes);const v=exact(value,['version','revision','records','receipts']);
 if(v.version!==1||!Number.isSafeInteger(v.revision)||Number(v.revision)<0||!Array.isArray(v.records)||v.records.length>MODEL_LEDGER_LIMITS.records||!Array.isArray(v.receipts)||v.receipts.length>MODEL_LEDGER_LIMITS.receipts)return fail();
 const records=v.records.map(value=>{const r=exact(value,['request','purpose','createdAt','updatedAt','phase','released','job','output']),request=readModelInferenceRequestShape(r.request),createdAt=time(r.createdAt),updatedAt=time(r.updatedAt);
  if(updatedAt<createdAt||typeof r.phase!=='string'||!phases.includes(r.phase)||typeof r.released!=='boolean')return fail();
  const job=r.job===null?null:validateModelInferenceJob(r.job),output=r.output===null?null:readModelInferenceOutputShape(r.output);
  if(job)matchJob(request,job);if((r.phase==='complete')!==(output!==null)||output&&job?.state==='complete'&&job.outputDigest!==output.digest)return fail();
  return{request,purpose:purpose(r.purpose),createdAt,updatedAt,phase:r.phase as ModelRecordPhase,released:r.released,job,output};
 });
 const receipts=v.receipts.map(value=>{const r=exact(value,['id','inputDigest','target','profileRef','model','purpose','createdAt','outcome']);if(typeof r.inputDigest!=='string'||!/^[0-9a-f]{64}$/.test(r.inputDigest)||typeof r.model!=='string'||!/^[A-Za-z0-9_./:@+-]{1,160}$/.test(r.model)||typeof r.outcome!=='string'||!outcomes.includes(r.outcome))return fail();return{id:modelInferenceId(r.id),inputDigest:r.inputDigest,target:validateModelInferenceTarget(r.target),profileRef:validateModelProfileRef(r.profileRef),model:r.model,purpose:purpose(r.purpose),createdAt:time(r.createdAt),outcome:r.outcome as ModelInvocationReceipt['outcome']};});
 if(new Set(records.map(r=>r.request.id)).size!==records.length||new Set(receipts.map(r=>r.id)).size!==receipts.length)return fail();
 for(const r of records){const receipt=receipts.find(x=>x.id===r.request.id);if(!receipt||!sameIdentity(receipt,receiptFor(r))||receipt.outcome!==receiptFor(r).outcome)return fail();}
 if(records.filter(r=>!r.released&&['intent','waiting','uncertain'].includes(r.phase)).length>1)return fail();
 const result={version:1 as const,revision:Number(v.revision),records,receipts};if(bytes(result)>MODEL_LEDGER_LIMITS.bytes)return fail();return result;
}
export async function verifyModelLedger(value:unknown):Promise<ModelInvocationLedger>{const result=readModelLedger(value);for(const r of result.records){r.request=await validateModelInferenceRequest(r.request);if(r.output)r.output=await validateModelInferenceOutput(r.output);}return result;}
function changed(ledger:ModelInvocationLedger,records:ModelInvocationRecord[],receipts=ledger.receipts):ModelInvocationLedger {return readModelLedger({...ledger,revision:ledger.revision+1,records,receipts});}
export function beginModelRecord(value:ModelInvocationLedger,requestValue:ModelInferenceRequest,p:ModelPurpose,at:number):{ledger:ModelInvocationLedger;created:boolean}{
 const ledger=readModelLedger(value),request=readModelInferenceRequestShape(requestValue),receipt=ledger.receipts.find(r=>r.id===request.id);
 if(receipt){if(receipt.inputDigest!==request.digest||receipt.purpose!==p)throw new AiError('REMOTE_PROFILE_CHANGED');return{ledger,created:false};}
 if(ledger.records.some(r=>!r.released&&['intent','waiting','uncertain'].includes(r.phase)))throw new AiError('REMOTE_UNCONFIRMED');
 if(ledger.records.length>=MODEL_LEDGER_LIMITS.records||ledger.receipts.length>=MODEL_LEDGER_LIMITS.receipts||bytes(ledger)+bytes(request)+MODEL_LEDGER_LIMITS.outputReservation+2048>MODEL_LEDGER_LIMITS.bytes)throw new AiError('REMOTE_CAPACITY');
 const record:ModelInvocationRecord={request,purpose:purpose(p),createdAt:time(at),updatedAt:time(at),phase:'intent',released:false,job:null,output:null};
 return{ledger:changed(ledger,[...ledger.records,record],[...ledger.receipts,receiptFor(record)]),created:true};
}
export async function checkedModelStatus(requestValue:ModelInferenceRequest,value:unknown):Promise<ModelInferenceStatus>{const request=await validateModelInferenceRequest(requestValue),status=await validateModelInferenceStatus(value);if(status.id!==request.id)return fail();if(status.job)matchJob(request,status.job);return status;}
/** Input must already have passed checkedModelStatus. Re-check the immutable binding in the transaction. */
export function observeModelRecord(value:ModelInvocationLedger,id:string,status:ModelInferenceStatus,at:number):ModelInvocationLedger {
 const ledger=readModelLedger(value),record=ledger.records.find(r=>r.request.id===id);if(!record)throw new AiError('REMOTE_UNCONFIRMED');if(status.id!==id)return fail();if(status.job)matchJob(record.request,status.job);
 // A retained known result survives service TTL, deletion and later weaker observations.
 if(record.output){if(status.output&&status.output.digest!==record.output.digest)return fail();return ledger;}
 const phase:ModelRecordPhase=status.output?'complete':status.status==='cancelled'?'cancelled':status.status==='removed'?'removed':status.status==='absent'?'uncertain':status.job?.state==='failed'?'failed':status.job?.state==='cancelled'?'cancelled':status.job?.state==='uncertain'?'uncertain':'waiting';
 const next={...record,updatedAt:Math.max(record.updatedAt,time(at)),phase,job:status.job,output:status.output};
 return changed(ledger,ledger.records.map(r=>r.request.id===id?next:r),ledger.receipts.map(r=>r.id===id?receiptFor(next):r));
}
export function markModelUncertain(value:ModelInvocationLedger,id:string,at:number):ModelInvocationLedger {const ledger=readModelLedger(value),r=ledger.records.find(r=>r.request.id===id);if(!r||r.output||['failed','cancelled','removed'].includes(r.phase))return ledger;const next={...r,phase:'uncertain' as const,updatedAt:Math.max(r.updatedAt,time(at))};return changed(ledger,ledger.records.map(x=>x===r?next:x),ledger.receipts.map(x=>x.id===id?receiptFor(next):x));}
/** Explicit user acknowledgement permits a NEW ID; the old receipt remains forever until explicit local reset. */
export function releaseModelRecord(value:ModelInvocationLedger,id:string):ModelInvocationLedger {const ledger=readModelLedger(value),r=ledger.records.find(r=>r.request.id===id);if(!r)throw new AiError('REMOTE_UNCONFIRMED');return changed(ledger,ledger.records.map(x=>x===r?{...x,released:true}:x));}
/** Explicitly compact full content after backup/abandonment. Never erase the anti-replay identity receipt. */
export function compactModelRecord(value:ModelInvocationLedger,id:string):ModelInvocationLedger {const ledger=readModelLedger(value),r=ledger.records.find(r=>r.request.id===id);if(!r)return ledger;if(!r.released&&!['complete','failed','cancelled','removed'].includes(r.phase))throw new AiError('REMOTE_UNCONFIRMED');return changed(ledger,ledger.records.filter(x=>x!==r));}

/** Captured root session; source changes do not retire its result storage. */
export interface ModelLedgerOwner {readonly signal:AbortSignal;current():boolean;read():ModelInvocationLedger;refresh():Promise<ModelInvocationLedger>;update(reducer:(value:ModelInvocationLedger)=>ModelInvocationLedger):Promise<ModelInvocationLedger>}
