import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import type {AccountScope,AccountStorage} from '../storage/accountStore.ts';
import type {StoredWorkspace} from '../sync/workspace.ts';
import type {PdfCache} from '../pdf/types.ts';
import type {ParsedCache} from '../parsed/cache.ts';
import type {AiArchiveStore} from '../ai/archiveStore.ts';
import {PrivacyExportError,type PersonalExportSink} from './exportStream.ts';

interface Sources {store:AccountStorage<StoredWorkspace>;pdf:PdfCache;parsed:ParsedCache;ai:AiArchiveStore}
const excluded=new Set(['sourceUrl','sourcePath','localPath','apiKey','accessToken','refreshToken','password','credentialRef','fence','lease','journalKey']);
/** Structural paths preserve local-only data without one library-sized line.
 * Secrets and private download locations have no portable-data representation. */
function* entries(value:unknown,path:(string|number)[]=[]):Generator<unknown> {
  if(Array.isArray(value)){yield {path,type:'array',length:value.length};for(let i=0;i<value.length;i++)yield* entries(value[i],[...path,i]);}
  else if(value&&typeof value==='object'){yield {path,type:'object'};for(const [key,item] of Object.entries(value))if(!excluded.has(key)&&item!==undefined)yield* entries(item,[...path,key]);}
  else yield {path,type:'value',value:value??null};
}
function fingerprint(value:unknown):string {
  const digest=sha256.create();for(const row of entries(value))digest.update(new TextEncoder().encode(JSON.stringify(row)+'\n'));return bytesToHex(digest.digest());
}
function base64(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}

export async function exportLocalData(scope:AccountScope,sink:PersonalExportSink,sources:Sources,
  {current,signal,progress}:{current:()=>boolean;signal:AbortSignal;progress?:(bytes:number)=>void}) {
  const check=()=>{if(signal.aborted)throw new PrivacyExportError('CANCELLED');if(!current())throw new PrivacyExportError('CHANGED');};
  const encoder=new TextEncoder(),hash=sha256.create();let records=0,files=0,fileBytes=0,bytes=0;
  const write=async(value:unknown)=>{check();const line=encoder.encode(JSON.stringify(value)+'\n');if(line.length>8*1024*1024)throw new PrivacyExportError('TOO_LARGE');
    await sink.write(line);check();hash.update(line);bytes+=line.length;progress?.(bytes);};
  const tree=async(area:string,value:unknown)=>{for(const row of entries(value)){await write({kind:'local-record',area,...row as object});records++;}};
  try {
    check();const workspace=await sources.store.read(scope);check();
    if(workspace&&workspace.sync.accountId!==scope.accountId)throw new PrivacyExportError('INVALID');
    const original=fingerprint(workspace),pdfs=await sources.pdf.list(scope);check();
    const parsed=await sources.parsed.list(scope);check();const archives=await sources.ai.list(scope);check();
    await write({kind:'header',format:'paperquay-local-personal-data',version:1,accountId:scope.accountId,
      scope:'this-device',exportedAt:new Date().toISOString(),consistency:'verified-unchanged-across-stores',
      excludes:['credentials','private download URLs and paths','other devices unsynced data','identity-provider data','operator backups'],
      excludedFields:[...excluded]});
    await tree('workspace',workspace);
    for(const row of archives){check();const value=await sources.ai.read(scope,row.kind,row.id,{signal,guard:current});check();
      if(!value||value.revision!==row.revision)throw new PrivacyExportError('INCOMPLETE');await tree('ai-archive/'+row.kind+'/'+row.id,value);}
    if(parsed.length&&!sources.parsed.exportEntry)throw new PrivacyExportError('UNAVAILABLE');
    for(const row of parsed){check();const value=await sources.parsed.exportEntry!(scope,row,{signal,guard:current});check();await tree('parsed-package/'+row.versionId+'/'+row.sha256,value);}
    for(const entry of pdfs) {
      check();
      // Cache-byte verification binds the real version UUID, SHA, size and page
      // count. Placeholder relationship IDs are never exported as library data.
      const content=await sources.pdf.peek(scope,{entityId:entry.versionId,data:{paperId:scope.accountId,attachmentId:entry.versionId,
        sha256:entry.sha256,sizeBytes:entry.sizeBytes,mediaType:'application/pdf',fileName:entry.fileName,pageCount:entry.pageCount}},{signal});check();
      if(!content||content.length!==entry.sizeBytes||bytesToHex(sha256(content))!==entry.sha256)throw new PrivacyExportError('INCOMPLETE');
      const {sourceUrl:privateUrl,...portable}=entry;void privateUrl;
      await write({kind:'file',table:'local-pdf-cache',id:entry.versionId,...portable});
      for(let offset=0;offset<content.length;offset+=65536){const chunk=content.subarray(offset,offset+65536);
        await write({kind:'file-chunk',table:'local-pdf-cache',id:entry.versionId,offset,bytes:chunk.length,base64:base64(chunk)});}
      await write({kind:'file-complete',table:'local-pdf-cache',id:entry.versionId,bytes:content.length,sha256:entry.sha256});files++;fileBytes+=content.length;
    }
    check();const finalWorkspace=await sources.store.read(scope);check();
    if(fingerprint(finalWorkspace)!==original)throw new PrivacyExportError('INCOMPLETE');
    for(const [before,after] of [[pdfs,await sources.pdf.list(scope)],[parsed,await sources.parsed.list(scope)],[archives,await sources.ai.list(scope)]]) {
      check();if(fingerprint(before)!==fingerprint(after))throw new PrivacyExportError('INCOMPLETE');
    }
    const receipt={records,files,fileBytes,sha256:bytesToHex(hash.digest())};
    check();await sink.write(encoder.encode(JSON.stringify({kind:'complete',...receipt})+'\n'));check();
    const destination=await sink.finish();check();return {...receipt,destination};
  } catch(error){await sink.abort().catch(()=>undefined);throw error;}
}
