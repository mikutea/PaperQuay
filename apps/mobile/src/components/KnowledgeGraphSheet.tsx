import {useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {listVisibleEntities,canonicalJson} from '../../../../packages/sync-core/src/index.ts';
import type {WorkspaceController} from '../sync/workspace.ts';
import {buildMobileGraph,defaultGraphSelection,graphScopeOptions,graphNeighbors,graphEdgeEvidence,exportGraph,GraphError,GRAPH_LIMITS,nodeLabels,edgeLabels,type KnowledgeGraphNode,type GraphSelection} from '../graph/model.ts';
import {exportTextFile,exportFilename,FileExportError,type ExportRuntime} from '../platform/exportFile.ts';
import {ReaderSheet} from './ReaderSheet.tsx';
import './knowledgeGraph.css';
interface Props {controller:WorkspaceController;scopeKey:string;accountCurrent():boolean;onClose():void;onOpen(node:KnowledgeGraphNode):void;exportRuntime?:ExportRuntime}
function errorMessage(error:unknown){return error instanceof GraphError&&error.code==='COAUTHOR_LIMIT'?'此范围的共同作者比较过多，请缩小标签、分类范围或关闭共同作者。':error instanceof GraphError&&error.code==='EXPORT_LIMIT'?'导出文件超过8MiB，请选择更小的标签、分类或邻域范围后重试。':error instanceof GraphError&&error.code==='LIMIT'?'此范围超过图谱预算（2000份文献与笔记、6000节点或50000关系）。请选择标签或分类缩小范围。':error instanceof FileExportError&&error.code==='UNAVAILABLE'?'此设备没有可用的系统文件分享能力。':error instanceof FileExportError&&error.code==='FAILED'?'本次导出未完成；图谱仍保留。':'账号、材料或当前视图已经变化，请核对后重新导出。';}
export function KnowledgeGraphSheet(props:Props){
 const latest=useRef(props);latest.current=props;
 const state=useSyncExternalStore(props.controller.subscribe,props.controller.getSnapshot,props.controller.getSnapshot);
 const owner=useMemo(()=>({controller:props.controller,key:props.scopeKey}),[props.controller,props.scopeKey]),active=useRef(owner);active.current=owner;
 const mounted=useRef(true),flight=useRef(false);
 const [selection,setSelection]=useState(defaultGraphSelection),[focusId,setFocusId]=useState(''),[page,setPage]=useState(1),[history,setHistory]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const entities=useMemo(()=>state.workspace?listVisibleEntities(state.workspace.sync):[],[state.workspace]);
 const options=useMemo(()=>graphScopeOptions(entities),[entities]);
 const computed=useMemo(()=>{try{return{result:buildMobileGraph(entities,selection),error:''};}catch(e){return{result:null,error:errorMessage(e)};}},[entities,selection]);
 const result=computed.result,snapshot=result?.snapshot,selected=snapshot?.nodes.find(n=>n.id===focusId)??snapshot?.nodes[0]??null;
 const neighbors=useMemo(()=>selected&&snapshot?graphNeighbors(snapshot,selected.id):[],[snapshot,selected]);
 const visualNeighbors=useMemo(()=>[...new Map(neighbors.map(x=>[x.node.id,x])).values()].slice(0,GRAPH_LIMITS.visualNeighbors),[neighbors]);
 const diagramHost=useRef<HTMLElement|null>(null),[connections,setConnections]=useState({width:0,height:0,paths:[] as string[]});
 useLayoutEffect(()=>{const host=diagramHost.current;if(!host)return;const measure=()=>{const outer=host.getBoundingClientRect(),center=host.querySelector('.graph-center')?.getBoundingClientRect();if(!center||!outer.width)return;const x=center.left+center.width/2-outer.left,y=center.bottom-outer.top;const paths=[...host.querySelectorAll('.graph-neighbor')].map(e=>{const r=e.getBoundingClientRect(),endX=r.left+r.width/2-outer.left,endY=r.top-outer.top;return 'M '+x+' '+y+' C '+x+' '+(y+20)+' '+endX+' '+(endY-20)+' '+endX+' '+endY;});const next={width:outer.width,height:outer.height,paths};setConnections(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);};measure();const observer=typeof ResizeObserver==='function'?new ResizeObserver(measure):null;observer?.observe(host);host.querySelectorAll('.graph-center,.graph-neighbor').forEach(e=>observer?.observe(e));window.addEventListener('resize',measure);return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};},[selected?.id,visualNeighbors]);
 const viewRef=useRef(result);viewRef.current=result;
 function current(){const p=latest.current,s=p.controller.getSnapshot(),sync=s.workspace?.sync;return mounted.current&&active.current===owner&&p.accountCurrent()&&s.status==='ready'&&Boolean(sync)&&JSON.stringify([sync!.accountId,sync!.deviceId,sync!.generation])===owner.key;}
 function change(patch:Partial<GraphSelection>){if(!current())return;setSelection(s=>({...s,...patch}));setPage(1);setError('');setNotice('');}
 function focus(node:KnowledgeGraphNode){if(!current())return;if(selected&&selected.id!==node.id)setHistory(h=>[...h,selected.id].slice(-8));setFocusId(node.id);}
 function open(){if(!current()||!selected||!['paper','note'].includes(selected.type))return;const sync=latest.current.controller.getSnapshot().workspace?.sync;const exists=sync&&listVisibleEntities(sync).some(e=>!e.deleted&&e.data&&e.entityType===selected.type&&e.entityId===(selected.paperId&&selected.type==='paper'?selected.paperId:selected.noteId));if(exists)latest.current.onOpen(selected);else setError('此内容已删除或不在当前账号，请重新选择。');}
 async function download(){
  if(!current()||!result||flight.current)return;const captured=result;flight.current=true;setBusy(true);setError('');setNotice('');
  const guard=()=>{if(!current()||viewRef.current!==captured)return false;const sync=latest.current.controller.getSnapshot().workspace?.sync;if(!sync)return false;try{return buildMobileGraph(listVisibleEntities(sync),captured.selection).identity===captured.identity;}catch{return false;}};
  try{const mode=await exportTextFile({name:exportFilename('PaperQuay-知识图谱','json'),text:exportGraph(captured),mime:'application/json'},guard,latest.current.exportRuntime);if(guard())setNotice(mode==='share'?'已打开系统分享。':'已交给浏览器下载。');}catch(e){if(current())setError(errorMessage(e));}finally{flight.current=false;if(mounted.current)setBusy(false);}
 }
 const shown=snapshot?.nodes.slice(0,page*GRAPH_LIMITS.page)??[];
 return <ReaderSheet open title="知识图谱" className="graph-sheet" onClose={props.onClose}><div className="mobile-graph">
  <header className="graph-intro"><p className="eyebrow">连接材料，回到出处</p><h3>从一条关系继续阅读</h3><p className="muted">浏览此账号在本机的文献、笔记和已保存的关系。点选节点查看相邻材料；图中的关系不代表论证已核实。</p></header>
  <div className="graph-controls"><label className="field">检索节点<input type="search" value={selection.search} maxLength={512} placeholder="标题、作者、标签或编号" onChange={e=>change({search:e.target.value,localNodeId:''})}/></label>
   <details><summary>范围与关系类型</summary><div className="graph-scope-fields"><label className="field">材料标签<select value={selection.tag} onChange={e=>change({tag:e.target.value,localNodeId:''})}><option value="">全部标签</option>{options.tags.map(t=><option key={t}>{t}</option>)}</select></label><label className="field">材料分类<select value={selection.collection} onChange={e=>change({collection:e.target.value,localNodeId:''})}><option value="">全部分类</option>{options.collections.map(t=><option key={t}>{t}</option>)}</select></label></div>
   <fieldset className="graph-types"><legend>显示内容</legend>{([['includePapers','文献'],['includeNotes','笔记'],['includeTags','标签'],['includeCategories','分类'],['includeCoAuthors','共同作者']] as const).map(([key,label])=><label key={key}><input type="checkbox" checked={selection[key]} onChange={e=>change({[key]:e.target.checked,localNodeId:''})}/>{label}</label>)}</fieldset><p className="muted">共同作者按题录姓名归一化匹配，同名仍需核实。标签与分类范围先筛选材料，检索再显示命中节点及其一跳邻居。</p></details>
  </div>
  {(computed.error||error)&&<p className="graph-feedback" role="alert">{computed.error||error}</p>}{notice&&<p className="graph-notice" role="status">{notice}</p>}
  {result&&<>
   <div className="graph-counts" aria-live="polite"><span>{result.itemCount} 份材料</span><strong>{snapshot!.nodes.length} 节点 · {snapshot!.edges.length} 关系</strong></div>
   {selection.localNodeId&&<div className="graph-local-state"><span>局部 · {selection.localDepth} 跳</span><button type="button" className="secondary" onClick={()=>change({localNodeId:''})}>返回全图</button></div>}
   {!selected?<div className="empty-state"><h4>当前范围没有节点</h4><p>调整范围、清空检索，或先在文库保存文献与笔记。</p><button type="button" className="secondary" onClick={()=>{if(current()){setSelection(defaultGraphSelection());setPage(1);}}}>重置视图</button></div>:<>
    <section ref={diagramHost} className="graph-explorer" aria-label="触控关系视图">
     {connections.width>0&&<svg className="graph-connections" aria-hidden="true" viewBox={'0 0 '+connections.width+' '+connections.height} preserveAspectRatio="none">{connections.paths.map((d,i)=><path key={i} d={d}/>)}</svg>}
     {history.length>0&&<button type="button" className="secondary graph-back" onClick={()=>{if(!current())return;const id=history.at(-1)!;setHistory(h=>h.slice(0,-1));setFocusId(id);}}>上一个节点</button>}
     <div className="graph-center" data-graph-id={selected.id}><small>{nodeLabels[selected.type]} · 当前节点</small><h4>{selected.label}</h4>{selected.subtitle&&<p>{selected.subtitle}</p>}</div>
     {visualNeighbors.length>0?<div className="graph-branches">{visualNeighbors.map(({node,edge})=><button type="button" key={node.id} data-graph-id={node.id} className="graph-neighbor secondary" aria-label={'查看节点：'+node.label} onClick={()=>focus(node)}><small>{edgeLabels[edge.type]} · {nodeLabels[node.type]}</small><span>{node.label}</span></button>)}</div>:<p className="muted graph-isolated">此视图中没有相邻节点。</p>}
     {neighbors.length>visualNeighbors.length&&<p className="muted">关系视图显示前{visualNeighbors.length}个相邻节点；完整关系见下方列表。</p>}
    </section>
    <section className="graph-node-detail"><h4>节点详情</h4><p className="graph-node-id">{selected.id}</p><div className="graph-actions">{['paper','note'].includes(selected.type)&&<button type="button" onClick={open}>{selected.type==='paper'?'打开文献':'打开笔记'}</button>}<button type="button" className="secondary" onClick={()=>change({localNodeId:selected.id,localDepth:1})}>以此为中心</button><label>邻域深度<select value={selection.localDepth} onChange={e=>change({localDepth:Number(e.target.value),localNodeId:selected.id})}>{[1,2,3,4].map(n=><option key={n} value={n}>{n} 跳</option>)}</select></label></div></section>
    <details className="graph-evidence" open><summary>关系与证据 · {neighbors.length}</summary><ul>{neighbors.slice(0,page*GRAPH_LIMITS.page).map(({node,edge})=><li key={edge.id}><button type="button" className="graph-text-button" onClick={()=>focus(node)}>{edgeLabels[edge.type]} · {node.label}</button><p>{graphEdgeEvidence(edge)}</p><small>{edge.source===selected.id?'从当前节点指向对方':'从对方指向当前节点'}</small></li>)}</ul>{neighbors.length>page*GRAPH_LIMITS.page&&<button type="button" className="secondary" onClick={()=>setPage(p=>p+1)}>显示更多关系</button>}</details>
   </>}
   <details className="graph-node-list" open><summary>浏览节点 · {snapshot!.nodes.length}</summary><ul>{shown.map(node=><li key={node.id}><button type="button" className="graph-node-button" aria-current={selected?.id===node.id?'true':undefined} onClick={()=>focus(node)}><small>{nodeLabels[node.type]}</small><span>{node.label}</span></button></li>)}</ul>{snapshot!.nodes.length>shown.length&&<button type="button" className="secondary" onClick={()=>setPage(p=>p+1)}>显示更多节点</button>}</details>
   <div className="graph-export"><button type="button" className="secondary" disabled={busy} onClick={()=>void download()}>{busy?'正在准备导出…':'导出当前图谱 JSON'}</button><p className="muted">导出当前范围、检索和邻域中的节点、关系与证据说明，笔记仅含至多160字的预览，不含图片。</p></div>
  </>}
  <details className="graph-coverage"><summary>此图谱的来源范围</summary><p>关系算法与桌面共用。分类按同步名称重建，不含桌面原分类编号或层级。笔记历史锚点只表示关联，不证明 PDF 版本或页码已核验。</p><p>桌面私有参考文献缓存、向量相似关系、自定义及 AI 关系尚未同步到此设备，因此不在此图谱中。此页面不联网检索，不调用模型，也不会修改任何关系。</p></details>
 </div></ReaderSheet>;
}
