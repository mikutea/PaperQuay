import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {AccountStore} from '../src/storage/accountStore.ts';
import {exportLocalData} from '../src/privacy/localExport.ts';
import type {PersonalExportSink} from '../src/privacy/exportStream.ts';
import type {StoredWorkspace} from '../src/sync/workspace.ts';
import type {PdfCache} from '../src/pdf/types.ts';
import type {ParsedCache} from '../src/parsed/cache.ts';
import type {AiArchiveStore} from '../src/ai/archiveStore.ts';

const scope={apiBaseUrl:'https://sync.example.test',accountId:'11111111-1111-4111-8111-111111111111'};
const id='22222222-2222-4222-8222-222222222222';
async function fixture(){
  const store=new AccountStore<StoredWorkspace>({indexedDB:new IDBFactory(),databaseName:crypto.randomUUID(),decode:value=>value as StoredWorkspace});
  await store.update(scope,()=>({sync:{accountId:scope.accountId,outbox:[{data:{title:'unsynced sentinel'}}]},reviewProject:{text:'local review sentinel'},
    radarState:{credentialRef:'must-not-export',candidates:[]}} as unknown as StoredWorkspace));
  const content=new TextEncoder().encode('synthetic cached bytes'.repeat(9000)),sha256=createHash('sha256').update(content).digest('hex');
  const entry={versionId:id,sha256,sizeBytes:content.length,fileName:'cached.pdf',pageCount:1,pinned:true,createdAt:1,lastUsedAt:1,sourceUrl:'https://private.example.test/token-sentinel'};
  const pdf={list:async()=>[entry],peek:async()=>content} as unknown as PdfCache;
  const parsed={list:async()=>[{versionId:id,sha256,sizeBytes:10,storedAt:1}],exportEntry:async()=>({document:{text:'orphan parsed sentinel'},digest:'d'.repeat(64)})} as unknown as ParsedCache;
  const ai={list:async()=>[{kind:'record',id,revision:1}],read:async()=>({id,kind:'record',revision:1,text:'local AI sentinel'})} as unknown as AiArchiveStore;
  const parts:Uint8Array[]=[],state={finished:0,aborted:0};
  const sink:PersonalExportSink={write:async part=>{parts.push(part);},finish:async()=>{state.finished++;return 'saved';},abort:async()=>{state.aborted++;}};
  return {store,pdf,parsed,ai,parts,state,sink,content};
}
test('local export includes unsynced, local-only and orphan cached content with complete file and archive receipts',async()=>{
  const f=await fixture();try{
    const result=await exportLocalData(scope,f.sink,f,{current:()=>true,signal:new AbortController().signal});
    const text=Buffer.concat(f.parts).toString(),rows=f.parts.map(part=>JSON.parse(Buffer.from(part).toString()));
    for(const sentinel of['unsynced sentinel','local review sentinel','orphan parsed sentinel','local AI sentinel'])assert(text.includes(sentinel));
    assert(!text.includes('must-not-export'));assert(!text.includes('token-sentinel'));assert(!text.includes('private.example.test'));
    assert.equal(result.files,1);assert.equal(result.fileBytes,f.content.length);assert.equal(f.state.finished,1);assert.equal(f.state.aborted,0);
    assert.equal(rows.at(-1).sha256,createHash('sha256').update(Buffer.concat(f.parts.slice(0,-1))).digest('hex'));
    assert.deepEqual(Buffer.concat(rows.filter(row=>row.kind==='file-chunk').map(row=>Buffer.from(row.base64,'base64'))),Buffer.from(f.content));
    assert(rows.some(row=>row.area==='ai-archive/record/'+id));assert(rows.some(row=>row.area?.startsWith('parsed-package/'+id)));
  }finally{await f.store.close();}
});
test('missing bytes, changed local data and an owner transition never promote a partial local export',async()=>{
  for(const failure of['missing','workspace-change','owner']){
    const f=await fixture();let current=true;try{
      f.pdf.peek=async()=>{if(failure==='workspace-change')await f.store.update(scope,value=>({...value!,reviewProject:{text:'changed'} as never}));
        if(failure==='owner')current=false;return failure==='missing'?null:f.content;};
      await assert.rejects(exportLocalData(scope,f.sink,f,{current:()=>current,signal:new AbortController().signal}));
      assert.equal(f.state.finished,0);assert(f.state.aborted>0);assert(!f.parts.some(part=>JSON.parse(Buffer.from(part).toString()).kind==='complete'));
    }finally{await f.store.close();}
  }
});
