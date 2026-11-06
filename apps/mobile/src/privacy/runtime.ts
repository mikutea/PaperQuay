import {normalizeServiceUrl,type AppConfig} from '../config.ts';
import type {AuthSession} from '../auth/oidc.ts';
import {accountScopeKey,type AccountStorage,type AccountScope} from '../storage/accountStore.ts';
import type {SecretStore} from '../platform/secretStore.ts';
import type {StoredWorkspace,WorkspaceController} from '../sync/workspace.ts';
import type {verifiedBinding} from '../storage/verifiedBinding.ts';
import {parseAccountIdentity,type AccountIdentity} from '../api.ts';
import {AccountPrivacyClient,PrivacyError} from './client.ts';
import type {AccountPrivacyStatus} from './client.ts';
import {AccountSecretStore} from './secretRegistry.ts';
import {eraseLocalAccount} from './lifecycle.ts';
import {clearPrivateExportCache,openPersonalExportSink} from './saveExport.ts';
import type {PersonalExportSink} from './exportStream.ts';
import {clearScopedNativeExports} from '../platform/exportScope.ts';
import type {BrowserErasureCoordinator} from './browserErasure.ts';
import type {PeerErasureHandler} from './browserAccount.ts';
import {PrivateExportCleanup} from './exportCleanup.ts';

export interface PeerErasureSnapshot{accountId:string;requestId:string;phase:'preparing'|'pending';failed:boolean;}
interface PeerErasureEntry{identity:AccountIdentity;current:()=>boolean;snapshot:PeerErasureSnapshot;
  prepared:boolean;finishing:boolean;prepare(retryFailedCleanup?:boolean):Promise<void>;}

export function createPrivacyRuntime(config:AppConfig,auth:AuthSession,store:AccountStorage<StoredWorkspace>,
  secrets:SecretStore,controller:WorkspaceController,binding:ReturnType<typeof verifiedBinding>,
  options:{browserErasure?:BrowserErasureCoordinator|null;owner?:object;stop?():void;
    openExportSink?:typeof openPersonalExportSink;
    registerPeerErasure?(handler:PeerErasureHandler):()=>void}={}) {
  const runtimeOwner=options.owner??{};
  const client=new AccountPrivacyClient({apiBaseUrl:config.apiBaseUrl,getAccessToken:auth.getAccessToken,
    getIdentityKey:binding.key,subscribeIdentity:auth.subscribe});
  let erasing=false;
  const exportCleanup=new PrivateExportCleanup();
  const localExports=new Set<{abort:AbortController;done:Promise<void>}>();
  const beginExport=(signal:AbortSignal)=>{
    const owner=client.captureIdentity(),abort=new AbortController(),stop=()=>abort.abort();
    const current=()=>!erasing&&!abort.signal.aborted&&owner();
    let settled!:()=>void;const entry={abort,done:new Promise<void>(resolve=>{settled=resolve;})};localExports.add(entry);
    signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
    return {current,signal:abort.signal,release(){signal.removeEventListener('abort',stop);localExports.delete(entry);settled();}};
  };
  const sealBusiness=async(retryFailedCleanup=false)=>{
    const failed=retryFailedCleanup?exportCleanup.captureFailed():[];
    erasing=true;const pending=[...localExports];for(const entry of pending)entry.abort.abort();
    await Promise.all([client.sealForErasure(retryFailedCleanup),...pending.map(entry=>entry.done)]);
    await exportCleanup.retry(failed);exportCleanup.assertClean();
  };
  let erasureRecovery:{identity:AccountIdentity;status:AccountPrivacyStatus;current:()=>boolean}|null=null;
  let peer:PeerErasureEntry|null=null;
  const peerListeners=new Set<()=>void>(),emitPeer=()=>{for(const listener of peerListeners)listener();};
  let ownerKey=binding.key();
  const peerAuth=auth.subscribe(()=>{
    const next=binding.key();if(next!==ownerKey){ownerKey=next;erasing=false;}
    if(peer&&!peer.current()){peer=null;emitPeer();}
  });
  const unregisterPeer=options.registerPeerErasure?.(async(scope,requestId,identity,clearRam)=>{
    const current=client.captureIdentity(),verified=parseAccountIdentity(identity);
    if(normalizeServiceUrl(scope.apiBaseUrl)!==config.apiBaseUrl||scope.accountId!==verified.accountId||!current())throw new PrivacyError('CHANGED');
    let pending=peer?.current()&&peer.snapshot.requestId===requestId&&peer.identity.device.id===verified.device.id?peer:null;
    if(pending?.prepared)return;
    if(!pending){
      let preparing:Promise<void>|null=null;
      const entry:PeerErasureEntry={identity:verified,current,prepared:false,finishing:false,
        snapshot:{accountId:scope.accountId,requestId,phase:'preparing',failed:false},
        prepare(retryFailedCleanup=false){
          if(entry.prepared)return Promise.resolve();
          preparing??=(async()=>{await sealBusiness(retryFailedCleanup);if(!current())throw new PrivacyError('CHANGED');
            await clearRam();if(!current())throw new PrivacyError('CHANGED');entry.prepared=true;})().finally(()=>{preparing=null;});
          return preparing;
        }};
      peer=pending=entry;
    }
    if(!pending.finishing){pending.snapshot={...pending.snapshot,phase:'preparing',failed:false};emitPeer();}
    try{await pending.prepare();
      if(peer===pending&&!pending.finishing){peer.snapshot={...pending.snapshot,phase:'pending'};emitPeer();}}
    catch(error){if(peer===pending&&pending.current()&&!pending.finishing){peer.snapshot={...pending.snapshot,phase:'pending',failed:true};emitPeer();}throw error;}
  });
  const scopedSecrets=(scope:AccountScope)=>{
    if(normalizeServiceUrl(scope.apiBaseUrl)!==config.apiBaseUrl)throw new PrivacyError('INVALID');
    return new AccountSecretStore(secrets,scope,client.captureIdentity());
  };
  const runtime={client,binding,scopedSecrets,
    subscribePeerErasure:(listener:()=>void)=>{peerListeners.add(listener);return()=>{peerListeners.delete(listener);};},
    getPeerErasure:():PeerErasureSnapshot|null=>peer?.current()?peer.snapshot:null,
    async finishPeerErasure(signal:AbortSignal):Promise<AccountPrivacyStatus>{
      const pending=peer;if(!pending||!pending.current())throw new PrivacyError('CHANGED');
      if(pending.snapshot.phase==='preparing'||pending.finishing)throw new PrivacyError('BUSY');
      pending.finishing=true;
      peer!.snapshot={...pending.snapshot,phase:'preparing',failed:false};emitPeer();
      try{
        await pending.prepare(true);if(!pending.current())throw new PrivacyError('CHANGED');
        let verified=erasureRecovery?.current()&&erasureRecovery.status.closureRequestId===pending.snapshot.requestId
          ?structuredClone(erasureRecovery.status):null;
        if(!verified)await auth.clearLocalSession({retainForErasure:true,renewForErasure:true,afterPersisted:async token=>{
          if(!token||!pending.current()||signal.aborted)throw new PrivacyError('CHANGED');
          const status=await client.status(signal,token);
          if(!pending.current()||status.accountId!==pending.snapshot.accountId||status.state!=='closed'
            ||status.closureRequestId!==pending.snapshot.requestId)throw new PrivacyError('INVALID');
          verified=status;
        }});
        if(!verified||!pending.current()||signal.aborted)throw new PrivacyError('CHANGED');
        erasureRecovery={identity:structuredClone(pending.identity),status:structuredClone(verified),current:pending.current};
        await runtime.erase(verified,true);
        if(peer===pending){peer=null;emitPeer();}return verified;
      }catch(error){if(peer===pending&&pending.current()){peer.snapshot={...pending.snapshot,phase:'pending',failed:true};emitPeer();}throw error;}
      finally{pending.finishing=false;}
    },
    recoveryStatus():AccountPrivacyStatus|null {
      if(!erasureRecovery?.current()){erasureRecovery=null;return null;}
      return structuredClone(erasureRecovery.status);
    },
    async exportData(scope:AccountScope,local:boolean,signal:AbortSignal,progress?:(bytes:number)=>void){
      // Own preparation before opening the asynchronous picker; its late
      // destination and any failed abort must remain behind the same lease.
      const operation=beginExport(signal);let destination:PersonalExportSink|undefined;
      try{
        if(!operation.current())throw new PrivacyError('CHANGED');
        if(normalizeServiceUrl(scope.apiBaseUrl)!==config.apiBaseUrl)throw new PrivacyError('INVALID');
        destination=await (options.openExportSink??openPersonalExportSink)(scope,operation.current,undefined,exportCleanup);
        return local?await runtime.localExport(scope,destination,operation.signal,progress)
          :await client.exportData(scope,destination,operation.signal,progress);
      }catch(error){await destination?.abort().catch(()=>undefined);throw error;}
      finally{operation.release();}
    },
    async localExport(scope:AccountScope,sink:PersonalExportSink,signal:AbortSignal,progress?:(bytes:number)=>void){
      const destination=exportCleanup.track(sink);
      const operation=beginExport(signal),current=operation.current;
      try {
        if(!current())throw new PrivacyError('CHANGED');
        if(normalizeServiceUrl(scope.apiBaseUrl)!==config.apiBaseUrl)throw new PrivacyError('INVALID');
        const owner=await binding.read();
        if(!current()||owner?.accountId!==scope.accountId)throw new PrivacyError('CHANGED');
        const [{exportLocalData},{getPdfCache},{getParsedCache},{getAiArchiveStore}]=await Promise.all([
          import('./localExport.ts'),import('../pdf/cache.ts'),import('../parsed/cache.ts'),import('../ai/archiveStore.ts')]);
        if(!current())throw new PrivacyError('CHANGED');
        return await exportLocalData(scope,destination,{store,pdf:getPdfCache(),parsed:getParsedCache(),ai:getAiArchiveStore()},{current,signal:operation.signal,progress});
      } catch(error){await destination.abort().catch(()=>undefined);throw error;}
      finally{operation.release();}
    },
    async erase(status:AccountPrivacyStatus,explicitLocalConsent=false) {
      await sealBusiness(explicitLocalConsent);
      const current=client.captureIdentity(),check=()=>{if(!current())throw new PrivacyError('CHANGED');};
      const recoverableBinding={remove:binding.remove,async read(){
        const verified=await (status.deviceErasure.thisDevicePending?binding.readSession():binding.read());check();
        if(verified){
          if(verified.accountId===status.accountId&&status.closureRequestId)erasureRecovery={identity:structuredClone(verified),status:structuredClone(status),current};
          return verified;
        }
        const saved=erasureRecovery;
        return saved&&saved.current()&&saved.status.closureRequestId===status.closureRequestId&&saved.identity.accountId===status.accountId
          ?structuredClone(saved.identity):null;
      }};
      await eraseLocalAccount(config.apiBaseUrl,status,current,{binding:recoverableBinding,store,stop:options.stop??(()=>controller.deactivate()),
        fence:async(scope,requestId)=>{options.browserErasure?.publish(scope,requestId,runtimeOwner);},
        complete:async(scope,requestId,finish)=>{
          if(options.browserErasure)await options.browserErasure.complete(scope,requestId,runtimeOwner,async()=>{
            // Every peer has finished its current task and cleared its config
            // before releasing the shared lock. Remove any late shared writes
            // once more while holding the exclusive lock, before server ACK.
            const {LocalAiConfigStore}=await import('../ai/provider.ts');check();
            new LocalAiConfigStore(localStorage).clear(scope);check();await finish();
          });else await finish();
        },
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
    dispose:async()=>{erasureRecovery=null;peer=null;unregisterPeer?.();peerAuth();peerListeners.clear();client.dispose();await sealBusiness();},
  };
  return runtime;
}
export type PrivacyRuntime=ReturnType<typeof createPrivacyRuntime>;
