import type { AccountSyncState, PullResponse, PushResponse, PushResult, ReadingPositionData, SyncContext, SyncRecord } from './types.ts';
import { canonicalJson, isPlainObject, validateEntityData, validatePullResponse, validatePushResponse, validatePushResult, validateRecord } from './validation.ts';
import { UUID_PATTERN } from './schema.ts';
import { applyConflictResolution, applyPullPage, applyPushResults, createAccountState, getSyncContext, queueLocalEdit, validateClientState } from './state.ts';
import { isDesktopLocalId } from './desktopProjection.ts';

export const DESKTOP_READING_LIMITS = Object.freeze({ privateBytes: 8 * 1024 * 1024, positions: 2000, bindings: 2000,
  pullPages: 8192, pdfBytes: 64 * 1024 * 1024, pages: 100000 });
export interface DesktopReadingScope { serviceKey: string; accountId: string; libraryBindingId: string }
export interface DesktopReadingCapture {
  bindingId: string; sha256: string; sizeBytes: number; pageCount: number; pageIndex: number; offsetRatio: number; observedAt: string;
}
export interface VerifiedDesktopReadingSource {
  bindingId: string; localPaperId: string; localAttachmentId: string; paperId: string; attachmentVersionId: string;
  sha256: string; sizeBytes: number; pageCount: number; title: string; fileName: string;
}
export interface DesktopReadingIntent {
  opId: string; entityId: string; originDeviceId: string; source: VerifiedDesktopReadingSource; capture: DesktopReadingCapture;
}
export interface DesktopReadingCheckpoint {
  entityId: string; originDeviceId: string; lastLive: SyncRecord<'readingPosition'>; source: VerifiedDesktopReadingSource | null;
}
export interface DesktopReadingTrackedPoint {
  pageIndex: number; offsetRatio: number; furthestPageIndex: number; furthestOffsetRatio: number; observedAt: string;
}
export interface DesktopReadingDraft {
  originDeviceId: string; source: VerifiedDesktopReadingSource; capture: DesktopReadingCapture;
  furthestPageIndex: number; furthestOffsetRatio: number; sessionId: string;
}
export interface DesktopReadingResolution {
  conflictId: string; originDeviceId: string;
  request: { opId: string; expectedRevision: number; choice: 'current' | 'attempted' }; lastResult: PushResult | null;
}
export interface DesktopReadingState {
  formatVersion: 1; scope: DesktopReadingScope; revision: number; sync: AccountSyncState;
  checkpoints: DesktopReadingCheckpoint[]; drafts: DesktopReadingDraft[]; intents: DesktopReadingIntent[];
  pendingResolutions: DesktopReadingResolution[]; checkedAt: string | null;
}
export interface DesktopReadingPlan {
  publicationAction: 'create' | 'update' | 'restore' | 'blocked'; publicationReason: string | null;
  own: SyncRecord<'readingPosition'> | null; previous: ReadingPositionData | null;
}
export class DesktopReadingError extends Error {
  readonly code: string;
  constructor(code = 'READING_STATE_INVALID') { super(code); this.name = 'DesktopReadingError'; this.code = code; }
}
const fail = (code = 'READING_STATE_INVALID'): never => { throw new DesktopReadingError(code); };
const id = (value: unknown): value is string => typeof value === 'string' && new RegExp(UUID_PATTERN).test(value);
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => isPlainObject(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key)) && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => row.enumerable && 'value' in row);
const array = (value: unknown, maximum: number): value is unknown[] => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1 && Object.keys(value).length === value.length
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => 'value' in row);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const fraction = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const key = (entityId: string): string => 'readingPosition:' + entityId;
function stamp(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24) return fail();
  try { if (new Date(value).toISOString() !== value) return fail(); } catch { return fail(); } return value;
}
export function validateDesktopReadingScope(value: unknown): DesktopReadingScope {
  canonicalJson(value);
  if (!exact(value, ['serviceKey', 'accountId', 'libraryBindingId']) || !hash(value.serviceKey) || !id(value.accountId) || !id(value.libraryBindingId)) return fail('READING_SCOPE_CHANGED');
  return { serviceKey: value.serviceKey, accountId: value.accountId, libraryBindingId: value.libraryBindingId };
}
export function readDesktopReadingCapture(value: unknown): DesktopReadingCapture {
  try {
    canonicalJson(value);
    if (!exact(value, ['bindingId', 'sha256', 'sizeBytes', 'pageCount', 'pageIndex', 'offsetRatio', 'observedAt']) || !id(value.bindingId) || !hash(value.sha256)
      || !integer(value.sizeBytes, 1, DESKTOP_READING_LIMITS.pdfBytes) || !integer(value.pageCount, 1, DESKTOP_READING_LIMITS.pages)
      || !integer(value.pageIndex, 0, Number(value.pageCount) - 1) || !fraction(value.offsetRatio)) return fail('READING_POSITION_UNSUPPORTED');
    stamp(value.observedAt); return structuredClone(value) as unknown as DesktopReadingCapture;
  } catch (error) { if (error instanceof DesktopReadingError) throw error; return fail('READING_POSITION_UNSUPPORTED'); }
}
export function readVerifiedDesktopReadingSource(value: unknown): VerifiedDesktopReadingSource {
  try {
    canonicalJson(value);
    if (!exact(value, ['bindingId', 'localPaperId', 'localAttachmentId', 'paperId', 'attachmentVersionId', 'sha256', 'sizeBytes', 'pageCount', 'title', 'fileName'])
      || !id(value.bindingId) || !id(value.paperId) || !id(value.attachmentVersionId) || !isDesktopLocalId(value.localPaperId) || !isDesktopLocalId(value.localAttachmentId)
      || !hash(value.sha256) || !integer(value.sizeBytes, 1, DESKTOP_READING_LIMITS.pdfBytes) || !integer(value.pageCount, 1, DESKTOP_READING_LIMITS.pages)
      || !text(value.title, 4096) || !text(value.fileName, 255) || /[\\/:]/.test(value.fileName)) return fail('READING_SOURCE_CHANGED');
    return structuredClone(value) as unknown as VerifiedDesktopReadingSource;
  } catch (error) { if (error instanceof DesktopReadingError) throw error; return fail('READING_SOURCE_CHANGED'); }
}
export function desktopReadingPointFits(data: ReadingPositionData, source: VerifiedDesktopReadingSource): boolean {
  return data.paperId === source.paperId && data.attachmentVersionId === source.attachmentVersionId
    && data.pageIndex < source.pageCount && data.furthestPageIndex < source.pageCount
    && (data.furthestPageIndex > data.pageIndex || data.furthestPageIndex === data.pageIndex && data.furthestOffsetRatio >= data.offsetRatio)
    && data.deviceSequence > 0;
}
function sameVersion(a: VerifiedDesktopReadingSource, b: VerifiedDesktopReadingSource): boolean {
  return ['paperId', 'attachmentVersionId', 'sha256', 'sizeBytes', 'pageCount'].every(field => a[field as keyof typeof a] === b[field as keyof typeof b]);
}
/** Presentation metadata is not document or native-binding identity. */
export function sameDesktopReadingSource(a: VerifiedDesktopReadingSource, b: VerifiedDesktopReadingSource): boolean {
  return sameVersion(a, b) && a.bindingId === b.bindingId && a.localPaperId === b.localPaperId && a.localAttachmentId === b.localAttachmentId;
}
function captureFits(capture: DesktopReadingCapture, source: VerifiedDesktopReadingSource): boolean {
  return capture.bindingId === source.bindingId && capture.sha256 === source.sha256 && capture.sizeBytes === source.sizeBytes && capture.pageCount === source.pageCount;
}
function liveRecord(value: unknown): SyncRecord<'readingPosition'> {
  const checked = validateRecord(value);
  if (!checked.ok || checked.value.entityType !== 'readingPosition' || checked.value.deletedAt !== null || !checked.value.data || checked.value.data.deviceSequence < 1) return fail();
  return structuredClone(checked.value) as SyncRecord<'readingPosition'>;
}
function intent(value: unknown): DesktopReadingIntent {
  if (!exact(value, ['opId', 'entityId', 'originDeviceId', 'source', 'capture']) || !id(value.opId) || !id(value.entityId) || !id(value.originDeviceId)) return fail();
  const source = readVerifiedDesktopReadingSource(value.source), capture = readDesktopReadingCapture(value.capture);
  if (!captureFits(capture, source)) return fail(); return { opId: value.opId, entityId: value.entityId, originDeviceId: value.originDeviceId, source, capture };
}
export function readDesktopReadingTrackedPoint(value: unknown, pageCount: number): DesktopReadingTrackedPoint {
  try {
    canonicalJson(value);
    if (!integer(pageCount, 1, DESKTOP_READING_LIMITS.pages)
      || !exact(value, ['pageIndex', 'offsetRatio', 'furthestPageIndex', 'furthestOffsetRatio', 'observedAt'])
      || !integer(value.pageIndex, 0, pageCount - 1) || !integer(value.furthestPageIndex, 0, pageCount - 1)
      || !fraction(value.offsetRatio) || !fraction(value.furthestOffsetRatio)
      || value.furthestPageIndex < value.pageIndex || value.furthestPageIndex === value.pageIndex && value.furthestOffsetRatio < value.offsetRatio) return fail('READING_POSITION_UNSUPPORTED');
    stamp(value.observedAt); return structuredClone(value) as unknown as DesktopReadingTrackedPoint;
  } catch (error) { if (error instanceof DesktopReadingError) throw error; return fail('READING_POSITION_UNSUPPORTED'); }
}
function draft(value: unknown): DesktopReadingDraft {
  if (!exact(value, ['originDeviceId', 'source', 'capture', 'furthestPageIndex', 'furthestOffsetRatio', 'sessionId'])
    || !id(value.originDeviceId) || !id(value.sessionId)) return fail();
  const source = readVerifiedDesktopReadingSource(value.source), capture = readDesktopReadingCapture(value.capture);
  if (!captureFits(capture, source)) return fail();
  const point = readDesktopReadingTrackedPoint({ pageIndex: capture.pageIndex, offsetRatio: capture.offsetRatio,
    furthestPageIndex: value.furthestPageIndex, furthestOffsetRatio: value.furthestOffsetRatio, observedAt: capture.observedAt }, source.pageCount);
  return { originDeviceId: value.originDeviceId, source, capture, furthestPageIndex: point.furthestPageIndex,
    furthestOffsetRatio: point.furthestOffsetRatio, sessionId: value.sessionId };
}
function resolution(value: unknown, sync: AccountSyncState, intents: DesktopReadingIntent[]): DesktopReadingResolution {
  if (!exact(value, ['conflictId', 'originDeviceId', 'request', 'lastResult']) || !id(value.conflictId) || !id(value.originDeviceId)) return fail();
  const conflict = sync.conflicts[value.conflictId], source = intents.find(row => row.opId === conflict?.attempted.opId), request = value.request;
  const original = sync.outbox.find(row => row.operation.opId === conflict?.attempted.opId);
  if (!conflict || !source || !original || original.status !== 'conflict' || original.conflictId !== value.conflictId
    || source.originDeviceId !== value.originDeviceId || !exact(request, ['opId', 'expectedRevision', 'choice']) || !id(request.opId)
    || !integer(request.expectedRevision) || !['current', 'attempted'].includes(String(request.choice))) return fail();
  const checked = value.lastResult === null ? null : validatePushResult(value.lastResult);
  if (checked && (!checked.ok || checked.value.opId !== request.opId || checked.value.status === 'applied'
    || checked.value.status === 'conflict' && checked.value.conflictId !== value.conflictId)) return fail();
  if (checked?.ok && checked.value.record && (checked.value.record.entityType !== 'readingPosition' || checked.value.record.entityId !== source.entityId
    || checked.value.record.modifiedByDeviceId !== source.originDeviceId)) return fail();
  return { conflictId: value.conflictId, originDeviceId: value.originDeviceId,
    request: { opId: request.opId, expectedRevision: request.expectedRevision, choice: request.choice as 'current' | 'attempted' }, lastResult: checked?.ok ? structuredClone(checked.value) : null };
}
export function readDesktopReadingState(value: unknown, expected: DesktopReadingScope): DesktopReadingState {
  try {
    if (new TextEncoder().encode(canonicalJson(value)).length > DESKTOP_READING_LIMITS.privateBytes) return fail('READING_STATE_FULL');
    if (!exact(value, ['formatVersion', 'scope', 'revision', 'sync', 'checkpoints', 'drafts', 'intents', 'pendingResolutions', 'checkedAt']) || value.formatVersion !== 1 || !integer(value.revision, 1)) return fail();
    const scope = validateDesktopReadingScope(value.scope); if (!same(scope, validateDesktopReadingScope(expected))) return fail('READING_SCOPE_CHANGED');
    const checked = validateClientState(value.sync); if (!checked.ok || checked.value.accountId !== scope.accountId) return fail(); const sync = checked.value;
    if (Object.keys(sync.serverRecords).length > DESKTOP_READING_LIMITS.positions || sync.outbox.length > DESKTOP_READING_LIMITS.positions
      || Object.keys(sync.conflicts).length > DESKTOP_READING_LIMITS.positions || Object.values(sync.serverRecords).some(row => row.entityType !== 'readingPosition')
      || sync.outbox.some(row => row.operation.entityType !== 'readingPosition' || row.operation.mutation === 'delete') || Object.keys(sync.overlays).length
      || Object.values(sync.conflicts).some(row => row.attempted.entityType !== 'readingPosition')) return fail();
    if (new Set(Object.values(sync.conflicts).map(row => row.attempted.opId)).size !== Object.keys(sync.conflicts).length) return fail();
    if (!array(value.checkpoints, DESKTOP_READING_LIMITS.positions) || !array(value.drafts, DESKTOP_READING_LIMITS.positions) || !array(value.intents, DESKTOP_READING_LIMITS.positions)
      || !array(value.pendingResolutions, DESKTOP_READING_LIMITS.positions)) return fail('READING_STATE_FULL');
    const checkpoints = value.checkpoints.map(row => {
      if (!exact(row, ['entityId', 'originDeviceId', 'lastLive', 'source']) || !id(row.entityId) || !id(row.originDeviceId)) return fail();
      const lastLive = liveRecord(row.lastLive), head = sync.serverRecords[key(row.entityId)], source = row.source === null ? null : readVerifiedDesktopReadingSource(row.source);
      if (lastLive.entityId !== row.entityId || lastLive.modifiedByDeviceId !== row.originDeviceId || !head || head.modifiedByDeviceId !== row.originDeviceId
        || head.revision < lastLive.revision || head.deletedAt === null && !same(head, lastLive)
        || source && !desktopReadingPointFits(lastLive.data!, source)) return fail();
      return { entityId: row.entityId, originDeviceId: row.originDeviceId, lastLive, source };
    });
    if (new Set(checkpoints.map(row => row.entityId)).size !== checkpoints.length
      || new Set(checkpoints.map(row => JSON.stringify([row.originDeviceId, row.lastLive.data!.attachmentVersionId]))).size !== checkpoints.length) return fail();
    // Every live head needs a retained identity. Otherwise a forged ledger could hide
    // an existing own checkpoint and create around the per-device/version constraint.
    if (Object.values(sync.serverRecords).some(row => row.deletedAt === null && !checkpoints.some(known => known.entityId === row.entityId))) return fail();
    const drafts = value.drafts.map(draft);
    if (new Set(drafts.map(row => JSON.stringify([row.originDeviceId, row.source.attachmentVersionId]))).size !== drafts.length) return fail();
    for (const row of drafts) {
      const known = checkpoints.find(known => known.originDeviceId === row.originDeviceId && known.lastLive.data!.attachmentVersionId === row.source.attachmentVersionId);
      if (known && (!desktopReadingPointFits(known.lastLive.data!, row.source) || known.source && !sameVersion(known.source, row.source))) return fail();
    }
    const intents = value.intents.map(intent), operations = [...sync.outbox.map(row => row.operation), ...Object.values(sync.conflicts).map(row => row.attempted)];
    if (new Set(intents.map(row => row.opId)).size !== intents.length) return fail();
    const originals = new Map<string, typeof operations[number]>();
    for (const operation of operations) {
      const previous = originals.get(operation.opId); if (previous && !same(previous, operation)) return fail(); originals.set(operation.opId, operation);
    }
    for (const row of intents) {
      const operation = operations.find(value => value.opId === row.opId), entry = sync.outbox.find(value => value.operation.opId === row.opId), data = operation?.data;
      if (!operation || !entry || operation.entityType !== 'readingPosition' || operation.entityId !== row.entityId || !data || operation.mutation === 'delete'
        || entry.originDeviceId !== row.originDeviceId || !desktopReadingPointFits(data as ReadingPositionData, row.source)
        || (data as ReadingPositionData).pageIndex !== row.capture.pageIndex || (data as ReadingPositionData).offsetRatio !== row.capture.offsetRatio
        || (data as ReadingPositionData).observedAt !== row.capture.observedAt) return fail();
      const known = checkpoints.find(value => value.entityId === row.entityId);
      if (known && (known.originDeviceId !== row.originDeviceId || !desktopReadingPointFits(known.lastLive.data!, row.source)
        || known.source && !sameVersion(known.source, row.source))) return fail();
      const local = drafts.find(value => value.originDeviceId === row.originDeviceId && value.source.attachmentVersionId === row.source.attachmentVersionId);
      if (local && !sameVersion(local.source, row.source)) return fail();
    }
    if (sync.outbox.some(row => !intents.some(value => value.opId === row.operation.opId))) return fail();
    const pendingResolutions = value.pendingResolutions.map(row => resolution(row, sync, intents));
    if (new Set(pendingResolutions.map(row => row.conflictId)).size !== pendingResolutions.length || new Set(pendingResolutions.map(row => row.request.opId)).size !== pendingResolutions.length
      || pendingResolutions.some(row => operations.some(operation => operation.opId === row.request.opId))) return fail();
    return { formatVersion: 1, scope, revision: value.revision, sync: structuredClone(sync), checkpoints, drafts, intents, pendingResolutions,
      checkedAt: value.checkedAt === null ? null : stamp(value.checkedAt) };
  } catch (error) { if (error instanceof DesktopReadingError) throw error; return fail(); }
}
export function createDesktopReadingState(owner: DesktopReadingScope, deviceId: string): DesktopReadingState {
  const scope = validateDesktopReadingScope(owner); return readDesktopReadingState({ formatVersion: 1, scope, revision: 1,
    sync: createAccountState(scope.accountId, deviceId), checkpoints: [], drafts: [], intents: [], pendingResolutions: [], checkedAt: null }, scope);
}
function next(state: DesktopReadingState, patch: Partial<DesktopReadingState>): DesktopReadingState {
  if (state.revision >= Number.MAX_SAFE_INTEGER) return fail('READING_STATE_FULL'); return readDesktopReadingState({ ...state, ...patch, revision: state.revision + 1 }, state.scope);
}
function collectCheckpoints(state: DesktopReadingState, sync: AccountSyncState): DesktopReadingCheckpoint[] {
  const values = new Map(state.checkpoints.map(row => [row.entityId, row]));
  for (const record of Object.values(sync.serverRecords)) {
    if (record.entityType !== 'readingPosition') return fail(); const known = values.get(record.entityId);
    if (known && (known.originDeviceId !== record.modifiedByDeviceId || record.data && (known.lastLive.data!.paperId !== record.data.paperId
      || known.lastLive.data!.attachmentVersionId !== record.data.attachmentVersionId))) return fail();
    if (!record.data || record.deletedAt !== null) continue;
    if (known && record.revision > known.lastLive.revision && (record.data.deviceSequence <= known.lastLive.data!.deviceSequence
      || record.data.furthestPageIndex < known.lastLive.data!.furthestPageIndex
      || record.data.furthestPageIndex === known.lastLive.data!.furthestPageIndex && record.data.furthestOffsetRatio < known.lastLive.data!.furthestOffsetRatio)) return fail();
    const proof = state.intents.find(row => row.entityId === record.entityId && row.originDeviceId === record.modifiedByDeviceId);
    values.set(record.entityId, { entityId: record.entityId, originDeviceId: record.modifiedByDeviceId, lastLive: structuredClone(record), source: proof?.source ?? known?.source ?? null });
  }
  return [...values.values()];
}
export function withDesktopReadingSync(input: DesktopReadingState, sync: AccountSyncState): DesktopReadingState {
  const state = readDesktopReadingState(input, input.scope), checkpoints = collectCheckpoints(state, sync);
  const active = new Set([...sync.outbox.map(row => row.operation.opId), ...Object.values(sync.conflicts).map(row => row.attempted.opId)]);
  return next(state, { sync, checkpoints, intents: state.intents.filter(row => active.has(row.opId)) });
}
export function stageDesktopReadingPull(input: DesktopReadingState, pages: readonly PullResponse[], observedAt: string): DesktopReadingState {
  let state = readDesktopReadingState(input, input.scope); stamp(observedAt); canonicalJson(pages);
  if (!Array.isArray(pages) || !pages.length || pages.length > DESKTOP_READING_LIMITS.pullPages) return fail('READING_LIMIT');
  if (new TextEncoder().encode(canonicalJson(pages)).length > DESKTOP_READING_LIMITS.privateBytes) return fail('READING_STATE_FULL');
  for (let index = 0; index < pages.length; index++) {
    const checked = validatePullResponse(pages[index]); if (!checked.ok || checked.value.hasMore !== (index + 1 < pages.length)) return fail();
    const sync = applyPullPage(state.sync, getSyncContext(state.sync), { fromCursor: state.sync.cursor,
      response: { ...checked.value, records: checked.value.records.filter(row => row.entityType === 'readingPosition') } });
    state = withDesktopReadingSync(state, sync);
  }
  return next(state, { checkedAt: observedAt });
}
function ownDraft(state: DesktopReadingState, source: VerifiedDesktopReadingSource): DesktopReadingDraft | null {
  const row = state.drafts.find(row => row.originDeviceId === state.sync.deviceId && row.source.attachmentVersionId === source.attachmentVersionId) ?? null;
  if (row && !sameVersion(row.source, source)) return fail('READING_SOURCE_CHANGED'); return row;
}
export function desktopReadingLocalDraft(input: DesktopReadingState, sourceInput: VerifiedDesktopReadingSource): DesktopReadingDraft | null {
  const state = readDesktopReadingState(input, input.scope); return ownDraft(state, readVerifiedDesktopReadingSource(sourceInput));
}
function furthest(points: readonly { furthestPageIndex: number; furthestOffsetRatio: number }[]): { furthestPageIndex: number; furthestOffsetRatio: number } {
  return points.reduce((best, point) => point.furthestPageIndex > best.furthestPageIndex
    || point.furthestPageIndex === best.furthestPageIndex && point.furthestOffsetRatio > best.furthestOffsetRatio ? point : best);
}
function mergeDraft(state: DesktopReadingState, source: VerifiedDesktopReadingSource, capture: DesktopReadingCapture,
  sessionId: string, point: DesktopReadingTrackedPoint): DesktopReadingState {
  if (!id(sessionId) || !captureFits(capture, source)) return fail('READING_SELECTION_INVALID');
  const before = ownDraft(state, source), known = state.checkpoints.find(row => row.originDeviceId === state.sync.deviceId
    && row.lastLive.data!.attachmentVersionId === source.attachmentVersionId);
  if (known && (!desktopReadingPointFits(known.lastLive.data!, source) || known.source && !sameVersion(known.source, source))) return fail('READING_SOURCE_CHANGED');
  const maximum = furthest([point, ...(before ? [before] : []), ...(known ? [known.lastLive.data!] : [])]);
  const row: DesktopReadingDraft = { originDeviceId: state.sync.deviceId, source, capture, sessionId,
    furthestPageIndex: maximum.furthestPageIndex, furthestOffsetRatio: maximum.furthestOffsetRatio };
  return next(state, { drafts: [...state.drafts.filter(row => row !== before), row],
    checkpoints: state.checkpoints.map(checkpoint => checkpoint === known ? { ...checkpoint, source } : checkpoint) });
}
/** A new explicitly enabled session saves the actual initial point, never a wire edit. */
export function stageDesktopReadingDraft(input: DesktopReadingState, sourceInput: VerifiedDesktopReadingSource,
  captureInput: DesktopReadingCapture, sessionId: string): DesktopReadingState {
  const state = readDesktopReadingState(input, input.scope), source = readVerifiedDesktopReadingSource(sourceInput), capture = readDesktopReadingCapture(captureInput);
  return mergeDraft(state, source, capture, sessionId, { pageIndex: capture.pageIndex, offsetRatio: capture.offsetRatio,
    furthestPageIndex: capture.pageIndex, furthestOffsetRatio: capture.offsetRatio, observedAt: capture.observedAt });
}
/** The runtime owns sequence/idempotency; this reducer only accepts its bound session. */
export function recordDesktopReadingDraft(input: DesktopReadingState, sourceInput: VerifiedDesktopReadingSource,
  sessionId: string, pointInput: DesktopReadingTrackedPoint): DesktopReadingState {
  const state = readDesktopReadingState(input, input.scope), source = readVerifiedDesktopReadingSource(sourceInput), before = ownDraft(state, source);
  if (!before || before.sessionId !== sessionId || !sameDesktopReadingSource(before.source, source)) return fail('READING_TRACKING_CHANGED');
  const point = readDesktopReadingTrackedPoint(pointInput, source.pageCount);
  const capture: DesktopReadingCapture = { bindingId: source.bindingId, sha256: source.sha256, sizeBytes: source.sizeBytes,
    pageCount: source.pageCount, pageIndex: point.pageIndex, offsetRatio: point.offsetRatio, observedAt: point.observedAt };
  return mergeDraft(state, source, capture, sessionId, point);
}
export function desktopReadingPlan(input: DesktopReadingState, sourceInput: VerifiedDesktopReadingSource): DesktopReadingPlan {
  const state = readDesktopReadingState(input, input.scope), source = readVerifiedDesktopReadingSource(sourceInput);
  const ownKnown = state.checkpoints.filter(row => row.originDeviceId === state.sync.deviceId && row.lastLive.data!.attachmentVersionId === source.attachmentVersionId);
  const own = ownKnown[0] ? state.sync.serverRecords[key(ownKnown[0].entityId)] as SyncRecord<'readingPosition'> : null;
  const previous = ownKnown[0]?.lastLive.data ?? null;
  const pending = state.intents.some(row => row.originDeviceId === state.sync.deviceId && row.source.attachmentVersionId === source.attachmentVersionId);
  const reason = pending ? 'READING_PENDING' : previous && !desktopReadingPointFits(previous, source) ? 'READING_POSITION_UNSUPPORTED'
    : ownKnown[0]?.source && !sameVersion(ownKnown[0].source, source) ? 'READING_SOURCE_CHANGED'
    : own?.deletedAt && (!ownKnown[0]?.source || !sameVersion(ownKnown[0].source, source)) ? 'READING_TOMBSTONE_UNBOUND' : null;
  return { publicationAction: reason ? 'blocked' : own ? own.deletedAt ? 'restore' : 'update' : 'create', publicationReason: reason, own, previous };
}
export function stageDesktopReadingPublication(input: DesktopReadingState, sourceInput: VerifiedDesktopReadingSource, captureInput: DesktopReadingCapture,
  identity: { opId: string; entityId: string; sessionId: string }, createdAt: string): DesktopReadingState {
  const state = readDesktopReadingState(input, input.scope), source = readVerifiedDesktopReadingSource(sourceInput), capture = readDesktopReadingCapture(captureInput), plan = desktopReadingPlan(state, source);
  canonicalJson(identity); if (!exact(identity, ['opId', 'entityId', 'sessionId']) || !id(identity.opId) || !id(identity.entityId) || !id(identity.sessionId)
    || !captureFits(capture, source)) return fail('READING_SELECTION_INVALID'); stamp(createdAt);
  if (plan.publicationAction === 'blocked') return fail(plan.publicationReason!);
  if (plan.own && plan.own.entityId !== identity.entityId || !plan.own && state.sync.serverRecords[key(identity.entityId)]) return fail('READING_PREVIEW_STALE');
  const before = plan.previous, local = ownDraft(state, source), maximum = furthest([
    { furthestPageIndex: capture.pageIndex, furthestOffsetRatio: capture.offsetRatio }, ...(before ? [before] : []), ...(local ? [local] : []),
  ]);
  const data: ReadingPositionData = { paperId: source.paperId, attachmentVersionId: source.attachmentVersionId, pageIndex: capture.pageIndex, offsetRatio: capture.offsetRatio,
    furthestPageIndex: maximum.furthestPageIndex, furthestOffsetRatio: maximum.furthestOffsetRatio,
    sessionId: identity.sessionId, deviceSequence: (before?.deviceSequence ?? 0) + 1, observedAt: capture.observedAt };
  if (!validateEntityData('readingPosition', data).ok || !Number.isSafeInteger(data.deviceSequence)) return fail('READING_POSITION_UNSUPPORTED');
  const sync = queueLocalEdit(state.sync, { entityType: 'readingPosition', entityId: identity.entityId, mutation: plan.publicationAction === 'restore' ? 'restore' : 'put', data },
    { opId: identity.opId, clientCreatedAt: createdAt });
  const proof: DesktopReadingIntent = { opId: identity.opId, entityId: identity.entityId, originDeviceId: state.sync.deviceId, source, capture };
  const checkpoints = state.checkpoints.map(row => row.entityId === identity.entityId ? { ...row, source } : row);
  return next(state, { sync, checkpoints, intents: [...state.intents, proof] });
}
export function applyDesktopReadingPush(input: DesktopReadingState, context: SyncContext, response: PushResponse, expectedOpIds: string[]): DesktopReadingState {
  const state = readDesktopReadingState(input, input.scope), checked = validatePushResponse(response); if (!checked.ok) return fail();
  for (const result of checked.value.results) {
    const entry = state.sync.outbox.find(row => row.operation.opId === result.opId); if (!entry) return fail();
    if (result.status === 'applied' && (!result.record || result.record.entityType !== 'readingPosition' || result.record.modifiedByDeviceId !== entry.originDeviceId
      || !same(result.record.data, entry.operation.data))) return fail();
    if (result.record && (result.record.entityType !== 'readingPosition' || result.record.modifiedByDeviceId !== entry.originDeviceId)) return fail();
  }
  return withDesktopReadingSync(state, applyPushResults(state.sync, context, checked.value, expectedOpIds));
}
export function stageDesktopReadingResolution(input: DesktopReadingState, conflictId: string, choice: 'current' | 'attempted', expectedRevision: number, opId: string): DesktopReadingState {
  const state = readDesktopReadingState(input, input.scope), conflict = state.sync.conflicts[conflictId], proof = state.intents.find(row => row.opId === conflict?.attempted.opId);
  if (!conflict || !id(opId) || !['current', 'attempted'].includes(choice)) return fail('READING_CONFLICT_CHANGED');
  if (!proof || proof.originDeviceId !== state.sync.deviceId) return fail('READING_DEVICE_CHANGED');
  const head = state.sync.serverRecords[key(conflict.attempted.entityId)], revision = Math.max(head?.revision ?? 0, conflict.current?.revision ?? 0);
  if ([head, conflict.current].some(row => row && row.modifiedByDeviceId !== proof.originDeviceId)) return fail('READING_DEVICE_CHANGED');
  if (revision !== expectedRevision) return fail('READING_CONFLICT_CHANGED');
  const previous = state.pendingResolutions.find(row => row.conflictId === conflictId);
  if (previous && (!previous.lastResult || previous.lastResult.status === 'rejected' && previous.lastResult.retryable)) return fail('READING_PENDING');
  if (previous?.request.opId === opId) return fail('READING_CONFLICT_CHANGED');
  const sync = structuredClone(state.sync), original = sync.outbox.find(row => row.operation.opId === conflict.attempted.opId);
  if (!original || original.status === 'rejected' || original.conflictId && original.conflictId !== conflictId
    || !same(original.operation, conflict.attempted)) return fail('READING_CONFLICT_CHANGED');
  // A conflict may have been learned from /conflicts after the push response was
  // lost. Durably bind that exact original before resolution, so its receipt
  // consumes the uncertain operation instead of replaying the now-closed conflict.
  original.status = 'conflict'; original.conflictId = conflictId; original.errorCode = 'CONFLICT';
  return next(state, { sync, pendingResolutions: [...state.pendingResolutions.filter(row => row !== previous), { conflictId, originDeviceId: proof.originDeviceId,
    request: { opId, expectedRevision, choice }, lastResult: null }] });
}
export function applyDesktopReadingResolution(input: DesktopReadingState, conflictId: string, response: unknown): DesktopReadingState {
  const state = readDesktopReadingState(input, input.scope), pending = state.pendingResolutions.find(row => row.conflictId === conflictId), checked = validatePushResult(response);
  if (!pending || !checked.ok || checked.value.opId !== pending.request.opId) return fail();
  const result = checked.value, conflict = state.sync.conflicts[conflictId];
  if (!conflict || result.record && (result.record.entityType !== 'readingPosition' || result.record.entityId !== conflict.attempted.entityId
    || result.record.modifiedByDeviceId !== pending.originDeviceId)) return fail();
  const terminal = pending.lastResult && (pending.lastResult.status === 'conflict' || pending.lastResult.status === 'rejected' && !pending.lastResult.retryable);
  if (terminal && !same({ ...pending.lastResult, replayed: result.replayed }, result)) return fail();
  if (result.status === 'applied') {
    const head = state.sync.serverRecords[key(conflict.attempted.entityId)], chosen = head && head.revision > (conflict.current?.revision ?? 0) ? head : conflict.current;
    if (!result.record || pending.request.choice === 'current' && (result.record.revision !== pending.request.expectedRevision
      || chosen?.revision === pending.request.expectedRevision && !same(result.record, chosen)) || pending.request.choice === 'attempted'
      && (result.record.revision <= pending.request.expectedRevision || !same(result.record.data, conflict.attempted.data))) return fail();
    const sync = applyConflictResolution(state.sync, getSyncContext(state.sync), { conflictId, record: result.record });
    const prepared = { ...state, pendingResolutions: state.pendingResolutions.filter(row => row !== pending) };
    return withDesktopReadingSync(prepared, sync);
  }
  if (result.status === 'conflict' && result.conflictId !== conflictId) return fail();
  let sync = state.sync;
  if (result.record) {
    sync = applyPullPage(sync, getSyncContext(sync), { fromCursor: sync.cursor, response: { protocolVersion: 1, records: [result.record], nextCursor: sync.cursor, hasMore: false } });
    sync.conflicts[conflictId] = { ...conflict, current: sync.serverRecords[key(conflict.attempted.entityId)] };
  }
  const updated = withDesktopReadingSync(state, sync);
  return next(updated, { pendingResolutions: updated.pendingResolutions.map(row => row.conflictId === conflictId ? { ...row, lastResult: result } : row) });
}
