import type { EntityData, EntityType, PullResponse, PushRequest, PushResponse, PushResult, SyncOperation, SyncRecord } from '../../packages/sync-core/src/index.ts';
import type { VerifiedIdentity } from './auth.ts';

export type DevicePlatform = 'web' | 'windows' | 'macos' | 'linux' | 'ios' | 'android';
export interface DeviceRegistration { name: string; platform: DevicePlatform }
export interface Device {
  id: string;
  name: string;
  platform: DevicePlatform;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}
export interface SessionView { accountId: string; device: Device }
export interface Conflict {
  conflictId: string;
  entityType: EntityType;
  entityId: string;
  createdAt: string;
  attemptedOperation: SyncOperation;
  observedRecord: SyncRecord;
  currentRecord: SyncRecord;
}
export interface ConflictPage { conflicts: Conflict[]; nextCursor: string; hasMore: boolean }
export type ResolveRequest = {
  opId: string; expectedRevision: number; choice: 'current' | 'attempted';
} | {
  opId: string; expectedRevision: number; choice: 'merged';
  mutation: 'put' | 'delete' | 'restore'; data: EntityData | null;
};

export interface SyncRepository {
  registerDevice(identity: VerifiedIdentity, registration: DeviceRegistration): Promise<SessionView>;
  me(identity: VerifiedIdentity): Promise<SessionView>;
  listDevices(identity: VerifiedIdentity): Promise<{ devices: Device[] }>;
  revokeDevice(identity: VerifiedIdentity, deviceId: string): Promise<{ revoked: true; deviceId: string }>;
  push(identity: VerifiedIdentity, request: PushRequest): Promise<PushResponse>;
  pull(identity: VerifiedIdentity, cursor: string | undefined, limit: number): Promise<PullResponse>;
  listConflicts(identity: VerifiedIdentity, cursor: string | undefined, limit: number): Promise<ConflictPage>;
  resolveConflict(identity: VerifiedIdentity, conflictId: string, request: ResolveRequest): Promise<PushResult>;
  ready(): Promise<boolean>;
}
