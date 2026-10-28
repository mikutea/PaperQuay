import type { AttachmentVersionData, EntityData, EntityType, PullResponse, PushRequest, PushResponse, PushResult, SyncOperation, SyncRecord } from '../../packages/sync-core/src/index.ts';
import type { VerifiedIdentity } from './auth.ts';
import type {SyncFeatureSet} from '../../packages/sync-core/src/features.ts';

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

export interface CloudPdfCopy {
  attachmentVersionId: string;
  paperId: string;
  sha256: string;
  sizeBytes: number;
  fileName: string;
  createdAt: string;
  available: boolean;
}
export interface CloudPdfQuota { usedBytes: number; maxBytes: number; usedCopies: number; maxCopies: number }
export interface CloudPdfStatus { copy: CloudPdfCopy | null; quota: CloudPdfQuota }
export interface CloudPdfRepository {
  listCloudPdfs(identity: VerifiedIdentity): Promise<{ copies: CloudPdfCopy[]; quota: CloudPdfQuota }>;
  getCloudPdf(identity: VerifiedIdentity, attachmentVersionId: string): Promise<CloudPdfStatus>;
  prepareCloudPdfUpload(identity: VerifiedIdentity, attachmentVersionId: string): Promise<{ accountId: string; sizeBytes: number; generation: string }>;
  putCloudPdf(identity: VerifiedIdentity, attachmentVersionId: string, content: Buffer, generation: string): Promise<{ copy: CloudPdfCopy; replayed: boolean; quota: CloudPdfQuota }>;
  downloadCloudPdf(identity: VerifiedIdentity, attachmentVersionId: string): Promise<{ copy: CloudPdfCopy; content: Buffer }>;
  deleteCloudPdf(identity: VerifiedIdentity, attachmentVersionId: string): Promise<{ attachmentVersionId: string; deleted: boolean; quota: CloudPdfQuota }>;
}

/** Deliberately excludes paper bodies, paths, source URLs, and unrelated sync entities. */
export interface DesktopPdfTarget {
  paper: { entityId: string; revision: number; title: string };
  version: { entityId: string; revision: number; data: AttachmentVersionData };
}
export interface DesktopPdfVersionPage {
  items: DesktopPdfTarget[];
  nextAfter: string | null;
  hasMore: boolean;
}
export interface DesktopPdfAccess {
  accountId: string;
  consumerDeviceId: string;
  providerDeviceId: string | null;
}
export interface DesktopPdfRepository {
  /** Short read-only transactions: no account write lock and no last-seen update. */
  desktopPdfSession(identity: VerifiedIdentity): Promise<SessionView>;
  listDesktopPdfVersions(identity: VerifiedIdentity, after: string | undefined, limit: number): Promise<DesktopPdfVersionPage>;
  getDesktopPdfVersion(identity: VerifiedIdentity, attachmentVersionId: string): Promise<DesktopPdfTarget>;
  checkDesktopPdfTransfer(consumer: VerifiedIdentity, provider: VerifiedIdentity | null, target: DesktopPdfTarget): Promise<DesktopPdfAccess>;
}

export interface SyncRepository {
  registerDevice(identity: VerifiedIdentity, registration: DeviceRegistration): Promise<SessionView>;
  me(identity: VerifiedIdentity): Promise<SessionView>;
  listDevices(identity: VerifiedIdentity): Promise<{ devices: Device[] }>;
  revokeDevice(identity: VerifiedIdentity, deviceId: string): Promise<{ revoked: true; deviceId: string }>;
  push(identity: VerifiedIdentity, request: PushRequest, features?:SyncFeatureSet): Promise<PushResponse>;
  pull(identity: VerifiedIdentity, cursor: string | undefined, limit: number): Promise<PullResponse>;
  listConflicts(identity: VerifiedIdentity, cursor: string | undefined, limit: number): Promise<ConflictPage>;
  resolveConflict(identity: VerifiedIdentity, conflictId: string, request: ResolveRequest, features?:SyncFeatureSet): Promise<PushResult>;
  ready(): Promise<boolean>;
}
