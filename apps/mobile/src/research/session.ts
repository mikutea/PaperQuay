import type { AiClient } from '../ai/client.ts';
import { aiAccountKey, parseAiProvider } from '../ai/provider.ts';
import { aiFailure } from '../ai/errors.ts';
import type { AiAccountScope, AiFailure, AiProviderConfig, AiUsage } from '../ai/types.ts';
import { ResearchError, validateResearchContext, type ResearchContext } from './context.ts';
export interface ResearchResult {
  id: string; context: ResearchContext; provider: {id:string;endpoint:string;model:string}; text: string;
  status: 'running'|'complete'|'incomplete'|'failed'|'cancelled'; startedAt: string; finishedAt: string|null;
  usage: AiUsage|null; failure: AiFailure|null; cost:'unknown';
}
export interface ResearchSnapshot { busy:boolean; result:ResearchResult|null; failure:AiFailure|null }
export class ResearchSession {
  private snapshot:ResearchSnapshot={busy:false,result:null,failure:null}; private listeners=new Set<()=>void>();
  private epoch=0; private abort:AbortController|null=null; private disposed=false;
  constructor(private client:Pick<AiClient,'generateResearch'>){}
  activate=()=>{this.disposed=false;};
  getSnapshot=()=>this.snapshot;
  subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
  private publish(snapshot:ResearchSnapshot){this.snapshot=snapshot;for(const listener of this.listeners)listener();}
  reset=()=>{this.epoch++;this.abort?.abort();this.abort=null;this.publish({busy:false,result:null,failure:null});};
  cancel=()=>{this.epoch++;this.abort?.abort();this.abort=null;const r=this.snapshot.result;this.publish({...this.snapshot,busy:false,
    result:r?.status==='running'?{...r,status:'cancelled',finishedAt:new Date().toISOString(),failure:{code:'CANCELLED'}}:r});};
  async start(input:{scope:AiAccountScope;config:AiProviderConfig;context:ResearchContext;current():boolean}):Promise<void>{
    if(this.disposed||this.snapshot.busy||!input.current())return;
    this.reset();const epoch=this.epoch,abort=new AbortController();this.abort=abort;
    const current=()=>!this.disposed&&epoch===this.epoch&&input.current();
    this.publish({busy:true,result:null,failure:null});
    try{
      aiAccountKey(input.scope);const config=parseAiProvider(input.config,true),scope={...input.scope};
      const context=await validateResearchContext(input.context);if(!current())return;
      const result:ResearchResult={id:crypto.randomUUID(),context,provider:{id:config.id,endpoint:config.endpoint,model:config.model},text:'',status:'running',startedAt:new Date().toISOString(),finishedAt:null,usage:null,failure:null,cost:'unknown'};
      this.publish({busy:true,result,failure:null});
      const completed=await this.client.generateResearch({accountScope:scope,config,context,requestId:result.id,current,signal:abort.signal,
        onText:text=>{if(!current())throw new ResearchError('CHANGED');this.publish({...this.snapshot,result:{...this.snapshot.result!,text}});},
        onUsage:usage=>{if(!current())throw new ResearchError('CHANGED');this.publish({...this.snapshot,result:{...this.snapshot.result!,usage}});}});
      if(!current())return;
      const failure=completed.finishReason==='length'?{code:'OUTPUT_TRUNCATED' as const}:completed.finishReason==='content_filter'?{code:'CONTENT_FILTERED' as const}:null;
      this.publish({busy:false,result:{...this.snapshot.result!,...completed,status:failure?'incomplete':'complete',finishedAt:new Date().toISOString(),failure},failure});
    }catch(error){if(current()){const failure=aiFailure(error);this.publish({busy:false,result:this.snapshot.result?{...this.snapshot.result,status:'failed',finishedAt:new Date().toISOString(),failure}:null,failure});}}
    finally{if(epoch===this.epoch){this.abort=null;if(!current()&&!this.disposed)this.reset();}}
  }
  dispose=()=>{this.reset();this.disposed=true;};
}
export function researchResultMarkdown(result:ResearchResult):string{
  if(result.status==='running'||!result.text.trim())throw new ResearchError('EMPTY');
  const c=result.context;
  return ['# 多篇文献问答', '', '问题：'+c.question, '状态：'+result.status+'；模型：'+result.provider.model+'；费用：未知',
    '上下文 SHA-256：'+c.digest,'开始：'+result.startedAt+'；结束：'+(result.finishedAt??'未完成'),'',result.text,'','## 实际发送的来源与片段',
    ...c.sources.map((s,i)=>'S'+(i+1)+'：'+s.title+'；文献 '+s.paperId+'；'+(s.kind==='remote-index'?'远程关键词检索片段，版本 '+s.attachmentVersionId+'，PDF SHA-256 '+s.sha256+'，解析摘要 '+s.packageDigest+'，索引 SHA-256 '+s.remoteRetrieval!.source.artifactDigest+'，检索请求 '+s.remoteRetrieval!.requestId+'，结果 SHA-256 '+s.remoteRetrieval!.resultDigest:s.kind==='parsed'?'解析片段，版本 '+s.attachmentVersionId+'，PDF SHA-256 '+s.sha256+'，解析摘要 '+s.packageDigest:'题录与摘要，未提供全文')+'；采用 '+s.selectedChunks+'/'+s.totalChunks+' 个片段'),
    '',...c.evidence.map(e=>'['+e.id+'] '+(e.pageIndex===null?'题录摘要':'第 '+(e.pageIndex+1)+' 页')+'\n'+e.text+'\n'),
    '未发送片段：'+c.omittedChunks+'。引用编号存在只证明对应输入片段存在，不证明模型结论正确。'].join('\n');
}
