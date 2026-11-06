import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { REMOTE_RETRIEVAL_LIMITS as L, parseRemoteRetrievalJson, remoteRetrievalDigest, remoteRetrievalTerms, runRemoteLexicalRetrieval,
  assertRemoteRetrievalArtifact, validateRemoteRetrievalRequest, validateRemoteRetrievalReceipt, validateRemoteRetrievalStatus,
  validateRemoteRetrievalSource, validateRemoteRetrievalSourcesPage, validateRemoteRetrievalResult } from '../packages/sync-core/src/remoteRetrieval.ts';
import { retrievalFixture, retrievalHash } from './remoteRetrievalFixtures.ts';

test('retrieval request is closed, detached and never carries a transport, path, command or semantic mode',()=>{
  const f=retrievalFixture(),r=validateRemoteRetrievalRequest(f.request);assert.deepEqual(r,f.request);r.sources[0].target.fileName='changed';assert.equal(f.source.target.fileName,'synthetic.pdf');
  for(const key of ['path','url','headers','command','modelKey','accountId','deviceId'])assert.throws(()=>validateRemoteRetrievalRequest({...f.request,[key]:'private'}));
  assert.throws(()=>validateRemoteRetrievalRequest({...f.request,mode:'vector'}));
  assert.throws(()=>validateRemoteRetrievalRequest({...f.request,sources:[{...f.source,endpoint:'https://example.test'}]}));
  assert.throws(()=>validateRemoteRetrievalRequest({...f.request,sources:[f.source,{...f.source,taskId:randomUUID()}]}));
  let called=false;const malicious=Object.defineProperty({...f.request},'query',{enumerable:true,get(){called=true;return'urban';}});
  assert.throws(()=>validateRemoteRetrievalRequest(malicious));assert.equal(called,false);
  const sparse=new Array(1);assert.throws(()=>validateRemoteRetrievalRequest({...f.request,sources:sparse}));
});
test('retrieval enforces combined bytes, chunks, vectors, query terms and explicit topK before work',()=>{
  const f=retrievalFixture(),g=retrievalFixture();
  for(const change of [{query:'x'.repeat(L.queryCharacters+1)},{query:'中'.repeat(1400)},{query:Array.from({length:65},(_,i)=>'token'+i).join(' ')},{query:'a !'},{topK:0},{topK:L.topK+1},{sources:[]}])assert.throws(()=>validateRemoteRetrievalRequest({...f.request,...change}));
  assert.throws(()=>validateRemoteRetrievalRequest({...f.request,sources:[{...f.source,artifactBytes:9*1024*1024},{...g.source,artifactBytes:9*1024*1024}]}),{code:'REMOTE_RETRIEVAL_LIMIT'});
  assert.throws(()=>validateRemoteRetrievalRequest({...f.request,sources:[{...f.source,chunkCount:6000},{...g.source,chunkCount:6000}]}),{code:'REMOTE_RETRIEVAL_LIMIT'});
  assert.throws(()=>validateRemoteRetrievalRequest({...f.request,sources:[{...f.source,dimension:2048,chunkCount:900},{...g.source,dimension:2048,chunkCount:900}]}),{code:'REMOTE_RETRIEVAL_LIMIT'});
  assert.throws(()=>validateRemoteRetrievalSource({...f.source,target:{...f.source.target,pageCount:null}}));
});
test('lexical ranking reuses actual chunks, exposes CJK terms, preserves stable ties and reports empty matches',async()=>{
  const f=retrievalFixture(),g=retrievalFixture(['URBAN urban urban']);const request={...f.request,sources:[f.source,g.source],topK:3};
  const result=await runRemoteLexicalRetrieval(request,[f.artifact,g.artifact]);assert.deepEqual(result.terms,['城乡','urban']);
  assert.deepEqual(result.evidence.map(e=>[e.id,e.score,e.pageIndex]),[['R1C1',2,0],['R1C2',1,1],['R1C3',1,0]]);
  assert.equal(result.stats.matchingChunks,4);assert.equal(result.stats.omittedMatches,1);assert.equal(result.stats.scannedChunks,4);
  assert.equal(result.requestDigest,await remoteRetrievalDigest(request));assert(!JSON.stringify(result).includes('vector'));
  const none=await runRemoteLexicalRetrieval({...f.request,query:'NoMatchToken'},[f.artifact]);assert.equal(none.evidence.length,0);assert.equal(none.stats.matchingChunks,0);
  assert.deepEqual(remoteRetrievalTerms('城乡生活 Urban urban'),['城乡','乡生','生活','urban']);
});
test('snippet offsets preserve original UTF-16 text and surrogate pairs and include late matches',async()=>{
  const f=retrievalFixture(['😀'.repeat(1300)+' urban '+'🧭'.repeat(1400)]),result=await runRemoteLexicalRetrieval({...f.request,query:'urban'},[f.artifact]),e=result.evidence[0];
  assert(e.excerptStart>0);assert(e.text.includes('urban'));assert(e.text.length<=L.excerptCharacters);
  assert.equal(e.text,f.artifact.chunks[0].text.slice(e.excerptStart,e.excerptStart+e.text.length));assert.doesNotThrow(()=>encodeURIComponent(e.text));
  assert.equal(e.excerptDigest,retrievalHash(e.text));assert.equal(result.stats.omittedCharacters,e.fullTextLength-e.text.length);
  const expanded=retrievalFixture(['İ'.repeat(1900)+'URBAN']);const other=(await runRemoteLexicalRetrieval({...expanded.request,query:'urban'},[expanded.artifact])).evidence[0];
  assert(other.text.includes('URBAN'));assert.equal(other.text,expanded.artifact.chunks[0].text.slice(other.excerptStart,other.excerptStart+other.text.length));
});
test('each manifest binds version, PDF, parse, model, dimension, chunker, content and exact coverage',()=>{
  const f=retrievalFixture();assertRemoteRetrievalArtifact(f.source,f.artifact);
  const altered=[{...f.artifact,paperId:randomUUID()},{...f.artifact,attachmentVersionId:randomUUID()},{...f.artifact,pdf:{...f.artifact.pdf,sha256:'d'.repeat(64)}},
    {...f.artifact,parseDigest:'d'.repeat(64)},{...f.artifact,model:'other'},{...f.artifact,dimension:3},{...f.artifact,chunker:{...f.artifact.chunker,revision:2}},
    {...f.artifact,contentHash:'d'.repeat(64)},{...f.artifact,chunks:f.artifact.chunks.slice(1)}];
  for(const a of altered)assert.throws(()=>assertRemoteRetrievalArtifact(f.source,a),{code:'REMOTE_RETRIEVAL_SOURCE_CHANGED'});
});
test('receipts verify exact request/result/excerpt hashes and reject fabricated evidence and tampering',async()=>{
  const f=retrievalFixture(),result=await runRemoteLexicalRetrieval(f.request,[f.artifact]);const receipt={version:1,request:f.request,requestDigest:await remoteRetrievalDigest(f.request),result,resultDigest:await remoteRetrievalDigest(result),createdAt:'2026-11-04T00:00:00.000Z'};
  assert.deepEqual(await validateRemoteRetrievalReceipt(receipt),receipt);
  assert.equal((await validateRemoteRetrievalStatus({requestId:f.request.requestId,status:'complete',requestDigest:receipt.requestDigest,receipt})).status,'complete');
  await assert.rejects(validateRemoteRetrievalReceipt({...receipt,request:{...f.request,query:'changed'}}));
  await assert.rejects(validateRemoteRetrievalReceipt({...receipt,resultDigest:'e'.repeat(64)}));
  const changed={...result,evidence:[{...result.evidence[0],text:'forged'}]};
  await assert.rejects(validateRemoteRetrievalReceipt({...receipt,result:changed,resultDigest:await remoteRetrievalDigest(changed)}));
  assert.throws(()=>validateRemoteRetrievalResult({...result,evidence:[{...result.evidence[0],sourceIndex:5}]},f.request));
  assert.throws(()=>validateRemoteRetrievalResult({...result,stats:{...result.stats,scannedChunks:999}},f.request));
  assert.throws(()=>validateRemoteRetrievalSourcesPage({sources:[f.source],nextCursor:null,hasMore:true}));
});
test('strict wire parser rejects duplicate keys, invalid UTF-8, BOM, huge and deeply nested JSON',()=>{
  for(const value of ['{"query":"one","query":"two"}','{"x":1,"\\u0078":2}','\ufeff{}','['.repeat(20)+'0'+']'.repeat(20)])assert.throws(()=>parseRemoteRetrievalJson(Buffer.from(value)));
  assert.throws(()=>parseRemoteRetrievalJson(Uint8Array.of(0xc0,0xaf)));assert.throws(()=>parseRemoteRetrievalJson(new Uint8Array(L.requestBytes+1)),{code:'REMOTE_RETRIEVAL_LIMIT'});
});
