import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { registerRemoteRetrievalRoutes, REMOTE_RETRIEVAL_CAPABILITY } from '../../src/remote-retrieval.ts';
import { runRemoteRetrieval } from '../../src/remote-retrieval-worker.ts';
import type { RemoteRetrievalRepository } from '../../src/remote-retrieval-store.ts';
import { ApiError } from '../../src/errors.ts';
import { identity, testConfig } from '../fixtures.ts';
import { retrievalFixture } from '../../../tests/remoteRetrievalFixtures.ts';
import { validateRemoteRetrievalCapability } from '../../../packages/sync-core/src/remoteRetrieval.ts';

async function fixture(enabled=true,overrides:Partial<RemoteRetrievalRepository>={}){
  const who=identity(),calls:{name:string;args:unknown[]}[]=[];
  const repository=new Proxy(overrides,{get(target,key){if(key in target)return Reflect.get(target,key);return async(...args:unknown[])=>{calls.push({name:String(key),args});return{test:true};};}})as RemoteRetrievalRepository;
  const app=Fastify({logger:false,ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});app.decorateRequest('identity',null);
  app.setErrorHandler((e,_request,reply)=>{const error=e as ApiError;reply.code(error.statusCode??500).send({error:{code:error.code}});});
  await registerRemoteRetrievalRoutes(app,{enabled,repository,authenticate:async request=>{if(request.headers.authorization!=='Bearer synthetic')throw new ApiError('AUTHENTICATION_REQUIRED',401);request.identity=who;}});
  return{app,who,calls,headers:{authorization:'Bearer synthetic'}};
}
test('retrieval has an independent default-off flag and explicit server lexical capability',async t=>{
  assert.equal(testConfig().remoteRetrievalEnabled,false);assert.equal(testConfig({PAPERQUAY_REMOTE_RETRIEVAL_ENABLED:'1'}).remoteTasksEnabled,false);
  assert.equal(testConfig({PAPERQUAY_REMOTE_RETRIEVAL_ENABLED:'1'}).remoteRetrievalEnabled,true);assert.throws(()=>testConfig({PAPERQUAY_REMOTE_RETRIEVAL_ENABLED:'true'}),{code:'CONFIGURATION_INVALID'});
  assert.deepEqual(validateRemoteRetrievalCapability(REMOTE_RETRIEVAL_CAPABILITY),REMOTE_RETRIEVAL_CAPABILITY);assert.equal(REMOTE_RETRIEVAL_CAPABILITY.externalModelCalls,false);
  const f=await fixture(false);t.after(()=>f.app.close());assert.equal((await f.app.inject('/v1/remote-retrieval/sources')).statusCode,401);
  assert.equal((await f.app.inject({url:'/v1/remote-retrieval/sources',headers:f.headers})).statusCode,503);assert.equal(f.calls.length,0);
  const empty=Fastify();t.after(()=>empty.close());await assert.rejects(registerRemoteRetrievalRoutes(empty,{enabled:true,authenticate:async()=>{}}),{code:'CONFIGURATION_INVALID'});
});
test('routes pass only validated fixed source manifests and bounded cursors, with no arbitrary server authority',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const r=retrievalFixture().request;
  for(const url of ['/v1/remote-retrieval/sources?limit=9','/v1/remote-retrieval/sources?cursor=bad','/v1/remote-retrieval/sources?accountId='+randomUUID()])assert.equal((await f.app.inject({url,headers:f.headers})).statusCode,400);
  assert.equal((await f.app.inject({url:'/v1/remote-retrieval/sources?limit=8',headers:f.headers})).statusCode,200);assert.equal(f.calls[0].name,'listSources');assert.deepEqual(f.calls[0].args[1],{limit:8});
  for(const payload of [{...r,path:'/private'},{...r,mode:'vector'},{...r,sources:[{...r.sources[0],url:'https://private.test'}]}])assert.equal((await f.app.inject({method:'POST',url:'/v1/remote-retrieval/requests',headers:f.headers,payload})).statusCode,400);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/remote-retrieval/requests',headers:f.headers,payload:r})).statusCode,200);assert.equal(f.calls.at(-1)!.name,'retrieve');assert.deepEqual(f.calls.at(-1)!.args[1],r);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/remote-retrieval/requests',headers:{...f.headers,'content-type':'application/json'},payload:'{"requestId":"a","requestId":"b"}'})).statusCode,400);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/remote-retrieval/requests',headers:{...f.headers,'content-type':'text/plain'},payload:'{}'})).statusCode,415);
  const id=randomUUID();await f.app.inject({url:'/v1/remote-retrieval/requests/'+id,headers:f.headers});assert.equal(f.calls.at(-1)!.name,'lookup');
  await f.app.inject({method:'DELETE',url:'/v1/remote-retrieval/requests/'+id,headers:f.headers});assert.equal(f.calls.at(-1)!.name,'remove');
});
test('a pending computation keeps the account admission occupied until it actually settles',async t=>{
  let finish!:(value:{replayed:boolean;receipt:never})=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
  const f=await fixture(true,{retrieve:async()=>{entered();return new Promise(r=>{finish=r;});}});t.after(()=>f.app.close());
  const pending=f.app.inject({method:'POST',url:'/v1/remote-retrieval/requests',headers:f.headers,payload:retrievalFixture().request}).then(response=>response);await started;
  const busy=await f.app.inject({url:'/v1/remote-retrieval/sources',headers:f.headers});assert.equal(busy.statusCode,429);assert.equal(busy.json().error.code,'REMOTE_RETRIEVAL_BUSY');
  finish({replayed:false,receipt:null as never});assert.equal((await pending).statusCode,200);
  assert.equal((await f.app.inject({url:'/v1/remote-retrieval/sources',headers:f.headers})).statusCode,200);
});
test('server worker executes real lexical results and stops an expired budget or explicit cancellation without any provider',async()=>{
  const f=retrievalFixture();assert.equal((await runRemoteRetrieval(f.request,[f.artifact])).evidence[0].score,2);
  await assert.rejects(runRemoteRetrieval(f.request,[f.artifact],{signal:AbortSignal.abort()}),{code:'REMOTE_RETRIEVAL_STOPPED'});
  let time=0;await assert.rejects(runRemoteRetrieval(f.request,[f.artifact],{now:()=>time+=11000}),{code:'REMOTE_RETRIEVAL_TIMEOUT'});
  const large=retrievalFixture(Array.from({length:130},()=> 'urban')),controller=new AbortController();setImmediate(()=>controller.abort());
  await assert.rejects(runRemoteRetrieval(large.request,[large.artifact],{signal:controller.signal}),{code:'REMOTE_RETRIEVAL_STOPPED'});
});
