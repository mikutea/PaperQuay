import {createKnowledgeGraphCore,type KnowledgeGraphNode,type KnowledgeGraphEdge,type KnowledgeGraphRequest,type KnowledgeGraphSnapshot} from '../../../../packages/graph-core/index.cjs';
import {type VisibleEntity,type PaperData,type NoteData} from '../../../../packages/sync-core/src/index.ts';
import {parsedMarkdownText} from '../parsed/aiContext.ts';
import {reviewFingerprint} from '../review/fingerprint.ts';
export type {KnowledgeGraphNode,KnowledgeGraphEdge,KnowledgeGraphSnapshot};
import {validateGraphRelationData,GRAPH_RELATION_LIMITS,type GraphRelationData} from '../../../../packages/sync-core/src/graphRelation.ts';
export const graphCore=createKnowledgeGraphCore();
export const GRAPH_LIMITS={items:2000,nodes:6000,edges:50000,page:40,visualNeighbors:8,exportBytes:8*1024*1024,coAuthorComparisons:50000} as const;
export class GraphError extends Error {constructor(readonly code:'LIMIT'|'CHANGED'|'EXPORT_LIMIT'|'COAUTHOR_LIMIT'){super(code);this.name='GraphError';}}
export interface GraphScope {tag:string;collection:string}
export interface GraphSelection extends GraphScope {search:string;includePapers:boolean;includeNotes:boolean;includeTags:boolean;includeCategories:boolean;includeCoAuthors:boolean;includeCustomRelations:boolean;localNodeId:string;localDepth:number}
export const defaultGraphSelection=():GraphSelection=>({tag:'',collection:'',search:'',includePapers:true,includeNotes:true,includeTags:true,includeCategories:true,includeCoAuthors:false,includeCustomRelations:true,localNodeId:'',localDepth:1});
const live=(e:VisibleEntity)=>!e.deleted&&e.data&&(e.entityType==='paper'||e.entityType==='note');
export function graphScopeOptions(entities:readonly VisibleEntity[]){
 const tags=new Set<string>(),collections=new Set<string>();
 for(const e of entities.filter(live))if(e.entityType==='paper'){const p=e.data as PaperData;for(const t of p.organization?.tags??[])tags.add(t);for(const c of p.organization?.collections??[])collections.add(c);}else{const n=e.data as NoteData;if(n.format==='tiptap-json')for(const t of n.metadata.tags)tags.add(t);}
 return{tags:[...tags].sort(),collections:[...collections].sort()};
}
/** Project only graph-owned fields. It does not read image assets, credential stores or desktop files. */
export function graphProjection(entities:readonly VisibleEntity[],scope:GraphScope){
 const all=entities.filter(live),papers=all.filter(e=>e.entityType==='paper').filter(e=>{const p=e.data as PaperData;return(!scope.tag||p.organization?.tags.includes(scope.tag))&&(!scope.collection||p.organization?.collections.includes(scope.collection));});
 const ids=new Set(papers.map(e=>e.entityId));
 const notes=all.filter(e=>e.entityType==='note').filter(e=>{if(!scope.tag&&!scope.collection)return true;const n=e.data as NoteData,m=n.format==='tiptap-json'?n.metadata:null;const linked=[n.paperId,m?.linkedPaperId,...(m?.linkedPaperIds??[]),...(m?.anchors.map(a=>a.paperId)??[])].some(id=>id&&ids.has(id));return(!scope.collection||linked)&&(!scope.tag||linked||m?.tags.includes(scope.tag));});
 if(papers.length+notes.length>GRAPH_LIMITS.items)throw new GraphError('LIMIT');
 let relationBudget=0;const budget=(count:number)=>{relationBudget+=count;if(relationBudget>GRAPH_LIMITS.edges)throw new GraphError('LIMIT');};const noteIds=new Set(notes.map(e=>e.entityId));
 const categoryByName=new Map<string,{id:string;name:string;isSystem:false;paperCount:number}>();
 const library={papers:papers.map(e=>{const p=e.data as PaperData;budget((p.organization?.tags.length??0)+(p.organization?.collections.length??0));const categoryIds=(p.organization?.collections??[]).map(name=>{const c=categoryByName.get(name)??{id:'collection-name:'+name,name,isSystem:false as const,paperCount:0};c.paperCount++;categoryByName.set(name,c);return c.id;});return{id:e.entityId,title:p.title,authors:p.authors.map(name=>({name})),year:p.year??'',publication:p.publication??'',doi:p.doi??'',tags:(p.organization?.tags??[]).map(name=>({name})),categoryIds};}),categories:[] as {id:string;name:string;isSystem:false;paperCount:number}[]};library.categories=[...categoryByName.values()];
 const projectedNotes=notes.map(e=>{const n=e.data as NoteData,m=n.format==='tiptap-json'?n.metadata:null,linkedNotes=(m?.linkedNoteIds??[]).filter(id=>noteIds.has(id)),anchorIds=new Set<string>();for(const a of m?.anchors??[])if(a.paperId&&ids.has(a.paperId))anchorIds.add(a.paperId);const linkedPapers=(m?.linkedPaperIds??[]).filter(id=>ids.has(id)),paperTargets=new Set([n.paperId,m?.linkedPaperId,...linkedPapers,...anchorIds].filter((id):id is string=>Boolean(id&&ids.has(id))));budget((m?.tags.length??0)+linkedNotes.length+paperTargets.size);const contentText=(n.format==='markdown'?parsedMarkdownText(n.body.slice(0,4096)):n.body).slice(0,160);return{id:e.entityId,title:n.title,contentText,paperId:n.paperId,linkedPaperId:m?.linkedPaperId??null,linkedPaperIds:linkedPapers,linkedNoteIds:linkedNotes,anchors:[...anchorIds].map(paperId=>({paperId})),tags:m?.tags??[],isPinned:m?.isPinned??false};});
 const context={store:{load:()=>library},noteStore:{listAllNotes:()=>projectedNotes},ragStore:{available:false}};
 const graphNodeIds=new Set([...ids].map(graphCore.paperNodeId).concat([...noteIds].map(graphCore.noteNodeId)));
 const graphRows=entities.filter(e=>e.entityType==='graphRelation'&&!e.deleted&&e.data);if(graphRows.length>GRAPH_RELATION_LIMITS.relations)throw new GraphError('LIMIT');
 const customRelations=graphRows.map(e=>{
  const d=validateGraphRelationData(e.data),id=(r:GraphRelationData['source'])=>r.entityType==='paper'?graphCore.paperNodeId(r.entityId):graphCore.noteNodeId(r.entityId);
  return{id:e.entityId,source:id(d.source),target:id(d.target),type:d.relationType,label:d.label,description:d.description,...(d.confidence===null?{}:{confidence:d.confidence}),weight:d.weight,createdAt:Date.parse(d.createdAt),...(d.updatedAt===null?{}:{updatedAt:Date.parse(d.updatedAt)})};
 }).filter(r=>graphNodeIds.has(r.source)&&graphNodeIds.has(r.target));
 budget(customRelations.length);
 const identity=reviewFingerprint({scope,library,notes:projectedNotes,customRelations});
 return{context,identity,customRelations,itemCount:papers.length+notes.length,paperCount:papers.length,noteCount:notes.length};
}
export interface GraphResult {snapshot:KnowledgeGraphSnapshot;identity:string;selection:GraphSelection;itemCount:number;paperCount:number;noteCount:number}
export function buildMobileGraph(entities:readonly VisibleEntity[],selection:GraphSelection):GraphResult{
 const projected=graphProjection(entities,selection),request:KnowledgeGraphRequest={...selection,includeReferences:false,includeCustomRelations:selection.includeCustomRelations,includeEmbeddingEdges:false,localNodeId:undefined,search:selection.search.trim().toLowerCase()};
 if(selection.includeCoAuthors){const counts=new Map<string,Set<string>>();for(const paper of projected.context.store.load().papers)for(const a of paper.authors){const key=graphCore.normalizeAuthorKey(a.name);if(key.length<2)continue;const group=counts.get(key)??new Set<string>();group.add(paper.id);counts.set(key,group);}let pairs=0;for(const group of counts.values())if(group.size>=2&&group.size<=80){pairs+=group.size*(group.size-1)/2;if(pairs>GRAPH_LIMITS.coAuthorComparisons)throw new GraphError('COAUTHOR_LIMIT');}}
 let snapshot=createKnowledgeGraphCore({listCustomRelations:()=>projected.customRelations}).createKnowledgeGraphSnapshot(projected.context,request);
 if(snapshot.nodes.length>GRAPH_LIMITS.nodes||snapshot.edges.length>GRAPH_LIMITS.edges)throw new GraphError('LIMIT');
 // A missing local center must not silently expand to the global graph.
 if(selection.localNodeId)snapshot=snapshot.nodes.some(n=>n.id===selection.localNodeId)?graphCore.filterLocalGraph(snapshot,selection.localNodeId,selection.localDepth):{...snapshot,nodes:[],edges:[]};
 return{snapshot,identity:projected.identity,selection:{...selection},itemCount:projected.itemCount,paperCount:projected.paperCount,noteCount:projected.noteCount};
}
export function graphNeighbors(snapshot:KnowledgeGraphSnapshot,nodeId:string){
 const nodes=new Map(snapshot.nodes.map(n=>[n.id,n]));return snapshot.edges.filter(e=>e.source===nodeId||e.target===nodeId).map(edge=>({edge,node:nodes.get(edge.source===nodeId?edge.target:edge.source)!})).filter(x=>x.node);
}
export const nodeLabels={paper:'文献',note:'笔记',tag:'标签',category:'分类',reference:'参考文献'} as const;
export const edgeLabels:Record<KnowledgeGraphEdge['type'],string>={paper_tag:'文献标签',note_tag:'笔记标签',paper_category:'分类成员',note_link:'笔记链接',note_paper:'笔记关联文献',co_author:'共同作者',paper_cites_paper:'文献引用',paper_reference:'参考文献',related_by_embedding:'语义相似',custom_relation:'自定义关系',ai_suggested:'AI 建议'};
export function graphEdgeEvidence(edge:KnowledgeGraphEdge):string{
 if(edge.type==='custom_relation'||edge.type==='ai_suggested')return (edge.type==='ai_suggested'?'已保存的 AI 建议':'用户保存的自定义关系')+'：'+edge.label+'。'+(edge.description??'')+' 此关系不代表论证已核实；分数不是校准后的正确概率。';
 if(edge.type==='co_author')return '来自题录作者姓名的桌面归一化匹配：'+edge.label+'。同名不证明是同一作者。';
 if(edge.type==='note_paper')return '来自笔记的关联文献或历史锚点记录。关联存在不代表 PDF 版本、页码或论证已经核验。';
 if(edge.type==='note_link')return '来自笔记明确保存的关联笔记编号；仅保留当前文库中存在的目标。';
 if(edge.type==='paper_category')return '来自同步分类名称；分类按名称重建，不含桌面原分类编号或层级。';
 if(edge.type==='paper_tag'||edge.type==='note_tag')return '来自文献或笔记保存的标签；大小写归并方式与桌面一致。';
 return edge.description??edgeLabels[edge.type];
}
export function exportGraph(result:GraphResult):string{
 const output=JSON.stringify({format:'paperquay-knowledge-graph',version:1,generatedAt:result.snapshot.generatedAt,selection:result.selection,sourceIdentity:result.identity,sourceItems:result.itemCount,nodeCount:result.snapshot.nodes.length,edgeCount:result.snapshot.edges.length,coverage:{source:'current-account-visible-copy',collectionIdentity:'synchronized-name',supported:['paper','note','tag','collection','note-links','co-author','custom-relations','approved-ai-relations'],unavailable:['desktop-private-reference-cache','embedding-edges']},nodes:result.snapshot.nodes,edges:result.snapshot.edges.map(edge=>({...edge,evidence:graphEdgeEvidence(edge)}))},null,2);if(new TextEncoder().encode(output).byteLength>GRAPH_LIMITS.exportBytes)throw new GraphError('EXPORT_LIMIT');return output;
}
