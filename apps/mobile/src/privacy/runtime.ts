import {normalizeServiceUrl,type AppConfig} from '../config.ts';
import type {AuthSession} from '../auth/oidc.ts';
import type {AccountStorage,AccountScope} from '../storage/accountStore.ts';
import type {SecretStore} from '../platform/secretStore.ts';
import type {StoredWorkspace,WorkspaceController} from '../sync/workspace.ts';
import {verifiedBinding} from '../storage/verifiedBinding.ts';
import {AccountPrivacyClient,PrivacyError} from './client.ts';
import type {AccountPrivacyStatus} from './client.ts';
import {AccountSecretStore} from './secretRegistry.ts';
import {eraseLocalAccount} from './lifecycle.ts';
import {clearPrivateExportCache} from './saveExport.ts';
import type {PersonalExportSink} from './exportStream.ts';

export function createPrivacyRuntime(config:AppConfig,auth:AuthSession,store:AccountStorage<StoredWorkspace>,
  secrets:SecretStore,controller:WorkspaceController) {
  const binding=verifiedBinding(config,secrets,auth.getSubject);
  const client=new AccountPrivacyClient({apiBaseUrl:config.apiBaseUrl,getAccessToken:auth.getAccessToken,
    getIdentityKey:binding.key,subscribeIdentity:auth.subscribe});
  const scopedSecrets=(scope:AccountScope)=>{
    if(normalizeServiceUrl(scope.apiBaseUrl)!==config.apiBaseUrl)throw new PrivacyError('INVALID');
    return new AccountSecretStore(secrets,scope,client.captureIdentity());
  };
  return {client,binding,scopedSecrets,
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
      await eraseLocalAccount(config.apiBaseUrl,status,current,{binding,store,stop:()=>controller.deactivate(),
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
        clearPdf:async scope=>{const {clearPdfCache}=await import('../pdf/cache.ts');check();await clearPdfCache(scope,{includePinned:true});},
        clearParsed:async scope=>{const {getParsedCache}=await import('../parsed/cache.ts');check();await getParsedCache().clear(scope,{guard:current});},
        clearAi:async scope=>{const {getAiArchiveStore}=await import('../ai/archiveStore.ts');check();await getAiArchiveStore().clear(scope,{guard:current});},
        clearExports:clearPrivateExportCache,
        acknowledge:id=>client.acknowledge(id,new AbortController().signal),clearSession:()=>auth.clearLocalSession(),
      },{explicitLocalConsent});
    },
    dispose:()=>client.dispose(),
  };
}
export type PrivacyRuntime=ReturnType<typeof createPrivacyRuntime>;
