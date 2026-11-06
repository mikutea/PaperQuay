import type {AccountIdentity} from '../api.ts';
import type {AccountScope,AccountStorage} from '../storage/accountStore.ts';
import type {StoredWorkspace} from '../sync/workspace.ts';
import type {AccountPrivacyStatus} from './client.ts';
import {PrivacyError} from './client.ts';

export interface ErasureDependencies {
  binding:{read():Promise<AccountIdentity|null>;remove():Promise<void>};
  store:AccountStorage<StoredWorkspace>;
  stop():void;
  clearIncoming(scope:AccountScope):Promise<void>;
  clearSecrets(scope:AccountScope,workspace:StoredWorkspace|null):Promise<void>;
  clearPdf(scope:AccountScope):Promise<void>;
  clearParsed(scope:AccountScope):Promise<void>;
  clearAi(scope:AccountScope):Promise<void>;
  clearExports(scope:AccountScope):Promise<void>;
  acknowledge(deviceId:string,accessToken:string|null):Promise<void>;
  clearSession(afterPersisted:(accessToken:string|null)=>Promise<void>):Promise<void>;
}
/** Server status alone cannot select a local scope. Require the original
 * subject's independently stored, server-verified account and device binding. */
export async function eraseLocalAccount(apiBaseUrl:string,status:AccountPrivacyStatus,current:()=>boolean,
  dependencies:ErasureDependencies,{explicitLocalConsent=false}:{explicitLocalConsent?:boolean}={}) {
  const check=()=>{if(!current())throw new PrivacyError('CHANGED');};check();
  if(status.state!=='closed'||!explicitLocalConsent&&!(status.deviceErasure.requested&&status.deviceErasure.thisDevicePending))throw new PrivacyError('INVALID');
  const binding=await dependencies.binding.read();check();
  if(!binding||binding.accountId!==status.accountId||binding.device.revokedAt!==null)throw new PrivacyError('INVALID');
  const scope={apiBaseUrl,accountId:binding.accountId};
  dependencies.stop();check();
  const workspace=await dependencies.store.read(scope);check();
  if(workspace&&workspace.sync.accountId!==binding.accountId)throw new PrivacyError('INVALID');
  await dependencies.clearIncoming(scope);check();
  await dependencies.clearSecrets(scope,workspace);check();
  await dependencies.clearPdf(scope);check();
  await dependencies.clearParsed(scope);check();
  await dependencies.clearAi(scope);check();
  await dependencies.clearExports(scope);check();
  await dependencies.store.remove(scope);check();
  // Durable credentials are removed before acknowledging. Preserve the original
  // volatile session and verified mapping while a failed deletion/ACK is pending.
  await dependencies.clearSession(async token=>{
    check();
    if(status.deviceErasure.thisDevicePending){await dependencies.acknowledge(binding.device.id,token);check();}
    await dependencies.binding.remove();check();
  });
}
