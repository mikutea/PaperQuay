import type { DesktopGraphExchangeStatus } from './desktopGraphExchange';
import type {ModelInferenceCapability,ModelInferenceProfile} from '../../packages/sync-core/src/modelInference';
import { invoke } from '../platform/electron/core';
import { listen } from '../platform/electron/event';
import { flushReaderConfigWrites } from './readerConfig';

export interface DesktopAccountConfig {
  apiBaseUrl: string;
  oidcIssuer: string;
  oidcClientId: string;
  deviceName: string;
}
export interface DesktopPdfBinding {
  bindingId: string;
  localPaperId: string;
  localAttachmentId: string;
  title: string;
  fileName: string;
  attachmentVersionId: string;
  paperId: string;
  sha256: string;
  sizeBytes: number;
  publicationStatus: 'pending-paper' | 'pending-version' | 'published' | 'blocked' | 'source-changed';
  errorCode?: string;
}
export interface DesktopAccountStatus {
  config: DesktopAccountConfig | null;
  auth: { status: 'signed-out' | 'signing-in' | 'signed-in' | 'error'; displayName?: string; expiresAt?: number; errorCode?: string };
  account: { accountId: string; deviceId: string; deviceName: string } | null;
  enabled: boolean;
  busy: boolean;
  capability: { transport: 'http-relay-v1'; maxFileBytes: number; requestTtlMs: number; pollTimeoutMs: number;
    direct?: { transport: 'webrtc-data-v1'; attemptMs: number; maxSdpBytes: number; stunUrls: string[] } } | null;
  bindings: DesktopPdfBinding[];
  transfers: { transferId: string; attachmentVersionId: string; status: 'reading' | 'connecting' | 'sending'; sizeBytes: number;
    transport?: 'webrtc-data-v1' | 'http-relay-v1'; candidateType?: 'host' | 'srflx' | 'prflx' | 'unknown' }[];
  errorCode: string | null;
  remoteTasks?: DesktopRemoteTaskStatus;
  modelInference?: DesktopModelStatus;
  graphExchange?: DesktopGraphExchangeStatus;
}
export interface DesktopRemoteTaskStatus {
  enabled: boolean; running: boolean; busy: boolean; errorCode: string | null;
  configurationToken: string | null;
  capability: { protocolVersion: 1; transport: 'persistent-jobs-v1'; maxArtifactBytes: number; maxAccountArtifactBytes: number;
    maxActive: number; maxQueued: number; maxRetained: number; maxReceipts: number; maxProfiles: number; leaseSeconds: number; providerPresenceSeconds: number } | null;
  profiles: { id: string; revision: number; digest: string; kind: 'parse' | 'index'; model: string }[];
  unavailable: { parse?: string; index?: string };
}
export interface DesktopModelStatus {
  enabled:boolean; running:boolean; busy:boolean; errorCode:string|null; configurationToken:string|null;
  capability:ModelInferenceCapability|null; profiles:ModelInferenceProfile[]; unconfirmed:number;
  presets:{id:string;label:string;model:string;maxOutputTokens:number}[];
}
export interface DesktopModelRecord {id:string;stage:'intent'|'outcome'|'acknowledged';model:string;createdAt:string;hasOutput:boolean;canRecover:boolean;failure:string|null}
export interface DesktopPdfCandidate {
  localPaperId: string; localAttachmentId: string; title: string; fileName: string; sizeBytes: number;
  bindingId?: string; publicationStatus?: DesktopPdfBinding['publicationStatus'];
}
export interface DesktopRemoteVersion {
  paperId: string; attachmentVersionId: string; title: string; fileName: string; sha256: string; sizeBytes: number; pageCount: number | null;
}

export const desktopAccount = {
  status: () => invoke<DesktopAccountStatus>('desktop_account_status'),
  configure: (config: DesktopAccountConfig) => invoke<DesktopAccountStatus>('desktop_account_configure', { config }),
  signIn: () => invoke<DesktopAccountStatus>('desktop_account_sign_in'),
  cancelSignIn: () => invoke<DesktopAccountStatus>('desktop_account_cancel_sign_in'),
  signOut: () => invoke<DesktopAccountStatus>('desktop_account_sign_out'),
  candidates: () => invoke<{ items: DesktopPdfCandidate[]; hasMore?: boolean }>('desktop_provider_candidates'),
  remoteVersions: () => invoke<{ items: DesktopRemoteVersion[]; hasMore?: boolean }>('desktop_provider_remote_versions'),
  publish: (localPaperId: string, localAttachmentId: string) => invoke<DesktopAccountStatus>('desktop_provider_publish', { localPaperId, localAttachmentId }),
  bind: (localPaperId: string, localAttachmentId: string, attachmentVersionId: string) => invoke<DesktopAccountStatus>('desktop_provider_bind', { localPaperId, localAttachmentId, attachmentVersionId }),
  unbind: (bindingId: string) => invoke<DesktopAccountStatus>('desktop_provider_unbind', { bindingId }),
  setEnabled: (enabled: boolean) => invoke<DesktopAccountStatus>('desktop_provider_set_enabled', { enabled }),
  retry: (bindingId: string) => invoke<DesktopAccountStatus>('desktop_provider_retry', { bindingId }),
  exportParsed: (bindingId: string) => invoke<{ status: 'cancelled' | 'exported'; blockCount?: number; assetCount?: number }>(
    'desktop_provider_export_parsed', { bindingId }),
  cancel: (transferId: string) => invoke<DesktopAccountStatus>('desktop_provider_cancel', { transferId }),
  setRemoteTasksEnabled: async (enabled: boolean, configurationToken?: string) => {
    if (enabled) await flushReaderConfigWrites();
    return invoke<DesktopAccountStatus>('desktop_remote_tasks_set_enabled', enabled ? { enabled: true, consent: true, configurationToken } : { enabled: false });
  },
  clearCompletedRemoteJournals: () => invoke<{ removed: number; status: DesktopAccountStatus }>('desktop_remote_tasks_clear_completed', { confirmed: true }),
  setModelsEnabled: async (enabled:boolean,presetId?:string,configurationToken?:string) => {
    if(enabled)await flushReaderConfigWrites();
    return invoke<DesktopAccountStatus>('desktop_models_set_enabled',enabled?{enabled:true,consent:true,presetId,configurationToken}:{enabled:false});
  },
  modelRecords:()=>invoke<{items:DesktopModelRecord[]}>('desktop_models_records'),
  modelBackup:(id:string)=>invoke<unknown>('desktop_models_backup',{id}),
  exportModelBackup:(id:string)=>invoke<{status:'cancelled'|'exported';bytes?:number}>('desktop_models_export',{id}),
  retryModelSave:(id:string)=>invoke<DesktopAccountStatus>('desktop_models_retry_save',{id}),
  clearCompletedModels:()=>invoke<{removed:number;status:DesktopAccountStatus}>('desktop_models_clear_completed',{confirmed:true}),
  onChanged: (listener: () => void) => listen('desktop-account:changed', listener),
};
