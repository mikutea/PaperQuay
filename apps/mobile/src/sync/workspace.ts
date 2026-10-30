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
  /** Private to this account on this device; never part of the synchronization payload. */
  externalLibraries?: ExternalLibraryRegistry;
  /** Durable, non-secret create intent. Replayed only on an explicit retry. */
  remoteTaskIntent?: { version: 1; request: RemoteTaskRequest };
  /** Private local batch ledger; every server request ID survives restart. */
  remoteBatch?: RemoteBatch;
  zoteroLibraries?: ZoteroLibraryState;
  /** One private literature-review project and its paid-call checkpoint; never synchronized. */
  reviewProject?: ReviewProject;
  /** Account-local receipts commit with imported entities and their outbox entries. */
  incomingReceipts?: IncomingImportReceipt[];
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
    Object.keys(value).some((key) => !['sync', 'pendingResolutions', 'paperOrganizationVersion','richNotesVersion','aiConversationsVersion', 'externalLibraries','remoteTaskIntent','remoteBatch','zoteroLibraries','incomingReceipts','reviewProject'].includes(key)) ||
    (value.paperOrganizationVersion !== undefined && value.paperOrganizationVersion !== 1) ||
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
    if (conflict.attempted.entityType === 'paper') blocked.add(conflict.attempted.entityId);
    if (conflict.current?.entityType === 'paper') blocked.add(conflict.current.entityId);
  }
  for (const resolution of Object.values(workspace.pendingResolutions)) {
    if (resolution.entityType === 'paper') blocked.add(resolution.entityId);
  }
  return listVisibleEntities(workspace.sync).map((entity) => entity.entityType === 'paper' && blocked.has(entity.entityId)
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
    read?: () => Promise<AccountIdentity | null>;
    write?: (identity: AccountIdentity) => Promise<void>;
    remove?: () => Promise<void>;
  };
  private readonly supportsPaperOrganization: () => boolean;
  private readonly supportsRichNotes:()=>boolean;
  private readonly supportsAiConversations:()=>boolean;
  private confirmedPaperOrganization: boolean | undefined;
  private scope: AccountScope | null = null;
  private context: SyncContext | null = null;
  private activeBindingKey: string | null | undefined;
  private epoch = 0;
  private abort = new AbortController();
  private running: Promise<void> | null = null;
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
  getContentCapabilities=(value=this.snapshot.workspace,allowOffline=true)=>{
    const remembered=allowOffline&&(!this.snapshot.online||this.snapshot.needsLogin);
    return{richNotes:this.supportsRichNotes()||Boolean(remembered&&value?.richNotesVersion),
      aiConversations:this.supportsAiConversations()||Boolean(remembered&&value?.aiConversationsVersion)};
  };
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
    return this.epoch === epoch && this.activeBindingKey === this.binding.key?.();
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
    const richNotes=!offline&&this.supportsRichNotes(),aiConversations=!offline&&this.supportsAiConversations();
    const workspace = await this.store.update(
        scope,
        (previous) => {
          if (!previous) {
            if (offline) throw new ClientError('AUTH_REQUIRED');
            return {
              sync: createAccountState(identity.accountId, identity.device.id),
              pendingResolutions: {},
              ...(organization ? { paperOrganizationVersion: 1 as const } : {}),
              ...(richNotes?{richNotesVersion:1 as const}:{}),...(aiConversations?{aiConversationsVersion:1 as const}:{}),
            };
          }
          if (previous.sync.accountId !== identity.accountId)
            throw new ClientError('STORAGE_CORRUPT');
          const resumed = previous.sync.deviceId === identity.device.id
            ? resumeAfterRestart(previous.sync) : rebindDevice(previous.sync, identity.device.id);
          const retained={...previous};
          if(!offline&&!richNotes)delete retained.richNotesVersion;
          if(!offline&&!aiConversations)delete retained.aiConversationsVersion;
          return {
            ...retained,
            // Re-read the feed once when opting in. Existing records and all local
            // operations remain intact while equal-revision metadata is hydrated.
            sync: (organization && !previous.paperOrganizationVersion)||(richNotes&&!previous.richNotesVersion)||(aiConversations&&!previous.aiConversationsVersion)
              ? { ...resumed, cursor: null } : resumed,
            ...(organization ? { paperOrganizationVersion: 1 as const } : {}),
            ...(richNotes?{richNotesVersion:1 as const}:{}),...(aiConversations?{aiConversationsVersion:1 as const}:{}),
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
      if (!this.snapshot.needsLogin) void this.syncNow();
    } catch (error) {
      this.assertBinding(epoch);
      const safe = safeError(error);
      if (epoch === this.epoch) this.publish({ error: safe });
      throw safe;
    }
  }

  /** A result UUID identifies one new note across retries and uncertain acknowledgements. */
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
    this.publish({ online });
    if (online) void this.syncNow();
  }

  syncNow = (): Promise<void> => {
    if (this.running) return this.running;
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
        if (
          !this.snapshot.error &&
          this.snapshot.workspace?.sync.outbox.some((entry) => entry.status === 'queued'&&this.supportedContent(entry.operation))
        )
          queueMicrotask(() => {
            if (this.epoch === epoch) void this.syncNow();
          });
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
          ...(this.supportsRichNotes()?{richNotesVersion:1 as const}:{}),...(this.supportsAiConversations()?{aiConversationsVersion:1 as const}:{}),
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
