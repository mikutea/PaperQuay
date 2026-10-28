import assert from 'node:assert/strict';
import {test}from'node:test';
import{createElement}from'react';
import{act,create,type ReactTestInstance,type ReactTestRenderer}from'react-test-renderer';
import{AiSyncPanel,type AiSyncPanelProps}from'../src/components/AiSyncPanel.tsx';
import{conversationFixture}from'../../../tests/fixtures/extendedSync.ts';
import{appendAiConversation,conversationRecord,type AiConversationData}from'../../../packages/ai-core/src/conversation.ts';
import{deriveAiHistoryResult,type AiHistoryRecord}from'../src/ai/archiveTypes.ts';
import{ClientError}from'../src/errors.ts';
import type{AiSyncEntry}from'../src/integration/aiSync.ts';
const text=(node:ReactTestInstance|string|number):string=>typeof node==='object'?node.children.map(text).join(''):String(node);
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function extra(base:AiConversationData,n:number):AiHistoryRecord{const record=conversationRecord(base,0);record.id=crypto.randomUUID();record.question='后续问题'+n;
  record.createdAt=`2026-10-28T01:00:${String(n*2).padStart(2,'0')}.000Z`;record.updatedAt=`2026-10-28T01:00:${String(n*2+1).padStart(2,'0')}.000Z`;return record;}
async function fixture(options:{data?:AiConversationData;record?:AiHistoryRecord;write?:(data:AiConversationData,previous?:AiSyncEntry<AiConversationData>)=>Promise<string>}={}){
  const data=options.data??conversationFixture(),entry:AiSyncEntry<AiConversationData>={id:crypto.randomUUID(),revision:1,data,status:'synced',conflicted:false};
  const record=options.record??extra(data,1),writes:{data:AiConversationData;previous?:AiSyncEntry<AiConversationData>}[]=[],applied:any[]=[],selected:any[]=[],saved:any[]=[];
  const props:AiSyncPanelProps={bridge:{enabled:true,conversations:[entry],templates:[{id:crypto.randomUUID(),revision:1,data:{version:1,title:'模板',action:'ask',question:'同步模板的问题'},status:'synced',conflicted:false}],
    async saveConversation(data,previous){writes.push({data,previous});return options.write?options.write(data,previous):crypto.randomUUID();},async saveTemplate(){return crypto.randomUUID();},async remove(){}},
    draft:{action:'ask',question:'当前问题'},currentResult:deriveAiHistoryResult(record),busy:false,activeId:entry.id,captureRecord:()=>record,continuationFor:()=>entry,
    onSelect:value=>{selected.push(value);},onSaved:id=>{saved.push(id);},onApplyDraft:(...args)=>{applied.push(args);},onNavigateCitation:()=>{}};
  let renderer!:ReactTestRenderer;await act(async()=>{renderer=create(createElement(AiSyncPanel,props));await tick();});
  const button=(label:string)=>{const value=renderer.root.findAllByType('button').find(value=>text(value)===label);assert.ok(value,'Missing button: '+label);return value;};
  const click=async(label:string)=>{await act(async()=>{button(label).props.onClick();await tick();await tick();});};
  return{renderer,props,entry,record,writes,applied,selected,saved,button,click,close:()=>act(()=>renderer.unmount())};
}
test('explicit saving appends the captured round to the reviewed snapshot, while viewing/templates never request or write anything',async()=>{
  const ui=await fixture();try{
    await ui.click('填入问题');assert.deepEqual(ui.applied,[['ask','同步模板的问题']]);assert.equal(ui.writes.length,0);
    await ui.click(ui.entry.data.title+' · 1 轮');await ui.click('用已保存原文继续此会话');assert.deepEqual(ui.selected,[ui.entry]);assert.equal(ui.writes.length,0);
    await ui.click('保存本轮到同步会话');assert.equal(ui.writes.length,1);assert.equal(ui.writes[0].previous!.id,ui.entry.id);assert.equal(ui.writes[0].data.turns.length,2);assert.deepEqual(ui.writes[0].data.context,ui.entry.data.context);
  }finally{ui.close();}
});
test('full-history overflow retains the result and offers an explicit current-round-only rescue which does not copy old turns',async()=>{
  let data=conversationFixture();for(let n=1;n<24;n++)data=appendAiConversation(data,extra(data,n));
  const ui=await fixture({data,record:extra(data,24)});try{
    await ui.click('保存本轮到同步会话');assert.equal(ui.writes.length,0);assert.match(text(ui.renderer.root),/超过24轮或1 MiB/);
    await ui.click('将完整前文与本轮另存为新会话');assert.equal(ui.writes.length,0);
    await ui.click('仅将本轮另存为新会话（不带前文）');assert.equal(ui.writes.length,1);assert.equal(ui.writes[0].previous,undefined);
    assert.equal(ui.writes[0].data.turns.length,1);assert.equal(ui.writes[0].data.turns[0].id,ui.record.id);assert.equal(ui.entry.data.turns.length,24);
  }finally{ui.close();}
});
test('a conflict rejection preserves the result and permits an explicit new branch without overwriting the old entity',async()=>{
  const ui=await fixture({write:async(_data,previous)=>{if(previous)throw new ClientError('EDIT_CHANGED');return crypto.randomUUID();}});try{
    await ui.click('保存本轮到同步会话');assert.equal(ui.saved.length,0);assert.match(text(ui.renderer.root),/草稿仍在/);
    await ui.click('将完整前文与本轮另存为新会话');assert.equal(ui.saved.length,1);assert.equal(ui.writes[1].previous,undefined);assert.equal(ui.writes[1].data.turns.length,2);
  }finally{ui.close();}
});
test('duplicate queued clicks share one save and an unmounted account cannot report late success',async()=>{
  let release!:(value:string)=>void;const gate=new Promise<string>(resolve=>{release=resolve;});const ui=await fixture({write:()=>gate});
  const handler=ui.button('保存本轮到同步会话').props.onClick;
  act(()=>{handler();handler();});await act(async()=>{await tick();});assert.equal(ui.writes.length,1);ui.close();release(crypto.randomUUID());await tick();await tick();assert.deepEqual(ui.saved,[]);
});
