import test,{type TestContext}from'node:test';import assert from'node:assert/strict';import{registerHooks}from'node:module';import{createElement}from'react';import{act,create,type ReactTestRenderer,type ReactTestInstance}from'react-test-renderer';import{IDBFactory}from'fake-indexeddb';
import{AccountStore}from'../src/storage/accountStore.ts';import{WorkspaceController,decodeWorkspace}from'../src/sync/workspace.ts';import{MemorySecretStore}from'../src/platform/secretStore.ts';import{LocalAiConfigStore,defaultAiProvider}from'../src/ai/provider.ts';import type{AiTransport}from'../src/ai/types.ts';
import{id,scope,paper,now,completion,deferred}from'./reviewFixtures.ts';
registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const{ReviewWorkspace}=await import('../src/components/ReviewWorkspace.tsx');
const text=(node:ReactTestInstance):string=>node.children.map(c=>typeof c==='string'?c:text(c)).join('');
function button(r:ReactTestRenderer,label:string){const b=r.root.findAllByType('button').find(n=>text(n)===label);assert(b,'Missing '+label);return b;}
async function flush(){await act(async()=>{await new Promise<void>(r=>setImmediate(r));});}
async function until(check:()=>boolean){const deadline=performance.now()+5000;while(!check()){if(performance.now()>=deadline)assert.fail('UI did not settle');await flush();}}
async function click(r:ReactTestRenderer,label:string){const b=button(r,label);assert(!b.props.disabled,label+' disabled');await act(async()=>{b.props.onClick();});}
async function input(r:ReactTestRenderer,label:string,value:string){const l=r.root.findAllByType('label').find(n=>text(n).startsWith(label));assert(l,'Missing label '+label);const control=l.findAll(n=>typeof n.type==='string'&&['input','textarea','select'].includes(n.type))[0];await act(async()=>{control.props.onChange({target:{value}});});}
async function setup(t:TestContext){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),data=new Map<string,string>();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete(globalThis as any).localStorage;});
 new LocalAiConfigStore(localStorage).save(scope,{...defaultAiProvider(),endpoint:'https://model.example.test/v1',model:'synthetic-review',requiresKey:false,stream:false});
 const store=new AccountStore({decode:decodeWorkspace,indexedDB:new IDBFactory(),databaseName:crypto.randomUUID()});const c=new WorkspaceController({apiBaseUrl:scope.apiBaseUrl,store,online:false,api:{register:async()=>({accountId:scope.accountId,device:{id:id(20),name:'Review UI',platform:'web',createdAt:now,lastSeenAt:now,revokedAt:null}}),devices:async()=>[],revokeDevice:async()=>{},conflicts:async()=>({conflicts:[],nextCursor:'done',hasMore:false}),push:async()=>{throw Error('No network');},pull:async()=>{throw Error('No network');},resolveConflict:async()=>{throw Error('No network');}}});await c.bind('Review UI');await c.save({entityType:'paper',entityId:id(2),mutation:'put',data:paper},0);
 let calls=0,closed=0;const transport:AiTransport={kind:'fetch',supportsStreaming:false,redirectPolicy:'error',request:async()=>{calls++;return new Response(JSON.stringify(completion(JSON.stringify({content:'Verified evidence [P1].\n\n$$E=mc^2$$',citations:['P1']}))),{headers:{'content-type':'application/json'}});}};
 const sync=c.getSnapshot().workspace!.sync,props={scope,scopeKey:JSON.stringify([sync.accountId,sync.deviceId,sync.generation]),controller:c,secretStore:new MemorySecretStore(),transport,accountCurrent:()=>true,onClose:()=>{closed++;}};let r!:ReactTestRenderer;await act(async()=>{r=create(createElement(ReviewWorkspace,props));});t.after(async()=>{await act(async()=>r.unmount());c.deactivate();await store.close();});return{r,c,store,props,calls:()=>calls,closed:()=>closed};
}
async function capture(r:ReactTestRenderer,c:WorkspaceController){const checkbox=r.root.findAllByType('input').find(n=>n.props.type==='checkbox');assert(checkbox);await act(async()=>checkbox.props.onChange({target:{checked:true}}));await input(r,'写作意图','比较已有证据和研究局限');await click(r,'核验材料并建立草稿');await until(()=>Boolean(c.getSnapshot().workspace?.reviewProject));await until(()=>!button(r,'手动建立蓝图').props.disabled);await click(r,'手动建立蓝图');await until(()=>Boolean(c.getSnapshot().workspace?.reviewProject?.blueprint));}
test('actual review UI captures a source, edits the blueprint, previews exact requests, checkpoints four paragraphs and builds Word',async t=>{
 const{r,c,store,calls}=await setup(t);
 const update=store.update.bind(store);let initialWrite=true;
 t.mock.method(store,'update',async(...args:Parameters<typeof store.update>)=>{
  if(initialWrite){initialWrite=false;await new Promise<void>(resolve=>setTimeout(resolve,250));}return update(...args);
 });
 await capture(r,c);await input(r,'标题','可追溯的研究证据综述');await click(r,'应用蓝图');await until(()=>c.getSnapshot().workspace?.reviewProject?.blueprint?.title==='可追溯的研究证据综述');await click(r,'写作');await click(r,'预览尚未完成的4段请求');await until(()=>r.root.findAllByProps({'aria-label':'综述实际发送预览'}).length===1);assert.equal(calls(),0);const send=button(r,'发送以上4次请求').props.onClick;await act(async()=>{send();send();});await until(()=>c.getSnapshot().workspace?.reviewProject?.parts.conclusion!==null);await until(()=>!button(r,'导出').props.disabled);assert.equal(calls(),4);assert.equal(c.getSnapshot().workspace?.reviewProject?.attempt?.status,'complete');await click(r,'导出');await click(r,'检查并生成 Word');await until(()=>r.root.findAllByProps({'aria-label':'Word 检查结果'}).length===1);assert(text(r.root).includes('4个可编辑公式'));assert.equal(calls(),4);assert(c.getSnapshot().workspace?.reviewProject?.previousDraft);
});
test('review UI preserves unsaved chapter edits on close until explicit save or discard',async t=>{const{r,c,closed}=await setup(t);await capture(r,c);await input(r,'核心观点','尚未应用的修改');await click(r,'关闭');assert.equal(closed(),0);assert(text(r.root).includes('有尚未应用的编辑'));await click(r,'放弃本次未保存编辑或结果');await click(r,'关闭');assert.equal(closed(),1);assert.notEqual(c.getSnapshot().workspace?.reviewProject?.blueprint?.thesis,'尚未应用的修改');});
test('account invalidation before React cleanup retires a saved send callback without a model POST',async t=>{const{r,c,props,calls}=await setup(t);await capture(r,c);await click(r,'写作');await click(r,'预览尚未完成的4段请求');await until(()=>r.root.findAllByProps({'aria-label':'综述实际发送预览'}).length===1);const send=button(r,'发送以上4次请求').props.onClick;props.accountCurrent=()=>false;await act(async()=>{send();});await flush();assert.equal(calls(),0);assert.equal(c.getSnapshot().workspace?.reviewProject?.attempt,null);});

test('same-account source changes retain a successful but unsaved model result for explicit backup',async t=>{const{r,c}=await setup(t);await capture(r,c);const save=c.saveReviewProject.bind(c);c.saveReviewProject=async(...args)=>{if(args[0].attempt?.status==='complete')throw Error('Synthetic disk failure');return save(...args);};await click(r,'写作');await click(r,'预览此段请求');await until(()=>r.root.findAllByProps({'aria-label':'综述实际发送预览'}).length===1);await click(r,'发送以上1次请求');await until(()=>text(r.root).includes('模型结果已收到，但尚未确认保存'));await act(async()=>{await c.save({entityType:'paper',entityId:id(2),mutation:'put',data:{...paper,abstractText:'Changed source after disk failure'}},0);});await flush();assert(text(r.root).includes('模型结果已收到，但尚未确认保存'));assert(button(r,'备份尚未保存的结果'));});

test('review returns from AI settings with its source choices, intent and unsaved blueprint intact',async t=>{
 const{r,c,calls}=await setup(t);
 const checkbox=r.root.findAllByType('input').find(n=>n.props.type==='checkbox')!;
 await act(async()=>checkbox.props.onChange({target:{checked:true}}));
 await input(r,'写作意图','保留正在填写的研究意图');
 await click(r,'更换 AI');await click(r,'返回文献综述');
 assert.equal(r.root.findAllByType('input').find(n=>n.props.type==='checkbox')!.props.checked,true);
 const intent=r.root.findAllByType('label').find(n=>text(n).startsWith('写作意图'))!.findByType('textarea');
 assert.equal(intent.props.value,'保留正在填写的研究意图');
 await click(r,'核验材料并建立草稿');await until(()=>Boolean(c.getSnapshot().workspace?.reviewProject));
 await click(r,'手动建立蓝图');await until(()=>Boolean(c.getSnapshot().workspace?.reviewProject?.blueprint));
 await input(r,'核心观点','仍未应用的蓝图编辑');
 await click(r,'更换 AI');await click(r,'返回文献综述');
 const thesis=r.root.findAllByType('label').find(n=>text(n).startsWith('核心观点'))!.findByType('textarea');
 assert.equal(thesis.props.value,'仍未应用的蓝图编辑');assert.equal(calls(),0);
 assert.notEqual(c.getSnapshot().workspace?.reviewProject?.blueprint?.thesis,'仍未应用的蓝图编辑');
});

test('review settings retire a prepared send even when the user returns without changing the model',async t=>{
 const{r,c,calls}=await setup(t);await capture(r,c);await click(r,'写作');await click(r,'预览尚未完成的4段请求');
 await until(()=>r.root.findAllByProps({'aria-label':'综述实际发送预览'}).length===1);
 const oldSend=button(r,'发送以上4次请求').props.onClick;
 await click(r,'更换 AI');await click(r,'返回文献综述');
 assert.equal(r.root.findAllByProps({'aria-label':'综述实际发送预览'}).length,0);
 await act(async()=>{oldSend();});await flush();
 assert.equal(calls(),0);assert.equal(c.getSnapshot().workspace?.reviewProject?.attempt,null);
});
