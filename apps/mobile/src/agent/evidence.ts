import{canonicalJson}from'../../../../packages/sync-core/src/index.ts';
import{defaultAiProvider,parseAiProvider}from'../ai/provider.ts';
import{reviewFingerprint}from'../review/fingerprint.ts';
import{AgentError,agentObject,agentOnly,agentText,agentUuid,agentHash,inspectAgentJson}from'./guards.ts';
import{normalizeAgentMetadataQuery,agentMetadataQueryUrl,type AgentMetadataQuery}from'./metadataQuery.ts';
import type{DoiLookupWarningCode,DoiLookupResult}from'../library/doiLookup.ts';
import type{AgentConversation,AgentModelTurn}from'./conversation.ts';
import type{AgentTarget}from'./proposals.ts';
import {readRetrievalProvenance,type RetrievalProvenance} from '../retrieval/provenance.ts';

export const AGENT_EVIDENCE_LIMITS=Object.freeze({bytes:512*1024,records:64});
export interface AgentEvidenceTarget{id:string;hash:string;revision:number}
export interface AgentContextEvidence{
 paperId:string;kind:'metadata'|'parsed'|'remote-index';versionId:string|null;pdfHash:string|null;packageDigest:string|null;contextDigest:string;
 pageSetDigest:string;pageCount:number;totalPages:number|null;characters:number;omittedCharacters:number;
 remoteRetrieval?:RetrievalProvenance;
}
export interface AgentModelEvidence{
 version:1;kind:'model';conversationId:string;requestId:string;requestDigest:string;responseDigest:string;startedAt:number;finishedAt:number;
 provider:{id:string;endpoint:string;model:string};targets:AgentEvidenceTarget[];contexts:AgentContextEvidence[];
}
export interface AgentCrossrefEvidence{
 version:1;kind:'crossref';requestId:string;target:AgentEvidenceTarget;query:AgentMetadataQuery;apiUrl:string;receivedAt:number;
 doi:string;dataDigest:string;recordDigest:string;responseDigest:string;
 yearField:DoiLookupResult['source']['yearField'];warnings:DoiLookupResult['warnings'];
}
export type AgentEvidence=AgentModelEvidence|AgentCrossrefEvidence;
const warningCodes:Record<DoiLookupWarningCode,true>={TITLE_ALTERNATIVES_OMITTED:true,SUBTITLE_OMITTED:true,TEXT_FORMATTING_REMOVED:true,AUTHORS_MISSING:true,AUTHORS_INCOMPLETE:true,AFFILIATIONS_OMITTED:true,YEAR_MISSING:true,YEAR_INVALID:true,YEAR_FALLBACK:true,YEAR_CONFLICT:true,PUBLICATION_MISSING:true,PUBLICATION_ALTERNATIVES_OMITTED:true,ABSTRACT_MISSING:true,ABSTRACT_UNSUPPORTED:true,SUBJECTS_AS_KEYWORDS:true,ADDITIONAL_METADATA_OMITTED:true};
function object(v:unknown,keys:readonly string[]):Record<string,unknown>{if(!agentObject(v))throw new AgentError('INVALID');agentOnly(v,keys);return v;}
function integer(v:unknown,min:number,max=Number.MAX_SAFE_INTEGER):number{if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)throw new AgentError('INVALID');return Number(v);}
function uuid(v:unknown):string{if(typeof v!=='string'||!agentUuid.test(v))throw new AgentError('INVALID');return v;}
function hash(v:unknown):string{if(typeof v!=='string'||!agentHash.test(v))throw new AgentError('INVALID');return v;}
function target(v:unknown):AgentEvidenceTarget{const t=object(v,['id','hash','revision']);return{id:uuid(t.id),hash:hash(t.hash),revision:integer(t.revision,0)};}
function provider(v:unknown){const p=object(v,['id','endpoint','model']);try{const parsed=parseAiProvider({...defaultAiProvider(),id:agentText(p.id,128,true),endpoint:agentText(p.endpoint,2048,true),model:agentText(p.model,160,true)},true);const safe={id:parsed.id,endpoint:parsed.endpoint,model:parsed.model};if(canonicalJson(safe)!==canonicalJson(p))throw new AgentError('INVALID');return safe;}catch{throw new AgentError('INVALID');}}
/** Durable source summaries; full request/context text stays in the explicitly exported conversation or metadata session. */
export function validateAgentEvidence(input:unknown):AgentEvidence[]{
 inspectAgentJson(input,AGENT_EVIDENCE_LIMITS.bytes);if(!Array.isArray(input)||!input.length||input.length>AGENT_EVIDENCE_LIMITS.records)throw new AgentError('LIMIT');const requestIds=new Set<string>();
 for(const raw of input){
  if(!agentObject(raw)||raw.version!==1)throw new AgentError('INVALID');uuid(raw.requestId);if(requestIds.has(raw.requestId as string))throw new AgentError('INVALID');requestIds.add(raw.requestId as string);
  if(raw.kind==='model'){
   agentOnly(raw,['version','kind','conversationId','requestId','requestDigest','responseDigest','startedAt','finishedAt','provider','targets','contexts']);uuid(raw.conversationId);hash(raw.requestDigest);hash(raw.responseDigest);integer(raw.startedAt,0,253402300799999);integer(raw.finishedAt,Number(raw.startedAt),253402300799999);provider(raw.provider);
   if(!Array.isArray(raw.targets)||!raw.targets.length||raw.targets.length>64||!Array.isArray(raw.contexts)||raw.contexts.length>8)throw new AgentError('INVALID');const known=new Set<string>();for(const value of raw.targets){const t=target(value);if(known.has(t.id))throw new AgentError('INVALID');known.add(t.id);}const seen=new Set<string>();
   for(const value of raw.contexts){const c=object(value,['paperId','kind','versionId','pdfHash','packageDigest','contextDigest','pageSetDigest','pageCount','totalPages','characters','omittedCharacters','remoteRetrieval']);const id=uuid(c.paperId);if(!known.has(id)||seen.has(id))throw new AgentError('INVALID');seen.add(id);hash(c.contextDigest);hash(c.pageSetDigest);integer(c.characters,1,4000);integer(c.omittedCharacters,0,c.kind==='remote-index'?2020000:200000);integer(c.pageCount,0,2000);
    if(c.kind==='metadata'){if([c.versionId,c.pdfHash,c.packageDigest,c.totalPages].some(v=>v!==null)||c.pageCount!==0||c.pageSetDigest!==reviewFingerprint([]))throw new AgentError('INVALID');}
    else if(c.kind==='parsed'||c.kind==='remote-index'){uuid(c.versionId);hash(c.pdfHash);hash(c.packageDigest);integer(c.totalPages,1,2000);if(Number(c.pageCount)<1||Number(c.pageCount)>Number(c.totalPages))throw new AgentError('INVALID');}else throw new AgentError('INVALID');
    if(c.kind==='remote-index'){const proof=readRetrievalProvenance(c.remoteRetrieval),pages=[...new Set(proof.evidence.map(row=>row.pageIndex))];
      if(proof.source.target.paperId!==id||proof.source.target.attachmentVersionId!==c.versionId||proof.source.target.sha256!==c.pdfHash||proof.source.parseDigest!==c.packageDigest||proof.source.target.pageCount!==c.totalPages
        ||pages.length!==c.pageCount||reviewFingerprint(pages)!==c.pageSetDigest||proof.evidence.reduce((n,row)=>n+row.excerptCharacters,0)+2*(proof.evidence.length-1)!==c.characters
        ||Number(c.characters)+Number(c.omittedCharacters)!==proof.source.textCharacters+2*(proof.source.chunkCount-1))throw new AgentError('INVALID');
    }else if(c.remoteRetrieval!==undefined)throw new AgentError('INVALID');
   }
  }else if(raw.kind==='crossref'){
   agentOnly(raw,['version','kind','requestId','target','query','apiUrl','receivedAt','doi','dataDigest','recordDigest','responseDigest','yearField','warnings']);target(raw.target);const q=normalizeAgentMetadataQuery(raw.query);if(canonicalJson(q)!==canonicalJson(raw.query)||raw.apiUrl!==agentMetadataQueryUrl(q))throw new AgentError('INVALID');integer(raw.receivedAt,0,253402300799999);hash(raw.dataDigest);hash(raw.recordDigest);hash(raw.responseDigest);const doi=normalizeAgentMetadataQuery({kind:'doi',value:raw.doi}).value;if(doi!==raw.doi||q.kind==='doi'&&q.value!==doi)throw new AgentError('INVALID');
   if(raw.yearField!==null&&!['issued','published','published-print','published-online'].includes(String(raw.yearField))||!Array.isArray(raw.warnings)||raw.warnings.length>32)throw new AgentError('INVALID');for(const value of raw.warnings){const w=object(value,['code','field']);if(typeof w.code!=='string'||!Object.hasOwn(warningCodes,w.code)||w.field!==undefined&&!['title','authors','year','publication','abstractText','keywords'].includes(String(w.field)))throw new AgentError('INVALID');}
  }else throw new AgentError('INVALID');
 }
 return structuredClone(input)as AgentEvidence[];
}
export function agentEvidenceTargets(evidence:AgentEvidence):AgentEvidenceTarget[]{return evidence.kind==='model'?evidence.targets:[evidence.target];}
export function assertAgentEvidenceMatches(input:AgentEvidence[],origin:'local'|'model'|'metadata',originPlanId:string,targets:readonly AgentTarget[],itemTargetIds:readonly string[]):void{
 const records=validateAgentEvidence(input),known=new Map(targets.map(t=>[t.id,t]));if(origin==='local'||origin==='model'&&(records.length!==1||records[0].kind!=='model')||origin==='metadata'&&records.some(e=>e.kind!=='crossref'))throw new AgentError('INVALID');
 for(const record of records)for(const t of agentEvidenceTargets(record)){const original=known.get(t.id);if(!original||original.hash!==t.hash||original.revision!==t.revision)throw new AgentError('INVALID');}
 if(origin==='model'){const e=records[0]as AgentModelEvidence;if(originPlanId!=='model:'+e.requestId||e.targets.length!==targets.length||new Set(e.targets.map(t=>t.id)).size!==targets.length)throw new AgentError('INVALID');}
 else{const ids=records.map(e=>(e as AgentCrossrefEvidence).target.id);if(new Set(ids).size!==ids.length||canonicalJson([...ids].sort())!==canonicalJson([...itemTargetIds].sort()))throw new AgentError('INVALID');}
}
export function modelEvidenceFromTurn(conversation:AgentConversation,turn:AgentModelTurn):AgentModelEvidence{
 if(turn.status!=='complete'||turn.request.conversationId!==conversation.id)throw new AgentError('INVALID');const request=turn.request;
 return validateAgentEvidence([{version:1,kind:'model',conversationId:conversation.id,requestId:request.id,requestDigest:request.digest,responseDigest:reviewFingerprint(turn.text),startedAt:turn.startedAt,finishedAt:turn.finishedAt,provider:{id:turn.provider.id,endpoint:turn.provider.endpoint,model:turn.provider.model},targets:request.targets.map(({id,hash,revision})=>({id,hash,revision})),contexts:request.contexts.map(c=>({paperId:c.paperId,kind:c.kind,versionId:c.selection.versionId,pdfHash:c.sha256,packageDigest:c.packageDigest,contextDigest:c.digest,pageSetDigest:reviewFingerprint(c.pages),pageCount:c.pages.length,totalPages:c.totalPages,characters:c.text.length,omittedCharacters:c.omittedCharacters,...(c.remoteRetrieval?{remoteRetrieval:c.remoteRetrieval}:{})}))}])[0]as AgentModelEvidence;
}

export function assertAgentReceiptEvidence(input:unknown,origin:'local'|'model'|'metadata',originPlanId:string,changes:readonly{paperId:string;beforeHash:string}[]):void{
 const records=validateAgentEvidence(input);if(origin==='local'||origin==='model'&&(records.length!==1||records[0].kind!=='model')||origin==='metadata'&&records.some(e=>e.kind!=='crossref'))throw new AgentError('INVALID');
 const sources=new Map(records.flatMap(r=>agentEvidenceTargets(r).map(t=>[t.id,t]as const)));for(const c of changes)if(sources.get(c.paperId)?.hash!==c.beforeHash)throw new AgentError('INVALID');
 if(origin==='model'){if(originPlanId!=='model:'+(records[0]as AgentModelEvidence).requestId)throw new AgentError('INVALID');}
 else if(canonicalJson(records.map(e=>(e as AgentCrossrefEvidence).target.id).sort())!==canonicalJson(changes.map(c=>c.paperId).sort()))throw new AgentError('INVALID');
}
export function selectAgentReceiptEvidence(input:AgentEvidence[],paperIds:readonly string[]):AgentEvidence[]{return validateAgentEvidence(input.filter(e=>e.kind==='model'||paperIds.includes(e.target.id)));}
