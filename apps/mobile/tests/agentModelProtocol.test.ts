import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentError,agentProposalDiffs} from '../src/agent/proposals.ts';
import {AGENT_MODEL_SYSTEM,agentModelMessages,validateAgentModelRequest,parseAgentModelResponse,prepareAgentModelRequest} from '../src/agent/modelProtocol.ts';
import {reviewFingerprint} from '../src/review/fingerprint.ts';
import {request,planResponse,id,targets} from './agentModelFixtures.ts';

test('exact Agent messages contain captured data and declared source limits without a tool execution channel',()=>{
 const r=request(),messages=agentModelMessages(r),payload=JSON.parse(messages[1].content);assert.equal(messages[0].content,AGENT_MODEL_SYSTEM);assert.deepEqual(payload.currentPaperScopeIds,[id(2)]);assert.equal(payload.papers[0].title,r.targets[0].data.title);assert.equal(payload.approvedContextExcerpts.length,0);assert.equal(payload.papers[0].url,undefined);assert.equal(messages.length,2);assert.deepEqual(validateAgentModelRequest(r),r);
});
test('rename plans have stable proposal identity while actual diffs use captured title data',()=>{
 const r=request(),a=parseAgentModelResponse(planResponse(),r),b=parseAgentModelResponse(planResponse(),r);assert.equal(a.kind,'plan');if(a.kind!=='plan'||b.kind!=='plan')throw Error();assert.deepEqual(a,b);assert.equal(a.proposal.origin,'model');assert.deepEqual(agentProposalDiffs(a.proposal,a.proposal.items[0].id),[{field:'title',before:r.targets[0].data.title,after:'Suggested title'}]);assert.equal(a.proposal.targets[0].hash,r.targets[0].hash);
});
test('unknown target IDs, duplicate items, aliases and unsupported fields stop the whole structured response',()=>{
 const r=request(),base=JSON.parse(planResponse());for(const edit of [(v:any)=>v.plan.items[0].paperId=id(99),(v:any)=>v.plan.items.push(v.plan.items[0]),(v:any)=>v.plan.tool='rename_papers',(v:any)=>v.plan.items[0].update.tags=['unexpected'],(v:any)=>v.plan.items[0].before='invented before',(v:any)=>v.plan.items[0].after='other',(v:any)=>v.plan.items[0].update.url='https://invalid.test/',(v:any)=>v.plan.items[0].hidden='extra',(v:any)=>v.plan.items[0].update.paperId=id(99)]){const v=structuredClone(base);edit(v);assert.throws(()=>parseAgentModelResponse(JSON.stringify(v),r));}
});
test('metadata and organization changes obey per-tool field allowlists and retain independent library fields',()=>{
 const r=request(),base=JSON.parse(planResponse());base.plan.tool='metadata';base.plan.items[0]={paperId:id(2),title:'建议补题录',description:'待核验',update:{publication:'New venue',authors:['A','B']}};const metadata=parseAgentModelResponse(JSON.stringify(base),r);assert.equal(metadata.kind,'plan');if(metadata.kind!=='plan')throw Error();assert.deepEqual(metadata.proposal.items[0].patch,{authors:['A','B'],publication:'New venue'});base.plan.tool='smart-tags';base.plan.items[0].update={tags:['One']};const tags=parseAgentModelResponse(JSON.stringify(base),r);if(tags.kind!=='plan')throw Error();assert.deepEqual(tags.proposal.items[0].patch.organization!.tags,['One']);assert.equal(tags.proposal.items[0].patch.organization!.readingStatus,'unread');
 const {digest:_digest,version:_version,...fields}=r;const forced=prepareAgentModelRequest({...fields,tool:'rename'});assert.throws(()=>parseAgentModelResponse(JSON.stringify(base),forced));
});
test('context requests and executable choice branches remain explicit responses, not automatic side effects',()=>{
 const r=request(),c={kind:'context-request',summary:'需核查方法',mode:'pdf-text',reason:'题录未提供方法细节',paperIds:[id(2)]};assert.deepEqual(parseAgentModelResponse(JSON.stringify(c),r),c);assert.deepEqual(parseAgentModelResponse(JSON.stringify({kind:c.kind,contextRequest:{summary:c.summary,mode:c.mode,reason:c.reason,paperIds:c.paperIds}}),r),c);assert.throws(()=>parseAgentModelResponse(JSON.stringify({...c,paperIds:[id(99)]}),r));assert.throws(()=>parseAgentModelResponse(JSON.stringify({...c,paperIds:[]}),r));
 const choices={kind:'choice-request',userChoices:{summary:'选择整理方式',reason:'需要用户决定',options:[{id:'one',label:'按主题',description:'分类建议',instruction:'请给所选文献提出主题分类建议'},{id:'two',label:'按标签',description:'标签建议',instruction:'请给所选文献提出标签建议'}]}};const result=parseAgentModelResponse(JSON.stringify(choices),r);assert.equal(result.kind,'choice-request');choices.userChoices.options[1].instruction=choices.userChoices.options[0].instruction;assert.throws(()=>parseAgentModelResponse(JSON.stringify(choices),r));
});
test('malformed action JSON is never silently treated as a successful plan or repaired by a second request',()=>{
 const r=request();for(const text of ['{broken','{"kind":"delete","paperId":"'+id(2)+'"}','[{"kind":"plan"}]','\x60\x60\x60json\n'+planResponse()+'\n\x60\x60\x60','{"kind":"answer","answer":""}'])assert.throws(()=>parseAgentModelResponse(text,r));assert.deepEqual(parseAgentModelResponse('需要先确认新标题。',r),{kind:'answer',answer:'需要先确认新标题。'});
});
test('request validation inspects getters, binds actual snapshot hashes and rejects oversized payloads before transport',()=>{
 const r=request();let reads=0;assert.throws(()=>validateAgentModelRequest({...r,get hidden(){reads++;return true;}}));assert.equal(reads,0);const changed=structuredClone(r);changed.targets[0].data.title='changed';const{digest,...body}=changed;changed.digest=reviewFingerprint(body);assert.throws(()=>validateAgentModelRequest(changed));const long=Array.from({length:4},(_,i)=>{const t=targets()[0];t.id=id(200+i);t.data.abstractText='中'.repeat(20000);t.hash=reviewFingerprint({id:t.id,revision:t.revision,data:t.data,deleted:false,blocked:false});return t;});assert.throws(()=>prepareAgentModelRequest({conversationId:id(80),tool:'auto',instruction:'分析',targets:long,contexts:[],history:[]}),e=>(e as AgentError).code==='LIMIT');
});
