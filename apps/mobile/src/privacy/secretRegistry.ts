import type {SecretStore} from '../platform/secretStore.ts';
import {secretAddress} from '../platform/secretStore.ts';
import {accountScopeKey,type AccountScope} from '../storage/accountStore.ts';
import {PrivacyError} from './client.ts';

type Address=[string,string];
interface Queue {tail:Promise<unknown>;sealed:boolean}
const queues=new WeakMap<SecretStore,Map<string,Queue>>();
/** Addresses stay in secure storage. All wrappers serialize on one owner so a
 * failed or late credential write cannot escape the subsequent erasure. */
export class AccountSecretStore implements SecretStore {
  readonly persistence:SecretStore['persistence'];
  private readonly namespace:string;
  private readonly queue:Queue;
  constructor(private readonly base:SecretStore,scope:AccountScope,private readonly current:()=>boolean) {
    this.persistence=base.persistence;this.namespace=JSON.stringify(['paperquay-private-secret-index-v1',accountScopeKey(scope)]);
    let map=queues.get(base);if(!map){map=new Map();queues.set(base,map);}
    let queue=map.get(this.namespace);if(!queue){queue={tail:Promise.resolve(),sealed:false};map.set(this.namespace,queue);}this.queue=queue;
  }
  private check(allowSealed=false){if(!this.current()||this.queue.sealed&&!allowSealed)throw new PrivacyError('CHANGED');}
  private serialize<T>(work:()=>Promise<T>):Promise<T>{const result=this.queue.tail.catch(()=>undefined).then(work);this.queue.tail=result.catch(()=>undefined);return result;}
  private async addresses():Promise<Address[]> {
    const raw=await this.base.get(this.namespace,'addresses');this.check(true);if(raw===null)return [];
    if(raw.length>100000)throw new PrivacyError('INVALID');let rows:unknown;try{rows=JSON.parse(raw);}catch{throw new PrivacyError('INVALID');}
    if(!Array.isArray(rows)||rows.length>256)throw new PrivacyError('INVALID');
    return rows.map(row=>{if(!Array.isArray(row)||row.length!==2||row.some(x=>typeof x!=='string'))throw new PrivacyError('INVALID');
      secretAddress(row[0],row[1]);if(row[0]===this.namespace)throw new PrivacyError('INVALID');return row as Address;});
  }
  private async track(namespace:string,key:string,allowSealed=false) {
    this.check(allowSealed);secretAddress(namespace,key);const rows=await this.addresses();this.check(allowSealed);
    if(rows.some(row=>row[0]===namespace&&row[1]===key))return;
    if(rows.length>=256)throw new PrivacyError('FAILED');rows.push([namespace,key]);
    const value=JSON.stringify(rows);if(value.length>100000)throw new PrivacyError('FAILED');
    await this.base.set(this.namespace,'addresses',value);this.check(allowSealed);
  }
  get(namespace:string,key:string):Promise<string|null>{return this.serialize(async()=>{await this.track(namespace,key);this.check();const value=await this.base.get(namespace,key);this.check();return value;});}
  set(namespace:string,key:string,value:string):Promise<void>{return this.serialize(async()=>{await this.track(namespace,key);this.check();await this.base.set(namespace,key,value);this.check();});}
  remove(namespace:string,key:string):Promise<void>{return this.serialize(async()=>{this.check();secretAddress(namespace,key);await this.base.remove(namespace,key);this.check();});}
  register(addresses:Address[]):Promise<void>{return this.serialize(async()=>{for(const [namespace,key] of addresses)await this.track(namespace,key,true);});}
  erase():Promise<void>{
    this.queue.sealed=true;
    return this.serialize(async()=>{this.check(true);const rows=await this.addresses();
      for(const [namespace,key] of rows){this.check(true);await this.base.remove(namespace,key);this.check(true);}
      if(this.base.persistence==='system'){
        if(!this.base.verifyErasureInventory)throw new PrivacyError('FAILED');
        await this.base.verifyErasureInventory();this.check(true);
      }
      await this.base.remove(this.namespace,'addresses');this.check(true);
    });
  }
}
