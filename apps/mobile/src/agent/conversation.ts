import { canonicalJson, type VisibleEntity } from '../../../../packages/sync-core/src/index.ts';
import { parseAiProvider } from '../ai/provider.ts';
import type { AiProviderConfig, AiUsage } from '../ai/types.ts';
import { AgentError, agentObject, agentOnly, agentText, agentUuid, inspectAgentJson, validateCapturedAgentTargets, assertAgentTargetsCurrent, type AgentTarget } from './proposals.ts';
import { assertAgentContextsCurrent, validateAgentContexts, type AgentContext } from './context.ts';
import { AGENT_MODEL_LIMITS, prepareAgentModelRequest, validateAgentModelRequest, parseAgentModelResponse, sameAgentModelRequest, type AgentModelRequest, type AgentHistoryEntry, type AgentModelTool } from './modelProtocol.ts';

export interface AgentModelTurn {
 id:string;request:AgentModelRequest;provider:AiProviderConfig;status:'uncertain'|'complete'|'failed'|'cancelled'|'invalid';
 startedAt:number;finishedAt:number|null;text:string;outputClipped:boolean;outputNormalized?:true;usage:AiUsage|null;failure:'transport'|'cancelled'|'invalid'|'limit'|null;proposalSaved:boolean;
}
export interface AgentConversation {version:1;id:string;revision:number;createdAt:number;targets:AgentTarget[];contexts:AgentContext[];turns:AgentModelTurn[]}
function timestamp(v:unknown){return Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=253402300799999;}
export function validateAgentUsage(input:unknown):AiUsage|null {
 if(input===null)return null;if(!agentObject(input))throw new AgentError('INVALID');agentOnly(input,['promptTokens','completionTokens','totalTokens']);const n=['promptTokens','completionTokens','totalTokens'].map(k=>input[k]);if(n.some(v=>!Number.isSafeInteger(v)||Number(v)<0||Number(v)>1000000000)||Number(n[2])!==Number(n[0])+Number(n[1]))throw new AgentError('INVALID');return structuredClone(input) as unknown as AiUsage;
}
export function agentConversationHistory(turns:readonly AgentModelTurn[]):AgentHistoryEntry[]{
 if(turns.some(t=>t.status==='uncertain'))throw new AgentError('PENDING');return turns.map(t=>({instruction:t.request.instruction,text:t.text,status:t.status as AgentHistoryEntry['status']}));
}
export function validateAgentConversation(input:unknown):AgentConversation {
 inspectAgentJson(input,AGENT_MODEL_LIMITS.conversationBytes);if(!agentObject(input))throw new AgentError('INVALID');agentOnly(input,['version','id','revision','createdAt','targets','contexts','turns']);
 if(input.version!==1||!agentUuid.test(String(input.id))||!Number.isSafeInteger(input.revision)||Number(input.revision)<1||!timestamp(input.createdAt)||!Array.isArray(input.turns)||input.turns.length>AGENT_MODEL_LIMITS.turns)throw new AgentError('INVALID');const targets=validateCapturedAgentTargets(input.targets);validateAgentContexts(input.contexts,targets);const seen=new Set<string>(),prior:AgentModelTurn[]=[];
 for(let i=0;i<input.turns.length;i++){
  const t=input.turns[i];if(!agentObject(t))throw new AgentError('INVALID');agentOnly(t,['id','request','provider','status','startedAt','finishedAt','text','outputClipped','outputNormalized','usage','failure','proposalSaved']);
  const request=validateAgentModelRequest(t.request);if(t.id!==request.id||seen.has(request.id)||request.conversationId!==input.id||canonicalJson(request.targets)!==canonicalJson(targets)||canonicalJson(request.history)!==canonicalJson(agentConversationHistory(prior))||t.startedAt!==request.createdAt||!timestamp(t.startedAt)||!['uncertain','complete','failed','cancelled','invalid'].includes(String(t.status))||typeof t.outputClipped!=='boolean'||typeof t.proposalSaved!=='boolean')throw new AgentError('INVALID');seen.add(request.id);
  const config=parseAiProvider(t.provider,true);if(canonicalJson(config)!==canonicalJson(t.provider))throw new AgentError('INVALID');agentText(t.text,AGENT_MODEL_LIMITS.outputCharacters);if(new TextEncoder().encode(t.text as string).length>AGENT_MODEL_LIMITS.outputBytes)throw new AgentError('LIMIT');validateAgentUsage(t.usage);
  if(t.outputNormalized!==undefined&&t.outputNormalized!==true||t.outputNormalized&&['uncertain','complete'].includes(String(t.status)))throw new AgentError('INVALID');
  if(t.failure!==null&&!['transport','cancelled','invalid','limit'].includes(String(t.failure)))throw new AgentError('INVALID');
  if(t.status==='uncertain'){if(i!==input.turns.length-1||t.finishedAt!==null||t.text!==''||t.usage!==null||t.failure!==null||t.outputClipped||t.proposalSaved)throw new AgentError('INVALID');}
  else if(!timestamp(t.finishedAt)||Number(t.finishedAt)<Number(t.startedAt))throw new AgentError('INVALID');
  if(t.status==='complete'){if(t.outputClipped||t.failure!==null)throw new AgentError('INVALID');const response=parseAgentModelResponse(t.text as string,request);if(t.proposalSaved&&response.kind!=='plan')throw new AgentError('INVALID');}
  else if(t.proposalSaved||t.status!=='uncertain'&&t.failure===null||t.status==='cancelled'&&t.failure!=='cancelled')throw new AgentError('INVALID');
  prior.push(t as unknown as AgentModelTurn);
 }
 return structuredClone(input) as unknown as AgentConversation;
}
export function createAgentConversation(targets:AgentTarget[],id:string=crypto.randomUUID(),at:number=Date.now()):AgentConversation{return validateAgentConversation({version:1,id,revision:1,createdAt:at,targets,contexts:[],turns:[]});}
export function assertAgentConversationCurrent(conversation:AgentConversation,entities:readonly VisibleEntity[]):void {
 // The same captured target identity used by approval is retained throughout this conversation.
 assertAgentTargetsCurrent({targets:conversation.targets},entities);assertAgentContextsCurrent(conversation.contexts,entities);
}
export function prepareAgentConversationRequest(input:AgentConversation,instruction:string,tool:AgentModelTool='auto',id:string=crypto.randomUUID(),at:number=Date.now()):AgentModelRequest {
 const c=validateAgentConversation(input);if(c.turns.length>=AGENT_MODEL_LIMITS.turns)throw new AgentError('LIMIT');return prepareAgentModelRequest({conversationId:c.id,targets:c.targets,contexts:c.contexts,history:agentConversationHistory(c.turns),instruction,tool,id,createdAt:at});
}
export function beginAgentModelTurn(input:AgentConversation,requestInput:AgentModelRequest,providerInput:AiProviderConfig):AgentConversation {
 const c=validateAgentConversation(input),request=validateAgentModelRequest(requestInput),provider=parseAiProvider(providerInput,true);
 if(c.turns.some(t=>t.id===request.id)||!sameAgentModelRequest(request,prepareAgentConversationRequest(c,request.instruction,request.tool,request.id,request.createdAt)))throw new AgentError('CHANGED');
 c.turns.push({id:request.id,request,provider,status:'uncertain',startedAt:request.createdAt,finishedAt:null,text:'',outputClipped:false,usage:null,failure:null,proposalSaved:false});c.revision++;return validateAgentConversation(c);
}
/** Retains a bounded diagnostic excerpt if an interrupted/oversized response cannot be accepted. Never parses a clipped output. */
export function finishAgentModelTurn(input:AgentConversation,id:string,result:{text:string;usage:AiUsage|null;failure:'transport'|'cancelled'|'invalid'|'limit'|null},at:number=Date.now()):AgentConversation {
 const c=validateAgentConversation(input),t=c.turns.at(-1);if(!t||t.id!==id||t.status!=='uncertain')throw new AgentError('CHANGED');if(!timestamp(at)||typeof result.text!=='string')throw new AgentError('INVALID');
 let bytes=0,text='',normalized=false;for(const original of result.text){const code=original.charCodeAt(0),invalid=original.length===1&&(code>=0xd800&&code<=0xdfff||code<32&&![9,10,13].includes(code)||code===127),char=invalid?String.fromCharCode(0xfffd):original,size=new TextEncoder().encode(char).length;if(text.length+char.length>AGENT_MODEL_LIMITS.outputCharacters||bytes+size>AGENT_MODEL_LIMITS.outputBytes)break;if(invalid)normalized=true;text+=char;bytes+=size;}
 t.text=text;if(normalized)t.outputNormalized=true;t.outputClipped=text.length!==result.text.length;t.usage=validateAgentUsage(result.usage);t.finishedAt=Math.max(at,t.startedAt);t.failure=result.failure;t.status=result.failure==='cancelled'?'cancelled':result.failure?'failed':'complete';
 if(t.outputClipped){t.status='invalid';t.failure='limit';}else if(normalized&&t.status==='complete'){t.status='invalid';t.failure='invalid';}else if(t.status==='complete'){try{parseAgentModelResponse(text,t.request);}catch{t.status='invalid';t.failure='invalid';}}
 c.revision++;return validateAgentConversation(c);
}
export function approveAgentContextRequest(input:AgentConversation,contextsInput:AgentContext[]):AgentConversation {
 const c=validateAgentConversation(input),turn=c.turns.at(-1);if(!turn||turn.status!=='complete')throw new AgentError('CHANGED');const response=parseAgentModelResponse(turn.text,turn.request);if(response.kind!=='context-request')throw new AgentError('INVALID');
 const contexts=validateAgentContexts(contextsInput,c.targets),ids=contexts.map(v=>v.paperId).sort();if(canonicalJson(ids)!==canonicalJson([...response.paperIds].sort()))throw new AgentError('INVALID');
 const replacement=new Map(contexts.map(v=>[v.paperId,v]));for(const old of c.contexts)if(!replacement.has(old.paperId))replacement.set(old.paperId,old);c.contexts=validateAgentContexts([...replacement.values()],c.targets);c.revision++;return validateAgentConversation(c);
}
export function agentChoiceInstruction(input:AgentConversation,choiceId:string):string {
 const c=validateAgentConversation(input),t=c.turns.at(-1);if(!t||t.status!=='complete')throw new AgentError('CHANGED');const response=parseAgentModelResponse(t.text,t.request);if(response.kind!=='choice-request')throw new AgentError('INVALID');const choice=response.options.find(o=>o.id===choiceId);if(!choice)throw new AgentError('INVALID');return choice.instruction;
}
