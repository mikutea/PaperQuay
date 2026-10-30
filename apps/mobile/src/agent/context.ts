import type { VisibleEntity } from '../../../../packages/sync-core/src/index.ts';
import type { AccountScope } from '../storage/accountStore.ts';
import type { ParsedCache } from '../parsed/cache.ts';
import { collectResearchSources, type ResearchSelection } from '../research/sources.ts';
import { reviewFingerprint } from '../review/fingerprint.ts';
import { AgentError, agentObject, agentOnly, agentText, agentUuid, agentHash, inspectAgentJson, validateCapturedAgentTargets, assertAgentTargetsCurrent, type AgentTarget } from './proposals.ts';

export const AGENT_CONTEXT_LIMITS=Object.freeze({sources:8,charactersPerSource:4000,totalCharacters:32000});
export interface AgentContext {
  paperId:string;paperHash:string;selection:ResearchSelection;dependencyHash:string;
  kind:'metadata'|'parsed';sha256:string|null;packageDigest:string|null;totalPages:number|null;
  text:string;pages:number[];totalCharacters:number;omittedCharacters:number;digest:string;
}
function sourceDependencies(entities:readonly VisibleEntity[],selection:ResearchSelection):unknown[] {
  return [entities.find(e=>e.entityType==='paper'&&e.entityId===selection.paperId)??null,selection.versionId?entities.find(e=>e.entityType==='attachmentVersion'&&e.entityId===selection.versionId)??null:null];
}
export function agentContextDependencyHash(entities:readonly VisibleEntity[],selection:ResearchSelection):string{return reviewFingerprint(sourceDependencies(entities,selection));}
export function validateAgentContexts(input:unknown,targets:readonly Pick<AgentTarget,'id'|'hash'>[]):AgentContext[]{
  inspectAgentJson(input,256*1024);if(!Array.isArray(input)||input.length>AGENT_CONTEXT_LIMITS.sources)throw new AgentError('LIMIT');
  const seen=new Set<string>(),papers=new Map(targets.map(t=>[t.id,t]));let characters=0;
  for(const c of input){
    if(!agentObject(c))throw new AgentError('INVALID');agentOnly(c,['paperId','paperHash','selection','dependencyHash','kind','sha256','packageDigest','totalPages','text','pages','totalCharacters','omittedCharacters','digest']);
    if(!papers.has(String(c.paperId))||seen.has(String(c.paperId))||c.paperHash!==papers.get(String(c.paperId))!.hash||!agentHash.test(String(c.dependencyHash))||!agentObject(c.selection))throw new AgentError('INVALID');
    seen.add(c.paperId as string);agentOnly(c.selection,['paperId','versionId']);if(c.selection.paperId!==c.paperId||c.selection.versionId!==null&&!agentUuid.test(String(c.selection.versionId)))throw new AgentError('INVALID');
    const text=agentText(c.text,AGENT_CONTEXT_LIMITS.charactersPerSource,true);characters+=text.length;
    if(!Number.isSafeInteger(c.totalCharacters)||Number(c.totalCharacters)<text.length||!Number.isSafeInteger(c.omittedCharacters)||c.omittedCharacters!==Number(c.totalCharacters)-text.length||!Array.isArray(c.pages)||c.pages.length>2000||new Set(c.pages).size!==c.pages.length)throw new AgentError('INVALID');
    if(c.kind==='metadata'){if([c.selection.versionId,c.sha256,c.packageDigest,c.totalPages].some(v=>v!==null)||c.pages.length)throw new AgentError('INVALID');}
    else if(c.kind==='parsed'){if(c.selection.versionId===null||!agentHash.test(String(c.sha256))||!agentHash.test(String(c.packageDigest))||!Number.isSafeInteger(c.totalPages)||Number(c.totalPages)<1||Number(c.totalPages)>2000||!c.pages.length||c.pages.some(p=>!Number.isSafeInteger(p)||p<0||p>=Number(c.totalPages)))throw new AgentError('INVALID');}
    else throw new AgentError('INVALID');
    const {digest,...body}=c;if(!agentHash.test(String(digest))||digest!==reviewFingerprint(body))throw new AgentError('INVALID');
  }
  if(characters>AGENT_CONTEXT_LIMITS.totalCharacters)throw new AgentError('LIMIT');return structuredClone(input) as AgentContext[];
}
/** Only reads the explicitly chosen local metadata or verified cache. Never downloads or substitutes a source. */
export async function collectAgentContexts(options:{entities:readonly VisibleEntity[];targets:readonly AgentTarget[];selections:ResearchSelection[];scope:AccountScope;cache:ParsedCache;signal?:AbortSignal;current():boolean}):Promise<AgentContext[]>{
  const targets=validateCapturedAgentTargets(options.targets),selections=structuredClone(options.selections),entities=structuredClone(options.entities);
  if(!selections.length||selections.length>AGENT_CONTEXT_LIMITS.sources||selections.some(s=>!targets.some(t=>t.id===s.paperId)))throw new AgentError('INVALID');
  assertAgentTargetsCurrent({targets},entities);
  const sources=await collectResearchSources({...options,entities,selections});if(options.signal?.aborted||!options.current())throw new AgentError('CHANGED');
  const contexts=sources.map(source=>{
    const full=source.chunks.map(c=>c.text).join('\n\n');let text=full.slice(0,AGENT_CONTEXT_LIMITS.charactersPerSource);if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
    let offset=0;const pages:number[]=[];for(const chunk of source.chunks){if(offset>=text.length)break;if(chunk.pageIndex!==null&&!pages.includes(chunk.pageIndex))pages.push(chunk.pageIndex);offset+=chunk.text.length+2;}
    const selection=selections.find(s=>s.paperId===source.paperId)!,body={paperId:source.paperId,paperHash:targets.find(t=>t.id===source.paperId)!.hash,selection,dependencyHash:agentContextDependencyHash(entities,selection),kind:source.kind,sha256:source.sha256,packageDigest:source.packageDigest,totalPages:source.totalPages,text,pages,totalCharacters:full.length,omittedCharacters:full.length-text.length};return{...body,digest:reviewFingerprint(body)};
  });const checked=validateAgentContexts(contexts,targets);assertAgentContextsCurrent(checked,entities);return checked;
}
export function assertAgentContextsCurrent(contexts:readonly AgentContext[],entities:readonly VisibleEntity[]):void {
  for(const c of contexts){const deps=sourceDependencies(entities,c.selection) as (VisibleEntity|null)[];if(deps.some((e,i)=>(i===0||c.selection.versionId!==null)&&(!e||e.deleted||!e.data||['conflict','rejected','device-blocked'].includes(e.status)))||c.dependencyHash!==agentContextDependencyHash(entities,c.selection))throw new AgentError('CHANGED');}
}
