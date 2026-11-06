import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';

export class PrivacyExportError extends Error {
  constructor(readonly code:'CHANGED'|'INVALID'|'INCOMPLETE'|'CANCELLED'|'UNAVAILABLE'|'TOO_LARGE'|'FAILED') {
    super(code);this.name='PrivacyExportError';
  }
}
export interface PersonalExportSink {
  write(bytes:Uint8Array):Promise<void>;
  finish():Promise<'saved'|'download'|'share'>;
  abort():Promise<void>;
}
export interface PersonalExportReceipt {records:number;files:number;fileBytes:number;sha256:string}
const tableNames=new Set(['accounts','devices','entities','changes','operation_receipts','conflicts','cloud_pdfs',
  'remote_task_providers','remote_tasks','remote_task_requests','remote_task_artifacts','model_inference_providers',
  'model_inference_jobs','remote_retrieval_requests','account_erasure_devices']);
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const whole=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function invalid():never {throw new PrivacyExportError('INVALID');}
function binary(value:unknown):Uint8Array {
  if(typeof value!=='string'||value.length>87384||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))invalid();
  let decoded:string;try{decoded=atob(value);}catch{return invalid();}
  if(btoa(decoded)!==value)invalid();return Uint8Array.from(decoded,c=>c.charCodeAt(0));
}

/** Only a fully verified stream can promote a private temporary export. The
 * transport, file chunks and one metadata line are bounded independently. */
export async function consumePersonalExport(source:AsyncIterable<Uint8Array>,accountId:string,sink:PersonalExportSink,
  options:{signal:AbortSignal;current:()=>boolean;progress?:(bytes:number)=>void}):Promise<PersonalExportReceipt&{destination:'saved'|'download'|'share'}> {
  let header=false,complete:PersonalExportReceipt|null=null,records=0,files=0,fileBytes=0,received=0;
  let pending:Uint8Array[]=[],pendingBytes=0;
  const archiveHash=sha256.create();
  const catalog=new Map<string,{bytes:number;sha256:string;done:boolean}>();
  let active:{key:string;offset:number;hash:ReturnType<typeof sha256.create>}|null=null;
  const guard=()=>{if(options.signal.aborted)throw new PrivacyExportError('CANCELLED');if(!options.current())throw new PrivacyExportError('CHANGED');};
  const accept=async(bytes:Uint8Array)=>{
    guard();if(complete)invalid();
    let row:unknown;try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,-1)));}catch{return invalid();}
    if(!object(row))invalid();
    if(!header) {
      if(row.kind!=='header'||row.format!=='paperquay-personal-data'||row.version!==1||row.accountId!==accountId
        ||row.consistency!=='repeatable-read'||row.scope!=='application-server')invalid();
      header=true;
    } else if(row.kind==='record') {
      if(typeof row.table!=='string'||!tableNames.has(row.table)||!object(row.data)
        ||(row.table==='accounts'?row.data.id:row.data.account_id)!==accountId||'content'in row.data)invalid();
      records++;
      if(row.table==='cloud_pdfs'||row.table==='remote_task_artifacts') {
        const id=row.table==='cloud_pdfs'?row.data.attachment_version_id:row.data.job_id;
        const hash=row.table==='cloud_pdfs'?row.data.sha256:row.data.digest;
        if(!uuid(id)||!whole(row.data.size_bytes)||row.data.size_bytes<1||!digest(hash)||catalog.size>=4096)invalid();
        const key=row.table+':'+id;if(catalog.has(key))invalid();
        catalog.set(key,{bytes:row.data.size_bytes,sha256:hash,done:false});
      }
    } else if(row.kind==='file-chunk') {
      if((row.table!=='cloud_pdfs'&&row.table!=='remote_task_artifacts')||!uuid(row.id)||!whole(row.offset)
        ||!whole(row.bytes)||row.bytes<1||row.bytes>65536)invalid();
      const key=row.table+':'+row.id,expected=catalog.get(key),part=binary(row.base64);
      if(!expected||expected.done||part.length!==row.bytes||row.offset+part.length>expected.bytes)invalid();
      if(!active) {if(row.offset!==0)invalid();active={key,offset:0,hash:sha256.create()};}
      if(active.key!==key||active.offset!==row.offset)invalid();
      active.hash.update(part);active.offset+=part.length;fileBytes+=part.length;
    } else if(row.kind==='file-complete') {
      const key=row.table+':'+row.id,expected=catalog.get(key);
      if(!active||!expected||active.key!==key||active.offset!==expected.bytes||row.bytes!==expected.bytes
        ||row.sha256!==expected.sha256||bytesToHex(active.hash.digest())!==expected.sha256)invalid();
      expected.done=true;active=null;files++;
    } else if(row.kind==='complete') {
      if(active||!whole(row.records)||!whole(row.files)||!whole(row.fileBytes)||!digest(row.sha256)
        ||row.records!==records||row.files!==files||row.fileBytes!==fileBytes||catalog.size!==files
        ||row.sha256!==bytesToHex(archiveHash.digest()))invalid();
      complete={records,files,fileBytes,sha256:row.sha256};
    } else invalid();
    if(!complete)archiveHash.update(bytes);
    await sink.write(bytes);guard();
  };
  try {
    guard();
    for await(const chunk of source) {
      guard();if(!(chunk instanceof Uint8Array))invalid();received+=chunk.length;
      let start=0;
      for(let index=0;index<chunk.length;index++) {
        if(chunk[index]!==10)continue;
        const part=chunk.subarray(start,index+1);pendingBytes+=part.length;
        if(pendingBytes>8*1024*1024)throw new PrivacyExportError('TOO_LARGE');
        const line=new Uint8Array(pendingBytes);let offset=0;
        for(const saved of pending){line.set(saved,offset);offset+=saved.length;}line.set(part,offset);
        pending=[];pendingBytes=0;start=index+1;await accept(line);
      }
      if(start<chunk.length) {const part=chunk.slice(start);pendingBytes+=part.length;
        if(pendingBytes>8*1024*1024)throw new PrivacyExportError('TOO_LARGE');pending.push(part);}
      options.progress?.(received);
    }
    guard();const receipt=complete as PersonalExportReceipt|null;
    if(pendingBytes||!receipt)throw new PrivacyExportError('INCOMPLETE');
    const destination=await sink.finish();guard();return {...receipt,destination};
  } catch(error) {await sink.abort().catch(()=>undefined);throw error;}
  finally {archiveHash.destroy();(active as {hash:ReturnType<typeof sha256.create>}|null)?.hash.destroy();}
}
