import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import {LockHub,StorageHub,deferred} from './browserErasureFixtures.ts';
import {BrowserErasureCoordinator} from '../src/privacy/browserErasure.ts';
import {browserAccountContext} from '../src/privacy/browserAccount.ts';
import {createPrivacyRuntime} from '../src/privacy/runtime.ts';
import {createVerifiedBinding} from '../src/storage/verifiedBinding.ts';
import {MemorySecretStore,createSecretStore} from '../src/platform/secretStore.ts';
import {AccountStore} from '../src/storage/accountStore.ts';
import {WorkspaceController,decodeWorkspace} from '../src/sync/workspace.ts';
import {parseAppConfig} from '../src/config.ts';
import {ClientError} from '../src/errors.ts';
import type {AuthSession,AuthSubject,AuthSnapshot,ClearLocalSessionOptions} from '../src/auth/oidc.ts';
import type {AccountIdentity} from '../src/api.ts';
import type {AccountPrivacyStatus} from '../src/privacy/client.ts';
import {AiClient} from '../src/ai/client.ts';
import {LocalAiConfigStore,defaultAiProvider,aiSecretNamespace,AI_SECRET_KEY,aiAccountKey} from '../src/ai/provider.ts';
import {ZoteroClient,zoteroSecretNamespace,ZOTERO_SECRET_KEY} from '../src/library/zoteroClient.ts';
import {RadarClient,radarSecretNamespace} from '../src/radar/client.ts';
import {config as radarTopic,at as radarTime} from './radarFixtures.ts';
import {authSubject} from '../src/auth/subject.ts';
import {openPersonalExportSink,type PersonalSaveRuntime} from '../src/privacy/saveExport.ts';

const config=parseAppConfig({apiBaseUrl:'https://sync.example.test',oidcAuthority:'https://id.example.test/realms/paperquay',oidcClientId:'mobile'},'https://app.example.test');
const now='2026-11-06T00:00:00.000Z',factory=new IDBFactory();
const identity=(accountId:string,deviceId:string):AccountIdentity=>({accountId,device:{id:deviceId,name:'Synthetic browser',platform:'web',createdAt:now,lastSeenAt:now,revokedAt:null}});
function context(coordinator:BrowserErasureCoordinator,databaseName:string,bindingName:string,accountId:string,deviceId:string,token:string,
  configStorage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>,openExportSink?:typeof openPersonalExportSink){
  const who=(id:string)=>authSubject({iss:config.oidcAuthority,sub:id,sid:token},config.oidcAuthority);
  let subject:AuthSubject|null=who(accountId),account=identity(accountId,deviceId),blocked=false;
  let snapshot:AuthSnapshot={status:'signed-in'};
  const listeners=new Set<()=>void>(),secrets=new MemorySecretStore();
  const auth={getSubject:()=>subject,getSnapshot:()=>snapshot,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},
    getAccessToken:async()=>{if(blocked||!subject)throw new ClientError('AUTH_REQUIRED');return token;},
    clearLocalSession:async(options?:ClearLocalSessionOptions)=>{blocked=true;await options?.afterPersisted?.(token);
      if(!options?.retainForErasure)subject=null;snapshot={status:subject?'signed-in':'signed-out',needsLogin:Boolean(subject)};listeners.forEach(fn=>fn());},
    dispose:async()=>{subject=null;listeners.forEach(fn=>fn());}} as unknown as AuthSession;
  const binding=createVerifiedBinding(config,secrets,auth.getSubject,{indexedDB:factory,databaseName:bindingName});
  const store=new AccountStore({indexedDB:factory,databaseName,decode:decodeWorkspace});
  let controller!:WorkspaceController;
  const lease=browserAccountContext({apiBaseUrl:config.apiBaseUrl,auth,secrets,binding,coordinator,configStorage,stop:()=>controller.deactivate()});
  const api={register:async()=>account,push:async()=>{throw Error('No automatic network');},pull:async()=>{throw Error('No automatic network');},
    conflicts:async()=>({conflicts:[],nextCursor:'',hasMore:false}),devices:async()=>[],revokeDevice:async()=>{},resolveConflict:async()=>{throw Error('No conflicts');}};
  controller=new WorkspaceController({api,apiBaseUrl:config.apiBaseUrl,store,binding:{...binding,guard:lease.guard,activate:lease.activate}});
  const privacy=createPrivacyRuntime(config,auth,store,secrets,controller,binding,{...lease.privacyOptions,openExportSink});
  return {auth,secrets,binding,store,controller,privacy,lease,api,
    async bind(){controller.setOnline(true);await controller.bind('Synthetic browser');assert.equal(controller.getSnapshot().status,'ready',controller.getSnapshot().error?.code);controller.setOnline(false);},
    changeOwner(id:string){subject=who(id);account=identity(id,crypto.randomUUID());blocked=false;listeners.forEach(fn=>fn());},
    async close(){controller.deactivate();await privacy.dispose();await auth.dispose();await store.close();await binding.close();await lease.disposeAfterResources();}};
}

async function waitForPeer(runtime:ReturnType<typeof createPrivacyRuntime>){
  const deadline=performance.now()+5000;
  while(runtime.getPeerErasure()?.phase!=='pending'){
    assert(performance.now()<deadline,'Peer preparation did not finish');await new Promise(done=>setTimeout(done,5));
  }
}

test('distinct browser SIDs retain peer erasure sessions and explicitly finish each original device ACK',async t=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port();
  const previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({indexedDB:factory,localStorage:one.storage})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});}
  t.after(()=>{for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const ca=new BrowserErasureCoordinator({...one,locks:locks.port('a'),timeoutMs:20}),cb=new BrowserErasureCoordinator({...two,locks:locks.port('b')});
  const accountId=crypto.randomUUID(),deviceId=crypto.randomUUID(),foreignId=crypto.randomUUID(),scope={apiBaseUrl:config.apiBaseUrl,accountId},foreign={...scope,accountId:foreignId};
  const database=crypto.randomUUID(),bindings=crypto.randomUUID(),main=context(ca,database,bindings,accountId,deviceId,'main-original-token'),peer=context(cb,database,bindings,foreignId,crypto.randomUUID(),'peer-original-token');
  let requests=0,acks=0,peerAcks=0,statusCalls=0;const acknowledged=new Set<string>();
  const provider={...defaultAiProvider(),endpoint:'https://synthetic-model.example.test/v1',requiresKey:true},aiNamespace=await aiSecretNamespace(scope,provider);
  const configKey='paperquay.mobile.ai-config.v1.'+encodeURIComponent(aiAccountKey(scope)),externalKey='paperquay.mobile.ai-config.v1.external.'+encodeURIComponent(aiAccountKey(scope));
  const zoteroNamespace=zoteroSecretNamespace(scope,{kind:'user',libraryId:'1',name:'Synthetic'}),radarNamespace=radarSecretNamespace(scope),radarRef=crypto.randomUUID();
  const peerDevice=crypto.randomUUID();
  const closed:AccountPrivacyStatus={accountId,state:'closed',closedAt:now,closureRequestId:crypto.randomUUID(),deviceErasure:{requested:true,pending:2,acknowledged:0,thisDevicePending:true}};
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const token=(init?.headers as Record<string,string>).Authorization;
    if(String(input).endsWith('/v1/privacy/status')){
      assert.equal(token,'Bearer peer-original-token');statusCalls++;
      return Response.json({...closed,deviceErasure:{requested:true,pending:2-acknowledged.size,acknowledged:acknowledged.size,thisDevicePending:!acknowledged.has(peerDevice)}});
    }
    assert.equal(String(input),config.apiBaseUrl+'/v1/privacy/erasure-ack');
    const id=token==='Bearer main-original-token'?deviceId:peerDevice;
    assert(['Bearer main-original-token','Bearer peer-original-token'].includes(token));
    assert.deepEqual(JSON.parse(String(init?.body)),{deviceId:id});
    assert.equal(peer.controller.getSnapshot().workspace,null);assert(peer.auth.getSubject());
    await assert.rejects(peer.auth.getAccessToken(),{code:'AUTH_REQUIRED'});
    assert.equal(await peer.secrets.get(aiNamespace,AI_SECRET_KEY),null);assert.equal(await peer.secrets.get(zoteroNamespace,ZOTERO_SECRET_KEY),null);
    assert.equal(await peer.secrets.get(radarNamespace,radarRef),null);
    assert.equal(one.storage.getItem(configKey),null);assert.equal(one.storage.getItem(externalKey),null);
    acks++;acknowledged.add(id);
    if(id===peerDevice&&++peerAcks===1)throw Error('Synthetic lost peer ACK response');
    return Response.json({acknowledged:true});
  });
  try{
    await peer.bind();await peer.privacy.scopedSecrets(foreign).set('foreign-provider','api-key','foreign preserved key');
    await main.bind();
    peer.changeOwner(accountId);peer.api.register=async()=>identity(accountId,peerDevice);await peer.bind();
    assert.equal((await main.binding.read())!.device.id,deviceId);assert.equal((await peer.binding.read())!.device.id,peerDevice);
    await peer.controller.save({entityType:'note',entityId:crypto.randomUUID(),mutation:'put',data:{title:'Private note',body:'synthetic loaded paper context',format:'markdown',paperId:null}},0);
    const scoped=peer.privacy.scopedSecrets(scope);
    await scoped.set(aiNamespace,AI_SECRET_KEY,'synthetic-model-key');await scoped.set(zoteroNamespace,ZOTERO_SECRET_KEY,'a'.repeat(32));await scoped.set(radarNamespace,radarRef,'b'.repeat(32));
    const configs=new LocalAiConfigStore(two.storage);configs.save(scope,provider);configs.save(foreign,provider);
    two.storage.setItem(externalKey,JSON.stringify(provider));
    const pendingConfigWrites=[configKey,externalKey].map(key=>[key,two.storage.getItem(key)!] as const);
    assert(peer.controller.getSnapshot().workspace);two.pause();
    await assert.rejects(main.privacy.erase(closed),{code:'BROWSER_ERASURE_PENDING'});assert.equal(acks,0);
    assert(peer.controller.getSnapshot().workspace);assert.equal(await peer.secrets.get(aiNamespace,AI_SECRET_KEY),'synthetic-model-key');
    await assert.rejects(scoped.get(aiNamespace,AI_SECRET_KEY),{code:'CHANGED'});
    assert.throws(()=>configs.save(scope,provider),{code:'CANCELLED'});
    const model=new AiClient(scoped,{kind:'fetch',supportsStreaming:false,redirectPolicy:'error',request:async()=>{requests++;return Response.json({data:[]});}});
    await assert.rejects(model.listModels({accountScope:scope,config:provider}),{code:'CANCELLED'});assert.equal(requests,0);
    await assert.rejects(peer.controller.save({entityType:'note',entityId:crypto.randomUUID(),mutation:'put',data:{title:'Late',body:'must not persist',format:'markdown',paperId:null}},0),{code:'ACCOUNT_CHANGED'});
    assert.equal(two.storage.getItem(configKey),null);assert.equal(two.storage.getItem(externalKey),null);
    // Resume two writes from a settings save already past its fence check in
    // the paused peer, after the initiator's first configStore.clear().
    for(const [key,value] of pendingConfigWrites)two.storage.setItem(key,value);
    assert.equal(configs.load(scope).endpoint,provider.endpoint);assert.equal(configs.loadExternal(scope).endpoint,provider.endpoint);
    two.resume();await waitForPeer(peer.privacy);
    assert.equal(two.storage.getItem(configKey),null);assert.equal(two.storage.getItem(externalKey),null);
    await main.privacy.erase(closed,true);assert.equal(acks,1);assert.equal(requests,0);
    assert(peer.auth.getSubject());assert.equal(peer.privacy.getPeerErasure()?.accountId,accountId);
    await assert.rejects(peer.privacy.client.status(new AbortController().signal),{code:'AUTH_REQUIRED'});
    await assert.rejects(peer.privacy.finishPeerErasure(new AbortController().signal),{code:'OUTCOME_UNKNOWN'});
    assert.equal(statusCalls,1);assert(peer.auth.getSubject());assert.equal(peer.privacy.getPeerErasure()?.failed,true);
    await peer.privacy.finishPeerErasure(new AbortController().signal);
    assert.equal(statusCalls,1);assert.equal(acks,3);assert.equal(peerAcks,2);assert.equal(acknowledged.size,2);
    assert.equal(peer.auth.getSubject(),null);assert.equal(peer.privacy.getPeerErasure(),null);
    assert.equal(two.storage.getItem(configKey),null);assert.equal(two.storage.getItem(externalKey),null);
    assert.equal(await peer.secrets.get('foreign-provider','api-key'),'foreign preserved key');assert.equal(configs.load(foreign).endpoint,provider.endpoint);
    assert.equal(await main.store.read(scope),null);assert.equal(main.auth.getSubject(),null);assert.equal(main.privacy.recoveryStatus(),null);
  }finally{await main.close();await peer.close();ca.detach();cb.detach();}
});

test('a peer config deletion failure retains its lease and blocks ACK until explicit retry clears both config rows',async t=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port();
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,value:one.storage});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else Reflect.deleteProperty(globalThis,'localStorage');});
  const ca=new BrowserErasureCoordinator({...one,locks:locks.port('initiator'),timeoutMs:20}),cb=new BrowserErasureCoordinator({...two,locks:locks.port('peer')});
  let failed=true,acknowledgements=0;
  const configStorage={...two.storage,removeItem(key:string){if(failed)throw Error('Synthetic config deletion failure');two.storage.removeItem(key);}};
  const accountId=crypto.randomUUID(),scope={apiBaseUrl:config.apiBaseUrl,accountId},peer=context(cb,crypto.randomUUID(),crypto.randomUUID(),accountId,crypto.randomUUID(),'peer-token',configStorage);
  const configs=new LocalAiConfigStore(one.storage),provider={...defaultAiProvider(),endpoint:'https://private-model.example.test/v1'};
  const configKey='paperquay.mobile.ai-config.v1.'+encodeURIComponent(aiAccountKey(scope)),externalKey='paperquay.mobile.ai-config.v1.external.'+encodeURIComponent(aiAccountKey(scope));
  const requestId=crypto.randomUUID(),owner={};
  try{
    await peer.bind();configs.save(scope,provider);two.storage.setItem(externalKey,JSON.stringify(provider));
    ca.publish(scope,requestId,owner);
    await assert.rejects(ca.complete(scope,requestId,owner,async()=>{acknowledgements++;}),{code:'BROWSER_ERASURE_PENDING'});
    assert.equal(acknowledgements,0);assert(peer.auth.getSubject());assert(one.storage.getItem(configKey));assert(one.storage.getItem(externalKey));
    failed=false;ca.publish(scope,requestId,owner);
    await ca.complete(scope,requestId,owner,async()=>{
      assert(peer.auth.getSubject());await assert.rejects(peer.auth.getAccessToken(),{code:'AUTH_REQUIRED'});
      assert.equal(one.storage.getItem(configKey),null);assert.equal(one.storage.getItem(externalKey),null);acknowledgements++;
    });
    assert.equal(acknowledgements,1);
  }finally{await peer.close();ca.detach();cb.detach();}
});

test('Web runtime disposal destroys its own secret map and cannot invalidate a replacement runtime',async()=>{
  const a=await createSecretStore(),b=await createSecretStore();assert.notEqual(a,b);
  await a.set('owner','key','old runtime key');await b.set('owner','key','replacement runtime key');a.disposeMemory!();
  await assert.rejects(a.get('owner','key'),{code:'STORAGE_UNAVAILABLE'});await assert.rejects(a.set('owner','key','late'),{code:'STORAGE_UNAVAILABLE'});
  assert.equal(await b.get('owner','key'),'replacement runtime key');b.disposeMemory!();
});

test('a peer retains its shared lease until an in-flight local export and its temporary destination are fully aborted',async t=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port(),previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({indexedDB:factory,localStorage:one.storage})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});
  }
  t.after(()=>{for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const ca=new BrowserErasureCoordinator({...one,locks:locks.port('initiator'),timeoutMs:20}),cb=new BrowserErasureCoordinator({...two,locks:locks.port('peer')});
  const accountId=crypto.randomUUID(),scope={apiBaseUrl:config.apiBaseUrl,accountId},requestId=crypto.randomUUID(),owner={};
  const peer=context(cb,crypto.randomUUID(),crypto.randomUUID(),accountId,crypto.randomUUID(),'peer-token');
  const writeEntered=deferred(),writeRelease=deferred(),abortEntered=deferred(),abortRelease=deferred();let confirmed=0,finished=0;
  try{
    await peer.bind();const exporting=assert.rejects(peer.privacy.localExport(scope,{write:async()=>{writeEntered.resolve();await writeRelease.promise;},
      finish:async()=>{finished++;return 'saved';},abort:async()=>{abortEntered.resolve();await abortRelease.promise;}},new AbortController().signal));
    await writeEntered.promise;ca.publish(scope,requestId,owner);
    await assert.rejects(ca.complete(scope,requestId,owner,async()=>{confirmed++;}),{code:'BROWSER_ERASURE_PENDING'});assert.equal(confirmed,0);
    writeRelease.resolve();await abortEntered.promise;
    await assert.rejects(ca.complete(scope,requestId,owner,async()=>{confirmed++;}),{code:'BROWSER_ERASURE_PENDING'});assert.equal(confirmed,0);
    abortRelease.resolve();await exporting;await waitForPeer(peer.privacy);
    await ca.complete(scope,requestId,owner,async()=>{confirmed++;});assert.equal(confirmed,1);assert.equal(finished,0);
    await assert.rejects(peer.privacy.localExport(scope,{write:async()=>{},finish:async()=>{assert.fail('A sealed peer cannot publish an export');},abort:async()=>{}},new AbortController().signal),{code:'CHANGED'});
  }finally{writeRelease.resolve();abortRelease.resolve();await peer.close();ca.detach();cb.detach();}
});

test('a peer accepts only the server-verified account and closure request, then drops recovery after an owner change',async t=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port();
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,value:one.storage});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else Reflect.deleteProperty(globalThis,'localStorage');});
  const ca=new BrowserErasureCoordinator({...one,locks:locks.port('initiator')}),cb=new BrowserErasureCoordinator({...two,locks:locks.port('peer')});
  const accountId=crypto.randomUUID(),scope={apiBaseUrl:config.apiBaseUrl,accountId},requestId=crypto.randomUUID(),owner={};
  const peer=context(cb,crypto.randomUUID(),crypto.randomUUID(),accountId,crypto.randomUUID(),'peer-token');
  let response:unknown,queries=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{assert(String(input).endsWith('/status'),'Invalid peer status must never reach ACK');queries++;return Response.json(response);});
  try{
    await peer.bind();ca.publish(scope,requestId,owner);await waitForPeer(peer.privacy);
    const closed:AccountPrivacyStatus={accountId,state:'closed',closedAt:now,closureRequestId:requestId,deviceErasure:{requested:true,pending:1,acknowledged:0,thisDevicePending:true}};
    for(const wrong of[{...closed,accountId:crypto.randomUUID()},{...closed,closureRequestId:crypto.randomUUID()},
      {accountId,state:'active',closedAt:null,closureRequestId:null,deviceErasure:{requested:false,pending:0,acknowledged:0,thisDevicePending:false}}]){
      response=wrong;await assert.rejects(peer.privacy.finishPeerErasure(new AbortController().signal),{code:'INVALID'});
      assert(peer.auth.getSubject());assert.equal(peer.privacy.getPeerErasure()?.failed,true);assert.equal(peer.privacy.recoveryStatus(),null);
    }
    assert.equal(queries,3);const replacementId=crypto.randomUUID();peer.changeOwner(replacementId);assert.equal(peer.privacy.getPeerErasure(),null);
    await assert.rejects(peer.privacy.finishPeerErasure(new AbortController().signal),{code:'CHANGED'});assert.equal(queries,3);
    response={accountId:replacementId,state:'active',closedAt:null,closureRequestId:null,deviceErasure:{requested:false,pending:0,acknowledged:0,thisDevicePending:false}};
    assert.deepEqual(await peer.privacy.client.status(new AbortController().signal),response);assert.equal(queries,4);
  }finally{await peer.close();ca.detach();cb.detach();}
});

for(const mode of ['local','server','picker'])test(`failed temporary-export cleanup stays pending until an explicit successful retry (${mode})`,{timeout:15000},async t=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port(),previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({indexedDB:factory,localStorage:one.storage})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});
  }
  t.after(()=>{for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const ca=new BrowserErasureCoordinator({...one,locks:locks.port('initiator'),timeoutMs:20}),cb=new BrowserErasureCoordinator({...two,locks:locks.port('peer')});
  const accountId=crypto.randomUUID(),deviceId=crypto.randomUUID(),scope={apiBaseUrl:config.apiBaseUrl,accountId},requestId=crypto.randomUUID(),owner={};
  const writeEntered=deferred(),writeRelease=deferred();let failed=true,temporary=true,aborts=0,confirmed=0,peerAcks=0,statusCalls=0,finished=0;
  const abort=async()=>{aborts++;if(failed)throw Error('Synthetic temporary destination deletion failed');temporary=false;};
  const save={native:false,pick:async()=>{writeEntered.resolve();await writeRelease.promise;return {write:async()=>{},close:async()=>{finished++;},abort};}} as unknown as PersonalSaveRuntime;
  const picker:typeof openPersonalExportSink=(scope,current,_runtime,cleanup)=>openPersonalExportSink(scope,current,save,cleanup);
  const peer=context(cb,crypto.randomUUID(),crypto.randomUUID(),accountId,deviceId,'peer-token',undefined,mode==='picker'?picker:undefined);
  const closed:AccountPrivacyStatus={accountId,state:'closed',closedAt:now,closureRequestId:requestId,deviceErasure:{requested:true,pending:1,acknowledged:0,thisDevicePending:true}};
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=String(input);
    if(url.endsWith('/export')){
      assert.equal(mode,'server');const header=new TextEncoder().encode(JSON.stringify({kind:'header',format:'paperquay-personal-data',version:1,accountId,
        consistency:'repeatable-read',scope:'application-server'})+'\n');
      return new Response(new ReadableStream({start(controller){controller.enqueue(header);}}),{headers:{'Content-Type':'application/x-ndjson'}});
    }
    if(url.endsWith('/status')){statusCalls++;return Response.json(closed);}
    assert(url.endsWith('/erasure-ack'));assert.equal(temporary,false);peerAcks++;return Response.json({acknowledged:true});
  });
  try{
    await peer.bind();const sink={write:async()=>{writeEntered.resolve();await writeRelease.promise;},finish:async()=>{finished++;return 'saved' as const;},abort};
    const exporting=assert.rejects(mode==='picker'?peer.privacy.exportData(scope,false,new AbortController().signal)
      :mode==='local'?peer.privacy.localExport(scope,sink,new AbortController().signal):peer.privacy.client.exportData(scope,sink,new AbortController().signal));
    await writeEntered.promise;ca.publish(scope,requestId,owner);
    const acknowledge=async()=>{confirmed++;assert.equal(temporary,false);};
    await assert.rejects(ca.complete(scope,requestId,owner,acknowledge),{code:'BROWSER_ERASURE_PENDING'});
    writeRelease.resolve();await exporting;await waitForPeer(peer.privacy);assert.equal(peer.privacy.getPeerErasure()?.failed,true);assert.equal(aborts,1);
    await assert.rejects(ca.complete(scope,requestId,owner,acknowledge),{code:'BROWSER_ERASURE_PENDING'});assert.equal(confirmed,0);assert.equal(peerAcks,0);
    ca.publish(scope,requestId,owner);await assert.rejects(ca.complete(scope,requestId,owner,acknowledge),{code:'BROWSER_ERASURE_PENDING'});
    assert.equal(aborts,1,'Repeated storage signals must not silently retry failed deletion');
    await assert.rejects(peer.privacy.finishPeerErasure(new AbortController().signal),{code:'FAILED'});assert.equal(aborts,2);
    assert.equal(statusCalls,0);assert.equal(confirmed,0);assert.equal(peerAcks,0);assert(temporary);
    failed=false;await peer.privacy.finishPeerErasure(new AbortController().signal);
    assert.equal(aborts,3);assert.equal(temporary,false);assert.equal(finished,0);assert.equal(peerAcks,1);assert.equal(statusCalls,1);
    await ca.complete(scope,requestId,owner,acknowledge);assert.equal(confirmed,1);
  }finally{failed=false;writeRelease.resolve();await peer.close();ca.detach();cb.detach();}
});

test('a former owner cannot release its erasure lease with a failed export, and cleanup leaves the replacement account usable',{timeout:15000},async t=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port(),previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({indexedDB:factory,localStorage:one.storage})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});
  }
  t.after(()=>{for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const ca=new BrowserErasureCoordinator({...one,locks:locks.port('initiator'),timeoutMs:20}),cb=new BrowserErasureCoordinator({...two,locks:locks.port('replacement')});
  const oldId=crypto.randomUUID(),nextId=crypto.randomUUID(),oldScope={apiBaseUrl:config.apiBaseUrl,accountId:oldId},nextScope={...oldScope,accountId:nextId};
  const peer=context(cb,crypto.randomUUID(),crypto.randomUUID(),oldId,crypto.randomUUID(),'original-token'),entered=deferred(),release=deferred();
  const nextStatusEntered=deferred();let releaseNextStatus!:(value:Response)=>void,nextSignal:AbortSignal|undefined;
  const nextStatus=new Promise<Response>(resolve=>{releaseNextStatus=resolve;});
  const active={accountId:nextId,state:'active',closedAt:null,closureRequestId:null,deviceErasure:{requested:false,pending:0,acknowledged:0,thisDevicePending:false}};
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    assert(String(input).endsWith('/status'));nextSignal=init?.signal??undefined;nextStatusEntered.resolve();return nextStatus;
  });
  let failed=true,temporary=true,acks=0;
  try{
    await peer.bind();const exporting=assert.rejects(peer.privacy.localExport(oldScope,{write:async()=>{entered.resolve();await release.promise;},
      finish:async()=>{assert.fail('Old account export cannot publish after replacement');},abort:async()=>{if(failed)throw Error('Synthetic cleanup failure');temporary=false;}},new AbortController().signal));
    await entered.promise;peer.changeOwner(nextId);release.resolve();await exporting;await peer.bind();
    assert.equal(peer.privacy.hasFailedExportCleanup(),true);assert.equal(peer.privacy.getPeerErasure(),null);
    const replacement=peer.auth.getSubject(),workspace=peer.controller.getSnapshot().workspace;
    await peer.privacy.scopedSecrets(nextScope).set('replacement-provider','key','replacement preserved');
    const querying=peer.privacy.client.status(new AbortController().signal);await nextStatusEntered.promise;
    const requestId=crypto.randomUUID(),owner={};ca.publish(oldScope,requestId,owner);
    await assert.rejects(ca.complete(oldScope,requestId,owner,async()=>{acks++;assert.equal(temporary,false);}),{code:'BROWSER_ERASURE_PENDING'});
    assert.equal(acks,0);assert.equal(peer.privacy.getPeerErasure(),null);assert.deepEqual(peer.auth.getSubject(),replacement);
    assert.equal(await peer.auth.getAccessToken(),'original-token');assert.equal(peer.controller.getSnapshot().workspace,workspace);
    assert.equal(nextSignal?.aborted,false,'A former owner must not abort the replacement account request');
    assert.equal(await peer.privacy.scopedSecrets(nextScope).get('replacement-provider','key'),'replacement preserved');
    await assert.rejects(peer.privacy.retryExportCleanup(),{code:'FAILED'});assert.equal(acks,0);
    failed=false;await peer.privacy.retryExportCleanup();assert.equal(temporary,false);assert.equal(peer.privacy.hasFailedExportCleanup(),false);
    ca.publish(oldScope,requestId,owner);await ca.complete(oldScope,requestId,owner,async()=>{acks++;assert.equal(temporary,false);});
    assert.equal(acks,1);assert.deepEqual(peer.auth.getSubject(),replacement);assert.equal(peer.controller.getSnapshot().workspace,workspace);
    assert.equal(await peer.privacy.scopedSecrets(nextScope).get('replacement-provider','key'),'replacement preserved');
    releaseNextStatus(Response.json(active));assert.equal((await querying).accountId,nextId);
  }finally{releaseNextStatus(Response.json(active));failed=false;release.resolve();await peer.privacy.retryExportCleanup();await peer.close();ca.detach();cb.detach();}
});

test('the durable fence aborts in-flight model, Zotero and keyed radar requests after their secrets have already been read',async()=>{
  const locks=new LockHub(),storage=new StorageHub(),port=storage.port(),coordinator=new BrowserErasureCoordinator({...port,locks:locks.port('requests')});
  const scope={apiBaseUrl:config.apiBaseUrl,accountId:crypto.randomUUID()},secrets=new MemorySecretStore(),provider={...defaultAiProvider(),requiresKey:true};
  const zotero={kind:'user' as const,libraryId:'1',name:'Synthetic'},ref=crypto.randomUUID(),started=[deferred(),deferred(),deferred()],signals:AbortSignal[]=[];
  await secrets.set(await aiSecretNamespace(scope,provider),AI_SECRET_KEY,'synthetic-model-key');
  await secrets.set(zoteroSecretNamespace(scope,zotero),ZOTERO_SECRET_KEY,'a'.repeat(32));await secrets.set(radarSecretNamespace(scope),ref,'b'.repeat(32));
  const pending=(index:number,signal:AbortSignal)=>{signals[index]=signal;started[index].resolve();return new Promise<Response>(()=>{});};
  const model=new AiClient(secrets,{kind:'fetch',supportsStreaming:false,redirectPolicy:'error',request:input=>pending(0,input.signal)});
  const zoteroClient=new ZoteroClient({fetch:async(_input,init)=>pending(1,init!.signal!)});
  const radar=new RadarClient({fetch:async(_input,init)=>pending(2,init!.signal!)});
  const outcomes=Promise.allSettled([
    model.listModels({accountScope:scope,config:provider}),
    zoteroClient.download(zotero,{expectedCursor:null,credential:{mode:'stored',store:secrets,accountScope:scope}}),
    (async()=>{for await(const _ of radar.search({topic:{...radarTopic,sources:['openalex']},timestamp:radarTime,credential:{mode:'stored',store:secrets,scope,ref}})){} })(),
  ]);
  try{
    await Promise.all(started.map(value=>value.promise));coordinator.publish(scope,crypto.randomUUID(),{});
    const results=await outcomes;assert(signals.every(signal=>signal.aborted));
    assert.deepEqual(results.map(result=>result.status==='rejected'?result.reason.code:'fulfilled'),['CANCELLED','CHANGED','CHANGED']);
  }finally{secrets.disposeMemory();coordinator.detach();}
});
