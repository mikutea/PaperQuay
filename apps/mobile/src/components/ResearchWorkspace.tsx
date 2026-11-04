import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { listVisibleEntities, validateEntityData, type AccountSyncState, type AttachmentVersionData, type PaperData } from '../../../../packages/sync-core/src/index.ts';
import { AiClient } from '../ai/client.ts';
import { describeAiError } from '../ai/errors.ts';
import { LocalAiConfigStore, parseAiProvider } from '../ai/provider.ts';
import type { AiAccountScope, AiProviderConfig, AiTransport, SecretStore } from '../ai/types.ts';
import { getParsedCache, type ParsedCache } from '../parsed/cache.ts';
import { exportFilename, exportTextFile } from '../platform/exportFile.ts';
import { ResearchError, RESEARCH_LIMITS, prepareResearchContext, researchCitations, type ResearchContext } from '../research/context.ts';
import { collectResearchSources, researchSelectionSignature, type ResearchSelection } from '../research/sources.ts';
import { ResearchSession, researchResultMarkdown } from '../research/session.ts';
import { researchContextFromRetrieval, selectedRetrievalEvidence } from '../research/fromRetrieval.ts';
import { RetrievalError, describeRetrievalError, type RetrievalContext } from '../retrieval/client.ts';
import { assertRetrievalSourcesCurrent } from '../retrieval/session.ts';
import type { WorkspaceController } from '../sync/workspace.ts';
import { MarkdownPreview } from './MarkdownPreview.tsx';
import { ReaderSheet } from './ReaderSheet.tsx';
import { TaskAiSettingsEntry, TaskAiSettingsSheet } from './TaskAiSettings.tsx';
import { RemoteRetrievalSheet, type RemoteRetrievalChoice } from './RemoteRetrievalSheet.tsx';
import './researchWorkspace.css';

interface Props {
  scope: AiAccountScope; scopeKey: string; controller: WorkspaceController; secretStore: SecretStore;
  accountCurrent(): boolean; onClose(): void; cache?: ParsedCache; transport?: AiTransport;
  modelRouter?: import('../modelRouting/router.ts').MobileModelRouter;
  retrieval?: RetrievalContext;
}
const descriptions:Record<ResearchError['code'],string>={INVALID:'来源或发送内容无效。解析来源需有已确认页数和本机核验缓存，请在阅读器中先准备。',LIMIT:'文献、文本或结果超过本机预算。请减少来源或导出结果文件。',EMPTY:'所选来源没有本机可用文本，请先准备解析缓存或明确改选题录摘要。',NO_MATCH:'没有匹配片段。请修改检索问题，或明确选择发送所选来源片段。',CHANGED:'账号、来源或输入已变化，旧操作已停止。请重新预览。'};
function errorMessage(error:unknown){return error instanceof RetrievalError?describeRetrievalError(error):error instanceof ResearchError?descriptions[error.code]:'本次操作未完成。请检查模型设置、连接或本机存储后重试。';}
function selectedEntities(sync:Readonly<AccountSyncState>,selections:ResearchSelection[]){const wanted=new Set(selections.flatMap(s=>['paper:'+s.paperId,...(s.versionId?['attachmentVersion:'+s.versionId]:[])]));return listVisibleEntities(sync as AccountSyncState).filter(e=>wanted.has(e.entityType+':'+e.entityId));}
function loadConfig(scope:AiAccountScope){return parseAiProvider(new LocalAiConfigStore(localStorage).load(scope),true);}

export function ResearchWorkspace(props:Props){
  const id=useId(),latest=useRef(props);latest.current=props;
  const snapshot=useSyncExternalStore(props.controller.subscribe,props.controller.getSnapshot,props.controller.getSnapshot);
  const entities=useMemo(()=>snapshot.workspace?listVisibleEntities(snapshot.workspace.sync):[],[snapshot.workspace]);
  const papers=useMemo(()=>entities.filter(e=>e.entityType==='paper'&&!e.deleted&&e.data),[entities]);
  const [query,setQuery]=useState(''),[chosen,setChosen]=useState<Record<string,string|null>>({}),[question,setQuestion]=useState(''),[mode,setMode]=useState<'search'|'selected'>('search');
  const [providerPreview,setProviderPreview]=useState<AiProviderConfig|null>(null);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [retrievalOpen,setRetrievalOpen]=useState(false),[remoteChoice,setRemoteChoice]=useState<RemoteRetrievalChoice|null>(null);
  const preparedRef=useRef<{context:ResearchContext;provider:AiProviderConfig|null}|null>(null);
  const [context,setContext]=useState<ResearchContext|null>(null),[phase,setPhase]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const session=useMemo(()=>new ResearchSession(new AiClient(props.secretStore,props.transport)),[props.secretStore,props.transport]);
  const resultState=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot);
  const mounted=useRef(false),epoch=useRef(0),flight=useRef(false),abort=useRef<AbortController|null>(null);
  const selections=useMemo(()=>Object.entries(chosen).map(([paperId,versionId])=>({paperId,versionId})),[chosen]);
  const sourceSignature=researchSelectionSignature(entities,selections);
  const visible=papers.filter(e=>{const p=e.data as PaperData;return[p.title,...p.authors,...p.keywords,p.abstractText].some(v=>v?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));});
  function scopeCurrent(){const p=latest.current,s=p.controller.getSnapshot(),sync=s.workspace?.sync;return mounted.current&&p.accountCurrent()&&s.status==='ready'&&sync?.accountId===p.scope.accountId
    &&JSON.stringify([sync.accountId,sync.deviceId,sync.generation])===p.scopeKey;}
  function invalidate(){preparedRef.current=null;epoch.current++;abort.current?.abort();abort.current=null;flight.current=false;session.reset();setContext(null);setProviderPreview(null);setPhase('');setError('');setNotice('');}
  useLayoutEffect(()=>{mounted.current=true;session.activate();return()=>{mounted.current=false;epoch.current++;abort.current?.abort();session.dispose();};},[session]);
  useLayoutEffect(()=>{invalidate();},[props.scopeKey,props.scope.apiBaseUrl,sourceSignature,session]);
  useLayoutEffect(()=>{setRemoteChoice(null);setRetrievalOpen(false);},[props.scopeKey,props.scope.apiBaseUrl,props.controller]);
  function changeInputs(work:()=>void){invalidate();work();}
  function configureAi(){
    if(flight.current||session.getSnapshot().busy||!scopeCurrent())return;
    preparedRef.current=null;setContext(null);setProviderPreview(null);setError('');setNotice('');setSettingsOpen(true);
  }
  async function run(label:string,work:(task:{signal:AbortSignal;current():boolean;check():void})=>Promise<void>,replacement?:{selections:ResearchSelection[];remote:RemoteRetrievalChoice}){
    if(flight.current||!scopeCurrent())return;flight.current=true;const token=++epoch.current,controller=new AbortController();abort.current=controller;
    const captured=structuredClone(replacement?.selections??selections),remote=replacement?.remote??remoteChoice;
    const signature=replacement?researchSelectionSignature(selectedEntities(latest.current.controller.getSnapshot().workspace!.sync,captured),captured):sourceSignature;
    let checkedWorkspace:unknown=null,checkedSignature='',sourceChanged=false;
    const current=()=>{const s=latest.current.controller.getSnapshot();if(token!==epoch.current||controller.signal.aborted||!scopeCurrent()||!s.workspace)return false;
      if(s.workspace!==checkedWorkspace){
        if(remote){try{const indices=[...new Set(selectedRetrievalEvidence(remote.receipt,remote.evidenceIds).map(row=>row.sourceIndex))];assertRetrievalSourcesCurrent({...remote.receipt.request,sources:indices.map(index=>remote.receipt.request.sources[index])},s.workspace.sync,s.workspace.pendingResolutions);}catch{sourceChanged=true;return false;}}
        checkedSignature=researchSelectionSignature(selectedEntities(s.workspace.sync,captured),captured);checkedWorkspace=s.workspace;
      }
      return checkedSignature===signature;};
    const check=()=>{if(!current())throw sourceChanged?new RetrievalError('SOURCE_CHANGED'):new ResearchError('CHANGED');};
    setPhase(label);setError('');setNotice('');
    try{check();await work({signal:controller.signal,current,check});}
    catch(failure){if(mounted.current&&token===epoch.current)setError(errorMessage(failure));}
    finally{if(mounted.current&&token===epoch.current){flight.current=false;abort.current=null;setPhase('');}}
  }
  async function prepare(task:{signal:AbortSignal;current():boolean;check():void}){
    if(remoteChoice){const w=latest.current.controller.getSnapshot().workspace!;const prepared=await researchContextFromRetrieval({...remoteChoice,sync:w.sync,pendingResolutions:w.pendingResolutions,question});task.check();return prepared;}
    const sources=await collectResearchSources({scope:props.scope,entities:selectedEntities(props.controller.getSnapshot().workspace!.sync,selections),selections,
      cache:props.cache??getParsedCache(),signal:task.signal,current:task.current});task.check();
    const prepared=await prepareResearchContext(sources,question,mode);task.check();return prepared;
  }
  function preview(){void run(remoteChoice?'正在核验所选远程原文…':'正在核验与检索本机来源…',async task=>{const prepared=await prepare(task);task.check();session.reset();setContext(prepared);let provider:AiProviderConfig|null=null;try{provider=loadConfig(props.scope);}catch{}preparedRef.current={context:prepared,provider};setProviderPreview(provider);setNotice(provider?'来源已准备。请核对实际片段、模型与地址，再明确发送。':'来源已准备。点击“设置 AI”选择模型，返回后重新预览即可。');});}
  function generate(){if(!context||!providerPreview||preparedRef.current?.context!==context||preparedRef.current.provider!==providerPreview||session.getSnapshot().result)return;void run('正在生成多篇问答…',async task=>{
    const prepared=await prepare(task);if(prepared.digest!==context.digest){setContext(null);throw new ResearchError('CHANGED');}
    const config=loadConfig(props.scope),configKey=JSON.stringify(config);if(configKey!==JSON.stringify(providerPreview)){preparedRef.current=null;setContext(null);setProviderPreview(null);throw new ResearchError('CHANGED');}
    const current=()=>{try{return task.current()&&JSON.stringify(loadConfig(latest.current.scope))===configKey;}catch{return false;}};
    await session.start({scope:props.scope,config,context:prepared,current});task.check();
  });}
  function stop(){epoch.current++;abort.current?.abort();abort.current=null;flight.current=false;session.cancel();setPhase('');setNotice('已停止本次等待。已经发生的模型用量以服务商账单为准。');}
  function save(){const result=session.getSnapshot().result;if(!result||result.status==='running')return;void run('正在核验并保存结果…',async task=>{
    const prepared=await prepare(task);if(prepared.digest!==result.context.digest)throw new ResearchError('CHANGED');
    const data={title:('多篇问答：'+prepared.question).slice(0,2048),paperId:null,format:'markdown' as const,body:researchResultMarkdown(result)};
    if(!validateEntityData('note',data).ok)throw new ResearchError('LIMIT');
    const expected=researchSelectionSignature(selectedEntities(props.controller.getSnapshot().workspace!.sync,selections),selections);
    const created=await props.controller.saveNewNoteOnce(result.id,data,sync=>{
      task.check();if(researchSelectionSignature(selectedEntities(sync,selections),selections)!==expected)throw new ResearchError('CHANGED');
    });task.check();setNotice(created?'已在当前账号保存一篇独立笔记，包含实际发送片段、来源摘要和结果状态。':'此问答结果已保存，没有新增重复笔记。');
  });}
  function download(){const result=session.getSnapshot().result;if(!result||result.status==='running')return;void run('正在导出结果与证据…',async task=>{
    const prepared=await prepare(task);if(prepared.digest!==result.context.digest)throw new ResearchError('CHANGED');
    await exportTextFile({name:exportFilename('多篇问答','md'),mime:'text/markdown',text:researchResultMarkdown(result)},task.current);task.check();setNotice('已准备问答与实际证据文件。');
  });}
  function adoptRemote(receipt:RemoteRetrievalChoice['receipt'],evidenceIds:string[]){
    if(!scopeCurrent())return;
    try{const next:Record<string,string>={};for(const row of selectedRetrievalEvidence(receipt,evidenceIds)){const source=receipt.request.sources[row.sourceIndex];next[source.target.paperId]=source.target.attachmentVersionId;}
      const remote={receipt,evidenceIds:[...evidenceIds]},nextQuestion=question.trim()?question:receipt.request.query;
      void run('正在核对选中的远程原文…',async task=>{const w=latest.current.controller.getSnapshot().workspace!;
        await researchContextFromRetrieval({...remote,sync:w.sync,pendingResolutions:w.pendingResolutions,question:nextQuestion});task.check();
        invalidate();setRemoteChoice(remote);setChosen(next);setQuestion(nextQuestion);setRetrievalOpen(false);
      },{remote,selections:Object.entries(next).map(([paperId,versionId])=>({paperId,versionId}))});
    }catch(failure){setError(errorMessage(failure));}
  }
  const result=resultState.result,citations=result?researchCitations(result.text,result.context):null,busy=Boolean(phase);
  return <><ReaderSheet open title="多篇文献问答" onClose={props.onClose} className="research-sheet">
    <div className="research-workspace">
      <TaskAiSettingsEntry scope={props.scope} disabled={busy} onOpen={configureAi} />
      <p className="muted">选择至多{RESEARCH_LIMITS.sources}篇文献，核对来源后再发送给你配置的模型。问答仅在此窗口保留，可保存到笔记或导出。</p>
      {props.retrieval&&<section className="research-selected"><p>需要从账号已有索引中查找原文？明确选择文献和片段后，返回这里核对模型发送内容。</p><button type="button" className="secondary" disabled={busy} onClick={()=>{if(scopeCurrent()){preparedRef.current=null;setContext(null);setProviderPreview(null);setRetrievalOpen(true);}}}>到账号索引中查找</button></section>}
      <fieldset disabled={busy} className="research-inputs"><legend>1 · 选择文献与来源</legend>
        {remoteChoice?<section aria-label="已选远程关键词原文"><p>采用远程关键词检索原文 · {remoteChoice.evidenceIds.length} 个明确选中片段</p><blockquote>{remoteChoice.receipt.request.query}</blockquote><ul>{selections.map(s=><li key={s.paperId}>{(papers.find(p=>p.entityId===s.paperId)?.data as PaperData|undefined)?.title??'对应文献当前不可用'}</li>)}</ul><p className="muted">修改问题后仍使用这些原文；重新选择片段可再次打开账号检索。不会自动改用题录摘要。</p><button type="button" className="secondary" onClick={()=>changeInputs(()=>{setRemoteChoice(null);setChosen({});})}>改选本机来源</button></section>:<>
        <label className="field" htmlFor={id+'-search'}>查找文库<input id={id+'-search'} type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="标题、作者或关键词" /></label>
        <p className="muted">已选 {selections.length}/{RESEARCH_LIMITS.sources} 篇。{visible.length>100?'显示前100条，请搜索缩小范围。':''}</p>
        <ul className="research-paper-list">{visible.slice(0,100).map(entity=>{const paper=entity.data as PaperData,selected=Object.hasOwn(chosen,entity.entityId),versions=entities.filter(e=>e.entityType==='attachmentVersion'&&!e.deleted&&(e.data as AttachmentVersionData|null)?.paperId===entity.entityId&&Number((e.data as AttachmentVersionData).pageCount)>0);
          return <li key={entity.entityId}><label className="research-paper-choice"><input type="checkbox" checked={selected} disabled={!selected&&selections.length>=RESEARCH_LIMITS.sources} onChange={e=>{const checked=e.target.checked;changeInputs(()=>setChosen(old=>{const next={...old};if(checked)next[entity.entityId]=null;else delete next[entity.entityId];return next;}));}}/><span><strong>{paper.title}</strong><small>{paper.authors.slice(0,3).join(' · ')}{paper.year?' · '+paper.year:''}</small></span></label>
            {selected&&<label className="field">用于问答的来源<select aria-label={paper.title+'的问答来源'} value={chosen[entity.entityId]??''} onChange={e=>{const value=e.target.value||null;changeInputs(()=>setChosen(old=>({...old,[entity.entityId]:value})));}}><option value="">仅题录与摘要（未提供全文）</option>{versions.map(v=><option key={v.entityId} value={v.entityId}>本机解析 · {(v.data as AttachmentVersionData).fileName} · {(v.data as AttachmentVersionData).sha256.slice(0,8)}</option>)}</select></label>}
          </li>;})}</ul>{!visible.length&&<p role="status">没有匹配文献。</p>}
        {selections.length>0&&<div className="research-selected"><strong>已选文献</strong>{selections.map(s=><button type="button" key={s.paperId} className="text-button" onClick={()=>changeInputs(()=>setChosen(old=>{const next={...old};delete next[s.paperId];return next;}))}>移除 {(papers.find(p=>p.entityId===s.paperId)?.data as PaperData|undefined)?.title??s.paperId}</button>)}</div>}
        </>}
        <label className="field" htmlFor={id+'-question'}>2 · 问题<textarea id={id+'-question'} value={question} maxLength={RESEARCH_LIMITS.questionBytes} rows={3} onChange={e=>changeInputs(()=>setQuestion(e.target.value))} placeholder="这些文献在研究方法上有什么异同？" /></label>
        {!remoteChoice&&<><label className="field" htmlFor={id+'-mode'}>片段选择<select id={id+'-mode'} value={mode} onChange={e=>changeInputs(()=>setMode(e.target.value as typeof mode))}><option value="search">按问题关键词检索</option><option value="selected">明确采用所选来源片段</option></select></label><p className="muted">最多发送{RESEARCH_LIMITS.evidence}个片段。关键词检索无匹配时停止；仅选择解析来源不会联网获取文件或提交解析任务。</p></>}
        <button type="button" className="secondary" disabled={!selections.length||!question.trim()} onClick={preview}>准备并预览发送内容</button>
      </fieldset>
      {context&&<section className="research-context" aria-label="实际发送内容"><h3>3 · 核对后发送</h3>
        <p>{context.sources.length}篇来源 · {context.evidence.length}个片段 · {context.omittedChunks}个片段未发送</p>
        <ul>{context.sources.map((s,i)=><li key={s.paperId}>S{i+1} · {s.title} · {s.kind==='remote-index'?'远程关键词检索原文':s.kind==='parsed'?'已核验解析片段':'题录与摘要，未提供全文'} · {s.selectedChunks}/{s.totalChunks}片段</li>)}</ul>
        <details><summary>查看实际片段</summary>{context.evidence.map(e=><article key={e.id}><h4>[{e.id}] {e.pageIndex===null?'题录摘要':'第'+(e.pageIndex+1)+'页'}</h4><pre>{e.text}</pre></article>)}</details>
        {providerPreview?<p className="research-provider" role="status">模型：{providerPreview.model}<br/>地址：{providerPreview.endpoint}</p>:<p role="status">尚未选择模型。先点击上方“设置 AI”，返回后重新准备发送内容。</p>}
        <p className="muted">未估算费用或token，请确认服务商计费规则。每次预览只启动一次生成；需要再次提问请重新准备。</p>
        <button type="button" className="primary" disabled={busy||!providerPreview||Boolean(resultState.result)} onClick={generate}>发送以上片段并提问</button>
      </section>}
      {busy&&<p role="status">{phase} <button className="secondary" type="button" onClick={stop}>停止本次等待</button></p>}
      {result&&<section className="research-answer" aria-label="多篇问答结果"><h3>回答</h3><p role="status">{result.status==='running'?'正在接收实际模型输出':result.status==='complete'?'已完成':result.status==='cancelled'?'已取消，以下为已接收部分':result.status==='incomplete'?'输出未完整结束':'请求失败，以下可能为已接收部分'}</p>
        <MarkdownPreview body={result.text}/><p className="muted">模型 {result.provider.model} · 用量 {result.usage?result.usage.totalTokens+' tokens':'未知'} · 费用未知</p>
        {citations&&<><h4>引用核对</h4><p>{citations.verified.length}个编号对应本次实际片段；编号匹配不证明结论正确。</p>{citations.unverified.length>0&&<p role="alert">未找到来源的编号：{citations.unverified.join('、')}</p>}
          {citations.verified.map(e=><details key={e.id}><summary>查看 [{e.id}] 的实际证据</summary><p>{result.context.sources[e.sourceIndex].title} · {e.pageIndex===null?'题录摘要':'第'+(e.pageIndex+1)+'页'}</p><pre>{e.text}</pre></details>)}
          {!citations.verified.length&&result.text&&<p className="muted">回答没有可核对的证据编号，请自行核查。</p>}</>}
        <div className="research-actions"><button type="button" className="secondary" disabled={busy||!result.text.trim()} onClick={save}>保存结果与来源到笔记</button><button type="button" className="secondary" disabled={busy||!result.text.trim()} onClick={download}>导出问答与实际证据</button></div>
      </section>}
      {resultState.failure&&<p role="alert" className="inline-error">{describeAiError(resultState.failure)}</p>}
      {error&&<p role="alert" className="inline-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    </div>
  </ReaderSheet>{settingsOpen&&<TaskAiSettingsSheet accountScope={props.scope} secretStore={props.secretStore} transport={props.transport} modelRouter={props.modelRouter} returnTo="多篇问答" onClose={()=>setSettingsOpen(false)} />}{retrievalOpen&&props.retrieval&&<RemoteRetrievalSheet context={props.retrieval} scopeKey={props.scopeKey} controller={props.controller} accountCurrent={props.accountCurrent} initialQuery={question} onClose={()=>setRetrievalOpen(false)} onUse={adoptRemote}/>}</>;
}
