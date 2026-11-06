import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {consumePersonalExport,type PersonalExportSink} from '../src/privacy/exportStream.ts';
import {openPersonalExportSink,type PersonalSaveRuntime} from '../src/privacy/saveExport.ts';

const accountId=randomUUID(),fileId=randomUUID(),scope={apiBaseUrl:'https://service.example.test',accountId};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(change?:(rows:Record<string,unknown>[])=>void) {
  const content=Buffer.from('中文私人测试材料'.repeat(9000));
  const rows:Record<string,unknown>[]=[{kind:'header',format:'paperquay-personal-data',version:1,accountId,consistency:'repeatable-read',scope:'application-server'},
    {kind:'record',table:'accounts',data:{id:accountId}},
    {kind:'record',table:'cloud_pdfs',data:{account_id:accountId,attachment_version_id:fileId,size_bytes:content.length,sha256:hash(content)}}];
  for(let offset=0;offset<content.length;offset+=65536){const bytes=content.subarray(offset,offset+65536);rows.push({kind:'file-chunk',table:'cloud_pdfs',id:fileId,offset,bytes:bytes.length,base64:bytes.toString('base64')});}
  rows.push({kind:'file-complete',table:'cloud_pdfs',id:fileId,bytes:content.length,sha256:hash(content)});
  change?.(rows);
  const text=rows.map(row=>JSON.stringify(row)+'\n').join('');
  return Buffer.from(text+JSON.stringify({kind:'complete',records:2,files:1,fileBytes:content.length,sha256:hash(Buffer.from(text))})+'\n');
}
async function* parts(bytes:Uint8Array,size=4093){for(let offset=0;offset<bytes.length;offset+=size)yield bytes.subarray(offset,offset+size);}
function sink(){const calls={written:[] as Uint8Array[],finished:0,aborted:0};const value:PersonalExportSink={
  write:async bytes=>{calls.written.push(new Uint8Array(bytes));},finish:async()=>{calls.finished++;return 'saved';},abort:async()=>{calls.aborted++;calls.written=[];}};return{calls,value};}
const options=()=>({signal:new AbortController().signal,current:()=>true});

test('full export survives arbitrary UTF8/wire boundaries and promotes only after all file and archive hashes',async()=>{
  const bytes=fixture(),target=sink();
  const receipt=await consumePersonalExport(parts(bytes),accountId,target.value,options());
  assert.equal(receipt.records,2);assert.equal(receipt.files,1);assert.equal(receipt.destination,'saved');
  assert.equal(target.calls.finished,1);assert.equal(target.calls.aborted,0);assert.deepEqual(Buffer.concat(target.calls.written),bytes);
});

test('foreign accounts, binary corruption and malformed receipts never publish a partial export',async()=>{
  for(const bytes of[
    fixture(rows=>{rows[0].accountId=randomUUID();}),
    fixture(rows=>{(rows[1].data as Record<string,unknown>).id=randomUUID();}),
    fixture(rows=>{rows.find(row=>row.kind==='file-chunk')!.base64=Buffer.from('tampered').toString('base64');}),
    fixture(rows=>{rows.find(row=>row.kind==='file-complete')!.sha256='0'.repeat(64);}),
    fixture(rows=>{rows.find(row=>row.kind==='file-chunk')!.offset=1;}),
  ]){const target=sink();await assert.rejects(consumePersonalExport(parts(bytes),accountId,target.value,options()),{code:'INVALID'});
    assert.equal(target.calls.finished,0);assert.equal(target.calls.aborted,1);}
});

test('missing, duplicate, altered and trailing completion data is incomplete or invalid',async()=>{
  const original=fixture(),lines=original.toString().trimEnd().split('\n');
  for(const text of[lines.slice(0,-1).join('\n')+'\n',original.toString()+lines.at(-1)+'\n',original.toString()+'trailing',
    original.toString().replace('"records":2','"records":3'),original.toString().replace('"scope":"application-server"','"scope":"application-server","note":"tampered"')]){
    const target=sink();await assert.rejects(consumePersonalExport(parts(Buffer.from(text)),accountId,target.value,options()));
    assert.equal(target.calls.finished,0);assert.equal(target.calls.aborted,1);
  }
});

test('account changes and cancellation during saving abort the temporary destination',async()=>{
  for(const mode of['change','cancel']){
    const target=sink(),stop=new AbortController();let current=true;
    const write=target.value.write;target.value.write=async bytes=>{await write(bytes);if(mode==='change')current=false;else stop.abort();};
    await assert.rejects(consumePersonalExport(parts(fixture()),accountId,target.value,{signal:stop.signal,current:()=>current}),{code:mode==='change'?'CHANGED':'CANCELLED'});
    assert.equal(target.calls.finished,0);assert.equal(target.calls.aborted,1);
  }
});

test('an oversized single JSON line stops before writing or promoting it',async()=>{
  const target=sink();await assert.rejects(consumePersonalExport(parts(new Uint8Array(8*1024*1024+1).fill(65),65536),accountId,target.value,options()),{code:'TOO_LARGE'});
  assert.equal(target.calls.finished,0);assert.equal(target.calls.aborted,1);
});

function runtime(overrides:Partial<PersonalSaveRuntime>={}){
  const calls={created:[] as string[],removed:[] as string[],shares:0,downloads:0,appends:0};
  const value:PersonalSaveRuntime={native:true,available:()=>true,canShare:async()=>true,
    create:async path=>{calls.created.push(path);return 'private-test-uri';},append:async()=>{calls.appends++;},
    remove:async path=>{calls.removed.push(path);},share:async()=>{calls.shares++;},download:()=>{calls.downloads++;},id:randomUUID,...overrides};
  return {calls,value};
}
test('native exports use only a private account path, remove aborted data, and preserve an opened share for its recipient',async()=>{
  const r=runtime(),temporary=await openPersonalExportSink(scope,()=>true,r.value);
  await temporary.write(new TextEncoder().encode('{}\n'));await temporary.abort();
  assert(r.calls.created[0].startsWith('paperquay-private-exports/'));assert.equal(r.calls.removed[0],r.calls.created[0]);assert.equal(r.calls.shares,0);
  const shared=await openPersonalExportSink(scope,()=>true,r.value);assert.equal(await shared.finish(),'share');await shared.abort();
  assert.equal(r.calls.shares,1);assert.equal(r.calls.removed.length,1);
});
test('browser fallback has a strict 16 MiB budget and never downloads after a failed write',async()=>{
  const r=runtime({native:false}),target=await openPersonalExportSink(scope,()=>true,r.value);
  await target.write(new Uint8Array(16*1024*1024));await assert.rejects(target.write(new Uint8Array(1)),{code:'TOO_LARGE'});
  await target.abort();assert.equal(r.calls.downloads,0);
});
test('browser save preparation is aborted when the account changes while its picker is open',async()=>{
  let current=true,aborted=0;
  const r=runtime({native:false,pick:async()=>{current=false;return{write:async()=>{},close:async()=>{},abort:async()=>{aborted++;}};}});
  await assert.rejects(openPersonalExportSink(scope,()=>current,r.value),{code:'CHANGED'});assert.equal(aborted,1);
});
