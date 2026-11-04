import type { AccountSyncState, NoteData, PullResponse, PushResult, SyncRecord } from './types.ts';
import { canonicalJson, isPlainObject, validateEntityData, validatePullResponse, validateRecord, validatePushResult } from './validation.ts';
import { UUID_PATTERN } from './schema.ts';
import { createAccountState, validateClientState, applyPullPage, getSyncContext, getVisibleEntity, queueLocalEdit, applyConflictResolution } from './state.ts';
import { createDesktopIdentityMap, isDesktopLocalId, validateDesktopIdentityMap, type DesktopIdentityMap, type ConfirmedDesktopNoteBinding } from './desktopProjection.ts';

export const DESKTOP_NOTE_LIMITS = Object.freeze({ privateBytes: 16 * 1024 * 1024, notes: 500, selected: 16, copyBindings: 4096, pullPages: 2048, pageSize: 8 });
export interface DesktopNoteScope { serviceKey: string; accountId: string; libraryBindingId: string }
export type DesktopNoteResolveRequest = { opId: string; expectedRevision: number; choice: 'current' | 'attempted' };
export interface DesktopNoteResolution { conflictId: string; request: DesktopNoteResolveRequest; consumedOverlayOpId: string | null; lastResult: PushResult | null }
export interface DesktopNoteCopyBinding { entityId: string; localId: string }
export interface DesktopNoteCopyIntent {
  entityId: string; localNoteId: string; revision: number;
  paperBindings: DesktopNoteCopyBinding[]; noteBindings: DesktopNoteCopyBinding[];
}
export interface DesktopNoteExchangeState {
  formatVersion: 1; scope: DesktopNoteScope; revision: number; richEnabled: boolean;
  identityMap: DesktopIdentityMap; sync: AccountSyncState; accepted: SyncRecord<'note'>[];
  pendingResolutions: DesktopNoteResolution[]; pendingCopies: DesktopNoteCopyIntent[]; checkedAt: string | null;
}
export class DesktopNoteError extends Error {
  readonly code: string;
  constructor(code = 'NOTE_STATE_INVALID') { super(code); this.code = code; this.name = 'DesktopNoteError'; }
}
const fail = (code = 'NOTE_STATE_INVALID'): never => { throw new DesktopNoteError(code); };
const uuid = new RegExp(UUID_PATTERN);
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => isPlainObject(value)
  && Reflect.ownKeys(value).length === keys.length && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function stamp(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24) return fail();
  try { if (new Date(value).toISOString() !== value) return fail(); } catch { return fail(); }
  return value;
}
function selection(value: unknown): string[] {
  canonicalJson(value);
  if (!Array.isArray(value) || value.length < 1 || value.length > DESKTOP_NOTE_LIMITS.selected
    || value.some(entry => !id(entry)) || new Set(value).size !== value.length) return fail('NOTE_SELECTION_INVALID');
  return [...value];
}
export function validateDesktopNoteScope(value: unknown): DesktopNoteScope {
  canonicalJson(value);
  if (!exact(value, ['serviceKey', 'accountId', 'libraryBindingId']) || typeof value.serviceKey !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.serviceKey) || !id(value.accountId) || !id(value.libraryBindingId)) return fail('NOTE_SCOPE_CHANGED');
  return { serviceKey: value.serviceKey, accountId: value.accountId, libraryBindingId: value.libraryBindingId };
}
function resolution(value: unknown, sync: AccountSyncState): DesktopNoteResolution {
  if (!exact(value, ['conflictId', 'request', 'consumedOverlayOpId', 'lastResult']) || !id(value.conflictId)
    || !sync.conflicts[value.conflictId] || value.consumedOverlayOpId !== null && !id(value.consumedOverlayOpId)) return fail();
  const request = value.request;
  if (!exact(request, ['opId', 'expectedRevision', 'choice']) || !id(request.opId) || !integer(request.expectedRevision)
    || !['current', 'attempted'].includes(String(request.choice))) return fail();
  const result = value.lastResult === null ? null : validatePushResult(value.lastResult);
  if (result && (!result.ok || result.value.opId !== request.opId || result.value.status === 'applied'
    || result.value.status === 'conflict' && result.value.conflictId !== value.conflictId)) return fail();
  if (result?.ok && result.value.record && (result.value.record.entityType !== 'note'
    || result.value.record.entityId !== sync.conflicts[value.conflictId].attempted.entityId)) return fail();
  return { conflictId: value.conflictId, request: { opId: request.opId, expectedRevision: request.expectedRevision, choice: request.choice as 'current' | 'attempted' },
    consumedOverlayOpId: value.consumedOverlayOpId as string | null, lastResult: result && result.ok ? structuredClone(result.value) : null };
}
function copyBindings(value: unknown): DesktopNoteCopyBinding[] {
  if (!Array.isArray(value)) return fail();
  if (value.length > DESKTOP_NOTE_LIMITS.copyBindings) return fail('NOTE_STATE_FULL');
  const entities = new Set<string>(), locals = new Set<string>();
  return value.map(row => {
    if (!exact(row, ['entityId', 'localId']) || !id(row.entityId) || !isDesktopLocalId(row.localId)
      || entities.has(row.entityId) || locals.has(row.localId)) return fail();
    entities.add(row.entityId); locals.add(row.localId);
    return { entityId: row.entityId, localId: row.localId };
  });
}
function copyIntent(value: unknown, accepted: readonly SyncRecord<'note'>[], map: DesktopIdentityMap): DesktopNoteCopyIntent {
  if (!exact(value, ['entityId', 'localNoteId', 'revision', 'paperBindings', 'noteBindings']) || !id(value.entityId)
    || !isDesktopLocalId(value.localNoteId) || !integer(value.revision, 1)) return fail();
  const source = accepted.find(row => row.entityId === value.entityId);
  if (!source || source.revision !== value.revision || source.deletedAt !== null
    || map.aliases[JSON.stringify(['note', value.localNoteId])] !== value.entityId) return fail();
  return { entityId: value.entityId, localNoteId: value.localNoteId, revision: value.revision,
    paperBindings: copyBindings(value.paperBindings), noteBindings: copyBindings(value.noteBindings) };
}
export function readDesktopNoteState(input: unknown, expected: DesktopNoteScope): DesktopNoteExchangeState {
  try {
    if (new TextEncoder().encode(canonicalJson(input)).length > DESKTOP_NOTE_LIMITS.privateBytes) return fail('NOTE_STATE_FULL');
    if (!exact(input, ['formatVersion', 'scope', 'revision', 'richEnabled', 'identityMap', 'sync', 'accepted', 'pendingResolutions', 'pendingCopies', 'checkedAt'])
      || input.formatVersion !== 1 || !integer(input.revision, 1) || typeof input.richEnabled !== 'boolean') return fail();
    const scope = validateDesktopNoteScope(input.scope);
    if (canonicalJson(scope) !== canonicalJson(validateDesktopNoteScope(expected))) return fail('NOTE_SCOPE_CHANGED');
    const map = validateDesktopIdentityMap(input.identityMap), client = validateClientState(input.sync);
    if (!map.ok || map.value.accountId !== scope.accountId || map.value.libraryBindingId !== scope.libraryBindingId
      || !client.ok || client.value.accountId !== scope.accountId) return fail();
    if (Object.keys(map.value.aliases).length > DESKTOP_NOTE_LIMITS.notes) return fail('NOTE_STATE_FULL');
    for (const key of Object.keys(map.value.aliases)) {
      const alias = JSON.parse(key); if (alias.length !== 2 || alias[0] !== 'note') return fail();
    }
    const sync = client.value;
    if (Object.values(sync.serverRecords).some(row => row.entityType !== 'note')
      || sync.outbox.some(row => row.operation.entityType !== 'note') || Object.values(sync.overlays).some(row => row.entityType !== 'note')
      || Object.values(sync.conflicts).some(row => row.attempted.entityType !== 'note')) return fail();
    if (!Array.isArray(input.accepted) || input.accepted.length > DESKTOP_NOTE_LIMITS.notes || !Array.isArray(input.pendingResolutions)
      || input.pendingResolutions.length > DESKTOP_NOTE_LIMITS.notes) return fail('NOTE_STATE_FULL');
    const seen = new Set<string>(), accepted: SyncRecord<'note'>[] = [];
    for (const value of input.accepted) {
      const checked = validateRecord(value);
      if (!checked.ok || checked.value.entityType !== 'note' || seen.has(checked.value.entityId)) return fail();
      const head = sync.serverRecords['note:' + checked.value.entityId];
      if (!head || checked.value.revision > head.revision
        || checked.value.revision === head.revision && canonicalJson(checked.value) !== canonicalJson(head)) return fail();
      seen.add(checked.value.entityId); accepted.push(structuredClone(checked.value) as SyncRecord<'note'>);
    }
    const pendingResolutions = input.pendingResolutions.map(value => resolution(value, sync));
    if (new Set(pendingResolutions.map(row => row.conflictId)).size !== pendingResolutions.length
      || new Set(pendingResolutions.map(row => row.request.opId)).size !== pendingResolutions.length) return fail();
    const operationIds = new Set([...sync.outbox.map(row => row.operation.opId), ...Object.values(sync.overlays).map(row => row.opId),
      ...Object.values(sync.conflicts).map(row => row.attempted.opId)]);
    if (pendingResolutions.some(row => operationIds.has(row.request.opId))) return fail();
    if (!Array.isArray(input.pendingCopies)) return fail();
    if (input.pendingCopies.length > DESKTOP_NOTE_LIMITS.notes) return fail('NOTE_STATE_FULL');
    const pendingCopies = input.pendingCopies.map(value => copyIntent(value, accepted, map.value));
    if (new Set(pendingCopies.map(row => row.entityId)).size !== pendingCopies.length
      || new Set(pendingCopies.map(row => row.localNoteId)).size !== pendingCopies.length) return fail();
    return { formatVersion: 1, scope, revision: input.revision, richEnabled: input.richEnabled, identityMap: structuredClone(map.value),
      sync: structuredClone(sync), accepted, pendingResolutions, pendingCopies, checkedAt: input.checkedAt === null ? null : stamp(input.checkedAt) };
  } catch (error) { if (error instanceof DesktopNoteError) throw error; return fail(); }
}
export function createDesktopNoteState(owner: DesktopNoteScope, deviceId: string): DesktopNoteExchangeState {
  const scope = validateDesktopNoteScope(owner);
  return readDesktopNoteState({ formatVersion: 1, scope, revision: 1, richEnabled: false,
    identityMap: createDesktopIdentityMap(scope.accountId, scope.libraryBindingId), sync: createAccountState(scope.accountId, deviceId),
    accepted: [], pendingResolutions: [], pendingCopies: [], checkedAt: null }, scope);
}
function next(input: DesktopNoteExchangeState, patch: Partial<DesktopNoteExchangeState>): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope);
  if (state.revision === Number.MAX_SAFE_INTEGER) return fail('NOTE_STATE_FULL');
  return readDesktopNoteState({ ...state, ...patch, revision: state.revision + 1 }, state.scope);
}
export function withDesktopNoteSync(state: DesktopNoteExchangeState, sync: AccountSyncState): DesktopNoteExchangeState { return next(state, { sync }); }
export function withDesktopNoteFeatures(input: DesktopNoteExchangeState, richEnabled: boolean): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope);
  if (typeof richEnabled !== 'boolean') return fail();
  return state.richEnabled === richEnabled ? state : next(state, { richEnabled, sync: { ...state.sync, cursor: null }, checkedAt: null });
}
/** Retain only note bodies while advancing the exact full-feed cursor. A check
 * never adopts account contents into the desktop's original note store. */
export function stageDesktopNotePull(input: DesktopNoteExchangeState, pages: readonly PullResponse[], observedAt: string): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope); stamp(observedAt); canonicalJson(pages);
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > DESKTOP_NOTE_LIMITS.pullPages) return fail('NOTE_LIMIT');
  if (new TextEncoder().encode(canonicalJson(pages)).length > DESKTOP_NOTE_LIMITS.privateBytes) return fail('NOTE_STATE_FULL');
  let sync = state.sync;
  for (let index = 0; index < pages.length; index++) {
    const valid = validatePullResponse(pages[index]);
    if (!valid.ok || valid.value.hasMore !== (index < pages.length - 1)
      || valid.value.hasMore && valid.value.nextCursor === sync.cursor) return fail();
    sync = applyPullPage(sync, getSyncContext(sync), { fromCursor: sync.cursor,
      response: { ...valid.value, records: valid.value.records.filter(row => row.entityType === 'note') } });
  }
  return next(state, { sync, checkedAt: observedAt });
}
export function confirmedDesktopNoteBindings(input: DesktopNoteExchangeState): ConfirmedDesktopNoteBinding[] {
  const state = readDesktopNoteState(input, input.scope), rows: ConfirmedDesktopNoteBinding[] = [];
  for (const [key, entityId] of Object.entries(state.identityMap.aliases)) {
    const head = state.sync.serverRecords['note:' + entityId];
    if (head?.entityType === 'note' && head.deletedAt === null && head.data && !getVisibleEntity(state.sync, 'note', entityId)?.pending
      && !Object.values(state.sync.conflicts).some(row => row.attempted.entityId === entityId)
      && !state.pendingCopies.some(row => row.entityId === entityId)) rows.push({ localNoteId: JSON.parse(key)[1], entityId });
  }
  return rows;
}
function aliasKey(localNoteId: string): string {
  if (!isDesktopLocalId(localNoteId)) return fail('NOTE_SELECTION_INVALID');
  return JSON.stringify(['note', localNoteId]);
}
export function bindDesktopAccountNote(input: DesktopNoteExchangeState, localNoteId: string, entityId: string): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope), key = aliasKey(localNoteId), head = state.sync.serverRecords['note:' + entityId];
  if (!id(entityId) || !head || head.deletedAt !== null || !head.data) return fail('NOTE_REMOTE_UNAVAILABLE');
  if (getVisibleEntity(state.sync, 'note', entityId)?.pending || Object.values(state.sync.conflicts).some(row => row.attempted.entityId === entityId)) return fail('NOTE_PENDING');
  const previous = state.identityMap.aliases[key];
  if (previous && previous !== entityId || Object.entries(state.identityMap.aliases).some(([other, value]) => other !== key && value === entityId)) return fail('NOTE_BINDING_CONFLICT');
  return next(state, { identityMap: { ...state.identityMap, aliases: { ...state.identityMap.aliases, [key]: entityId } } });
}
export interface DesktopNotePublication { localNoteId: string; entityId: string; data: NoteData; mutation?: 'put' | 'restore' }
export function stageDesktopNotePublication(input: DesktopNoteExchangeState, rows: readonly DesktopNotePublication[], allocate: () => string, createdAt: string): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope); stamp(createdAt); canonicalJson(rows);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > DESKTOP_NOTE_LIMITS.selected) return fail('NOTE_SELECTION_INVALID');
  const locals = new Set<string>(), ids = new Set<string>();
  const identityMap = structuredClone(state.identityMap); let sync = state.sync;
  for (const row of rows) {
    const key = aliasKey(row.localNoteId), previous = identityMap.aliases[key], head = sync.serverRecords['note:' + row.entityId];
    if (!id(row.entityId) || locals.has(row.localNoteId) || ids.has(row.entityId) || previous && previous !== row.entityId
      || Object.entries(identityMap.aliases).some(([other, value]) => other !== key && value === row.entityId)) return fail('NOTE_BINDING_CONFLICT');
    if (!previous && head) return fail('NOTE_BINDING_REQUIRED');
    if (state.pendingCopies.some(value => value.entityId === row.entityId)) return fail('NOTE_COPY_SAVE_UNCONFIRMED');
    if (getVisibleEntity(sync, 'note', row.entityId)?.pending || Object.values(sync.conflicts).some(value => value.attempted.entityId === row.entityId)) return fail('NOTE_PENDING');
    const checked = validateEntityData('note', row.data); if (!checked.ok) return fail('NOTE_UNSUPPORTED');
    if (row.data.format === 'tiptap-json' && !state.richEnabled) return fail('NOTE_RICH_UNAVAILABLE');
    if (row.mutation !== undefined && !['put', 'restore'].includes(row.mutation) || head?.deletedAt && row.mutation !== 'restore'
      || row.mutation === 'restore' && !head?.deletedAt) return fail('NOTE_RESTORE_REQUIRED');
    locals.add(row.localNoteId); ids.add(row.entityId); identityMap.aliases[key] = row.entityId;
    if (head && head.deletedAt === null && canonicalJson(head.data) === canonicalJson(checked.value)) continue;
    sync = queueLocalEdit(sync, { entityType: 'note', entityId: row.entityId, mutation: row.mutation ?? 'put', data: checked.value }, { opId: allocate(), clientCreatedAt: createdAt });
  }
  return next(state, { identityMap, sync });
}
function acceptanceHead(state: DesktopNoteExchangeState, entityId: string): SyncRecord<'note'> {
  const head = state.sync.serverRecords['note:' + entityId];
  if (!head || head.entityType !== 'note') return fail('NOTE_REMOTE_UNAVAILABLE');
  const pendingCopy = state.pendingCopies.find(row => row.entityId === entityId);
  if (pendingCopy && (head.revision !== pendingCopy.revision || head.deletedAt !== null)) return fail('NOTE_COPY_SAVE_UNCONFIRMED');
  if (getVisibleEntity(state.sync, 'note', entityId)?.pending || Object.values(state.sync.conflicts).some(row => row.attempted.entityId === entityId)) return fail('NOTE_PENDING');
  return structuredClone(head) as SyncRecord<'note'>;
}
export function acceptDesktopNotes(input: DesktopNoteExchangeState, ids: readonly string[]): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope), accepted = new Map(state.accepted.map(row => [row.entityId, row]));
  for (const entityId of selection(ids)) accepted.set(entityId, acceptanceHead(state, entityId));
  return next(state, { accepted: [...accepted.values()] });
}
/** Persist this intent before creating the named local copy. Original local
 * notes remain untouched; accepting a tombstone never rebinds or deletes them. */
export function adoptDesktopNoteCopy(input: DesktopNoteExchangeState, entityId: string, localCopyId: string): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope), head = acceptanceHead(state, selection([entityId])[0]);
  const pendingCopy = state.pendingCopies.find(row => row.entityId === entityId);
  if (pendingCopy && pendingCopy.localNoteId !== localCopyId) return fail('NOTE_COPY_SAVE_UNCONFIRMED');
  const accepted = new Map(state.accepted.map(row => [row.entityId, row])), identityMap = structuredClone(state.identityMap);
  if (head.deletedAt === null) {
    const key = aliasKey(localCopyId), previous = identityMap.aliases[key];
    if (previous && previous !== entityId) return fail('NOTE_BINDING_CONFLICT');
    for (const [alias, target] of Object.entries(identityMap.aliases)) if (target === entityId) delete identityMap.aliases[alias];
    identityMap.aliases[key] = entityId;
  }
  accepted.set(entityId, head);
  const patch = { accepted: [...accepted.values()], identityMap };
  if (canonicalJson(patch) === canonicalJson({ accepted: state.accepted, identityMap: state.identityMap })) return state;
  return next(state, patch);
}
/** Combine with adoption in RAM, then persist once before touching local notes.
 * Captured identities stay fixed even if later account mappings change. */
export function stageDesktopNoteCopyIntents(input: DesktopNoteExchangeState, entries: readonly DesktopNoteCopyIntent[]): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope); canonicalJson(entries);
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > DESKTOP_NOTE_LIMITS.selected) return fail('NOTE_SELECTION_INVALID');
  const pending = new Map(state.pendingCopies.map(row => [row.entityId, row])), seen = new Set<string>();
  for (const entry of entries) {
    const row = copyIntent(entry, state.accepted, state.identityMap), previous = pending.get(row.entityId);
    if (seen.has(row.entityId)) return fail('NOTE_SELECTION_INVALID');
    if (previous && canonicalJson(previous) !== canonicalJson(row)) return fail('NOTE_COPY_SAVE_UNCONFIRMED');
    seen.add(row.entityId); pending.set(row.entityId, row);
  }
  if (pending.size === state.pendingCopies.length) return state;
  return next(state, { pendingCopies: [...pending.values()] });
}
/** Called only after the corresponding fixed-ID local copies passed readback. */
export function completeDesktopNoteCopies(input: DesktopNoteExchangeState, localNoteIds: readonly string[]): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope); canonicalJson(localNoteIds);
  if (!Array.isArray(localNoteIds) || localNoteIds.length > DESKTOP_NOTE_LIMITS.notes
    || localNoteIds.some(value => !isDesktopLocalId(value)) || new Set(localNoteIds).size !== localNoteIds.length) return fail('NOTE_SELECTION_INVALID');
  const completed = new Set(localNoteIds), pendingCopies = state.pendingCopies.filter(row => !completed.has(row.localNoteId));
  return pendingCopies.length === state.pendingCopies.length ? state : next(state, { pendingCopies });
}
export function stageDesktopNoteResolution(input: DesktopNoteExchangeState, conflictId: string, choice: 'current' | 'attempted', expectedRevision: number, opId: string): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope), conflict = state.sync.conflicts[conflictId];
  if (!conflict || !id(opId) || !['current', 'attempted'].includes(choice)) return fail('NOTE_CONFLICT_CHANGED');
  const head = state.sync.serverRecords['note:' + conflict.attempted.entityId], revision = Math.max(head?.revision ?? 0, conflict.current?.revision ?? 0);
  if (revision !== expectedRevision) return fail('NOTE_CONFLICT_CHANGED');
  const previous = state.pendingResolutions.find(row => row.conflictId === conflictId);
  if (previous && (!previous.lastResult || previous.lastResult.status === 'rejected' && previous.lastResult.retryable === true)) return fail('NOTE_PENDING');
  if (previous?.request.opId === opId) return fail('NOTE_CONFLICT_CHANGED');
  return next(state, { pendingResolutions: [...state.pendingResolutions.filter(row => row !== previous), { conflictId, request: { opId, choice, expectedRevision },
    consumedOverlayOpId: state.sync.overlays['note:' + conflict.attempted.entityId]?.opId ?? null, lastResult: null }] });
}
export function applyDesktopNoteResolution(input: DesktopNoteExchangeState, conflictId: string, result: unknown): DesktopNoteExchangeState {
  const state = readDesktopNoteState(input, input.scope), pending = state.pendingResolutions.find(row => row.conflictId === conflictId), valid = validatePushResult(result);
  if (!pending || !valid.ok || valid.value.opId !== pending.request.opId) return fail();
  const row = valid.value, original = state.sync.conflicts[conflictId];
  if (!original || row.record && (row.record.entityType !== 'note' || row.record.entityId !== original.attempted.entityId)) return fail();
  const terminal = pending.lastResult && (pending.lastResult.status === 'conflict' || pending.lastResult.status === 'rejected' && !pending.lastResult.retryable);
  // A replay may change only the transport's replayed flag, never the saved decision.
  if (terminal && canonicalJson({ ...pending.lastResult, replayed: row.replayed }) !== canonicalJson(row)) return fail();
  if (row.status === 'applied') {
    if (!row.record && (pending.request.choice !== 'current' || pending.request.expectedRevision !== 0)
      || row.record && row.record.revision < pending.request.expectedRevision) return fail();
    const sync = applyConflictResolution(state.sync, getSyncContext(state.sync), { conflictId, record: row.record ?? null, consumedOverlayOpId: pending.consumedOverlayOpId ?? undefined });
    return next(state, { sync, pendingResolutions: state.pendingResolutions.filter(value => value !== pending) });
  }
  if (row.status === 'conflict' && row.conflictId !== conflictId) return fail();
  let sync = state.sync;
  if (row.record) {
    sync = applyPullPage(sync, getSyncContext(sync), { fromCursor: sync.cursor,
      response: { protocolVersion: 1, records: [row.record], nextCursor: sync.cursor, hasMore: false } });
    sync.conflicts[conflictId] = { ...original, current: sync.serverRecords['note:' + original.attempted.entityId] };
  }
  return next(state, { sync, pendingResolutions: state.pendingResolutions.map(value => value === pending ? { ...value, lastResult: row } : value) });
}
