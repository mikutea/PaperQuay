import {useEffect,useId,useRef,useState,useSyncExternalStore} from 'react';
import type {AiAccountScope,AiProviderConfig} from '../ai/types.ts';
import {describeAiError} from '../ai/errors.ts';
import {createModelRouteProvider} from '../modelRouting/config.ts';
import {describeModelRoutingError,type MobileModelRouter} from '../modelRouting/router.ts';
import type {ModelInferenceAvailability,ModelInferenceProfile,ModelInferenceTarget} from '../../../../packages/sync-core/src/modelInference.ts';
import type {ModelInvocationLedger,ModelInvocationRecord} from '../modelRouting/ledger.ts';
import {exportTextFile,exportFilename,type ExportRuntime} from '../platform/exportFile.ts';
interface Props {ledgerRevision?:number;scope:AiAccountScope;router?:MobileModelRouter;config:AiProviderConfig;busy:boolean;onChange(config:AiProviderConfig):void;onExternal():void;exportRuntime?:ExportRuntime}
const labels={intent:'发送状态未确认',waiting:'等待执行或返回',complete:'结果已保存在本机',failed:'执行失败',cancelled:'已停止',uncertain:'结果尚未确认',removed:'服务端记录已清除'};
const purposes={pdf:'阅读辅助',research:'多篇问答',review:'综述写作',agent:'模型 Agent'};
const emptySnapshot={revision:0,pendingIds:[] as string[]},subscribe=()=>()=>{},getEmpty=()=>emptySnapshot;
type Choice={key:string;target:ModelInferenceTarget;profile:ModelInferenceProfile;expiresAt:string};
export function ModelRoutingPanel(p:Props){
 const id=useId(),router=p.router,snapshot=useSyncExternalStore(router?.subscribe??subscribe,router?.getSnapshot??getEmpty,getEmpty),[inventory,setInventory]=useState<ModelInferenceAvailability|null>(null),[selected,setSelected]=useState(''),[consent,setConsent]=useState(false),[ledger,setLedger]=useState<ModelInvocationLedger|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[working,setWorking]=useState(false),[confirm,setConfirm]=useState<{id:string;action:'release'|'compact'|'dispatch'}|null>(null);
 const mounted=useRef(false),task=useRef<object|null>(null),latest=useRef(p);latest.current=p;
 const current=()=>mounted.current&&latest.current.router===router&&Boolean(router?.current());
 useEffect(()=>{mounted.current=true;setInventory(null);setConsent(false);setSelected('');setConfirm(null);setLedger(null);setError('');setNotice('');return()=>{mounted.current=false;task.current=null;};},[router]);
 useEffect(()=>{let live=true;if(router)void router.readActivity().then(value=>{if(live&&current())setLedger(value);}).catch(()=>{if(live&&current())setError('本机模型记录无法验证，请保留现有数据后核对。');});return()=>{live=false;};},[router,snapshot.revision,p.ledgerRevision]);
 useEffect(()=>{if(!inventory)return;const timer=setTimeout(()=>{setInventory(null);setSelected('');setConsent(false);},Math.max(1,Date.parse(inventory.validUntil)-Date.now()));return()=>clearTimeout(timer);},[inventory]);
 const choices:Choice[]=inventory?[...(inventory.gateway?[{key:'gateway',target:{kind:'gateway' as const},profile:inventory.gateway,expiresAt:inventory.validUntil}]:[]),...inventory.computers.flatMap(c=>c.profiles.map(profile=>({key:c.deviceId+':'+profile.id,target:{kind:'computer' as const,deviceId:c.deviceId},profile,expiresAt:c.expiresAt})))]:[],choice=choices.find(c=>c.key===selected);
 async function launch(action:(signal:AbortSignal,guard:()=>boolean)=>Promise<void>){
  if(!current()||task.current||p.busy)return;const id={},abort=new AbortController();task.current=id;setWorking(true);setError('');setNotice('');const guard=()=>current()&&task.current===id;
  try{await action(abort.signal,guard);}catch(e){if(guard())setError(describeAiError(describeModelRoutingError(e)));}
  finally{abort.abort();if(task.current===id){task.current=null;if(current())setWorking(false);}}
 }
 function choose(){void launch(async(_signal,guard)=>{if(!choice||!consent||Date.parse(choice.expiresAt)<=Date.now())return;const config=await createModelRouteProvider(p.scope,choice.target,choice.profile);if(!guard())return;p.onChange(config);setConsent(false);setNotice('已选择模型。仅点击业务中的发送按钮才会产生模型调用。');});}
 function act(r:ModelInvocationRecord,action:'refresh'|'cancel'|'localSave'|'gatewaySave'|'backup'|'gatewayBackup'){
  void launch(async(signal,guard)=>{
   if(action==='refresh')await router!.refresh(r.request.id,signal);
   if(action==='cancel')await router!.cancel(r.request.id,signal);
   if(action==='localSave')await router!.retryLocalSave(r.request.id);
   if(action==='gatewaySave')await router!.retryGatewaySave(r.request.id,signal);
   if(action==='backup'||action==='gatewayBackup'){
    const value=action==='backup'?await router!.backup(r.request.id):await router!.gatewayCandidate(r.request.id,signal);if(!guard())return;
    const result=await exportTextFile({name:exportFilename('模型请求-'+r.request.id.slice(0,8),'json'),mime:'application/json',text:JSON.stringify(value,null,2)},guard,p.exportRuntime);
    if(guard())setNotice(result==='share'?'已打开系统分享，请在目标应用确认接收。':'已交给浏览器下载，请核对保存的文件。');
   }else if(guard())setNotice(action==='cancel'?'已查询原请求的取消状态；已经发出的调用仍可能计费。':'已核对原请求，没有新建模型调用。');
  });
 }
 function approve(){const value=confirm;if(!value)return;void launch(async(signal,guard)=>{if(value.action==='dispatch')await router!.dispatchQueued(value.id,signal);else if(value.action==='release')await router!.release(value.id);else await router!.compact(value.id);if(guard()){setConfirm(null);setNotice(value.action==='dispatch'?'已请求执行原排队任务，请查询原请求状态。':value.action==='release'?'已解除本机阻塞。原请求与可能产生的用量记录仍保留。':'已清理这条记录的本机全文，原请求身份回执仍保留。');}});}
 const busy=p.busy||working;
 return <section className="model-routing" aria-label="模型调用方式与记录">
  <div className="model-route-heading"><div><p className="eyebrow">模型服务</p><h3>选择在哪里运行</h3></div><span className="model-route-badge">{p.config.execution?(p.config.execution.target.kind==='gateway'?'账号网关':'已选电脑'):'直接连接'}</span></div>
  <p className="muted">按你的选择发送本次文字。模型可能产生费用，用量与金额以服务商账单为准。</p>
  {p.config.execution&&<div className="model-route-current"><strong>{p.config.model}</strong><span>{p.config.execution.target.kind==='gateway'?'通过当前账号网关':('电脑 '+p.config.execution.target.deviceId.slice(0,8))} · 配置版本 {p.config.execution.profileRef.revision}</span><p>本机不读取模型密钥。收到完整结果后显示；不会自动更换服务或重发。</p></div>}
  <div className="model-route-actions"><button type="button" className="secondary" disabled={busy} onClick={p.onExternal}>{p.config.execution?'切换回本机直连设置':'使用本机直连设置'}</button><button type="button" className="secondary" disabled={busy||!router} onClick={()=>void launch(async(signal,guard)=>{const value=await router!.inventory(signal);if(guard()){setInventory(value);setConsent(false);setSelected('');setNotice('已读取账号内可用模型，尚未调用模型。');}})}>{working?'正在处理…':'查看网关与电脑模型'}</button>{router&&<button type="button" className="secondary" disabled={busy} onClick={()=>void launch(async(signal,guard)=>{await router.refreshLocal(signal);if(guard())setNotice('已只读刷新本机记录，没有联网或新建模型调用。');})}>刷新本机记录</button>}</div>
  {!router&&<p className="muted">当前会话未提供远程模型连接。已有直连设置仍可使用。</p>}
  {inventory&&<fieldset className="model-route-choices" disabled={busy}><legend>当前可选模型</legend>{choices.length?choices.map(c=><label className="model-route-choice" key={c.key}><input type="radio" name={'model-route-choice-'+id} value={c.key} checked={selected===c.key} onChange={()=>{setSelected(c.key);setConsent(false);}}/><span><strong>{c.profile.model}</strong><small>{c.target.kind==='gateway'?'账号网关':('电脑 '+c.target.deviceId.slice(0,8))} · 最多 {c.profile.maxOutputTokens} 输出 tokens</small></span></label>):<p className="muted">当前没有可用模型。请在电脑端开启指定模型，或联系账号网关维护者。</p>}
   {choice&&<><label className="model-route-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>我知道明确发送后，所选文字会交给此网关或电脑，并可能产生模型用量。</span></label><button type="button" className="primary" disabled={!consent||busy} onClick={choose}>使用所选模型</button></>}<p className="muted">列表会过期；每次发送前会重新核对原配置，不会自动选择替代模型。</p></fieldset>}
  {ledger&&<details className="model-route-history"><summary>本机调用记录 <span>{ledger.records.length}/4 份全文 · {ledger.receipts.length}/128 份身份回执</span></summary>
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
