import assert from 'node:assert/strict';import {test} from 'node:test';
import {createAccountState,queueLocalEdit,getSyncContext,applyPullPage,validateClientState,validateEntityData,validateOperation,validateRecord,validatePullResponse,validatePushResponse,
  supportsSyncRecord,type SyncRecord} from '../packages/sync-core/src/index.ts';
import {richFixture,conversationFixture,extendedId as id} from './fixtures/extendedSync.ts';
const envelope=(entityType:string,data:unknown)=>({entityType,entityId:id(3),schemaVersion:1,revision:1,deletedAt:null,updatedAt:'2026-10-28T00:00:00.000Z',modifiedByDeviceId:id(2),data});
test('rich and conversation semantic validation runs at entity, operation, record, response and persisted-state boundaries',()=>{
  for(const [kind,data]of[['note',richFixture()],['aiConversation',conversationFixture()]] as const){
    const record=envelope(kind,data) as SyncRecord;assert.equal(validateEntityData(kind,data).ok,true);assert.equal(validateRecord(record).ok,true);
    const bad=structuredClone(data) as unknown as Record<string,unknown>;
    if(kind==='note')bad.body='flattened wrong body';else bad.context={...(bad.context as object),apiKey:'must reject'};
    const operation={opId:id(4),entityType:kind,entityId:id(3),schemaVersion:1,mutation:'put',baseRevision:0,clientCreatedAt:'2026-10-28T00:00:00.000Z',data:bad};
    assert.equal(validateEntityData(kind,bad).ok,false);assert.equal(validateOperation(operation).ok,false);
    assert.equal(validateRecord({...record,data:bad}).ok,false);
    assert.equal(validatePullResponse({protocolVersion:1,records:[{...record,data:bad}],nextCursor:null,hasMore:false}).ok,false);
    assert.equal(validatePushResponse({protocolVersion:1,results:[{opId:id(4),status:'applied',replayed:false,record:{...record,data:bad}}]}).ok,false);
    const state=createAccountState(id(1),id(2));
    assert.throws(()=>queueLocalEdit(state,{entityType:kind,entityId:id(3),mutation:'put',data:bad} as never,{opId:id(4),clientCreatedAt:'2026-10-28T00:00:00.000Z'}));
    const pulled=applyPullPage(state,getSyncContext(state),{fromCursor:null,response:{protocolVersion:1,records:[record],nextCursor:'cursor',hasMore:false}});
    const poisoned=structuredClone(pulled);(poisoned.serverRecords[`${kind}:${id(3)}`] as any).data=bad;
    assert.equal(validateClientState(poisoned).ok,false);assert.equal(validateClientState(pulled).ok,true);
  }
});
test('feature negotiation hides only unsupported content while Markdown and tombstones remain readable',()=>{
  const legacy={richNotes:false,aiConversations:false},all={richNotes:true,aiConversations:true};
  assert.equal(supportsSyncRecord(legacy,{entityType:'note',data:richFixture()}),false);
  assert.equal(supportsSyncRecord(all,{entityType:'note',data:richFixture()}),true);
  assert.equal(supportsSyncRecord(legacy,{entityType:'note',data:{paperId:null,title:'旧笔记',body:'原文',format:'markdown'}}),true);
  assert.equal(supportsSyncRecord(legacy,{entityType:'note',data:null}),true);
  assert.equal(supportsSyncRecord(legacy,{entityType:'aiConversation',data:null}),false);
  assert.equal(supportsSyncRecord(all,{entityType:'aiConversation',data:conversationFixture()}),true);
});
