import type { OutboxStatus, PaperData } from '../../packages/sync-core/src/types';
import type { DesktopPaperMetadata, DesktopPaperOrganizationChoice } from '../../packages/sync-core/src/desktopPaperState';
import { invoke } from '../platform/electron/core';
import { listen } from '../platform/electron/event';

export interface DesktopPaperExchangeStatus {
  scopeKey: string | null; supported: boolean; organizationSupported: boolean; loaded: boolean; busy: boolean;
  revision: number; pending: number; continuable: number; conflicts: number; accepted: number; bound: number;
  adoptionPending: number; restorationPending?: number; errorCode: string | null; saveUnconfirmed: boolean;
}
export interface DesktopPaperList {
  scopeKey: string | null; revision: number;
  papers: { localPaperId: string; title: string; updatedAt: number | string; boundEntityId: string | null }[];
}
export interface DesktopPaperLocalRow {
  key: string; localPaperId: string; entityId: string | null; label: string; action: 'update' | 'none' | 'blocked';
  reason: string | null; local: PaperData | null; remote: PaperData | null;
  organizationSource: 'desktop-choice' | 'account' | 'initial' | null;
}
export interface DesktopPaperIncomingRow {
  entityId: string; localPaperId: string | null; label: string; state: 'new' | 'update' | 'deleted' | 'same' | 'pending';
  canAccept: boolean; reason: string | null; data: PaperData | null; local: PaperData | null; accepted: PaperData | null;
  revision: number; acceptedRevision: number | null;
}
export type DesktopPaperConflictChoice = 'current' | 'attempted';
export interface DesktopPaperConflict {
  conflictId: string; entityId: string; label: string; expectedRevision: number;
  attempted: { mutation: 'put' | 'restore' | 'delete'; data: PaperData | null };
  current: { revision: number; deletedAt: string | null; data: PaperData | null } | null;
}
export interface DesktopPaperAdoption {
  adoptionId: string; entityId: string; localPaperId: string; label: string; revision: number;
  phase: 'pending' | 'applied' | 'restoring' | 'restored'; createdAt: string;
  before: DesktopPaperMetadata; after: DesktopPaperMetadata;
  beforeOrganization: DesktopPaperOrganizationChoice | null; afterOrganization: DesktopPaperOrganizationChoice | null;
}
export interface DesktopPaperExchangePreview {
  token: string; scopeKey: string; revision: number; checkedAt: string;
  localRows: DesktopPaperLocalRow[]; incoming: DesktopPaperIncomingRow[]; organizationPolicy: 'independent-account-names';
  conflicts: DesktopPaperConflict[];
  pendingRows: { opId: string; entityId: string; label: string; mutation: 'put' | 'restore' | 'delete'; stage: OutboxStatus | 'overlay'; data: PaperData | null }[];
  pendingResolutions: { conflictId: string; opId: string; expectedRevision: number; choice: DesktopPaperConflictChoice;
    lastResult?: { status: 'applied' | 'conflict' | 'rejected'; code?: string; retryable?: boolean } | null }[];
  adoptions: DesktopPaperAdoption[];
}
export interface DesktopPaperAdoptResult extends DesktopPaperExchangeStatus { localPaperIds: string[] }
export interface DesktopPaperOrganizationInput {
  token: string; localPaperId: string; readingStatus: 'unread' | 'reading' | 'read'; queued: boolean; collections: string[];
}
export const desktopPaperExchange = {
  status: () => invoke<DesktopPaperExchangeStatus>('desktop_paper_status'),
  list: () => invoke<DesktopPaperList>('desktop_paper_list'),
  preview: (input: { localPaperIds: string[] }) => invoke<DesktopPaperExchangePreview>('desktop_paper_preview', input),
  publish: (input: { token: string }) => invoke<DesktopPaperExchangeStatus>('desktop_paper_publish', input),
  adopt: (input: { token: string; ids: string[] }) => invoke<DesktopPaperAdoptResult>('desktop_paper_adopt', input),
  organization: (input: DesktopPaperOrganizationInput) => invoke<DesktopPaperExchangeStatus>('desktop_paper_organization', { ...input }),
  resumeAdoptions: () => invoke<DesktopPaperAdoptResult>('desktop_paper_resume_adoptions'),
  restoreAdoption: (input: { adoptionId: string }) => invoke<DesktopPaperAdoptResult>('desktop_paper_restore_adoption', input),
  continue: () => invoke<DesktopPaperExchangeStatus>('desktop_paper_continue'),
  stop: () => invoke<DesktopPaperExchangeStatus>('desktop_paper_stop'),
  resolve: (input: { conflictId: string; choice: DesktopPaperConflictChoice; expectedRevision: number }) => invoke<DesktopPaperExchangeStatus>('desktop_paper_resolve', input),
  retrySave: () => invoke<DesktopPaperExchangeStatus>('desktop_paper_retry_save'),
  exportBackup: () => invoke<{ status: 'cancelled' | 'exported'; bytes?: number }>('desktop_paper_export'),
  onChanged: (listener: () => void) => listen('desktop-account:changed', listener),
};
