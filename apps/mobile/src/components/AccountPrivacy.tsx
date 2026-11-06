import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {AuthSession} from '../auth/oidc.ts';
import type {WorkspaceController} from '../sync/workspace.ts';
import type {PrivacyRuntime} from '../privacy/runtime.ts';
import {ClosureIntentStore,PrivacyError,type AccountPrivacyStatus,type ClosureRequest} from '../privacy/client.ts';
import type {AccountScope} from '../storage/accountStore.ts';
import {PrivacyExportError} from '../privacy/exportStream.ts';
import {ScopedExportError} from '../platform/exportScope.ts';
import {ClientError,describeError} from '../errors.ts';

const noPeerUpdates=()=>()=>{};
const noPeerState=()=>null;

function message(error:unknown,recovering=false):string {
  if(error instanceof ClientError&&['LEGACY_SECRETS_UNVERIFIED','BROWSER_ERASURE_PENDING'].includes(error.code))return describeError(error);
  if(error instanceof ScopedExportError&&error.code==='LEGACY_UNOWNED')return '发现旧版无账号标记的导出副本，尚未确认清理。请联系维护者备份并逐份核对；不会猜测归属、删除其他账号文件或确认成功。';
  const code=error instanceof PrivacyError||error instanceof PrivacyExportError?error.code:'';
  if(code==='RECENT_AUTH_REQUIRED')return '请先重新验证登录，再显式重试同一注销请求。刷新令牌不会替代身份验证。';
  if(code==='AUTH_REQUIRED')return recovering?'本机清理尚未完成，请保留当前登录并使用下方清理按钮重试。':'登录已失效。请重新登录后查询账号状态。';
  if(code==='CHANGED')return '账号或登录会话已变化，本次操作已停止。';
  if(code==='OUTCOME_UNKNOWN')return recovering?'尚未确认设备清理结果。请保留本页，显式重试下方清理确认；不会自动再次提交。':'尚未确认注销结果。请查询状态，或显式重试同一请求；不会自动再次提交。';
  if(code==='TOO_LARGE')return '此保存方式的大小限制不足。请使用支持文件保存的浏览器或原生应用重试。';
  if(code==='BUSY')return '已有导出正在进行，请稍后重试。';
  if(code==='CANCELLED')return '导出已取消，临时文件未发布。';
  if(code==='UNAVAILABLE')return '当前服务或保存环境尚不支持此操作。';
  if(code==='INCOMPLETE')return '导出未完成，或导出期间本机数据有变化。临时文件未发布，请停止编辑后重试。';
  return '操作未完成。请保留当前数据并重试；清理失败不会被确认成成功。';
}

export function PrivacyHost({privacy,auth,controller,apiBaseUrl,open,onClose}:{privacy:PrivacyRuntime;auth:AuthSession;
  controller:WorkspaceController;apiBaseUrl:string;open:boolean;onClose():void}) {
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
  const login=useSyncExternalStore(auth.subscribe,auth.getSnapshot);
  const peer=useSyncExternalStore(privacy.subscribePeerErasure??noPeerUpdates,privacy.getPeerErasure??noPeerState);
  const closed=state.error?.code==='ACCOUNT_CLOSED';
  const identityKey=JSON.stringify(auth.getSubject());
  const [automaticOwner,setAutomaticOwner]=useState<string|null>(()=>closed?identityKey:null);
  const [dismissed,setDismissed]=useState(false);
  useEffect(()=>{if(!closed)setDismissed(false);},[closed]);
  useEffect(()=>{if(peer)setDismissed(false);},[peer?.requestId]);
  useEffect(()=>{if(closed&&!dismissed)setAutomaticOwner(identityKey);},[closed,dismissed,identityKey]);
  if(login.status!=='signed-in'||!open&&automaticOwner!==identityKey&&(!closed||dismissed)&&(!peer||dismissed))return null;
  return <AccountPrivacy key={JSON.stringify(auth.getSubject())} privacy={privacy} auth={auth} apiBaseUrl={apiBaseUrl}
    onClose={()=>{setAutomaticOwner(null);setDismissed(true);onClose();}}/>;
}

export function AccountPrivacy({privacy,auth,apiBaseUrl,onClose}:{privacy:PrivacyRuntime;auth:AuthSession;apiBaseUrl:string;onClose():void}) {
  const peer=useSyncExternalStore(privacy.subscribePeerErasure??noPeerUpdates,privacy.getPeerErasure??noPeerState);
  const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null),mounted=useRef(true),busyRef=useRef(false);
  const cloudCheckbox=useRef<HTMLInputElement>(null),prepareButton=useRef<HTMLButtonElement>(null),retryButton=useRef<HTMLButtonElement>(null),wasConfirming=useRef(false);
  const generation=useRef(0);
  const active=useRef<AbortController|null>(null),owner=useRef(privacy.client.captureIdentity());
  const [status,setStatus]=useState<AccountPrivacyStatus|null>(null),[intent,setIntent]=useState<ClosureRequest|null>(null);
  const [busy,setBusy]=useState(''),[notice,setNotice]=useState(''),[error,setError]=useState(''),[confirming,setConfirming]=useState(false);
  const [cloudConsent,setCloudConsent]=useState(false),[localConsent,setLocalConsent]=useState(false),[deviceConsent,setDeviceConsent]=useState(false),[text,setText]=useState('');
  const intents=useRef(new ClosureIntentStore(localStorage));
  const scope:AccountScope|null=status?{apiBaseUrl,accountId:status.accountId}:null;
  useEffect(()=>{
    if(wasConfirming.current===confirming)return;wasConfirming.current=confirming;
    const target=confirming?cloudCheckbox.current:prepareButton.current;
    target?.focus({preventScroll:true});target?.scrollIntoView?.({block:'nearest'});
  },[confirming]);
  useEffect(()=>{if(intent)retryButton.current?.focus({preventScroll:true});},[intent]);
  useEffect(()=>{if(status?.state==='closed')heading.current?.focus({preventScroll:true});},[status?.state]);
  const current=()=>mounted.current&&owner.current();
  async function run(label:string,work:(signal:AbortSignal)=>Promise<void>) {
    if(busyRef.current||!current())return;busyRef.current=true;setBusy(label);setNotice('');setError('');
    const epoch=generation.current,stop=new AbortController();active.current=stop;
    const live=()=>current()&&generation.current===epoch;
    try{await work(stop.signal);}catch(problem){if(live())setError(message(problem,Boolean(privacy.recoveryStatus?.()||privacy.getPeerErasure?.())));}
    finally{if(active.current===stop){active.current=null;busyRef.current=false;}if(live())setBusy('');}
  }
  const consume=async(value:AccountPrivacyStatus,allowLocal=false)=>{
    if(!current())throw new PrivacyError('CHANGED');setStatus(value);
    const target={apiBaseUrl,accountId:value.accountId};
    const saved=intents.current.read(target);
    if(value.state==='closed'&&saved&&saved.requestId===value.closureRequestId){intents.current.remove(target);setIntent(null);}else setIntent(saved);
    if(value.state==='closed'&&(allowLocal||value.deviceErasure.thisDevicePending)) {
      setBusy('正在清理本机私有副本…');await privacy.erase(value,allowLocal);
      if(current())setNotice('本机私有副本已清理。');
    }
  };
  useEffect(()=>{
    mounted.current=true;generation.current++;const node=dialog.current;
    if(node&&!node.open){if(node.showModal)node.showModal();else node.setAttribute('open','');}
    heading.current?.focus();
    const recovery=privacy.recoveryStatus?.();
    if(privacy.getPeerErasure?.()){setNotice('另一页面已请求清理此账号。请保留本页，核实状态并完成本页确认。');}
    else if(recovery){setStatus(recovery);setNotice('上次已验证账号注销，本机清理尚未完成。请保留当前登录并明确重试清理；设备数量是上次查询结果。');}
    else void run('正在查询账号状态…',async signal=>{await consume(await privacy.client.status(signal));});
    return ()=>{mounted.current=false;generation.current++;active.current?.abort();active.current=null;busyRef.current=false;node?.close?.();};
  },[]);
  useEffect(()=>{
    if(!peer)return;
    generation.current++;active.current?.abort();active.current=null;busyRef.current=false;
    setBusy('');setStatus(null);setIntent(null);setConfirming(false);setLocalConsent(false);setError('');
  },[peer?.requestId]);
  function dismiss(){active.current?.abort();dialog.current?.close();onClose();}
  const refresh=()=>void run('正在查询账号状态…',async signal=>{await consume(await privacy.client.status(signal));});
  const exportData=(local:boolean)=>{
    if(!scope||busyRef.current||!current())return;
    void run('正在准备导出…',async signal=>{
      // The async work starts synchronously in the button gesture.
      const progress=(bytes:number)=>{if(current())setBusy(`正在导出 ${(bytes/1048576).toFixed(1)} MiB…`);};
      const result=await privacy.exportData(scope,local,signal,progress);
      if(current())setNotice(result.destination==='share'?'完整性校验已通过，已打开系统分享。':'完整性校验已通过，导出已保存。');
    });
  };
  const closeAccount=()=>{
    if(!scope||!status||status.state!=='active')return;
    void run('正在提交注销请求…',async signal=>{
      const request=intent??{accountId:scope.accountId,requestId:crypto.randomUUID(),confirmation:'注销 '+scope.accountId,
        deleteCloudCopies:true as const,eraseDevices:deviceConsent};
      if(!intent&&(!cloudConsent||text!==request.confirmation||deviceConsent&&!localConsent))throw new PrivacyError('INVALID');
      intents.current.save(scope,request);if(current())setIntent(request);
      const result=await privacy.client.close(request,signal);await consume(result,localConsent);
      if(current()){setConfirming(false);setNotice('应用账号已注销。身份服务账号与历史备份按各自渠道和保留政策处理。');}
    });
  };
  return <dialog ref={dialog} className="account-privacy" aria-labelledby="privacy-title" onCancel={event=>{event.preventDefault();dismiss();}}>
    <header><h1 id="privacy-title" tabIndex={-1} ref={heading}>数据与隐私</h1><button className="secondary" onClick={dismiss}>关闭</button></header>
    <div className="privacy-content" aria-busy={Boolean(busy)}>
      <p>导出包含私人材料，请选择可信的保存位置。导出与注销均不会调用第三方模型。</p>
      {!peer&&status&&<p className="privacy-state">{status.state==='closed'?'应用账号已注销':'应用账号正常'}<br/><span className="privacy-account-id">{status.accountId}</span></p>}
      <div className="privacy-actions"><button className="secondary" disabled={Boolean(busy)||Boolean(peer)} onClick={refresh}>查询账号状态</button>
        <button className="secondary" disabled={Boolean(busy)||Boolean(peer)||Boolean(privacy.recoveryStatus?.())} onClick={()=>void run('正在重新验证登录…',async()=>auth.signIn({reauthenticate:true}))}>重新验证登录</button></div>
      {peer&&<section aria-labelledby="privacy-peer-title"><h2 id="privacy-peer-title">完成本页清理确认</h2>
        <p>{peer.phase==='preparing'?'正在停止本页私有操作并清理凭据…':peer.failed?'上次操作尚未完成，请保留本页并明确重试。':'本页普通业务已停止，仅保留原会话供清理确认。'}</p>
        <p>将先向服务核实同一账号的注销请求，再清理残留副本并确认本页设备。完成前请保留本页原登录，不要重新登录。</p>
        <label className="privacy-check"><input type="checkbox" checked={localConsent} disabled={Boolean(busy)||peer.phase==='preparing'} onChange={e=>setLocalConsent(e.target.checked)}/>继续清理本机残留，并用本页原会话确认</label>
        <button className="secondary" disabled={Boolean(busy)||peer.phase==='preparing'||!localConsent} onClick={()=>void run('正在核实并完成本页清理…',async signal=>{await privacy.finishPeerErasure(signal);})}>核实并完成本页清理</button>
      </section>}
      {!peer&&status?.state==='active'&&<section aria-labelledby="privacy-export-title"><h2 id="privacy-export-title">导出我的数据</h2>
        <p>服务器导出包含云文库、历史、冲突和云文件。本机导出另含待同步改动、问答、综述、雷达、解析包和缓存 PDF。凭据、私有下载地址和其他设备未同步内容不进入导出。</p>
        <div className="privacy-actions"><button className="primary" disabled={Boolean(busy)} onClick={()=>exportData(false)}>导出服务器数据</button><button className="secondary" disabled={Boolean(busy)} onClick={()=>exportData(true)}>导出本机数据</button></div>
      </section>}
      {!peer&&status?.state==='active'&&<section aria-labelledby="privacy-close-title"><h2 id="privacy-close-title">注销应用账号</h2>
        <p>将永久清除该账号的应用文库、历史、冲突和云文件，并阻止再次绑定。原始文件、身份服务资料及加密历史备份分别处理。请先导出尚需保留的内容。</p>
        {intent?<><p role="status">上次请求尚待确认。先查询状态，或显式重试同一请求。设备清理请求：{intent.eraseDevices?'已选择':'未选择'}。</p>
          <button ref={retryButton} className="danger" disabled={Boolean(busy)} onClick={closeAccount}>重试同一注销请求</button></>:
          !confirming?<button ref={prepareButton} className="secondary danger" disabled={Boolean(busy)} onClick={()=>setConfirming(true)}>准备注销账号</button>:
          <fieldset disabled={Boolean(busy)}><legend>分别确认清理范围</legend>
            <label className="privacy-check"><input ref={cloudCheckbox} type="checkbox" checked={cloudConsent} onChange={e=>setCloudConsent(e.target.checked)}/>永久删除应用账号及全部云副本</label>
            <label className="privacy-check"><input type="checkbox" checked={localConsent} onChange={e=>{setLocalConsent(e.target.checked);if(!e.target.checked)setDeviceConsent(false);}}/>注销成功后清理本机副本、离线 PDF 与本账号凭据；未同步内容也会丢失</label>
            <label className="privacy-check"><input type="checkbox" disabled={!localConsent} checked={deviceConsent} onChange={e=>setDeviceConsent(e.target.checked)}/>请求所有已绑定设备在联网后清理各自副本（包含本机）；离线设备保持待执行</label>
            <label className="field">输入 <code>注销 {status.accountId}</code><input autoComplete="off" spellCheck={false} value={text} onChange={e=>setText(e.target.value)}/></label>
            <div className="privacy-actions"><button className="secondary" onClick={()=>setConfirming(false)}>返回</button><button className="danger" disabled={!cloudConsent||text!=='注销 '+status.accountId} onClick={closeAccount}>确认永久注销</button></div>
          </fieldset>}
      </section>}
      {!peer&&status?.state==='closed'&&<section><h2>设备清理状态</h2><p>待执行 {status.deviceErasure.pending} 台，已确认 {status.deviceErasure.acknowledged} 台。设备只有实际清理成功后才确认，长期离线或丢失设备无法证明擦除。</p>
        <label className="privacy-check"><input type="checkbox" checked={localConsent} onChange={e=>setLocalConsent(e.target.checked)}/>清理本机此账号的副本与凭据，接受丢失本机未同步内容</label>
        <button className="secondary" disabled={Boolean(busy)||!localConsent} onClick={()=>void run('正在清理本机私有副本…',async()=>{await privacy.erase(status,true);})}>清理本机并完成确认</button>
      </section>}
      <p className="privacy-progress" role="status" aria-live="polite" aria-atomic="true">{busy||notice}</p>
      {busy.startsWith('正在导出')&&<button className="secondary" onClick={()=>active.current?.abort()}>取消导出</button>}
      {error&&<p role="alert" className="error-message">{error}</p>}
    </div>
  </dialog>;
}
