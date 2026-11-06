import assert from 'node:assert/strict';import {test} from 'node:test';
import {SyncApi} from '../src/api.ts';import {FeatureInspector} from '../src/capabilities/inspector.ts';
import {enabled,remote,now} from './fixtures/featureCapabilities.ts';
const base='https://sync.example.test',capability={protocolVersion:1,features:{remoteTasks:1},remoteTasks:remote};
function gate<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
const context={apiBaseUrl:base,getAccessToken:async()=>'synthetic-offline-credential',getCapability:()=>remote,identityKey:()=> 'synthetic-owner'};
test('actual inspector only reads fixed service declarations, provider profiles and a non-reserving request lookup',async t=>{
 const calls:{url:string;method:string}[]=[];const fetcher=async(url:any,options?:RequestInit)=>{const path=String(url);calls.push({url:path,method:options?.method??'GET'});assert.equal(options?.redirect,'error');assert.equal(options?.credentials,'omit');
  if(path===base+'/v1/capabilities')return Response.json(capability);if(path===base+'/v1/remote-tasks/providers')return Response.json({providers:enabled().inspection.providers});
  const id=path.split('/').at(-1);assert.match(path,/\/v1\/remote-tasks\/requests\/[0-9a-f-]+$/);return Response.json({requestId:id,status:'absent',task:null});};
 t.mock.method(globalThis,'fetch',fetcher);const api=new SyncApi(base,context.getAccessToken,fetcher),inspector=new FeatureInspector({readService:s=>api.inspectCapabilities(s),remote:context,current:()=>true,now:()=>now});t.after(()=>inspector.dispose());assert.equal(calls.length,0);
 await inspector.inspect();const result=inspector.getSnapshot();assert.equal(result.status,'ready');assert.equal(result.providers.length,1);assert.equal(result.batch,'supported');assert.equal(calls.length,3);assert.ok(calls.every(c=>c.method==='GET'));await inspector.inspect();assert.equal(calls.length,6);
});
test('provider failure and unsupported batch routes retain service declarations with distinct partial evidence',async t=>{
 t.mock.method(globalThis,'fetch',async(url:any)=>String(url).endsWith('/providers')?Response.json({error:{code:'AUTHENTICATION_REQUIRED'}},{status:401}):Response.json({error:{code:'NOT_FOUND'}},{status:404}));
 const inspector=new FeatureInspector({readService:async()=>enabled().inspection.service!,remote:context,current:()=>true});t.after(()=>inspector.dispose());await inspector.inspect();const result=inspector.getSnapshot();assert.equal(result.status,'ready');assert.ok(result.service!.remoteTasks);assert.equal(result.providers.length,0);assert.match(result.providersError,/登录/);assert.equal(result.batch,'unsupported');
});
test('non-cooperative service reads are bounded and late results cannot restore a stopped or superseded screen',async t=>{
 const first=gate<ReturnType<typeof enabled>['inspection']['service']>();let calls=0,current=true;const inspector=new FeatureInspector({readService:()=>{calls++;return first.promise as any;},current:()=>current,timeoutMs:20});t.after(()=>inspector.dispose());await inspector.inspect();assert.equal(inspector.getSnapshot().status,'error');assert.equal(inspector.getSnapshot().service,null);
 first.resolve(enabled().inspection.service);await Promise.resolve();assert.equal(inspector.getSnapshot().status,'error');assert.equal(calls,1);
});
test('stop and account A-B-A dispose retire old callbacks without starting another request automatically',async t=>{
 const old=gate<any>();let reads=0;const inspector=new FeatureInspector({readService:()=>{reads++;return reads===1?old.promise:Promise.resolve(enabled().inspection.service!);},current:()=>true});t.after(()=>inspector.dispose());const pending=inspector.inspect();inspector.stop();assert.equal(inspector.getSnapshot().status,'idle');await inspector.inspect();assert.equal(inspector.getSnapshot().status,'ready');inspector.dispose();inspector.activate();old.resolve({paperOrganization:false,richNotes:false,aiConversations:false,cloudPdf:null,desktopPdf:null,remoteTasks:null});await pending;assert.equal(inspector.getSnapshot().status,'idle');assert.equal(reads,2);
});
test('an owner change while reading makes the late result unavailable to the replacement owner',async t=>{
 const old=gate<any>();let current=true;const inspector=new FeatureInspector({readService:()=>old.promise,current:()=>current});t.after(()=>inspector.dispose());const pending=inspector.inspect();current=false;old.resolve(enabled().inspection.service);await pending;assert.equal(inspector.getSnapshot().service,null);
});
