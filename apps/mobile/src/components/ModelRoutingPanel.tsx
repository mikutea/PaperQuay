import {useEffect,useId,useRef,useState,useSyncExternalStore} from 'react';
import type {AiAccountScope,AiProviderConfig} from '../ai/types.ts';
import {describeAiError} from '../ai/errors.ts';
import {createModelRouteProvider} from '../modelRouting/config.ts';
import {describeModelRoutingError,type MobileModelRouter} from '../modelRouting/router.ts';
import type {ModelInferenceAvailability,ModelInferenceProfile,ModelInferenceTarget} from '../../../../packages/sync-core/src/modelInference.ts';
import type {ModelInvocationLedger,ModelInvocationRecord} from '../modelRouting/ledger.ts';
import {exportTextFile,exportFilename,type ExportRuntime} from '../platform/exportFile.ts';
interface Props {ledgerRevision?:number;showActivity?:boolean;picker?:boolean;scope:AiAccountScope;router?:MobileModelRouter;config:AiProviderConfig;busy:boolean;onChange(config:AiProviderConfig):void;onExternal():void;exportRuntime?:ExportRuntime}
const labels={intent:'发送状态未确认',waiting:'等待执行或返回',complete:'结果已保存在本机',failed:'执行失败',cancelled:'已停止',uncertain:'结果尚未确认',removed:'服务端记录已清除'};
const purposes={pdf:'阅读辅助',research:'多篇问答',review:'综述写作',agent:'模型 Agent'};
const emptySnapshot={revision:0,pendingIds:[] as string[]},subscribe=()=>()=>{},getEmpty=()=>emptySnapshot;
type Choice={key:string;target:ModelInferenceTarget;profile:ModelInferenceProfile;expiresAt:string};
export function ModelRoutingPanel(p:Props){
 const id=useId(),router=p.router,showActivity=p.showActivity!==false,snapshot=useSyncExternalStore(router?.subscribe??subscribe,router?.getSnapshot??getEmpty,getEmpty),[inventory,setInventory]=useState<ModelInferenceAvailability|null>(null),[selected,setSelected]=useState(''),[ledger,setLedger]=useState<ModelInvocationLedger|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[working,setWorking]=useState(false),[confirm,setConfirm]=useState<{id:string;action:'release'|'compact'|'dispatch'}|null>(null);
 const mounted=useRef(false),task=useRef<object|null>(null),activeAbort=useRef<AbortController|null>(null),latest=useRef(p);latest.current=p;
 const current=()=>mounted.current&&latest.current.router===router&&Boolean(router?.current());
 useEffect(()=>{mounted.current=true;setInventory(null);setSelected('');setConfirm(null);setLedger(null);setError('');setNotice('');return()=>{mounted.current=false;task.current=null;activeAbort.current?.abort();activeAbort.current=null;};},[router]);
 useEffect(()=>{let live=true;if(!showActivity){setLedger(null);return;}if(router)void router.readActivity().then(value=>{if(live&&current())setLedger(value);}).catch(()=>{if(live&&current())setError('暂时无法读取最近的 AI 任务，请稍后重新打开。');});return()=>{live=false;};},[router,snapshot.revision,p.ledgerRevision,showActivity]);
 useEffect(()=>{if(!inventory)return;const timer=setTimeout(()=>{setInventory(null);setSelected('');},Math.max(1,Date.parse(inventory.validUntil)-Date.now()));return()=>clearTimeout(timer);},[inventory]);
 const choices:Choice[]=inventory?[...(inventory.gateway?[{key:'gateway',target:{kind:'gateway' as const},profile:inventory.gateway,expiresAt:inventory.validUntil}]:[]),...inventory.computers.flatMap(c=>c.profiles.map(profile=>({key:c.deviceId+':'+profile.id,target:{kind:'computer' as const,deviceId:c.deviceId},profile,expiresAt:c.expiresAt})))]:[],choice=choices.find(c=>c.key===selected);
 async function launch(action:(signal:AbortSignal,guard:()=>boolean)=>Promise<void>){
  if(!current()||task.current||p.busy)return;const id={},abort=new AbortController();task.current=id;activeAbort.current=abort;setWorking(true);setError('');setNotice('');const guard=()=>current()&&task.current===id;
  try{await action(abort.signal,guard);}catch(e){if(guard())setError(describeAiError(describeModelRoutingError(e)));}
  finally{abort.abort();if(activeAbort.current===abort)activeAbort.current=null;if(task.current===id){task.current=null;if(current())setWorking(false);}}
 }
 function loadModels(){void launch(async(signal,guard)=>{const value=await router!.inventory(signal);if(guard()){setInventory(value);setSelected('');if(!p.picker)setNotice('已取得可用模型，请选择要使用的模型。');}});}
 useEffect(()=>{if(p.picker)loadModels();},[router,p.picker]);
 function choose(){void launch(async(_signal,guard)=>{if(!choice||Date.parse(choice.expiresAt)<=Date.now())return;const config=await createModelRouteProvider(p.scope,choice.target,choice.profile);if(!guard())return;p.onChange(config);setInventory(null);setSelected('');setNotice('已保存模型选择。发送问题时会使用这个模型。');});}
 function act(r:ModelInvocationRecord,action:'refresh'|'cancel'|'localSave'|'gatewaySave'|'backup'|'gatewayBackup'){
  void launch(async(signal,guard)=>{
   if(action==='refresh')await router!.refresh(r.request.id,signal);
   if(action==='cancel')await router!.cancel(r.request.id,signal);
   if(action==='localSave')await router!.retryLocalSave(r.request.id);
   if(action==='gatewaySave')await router!.retryGatewaySave(r.request.id,signal);
   if(action==='backup'||action==='gatewayBackup'){
    const value=action==='backup'?await router!.backup(r.request.id):await router!.gatewayCandidate(r.request.id,signal);if(!guard())return;
    const result=await exportTextFile({name:exportFilename('模型请求-'+r.request.id.slice(0,8),'json'),mime:'application/json',text:JSON.stringify(value,null,2)},guard,p.exportRuntime,p.scope);
    if(guard())setNotice(result==='share'?'已打开系统分享，请在目标应用确认接收。':'已交给浏览器下载，请核对保存的文件。');
   }else if(guard())setNotice(action==='cancel'?'已查询原请求的取消状态；已经发出的调用仍可能计费。':'已核对原请求，没有新建模型调用。');
  });
 }
 function approve(){const value=confirm;if(!value)return;void launch(async(signal,guard)=>{if(value.action==='dispatch')await router!.dispatchQueued(value.id,signal);else if(value.action==='release')await router!.release(value.id);else await router!.compact(value.id);if(guard()){setConfirm(null);setNotice(value.action==='dispatch'?'已请求执行原排队任务，请查询原请求状态。':value.action==='release'?'已解除本机阻塞。原请求与可能产生的用量记录仍保留。':'已清理这条记录的本机全文，原请求身份回执仍保留。');}});}
 const busy=p.busy||working;
 return <section className="model-routing" aria-label={showActivity?'AI 连接与最近任务':'AI 连接方式'}>
  {!p.picker&&<>
  <div className="model-route-heading"><h3>当前连接</h3><span className="model-route-badge">{p.config.execution?(p.config.execution.target.kind==='gateway'?'账号提供的 AI':'已登录的电脑'):'自己的 AI 服务'}</span></div>
  <p className="muted">发送问题时，所选文字会交给这个服务，可能产生费用。</p>
  {p.config.execution&&<div className="model-route-current"><strong>{p.config.model}</strong><span>{p.config.execution.target.kind==='gateway'?'由账号提供模型和密钥':'使用已登录电脑上的模型和密钥'}</span><details><summary>连接详情</summary><p>配置版本 {p.config.execution.profileRef.revision}{p.config.execution.target.kind==='computer'?' · 电脑编号 '+p.config.execution.target.deviceId:''}。收到完整结果后显示；不会自动更换服务或重发。</p></details></div>}
  </>}
  <div className="model-route-actions">{!p.picker&&p.config.execution&&<button type="button" className="secondary" disabled={busy} onClick={p.onExternal}>使用自己的 AI 服务</button>}{router&&<button type="button" className="secondary" disabled={busy} onClick={loadModels}>{working?'正在获取…':p.picker?'刷新模型列表':'查看账号和电脑提供的模型'}</button>}{router&&showActivity&&<button type="button" className="secondary" disabled={busy} onClick={()=>void launch(async(signal,guard)=>{await router.refreshLocal(signal);if(guard())setNotice('已刷新此设备的任务记录。');})}>刷新最近任务</button>}</div>
  {!router&&p.config.execution&&<p className="muted">当前账号暂时无法获取其他模型。可先切换到自己的 AI 服务。</p>}
  {inventory&&<fieldset className="model-route-choices" disabled={busy}><legend>选择模型</legend>{choices.length?choices.map(c=><label className="model-route-choice" key={c.key}><input type="radio" name={'model-route-choice-'+id} value={c.key} checked={selected===c.key} onChange={()=>setSelected(c.key)}/><span><strong>{c.profile.model}</strong><small>{c.target.kind==='gateway'?'账号提供的 AI':('已登录电脑 · '+c.target.deviceId.slice(0,8))}</small></span></label>):<p className="muted">暂时没有可用模型。请在电脑上开启模型共享，或联系账号服务的管理员。</p>}
   {choice&&<button type="button" className="primary" disabled={busy} onClick={choose}>使用此模型</button>}{!p.picker&&<p className="muted">这里只保存模型选择。发送问题前会再次检查所选服务；不会自动换用其他模型。</p>}</fieldset>}
  {p.picker&&<p className="muted">选择后，阅读问答会使用这个模型。</p>}
  {showActivity&&ledger&&<details className="model-route-history"><summary>最近的 AI 任务 <span>{ledger.records.length} 条</span></summary>
   <p className="muted">重新打开只读取本机记录。结果不会自动重新应用到笔记、综述或 Agent。备份后可清理全文，原请求回执继续防止重发。</p>
   {!ledger.records.length&&<p className="muted">本机暂无保留全文的调用。</p>}
   {ledger.records.map(r=>{const unresolved=['intent','waiting','uncertain'].includes(r.phase),pending=snapshot.pendingIds.includes(r.request.id);return <article className="model-invocation" key={r.request.id}>
    <div className="model-invocation-heading"><strong>{purposes[r.purpose]}</strong><span>{pending?'结果等待本机保存':labels[r.phase]}</span></div><p>{r.request.model} · {r.request.target.kind==='gateway'?'账号网关':'指定电脑'}<br/><small>请求 {r.request.id} · {new Date(r.createdAt).toLocaleString()}</small></p>
    {unresolved&&<p className="model-route-warning">这次调用可能已经产生用量。查询和补存不会新建调用；停止等待不代表服务商尚未计费。</p>}
    {r.released&&<p className="muted">已明确解除本机阻塞；原请求没有重新执行。</p>}
    <details><summary>查看原始输入与已收结果</summary><pre>{r.request.messages.map(m=>m.role+'\n'+m.content).join('\n\n')}</pre><pre>{r.output?.text??'本机尚未确认完整结果。'}</pre>{r.output&&<p className="muted">{r.output.finishReason==='length'?'达到输出上限，结果不完整':r.output.finishReason==='content_filter'?'服务过滤了这次输出':'服务已结束响应'}{r.output.reportedModel?' · 服务报告模型 '+r.output.reportedModel:''}</p>}<p className="muted">{r.output?.usage?'输入 '+r.output.usage.promptTokens+' · 输出 '+r.output.usage.completionTokens+' tokens':'用量未知'}{r.output?.redacted?' · 服务已移除私有密钥回显':''}</p></details>
    <div className="model-route-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>act(r,'refresh')}>查询原请求</button><button type="button" className="secondary" disabled={busy} onClick={()=>act(r,'backup')}>备份请求与结果</button>
     {pending&&<button type="button" className="secondary" disabled={busy} onClick={()=>act(r,'localSave')}>仅重试本机保存</button>}
     {unresolved&&<button type="button" className="secondary" disabled={busy} onClick={()=>act(r,'cancel')}>取消原请求</button>}
     {unresolved&&r.request.target.kind==='gateway'&&<><button type="button" className="secondary" disabled={busy} onClick={()=>act(r,'gatewaySave')}>仅补存网关结果</button><button type="button" className="secondary" disabled={busy} onClick={()=>act(r,'gatewayBackup')}>备份网关内存结果</button></>}
     {r.job?.state==='queued'&&r.request.target.kind==='gateway'&&<button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm({id:r.request.id,action:'dispatch'})}>执行原排队请求…</button>}
     {unresolved&&!r.released&&<button type="button" className="text-button" disabled={busy||pending} onClick={()=>setConfirm({id:r.request.id,action:'release'})}>解除本机阻塞…</button>}
     <button type="button" className="text-button" disabled={busy||pending||(unresolved&&!r.released)} onClick={()=>setConfirm({id:r.request.id,action:'compact'})}>清理本机全文…</button>
    </div></article>;})}
   {confirm&&<div className="model-route-confirm" role="group" aria-label="确认模型记录操作"><strong>{confirm.action==='dispatch'?'执行原排队请求可能产生费用':confirm.action==='release'?'原调用仍可能计费':'清理前请先保存需要的备份'}</strong><p>{confirm.action==='dispatch'?'将先查询同一请求，只有仍未领取的网关排队任务才能执行。不会新建请求 ID。':confirm.action==='release'?'解除阻塞后可明确发送新的请求；原请求状态和既往用量不会因此取消。': '将删除这条记录在本机保存的输入和输出全文，保留防止重发的身份回执。服务端记录不会被删除。'}</p><div className="model-route-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>setConfirm(null)}>返回</button><button type="button" className="primary" disabled={busy} onClick={approve}>{confirm.action==='dispatch'?'确认执行原请求':confirm.action==='release'?'确认解除阻塞':'确认清理全文'}</button></div></div>}
  </details>}
  {error&&<p role="alert" className="model-route-warning">{error}</p>}{notice&&<p role="status" className="model-route-notice">{notice}</p>}
 </section>;
}
