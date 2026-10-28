import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getVisibleEntity, type AttachmentVersionData, type PaperData, type VisibleEntity } from '../../../../packages/sync-core/src/index.ts';
import type { RemoteTask, RemoteTaskProvider, RemoteTaskQuota, RemoteTaskRequest } from '../../../../packages/sync-core/src/remoteTasks.ts';
import { getParsedCache } from '../parsed/cache.ts';
import { exportFilename, exportTextFile, FileExportError } from '../platform/exportFile.ts';
import type { AccountScope } from '../storage/accountStore.ts';
import { ClientError, describeError } from '../errors.ts';
import { RemoteTaskClient, RemoteTaskError, describeRemoteTaskError, type RemoteTaskContext } from '../remote/client.ts';
import type { WorkspaceController } from '../sync/workspace.ts';
import { ReaderSheet } from './ReaderSheet.tsx';
import './remoteTasks.css';

interface Props {
  context: RemoteTaskContext; scope: AccountScope; scopeKey: string; controller: WorkspaceController;
  entities: readonly VisibleEntity[]; accountCurrent(): boolean; onClose(): void;
  onParsed?(versionId: string, digest: string): void;
  client?: RemoteTaskClient;
}
interface Task { signal: AbortSignal; check(): void; guard(): boolean }
const states: Record<RemoteTask['state'],string> = { queued:'等待电脑执行',running:'正在执行',succeeded:'已完成',failed:'执行失败',cancel_requested:'正在请求取消',cancelled:'已取消',interrupted:'执行已中断，需明确恢复' };
const reasons:Record<NonNullable<RemoteTask['failure']>,string> = { EXECUTION_FAILED:'电脑执行失败，请查看电脑上的配置与存储。',SOURCE_UNAVAILABLE:'所选文件或解析来源当前不可用。',PROFILE_CHANGED:'电脑上的模型配置已变化。',
  EXTERNAL_OUTCOME_UNKNOWN:'外部服务结果尚不确定。恢复只会查询已知任务；不会重发无法确认的付费请求。',LEASE_EXPIRED:'电脑未在租约内续期，服务保留中断状态。',SESSION_REVOKED:'相关登录会话已被撤销。',VERSION_CHANGED:'目标版本已变化。' };
function message(error:unknown){
  if(error instanceof ClientError)return describeError(error);
  if(error instanceof FileExportError)return error.code==='CHANGED'?'账号或目标已变化，未打开旧产物。':'产物未能分享，请检查设备空间或分享组件后重试。';
  return describeRemoteTaskError(error);
}
function active(task:RemoteTask){return['queued','running','cancel_requested'].includes(task.state);}

export function RemoteTaskPanel(props:Props){
  const id=useId(),latest=useRef(props);latest.current=props;
  const client=useMemo(()=>props.client??new RemoteTaskClient(props.context),[props.client,props.context]);
  const snapshot=useSyncExternalStore(props.controller.subscribe,props.controller.getSnapshot,props.controller.getSnapshot);
  const mounted=useRef(false),generation=useRef(0),inFlight=useRef(false),abort=useRef<AbortController|null>(null);
  const [providers,setProviders]=useState<RemoteTaskProvider[]>([]),[tasks,setTasks]=useState<RemoteTask[]>([]),[quota,setQuota]=useState<RemoteTaskQuota|null>(null);
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [versionId,setVersionId]=useState(''),[choice,setChoice]=useState(''),[parseId,setParseId]=useState('');
  const [recoveryChoices,setRecoveryChoices]=useState<Record<string,string>>({});
  const versions=props.entities.filter(entity=>entity.entityType==='attachmentVersion'&&!entity.deleted&&entity.data&&entity.revision>0);
  const profiles=providers.flatMap(provider=>provider.profiles.map(profile=>({provider,profile,key:provider.deviceId+':'+profile.id})));
  const selected=profiles.find(value=>value.key===choice),version=versions.find(value=>value.entityId===versionId);
  const parseSources=tasks.filter(task=>task.kind==='parse'&&task.state==='succeeded'&&task.target.attachmentVersionId===versionId&&task.artifact);
  const parseSource=parseSources.find(value=>value.id===parseId);
  const intent=snapshot.workspace?.remoteTaskIntent;
  function current(){
    const p=latest.current,s=p.controller.getSnapshot(),sync=s.workspace?.sync;
    return mounted.current&&p.accountCurrent()&&s.status==='ready'&&sync?.accountId===p.scope.accountId
      &&JSON.stringify([sync.accountId,sync.deviceId,sync.generation])===p.scopeKey;
  }
  function targetCurrent(task:RemoteTask){
    if(!current())throw new RemoteTaskError('CHANGED');
    const sync=latest.current.controller.getSnapshot().workspace!.sync;
    const paper=getVisibleEntity(sync,'paper',task.target.paperId),version=getVisibleEntity(sync,'attachmentVersion',task.target.attachmentVersionId);
    if(!paper?.data||paper.deleted||!version?.data||version.deleted||!('mediaType'in version.data)||version.data.paperId!==task.target.paperId
      ||version.data.sha256!==task.target.sha256||version.data.sizeBytes!==task.target.sizeBytes
      ||version.data.pageCount!==null&&task.target.pageCount!==null&&version.data.pageCount!==task.target.pageCount)throw new RemoteTaskError('VERSION_UNAVAILABLE');
  }
  async function run(label:string,work:(task:Task)=>Promise<void>){
    if(inFlight.current)return;
    inFlight.current=true;const controller=new AbortController(),token=++generation.current;abort.current=controller;
    const check=()=>{if(controller.signal.aborted)throw new RemoteTaskError('CANCELLED');if(token!==generation.current||!current())throw new RemoteTaskError('CHANGED');};
    const guard=()=>{try{check();return true;}catch{return false;}};
    setBusy(label);setError('');setNotice('');
    try{check();await work({signal:controller.signal,check,guard});}
    catch(failure){if(mounted.current&&token===generation.current)setError(message(failure));}
    finally{if(mounted.current&&token===generation.current){inFlight.current=false;abort.current=null;setBusy('');}}
  }
  async function refresh(task:Task){
    const [rows,result]=await Promise.all([client.providers({signal:task.signal,current:task.guard}),client.list({signal:task.signal,current:task.guard})]);task.check();
    setProviders(rows);setTasks(result.tasks);setQuota(result.quota);
  }
  useEffect(()=>{
    mounted.current=true;void run('正在读取远程任务…',refresh);
    return()=>{mounted.current=false;generation.current++;abort.current?.abort();};
  },[client,props.scopeKey]);
  async function send(request:RemoteTaskRequest,task:Task){
    const controller=latest.current.controller;
    const persisted=await controller.prepareRemoteTask(request);task.check();
    const result=await client.create(persisted,{signal:task.signal,current:task.guard});task.check();
    targetCurrent(result.task);await controller.clearRemoteTaskIntent(persisted.requestId);task.check();
    setTasks(previous=>[result.task,...previous.filter(value=>value.id!==result.task.id)]);setQuota(result.quota);
    setNotice(result.replayed?'已找回同一请求的真实状态，没有重新创建任务。':result.deduplicated?'已找到相同来源和配置的既有任务，没有重复创建。':'任务已由同步服务持久保存。关闭本面板后仍可稍后查询。');
  }
  function create(){
    if(!selected||!version||inFlight.current)return;
    const profile=selected.profile;
    const request:RemoteTaskRequest={requestId:crypto.randomUUID(),kind:profile.kind,versionId:version.entityId,providerDeviceId:selected.provider.deviceId,
      profileRef:{id:profile.id,revision:profile.revision,digest:profile.digest},...(profile.kind==='index'&&parseSource?.artifact?{indexSourceDigest:parseSource.artifact.digest}:{})};
    void run('正在提交所选任务…',task=>send(request,task));
  }
  function update(task:RemoteTask,action:'cancel'|'resume'){
    const recovery=profiles.find(value=>value.key===recoveryChoices[task.id]);
    if(action==='resume'&&!window.confirm(recovery&&recovery.provider.deviceId!==task.providerDeviceId
      ? '明确把此任务交给所选电脑的新登录会话恢复？它必须在本机保留且核对原执行记录；不会从未知结果重新提交付费请求。'
      : '明确恢复此任务？电脑会先复核原文件和配置；无法确认的外部付费请求不会自动重发。'))return;
    void run(action==='cancel'?'正在请求取消…':'正在恢复任务…',async current=>{
      const result=await client.update(task.id,action,{signal:current.signal,current:current.guard},action==='resume'&&recovery?{providerDeviceId:recovery.provider.deviceId,
        profileRef:{id:recovery.profile.id,revision:recovery.profile.revision,digest:recovery.profile.digest}}:{});current.check();
      setTasks(previous=>previous.map(value=>value.id===result.id?result:value));
      setNotice(action==='cancel'?'已保存取消请求。请刷新确认最终状态；已经发生的外部费用无法据此撤回。':'恢复请求已保存，请刷新查看电脑的执行状态。');
    });
  }
  function remove(task:RemoteTask){
    if(!window.confirm('清理此已结束任务及服务端产物？文献、电脑原文件和已下载缓存会保留。用于阻止旧请求重放的服务端回执仍会保留。'))return;
    void run('正在清理任务产物…',async current=>{
      const result=await client.remove(task.id,{signal:current.signal,current:current.guard});current.check();setTasks(previous=>previous.filter(value=>value.id!==task.id));setQuota(result);setNotice('任务与服务端产物已清理；幂等回执仍保留。');
    });
  }
  function download(task:RemoteTask){
    void run('正在核对任务产物…',async current=>{
      targetCurrent(task);const value=await client.artifact(task,{signal:current.signal,current:()=>{try{targetCurrent(task);return current.guard();}catch{return false;}}});current.check();targetCurrent(task);
      if(value.document.format==='paperquay-parsed-document'){
        const guard=()=>{try{targetCurrent(task);return current.guard();}catch{return false;}};
        await getParsedCache().put(latest.current.scope,{document:value.document,digest:value.digest},{signal:current.signal,guard});
        latest.current.onParsed?.(task.target.attachmentVersionId,value.digest);current.check();
        setNotice('解析包已核验并保存到本机缓存，可在此 PDF 的“解析”面板中离线阅读。');
      }else{
        const mode=await exportTextFile({name:exportFilename(task.target.fileName+'-向量索引','json'),text:new TextDecoder().decode(value.bytes),mime:'application/json'},()=>{try{targetCurrent(task);return current.guard();}catch{return false;}});
        current.check();setNotice(mode==='share'?'已打开已核验索引文件的系统分享界面；目标应用是否接收由系统确认。':'已发起已核验索引文件的下载。');
      }
    });
  }
  const enabled=Boolean(props.context.getCapability());
  return <ReaderSheet open title="远程解析与索引" onClose={props.onClose} className="remote-task-sheet">
    <div className="remote-tasks">
      <p>任务由同账号、明确开启远程执行的电脑处理。电脑会将所选 PDF 或解析文字发送给它配置的服务，可能产生费用；手机无需保持后台运行。</p>
      {!enabled&&<p role="status" className="inline-error">此同步服务尚未启用远程任务。请在服务与电脑启用相应能力后重新打开。</p>}
      <button type="button" className="secondary" disabled={Boolean(busy)||!enabled} onClick={()=>void run('正在刷新任务…',refresh)}>刷新电脑与任务</button>
      {quota&&<dl className="remote-quota"><div><dt>执行中</dt><dd>{quota.active}/{quota.maxActive}</dd></div><div><dt>排队</dt><dd>{quota.queued}/{quota.maxQueued}</dd></div><div><dt>任务记录</dt><dd>{quota.retained}/{quota.maxRetained}</dd></div>
        <div><dt>服务端产物</dt><dd>{(quota.artifactBytes/1048576).toFixed(2)}/{(quota.maxArtifactBytes/1048576).toFixed(0)} MiB</dd></div><div><dt>幂等回执</dt><dd>{quota.receipts}/{quota.maxReceipts}</dd></div></dl>}
      {intent&&<section className="remote-intent" aria-label="尚未确认的远程请求"><h3>上一条创建请求尚未确认</h3><p>已在本机保存请求 {intent.request.requestId.slice(0,8)}。重试使用相同 ID，不会自动新建另一笔任务。</p>
        <div className="remote-actions"><button type="button" className="secondary" disabled={Boolean(busy)||!enabled} onClick={()=>void run('正在重试同一请求…',task=>send(intent.request,task))}>重试同一创建请求</button>
          <button type="button" className="text-button" disabled={Boolean(busy)} onClick={()=>{
            if(window.confirm('仅移除此设备的未确认请求记录？服务端可能已创建任务，请先查询任务列表；此操作不会取消后台任务。'))void run('正在清理本机请求记录…',async task=>{await props.controller.clearRemoteTaskIntent(intent.request.requestId);task.check();setNotice('本机未确认记录已移除。服务端任务仍需单独查询或取消。');});
          }}>移除本机未确认记录</button></div></section>}
      <fieldset disabled={Boolean(busy)||!enabled||Boolean(intent)} className="remote-create"><legend>明确选择一份文件</legend>
        <label htmlFor={id+'-version'}>文献版本</label><select id={id+'-version'} value={versionId} onChange={event=>{setVersionId(event.target.value);setParseId('');}}><option value="">选择已同步的 PDF 版本</option>{versions.map(value=>{
          const data=value.data as AttachmentVersionData,paper=props.entities.find(paper=>paper.entityType==='paper'&&paper.entityId===data.paperId&&!paper.deleted);
          return <option key={value.entityId} value={value.entityId}>{(paper?.data as PaperData|undefined)?.title??'当前不可用文献'} · {data.fileName} · {data.sha256.slice(0,8)}</option>;
        })}</select>
        <label htmlFor={id+'-profile'}>电脑与配置</label><select id={id+'-profile'} value={choice} onChange={event=>setChoice(event.target.value)}><option value="">选择在线电脑已公开的配置</option>{profiles.map(value=><option key={value.key} value={value.key}>电脑 {value.provider.deviceId.slice(0,8)} · {value.profile.kind==='parse'?'解析':'向量索引'} · {value.profile.model}</option>)}</select>
        {selected?.profile.kind==='index'&&<><label htmlFor={id+'-parse'}>相同版本已完成的解析结果</label><select id={id+'-parse'} value={parseId} onChange={event=>setParseId(event.target.value)}><option value="">选择解析来源</option>{parseSources.map(value=><option key={value.id} value={value.id}>{value.profile.model} · {value.artifact!.digest.slice(0,12)} · {value.updatedAt}</option>)}</select><p className="muted">索引绑定所选解析摘要；电脑还需保留对应的有效解析缓存。</p></>}
        {!profiles.length&&enabled&&<p className="muted">当前没有电脑公开可执行配置。请在同账号电脑上显式开启后刷新。</p>}
        <button type="button" className="primary" disabled={!selected||!version||selected.profile.kind==='index'&&!parseSource} onClick={create}>提交所选{selected?.profile.kind==='index'?'索引':'解析'}任务</button>
      </fieldset>
      <h3>此账号的任务</h3>{!tasks.length&&<p className="muted">尚无任务。刷新只读取状态，不会自动提交新任务。</p>}
      <ol className="remote-task-list">{tasks.map(task=>{
        const recoverable=profiles.filter(value=>value.profile.kind===task.kind&&value.profile.id===task.profile.id&&value.profile.revision===task.profile.revision&&value.profile.digest===task.profile.digest&&value.profile.model===task.profile.model);
        return <li key={task.id}><h4>{task.kind==='parse'?'解析':'向量索引'} · {task.target.fileName}</h4><p role="status">{states[task.state]} · 第 {task.attempt} 次领取</p>
        <p className="muted">模型 {task.profile.model} · PDF {task.target.sha256.slice(0,12)} · 更新于 {task.updatedAt}</p>{task.failure&&<p>{reasons[task.failure]}</p>}
        {task.artifact&&<p className="muted">产物 {(task.artifact.sizeBytes/1024).toFixed(1)} KiB · SHA-256 {task.artifact.digest.slice(0,12)}</p>}
        {['failed','cancelled','interrupted'].includes(task.state)&&<div className="remote-recovery">
          <label htmlFor={id+'-recovery-'+task.id}>恢复所用电脑会话</label>
          <select id={id+'-recovery-'+task.id} value={recoveryChoices[task.id]??''} disabled={Boolean(busy)} onChange={event=>setRecoveryChoices(previous=>({...previous,[task.id]:event.target.value}))}>
            <option value="">沿用原电脑会话 {task.providerDeviceId.slice(0,8)}</option>
            {recoverable.map(value=><option key={value.key} value={value.key}>{snapshot.devices.find(device=>device.id===value.provider.deviceId)?.name??'在线电脑'} {value.provider.deviceId.slice(0,8)} · {value.profile.model}</option>)}
          </select><p className="muted">电脑重登录后可选择它的新会话；同一台电脑还须保留原执行记录。另一台电脑没有旧记录时会拒绝恢复。</p>
        </div>}
        <div className="remote-actions">{active(task)?<button type="button" className="secondary" disabled={Boolean(busy)||task.state==='cancel_requested'} onClick={()=>update(task,'cancel')}>请求取消</button>:<>
          {['failed','cancelled','interrupted'].includes(task.state)&&<button type="button" className="secondary" disabled={Boolean(busy)} onClick={()=>update(task,'resume')}>明确恢复此任务</button>}
          {task.state==='succeeded'&&<button type="button" className="secondary" disabled={Boolean(busy)} onClick={()=>download(task)}>{task.kind==='parse'?'核验并保存解析包到本机':'核验并导出索引文件'}</button>}
          <button type="button" className="text-button danger-text" disabled={Boolean(busy)} onClick={()=>remove(task)}>清理任务与服务端产物</button></>}</div></li>;
      })}</ol>
      {busy&&<p role="status">{busy} <button type="button" className="text-button" onClick={()=>abort.current?.abort()}>停止本次等待</button></p>}
      {error&&<p role="alert" className="inline-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
      <p className="muted">外部用量与费用未知，以服务商账单为准。中断任务不会自动恢复；清理任务不清除幂等回执，也不删除电脑原文件。</p>
    </div>
  </ReaderSheet>;
}
