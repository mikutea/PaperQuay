import {ModelServiceError} from '../src/modelRouting/errors.ts';
import test from'node:test';import assert from'node:assert/strict';import {randomUUID}from'node:crypto';import{createElement}from'react';import{act,create,type ReactTestRenderer}from'react-test-renderer';
import{ModelRoutingPanel}from'../src/components/ModelRoutingPanel.tsx';import type{MobileModelRouter}from'../src/modelRouting/router.ts';import{defaultAiProvider}from'../src/ai/provider.ts';
import{emptyModelLedger,beginModelRecord}from'../src/modelRouting/ledger.ts';import{prepareModelInferenceRequest}from'../../../packages/sync-core/src/modelInference.ts';
test('activity follows another committed consumer without a network read, model call, or automatic result adoption',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;let ledger=emptyModelLedger(),reads=0,network=0,changes=0;const view={revision:0,pendingIds:[]},router={current:()=>true,subscribe:()=>()=>{},getSnapshot:()=>view,readActivity:async()=>{reads++;return structuredClone(ledger);},inventory:async()=>{network++;throw Error('Explicit only');}}as unknown as MobileModelRouter,scope={apiBaseUrl:'https://sync.fixture.test',accountId:randomUUID()},props={scope,config:defaultAiProvider(),busy:false,router,onChange:()=>{changes++;},onExternal:()=>{}};
 let root!:ReactTestRenderer;await act(async()=>{root=create(createElement(ModelRoutingPanel,{...props,ledgerRevision:0}));});assert.equal(root.root.findAll(n=>n.type==='article'&&n.props.className==='model-invocation').length,0);const prior=reads;
 const request=await prepareModelInferenceRequest({id:randomUUID(),target:{kind:'gateway'},profileRef:{id:'default',revision:1,digest:'a'.repeat(64)},model:'synthetic',messages:[{role:'user',content:'Other explicit consumer'}],maxOutputTokens:1024});ledger=beginModelRecord(ledger,request,'research',Date.now()).ledger;
 await act(async()=>{root.update(createElement(ModelRoutingPanel,{...props,ledgerRevision:ledger.revision}));});assert(reads>prior);assert.equal(root.root.findAll(n=>n.type==='article'&&n.props.className==='model-invocation').length,1);assert.equal(network,0);assert.equal(changes,0);await act(async()=>root.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

test('an explicit unavailable gateway inspection reports the remote route state without a direct-service CORS diagnosis',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;let inventoryCalls=0;const view={revision:0,pendingIds:[]},router={current:()=>true,subscribe:()=>()=>{},getSnapshot:()=>view,readActivity:async()=>emptyModelLedger(),inventory:async()=>{inventoryCalls++;throw new ModelServiceError('MODEL_INFERENCE_DISABLED');}}as unknown as MobileModelRouter;
 let root!:ReactTestRenderer;await act(async()=>{root=create(createElement(ModelRoutingPanel,{scope:{apiBaseUrl:'https://sync.fixture.test',accountId:randomUUID()},config:defaultAiProvider(),busy:false,router,onChange:()=>{throw Error('No provider switch');},onExternal:()=>{}}));});
 const button=root.root.findAllByType('button').find(b=>b.children.includes('查看账号和电脑提供的模型'))!;await act(async()=>{button.props.onClick();});assert.equal(inventoryCalls,1);const alerts=root.root.findAll(n=>n.type==='p'&&n.props.role==='alert'),text=alerts.map(n=>n.children.join('')).join('');assert.match(text,/网关或在线电脑/);assert(!text.includes('直连'));await act(async()=>root.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

test('settings route selection reads only an explicit model list and saves the choice without a redundant consent control',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 let activityReads=0,inventoryReads=0;const changes:ReturnType<typeof defaultAiProvider>[]=[];
 const view={revision:0,pendingIds:[]},scope={apiBaseUrl:'https://sync.fixture.test',accountId:randomUUID()};
 const router={current:()=>true,subscribe:()=>()=>{},getSnapshot:()=>view,readActivity:async()=>{activityReads++;return emptyModelLedger();},inventory:async()=>{inventoryReads++;return{checkedAt:new Date().toISOString(),validUntil:new Date(Date.now()+30000).toISOString(),gateway:{id:'default',revision:2,digest:'a'.repeat(64),kind:'chat',model:'fixture-reading-model',maxInputBytes:65536,maxOutputTokens:2048,stream:false},computers:[]};}}as unknown as MobileModelRouter;
 let root!:ReactTestRenderer;
 try{
  await act(async()=>{root=create(createElement(ModelRoutingPanel,{scope,router,config:defaultAiProvider(),showActivity:false,busy:false,onChange:value=>{changes.push(value);},onExternal:()=>{throw Error('Unexpected route reset');}}));});
  assert.equal(activityReads,0);assert.equal(inventoryReads,0);assert.equal(root.root.findAllByProps({className:'model-route-history'}).length,0);
  assert.equal(root.root.findAllByType('button').some(b=>b.children.includes('使用本机直连设置')),false);
  await act(async()=>{root.root.findAllByType('button').find(b=>b.children.includes('查看账号和电脑提供的模型'))!.props.onClick();});
  assert.equal(inventoryReads,1);assert.equal(changes.length,0);
  const radio=root.root.findAllByType('input').find(n=>n.props.type==='radio')!;
  act(()=>radio.props.onChange());
  assert.equal(root.root.findAllByType('input').filter(n=>n.props.type==='checkbox').length,0);
  await act(async()=>{root.root.findAllByType('button').find(b=>b.children.includes('使用此模型'))!.props.onClick();});
  assert.equal(changes[0]?.model,'fixture-reading-model');assert.equal(changes[0]?.execution?.target.kind,'gateway');
  assert.equal(inventoryReads,1);assert.equal(activityReads,0);
  assert.equal(root.root.findAllByType('fieldset').length,0);
 }finally{if(root)await act(async()=>root.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
