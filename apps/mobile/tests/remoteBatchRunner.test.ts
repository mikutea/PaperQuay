import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteBatchRunner } from '../src/remote/batchRunner.ts';
import { RemoteTaskError } from '../src/remote/client.ts';
import { WorkspaceController } from '../src/sync/workspace.ts';
import type { RemoteTask, RemoteTaskRequestStatus } from '../../../packages/sync-core/src/remoteTasks.ts';
import { draft, fixture, job, quota, scope } from './fixtures/remoteBatch.ts';
type Client=ConstructorParameters<typeof RemoteBatchRunner>[0]['client'];
function rpc(overrides:Partial<Client>={}):Client{return{async create(){throw new Error('unexpected create');},async lookupRequest(id){return{requestId:id,status:'absent',task:null};},async cancelRequest(id){return{requestId:id,status:'cancelled',task:null};},...overrides};}
function gate<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
test('batch stops at first unknown result, persists before each RPC, survives restart and resumes using the exact original IDs',async t=>{
 const f=await fixture();t.after(()=>f.close());const b=f.batch;await f.controller.createRemoteBatch(b);let calls:string[]=[],lookups:string[]=[];let fail=true;
 const client=rpc({async create(request){assert.equal((await f.store.read(scope))!.remoteBatch!.items.find(i=>i.request.requestId===request.requestId)!.state,'uncertain');calls.push(request.requestId);if(calls.length===2&&fail)throw new RemoteTaskError('NETWORK');return{task:job(b,b.items.findIndex(i=>i.request.requestId===request.requestId)),quota,replayed:false,deduplicated:false};},async lookupRequest(id){lookups.push(id);return{requestId:id,status:'absent',task:null};}});
 const runner=new RemoteBatchRunner({workspace:f.controller,client,current:()=>true});t.after(()=>runner.dispose());assert.equal(calls.length,0);await runner.submit(b.id);
 assert.deepEqual(f.controller.getSnapshot().workspace!.remoteBatch!.items.map(i=>i.state),['submitted','uncertain','pending']);assert.equal(f.controller.getSnapshot().workspace!.remoteBatch!.items[1].failure,'NETWORK');
 runner.dispose();f.controller.deactivate();const controller=new WorkspaceController(f.options);await controller.bind('重开批次');t.after(()=>controller.deactivate());fail=false;
 const restarted=new RemoteBatchRunner({workspace:controller,client,current:()=>true});t.after(()=>restarted.dispose());assert.equal(calls.length,2);await restarted.submit(b.id);
 assert.deepEqual(calls,[b.items[0].request.requestId,b.items[1].request.requestId,b.items[1].request.requestId,b.items[2].request.requestId]);assert.deepEqual(lookups,[b.items[1].request.requestId]);
 assert.ok(controller.getSnapshot().workspace!.remoteBatch!.items.every(i=>i.state==='submitted'));
});
test('cancel interrupts an unknown create and reserves every pending ID so late delivery cannot create after cancel',async t=>{
 const f=await fixture();t.after(()=>f.close());const b=f.batch;await f.controller.createRemoteBatch(b);const started=gate<void>(),deliver=gate<void>(),reservations=new Set<string>(),cancelled:string[]=[],published:RemoteTask[]=[];
 const client=rpc({async create(request){started.resolve();await deliver.promise;if(reservations.has(request.requestId))throw new RemoteTaskError('REQUEST_CANCELLED');return{task:job(b),quota,replayed:false,deduplicated:false};},async cancelRequest(id){assert.equal((await f.store.read(scope))!.remoteBatch!.cancelRequested,true);reservations.add(id);cancelled.push(id);return{requestId:id,status:'cancelled',task:null};}});
 const runner=new RemoteBatchRunner({workspace:f.controller,client,current:()=>true,onTask:task=>published.push(task)});t.after(()=>runner.dispose());
 const sending=runner.submit(b.id);await started.promise;await runner.cancel(b.id);deliver.resolve();await sending;
 assert.deepEqual(cancelled,b.items.map(i=>i.request.requestId));assert.ok(f.controller.getSnapshot().workspace!.remoteBatch!.items.every(i=>i.state==='cancelled'&&i.cancelAcknowledged));assert.equal(published.length,0);
 await runner.submit(b.id);assert.equal(cancelled.length,3);assert.equal(reservations.size,3);
});
test('stopping only the local wait retains an uncertain request; explicit query finds late creation without a second POST',async t=>{
 const f=await fixture(draft(1));t.after(()=>f.close());const b=f.batch;await f.controller.createRemoteBatch(b);const started=gate<void>(),deliver=gate<void>();let posted=0,known=false;
 const client=rpc({async create(){posted++;started.resolve();await deliver.promise;known=true;return{task:job(b),quota,replayed:false,deduplicated:false};},async lookupRequest(id){return{requestId:id,status:known?'known':'absent',task:known?job(b):null} as RemoteTaskRequestStatus;}});
 const runner=new RemoteBatchRunner({workspace:f.controller,client,current:()=>true});t.after(()=>runner.dispose());const sending=runner.submit(b.id);await started.promise;runner.stopWaiting();deliver.resolve();await sending;
 assert.equal(f.controller.getSnapshot().workspace!.remoteBatch!.cancelRequested,false);assert.equal(f.controller.getSnapshot().workspace!.remoteBatch!.items[0].state,'uncertain');
 await runner.refresh(b.id);await runner.submit(b.id);assert.equal(posted,1);assert.equal(f.controller.getSnapshot().workspace!.remoteBatch!.items[0].state,'submitted');
});
test('partial cancellation remains durable and explicit retry only repeats unacknowledged cancellation IDs',async t=>{
 const f=await fixture();t.after(()=>f.close());const b=f.batch;await f.controller.createRemoteBatch(b);const calls:string[]=[];let offline=true;
 const runner=new RemoteBatchRunner({workspace:f.controller,current:()=>true,client:rpc({async cancelRequest(id){calls.push(id);if(id===b.items[1].request.requestId&&offline)throw new RemoteTaskError('NETWORK');return{requestId:id,status:'cancelled',task:null};}})});t.after(()=>runner.dispose());
 await runner.cancel(b.id);assert.equal(f.controller.getSnapshot().workspace!.remoteBatch!.cancelRequested,true);assert.deepEqual(f.controller.getSnapshot().workspace!.remoteBatch!.items.map(i=>i.cancelAcknowledged),[true,false,false]);
 await assert.rejects(f.controller.clearRemoteBatch(b.id),{code:'REMOTE_REQUEST_PENDING'});offline=false;await runner.cancel(b.id);
 assert.deepEqual(calls,[b.items[0].request.requestId,b.items[1].request.requestId,b.items[1].request.requestId,b.items[2].request.requestId]);await f.controller.clearRemoteBatch(b.id);
});
test('lookup of an unknown request is non-creating and known task receipts do not automatically resume failed executions',async t=>{
 const f=await fixture(draft(2));t.after(()=>f.close());const b=f.batch;await f.controller.createRemoteBatch(b);for(const item of b.items)await f.controller.markRemoteBatchAttempt(b.id,item.request.requestId);let lookups=0,creates=0;
 const runner=new RemoteBatchRunner({workspace:f.controller,current:()=>true,client:rpc({async create(){creates++;throw new Error();},async lookupRequest(id){lookups++;return id===b.items[0].request.requestId?{requestId:id,status:'known',task:{...job(b),state:'failed',attempt:1,failure:'EXECUTION_FAILED'}}:{requestId:id,status:'absent',task:null};}})});t.after(()=>runner.dispose());
 await runner.refresh(b.id);assert.equal(creates,0);assert.equal(lookups,2);assert.deepEqual(f.controller.getSnapshot().workspace!.remoteBatch!.items.map(i=>i.state),['submitted','uncertain']);
});
test('late credentials/account results and changed source cannot publish or advance a batch',async t=>{
 for(const change of ['account','source','model'] as const)await t.test(change,async t=>{
  const f=await fixture(draft(1));t.after(()=>f.close());const b=f.batch;await f.controller.createRemoteBatch(b);const started=gate<void>(),deliver=gate<void>();let current=true,posted=0,published=0;
  if(change==='source'){await f.controller.markRemoteBatchAttempt(b.id,b.items[0].request.requestId);await f.controller.save({entityType:'attachmentVersion',entityId:b.items[0].request.versionId,mutation:'delete',data:null},1);}
  const runner=new RemoteBatchRunner({workspace:f.controller,current:()=>current,onTask:()=>published++,client:rpc({async create(){posted++;started.resolve();await deliver.promise;return{task:change==='model'?{...job(b),profile:{...b.profile,model:'unreviewed'}}:job(b),quota,replayed:false,deduplicated:false};}})});t.after(()=>runner.dispose());
  const sending=runner.submit(b.id);if(change!=='source'){await started.promise;if(change==='account'){current=false;f.controller.deactivate();}deliver.resolve();}await sending;
  assert.equal(published,0);assert.equal(posted,change==='source'?0:1);assert.equal((await f.store.read(scope))!.remoteBatch!.items[0].state,'uncertain');
 });
});
