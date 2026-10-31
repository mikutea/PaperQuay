import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {createRequire} from 'node:module';
import * as core from '../packages/sync-core/src/modelInference.ts';
import {canonicalJson} from '../packages/sync-core/src/validation.ts';
const require=createRequire(import.meta.url),{createModelCredentialStore,createModelJournal,MODEL_JOURNAL_LIMITS}=require('../electron/backend/modelInferenceStorage.cjs'),nativeFs=require('../electron/backend/nativeFs.cjs');
async function fixture(t:import('node:test').TestContext){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'paperquay-model-storage-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const key=randomBytes(32),secure={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'test_authenticated_vault',encryptString:(s:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(s,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]);},decryptString:(bytes:Buffer)=>{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');}};
 const scope={service:'https://sync.fixture.test',accountId:randomUUID(),deviceId:randomUUID(),libraryId:randomUUID()},journal=createModelJournal(path.join(directory,'journal'),{core,secure});
 const claim=async(id=randomUUID())=>{const profile={id:'chat-default',revision:1,digest:'a'.repeat(64),kind:'chat' as const,model:'synthetic',maxInputBytes:192*1024,maxOutputTokens:2048,stream:false as const},request=await core.prepareModelInferenceRequest({id,target:{kind:'computer',deviceId:scope.deviceId},profileRef:{id:profile.id,revision:1,digest:profile.digest},model:profile.model,messages:[{role:'user',content:'Private synthetic prompt'}],maxOutputTokens:1024}),at=new Date().toISOString();return{request,lease:{fence:randomUUID()},job:{id,state:'running' as const,target:request.target,profile,requesterDeviceId:randomUUID(),inputDigest:request.digest,inputBytes:Buffer.byteLength(canonicalJson(request)),outputBytes:0,outputDigest:null,createdAt:at,updatedAt:at,leaseExpiresAt:new Date(Date.now()+60000).toISOString(),failure:null}};};
 const row=async()=>{const c=await claim();return{id:c.request.id,deviceId:scope.deviceId,claim:c,stage:'intent',outcome:null,createdAt:new Date().toISOString()};};
 return{directory,secure,scope,journal,row};
}
test('model journal uses authenticated encrypted native atomic files and reopens exact intents without execution',async t=>{
 const f=await fixture(t),record=await f.row();await f.journal.put(f.scope,record);
 const files=await fs.readdir(path.join(f.directory,'journal'));assert.equal(files.length,1);const bytes=await fs.readFile(path.join(f.directory,'journal',files[0]));assert(!bytes.includes(Buffer.from('Private synthetic prompt')));assert(!bytes.includes(Buffer.from(record.id)));
 const reopened=createModelJournal(path.join(f.directory,'journal'),{core,secure:f.secure});assert.deepEqual(await reopened.list(f.scope),[record]);
 const output=await core.prepareModelInferenceOutput({text:'Private synthetic received result',usage:null,reportedModel:null,finishReason:'stop',redacted:false});record.stage='outcome';(record as any).outcome={output};await reopened.put(f.scope,record);assert.deepEqual((await f.journal.list(f.scope))[0].outcome,{output});
});
test('credential epochs survive restart, rotate on private changes and contain no published key fingerprint',async t=>{
 const f=await fixture(t),dir=path.join(f.directory,'epoch'),store=createModelCredentialStore(dir,{secure:f.secure}),configuration={endpoint:'https://private.fixture.test/v1',model:'synthetic',apiKey:'synthetic-private-key'};
 const first=await store.update(f.scope,configuration),again=await createModelCredentialStore(dir,{secure:f.secure}).update(f.scope,configuration);assert.deepEqual(again,first);assert.deepEqual(Object.keys(first).sort(),['epoch','revision']);assert.equal(first.revision,1);
 const next=await store.update(f.scope,{...configuration,apiKey:'changed-private-key'});assert.notEqual(next.epoch,first.epoch);assert.equal(next.revision,2);assert.deepEqual(await store.update({...f.scope,deviceId:randomUUID()},{...configuration,apiKey:'changed-private-key'}),next);
 assert(!(await fs.readFile(path.join(dir,(await fs.readdir(dir))[0]))).includes(Buffer.from('synthetic-private-key')));
});
test('model journal isolates service, account and library while recording the original provider device',async t=>{
 const f=await fixture(t),row=await f.row();await f.journal.put(f.scope,row);
 for(const changed of [{accountId:randomUUID()},{libraryId:randomUUID()},{service:'https://other.fixture.test'}])assert.deepEqual(await f.journal.list({...f.scope,...changed}),[]);
 assert.equal((await f.journal.list({...f.scope,deviceId:randomUUID()}))[0].deviceId,f.scope.deviceId);
 await assert.rejects(f.journal.put({...f.scope,deviceId:randomUUID()},row),{code:'MODEL_BINDING_CHANGED'});
});
test('a received model result cannot change, downgrade or replace its request or execution fence',async t=>{
 const f=await fixture(t),row=await f.row(),output=await core.prepareModelInferenceOutput({text:'Known result',usage:null,reportedModel:null,finishReason:'stop',redacted:false});await f.journal.put(f.scope,row);const received={...row,stage:'outcome',outcome:{output}};await f.journal.put(f.scope,received);
 await assert.rejects(f.journal.put(f.scope,row),{code:'MODEL_INFERENCE_CHANGED'});await assert.rejects(f.journal.put(f.scope,{...received,claim:{...row.claim,lease:{fence:randomUUID()}}}),{code:'MODEL_INFERENCE_CHANGED'});
 const changed=await core.prepareModelInferenceOutput({text:'Changed result',usage:null,reportedModel:null,finishReason:'stop',redacted:false});await assert.rejects(f.journal.put(f.scope,{...received,outcome:{output:changed}}),{code:'MODEL_INFERENCE_CHANGED'});
 assert.equal((await f.journal.clearAcknowledged(f.scope)).removed,0);await f.journal.put(f.scope,{...received,stage:'acknowledged'});assert.equal((await f.journal.clearAcknowledged(f.scope)).removed,1);assert.deepEqual(await f.journal.list(f.scope),[]);
});
test('bounded model journal retains unconfirmed records until acknowledged cleanup and reserves a full row',async t=>{
 const f=await fixture(t);for(let i=0;i<MODEL_JOURNAL_LIMITS.records;i++)await f.journal.put(f.scope,await f.row());assert.deepEqual(await f.journal.capacity(f.scope),{retained:16,maxRetained:16});await assert.rejects(f.journal.put(f.scope,await f.row()),{code:'MODEL_LOCAL_CAPACITY'});assert.equal((await f.journal.clearAcknowledged(f.scope)).removed,0);
});
test('secure storage absence, plaintext backend and tampered ciphertext fail closed',async t=>{
 const f=await fixture(t);
 for(const secure of [{...f.secure,isEncryptionAvailable:()=>false},{...f.secure,getSelectedStorageBackend:()=> 'basic_text'}])await assert.rejects(createModelJournal(path.join(f.directory,'journal'),{core,secure}).list(f.scope),{code:'MODEL_SECURE_STORAGE_UNAVAILABLE'});
 await f.journal.put(f.scope,await f.row());const file=path.join(f.directory,'journal',(await fs.readdir(path.join(f.directory,'journal')))[0]),bytes=await fs.readFile(file);bytes[bytes.length-1]^=1;await fs.writeFile(file,bytes);await assert.rejects(f.journal.list(f.scope),{code:'MODEL_SECURE_STORAGE_INVALID'});
});
test('lost native intent acknowledgement remains inspectable and caller mutation cannot alter the stored request',async t=>{
 const f=await fixture(t);let lose=true;const files={...nativeFs,write:async(...args:any[])=>{await nativeFs.write(...args);if(lose){lose=false;throw Error('lost acknowledgement');}}},journal=createModelJournal(path.join(f.directory,'lost'),{core,secure:f.secure,files}),row=await f.row(),before=structuredClone(row);
 const pending=journal.put(f.scope,row);row.claim.request.messages[0].content='Late mutation';await assert.rejects(pending,{code:'MODEL_SECURE_STORAGE_WRITE_FAILED'});assert.deepEqual(await journal.list(f.scope),[before]);assert.equal((await journal.capacity(f.scope)).retained,1);
});
