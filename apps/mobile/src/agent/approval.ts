import{assertAgentReceiptEvidence,selectAgentReceiptEvidence,type AgentEvidence}from'./evidence.ts';
import { canonicalJson, validateEntityData, type VisibleEntity, type PaperData, type LocalEdit, type EditIdentity } from '../../../../packages/sync-core/src/index.ts';
import { reviewFingerprint } from '../review/fingerprint.ts';
import { AgentError, AGENT_LIMITS, agentUuid, agentHash, agentObject, agentOnly, agentText, inspectAgentJson, validateAgentProposal, assertAgentTargetsCurrent, agentProposalDiffs, type AgentProposal } from './proposals.ts';

export interface AgentApproval { version:1; id:string; stateRevision:number; proposalId:string; proposalDigest:string; itemIds:string[]; digest:string }
export interface AgentAppliedChange { itemId:string; paperId:string; opId:string; fields:string[]; beforeHash:string; afterDataHash:string }
export interface AgentReceipt { id:string; digest:string; proposalId:string; proposalDigest:string; origin:AgentProposal['origin']; originPlanId:string; title:string; at:number; changes:AgentAppliedChange[];evidence?:AgentEvidence[] }
export interface AgentState { version:1; revision:number; proposal:AgentProposal|null; receipts:AgentReceipt[] }
export interface AgentApplyResult { receipt:AgentReceipt; replayed:boolean }
const stateBytes=8*1024*1024;
const fields=new Set(['title','authors','year','publication','doi','abstractText','keywords','tags','collections']);
function stamp(v:unknown):boolean{return Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=253402300799999;}
export function agentOperationId(approvalId:string,paperId:string,itemId:string):string {
  if(!agentUuid.test(approvalId)||!agentUuid.test(paperId))throw new AgentError('INVALID');agentText(itemId,512,true);
  const h=reviewFingerprint(['paperquay-agent-approved-put-v1',approvalId,paperId,itemId]);return h.slice(0,8)+'-'+h.slice(8,12)+'-8'+h.slice(13,16)+'-'+((parseInt(h[16],16)&3)|8).toString(16)+h.slice(17,20)+'-'+h.slice(20,32);
}
export function emptyAgentState():AgentState{return{version:1,revision:1,proposal:null,receipts:[]};}
export function validateAgentState(input:unknown):AgentState {
  inspectAgentJson(input,stateBytes);if(!agentObject(input))throw new AgentError('INVALID');agentOnly(input,['version','revision','proposal','receipts']);
  if(input.version!==1||!Number.isSafeInteger(input.revision)||(input.revision as number)<1||!Array.isArray(input.receipts)||input.receipts.length>AGENT_LIMITS.receipts)throw new AgentError('INVALID');
  if(input.proposal!==null)validateAgentProposal(input.proposal);
  const receiptIds=new Set<string>();for(const raw of input.receipts){
    if(!agentObject(raw))throw new AgentError('INVALID');agentOnly(raw,['id','digest','proposalId','proposalDigest','origin','originPlanId','title','at','changes','evidence']);
    if(!agentUuid.test(String(raw.id))||receiptIds.has(raw.id as string)||!agentUuid.test(String(raw.proposalId))||!agentHash.test(String(raw.digest))||!agentHash.test(String(raw.proposalDigest))||!['local','model','metadata'].includes(String(raw.origin))||!stamp(raw.at)||!Array.isArray(raw.changes)||!raw.changes.length||raw.changes.length>AGENT_LIMITS.targets)throw new AgentError('INVALID');receiptIds.add(raw.id as string);agentText(raw.originPlanId,512,true);agentText(raw.title,1000,true);
    const items=new Set<string>(),papers=new Set<string>(),operations=new Set<string>();for(const change of raw.changes){
      if(!agentObject(change))throw new AgentError('INVALID');agentOnly(change,['itemId','paperId','opId','fields','beforeHash','afterDataHash']);agentText(change.itemId,512,true);
      if(items.has(change.itemId as string)||!agentUuid.test(String(change.paperId))||papers.has(change.paperId as string)||!agentUuid.test(String(change.opId))||operations.has(change.opId as string)||change.opId!==agentOperationId(raw.id as string,change.paperId as string,change.itemId as string)||!agentHash.test(String(change.beforeHash))||!agentHash.test(String(change.afterDataHash))||!Array.isArray(change.fields)||!change.fields.length||change.fields.length>fields.size||new Set(change.fields).size!==change.fields.length||change.fields.some(f=>!fields.has(String(f))))throw new AgentError('INVALID');items.add(change.itemId as string);papers.add(change.paperId as string);operations.add(change.opId as string);
    }
    if(raw.evidence!==undefined)assertAgentReceiptEvidence(raw.evidence,raw.origin as AgentReceipt['origin'],raw.originPlanId as string,raw.changes as unknown as AgentAppliedChange[]);
  }
  return structuredClone(input) as unknown as AgentState;
}
export function withAgentProposal(state:AgentState,input:AgentProposal):AgentState {const next=validateAgentState(state);next.proposal=validateAgentProposal(input);next.revision++;return validateAgentState(next);}
export function clearAgentProposal(state:AgentState):AgentState {const next=validateAgentState(state);next.proposal=null;next.revision++;return validateAgentState(next);}
export function prepareAgentApproval(state:AgentState,itemIds:readonly string[],id:string=crypto.randomUUID()):AgentApproval {
  const current=validateAgentState(state),proposal=current.proposal;if(!proposal)throw new AgentError('CHANGED');inspectAgentJson(itemIds,65536);
  if(!Array.isArray(itemIds)||!itemIds.length)throw new AgentError('EMPTY');if(itemIds.length>AGENT_LIMITS.targets||new Set(itemIds).size!==itemIds.length||itemIds.some(item=>!proposal.items.some(i=>i.id===item)))throw new AgentError('INVALID');
  const value={version:1 as const,id,stateRevision:current.revision,proposalId:proposal.id,proposalDigest:proposal.digest,itemIds:[...itemIds].sort()};return validateAgentApproval({...value,digest:reviewFingerprint(value)});
}
export function validateAgentApproval(input:unknown):AgentApproval {
  inspectAgentJson(input,65536);if(!agentObject(input))throw new AgentError('INVALID');agentOnly(input,['version','id','stateRevision','proposalId','proposalDigest','itemIds','digest']);
  if(input.version!==1||!agentUuid.test(String(input.id))||!Number.isSafeInteger(input.stateRevision)||(input.stateRevision as number)<1||!agentUuid.test(String(input.proposalId))||!agentHash.test(String(input.proposalDigest))||!Array.isArray(input.itemIds)||!input.itemIds.length||input.itemIds.length>AGENT_LIMITS.targets||new Set(input.itemIds).size!==input.itemIds.length)throw new AgentError('INVALID');for(const item of input.itemIds)agentText(item,512,true);
  if(canonicalJson(input.itemIds)!==canonicalJson([...input.itemIds].sort()))throw new AgentError('INVALID');const{digest,...value}=input;if(digest!==reviewFingerprint(value))throw new AgentError('INVALID');return structuredClone(input) as unknown as AgentApproval;
}
/** Caller commits these edits, identities and the private receipt in one account transaction. */
export function materializeAgentApproval(input:AgentState,entities:readonly VisibleEntity[],request:AgentApproval,at:number,organizationSupported:boolean):{state:AgentState;edits:LocalEdit[];identities:EditIdentity[];result:AgentApplyResult} {
  const state=validateAgentState(input),approval=validateAgentApproval(request);if(!stamp(at))throw new AgentError('INVALID');
  const receipt=state.receipts.find(r=>r.id===approval.id);
  if(receipt){if(receipt.digest!==approval.digest||receipt.proposalId!==approval.proposalId||receipt.proposalDigest!==approval.proposalDigest||canonicalJson(receipt.changes.map(c=>c.itemId).sort())!==canonicalJson(approval.itemIds))throw new AgentError('CHANGED');return{state:input,edits:[],identities:[],result:{receipt:structuredClone(receipt),replayed:true}};}
  const proposal=state.proposal;if(state.revision!==approval.stateRevision||!proposal||proposal.id!==approval.proposalId||proposal.digest!==approval.proposalDigest)throw new AgentError('CHANGED');assertAgentTargetsCurrent(proposal,entities);
  const targets=new Map(proposal.targets.map(t=>[t.id,t])),current=new Map(entities.filter(e=>e.entityType==='paper'&&targets.has(e.entityId)).map(e=>[e.entityId,e]));
  const edits:LocalEdit[]=[],identities:EditIdentity[]=[],changes:AgentAppliedChange[]=[];
  for(const itemId of approval.itemIds){
    const item=proposal.items.find(i=>i.id===itemId);if(!item)throw new AgentError('INVALID');const target=targets.get(item.targetId)!,entity=current.get(item.targetId)!;
    const data={...structuredClone(entity.data as PaperData),...structuredClone(item.patch)};
    if(data.organization!==undefined&&!organizationSupported)throw new AgentError('UNSUPPORTED');if(!validateEntityData('paper',data).ok)throw new AgentError('INVALID');
    const opId=agentOperationId(approval.id,item.targetId,item.id);edits.push({entityType:'paper',entityId:item.targetId,mutation:'put',data});identities.push({opId,clientCreatedAt:new Date(at).toISOString()});changes.push({itemId:item.id,paperId:item.targetId,opId,fields:agentProposalDiffs(proposal,item.id).map(d=>d.field),beforeHash:target.hash,afterDataHash:reviewFingerprint(data)});
  }
  const saved:AgentReceipt={id:approval.id,digest:approval.digest,proposalId:proposal.id,proposalDigest:proposal.digest,origin:proposal.origin,originPlanId:proposal.originPlanId,title:proposal.title,at,changes,...(proposal.evidence?{evidence:selectAgentReceiptEvidence(proposal.evidence,changes.map(c=>c.paperId))}:{})};// Applying checked items finishes this proposal; unchecked items remain unchanged and require a new reviewed proposal.
  state.proposal=null;state.receipts.push(saved);if(state.receipts.length>AGENT_LIMITS.receipts)state.receipts.shift();state.revision++;return{state:validateAgentState(state),edits,identities,result:{receipt:structuredClone(saved),replayed:false}};
}
