import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {buildApp} from '../../src/app.ts';
import type {AccountPrivacyRepository} from '../../src/account-privacy.ts';
import type {SyncRepository} from '../../src/types.ts';
import {identity,testConfig} from '../fixtures.ts';

test('real HTTP exports reserve bounded account/process slots and release after disconnect without blocking readiness',async()=>{
  const owners=['a','b','c'].map(()=>({...identity(),accountId:randomUUID()}));
  const completed=new Map<string,Promise<void>>(),finish=new Map<string,()=>void>();
  const repository:AccountPrivacyRepository={
    status:async who=>({accountId:owners.find(owner=>owner.subject===who.subject)!.accountId,state:'active',closedAt:null,
      closureRequestId:null,deviceErasure:{requested:false,pending:0,acknowledged:0,thisDevicePending:false}}),
    close:async()=>{throw new Error('Unexpected mutation');},
    acknowledgeErasure:async()=>{throw new Error('Unexpected mutation');},
    async *exportData(who,signal){
      completed.set(who.subject,new Promise(done=>finish.set(who.subject,done)));
      try {
        yield Buffer.from('{"kind":"synthetic-held-stream"}\n');
        await new Promise<void>(done=>{if(signal.aborted)done();else signal.addEventListener('abort',()=>done(),{once:true});});
      } finally {finish.get(who.subject)?.();}
    },
  };
  const app=await buildApp({config:testConfig(),repository:{ready:async()=>true} as SyncRepository,
    accountPrivacyRepository:repository,verifyToken:async authorization=>owners[Number(authorization?.slice(-1))]});
  const base=await app.listen({host:'127.0.0.1',port:0});
  const open=(index:number)=>fetch(base+'/v1/privacy/export',{headers:{Authorization:'Bearer '+index},signal:AbortSignal.timeout(10000)});
  const held:Response[]=[];
  try {
    held.push(await open(0),await open(1));assert(held.every(response=>response.status===200));
    for(const index of[0,2]){const rejected=await open(index);assert.equal(rejected.status,409);assert.equal((await rejected.json()).error.code,'EXPORT_BUSY');}
    const ready=await fetch(base+'/health/ready');assert.equal(ready.status,200);await ready.arrayBuffer();
    await held[0].body!.cancel();await completed.get(owners[0].subject);
    await new Promise(done=>setImmediate(done));
    const next=await open(0);held.push(next);assert.equal(next.status,200);
  } finally {
    await Promise.allSettled(held.map(response=>response.body?.cancel()));await app.close();
  }
});
