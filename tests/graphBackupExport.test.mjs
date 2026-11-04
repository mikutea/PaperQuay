import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import{createRequire}from'node:module';
const require=createRequire(import.meta.url),{createGraphBackupExporter,MAX_BACKUP_BYTES}=require('../electron/backend/graphBackupExport.cjs');
const backup=()=>({format:'paperquay-desktop-graph-backup',version:1,scope:{serviceKey:'a'.repeat(64),accountId:'00000000-0000-4000-8000-000000000001',libraryBindingId:'00000000-0000-4000-8000-000000000002'},state:{pending:[{description:'完整说明\n需要保留原文 🙂',confidence:null}],accepted:[]}});
async function fixture(t){const prefix=path.resolve(await fs.realpath(os.tmpdir()),'paperquay-graph-backup-'),dir=await fs.realpath(await fs.mkdtemp(prefix));t.after(async()=>{assert(path.isAbsolute(dir)&&path.resolve(dir).startsWith(prefix));await fs.rm(dir,{recursive:true,force:true});});return{dir,file:path.join(dir,'关系备份.json')};}
test('native graph backup writes the complete owned snapshot and returns no filesystem path to the renderer',async t=>{
 const f=await fixture(t),value=backup();let picker=0;const exporter=createGraphBackupExporter({showSaveDialog:async settings=>{picker++;assert.equal(settings.filters[0].extensions[0],'json');return{canceled:false,filePath:f.file};}});
 const result=await exporter.save(value);assert.equal(picker,1);assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),value);assert.deepEqual(Object.keys(result).sort(),['bytes','status']);assert.equal(result.status,'exported');assert.equal(result.bytes,Buffer.byteLength(JSON.stringify(value)));assert(!JSON.stringify(result).includes(f.dir));
});
test('cancelled native save never opens or modifies any file',async()=>{
 let reads=0,writes=0;const exporter=createGraphBackupExporter({showSaveDialog:async()=>({canceled:true}),files:{inspectSync(){reads++;},write:async()=>writes++}});assert.deepEqual(await exporter.save(backup()),{status:'cancelled'});assert.equal(reads+writes,0);
});
test('account/library changes while the native picker is open stop the export and preserve an existing destination',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,'previous user backup');let active=true;
 const exporter=createGraphBackupExporter({showSaveDialog:async()=>{active=false;return{canceled:false,filePath:f.file};}});
 await assert.rejects(exporter.save(backup(),{check(){if(!active)throw Object.assign(Error('cancelled'),{code:'DESKTOP_OPERATION_CANCELLED'});}}),{code:'DESKTOP_OPERATION_CANCELLED'});assert.equal(await fs.readFile(f.file,'utf8'),'previous user backup');
});
test('backup type/size and picker path failures stop before writing, without exposing the chosen path',async()=>{
 let writes=0,pickers=0;const files={inspectSync:()=>({actual:'relative.json'}),write:async()=>writes++};
 const bad=createGraphBackupExporter({files,showSaveDialog:async()=>{pickers++;return{canceled:false,filePath:'relative.json'};}});
 await assert.rejects(bad.save({...backup(),format:'other'}),{code:'DESKTOP_GRAPH_BACKUP_INVALID'});assert.equal(pickers,0);
 await assert.rejects(bad.save({...backup(),large:'x'.repeat(MAX_BACKUP_BYTES)}),{code:'DESKTOP_GRAPH_BACKUP_TOO_LARGE'});assert.equal(pickers,0);
 await assert.rejects(bad.save(backup()),{code:'DESKTOP_GRAPH_BACKUP_SAVE_FAILED'});assert.equal(writes,0);
});
test('native path inspection rejects linked or changed destinations before publication',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,'unchanged');let writes=0;
 const exporter=createGraphBackupExporter({showSaveDialog:async()=>({canceled:false,filePath:f.file}),files:{inspectSync:()=>({linkPath:f.dir,actual:f.file}),write:async()=>writes++}});
 await assert.rejects(exporter.save(backup()),{code:'DESKTOP_GRAPH_BACKUP_SAVE_FAILED'});assert.equal(writes,0);assert.equal(await fs.readFile(f.file,'utf8'),'unchanged');
});

test('graph recovery backup retains both legal snapshots above the single-state size limit',async t=>{
 const f=await fixture(t),value={...backup(),state:{accepted:'a'.repeat(9*1024*1024)},unconfirmedState:{accepted:'b'.repeat(9*1024*1024)}};
 const exporter=createGraphBackupExporter({showSaveDialog:async()=>({canceled:false,filePath:f.file})});
 const result=await exporter.save(value);assert.equal(result.status,'exported');assert(result.bytes>16*1024*1024);assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),value);
});
