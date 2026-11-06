import assert from 'node:assert/strict';
import test from 'node:test';
import {BrowserErasureCoordinator,accountScopeAvailable} from '../src/privacy/browserErasure.ts';
import type {AccountScope} from '../src/storage/accountStore.ts';

import {LockHub,StorageHub,deferred} from './browserErasureFixtures.ts';
const scope=(accountId=crypto.randomUUID()):AccountScope=>({apiBaseUrl:'https://sync.example.test',accountId});

test('shared leases block an ACK until every peer purges RAM, while another account and service remain independent',async()=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port();
  const a=new BrowserErasureCoordinator({...one,locks:locks.port('a')}),b=new BrowserErasureCoordinator({...two,locks:locks.port('b')});
  const own=scope(),foreign=scope(),otherService={...own,apiBaseUrl:'https://other.example.test'},ownerA={},ownerB={},foreignOwner={};
  const entered=deferred(),release=deferred(),erased=deferred();let peerKey='synthetic private key',peerBody='synthetic loaded paper',foreignClears=0,acks=0;
  await a.retain(own,ownerA,async()=>{throw Error('Initiator must retain only its erasure session until ACK');});
  await b.retain(own,ownerB,async()=>{entered.resolve();await release.promise;peerKey='';peerBody='';erased.resolve();});
  await b.retain(foreign,foreignOwner,async()=>{foreignClears++;});
  const requestId=crypto.randomUUID();a.publish(own,requestId,ownerA);await entered.promise;
  assert.equal(a.available(own),false);assert.equal(b.available(own),false);assert.equal(accountScopeAvailable(own),false);
  assert.equal(b.available(foreign),true);assert.equal(b.available(otherService),true);
  const completed=a.complete(own,requestId,ownerA,async()=>{assert.equal(peerKey,'');assert.equal(peerBody,'');acks++;});
  await Promise.resolve();assert.equal(acks,0);assert(locks.held.some(item=>item.client==='b'&&item.mode==='shared'));
  release.resolve();await erased.promise;await completed;assert.equal(acks,1);assert.equal(foreignClears,0);
  await b.forget(foreignOwner);a.detach();b.detach();
});

test('an unresponsive peer never loses its lease to a timer; a later explicit retry succeeds after it clears',async()=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port();
  const a=new BrowserErasureCoordinator({...one,locks:locks.port('a'),timeoutMs:20}),b=new BrowserErasureCoordinator({...two,locks:locks.port('b')});
  const own=scope(),ownerA={},ownerB={};let peerKey='retained key',acks=0;
  await a.retain(own,ownerA,async()=>undefined);await b.retain(own,ownerB,async()=>{peerKey='';});two.pause();
  const requestId=crypto.randomUUID();a.publish(own,requestId,ownerA);
  await assert.rejects(a.complete(own,requestId,ownerA,async()=>{acks++;}),{code:'BROWSER_ERASURE_PENDING'});
  assert.equal(acks,0);assert.equal(peerKey,'retained key');assert(locks.held.some(item=>item.client==='b'));
  two.resume();a.publish(own,requestId,ownerA);
  await a.complete(own,requestId,ownerA,async()=>{assert.equal(peerKey,'');acks++;});assert.equal(acks,1);
  a.detach();b.detach();
});

test('a failed peer purge prevents ACK and preserves the lease for an explicit retry',async()=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port();
  const a=new BrowserErasureCoordinator({...one,locks:locks.port('a'),timeoutMs:20}),b=new BrowserErasureCoordinator({...two,locks:locks.port('b')});
  const own=scope(),ownerA={},ownerB={};let fail=true,acks=0;
  await a.retain(own,ownerA,async()=>undefined);await b.retain(own,ownerB,async()=>{if(fail)throw Error('Synthetic RAM purge failed');});
  const requestId=crypto.randomUUID();a.publish(own,requestId,ownerA);
  await assert.rejects(a.complete(own,requestId,ownerA,async()=>{acks++;}),{code:'BROWSER_ERASURE_PENDING'});assert.equal(acks,0);
  fail=false;a.publish(own,requestId,ownerA);await a.complete(own,requestId,ownerA,async()=>{acks++;});assert.equal(acks,1);
  a.detach();b.detach();
});

test('new and queued owners cannot load private RAM after the durable fence, and corrupt storage cannot authorize an ACK',async()=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port();
  const a=new BrowserErasureCoordinator({...one,locks:locks.port('a')}),b=new BrowserErasureCoordinator({...two,locks:locks.port('b')});
  const own=scope(),owner={};let privateLoads=0,acks=0;
  const requestId=crypto.randomUUID();a.publish(own,requestId,owner);
  await assert.rejects(b.retain(own,{},async()=>{privateLoads++;}),{code:'ACCOUNT_CLOSED'});assert.equal(privateLoads,0);
  const queuedScope=scope(),queuedOwner={};await a.retain(queuedScope,owner,async()=>undefined);
  const address=locks.held.find(item=>item.client==='a')!.name;await a.forget(owner);
  const entered=deferred(),release=deferred();
  const exclusive=locks.port('third').request(address,{mode:'exclusive'},async()=>{entered.resolve();await release.promise;});await entered.promise;
  const queued=b.retain(queuedScope,queuedOwner,async()=>{privateLoads++;});
  const denied=assert.rejects(queued,{code:'ACCOUNT_CLOSED'});
  a.publish(queuedScope,crypto.randomUUID(),owner);release.resolve();await exclusive;await denied;assert.equal(privateLoads,0);
  await assert.rejects(a.complete(own,crypto.randomUUID(),owner,async()=>{acks++;}),{code:'STORAGE_CORRUPT'});
  const key=[...storage.values.keys()][0];storage.values.set(key,'broken');
  await assert.rejects(a.complete(own,requestId,owner,async()=>{acks++;}),{code:'STORAGE_CORRUPT'});assert.equal(acks,0);
  a.detach();b.detach();
});

test('concurrent erasure initiators retain their own minimal sessions and serialize ACK only after both have cleared RAM',async()=>{
  const locks=new LockHub(),storage=new StorageHub(),one=storage.port(),two=storage.port();
  const a=new BrowserErasureCoordinator({...one,locks:locks.port('a')}),b=new BrowserErasureCoordinator({...two,locks:locks.port('b')});
  const own=scope(),ownerA={},ownerB={},requestId=crypto.randomUUID();let pending=0,maximum=0,acks=0;
  const mustFinishOwn=async()=>{throw Error('An initiator cannot lose its own erasure-only session');};
  await a.retain(own,ownerA,mustFinishOwn);await b.retain(own,ownerB,mustFinishOwn);
  a.publish(own,requestId,ownerA);b.publish(own,requestId,ownerB);
  const acknowledge=async()=>{pending++;maximum=Math.max(maximum,pending);await Promise.resolve();acks++;pending--;};
  await Promise.all([a.complete(own,requestId,ownerA,acknowledge),b.complete(own,requestId,ownerB,acknowledge)]);
  assert.equal(acks,2);assert.equal(maximum,1);a.detach();b.detach();
});

test('another runtime in the same document is cleared before the initiating runtime may ACK',async()=>{
  const locks=new LockHub(),storage=new StorageHub(),port=storage.port();
  const coordinator=new BrowserErasureCoordinator({...port,locks:locks.port('a'),timeoutMs:20}),own=scope(),ownerA={},ownerB={};
  const entered=deferred(),release=deferred();let body='other runtime paper',acks=0;
  await coordinator.retain(own,ownerA,async()=>{throw Error('Do not discard the initiating session');});
  await coordinator.retain(own,ownerB,async()=>{entered.resolve();await release.promise;body='';});
  const requestId=crypto.randomUUID();coordinator.publish(own,requestId,ownerA);
  const first=coordinator.complete(own,requestId,ownerA,async()=>{acks++;});
  const stopped=assert.rejects(first,{code:'BROWSER_ERASURE_PENDING'});await entered.promise;await stopped;assert.equal(acks,0);
  release.resolve();coordinator.publish(own,requestId,ownerA);
  await coordinator.complete(own,requestId,ownerA,async()=>{assert.equal(body,'');acks++;});assert.equal(acks,1);coordinator.detach();
});

test('unsupported locks and a failed durable fence fail closed without clearing another owner',async()=>{
  const storage=new StorageHub(),port=storage.port();
  assert.throws(()=>new BrowserErasureCoordinator({...port,locks:{} as LockManager}),{code:'STORAGE_UNAVAILABLE'});
  const locks=new LockHub(),a=new BrowserErasureCoordinator({...port,locks:locks.port('a')}),own=scope(),owner={};let cleared=0;
  await a.retain(own,owner,async()=>{cleared++;});port.fail();
  assert.throws(()=>a.publish(own,crypto.randomUUID(),owner),{code:'STORAGE_FAILED'});assert.equal(cleared,0);assert.equal(a.available(own),true);
  await a.forget(owner);a.detach();
});
