import assert from 'node:assert/strict';
import test from 'node:test';
import {exportTextFile,type ExportRuntime} from '../src/platform/exportFile.ts';
import {clearScopedNativeExports,nativeExportDirectory,type ScopedExportFiles} from '../src/platform/exportScope.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const fresh=()=>({apiBaseUrl:'https://sync.example.test',accountId:crypto.randomUUID()});
const file={name:'private.md',mime:'text/markdown' as const,text:'Synthetic private draft'};
function fixture(){const values=new Map<string,string>(),calls={shares:0,clears:[] as string[]};
  const runtime:ExportRuntime={native:true,available:()=>true,canShare:async()=>true,id:()=>crypto.randomUUID(),
    write:async(path,text)=>{values.set(path,text);return 'content://private/'+path;},share:async()=>{calls.shares++;},
    remove:async path=>{values.delete(path);},download:()=>{throw Error('Unexpected download');}};
  const files:ScopedExportFiles={native:true,available:()=>true,listRoot:async()=>[...new Set([...values.keys()].map(path=>path.split('/')[1]))],
    removeDirectory:async directory=>{calls.clears.push(directory);for(const key of values.keys())if(key.startsWith(directory+'/'))values.delete(key);}};
  return {values,calls,runtime,files};}

test('a late native draft write is drained before erasure and cannot open Share or leave a post-erasure file',async()=>{
  const f=fixture(),scope=fresh(),other=fresh(),entered=deferred(),release=deferred();
  await exportTextFile(file,()=>true,f.runtime,other);const originalWrite=f.runtime.write;
  f.runtime.write=async(path,text)=>{entered.resolve();await release.promise;return originalWrite(path,text);};
  const pending=exportTextFile(file,()=>true,f.runtime,scope),rejected=assert.rejects(pending,{code:'CHANGED'});await entered.promise;
  const clearing=clearScopedNativeExports(scope,f.files);assert.equal(f.calls.clears.length,0);release.resolve();await rejected;await clearing;
  assert.equal(f.calls.shares,1);assert(![...f.values.keys()].some(key=>key.startsWith(nativeExportDirectory(scope)+'/')));
  assert([...f.values.keys()].some(key=>key.startsWith(nativeExportDirectory(other)+'/')));
  await assert.rejects(exportTextFile(file,()=>true,f.runtime,scope),{code:'CHANGED'});
});

test('shared retained drafts are account-scoped and unowned prototype exports prevent an erasure acknowledgement',async()=>{
  const f=fixture(),scope=fresh(),other=fresh();await exportTextFile(file,()=>true,f.runtime,scope);await exportTextFile(file,()=>true,f.runtime,other);
  assert.equal(f.values.size,2);await clearScopedNativeExports(scope,f.files);assert.equal(f.values.size,1);
  assert([...f.values.keys()][0].startsWith(nativeExportDirectory(other)+'/'));
  const unknownScope=fresh();f.values.set('paperquay-exports/'+crypto.randomUUID()+'/legacy.md','Unknown owner');
  const clears=f.calls.clears.length;await assert.rejects(clearScopedNativeExports(unknownScope,f.files),{code:'LEGACY_UNOWNED'});
  assert.equal(f.calls.clears.length,clears);assert.equal(f.values.size,2);
});

test('native exports require explicit owner scope and equal account UUIDs on different services never share a directory',async()=>{
  const f=fixture();await assert.rejects(exportTextFile(file,()=>true,f.runtime),{code:'UNAVAILABLE'});assert.equal(f.values.size,0);
  const scope=fresh(),other={...scope,apiBaseUrl:'https://other.example.test'};
  assert.notEqual(nativeExportDirectory(scope),nativeExportDirectory(other));
  assert(!nativeExportDirectory(scope).includes(scope.accountId));assert(!nativeExportDirectory(scope).includes('example.test'));
});
