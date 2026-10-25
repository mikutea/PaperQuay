import { ENTITY_TYPES } from './types.ts';
import type { AccountSyncState, EditIdentity, EntityType, LocalEdit, OutboxEntry, PendingEdit, PreparedPush, PullResponse, PushResponse, SyncContext, SyncOperation, SyncRecord, ValidationResult, VisibleEntity } from './types.ts';
import { ENTITY_DATA_SCHEMAS, ISO_TIMESTAMP_PATTERN, SYNC_LIMITS, SYNC_OPERATION_SCHEMA, SYNC_RECORD_SCHEMA, UUID_PATTERN } from './schema.ts';
import type { JsonSchema } from './schema.ts';
import { canonicalJson, validateJsonSchema, validateOperation, validatePullResponse, validatePushResponse, validateRecord } from './validation.ts';

const uuidSchema: JsonSchema = { type: 'string', pattern: UUID_PATTERN };
const safeInteger: JsonSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const codeSchema: JsonSchema = { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,79}$' };
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [{ type: 'null' }, schema] });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const mapSchema: JsonSchema = { type: 'object' };
const cursorSchema = nullable({ type: 'string', minLength: 1, maxLength: SYNC_LIMITS.maxCursorLength });
const identitySchema = object({ opId: uuidSchema, clientCreatedAt: { type: 'string', pattern: ISO_TIMESTAMP_PATTERN, format: 'date-time' } });
const contextSchema = object({ accountId: uuidSchema, deviceId: uuidSchema, generation: safeInteger });
const entrySchema = object({
  operation: SYNC_OPERATION_SCHEMA, originDeviceId: uuidSchema,
  status: { enum: ['queued', 'sending', 'uncertain', 'conflict', 'rejected', 'device-blocked'] },
  attempts: safeInteger, errorCode: nullable(codeSchema), conflictId: nullable(uuidSchema),
});
const pendingSchema: JsonSchema = {
  oneOf: ENTITY_TYPES.flatMap((entityType) => (['put', 'delete', 'restore'] as const).map((mutation) => object({
    entityType: { const: entityType }, entityId: uuidSchema, mutation: { const: mutation },
    data: mutation === 'delete' ? { type: 'null' } : ENTITY_DATA_SCHEMAS[entityType],
    opId: uuidSchema, clientCreatedAt: { type: 'string', pattern: ISO_TIMESTAMP_PATTERN, format: 'date-time' },
  }))),
};
const editSchema: JsonSchema = {
  oneOf: ENTITY_TYPES.flatMap((entityType) => (['put', 'delete', 'restore'] as const).map((mutation) => object({
    entityType: { const: entityType }, entityId: uuidSchema, mutation: { const: mutation },
    data: mutation === 'delete' ? { type: 'null' } : ENTITY_DATA_SCHEMAS[entityType],
  }))),
};
const conflictSchema = object({ conflictId: uuidSchema, attempted: SYNC_OPERATION_SCHEMA, current: nullable(SYNC_RECORD_SCHEMA) });
const stateSchema = object({
  formatVersion: { const: 1 }, accountId: uuidSchema, deviceId: uuidSchema, generation: safeInteger,
  cursor: cursorSchema, serverRecords: mapSchema,
  outbox: { type: 'array', maxItems: SYNC_LIMITS.maxLocalOperations, items: entrySchema },
  overlays: mapSchema, conflicts: mapSchema,
});

export class SyncStateError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'SyncStateError';
    this.code = code;
  }
}

const fail = (code: string): never => { throw new SyncStateError(code); };
const copy = <T>(value: T): T => structuredClone(value);
const invalidState = (code: string, path = '$'): ValidationResult<AccountSyncState> => ({ ok: false, issues: [{ path, code }] });

export function entityKey(type: EntityType, id: string): string {
  if (!ENTITY_TYPES.includes(type) || typeof id !== 'string' || !new RegExp(UUID_PATTERN).test(id)) fail('INVALID_ENTITY_ID');
  return `${type}:${id}`;
}

function operationKey(operation: Pick<SyncOperation, 'entityType' | 'entityId'>): string {
  return entityKey(operation.entityType, operation.entityId);
}

function pendingAsOperation(pending: PendingEdit, baseRevision: number): SyncOperation {
  return { ...copy(pending), baseRevision, schemaVersion: 1 } as SyncOperation;
}

function validatePending(value: unknown): ValidationResult<PendingEdit> {
  const result = validateJsonSchema<PendingEdit>(pendingSchema, value);
  if (!result.ok) return result;
  const checked = validateOperation(pendingAsOperation(result.value, result.value.mutation === 'restore' ? 1 : 0));
  return checked.ok ? result : checked;
}

/** Validate untrusted IndexedDB/backup state before any reducer receives it. */
export function validateClientState(value: unknown): ValidationResult<AccountSyncState> {
  const initial = validateJsonSchema<AccountSyncState>(stateSchema, value);
  if (!initial.ok) return initial;
  const state = initial.value;
  try {
    if (Object.keys(state.serverRecords).length > SYNC_LIMITS.maxLocalEntities || Object.keys(state.overlays).length > SYNC_LIMITS.maxLocalOperations || Object.keys(state.conflicts).length > SYNC_LIMITS.maxLocalOperations) return invalidState('LOCAL_CAPACITY_EXCEEDED');
    for (const [key, record] of Object.entries(state.serverRecords)) {
      const result = validateRecord(record);
      if (!result.ok || key !== operationKey(result.value)) return invalidState('INVALID_SERVER_RECORD', '$.serverRecords');
    }
    const entities = new Set<string>();
    const ids = new Set<string>();
    for (const entry of state.outbox) {
      const checked = validateOperation(entry.operation);
      if (!checked.ok) return invalidState('INVALID_OUTBOX_OPERATION', '$.outbox');
      const key = operationKey(entry.operation);
      if (entities.has(key) || ids.has(entry.operation.opId)) return invalidState('DUPLICATE_PENDING_OPERATION', '$.outbox');
      entities.add(key); ids.add(entry.operation.opId);
      if ((entry.status === 'sending' || entry.status === 'uncertain') && entry.attempts < 1) return invalidState('INVALID_SEND_STATE', '$.outbox');
      if ((entry.status === 'conflict') !== (entry.conflictId !== null)) return invalidState('INVALID_CONFLICT_REFERENCE', '$.outbox');
      if (entry.status === 'device-blocked' && entry.errorCode !== 'DEVICE_CHANGED') return invalidState('INVALID_DEVICE_BLOCK', '$.outbox');
    }
    for (const [key, pending] of Object.entries(state.overlays)) {
      const result = validatePending(pending);
      if (!result.ok || key !== operationKey(result.value) || !entities.has(key) || ids.has(result.value.opId)) return invalidState('INVALID_OVERLAY', '$.overlays');
      ids.add(result.value.opId);
    }
    for (const [key, conflict] of Object.entries(state.conflicts)) {
      if (!validateJsonSchema(conflictSchema, conflict).ok) return invalidState('INVALID_CONFLICT', '$.conflicts');
      if (!validateJsonSchema(uuidSchema, conflict.conflictId).ok || key !== conflict.conflictId || !validateOperation(conflict.attempted).ok) return invalidState('INVALID_CONFLICT', '$.conflicts');
      if (conflict.current !== null && (!validateRecord(conflict.current).ok || operationKey(conflict.current) !== operationKey(conflict.attempted))) return invalidState('INVALID_CONFLICT_RECORD', '$.conflicts');
    }
    for (const entry of state.outbox) {
      if (entry.conflictId && (!state.conflicts[entry.conflictId] || canonicalJson(state.conflicts[entry.conflictId].attempted) !== canonicalJson(entry.operation))) return invalidState('MISSING_CONFLICT', '$.outbox');
    }
    return initial;
  } catch { return invalidState('INVALID_CLIENT_STATE'); }
}

function assertState(state: AccountSyncState): void {
  if (!validateClientState(state).ok) fail('INVALID_CLIENT_STATE');
}

function assertContext(state: AccountSyncState, context: SyncContext): void {
  assertState(state);
  if (!validateJsonSchema(contextSchema, context).ok || state.accountId !== context.accountId || state.deviceId !== context.deviceId || state.generation !== context.generation) fail('IDENTITY_CHANGED');
}

function incrementGeneration(state: AccountSyncState): void {
  if (state.generation >= Number.MAX_SAFE_INTEGER) fail('GENERATION_EXHAUSTED');
  state.generation += 1;
}

export function createAccountState(accountId: string, deviceId: string): AccountSyncState {
  if (!validateJsonSchema(uuidSchema, accountId).ok || !validateJsonSchema(uuidSchema, deviceId).ok) fail('INVALID_IDENTITY');
  return { formatVersion: 1, accountId, deviceId, generation: 1, cursor: null, serverRecords: {}, outbox: [], overlays: {}, conflicts: {} };
}

export function getSyncContext(state: AccountSyncState): SyncContext {
  assertState(state);
  return { accountId: state.accountId, deviceId: state.deviceId, generation: state.generation };
}

function newEntry(operation: SyncOperation, deviceId: string): OutboxEntry {
  return { operation, originDeviceId: deviceId, status: 'queued', attempts: 0, errorCode: null, conflictId: null };
}

function sameIntent(operation: SyncOperation | PendingEdit, pending: PendingEdit): boolean {
  return canonicalJson({ entityType: operation.entityType, entityId: operation.entityId, mutation: operation.mutation, data: operation.data, opId: operation.opId, clientCreatedAt: operation.clientCreatedAt }) === canonicalJson(pending);
}

/** Persist the returned state before showing "saved". This function performs no I/O. */
export function queueLocalEdit(state: AccountSyncState, edit: LocalEdit, identity: EditIdentity): AccountSyncState {
  assertState(state);
  if (!validateJsonSchema(identitySchema, identity).ok) fail('INVALID_EDIT_IDENTITY');
  if (!validateJsonSchema(editSchema, edit).ok) fail('INVALID_EDIT');
  let candidate = { ...edit, ...identity } as PendingEdit;
  if (!validatePending(candidate).ok) fail('INVALID_EDIT');
  const key = operationKey(candidate);
  const pending = state.outbox.find((item) => operationKey(item.operation) === key);
  // Editing an unsent restoration changes its content, not the explicit intent to restore.
  // Normalize repeats of that same local edit too, so idempotency checks still compare
  // the effective operation after it has been prepared or sent.
  if (candidate.mutation === 'put' && pending?.operation.mutation === 'restore'
    && ((pending.status === 'queued' && pending.attempts === 0) || pending.operation.opId === candidate.opId)) {
    candidate = { ...candidate, mutation: 'restore' } as PendingEdit;
  }
  const duplicate = [...state.outbox.map((entry) => entry.operation), ...Object.values(state.overlays), ...Object.values(state.conflicts).map((conflict) => conflict.attempted)].find((operation) => operation.opId === identity.opId);
  if (duplicate) return sameIntent(duplicate, candidate) ? state : fail('OP_ID_REUSED');
  const next = copy(state);
  const entry = next.outbox.find((item) => operationKey(item.operation) === key);
  const current = next.serverRecords[key];
  if (edit.entityType === 'readingPosition' && current && current.modifiedByDeviceId !== state.deviceId) fail('READING_DEVICE_MISMATCH');
  if (!entry && edit.mutation === 'put' && current?.deletedAt !== null && current?.deletedAt !== undefined) fail('RESTORE_REQUIRED');
  if (edit.mutation === 'restore' && !current?.deletedAt) fail('NO_TOMBSTONE');
  if (entry && entry.attempts === 0 && entry.status === 'queued') {
    if (edit.mutation === 'delete' && entry.operation.baseRevision === 0 && !current) {
      next.outbox = next.outbox.filter((item) => item !== entry);
      delete next.overlays[key];
    } else {
      const base = edit.mutation === 'restore' ? current!.revision : entry.operation.baseRevision;
      entry.operation = pendingAsOperation(candidate, base);
    }
  } else if (entry) {
    next.overlays[key] = copy(candidate);
  } else {
    if (next.outbox.length >= SYNC_LIMITS.maxLocalOperations) fail('LOCAL_CAPACITY_EXCEEDED');
    if (edit.mutation === 'delete' && !current) return state;
    next.outbox.push(newEntry(pendingAsOperation(candidate, current?.revision ?? 0), state.deviceId));
  }
  return next;
}

/** Commit state first; send request only when opIds is non-empty. */
export function preparePush(state: AccountSyncState, context: SyncContext, limit: number = SYNC_LIMITS.maxBatchOperations): PreparedPush {
  assertContext(state, context);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SYNC_LIMITS.maxBatchOperations) fail('INVALID_BATCH_LIMIT');
  const next = copy(state);
  const ready = next.outbox.filter((entry) => entry.status === 'queued' || entry.status === 'uncertain').slice(0, limit);
  for (const entry of ready) {
    if (entry.operation.entityType === 'readingPosition' && entry.originDeviceId !== next.deviceId) fail('READING_DEVICE_MISMATCH');
    if (entry.attempts >= Number.MAX_SAFE_INTEGER) fail('ATTEMPTS_EXHAUSTED');
    entry.status = 'sending'; entry.attempts += 1; entry.errorCode = null;
  }
  return { state: next, context: { ...context }, request: { protocolVersion: 1, deviceId: state.deviceId, operations: copy(ready.map((entry) => entry.operation)) }, opIds: ready.map((entry) => entry.operation.opId) };
}

export function markPushUncertain(state: AccountSyncState, context: SyncContext, opIds: string[], code = 'NETWORK_ERROR'): AccountSyncState {
  assertContext(state, context);
  if (!validateJsonSchema(codeSchema, code).ok || !Array.isArray(opIds) || opIds.some((id) => !validateJsonSchema(uuidSchema, id).ok)) fail('INVALID_FAILURE');
  const next = copy(state);
  const affected = new Set(opIds);
  for (const entry of next.outbox) {
    if (affected.has(entry.operation.opId) && entry.status === 'sending') { entry.status = 'uncertain'; entry.errorCode = code; }
  }
  return next;
}

function storeServerRecord(state: AccountSyncState, record: SyncRecord): void {
  const key = operationKey(record);
  const current = state.serverRecords[key];
  if (current && current.revision > record.revision) return;
  if (current && current.revision === record.revision) {
    if (canonicalJson(current) !== canonicalJson(record)) fail('REVISION_COLLISION');
    return;
  }
  if (!current && Object.keys(state.serverRecords).length >= SYNC_LIMITS.maxLocalEntities) fail('LOCAL_CAPACITY_EXCEEDED');
  state.serverRecords[key] = copy(record);
}

function promoteOverlay(state: AccountSyncState, key: string, baseRevision: number, originDeviceId = state.deviceId): void {
  const pending = state.overlays[key];
  if (!pending) return;
  delete state.overlays[key];
  const operation = pendingAsOperation(pending, baseRevision);
  if (!validateOperation(operation).ok) fail('OVERLAY_REQUIRES_REVIEW');
  const entry = newEntry(operation, originDeviceId);
  if (operation.entityType === 'readingPosition' && originDeviceId !== state.deviceId) { entry.status = 'device-blocked'; entry.errorCode = 'DEVICE_CHANGED'; }
  state.outbox.push(entry);
}

export function applyPushResults(state: AccountSyncState, context: SyncContext, response: PushResponse, expectedOpIds?: string[]): AccountSyncState {
  assertContext(state, context);
  if (!validatePushResponse(response).ok) fail('INVALID_PUSH_RESPONSE');
  if (expectedOpIds && (new Set(expectedOpIds).size !== expectedOpIds.length || expectedOpIds.length !== response.results.length || response.results.some((result) => !expectedOpIds.includes(result.opId)))) fail('INCOMPLETE_PUSH_RESPONSE');
  const next = copy(state);
  for (const result of response.results) {
    const entry = next.outbox.find((item) => item.operation.opId === result.opId);
    if (!entry) continue; // A replayed acknowledgement cannot overwrite its successor.
    if (entry.attempts < 1) fail('UNSENT_ACKNOWLEDGEMENT');
    if ((entry.status === 'conflict' && result.status !== 'conflict') || (entry.status === 'rejected' && result.status !== 'rejected')) fail('RECEIPT_CHANGED');
    if (entry.status === 'conflict' && result.conflictId !== entry.conflictId) fail('RECEIPT_CHANGED');
    if (entry.status === 'rejected' && (result.retryable || result.code !== entry.errorCode)) fail('RECEIPT_CHANGED');
    const key = operationKey(entry.operation);
    if (result.record && operationKey(result.record) !== key) fail('MISMATCHED_ACKNOWLEDGEMENT');
    if (result.status === 'applied') {
      const record = result.record;
      if (!record) return fail('INVALID_APPLIED_RECORD');
      // Deleting an existing tombstone is an acknowledged no-op. All other writes advance revision.
      const known = next.serverRecords[key];
      const noOpDelete = entry.operation.mutation === 'delete' && record.deletedAt !== null && record.revision === entry.operation.baseRevision && known && known.revision >= record.revision;
      if ((!noOpDelete && record.revision <= entry.operation.baseRevision) || ((entry.operation.mutation === 'delete') !== (record.deletedAt !== null))) fail('INVALID_APPLIED_RECORD');
      storeServerRecord(next, record);
      next.outbox = next.outbox.filter((item) => item !== entry);
      if (entry.conflictId) delete next.conflicts[entry.conflictId];
      // Use the acknowledged revision, never a possibly newer pull revision that this edit did not observe.
      promoteOverlay(next, key, record.revision, entry.originDeviceId);
    } else if (result.status === 'conflict') {
      const conflictId = result.conflictId!;
      const previous = next.conflicts[conflictId];
      if (!previous && Object.keys(next.conflicts).length >= SYNC_LIMITS.maxLocalOperations) fail('LOCAL_CAPACITY_EXCEEDED');
      if (previous && canonicalJson(previous.attempted) !== canonicalJson(entry.operation)) fail('CONFLICT_ID_COLLISION');
      next.conflicts[conflictId] = { conflictId, attempted: copy(entry.operation), current: result.record ? copy(result.record) : null };
      entry.status = 'conflict'; entry.conflictId = conflictId; entry.errorCode = 'CONFLICT';
      if (result.record) storeServerRecord(next, result.record);
    } else {
      entry.status = result.retryable ? 'queued' : 'rejected';
      entry.errorCode = result.code ?? 'REJECTED';
    }
  }
  return next;
}

/** Store the returned mirror and cursor in one transaction; never commit cursor separately. */
export function applyPullPage(state: AccountSyncState, context: SyncContext, page: { fromCursor: string | null; response: PullResponse }): AccountSyncState {
  assertContext(state, context);
  if (page.fromCursor !== state.cursor) fail('STALE_PULL_CURSOR');
  if (!validatePullResponse(page.response).ok || (page.response.hasMore && page.response.nextCursor === page.fromCursor)) fail('INVALID_PULL_RESPONSE');
  const next = copy(state);
  for (const record of page.response.records) storeServerRecord(next, record);
  next.cursor = page.response.nextCursor;
  return next;
}

export function resumeAfterRestart(state: AccountSyncState): AccountSyncState {
  assertState(state);
  const next = copy(state);
  incrementGeneration(next);
  for (const entry of next.outbox) if (entry.status === 'sending') { entry.status = 'uncertain'; entry.errorCode = 'INTERRUPTED'; }
  return next;
}

/** deviceId must be returned by the service for the new authenticated session. */
export function rebindDevice(state: AccountSyncState, deviceId: string): AccountSyncState {
  if (!validateJsonSchema(uuidSchema, deviceId).ok) fail('INVALID_IDENTITY');
  const next = resumeAfterRestart(state);
  next.deviceId = deviceId;
  for (const entry of next.outbox) {
    if (entry.operation.entityType === 'readingPosition' && entry.originDeviceId !== deviceId && entry.status !== 'conflict') {
      entry.status = 'device-blocked'; entry.errorCode = 'DEVICE_CHANGED';
    } else if (entry.status === 'device-blocked' && entry.originDeviceId === deviceId) {
      entry.status = entry.attempts > 0 ? 'uncertain' : 'queued'; entry.errorCode = null;
    }
  }
  return next;
}

/** Acknowledgement of this client's explicit, durably saved resolution request. */
export function applyConflictResolution(state: AccountSyncState, context: SyncContext, resolution: { conflictId: string; record: SyncRecord | null; consumedOverlayOpId?: string }): AccountSyncState {
  assertContext(state, context);
  if (!validateJsonSchema(uuidSchema, resolution.conflictId).ok || (resolution.record !== null && !validateRecord(resolution.record).ok) || (resolution.consumedOverlayOpId !== undefined && !validateJsonSchema(uuidSchema, resolution.consumedOverlayOpId).ok)) fail('INVALID_CONFLICT_RESOLUTION');
  const next = copy(state);
  const conflict = next.conflicts[resolution.conflictId];
  const key = conflict ? operationKey(conflict.attempted) : resolution.record ? operationKey(resolution.record) : null;
  if (conflict && resolution.record && operationKey(resolution.record) !== key) fail('MISMATCHED_CONFLICT_RESOLUTION');
  if (resolution.record) storeServerRecord(next, resolution.record);
  delete next.conflicts[resolution.conflictId];
  const blocked = next.outbox.find((entry) => entry.conflictId === resolution.conflictId);
  if (blocked) next.outbox = next.outbox.filter((entry) => entry !== blocked);
  if (key && blocked) {
    if (next.overlays[key]?.opId === resolution.consumedOverlayOpId) delete next.overlays[key];
    promoteOverlay(next, key, resolution.record?.revision ?? 0, blocked.originDeviceId);
  }
  return next;
}

/** Reconcile a conflict authoritatively closed elsewhere without rebasing this client's later edits. */
export function applyRemoteConflictResolution(state: AccountSyncState, context: SyncContext, resolution: { conflictId: string; record: SyncRecord | null }): AccountSyncState {
  assertContext(state, context);
  if (!validateJsonSchema(uuidSchema, resolution.conflictId).ok || (resolution.record !== null && !validateRecord(resolution.record).ok)) fail('INVALID_CONFLICT_RESOLUTION');
  const next = copy(state);
  const conflict = next.conflicts[resolution.conflictId];
  const key = conflict ? operationKey(conflict.attempted) : resolution.record ? operationKey(resolution.record) : null;
  if (conflict && resolution.record && operationKey(resolution.record) !== key) fail('MISMATCHED_CONFLICT_RESOLUTION');
  if (resolution.record) storeServerRecord(next, resolution.record);
  delete next.conflicts[resolution.conflictId];
  const blocked = next.outbox.find((entry) => entry.conflictId === resolution.conflictId);
  if (blocked) next.outbox = next.outbox.filter((entry) => entry !== blocked);
  if (key && blocked) {
    const pending = next.overlays[key];
    // These edits did not participate in the remote decision. A fresh operation with the
    // old CAS basis creates a real server conflict instead of overwriting that decision.
    // Restore cannot use revision zero. Revision one precedes every server tombstone:
    // entities are created live at revision one and deletion always advances revision.
    const baseRevision = pending?.mutation === 'restore' ? Math.max(1, blocked.operation.baseRevision) : blocked.operation.baseRevision;
    promoteOverlay(next, key, baseRevision, blocked.originDeviceId);
  }
  return next;
}

function visibleEntity(state: AccountSyncState, type: EntityType, id: string, entry: OutboxEntry | undefined): VisibleEntity | null {
  const key = entityKey(type, id);
  const record = state.serverRecords[key];
  const pending = state.overlays[key] ?? entry?.operation;
  if (pending) return { entityType: type, entityId: id, data: copy(pending.data), deleted: pending.mutation === 'delete', revision: record?.revision ?? 0, pending: true, status: state.overlays[key] ? 'overlay' : entry!.status };
  if (!record) return null;
  return { entityType: type, entityId: id, data: copy(record.data), deleted: record.deletedAt !== null, revision: record.revision, pending: false, status: 'synced' };
}

export function getVisibleEntity(state: AccountSyncState, type: EntityType, id: string): VisibleEntity | null {
  assertState(state);
  const key = entityKey(type, id);
  return visibleEntity(state, type, id, state.outbox.find((item) => operationKey(item.operation) === key));
}

export function listVisibleEntities(state: AccountSyncState, type?: EntityType): VisibleEntity[] {
  assertState(state);
  const identities = new Map<string, { type: EntityType; id: string }>();
  const pending = new Map<string, OutboxEntry>();
  for (const record of Object.values(state.serverRecords)) identities.set(operationKey(record), { type: record.entityType, id: record.entityId });
  for (const entry of state.outbox) {
    const key = operationKey(entry.operation);
    identities.set(key, { type: entry.operation.entityType, id: entry.operation.entityId });
    pending.set(key, entry);
  }
  return [...identities.entries()].filter(([, identity]) => type === undefined || identity.type === type).map(([key, identity]) => visibleEntity(state, identity.type, identity.id, pending.get(key))!);
}
