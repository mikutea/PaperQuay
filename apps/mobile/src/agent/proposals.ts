import { canonicalJson, validateEntityData, type PaperData, type PaperOrganization, type VisibleEntity } from '../../../../packages/sync-core/src/index.ts';
import { createAgentPlanCore, type AgentPlan, type AgentPlanItem, type AgentTool, type AgentPaper, type RenameOperation } from '../../../../packages/agent-core/index.mjs';
import { organizationOf } from '../library/organization.ts';
import { reviewFingerprint } from '../review/fingerprint.ts';

export const AGENT_LIMITS = Object.freeze({ targets:64, targetBytes:1024*1024, proposalBytes:4*1024*1024, receipts:256, classificationWork:32000000 });
export class AgentError extends Error {
  constructor(readonly code:'INVALID'|'LIMIT'|'CHANGED'|'BLOCKED'|'UNSUPPORTED'|'EMPTY'|'PENDING'|'DELETED'|'COMPLEXITY') { super(code); this.name='AgentError'; }
}
export const agentUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const agentHash=/^[0-9a-f]{64}$/;
export const agentCore=createAgentPlanCore();
export interface AgentTarget { id:string; hash:string; revision:number; data:PaperData }
export type AgentPatch=Partial<Pick<PaperData,'title'|'authors'|'year'|'publication'|'doi'|'abstractText'|'keywords'|'organization'>>;
export interface AgentProposalItem { id:string; targetId:string; tool:AgentTool; label:string; description:string; patch:AgentPatch }
export interface AgentProposal { version:1; id:string; origin:'local'|'model'|'metadata'; originPlanId:string; tool:AgentTool; title:string; description:string; createdAt:number; targets:AgentTarget[]; items:AgentProposalItem[]; digest:string }
export function agentObject(v:unknown):v is Record<string,unknown> { return Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))); }
export function agentOnly(v:Record<string,unknown>,keys:readonly string[]):void { if(Reflect.ownKeys(v).some(k=>typeof k!=='string'||!keys.includes(k)))throw new AgentError('INVALID'); }
export function agentText(v:unknown,max:number,required=false):string {
  if(typeof v!=='string'||v.length>max||required&&!v.trim())throw new AgentError('INVALID');
  for(const c of v){const n=c.charCodeAt(0);if(n<32&&![9,10,13].includes(n)||n===127)throw new AgentError('INVALID');}
  try{encodeURIComponent(v);}catch{throw new AgentError('INVALID');}return v;
}
/** Inspect descriptors before serialization, including imported/proposed objects. */
export function inspectAgentJson(value:unknown,maxBytes=AGENT_LIMITS.proposalBytes):void {
  let nodes=0,chars=0;const seen=new Set<object>();
  function visit(v:unknown,depth:number){
    if(++nodes>500000||depth>24)throw new AgentError('LIMIT');
    if(typeof v==='string'){chars+=v.length;if(chars>maxBytes)throw new AgentError('LIMIT');return;}
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
    if(!v||typeof v!=='object'||seen.has(v)||!Array.isArray(v)&&!agentObject(v))throw new AgentError('INVALID');
    seen.add(v);const keys=Reflect.ownKeys(v);
    for(const k of keys){if(Array.isArray(v)&&k==='length')continue;if(typeof k!=='string')throw new AgentError('INVALID');const d=Object.getOwnPropertyDescriptor(v,k)!;if(!d.enumerable||!('value'in d))throw new AgentError('INVALID');if(Array.isArray(v)&&(!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=v.length))throw new AgentError('INVALID');chars+=k.length;if(chars>maxBytes)throw new AgentError('LIMIT');visit(d.value,depth+1);}
    if(Array.isArray(v)&&keys.length!==v.length+1)throw new AgentError('INVALID');seen.delete(v);
  }
  visit(value,0);if(new TextEncoder().encode(JSON.stringify(value)).length>maxBytes)throw new AgentError('LIMIT');
}
function blocked(e:VisibleEntity){return e.deleted||!e.data||['conflict','rejected','device-blocked'].includes(e.status);}
export function agentEntityHash(e:VisibleEntity):string { return reviewFingerprint({id:e.entityId,revision:e.revision,data:e.data,deleted:e.deleted,blocked:blocked(e)}); }
export function captureAgentTargets(entities:readonly VisibleEntity[],ids:readonly string[]):AgentTarget[] {
  inspectAgentJson(ids,16384);if(!ids.length)throw new AgentError('EMPTY');if(ids.length>AGENT_LIMITS.targets)throw new AgentError('LIMIT');if(new Set(ids).size!==ids.length||ids.some(id=>!agentUuid.test(id)))throw new AgentError('INVALID');
  const wanted=new Set(ids),found=new Map<string,VisibleEntity>();for(const e of entities)if(e.entityType==='paper'&&wanted.has(e.entityId)){if(found.has(e.entityId))throw new AgentError('INVALID');found.set(e.entityId,e);}
  const result=ids.map(id=>{const e=found.get(id);if(!e)throw new AgentError('DELETED');if(blocked(e))throw new AgentError(e.deleted?'DELETED':'BLOCKED');inspectAgentJson(e.data,AGENT_LIMITS.targetBytes);if(!validateEntityData('paper',e.data).ok)throw new AgentError('INVALID');return{id,revision:e.revision,hash:agentEntityHash(e),data:structuredClone(e.data as PaperData)};});
  inspectAgentJson(result,AGENT_LIMITS.targetBytes);return result;
}
export function validateCapturedAgentTargets(input:unknown):AgentTarget[] {
  inspectAgentJson(input,AGENT_LIMITS.targetBytes);if(!Array.isArray(input)||!input.length||input.length>AGENT_LIMITS.targets)throw new AgentError('INVALID');const seen=new Set<string>();
  for(const raw of input){if(!agentObject(raw))throw new AgentError('INVALID');agentOnly(raw,['id','hash','revision','data']);if(!agentUuid.test(String(raw.id))||seen.has(String(raw.id))||!agentHash.test(String(raw.hash))||!Number.isSafeInteger(raw.revision)||Number(raw.revision)<0||!validateEntityData('paper',raw.data).ok||raw.hash!==reviewFingerprint({id:raw.id,revision:raw.revision,data:raw.data,deleted:false,blocked:false}))throw new AgentError('INVALID');seen.add(raw.id as string);}
  return structuredClone(input) as AgentTarget[];
}
export function agentPaper(target:AgentTarget):AgentPaper {
  const p=target.data,o=organizationOf(p);return{id:target.id,title:p.title,authors:p.authors.map(name=>({name})),year:p.year??null,publication:p.publication??null,doi:p.doi??null,url:null,abstractText:p.abstractText??null,keywords:[...p.keywords],tags:o.tags.map(name=>({name})),categoryIds:o.collections.map(name=>'name:'+reviewFingerprint(name))};
}
function validTool(v:unknown):v is AgentTool{return['rename','metadata','smart-tags','clean-tags','classify'].includes(String(v));}
function equal(a:unknown,b:unknown){return canonicalJson(a)===canonicalJson(b);}
function patchFor(item:AgentPlanItem,target:AgentTarget):AgentPatch {
  const patch:AgentPatch={},u=item.updateRequest,tool=item.tool;
  if(u){
    if(!agentObject(u)||u.paperId!==target.id)throw new AgentError('INVALID');agentOnly(u,['paperId','title','authors','year','publication','doi','abstractText','keywords','tags','url']);
    if(u.url!==undefined)throw new AgentError('UNSUPPORTED');
    const allowed=tool==='rename'?['title']:tool==='metadata'?['title','authors','year','publication','doi','abstractText','keywords']:tool==='smart-tags'||tool==='clean-tags'?['tags']:[];
    for(const key of Object.keys(u).filter(k=>k!=='paperId'))if(!allowed.includes(key))throw new AgentError('INVALID');
    for(const key of ['title','authors','year','publication','doi','abstractText','keywords']as const)if(u[key]!==undefined)(patch as Record<string,unknown>)[key]=structuredClone(u[key]);
    if(u.tags!==undefined){if(!Array.isArray(u.tags))throw new AgentError('INVALID');patch.organization={...organizationOf(target.data),tags:[...u.tags]};}
  }
  if(tool==='classify'){
    if(u||!item.targetCategoryName)throw new AgentError('INVALID');const name=agentText(item.targetCategoryName,128,true),parent=agentText(item.targetCategoryParentName??'Agent 自动归类',128,true),label=parent+' / '+name;agentText(label,128,true);const org=organizationOf(target.data);patch.organization={...org,collections:org.collections.includes(label)?[...org.collections]:[...org.collections,label]};
  }else if(item.targetCategoryName!==undefined||item.targetCategoryParentName!==undefined)throw new AgentError('INVALID');
  return patch;
}
function validatePatch(item:AgentProposalItem,target:AgentTarget):void {
  if(!agentObject(item.patch))throw new AgentError('INVALID');const allowed=item.tool==='rename'?['title']:item.tool==='metadata'?['title','authors','year','publication','doi','abstractText','keywords']:['organization'];agentOnly(item.patch,allowed);
  if(!Object.keys(item.patch).length)throw new AgentError('EMPTY');const next={...target.data,...structuredClone(item.patch)};if(!validateEntityData('paper',next).ok)throw new AgentError('INVALID');
  if(item.tool==='smart-tags'||item.tool==='clean-tags'||item.tool==='classify'){
    const before=organizationOf(target.data),after=next.organization;if(!after)throw new AgentError('INVALID');const field=item.tool==='classify'?'collections':'tags';const expected={...before,[field]:after[field]};if(!equal(after,expected))throw new AgentError('INVALID');
    if(field==='collections'&&before.collections.some(c=>!after.collections.includes(c)))throw new AgentError('INVALID');
  }
  if(equal(next,target.data))throw new AgentError('EMPTY');
}
export function proposalFromAgentPlan(input:{plan:AgentPlan;targets:AgentTarget[];id?:string;at?:number;origin?:AgentProposal['origin']}):AgentProposal {
  inspectAgentJson(input.plan);inspectAgentJson(input.targets,AGENT_LIMITS.targetBytes);agentOnly(input.plan as unknown as Record<string,unknown>,['id','tool','title','description','items','createdAt']);const targets=structuredClone(input.targets),map=new Map(targets.map(t=>[t.id,t]));
  if(!validTool(input.plan.tool)||!Array.isArray(input.plan.items)||input.plan.items.length>AGENT_LIMITS.targets)throw new AgentError('INVALID');
  const seen=new Set<string>(),items:AgentProposalItem[]=[];
  for(const source of input.plan.items){
    if(!agentObject(source))throw new AgentError('INVALID');agentOnly(source,['id','tool','paperId','paperTitle','title','description','before','after','updateRequest','targetCategoryName','targetCategoryParentName','metadataSource']);
    if(source.tool!==input.plan.tool||seen.has(source.paperId)||!map.has(source.paperId))throw new AgentError('INVALID');seen.add(source.paperId);const target=map.get(source.paperId)!;const item={id:source.id,targetId:target.id,tool:source.tool,label:source.title,description:source.description,patch:patchFor(source,target)};
    if(equal({...target.data,...item.patch},target.data))continue;validatePatch(item,target);items.push(item);
  }
  if(!items.length)throw new AgentError('EMPTY');const value={version:1 as const,id:input.id??crypto.randomUUID(),origin:input.origin??'local',originPlanId:input.plan.id,tool:input.plan.tool,title:input.plan.title,description:input.plan.description,createdAt:input.at??Date.now(),targets,items};return validateAgentProposal({...value,digest:reviewFingerprint(value)});
}
/** Conservative upper bound for the desktop classifier's repeated text comparisons. */
function assertClassificationBudget(papers:AgentPaper[]):void {
  let work=0;for(const paper of papers){
    const text=[paper.title,paper.publication,paper.abstractText,paper.keywords.join(' '),paper.tags.map(t=>t.name).join(' ')].filter(Boolean).join('\n');
    let candidates=8+paper.keywords.length+paper.tags.length;
    for(const _ of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[- ][A-Z]?[A-Za-z0-9]+){0,4}\b/g))candidates++;
    for(const _ of text.matchAll(/[\u4e00-\u9fa5]{2,12}/g))candidates++;
    work+=text.length*candidates;if(work>AGENT_LIMITS.classificationWork)throw new AgentError('COMPLEXITY');
  }
}
export function prepareLocalAgentProposal(entities:readonly VisibleEntity[],ids:readonly string[],tool:Exclude<AgentTool,'metadata'>,operation?:RenameOperation):AgentProposal {
  const targets=captureAgentTargets(entities,ids),papers=targets.map(agentPaper);let plan:AgentPlan;
  if(tool==='rename'){if(!operation)throw new AgentError('INVALID');inspectAgentJson(operation,4096);if(operation.mode==='replace'){agentOnly(operation as unknown as Record<string,unknown>,['mode','from','to']);agentText(operation.from,240,true);agentText(operation.to,240);}else if(operation.mode==='prefix'||operation.mode==='suffix'){agentOnly(operation as unknown as Record<string,unknown>,['mode','value']);agentText(operation.value,240,true);}else throw new AgentError('INVALID');plan=agentCore.buildRenamePlan(papers,operation);}
  else if(tool==='smart-tags')plan=agentCore.buildSmartTagPlan(papers);else if(tool==='clean-tags')plan=agentCore.buildCleanTagsPlan(papers);else if(tool==='classify'){assertClassificationBudget(papers);plan=agentCore.buildAutoClassifyPlan(papers);}else throw new AgentError('INVALID');
  return proposalFromAgentPlan({plan,targets});
}
export function validateAgentProposal(input:unknown):AgentProposal {
  inspectAgentJson(input);if(!agentObject(input))throw new AgentError('INVALID');agentOnly(input,['version','id','origin','originPlanId','tool','title','description','createdAt','targets','items','digest']);
  if(input.version!==1||!agentUuid.test(String(input.id))||!['local','model','metadata'].includes(String(input.origin))||!validTool(input.tool)||!Number.isSafeInteger(input.createdAt)||(input.createdAt as number)<0||!Array.isArray(input.targets)||!input.targets.length||input.targets.length>AGENT_LIMITS.targets||!Array.isArray(input.items)||!input.items.length||input.items.length>AGENT_LIMITS.targets)throw new AgentError('INVALID');
  agentText(input.originPlanId,512,true);agentText(input.title,1000,true);agentText(input.description,4000);
  const targets=new Map<string,AgentTarget>();for(const raw of input.targets){if(!agentObject(raw))throw new AgentError('INVALID');agentOnly(raw,['id','hash','revision','data']);if(!agentUuid.test(String(raw.id))||targets.has(String(raw.id))||!agentHash.test(String(raw.hash))||!Number.isSafeInteger(raw.revision)||(raw.revision as number)<0||!validateEntityData('paper',raw.data).ok)throw new AgentError('INVALID');if(raw.hash!==reviewFingerprint({id:raw.id,revision:raw.revision,data:raw.data,deleted:false,blocked:false}))throw new AgentError('INVALID');targets.set(raw.id as string,raw as unknown as AgentTarget);}inspectAgentJson(input.targets,AGENT_LIMITS.targetBytes);
  const seen=new Set<string>(),seenTargets=new Set<string>();for(const raw of input.items){if(!agentObject(raw))throw new AgentError('INVALID');agentOnly(raw,['id','targetId','tool','label','description','patch']);agentText(raw.id,512,true);agentText(raw.label,1000,true);agentText(raw.description,4000);if(raw.tool!==input.tool||seen.has(raw.id as string)||seenTargets.has(raw.targetId as string)||!targets.has(raw.targetId as string))throw new AgentError('INVALID');seen.add(raw.id as string);seenTargets.add(raw.targetId as string);validatePatch(raw as unknown as AgentProposalItem,targets.get(raw.targetId as string)!);}
  const{digest,...value}=input;if(!agentHash.test(String(digest))||digest!==reviewFingerprint(value))throw new AgentError('INVALID');return structuredClone(input) as unknown as AgentProposal;
}
export function assertAgentTargetsCurrent(proposal:Pick<AgentProposal,'targets'>,entities:readonly VisibleEntity[]):void {
  const wanted=new Set(proposal.targets.map(t=>t.id)),found=new Map<string,VisibleEntity>();for(const e of entities)if(e.entityType==='paper'&&wanted.has(e.entityId)){if(found.has(e.entityId))throw new AgentError('INVALID');found.set(e.entityId,e);}
  for(const target of proposal.targets){const entity=found.get(target.id);if(!entity||entity.deleted)throw new AgentError('DELETED');if(blocked(entity))throw new AgentError('BLOCKED');if(agentEntityHash(entity)!==target.hash)throw new AgentError('CHANGED');}
}
export function agentProposalDiffs(proposal:AgentProposal,itemId:string):{field:string;before:unknown;after:unknown}[]{
  const item=proposal.items.find(i=>i.id===itemId),target=proposal.targets.find(t=>t.id===item?.targetId);if(!item||!target)throw new AgentError('CHANGED');const diffs=[];for(const key of Object.keys(item.patch)as (keyof AgentPatch)[]){if(key==='organization'){const field=item.tool==='classify'?'collections':'tags';diffs.push({field,before:organizationOf(target.data)[field],after:item.patch.organization![field]});}else diffs.push({field:key,before:target.data[key]??null,after:item.patch[key]??null});}return diffs;
}
