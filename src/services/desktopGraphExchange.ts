import type { GraphRelationData } from '../../packages/sync-core/src/graphRelation';
import type { OutboxStatus } from '../../packages/sync-core/src/types';
import { invoke } from '../platform/electron/core';
import { listen } from '../platform/electron/event';

export type { GraphRelationData };

export interface DesktopGraphExchangeStatus {
  scopeKey: string | null;
  supported: boolean;
  loaded: boolean;
  busy: boolean;
  revision: number | null;
  pending: number;
  continuable: number;
  conflicts: number;
  accepted: number;
  mapped: number;
  unmapped: number;
  errorCode: string | null;
  saveUnconfirmed: boolean;
}

export interface DesktopGraphLocalRow {
  key: string;
  localRelationId: string | null;
  entityId?: string | null;
  label: string;
  action: 'create' | 'update' | 'restore' | 'delete' | 'none' | 'blocked';
  reason?: string;
  local?: GraphRelationData | null;
  remote?: GraphRelationData | null;
  /** Original local fields are for on-device review only. */
  raw?: unknown;
}

export interface DesktopGraphIncomingRow {
  key: string;
  entityId: string;
  label: string;
  state: 'new' | 'update' | 'delete' | 'same' | 'unmapped' | 'pending';
  canAccept: boolean;
  reason?: string;
  data?: GraphRelationData | null;
  accepted: GraphRelationData | null;
  revision: number;
  acceptedRevision: number | null;
}

export interface DesktopGraphPendingRow {
  opId: string;
  entityId: string;
  label: string;
  mutation: 'put' | 'restore' | 'delete';
  stage: OutboxStatus | 'overlay';
  data: GraphRelationData | null;
}

export interface DesktopGraphConflict {
  conflictId: string;
  entityId: string;
  label: string;
  expectedRevision: number;
  attempted: { mutation: 'put' | 'restore' | 'delete'; data: GraphRelationData | null };
  current: { revision: number; deletedAt: string | null; data: GraphRelationData | null } | null;
}

export interface DesktopGraphPendingResolution {
  conflictId: string;
  opId: string;
  expectedRevision: number;
  choice: 'current' | 'attempted' | 'merged';
  mutation?: 'put' | 'restore' | 'delete';
  data?: GraphRelationData | null;
  lastResult?: { status: 'applied' | 'conflict' | 'rejected'; code?: string; retryable?: boolean };
}

export interface DesktopGraphExchangePreview {
  token: string;
  scopeKey: string;
  revision: number;
  checkedAt: string;
  localRows: DesktopGraphLocalRow[];
  incoming: DesktopGraphIncomingRow[];
  conflicts: DesktopGraphConflict[];
  pendingRows: DesktopGraphPendingRow[];
  pendingResolutions: DesktopGraphPendingResolution[];
}

export type DesktopGraphConflictChoice = 'current' | 'attempted';
export interface DesktopGraphResolveInput {
  conflictId: string;
  choice: DesktopGraphConflictChoice;
  expectedRevision: number;
}

export const desktopGraphExchange = {
  status: () => invoke<DesktopGraphExchangeStatus>('desktop_graph_status'),
  preview: () => invoke<DesktopGraphExchangePreview>('desktop_graph_preview'),
  publish: (input: { token: string; keys: string[] }) => invoke<DesktopGraphExchangeStatus>('desktop_graph_publish', input),
  adopt: (input: { token: string; ids: string[] }) => invoke<DesktopGraphExchangeStatus>('desktop_graph_adopt', input),
  continue: () => invoke<DesktopGraphExchangeStatus>('desktop_graph_continue'),
  stop: () => invoke<DesktopGraphExchangeStatus>('desktop_graph_stop'),
  resolve: (input: DesktopGraphResolveInput) => invoke<DesktopGraphExchangeStatus>('desktop_graph_resolve', { ...input }),
  retrySave: () => invoke<DesktopGraphExchangeStatus>('desktop_graph_retry_save'),
  exportBackup: () => invoke<{ status: 'cancelled' | 'exported'; bytes?: number }>('desktop_graph_export'),
  onChanged: (listener: () => void) => listen('desktop-account:changed', listener),
};
