import {Capacitor} from '@capacitor/core';
import {Directory,Filesystem} from '@capacitor/filesystem';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {accountScopeKey,type AccountScope} from '../storage/accountStore.ts';

export class ScopedExportError extends Error {
  constructor(readonly code:'CHANGED'|'UNAVAILABLE'|'FAILED'|'LEGACY_UNOWNED'){super(code);this.name='ScopedExportError';}
}
interface Fence {sealed:boolean;pending:Set<Promise<void>>}
const fences=new Map<string,Fence>();
export function nativeExportDirectory(scope:AccountScope):string {
  return 'paperquay-exports/'+bytesToHex(sha256(new TextEncoder().encode(accountScopeKey(scope))));
}
function fence(path:string){let value=fences.get(path);if(!value){value={sealed:false,pending:new Set()};fences.set(path,value);}return value;}
export function beginScopedExport(scope:AccountScope|undefined,current:()=>boolean) {
  if(!scope)throw new ScopedExportError('UNAVAILABLE');
  const directory=nativeExportDirectory({...scope}),state=fence(directory);
  const check=()=>{if(state.sealed||!current())throw new ScopedExportError('CHANGED');};check();
  if(state.pending.size>=4)throw new ScopedExportError('UNAVAILABLE');
  let resolve!:()=>void;const done=new Promise<void>(finish=>{resolve=finish;});state.pending.add(done);
  const release=()=>{state.pending.delete(done);resolve();};
  return {directory,check,prepared:release,release};
}
export interface ScopedExportFiles {
  native:boolean;available():boolean;listRoot():Promise<string[]>;removeDirectory(path:string):Promise<void>;
}
const missing=(error:unknown)=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='OS-PLUG-FILE-0008');
const files:ScopedExportFiles={native:Capacitor.isNativePlatform(),available:()=>Capacitor.isPluginAvailable('Filesystem'),
  async listRoot(){try{return (await Filesystem.readdir({path:'paperquay-exports',directory:Directory.Cache})).files.map(file=>file.type==='directory'?file.name:'unowned-file');}
    catch(error){if(missing(error))return [];throw error;}},
  async removeDirectory(path){try{await Filesystem.rmdir({path,directory:Directory.Cache,recursive:true});}catch(error){if(!missing(error))throw error;}},
};
/** Wait for already-started writes before deleting this account directory.
 * Unattributed prototype files cannot be guessed or erased for another owner. */
export async function clearScopedNativeExports(scope:AccountScope,platform:ScopedExportFiles=files):Promise<void> {
  if(!platform.native)return;if(!platform.available())throw new ScopedExportError('UNAVAILABLE');
  const directory=nativeExportDirectory(scope),state=fence(directory);state.sealed=true;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([Promise.all([...state.pending]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ScopedExportError('FAILED')),30000);})]);
    const roots=await platform.listRoot();
    if(roots.length>4096||roots.some(name=>!/^[a-f0-9]{64}$/.test(name)))throw new ScopedExportError('LEGACY_UNOWNED');
    await platform.removeDirectory(directory);
  }finally{if(timer)clearTimeout(timer);}
}
