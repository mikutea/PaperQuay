import { ENTITY_TYPES } from './types.ts';
import type { EntityType } from './types.ts';

export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const ISO_TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$';
export const SYNC_LIMITS = Object.freeze({
  maxBatchOperations: 100,
  maxPullRecords: 1000,
  maxTitleLength: 2048,
  maxAbstractLength: 65536,
  maxNoteBodyLength: 262144,
  maxAuthors: 200,
  maxKeywords: 100,
  maxNameLength: 512,
  maxFileNameLength: 255,
  maxQuads: 200,
  maxCursorLength: 4096,
  maxLocalEntities: 100000,
  maxLocalOperations: 10000,
  maxValidationIssues: 20,
});

export interface JsonSchema {
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  format?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

const text = (maxLength: number, minLength = 0): JsonSchema => ({ type: 'string', minLength, maxLength });
const integer = (minimum = 0): JsonSchema => ({ type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER });
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [{ type: 'null' }, schema] });
const uuid: JsonSchema = { type: 'string', pattern: UUID_PATTERN };
const timestamp: JsonSchema = { type: 'string', maxLength: 40, pattern: ISO_TIMESTAMP_PATTERN, format: 'date-time' };
const fraction: JsonSchema = { type: 'number', minimum: 0, maximum: 1 };
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
  type: 'object', properties, required, additionalProperties: false,
});
const list = (items: JsonSchema, maxItems: number, minItems = 0): JsonSchema => ({ type: 'array', items, minItems, maxItems });

export const ENTITY_DATA_SCHEMAS: Record<EntityType, JsonSchema> = {
  paper: object({
    title: text(SYNC_LIMITS.maxTitleLength, 1),
    doi: nullable(text(2048, 1)),
    year: nullable(text(32, 1)),
    publication: nullable(text(2048, 1)),
    abstractText: nullable(text(SYNC_LIMITS.maxAbstractLength)),
    authors: list(text(SYNC_LIMITS.maxNameLength, 1), SYNC_LIMITS.maxAuthors),
    keywords: list(text(SYNC_LIMITS.maxNameLength, 1), SYNC_LIMITS.maxKeywords),
    organization: object({
      favorite: { type: 'boolean' },
      readingStatus: { enum: ['unread', 'reading', 'read'] },
      tags: list(text(80, 1), 64),
      collections: list(text(80, 1), 32),
      queueRank: nullable(integer()),
    }),
  }, ['title', 'doi', 'year', 'publication', 'abstractText', 'authors', 'keywords']),
  attachmentVersion: object({
    paperId: uuid,
    attachmentId: uuid,
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    sizeBytes: integer(1),
    mediaType: { const: 'application/pdf' },
    fileName: { type: 'string', minLength: 1, maxLength: SYNC_LIMITS.maxFileNameLength, pattern: '^(?!\\.{1,2}$)[^/\\\\:\\x00-\\x1f\\x7f]+$' },
    pageCount: nullable(integer(1)),
  }),
  note: object({ paperId: nullable(uuid), title: text(SYNC_LIMITS.maxTitleLength), body: text(SYNC_LIMITS.maxNoteBodyLength), format: { const: 'markdown' } }),
  annotation: object({
    paperId: uuid,
    attachmentVersionId: uuid,
    kind: { enum: ['highlight', 'underline', 'area'] },
    color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    comment: text(SYNC_LIMITS.maxNoteBodyLength),
    anchor: object({
      pageIndex: integer(),
      coordinateSpace: { const: 'pdf-crop-box-unrotated-normalized' },
      quads: list(list(fraction, 8, 8), SYNC_LIMITS.maxQuads, 1),
      quote: nullable(object({ exact: text(8192), prefix: text(512), suffix: text(512) })),
    }),
  }),
  readingPosition: object({
    paperId: uuid, attachmentVersionId: uuid,
    pageIndex: integer(), offsetRatio: fraction,
    furthestPageIndex: integer(), furthestOffsetRatio: fraction,
    sessionId: uuid, deviceSequence: integer(), observedAt: timestamp,
  }),
};

export const SYNC_OPERATION_SCHEMA: JsonSchema = {
  oneOf: ENTITY_TYPES.flatMap((entityType) => (['put', 'delete', 'restore'] as const).map((mutation) => object({
    opId: uuid, entityType: { const: entityType }, entityId: uuid,
    mutation: { const: mutation }, baseRevision: integer(mutation === 'restore' ? 1 : 0),
    schemaVersion: { const: 1 }, data: mutation === 'delete' ? { type: 'null' } : ENTITY_DATA_SCHEMAS[entityType],
    clientCreatedAt: timestamp,
  }))),
};

export const SYNC_RECORD_SCHEMA: JsonSchema = {
  oneOf: ENTITY_TYPES.flatMap((entityType) => [false, true].map((deleted) => object({
    entityType: { const: entityType }, entityId: uuid, schemaVersion: { const: 1 }, revision: integer(1),
    deletedAt: deleted ? timestamp : { type: 'null' }, updatedAt: timestamp, modifiedByDeviceId: uuid,
    data: deleted ? { type: 'null' } : ENTITY_DATA_SCHEMAS[entityType],
  }))),
};

export const PUSH_REQUEST_SCHEMA: JsonSchema = object({
  protocolVersion: { const: 1 }, deviceId: uuid,
  operations: list(SYNC_OPERATION_SCHEMA, SYNC_LIMITS.maxBatchOperations, 1),
});

export const PUSH_RESULT_SCHEMA: JsonSchema = object({
  opId: uuid, status: { enum: ['applied', 'conflict', 'rejected'] }, replayed: { type: 'boolean' },
  record: SYNC_RECORD_SCHEMA, conflictId: uuid,
  code: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Z][A-Z0-9_]*$' },
  retryable: { type: 'boolean' },
}, ['opId', 'status', 'replayed']);

export const PUSH_RESPONSE_SCHEMA: JsonSchema = object({
  protocolVersion: { const: 1 }, results: list(PUSH_RESULT_SCHEMA, SYNC_LIMITS.maxBatchOperations),
});

export const PULL_RESPONSE_SCHEMA: JsonSchema = object({
  protocolVersion: { const: 1 }, records: list(SYNC_RECORD_SCHEMA, SYNC_LIMITS.maxPullRecords),
  nextCursor: nullable(text(SYNC_LIMITS.maxCursorLength, 1)), hasMore: { type: 'boolean' },
});
