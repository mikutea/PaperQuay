import assert from 'node:assert/strict';import test from 'node:test';
import {buildApp} from '../../src/app.ts';import {identity,testConfig,paper} from '../fixtures.ts';
import type {SyncRepository} from '../../src/types.ts';
import {richFixture,conversationFixture,extendedId as id} from '../../../tests/fixtures/extendedSync.ts';
import {AI_CONVERSATIONS_FEATURE,PAPER_ORGANIZATION_FEATURE,RICH_NOTES_FEATURE,type SyncRecord} from '../../../packages/sync-core/src/index.ts';
const who=identity(),stamp='2026-10-28T00:00:00.000Z';
const record=(entityType:string,data:unknown,n:number)=>({entityType,entityId:id(n),schemaVersion:1,revision:1,deletedAt:null,updatedAt:stamp,modifiedByDeviceId:id(2),data}) as SyncRecord;
test('actual Fastify serialization preserves rich AST and full conversation snapshots only for negotiated clients',async()=>{
  const rows=[record('paper',paper(),1),record('note',richFixture(),3),record('aiConversation',conversationFixture(),4),record('aiTemplate',{version:1,title:'模板',action:'ask',question:'一个问题'},5)];
  const conflicts=[{conflictId:id(7),entityType:'note',entityId:id(3),createdAt:stamp,attemptedOperation:{opId:id(8),entityType:'note',entityId:id(3),mutation:'put',baseRevision:0,schemaVersion:1,data:rows[1].data,clientCreatedAt:stamp},observedRecord:rows[1],currentRecord:rows[1]}];
  let received:unknown;
  const repository={ready:async()=>true,pull:async()=>({protocolVersion:1,records:rows,nextCursor:'advanced-hidden-feed',hasMore:true}),
    listConflicts:async()=>({conflicts,nextCursor:'advanced-conflicts',hasMore:false}),push:async(_i:unknown,_r:unknown,features:unknown)=>{received=features;return{protocolVersion:1,results:[]};}} as unknown as SyncRepository;
  const app=await buildApp({config:testConfig(),repository,verifyToken:async()=>who});
  try{
    const headers={authorization:'Bearer synthetic','X-PaperQuay-Features':PAPER_ORGANIZATION_FEATURE};
    const old=await app.inject({method:'GET',url:'/v1/sync/pull',headers});assert.equal(old.statusCode,200);assert.deepEqual(old.json().records,[rows[0]]);assert.equal(old.json().nextCursor,'advanced-hidden-feed');assert.equal(old.json().hasMore,true);
    const current={...headers,'X-PaperQuay-Features':[PAPER_ORGANIZATION_FEATURE,RICH_NOTES_FEATURE,AI_CONVERSATIONS_FEATURE].join(', ')};
    const next=await app.inject({method:'GET',url:'/v1/sync/pull',headers:current});assert.equal(next.statusCode,200);assert.deepEqual(next.json().records,rows);
    const hidden=await app.inject({method:'GET',url:'/v1/conflicts',headers});assert.deepEqual(hidden.json().conflicts,[]);assert.equal(hidden.json().nextCursor,'advanced-conflicts');
    const shown=await app.inject({method:'GET',url:'/v1/conflicts',headers:current});assert.deepEqual(shown.json().conflicts,conflicts);
    const sent=await app.inject({method:'POST',url:'/v1/sync/push',headers:current,payload:{protocolVersion:1,deviceId:id(2),operations:[{opId:id(9),entityType:'note',entityId:id(3),mutation:'put',baseRevision:0,schemaVersion:1,data:rows[1].data,clientCreatedAt:stamp}]}});
    assert.equal(sent.statusCode,200);assert.deepEqual(received,{richNotes:true,aiConversations:true});
  }finally{await app.close();}
});
