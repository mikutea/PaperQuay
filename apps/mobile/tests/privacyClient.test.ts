import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {AccountPrivacyClient,ClosureIntentStore,privacyStatus,type ClosureRequest} from '../src/privacy/client.ts';

const accountId=randomUUID(),scope={apiBaseUrl:'https://service.example.test',accountId};
const active={accountId,state:'active',closedAt:null,closureRequestId:null,
  deviceErasure:{requested:false,pending:0,acknowledged:0,thisDevicePending:false}};
const request=():ClosureRequest=>({accountId,requestId:randomUUID(),confirmation:'注销 '+accountId,deleteCloudCopies:true,eraseDevices:true});
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});}
function context(fetcher:typeof fetch){let key:string|null='owner-a';const listeners=new Set<()=>void>();
  const client=new AccountPrivacyClient({...scope,getAccessToken:async()=> 'synthetic-bearer',getIdentityKey:()=>key,
    subscribeIdentity:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},fetcher});
  return {client,setKey:(next:string|null)=>{key=next;for(const listener of listeners)listener();}};}

test('privacy status validates closure receipts and pending erasure without accepting contradictory active state',()=>{
  assert.deepEqual(privacyStatus(active),active);
  const closed={...active,state:'closed',closedAt:new Date().toISOString(),closureRequestId:randomUUID(),
    deviceErasure:{requested:true,pending:2,acknowledged:0,thisDevicePending:true}};
  assert.deepEqual(privacyStatus(closed),closed);
  for(const value of[{...active,closedAt:closed.closedAt},{...closed,closureRequestId:null},
    {...closed,deviceErasure:{...closed.deviceErasure,pending:0}},
    {...closed,deviceErasure:{...closed.deviceErasure,pending:1001}}])assert.throws(()=>privacyStatus(value),{code:'INVALID'});
});

test('private requests omit cookies, reject redirects and forward only the exact explicit closure request once',async()=>{
  const seen:{url:string;options?:RequestInit}[]=[],r=request();
  const ctx=context(async(input,options)=>{seen.push({url:String(input),options});return json({...active,state:'closed',closedAt:new Date().toISOString(),closureRequestId:r.requestId});});
  try{await ctx.client.close(r,new AbortController().signal);assert.equal(seen.length,1);
    assert.equal(seen[0].url,scope.apiBaseUrl+'/v1/privacy/close');assert.equal(seen[0].options?.credentials,'omit');
    assert.equal(seen[0].options?.redirect,'error');assert.equal(seen[0].options?.cache,'no-store');
    assert.deepEqual(JSON.parse(String(seen[0].options?.body)),r);
  }finally{ctx.client.dispose();}
});

test('A to B to A invalidates a late status response even when the final subject key matches',async()=>{
  let resolve!:(value:Response)=>void;const pending=new Promise<Response>(done=>{resolve=done;});
  const ctx=context(async()=>pending),result=ctx.client.status(new AbortController().signal);
  await new Promise(done=>setImmediate(done));ctx.setKey('owner-b');ctx.setKey('owner-a');
  await assert.rejects(result,{code:'CHANGED'});resolve(json(active));ctx.client.dispose();
});

test('a failed closure connection remains unknown and cannot automatically issue a second POST',async()=>{
  let calls=0;const ctx=context(async()=>{calls++;throw new TypeError('synthetic network failure');});
  try{await assert.rejects(ctx.client.close(request(),new AbortController().signal),{code:'OUTCOME_UNKNOWN'});assert.equal(calls,1);}
  finally{ctx.client.dispose();}
});

test('failed preparation or a rejected export cleans up its unshared temporary destination',async()=>{
  for(const mode of['no-auth','http-error','bad-type']){
    const ctx=context(async()=>mode==='http-error'?json({error:{code:'EXPORT_BUSY'}},409):json(active));
    if(mode==='no-auth')ctx.setKey(null);let aborted=0,finished=0;
    try{await assert.rejects(ctx.client.exportData(scope,{write:async()=>{},finish:async()=>{finished++;return 'saved';},abort:async()=>{aborted++;}},new AbortController().signal));
      assert.equal(aborted,1);assert.equal(finished,0);
    }finally{ctx.client.dispose();}
  }
});

test('closure intents are durable, scoped, secret-free and retain the same UUID across a restart',()=>{
  const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
  const r=request(),store=new ClosureIntentStore(storage);store.save(scope,r);
  assert.deepEqual(new ClosureIntentStore(storage).read(scope),r);
  assert.equal(store.read({...scope,accountId:randomUUID()}),null);
  assert.equal(store.read({...scope,apiBaseUrl:'https://other.example.test'}),null);
  assert.throws(()=>store.save(scope,{...r,requestId:randomUUID()}),{code:'OUTCOME_UNKNOWN'});
  assert.throws(()=>store.save(scope,{...r,apiKey:'must-never-persist'} as ClosureRequest),{code:'INVALID'});
  assert(![...values.values()].join('').includes('must-never-persist'));
  store.save(scope,{eraseDevices:r.eraseDevices,deleteCloudCopies:true,confirmation:r.confirmation,requestId:r.requestId,accountId:r.accountId});
  store.remove(scope);assert.equal(store.read(scope),null);
});

test('erasure waits for an in-flight server export destination to abort and permits only explicit original-session status and ACK',async()=>{
  let release!:()=>void,entered!:()=>void,aborting!:()=>void;
  const writeEntered=new Promise<void>(resolve=>{entered=resolve;}),abortEntered=new Promise<void>(resolve=>{aborting=resolve;});
  const aborted=new Promise<void>(resolve=>{release=resolve;});let calls=0,finished=0,sealed=false;
  const header=new TextEncoder().encode(JSON.stringify({kind:'header',format:'paperquay-personal-data',version:1,accountId,
    consistency:'repeatable-read',scope:'application-server'})+'\n');
  const ctx=context(async(input,options)=>{
    calls++;const url=String(input);
    if(url.endsWith('/export'))return new Response(new ReadableStream({start(controller){controller.enqueue(header);}}),{headers:{'Content-Type':'application/x-ndjson'}});
    assert.equal((options?.headers as Record<string,string>).Authorization,'Bearer original-peer-token');
    return url.endsWith('/status')?json(active):json({acknowledged:true});
  });
  let finishWrite!:()=>void;const write=new Promise<void>(resolve=>{finishWrite=resolve;});
  const exporting=assert.rejects(ctx.client.exportData(scope,{write:async()=>{entered();await write;},finish:async()=>{finished++;return 'saved';},
    abort:async()=>{aborting();await aborted;}},new AbortController().signal));
  try {
    await writeEntered;const sealing=ctx.client.sealForErasure().then(()=>{sealed=true;});
    finishWrite();await abortEntered;await new Promise(done=>setImmediate(done));assert.equal(sealed,false);assert.equal(finished,0);
    await assert.rejects(ctx.client.status(new AbortController().signal),{code:'AUTH_REQUIRED'});
    await assert.rejects(ctx.client.close(request(),new AbortController().signal),{code:'AUTH_REQUIRED'});assert.equal(calls,1);
    release();await exporting;await sealing;assert.equal(sealed,true);
    assert.deepEqual(await ctx.client.status(new AbortController().signal,'original-peer-token'),active);
    await ctx.client.acknowledge(randomUUID(),new AbortController().signal,'original-peer-token');assert.equal(calls,3);
  }finally{release();finishWrite();ctx.client.dispose();}
});

test('the erasure-only business fence belongs to the original authentication epoch and does not block a replacement login',async()=>{
  let calls=0;const ctx=context(async()=>{calls++;return json(active);});
  try{
    const former=ctx.client.captureIdentity();await ctx.client.sealForErasure();
    await assert.rejects(ctx.client.status(new AbortController().signal),{code:'AUTH_REQUIRED'});assert.equal(calls,0);
    ctx.setKey('owner-b');assert.deepEqual(await ctx.client.status(new AbortController().signal),active);
    ctx.setKey('owner-a');assert.equal(former(),false);assert.deepEqual(await ctx.client.status(new AbortController().signal),active);assert.equal(calls,2);
  }finally{ctx.client.dispose();}
});
