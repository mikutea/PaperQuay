import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import {AccountStore,type AccountScope} from '../src/storage/accountStore.ts';
import {MemorySecretStore} from '../src/platform/secretStore.ts';
import {AccountSecretStore} from '../src/privacy/secretRegistry.ts';
import {eraseLocalAccount,type ErasureDependencies} from '../src/privacy/lifecycle.ts';
import type {AccountPrivacyStatus} from '../src/privacy/client.ts';
import type {StoredWorkspace} from '../src/sync/workspace.ts';
import type {AccountIdentity} from '../src/api.ts';
import {NativeSecretStore,NATIVE_SECRET_INVENTORY} from '../src/platform/nativeSecrets.ts';
import {createHash} from 'node:crypto';

const scope={apiBaseUrl:'https://sync.example.test',accountId:'11111111-1111-4111-8111-111111111111'};
const other={...scope,accountId:'22222222-2222-4222-8222-222222222222'};
const device='33333333-3333-4333-8333-333333333333';
const closed:AccountPrivacyStatus={accountId:scope.accountId,state:'closed',closedAt:'2026-11-06T00:00:00.000Z',
  closureRequestId:'44444444-4444-4444-8444-444444444444',deviceErasure:{requested:true,pending:1,acknowledged:0,thisDevicePending:true}};
const identity:AccountIdentity={accountId:scope.accountId,device:{id:device,name:'Synthetic browser',platform:'web',createdAt:closed.closedAt!,lastSeenAt:closed.closedAt!,revokedAt:null}};
const workspace=(accountId:string)=>({sync:{accountId,outbox:[{title:'private unsynced sentinel'}]}} as unknown as StoredWorkspace);
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

test('a credential write already in flight is erased, while later writes and foreign credentials stay isolated',async()=>{
  const entered=deferred(),release=deferred();
  class SlowStore extends MemorySecretStore {
    override async set(namespace:string,key:string,value:string){if(namespace==='own-provider'){entered.resolve();await release.promise;}await super.set(namespace,key,value);}
  }
  const base=new SlowStore(),a=new AccountSecretStore(base,scope,()=>true),b=new AccountSecretStore(base,other,()=>true);
  await b.set('other-provider','api-key','foreign-secret');await base.set('oidc-original','token','session-secret');
  const writing=a.set('own-provider','api-key','late-secret');const rejected=assert.rejects(writing,{code:'CHANGED'});
  await entered.promise;const erasing=a.erase();release.resolve();await rejected;await erasing;
  assert.equal(await base.get('own-provider','api-key'),null);
  assert.equal(await b.get('other-provider','api-key'),'foreign-secret');assert.equal(await base.get('oidc-original','token'),'session-secret');
  await assert.rejects(a.set('late-provider','api-key','must-not-persist'),{code:'CHANGED'});
  assert.equal(await base.get('late-provider','api-key'),null);
});

test('registry failures prevent a secret write and partial erasure can be explicitly retried',async()=>{
  class FaultStore extends MemorySecretStore {
    failIndex=true;failRemove=false;
    override async set(namespace:string,key:string,value:string){if(this.failIndex&&key==='addresses')throw Error('synthetic storage failure');await super.set(namespace,key,value);}
    override async remove(namespace:string,key:string){if(this.failRemove&&namespace==='own')throw Error('synthetic removal failure');await super.remove(namespace,key);}
  }
  const base=new FaultStore(),a=new AccountSecretStore(base,scope,()=>true);
  await assert.rejects(a.set('own','api-key','private'));assert.equal(await base.get('own','api-key'),null);
  base.failIndex=false;await a.set('own','api-key','private');base.failRemove=true;await assert.rejects(a.erase());
  assert.equal(await base.get('own','api-key'),'private');base.failRemove=false;
  await a.register([['own','api-key']]);await a.erase();assert.equal(await base.get('own','api-key'),null);
});

async function fixture() {
  const store=new AccountStore<StoredWorkspace>({indexedDB:new IDBFactory(),databaseName:crypto.randomUUID(),decode:value=>value as StoredWorkspace});
  await store.update(scope,()=>workspace(scope.accountId));await store.update(other,()=>workspace(other.accountId));
  const state={binding:identity as AccountIdentity|null,acks:0,sessions:0,stops:0,fail:'',current:true};
  const clear=async(name:string,_scope:AccountScope)=>{assert.equal(_scope.accountId,scope.accountId);if(state.fail===name)throw Error('synthetic '+name);};
  const dependencies:ErasureDependencies={store,binding:{read:async()=>state.binding,remove:async()=>{state.binding=null;}},
    fence:async()=>undefined,complete:async(_scope,_request,finish)=>finish(),
    stop:()=>{state.stops++;},clearIncoming:s=>clear('incoming',s),clearSecrets:s=>clear('secrets',s),clearPdf:s=>clear('pdf',s),clearParsed:s=>clear('parsed',s),
    clearAi:s=>clear('ai',s),clearExports:s=>clear('exports',s),
    acknowledge:async id=>{assert.equal(id,device);if(state.fail==='ack')throw Error('synthetic lost ACK');state.acks++;},
    clearSession:async afterPersisted=>{if(state.fail==='session')throw Error('synthetic credential removal failure');
      await afterPersisted('synthetic original token');state.sessions++;state.current=false;}};
  return {store,state,dependencies,erase:()=>eraseLocalAccount(scope.apiBaseUrl,closed,()=>state.current,dependencies)};
}

test('a foreign or missing stored binding never clears a scope selected only by server status',async()=>{
  const f=await fixture();try{
    for(const binding of[null,{...identity,accountId:other.accountId}]){
      f.state.binding=binding;await assert.rejects(f.erase(),{code:'INVALID'});
      assert.equal(f.state.stops,0);assert.equal(f.state.acks,0);assert(await f.store.read(scope));assert(await f.store.read(other));
    }
  }finally{await f.store.close();}
});

test('every failed local payload cleanup keeps erasure pending and preserves the original authenticated binding',async()=>{
  for(const failure of['incoming','secrets','pdf','parsed','ai','exports']){
    const f=await fixture();try{f.state.fail=failure;await assert.rejects(f.erase());
      assert.equal(f.state.acks,0);assert.equal(f.state.sessions,0);assert.equal(f.state.binding?.device.id,device);
      assert(await f.store.read(scope));assert(await f.store.read(other));
    }finally{await f.store.close();}
  }
});

test('a lost ACK can be retried after payload deletion without touching another account',async()=>{
  const f=await fixture();try{f.state.fail='ack';await assert.rejects(f.erase());
    assert.equal(await f.store.read(scope),null);assert(await f.store.read(other));assert.equal(f.state.binding?.device.id,device);assert.equal(f.state.sessions,0);
    f.state.fail='';await f.erase();assert.equal(f.state.acks,1);assert.equal(f.state.binding,null);assert.equal(f.state.sessions,1);
    assert(await f.store.read(other));
  }finally{await f.store.close();}
});

test('failed persisted session removal keeps the verified binding and sends no ACK until an explicit successful retry',async()=>{
  const f=await fixture();try{
    f.state.fail='session';await assert.rejects(f.erase());assert.equal(f.state.acks,0);assert.equal(f.state.sessions,0);
    assert.equal(f.state.binding?.device.id,device);assert.equal(await f.store.read(scope),null);assert(await f.store.read(other));
    f.state.fail='';await f.erase();assert.equal(f.state.acks,1);assert.equal(f.state.sessions,1);assert.equal(f.state.binding,null);
  }finally{await f.store.close();}
});

test('an owner transition during binding lookup prevents all cleanup, and a new SID cannot automatically acknowledge',async()=>{
  const f=await fixture();try{
    f.dependencies.binding.read=async()=>{f.state.current=false;return identity;};
    await assert.rejects(f.erase(),{code:'CHANGED'});assert.equal(f.state.stops,0);assert(await f.store.read(scope));
    f.state.current=true;
    await assert.rejects(eraseLocalAccount(scope.apiBaseUrl,{...closed,deviceErasure:{...closed.deviceErasure,thisDevicePending:false}},()=>true,f.dependencies),{code:'INVALID'});
    assert.equal(f.state.acks,0);
  }finally{await f.store.close();}
});

test('explicit local cleanup without a pending device ACK does not request token renewal and can finalize offline',async()=>{
  const f=await fixture();try{
    let finalized=0;
    f.dependencies.clearSession=async(afterPersisted,renew)=>{assert.equal(renew,false);await afterPersisted(null);finalized++;};
    await eraseLocalAccount(scope.apiBaseUrl,{...closed,deviceErasure:{requested:false,thisDevicePending:false,pending:0,acknowledged:0}},
      ()=>true,f.dependencies,{explicitLocalConsent:true});
    assert.equal(finalized,1);assert.equal(f.state.acks,0);assert.equal(f.state.binding,null);
    assert.equal(await f.store.read(scope),null);assert(await f.store.read(other));
  }finally{await f.store.close();}
});

function nativeFixture() {
  const entries=new Map<string,unknown>();let failInventory=false;
  const bridge={get:async(key:string)=>entries.get(key) as string??null,
    set:async(key:string,value:unknown)=>{if(failInventory&&key===NATIVE_SECRET_INVENTORY)throw Error('synthetic index failure');entries.set(key,value);},
    remove:async(key:string)=>entries.delete(key),keys:async()=>[...entries.keys()]};
  return {entries,open:()=>new NativeSecretStore(bridge),fail:()=>{failInventory=true;}};
}

test('unindexed legacy endpoint credentials block erasure ACK and can only be removed after recovering their exact owner address',async()=>{
  const f=await fixture(),native=nativeFixture(),base=native.open(),registry=new AccountSecretStore(base,scope,()=>true);
  const oldNamespace='paperquay.ai.v1.'+'a'.repeat(64),oldAddress=createHash('sha256').update(JSON.stringify([oldNamespace,'api-key'])).digest('hex');
  native.entries.set(oldAddress,'synthetic former endpoint key');
  const foreign=new AccountSecretStore(base,other,()=>true);await foreign.set('foreign provider','api-key','foreign secret');
  await registry.set('current provider','api-key','current secret');
  f.dependencies.clearSecrets=async()=>registry.erase();
  try{
    await assert.rejects(f.erase(),{code:'LEGACY_SECRETS_UNVERIFIED'});
    assert.equal(f.state.acks,0);assert.equal(f.state.sessions,0);assert(f.state.binding);assert(await f.store.read(scope));
    assert.equal(native.entries.get(oldAddress),'synthetic former endpoint key');assert.equal(await foreign.get('foreign provider','api-key'),'foreign secret');
    // A known former endpoint can be explicitly attributed. Never guess an
    // unknown hash's owner, clear all system keys, or ACK an incomplete wipe.
    await registry.register([[oldNamespace,'api-key']]);await f.erase();
    assert.equal(native.entries.has(oldAddress),false);assert.equal(f.state.acks,1);assert.equal(await f.store.read(scope),null);
    assert.equal(await foreign.get('foreign provider','api-key'),'foreign secret');
  }finally{await f.store.close();}
});

test('account provider history survives a native restart and erases former and current endpoints without touching another account',async()=>{
  const native=nativeFixture(),first=native.open(),old=new AccountSecretStore(first,scope,()=>true),foreign=new AccountSecretStore(first,other,()=>true);
  await old.set('previous endpoint','api-key','old key');await old.set('replacement endpoint','api-key','new key');
  await foreign.set('foreign endpoint','api-key','foreign key');
  const reopened=native.open(),registry=new AccountSecretStore(reopened,scope,()=>true);await registry.erase();await reopened.verifyErasureInventory();
  assert.equal(await reopened.get('previous endpoint','api-key'),null);assert.equal(await reopened.get('replacement endpoint','api-key'),null);
  assert.equal(await reopened.get('foreign endpoint','api-key'),'foreign key');
});

test('native inventory failure prevents a new credential write instead of creating another unindexed key',async()=>{
  const native=nativeFixture(),store=native.open();native.fail();
  await assert.rejects(store.set('provider','api-key','must-not-write'),{code:'STORAGE_FAILED'});
  assert.equal([...native.entries.values()].includes('must-not-write'),false);
});
