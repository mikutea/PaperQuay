import{AgentError,agentObject,agentOnly,agentText,inspectAgentJson}from'./guards.ts';
import{normalizeDoi}from'../library/doiLookup.ts';
export interface AgentMetadataQuery{kind:'doi'|'title';value:string}
export function normalizeAgentMetadataQuery(input:unknown):AgentMetadataQuery{
 inspectAgentJson(input,16384);if(!agentObject(input))throw new AgentError('INVALID');agentOnly(input,['kind','value']);
 if(input.kind==='doi'){try{return{kind:'doi',value:normalizeDoi(agentText(input.value,4096,true))};}catch{throw new AgentError('INVALID');}}
 if(input.kind!=='title')throw new AgentError('INVALID');return{kind:'title',value:agentText(input.value,2048,true).trim().replace(/\s+/gu,' ')};
}
export function agentMetadataQueryUrl(input:AgentMetadataQuery):string{
 const q=normalizeAgentMetadataQuery(input);if(q.kind==='doi'){const url='https://api.crossref.org/works/'+encodeURIComponent(q.value);if(url.length>8192)throw new AgentError('LIMIT');return url;}
 const url=new URL('https://api.crossref.org/works');url.searchParams.set('query.bibliographic',q.value);url.searchParams.set('rows','5');if(url.href.length>8192)throw new AgentError('LIMIT');return url.href;
}
