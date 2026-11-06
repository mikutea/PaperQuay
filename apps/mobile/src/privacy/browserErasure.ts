import {sha256} from '@noble/hashes/sha2.js';
import {accountScopeKey,type AccountScope} from '../storage/accountStore.ts';
import {ClientError} from '../errors.ts';

const PREFIX='paperquay.account-erasure.v1.';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Fence={version:1;requestId:string;signalId:string};
type StoragePort=Pick<Storage,'getItem'|'setItem'|'key'|'length'>;
type LockPort=Pick<LockManager,'request'>;
interface Options {
  storage:StoragePort;
  locks:LockPort;
  listen(listener:(key:string|null)=>void):()=>void;
  timeoutMs?:number;
}
interface Resident {
  scope:AccountScope;
  callbacks:Map<object,()=>Promise<void>>;
  initiators:Set<object>;
  ready:Promise<void>;
  held:Promise<unknown>;
  release():void;
  clearing?:Promise<void>;
}
let reader:((scope:AccountScope)=>boolean)|undefined;
const observers=new Map<string,Set<()=>void>>();
function notifyFence(address:string){for(const callback of [...observers.get(address)??[]])try{callback();}catch{}}
export function subscribeAccountFence(scope:AccountScope,callback:()=>void):()=>void {
  const address=keyFor(scope);let listeners=observers.get(address);
  if(!listeners){listeners=new Set();observers.set(address,listeners);}listeners.add(callback);
  if(!accountScopeAvailable(scope))callback();
  return()=>{listeners!.delete(callback);if(!listeners!.size)observers.delete(address);};
}

/** Installed before a production Web runtime can activate private content.
 * Standalone domain adapters can supply their own ownership guards. */
export function accountScopeAvailable(scope:AccountScope):boolean {
  try{return reader?.(scope)??true;}catch{return false;}
}
function keyFor(scope:AccountScope):string {
  return PREFIX+Array.from(sha256(new TextEncoder().encode(accountScopeKey(scope))),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

/** Every context retains a shared lock for as long as it can hold this owner's
 * RAM. Never expire or steal a peer's lock: a frozen peer keeps erasure pending.
 * The browser releases a destroyed document's locks with that document's RAM. */
export class BrowserErasureCoordinator {
  private readonly residents=new Map<string,Resident>();
  private readonly fenced=new Set<string>();
  private readonly timeoutMs:number;
  private readonly unlisten:()=>void;
  constructor(private readonly options:Options) {
    if(!options.locks?.request)throw new ClientError('STORAGE_UNAVAILABLE');
    this.timeoutMs=options.timeoutMs??15000;
    if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>30000)throw new ClientError('CONFIG_INVALID');
    this.unlisten=options.listen(key=>{
      for(const [address,resident] of this.residents){
        if(key!==null&&key!==address)continue;
        // Removal/clear of site storage also invalidates the old RAM owner.
        this.fenced.add(address);notifyFence(address);
        void this.clearResident(address,resident).catch(()=>undefined);
      }
    });
    reader=scope=>this.available(scope);
  }
  private read(scope:AccountScope):Fence|null {
    let raw:string|null;
    try{raw=this.options.storage.getItem(keyFor(scope));}catch{throw new ClientError('STORAGE_UNAVAILABLE');}
    if(raw===null)return null;
    let value:unknown;try{value=raw.length<=256?JSON.parse(raw):null;}catch{}
    const row=value as Partial<Fence>|null;
    if(!row||Object.keys(row).sort().join(',')!=='requestId,signalId,version'||row.version!==1||
      typeof row.requestId!=='string'||!UUID.test(row.requestId)||typeof row.signalId!=='string'||!UUID.test(row.signalId))
      throw new ClientError('STORAGE_CORRUPT');
    return row as Fence;
  }
  available(scope:AccountScope):boolean {
    const key=keyFor(scope);
    if(this.fenced.has(key))return false;
    try{if(this.read(scope)!==null){this.fenced.add(key);notifyFence(key);return false;}return true;}
    catch{this.fenced.add(key);notifyFence(key);return false;}
  }
  pendingRequestId(scope:AccountScope):string|null{return this.read(scope)?.requestId??null;}
  private assertAvailable(scope:AccountScope){if(!this.available(scope))throw new ClientError('ACCOUNT_CLOSED');}

  async retain(scope:AccountScope,owner:object,clearRam:()=>Promise<void>):Promise<void> {
    this.assertAvailable(scope);
    const address=keyFor(scope),existing=this.residents.get(address);
    if(existing){existing.callbacks.set(owner,clearRam);await existing.ready;this.assertAvailable(scope);return;}
    if(this.residents.size>=128)throw new ClientError('STORAGE_FAILED');
    const acquired=deferred<void>(),released=deferred<void>();
    const resident:Resident={scope:{...scope},callbacks:new Map([[owner,clearRam]]),initiators:new Set(),ready:acquired.promise,
      held:Promise.resolve(),release:()=>released.resolve()};
    this.residents.set(address,resident);
    let granted=false;
    resident.held=this.options.locks.request(address,{mode:'shared'},async()=>{
      try{this.assertAvailable(scope);granted=true;acquired.resolve();await released.promise;}
      catch(error){acquired.reject(error);throw error;}
    });
    void resident.held.catch(error=>{acquired.reject(error);if(!granted&&this.residents.get(address)===resident)this.residents.delete(address);});
    await acquired.promise;this.assertAvailable(scope);
  }
  publish(scope:AccountScope,requestId:string,owner:object):void {
    if(!UUID.test(requestId))throw new ClientError('INVALID_RESPONSE');
    const old=this.read(scope);
    if(old&&old.requestId!==requestId)throw new ClientError('STORAGE_CORRUPT');
    if(!old){
      let count=0;
      try{for(let index=0;index<this.options.storage.length;index++)if(this.options.storage.key(index)?.startsWith(PREFIX))count++;}
      catch{throw new ClientError('STORAGE_UNAVAILABLE');}
      if(count>=128)throw new ClientError('STORAGE_FAILED');
    }
    const address=keyFor(scope);
    try{this.options.storage.setItem(address,JSON.stringify({version:1,requestId,signalId:crypto.randomUUID()} satisfies Fence));}
    catch{throw new ClientError('STORAGE_FAILED');}
    this.fenced.add(address);notifyFence(address);
    this.residents.get(address)?.initiators.add(owner);
    // Storage events reach the other contexts. The caller must finish its own
    // payload/credential cleanup before releasing its shared lease below.
  }
  private async clearResident(address:string,resident:Resident):Promise<void> {
    if(resident.clearing)return resident.clearing;
    const clearing=(async()=>{
      await resident.ready;
      for(const [owner,clear] of resident.callbacks){
        if(resident.initiators.has(owner))continue;
        await clear();resident.callbacks.delete(owner);
      }
      if(!resident.callbacks.size){
        resident.release();await resident.held;
        if(this.residents.get(address)===resident)this.residents.delete(address);
      }
    })();
    resident.clearing=clearing;
    try{await clearing;}finally{if(resident.clearing===clearing)resident.clearing=undefined;}
  }
  async complete<T>(scope:AccountScope,requestId:string,owner:object,finish:()=>Promise<T>):Promise<T> {
    const address=keyFor(scope),fence=this.read(scope);
    if(!fence||fence.requestId!==requestId)throw new ClientError('STORAGE_CORRUPT');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    let granted=false;
    try{
      const resident=this.residents.get(address);
      if(resident){
        // The caller has already purged its RAM, including stored credentials.
        resident.callbacks.delete(owner);resident.initiators.delete(owner);
        const preparation=(async()=>{await this.clearResident(address,resident);await resident.held;})();
        await new Promise<void>((resolve,reject)=>{
          const stop=()=>reject(new ClientError('BROWSER_ERASURE_PENDING'));
          controller.signal.addEventListener('abort',stop,{once:true});
          preparation.then(()=>{controller.signal.removeEventListener('abort',stop);resolve();},
            error=>{controller.signal.removeEventListener('abort',stop);reject(error);});
          if(controller.signal.aborted)stop();
        });
      }
      return await this.options.locks.request(address,{mode:'exclusive',signal:controller.signal},async()=>{
      granted=true;clearTimeout(timer);
      if(this.read(scope)?.requestId!==requestId)throw new ClientError('STORAGE_CORRUPT');
      return finish();
      });
    }
    catch(error){if(!granted&&controller.signal.aborted)throw new ClientError('BROWSER_ERASURE_PENDING');throw error;}
    finally{clearTimeout(timer);}
  }
  /** Caller must first dispose this runtime's views, auth, stores and volatile
   * secret map. Other runtime owners in the same document keep their leases. */
  async forget(owner:object):Promise<void> {
    for(const [address,resident] of this.residents){
      resident.callbacks.delete(owner);resident.initiators.delete(owner);
      if(!resident.callbacks.size){resident.release();await resident.held;
        if(this.residents.get(address)===resident)this.residents.delete(address);}
    }
  }
  /** Only test instances with already-cleared RAM may detach their listeners. */
  detach(){if(this.residents.size)throw new ClientError('STORAGE_FAILED');this.unlisten();}
}

let shared:BrowserErasureCoordinator|undefined;
export function getBrowserErasureCoordinator():BrowserErasureCoordinator {
  if(window.top!==window.self)throw new ClientError('STORAGE_UNAVAILABLE');
  shared??=new BrowserErasureCoordinator({storage:window.localStorage,locks:navigator.locks,
    listen(listener){const receive=(event:StorageEvent)=>{if(event.storageArea===window.localStorage)listener(event.key);};
      window.addEventListener('storage',receive);return()=>window.removeEventListener('storage',receive);}});
  return shared;
}
