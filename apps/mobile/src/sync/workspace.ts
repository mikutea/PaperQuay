import {assertGraphRelationPlan,type GraphRelationPlan} from '../graph/relations.ts';
import { readRetrievalSession, beginRetrievalSession, assertRetrievalSourcesCurrent, type RetrievalSession } from '../retrieval/session.ts';
import type {ModelLedgerOwner} from '../modelRouting/ledger.ts';
import {emptyModelLedger,readModelLedger,verifyModelLedger} from '../modelRouting/ledger.ts';
import { validateAgentMetadataSession, beginAgentMetadataQuery, assertAgentMetadataCurrent, buildAgentMetadataProposal, metadataPublicationKey, markAgentMetadataPublished, type AgentMetadataSession, type AgentMetadataChoice } from '../agent/metadataSession.ts';
import { validateAgentMetadataRequest, type AgentMetadataRequest } from '../agent/metadataRequest.ts';
import{modelEvidenceFromTurn}from'../agent/evidence.ts';
import{validateAgentContexts,assertAgentContextsCurrent,type AgentContext}from'../agent/context.ts';
import{validateAgentConversation,assertAgentConversationCurrent,approveAgentContextRequest,beginAgentModelTurn,type AgentConversation}from'../agent/conversation.ts';
import{validateAgentModelRequest,parseAgentModelResponse,type AgentModelRequest}from'../agent/modelProtocol.ts';
import type{AiProviderConfig}from'../ai/types.ts';
import{validateAgentState,emptyAgentState,withAgentProposal,validateAgentApproval,materializeAgentApproval,type AgentState,type AgentApproval,type AgentApplyResult}from'../agent/approval.ts';
import{AgentError,withAgentProposalEvidence}from'../agent/proposals.ts';
import{validateRadarState,type RadarState}from'../radar/model.ts';
import{materializeRadarAdoption,validateRadarAdoption,type RadarAdoptionPlan,type RadarAdoptionResult}from'../radar/adoption.ts';
import{RadarError}from'../radar/config.ts';
import {validateReviewProject,assertReviewSourcesCurrent,type ReviewProject} from '../review/model.ts';
import {
  applyConflictResolution,
  applyPullPage,
  applyPushResults,
  applyRemoteConflictResolution,
  createAccountState,
  canonicalJson,
  entityKey,
  getSyncContext,
  getVisibleEntity,
  listVisibleEntities,
  markPushUncertain,
  preparePush,
  queueLocalCreates,
  queueLocalPuts,
  queueLocalApprovedPaperPuts,
  queueLocalEdit,
  rebindDevice,
  resumeAfterRestart,
  validateClientState,
  validateEntityData,
  validateOperation,
  SyncStateError,
  supportsSyncRecord,
  type AccountSyncState,
  type EntityData,
  type EntityType,
  type LocalEdit,
  type NoteData,
  type PreparedPush,
  type PushResult,
  type SyncContext,
  type SyncMutation,
  type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import type {
  AccountIdentity,
  ConflictResolution,
  DeviceSession,
  ServerConflict,
  SyncApi,
} from '../api.ts';
import { validateRemoteBatch, validateRemoteBatchDraft, remoteBatchIdentity, assertRemoteBatchTarget, remoteBatchReceipt,
  stopRemoteBatch as stoppedRemoteBatch, canClearRemoteBatch, type RemoteBatch, type RemoteBatchFailure } from '../remote/batch.ts';
import { validateRemoteTaskId, validateRemoteTaskRequestStatus, type RemoteTaskRequestStatus } from '../../../../packages/sync-core/src/remoteTasks.ts';
import { ClientError } from '../errors.ts';
import {
  materializeLibraryImport,
  planLibraryImport,
  type LibraryArchive,
  type LibraryImportSummary,
} from '../library/libraryTransfer.ts';
import {
  appendIncomingReceipt,
  assertPreparedIncomingImport,
  findIncomingReceipt,
  IncomingReceiptError,
  validateIncomingReceipts,
  type IncomingImportReceipt,
  type PreparedIncomingImport,
} from '../library/incomingReceipt.ts';
import {
  ExternalLibraryError,
  materializeExternalLibraryImport,
  planExternalLibraryImport,
  validateExternalLibraryRegistry,
  type ExternalLibraryDecision,
  type ExternalLibraryRegistry,
  type ExternalLibrarySnapshot,
  type ExternalLibrarySummary,
} from '../library/externalLibrary.ts';
import type { AccountStorage, AccountScope } from '../storage/accountStore.ts';
import { readStoredGraphEvidence, readGraphEvidenceAdoption, graphEvidenceAdoptionKey, assertGraphEvidenceAccount, assertGraphEvidenceSelection, type GraphEvidenceAdoption, type GraphEvidenceSnapshot } from '../graph/evidence.ts';
import { validateRemoteTaskRequest, type RemoteTaskRequest } from '../../../../packages/sync-core/src/remoteTasks.ts';
import { validateZoteroRefreshResult, type ZoteroRefreshResult } from '../library/zoteroRefresh.ts';
import { validateZoteroLibraryState, updateZoteroCursor, zoteroCursor, type ZoteroLibraryState } from '../library/zoteroState.ts';
import type { ZoteroLibraryConfig } from '../library/zoteroClient.ts';

interface PendingResolution {
  request: ConflictResolution;
  entityType: EntityType;
  entityId: string;
  consumedOverlayOpId?: string;
}
export interface StoredWorkspace {
  sync: AccountSyncState;
  pendingResolutions: Record<string, PendingResolution>;
  paperOrganizationVersion?: 1;
  richNotesVersion?:1;
  aiConversationsVersion?:1;
  graphRelationsVersion?:1;
  /** Private to this account on this device; never part of the synchronization payload. */
  externalLibraries?: ExternalLibraryRegistry;
  /** Durable, non-secret create intent. Replayed only on an explicit retry. */
  remoteTaskIntent?: { version: 1; request: RemoteTaskRequest };
  /** Private local batch ledger; every server request ID survives restart. */
  remoteBatch?: RemoteBatch;
  zoteroLibraries?: ZoteroLibraryState;
  /** One private literature-review project and its paid-call checkpoint; never synchronized. */
  reviewProject?: ReviewProject;
  /** Account-local radar configuration/results; library adoption still uses the synchronization outbox. */
  radarState?: RadarState;
  /** Local Agent proposals and apply receipts; only approved paper edits enter the outbox. */
  agentState?: AgentState;
  agentConversation?:AgentConversation;
  agentMetadataSession?:AgentMetadataSession;
  agentMetadataCooldownUntil?:number;
  /** Account-local receipts commit with imported entities and their outbox entries. */
  incomingReceipts?: IncomingImportReceipt[];
  /** Private model identity/result ledger; never sent through the sync outbox. */
  modelInvocations?: import('../modelRouting/ledger.ts').ModelInvocationLedger;
  /** One private read-only search request and its integrity-checked receipt. */
  retrievalSession?: RetrievalSession;
  /** Explicitly selected desktop cache evidence; private to this account/device, never sync outbox content. */
  graphEvidence?: GraphEvidenceAdoption;
}
export interface WorkspaceSnapshot {
  status: 'signed-out' | 'binding' | 'ready' | 'error';
  identity: AccountIdentity | null;
  workspace: StoredWorkspace | null;
  syncing: boolean;
  online: boolean;
  needsLogin: boolean;
  devices: DeviceSession[];
  conflicts: ServerConflict[];
  lastSyncedAt: string | null;
  error: ClientError | null;
}
type Api = Pick<
  SyncApi,
  'register' | 'push' | 'pull' | 'devices' | 'conflicts' | 'resolveConflict' | 'revokeDevice'
>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function decodeWorkspace(value: unknown): StoredWorkspace {
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => !['sync', 'pendingResolutions', 'paperOrganizationVersion','richNotesVersion','aiConversationsVersion','graphRelationsVersion', 'externalLibraries','remoteTaskIntent','remoteBatch','zoteroLibraries','incomingReceipts','reviewProject','radarState','agentState','agentConversation','agentMetadataSession','agentMetadataCooldownUntil','modelInvocations','retrievalSession','graphEvidence'].includes(key)) ||
    (value.paperOrganizationVersion !== undefined && value.paperOrganizationVersion !== 1) ||
    (value.graphRelationsVersion!==undefined&&value.graphRelationsVersion!==1)||
    (value.richNotesVersion!==undefined&&value.richNotesVersion!==1)||(value.aiConversationsVersion!==undefined&&value.aiConversationsVersion!==1)||
    !isObject(value.pendingResolutions) ||
    !validateClientState(value.sync).ok ||
    Object.keys(value.pendingResolutions).length > 10_000
  )
    throw new ClientError('STORAGE_CORRUPT');
  if (value.externalLibraries !== undefined) {
    try { validateExternalLibraryRegistry(value.externalLibraries); }
    catch { throw new ClientError('STORAGE_CORRUPT'); }
  }
  if (value.remoteTaskIntent !== undefined) {
    const intent = value.remoteTaskIntent;
    if (!isObject(intent) || Object.keys(intent).sort().join(',') !== 'request,version' || intent.version !== 1) throw new ClientError('STORAGE_CORRUPT');
    try { validateRemoteTaskRequest(intent.request); } catch { throw new ClientError('STORAGE_CORRUPT'); }
  }
  if (value.remoteBatch !== undefined) {
    try { validateRemoteBatch(value.remoteBatch); } catch { throw new ClientError('STORAGE_CORRUPT'); }
    if (value.remoteTaskIntent !== undefined) throw new ClientError('STORAGE_CORRUPT');
  }
  if(value.modelInvocations!==undefined){try{readModelLedger(value.modelInvocations);}catch{throw new ClientError('STORAGE_CORRUPT');}}
  if(value.retrievalSession!==undefined){try{readRetrievalSession(value.retrievalSession);}catch{throw new ClientError('STORAGE_CORRUPT');}}
  if(value.graphEvidence!==undefined){try{if(readGraphEvidenceAdoption(value.graphEvidence).snapshot.accountId!==(value.sync as AccountSyncState).accountId)throw Error();}catch{throw new ClientError('STORAGE_CORRUPT');}}
  if(value.agentMetadataCooldownUntil!==undefined&&(!Number.isSafeInteger(value.agentMetadataCooldownUntil)||Number(value.agentMetadataCooldownUntil)<0||Number(value.agentMetadataCooldownUntil)>253402300799999))throw new ClientError('STORAGE_CORRUPT');
  if(value.agentMetadataSession!==undefined){try{validateAgentMetadataSession(value.agentMetadataSession);}catch{throw new ClientError('STORAGE_CORRUPT');}}
  if(value.agentConversation!==undefined){try{validateAgentConversation(value.agentConversation);}catch{throw new ClientError('STORAGE_CORRUPT');}}
  if(value.agentState!==undefined){try{validateAgentState(value.agentState);}catch{throw new ClientError('STORAGE_CORRUPT');}}
  if(value.radarState!==undefined){try{validateRadarState(value.radarState);}catch{throw new ClientError('STORAGE_CORRUPT');}}
  if(value.reviewProject!==undefined){try{validateReviewProject(value.reviewProject);}catch{throw new ClientError('STORAGE_CORRUPT');}}
  if (value.zoteroLibraries !== undefined) {
    try { validateZoteroLibraryState(value.zoteroLibraries); } catch { throw new ClientError('STORAGE_CORRUPT'); }
  }
  if (value.incomingReceipts !== undefined) {
    try { validateIncomingReceipts(value.incomingReceipts); } catch { throw new ClientError('STORAGE_CORRUPT'); }
  }
  for (const [conflictId, pending] of Object.entries(value.pendingResolutions)) {
    if (
      !uuid.test(conflictId) ||
      !isObject(pending) ||
      Object.keys(pending).length !== (pending.consumedOverlayOpId === undefined ? 3 : 4) ||
      typeof pending.entityId !== 'string' ||
      !uuid.test(pending.entityId) ||
      !isObject(pending.request)
    )
      throw new ClientError('STORAGE_CORRUPT');
    if (
      pending.consumedOverlayOpId !== undefined &&
      (typeof pending.consumedOverlayOpId !== 'string' || !uuid.test(pending.consumedOverlayOpId))
    )
      throw new ClientError('STORAGE_CORRUPT');
    const request = pending.request;
    if (
      typeof request.opId !== 'string' ||
      !uuid.test(request.opId) ||
      !Number.isSafeInteger(request.expectedRevision) ||
      (request.expectedRevision as number) < 0 ||
      !['current', 'attempted', 'merged'].includes(String(request.choice))
    )
      throw new ClientError('STORAGE_CORRUPT');
    const operation = {
      opId: request.opId,
      entityType: pending.entityType,
      entityId: pending.entityId,
      mutation: request.choice === 'merged' ? request.mutation : 'delete',
      data: request.choice === 'merged' ? request.data : null,
      baseRevision: Math.max(1, request.expectedRevision as number),
      schemaVersion: 1,
      clientCreatedAt: '2026-01-01T00:00:00.000Z',
    };
    if (
      !validateOperation(operation).ok ||
      Object.keys(request).length !== (request.choice === 'merged' ? 5 : 3)
    )
      throw new ClientError('STORAGE_CORRUPT');
  }
  return value as unknown as StoredWorkspace;
}

/** Retained conflicts and a resolution in flight can outlive a visible outbox row. */
export function externalLibraryEntities(workspace: StoredWorkspace): VisibleEntity[] {
  const blocked = new Set<string>();
  for (const conflict of Object.values(workspace.sync.conflicts)) {
    if (['paper','attachmentVersion'].includes(conflict.attempted.entityType)) blocked.add(conflict.attempted.entityType+':'+conflict.attempted.entityId);
    if (conflict.current&&['paper','attachmentVersion'].includes(conflict.current.entityType)) blocked.add(conflict.current.entityType+':'+conflict.current.entityId);
  }
  for (const resolution of Object.values(workspace.pendingResolutions)) {
    if (['paper','attachmentVersion'].includes(resolution.entityType)) blocked.add(resolution.entityType+':'+resolution.entityId);
  }
  return listVisibleEntities(workspace.sync).map((entity) => blocked.has(entity.entityType+':'+entity.entityId)
    ? { ...entity, pending: true, status: 'conflict' as const } : entity);
}

const sameContext = (a: SyncContext, b: SyncContext): boolean =>
  a.accountId === b.accountId && a.deviceId === b.deviceId && a.generation === b.generation;
function safeError(error: unknown): ClientError {
  if (error instanceof ClientError) return error;
  if (isObject(error) && ['IDENTITY_CHANGED', 'STALE_PULL_CURSOR'].includes(String(error.code)))
    return new ClientError('ACCOUNT_CHANGED');
  return new ClientError('SYNC_FAILED');
}

/** Owns one authenticated account. All writes re-read IndexedDB in a single transaction. */
export class WorkspaceController {
  private readonly api: Api;
  private readonly apiBaseUrl: string;
  private readonly store: AccountStorage<StoredWorkspace>;
  private readonly makeId: () => string;
  private readonly now: () => string;
  private readonly binding: {
    key?: () => string | null;
    prepare?: (signal: AbortSignal) => Promise<unknown>;
    activate?: (identity:AccountIdentity)=>Promise<void>;
    guard?:()=>boolean;
    read?: () => Promise<AccountIdentity | null>;
    write?: (identity: AccountIdentity) => Promise<void>;
    remove?: () => Promise<void>;
  };
  private readonly supportsPaperOrganization: () => boolean;
  private readonly supportsRichNotes:()=>boolean;
  private readonly supportsAiConversations:()=>boolean;
  private readonly supportsGraphRelations:()=>boolean;
  private confirmedPaperOrganization: boolean | undefined;
  private scope: AccountScope | null = null;
  private context: SyncContext | null = null;
  private activeBindingKey: string | null | undefined;
  private epoch = 0;
  private abort = new AbortController();
  private running: Promise<void> | null = null;
  private readingSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private flushReadingAfterRun = false;
  private listeners = new Set<() => void>();
  private snapshot: WorkspaceSnapshot;

  constructor(options: {
    api: Api;
    apiBaseUrl: string;
    store: AccountStorage<StoredWorkspace>;
    online?: boolean;
    makeId?: () => string;
    now?: () => string;
    supportsPaperOrganization?: () => boolean;
    supportsRichNotes?:()=>boolean;
    supportsAiConversations?:()=>boolean;
    supportsGraphRelations?:()=>boolean;
    binding?: WorkspaceController['binding'];
  }) {
    this.api = options.api;
    this.apiBaseUrl = options.apiBaseUrl;
    this.store = options.store;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.binding = options.binding ?? {};
    this.supportsPaperOrganization = options.supportsPaperOrganization ?? (() => false);
    this.supportsRichNotes=options.supportsRichNotes??(()=>false);
    this.supportsAiConversations=options.supportsAiConversations??(()=>false);
    this.supportsGraphRelations=options.supportsGraphRelations??(()=>false);
    this.snapshot = {
      status: 'signed-out',
      identity: null,
      workspace: null,
      syncing: false,
      online: options.online ?? true,
      needsLogin: false,
      devices: [],
      conflicts: [],
      lastSyncedAt: null,
      error: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): WorkspaceSnapshot => this.snapshot;
  getAccountScope = ():AccountScope|null => this.snapshot.status==='ready'&&this.scope?{...this.scope}:null;
  getContentCapabilities=(value=this.snapshot.workspace,allowOffline=true)=>{
    const remembered=allowOffline&&(!this.snapshot.online||this.snapshot.needsLogin);
    return{richNotes:this.supportsRichNotes()||Boolean(remembered&&value?.richNotesVersion),
      aiConversations:this.supportsAiConversations()||Boolean(remembered&&value?.aiConversationsVersion),
      graphRelations:this.supportsGraphRelations()||Boolean(remembered&&value?.graphRelationsVersion)};
  };
  /** Captures an epoch, so A -> B -> A cannot revive old model callbacks. No IO or model execution. */
  captureModelOwner(scope: AccountScope):ModelLedgerOwner {
    const epoch=this.epoch,capturedScope={...scope},capturedContext=this.context,scopeKey=JSON.stringify([scope.apiBaseUrl,scope.accountId]),current=()=>this.current(epoch)&&this.snapshot.status==='ready'&&this.scope!==null&&JSON.stringify([this.scope.apiBaseUrl,this.scope.accountId])===scopeKey;
    const assert=()=>{if(!current())throw new ClientError('ACCOUNT_CHANGED');};
    return{
      signal:this.abort.signal,
      current,
      read:()=>{assert();return readModelLedger(this.snapshot.workspace?.modelInvocations??emptyModelLedger());},
      refresh:async()=>{
        assert();const saved=await this.store.read(capturedScope);assert();
        if(!saved||!capturedContext||!sameContext(getSyncContext(saved.sync),capturedContext))throw new ClientError('ACCOUNT_CHANGED');
        const ledger=await verifyModelLedger(saved.modelInvocations??emptyModelLedger());assert();
        const currentWorkspace=this.snapshot.workspace;if(!currentWorkspace)throw new ClientError('ACCOUNT_CHANGED');
        const known=readModelLedger(currentWorkspace.modelInvocations??emptyModelLedger());
        if(ledger.revision<known.revision)return known;
        if(ledger.revision===known.revision){if(canonicalJson(ledger)!==canonicalJson(known))throw new ClientError('STORAGE_CORRUPT');return known;}
        // Only this private field is refreshed; concurrent notes/outbox/cursor updates stay intact.
        this.publish({workspace:{...currentWorkspace,modelInvocations:ledger}});
        return ledger;
      },
      update:async(reducer)=>{
        assert();const next=await this.update(epoch,value=>{assert();return{...value,modelInvocations:readModelLedger(reducer(readModelLedger(value.modelInvocations??emptyModelLedger())))};});
        assert();return readModelLedger(next.modelInvocations);
      },
    };
  }

  private supportedContent(item:{entityType:EntityType;entityId?:string;data:EntityData|null},value:StoredWorkspace|null=this.snapshot.workspace,allowOffline=false):boolean{
    const features=this.getContentCapabilities(value,allowOffline);
    if(!supportsSyncRecord(features,item))return false;
    const current=item.entityId&&value?.sync.serverRecords[entityKey(item.entityType,item.entityId)];
    return!current||supportsSyncRecord(features,current);
  }
  private publish(update: Partial<WorkspaceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  private current(epoch: number): boolean {
    return this.sameBinding(epoch) && !this.abort.signal.aborted;
  }
  private sameBinding(epoch: number): boolean {
    return this.epoch === epoch && this.activeBindingKey === this.binding.key?.()&&this.binding.guard?.()!==false;
  }
  private assertBinding(epoch: number): void {
    if (this.sameBinding(epoch)) return;
    if (this.epoch === epoch) {
      this.deactivate();
      this.publish({ status: 'error', error: new ClientError('ACCOUNT_CHANGED') });
    }
    throw new ClientError('ACCOUNT_CHANGED');
  }
  private async request<T>(epoch: number, task: () => Promise<T>): Promise<T> {
    this.assertBinding(epoch);
    if (this.abort.signal.aborted) throw new ClientError('ACCOUNT_CHANGED');
    const result = await task();
    this.assertBinding(epoch);
    return result;
  }
  private stop(): void {
    this.clearReadingSyncTimer();
    this.flushReadingAfterRun = false;
    this.epoch += 1;
    this.abort.abort();
    this.abort = new AbortController();
    this.running = null;
  }

  deactivate(): void {
    this.stop();
    this.scope = null;
    this.context = null;
    this.activeBindingKey = undefined;
    this.confirmedPaperOrganization = undefined;
    this.publish({
      status: 'signed-out',
      identity: null,
      workspace: null,
      syncing: false,
      needsLogin: false,
      devices: [],
      conflicts: [],
      lastSyncedAt: null,
      error: null,
    });
  }

  requireLogin(error = new ClientError('AUTH_REQUIRED')): void {
    this.clearReadingSyncTimer();
    this.flushReadingAfterRun = false;
    this.abort.abort();
    this.running = null;
    this.publish({
      ...(this.snapshot.status === 'binding' ? { status: 'error' as const } : {}),
      needsLogin: true,
      syncing: false,
      error,
    });
  }

  async bind(deviceName: string, retainCurrent = false): Promise<void> {
    const retainedIdentity = retainCurrent && this.snapshot.status === 'ready' ? this.snapshot.identity : null;
    const bindingKey = this.binding.key?.();
    if (retainedIdentity && bindingKey !== this.activeBindingKey) {
      this.deactivate();
      this.publish({ status: 'error', error: new ClientError('ACCOUNT_CHANGED') });
      return;
    }
    if (retainedIdentity) this.stop();
    else this.deactivate();
    this.activeBindingKey = bindingKey;
    const epoch = this.epoch;
    const guard = () => this.current(epoch) && this.binding.key?.() === bindingKey;
    const current = () => {
      if (this.epoch !== epoch || this.abort.signal.aborted) return false;
      if (!guard()) {
        this.deactivate();
        this.publish({ status: 'error', error: new ClientError('ACCOUNT_CHANGED') });
        return false;
      }
      return true;
    };
    this.publish(retainedIdentity ? { syncing: true } : { status: 'binding' });
    try {
      if (!this.snapshot.online && this.binding.read) throw new ClientError('NETWORK_UNAVAILABLE', true);
      await this.binding.prepare?.(this.abort.signal);
      if (!current()) return;
      const identity = await this.api.register(deviceName, this.abort.signal);
      if (!current()) return;
      if (retainedIdentity && retainedIdentity.accountId !== identity.accountId) {
        this.deactivate();
        this.publish({ status: 'error', error: new ClientError('ACCOUNT_CHANGED') });
        return;
      }
      await this.binding.activate?.(identity);
      if(!current())return;
      await this.activate(identity, epoch, false, guard);
      if (!current()) return;
      try { await this.binding.write?.(identity); }
      catch (error) { if (current()) this.publish({ error: safeError(error) }); }
    } catch (error) {
      if (!current()) return;
      const safe = safeError(error);
      if (retainedIdentity) {
        if (safe.code === 'SESSION_REVOKED') await this.binding.remove?.().catch(() => undefined);
        if (current()) this.publish({ syncing: false, needsLogin: true, error: safe });
        return;
      }
      if (this.binding.read && ['NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT', 'AUTH_REQUIRED'].includes(safe.code)) {
        try {
          const cached = await this.binding.read();
          if (!current()) return;
          if (cached) {
            await this.binding.activate?.(cached);
            if(!current())return;
            await this.activate(cached, epoch, true, guard);
            if (current()) this.publish({ error: safe });
            return;
          }
        } catch (cachedError) {
          if (current()) this.publish({ status: 'error', error: safeError(cachedError) });
          return;
        }
      }
      if (safe.code === 'SESSION_REVOKED') await this.binding.remove?.().catch(() => undefined);
      if (current()) this.publish({ status: 'error', error: safe });
    }
  }

  private async activate(identity: AccountIdentity, epoch: number, offline: boolean, guard: () => boolean): Promise<void> {
    const scope = { apiBaseUrl: this.apiBaseUrl, accountId: identity.accountId };
    const organization = !offline && this.supportsPaperOrganization();
    const richNotes=!offline&&this.supportsRichNotes(),aiConversations=!offline&&this.supportsAiConversations(),graphRelations=!offline&&this.supportsGraphRelations();
    const workspace = await this.store.update(
        scope,
        (previous) => {
          if (!previous) {
            if (offline) throw new ClientError('AUTH_REQUIRED');
            return {
              sync: createAccountState(identity.accountId, identity.device.id),
              pendingResolutions: {},
              ...(organization ? { paperOrganizationVersion: 1 as const } : {}),
              ...(richNotes?{richNotesVersion:1 as const}:{}),...(aiConversations?{aiConversationsVersion:1 as const}:{}),...(graphRelations?{graphRelationsVersion:1 as const}:{}),
            };
          }
          if (previous.sync.accountId !== identity.accountId)
            throw new ClientError('STORAGE_CORRUPT');
          const resumed = previous.sync.deviceId === identity.device.id
            ? resumeAfterRestart(previous.sync) : rebindDevice(previous.sync, identity.device.id);
          const retained={...previous};
          if(!offline&&!richNotes)delete retained.richNotesVersion;
          if(!offline&&!aiConversations)delete retained.aiConversationsVersion;
          if(!offline&&!graphRelations)delete retained.graphRelationsVersion;
          return {
            ...retained,
            // Re-read the feed once when opting in. Existing records and all local
            // operations remain intact while equal-revision metadata is hydrated.
            sync: (organization && !previous.paperOrganizationVersion)||(richNotes&&!previous.richNotesVersion)||(aiConversations&&!previous.aiConversationsVersion)||(graphRelations&&!previous.graphRelationsVersion)
              ? { ...resumed, cursor: null } : resumed,
            ...(organization ? { paperOrganizationVersion: 1 as const } : {}),
            ...(richNotes?{richNotesVersion:1 as const}:{}),...(aiConversations?{aiConversationsVersion:1 as const}:{}),...(graphRelations?{graphRelationsVersion:1 as const}:{}),
          };
        },
        guard,
      );
      if (!guard()) throw new ClientError('ACCOUNT_CHANGED');
      if (!offline) this.confirmedPaperOrganization = organization;
      this.scope = scope;
      this.context = getSyncContext(workspace.sync);
      this.publish({ status: 'ready', identity, workspace, syncing: false, needsLogin: offline, error: null });
  }

  private async update(
    epoch: number,
    reducer: (value: StoredWorkspace) => StoredWorkspace,
  ): Promise<StoredWorkspace> {
    const scope = this.scope;
    const context = this.context;
    this.assertBinding(epoch);
    if (!scope || !context) throw new ClientError('ACCOUNT_CHANGED');
    const next = await this.store.update(
      scope,
      (value) => {
        if (!value || !sameContext(getSyncContext(value.sync), context))
          throw new ClientError('ACCOUNT_CHANGED');
        return reducer(value);
      },
      () => this.sameBinding(epoch),
    );
    this.assertBinding(epoch);
    this.publish({ workspace: next });
    return next;
  }

  /** beforeCommit is a trusted, synchronous, read-only check of the transaction's current state. */
  async save(
    edit: LocalEdit,
    expectedRevision?: number,
    beforeCommit?: (state: Readonly<AccountSyncState>, workspace?: Readonly<StoredWorkspace>) => void,
  ): Promise<void> {
    const epoch = this.epoch;
    try {
      // Local position persistence stays fast. Reserve its network interval
      // before the transaction, so an already running sync cannot pick up a
      // newly committed scrolling checkpoint and bypass this coalescing.
      if (edit.entityType === 'readingPosition') this.deferReadingSync();
      await this.update(epoch, (value) => {
        if(!this.supportedContent(edit,value,true))throw new ClientError('SYNC_FEATURE_UNAVAILABLE');
        if (
          expectedRevision !== undefined &&
          (getVisibleEntity(value.sync, edit.entityType, edit.entityId)?.revision ?? 0) !==
            expectedRevision
        )
          throw new ClientError('EDIT_CHANGED');
        beforeCommit?.(value.sync, value);
        return {
          ...value,
          sync: queueLocalEdit(value.sync, edit, {
            opId: this.makeId(),
            clientCreatedAt: this.now(),
          }),
        };
      });
      // Saving is complete only after the IndexedDB transaction commits.
      if (!this.snapshot.needsLogin) {
        if (edit.entityType === 'readingPosition') this.deferReadingSync();
        else void this.syncNow();
      }
    } catch (error) {
      this.assertBinding(epoch);
      const safe = safeError(error);
      if (epoch === this.epoch) this.publish({ error: safe });
      throw safe;
    }
  }

  /** A result UUID identifies one new note across retries and uncertain acknowledgements. */
  async saveGraphRelation(input:GraphRelationPlan,guard:()=>boolean=()=>true):Promise<void>{
    const plan=structuredClone(input);await this.save(plan.edit,plan.expected?.revision??0,sync=>{if(!guard())throw new ClientError('ACCOUNT_CHANGED');assertGraphRelationPlan(plan,listVisibleEntities(sync));});
  }

  async saveNewNoteOnce(entityId: string, note: NoteData,
    beforeCommit?: (state: Readonly<AccountSyncState>) => void): Promise<boolean> {
    const validated = validateEntityData('note', note);
    if (!validated.ok) throw new ClientError('EDIT_CHANGED');
    const data = structuredClone(validated.value), epoch = this.epoch;
    const edit: LocalEdit = { entityType: 'note', entityId, mutation: 'put', data };
    let created = false;
    await this.update(epoch, value => {
      beforeCommit?.(value.sync);
      if (!this.supportedContent(edit, value, true)) throw new ClientError('SYNC_FEATURE_UNAVAILABLE');
      const existing = getVisibleEntity(value.sync, 'note', entityId);
      if (existing) {
        if (existing.deleted || canonicalJson(existing.data) !== canonicalJson(data)) throw new ClientError('EDIT_CHANGED');
        created = false; return value;
      }
      created = true;
      return { ...value, sync: queueLocalEdit(value.sync, edit, { opId: this.makeId(), clientCreatedAt: this.now() }) };
    });
    if (created && !this.snapshot.needsLogin) void this.syncNow();
    return created;
  }

  /** Exact revision comparison prevents stale editor/cancel callbacks and competing tabs from overwriting work. */
  async saveReviewProject(input:ReviewProject,expected:{id:string;revision:number}|null,guard:()=>boolean=()=>true):Promise<ReviewProject>{
    const project=validateReviewProject(input),epoch=this.epoch;
    const next=await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');
      const current=value.reviewProject;
      if(expected===null){if(current||project.revision!==1)throw new ClientError('EDIT_CHANGED');}
      else if(!current||current.id!==expected.id||current.revision!==expected.revision||project.id!==current.id||project.revision!==current.revision+1)throw new ClientError('EDIT_CHANGED');
      try{assertReviewSourcesCurrent(project,value.sync);}catch{throw new ClientError('EDIT_CHANGED');}return {...value,reviewProject:project};
    });return next.reviewProject!;
  }
  async clearReviewProject(id:string,revision:number,guard:()=>boolean=()=>true):Promise<void>{
    const epoch=this.epoch;await this.update(epoch,value=>{if(!guard())throw new ClientError('ACCOUNT_CHANGED');if(value.reviewProject?.id!==id||value.reviewProject.revision!==revision)throw new ClientError('EDIT_CHANGED');const{reviewProject:_project,...rest}=value;return rest;});
  }


  async refreshAgentMetadataSession():Promise<AgentMetadataSession|null>{const next=await this.update(this.epoch,value=>value);return next.agentMetadataSession??null;}
  /** Private diagnostics are retained even if a same-account source changed after the query. */
  async saveAgentMetadataSession(input:AgentMetadataSession,expected:{id:string;revision:number}|null,guard:()=>boolean=()=>true):Promise<AgentMetadataSession>{
    const session=validateAgentMetadataSession(input),epoch=this.epoch;const next=await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');const old=value.agentMetadataSession;if(old&&canonicalJson(old)===canonicalJson(session))return value;
      if(expected===null){if(old||session.revision!==1)throw new ClientError('EDIT_CHANGED');}
      else if(!old||old.id!==expected.id||old.revision!==expected.revision||(session.id===old.id?session.revision!==old.revision+1:session.revision!==1))throw new ClientError('EDIT_CHANGED');
      return{...value,agentMetadataSession:session,agentMetadataCooldownUntil:Math.max(value.agentMetadataCooldownUntil??0,session.cooldownUntil)};
    });return next.agentMetadataSession!;
  }
  async beginAgentMetadataRequest(input:AgentMetadataRequest,expected:{id:string;revision:number},guard:()=>boolean=()=>true):Promise<AgentMetadataSession>{
    const request=validateAgentMetadataRequest(input),epoch=this.epoch;const next=await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');const s=value.agentMetadataSession;if(!s||s.id!==expected.id||s.revision!==expected.revision||Date.parse(this.now())<Math.max(s.cooldownUntil,value.agentMetadataCooldownUntil??0))throw new ClientError('EDIT_CHANGED');assertAgentMetadataCurrent(s,externalLibraryEntities(value));return{...value,agentMetadataSession:beginAgentMetadataQuery(s,request)};
    });return next.agentMetadataSession!;
  }
  /** A selected candidate and publication marker commit together. Library writes still require normal item approval. */
  async adoptAgentMetadataPlan(sessionId:string,choices:AgentMetadataChoice[],expected:{sessionRevision:number;agentRevision:number|null;proposalDigest:string},guard:()=>boolean=()=>true):Promise<{proposalId:string;replayed:boolean}>{
    const key=metadataPublicationKey(sessionId,choices),epoch=this.epoch;let result!:{proposalId:string;replayed:boolean};await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');const s=value.agentMetadataSession;if(!s||s.id!==sessionId)throw new ClientError('EDIT_CHANGED');const marker=s.publications.find(p=>p.key===key);
      if(marker){if(marker.proposalDigest!==expected.proposalDigest)throw new ClientError('EDIT_CHANGED');result={proposalId:marker.proposalId,replayed:true};return value;}
      if(s.revision!==expected.sessionRevision||(value.agentState?.revision??null)!==expected.agentRevision)throw new ClientError('EDIT_CHANGED');assertAgentMetadataCurrent(s,externalLibraryEntities(value));const proposal=buildAgentMetadataProposal(s,choices);
      if(proposal.digest!==expected.proposalDigest||value.agentState?.receipts.some(r=>r.proposalId===proposal.id))throw new ClientError('EDIT_CHANGED');result={proposalId:proposal.id,replayed:false};
      return{...value,agentMetadataSession:markAgentMetadataPublished(s,key,proposal),agentState:withAgentProposal(value.agentState??emptyAgentState(),proposal)};
    });return result;
  }

  async refreshAgentConversation():Promise<AgentConversation|null>{const next=await this.update(this.epoch,value=>value);return next.agentConversation??null;}
  /** Stores private diagnostics, including a received response after source changes. Does not send or apply anything. */
  async saveAgentConversation(input:AgentConversation,expected:{id:string;revision:number}|null,guard:()=>boolean=()=>true):Promise<AgentConversation>{
    const conversation=validateAgentConversation(input),epoch=this.epoch;const next=await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');const old=value.agentConversation;
      if(old&&canonicalJson(old)===canonicalJson(conversation))return value;
      if(expected===null){if(old||conversation.revision!==1)throw new ClientError('EDIT_CHANGED');}
      else if(!old||old.id!==expected.id||old.revision!==expected.revision||(conversation.id===old.id?conversation.revision!==old.revision+1:conversation.revision!==1))throw new ClientError('EDIT_CHANGED');
      return{...value,agentConversation:conversation};
    });return next.agentConversation!;
  }

  prepareGraphEvidenceFile(input:unknown):GraphEvidenceSnapshot{
    this.assertBinding(this.epoch);if(!this.scope||this.snapshot.status!=='ready')throw new ClientError('ACCOUNT_CHANGED');
    const snapshot=readStoredGraphEvidence(input);assertGraphEvidenceAccount(snapshot,this.scope);return snapshot;
  }
  async refreshGraphEvidence():Promise<GraphEvidenceAdoption|null>{
    const scope=this.scope;if(!scope)throw new ClientError('ACCOUNT_CHANGED');
    const next=await this.update(this.epoch,value=>{if(value.graphEvidence)assertGraphEvidenceAccount(value.graphEvidence.snapshot,scope);return value;});return next.graphEvidence??null;
  }
  /** Import only the exact selected cache edges, after checking sources inside the storage transaction. */
  async adoptGraphEvidence(input:GraphEvidenceSnapshot,edgeIds:readonly string[],expected:string|null,guard:()=>boolean=()=>true):Promise<GraphEvidenceAdoption>{
    const snapshot=readStoredGraphEvidence(input),scope=this.scope,epoch=this.epoch;if(!scope)throw new ClientError('ACCOUNT_CHANGED');assertGraphEvidenceAccount(snapshot,scope);
    const adoption=readGraphEvidenceAdoption({version:1,snapshot,edgeIds:[...edgeIds],adoptedAt:this.now()}),desired=graphEvidenceAdoptionKey(adoption);
    const next=await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');
      if(graphEvidenceAdoptionKey(value.graphEvidence)===desired)return value;
      if(graphEvidenceAdoptionKey(value.graphEvidence)!==expected)throw new ClientError('EDIT_CHANGED');
      try{assertGraphEvidenceSelection(snapshot,adoption.edgeIds,value);}catch{throw new ClientError('EDIT_CHANGED');}
      return{...value,graphEvidence:adoption};
    });return next.graphEvidence!;
  }
  async clearGraphEvidence(expected:string,guard:()=>boolean=()=>true):Promise<void>{
    await this.update(this.epoch,value=>{if(!guard())throw new ClientError('ACCOUNT_CHANGED');if(!value.graphEvidence)return value;
      if(graphEvidenceAdoptionKey(value.graphEvidence)!==expected)throw new ClientError('EDIT_CHANGED');const{graphEvidence:_evidence,...rest}=value;return rest;});
  }

  async refreshRetrievalSession():Promise<RetrievalSession|null>{const next=await this.update(this.epoch,value=>value);return next.retrievalSession??null;}
  async saveRetrievalSession(input:RetrievalSession,expected:{requestId:string;revision:number}|null,guard:()=>boolean=()=>true):Promise<RetrievalSession>{
    const session=readRetrievalSession(input),epoch=this.epoch;
    const next=await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');const old=value.retrievalSession;
      if(old&&canonicalJson(old)===canonicalJson(session))return value;
      if(expected===null){if(old||session.revision!==1)throw new ClientError('EDIT_CHANGED');}
      else if(!old||old.request.requestId!==expected.requestId||old.revision!==expected.revision
        ||(old.request.requestId===session.request.requestId?session.revision!==old.revision+1:session.revision!==1||old.status==='uncertain'))throw new ClientError('EDIT_CHANGED');
      if(old&&old.request.requestId===session.request.requestId){
        if(canonicalJson(old.request)!==canonicalJson(session.request)||old.receipt&&session.receipt?.resultDigest!==old.receipt.resultDigest
          ||!({prepared:[],uncertain:['absent','complete','removed'],absent:['absent','removed'],complete:['complete','removed'],removed:['removed']}[old.status] as string[]).includes(session.status))throw new ClientError('EDIT_CHANGED');
      }
      return{...value,retrievalSession:session};
    });return next.retrievalSession!;
  }
  /** The original request is durably marked unknown before a network action. */
  async beginRetrievalRequest(expected:{requestId:string;revision:number},guard:()=>boolean=()=>true):Promise<RetrievalSession>{
    const epoch=this.epoch;const next=await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');const old=value.retrievalSession;
      if(!old||old.request.requestId!==expected.requestId||old.revision!==expected.revision)throw new ClientError('EDIT_CHANGED');
      try{assertRetrievalSourcesCurrent(old.request,value.sync,value.pendingResolutions);}catch{throw new ClientError('EDIT_CHANGED');}
      return{...value,retrievalSession:beginRetrievalSession(old)};
    });return next.retrievalSession!;
  }
  async clearRetrievalSession(expected:{requestId:string;revision:number},guard:()=>boolean=()=>true):Promise<void>{
    await this.update(this.epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');const old=value.retrievalSession;
      if(!old||old.request.requestId!==expected.requestId||old.revision!==expected.revision||old.status==='uncertain')throw new ClientError('EDIT_CHANGED');
      const{retrievalSession:_session,...rest}=value;return rest;
    });
  }
  /** A paid request cannot begin until this uncertain intent is durably acknowledged. No replay of an unknown model call. */
  async beginAgentConversationTurn(input:AgentModelRequest,provider:AiProviderConfig,expected:{id:string;revision:number},guard:()=>boolean=()=>true):Promise<AgentConversation>{
    const request=validateAgentModelRequest(input),epoch=this.epoch;const next=await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');const c=value.agentConversation;if(!c||c.id!==expected.id||c.revision!==expected.revision)throw new ClientError('EDIT_CHANGED');assertAgentConversationCurrent(c,externalLibraryEntities(value));
      return{...value,agentConversation:beginAgentModelTurn(c,request,provider)};
    });return next.agentConversation!;
  }
  async approveAgentConversationContexts(conversationId:string,requestId:string,input:AgentContext[],expectedRevision:number,guard:()=>boolean=()=>true):Promise<AgentConversation>{
    const epoch=this.epoch;const next=await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');const current=value.agentConversation;if(!current||current.id!==conversationId||current.revision!==expectedRevision||current.turns.at(-1)?.id!==requestId)throw new ClientError('EDIT_CHANGED');
      const entities=externalLibraryEntities(value),contexts=validateAgentContexts(input,current.targets);assertAgentConversationCurrent(current,entities);assertAgentContextsCurrent(contexts,entities);return{...value,agentConversation:approveAgentContextRequest(current,contexts)};
    });return next.agentConversation!;
  }
  /** Saves the model suggestion and its once-only publication marker together; library changes still require ordinary item approval. */
  async adoptAgentModelPlan(conversationId:string,requestId:string,expectedAgentRevision:number|null,guard:()=>boolean=()=>true):Promise<{proposalId:string;replayed:boolean}>{
    const epoch=this.epoch;let result!:{proposalId:string;replayed:boolean};await this.update(epoch,value=>{
      if(!guard())throw new ClientError('ACCOUNT_CHANGED');const current=value.agentConversation,turn=current?.turns.at(-1);if(!current||current.id!==conversationId||!turn||turn.id!==requestId||turn.status!=='complete')throw new ClientError('EDIT_CHANGED');
      const response=parseAgentModelResponse(turn.text,turn.request);if(response.kind!=='plan')throw new ClientError('EDIT_CHANGED');if(turn.proposalSaved){result={proposalId:response.proposal.id,replayed:true};return value;}
      if((value.agentState?.revision??null)!==expectedAgentRevision||value.agentState?.receipts.some(r=>r.proposalId===response.proposal.id))throw new ClientError('EDIT_CHANGED');assertAgentConversationCurrent(current,externalLibraryEntities(value));
      const conversation=structuredClone(current);conversation.turns[conversation.turns.length-1].proposalSaved=true;conversation.revision++;result={proposalId:response.proposal.id,replayed:false};
      return{...value,agentConversation:validateAgentConversation(conversation),agentState:withAgentProposal(value.agentState??emptyAgentState(),withAgentProposalEvidence(response.proposal,[modelEvidenceFromTurn(current,turn)]))};
    });return result;
  }
  async refreshAgentState():Promise<AgentState|null>{const next=await this.update(this.epoch,value=>value);return next.agentState??null;}
  async saveAgentState(input:AgentState,expectedRevision:number|null,guard:()=>boolean=()=>true):Promise<AgentState>{
    const agent=validateAgentState(input),epoch=this.epoch;const next=await this.update(epoch,value=>{if(!guard())throw new ClientError('ACCOUNT_CHANGED');if(expectedRevision===null){if(value.agentState||agent.revision!==1)throw new ClientError('EDIT_CHANGED');}else if(!value.agentState||value.agentState.revision!==expectedRevision||agent.revision!==expectedRevision+1)throw new ClientError('EDIT_CHANGED');return{...value,agentState:agent};});return next.agentState!;
  }
  async approveAgentProposal(input:AgentApproval,guard:()=>boolean=()=>true):Promise<AgentApplyResult>{
    const approval=validateAgentApproval(input),epoch=this.epoch;let result!:AgentApplyResult,changed=false;
    await this.update(epoch,value=>{if(!guard())throw new ClientError('ACCOUNT_CHANGED');if(!value.agentState)throw new ClientError('EDIT_CHANGED');
      try{const supported=this.supportsPaperOrganization()||Boolean((!this.snapshot.online||this.snapshot.needsLogin)&&value.paperOrganizationVersion===1),materialized=materializeAgentApproval(value.agentState,externalLibraryEntities(value),approval,Date.parse(this.now()),supported);result=materialized.result;changed=materialized.edits.length>0;return{...value,agentState:materialized.state,sync:changed?queueLocalApprovedPaperPuts(value.sync,materialized.edits,materialized.identities):value.sync};}
      catch(error){if(error instanceof AgentError)throw new ClientError(error.code==='UNSUPPORTED'?'SYNC_FEATURE_UNAVAILABLE':error.code==='LIMIT'?'AGENT_CAPACITY':'EDIT_CHANGED');if(error instanceof SyncStateError)throw new ClientError(error.code==='LOCAL_CAPACITY_EXCEEDED'?'AGENT_CAPACITY':'EDIT_CHANGED');throw error;}
    });if(changed&&!this.snapshot.needsLogin)void this.syncNow();return result;
  }
  async refreshRadarState():Promise<RadarState|null>{const next=await this.update(this.epoch,value=>value);return next.radarState??null;}
  async saveRadarState(input:RadarState,expectedRevision:number|null,guard:()=>boolean=()=>true):Promise<RadarState>{
    const radar=validateRadarState(input),epoch=this.epoch;const next=await this.update(epoch,value=>{if(!guard())throw new ClientError('ACCOUNT_CHANGED');if(expectedRevision===null){if(value.radarState||radar.revision!==1)throw new ClientError('EDIT_CHANGED');}else if(!value.radarState||value.radarState.revision!==expectedRevision||radar.revision!==expectedRevision+1)throw new ClientError('EDIT_CHANGED');return{...value,radarState:radar};});return next.radarState!;
  }
  async adoptRadarCandidate(input:RadarAdoptionPlan,guard:()=>boolean=()=>true):Promise<RadarAdoptionResult>{
    const plan=validateRadarAdoption(input),epoch=this.epoch;let result!:RadarAdoptionResult,changed=false;
    await this.update(epoch,value=>{if(!guard())throw new ClientError('ACCOUNT_CHANGED');if(!value.radarState)throw new ClientError('EDIT_CHANGED');let materialized;try{const supported=this.supportsPaperOrganization()||Boolean((!this.snapshot.online||this.snapshot.needsLogin)&&value.paperOrganizationVersion===1);materialized=materializeRadarAdoption(value.radarState,externalLibraryEntities(value),plan,Date.parse(this.now()),supported);}catch(error){if(error instanceof RadarError)throw new ClientError(error.code==='UNSUPPORTED'?'SYNC_FEATURE_UNAVAILABLE':'EDIT_CHANGED');throw error;}result=materialized.result;changed=Boolean(materialized.edit);return{...value,radarState:materialized.state,sync:materialized.edit?queueLocalEdit(value.sync,materialized.edit,{opId:plan.id,clientCreatedAt:this.now()}):value.sync};});if(changed&&!this.snapshot.needsLogin)void this.syncNow();return result;
  }

  async prepareRemoteTask(request: RemoteTaskRequest): Promise<RemoteTaskRequest> {
    const captured = validateRemoteTaskRequest(request), epoch = this.epoch;
    const updated = await this.update(epoch, value => {
      if (value.remoteBatch) throw new ClientError('REMOTE_REQUEST_PENDING');
      if (value.remoteTaskIntent && canonicalJson(value.remoteTaskIntent.request) !== canonicalJson(captured))
        throw new ClientError('REMOTE_REQUEST_PENDING');
      const version = getVisibleEntity(value.sync, 'attachmentVersion', captured.versionId);
      const versionData = version?.data && 'mediaType' in version.data ? version.data : null;
      const paper = versionData ? getVisibleEntity(value.sync, 'paper', versionData.paperId) : null;
      if (!version?.data || version.deleted || version.revision < 1 || !paper?.data || paper.deleted || paper.revision < 1)
        throw new ClientError('EDIT_CHANGED');
      return { ...value, remoteTaskIntent: { version: 1, request: captured } };
    });
    return updated.remoteTaskIntent!.request;
  }

  async clearRemoteTaskIntent(requestId: string): Promise<void> {
    const epoch = this.epoch;
    await this.update(epoch, value => {
      if (value.remoteTaskIntent?.request.requestId !== requestId) return value;
      const { remoteTaskIntent: _intent, ...remaining } = value;
      return remaining;
    });
  }

  async createRemoteBatch(input: RemoteBatch, guard: () => boolean = () => true): Promise<RemoteBatch> {
    const captured = validateRemoteBatchDraft(input), epoch = this.epoch;
    const next = await this.update(epoch, value => {
      if (!guard()) throw new ClientError('ACCOUNT_CHANGED');
      if (value.remoteTaskIntent) throw new ClientError('REMOTE_REQUEST_PENDING');
      if (value.remoteBatch) {
        if (remoteBatchIdentity(value.remoteBatch) !== remoteBatchIdentity(captured)) throw new ClientError('REMOTE_REQUEST_PENDING');
        return value;
      }
      try { for (const item of captured.items) assertRemoteBatchTarget(value.sync,item); }
      catch { throw new ClientError('EDIT_CHANGED'); }
      return {...value,remoteBatch:captured};
    });
    return next.remoteBatch!;
  }
  private async updateRemoteBatch(id: string, change: (batch: RemoteBatch, sync: Readonly<AccountSyncState>) => RemoteBatch,
    guard: () => boolean): Promise<RemoteBatch> {
    validateRemoteTaskId(id); const epoch = this.epoch;
    const next = await this.update(epoch,value=>{
      if (!guard() || !value.remoteBatch || value.remoteBatch.id!==id) throw new ClientError('ACCOUNT_CHANGED');
      let batch:RemoteBatch;
      try { batch=validateRemoteBatch(change(value.remoteBatch,value.sync)); }
      catch(error){if(error instanceof ClientError)throw error;throw new ClientError('EDIT_CHANGED');}
      return {...value,remoteBatch:batch};
    });
    return next.remoteBatch!;
  }
  async markRemoteBatchAttempt(id:string,requestId:string,guard:()=>boolean=()=>true):Promise<RemoteBatch>{
    validateRemoteTaskId(requestId);
    return this.updateRemoteBatch(id,(batch,sync)=>{
      const index=batch.items.findIndex(i=>i.request.requestId===requestId),item=batch.items[index];
      if(batch.cancelRequested||!item||!['pending','uncertain'].includes(item.state))throw new ClientError('EDIT_CHANGED');
      assertRemoteBatchTarget(sync,item);
      return {...batch,items:batch.items.map((i,n)=>n===index?{...i,state:'uncertain',failure:null}:i)};
    },guard);
  }
  async acknowledgeRemoteBatchRequest(id:string,input:RemoteTaskRequestStatus,cancelAcknowledged=false,guard:()=>boolean=()=>true):Promise<RemoteBatch>{
    const status=validateRemoteTaskRequestStatus(input);
    return this.updateRemoteBatch(id,batch=>{
      const index=batch.items.findIndex(i=>i.request.requestId===status.requestId);if(index<0)throw new ClientError('EDIT_CHANGED');
      const current=batch.items[index],updated=remoteBatchReceipt(current,status,batch.profile);
      if(cancelAcknowledged&&!batch.cancelRequested)throw new ClientError('EDIT_CHANGED');
      if(updated.taskId&&current.taskId&&updated.taskId!==current.taskId)throw new ClientError('EDIT_CHANGED');
      return {...batch,items:batch.items.map((i,n)=>n===index?{...updated,cancelAcknowledged:updated.cancelAcknowledged||cancelAcknowledged}:i)};
    },guard);
  }
  async recordRemoteBatchFailure(id:string,requestId:string,failure:RemoteBatchFailure,guard:()=>boolean=()=>true):Promise<RemoteBatch>{
    validateRemoteTaskId(requestId);
    return this.updateRemoteBatch(id,batch=>{
      const item=batch.items.find(i=>i.request.requestId===requestId);if(!item)throw new ClientError('EDIT_CHANGED');
      return {...batch,items:batch.items.map(i=>i===item&&i.state==='uncertain'?{...i,failure}:i)};
    },guard);
  }
  async stopRemoteBatch(id:string,guard:()=>boolean=()=>true):Promise<RemoteBatch>{
    return this.updateRemoteBatch(id,batch=>stoppedRemoteBatch(batch),guard);
  }
  async clearRemoteBatch(id:string,guard:()=>boolean=()=>true):Promise<void>{
    validateRemoteTaskId(id);const epoch=this.epoch;
    await this.update(epoch,value=>{
      if(!guard()||value.remoteBatch?.id!==id)throw new ClientError('ACCOUNT_CHANGED');
      if(!canClearRemoteBatch(value.remoteBatch))throw new ClientError('REMOTE_REQUEST_PENDING');
      const {remoteBatch:_batch,...remaining}=value;return remaining;
    });
  }

  async importLibrary(
    archive: LibraryArchive,
    selection: readonly string[] | undefined,
    reviewedSignature: string,
    incoming?: PreparedIncomingImport,
  ): Promise<LibraryImportSummary> {
    const epoch = this.epoch;
    let summary: LibraryImportSummary | undefined;
    try {
      await this.update(epoch, (value) => {
        try {
          const request = incoming === undefined ? undefined : assertPreparedIncomingImport(incoming);
          // Prepared inputs are detached and deeply frozen. Do not let a caller
          // attach a receipt to a different archive or selection after review.
          if (request && (archive !== request.archive || selection !== (request.selection ?? undefined)))
            throw new ClientError('IMPORT_CHANGED');
          if (request) {
            // A committed request is authoritative even after local duplicates,
            // capabilities or the old review signature have changed.
            const previous = findIncomingReceipt(value.incomingReceipts ?? [], request);
            if (previous) {
              this.assertBinding(epoch);
              summary = previous;
              return value;
            }
          }
          const plan = planLibraryImport(request?.archive ?? archive, listVisibleEntities(value.sync),
            request ? request.selection ?? undefined : selection);
          if (typeof reviewedSignature !== 'string' || plan.signature !== reviewedSignature)
            throw new ClientError('IMPORT_CHANGED');
          const organizationSupported = this.supportsPaperOrganization() || (
            this.confirmedPaperOrganization !== false &&
            (!this.snapshot.online || this.snapshot.needsLogin) &&
            value.paperOrganizationVersion === 1
          );
          if (plan.requiresPaperOrganization && !organizationSupported)
            throw new ClientError('IMPORT_UNSUPPORTED');
          if (plan.requiresRichNotes && !this.getContentCapabilities(value, true).richNotes)
            throw new ClientError('IMPORT_UNSUPPORTED');
          const imported = materializeLibraryImport(plan, this.makeId);
          const sync = queueLocalCreates(value.sync, imported.edits, imported.edits.map(() => ({
            opId: this.makeId(), clientCreatedAt: this.now(),
          })));
          const incomingReceipts = request
            ? appendIncomingReceipt(value.incomingReceipts ?? [], request, imported.summary) : undefined;
          this.assertBinding(epoch);
          summary = imported.summary;
          return { ...value, sync, ...(incomingReceipts ? { incomingReceipts } : {}) };
        } catch (error) {
          // AccountStore deliberately hides arbitrary reducer failures. Preserve
          // import-specific, input-free errors before that storage boundary.
          if (error instanceof ClientError) throw error;
          if (error instanceof IncomingReceiptError)
            throw new ClientError(error.code === 'CHANGED' ? 'IMPORT_CHANGED'
              : error.code === 'FULL' ? 'IMPORT_RECEIPT_FULL' : 'IMPORT_INVALID');
          if (error instanceof SyncStateError && error.code === 'LOCAL_CAPACITY_EXCEEDED')
            throw new ClientError('IMPORT_CAPACITY');
          throw new ClientError('IMPORT_INVALID');
        }
      });
      // Publishing and synchronization both happen only after the entire batch commits.
      this.assertBinding(epoch);
      if (this.snapshot.error?.code.startsWith('IMPORT_') || this.snapshot.error?.code === 'STORAGE_FAILED')
        this.publish({ error: null });
      if (!this.snapshot.needsLogin) void this.syncNow();
      return summary!;
    } catch (error) {
      this.assertBinding(epoch);
      const safe = error instanceof ClientError ? error : new ClientError('STORAGE_FAILED');
      this.publish({ error: safe });
      throw safe;
    }
  }

  async importExternalLibrary(
    snapshot: ExternalLibrarySnapshot,
    decisions: readonly ExternalLibraryDecision[] | undefined,
    reviewedSignature: string,
    reviewedScopeKey: string,
  ): Promise<ExternalLibrarySummary> {
    const epoch = this.epoch;
    const context = this.context;
    if (!context || reviewedScopeKey !== JSON.stringify([context.accountId, context.deviceId, context.generation]))
      throw new ClientError('ACCOUNT_CHANGED');
    let summary: ExternalLibrarySummary | undefined;
    try {
      await this.update(epoch, (value) => {
        try {
          const plan = planExternalLibraryImport(snapshot, value.externalLibraries, externalLibraryEntities(value), decisions);
          if (typeof reviewedSignature !== 'string' || plan.signature !== reviewedSignature)
            throw new ClientError('IMPORT_CHANGED');
          const imported = materializeExternalLibraryImport(plan, this.makeId);
          const sync = queueLocalPuts(value.sync, imported.edits, imported.edits.map(() => ({
            opId: this.makeId(), clientCreatedAt: this.now(),
          })));
          this.assertBinding(epoch);
          summary = imported.summary;
          // Mapping baselines and paper operations have one durability boundary.
          return { ...value, sync, externalLibraries: imported.newRegistry };
        } catch (error) {
          if (error instanceof ClientError) throw error;
          if (error instanceof SyncStateError) {
            if (error.code === 'LOCAL_CAPACITY_EXCEEDED') throw new ClientError('IMPORT_CAPACITY');
            if (['TARGET_HAS_PENDING_EDITS', 'RESTORE_REQUIRED'].includes(error.code))
              throw new ClientError('IMPORT_CHANGED');
          }
          if (error instanceof ExternalLibraryError && error.code === 'REGISTRY_TOO_LARGE')
            throw new ClientError('IMPORT_CAPACITY');
          throw new ClientError('IMPORT_INVALID');
        }
      });
      this.assertBinding(epoch);
      if (this.snapshot.error?.code.startsWith('IMPORT_') || this.snapshot.error?.code === 'STORAGE_FAILED')
        this.publish({ error: null });
      if (!this.snapshot.needsLogin) void this.syncNow();
      return summary!;
    } catch (error) {
      this.assertBinding(epoch);
      const safe = error instanceof ClientError ? error : new ClientError('STORAGE_FAILED');
      if (safe.code === 'IMPORT_CHANGED' && this.scope) {
        // Another tab can commit while this preview is open. Read its saved value
        // so the user can review again without repeatedly submitting a stale view.
        const latest = await this.store.read(this.scope);
        this.assertBinding(epoch);
        if (latest && this.context && sameContext(getSyncContext(latest.sync), this.context))
          this.publish({ workspace: latest });
      }
      this.publish({ error: safe });
      throw safe;
    }
  }

  getZoteroCursor(config: ZoteroLibraryConfig): number | null {
    return zoteroCursor(this.snapshot.workspace?.zoteroLibraries, config);
  }

  async resetZoteroCursor(config: ZoteroLibraryConfig): Promise<void> {
    const epoch = this.epoch;
    await this.update(epoch, value => ({ ...value, zoteroLibraries: updateZoteroCursor(value.zoteroLibraries, config, null) }));
  }

  async adoptZoteroRefresh(result: ZoteroRefreshResult, decisions: readonly ExternalLibraryDecision[], reviewedSignature: string, reviewedScopeKey: string): Promise<ExternalLibrarySummary> {
    const captured = validateZoteroRefreshResult(result), choices = structuredClone(decisions), epoch = this.epoch, context = this.context;
    if (!context || reviewedScopeKey !== JSON.stringify([context.accountId, context.deviceId, context.generation])) throw new ClientError('ACCOUNT_CHANGED');
    let summary: ExternalLibrarySummary | undefined;
    try {
      await this.update(epoch, value => {
        if (zoteroCursor(value.zoteroLibraries, captured.config) !== captured.expectedCursor) throw new ClientError('IMPORT_CHANGED');
        try {
          const plan = planExternalLibraryImport(captured.snapshot, value.externalLibraries, externalLibraryEntities(value), choices);
          if (plan.signature !== reviewedSignature) throw new ClientError('IMPORT_CHANGED');
          const imported = materializeExternalLibraryImport(plan, this.makeId);
          const sync = queueLocalPuts(value.sync, imported.edits, imported.edits.map(() => ({ opId: this.makeId(), clientCreatedAt: this.now() })));
          const zoteroLibraries = updateZoteroCursor(value.zoteroLibraries, captured.config, captured.nextCursor);
          summary = imported.summary;
          return { ...value, sync, externalLibraries: imported.newRegistry, zoteroLibraries };
        } catch (error) {
          if (error instanceof ClientError) throw error;
          if (error instanceof SyncStateError && error.code === 'LOCAL_CAPACITY_EXCEEDED' || error instanceof ExternalLibraryError && error.code === 'REGISTRY_TOO_LARGE') throw new ClientError('IMPORT_CAPACITY');
          if (error instanceof SyncStateError && ['TARGET_HAS_PENDING_EDITS','RESTORE_REQUIRED'].includes(error.code)) throw new ClientError('IMPORT_CHANGED');
          throw new ClientError('IMPORT_INVALID');
        }
      });
      if (!this.snapshot.needsLogin) void this.syncNow();
      return summary!;
    } catch (error) {
      this.assertBinding(epoch);
      const safe = error instanceof ClientError ? error : new ClientError('STORAGE_FAILED');
      if (safe.code === 'IMPORT_CHANGED' && this.scope) {
        const latest = await this.store.read(this.scope); this.assertBinding(epoch);
        if (latest && this.context && sameContext(getSyncContext(latest.sync), this.context)) this.publish({ workspace: latest });
      }
      this.publish({ error: safe }); throw safe;
    }
  }

  setOnline(online: boolean): void {
    if (!online) this.clearReadingSyncTimer();
    this.publish({ online });
    if (online) void this.syncNow();
  }

  private clearReadingSyncTimer(): void {
    if (this.readingSyncTimer !== null) clearTimeout(this.readingSyncTimer);
    this.readingSyncTimer = null;
  }

  private deferReadingSync(): void {
    if (this.readingSyncTimer !== null || this.snapshot.status !== 'ready' || !this.snapshot.online
      || this.snapshot.needsLogin || this.abort.signal.aborted) return;
    const epoch = this.epoch;
    // At most four automatic checkpoint sync runs/minute (normally 16
    // requests), leaving the shared account budget for other operations.
    this.readingSyncTimer = setTimeout(() => {
      this.readingSyncTimer = null;
      if (!this.current(epoch)) return;
      if (this.running) this.flushReadingAfterRun = true;
      void this.syncNow();
    }, 15000);
  }

  syncNow = (): Promise<void> => {
    const pendingReading = this.readingSyncTimer !== null;
    this.clearReadingSyncTimer();
    if (this.running) {
      if (pendingReading) this.flushReadingAfterRun = true;
      return this.running;
    }
    if (
      this.snapshot.status !== 'ready' ||
      !this.snapshot.online ||
      this.snapshot.needsLogin ||
      !this.context ||
      this.abort.signal.aborted
    )
      return Promise.resolve();
    const epoch = this.epoch;
    const task = this.performSync(epoch).finally(() => {
      if (this.epoch === epoch) {
        this.running = null;
        this.publish({ syncing: false });
        const queued = this.snapshot.workspace?.sync.outbox.filter(entry => entry.status === 'queued' && this.supportedContent(entry.operation)) ?? [];
        if (!this.snapshot.error && queued.length) {
          if (!this.flushReadingAfterRun && queued.every(entry => entry.operation.entityType === 'readingPosition')) this.deferReadingSync();
          else queueMicrotask(() => { if (this.epoch === epoch) void this.syncNow(); });
        }
        this.flushReadingAfterRun = false;
      }
    });
    this.running = task;
    return task;
  };

  private async performSync(epoch: number): Promise<void> {
    const signal = this.abort.signal;
    const context = this.context!;
    this.publish({ syncing: true, error: null });
    try {
      this.assertBinding(epoch);
      // Retry missing dependencies only after another write succeeds. Other retryable
      // rejections wait for the next sync trigger, without blocking independent edits.
      const deferred = new Map<string, number | null>();
      const resolutionErrors = new Map<string, ClientError>();
      let progress = 0;
      let budgetExhausted = false;
      const canAttempt = (opId: string): boolean => {
        const afterProgress = deferred.get(opId);
        return afterProgress === undefined || (afterProgress !== null && progress > afterProgress);
      };
      for (let sent = 0; sent < 100; sent += 1) {
        const resolution = Object.entries(this.snapshot.workspace!.pendingResolutions).find(
          ([, pending]) => canAttempt(pending.request.opId)&&this.supportedContent({entityType:pending.entityType,entityId:pending.entityId,data:'data'in pending.request?pending.request.data:null}),
        );
        if (resolution) {
          const [conflictId, pending] = resolution;
          try {
            const result = await this.sendResolution(epoch, conflictId, signal);
            if (result?.status === 'applied') {
              progress += 1;
              deferred.delete(result.opId);
              resolutionErrors.delete(result.opId);
            } else if (result?.status === 'rejected' && result.retryable) {
              deferred.set(result.opId, result.code === 'DEPENDENCY_NOT_READY' ? progress : null);
              resolutionErrors.set(
                result.opId,
                new ClientError(
                  result.code === 'ACCOUNT_STORAGE_LIMIT' ? 'ACCOUNT_STORAGE_LIMIT' : 'SYNC_FAILED',
                  true,
                ),
              );
            }
          } catch (error) {
            const safe = safeError(error);
            if (
              !safe.retryable ||
              !['NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT', 'SYNC_FAILED'].includes(safe.code)
            )
              throw error;
            if (
              this.snapshot.workspace?.pendingResolutions[conflictId]?.request.opId !==
              pending.request.opId
            )
              throw error;
            // A lost response can hide a committed resolution. Retain its exact
            // request and wait for another sync trigger before replaying it.
            deferred.set(pending.request.opId, null);
            resolutionErrors.set(pending.request.opId, safe);
          }
          if (resolutionErrors.has(pending.request.opId))
            await this.update(epoch, (value) => {
              const resolutions = { ...value.pendingResolutions };
              const current = resolutions[conflictId];
              if (current?.request.opId !== pending.request.opId)
                throw new ClientError('ACCOUNT_CHANGED');
              // Rotate whole requests so a bounded run also gives later pending
              // resolutions a turn after the next trigger or a restart.
              delete resolutions[conflictId];
              return { ...value, pendingResolutions: { ...resolutions, [conflictId]: current } };
            });
        }
        let prepared: PreparedPush | undefined;
        await this.update(epoch, (value) => {
          const index = value.sync.outbox.findIndex((entry) => {
            if (entry.status !== 'queued' && entry.status !== 'uncertain') return false;
            if (entry.operation.entityType === 'readingPosition' && this.readingSyncTimer !== null) return false;
            return canAttempt(entry.operation.opId)&&this.supportedContent(entry.operation,value);
          });
          if (index < 0) return value;
          // Reorder whole entries only; attempted operation identities and payloads
          // remain immutable, including requests whose acknowledgements were lost.
          const ordered =
            index === 0
              ? value.sync
              : {
                  ...value.sync,
                  outbox: [
                    value.sync.outbox[index],
                    ...value.sync.outbox.slice(0, index),
                    ...value.sync.outbox.slice(index + 1),
                  ],
                };
          prepared = preparePush(ordered, context, 1);
          return { ...value, sync: prepared.state };
        });
        if (!prepared?.opIds.length) {
          if (resolution) {
            if (sent === 99) budgetExhausted = true;
            continue;
          }
          break;
        }
        try {
          const response = await this.request(epoch, () => this.api.push(prepared!.request, signal));
          await this.update(epoch, (value) => {
            const sync = applyPushResults(value.sync, context, response, prepared!.opIds);
            const retryableIds = new Set(
              response.results
                .filter((result) => result.status === 'rejected' && result.retryable)
                .map((result) => result.opId),
            );
            // Keep deferred work behind the rest even if this run reaches its limit.
            return {
              ...value,
              sync: retryableIds.size
                ? {
                    ...sync,
                    outbox: [
                      ...sync.outbox.filter((entry) => !retryableIds.has(entry.operation.opId)),
                      ...sync.outbox.filter((entry) => retryableIds.has(entry.operation.opId)),
                    ],
                  }
                : sync,
            };
          });
          for (const result of response.results) {
            if (result.status === 'applied') progress += 1;
            else if (result.status === 'rejected' && result.retryable)
              deferred.set(result.opId, result.code === 'DEPENDENCY_NOT_READY' ? progress : null);
          }
        } catch (error) {
          if (epoch === this.epoch)
            await this.update(epoch, (value) => ({
              ...value,
              sync: markPushUncertain(value.sync, context, prepared!.opIds, 'REQUEST_INTERRUPTED'),
            }));
          throw error;
        }
        if (sent === 99) budgetExhausted = true;
      }
      await this.pullToCurrent(epoch, context, signal);
      const conflicts = await this.fetchConflicts(epoch, signal);
      const open = new Set(conflicts.map((conflict) => conflict.conflictId));
      const closedSincePull = Object.keys(this.snapshot.workspace!.sync.conflicts).some(
        (id) => !open.has(id) && !this.snapshot.workspace!.pendingResolutions[id],
      );
      // Another device may resolve a conflict after our first pull but before this list.
      // Observe its committed feed event before releasing the local blocked operation.
      if (closedSincePull) await this.pullToCurrent(epoch, context, signal);
      const devices = await this.request(epoch, () => this.api.devices(signal));
      if (!this.current(epoch)) return;
      // A complete authoritative list also acknowledges resolutions made on another device.
      await this.update(epoch, (value) => {
        let sync = value.sync;
        for (const conflict of Object.values(sync.conflicts)) {
          if(!this.supportedContent(conflict.attempted,value))continue;
          if (!open.has(conflict.conflictId) && !value.pendingResolutions[conflict.conflictId]) {
            sync = applyRemoteConflictResolution(sync, context, {
              conflictId: conflict.conflictId,
              record:
                sync.serverRecords[
                  entityKey(conflict.attempted.entityType, conflict.attempted.entityId)
                ] ?? null,
            });
          }
        }
        return { ...value, sync };
      });
      if (this.current(epoch)) {
        const pendingResolution = Object.values(this.snapshot.workspace!.pendingResolutions).find(
          (pending) => resolutionErrors.has(pending.request.opId),
        );
        const pendingPush = this.snapshot.workspace!.sync.outbox.find(
          (entry) => entry.status === 'queued' && deferred.has(entry.operation.opId),
        );
        const retryPending =
          Boolean(pendingResolution) ||
          Boolean(pendingPush) ||
          (budgetExhausted &&
            (Object.keys(this.snapshot.workspace!.pendingResolutions).length > 0 ||
              this.snapshot.workspace!.sync.outbox.some(
                (entry) => entry.status === 'queued' || entry.status === 'uncertain',
              )));
        const unsupportedPending=this.snapshot.workspace!.sync.outbox.some(entry=>!this.supportedContent(entry.operation))
          ||Object.values(this.snapshot.workspace!.pendingResolutions).some(pending=>!this.supportedContent({entityType:pending.entityType,entityId:pending.entityId,data:'data'in pending.request?pending.request.data:null}));
        this.publish({
          conflicts,
          devices,
          ...(retryPending ? {} : { lastSyncedAt: this.now() }),
          error: retryPending
            ? (pendingResolution && resolutionErrors.get(pendingResolution.request.opId)) ||
              new ClientError(
                pendingPush?.errorCode === 'ACCOUNT_STORAGE_LIMIT'
                  ? 'ACCOUNT_STORAGE_LIMIT'
                  : 'SYNC_FAILED',
                true,
              )
            : unsupportedPending?new ClientError('SYNC_FEATURE_UNAVAILABLE'):null,
        });
      }
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (!this.sameBinding(epoch)) {
        this.deactivate();
        this.publish({ status: 'error', error: new ClientError('ACCOUNT_CHANGED') });
        return;
      }
      const safe = safeError(error);
      if(safe.code==='ACCOUNT_CLOSED'){this.deactivate();this.publish({status:'error',error:safe});return;}
      if (
        safe.code === 'AUTH_REQUIRED' ||
        safe.code === 'SESSION_REVOKED' ||
        safe.code === 'ACCOUNT_CHANGED'
      )
        this.requireLogin(safe);
      else this.publish({ error: safe });
    }
  }

  private async pullToCurrent(
    epoch: number,
    context: SyncContext,
    signal: AbortSignal,
  ): Promise<void> {
    let hasMore = true;
    for (let page = 0; page < 100 && hasMore; page += 1) {
      this.assertBinding(epoch);
      const cursor = this.snapshot.workspace!.sync.cursor;
      const response = await this.request(epoch, () => this.api.pull(cursor, signal));
      await this.update(epoch, (value) => ({
        ...value,
        sync: applyPullPage(value.sync, context, { fromCursor: cursor, response }),
      }));
      hasMore = response.hasMore;
    }
    if (hasMore) throw new ClientError('SYNC_FAILED', true);
  }

  private async fetchConflicts(epoch: number, signal: AbortSignal): Promise<ServerConflict[]> {
    const result: ServerConflict[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 500; page += 1) {
      const response = await this.request(epoch, () => this.api.conflicts(cursor, signal));
      result.push(...response.conflicts);
      if (!response.hasMore) return result;
      if (response.nextCursor === cursor) throw new ClientError('INVALID_RESPONSE');
      cursor = response.nextCursor;
    }
    throw new ClientError('SYNC_FAILED');
  }

  async resolve(
    conflict: ServerConflict,
    decision:
      | { choice: 'current' | 'attempted' }
      | { choice: 'merged'; mutation: SyncMutation; data: EntityData | null },
    reviewed?: { consumedOverlayOpId?: string },
  ): Promise<void> {
    const epoch = this.epoch;
    if (!this.snapshot.online || this.snapshot.needsLogin)
      throw new ClientError(this.snapshot.needsLogin ? 'AUTH_REQUIRED' : 'NETWORK_UNAVAILABLE');
    if (this.running) await this.running;
    if (!this.current(epoch)) throw new ClientError('ACCOUNT_CHANGED');
    if (!this.snapshot.conflicts.some((entry) => entry.conflictId === conflict.conflictId))
      throw new ClientError('CONFLICT_CHANGED');
    const request = {
      ...decision,
      opId: this.makeId(),
      expectedRevision: conflict.currentRecord?.revision ?? 0,
    } as ConflictResolution;
    await this.update(epoch, (value) => ({
      ...value,
      pendingResolutions: value.pendingResolutions[conflict.conflictId]
        ? value.pendingResolutions
        : {
            ...value.pendingResolutions,
            [conflict.conflictId]: {
              request,
              entityType: conflict.entityType,
              entityId: conflict.entityId,
              ...(reviewed?.consumedOverlayOpId
                ? { consumedOverlayOpId: reviewed.consumedOverlayOpId }
                : {}),
            },
          },
    }));
    await this.syncNow();
  }

  private async sendResolution(
    epoch: number,
    conflictId: string,
    signal: AbortSignal,
  ): Promise<PushResult | undefined> {
    const pending = this.snapshot.workspace!.pendingResolutions[conflictId];
    if (!pending) return;
    const result = await this.request(epoch, () => this.api.resolveConflict(conflictId, pending.request, signal));
    if (
      result.opId !== pending.request.opId ||
      (result.record &&
        (result.record.entityType !== pending.entityType ||
          result.record.entityId !== pending.entityId))
    )
      throw new ClientError('INVALID_RESPONSE');
    if (result.status === 'rejected' && result.retryable) return result;
    await this.update(epoch, (value) => {
      const resolutions = { ...value.pendingResolutions };
      if (resolutions[conflictId]?.request.opId !== pending.request.opId)
        throw new ClientError('ACCOUNT_CHANGED');
      delete resolutions[conflictId];
      return {
        ...value,
        sync:
          result.status === 'applied'
            ? applyConflictResolution(value.sync, this.context!, {
                conflictId,
                record: result.record ?? null,
                consumedOverlayOpId: pending.consumedOverlayOpId,
              })
            : value.sync,
        pendingResolutions: resolutions,
      };
    });
    if (result.status !== 'applied') {
      const conflicts = await this.fetchConflicts(epoch, signal);
      if (this.current(epoch)) this.publish({ conflicts });
      throw new ClientError(result.status === 'conflict' ? 'CONFLICT_CHANGED' : 'SYNC_FAILED');
    }
    return result;
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const epoch = this.epoch;
    await this.request(epoch, () => this.api.revokeDevice(deviceId, this.abort.signal));
    if (!this.current(epoch)) throw new ClientError('ACCOUNT_CHANGED');
    const isCurrent = deviceId === this.snapshot.identity?.device.id;
    if (isCurrent) this.requireLogin(new ClientError('SESSION_REVOKED'));
    else {
      const devices = await this.request(epoch, () => this.api.devices(this.abort.signal));
      if (this.current(epoch)) this.publish({ devices });
    }
    return isCurrent;
  }

  async clearLocalData(): Promise<void> {
    this.assertBinding(this.epoch);
    const scope = this.scope;
    const identity = this.snapshot.identity;
    const generation = this.snapshot.workspace?.sync.generation ?? 0;
    if (!scope || !identity) throw new ClientError('ACCOUNT_CHANGED');
    this.stop();
    const epoch = this.epoch;
    let workspace: StoredWorkspace;
    try {
      workspace = await this.store.update(
        scope,
        () => ({
          sync: {
            ...createAccountState(identity.accountId, identity.device.id),
            generation: generation + 1,
          },
          pendingResolutions: {},
          ...(this.supportsPaperOrganization() ? { paperOrganizationVersion: 1 as const } : {}),
          ...(this.supportsRichNotes()?{richNotesVersion:1 as const}:{}),...(this.supportsAiConversations()?{aiConversationsVersion:1 as const}:{}),...(this.supportsGraphRelations()?{graphRelationsVersion:1 as const}:{}),
        }),
        () => this.sameBinding(epoch),
      );
    } catch (error) {
      this.assertBinding(epoch);
      if (this.current(epoch)) this.publish({ status: 'error', error: safeError(error) });
      throw safeError(error);
    }
    this.assertBinding(epoch);
    this.context = getSyncContext(workspace.sync);
    this.publish({
      status: 'ready',
      workspace,
      conflicts: [],
      lastSyncedAt: null,
      syncing: false,
      error: null,
    });
    await this.syncNow();
  }
}
