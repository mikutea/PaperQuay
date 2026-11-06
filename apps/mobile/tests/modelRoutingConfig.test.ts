import assert from'node:assert/strict';import test from'node:test';import{randomUUID}from'node:crypto';
import{defaultAiProvider,parseAiProvider,validateAiModelExecution,LocalAiConfigStore}from'../src/ai/provider.ts';
import{createModelRouteProvider,assertModelRouteScope}from'../src/modelRouting/config.ts';
import type{ModelInferenceProfile}from'../../../packages/sync-core/src/modelInference.ts';
const scope=()=>({apiBaseUrl:'https://sync.fixture.test',accountId:randomUUID()}),profile=():ModelInferenceProfile=>({id:'chat-default',revision:1,digest:'a'.repeat(64),kind:'chat',model:'synthetic-chat',maxInputBytes:192*1024,maxOutputTokens:2048,stream:false});
const external=()=>({...defaultAiProvider(),endpoint:'https://external.fixture.test/v1',model:'my-external-model'});
function memory(){const values=new Map<string,string>();return{values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
test('private remote config has a deterministic scope/profile identity and never requires a client model key or fabricated stream',async()=>{
 const account=scope(),p=profile(),a=await createModelRouteProvider(account,{kind:'gateway'},p),again=await createModelRouteProvider(account,{kind:'gateway'},p);
 assert.deepEqual(a,again);assert.match(a.id,/^remote_[0-9a-f]{40}$/);assert.equal(a.endpoint,account.apiBaseUrl+'/v1/model-inference');assert.equal(a.requiresKey,false);assert.equal(a.stream,false);assert.equal(a.includeUsage,false);assert.equal(a.tokenParameter,'max_tokens');assert.deepEqual(assertModelRouteScope(account,a),a);
 const changed=await createModelRouteProvider({...account,accountId:randomUUID()},{kind:'gateway'},p);assert.notEqual(a.id,changed.id);const pc=await createModelRouteProvider(account,{kind:'computer',deviceId:randomUUID()},p);assert.notEqual(pc.id,a.id);assert.equal(pc.execution!.target.kind,'computer');
});
test('remote provider construction detaches target, profile and service before awaiting its fingerprint',async()=>{
 const account=scope(),p=profile(),target={kind:'computer' as const,deviceId:randomUUID()},original=structuredClone({account,p,target}),pending=createModelRouteProvider(account,target,p);p.model='late-change';target.deviceId=randomUUID();account.apiBaseUrl='https://changed.fixture.test';const result=await pending;assert.equal(result.model,original.p.model);assert.deepEqual(result.execution!.target,original.target);assert.equal(result.endpoint,original.account.apiBaseUrl+'/v1/model-inference');
});
test('remote config is bound to the current account service and exact nonstreaming execution contract',async()=>{
 const account=scope(),p=profile(),good=await createModelRouteProvider(account,{kind:'gateway'},p);
 for(const patch of [{stream:true},{includeUsage:true},{requiresKey:true},{tokenParameter:'max_completion_tokens'},{id:'primary'},{endpoint:'https://external.fixture.test/v1'},{model:''}])assert.throws(()=>parseAiProvider({...good,...patch}),{code:'CONFIG_INVALID'});
 assert.throws(()=>assertModelRouteScope({...account,apiBaseUrl:'https://other.fixture.test'},good),{code:'CONFIG_INVALID'});
 await assert.rejects(createModelRouteProvider(account,{kind:'gateway'},p,2049),{code:'CONFIG_INVALID'});await assert.rejects(createModelRouteProvider(account,{kind:'gateway'},p,63),{code:'CONFIG_INVALID'});
});
test('execution references reject transport authority, unknown fields, accessors and changed identities',async()=>{
 const account=scope(),good=(await createModelRouteProvider(account,{kind:'gateway'},profile())).execution!;
 for(const value of [{...good,endpoint:'https://private.fixture.test'},{...good,target:{kind:'gateway',apiKey:'secret'}},{...good,target:{kind:'computer',deviceId:'bad'}},{...good,profileRef:{...good.profileRef,revision:0}},{...good,profileRef:{...good.profileRef,digest:'BAD'}},{...good,version:2}])assert.throws(()=>validateAiModelExecution(value),{code:'CONFIG_INVALID'});
 let invoked=false;const getter=Object.defineProperty({...good},'target',{enumerable:true,get(){invoked=true;return good.target;}});assert.throws(()=>validateAiModelExecution(getter),{code:'CONFIG_INVALID'});assert.equal(invoked,false);
 const config=external(),withGetter=Object.defineProperty({...config},'endpoint',{enumerable:true,get(){invoked=true;return config.endpoint;}});assert.throws(()=>parseAiProvider(withGetter),{code:'CONFIG_INVALID'});assert.equal(invoked,false);
});
test('legacy external configurations remain byte-compatible and do not acquire a private execution field',()=>{
 const config=external(),parsed=parseAiProvider(config,true);assert.deepEqual(parsed,config);assert.equal(Object.hasOwn(parsed,'execution'),false);assert.equal(JSON.stringify(parsed),JSON.stringify(config));
 assert.throws(()=>parseAiProvider({...config,execution:undefined}),{code:'CONFIG_INVALID'});assert.throws(()=>parseAiProvider({...config,apiKey:'must-not-persist'}),{code:'CONFIG_INVALID'});
});
test('explicit remote switches preserve public external settings and never copy model keys into the configuration store',async()=>{
 const account=scope(),storage=memory(),store=new LocalAiConfigStore(storage),direct=external(),remote=await createModelRouteProvider(account,{kind:'gateway'},profile());store.save(account,direct);store.save(account,remote);assert.deepEqual(store.load(account),remote);assert.deepEqual(store.loadExternal(account),direct);
 const pc=await createModelRouteProvider(account,{kind:'computer',deviceId:randomUUID()},profile());store.save(account,pc);assert.deepEqual(store.loadExternal(account),direct);store.save(account,store.loadExternal(account));assert.deepEqual(store.load(account),direct);assert(![...storage.values.values()].some(value=>value.includes('apiKey')));
 const other={...account,accountId:randomUUID()};assert.deepEqual(store.load(other),defaultAiProvider());assert.deepEqual(store.loadExternal(other),defaultAiProvider());
});
test('failed public sidecar persistence cannot activate a remote route or replace the current external config',async()=>{
 const account=scope(),storage=memory(),store=new LocalAiConfigStore(storage),direct=external();store.save(account,direct);const remote=await createModelRouteProvider(account,{kind:'gateway'},profile()),failed=new LocalAiConfigStore({...storage,setItem:(key:string,value:string)=>{if(key.includes('external.'))throw Error('Disk failure');storage.setItem(key,value);}});assert.throws(()=>failed.save(account,remote),{code:'SETTINGS_STORAGE_FAILED'});assert.deepEqual(store.load(account),direct);
});

test('legacy external-only users persist one public config key without introducing a sidecar dependency',()=>{
 const account=scope(),storage=memory(),writes:string[]=[],store=new LocalAiConfigStore({...storage,setItem:(key,value)=>{writes.push(key);storage.setItem(key,value);}}),direct=external();store.save(account,direct);store.save(account,{...direct,model:'updated'});
 assert.equal(writes.length,2);assert.equal(new Set(writes).size,1);assert(!writes.some(k=>k.includes('external.')));assert.equal(storage.values.size,1);
});
