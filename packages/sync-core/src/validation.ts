import { ENTITY_TYPES } from './types.ts';
import type { EntityDataMap, EntityType, PullResponse, PushRequest, PushResponse, PushResult, SyncOperation, SyncRecord, ValidationIssue, ValidationResult } from './types.ts';
import { ENTITY_DATA_SCHEMAS, PULL_RESPONSE_SCHEMA, PUSH_REQUEST_SCHEMA, PUSH_RESPONSE_SCHEMA, PUSH_RESULT_SCHEMA, SYNC_LIMITS, SYNC_OPERATION_SCHEMA, SYNC_RECORD_SCHEMA } from './schema.ts';
import type { JsonSchema } from './schema.ts';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDataObject(value: object): boolean {
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
}

function validTimestamp(value: string): boolean {
  const parsed = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})/.exec(value);
  if (!parsed || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hours, minutes, seconds] = parsed.map(Number);
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year, month, 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= lastDay.getUTCDate() && hours < 24 && minutes < 60 && seconds < 60;
}

function check(schema: JsonSchema, value: unknown, path: string, issues: ValidationIssue[], depth: number): void {
  const fail = (code: string) => { if (issues.length < SYNC_LIMITS.maxValidationIssues) issues.push({ path, code }); };
  if (issues.length >= SYNC_LIMITS.maxValidationIssues) return;
  if (depth > 40) { fail('MAX_DEPTH'); return; }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    const candidates = alternatives.map((alternative) => {
      const candidateIssues: ValidationIssue[] = [];
      check(alternative, value, path, candidateIssues, depth + 1);
      return candidateIssues;
    });
    const matches = candidates.filter((candidate) => candidate.length === 0).length;
    if (schema.oneOf ? matches === 1 : matches > 0) return;
    if (matches > 1) { fail('AMBIGUOUS_SCHEMA'); return; }
    const closest = candidates.sort((a, b) => a.length - b.length)[0];
    for (const issue of closest ?? [{ path, code: 'INVALID_SCHEMA' }]) {
      if (issues.length < SYNC_LIMITS.maxValidationIssues) issues.push(issue);
    }
    return;
  }
  if ('const' in schema && value !== schema.const) { fail('INVALID_CONSTANT'); return; }
  if (schema.enum && !schema.enum.includes(value)) { fail('INVALID_ENUM'); return; }
  if (schema.type === 'null') { if (value !== null) fail('EXPECTED_NULL'); return; }
  if (schema.type === 'boolean') { if (typeof value !== 'boolean') fail('EXPECTED_BOOLEAN'); return; }
  if (schema.type === 'string') {
    if (typeof value !== 'string') { fail('EXPECTED_STRING'); return; }
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('TOO_SHORT');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('TOO_LONG');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('INVALID_FORMAT');
    if (schema.format === 'date-time' && !validTimestamp(value)) fail('INVALID_TIMESTAMP');
    return;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) { fail('EXPECTED_FINITE_NUMBER'); return; }
    if (schema.type === 'integer' && !Number.isSafeInteger(value)) fail('EXPECTED_SAFE_INTEGER');
    if (schema.minimum !== undefined && value < schema.minimum) fail('BELOW_MINIMUM');
    if (schema.maximum !== undefined && value > schema.maximum) fail('ABOVE_MAXIMUM');
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) { fail('EXPECTED_ARRAY'); return; }
    if (!isDataObject(value)) { fail('ACCESSOR_NOT_ALLOWED'); return; }
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('TOO_FEW_ITEMS');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) { fail('TOO_MANY_ITEMS'); return; }
    if (Object.keys(value).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) fail('EXTRA_FIELD');
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) { fail('SPARSE_ARRAY'); break; }
      if (schema.items) check(schema.items, value[index], `${path}[${index}]`, issues, depth + 1);
    }
    return;
  }
  if (schema.type === 'object') {
    if (!isPlainObject(value)) { fail('EXPECTED_OBJECT'); return; }
    if (!isDataObject(value)) { fail('ACCESSOR_NOT_ALLOWED'); return; }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) fail('EXTRA_FIELD');
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        if (issues.length < SYNC_LIMITS.maxValidationIssues) issues.push({ path: `${path}.${required}`, code: 'REQUIRED_FIELD' });
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) check(childSchema, value[key], `${path}.${key}`, issues, depth + 1);
    }
  }
}

/** Portable validator for the exact JSON-schema subset exported by this package. */
export function validateJsonSchema<T>(schema: JsonSchema, value: unknown): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  try { check(schema, value, '$', issues, 0); }
  catch { issues.push({ path: '$', code: 'INVALID_INPUT' }); }
  return issues.length ? { ok: false, issues } : { ok: true, value: value as T };
}

function checkPositionOrder(type: EntityType, data: unknown): ValidationIssue[] {
  if (type !== 'readingPosition' || !isPlainObject(data)) return [];
  const current = data.pageIndex as number;
  const furthest = data.furthestPageIndex as number;
  if (furthest < current || (furthest === current && (data.furthestOffsetRatio as number) < (data.offsetRatio as number))) {
    return [{ path: '$.furthestPageIndex', code: 'FURTHEST_BEFORE_CURRENT' }];
  }
  return [];
}

export function validateEntityData<T extends EntityType>(type: T, value: unknown): ValidationResult<EntityDataMap[T]> {
  if (!ENTITY_TYPES.includes(type)) return { ok: false, issues: [{ path: '$', code: 'INVALID_ENTITY_TYPE' }] };
  const result = validateJsonSchema<EntityDataMap[T]>(ENTITY_DATA_SCHEMAS[type], value);
  if (!result.ok) return result;
  const issues = checkPositionOrder(type, value);
  return issues.length ? { ok: false, issues } : result;
}

export function validateOperation(value: unknown): ValidationResult<SyncOperation> {
  const result = validateJsonSchema<SyncOperation>(SYNC_OPERATION_SCHEMA, value);
  if (!result.ok) return result;
  const issues = checkPositionOrder(result.value.entityType, result.value.data);
  return issues.length ? { ok: false, issues } : result;
}

export function validateRecord(value: unknown): ValidationResult<SyncRecord> {
  const result = validateJsonSchema<SyncRecord>(SYNC_RECORD_SCHEMA, value);
  if (!result.ok) return result;
  const issues = checkPositionOrder(result.value.entityType, result.value.data);
  return issues.length ? { ok: false, issues } : result;
}

export const validateSyncOperation = validateOperation;
export const validateSyncRecord = validateRecord;

export function validatePushRequest(value: unknown): ValidationResult<PushRequest> {
  const result = validateJsonSchema<PushRequest>(PUSH_REQUEST_SCHEMA, value);
  if (!result.ok) return result;
  const ids = new Set<string>();
  for (const operation of result.value.operations) {
    if (ids.has(operation.opId)) return { ok: false, issues: [{ path: '$.operations', code: 'DUPLICATE_OP_ID' }] };
    ids.add(operation.opId);
    const operationResult = validateOperation(operation);
    if (!operationResult.ok) return operationResult;
  }
  return result;
}

export function validatePushResult(value: unknown): ValidationResult<PushResult> {
  const result = validateJsonSchema<PushResult>(PUSH_RESULT_SCHEMA, value);
  if (!result.ok) return result;
  if (result.value.status === 'conflict' && !result.value.conflictId) return { ok: false, issues: [{ path: '$.conflictId', code: 'REQUIRED_FIELD' }] };
  if (result.value.status === 'rejected' && (!result.value.code || typeof result.value.retryable !== 'boolean')) {
    return { ok: false, issues: [{ path: '$', code: 'INCOMPLETE_REJECTION' }] };
  }
  if (result.value.record) {
    const record = validateRecord(result.value.record);
    if (!record.ok) return record;
  }
  return result;
}

export function validatePushResponse(value: unknown): ValidationResult<PushResponse> {
  const result = validateJsonSchema<PushResponse>(PUSH_RESPONSE_SCHEMA, value);
  if (!result.ok) return result;
  const ids = new Set<string>();
  for (const entry of result.value.results) {
    if (ids.has(entry.opId)) return { ok: false, issues: [{ path: '$.results', code: 'DUPLICATE_OP_ID' }] };
    ids.add(entry.opId);
    const entryResult = validatePushResult(entry);
    if (!entryResult.ok) return entryResult;
  }
  return result;
}

export function validatePullResponse(value: unknown): ValidationResult<PullResponse> {
  const result = validateJsonSchema<PullResponse>(PULL_RESPONSE_SCHEMA, value);
  if (!result.ok) return result;
  if (result.value.hasMore && !result.value.nextCursor) return { ok: false, issues: [{ path: '$.nextCursor', code: 'CURSOR_REQUIRED' }] };
  for (const record of result.value.records) {
    const recordResult = validateRecord(record);
    if (!recordResult.ok) return recordResult;
  }
  return result;
}

/** A deterministic JSON representation, useful for idempotency comparisons. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, depth: number): string => {
    if (depth > 40) throw new Error('INVALID_JSON');
    if (candidate === null) return 'null';
    if (typeof candidate === 'string' || typeof candidate === 'boolean') return JSON.stringify(candidate);
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return JSON.stringify(candidate);
    if (typeof candidate !== 'object' || !candidate || ancestors.has(candidate) || !isDataObject(candidate)) throw new Error('INVALID_JSON');
    ancestors.add(candidate);
    let serialized: string;
    if (Array.isArray(candidate)) {
      if (Object.keys(candidate).length !== candidate.length || Object.keys(candidate).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= candidate.length)) throw new Error('INVALID_JSON');
      serialized = `[${candidate.map((item) => visit(item, depth + 1)).join(',')}]`;
    } else {
      if (!isPlainObject(candidate)) throw new Error('INVALID_JSON');
      serialized = `{${Object.keys(candidate).sort().map((key) => `${JSON.stringify(key)}:${visit(candidate[key], depth + 1)}`).join(',')}}`;
    }
    ancestors.delete(candidate);
    return serialized;
  };
  return visit(value, 0);
}
