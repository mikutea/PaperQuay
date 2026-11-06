import {normalizeServiceUrl,type AppConfig} from '../config.ts';
import type {AuthSession} from '../auth/oidc.ts';
import {accountScopeKey,type AccountStorage,type AccountScope} from '../storage/accountStore.ts';
import type {SecretStore} from '../platform/secretStore.ts';
import type {StoredWorkspace,WorkspaceController} from '../sync/workspace.ts';
import type {verifiedBinding} from '../storage/verifiedBinding.ts';
import type {AccountIdentity} from '../api.ts';
import {AccountPrivacyClient,PrivacyError} from './client.ts';
import type {AccountPrivacyStatus} from './client.ts';
import {AccountSecretStore} from './secretRegistry.ts';
import {eraseLocalAccount} from './lifecycle.ts';
import {clearPrivateExportCache} from './saveExport.ts';
import type {PersonalExportSink} from './exportStream.ts';
import {clearScopedNativeExports} from '../platform/exportScope.ts';

export function createPrivacyRuntime(config:AppConfig,auth:AuthSession,store:AccountStorage<StoredWorkspace>,
  secrets:SecretStore,controller:WorkspaceController,binding:ReturnType<typeof verifiedBinding>) {
  const client=new AccountPrivacyClient({apiBaseUrl:config.apiBaseUrl,getAccessToken:auth.getAccessToken,
    getIdentityKey:binding.key,subscribeIdentity:auth.subscribe});
  let erasureRecovery:{identity:AccountIdentity;status:AccountPrivacyStatus;current:()=>boolean}|null=null;
  const scopedSecrets=(scope:AccountScope)=>{
    if(normalizeServiceUrl(scope.apiBaseUrl)!==config.apiBaseUrl)throw new PrivacyError('INVALID');
    return new AccountSecretStore(secrets,scope,client.captureIdentity());
  };
  return {client,binding,scopedSecrets,
    recoveryStatus():AccountPrivacyStatus|null {
      if(!erasureRecovery?.current()){erasureRecovery=null;return null;}
      return structuredClone(erasureRecovery.status);
    },
    async localExport(scope:AccountScope,sink:PersonalExportSink,signal:AbortSignal,progress?:(bytes:number)=>void){
      const current=client.captureIdentity();
      try {
        if(normalizeServiceUrl(scope.apiBaseUrl)!==config.apiBaseUrl)throw new PrivacyError('INVALID');
        const owner=await binding.read();
        if(!current()||owner?.accountId!==scope.accountId)throw new PrivacyError('CHANGED');
        const [{exportLocalData},{getPdfCache},{getParsedCache},{getAiArchiveStore}]=await Promise.all([
          import('./localExport.ts'),import('../pdf/cache.ts'),import('../parsed/cache.ts'),import('../ai/archiveStore.ts')]);
        if(!current()||signal.aborted)throw new PrivacyError('CHANGED');
        return await exportLocalData(scope,sink,{store,pdf:getPdfCache(),parsed:getParsedCache(),ai:getAiArchiveStore()},{current,signal,progress});
      } catch(error){await sink.abort().catch(()=>undefined);throw error;}
    },
    async erase(status:AccountPrivacyStatus,explicitLocalConsent=false) {
      const current=client.captureIdentity(),check=()=>{if(!current())throw new PrivacyError('CHANGED');};
      const recoverableBinding={remove:binding.remove,async read(){
        const verified=await binding.read();check();
        if(verified){
          if(verified.accountId===status.accountId&&status.closureRequestId)erasureRecovery={identity:structuredClone(verified),status:structuredClone(status),current};
          return verified;
        }
        const saved=erasureRecovery;
        return saved&&saved.current()&&saved.status.closureRequestId===status.closureRequestId&&saved.identity.accountId===status.accountId
          ?structuredClone(saved.identity):null;
      }};
      await eraseLocalAccount(config.apiBaseUrl,status,current,{binding:recoverableBinding,store,stop:()=>controller.deactivate(),
        clearIncoming:async scope=>{const {purgeIncomingShareOwner}=await import('../platform/incomingShare.ts');check();await purgeIncomingShareOwner(accountScopeKey(scope),{current});},
        async clearSecrets(scope,workspace) {
          check();const [{LocalAiConfigStore,aiSecretNamespace,AI_SECRET_KEY},{zoteroSecretNamespace,ZOTERO_SECRET_KEY},{radarSecretNamespace}]=await Promise.all([
            import('../ai/provider.ts'),import('../library/zoteroClient.ts'),import('../radar/client.ts')]);
          check();const configStore=new LocalAiConfigStore(localStorage),registry=scopedSecrets(scope),addresses:[string,string][]=[];
          for(const provider of[configStore.load(scope),configStore.loadExternal(scope)]){
            if(!provider.execution)addresses.push([await aiSecretNamespace(scope,provider),AI_SECRET_KEY]);check();
          }
          for(const entry of workspace?.zoteroLibraries?.entries??[])addresses.push([zoteroSecretNamespace(scope,entry.config),ZOTERO_SECRET_KEY]);
          if(workspace?.radarState?.credentialRef)addresses.push([radarSecretNamespace(scope),workspace.radarState.credentialRef]);
          check();await registry.register(addresses);check();await registry.erase();check();configStore.clear(scope);
        },
        clearPdf:async scope=>{const {clearPdfCache}=await import('../pdf/cache.ts');check();await clearPdfCache(scope,{includePinned:true,accountErasure:true});},
        clearParsed:async scope=>{const {getParsedCache}=await import('../parsed/cache.ts');check();await getParsedCache().clear(scope,{guard:current,accountErasure:true});},
        clearAi:async scope=>{const {getAiArchiveStore}=await import('../ai/archiveStore.ts');check();await getAiArchiveStore().clear(scope,{guard:current,accountErasure:true});},
        clearExports:async scope=>{await clearScopedNativeExports(scope);check();await clearPrivateExportCache(scope);},
        acknowledge:(id,token)=>{if(!token)throw new PrivacyError('AUTH_REQUIRED');return client.acknowledge(id,new AbortController().signal,token);},
        clearSession:(afterPersisted,renewForErasure)=>auth.clearLocalSession({afterPersisted,renewForErasure}),
      },{explicitLocalConsent});
      erasureRecovery=null;
    },
    dispose:()=>{erasureRecovery=null;client.dispose();},
  };
}
export type PrivacyRuntime=ReturnType<typeof createPrivacyRuntime>;
