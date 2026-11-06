import type { OutboxStatus, ReadingPositionData, SyncMutation, SyncRecord } from '../../packages/sync-core/src/types';
import type { DesktopReadingReaderSnapshot } from './desktopReadingReader';
import { invoke } from '../platform/electron/core';
import { listen } from '../platform/electron/event';

export interface DesktopReadingPositionStatus {
  scopeKey: string | null; supported: boolean; busy: boolean; revision: number; pending: number;
  continuable: number; conflicts: number; saveUnconfirmed: boolean; errorCode: string | null;
  tracking: { trackingId: string; bindingId: string; attachmentVersionId: string } | null;
}
export interface VerifiedDesktopReadingSource {
  bindingId: string; localPaperId: string; localAttachmentId: string; paperId: string;
  attachmentVersionId: string; sha256: string; sizeBytes: number; pageCount: number; title: string; fileName: string;
}
export interface DesktopReadingCapture extends DesktopReadingReaderSnapshot { bindingId: string }
export interface DesktopReadingDraft {
  originDeviceId: string; source: VerifiedDesktopReadingSource; capture: DesktopReadingCapture;
  furthestPageIndex: number; furthestOffsetRatio: number; sessionId: string;
}
export interface DesktopReadingTrackedPoint {
  pageIndex: number; offsetRatio: number; furthestPageIndex: number; furthestOffsetRatio: number; observedAt: string;
}
export interface DesktopReadingTrackStartResult {
  status: DesktopReadingPositionStatus; trackingId: string; source: VerifiedDesktopReadingSource;
  capture: DesktopReadingCapture; furthestPageIndex: number; furthestOffsetRatio: number;
}
export interface DesktopReadingVersions { scopeKey: string; versions: VerifiedDesktopReadingSource[] }
export interface DesktopReadingDevicePosition {
  entityId: string; revision: number; deviceId: string; deviceName: string | null;
  isCurrentDevice: boolean; data: ReadingPositionData;
}
export interface DesktopReadingConflict {
  conflictId: string; entityId: string; label: string; expectedRevision: number; canResolve: boolean; reason: string | null;
  attempted: { mutation: SyncMutation; data: ReadingPositionData | null };
  current: { revision: number; deletedAt: string | null; data: ReadingPositionData | null } | null;
}
export type DesktopReadingConflictChoice = 'current' | 'attempted';
export interface DesktopReadingPositionPreview {
  token: string; scopeKey: string; revision: number; source: VerifiedDesktopReadingSource; capture: DesktopReadingCapture;
  publicationAction: 'create' | 'update' | 'restore' | 'blocked'; publicationReason: string | null;
  own: SyncRecord<'readingPosition'> | null; positions: DesktopReadingDevicePosition[];
  localDraft: DesktopReadingDraft | null;
  pendingRows: { opId: string; entityId: string; label: string; mutation: SyncMutation; stage: OutboxStatus;
    data: ReadingPositionData | null; errorCode: string | null }[];
  conflicts: DesktopReadingConflict[];
  pendingResolutions: { conflictId: string; opId: string; expectedRevision: number; choice: DesktopReadingConflictChoice;
    lastResult: { status: 'applied' | 'conflict' | 'rejected'; code?: string; retryable?: boolean } | null }[];
}
export interface DesktopReadingResumeResult {
  scopeKey: string; source: VerifiedDesktopReadingSource; position: ReadingPositionData;
  origin: { entityId: string; revision: number; deviceId: string; deviceName: string | null };
}
export const desktopReadingPosition = {
  status: () => invoke<DesktopReadingPositionStatus>('desktop_reading_status'),
  versions: (input: { localPaperId: string; sha256: string; sizeBytes: number; pageCount: number }) => invoke<DesktopReadingVersions>('desktop_reading_versions', input),
  preview: (input: { capture: DesktopReadingCapture }) => invoke<DesktopReadingPositionPreview>('desktop_reading_preview', input),
  publish: (input: { token: string }) => invoke<DesktopReadingPositionStatus>('desktop_reading_publish', input),
  resume: (input: { token: string; entityId: string; expectedRevision: number }) => invoke<DesktopReadingResumeResult>('desktop_reading_resume', input),
  continue: () => invoke<DesktopReadingPositionStatus>('desktop_reading_continue'),
  stop: () => invoke<DesktopReadingPositionStatus>('desktop_reading_stop'),
  resolve: (input: { conflictId: string; choice: DesktopReadingConflictChoice; expectedRevision: number }) => invoke<DesktopReadingPositionStatus>('desktop_reading_resolve', input),
  retrySave: () => invoke<DesktopReadingPositionStatus>('desktop_reading_retry_save'),
  startTracking: (input: { token: string }) => invoke<DesktopReadingTrackStartResult>('desktop_reading_track_start', input),
  recordTracked: (input: { trackingId: string; sequence: number; point: DesktopReadingTrackedPoint }) => invoke<DesktopReadingPositionStatus>('desktop_reading_track_point', input),
  stopTracking: (input: { trackingId: string }) => invoke<DesktopReadingPositionStatus>('desktop_reading_track_stop', input),
  exportBackup: () => invoke<{ status: 'cancelled' | 'exported'; bytes?: number }>('desktop_reading_export'),
  onChanged: (listener: (change?: { readingScopeKey: string | null }) => void) => listen<unknown>('desktop-account:changed', event => {
    const payload = event.payload;
    listener(payload && typeof payload === 'object' && 'readingScopeKey' in payload && (payload.readingScopeKey === null || typeof payload.readingScopeKey === 'string')
      ? { readingScopeKey: payload.readingScopeKey } : undefined);
  }),
};
