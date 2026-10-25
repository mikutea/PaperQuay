export const ENTITY_TYPES = ['paper', 'attachmentVersion', 'note', 'annotation', 'readingPosition'] as const;
export type EntityType = typeof ENTITY_TYPES[number];

export interface PaperOrganization {
  favorite: boolean;
  readingStatus: 'unread' | 'reading' | 'read';
  tags: string[];
  collections: string[];
  /** Null is outside the reading queue; equal ranks sort by stable entity ID. */
  queueRank: number | null;
}

export interface PaperData {
  title: string;
  doi: string | null;
  year: string | null;
  publication: string | null;
  abstractText: string | null;
  authors: string[];
  keywords: string[];
  organization?: PaperOrganization;
}

export interface AttachmentVersionData {
  paperId: string;
  attachmentId: string;
  sha256: string;
  sizeBytes: number;
  mediaType: 'application/pdf';
  fileName: string;
  pageCount: number | null;
}

export interface NoteData {
  paperId: string | null;
  title: string;
  body: string;
  format: 'markdown';
}

export type PdfQuad = [number, number, number, number, number, number, number, number];
export interface AnnotationAnchor {
  pageIndex: number;
  coordinateSpace: 'pdf-crop-box-unrotated-normalized';
  quads: PdfQuad[];
  quote: { exact: string; prefix: string; suffix: string } | null;
}

export interface AnnotationData {
  paperId: string;
  attachmentVersionId: string;
  kind: 'highlight' | 'underline' | 'area';
  color: string;
  comment: string;
  anchor: AnnotationAnchor;
}

export interface ReadingPositionData {
  paperId: string;
  attachmentVersionId: string;
  pageIndex: number;
  offsetRatio: number;
  furthestPageIndex: number;
  furthestOffsetRatio: number;
  sessionId: string;
  deviceSequence: number;
  observedAt: string;
}

export interface EntityDataMap {
  paper: PaperData;
  attachmentVersion: AttachmentVersionData;
  note: NoteData;
  annotation: AnnotationData;
  readingPosition: ReadingPositionData;
}
export type EntityData = EntityDataMap[EntityType];
export type SyncMutation = 'put' | 'delete' | 'restore';

export type SyncRecord<T extends EntityType = EntityType> = {
  [K in T]: {
    entityType: K;
    entityId: string;
    schemaVersion: 1;
    revision: number;
    deletedAt: string | null;
    updatedAt: string;
    modifiedByDeviceId: string;
    data: EntityDataMap[K] | null;
  }
}[T];

export type SyncOperation<T extends EntityType = EntityType> = {
  [K in T]: {
    opId: string;
    entityType: K;
    entityId: string;
    mutation: SyncMutation;
    baseRevision: number;
    schemaVersion: 1;
    data: EntityDataMap[K] | null;
    clientCreatedAt: string;
  }
}[T];

export interface PushRequest {
  protocolVersion: 1;
  deviceId: string;
  operations: SyncOperation[];
}

export interface PushResult {
  opId: string;
  status: 'applied' | 'conflict' | 'rejected';
  replayed: boolean;
  record?: SyncRecord;
  conflictId?: string;
  code?: string;
  retryable?: boolean;
}

export interface PushResponse {
  protocolVersion: 1;
  results: PushResult[];
}

export interface PullResponse {
  protocolVersion: 1;
  records: SyncRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ValidationIssue {
  /** Only schema-owned field names and array indices; never input values. */
  path: string;
  code: string;
}
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

export interface SyncContext {
  accountId: string;
  deviceId: string;
  generation: number;
}

export type LocalEdit = {
  [K in EntityType]: {
    entityType: K;
    entityId: string;
    mutation: SyncMutation;
    data: EntityDataMap[K] | null;
  }
}[EntityType];

export interface EditIdentity {
  opId: string;
  clientCreatedAt: string;
}

export type PendingEdit = LocalEdit & EditIdentity;
export type OutboxStatus = 'queued' | 'sending' | 'uncertain' | 'conflict' | 'rejected' | 'device-blocked';

export interface OutboxEntry {
  operation: SyncOperation;
  originDeviceId: string;
  status: OutboxStatus;
  attempts: number;
  errorCode: string | null;
  conflictId: string | null;
}

export interface LocalConflict {
  conflictId: string;
  attempted: SyncOperation;
  current: SyncRecord | null;
}

/** Persist this complete value atomically. Tokens and model credentials never belong here. */
export interface AccountSyncState {
  formatVersion: 1;
  accountId: string;
  deviceId: string;
  generation: number;
  cursor: string | null;
  serverRecords: Record<string, SyncRecord>;
  outbox: OutboxEntry[];
  overlays: Record<string, PendingEdit>;
  conflicts: Record<string, LocalConflict>;
}

export interface PreparedPush {
  state: AccountSyncState;
  request: PushRequest;
  context: SyncContext;
  opIds: string[];
}

export interface VisibleEntity {
  entityType: EntityType;
  entityId: string;
  data: EntityData | null;
  deleted: boolean;
  revision: number;
  pending: boolean;
  status: 'synced' | OutboxStatus | 'overlay';
}
