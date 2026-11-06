import {Capacitor} from '@capacitor/core';
import {Directory,Encoding,Filesystem} from '@capacitor/filesystem';
import {Share} from '@capacitor/share';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {accountScopeKey,type AccountScope} from '../storage/accountStore.ts';
import {PrivacyExportError,type PersonalExportSink} from './exportStream.ts';

export interface BrowserExportWriter {write(bytes:Uint8Array):Promise<void>;close():Promise<void>;abort():Promise<void>}
export interface PersonalSaveRuntime {
  native:boolean;
  available():boolean;
  canShare():Promise<boolean>;
  create(path:string):Promise<string>;
  append(path:string,text:string):Promise<void>;
  remove(path:string):Promise<void>;
  share(uri:string):Promise<void>;
  pick?():Promise<BrowserExportWriter>;
  download(parts:Uint8Array[]):void;
  id():string;
}
const name='PaperQuay-personal-data.jsonl';
const browser=typeof window==='undefined'?undefined:window as unknown as {
  showSaveFilePicker?:(options:unknown)=>Promise<{createWritable():Promise<BrowserExportWriter>}>;
};
const platform:PersonalSaveRuntime={
  native:Capacitor.isNativePlatform(),
  available:()=>['Filesystem','Share'].every(plugin=>Capacitor.isPluginAvailable(plugin)),
  canShare:async()=>(await Share.canShare()).value,
  create:async path=>(await Filesystem.writeFile({path,directory:Directory.Cache,data:'',encoding:Encoding.UTF8,recursive:true})).uri,
  append:async(path,data)=>{await Filesystem.appendFile({path,directory:Directory.Cache,data,encoding:Encoding.UTF8});},
  remove:async path=>{await Filesystem.deleteFile({path,directory:Directory.Cache});},
  share:async uri=>{await Share.share({files:[uri],dialogTitle:'保存 PaperQuay 个人数据'});},
  ...(typeof browser?.showSaveFilePicker==='function'?{pick:async()=>{
    const handle=await browser.showSaveFilePicker!({suggestedName:name,types:[{description:'PaperQuay 个人数据',accept:{'application/x-ndjson':['.jsonl']}}]});
    return handle.createWritable();
  }}:{}),
  download:parts=>{
    const url=URL.createObjectURL(new Blob(parts.map(part=>new Uint8Array(part)),{type:'application/x-ndjson;charset=utf-8'}));
    const link=document.createElement('a');
    try{link.href=url;link.download=name;link.hidden=true;document.body.append(link);link.click();}
    finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  },
  id:()=>crypto.randomUUID(),
};
export function privateExportDirectory(scope:AccountScope):string {
  return 'paperquay-private-exports/'+bytesToHex(sha256(new TextEncoder().encode(accountScopeKey(scope))));
}

/** Call directly from the user's click so a supported browser can open its
 * save picker before token/network awaits. Nothing is promoted before finish. */
export async function openPersonalExportSink(scope:AccountScope,current:()=>boolean,runtime:PersonalSaveRuntime=platform):Promise<PersonalExportSink> {
  const guard=()=>{if(!current())throw new PrivacyExportError('CHANGED');};guard();
  if(runtime.native) {
    if(!runtime.available()||!await runtime.canShare())throw new PrivacyExportError('UNAVAILABLE');guard();
    const id=runtime.id();if(!/^[0-9a-f-]{36}$/.test(id))throw new PrivacyExportError('FAILED');
    const path=privateExportDirectory(scope)+'/'+id+'/'+name;
    const uri=await runtime.create(path);let opened=false,finished=false;
    try{guard();}catch(error){await runtime.remove(path).catch(()=>undefined);throw error;}
    return {
      write:async bytes=>{guard();if(opened||finished)throw new PrivacyExportError('FAILED');
        await runtime.append(path,new TextDecoder('utf-8',{fatal:true}).decode(bytes));guard();},
      finish:async()=>{guard();if(opened||finished)throw new PrivacyExportError('FAILED');opened=true;
        await runtime.share(uri);guard();finished=true;return 'share';},
      // Once the OS share UI has opened, its recipient may still be reading.
      // Keep that account-scoped cache; an explicit account wipe removes it.
      abort:async()=>{if(!opened&&!finished)await runtime.remove(path);},
    };
  }
  if(runtime.pick) {
    const writer=await runtime.pick();
    try{guard();}catch(error){await writer.abort().catch(()=>undefined);throw error;}
    let finished=false;
    return {write:async bytes=>{guard();if(finished)throw new PrivacyExportError('FAILED');await writer.write(bytes);guard();},
      finish:async()=>{guard();await writer.close();finished=true;guard();return 'saved';},
      abort:async()=>{if(!finished)await writer.abort();}};
  }
  const parts:Uint8Array[]=[];let size=0,finished=false;
  return {
    write:async bytes=>{guard();if(finished)throw new PrivacyExportError('FAILED');size+=bytes.length;
      if(size>16*1024*1024)throw new PrivacyExportError('TOO_LARGE');parts.push(new Uint8Array(bytes));},
    finish:async()=>{guard();if(finished)throw new PrivacyExportError('FAILED');runtime.download(parts);finished=true;parts.length=0;return 'download';},
    abort:async()=>{parts.length=0;},
  };
}

export async function clearPrivateExportCache(scope:AccountScope):Promise<void> {
  if(!Capacitor.isNativePlatform())return;
  const path=privateExportDirectory(scope);
  // This derived scope contains no user-selected path and cannot reach originals.
  try{await Filesystem.rmdir({path,directory:Directory.Cache,recursive:true});}
  catch(error){
    // Missing caches are already clear. Other failures must keep erasure pending.
    const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
    if(code!=='OS-PLUG-FILE-0008')throw new PrivacyExportError('FAILED');
  }
}
