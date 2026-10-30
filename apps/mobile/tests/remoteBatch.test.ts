import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { entityKey, queueLocalEdit, rebindDevice, resumeAfterRestart } from '../../../packages/sync-core/src/index.ts';
import { validateRemoteBatch, validateRemoteBatchDraft, canClearRemoteBatch, remoteBatchReceipt } from '../src/remote/batch.ts';
import { decodeWorkspace, WorkspaceController } from '../src/sync/workspace.ts';
import { draft, fixture, job, scope, at } from './fixtures/remoteBatch.ts';
test('batch ledger accepts detached parse/index drafts and rejects authority, unsafe labels, holes and inconsistent receipts',()=>{
 for(const kind of ['parse','index'] as const){const b=draft(16,kind),copy=validateRemoteBatchDraft(b);assert.deepEqual(copy,b);b.items[0].label='changed';assert.notEqual(copy.items[0].label,b.items[0].label);}
 const b=draft();let getter=0;const accessor={...b};Object.defineProperty(accessor,'profile',{enumerable:true,get(){getter++;return b.profile;}});
 const variants=[{...b,endpoint:'https://private.invalid'},accessor,{...b,createdAt:'2026-02-30T00:00:00.000Z'},{...b,items:[]},{...b,items:Array(3)},draft(17),
 {...b,items:[b.items[0],b.items[0]]},{...b,items:[{...b.items[0],state:'submitted'}]}, {...b,items:[{...b.items[0],label:'bad\u0000label'}]},
 {...b,items:[{...b.items[0],request:{...b.items[0].request,profileRef:{...b.items[0].request.profileRef,digest:'f'.repeat(64)}}}]},
 {...b,items:[{...b.items[0],request:{...b.items[0].request,indexSourceDigest:'c'.repeat(64)}}]},
 {...b,items:[{...b.items[0],cancelAcknowledged:true}]},{...b,items:[{...b.items[0],state:'cancelled',cancelAcknowledged:false}]}];
 for(const value of variants)assert.throws(()=>validateRemoteBatch(value));assert.equal(getter,0);
 const indexed=draft(1,'index');delete indexed.items[0].request.indexSourceDigest;assert.throws(()=>validateRemoteBatchDraft(indexed));
});
test('batch receipts bind version bytes, exact profile/model, parse digest and request ID while allowing an explicit provider handover',()=>{
 const b=draft(1,'index'),task=job(b),status={requestId:b.items[0].request.requestId,status:'known',task};
 assert.equal(remoteBatchReceipt(b.items[0],{...status,task:{...task,providerDeviceId:randomUUID()}},b.profile).state,'submitted');
 for(const changed of [{...status,requestId:randomUUID()},{...status,status:'absent',task:null},{...status,task:{...task,target:{...task.target,sha256:'e'.repeat(64)}}},
 {...status,task:{...task,profile:{...task.profile,model:'changed-model'}}},{...status,task:{...task,indexSourceDigest:'e'.repeat(64)}}])assert.throws(()=>remoteBatchReceipt(b.items[0],changed,b.profile));
 assert.equal(canClearRemoteBatch(b),false);const submitted={...b,items:[remoteBatchReceipt(b.items[0],status,b.profile)]};assert.equal(canClearRemoteBatch(submitted),true);assert.equal(canClearRemoteBatch({...submitted,cancelRequested:true}),false);
});
test('actual IndexedDB ledger is atomic, survives restart, excludes single intents and does not enqueue sync records',async t=>{
 const f=await fixture();t.after(()=>f.close());const b=f.batch;
 await f.controller.createRemoteBatch(b);assert.equal((await f.store.read(scope))!.sync.outbox.length,0);
 await assert.rejects(f.controller.prepareRemoteTask(b.items[0].request),{code:'REMOTE_REQUEST_PENDING'});
 await assert.rejects(f.controller.createRemoteBatch(draft()),{code:'REMOTE_REQUEST_PENDING'});
 await f.controller.markRemoteBatchAttempt(b.id,b.items[0].request.requestId);await f.controller.recordRemoteBatchFailure(b.id,b.items[0].request.requestId,'TIMEOUT');
 f.controller.deactivate();const restarted=new WorkspaceController(f.options);t.after(()=>restarted.deactivate());await restarted.bind('重启');
 assert.equal(restarted.getSnapshot().workspace!.remoteBatch!.items[0].state,'uncertain');assert.equal(restarted.getSnapshot().workspace!.remoteBatch!.items[0].failure,'TIMEOUT');
 assert.deepEqual((await restarted.createRemoteBatch(b)).items[0].request,b.items[0].request);
 await assert.rejects(restarted.clearRemoteBatch(b.id),{code:'REMOTE_REQUEST_PENDING'});
 assert.throws(()=>decodeWorkspace({...restarted.getSnapshot().workspace!,remoteTaskIntent:{version:1,request:b.items[0].request}}),{code:'STORAGE_CORRUPT'});
 await restarted.stopRemoteBatch(b.id);await assert.rejects(restarted.markRemoteBatchAttempt(b.id,b.items[1].request.requestId),{code:'EDIT_CHANGED'});
 for(const item of b.items)await restarted.acknowledgeRemoteBatchRequest(b.id,{requestId:item.request.requestId,status:'cancelled',task:null},true);
 await restarted.clearRemoteBatch(b.id);assert.equal((await f.store.read(scope))!.remoteBatch,undefined);
 await restarted.prepareRemoteTask(b.items[0].request);await assert.rejects(restarted.createRemoteBatch(b),{code:'REMOTE_REQUEST_PENDING'});
});
test('batch target guards read transaction state and queued account/device/generation changes roll back without transport',async t=>{
 for(const change of ['delete','bytes','binding','device','generation','guard'] as const)await t.test(change,async t=>{
  const f=await fixture();t.after(()=>f.close());const b=f.batch;
  if(change==='delete'||change==='bytes')await f.store.update(scope,value=>({...value!,sync:queueLocalEdit(value!.sync,{entityType:'attachmentVersion',entityId:b.items[0].request.versionId,mutation:change==='delete'?'delete':'put',data:change==='delete'?null:{...value!.sync.serverRecords[entityKey('attachmentVersion',b.items[0].request.versionId)].data as any,sha256:'d'.repeat(64)}},{opId:randomUUID(),clientCreatedAt:at})}));
  if(change==='device'||change==='generation')await f.store.update(scope,value=>({...value!,sync:change==='device'?rebindDevice(value!.sync,randomUUID()):resumeAfterRestart(value!.sync)}));
  if(change==='binding')f.binding.key='changed';const before=await f.store.read(scope);
  await assert.rejects(f.controller.createRemoteBatch(b,()=>change!=='guard'),error=>['EDIT_CHANGED','ACCOUNT_CHANGED'].includes((error as any).code));
  assert.deepEqual(await f.store.read(scope),before);
 });
});
test('existing uncertain requests can be queried or cancelled after local source deletion, but absent retry rechecks source',async t=>{
 const f=await fixture(draft(1));t.after(()=>f.close());const b=f.batch,item=b.items[0];await f.controller.createRemoteBatch(b);await f.controller.markRemoteBatchAttempt(b.id,item.request.requestId);
 await f.controller.save({entityType:'attachmentVersion',entityId:item.request.versionId,mutation:'delete',data:null},1);
 await assert.rejects(f.controller.markRemoteBatchAttempt(b.id,item.request.requestId),{code:'EDIT_CHANGED'});
 await f.controller.acknowledgeRemoteBatchRequest(b.id,{requestId:item.request.requestId,status:'known',task:job(b)});
 await f.controller.stopRemoteBatch(b.id);await f.controller.acknowledgeRemoteBatchRequest(b.id,{requestId:item.request.requestId,status:'known',task:{...job(b),state:'cancelled'}},true);
 assert.equal(canClearRemoteBatch(f.controller.getSnapshot().workspace!.remoteBatch!),true);
 await assert.rejects(f.controller.acknowledgeRemoteBatchRequest(b.id,{requestId:item.request.requestId,status:'known',task:{...job(b),id:randomUUID()}},true),{code:'EDIT_CHANGED'});
});
test('scope deactivation while cancellation persistence is queued rejects the write and never edits another account',async t=>{
 const f=await fixture();t.after(()=>f.close());await f.controller.createRemoteBatch(f.batch);const original=f.store.update.bind(f.store);let entered!:()=>void,release!:()=>void;
 const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);t.mock.method(f.store,'update',async(...args:Parameters<typeof f.store.update>)=>{entered();await gate;return original(...args);});
 const pending=assert.rejects(f.controller.stopRemoteBatch(f.batch.id),{code:'ACCOUNT_CHANGED'});await ready;f.controller.deactivate();release();await pending;
 assert.equal((await f.store.read(scope))!.remoteBatch!.cancelRequested,false);
});

test('sparse arrays cannot substitute a private property for a missing member or evaluate an indexed accessor',()=>{
 const b=draft(),items=[...b.items] as any;delete items[1];items.privateAuthority=b.items[1];assert.throws(()=>validateRemoteBatch({...b,items}));let read=0;
 const accessors=[...b.items];Object.defineProperty(accessors,'1',{enumerable:true,get(){read++;return b.items[1];}});assert.throws(()=>validateRemoteBatch({...b,items:accessors}));assert.equal(read,0);
});
