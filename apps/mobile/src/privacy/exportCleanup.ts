import {PrivacyExportError,type PersonalExportSink} from './exportStream.ts';

interface FailedDestination{retry():Promise<void>;}
const destinations=new WeakMap<PersonalExportSink,{sink:PersonalExportSink;attach(owner:PrivateExportCleanup):void}>();
/** Failed temporary destinations remain owned by this runtime. Internal error
 * handling shares one abort attempt; only an explicit retry may start another. */
export class PrivateExportCleanup {
  private readonly failed=new Set<FailedDestination>();
  captureFailed():ReadonlyArray<FailedDestination>{return [...this.failed];}
  assertClean():void{if(this.failed.size)throw new PrivacyExportError('FAILED');}
  async retry(captured:ReadonlyArray<FailedDestination>):Promise<void>{
    for(const destination of captured)if(this.failed.has(destination))await destination.retry();
  }
  track(sink:PersonalExportSink):PersonalExportSink{
    const previous=destinations.get(sink);if(previous){previous.attach(this);return previous.sink;}
    const owners=new Set<PrivateExportCleanup>([this]);
    let attempt:Promise<void>|null=null,state:'new'|'pending'|'failed'|'clean'='new';
    const destination:FailedDestination={retry:()=>{
      if(state==='failed'){attempt=null;state='new';}return abort();
    }};
    const abort=():Promise<void>=>{
      if(attempt)return attempt;state='pending';
      attempt=(async()=>{
        try{await sink.abort();state='clean';for(const owner of owners)owner.failed.delete(destination);}
        catch{state='failed';for(const owner of owners)owner.failed.add(destination);throw new PrivacyExportError('FAILED');}
      })();
      return attempt;
    };
    const wrapped={write:(bytes:Uint8Array)=>sink.write(bytes),finish:()=>sink.finish(),abort};
    const tracked={sink:wrapped,attach:(owner:PrivateExportCleanup)=>{owners.add(owner);if(state==='failed')owner.failed.add(destination);}};
    destinations.set(sink,tracked);destinations.set(wrapped,tracked);return wrapped;
  }
}
