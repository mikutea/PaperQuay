import { canonicalJson, validateRecord, validatePullResponse, validatePushResult } from './validation.ts';
import { createAccountState, validateClientState, applyPullPage, applyConflictResolution, getSyncContext, listVisibleEntities, getVisibleEntity } from './state.ts';
import { UUID_PATTERN } from './schema.ts';
import { validateGraphRelationData, validateGraphEntityRef, type GraphRelationData, type GraphEntityRef } from './graphRelation.ts';
import { validateDesktopGraphScope, isDesktopGraphLocalId, assertDesktopGraphMapping, graphWireToDesktop, DESKTOP_GRAPH_LIMITS, DesktopGraphError, type DesktopGraphScope, type DesktopGraphMapping, type DesktopGraphIncoming } from './desktopGraph.ts';
import type { AccountSyncState, PullResponse, PushResult, SyncRecord } from './types.ts';

export const DESKTOP_GRAPH_STATE_LIMITS = Object.freeze({ links: 2048, accepted: 2048, parentHeads: 4096, resolutions: 512 });
export interface DesktopGraphLink { localRelationId: string; entityId: string; lastLocalData: GraphRelationData }
export interface DesktopGraphParentHead extends GraphEntityRef { revision: number; deleted: boolean }
export type DesktopGraphResolveRequest =
  | { opId: string; expectedRevision: number; choice: 'current' | 'attempted' }
  | { opId: string; expectedRevision: number; choice: 'merged'; mutation: 'put' | 'restore' | 'delete'; data: GraphRelationData | null };
export interface DesktopGraphResolution { conflictId: string; request: DesktopGraphResolveRequest; consumedOverlayOpId: string | null; lastResult: PushResult | null }
export type DesktopGraphResolutionDecision = (
  | { conflictId: string; expectedRevision: number; choice: 'current' | 'attempted' }
  | { conflictId: string; expectedRevision: number; choice: 'merged'; mutation: 'put' | 'restore' | 'delete'; data: GraphRelationData | null }
) & { consumedOverlayOpId?: string };
export interface DesktopGraphExchangeState {
  formatVersion: 1; scope: DesktopGraphScope; revision: number; sync: AccountSyncState;
  links: DesktopGraphLink[]; accepted: SyncRecord<'graphRelation'>[]; parentHeads: DesktopGraphParentHead[];
  pendingResolutions: DesktopGraphResolution[]; checkedAt: string | null;
}
const uuid = new RegExp(UUID_PATTERN);
const fail = (code: DesktopGraphError['code'] = 'GRAPH_STATE_INVALID'): never => { throw new DesktopGraphError(code); };
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).length === keys.length && Object.keys(v).sort().join(',') === [...keys].sort().join(','));
const id = (v: unknown): v is string => typeof v === 'string' && uuid.test(v);
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
function stamp(v: unknown): string {
  if (typeof v !== 'string' || v.length !== 24) return fail();
  try { if (new Date(v).toISOString() !== v) return fail(); } catch { return fail(); }
  return v;
}
function array(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v)) return fail();
  if (v.length > max) return fail('GRAPH_STATE_FULL');
  return v;
}
function unique(values: string[]) { if (new Set(values).size !== values.length) return fail(); }
const key = (r: GraphEntityRef) => r.entityType + ':' + r.entityId;
export function graphRelationBinding(data: GraphRelationData) {
  return { source: { ...data.source }, target: { ...data.target }, relationType: data.relationType, createdAt: data.createdAt };
}
export function readDesktopGraphResolution(input: unknown): DesktopGraphResolution {
  try {
    canonicalJson(input);
    if (!exact(input, ['conflictId', 'request', 'consumedOverlayOpId', 'lastResult']) || !id(input.conflictId) || input.consumedOverlayOpId !== null && !id(input.consumedOverlayOpId)) return fail();
    const value = input.request;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const merged = (value as Record<string, unknown>).choice === 'merged';
    if (!exact(value, merged ? ['opId', 'expectedRevision', 'choice', 'mutation', 'data'] : ['opId', 'expectedRevision', 'choice']) || !id(value.opId) || !integer(value.expectedRevision) || !['current', 'attempted', 'merged'].includes(String(value.choice))) return fail();
    let request: DesktopGraphResolveRequest;
    if (merged) {
      if (!['put', 'restore', 'delete'].includes(String(value.mutation)) || value.mutation === 'delete' && value.data !== null || value.mutation !== 'delete' && value.data === null) return fail();
      request = { opId: value.opId, expectedRevision: value.expectedRevision, choice: 'merged', mutation: value.mutation as 'put' | 'restore' | 'delete', data: value.data === null ? null : validateGraphRelationData(value.data) };
    } else request = { opId: value.opId, expectedRevision: value.expectedRevision, choice: value.choice as 'current' | 'attempted' };
    const lastResult = input.lastResult === null ? null : validatePushResult(input.lastResult);
    if (lastResult && (!lastResult.ok || lastResult.value.opId !== request.opId || lastResult.value.status === 'applied' || lastResult.value.status === 'conflict' && lastResult.value.conflictId !== input.conflictId)) return fail();
    return { conflictId: input.conflictId, request, consumedOverlayOpId: input.consumedOverlayOpId as string | null, lastResult: lastResult && lastResult.ok ? structuredClone(lastResult.value) : null };
  } catch (e) { if (e instanceof DesktopGraphError) throw e; return fail(); }
}
function knownBindings(state: DesktopGraphExchangeState): Map<string, ReturnType<typeof graphRelationBinding>> {
  const result = new Map<string, ReturnType<typeof graphRelationBinding>>();
  const add = (entityId: string, data: GraphRelationData | null) => {
    if (!data) return;
    const binding = graphRelationBinding(data), previous = result.get(entityId);
    if (previous && canonicalJson(previous) !== canonicalJson(binding)) return fail();
    result.set(entityId, binding);
  };
  for (const row of [...Object.values(state.sync.serverRecords), ...state.accepted]) if (row.entityType === 'graphRelation') add(row.entityId, row.data);
  for (const link of state.links) add(link.entityId, link.lastLocalData);
  for (const entry of state.sync.outbox) if (entry.operation.entityType === 'graphRelation') add(entry.operation.entityId, entry.operation.data);
  for (const edit of Object.values(state.sync.overlays)) if (edit.entityType === 'graphRelation') add(edit.entityId, edit.data);
  for (const conflict of Object.values(state.sync.conflicts)) {
    // A stale remote attempt can reach the conflict branch before the service's
    // immutable-binding check. Keep that draft for review, not as an authority.
    if (conflict.current?.entityType === 'graphRelation') add(conflict.current.entityId, conflict.current.data);
  }
  for (const resolution of state.pendingResolutions) {
    if (resolution.request.choice === 'merged') add(state.sync.conflicts[resolution.conflictId].attempted.entityId, resolution.request.data);
    if (resolution.lastResult?.record?.entityType === 'graphRelation') add(resolution.lastResult.record.entityId, resolution.lastResult.record.data);
  }
  return result;
}
/** Closed account-only snapshot. Unrelated paper/note bodies never enter this file. */
export function readDesktopGraphExchangeState(input: unknown, expected: DesktopGraphScope): DesktopGraphExchangeState {
  try {
    const encoded = canonicalJson(input);
    if (new TextEncoder().encode(encoded).length > DESKTOP_GRAPH_LIMITS.privateBytes) return fail('GRAPH_STATE_FULL');
    if (!exact(input, ['formatVersion', 'scope', 'revision', 'sync', 'links', 'accepted', 'parentHeads', 'pendingResolutions', 'checkedAt']) || input.formatVersion !== 1 || !integer(input.revision, 1)) return fail();
    const owner = validateDesktopGraphScope(input.scope);
    if (canonicalJson(owner) !== canonicalJson(validateDesktopGraphScope(expected))) return fail('GRAPH_MAPPING_CHANGED');
    const validated = validateClientState(input.sync);
    if (!validated.ok || validated.value.accountId !== owner.accountId) return fail();
    const sync = validated.value;
    if (Object.values(sync.serverRecords).some(r => r.entityType !== 'graphRelation') || sync.outbox.some(e => e.operation.entityType !== 'graphRelation') || Object.values(sync.overlays).some(e => e.entityType !== 'graphRelation') || Object.values(sync.conflicts).some(c => c.attempted.entityType !== 'graphRelation' || c.current && c.current.entityType !== 'graphRelation')) return fail();
    const links = array(input.links, DESKTOP_GRAPH_STATE_LIMITS.links).map(v => {
      if (!exact(v, ['localRelationId', 'entityId', 'lastLocalData']) || !isDesktopGraphLocalId(v.localRelationId) || !id(v.entityId)) return fail();
      return { localRelationId: v.localRelationId, entityId: v.entityId, lastLocalData: validateGraphRelationData(v.lastLocalData) };
    });
    unique(links.map(l => l.localRelationId)); unique(links.map(l => l.entityId));
    const accepted = array(input.accepted, DESKTOP_GRAPH_STATE_LIMITS.accepted).map(v => {
      const row = validateRecord(v);
      if (!row.ok || row.value.entityType !== 'graphRelation') return fail();
      const head = sync.serverRecords['graphRelation:' + row.value.entityId];
      if (!head || row.value.revision > head.revision || row.value.revision === head.revision && canonicalJson(row.value) !== canonicalJson(head)) return fail();
      return row.value as SyncRecord<'graphRelation'>;
    });
    unique(accepted.map(r => r.entityId));
    const parentHeads = array(input.parentHeads, DESKTOP_GRAPH_STATE_LIMITS.parentHeads).map(v => {
      if (!exact(v, ['entityType', 'entityId', 'revision', 'deleted']) || !integer(v.revision, 1) || typeof v.deleted !== 'boolean') return fail();
      return { ...validateGraphEntityRef({ entityType: v.entityType, entityId: v.entityId }), revision: v.revision, deleted: v.deleted };
    });
    unique(parentHeads.map(key));
    const pendingResolutions = array(input.pendingResolutions, DESKTOP_GRAPH_STATE_LIMITS.resolutions).map(readDesktopGraphResolution);
    unique(pendingResolutions.map(r => r.conflictId)); unique(pendingResolutions.map(r => r.request.opId));
    const pendingIds = new Set([...sync.outbox.map(e => e.operation.opId), ...Object.values(sync.overlays).map(e => e.opId), ...Object.values(sync.conflicts).map(c => c.attempted.opId)]);
    for (const resolution of pendingResolutions) {
      const conflict = sync.conflicts[resolution.conflictId];
      if (!conflict || pendingIds.has(resolution.request.opId)) return fail();
      const resultRecord = resolution.lastResult?.record;
      if (resultRecord && (resultRecord.entityType !== 'graphRelation' || resultRecord.entityId !== conflict.attempted.entityId)) return fail();
    }
    const state: DesktopGraphExchangeState = { formatVersion: 1, scope: owner, revision: input.revision, sync, links, accepted, parentHeads, pendingResolutions, checkedAt: input.checkedAt === null ? null : stamp(input.checkedAt) };
    knownBindings(state);
    return structuredClone(state);
  } catch (e) { if (e instanceof DesktopGraphError) throw e; return fail(); }
}
export function createDesktopGraphExchangeState(owner: DesktopGraphScope, deviceId: string): DesktopGraphExchangeState {
  const scope = validateDesktopGraphScope(owner);
  if (!id(deviceId)) return fail();
  return { formatVersion: 1, scope, revision: 1, sync: createAccountState(scope.accountId, deviceId), links: [], accepted: [], parentHeads: [], pendingResolutions: [], checkedAt: null };
}
function nextState(previous: DesktopGraphExchangeState, patch: Partial<DesktopGraphExchangeState>): DesktopGraphExchangeState {
  if (previous.revision >= Number.MAX_SAFE_INTEGER) return fail('GRAPH_STATE_FULL');
  return readDesktopGraphExchangeState({ ...previous, ...patch, revision: previous.revision + 1 }, previous.scope);
}
/** Wrap an existing sync reducer result; the caller persists the entire returned snapshot. */
export function withDesktopGraphSync(input: DesktopGraphExchangeState, sync: AccountSyncState): DesktopGraphExchangeState {
  const state = readDesktopGraphExchangeState(input, input.scope);
  return nextState(state, { sync });
}
/** Candidate only: checking advances a RAM snapshot, without adopting incoming records. */
export function stageDesktopGraphPull(input: DesktopGraphExchangeState, pages: readonly PullResponse[], mapping: DesktopGraphMapping, observedAt: string): DesktopGraphExchangeState {
  const state = readDesktopGraphExchangeState(input, input.scope);
  assertDesktopGraphMapping(mapping, state.scope); stamp(observedAt);
  if (!Array.isArray(pages) || pages.length < 1) return fail();
  if (pages.length > DESKTOP_GRAPH_LIMITS.pullPages) return fail('GRAPH_STATE_FULL');
  try { if (new TextEncoder().encode(canonicalJson(pages)).length > DESKTOP_GRAPH_LIMITS.privateBytes) return fail('GRAPH_STATE_FULL'); }
  catch (e) { if (e instanceof DesktopGraphError) throw e; return fail(); }
  const detached = pages.map(page => { const r = validatePullResponse(page); if (!r.ok) return fail(); return structuredClone(r.value); });
  // A supplied sequence is one complete check, not a cursor silently truncated at a budget.
  if (detached.some((page, i) => page.hasMore !== (i < detached.length - 1))) return fail();
  const refs = new Set<string>(mapping.bindings.map(key));
  const add = (data: GraphRelationData | null) => { if (data) { refs.add(key(data.source)); refs.add(key(data.target)); } };
  for (const row of Object.values(state.sync.serverRecords)) if (row.entityType === 'graphRelation') add(row.data);
  for (const row of state.accepted) add(row.data);
  for (const link of state.links) add(link.lastLocalData);
  for (const edit of listVisibleEntities(state.sync, 'graphRelation')) add(edit.deleted ? null : validateGraphRelationData(edit.data));
  for (const conflict of Object.values(state.sync.conflicts)) if (conflict.attempted.entityType === 'graphRelation') add(conflict.attempted.data);
  for (const page of detached) for (const row of page.records) if (row.entityType === 'graphRelation') add(row.data);
  let sync = state.sync;
  const parent = new Map(state.parentHeads.filter(p => refs.has(key(p))).map(p => [key(p), p])), bindings = knownBindings(state);
  for (const page of detached) {
    for (const row of page.records) {
      if (row.entityType === 'graphRelation' && row.data) {
        const before = bindings.get(row.entityId), after = graphRelationBinding(row.data);
        if (before && canonicalJson(before) !== canonicalJson(after)) return fail();
        bindings.set(row.entityId, after);
      } else if ((row.entityType === 'paper' || row.entityType === 'note') && refs.has(key(row))) {
        const before = parent.get(key(row));
        if (before && row.revision === before.revision && (row.deletedAt !== null) !== before.deleted) return fail();
        if (!before || row.revision > before.revision) parent.set(key(row), { entityType: row.entityType, entityId: row.entityId, revision: row.revision, deleted: row.deletedAt !== null });
      }
    }
    sync = applyPullPage(sync, getSyncContext(sync), { fromCursor: sync.cursor, response: { ...page, records: page.records.filter(r => r.entityType === 'graphRelation') } });
  }
  return nextState(state, { sync, parentHeads: [...parent.values()], checkedAt: observedAt });
}
export function acceptDesktopGraphRecords(input: DesktopGraphExchangeState, selection: readonly string[]): DesktopGraphExchangeState {
  const state = readDesktopGraphExchangeState(input, input.scope);
  canonicalJson(selection);
  if (!Array.isArray(selection) || selection.length > DESKTOP_GRAPH_LIMITS.selected || selection.some(v => !id(v))) return fail();
  unique([...selection]);
  if (!selection.length) return state;
  const accepted = new Map(state.accepted.map(r => [r.entityId, r]));
  for (const entityId of selection) {
    const head = state.sync.serverRecords['graphRelation:' + entityId], visible = getVisibleEntity(state.sync, 'graphRelation', entityId);
    if (!head || head.entityType !== 'graphRelation') return fail();
    if (visible?.pending || Object.values(state.sync.conflicts).some(c => c.attempted.entityId === entityId)) return fail('GRAPH_PENDING');
    accepted.set(entityId, head);
  }
  return nextState(state, { accepted: [...accepted.values()] });
}
export function projectAcceptedDesktopGraphRecords(input: DesktopGraphExchangeState, mapping: DesktopGraphMapping): DesktopGraphIncoming[] {
  const state = readDesktopGraphExchangeState(input, input.scope);
  assertDesktopGraphMapping(mapping, state.scope);
  const deleted = new Set(state.parentHeads.filter(p => p.deleted).map(key));
  return state.accepted.map(row => {
    if (row.data) {
      const missing = [row.data.source, row.data.target].filter(ref => deleted.has(key(ref)));
      if (missing.length) return { kind: 'unmapped', entityId: row.entityId, revision: row.revision, missing: missing.map(ref => ({ ...ref })) };
    }
    return graphWireToDesktop(row, mapping, state.scope);
  });
}
/** Preserve the exact resolution request before the first HTTP attempt. Repeated decisions reuse it. */
export function stageDesktopGraphResolution(input: DesktopGraphExchangeState, decision: DesktopGraphResolutionDecision, opIdFactory: () => string): DesktopGraphExchangeState {
  const state = readDesktopGraphExchangeState(input, input.scope);
  canonicalJson(decision);
  const { conflictId, consumedOverlayOpId = null, ...choice } = decision;
  const pending = state.pendingResolutions.find(r => r.conflictId === conflictId);
  const terminal = pending?.lastResult && (pending.lastResult.status === 'conflict' || pending.lastResult.status === 'rejected' && !pending.lastResult.retryable);
  if (pending && !terminal) {
    const { opId: _, ...previous } = pending.request;
    if (canonicalJson(previous) !== canonicalJson(choice) || pending.consumedOverlayOpId !== consumedOverlayOpId) return fail('GRAPH_PENDING');
    return state;
  }
  const conflict = state.sync.conflicts[conflictId];
  if (!conflict) return fail();
  const mirror = state.sync.serverRecords['graphRelation:' + conflict.attempted.entityId];
  const head = !mirror || conflict.current && conflict.current.revision > mirror.revision ? conflict.current : mirror;
  if (choice.expectedRevision !== (head?.revision ?? 0)) return fail('GRAPH_MAPPING_CHANGED');
  if (choice.choice === 'attempted' && conflict.attempted.entityType === 'graphRelation' && conflict.attempted.data) {
    const binding = knownBindings(state).get(conflict.attempted.entityId);
    if (binding && canonicalJson(binding) !== canonicalJson(graphRelationBinding(conflict.attempted.data))) return fail('INVALID_DESKTOP_GRAPH_RELATION');
  }
  if (consumedOverlayOpId !== null && state.sync.overlays['graphRelation:' + conflict.attempted.entityId]?.opId !== consumedOverlayOpId) return fail('GRAPH_MAPPING_CHANGED');
  const resolution = readDesktopGraphResolution({ conflictId, request: { ...choice, opId: opIdFactory() }, consumedOverlayOpId, lastResult: null });
  if (pending?.request.opId === resolution.request.opId) return fail();
  return nextState(state, { pendingResolutions: [...state.pendingResolutions.filter(r => r.conflictId !== conflictId), resolution] });
}
/** Only an applied receipt for the retained opId may clear the durable request. */
export function acknowledgeDesktopGraphResolution(input: DesktopGraphExchangeState, conflictId: string, response: PushResult): DesktopGraphExchangeState {
  const state = readDesktopGraphExchangeState(input, input.scope), pending = state.pendingResolutions.find(r => r.conflictId === conflictId);
  canonicalJson(response);
  const checked = validatePushResult(response);
  if (!pending || !checked.ok || response.opId !== pending.request.opId || response.status === 'conflict' && response.conflictId !== conflictId) return fail();
  const terminal = pending.lastResult && (pending.lastResult.status === 'conflict' || pending.lastResult.status === 'rejected' && !pending.lastResult.retryable);
  if (terminal && canonicalJson(pending.lastResult) !== canonicalJson(response)) return fail();
  const conflict = state.sync.conflicts[conflictId], record = response.record ?? null;
  if (record && (record.entityType !== 'graphRelation' || record.entityId !== conflict.attempted.entityId)) return fail();
  if (response.status !== 'applied') {
    let sync = state.sync;
    if (record) {
      sync = applyPullPage(sync, getSyncContext(sync), { fromCursor: sync.cursor, response: { protocolVersion: 1, records: [record], nextCursor: sync.cursor, hasMore: false } });
      const current = sync.serverRecords['graphRelation:' + conflict.attempted.entityId];
      sync.conflicts[conflictId] = { ...sync.conflicts[conflictId], current };
    }
    return nextState(state, { sync, pendingResolutions: state.pendingResolutions.map(r => r.conflictId === conflictId ? { ...r, lastResult: response } : r) });
  }
  // Selecting an existing head cannot legitimately acknowledge a missing record.
  if (!record && (pending.request.choice !== 'current' || pending.request.expectedRevision !== 0)) return fail();
  if (record && record.revision < pending.request.expectedRevision) return fail();
  const sync = applyConflictResolution(state.sync, getSyncContext(state.sync), { conflictId, record, ...(pending.consumedOverlayOpId === null ? {} : { consumedOverlayOpId: pending.consumedOverlayOpId }) });
  return nextState(state, { sync, pendingResolutions: state.pendingResolutions.filter(r => r.conflictId !== conflictId) });
}
