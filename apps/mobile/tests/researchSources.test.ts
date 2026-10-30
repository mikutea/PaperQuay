import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { verifyParsedDocument, type PaperData, type AttachmentVersionData, type VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import { collectResearchSources } from '../src/research/sources.ts';
import { WebParsedCache } from '../src/parsed/cache.ts';
const id=(n:number)=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const scope={apiBaseUrl:'https://sync.example.test',accountId:id(1)};
const paper:PaperData={title:'Research paper',authors:['Author'],doi:null,year:'2026',publication:null,keywords:['evidence'],abstractText:'Metadata methods only'};
const version:AttachmentVersionData={paperId:id(2),attachmentId:id(3),fileName:'research.pdf',sha256:'a'.repeat(64),sizeBytes:100,pageCount:2,mediaType:'application/pdf'};
const entities:VisibleEntity[]=[{entityType:'paper',entityId:id(2),data:paper,revision:1,deleted:false,pending:false,status:'synced'},
 {entityType:'attachmentVersion',entityId:id(4),data:version,revision:1,deleted:false,pending:false,status:'synced'}];
function parsed(){return verifyParsedDocument({format:'paperquay-parsed-document',version:1,paperId:id(2),attachmentVersionId:id(4),pdf:{sha256:version.sha256,sizeBytes:100,pageCount:2},parser:{name:'mineru',model:'fixture-parser'},assets:[],blocks:[{id:'block-1',kind:'text',pageIndex:1,text:'Actual cached page two evidence'}]});}

test('multi-source collector reads actual scoped parsed cache and preserves package digest, page and exact version',async()=>{
 const cache=new WebParsedCache({indexedDB:new IDBFactory(),databaseName:crypto.randomUUID()});const verified=await parsed();await cache.put(scope,verified,{});
 const result=await collectResearchSources({entities,selections:[{paperId:id(2),versionId:id(4)}],scope,cache,current:()=>true});
 assert.equal(result[0].kind,'parsed');assert.equal(result[0].packageDigest,verified.digest);assert.equal(result[0].attachmentVersionId,id(4));assert.equal(result[0].chunks[0].pageIndex,1);assert.equal(result[0].chunks[0].text,'Actual cached page two evidence');
});
test('metadata collection never reads parsed cache or pretends to have PDF pages',async()=>{
 let calls=0;const cache=new WebParsedCache({indexedDB:new IDBFactory(),databaseName:crypto.randomUUID()});const read=cache.read.bind(cache);cache.read=async(...args)=>{calls++;return read(...args);};
 const result=await collectResearchSources({entities,selections:[{paperId:id(2),versionId:null}],scope,cache,current:()=>true});
 assert.equal(calls,0);assert.equal(result[0].kind,'metadata');assert.equal(result[0].sha256,null);assert.equal(result[0].chunks[0].pageIndex,null);assert(result[0].chunks[0].text.includes('Metadata methods only'));
});
test('missing or other-account parsed cache never silently falls back to metadata',async()=>{
 const cache=new WebParsedCache({indexedDB:new IDBFactory(),databaseName:crypto.randomUUID()});await cache.put({...scope,accountId:id(99)},await parsed(),{});
 await assert.rejects(collectResearchSources({entities,selections:[{paperId:id(2),versionId:id(4)}],scope,cache,current:()=>true}),e=>(e as any).code==='EMPTY');
});
test('parsed collection rejects changed version, unknown page count and an identity change during cache read',async()=>{
 const cache=new WebParsedCache({indexedDB:new IDBFactory(),databaseName:crypto.randomUUID()});await cache.put(scope,await parsed(),{});
 const changed=structuredClone(entities);(changed[1].data as AttachmentVersionData).sha256='b'.repeat(64);
 await assert.rejects(collectResearchSources({entities:changed,selections:[{paperId:id(2),versionId:id(4)}],scope,cache,current:()=>true}));
 const unknown=structuredClone(entities);(unknown[1].data as AttachmentVersionData).pageCount=null;
 await assert.rejects(collectResearchSources({entities:unknown,selections:[{paperId:id(2),versionId:id(4)}],scope,cache,current:()=>true}),e=>(e as any).code==='INVALID');
 let current=true;const read=cache.read.bind(cache);cache.read=async(...args)=>{const result=await read(...args);current=false;return result;};
 await assert.rejects(collectResearchSources({entities,selections:[{paperId:id(2),versionId:id(4)}],scope,cache,current:()=>current}),e=>(e as any).code==='CHANGED');
});
