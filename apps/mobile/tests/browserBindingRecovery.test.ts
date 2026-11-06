import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import type {AccountIdentity} from '../src/api.ts';
import {parseAppConfig} from '../src/config.ts';
import {ClientError} from '../src/errors.ts';
import {MemorySecretStore,type SecretStore} from '../src/platform/secretStore.ts';
import {createVerifiedBinding} from '../src/storage/verifiedBinding.ts';
import {WebBindingStorage} from '../src/storage/verifiedBindingStorage.ts';
import {AccountStore} from '../src/storage/accountStore.ts';
import {WorkspaceController,decodeWorkspace} from '../src/sync/workspace.ts';
import {eraseLocalAccount} from '../src/privacy/lifecycle.ts';
import type {AccountPrivacyStatus} from '../src/privacy/client.ts';

const config=parseAppConfig({apiBaseUrl:'https://sync.example.test',oidcAuthority:'https://id.example.test/realms/paperquay',oidcClientId:'mobile'},'https://app.example.test');
const accountId='11111111-1111-4111-8111-111111111111',deviceId='22222222-2222-4222-8222-222222222222',now='2026-11-06T00:00:00.000Z';
const identity:AccountIdentity={accountId,device:{id:deviceId,name:'Synthetic browser',platform:'web',createdAt:now,lastSeenAt:now,revokedAt:null}};
const closed:AccountPrivacyStatus={accountId,state:'closed',closedAt:now,closureRequestId:'33333333-3333-4333-8333-333333333333',
  deviceErasure:{requested:true,pending:1,acknowledged:0,thisDevicePending:false}};
const scope={apiBaseUrl:config.apiBaseUrl,accountId};

test('browser closure then reload retains the verified owner without credentials and permits explicit erasure after registration rejects',async()=>{
  const indexedDB=new IDBFactory(),databaseName=crypto.randomUUID(),workspaceName=crypto.randomUUID();
  let subject='owner-a',registrationClosed=false,registrations=0;
  const getSubject=()=>({issuer:config.oidcAuthority,subject}),firstSecrets=new MemorySecretStore();
  await firstSecrets.set('oidc','access','synthetic-access-token');
  const firstBinding=createVerifiedBinding(config,firstSecrets,getSubject,{indexedDB,databaseName});
  const api={register:async()=>{registrations++;if(registrationClosed)throw new ClientError('ACCOUNT_CLOSED');return identity;},
    push:async()=>{throw Error('No automatic network');},pull:async()=>{throw Error('No automatic network');},devices:async()=>[],
    conflicts:async()=>({conflicts:[],nextCursor:'',hasMore:false}),resolveConflict:async()=>{throw Error('No conflict');},revokeDevice:async()=>{}};
  const firstStore=new AccountStore({decode:decodeWorkspace,indexedDB,databaseName:workspaceName});
  const first=new WorkspaceController({api,apiBaseUrl:config.apiBaseUrl,store:firstStore,binding:firstBinding});
  await first.bind('Synthetic browser');first.setOnline(false);
  await first.save({entityType:'note',entityId:'44444444-4444-4444-8444-444444444444',mutation:'put',
    data:{title:'Unsynced',body:'synthetic private payload',format:'markdown',paperId:null}},0);
  assert.equal((await firstStore.read(scope))!.sync.outbox.length,1);
  first.deactivate();await firstStore.close();await firstBinding.close();
  registrationClosed=true;
  const reloadedSecrets=new MemorySecretStore();assert.equal(await reloadedSecrets.get('oidc','access'),null);
  const binding=createVerifiedBinding(config,reloadedSecrets,getSubject,{indexedDB,databaseName});
  const store=new AccountStore({decode:decodeWorkspace,indexedDB,databaseName:workspaceName});
  const controller=new WorkspaceController({api,apiBaseUrl:config.apiBaseUrl,store,binding});
  try{
    subject='owner-b';assert.equal(await binding.read(),null);subject='owner-a';await controller.bind('New login');
    assert.equal(controller.getSnapshot().error?.code,'ACCOUNT_CLOSED');assert.equal(registrations,2);
    assert.deepEqual(await binding.read(),identity);assert.equal((await store.read(scope))!.sync.outbox.length,1);
    let cleared=0,finalized=0;const clear=async()=>{cleared++;};
    await eraseLocalAccount(config.apiBaseUrl,closed,()=>true,{binding,store,stop:()=>controller.deactivate(),
      fence:async()=>undefined,complete:async(_scope,_request,finish)=>finish(),
      clearIncoming:clear,clearSecrets:clear,clearPdf:clear,clearParsed:clear,clearAi:clear,clearExports:clear,
      acknowledge:async()=>{throw Error('Replacement login must never ACK the original session');},
      clearSession:async(afterPersisted,renew)=>{assert.equal(renew,false);await afterPersisted(null);finalized++;}},
      {explicitLocalConsent:true});
    assert.equal(cleared,6);assert.equal(finalized,1);assert.equal(await store.read(scope),null);assert.equal(await binding.read(),null);
  }finally{controller.deactivate();await store.close();await binding.close();}
  const reopened=createVerifiedBinding(config,new MemorySecretStore(),getSubject,{indexedDB,databaseName});
  try{assert.equal(await reopened.read(),null);}finally{await reopened.close();}
});

test('durable browser binding isolates service, issuer, client and subject and persists only parsed identity fields',async()=>{
  const indexedDB=new IDBFactory(),databaseName=crypto.randomUUID(),subject=()=>({issuer:config.oidcAuthority,subject:'a'});
  const binding=createVerifiedBinding(config,new MemorySecretStore(),subject,{indexedDB,databaseName});
  try{
    await binding.write({...identity,access_token:'must-not-persist'} as AccountIdentity);
    for(const variant of[{...config,apiBaseUrl:'https://other.example.test'},{...config,oidcClientId:'other'},
      {...config,oidcAuthority:'https://other-id.example.test'}]){
      const other=createVerifiedBinding(variant,new MemorySecretStore(),()=>({...subject(),issuer:variant.oidcAuthority}),{indexedDB,databaseName});
      try{assert.equal(await other.read(),null);}finally{await other.close();}
    }
    assert.deepEqual(await binding.read(),identity);
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(databaseName);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const values=await new Promise<unknown[]>((resolve,reject)=>{const tx=db.transaction('bindings'),request=tx.objectStore('bindings').getAll();tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error);});
    assert.equal(JSON.stringify(values).includes('must-not-persist'),false);db.close();
  }finally{await binding.close();}
});

test('native binding keeps system storage while unavailable browser storage fails closed',async()=>{
  const memory=new MemorySecretStore(),secrets:SecretStore={persistence:'system',get:memory.get.bind(memory),set:memory.set.bind(memory),remove:memory.remove.bind(memory)};
  const binding=createVerifiedBinding(config,secrets,()=>({issuer:config.oidcAuthority,subject:'a'}),{
    indexedDB:{open:()=>{throw Error('Native must not use IndexedDB');}} as unknown as IDBFactory});
  await binding.write(identity);assert.deepEqual(await binding.read(),identity);await binding.close();
  const unavailable=new WebBindingStorage({indexedDB:{open:()=>{throw Error('Storage unavailable');}} as unknown as IDBFactory});
  await assert.rejects(unavailable.get('paperquay-verified-account:'+'a'.repeat(64),'identity'),{code:'STORAGE_UNAVAILABLE'});
  await assert.rejects(unavailable.set('oidc','access-token','never durable'),{code:'STORAGE_FAILED'});
});
