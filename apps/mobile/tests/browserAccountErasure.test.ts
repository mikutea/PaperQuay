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
import type {AuthSession,AuthSubject,ClearLocalSessionOptions} from '../src/auth/oidc.ts';
import type {AccountIdentity} from '../src/api.ts';
import type {AccountPrivacyStatus} from '../src/privacy/client.ts';
import {AiClient} from '../src/ai/client.ts';
import {LocalAiConfigStore,defaultAiProvider,aiSecretNamespace,AI_SECRET_KEY} from '../src/ai/provider.ts';
import {ZoteroClient,zoteroSecretNamespace,ZOTERO_SECRET_KEY} from '../src/library/zoteroClient.ts';
import {RadarClient,radarSecretNamespace} from '../src/radar/client.ts';
import {config as radarTopic,at as radarTime} from './radarFixtures.ts';
import {authSubject} from '../src/auth/subject.ts';

const config=parseAppConfig({apiBaseUrl:'https://sync.example.test',oidcAuthority:'https://id.example.test/realms/paperquay',oidcClientId:'mobile'},'https://app.example.test');
const now='2026-11-06T00:00:00.000Z',factory=new IDBFactory();
const identity=(accountId:string,deviceId:string):AccountIdentity=>({accountId,device:{id:deviceId,name:'Synthetic browser',platform:'web',createdAt:now,lastSeenAt:now,revokedAt:null}});
function context(coordinator:BrowserErasureCoordinator,databaseName:string,bindingName:string,accountId:string,deviceId:string,token:string){
  const who=(id:string)=>authSubject({iss:config.oidcAuthority,sub:id,sid:token},config.oidcAuthority);
  let subject:AuthSubject|null=who(accountId),account=identity(accountId,deviceId),blocked=false;
  const listeners=new Set<()=>void>(),secrets=new MemorySecretStore();
  const auth={getSubject:()=>subject,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},
    getAccessToken:async()=>{if(blocked||!subject)throw new ClientError('AUTH_REQUIRED');return token;},
    clearLocalSession:async(options?:ClearLocalSessionOptions)=>{blocked=true;await options?.afterPersisted?.(token);subject=null;listeners.forEach(fn=>fn());},
    dispose:async()=>{subject=null;listeners.forEach(fn=>fn());}} as unknown as AuthSession;
  const binding=createVerifiedBinding(config,secrets,auth.getSubject,{indexedDB:factory,databaseName:bindingName});
  const store=new AccountStore({indexedDB:factory,databaseName,decode:decodeWorkspace});
  let controller!:WorkspaceController;
  const lease=browserAccountContext({apiBaseUrl:config.apiBaseUrl,auth,secrets,binding,coordinator,stop:()=>controller.deactivate()});
  const api={register:async()=>account,push:async()=>{throw Error('No automatic network');},pull:async()=>{throw Error('No automatic network');},
    conflicts:async()=>({conflicts:[],nextCursor:'',hasMore:false}),devices:async()=>[],revokeDevice:async()=>{},resolveConflict:async()=>{throw Error('No conflicts');}};
  controller=new WorkspaceController({api,apiBaseUrl:config.apiBaseUrl,store,binding:{...binding,guard:lease.guard,activate:lease.activate}});
  const privacy=createPrivacyRuntime(config,auth,store,secrets,controller,binding,lease.privacyOptions);
  return {auth,secrets,binding,store,controller,privacy,lease,api,
    async bind(){controller.setOnline(true);await controller.bind('Synthetic browser');assert.equal(controller.getSnapshot().status,'ready',controller.getSnapshot().error?.code);controller.setOnline(false);},
    changeOwner(id:string){subject=who(id);account=identity(id,crypto.randomUUID());blocked=false;listeners.forEach(fn=>fn());},
    async close(){controller.deactivate();privacy.dispose();await auth.dispose();await store.close();await binding.close();await lease.disposeAfterResources();}};
}

test('distinct browser SIDs keep their own verified device and wait for peer RAM erasure before ACK',async t=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port();
  const previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({indexedDB:factory,localStorage:one.storage})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});}
  t.after(()=>{for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const ca=new BrowserErasureCoordinator({...one,locks:locks.port('a'),timeoutMs:20}),cb=new BrowserErasureCoordinator({...two,locks:locks.port('b')});
  const accountId=crypto.randomUUID(),deviceId=crypto.randomUUID(),foreignId=crypto.randomUUID(),scope={apiBaseUrl:config.apiBaseUrl,accountId},foreign={...scope,accountId:foreignId};
  const database=crypto.randomUUID(),bindings=crypto.randomUUID(),main=context(ca,database,bindings,accountId,deviceId,'main-original-token'),peer=context(cb,database,bindings,foreignId,crypto.randomUUID(),'peer-original-token');
  let requests=0,acks=0;const provider={...defaultAiProvider(),requiresKey:true},aiNamespace=await aiSecretNamespace(scope,provider);
  const zoteroNamespace=zoteroSecretNamespace(scope,{kind:'user',libraryId:'1',name:'Synthetic'}),radarNamespace=radarSecretNamespace(scope),radarRef=crypto.randomUUID();
  const closed:AccountPrivacyStatus={accountId,state:'closed',closedAt:now,closureRequestId:crypto.randomUUID(),deviceErasure:{requested:true,pending:1,acknowledged:0,thisDevicePending:true}};
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(String(input),config.apiBaseUrl+'/v1/privacy/erasure-ack');assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer main-original-token');
    assert.deepEqual(JSON.parse(String(init?.body)),{deviceId});
    assert.equal(peer.controller.getSnapshot().workspace,null);assert.equal(peer.auth.getSubject(),null);
    assert.equal(await peer.secrets.get(aiNamespace,AI_SECRET_KEY),null);assert.equal(await peer.secrets.get(zoteroNamespace,ZOTERO_SECRET_KEY),null);
    assert.equal(await peer.secrets.get(radarNamespace,radarRef),null);acks++;return Response.json({acknowledged:true});
  });
  try{
    await peer.bind();await peer.privacy.scopedSecrets(foreign).set('foreign-provider','api-key','foreign preserved key');
    await main.bind();
    const peerDevice=crypto.randomUUID();peer.changeOwner(accountId);peer.api.register=async()=>identity(accountId,peerDevice);await peer.bind();
    assert.equal((await main.binding.read())!.device.id,deviceId);assert.equal((await peer.binding.read())!.device.id,peerDevice);
    await peer.controller.save({entityType:'note',entityId:crypto.randomUUID(),mutation:'put',data:{title:'Private note',body:'synthetic loaded paper context',format:'markdown',paperId:null}},0);
    const scoped=peer.privacy.scopedSecrets(scope);
    await scoped.set(aiNamespace,AI_SECRET_KEY,'synthetic-model-key');await scoped.set(zoteroNamespace,ZOTERO_SECRET_KEY,'a'.repeat(32));await scoped.set(radarNamespace,radarRef,'b'.repeat(32));
    const configs=new LocalAiConfigStore(two.storage);configs.save(scope,provider);configs.save(foreign,provider);
    assert(peer.controller.getSnapshot().workspace);two.pause();
    await assert.rejects(main.privacy.erase(closed),{code:'BROWSER_ERASURE_PENDING'});assert.equal(acks,0);
    assert(peer.controller.getSnapshot().workspace);assert.equal(await peer.secrets.get(aiNamespace,AI_SECRET_KEY),'synthetic-model-key');
    await assert.rejects(scoped.get(aiNamespace,AI_SECRET_KEY),{code:'CHANGED'});
    assert.throws(()=>configs.save(scope,provider),{code:'CANCELLED'});
    const model=new AiClient(scoped,{kind:'fetch',supportsStreaming:false,redirectPolicy:'error',request:async()=>{requests++;return Response.json({data:[]});}});
    await assert.rejects(model.listModels({accountScope:scope,config:provider}),{code:'CANCELLED'});assert.equal(requests,0);
    await assert.rejects(peer.controller.save({entityType:'note',entityId:crypto.randomUUID(),mutation:'put',data:{title:'Late',body:'must not persist',format:'markdown',paperId:null}},0),{code:'ACCOUNT_CHANGED'});
    two.resume();await main.privacy.erase(closed,true);assert.equal(acks,1);assert.equal(requests,0);
    assert.equal(await peer.secrets.get('foreign-provider','api-key'),'foreign preserved key');assert.equal(configs.load(foreign).endpoint,provider.endpoint);
    assert.equal(await main.store.read(scope),null);assert.equal(main.auth.getSubject(),null);assert.equal(main.privacy.recoveryStatus(),null);
  }finally{await main.close();await peer.close();ca.detach();cb.detach();}
});

test('Web runtime disposal destroys its own secret map and cannot invalidate a replacement runtime',async()=>{
  const a=await createSecretStore(),b=await createSecretStore();assert.notEqual(a,b);
  await a.set('owner','key','old runtime key');await b.set('owner','key','replacement runtime key');a.disposeMemory!();
  await assert.rejects(a.get('owner','key'),{code:'STORAGE_UNAVAILABLE'});await assert.rejects(a.set('owner','key','late'),{code:'STORAGE_UNAVAILABLE'});
  assert.equal(await b.get('owner','key'),'replacement runtime key');b.disposeMemory!();
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
