import {Capacitor} from '@capacitor/core';
import {Directory,Filesystem} from '@capacitor/filesystem';
import {Share} from '@capacitor/share';
import {FileExportError,exportFilename} from './exportFile.ts';
import type {AccountScope} from '../storage/accountStore.ts';
import {beginScopedExport,ScopedExportError} from './exportScope.ts';
export const WORD_MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export interface BinaryFileExport {name:string;bytes:Uint8Array;mime:typeof WORD_MIME}
export interface BinaryExportRuntime {native:boolean;available():boolean;canShare():Promise<boolean>;write(path:string,base64:string):Promise<string>;share(uri:string):Promise<void>;remove(path:string):Promise<void>;download(file:BinaryFileExport):void;id():string}
function base64(bytes:Uint8Array):string{let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);}
function download(file:BinaryFileExport){const url=URL.createObjectURL(new Blob([new Uint8Array(file.bytes)],{type:file.mime})),link=document.createElement('a');try{link.href=url;link.download=file.name;link.hidden=true;document.body.append(link);link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}}
const runtime:BinaryExportRuntime={native:Capacitor.isNativePlatform(),available:()=>['Filesystem','Share'].every(n=>Capacitor.isPluginAvailable(n)),canShare:async()=>(await Share.canShare()).value,
 write:async(path,data)=>(await Filesystem.writeFile({path,data,directory:Directory.Cache,recursive:true})).uri,share:async uri=>{await Share.share({files:[uri],dialogTitle:'导出 PaperQuay 综述'});},remove:async path=>{await Filesystem.deleteFile({path,directory:Directory.Cache});},download,id:()=>crypto.randomUUID()};
/** File bytes and the account guard are captured before any OS preparation; no text encoding is used for DOCX. */
export async function exportBinaryFile(input:BinaryFileExport,current:()=>boolean,platform:BinaryExportRuntime=runtime,scope?:AccountScope):Promise<'download'|'share'|'cancelled'>{
 const check=()=>{if(!current())throw new FileExportError('CHANGED');};check();
 if(!(input.bytes instanceof Uint8Array)||input.bytes.length<4||input.bytes.length>16*1024*1024||input.bytes[0]!==0x50||input.bytes[1]!==0x4b||input.mime!==WORD_MIME)throw new FileExportError('FAILED');
 const file:BinaryFileExport={name:exportFilename(input.name.replace(/\.docx$/i,''),'docx'),bytes:new Uint8Array(input.bytes),mime:WORD_MIME};
 if(!platform.native){check();platform.download(file);return'download';}if(!platform.available())throw new FileExportError('UNAVAILABLE');
 let path:string|null=null,opened=false,operation:ReturnType<typeof beginScopedExport>|undefined;try{
  operation=beginScopedExport(scope,current);
  if(!await platform.canShare())throw new FileExportError('UNAVAILABLE');check();operation.check();const id=platform.id();if(!/^[0-9a-f-]{36}$/.test(id))throw new FileExportError('FAILED');
  path=operation.directory+'/'+id+'/'+file.name;const uri=await platform.write(path,base64(file.bytes));check();operation.check();operation.prepared();opened=true;await platform.share(uri);return'share';
 }catch(error){if(opened&&error&&typeof error==='object'&&'message'in error&&error.message==='Share canceled')return'cancelled';if(error instanceof ScopedExportError)throw new FileExportError(error.code==='LEGACY_UNOWNED'?'FAILED':error.code);if(error instanceof FileExportError)throw error;throw new FileExportError('FAILED');}
 finally{if(path&&!opened)await platform.remove(path).catch(()=>undefined);operation?.release();}
}
