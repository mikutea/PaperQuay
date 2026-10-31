import{useLayoutEffect,useRef,useState}from'react';
import{validateGraphRelationData,type VisibleEntity}from'../../../../packages/sync-core/src/index.ts';
import type{WorkspaceController}from'../sync/workspace.ts';import{planGraphRelation}from'../graph/relations.ts';import{describeError}from'../errors.ts';
interface Props{controller:WorkspaceController;entities:VisibleEntity[];enabled:boolean;current():boolean}
const key=(e:{entityType:string;entityId:string})=>e.entityType+':'+e.entityId;
export function orphanGraphRelations(entities:readonly VisibleEntity[]){
 const live=new Set(entities.filter(e=>!e.deleted&&e.data&&(e.entityType==='paper'||e.entityType==='note')).map(key));
 return entities.filter(e=>e.entityType==='graphRelation'&&!e.deleted&&e.data).filter(e=>{const d=validateGraphRelationData(e.data);return!live.has(key(d.source))||!live.has(key(d.target));});
}
export function GraphRelationOrphans(props:Props){
 const[review,setReview]=useState<{row:VisibleEntity;rows:VisibleEntity[]}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const mounted=useRef(true),flight=useRef(false),latest=useRef(props);latest.current=props;useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const current=()=>mounted.current&&latest.current.current()&&latest.current.enabled;
 async function erase(){if(!review||flight.current||!current())return;setError('');setNotice('');try{const plan=planGraphRelation(review.rows,review.row.entityId,null);flight.current=true;setBusy(true);await props.controller.saveGraphRelation(plan,current);if(current()){setReview(null);setNotice('关系已删除，材料没有恢复或改变。');}}catch(e){if(current())setError(describeError(e));}finally{flight.current=false;if(mounted.current)setBusy(false);}}
 const rows=orphanGraphRelations(props.entities);
 if(!rows.length&&!review&&!notice)return null;
 return <details className="graph-relation-orphans"><summary>两端材料不可用的关系 · {rows.length}</summary><p className="muted">这些关系仍保存在账号中，当前副本缺少至少一端材料，所以不画进图中。可核对后单独删除关系；不会自动恢复材料。</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <ul>{rows.map(row=>{const d=validateGraphRelationData(row.data);return<li key={row.entityId}><strong>{d.label}</strong><p>{d.description}</p><small>{d.relationType==='ai_suggested'?'已采纳 AI 建议':'自定义关系'}{row.pending?' · 待同步':''}</small><button type="button" className="secondary" disabled={!props.enabled||row.pending||busy} onClick={()=>{if(current()){setReview({row:structuredClone(row),rows:structuredClone(props.entities)});setError('');setNotice('');}}}>核对并删除此关系</button></li>;})}</ul>
  {review&&<div className="graph-relation-confirm"><p>确认删除“{validateGraphRelationData(review.row.data).label}”？此操作只删除关系。</p><div className="graph-actions"><button type="button" disabled={busy||!props.enabled} onClick={()=>void erase()}>确认删除不可用关系</button><button type="button" className="secondary" disabled={busy} onClick={()=>setReview(null)}>保留关系</button></div></div>}
 </details>;
}
