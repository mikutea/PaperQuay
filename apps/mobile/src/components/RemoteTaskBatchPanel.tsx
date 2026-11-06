import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getVisibleEntity, type AttachmentVersionData, type PaperData, type VisibleEntity } from '../../../../packages/sync-core/src/index.ts';
import type { RemoteTask, RemoteTaskProvider, RemoteTaskQuota } from '../../../../packages/sync-core/src/remoteTasks.ts';
import { ClientError, describeError } from '../errors.ts';
import { canClearRemoteBatch, REMOTE_BATCH_LIMITS, validateRemoteBatchDraft, type RemoteBatch } from '../remote/batch.ts';
import { RemoteBatchRunner } from '../remote/batchRunner.ts';
import { RemoteTaskClient, describeRemoteTaskError } from '../remote/client.ts';
import type { WorkspaceController } from '../sync/workspace.ts';
interface Props {
 controller:WorkspaceController;client:RemoteTaskClient;providers:RemoteTaskProvider[];tasks:RemoteTask[];
 versions:readonly VisibleEntity[];enabled:boolean;parentBusy:boolean;current():boolean;
 onTask(task:RemoteTask,quota?:RemoteTaskQuota):void;onBusy(value:boolean):void;
}
const deliveries={pending:'待提交',uncertain:'创建结果待核对',submitted:'已确认创建',cancelled:'已阻止创建',removed:'任务记录已清理'};
const executions:Record<RemoteTask['state'],string>={queued:'等待电脑',running:'正在执行',succeeded:'已完成',failed:'执行失败',cancel_requested:'正在取消',cancelled:'已取消',interrupted:'已中断'};
export function RemoteTaskBatchPanel(props:Props){
 const id=useId(),latest=useRef(props);latest.current=props;
 const snapshot=useSyncExternalStore(props.controller.subscribe,props.controller.getSnapshot,props.controller.getSnapshot),batch=snapshot.workspace?.remoteBatch;
 const runner=useMemo(()=>new RemoteBatchRunner({workspace:props.controller,client:props.client,current:()=>latest.current.current(),onTask:(task,quota)=>latest.current.onTask(task,quota)}),[props.controller,props.client]);
 const run=useSyncExternalStore(runner.subscribe,runner.getSnapshot,runner.getSnapshot);
 const [support,setSupport]=useState<'checking'|'ready'|'unavailable'>('checking'),[supportError,setSupportError]=useState(''),[probe,setProbe]=useState(0);
 const [selected,setSelected]=useState<string[]>([]),[choice,setChoice]=useState(''),[sources,setSources]=useState<Record<string,string>>({}),[preview,setPreview]=useState<RemoteBatch|null>(null),[localBusy,setLocalBusy]=useState(false),[error,setError]=useState('');
 const profiles=props.providers.flatMap(provider=>provider.profiles.map(profile=>({provider,profile,key:provider.deviceId+':'+profile.id}))),chosen=profiles.find(value=>value.key===choice);
 useEffect(()=>{runner.activate();return()=>runner.dispose();},[runner]);
 useEffect(()=>{props.onBusy(Boolean(run.action)||localBusy);return()=>latest.current.onBusy(false);},[run.action,localBusy]);
 useEffect(()=>{
  const abort=new AbortController();let live=true;setSupport('checking');setSupportError('');
  if(!props.enabled){setSupport('unavailable');setSupportError('此服务尚未启用远程任务。');return()=>{live=false;abort.abort();};}
  void Promise.resolve().then(()=>props.client.lookupRequest(crypto.randomUUID(),{signal:abort.signal,current:()=>live&&latest.current.current()})).then(()=>{if(live)setSupport('ready');},failure=>{if(live){setSupport('unavailable');setSupportError(describeRemoteTaskError(failure));}});
  return()=>{live=false;abort.abort();};
 },[props.client,props.enabled,probe]);
 function build(){
  setError('');try{
   if(!chosen||!selected.length)throw new Error();const sync=props.controller.getSnapshot().workspace!.sync,profile=chosen.profile;
   const draft:RemoteBatch={version:1,id:crypto.randomUUID(),createdAt:new Date().toISOString(),providerDeviceId:chosen.provider.deviceId,profile,cancelRequested:false,items:selected.map(versionId=>{
    const entity=getVisibleEntity(sync,'attachmentVersion',versionId),data=entity?.data as AttachmentVersionData,paper=getVisibleEntity(sync,'paper',data.paperId);
    const source=props.tasks.find(task=>task.id===sources[versionId]&&task.kind==='parse'&&task.state==='succeeded'&&task.target.attachmentVersionId===versionId&&task.artifact);
    if(profile.kind==='index'&&!source)throw new Error();
    return{request:{requestId:crypto.randomUUID(),kind:profile.kind,versionId,providerDeviceId:chosen.provider.deviceId,profileRef:{id:profile.id,revision:profile.revision,digest:profile.digest},...(profile.kind==='index'?{indexSourceDigest:source!.artifact!.digest}:{})},
     target:{paperId:data.paperId,attachmentVersionId:versionId,paperRevision:paper!.revision,versionRevision:entity!.revision,sha256:data.sha256,sizeBytes:data.sizeBytes,pageCount:data.pageCount,fileName:data.fileName},
     label:(paper?.data as PaperData).title+' · '+data.fileName,state:'pending',taskId:null,cancelAcknowledged:false,failure:null};
   })};setPreview(validateRemoteBatchDraft(draft));
  }catch{setError('所选版本、电脑配置或解析来源已变化，请重新核对选择。');setPreview(null);}
 }
 async function submit(){
  if(!preview||localBusy||run.action)return;setLocalBusy(true);setError('');
  try{const saved=await props.controller.createRemoteBatch(preview,()=>latest.current.current());setPreview(null);setLocalBusy(false);await runner.submit(saved.id);}
  catch(failure){if(latest.current.current())setError(failure instanceof ClientError?describeError(failure):'批次未能保存，请重新核对来源。');}
  finally{setLocalBusy(false);}
 }
 async function clear(){
  if(!batch||!canClearRemoteBatch(batch)||!window.confirm(batch.cancelRequested?'移除此设备的批次记录？取消回执已保存；后台任务的最终状态仍可在任务列表查询。':'移除此设备的批次记录？所有创建请求已确认；此操作不会取消仍在运行的后台任务。'))return;
  setLocalBusy(true);setError('');try{await props.controller.clearRemoteBatch(batch.id,()=>latest.current.current());runner.resetFeedback();}catch(failure){if(latest.current.current())setError(failure instanceof ClientError?describeError(failure):'本机批次记录未能清理。');}finally{setLocalBusy(false);}
 }
 const busy=Boolean(run.action)||localBusy||props.parentBusy;
 const indexReady=!chosen||chosen.profile.kind!=='index'||selected.every(versionId=>props.tasks.some(task=>task.id===sources[versionId]&&task.kind==='parse'&&task.state==='succeeded'&&task.target.attachmentVersionId===versionId&&task.artifact));
 const confirmed=batch?.items.filter(item=>['submitted','cancelled','removed'].includes(item.state)).length??0;
 return <section className="remote-batch" aria-labelledby={id+'-title'}>
  <div className="remote-batch-heading"><div><p className="eyebrow">批量处理</p><h3 id={id+'-title'}>{batch?'保留进度，稍后继续':'一次选择，多份处理'}</h3></div><span className="remote-batch-count">{batch?confirmed+'/'+batch.items.length:'最多 '+REMOTE_BATCH_LIMITS.items+' 份'}</span></div>
  <p className="muted">每份文件单独记录进度。关闭后不会自动提交或恢复；下次打开可查询、继续或取消。</p>
  {support!=='ready'&&<div className="remote-batch-support" role="status"><p>{support==='checking'?'正在核对服务是否支持按原请求查询与取消…':supportError}</p>{support==='unavailable'&&props.enabled&&<button type="button" className="text-button" disabled={busy} onClick={()=>setProbe(value=>value+1)}>重新检查批次能力</button>}</div>}
  {batch?<>
   <progress max={batch.items.length} value={confirmed} aria-label="已确认创建或终止的请求"/>
   <p className="muted">{batch.profile.kind==='parse'?'解析':'索引'} · 模型 {batch.profile.model} · 电脑 {batch.providerDeviceId.slice(0,8)}{batch.cancelRequested?' · 已停止继续提交':''}</p>
   <ol className="remote-batch-ledger">{batch.items.map((item,index)=>{
    const task=props.tasks.find(task=>task.id===item.taskId);return <li key={item.request.requestId} data-batch-state={item.state}>
     <span className="remote-batch-number" aria-hidden="true">{index+1}</span><div><h4>{item.label}</h4><p className="remote-batch-status">{deliveries[item.state]}{item.cancelAcknowledged&&item.state==='submitted'?' · 取消请求已确认':''}{task?' · '+executions[task.state]:''}</p>
     {item.failure&&<p className="muted">本项尚未确认，请查询后继续使用原请求。</p>}{run.requestId===item.request.requestId&&run.action&&<p role="status">{run.action==='submit'?'正在提交…':run.action==='cancel'?'正在核对取消…':'正在查询…'}</p>}</div>
    </li>;
   })}</ol>
   <div className="remote-actions">
    {!batch.cancelRequested&&batch.items.some(item=>['pending','uncertain'].includes(item.state))&&<button type="button" className="primary" disabled={busy||support!=='ready'} onClick={()=>void runner.submit(batch.id)}>继续提交剩余请求</button>}
    <button type="button" className="secondary" disabled={busy||support!=='ready'} onClick={()=>void runner.refresh(batch.id)}>仅查询本批次</button>
    {run.action&&<button type="button" className="text-button" onClick={runner.stopWaiting}>停止本次等待</button>}
    {(!batch.cancelRequested||batch.items.some(item=>!item.cancelAcknowledged))&&<button type="button" className="text-button danger-text" disabled={localBusy||props.parentBusy||run.action==='cancel'} onClick={()=>{
     if(window.confirm('停止继续提交并取消本批次？尚未创建的请求也会被阻止；取消可能影响相同来源和配置共用的既有任务。已发生的外部费用不会撤回。'))void runner.cancel(batch.id);
    }}>{batch.cancelRequested?'继续核对取消':'停止并取消本批次'}</button>}
    {canClearRemoteBatch(batch)&&<button type="button" className="text-button" disabled={busy} onClick={()=>void clear()}>清理本机批次记录</button>}
   </div>
   {batch.cancelRequested&&batch.items.some(item=>!item.cancelAcknowledged)&&<p className="inline-error" role="status">本机已停止继续提交，仍有取消尚未获得服务确认。请恢复连接后继续核对取消。</p>}
  </>:preview?<div className="remote-batch-review">
   <h4>核对这 {preview.items.length} 份文件</h4><p>{preview.profile.kind==='parse'?'解析':'向量索引'} · {preview.profile.model}<br/>电脑 {preview.providerDeviceId.slice(0,8)}</p>
   <ol>{preview.items.map(item=><li key={item.request.requestId}><strong>{item.label}</strong><small>PDF {item.target.sha256.slice(0,12)} · {(item.target.sizeBytes/1024).toFixed(1)} KiB{item.request.indexSourceDigest?' · 解析 '+item.request.indexSourceDigest.slice(0,12):''}</small></li>)}</ol>
   <p className="muted">确认后，电脑会将这些文件或解析文字发给所选模型服务，可能产生费用。遇到首个未确认结果即停下；继续时保留原请求。相同来源与配置可能共用既有任务。</p>
   <div className="remote-actions"><button type="button" className="primary" disabled={busy||support!=='ready'} onClick={()=>void submit()}>确认并逐项提交</button><button type="button" className="text-button" disabled={busy} onClick={()=>setPreview(null)}>返回修改</button></div>
  </div>:<fieldset disabled={busy||support!=='ready'||Boolean(snapshot.workspace?.remoteTaskIntent)} className="remote-batch-select">
   <legend className="sr-only">选择批量处理的文件与配置</legend>
   <label htmlFor={id+'-profile'}>电脑与模型配置</label><select id={id+'-profile'} value={choice} onChange={event=>{setChoice(event.target.value);setSources({});}}><option value="">请选择</option>{profiles.map(value=><option key={value.key} value={value.key}>{value.profile.kind==='parse'?'解析':'索引'} · {value.profile.model} · 电脑 {value.provider.deviceId.slice(0,8)}</option>)}</select>
   <p className="muted remote-batch-selection-count">已选 {selected.length} / {REMOTE_BATCH_LIMITS.items}</p>
   <div className="remote-batch-options">{props.versions.map(version=>{
    const data=version.data as AttachmentVersionData,checked=selected.includes(version.entityId),sourcesForVersion=props.tasks.filter(task=>task.kind==='parse'&&task.state==='succeeded'&&task.target.attachmentVersionId===version.entityId&&task.artifact);
    return <div key={version.entityId}><label className="remote-batch-option"><input type="checkbox" checked={checked} disabled={!checked&&selected.length>=REMOTE_BATCH_LIMITS.items} onChange={()=>setSelected(previous=>checked?previous.filter(value=>value!==version.entityId):[...previous,version.entityId])}/><span>{data.fileName}<small>PDF {data.sha256.slice(0,12)}</small></span></label>
     {checked&&chosen?.profile.kind==='index'&&<label className="remote-batch-source">解析来源<select value={sources[version.entityId]??''} onChange={event=>setSources(previous=>({...previous,[version.entityId]:event.target.value}))}><option value="">选择此版本的已完成解析</option>{sourcesForVersion.map(task=><option key={task.id} value={task.id}>{task.profile.model} · {task.artifact!.digest.slice(0,12)}</option>)}</select></label>}
    </div>;
   })}</div>
   {!props.versions.length&&<p className="muted">同步 PDF 版本后即可选择。</p>}
   <button type="button" className="primary" disabled={!chosen||!selected.length||!indexReady} onClick={build}>核对所选批次</button>
  </fieldset>}
  {(error||run.error)&&<p role="alert" className="inline-error">{error||run.error}</p>}{run.notice&&<p role="status" className="remote-batch-notice">{run.notice}</p>}
  <p className="muted remote-batch-footnote">批次进度仅保存在此设备、此账号；实际执行状态以任务列表为准。取消未创建的请求也会占用服务端幂等回执额度。</p>
 </section>;
}
