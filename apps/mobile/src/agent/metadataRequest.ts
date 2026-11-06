import{canonicalJson}from'../../../../packages/sync-core/src/index.ts';
import{AgentError,agentObject,agentOnly,agentUuid,agentHash,inspectAgentJson}from'./guards.ts';
import{normalizeAgentMetadataQuery,agentMetadataQueryUrl,type AgentMetadataQuery}from'./metadataQuery.ts';
import{reviewFingerprint}from'../review/fingerprint.ts';
import type{AgentEvidenceTarget}from'./evidence.ts';
export interface AgentMetadataRequest{version:1;id:string;sessionId:string;target:AgentEvidenceTarget;query:AgentMetadataQuery;apiUrl:string;createdAt:number;digest:string}
export function validateAgentMetadataRequest(input:unknown):AgentMetadataRequest{
 inspectAgentJson(input,32768);if(!agentObject(input))throw new AgentError('INVALID');agentOnly(input,['version','id','sessionId','target','query','apiUrl','createdAt','digest']);
 if(input.version!==1||!agentUuid.test(String(input.id))||!agentUuid.test(String(input.sessionId))||!Number.isSafeInteger(input.createdAt)||Number(input.createdAt)<0||Number(input.createdAt)>253402300799999||!agentObject(input.target))throw new AgentError('INVALID');agentOnly(input.target,['id','hash','revision']);if(!agentUuid.test(String(input.target.id))||!agentHash.test(String(input.target.hash))||!Number.isSafeInteger(input.target.revision)||Number(input.target.revision)<0)throw new AgentError('INVALID');
 const query=normalizeAgentMetadataQuery(input.query);if(canonicalJson(query)!==canonicalJson(input.query)||input.apiUrl!==agentMetadataQueryUrl(query))throw new AgentError('INVALID');const{digest,...body}=input;if(!agentHash.test(String(digest))||digest!==reviewFingerprint(body))throw new AgentError('INVALID');return structuredClone(input)as unknown as AgentMetadataRequest;
}
export function prepareAgentMetadataRequest(sessionId:string,target:AgentEvidenceTarget,input:AgentMetadataQuery,id:string=crypto.randomUUID(),at:number=Date.now()):AgentMetadataRequest{
 const query=normalizeAgentMetadataQuery(input),body={version:1 as const,id,sessionId,target:{id:target.id,hash:target.hash,revision:target.revision},query,apiUrl:agentMetadataQueryUrl(query),createdAt:at};return validateAgentMetadataRequest({...body,digest:reviewFingerprint(body)});
}
