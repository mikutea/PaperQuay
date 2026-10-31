import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {registerModelInferenceRoutes,MODEL_INFERENCE_CAPABILITY,type ModelGatewayControl} from '../../src/model-inference.ts';
import type {ModelInferenceRepository} from '../../src/model-inference-store.ts';
import {prepareModelInferenceRequest,prepareModelInferenceOutput} from '../../../packages/sync-core/src/modelInference.ts';
import {ApiError} from '../../src/errors.ts';
import {identity} from '../fixtures.ts';
const profile={id:'chat-default',revision:1,digest:'a'.repeat(64),kind:'chat' as const,model:'synthetic',maxInputBytes:192*1024,maxOutputTokens:2048,stream:false as const};
const request=()=>prepareModelInferenceRequest({id:randomUUID(),target:{kind:'gateway'},profileRef:{id:profile.id,revision:1,digest:profile.digest},model:profile.model,messages:[{role:'user',content:'Synthetic evidence'}],maxOutputTokens:1024});
async function fixture(enabled=true,overrides:Partial<ModelInferenceRepository>={},withGateway=false){
 const calls:{name:string;args:unknown[]}[]=[],gatewayCalls:string[]=[],who={...identity(),expiresAtMs:Date.now()+3600000};
 const repository=new Proxy(overrides,{get(target,prop){if(prop in target)return Reflect.get(target,prop);return async(...args:unknown[])=>{calls.push({name:String(prop),args});return {ok:true};};}})as ModelInferenceRepository;
 const gateway=new Proxy({}, {get(_target,prop){if(prop==='close')return async()=>{gatewayCalls.push('close');};if(prop==='candidate')return()=>{gatewayCalls.push('candidate');return null;};if(['observe','cancel'].includes(String(prop)))return()=>{gatewayCalls.push(String(prop));};return async()=>{gatewayCalls.push(String(prop));return{id:'synthetic',phase:'none',hasOutput:false};};}})as ModelGatewayControl;
 const app=Fastify({logger:false,bodyLimit:1024,ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});app.decorateRequest('identity',null);
 app.setErrorHandler((error,_request,reply)=>{const e=error as ApiError;reply.code(e.statusCode??500).send({error:{code:e.code}});});
 app.post('/ordinary',async r=>r.body);
 await registerModelInferenceRoutes(app,{enabled,gatewayEnabled:withGateway,repository,gateway:withGateway?gateway:undefined,authenticate:async req=>{if(req.headers.authorization!=='Bearer synthetic')throw new ApiError('AUTHENTICATION_REQUIRED',401);req.identity=who;}});
 return{app,calls,gatewayCalls,who,headers:{authorization:'Bearer synthetic'}};
}
test('model routes authenticate before disabled feature or JSON parsing and leave ordinary limits intact',async t=>{
 const f=await fixture(false);t.after(()=>f.app.close());
 assert.equal((await f.app.inject('/v1/model-inference/jobs')).statusCode,401);
 const disabled=await f.app.inject({method:'POST',url:'/v1/model-inference/jobs',headers:{...f.headers,'content-type':'application/json'},payload:'broken'});assert.equal(disabled.statusCode,503);assert.equal(disabled.json().error.code,'MODEL_INFERENCE_DISABLED');assert.deepEqual(f.calls,[]);
 assert.equal((await f.app.inject({method:'POST',url:'/ordinary',payload:{text:'x'.repeat(1100)}})).statusCode,413);
 assert.equal(MODEL_INFERENCE_CAPABILITY.transport,'model-invocations-v1');assert.equal(MODEL_INFERENCE_CAPABILITY.maxActive,1);
});
test('model routes require repository and concrete enabled gateway implementation',async t=>{
 for(const options of [{enabled:true},{enabled:true,gatewayEnabled:true,repository:{}as ModelInferenceRepository}]){const app=Fastify();t.after(()=>app.close());await assert.rejects(registerModelInferenceRoutes(app,{...options,authenticate:async()=>{}}),{code:'CONFIGURATION_INVALID'});}
});
test('strict model JSON rejects duplicate escaped keys, BOM, malformed UTF8 and excess depth before repository',async t=>{
 const f=await fixture();t.after(()=>f.app.close());
 for(const payload of ['{"profiles":[],"profiles":[]}','{"profiles":[],"\\u0070rofiles":[]}','\ufeff{}','['.repeat(17)+'0'+']'.repeat(17),Buffer.from([0xc0,0xaf])]){
 const r=await f.app.inject({method:'PUT',url:'/v1/model-inference/provider',headers:{...f.headers,'content-type':'application/json'},payload});assert.equal(r.statusCode,typeof payload==='string'&&payload.startsWith('[')?413:400);
 }assert.deepEqual(f.calls,[]);
});
test('model routes bound wire sizes, media types and exact query/body authority',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const id=randomUUID();
 for(const input of [
 {method:'POST' as const,url:'/v1/model-inference/jobs',headers:{...f.headers,'content-type':'text/plain'},payload:'{}',status:415},
 {method:'POST' as const,url:'/v1/model-inference/jobs',headers:{...f.headers,'content-type':'application/json','content-encoding':'gzip'},payload:'{}',status:415},
 {method:'GET' as const,url:'/v1/model-inference/jobs?accountId='+randomUUID(),headers:f.headers,status:400},
 {method:'POST' as const,url:'/v1/model-inference/jobs/'+id+'/dispatch',headers:f.headers,payload:{endpoint:'https://private.test'},status:400},
 {method:'POST' as const,url:'/v1/model-inference/jobs',headers:f.headers,payload:{padding:'x'.repeat(270000)},status:413},
 {method:'PUT' as const,url:'/v1/model-inference/provider',headers:f.headers,payload:{profiles:[{...profile,apiKey:'secret'}]},status:400},
 ]){const {status,...options}=input;assert.equal((await f.app.inject(options)).statusCode,status);}assert.deepEqual(f.calls,[]);
});
test('only newly acknowledged queued gateway creation dispatches; replay and reads never dispatch',async t=>{
 const r=await request();let replayed=false;
 const f=await fixture(true,{createInvocation:async(_who,value)=>{assert.deepEqual(value,r);return{replayed,result:{status:'queued',job:{state:'queued'}}}as any;}},true);t.after(()=>f.app.close());
 assert.equal((await f.app.inject({method:'POST',url:'/v1/model-inference/jobs',headers:f.headers,payload:r})).statusCode,200);assert.deepEqual(f.gatewayCalls,['dispatch']);
 replayed=true;assert.equal((await f.app.inject({method:'POST',url:'/v1/model-inference/jobs',headers:f.headers,payload:r})).statusCode,200);
 await f.app.inject({url:'/v1/model-inference/requests/'+r.id,headers:f.headers});await f.app.inject({url:'/v1/model-inference/availability',headers:f.headers});await f.app.inject({url:'/v1/model-inference/jobs',headers:f.headers});
 assert.equal(f.gatewayCalls.filter(x=>x==='dispatch').length,1);
});
test('unacknowledged creation, computer targets and cancelled receipts never auto-dispatch',async t=>{
 const lost=await fixture(true,{createInvocation:async()=>{throw new ApiError('DATABASE_TEMPORARILY_UNAVAILABLE',503);}},true);t.after(()=>lost.app.close());const r=await request();
 assert.equal((await lost.app.inject({method:'POST',url:'/v1/model-inference/jobs',headers:lost.headers,payload:r})).statusCode,503);assert.deepEqual(lost.gatewayCalls,[]);
 const cancelled=await fixture(true,{createInvocation:async()=>({replayed:false,result:{status:'cancelled',job:null}}as any)},true);t.after(()=>cancelled.app.close());
 await cancelled.app.inject({method:'POST',url:'/v1/model-inference/jobs',headers:cancelled.headers,payload:r});assert.deepEqual(cancelled.gatewayCalls,[]);
 const pc=await fixture(true,{createInvocation:async()=>({replayed:false,result:{status:'queued',job:{state:'queued'}}}as any)},true);t.after(()=>pc.app.close());
 const {digest:_digest,...unsigned}=r;const computer=await prepareModelInferenceRequest({...unsigned,target:{kind:'computer',deviceId:randomUUID()}});await pc.app.inject({method:'POST',url:'/v1/model-inference/jobs',headers:pc.headers,payload:computer});assert.deepEqual(pc.gatewayCalls,[]);
});
test('computer completion validates exact lease and output; failure cannot impersonate server lease expiry',async t=>{
 const f=await fixture();t.after(()=>f.app.close());const id=randomUUID(),lease={fence:randomUUID()},output=await prepareModelInferenceOutput({text:'Known result',usage:null,reportedModel:null,finishReason:'stop',redacted:false});
 assert.equal((await f.app.inject({method:'POST',url:'/v1/model-inference/jobs/'+id+'/complete',headers:f.headers,payload:{lease,output}})).statusCode,200);assert.equal(f.calls[0].name,'completeComputer');assert.deepEqual(f.calls[0].args.slice(1),[id,lease,output]);
 assert.equal((await f.app.inject({method:'POST',url:'/v1/model-inference/jobs/'+id+'/complete',headers:f.headers,payload:{lease,output:{...output,text:'tampered'}}})).statusCode,400);
 for(const code of ['LEASE_EXPIRED','SESSION_REVOKED','EXPIRED','raw secret'])assert.equal((await f.app.inject({method:'POST',url:'/v1/model-inference/jobs/'+id+'/fail',headers:f.headers,payload:{lease,code}})).statusCode,400);
 assert.equal(f.calls.length,1);
});
test('explicit cancellation and recovery use verified account and never dispatch upstream',async t=>{
 const f=await fixture(true,{},true);t.after(()=>f.app.close());const id=randomUUID();
 for(const [method,path]of [['POST','/requests/'+id+'/cancel'],['POST','/jobs/'+id+'/recover'],['GET','/jobs/'+id+'/recovery/candidate'],['DELETE','/jobs/'+id+'/recovery']]as const)assert.equal((await f.app.inject({method,url:'/v1/model-inference'+path,headers:f.headers,...(method==='POST'?{payload:{}}:{})})).statusCode,200);
 assert.deepEqual(f.gatewayCalls,['cancel','retrySave','candidate','observe','forget']);assert.equal(f.calls[0].args[0],f.who);
});
test('disabled gateway recovery is explicit without silent fallback',async t=>{
 const f=await fixture();t.after(()=>f.app.close());
 const r=await f.app.inject({method:'POST',url:'/v1/model-inference/jobs/'+randomUUID()+'/dispatch',headers:f.headers,payload:{}});assert.equal(r.statusCode,503);assert.equal(r.json().error.code,'MODEL_GATEWAY_UNAVAILABLE');assert.deepEqual(f.calls,[]);
});
