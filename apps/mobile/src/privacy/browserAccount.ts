import type {AccountIdentity} from '../api.ts';
import type {AuthSession} from '../auth/oidc.ts';
import {ClientError} from '../errors.ts';
import type {SecretStore} from '../platform/secretStore.ts';
import type {AccountScope} from '../storage/accountStore.ts';
import type {verifiedBinding} from '../storage/verifiedBinding.ts';
import {accountScopeAvailable,type BrowserErasureCoordinator} from './browserErasure.ts';
import {AccountSecretStore} from './secretRegistry.ts';
import {LocalAiConfigStore} from '../ai/provider.ts';

/** One owner token belongs to one runtime's views, auth, stores and volatile
 * secret map. Old accounts retain leases until that RAM is purged or disposed. */
export function browserAccountContext(options:{apiBaseUrl:string;auth:AuthSession;secrets:SecretStore;
  binding:Pick<ReturnType<typeof verifiedBinding>,'key'>;coordinator:BrowserErasureCoordinator|null;stop():void;
  configStorage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>}) {
  const {auth,secrets,binding,coordinator,stop}=options,owner={};
  if(coordinator&&(secrets.persistence!=='memory'||!secrets.disposeMemory))throw new ClientError('STORAGE_UNAVAILABLE');
  let activeScope:AccountScope|null=null,activeSubjectKey:string|null=null;
  return {owner,
    guard:()=>!activeScope||activeSubjectKey!==binding.key()||accountScopeAvailable(activeScope),
    async activate(identity:AccountIdentity) {
      const scope={apiBaseUrl:options.apiBaseUrl,accountId:identity.accountId},subjectKey=binding.key();
      if(coordinator)await coordinator.retain(scope,owner,async()=>{
        if(binding.key()===subjectKey)stop();
        await new AccountSecretStore(secrets,scope,()=>true).erase();
        // A synchronous save that passed its fence check in this context has
        // finished before this storage-event callback can run. Clear both
        // config rows before releasing the context's shared lease.
        new LocalAiConfigStore(options.configStorage??globalThis.localStorage).clear(scope);
        // Clearing a former owner's keys must never sign out a replacement.
        if(binding.key()===subjectKey){await auth.clearLocalSession();stop();}
      });
      activeScope=scope;activeSubjectKey=subjectKey;
    },
    privacyOptions:{browserErasure:coordinator,owner,stop},
    /** Call only after closing this runtime's auth, account store and binding. */
    async disposeAfterResources() {
      secrets.disposeMemory?.();
      if(coordinator){stop();await coordinator.forget(owner);}
    },
  };
}
