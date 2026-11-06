import {PrivacyExportError,type PersonalExportSink} from './exportStream.ts';

interface FailedDestination{retry():Promise<void>;}
const destinations=new WeakMap<PersonalExportSink,{sink:PersonalExportSink;attach(owner:PrivateExportCleanup,key?:string|null):void}>();
/** Failed temporary destinations remain owned by this runtime. Internal error
 * handling shares one abort attempt; only an explicit retry may start another. */
export class PrivateExportCleanup {
  private readonly failed=new Map<FailedDestination,string|null|undefined>();
  private readonly listeners=new Set<()=>void>();
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  hasFailed=():boolean=>this.failed.size>0;
  private changed(){for(const listener of this.listeners)listener();}
  captureFailed(key?:string|null):ReadonlyArray<FailedDestination>{return [...this.failed].filter(([,owner])=>key===undefined||owner===key).map(([destination])=>destination);}
  assertClean(key?:string|null):void{if(this.captureFailed(key).length)throw new PrivacyExportError('FAILED');}
  async retry(captured:ReadonlyArray<FailedDestination>):Promise<void>{
    for(const destination of captured)if(this.failed.has(destination))await destination.retry();
  }
  track(sink:PersonalExportSink,key?:string|null):PersonalExportSink{
    const previous=destinations.get(sink);if(previous){previous.attach(this,key);return previous.sink;}
    const owners=new Map<PrivateExportCleanup,string|null|undefined>([[this,key]]);
    let attempt:Promise<void>|null=null,state:'new'|'pending'|'failed'|'clean'='new';
    const destination:FailedDestination={retry:()=>{
      if(state==='failed'){attempt=null;state='new';}return abort();
    }};
    const abort=():Promise<void>=>{
      if(attempt)return attempt;state='pending';
      attempt=(async()=>{
        try{await sink.abort();state='clean';for(const owner of owners.keys())if(owner.failed.delete(destination))owner.changed();}
        catch{state='failed';for(const [owner,key] of owners){owner.failed.set(destination,key);owner.changed();}throw new PrivacyExportError('FAILED');}
      })();
      return attempt;
    };
    const wrapped={write:(bytes:Uint8Array)=>sink.write(bytes),finish:()=>sink.finish(),abort};
    const tracked={sink:wrapped,attach:(owner:PrivateExportCleanup,key?:string|null)=>{
      if(owners.has(owner)&&owners.get(owner)!==key)throw new PrivacyExportError('CHANGED');
      owners.set(owner,key);if(state==='failed'&&!owner.failed.has(destination)){owner.failed.set(destination,key);owner.changed();}
    }};
    destinations.set(sink,tracked);destinations.set(wrapped,tracked);return wrapped;
  }
}
