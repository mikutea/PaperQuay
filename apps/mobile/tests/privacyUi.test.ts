import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {act,create,type ReactTestRenderer,type ReactTestInstance} from 'react-test-renderer';
import {InMemoryWebStorage} from 'oidc-client-ts';
import {AccountPrivacy,PrivacyHost} from '../src/components/AccountPrivacy.tsx';
import {PrivacyError,type AccountPrivacyStatus,type ClosureRequest} from '../src/privacy/client.ts';
import type {PrivacyRuntime} from '../src/privacy/runtime.ts';
import type {AuthSession} from '../src/auth/oidc.ts';
import type {WorkspaceController,WorkspaceSnapshot} from '../src/sync/workspace.ts';
import {ClientError} from '../src/errors.ts';

const accountId='11111111-1111-4111-8111-111111111111';
const active:AccountPrivacyStatus={accountId,state:'active',closedAt:null,closureRequestId:null,
  deviceErasure:{requested:false,pending:0,acknowledged:0,thisDevicePending:false}};
function text(node:ReactTestInstance):string{return node.children.map(child=>typeof child==='string'?child:text(child)).join('');}
function button(root:ReactTestInstance,label:string){return root.findAllByType('button').find(node=>text(node)===label)!;}
function checkbox(root:ReactTestInstance,label:string){return root.findAllByType('label').find(node=>text(node).includes(label))!.findByType('input');}

test('privacy confirmation separates cloud/local/device scope and retains one explicit request across an unknown result and restart',async t=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),memory=new InMemoryWebStorage();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>memory.getItem(key)??null,setItem:(key:string,value:string)=>memory.setItem(key,value),removeItem:(key:string)=>memory.removeItem(key)}});
  t.after(()=>{if(old)Object.defineProperty(globalThis,'localStorage',old);else Reflect.deleteProperty(globalThis,'localStorage');});
  const calls:ClosureRequest[]=[],reauth:unknown[]=[];let status=active,lose=true,erased=0,focused=0;
  const privacy={client:{captureIdentity:()=>()=>true,status:async()=>status,
    close:async(request:ClosureRequest)=>{calls.push(structuredClone(request));if(lose)throw new PrivacyError('OUTCOME_UNKNOWN');
      status={...active,state:'closed',closedAt:'2026-11-06T00:00:00.000Z',closureRequestId:request.requestId};return status;}},
    erase:async()=>{erased++;}} as unknown as PrivacyRuntime;
  const auth={signIn:async(value:unknown)=>{reauth.push(value);}} as unknown as AuthSession;
  let renderer!:ReactTestRenderer;
  const mount=async()=>{await act(async()=>{renderer=create(createElement(AccountPrivacy,{privacy,auth,apiBaseUrl:'https://sync.example.test',onClose:()=>undefined}),
    {createNodeMock:element=>element.type==='dialog'?{open:false,showModal(){this.open=true;},close(){this.open=false;}}:{focus:()=>{focused++;}}});});};
  await mount();try{
    assert.equal(calls.length,0);assert(focused>0);
    await act(async()=>button(renderer.root,'重新验证登录').props.onClick());assert.deepEqual(reauth,[{reauthenticate:true}]);assert.equal(calls.length,0);
    await act(async()=>button(renderer.root,'准备注销账号').props.onClick());
    const all=checkbox(renderer.root,'请求所有已绑定设备');assert.equal(all.props.disabled,true);
    assert.equal(button(renderer.root,'确认永久注销').props.disabled,true);
    await act(async()=>checkbox(renderer.root,'永久删除应用账号').props.onChange({target:{checked:true}}));
    await act(async()=>renderer.root.findAllByType('input').find(node=>node.props.autoComplete==='off')!.props.onChange({target:{value:'注销 '+accountId}}));
    await act(async()=>button(renderer.root,'确认永久注销').props.onClick());
    assert.equal(calls.length,1);assert.equal(calls[0].eraseDevices,false);assert.equal(calls[0].deleteCloudCopies,true);assert.equal(erased,0);
    assert(renderer.root.findAllByProps({role:'alert'}).some(node=>text(node).includes('尚未确认注销结果')));
    const requestId=calls[0].requestId;await act(async()=>renderer.unmount());await mount();
    assert(button(renderer.root,'重试同一注销请求'));assert.equal(calls.length,1);
    await act(async()=>button(renderer.root,'查询账号状态').props.onClick());assert.equal(calls.length,1);
    lose=false;await act(async()=>button(renderer.root,'重试同一注销请求').props.onClick());
    assert.equal(calls.length,2);assert.equal(calls[1].requestId,requestId);assert.deepEqual(calls[1],calls[0]);assert.equal(erased,0);
    assert(renderer.root.findAllByType('h2').some(node=>text(node)==='设备清理状态'));
  }finally{await act(async()=>renderer.unmount());}
});

test('an automatically opened privacy dialog survives controller deactivation and keeps failed erasure retry controls',async t=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),memory=new InMemoryWebStorage();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>memory.getItem(key)??null,setItem:(key:string,value:string)=>memory.setItem(key,value),removeItem:(key:string)=>memory.removeItem(key)}});
  t.after(()=>{if(old)Object.defineProperty(globalThis,'localStorage',old);else Reflect.deleteProperty(globalThis,'localStorage');});
  const workspaceListeners=new Set<()=>void>(),authListeners=new Set<()=>void>();
  let workspace={error:null} as WorkspaceSnapshot,login={status:'signed-in' as 'signed-in'|'signed-out'},attempts=0;
  const controller={subscribe:(fn:()=>void)=>{workspaceListeners.add(fn);return ()=>workspaceListeners.delete(fn);},getSnapshot:()=>workspace} as unknown as WorkspaceController;
  const auth={subscribe:(fn:()=>void)=>{authListeners.add(fn);return ()=>authListeners.delete(fn);},getSnapshot:()=>login,
    getSubject:()=>login.status==='signed-in'?{issuer:'https://id.example.test',subject:'synthetic-owner'}:null} as unknown as AuthSession;
  const privacy={client:{captureIdentity:()=>()=>login.status==='signed-in',status:async()=>({...active,state:'closed',closedAt:'2026-11-06T00:00:00.000Z',
    closureRequestId:'22222222-2222-4222-8222-222222222222',deviceErasure:{requested:true,pending:1,acknowledged:0,thisDevicePending:true}})},
    erase:async()=>{attempts++;workspace={...workspace,error:null};workspaceListeners.forEach(fn=>fn());
      if(attempts===1)throw Error('Synthetic cache removal failure');login={status:'signed-out'};authListeners.forEach(fn=>fn());}} as unknown as PrivacyRuntime;
  let renderer!:ReactTestRenderer;
  await act(async()=>{renderer=create(createElement(PrivacyHost,{privacy,auth,controller,apiBaseUrl:'https://sync.example.test',open:false,onClose:()=>undefined}));});
  try {
    await act(async()=>{workspace={...workspace,error:new ClientError('ACCOUNT_CLOSED')};workspaceListeners.forEach(fn=>fn());});
    assert.equal(attempts,1);assert.equal(renderer.root.findAllByType('dialog').length,1);
    assert(renderer.root.findAllByProps({role:'alert'}).some(node=>text(node).includes('操作未完成')));
    await act(async()=>checkbox(renderer.root,'清理本机此账号的副本与凭据').props.onChange({target:{checked:true}}));
    await act(async()=>button(renderer.root,'清理本机并完成确认').props.onClick());assert.equal(attempts,2);
    assert.equal(renderer.root.findAllByType('dialog').length,0);
  }finally{await act(async()=>renderer.unmount());}
});
