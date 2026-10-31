import{canonicalJson,validateRecord}from'./validation.ts';
import{UUID_PATTERN,SYNC_LIMITS}from'./schema.ts';
import{validateGraphRelationData,validateGraphEntityRef,type GraphEntityRef,type GraphRelationData}from'./graphRelation.ts';
import type{SyncRecord}from'./types.ts';
export const DESKTOP_GRAPH_LIMITS=Object.freeze({mappings:4096,sourceRelations:2000,selected:512,privateBytes:16*1024*1024,pullPages:64,pushPerRun:32});
export interface DesktopGraphScope{serviceKey:string;accountId:string;libraryBindingId:string}
export interface DesktopGraphMaterialBinding{entityType:'paper'|'note';localId:string;entityId:string}
export interface DesktopGraphMappingBlock{entityType:'paper'|'note';localId:string;code:'MISSING_LOCAL_MATERIAL'|'AMBIGUOUS_LOCAL_MAPPING'|'AMBIGUOUS_ACCOUNT_MAPPING'}
export interface DesktopGraphMapping{readonly scope:Readonly<DesktopGraphScope>;readonly bindings:readonly Readonly<DesktopGraphMaterialBinding>[];readonly blocked:readonly Readonly<DesktopGraphMappingBlock>[];/** Private equality value; never log or send it as a URL/HTTP field. */readonly identity:string}
export class DesktopGraphError extends Error{readonly code:'INVALID_GRAPH_MAPPING'|'GRAPH_MAPPING_CHANGED'|'INVALID_DESKTOP_GRAPH_RELATION'|'UNMAPPED_GRAPH_ENDPOINT'|'GRAPH_LIMIT'|'GRAPH_STATE_INVALID'|'GRAPH_STATE_FULL'|'GRAPH_PENDING';constructor(code:DesktopGraphError['code']){super(code);this.name='DesktopGraphError';this.code=code;}}
const uuid=new RegExp(UUID_PATTERN),fail=(code:DesktopGraphError['code']):never=>{throw new DesktopGraphError(code);};
const localId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&v.trim()===v&&!/[\\/\x00-\x1f\x7f]/.test(v)&&!/^(?:(?:file|https?|standalone):|[a-z]:)/i.test(v);
function object(value:unknown,required:readonly string[],allowed=required):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail('INVALID_GRAPH_MAPPING');
 const d=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(value).some(k=>typeof k!=='string'||!allowed.includes(k))||required.some(k=>!Object.hasOwn(d,k))||Object.values(d).some(v=>!v.enumerable||!('value'in v)))return fail('INVALID_GRAPH_MAPPING');return value as Record<string,unknown>;
}
function list(value:unknown,max:number):unknown[]{
 if(!Array.isArray(value)||value.length>max)return fail('GRAPH_LIMIT');
 const keys=Reflect.ownKeys(value),d=Object.getOwnPropertyDescriptors(value);if(keys.length!==value.length+1||Object.keys(value).some((k,i)=>k!==String(i))||Object.entries(d).some(([k,v])=>k!=='length'&&(!v.enumerable||!('value'in v))))return fail('INVALID_GRAPH_MAPPING');return value;
}
function scope(value:unknown):DesktopGraphScope{const v=object(value,['serviceKey','accountId','libraryBindingId']);if(typeof v.serviceKey!=='string'||!/^[0-9a-f]{64}$/.test(v.serviceKey)||typeof v.accountId!=='string'||!uuid.test(v.accountId)||typeof v.libraryBindingId!=='string'||!uuid.test(v.libraryBindingId))return fail('INVALID_GRAPH_MAPPING');return{serviceKey:v.serviceKey,accountId:v.accountId,libraryBindingId:v.libraryBindingId};}
const typedKey=(type:string,id:string)=>JSON.stringify([type,id]);
const indexes=new WeakMap<object,{local:Map<string,string>;remote:Map<string,string>}>();
/** Runtime supplies bindings from its current verified private account/library
 * state. This does not infer or verify a binding from a title, path or UUID. */
export function createDesktopGraphMapping(input:{scope:DesktopGraphScope;bindings:readonly DesktopGraphMaterialBinding[];live:{paperIds:readonly string[];noteIds:readonly string[]}}):DesktopGraphMapping{
 const v=object(input,['scope','bindings','live']),owner=scope(v.scope),live=object(v.live,['paperIds','noteIds']);
 const active={paper:new Set(list(live.paperIds,SYNC_LIMITS.maxLocalEntities).filter(localId)),note:new Set(list(live.noteIds,SYNC_LIMITS.maxLocalEntities).filter(localId))};
 const candidates:DesktopGraphMaterialBinding[]=[],seenMappings=new Set<string>(),forward=new Map<string,Set<string>>(),reverse=new Map<string,Set<string>>();
 for(const raw of list(v.bindings,DESKTOP_GRAPH_LIMITS.mappings)){
  const row=object(raw,['entityType','localId','entityId']);if((row.entityType!=='paper'&&row.entityType!=='note')||!localId(row.localId)||typeof row.entityId!=='string'||!uuid.test(row.entityId))return fail('INVALID_GRAPH_MAPPING');
  const entry={entityType:row.entityType,localId:row.localId,entityId:row.entityId} as DesktopGraphMaterialBinding,lk=typedKey(entry.entityType,entry.localId),rk=typedKey(entry.entityType,entry.entityId);
  const exact=canonicalJson(entry);if(seenMappings.has(exact))continue;seenMappings.add(exact);
  candidates.push(entry);if(!active[entry.entityType].has(entry.localId))continue;const targets=forward.get(lk)??new Set<string>();targets.add(entry.entityId);forward.set(lk,targets);const sources=reverse.get(rk)??new Set<string>();sources.add(entry.localId);reverse.set(rk,sources);
 }
 const bindings:DesktopGraphMaterialBinding[]=[],blocked:DesktopGraphMappingBlock[]=[],seenBlocks=new Set<string>();
 for(const entry of candidates){let code:DesktopGraphMappingBlock['code']|null=null;
  if(!active[entry.entityType].has(entry.localId))code='MISSING_LOCAL_MATERIAL';
  else if(forward.get(typedKey(entry.entityType,entry.localId))!.size!==1)code='AMBIGUOUS_LOCAL_MAPPING';
  else if(reverse.get(typedKey(entry.entityType,entry.entityId))!.size!==1)code='AMBIGUOUS_ACCOUNT_MAPPING';
  if(code){const key=typedKey(entry.entityType,entry.localId);if(!seenBlocks.has(key)){blocked.push({entityType:entry.entityType,localId:entry.localId,code});seenBlocks.add(key);}}else bindings.push(entry);
 }
 const order=(a:unknown,b:unknown)=>{const x=canonicalJson(a),y=canonicalJson(b);return x<y?-1:x>y?1:0;};bindings.sort(order);blocked.sort(order);
 const local=new Map<string,string>(),remote=new Map<string,string>();for(const b of bindings){local.set(typedKey(b.entityType,b.localId),b.entityId);remote.set(typedKey(b.entityType,b.entityId),b.localId);}
 const result=Object.freeze({scope:Object.freeze(owner),bindings:Object.freeze(bindings.map(b=>Object.freeze(b))),blocked:Object.freeze(blocked.map(b=>Object.freeze(b))),identity:canonicalJson({scope:owner,bindings})});indexes.set(result,{local,remote});return result;
}
function mappingIndex(mapping:DesktopGraphMapping,expected:DesktopGraphScope){const index=indexes.get(mapping);if(!index)return fail('INVALID_GRAPH_MAPPING');if(canonicalJson(mapping.scope)!==canonicalJson(scope(expected)))return fail('GRAPH_MAPPING_CHANGED');return index;}
const localRef=(raw:unknown):{entityType:'paper'|'note';localId:string}=>{
 if(typeof raw!=='string')return fail('INVALID_DESKTOP_GRAPH_RELATION');const entityType=raw.startsWith('paper:')?'paper':raw.startsWith('note:')?'note':null;if(!entityType)return fail('UNMAPPED_GRAPH_ENDPOINT');const id=raw.slice(entityType.length+1);if(!localId(id))return fail('UNMAPPED_GRAPH_ENDPOINT');return{entityType,localId:id};
};
export interface ProjectedDesktopGraphRelation{localRelationId:string;data:GraphRelationData}
export function desktopGraphRelationToWire(raw:unknown,mapping:DesktopGraphMapping,expected:DesktopGraphScope):ProjectedDesktopGraphRelation{
 const index=mappingIndex(mapping,expected);
 try{
  const v=object(raw,['id','source','target','type','label','weight','createdAt'],['id','source','target','type','label','description','confidence','weight','createdAt','updatedAt']);if(!localId(v.id))return fail('INVALID_DESKTOP_GRAPH_RELATION');
  const bind=(value:unknown):GraphEntityRef=>{const ref=localRef(value),entityId=index.local.get(typedKey(ref.entityType,ref.localId));if(!entityId)return fail('UNMAPPED_GRAPH_ENDPOINT');return{entityType:ref.entityType,entityId};};
  if(typeof v.createdAt!=='number'||!Number.isSafeInteger(v.createdAt)||v.createdAt<0)return fail('INVALID_DESKTOP_GRAPH_RELATION');
  const modified=v.updatedAt==null?null:typeof v.updatedAt==='number'&&Number.isSafeInteger(v.updatedAt)&&v.updatedAt>=v.createdAt?new Date(v.updatedAt).toISOString():'INVALID';
  return{localRelationId:v.id,data:validateGraphRelationData({source:bind(v.source),target:bind(v.target),relationType:v.type,label:v.label,description:v.description??'',confidence:v.confidence??null,weight:v.weight,createdAt:new Date(v.createdAt).toISOString(),updatedAt:modified})};
 }catch(e){if(e instanceof DesktopGraphError&&e.code==='UNMAPPED_GRAPH_ENDPOINT')throw e;return fail('INVALID_DESKTOP_GRAPH_RELATION');}
}
export const DESKTOP_ACCOUNT_GRAPH_PREFIX='account-graph:';
export function desktopAccountGraphId(entityId:string):string{if(!uuid.test(entityId))return fail('INVALID_DESKTOP_GRAPH_RELATION');return DESKTOP_ACCOUNT_GRAPH_PREFIX+entityId;}
export function parseDesktopAccountGraphId(value:unknown):string|null{if(typeof value!=='string'||!value.startsWith(DESKTOP_ACCOUNT_GRAPH_PREFIX))return null;const id=value.slice(DESKTOP_ACCOUNT_GRAPH_PREFIX.length);return uuid.test(id)?id:null;}
export interface DesktopAccountGraphRelation{id:string;source:string;target:string;type:'custom_relation'|'ai_suggested';label:string;description:string;confidence?:number;weight:number;createdAt:number;updatedAt?:number;scope:'account'}
export type DesktopGraphIncoming={kind:'deleted';entityId:string;revision:number}|{kind:'unmapped';entityId:string;revision:number;missing:GraphEntityRef[]}|{kind:'mapped';entityId:string;revision:number;relation:DesktopAccountGraphRelation};
/** A projection only. The runtime still requires explicit adoption before its
 * account overlay participates in a rendered desktop graph. */
export function graphWireToDesktop(input:unknown,mapping:DesktopGraphMapping,expected:DesktopGraphScope):DesktopGraphIncoming{
 const index=mappingIndex(mapping,expected),valid=validateRecord(input);if(!valid.ok||valid.value.entityType!=='graphRelation')return fail('INVALID_DESKTOP_GRAPH_RELATION');const record=valid.value as SyncRecord<'graphRelation'>;
 if(record.deletedAt!==null)return{kind:'deleted',entityId:record.entityId,revision:record.revision};
 const data=validateGraphRelationData(record.data),missing=[data.source,data.target].filter(ref=>!index.remote.has(typedKey(ref.entityType,ref.entityId)));if(missing.length)return{kind:'unmapped',entityId:record.entityId,revision:record.revision,missing:missing.map(validateGraphEntityRef)};
 const node=(ref:GraphEntityRef)=>ref.entityType+':'+index.remote.get(typedKey(ref.entityType,ref.entityId))!;
 return{kind:'mapped',entityId:record.entityId,revision:record.revision,relation:{id:desktopAccountGraphId(record.entityId),source:node(data.source),target:node(data.target),type:data.relationType,label:data.label,description:data.description,...(data.confidence===null?{}:{confidence:data.confidence}),weight:data.weight,createdAt:Date.parse(data.createdAt),...(data.updatedAt===null?{}:{updatedAt:Date.parse(data.updatedAt)}),scope:'account'}};
}

export {scope as validateDesktopGraphScope};
export const isDesktopGraphLocalId=localId;
export function assertDesktopGraphMapping(mapping:DesktopGraphMapping,expected:DesktopGraphScope):void{mappingIndex(mapping,expected);}
