import type {JsonSchema} from './schema.ts';
/** Account synchronization data for explicit paper/note relations. Local desktop IDs and paths are never endpoints. */
export const GRAPH_RELATION_LIMITS=Object.freeze({relations:512,labelChars:80,descriptionChars:4096,dataBytes:16*1024,accountBytes:2*1024*1024});
export interface GraphEntityRef {entityType:'paper'|'note';entityId:string}
export interface GraphRelationData {source:GraphEntityRef;target:GraphEntityRef;relationType:'custom_relation'|'ai_suggested';label:string;description:string;confidence:number|null;weight:number;createdAt:string;updatedAt:string|null}
export class GraphRelationValidationError extends Error {
 readonly code:'INVALID_GRAPH_RELATION'|'GRAPH_RELATION_LIMIT';
 constructor(code:'INVALID_GRAPH_RELATION'|'GRAPH_RELATION_LIMIT'='INVALID_GRAPH_RELATION'){super(code);this.name='GraphRelationValidationError';this.code=code;}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=():never=>{throw new GraphRelationValidationError();},limit=():never=>{throw new GraphRelationValidationError('GRAPH_RELATION_LIMIT');};
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();
 const descriptors=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(descriptors,k))||Object.values(descriptors).some(d=>!d.enumerable||!('value'in d)))return fail();
 return value as Record<string,unknown>;
}
function text(value:unknown,max:number,multiline=false,required=false):string{
 if(typeof value!=='string')return fail();if(value.length>max)return limit();if(required&&!value.trim())return fail();
 for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);if(n<32&&(!multiline||![9,10,13].includes(n))||n===127)return fail();if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return fail();}else if(n>=0xdc00&&n<=0xdfff)return fail();}
 return value;
}
export function validateGraphEntityRef(value:unknown):GraphEntityRef{
 const v=object(value,['entityType','entityId']);if(v.entityType!=='paper'&&v.entityType!=='note'||typeof v.entityId!=='string'||!UUID.test(v.entityId))return fail();return{entityType:v.entityType,entityId:v.entityId};
}
export function validateGraphRelationData(value:unknown):GraphRelationData{
 const v=object(value,['source','target','relationType','label','description','confidence','weight','createdAt','updatedAt']),source=validateGraphEntityRef(v.source),target=validateGraphEntityRef(v.target);
 if(source.entityType===target.entityType&&source.entityId===target.entityId||v.relationType!=='custom_relation'&&v.relationType!=='ai_suggested')return fail();
 if(v.confidence!==null&&(typeof v.confidence!=='number'||!Number.isFinite(v.confidence)||v.confidence<0||v.confidence>1)||typeof v.weight!=='number'||!Number.isFinite(v.weight)||v.weight<0.1||v.weight>1)return fail();
 const createdAt=text(v.createdAt,24);try{if(new Date(createdAt).toISOString()!==createdAt)return fail();}catch{return fail();}
 let updatedAt:string|null=null;if(v.updatedAt!==null){updatedAt=text(v.updatedAt,24);try{if(new Date(updatedAt).toISOString()!==updatedAt||updatedAt<createdAt)return fail();}catch{return fail();}}
 const result:GraphRelationData={source,target,relationType:v.relationType,label:text(v.label,GRAPH_RELATION_LIMITS.labelChars,false,true),description:text(v.description,GRAPH_RELATION_LIMITS.descriptionChars,true),confidence:v.confidence as number|null,weight:v.weight,createdAt,updatedAt};
 if(new TextEncoder().encode(JSON.stringify(result)).length>GRAPH_RELATION_LIMITS.dataBytes)return limit();return result;
}
const endpointSchema:JsonSchema={type:'object',required:['entityType','entityId'],additionalProperties:false,properties:{entityType:{enum:['paper','note']},entityId:{type:'string',pattern:UUID.source}}};
export const GRAPH_RELATION_DATA_SCHEMA:JsonSchema={
 type:'object',required:['source','target','relationType','label','description','confidence','weight','createdAt','updatedAt'],additionalProperties:false,
 properties:{source:endpointSchema,target:endpointSchema,relationType:{enum:['custom_relation','ai_suggested']},label:{type:'string',minLength:1,maxLength:GRAPH_RELATION_LIMITS.labelChars},description:{type:'string',maxLength:GRAPH_RELATION_LIMITS.descriptionChars},confidence:{anyOf:[{type:'null'},{type:'number',minimum:0,maximum:1}]},weight:{type:'number',minimum:0.1,maximum:1},createdAt:{type:'string',minLength:24,maxLength:24},updatedAt:{anyOf:[{type:'null'},{type:'string',minLength:24,maxLength:24}]}},
};
