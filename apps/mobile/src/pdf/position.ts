import {
  entityKey, listVisibleEntities, type AccountSyncState, type ReadingPositionData, type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import type { AccountScope } from '../storage/accountStore.ts';
import type { WorkspaceController } from '../sync/workspace.ts';
import { PdfError } from './errors.ts';
import type { PdfVersion } from './types.ts';

export type ReaderController = Pick<WorkspaceController, 'save' | 'getSnapshot'>;
export interface ReaderIdentity { accountId: string; deviceId: string; generation: number }
export interface ReadingPoint { pageIndex: number; offsetRatio: number }
export type PositionStatus = 'idle' | 'saving' | 'saved' | 'error';

export function readerIdentity(controller: ReaderController, scope: AccountScope): ReaderIdentity {
  const state = controller.getSnapshot().workspace?.sync;
  if (!state || state.accountId !== scope.accountId) throw new PdfError('ACCOUNT_CHANGED');
  return { accountId: state.accountId, deviceId: state.deviceId, generation: state.generation };
}

export function sameReaderIdentity(controller: ReaderController, identity: ReaderIdentity): boolean {
  const state = controller.getSnapshot().workspace?.sync;
  return Boolean(state && state.accountId === identity.accountId && state.deviceId === identity.deviceId && state.generation === identity.generation);
}

export function positionOwner(state: AccountSyncState, entityId: string): string | null {
  const pending = state.outbox.find((entry) => entry.operation.entityType === 'readingPosition' && entry.operation.entityId === entityId);
  return pending?.originDeviceId ?? state.serverRecords[entityKey('readingPosition', entityId)]?.modifiedByDeviceId ?? null;
}

export function ownReadingPosition(state: AccountSyncState, version: PdfVersion): VisibleEntity | null {
  return listVisibleEntities(state, 'readingPosition').filter((record) => {
    const data = record.data as ReadingPositionData | null;
    return !record.deleted && data?.attachmentVersionId === version.entityId && data.paperId === version.data.paperId
      && positionOwner(state, record.entityId) === state.deviceId;
  }).sort((left, right) => {
    const a = left.data as ReadingPositionData; const b = right.data as ReadingPositionData;
    return b.observedAt.localeCompare(a.observedAt) || b.deviceSequence - a.deviceSequence
      || right.revision - left.revision || left.entityId.localeCompare(right.entityId);
  })[0] ?? null;
}

const further = (a: ReadingPoint, b: ReadingPoint): ReadingPoint => a.pageIndex > b.pageIndex
  || (a.pageIndex === b.pageIndex && a.offsetRatio >= b.offsetRatio) ? a : b;

/** Recent position follows the user's last action; furthest progress is tracked independently. */
export class ReadingCheckpointWriter {
  private readonly controller: ReaderController;
  private readonly version: PdfVersion;
  private readonly identity: ReaderIdentity;
  private readonly sessionId: string;
  private readonly makeId: () => string;
  private readonly now: () => string;
  private readonly notify: (status: PositionStatus) => void;
  private entityId: string | null = null;
  private pending: ReadingPoint | null = null;
  private furthest: ReadingPoint = { pageIndex: 0, offsetRatio: 0 };
  private running: Promise<void> | null = null;
  private failure: unknown = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(controller: ReaderController, scope: AccountScope, version: PdfVersion, options: {
    makeId?: () => string; now?: () => string; onStatus?: (status: PositionStatus) => void; debounceMs?: number;
  } = {}) {
    this.controller = controller; this.version = version; this.identity = readerIdentity(controller, scope);
    this.makeId = options.makeId ?? (() => crypto.randomUUID()); this.now = options.now ?? (() => new Date().toISOString());
    this.sessionId = this.makeId(); this.notify = options.onStatus ?? (() => undefined);
    this.debounceMs = options.debounceMs ?? 250;
    const own = ownReadingPosition(controller.getSnapshot().workspace!.sync, version);
    if (own?.data) {
      this.entityId = own.entityId;
      const data = own.data as ReadingPositionData;
      this.furthest = { pageIndex: data.furthestPageIndex, offsetRatio: data.furthestOffsetRatio };
    }
  }

  record(point: ReadingPoint): void {
    if (this.stopped || !Number.isInteger(point.pageIndex) || point.pageIndex < 0
      || point.pageIndex >= (this.version.data.pageCount ?? 0) || !Number.isFinite(point.offsetRatio)) return;
    this.pending = { pageIndex: point.pageIndex, offsetRatio: Math.max(0, Math.min(1, point.offsetRatio)) };
    this.furthest = further(this.furthest, this.pending);
    this.notify('saving');
    if (!this.failure && !this.running && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.start(); }, this.debounceMs);
    }
  }

  private start(): void {
    if (this.running || this.stopped || !this.pending) return;
    const work = this.drain();
    this.running = work;
    void work.finally(() => { if (this.running === work) this.running = null; }).catch(() => undefined);
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.stopped) {
      const point = this.pending; this.pending = null;
      try {
        if (!sameReaderIdentity(this.controller, this.identity)) throw new PdfError('ACCOUNT_CHANGED');
        const state = this.controller.getSnapshot().workspace!.sync;
        const own = ownReadingPosition(state, this.version);
        if (own) this.entityId = own.entityId;
        this.entityId ??= this.makeId();
        const before = own?.data as ReadingPositionData | null;
        if (before) this.furthest = further(this.furthest, { pageIndex: before.furthestPageIndex, offsetRatio: before.furthestOffsetRatio });
        const sequence = (before?.deviceSequence ?? 0) + 1;
        if (!Number.isSafeInteger(sequence)) throw new PdfError('POSITION_FAILED');
        const data: ReadingPositionData = { paperId: this.version.data.paperId, attachmentVersionId: this.version.entityId,
          ...point, furthestPageIndex: this.furthest.pageIndex, furthestOffsetRatio: this.furthest.offsetRatio,
          sessionId: this.sessionId, deviceSequence: sequence, observedAt: this.now() };
        await this.controller.save({ entityType: 'readingPosition', entityId: this.entityId, mutation: 'put', data }, own?.revision ?? 0);
        if (!sameReaderIdentity(this.controller, this.identity)) throw new PdfError('ACCOUNT_CHANGED');
        this.failure = null;
        if (!this.pending) this.notify('saved');
      } catch (error) {
        this.pending ??= point;
        this.failure = error;
        this.notify('error');
        throw error;
      }
    }
  }

  async flush(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.running) { try { await this.running; } catch { /* An explicit flush may retry the retained point. */ } }
    this.failure = null;
    this.start();
    if (this.running) await this.running;
    if (this.failure) throw this.failure;
  }

  stop(): void { this.stopped = true; this.pending = null; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
