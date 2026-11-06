import {useLayoutEffect,useRef,useState} from 'react';
import {validateGraphRelationData,GRAPH_RELATION_LIMITS,type GraphEntityRef,type VisibleEntity} from '../../../../packages/sync-core/src/index.ts';
import type {WorkspaceController} from '../sync/workspace.ts';
import {ClientError,describeError} from '../errors.ts';
import {planGraphRelation} from '../graph/relations.ts';
interface Props {controller:WorkspaceController;entities:VisibleEntity[];source:GraphEntityRef;current():boolean;enabled:boolean;onDirty?(dirty:boolean):void}
const key=(e:{entityType:string;entityId:string})=>e.entityType+':'+e.entityId;
export function GraphRelationEditor(props:Props){
 const [draft,setDraft]=useState<{id:string;rows:VisibleEntity[];target:string;label:string;description:string;createdAt:string;editing:boolean;source:GraphEntityRef}|null>(null);
 const [remove,setRemove]=useState<{row:VisibleEntity;rows:VisibleEntity[]}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const mounted=useRef(true);useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const active=()=>mounted.current&&latest.current.current()&&latest.current.enabled;
 useLayoutEffect(()=>{latest.current.onDirty?.(Boolean(draft));return()=>latest.current.onDirty?.(false);},[Boolean(draft)]);
 const flight=useRef(false),latest=useRef(props);latest.current=props;
 const links=props.entities.filter(e=>e.entityType==='graphRelation'&&!e.deleted&&e.data).filter(e=>{const d=validateGraphRelationData(e.data);return key(d.source)===key(props.source)||key(d.target)===key(props.source);});
 function begin(row?:VisibleEntity){if(!active()||!props.enabled||flight.current)return;setError('');setNotice('');setRemove(null);
  const d=row?validateGraphRelationData(row.data):null;
  setDraft({id:row?.entityId??crypto.randomUUID(),rows:structuredClone(props.entities),target:d?key(d.target):'',label:d?.label??'',description:d?.description??'',createdAt:d?.createdAt??new Date().toISOString(),editing:Boolean(row),source:structuredClone(d?.source??props.source)});
 }
 async function save(){if(!draft||flight.current||!active())return;setError('');setNotice('');
  try{
   const old=draft.rows.find(e=>e.entityType==='graphRelation'&&e.entityId===draft.id),prior=old?validateGraphRelationData(old.data):null;
   const target=draft.rows.find(e=>key(e)===draft.target&&(e.entityType==='paper'||e.entityType==='note'));
   if(!prior&&!target)throw new ClientError('EDIT_CHANGED');
   const data=validateGraphRelationData(prior?{...prior,label:draft.label,description:draft.description,updatedAt:new Date().toISOString()}:{source:draft.source,target:{entityType:target!.entityType,entityId:target!.entityId},relationType:'custom_relation',label:draft.label,description:draft.description,confidence:null,weight:0.58,createdAt:draft.createdAt,updatedAt:draft.createdAt});
   const plan=planGraphRelation(draft.rows,draft.id,data);flight.current=true;setBusy(true);
   await props.controller.saveGraphRelation(plan,active);if(active()){setDraft(null);setNotice('关系已保存到本机，按账号能力同步。');}
  }catch(e){if(active())setError(e instanceof ClientError?describeError(e):'关系内容无效，请检查名称、说明和目标。草稿仍保留。');}
  finally{flight.current=false;if(mounted.current)setBusy(false);}
 }
 async function erase(){if(!remove||flight.current||!active())return;setError('');try{const plan=planGraphRelation(remove.rows,remove.row.entityId,null);flight.current=true;setBusy(true);await props.controller.saveGraphRelation(plan,active);if(active()){setRemove(null);setNotice('关系已删除，材料仍保留。');}}catch(e){if(active())setError(describeError(e));}finally{flight.current=false;if(mounted.current)setBusy(false);}}
 const source=draft?.source??props.source;
 const targets=(draft?.rows??props.entities).filter(e=>(e.entityType==='paper'||e.entityType==='note')&&!e.deleted&&e.data&&!e.pending&&e.status==='synced'&&key(e)!==key(source));
 return <section className="graph-relation-editor" aria-label="管理已保存关系"><h4>已保存关系 · {links.length}</h4>
  {!props.enabled&&<p className="muted">当前连接尚未协商关系同步。已有关系可浏览；连接支持此能力的服务并重新登录后可编辑。</p>}
  <p className="muted">只连接已同步的文献与笔记。手动关系与已采纳的 AI 建议保留各自来源；此处不会调用模型。</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <ul>{links.map(row=>{const d=validateGraphRelationData(row.data);return <li key={row.entityId}><strong>{d.label}</strong><small>{d.relationType==='ai_suggested'?'已采纳的 AI 建议':'自定义关系'}{row.pending?' · 待同步':''}</small>{d.description&&<p>{d.description}</p>}<div className="graph-actions"><button type="button" className="secondary" disabled={!props.enabled||row.pending||busy} onClick={()=>begin(row)}>编辑关系</button><button type="button" className="secondary" disabled={!props.enabled||row.pending||busy} onClick={()=>{if(props.current()){setDraft(null);setRemove({row:structuredClone(row),rows:structuredClone(props.entities)});setError('');}}}>删除关系</button></div></li>;})}</ul>
  {remove&&<div className="graph-relation-confirm"><p>删除“{validateGraphRelationData(remove.row.data).label}”？两端材料会保留。</p><button type="button" disabled={busy} onClick={()=>void erase()}>确认删除关系</button><button type="button" className="secondary" disabled={busy} onClick={()=>setRemove(null)}>保留关系</button></div>}
  {!draft?<button type="button" disabled={!props.enabled||busy||!targets.length} onClick={()=>begin()}>新建关系</button>:<form onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={busy||!props.enabled}><legend>{draft.editing?'编辑已保存关系':'从已选择材料新建关系'}</legend>
   <p className="muted">来源：{String((draft.rows.find(e=>key(e)===key(draft.source))?.data as {title?:string}|null)?.title??draft.source.entityId)}</p>
   {!draft.editing&&<label className="field">目标材料<select required value={draft.target} onChange={e=>setDraft(previous=>previous?{...previous,target:e.target.value}:null)}><option value="">选择文献或笔记</option>{targets.map(e=><option key={key(e)} value={key(e)}>{e.entityType==='paper'?'文献':'笔记'} · {'title'in e.data!?String(e.data.title):e.entityId}</option>)}</select></label>}
   <label className="field">关系名称<input required maxLength={GRAPH_RELATION_LIMITS.labelChars} value={draft.label} placeholder="例如：补充方法、相互支持" onChange={e=>setDraft(previous=>previous?{...previous,label:e.target.value}:null)}/></label>
   <label className="field">说明<textarea rows={3} maxLength={GRAPH_RELATION_LIMITS.descriptionChars} value={draft.description} onChange={e=>setDraft(previous=>previous?{...previous,description:e.target.value}:null)}/></label>
   <div className="graph-actions"><button type="submit">{busy?'正在保存…':'保存关系'}</button><button type="button" className="secondary" onClick={()=>{setDraft(null);setError('');}}>取消编辑</button></div>
  </fieldset></form>}
 </section>;
}
