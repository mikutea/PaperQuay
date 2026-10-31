import {canonicalJson,validateGraphRelationData,GRAPH_RELATION_LIMITS,type GraphRelationData,type GraphEntityRef,type VisibleEntity,type LocalEdit} from '../../../../packages/sync-core/src/index.ts';
import {ClientError} from '../errors.ts';
export interface GraphRelationPlan {edit:LocalEdit;expected:VisibleEntity|null;endpoints:VisibleEntity[]}
const key=(e:{entityType:string;entityId:string})=>e.entityType+':'+e.entityId;
export function planGraphRelation(entities:readonly VisibleEntity[],id:string,input:GraphRelationData|null):GraphRelationPlan{
 const expected=entities.find(e=>e.entityType==='graphRelation'&&e.entityId===id)??null;
 if(expected?.deleted||expected?.pending||expected&&expected.status!=='synced')throw new ClientError('EDIT_CHANGED');
 const data=input===null?null:validateGraphRelationData(input);
 if(!expected&&!data)throw new ClientError('EDIT_CHANGED');
 const endpoints=data?[data.source,data.target].map(ref=>{
  const row=entities.find(e=>key(e)===key(ref));
  if(!row||row.deleted||!row.data||row.pending||row.status!=='synced')throw new ClientError('EDIT_CHANGED');
  return row;
 }):[];
 if(expected&&data){const before=validateGraphRelationData(expected.data);if(['source','target','relationType','createdAt'].some(field=>canonicalJson(before[field as keyof GraphRelationData])!==canonicalJson(data[field as keyof GraphRelationData])))throw new ClientError('EDIT_CHANGED');}
 const rest=entities.filter(e=>e.entityType==='graphRelation'&&!e.deleted&&e.entityId!==id);
 if(data&&(rest.length>=GRAPH_RELATION_LIMITS.relations||new TextEncoder().encode(JSON.stringify([...rest.map(e=>e.data),data])).length>GRAPH_RELATION_LIMITS.accountBytes))throw new ClientError('GRAPH_COLLECTION_LIMIT');
 return structuredClone({edit:{entityType:'graphRelation',entityId:id,mutation:data?'put':'delete',data} as LocalEdit,expected,endpoints});
}
export function assertGraphRelationPlan(plan:GraphRelationPlan,entities:readonly VisibleEntity[]):void{
 const current=planGraphRelation(entities,plan.edit.entityId,plan.edit.data as GraphRelationData|null);
 if(canonicalJson(current)!==canonicalJson(plan))throw new ClientError('EDIT_CHANGED');
}
export function graphRef(node:{type:string;paperId?:string;noteId?:string}):GraphEntityRef|null{
 if(node.type==='paper'&&node.paperId)return{entityType:'paper',entityId:node.paperId};
 if(node.type==='note'&&node.noteId)return{entityType:'note',entityId:node.noteId};
 return null;
}
