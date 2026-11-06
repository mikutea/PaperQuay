import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {act,create,type ReactTestRenderer,type ReactTestInstance} from 'react-test-renderer';
import {IDBFactory} from 'fake-indexeddb';
import {InMemoryWebStorage,User,UserManager} from 'oidc-client-ts';
import {AccountPrivacy,PrivacyHost} from '../src/components/AccountPrivacy.tsx';
import {OidcSession} from '../src/auth/oidc.ts';
import {createPrivacyRuntime} from '../src/privacy/runtime.ts';
import {verifiedBinding} from '../src/storage/verifiedBinding.ts';
import {MemorySecretStore} from '../src/platform/secretStore.ts';
import {AccountStore} from '../src/storage/accountStore.ts';
import {parseAppConfig} from '../src/config.ts';
import {ClientError} from '../src/errors.ts';
import type {AuthSession,AuthSubject,ClearLocalSessionOptions} from '../src/auth/oidc.ts';
import type {StoredWorkspace,WorkspaceController} from '../src/sync/workspace.ts';
import type {AccountPrivacyStatus} from '../src/privacy/client.ts';

const config=parseAppConfig({apiBaseUrl:'https://sync.example.test',oidcAuthority:'https://id.example.test/realms/paperquay',oidcClientId:'mobile'},'https://app.example.test');
const now='2026-11-06T00:00:00.000Z';
const text=(node:ReactTestInstance):string=>node.children.map(child=>typeof child==='string'?child:text(child)).join('');
const button=(root:ReactTestInstance,label:string)=>root.findAllByType('button').find(node=>text(node)===label)!;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

test('joined Web refresh and a lost ACK keep PrivacyHost mounted and allow closing, reopening and explicitly retrying',{timeout:15000},async t=>{
  const memory=new InMemoryWebStorage(),previous=new Map<string,PropertyDescriptor|undefined>();
  const localStorage={getItem:(key:string)=>memory.getItem(key)??null,setItem:(key:string,value:string)=>memory.setItem(key,value),removeItem:(key:string)=>memory.removeItem(key)};
  for(const [key,value] of Object.entries({indexedDB:new IDBFactory(),localStorage})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});
  }
  t.after(()=>{for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const accountId=crypto.randomUUID(),deviceId=crypto.randomUUID(),scope={apiBaseUrl:config.apiBaseUrl,accountId};
  const closed:AccountPrivacyStatus={accountId,state:'closed',closedAt:now,closureRequestId:crypto.randomUUID(),
    deviceErasure:{requested:true,pending:1,acknowledged:0,thisDevicePending:true}};
  const makeUser=(rotated=false)=>new User({access_token:rotated?'rotated-access':'initial-access',token_type:'Bearer',refresh_token:rotated?'rotated-refresh':'initial-refresh',
    expires_at:Math.floor(Date.now()/1000)+3600,profile:{iss:config.oidcAuthority,sub:accountId,sid:'original-session',aud:config.oidcClientId,
      iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600}});
  const originalUser=makeUser(),refreshEntered=deferred<void>(),refreshRelease=deferred<User>(),statusEntered=deferred<void>(),statusRelease=deferred<Response>(),clearing=deferred<void>();
  let stored:User|null=originalUser,statusCalls=0,acks=0;
  t.mock.method(UserManager.prototype,'signinRedirectCallback',async()=>originalUser);
  t.mock.method(UserManager.prototype,'signinSilent',async()=>{refreshEntered.resolve();stored=await refreshRelease.promise;return stored;});
  t.mock.method(UserManager.prototype,'removeUser',async()=>{stored=null;});
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(String(input).endsWith('/status')){statusCalls++;statusEntered.resolve();return statusRelease.promise;}
    assert(String(input).endsWith('/erasure-ack'));assert.equal(stored,null);
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer rotated-access');acks++;
    if(acks===1)throw Error('Synthetic lost ACK');return Response.json({acknowledged:true});
  });
  const auth=new OidcSession(config,new InMemoryWebStorage());await auth.completeSignIn(config.redirectUri);
  const states:string[]=[],unsubscribe=auth.subscribe(()=>states.push(auth.getSnapshot().status));
  const secrets=new MemorySecretStore(),binding=verifiedBinding(config,secrets,auth.getSubject);
  await binding.write({accountId,device:{id:deviceId,name:'Synthetic browser',platform:'web',createdAt:now,lastSeenAt:now,revokedAt:null}});
  const store=new AccountStore<StoredWorkspace>({indexedDB:globalThis.indexedDB,databaseName:crypto.randomUUID(),decode:value=>value as StoredWorkspace});
  await store.update(scope,()=>({sync:{accountId}} as StoredWorkspace));
  const controller={subscribe:()=>()=>{},getSnapshot:()=>workspace,deactivate:()=>undefined} as unknown as WorkspaceController;
  const workspace={error:null};
  const runtime=createPrivacyRuntime(config,auth,store,secrets,controller,binding),clear=auth.clearLocalSession.bind(auth),erase=runtime.erase.bind(runtime);
  t.mock.method(auth,'clearLocalSession',async(options?:ClearLocalSessionOptions)=>{clearing.resolve();return clear(options);});
  let finished=deferred<void>();runtime.erase=async(...args)=>{try{return await erase(...args);}finally{finished.resolve();}};
  let renderer!:ReactTestRenderer,open=true;
  const view=()=>createElement(PrivacyHost,{privacy:runtime,auth,controller,apiBaseUrl:config.apiBaseUrl,open,onClose:()=>{open=false;renderer.update(view());}});
  try {
    await act(async()=>{renderer=create(view(),{createNodeMock:element=>element.type==='dialog'?{open:false,showModal(){this.open=true;},close(){this.open=false;}}:{focus:()=>undefined}});});
    await statusEntered.promise;originalUser.expires_at=Math.floor(Date.now()/1000)+10;
    const ordinary=assert.rejects(auth.getAccessToken(),{code:'AUTH_REQUIRED'});await refreshEntered.promise;
    await act(async()=>{statusRelease.resolve(Response.json(closed));await clearing.promise;});
    await act(async()=>{refreshRelease.resolve(makeUser(true));await ordinary;await finished.promise;});
    assert(!states.includes('error'),states.join(','));assert.equal(auth.getSnapshot().status,'signed-in');assert.equal(auth.getSnapshot().needsLogin,true);
    assert.equal(acks,1);assert.equal(renderer.root.findAllByType('dialog').length,1);
    assert(renderer.root.findAllByProps({role:'alert'}).some(node=>text(node).includes('尚未确认设备清理结果')));
    await act(async()=>button(renderer.root,'关闭').props.onClick());assert.equal(renderer.root.findAllByType('dialog').length,0);
    await act(async()=>{open=true;renderer.update(view());});assert.equal(statusCalls,1);
    assert.equal(button(renderer.root,'重新验证登录').props.disabled,true);
    const consent=renderer.root.findAllByType('label').find(node=>text(node).includes('清理本机此账号的副本与凭据'))!.findByType('input');
    await act(async()=>consent.props.onChange({target:{checked:true}}));finished=deferred<void>();
    await act(async()=>{button(renderer.root,'清理本机并完成确认').props.onClick();await finished.promise;});
    assert.equal(acks,2);assert.equal(auth.getSnapshot().status,'signed-out');assert.equal(renderer.root.findAllByType('dialog').length,0);
  }finally{await act(async()=>renderer?.unmount());unsubscribe();await runtime.dispose();await auth.dispose();await store.close();}
});

test('reopening real privacy runtime preserves explicit erasure retry while ordinary credentials remain blocked',{timeout:15000},async t=>{
  const indexedDB=new IDBFactory(),memory=new InMemoryWebStorage(),previous=new Map<string,PropertyDescriptor|undefined>();
  const localStorage={getItem:(key:string)=>memory.getItem(key)??null,setItem:(key:string,value:string)=>memory.setItem(key,value),removeItem:(key:string)=>memory.removeItem(key)};
  for(const [key,value] of Object.entries({indexedDB,localStorage})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});}
  t.after(()=>{for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  for(const failure of ['persisted-session','token-renewal','ack','identity-change'])await t.test(failure,async()=>{
    const accountId=crypto.randomUUID(),deviceId=crypto.randomUUID(),scope={apiBaseUrl:config.apiBaseUrl,accountId};
    const closed:AccountPrivacyStatus={accountId,state:'closed',closedAt:now,closureRequestId:crypto.randomUUID(),
      deviceErasure:{requested:true,pending:1,acknowledged:0,thisDevicePending:true}};
    let subject:AuthSubject|null={issuer:config.oidcAuthority,subject:accountId,sessionKey:'a'.repeat(64)},blocked=false,attempts=0,statusCalls=0,acks=0,signIns=0;
    const listeners=new Set<()=>void>(),secrets=new MemorySecretStore();
    const auth={getSubject:()=>subject,subscribe:(fn:()=>void)=>{listeners.add(fn);return ()=>listeners.delete(fn);},
      getAccessToken:async()=>{if(blocked)throw new ClientError('AUTH_REQUIRED');return 'synthetic original token';},
      signIn:async()=>{signIns++;},clearLocalSession:async(options:ClearLocalSessionOptions)=>{
        blocked=true;attempts++;assert.equal(options.renewForErasure,true);
        if(attempts===1&&failure!=='ack')throw new ClientError(failure==='token-renewal'?'AUTH_REQUIRED':'STORAGE_FAILED');
        await options.afterPersisted?.('synthetic original token');subject=null;listeners.forEach(fn=>fn());
      }} as unknown as AuthSession;
    const binding=verifiedBinding(config,secrets,auth.getSubject);
    await binding.write({accountId,device:{id:deviceId,name:'Synthetic browser',platform:'web',createdAt:now,lastSeenAt:now,revokedAt:null}});
    const store=new AccountStore<StoredWorkspace>({indexedDB,databaseName:crypto.randomUUID(),decode:value=>value as StoredWorkspace});
    await store.update(scope,()=>({sync:{accountId}} as StoredWorkspace));
    const controller={deactivate:()=>undefined} as unknown as WorkspaceController;
    const runtime=createPrivacyRuntime(config,auth,store,secrets,controller,binding);
    let finished!:()=>void,erasureDone=new Promise<void>(resolve=>{finished=resolve;});
    const erase=runtime.erase.bind(runtime);
    runtime.erase=async(...args)=>{try{return await erase(...args);}finally{finished();}};
    const fetcher=t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer synthetic original token');
      if(url.endsWith('/v1/privacy/status')){statusCalls++;return Response.json(closed);}
      assert(url.endsWith('/v1/privacy/erasure-ack'));assert.deepEqual(JSON.parse(String(init?.body)),{deviceId});acks++;
      if(acks===1&&failure==='ack')throw Error('Synthetic lost ACK');
      return Response.json({acknowledged:true});
    });
    let renderer!:ReactTestRenderer;
    const mount=async()=>act(async()=>{renderer=create(createElement(AccountPrivacy,{privacy:runtime,auth,apiBaseUrl:config.apiBaseUrl,onClose:()=>undefined}),
      {createNodeMock:element=>element.type==='dialog'?{open:false,showModal(){this.open=true;},close(){this.open=false;}}:{focus:()=>undefined}});});
    try{
      await mount();await act(async()=>{await erasureDone;});
      assert.equal(attempts,1,renderer.root.findAllByProps({role:'alert'}).map(text).join(' '));
      assert.equal(statusCalls,1);assert(blocked);assert.equal(subject?.subject,accountId);
      await assert.rejects(auth.getAccessToken(),{code:'AUTH_REQUIRED'});assert.equal(await store.read(scope),null);
      assert.deepEqual(runtime.recoveryStatus(),closed);
      const copy=runtime.recoveryStatus()!;copy.accountId=crypto.randomUUID();assert.equal(runtime.recoveryStatus()!.accountId,accountId);
      await act(async()=>renderer.unmount());
      if(failure==='identity-change'){
        subject={issuer:config.oidcAuthority,subject:'replacement'};listeners.forEach(fn=>fn());
        subject={issuer:config.oidcAuthority,subject:accountId};listeners.forEach(fn=>fn());
        assert.equal(runtime.recoveryStatus(),null);return;
      }
      await mount();assert.equal(statusCalls,1);assert.equal(attempts,1);
      assert(button(renderer.root,'清理本机并完成确认'),'reopened dialog must retain its erasure retry control');
      assert.equal(button(renderer.root,'重新验证登录').props.disabled,true);
      assert(renderer.root.findAllByProps({role:'status'}).some(node=>text(node).includes('上次已验证账号注销')));
      const consent=renderer.root.findAllByType('label').find(node=>text(node).includes('清理本机此账号的副本与凭据'))!.findByType('input');
      await act(async()=>consent.props.onChange({target:{checked:true}}));
      erasureDone=new Promise<void>(resolve=>{finished=resolve;});
      await act(async()=>{button(renderer.root,'清理本机并完成确认').props.onClick();await erasureDone;});
      assert.equal(attempts,2);assert.equal(acks,failure==='ack'?2:1);assert.equal(signIns,0);assert.equal(await binding.read().catch(()=>null),null);
      assert.equal(runtime.recoveryStatus(),null);
    }finally{await act(async()=>renderer.unmount());fetcher.mock.restore();runtime.dispose();await store.close();}
  });
});
