import { canonicalJson, type VisibleEntity } from '../../../../packages/sync-core/src/index.ts';
import { reviewFingerprint } from '../review/fingerprint.ts';
import { AgentError, agentObject, agentOnly, agentUuid, agentHash, inspectAgentJson } from './guards.ts';
import { validateCapturedAgentTargets, captureAgentTargets, assertAgentTargetsCurrent, agentPaper, agentCore, validateAgentProposal, withAgentProposalEvidence, type AgentTarget, type AgentPatch, type AgentProposal } from './proposals.ts';
import { prepareAgentMetadataRequest, validateAgentMetadataRequest, type AgentMetadataRequest } from './metadataRequest.ts';
import { validateAgentMetadataResponse, crossrefEvidenceFromCandidate, type AgentMetadataResponse, type AgentMetadataCandidate } from './metadataClient.ts';
import type { AgentMetadataQuery } from './metadataQuery.ts';

export const AGENT_METADATA_LIMITS = Object.freeze({ targets:16, requests:32, bytes:8*1024*1024, publications:32 });
export const METADATA_FIELDS = ['title','authors','year','publication','doi','abstractText','keywords'] as const;
export type AgentMetadataField = typeof METADATA_FIELDS[number];
export const METADATA_FAILURES = ['INVALID_DOI','INVALID_OPTIONS','ABORTED','TIMEOUT','NETWORK_FAILED','NOT_FOUND','RATE_LIMITED','SERVICE_UNAVAILABLE','HTTP_ERROR','RESPONSE_TOO_LARGE','INVALID_RESPONSE','DOI_MISMATCH','METADATA_LIMIT','MISSING_TITLE','CHANGED','BUSY','COOLDOWN'] as const;
export type AgentMetadataFailure = typeof METADATA_FAILURES[number];
export interface AgentMetadataRecord {
 request:AgentMetadataRequest; status:'uncertain'|'complete'|'failed'|'cancelled'; finishedAt:number|null;
 responseDigest:string|null; candidates:number|null; failure:AgentMetadataFailure|null; retryAt:number|null;
}
export interface AgentMetadataChoice { targetId:string; requestId:string; candidateId:string; fields:AgentMetadataField[] }
export interface AgentMetadataPublication { key:string; proposalId:string; proposalDigest:string }
export interface AgentMetadataSession {
 version:1; id:string; revision:number; createdAt:number; targets:AgentTarget[];
 records:AgentMetadataRecord[]; responses:AgentMetadataResponse[]; cooldownUntil:number; publications:AgentMetadataPublication[];
}
const timestamp=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=253402300799999;
function targetRef(t:AgentTarget){return{id:t.id,hash:t.hash,revision:t.revision};}
export function validateAgentMetadataSession(input:unknown):AgentMetadataSession {
 inspectAgentJson(input,AGENT_METADATA_LIMITS.bytes);if(!agentObject(input))throw new AgentError('INVALID');
 agentOnly(input,['version','id','revision','createdAt','targets','records','responses','cooldownUntil','publications']);
 if(input.version!==1||!agentUuid.test(String(input.id))||!Number.isSafeInteger(input.revision)||Number(input.revision)<1||!timestamp(input.createdAt)||!timestamp(input.cooldownUntil)||!Array.isArray(input.records)||input.records.length>32||!Array.isArray(input.responses)||!Array.isArray(input.publications)||input.publications.length>32)throw new AgentError('INVALID');
 const targets=validateCapturedAgentTargets(input.targets);if(targets.length>16)throw new AgentError('LIMIT');const known=new Map(targets.map(t=>[t.id,t])),records=new Map<string,AgentMetadataRecord>(),latestSuccess=new Map<string,string>();let cooldown=0;
 for(let i=0;i<input.records.length;i++){
  const raw=input.records[i];if(!agentObject(raw))throw new AgentError('INVALID');agentOnly(raw,['request','status','finishedAt','responseDigest','candidates','failure','retryAt']);const r=validateAgentMetadataRequest(raw.request),target=known.get(r.target.id);
  if(!target||r.sessionId!==input.id||canonicalJson(r.target)!==canonicalJson(targetRef(target))||records.has(r.id)||!['uncertain','complete','failed','cancelled'].includes(String(raw.status)))throw new AgentError('INVALID');
  if(raw.retryAt!==null&&(!timestamp(raw.retryAt)||raw.retryAt<r.createdAt))throw new AgentError('INVALID');
  if(raw.status==='uncertain'){if(i!==input.records.length-1||[raw.finishedAt,raw.responseDigest,raw.candidates,raw.failure,raw.retryAt].some(v=>v!==null))throw new AgentError('INVALID');}
  else if(!timestamp(raw.finishedAt)||raw.finishedAt<r.createdAt)throw new AgentError('INVALID');
  if(raw.status==='complete'){if(!agentHash.test(String(raw.responseDigest))||!Number.isSafeInteger(raw.candidates)||Number(raw.candidates)<0||Number(raw.candidates)>5||raw.failure!==null||raw.retryAt!==null)throw new AgentError('INVALID');}
  else if(raw.status!=='uncertain'&&(raw.responseDigest!==null||raw.candidates!==null||!METADATA_FAILURES.includes(raw.failure as AgentMetadataFailure)||raw.status==='cancelled'&&raw.failure!=='ABORTED'))throw new AgentError('INVALID');
  if(raw.retryAt!==null){if(!['RATE_LIMITED','SERVICE_UNAVAILABLE','COOLDOWN'].includes(String(raw.failure)))throw new AgentError('INVALID');cooldown=Math.max(cooldown,Number(raw.retryAt));}
  records.set(r.id,raw as unknown as AgentMetadataRecord);if(raw.status==='complete')latestSuccess.set(r.target.id,r.id);
 }
 if(cooldown!==input.cooldownUntil)throw new AgentError('INVALID');
 const responseTargets=new Set<string>();if(input.responses.length>targets.length)throw new AgentError('INVALID');
 for(const raw of input.responses){if(!agentObject(raw))throw new AgentError('INVALID');const record=records.get(String(raw.requestId));if(!record||record.status!=='complete')throw new AgentError('INVALID');const response=validateAgentMetadataResponse(raw,record.request),id=record.request.target.id;
  if(responseTargets.has(id)||response.responseDigest!==record.responseDigest||response.candidates.length!==record.candidates||response.receivedAt>record.finishedAt!||latestSuccess.get(id)!==record.request.id)throw new AgentError('INVALID');responseTargets.add(id);
 }
 for(const id of new Set([...records.values()].filter(r=>r.status==='complete').map(r=>r.request.target.id)))if(!responseTargets.has(id))throw new AgentError('INVALID');
 const keys=new Set<string>();for(const raw of input.publications){if(!agentObject(raw))throw new AgentError('INVALID');agentOnly(raw,['key','proposalId','proposalDigest']);if(!agentHash.test(String(raw.key))||keys.has(String(raw.key))||raw.proposalId!==metadataProposalId(String(raw.key))||!agentHash.test(String(raw.proposalDigest)))throw new AgentError('INVALID');keys.add(String(raw.key));}
 return structuredClone(input) as unknown as AgentMetadataSession;
}
export function createAgentMetadataSession(entities:readonly VisibleEntity[],ids:readonly string[],id:string=crypto.randomUUID(),at:number=Date.now()):AgentMetadataSession {
 if(ids.length>16)throw new AgentError('LIMIT');return validateAgentMetadataSession({version:1,id,revision:1,createdAt:at,targets:captureAgentTargets(entities,ids),records:[],responses:[],cooldownUntil:0,publications:[]});
}
export function prepareAgentMetadataSessionRequest(input:AgentMetadataSession,targetId:string,query:AgentMetadataQuery,id:string=crypto.randomUUID(),at:number=Date.now()):AgentMetadataRequest {
 const s=validateAgentMetadataSession(input);if(s.records.some(r=>r.status==='uncertain'))throw new AgentError('PENDING');if(s.records.length>=32||new TextEncoder().encode(JSON.stringify(s)).length>AGENT_METADATA_LIMITS.bytes-2*1024*1024-65536)throw new AgentError('LIMIT');if(at<s.cooldownUntil)throw new AgentError('PENDING');const t=s.targets.find(t=>t.id===targetId);if(!t)throw new AgentError('INVALID');return prepareAgentMetadataRequest(s.id,targetRef(t),query,id,at);
}
export function beginAgentMetadataQuery(input:AgentMetadataSession,requestInput:AgentMetadataRequest):AgentMetadataSession {
 const s=validateAgentMetadataSession(input),r=validateAgentMetadataRequest(requestInput),expected=prepareAgentMetadataSessionRequest(s,r.target.id,r.query,r.id,r.createdAt);
 if(canonicalJson(r)!==canonicalJson(expected)||s.records.some(x=>x.request.id===r.id))throw new AgentError('CHANGED');s.records.push({request:r,status:'uncertain',finishedAt:null,responseDigest:null,candidates:null,failure:null,retryAt:null});s.revision++;return validateAgentMetadataSession(s);
}
export function finishAgentMetadataQuery(input:AgentMetadataSession,requestId:string,result:{response:AgentMetadataResponse}|{failure:AgentMetadataFailure;retryAt:number|null},at:number=Date.now()):AgentMetadataSession {
 const s=validateAgentMetadataSession(input),r=s.records.at(-1);if(!r||r.request.id!==requestId||r.status!=='uncertain'||!timestamp(at))throw new AgentError('CHANGED');
 r.finishedAt=Math.max(r.request.createdAt,at);
 if('response'in result){const response=validateAgentMetadataResponse(result.response,r.request);r.status='complete';r.responseDigest=response.responseDigest;r.candidates=response.candidates.length;r.finishedAt=Math.max(r.finishedAt,response.receivedAt);s.responses=s.responses.filter(v=>s.records.find(x=>x.request.id===v.requestId)!.request.target.id!==r.request.target.id);s.responses.push(response);}
 else{r.status=result.failure==='ABORTED'?'cancelled':'failed';r.failure=result.failure;r.retryAt=result.retryAt;s.cooldownUntil=Math.max(s.cooldownUntil,result.retryAt??0);}
 s.revision++;return validateAgentMetadataSession(s);
}
export function validateAgentMetadataChoices(input:unknown):AgentMetadataChoice[] {
 inspectAgentJson(input,65536);if(!Array.isArray(input)||!input.length||input.length>16)throw new AgentError('INVALID');const seen=new Set<string>();for(const raw of input){if(!agentObject(raw))throw new AgentError('INVALID');agentOnly(raw,['targetId','requestId','candidateId','fields']);if(!agentUuid.test(String(raw.targetId))||seen.has(String(raw.targetId))||!agentUuid.test(String(raw.requestId))||!agentHash.test(String(raw.candidateId))||!Array.isArray(raw.fields)||!raw.fields.length||raw.fields.length>7||new Set(raw.fields).size!==raw.fields.length||raw.fields.some(f=>!METADATA_FIELDS.includes(f as AgentMetadataField)))throw new AgentError('INVALID');seen.add(String(raw.targetId));}
 return (structuredClone(input) as AgentMetadataChoice[]).map(c=>({...c,fields:METADATA_FIELDS.filter(f=>c.fields.includes(f))})).sort((a,b)=>a.targetId.localeCompare(b.targetId));
}
export function metadataPublicationKey(sessionId:string,choices:unknown):string {if(!agentUuid.test(sessionId))throw new AgentError('INVALID');return reviewFingerprint(['paperquay-metadata-selection-v1',sessionId,validateAgentMetadataChoices(choices)]);}
export function metadataProposalId(key:string):string {if(!agentHash.test(key))throw new AgentError('INVALID');return key.slice(0,8)+'-'+key.slice(8,12)+'-8'+key.slice(13,16)+'-'+((parseInt(key[16],16)&3)|8).toString(16)+key.slice(17,20)+'-'+key.slice(20,32);}
/** Missing external values preserve local data. Subjects become keywords only when explicitly selected. */
export function metadataCandidatePatch(target:AgentTarget,candidate:AgentMetadataCandidate):AgentPatch {
 const data=candidate.data,update=agentCore.metadataUpdateForPaper(agentPaper(target),{title:data.title,authors:data.authors,year:data.year,publication:data.publication,doi:data.doi,abstractText:data.abstractText}),patch:AgentPatch={};
 for(const field of METADATA_FIELDS){if(field==='keywords'){if(data.keywords.length&&canonicalJson(data.keywords)!==canonicalJson(target.data.keywords))patch.keywords=[...data.keywords];}else if(update?.[field]!==undefined)(patch as Record<string,unknown>)[field]=structuredClone(update[field]);}return patch;
}
export function buildAgentMetadataProposal(input:AgentMetadataSession,inputChoices:unknown):AgentProposal {
 const s=validateAgentMetadataSession(input),choices=validateAgentMetadataChoices(inputChoices),key=metadataPublicationKey(s.id,choices),items:AgentProposal['items']=[],targets:AgentTarget[]=[],evidence=[];let createdAt=s.createdAt;
 for(const choice of choices){const target=s.targets.find(t=>t.id===choice.targetId),record=s.records.find(r=>r.request.id===choice.requestId),response=s.responses.find(r=>r.requestId===choice.requestId),candidate=response?.candidates.find(c=>c.id===choice.candidateId);if(!target||!record||record.request.target.id!==target.id||!response||!candidate)throw new AgentError('CHANGED');
  const available=metadataCandidatePatch(target,candidate),patch:AgentPatch={};for(const field of choice.fields){if(!Object.hasOwn(available,field))throw new AgentError('EMPTY');(patch as Record<string,unknown>)[field]=structuredClone(available[field]);}
  targets.push(target);items.push({id:'crossref:'+record.request.id+':'+target.id,targetId:target.id,tool:'metadata',label:'核对 Crossref 题录',description:'由你选择同一文献候选与字段；空白来源字段保留本机内容。',patch});evidence.push(crossrefEvidenceFromCandidate(record.request,response,candidate));createdAt=Math.max(createdAt,response.receivedAt);
 }
 const body={version:1 as const,id:metadataProposalId(key),origin:'metadata' as const,originPlanId:'metadata:'+key,tool:'metadata' as const,title:'核对公开题录补全',description:'根据明确选择的 Crossref 候选补全题录，逐项审批后才修改文库。',createdAt,targets,items};return withAgentProposalEvidence(validateAgentProposal({...body,digest:reviewFingerprint(body)}),evidence);
}
export function markAgentMetadataPublished(input:AgentMetadataSession,key:string,proposal:AgentProposal):AgentMetadataSession {
 const s=validateAgentMetadataSession(input);if(s.publications.some(p=>p.key===key)||s.publications.length>=32||proposal.id!==metadataProposalId(key))throw new AgentError('CHANGED');s.publications.push({key,proposalId:proposal.id,proposalDigest:proposal.digest});s.revision++;return validateAgentMetadataSession(s);
}
export function assertAgentMetadataCurrent(input:AgentMetadataSession,entities:readonly VisibleEntity[]):void {assertAgentTargetsCurrent({targets:input.targets},entities);}
