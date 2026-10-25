import {
  applyConflictResolution,
  applyPullPage,
  applyPushResults,
  applyRemoteConflictResolution,
  createAccountState,
  entityKey,
  getSyncContext,
  getVisibleEntity,
  markPushUncertain,
  preparePush,
  queueLocalEdit,
  rebindDevice,
  resumeAfterRestart,
  validateClientState,
  validateOperation,
  type AccountSyncState,
  type EntityData,
  type EntityType,
  type LocalEdit,
  type PreparedPush,
  type PushResult,
  type SyncContext,
  type SyncMutation,
} from '../../../../packages/sync-core/src/index.ts';
import type {
  AccountIdentity,
  ConflictResolution,
  DeviceSession,
  ServerConflict,
  SyncApi,
} from '../api.ts';
import { ClientError } from '../errors.ts';
import { AccountStore, type AccountScope } from '../storage/accountStore.ts';

interface PendingResolution {
  request: ConflictResolution;
  entityType: EntityType;
  entityId: string;
  consumedOverlayOpId?: string;
}
export interface StoredWorkspace {
  sync: AccountSyncState;
  pendingResolutions: Record<string, PendingResolution>;
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
    Object.keys(value).length !== 2 ||
    !isObject(value.pendingResolutions) ||
    !validateClientState(value.sync).ok ||
    Object.keys(value.pendingResolutions).length > 10_000
  )
    throw new ClientError('STORAGE_CORRUPT');
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
  private readonly store: AccountStore<StoredWorkspace>;
  private readonly makeId: () => string;
  private readonly now: () => string;
  private scope: AccountScope | null = null;
  private context: SyncContext | null = null;
  private epoch = 0;
  private abort = new AbortController();
  private running: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: WorkspaceSnapshot;

  constructor(options: {
    api: Api;
    apiBaseUrl: string;
    store: AccountStore<StoredWorkspace>;
    online?: boolean;
    makeId?: () => string;
    now?: () => string;
  }) {
    this.api = options.api;
    this.apiBaseUrl = options.apiBaseUrl;
    this.store = options.store;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
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
  private publish(update: Partial<WorkspaceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  private current(epoch: number): boolean {
    return this.epoch === epoch && !this.abort.signal.aborted;
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

  async bind(deviceName: string): Promise<void> {
    this.deactivate();
    const epoch = this.epoch;
    this.publish({ status: 'binding' });
    try {
      const identity = await this.api.register(deviceName, this.abort.signal);
      if (!this.current(epoch)) return;
      const scope = { apiBaseUrl: this.apiBaseUrl, accountId: identity.accountId };
      const workspace = await this.store.update(
        scope,
        (previous) => {
          if (!previous)
            return {
              sync: createAccountState(identity.accountId, identity.device.id),
              pendingResolutions: {},
            };
          if (previous.sync.accountId !== identity.accountId)
            throw new ClientError('STORAGE_CORRUPT');
          return {
            ...previous,
            sync:
              previous.sync.deviceId === identity.device.id
                ? resumeAfterRestart(previous.sync)
                : rebindDevice(previous.sync, identity.device.id),
          };
        },
        () => this.current(epoch),
      );
      if (!this.current(epoch)) return;
      this.scope = scope;
      this.context = getSyncContext(workspace.sync);
      this.publish({ status: 'ready', identity, workspace, error: null });
    } catch (error) {
      if (this.current(epoch)) this.publish({ status: 'error', error: safeError(error) });
    }
  }

  private async update(
    epoch: number,
    reducer: (value: StoredWorkspace) => StoredWorkspace,
  ): Promise<StoredWorkspace> {
    const scope = this.scope;
    const context = this.context;
    if (!scope || !context || epoch !== this.epoch) throw new ClientError('ACCOUNT_CHANGED');
    const next = await this.store.update(
      scope,
      (value) => {
        if (!value || !sameContext(getSyncContext(value.sync), context))
          throw new ClientError('ACCOUNT_CHANGED');
        return reducer(value);
      },
      () => epoch === this.epoch,
    );
    if (epoch !== this.epoch) throw new ClientError('ACCOUNT_CHANGED');
    this.publish({ workspace: next });
    return next;
  }

  async save(edit: LocalEdit, expectedRevision?: number): Promise<void> {
    const epoch = this.epoch;
    try {
      await this.update(epoch, (value) => {
        if (
          expectedRevision !== undefined &&
          (getVisibleEntity(value.sync, edit.entityType, edit.entityId)?.revision ?? 0) !==
            expectedRevision
        )
          throw new ClientError('EDIT_CHANGED');
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
      const safe = safeError(error);
      if (epoch === this.epoch) this.publish({ error: safe });
      throw safe;
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
          this.snapshot.workspace?.sync.outbox.some((entry) => entry.status === 'queued')
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
          ([, pending]) => canAttempt(pending.request.opId),
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
            return canAttempt(entry.operation.opId);
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
          const response = await this.api.push(prepared!.request, signal);
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
      const conflicts = await this.fetchConflicts(signal);
      const open = new Set(conflicts.map((conflict) => conflict.conflictId));
      const closedSincePull = Object.keys(this.snapshot.workspace!.sync.conflicts).some(
        (id) => !open.has(id) && !this.snapshot.workspace!.pendingResolutions[id],
      );
      // Another device may resolve a conflict after our first pull but before this list.
      // Observe its committed feed event before releasing the local blocked operation.
      if (closedSincePull) await this.pullToCurrent(epoch, context, signal);
      const devices = await this.api.devices(signal);
      if (!this.current(epoch)) return;
      // A complete authoritative list also acknowledges resolutions made on another device.
      await this.update(epoch, (value) => {
        let sync = value.sync;
        for (const conflict of Object.values(sync.conflicts)) {
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
            : null,
        });
      }
    } catch (error) {
      if (epoch !== this.epoch) return;
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
      if (epoch !== this.epoch) throw new ClientError('ACCOUNT_CHANGED');
      const cursor = this.snapshot.workspace!.sync.cursor;
      const response = await this.api.pull(cursor, signal);
      await this.update(epoch, (value) => ({
        ...value,
        sync: applyPullPage(value.sync, context, { fromCursor: cursor, response }),
      }));
      hasMore = response.hasMore;
    }
    if (hasMore) throw new ClientError('SYNC_FAILED', true);
  }

  private async fetchConflicts(signal: AbortSignal): Promise<ServerConflict[]> {
    const result: ServerConflict[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 500; page += 1) {
      const response = await this.api.conflicts(cursor, signal);
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
    const result = await this.api.resolveConflict(conflictId, pending.request, signal);
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
      const conflicts = await this.fetchConflicts(signal);
      if (this.current(epoch)) this.publish({ conflicts });
      throw new ClientError(result.status === 'conflict' ? 'CONFLICT_CHANGED' : 'SYNC_FAILED');
    }
    return result;
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const epoch = this.epoch;
    await this.api.revokeDevice(deviceId, this.abort.signal);
    if (!this.current(epoch)) throw new ClientError('ACCOUNT_CHANGED');
    const isCurrent = deviceId === this.snapshot.identity?.device.id;
    if (isCurrent) this.requireLogin(new ClientError('SESSION_REVOKED'));
    else {
      const devices = await this.api.devices(this.abort.signal);
      if (this.current(epoch)) this.publish({ devices });
    }
    return isCurrent;
  }

  async clearLocalData(): Promise<void> {
    const scope = this.scope;
    const identity = this.snapshot.identity;
    const generation = this.snapshot.workspace?.sync.generation ?? 0;
    if (!scope || !identity) throw new ClientError('ACCOUNT_CHANGED');
    this.stop();
    const epoch = this.epoch;
    await this.store.remove(scope);
    if (!this.current(epoch)) return;
    this.publish({
      status: 'binding',
      workspace: null,
      syncing: false,
      conflicts: [],
      lastSyncedAt: null,
    });
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
        }),
        () => this.current(epoch),
      );
    } catch (error) {
      if (this.current(epoch)) this.publish({ status: 'error', error: safeError(error) });
      throw safeError(error);
    }
    if (!this.current(epoch)) return;
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
