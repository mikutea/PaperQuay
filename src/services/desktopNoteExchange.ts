import type { OutboxStatus } from '../../packages/sync-core/src/types';
import { invoke } from '../platform/electron/core';
import { listen } from '../platform/electron/event';

export interface DesktopNoteExchangeStatus {
  scopeKey: string | null;
  supported: boolean;
  richSupported: boolean;
  loaded: boolean;
  busy: boolean;
  revision: number;
  pending: number;
  continuable: number;
  conflicts: number;
  accepted: number;
  bound: number;
  copyPending?: number;
  errorCode: string | null;
  saveUnconfirmed: boolean;
}

export interface DesktopNoteListItem {
  localNoteId: string;
  title: string;
  updatedAt: number | string;
  boundEntityId: string | null;
}

export interface DesktopNoteList {
  scopeKey: string | null;
  revision: number;
  notes: DesktopNoteListItem[];
}

export interface DesktopNoteSummary {
  title: string;
  body: string;
  format: 'markdown' | 'tiptap-json';
  images: number;
  tags: string[];
  unresolvedReferences: number;
}

export interface DesktopNoteLocalRow {
  key: string;
  localNoteId: string;
  entityId: string | null;
  label: string;
  action: 'create' | 'update' | 'restore' | 'none' | 'blocked';
  reason?: string;
  local: DesktopNoteSummary | null;
  remote: DesktopNoteSummary | null;
}

export interface DesktopNoteIncomingRow {
  entityId: string;
  label: string;
  state: 'new' | 'update' | 'delete' | 'same' | 'pending';
  canAccept: boolean;
  revision: number;
  acceptedRevision: number | null;
  data: DesktopNoteSummary | null;
  accepted: DesktopNoteSummary | null;
}

export type DesktopNoteConflictChoice = 'current' | 'attempted';
export interface DesktopNoteConflict {
  conflictId: string;
  entityId: string;
  label: string;
  expectedRevision: number;
  attempted: { mutation: 'put' | 'restore' | 'delete'; data: DesktopNoteSummary | null };
  current: { revision: number; deletedAt: string | null; data: DesktopNoteSummary | null } | null;
}

export interface DesktopNotePendingRow {
  opId: string;
  entityId: string;
  label: string;
  mutation: 'put' | 'restore' | 'delete';
  stage: OutboxStatus | 'overlay';
  data: DesktopNoteSummary | null;
}

export interface DesktopNotePendingResolution {
  conflictId: string;
  opId: string;
  expectedRevision: number;
  choice: DesktopNoteConflictChoice;
  mutation?: 'put' | 'restore' | 'delete';
  data?: DesktopNoteSummary | null;
  lastResult?: { status: 'applied' | 'conflict' | 'rejected'; code?: string; retryable?: boolean };
}

export interface DesktopNoteExchangePreview {
  token: string;
  scopeKey: string;
  revision: number;
  checkedAt: string;
  localRows: DesktopNoteLocalRow[];
  incoming: DesktopNoteIncomingRow[];
  conflicts: DesktopNoteConflict[];
  pendingRows: DesktopNotePendingRow[];
  pendingResolutions: DesktopNotePendingResolution[];
}

export interface DesktopNoteAdoptResult extends DesktopNoteExchangeStatus {
  localNoteIds: string[];
}

export const desktopNoteExchange = {
  status: () => invoke<DesktopNoteExchangeStatus>('desktop_note_status'),
  list: () => invoke<DesktopNoteList>('desktop_note_list'),
  preview: (input: { noteIds: string[] }) => invoke<DesktopNoteExchangePreview>('desktop_note_preview', input),
  publish: (input: { token: string }) => invoke<DesktopNoteExchangeStatus>('desktop_note_publish', input),
  bind: (input: { token: string; localNoteId: string; entityId: string }) => invoke<DesktopNoteExchangeStatus>('desktop_note_bind', input),
  adopt: (input: { token: string; ids: string[] }) => invoke<DesktopNoteAdoptResult>('desktop_note_adopt', input),
  deleteFromAccount: (input: { token: string; entityId: string }) => invoke<DesktopNoteExchangeStatus>('desktop_note_delete', input),
  continue: () => invoke<DesktopNoteExchangeStatus>('desktop_note_continue'),
  stop: () => invoke<DesktopNoteExchangeStatus>('desktop_note_stop'),
  retrySave: () => invoke<DesktopNoteExchangeStatus>('desktop_note_retry_save'),
  resumeCopies: () => invoke<DesktopNoteAdoptResult>('desktop_note_resume_copies'),
  resolve: (input: { conflictId: string; choice: DesktopNoteConflictChoice; expectedRevision: number }) => invoke<DesktopNoteExchangeStatus>('desktop_note_resolve', input),
  exportBackup: () => invoke<{ status: 'cancelled' | 'exported'; bytes?: number }>('desktop_note_export'),
  onChanged: (listener: () => void) => listen('desktop-account:changed', listener),
};
