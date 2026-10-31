import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {AiClient} from '../src/ai/client.ts';import {AiSessionController} from '../src/ai/controller.ts';import {prepareAiContext} from '../src/ai/context.ts';import {AiError} from '../src/ai/errors.ts';
import type {AiTransport,AiModelRoutingTransport,PdfAiContext,SecretStore} from '../src/ai/types.ts';import {createModelRouteProvider} from '../src/modelRouting/config.ts';
import {ResearchSession} from '../src/research/session.ts';import {prepareResearchContext,splitResearchText} from '../src/research/context.ts';
import {ReviewWriter} from '../src/review/writer.ts';import {reviewSlots,validateReviewProject} from '../src/review/model.ts';
import {AgentModelRunner} from '../src/agent/runner.ts';import {createAgentConversation,beginAgentModelTurn,prepareAgentConversationRequest,validateAgentConversation} from '../src/agent/conversation.ts';
import {scope,id,project,memoryStore} from './reviewFixtures.ts';import {targets,planResponse,request as agentRequest} from './agentModelFixtures.ts';
const profile={id:'chat-default',revision:1,digest:'a'.repeat(64),kind:'chat' as const,model:'synthetic',maxInputBytes:192*1024,maxOutputTokens:2048,stream:false as const};
const pdf=():PdfAiContext=>({paperId:id(2),attachmentVersionId:id(4),sha256:'b'.repeat(64),scope:'page',totalPages:1,pages:[{pageIndex:0,text:'Explicit synthetic evidence.'}],complete:true,label:'Fixture'});
async function setup(answer:(input:Parameters<AiModelRoutingTransport['invoke']>[0])=>string|Promise<string>=()=> 'Synthetic result [P1]',finishReason:'stop'|'length'|'content_filter'='stop'){
 const config=await createModelRouteProvider(scope,{kind:'gateway'},profile),calls:Parameters<AiModelRoutingTransport['invoke']>[0][]=[],counts={secrets:0,direct:0,inspect:0};
 const secrets:SecretStore={persistence:'memory',get:async()=>{counts.secrets++;throw Error('Remote must never read a model key');},set:async()=>{},remove:async()=>{}},transport:AiTransport={kind:'fetch',supportsStreaming:true,redirectPolicy:'error',request:async()=>{counts.direct++;throw Error('No ordinary fallback');},modelRouting:{inspect:async()=>{counts.inspect++;return[config.model];},invoke:async input=>{calls.push(input);return{text:await answer(input),usage:{promptTokens:10,completionTokens:5,totalTokens:15},finishReason,redacted:false};}}};
 return{config,calls,counts,secrets,transport,client:new AiClient(secrets,transport)};
}
test('PDF controller passes its actual history ID to a one-shot bridge and publishes actual usage without model key access',async()=>{
 const f=await setup(),controller=new AiSessionController(f.client);controller.bind(scope,f.config,pdf());await controller.probe();assert.equal(f.counts.inspect,1);assert.equal(f.calls.length,0);
 await controller.start('explain','');const result=controller.getSnapshot().result!;assert.equal(result.status,'complete');assert.equal(f.calls[0].requestId,result.requestId);assert.equal(f.calls[0].purpose,'pdf');assert.equal(controller.historyRecord(result.requestId).provider.id,f.config.id);assert.equal(result.usage!.totalTokens,15);assert.match(result.text,/Synthetic result/);assert.deepEqual(f.counts,{secrets:0,direct:0,inspect:1});controller.dispose();
});
test('research session passes its result identity and current guard rather than generating an untracked transport ID',async()=>{
 const f=await setup(()=> 'Grounded result [S1E1]'),session=new ResearchSession(f.client),context=await prepareResearchContext([{paperId:id(2),title:'Fixture',revision:1,kind:'metadata',attachmentVersionId:null,sha256:null,packageDigest:null,totalPages:null,chunks:splitResearchText('Synthetic evidence.',null)}],'Summarize','selected');
 await session.start({scope,config:f.config,context,current:()=>true});const result=session.getSnapshot().result!;assert.equal(result.status,'complete');assert.equal(f.calls[0].requestId,result.id);assert.equal(f.calls[0].purpose,'research');assert.equal(f.calls[0].current?.(),true);assert.equal(f.counts.secrets+f.counts.direct,0);session.dispose();
});
test('review serial writing binds every model call to its separately committed attempt and preserves legacy provider fields',async()=>{
 const p=await project(),store=memoryStore(p),f=await setup(input=>{assert.equal(store.get().attempt?.status,'uncertain');assert.equal(store.get().attempt?.id,input.requestId);assert.equal(input.purpose,'review');return JSON.stringify({content:'Evidence [P1][N1].',citations:['P1','N1']});}),writer=new ReviewWriter(f.client),plan=await writer.prepare(p,f.config,reviewSlots(p).map(s=>s.key));
 await writer.start({plan,scope,store,current:()=>true,revalidate:async()=>{}});assert.equal(f.calls.length,4);assert.equal(new Set(f.calls.map(c=>c.requestId)).size,4);assert.equal(writer.getSnapshot().completed,4);assert.deepEqual(Object.keys(store.get().attempt!.provider).sort(),['endpoint','id','model']);assert.deepEqual(validateReviewProject(store.get()),store.get());assert.equal(f.counts.secrets+f.counts.direct,0);
});
test('review transport failure checkpoints the fixed remote error once and does not retry the consumed preview',async()=>{
 const p=await project(),store=memoryStore(p),f=await setup(()=>{throw new AiError('REMOTE_UNCONFIRMED');}),writer=new ReviewWriter(f.client),plan=await writer.prepare(p,f.config,[reviewSlots(p)[0].key]),input={plan,scope,store,current:()=>true,revalidate:async()=>{}};
 await writer.start(input);assert.equal(store.get().attempt!.failure!.code,'REMOTE_UNCONFIRMED');assert.equal(store.get().attempt!.status,'failed');validateReviewProject(store.get());await writer.start(input);assert.equal(f.calls.length,1);assert.equal(writer.getSnapshot().storageFailure,false);
});
test('Agent invocation shares its durable turn UUID with the generic bridge while proposal adoption remains separate',async()=>{
 let conversation=createAgentConversation(targets(),id(80),1793359753000);const request=prepareAgentConversationRequest(conversation,'Suggest a title','rename',id(81),1793359753000),f=await setup(input=>{assert.equal(input.requestId,conversation.turns.at(-1)!.id);assert.equal(input.purpose,'agent');return planResponse();}),runner=new AgentModelRunner(f.client,{get:()=>conversation,begin:async(r,p,expected,guard)=>{assert(guard());assert.equal(expected.revision,conversation.revision);conversation=beginAgentModelTurn(conversation,r,p);return structuredClone(conversation);},save:async(next,expected,guard)=>{assert(guard());assert.equal(expected.revision,conversation.revision);conversation=validateAgentConversation(next);return structuredClone(conversation);}});
 await runner.start({request,provider:f.config,expected:{id:conversation.id,revision:conversation.revision},scope,owner:()=>true,modelCurrent:()=>true});assert.equal(f.calls.length,1);assert.equal(f.calls[0].requestId,request.id);assert.equal(conversation.turns[0].status,'complete');assert.equal(conversation.turns[0].proposalSaved,false);assert.equal(f.counts.secrets+f.counts.direct,0);runner.dispose();
});
test('remote bridge requires caller identity, respects custom request budgets and never publishes to a retired caller',async()=>{
 const f=await setup(),base={accountScope:scope,config:f.config,context:prepareAiContext(pdf()),action:'explain' as const,question:'',onText:()=>{}};
 await assert.rejects(f.client.generate(base),{code:'CONFIG_INVALID'});assert.equal(f.calls.length,0);
 const limited=new AiClient(f.secrets,f.transport,{requestBytes:512});await assert.rejects(limited.generate({...base,requestId:randomUUID(),question:'long '.repeat(200)}),{code:'INPUT_TOO_LARGE'});assert.equal(f.calls.length,0);
 let current=true,callbacks=0;const retired=await setup(()=>{current=false;return'Late result';});await assert.rejects(retired.client.generate({...base,config:retired.config,requestId:randomUUID(),current:()=>current,onText:()=>{callbacks++;}}),{code:'CANCELLED'});assert.equal(callbacks,0);assert.equal(retired.counts.secrets+retired.counts.direct,0);
});

for(const reason of ['length','content_filter'] as const)test('empty remote '+reason+' output preserves its actual finish state and usage without inventing text',async()=>{
 const f=await setup(()=>'',reason),controller=new AiSessionController(f.client);controller.bind(scope,f.config,pdf());await controller.start('explain','');const result=controller.getSnapshot().result!;assert.equal(result.status,'incomplete');assert.equal(result.failure!.code,reason==='length'?'OUTPUT_TRUNCATED':'CONTENT_FILTERED');assert.equal(result.text,'');assert.equal(result.usage!.totalTokens,15);assert.equal(f.calls.length,1);assert.equal(f.counts.secrets+f.counts.direct,0);controller.dispose();
});
