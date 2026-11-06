import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { verifyParsedDocument } from '../../../packages/sync-core/src/parsedDocument.ts';
import { validateRemoteTask, validateRemoteTaskQuota, validateRemoteTaskProvider, type RemoteTask, type RemoteTaskCapability } from '../../../packages/sync-core/src/remoteTasks.ts';
import { RemoteTaskClient, RemoteTaskError, type RemoteTaskContext } from '../src/remote/client.ts';
const capability:RemoteTaskCapability={protocolVersion:1,transport:'persistent-jobs-v1',maxArtifactBytes:16777216,maxAccountArtifactBytes:67108864,maxActive:1,maxQueued:16,maxRetained:200,maxReceipts:2000,maxProfiles:8,leaseSeconds:60,providerPresenceSeconds:45};
const quota={active:0,queued:1,retained:1,receipts:1,artifactBytes:0,maxActive:1,maxQueued:16,maxRetained:200,maxReceipts:2000,maxArtifactBytes:67108864};
const profile={id:'mineru',revision:1,digest:'b'.repeat(64),kind:'parse' as const,model:'vlm'};
const key='synthetic-session-credential-never-live';
function job():RemoteTask{return{id:randomUUID(),kind:'parse',state:'queued',target:{paperId:randomUUID(),attachmentVersionId:randomUUID(),paperRevision:1,versionRevision:1,sha256:'a'.repeat(64),sizeBytes:512,pageCount:1,fileName:'合成.pdf'},providerDeviceId:randomUUID(),profile,indexSourceDigest:null,recoveryProviderDeviceId:null,attempt:0,createdAt:'2026-10-28T00:00:00.000Z',updatedAt:'2026-10-28T00:00:00.000Z',leaseExpiresAt:null,failure:null,artifact:null};}
async function serve(t:any,handler:(request:IncomingMessage,response:ServerResponse)=>void|Promise<void>){
  const server=createServer((req,res)=>{void Promise.resolve(handler(req,res)).catch(()=>res.destroy());});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});return`http://127.0.0.1:${address.port}`;
}
function json(response:ServerResponse,value:unknown){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value));}
const context=(base:string):RemoteTaskContext=>({apiBaseUrl:base,getAccessToken:async()=>key,getCapability:()=>capability,identityKey:()=> 'synthetic-account'});
const expected=(code:string)=>(error:unknown)=>error instanceof RemoteTaskError&&error.code===code&&!JSON.stringify(error).includes(key);
async function body(request:IncomingMessage){const parts:Buffer[]=[];for await(const part of request)parts.push(Buffer.from(part));return JSON.parse(Buffer.concat(parts).toString());}

test('mobile remote client uses real scoped HTTP, closed DTOs and the same explicit request ID for replay',async t=>{
  const task=job(),received:any[]=[];
  const base=await serve(t,async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+key);
    if(req.url==='/v1/remote-tasks/providers')return json(res,{providers:[{deviceId:task.providerDeviceId,profiles:[profile],expiresAt:'2026-10-28T00:01:00.000Z'}]});
    if(req.method==='POST'){const value=await body(req);received.push(value);return json(res,{task:{...task,id:value.requestId},replayed:received.length>1,deduplicated:false,quota});}
    json(res,{tasks:[task],quota});
  });
  const client=new RemoteTaskClient(context(base));assert.equal((await client.providers()).length,1);assert.equal((await client.list()).tasks[0].target.fileName,'合成.pdf');
  const request={requestId:randomUUID(),kind:'parse' as const,versionId:task.target.attachmentVersionId,providerDeviceId:task.providerDeviceId,profileRef:{id:profile.id,revision:1,digest:profile.digest}};
  assert.equal((await client.create(request)).replayed,false);assert.equal((await client.create(request)).replayed,true);assert.deepEqual(received,[request,request]);
});
test('artifact download verifies canonical bytes, digest, parser model and current PDF target before returning data',async t=>{
  const task=job(),parsed=await verifyParsedDocument({format:'paperquay-parsed-document',version:1,paperId:task.target.paperId,attachmentVersionId:task.target.attachmentVersionId,
    pdf:{sha256:task.target.sha256,sizeBytes:512,pageCount:1},parser:{name:'mineru',model:'vlm'},blocks:[{id:'text',pageIndex:0,kind:'text',text:'已核验合成正文'}],assets:[]});
  const bytes=Buffer.from(JSON.stringify(parsed.document));task.state='succeeded';task.attempt=1;task.artifact={digest:parsed.digest,sizeBytes:bytes.length,mediaType:'application/json'};
  let mode='valid';const base=await serve(t,(req,res)=>{
    assert.equal(req.headers.accept,'application/octet-stream');res.setHeader('Content-Type','application/octet-stream');res.setHeader('X-PaperQuay-Artifact-Digest',mode==='header'?'f'.repeat(64):parsed.digest);
    res.end(mode==='bytes'?Buffer.from(bytes).fill(65,10,12):bytes);
  });
  const client=new RemoteTaskClient(context(base));assert.deepEqual((await client.artifact(task)).document,parsed.document);
  mode='header';await assert.rejects(client.artifact(task),expected('INVALID_RESPONSE'));mode='bytes';await assert.rejects(client.artifact(task),expected('INVALID_RESPONSE'));mode='valid';
  await assert.rejects(client.artifact({...task,profile:{...task.profile,model:'another-model'}}),expected('INVALID_RESPONSE'));
  await assert.rejects(client.artifact({...task,target:{...task.target,sha256:'c'.repeat(64)}}),expected('INVALID_RESPONSE'));
});
test('account changes during credentials, disabled capability and non-cooperative transports are bounded before credential use',async()=>{
  let identity='A',resolve!:(value:string)=>void,calls=0;
  const secret=new Promise<string>(done=>{resolve=done;});
  const options:RemoteTaskContext={...context('https://sync.example.invalid'),getAccessToken:()=>secret,identityKey:()=>identity};
  const client=new RemoteTaskClient(options,async()=>{calls++;throw new Error('must not send');});
  const pending=assert.rejects(client.list(),expected('CHANGED'));identity='B';resolve(key);await pending;assert.equal(calls,0);
  await assert.rejects(new RemoteTaskClient({...options,getCapability:()=>null}).list(),expected('DISABLED'));
  const never=()=>new Promise<Response>(()=>{});
  await assert.rejects(new RemoteTaskClient(context('https://sync.example.invalid'),never,25).list(),expected('TIMEOUT'));
  await assert.rejects(new RemoteTaskClient({...options,identityKey:()=> 'B',getAccessToken:()=>new Promise<string>(()=>{})},never,25).list(),expected('TIMEOUT'));
});
test('actual cancellation closes a remote response socket and no provider-supplied URL is followed',async t=>{
  let opened!:()=>void,closed!:()=>void;
  const ready=new Promise<void>(resolve=>{opened=resolve;}),ended=new Promise<void>(resolve=>{closed=resolve;});
  const base=await serve(t,(req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{"tasks":[');opened();res.once('close',closed);});
  const controller=new AbortController(),client=new RemoteTaskClient(context(base));const pending=assert.rejects(client.list({signal:controller.signal}),expected('CANCELLED'));
  await ready;controller.abort();await pending;await Promise.race([ended,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('response socket did not close')),1000))]);
  const malicious=await serve(t,(_req,res)=>json(res,{providers:[{deviceId:randomUUID(),profiles:[profile],expiresAt:'2026-10-28T00:01:00.000Z',url:'https://attacker.example.invalid'}]}));
  await assert.rejects(new RemoteTaskClient(context(malicious)).providers(),expected('INVALID_RESPONSE'));
});
test('redirects do not forward the service Bearer and malformed/oversized JSON cannot become trusted task state',async t=>{
  let leaked=0;const other=await serve(t,(_req,res)=>{leaked++;json(res,{tasks:[],quota});});
  const redirect=await serve(t,(_req,res)=>{res.writeHead(307,{Location:other+'/capture'});res.end();});
  await assert.rejects(new RemoteTaskClient(context(redirect)).list(),expected('NETWORK'));assert.equal(leaked,0);
  const oversize=async()=>new Response('secret reflected '+key,{headers:{'content-length':String(2*1024*1024+1)}});
  await assert.rejects(new RemoteTaskClient(context('https://sync.example.invalid'),oversize).list(),expected('INVALID_RESPONSE'));
  const sensitive=async()=>new Response(JSON.stringify({error:{code:'arbitrary '+key}}),{status:500});
  await assert.rejects(new RemoteTaskClient(context('https://sync.example.invalid'),sensitive).list(),expected('FAILED'));
});
test('shared public DTO validation rejects unknown authority, malformed chronology and impossible state while allowing a pre-claim interruption',()=>{
  const task=job();assert.deepEqual(validateRemoteTask(task),task);
  assert.equal(validateRemoteTask({...task,state:'interrupted',failure:'SESSION_REVOKED'}).attempt,0);
  for(const changed of [{...task,path:'C:\\private\\source.pdf'},{...task,state:'succeeded'},{...task,createdAt:'2026-10-29T00:00:00.000Z'},
    {...task,target:{...task.target,fileName:'../private.pdf'}},{...task,profile:{...task.profile,kind:'index'}}])assert.throws(()=>validateRemoteTask(changed));
  assert.throws(()=>validateRemoteTaskQuota({...quota,active:1,queued:1,retained:1}));
  assert.throws(()=>validateRemoteTaskProvider({deviceId:task.providerDeviceId,profiles:[profile],expiresAt:'invalid',apiKey:key}));
});

test('a lost creation response can replay the same immutable request after explicit provider handover without issuing another create identity',async t=>{
  const task=job(),old=task.providerDeviceId,newProvider=randomUUID(),received:any[]=[];let replay=false;
  let holder:string|null=old;
  const base=await serve(t,async(req,res)=>{const value=await body(req);received.push(value);json(res,{task:{...task,id:value.requestId,providerDeviceId:newProvider,recoveryProviderDeviceId:holder},replayed:replay,deduplicated:false,quota});});
  const client=new RemoteTaskClient(context(base)),request={requestId:randomUUID(),kind:'parse' as const,versionId:task.target.attachmentVersionId,providerDeviceId:old,profileRef:{id:profile.id,revision:1,digest:profile.digest}};
  await assert.rejects(client.create(request),expected('INVALID_RESPONSE'));
  replay=true;const result=await client.create(request);assert.equal(result.task.providerDeviceId,newProvider);assert.equal(result.task.recoveryProviderDeviceId,old);
  holder=null;assert.equal((await client.create(request)).task.recoveryProviderDeviceId,null);assert.deepEqual(received,[request,request,request]);
});

test('request lookup and cancellation use scoped read/cancel endpoints without a creation POST, preserve IDs and reject mismatched receipts',async t=>{
 const id=randomUUID(),calls:{method:string;url:string}[]=[],task=job();let bad=false;
 const base=await serve(t,async(req,res)=>{calls.push({method:req.method!,url:req.url!});assert.equal(req.headers.authorization,'Bearer '+key);
  if(req.method==='POST')assert.deepEqual(await body(req),{});json(res,{requestId:bad?randomUUID():id,status:req.method==='POST'?'cancelled':'known',task:req.method==='POST'?null:task});});
 const client=new RemoteTaskClient(context(base));assert.equal((await client.lookupRequest(id)).task!.id,task.id);assert.equal((await client.cancelRequest(id)).status,'cancelled');
 assert.deepEqual(calls,[{method:'GET',url:'/v1/remote-tasks/requests/'+id},{method:'POST',url:'/v1/remote-tasks/requests/'+id+'/cancel'}]);
 bad=true;await assert.rejects(client.lookupRequest(id),expected('INVALID_RESPONSE'));await assert.rejects(client.cancelRequest(id),expected('INVALID_RESPONSE'));
});
test('old service endpoints fail batch capability explicitly while absent/cancelled/removed are closed non-creating receipts',async()=>{
 const id=randomUUID();for(const status of ['absent','cancelled','removed']){
  const client=new RemoteTaskClient(context('https://sync.example.invalid'),async()=>Response.json({requestId:id,status,task:null}));assert.equal((await client.lookupRequest(id)).status,status);
  if(status==='absent')await assert.rejects(client.cancelRequest(id),expected('INVALID_RESPONSE'));
 }
 const old=new RemoteTaskClient(context('https://sync.example.invalid'),async()=>Response.json({error:{code:'NOT_FOUND'}},{status:404}));
 await assert.rejects(old.lookupRequest(id),expected('BATCH_UNSUPPORTED'));await assert.rejects(old.cancelRequest(id),expected('BATCH_UNSUPPORTED'));
 const reserved=new RemoteTaskClient(context('https://sync.example.invalid'),async()=>Response.json({error:{code:'REMOTE_TASK_REQUEST_CANCELLED'}},{status:410}));
 await assert.rejects(reserved.create({requestId:id,kind:'parse',versionId:randomUUID(),providerDeviceId:randomUUID(),profileRef:{id:profile.id,revision:1,digest:profile.digest}}),expected('REQUEST_CANCELLED'));
});
