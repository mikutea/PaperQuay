import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import * as core from '../packages/sync-core/src/modelInference.ts';
import {canonicalJson} from '../packages/sync-core/src/validation.ts';
import {MODEL_INFERENCE_CAPABILITY} from '../server/src/model-inference.ts';
const require=createRequire(import.meta.url),{createDesktopModels}=require('../electron/backend/desktopModels.cjs'),{createModelJournal}=require('../electron/backend/modelInferenceStorage.cjs');
const secure={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'test-vault',encryptString:(s:string)=>Buffer.from('TEST-SEALED:'+Buffer.from(s).toString('base64')),decryptString:(b:Buffer)=>Buffer.from(b.toString().slice(12),'base64').toString()};
async function fixture(t:import('node:test').TestContext){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'paperquay-desktop-models-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const base:any={config:{apiBaseUrl:'https://sync.fixture.test'},account:{accountId:randomUUID(),deviceId:randomUUID()},epoch:1,library:{libraryBindingId:randomUUID(),anchor:{identity:'Synthetic library'}}},configuration:any={settings:{},secrets:{qaModelPresets:[{id:'selected',label:'My selected model',baseUrl:'https://private.fixture.test/v1',model:'synthetic',apiKey:'synthetic-private-key',apiMode:'chat_completions'},{id:'responses',label:'Unsupported protocol',baseUrl:'https://private.fixture.test/v1',model:'synthetic-responses',apiKey:'private-responses-key',apiMode:'responses'}]}},calls:any[]=[],managers:any[]=[];let ensure:(()=>Promise<void>)=async()=>{};
 const context={appPaths:{configPath:path.join(root,'reader-config.json')}},scope=()=>({service:base.config.apiBaseUrl,accountId:base.account.accountId,deviceId:base.account.deviceId,libraryId:base.library.libraryBindingId});
 const check=(c:any)=>{if(c.epoch!==base.epoch||c.account.accountId!==base.account?.accountId||c.account.deviceId!==base.account?.deviceId||c.library.libraryBindingId!==base.library.libraryBindingId)throw Object.assign(Error('DESKTOP_OPERATION_CANCELLED'),{code:'DESKTOP_OPERATION_CANCELLED'});};
 const create=()=>{const m=createDesktopModels(context,{core,secure,manual:true,getContext:()=>structuredClone(base),checkContext:check,readConfiguration:async()=>structuredClone(configuration),ensureTokenLifetime:async()=>ensure(),api:async(_snapshot:any,input:any)=>{calls.push(input);if(input.path.endsWith('/claim'))return{claim:null};if(input.path.endsWith('/fail'))return{job:{...pendingClaim.job,state:'uncertain',leaseExpiresAt:null,failure:'OUTCOME_UNKNOWN'}};return{};},withdrawPresence:async(s:any)=>{calls.push({withdraw:s});}});m.setCapability(MODEL_INFERENCE_CAPABILITY);managers.push(m);return m;};
 let pendingClaim:any;const row=async()=>{const s=scope(),profile={id:'chat-default',revision:1,digest:'a'.repeat(64),kind:'chat',model:'synthetic',maxInputBytes:192*1024,maxOutputTokens:2048,stream:false},request=await core.prepareModelInferenceRequest({id:randomUUID(),target:{kind:'computer',deviceId:s.deviceId},profileRef:{id:profile.id,revision:1,digest:profile.digest},model:profile.model,messages:[{role:'user',content:'Synthetic recovery prompt'}],maxOutputTokens:1024}),at=new Date().toISOString();pendingClaim={request,lease:{fence:randomUUID()},job:{id:request.id,state:'running',target:request.target,profile,requesterDeviceId:randomUUID(),inputDigest:request.digest,inputBytes:Buffer.byteLength(canonicalJson(request)),outputBytes:0,outputDigest:null,createdAt:at,updatedAt:at,leaseExpiresAt:new Date(Date.now()+60000).toISOString(),failure:null}};return{id:request.id,deviceId:s.deviceId,claim:pendingClaim,stage:'intent',outcome:null,createdAt:at};};
 t.after(async()=>{for(const m of managers){await m.stop();await m.settled();}});
 return{root,base,configuration,calls,create,scope,row,setEnsure:(f:()=>Promise<void>)=>{ensure=f;},journal:createModelJournal(path.join(root,'account-sync','model-inference','journal'),{core,secure})};
}
const enable=async(m:any)=>{await m.refreshStatus();return m.setEnabled({enabled:true,consent:true,configurationToken:m.status().configurationToken,presetId:'selected'});};
test('desktop model provider is off by default, requires concrete consent and needs no published PDF binding',async t=>{
 const f=await fixture(t),m=f.create();await m.refreshStatus();assert.equal(m.status().enabled,false);assert.equal(f.calls.length,0);assert.deepEqual(m.status().presets.map((p:any)=>p.id),['selected']);assert(!JSON.stringify(m.status()).includes('synthetic-private-key'));assert(!JSON.stringify(m.status()).includes('https://private.fixture.test'));
 await assert.rejects(m.setEnabled({enabled:true,consent:false,configurationToken:m.status().configurationToken,presetId:'selected'}),{code:'DESKTOP_ARGUMENT_INVALID'});await enable(m);assert.equal(m.status().enabled,true);assert.equal(f.calls[0].method,'PUT');assert.equal(f.calls[0].body.profiles[0].kind,'chat');await enable(m);assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
});
test('model credential profile epoch survives restart and rotates when private keys change',async t=>{
 const f=await fixture(t),first=f.create();await enable(first);const profile=first.status().profiles[0];await first.stop();const reopened=f.create();await enable(reopened);assert.deepEqual(reopened.status().profiles[0],profile);await reopened.stop();f.configuration.secrets.qaModelPresets[0].apiKey='new-private-key';const rotated=f.create();await enable(rotated);assert.notEqual(rotated.status().profiles[0].digest,profile.digest);assert.equal(rotated.status().profiles[0].revision,profile.revision+1);assert(!JSON.stringify(rotated.status()).includes('new-private-key'));
});
test('unrelated settings preserve consented execution while selected private changes stop before configuration is written',async t=>{
 const f=await fixture(t),m=f.create();await enable(m);await m.configurationWillChange(JSON.stringify({...f.configuration,leftSidebarCollapsed:true}));assert.equal(m.status().enabled,true);
 const oldToken=m.status().configurationToken,changed=structuredClone(f.configuration);changed.secrets.qaModelPresets[0].apiKey='rotated';await m.configurationWillChange(JSON.stringify(changed));assert.equal(m.status().enabled,false);assert(f.calls.some(c=>c.withdraw));f.configuration.secrets=changed.secrets;await m.refreshStatus();await assert.rejects(m.setEnabled({enabled:true,consent:true,configurationToken:oldToken,presetId:'selected'}),{code:'MODEL_CONFIGURATION_CHANGED'});
});
test('capability withdrawal and library changes revoke the provider and rotate visible consent identity',async t=>{
 const f=await fixture(t),m=f.create();await enable(m);const old=m.status().configurationToken;f.base.library.libraryBindingId=randomUUID();await m.refreshStatus();assert.equal(m.status().enabled,false);assert.notEqual(m.status().configurationToken,old);await m.settled();await enable(m);m.setCapability(null);assert.equal(m.status().enabled,false);assert.deepEqual(m.status().presets,[]);assert.deepEqual(m.status().profiles,[]);await m.settled();
});
test('a stop during pending enable cannot start a provider after token verification returns',async t=>{
 const f=await fixture(t),m=f.create();let release!:()=>void,entered=false;f.setEnsure(async()=>{entered=true;await new Promise<void>(r=>{release=r;});});const pending=enable(m);for(let i=0;i<300&&!entered;i++)await new Promise(r=>setTimeout(r,2));assert(entered);const stopped=m.stop();release();await assert.rejects(pending,{code:'DESKTOP_OPERATION_CANCELLED'});await stopped;assert.equal(m.status().enabled,false);assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
});
test('insufficient token lifetime rejects model enable before profile publication',async t=>{
 const f=await fixture(t),m=f.create();f.setEnsure(async()=>{throw Object.assign(Error('AUTHENTICATION_REQUIRED'),{code:'AUTHENTICATION_REQUIRED'});});await assert.rejects(enable(m),{code:'AUTHENTICATION_REQUIRED'});assert.equal(f.calls.length,0);
});
test('local history and explicit unknown-outcome recovery work without a model key or provider publication',async t=>{
 const f=await fixture(t),m=f.create(),record=await f.row();await f.journal.put(f.scope(),record);f.configuration.secrets.qaModelPresets=[];
 assert.equal((await m.listRecords()).items[0].canRecover,true);assert.equal((await m.backup({id:record.id})).record.claim.request.messages[0].content,'Synthetic recovery prompt');await m.retrySave({id:record.id});assert.equal((await m.listRecords()).items[0].stage,'acknowledged');assert.equal(f.calls.filter(c=>c.method==='PUT'||c.path?.endsWith('/claim')).length,0);assert.equal(f.calls.filter(c=>c.path?.endsWith('/fail')).length,1);
 await assert.rejects(m.clearAcknowledged({confirmed:false}),{code:'DESKTOP_ARGUMENT_INVALID'});assert.equal((await m.clearAcknowledged({confirmed:true})).removed,1);assert.deepEqual((await m.listRecords()).items,[]);
});
test('another account, library or device cannot adopt an original provider execution',async t=>{
 const f=await fixture(t),m=f.create(),record=await f.row();await f.journal.put(f.scope(),record);const original=structuredClone(f.base);
 f.base.account.accountId=randomUUID();f.base.epoch++;assert.deepEqual((await m.listRecords()).items,[]);await assert.rejects(m.backup({id:record.id}),{code:'MODEL_INFERENCE_NOT_FOUND'});Object.assign(f.base,structuredClone(original));f.base.account.deviceId=randomUUID();assert.equal((await m.listRecords()).items[0].canRecover,false);await assert.rejects(m.retrySave({id:record.id}),{code:'MODEL_BINDING_CHANGED'});assert.equal(f.calls.length,0);
});
