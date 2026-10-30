import {useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {ServiceCapabilitySnapshot} from '../api.ts';
import type {RemoteTaskContext} from '../remote/client.ts';
import type {CloudPdfContext} from '../pdf/cloudCopies.ts';
import type {DesktopPdfContext} from '../pdf/desktopCopies.ts';
import type {SecretStore} from '../platform/secretStore.ts';
import {LocalAiConfigStore,parseAiProvider} from '../ai/provider.ts';
import {getPlatformCapabilities} from '../platform.ts';
import type {AccountScope} from '../storage/accountStore.ts';
import type {WorkspaceController} from '../sync/workspace.ts';
import {FeatureInspector} from '../capabilities/inspector.ts';
import {capabilityCatalog,featureGroups,featureModeLabels,featureStateLabels,type FeatureAction,type FeatureEnvironment} from '../capabilities/catalog.ts';
import {ReaderSheet} from './ReaderSheet.tsx';
import './capabilities.css';
interface CapabilityRuntime {
 secretStore?:SecretStore;cloudPdf?:CloudPdfContext;desktopPdf?:DesktopPdfContext;remoteTasks?:RemoteTaskContext;
 inspectCapabilities?(signal:AbortSignal):Promise<ServiceCapabilitySnapshot>;
}
interface Props {runtime:CapabilityRuntime;controller:WorkspaceController;scope:AccountScope;scopeKey:string;incomingShare:boolean;current():boolean;onClose():void;onNavigate(action:FeatureAction):void}
const actionLabels:Record<FeatureAction,string>={library:'前往文库',notes:'前往笔记',sync:'设备与同步',conflicts:'查看已收到的冲突',transfer:'导入与导出',incoming:'处理系统分享',cloud:'管理私有副本',remote:'查看远程任务',zotero:'接入Zotero',research:'多篇文献问答',review:'打开文献综述','ai-settings':'检查模型设置',exports:'导出笔记与引用'};
export function CapabilitySheet(props:Props){
 const id=useId(),latest=useRef(props);latest.current=props;
 const state=useSyncExternalStore(props.controller.subscribe,props.controller.getSnapshot,props.controller.getSnapshot);
 const mounted=useRef(false),[,tickClock]=useState(0),[query,setQuery]=useState(''),[filter,setFilter]=useState<'all'|'local'|'remote'|'pending'>('all');
 function current(){const p=latest.current,s=p.controller.getSnapshot(),sync=s.workspace?.sync;return mounted.current&&p.current()&&s.status==='ready'&&sync?.accountId===p.scope.accountId&&JSON.stringify([sync.accountId,sync.deviceId,sync.generation])===p.scopeKey;}
 const inspector=useMemo(()=>new FeatureInspector({current,readService:signal=>latest.current.runtime.inspectCapabilities?.(signal)??Promise.reject(new Error('No inspector')),remote:props.runtime.remoteTasks}),[props.controller,props.runtime,props.scopeKey]);
 const inspection=useSyncExternalStore(inspector.subscribe,inspector.getSnapshot,inspector.getSnapshot);
 useEffect(()=>{mounted.current=true;inspector.activate();const timer=setInterval(()=>tickClock(value=>value+1),1000);return()=>{mounted.current=false;clearInterval(timer);inspector.dispose();};},[inspector]);
 useEffect(()=>{if(state.online&&!state.needsLogin&&props.runtime.inspectCapabilities)void inspector.inspect();else if(inspector.getSnapshot().status==='loading')inspector.stop();},[inspector,state.online,state.needsLogin,props.runtime.inspectCapabilities]);
 const configured=useMemo(()=>{try{parseAiProvider(new LocalAiConfigStore(localStorage).load(props.scope),true);return true;}catch{return false;}},[props.scope.apiBaseUrl,props.scope.accountId,inspection.checkedAt]);
 const platform=getPlatformCapabilities(),content=props.controller.getContentCapabilities();
 const env:FeatureEnvironment={ready:state.status==='ready'&&Boolean(state.workspace),online:state.online,needsLogin:state.needsLogin,native:platform.native,nativeAuthentication:platform.nativeAuthentication,webRtc:typeof RTCPeerConnection==='function',
  secretPersistence:props.runtime.secretStore?.persistence??null,incomingShare:props.incomingShare,localOrganization:Boolean(state.workspace?.paperOrganizationVersion)&&(!state.online||state.needsLogin||!inspection.service||inspection.service.paperOrganization),localRichNotes:content.richNotes&&(!state.online||state.needsLogin||!inspection.service||inspection.service.richNotes),localAiConversations:content.aiConversations&&(!state.online||state.needsLogin||!inspection.service||inspection.service.aiConversations),
  modelRuntime:Boolean(props.runtime.secretStore),cloudClient:Boolean(props.runtime.cloudPdf),desktopClient:Boolean(props.runtime.desktopPdf),remoteClient:Boolean(props.runtime.remoteTasks),aiConfigured:configured,inspection,now:Date.now()};
 const catalog=capabilityCatalog(env),needle=query.trim().toLocaleLowerCase();
 const rows=catalog.filter(row=>(filter==='all'||filter==='local'&&row.mode==='local'||filter==='remote'&&['service','computer','external','mixed'].includes(row.mode)||filter==='pending'&&['planned','partial','managed'].includes(row.state))&&(!needle||[row.id,row.title,row.reason,featureModeLabels[row.mode]].some(value=>value.toLocaleLowerCase().includes(needle))));
 const canInspect=state.online&&!state.needsLogin&&Boolean(props.runtime.inspectCapabilities);
 return <ReaderSheet open title="功能与可用性" onClose={props.onClose} className="capability-sheet"><div className="capability-workspace">
  <section className="capability-overview" aria-label="当前运行环境"><p className="eyebrow">在此设备上继续研究</p><h3>本机与远程能力</h3><p>逐项查看执行位置和准备条件。功能接入与实际连接状态分别说明，具体文献和目标设备仍需核对。</p>
   <dl><div><dt>本机支持</dt><dd>{catalog.filter(row=>row.state==='available').length}</dd></div><div><dt>需要准备</dt><dd>{catalog.filter(row=>['conditional','unavailable'].includes(row.state)).length}</dd></div><div><dt>待完善或管理端</dt><dd>{catalog.filter(row=>['planned','partial','managed'].includes(row.state)).length}</dd></div></dl>
   <p className="muted">{platform.native?'原生应用':'浏览器'} · {state.online?'设备报告有网络':'设备当前离线'}{state.needsLogin?' · 需要重新登录':''}</p>
  </section>
  <section className="capability-check" aria-label="检查服务与电脑"><div className="capability-check-heading"><h3>服务与电脑</h3><button type="button" className="secondary" disabled={!canInspect||inspection.status==='loading'} onClick={()=>void inspector.inspect()}>检查服务与电脑</button></div>
   {inspection.status==='loading'?<p role="status">正在读取服务声明与电脑公开配置… <button type="button" className="text-button" onClick={inspector.stop}>停止本次检查</button></p>:<p className="muted" role="status">{!state.online?'离线时保留本机功能。联网后可重新检查远程能力。':state.needsLogin?'请先在账号页重新登录，再检查服务与电脑。':!props.runtime.inspectCapabilities?'此运行环境尚未提供服务检查。':inspection.checkedAt?'最近检查：'+new Date(inspection.checkedAt).toLocaleString():'尚未成功核对当前服务。'}</p>}
   {inspection.error&&<p className="inline-error" role="alert">{inspection.error}</p>}
   <p className="capability-footnote">这次检查不会上传文件、提交任务或调用模型。电脑信息会过期；打开具体功能时仍会核对权限、来源与配额。</p>
  </section>
  <label className="field capability-search" htmlFor={id+'-search'}>查找功能<input id={id+'-search'} type="search" placeholder="搜索功能、准备条件或需求编号" value={query} onChange={event=>setQuery(event.target.value)}/></label>
  <div className="capability-filters" role="group" aria-label="筛选能力">{([['all','全部'],['local','在此设备'],['remote','涉及远程'],['pending','待完善']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div>
  <p className="muted capability-results" role="status">显示 {rows.length} / {catalog.length} 项{needle?' · 搜索结果':''}</p>
  {!rows.length&&<div className="capability-empty"><h3>没有匹配的功能</h3><p className="muted">换个关键词，或清除筛选查看完整清单。</p><button type="button" className="secondary" onClick={()=>{setQuery('');setFilter('all');}}>清除搜索与筛选</button></div>}
  {Object.entries(featureGroups).map(([key,label])=>{const group=rows.filter(row=>row.group===key);return group.length?<section className="capability-group" key={key} aria-label={label}><h3>{label}</h3><ul>{group.map(row=><li key={row.id} data-feature-id={row.id} data-feature-state={row.state}><details><summary><span className="capability-feature-title"><strong>{row.title}</strong><small>{featureModeLabels[row.mode]} · {row.id}</small></span><span className="capability-state" data-state={row.state}>{featureStateLabels[row.state]}</span></summary><div className="capability-detail"><p>{row.reason}</p>{row.action&&<button type="button" className="text-button" onClick={()=>{if(current())latest.current.onNavigate(row.action!);}}>{actionLabels[row.action]}</button>}</div></details></li>)}</ul></section>:null;})}
  <p className="muted capability-footer">本页依据此版本的接入范围、当前运行环境和最近检查结果。账号注销、正式发布与恢复演练等管理能力仍按各自进度交付。</p>
 </div></ReaderSheet>;
}
