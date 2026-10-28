import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appendAiConversation,buildConversationMessages,conversationRecord,createAiConversation,syncedAiTemplate,validateAiConversation,validateAiTemplate} from '../packages/ai-core/src/conversation.ts';
import {validateAiArchiveItem,type AiHistoryRecord} from '../packages/ai-core/src/archiveTypes.ts';
import {prepareAiContext} from '../packages/ai-core/src/context.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const record=(n=1,status='complete',text='回答 [P1]'):AiHistoryRecord=>validateAiArchiveItem({kind:'record',version:1,id:id(n),revision:1,
  createdAt:`2026-10-28T12:00:${String(n*2).padStart(2,'0')}.000Z`,updatedAt:`2026-10-28T12:00:${String(n*2+1).padStart(2,'0')}.000Z`,
  context:{paperId:id(100),attachmentVersionId:id(101),sha256:'a'.repeat(64),scope:'page',totalPages:2,pages:[{pageIndex:0,text:'原文 test'}],complete:true,label:'测试文献'},
  action:'ask',question:'问题 '+n,provider:{id:'primary',endpoint:'https://model.example.invalid/v1',model:'test'},
  result:{text,status,finishReason:status==='complete'?'stop':null,usage:null,cost:'unknown',failure:status==='cancelled'?{code:'CANCELLED'}:null}}) as AiHistoryRecord;
test('account conversations retain the exact source and each terminal record without a second context copy',()=>{
  const first=record(),second=record(2,'cancelled','部分结果'),third=record(3);
  const value=appendAiConversation(appendAiConversation(createAiConversation(first),second),third);
  assert.equal(value.turns.length,3);assert.deepEqual(conversationRecord(value,0),first);assert.deepEqual(conversationRecord(value,1),second);
  assert.equal('context'in value.turns[0],false);assert.equal(value.turns[1].result.status,'cancelled');
  value.context.pages[0].text='外部改写';assert.equal(first.context.pages[0].text,'原文 test');
});
test('continuation is explicit, source-bound and sends only completed prior answers',()=>{
  const value=appendAiConversation(createAiConversation(record()),record(2,'cancelled','cancelled secretary text'));
  const context=prepareAiContext(value.context),messages=buildConversationMessages(context,'ask','追问',value);
  assert.deepEqual(messages.map(x=>x.role),['system','user','assistant','user']);assert.equal(messages[2].content,'回答 [P1]');
  assert.match(messages.at(-1)!.content,/原文 test/);assert.equal(JSON.stringify(messages).includes('cancelled secretary text'),false);
  assert.equal(buildConversationMessages(context,'ask','新提问').length,2);
  assert.throws(()=>buildConversationMessages(prepareAiContext({...value.context,pages:[{pageIndex:0,text:'等长不同 test'}]}),'ask','x',value));
});
test('duplicate append is idempotent, while a changed turn or source cannot overwrite history',()=>{
  const value=createAiConversation(record());assert.deepEqual(appendAiConversation(value,record()),value);
  assert.throws(()=>appendAiConversation(value,record(1,'complete','changed')));
  const other=record(2);other.context.sha256='b'.repeat(64);assert.throws(()=>appendAiConversation(value,other));
  assert.throws(()=>validateAiConversation({...value,turns:[value.turns[0],value.turns[0]]}));
});
test('closed conversation and template contracts reject credentials, getters, metadata mismatches and invalid Unicode',()=>{
  const value=createAiConversation(record());
  for(const bad of [{...value,apiKey:'must never be stored'},{...value,paperId:id(9)},{...value,title:'broken\ud800'},
    {...value,context:{...value.context,headers:{Authorization:'secret'}}},{...value,turns:[{...value.turns[0],provider:{...value.turns[0].provider,apiKey:'secret'}}]}])assert.throws(()=>validateAiConversation(bad));
  const getter={...value};Object.defineProperty(getter,'turns',{enumerable:true,get(){assert.fail('getter executed');}});assert.throws(()=>validateAiConversation(getter));
  let executed=false;const turns=[value.turns[0]];Object.defineProperty(turns,'0',{enumerable:true,get(){executed=true;throw Error('array getter executed');}});
  assert.throws(()=>validateAiConversation({...value,turns}));assert.equal(executed,false);
  const template=validateAiArchiveItem({kind:'template',version:1,id:id(5),revision:1,createdAt:'2026-10-28T00:00:00.000Z',updatedAt:'2026-10-28T00:00:00.000Z',title:'模板😀',action:'ask',question:'问题'});
  if(template.kind!=='template')assert.fail();assert.deepEqual(syncedAiTemplate(template),{version:1,title:'模板😀',action:'ask',question:'问题'});
  assert.throws(()=>validateAiTemplate({version:1,title:'x',action:'ask',question:'q',headers:{}}));
});
test('conversation size and turn limits reject whole updates, never silently trim earlier history',()=>{
  let value=createAiConversation(record());for(let n=2;n<=24;n++)value=appendAiConversation(value,record(n));
  const tooMany=record(25);assert.throws(()=>appendAiConversation(value,tooMany));assert.equal(value.turns.length,24);
  assert.throws(()=>buildConversationMessages(prepareAiContext(value.context),'ask','第25轮',value),{code:'CONVERSATION_LIMIT'});
  const large=createAiConversation(record(1,'complete','x'.repeat(200000)));
  let growing=large;for(let n=2;n<=4;n++)growing=appendAiConversation(growing,record(n,'complete','x'.repeat(200000)));
  assert.throws(()=>appendAiConversation(appendAiConversation(growing,record(5,'complete','x'.repeat(200000))),record(6,'complete','x'.repeat(200000))));
  assert.equal(growing.turns.length,4);
});
