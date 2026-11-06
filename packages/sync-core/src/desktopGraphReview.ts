import { canonicalJson } from './validation.ts';
import { queueLocalEdit } from './state.ts';
import { UUID_PATTERN } from './schema.ts';
import { desktopGraphRelationToWire, graphWireToDesktop, assertDesktopGraphMapping, isDesktopGraphLocalId, DESKTOP_GRAPH_LIMITS, DesktopGraphError, type DesktopGraphMapping, type DesktopGraphIncoming } from './desktopGraph.ts';
import { readDesktopGraphExchangeState, withDesktopGraphSync, graphRelationBinding, type DesktopGraphExchangeState, type DesktopGraphResolution } from './desktopGraphState.ts';
import type { GraphRelationData, GraphEntityRef } from './graphRelation.ts';
import type { LocalConflict, SyncRecord } from './types.ts';

export type DesktopGraphSourceStatus = 'available' | 'missing' | 'invalid';
export type DesktopGraphReviewKind = 'create' | 'update' | 'restore' | 'delete' | 'same' | 'blocked';
export interface DesktopGraphReviewRow {
  rowId: string; localRelationId: string | null; entityId: string | null;
  kind: DesktopGraphReviewKind; reasonCode: string | null; data: GraphRelationData | null;
  /** The unmodified local draft, including unsupported fields, for review only. */
  raw: unknown; server: SyncRecord<'graphRelation'> | null; accepted: SyncRecord<'graphRelation'> | null;
}
export interface DesktopGraphIncomingReview {
  entityId: string; kind: 'new' | 'update' | 'delete' | 'same' | 'unmapped' | 'pending';
  record: SyncRecord<'graphRelation'>; accepted: SyncRecord<'graphRelation'> | null;
  projection: DesktopGraphIncoming; canAccept: boolean;
}
export interface DesktopGraphReview {
  stateRevision: number; mappingIdentity: string; sourceIdentity: string; sourceStatus: DesktopGraphSourceStatus;
  rows: DesktopGraphReviewRow[]; incoming: DesktopGraphIncomingReview[];
  conflicts: LocalConflict[]; pendingResolutions: DesktopGraphResolution[];
}
export interface DesktopGraphPublicationIdentity { entityId: string; opId: string; clientCreatedAt: string }
const reviews = new WeakMap<DesktopGraphReview, { stateIdentity: string; rows: DesktopGraphReviewRow[] }>();
const fail = (code: DesktopGraphError['code'] = 'GRAPH_STATE_INVALID'): never => { throw new DesktopGraphError(code); };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const refKey = (ref: GraphEntityRef) => ref.entityType + ':' + ref.entityId;

/** A local store is authoritative for absence only when it was read successfully.
 * Neither a missing file nor a corrupt file turns old links into deletion requests. */
export function prepareDesktopGraphReview(
  input: DesktopGraphExchangeState, rawRelations: readonly unknown[], mapping: DesktopGraphMapping,
  options: { sourceStatus?: DesktopGraphSourceStatus } = {},
): DesktopGraphReview {
  const state = readDesktopGraphExchangeState(input, input.scope);
  assertDesktopGraphMapping(mapping, state.scope);
  const sourceStatus = options.sourceStatus ?? 'available';
  if (!['available', 'missing', 'invalid'].includes(sourceStatus) || !Array.isArray(rawRelations)) return fail();
  if (rawRelations.length > DESKTOP_GRAPH_LIMITS.sourceRelations) return fail('GRAPH_LIMIT');
  let sourceIdentity: string;
  try {
    sourceIdentity = canonicalJson({ sourceStatus, relations: rawRelations });
    if (new TextEncoder().encode(sourceIdentity).length > DESKTOP_GRAPH_LIMITS.privateBytes) return fail('GRAPH_LIMIT');
  } catch (error) { if (error instanceof DesktopGraphError) throw error; return fail('INVALID_DESKTOP_GRAPH_RELATION'); }
  const source = sourceStatus === 'available' ? structuredClone(rawRelations) : [];
  const links = new Map(state.links.map(link => [link.localRelationId, link]));
  const accepted = new Map(state.accepted.map(record => [record.entityId, record]));
  const pending = new Set([
    ...state.sync.outbox.map(entry => entry.operation.entityId),
    ...Object.values(state.sync.overlays).map(edit => edit.entityId),
    ...Object.values(state.sync.conflicts).map(conflict => conflict.attempted.entityId),
  ]);
  const deletedParents = new Set(state.parentHeads.filter(parent => parent.deleted).map(refKey));
  const duplicateIds = new Map<string, number>();
  let unidentifiedSource = false;
  for (const raw of source) {
    const localId = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : null;
    if (isDesktopGraphLocalId(localId)) duplicateIds.set(localId, (duplicateIds.get(localId) ?? 0) + 1);
    else unidentifiedSource = true;
  }
  const rows: DesktopGraphReviewRow[] = [], present = new Set<string>();
  for (const [index, raw] of source.entries()) {
    const possibleId = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : null;
    const localRelationId = isDesktopGraphLocalId(possibleId) ? possibleId : null;
    if (localRelationId !== null) present.add(localRelationId);
    const link = localRelationId === null ? undefined : links.get(localRelationId);
    const server = link ? state.sync.serverRecords['graphRelation:' + link.entityId] as SyncRecord<'graphRelation'> | undefined : undefined;
    const row: DesktopGraphReviewRow = {
      rowId: 'local:' + index + ':' + (localRelationId ?? ''), localRelationId, entityId: link?.entityId ?? null,
      kind: 'blocked', reasonCode: null, data: null, raw, server: server ?? null, accepted: link ? accepted.get(link.entityId) ?? null : null,
    };
    rows.push(row);
    if (localRelationId !== null && (duplicateIds.get(localRelationId) ?? 0) > 1) { row.reasonCode = 'DUPLICATE_LOCAL_RELATION'; continue; }
    try { row.data = desktopGraphRelationToWire(raw, mapping, state.scope).data; }
    catch (error) { row.reasonCode = error instanceof DesktopGraphError ? error.code : 'INVALID_DESKTOP_GRAPH_RELATION'; continue; }
    if (link && pending.has(link.entityId)) { row.reasonCode = 'GRAPH_PENDING'; continue; }
    if (link && !same(graphRelationBinding(row.data), graphRelationBinding(link.lastLocalData))) { row.reasonCode = 'IMMUTABLE_GRAPH_BINDING_CHANGED'; continue; }
    if ([row.data.source, row.data.target].some(ref => deletedParents.has(refKey(ref)))) { row.reasonCode = 'DELETED_GRAPH_ENDPOINT'; continue; }
    if (!link) row.kind = 'create';
    else if (!server) row.reasonCode = 'GRAPH_HEAD_MISSING';
    else if (server.deletedAt !== null) row.kind = 'restore';
    else if (same(row.data, server.data)) row.kind = 'same';
    else if (same(row.data, link.lastLocalData)) row.reasonCode = 'REMOTE_GRAPH_CHANGED';
    else row.kind = 'update';
  }
  for (const link of state.links) {
    if (present.has(link.localRelationId)) continue;
    const server = state.sync.serverRecords['graphRelation:' + link.entityId] as SyncRecord<'graphRelation'> | undefined;
    let kind: DesktopGraphReviewKind = 'blocked', reasonCode: string | null = null;
    if (sourceStatus !== 'available') reasonCode = sourceStatus === 'missing' ? 'GRAPH_SOURCE_MISSING' : 'GRAPH_SOURCE_INVALID';
    else if (unidentifiedSource) reasonCode = 'GRAPH_SOURCE_INVALID';
    else if (pending.has(link.entityId)) reasonCode = 'GRAPH_PENDING';
    else if (!server) reasonCode = 'GRAPH_HEAD_MISSING';
    else kind = server.deletedAt !== null ? 'same' : 'delete';
    rows.push({ rowId: 'missing:' + link.localRelationId, localRelationId: link.localRelationId, entityId: link.entityId, kind, reasonCode, data: null, raw: null, server: server ?? null, accepted: accepted.get(link.entityId) ?? null });
  }
  const incoming: DesktopGraphIncomingReview[] = Object.values(state.sync.serverRecords).map(value => {
    const record = value as SyncRecord<'graphRelation'>, previous = accepted.get(record.entityId) ?? null;
    let projection = graphWireToDesktop(record, mapping, state.scope);
    if (record.data) {
      const missing = [...(projection.kind === 'unmapped' ? projection.missing : []), ...[record.data.source, record.data.target].filter(ref => deletedParents.has(refKey(ref)))];
      if (missing.length) projection = { kind: 'unmapped', entityId: record.entityId, revision: record.revision, missing: [...new Map(missing.map(ref => [refKey(ref), ref])).values()] };
    }
    const kind: DesktopGraphIncomingReview['kind'] = pending.has(record.entityId) ? 'pending'
      : projection.kind === 'unmapped' ? 'unmapped'
      : previous && same(record, previous) ? 'same'
      : record.deletedAt !== null ? 'delete' : previous ? 'update' : 'new';
    return { entityId: record.entityId, kind, record, accepted: previous, projection, canAccept: ['new', 'update', 'delete'].includes(kind) };
  });
  const review: DesktopGraphReview = {
    stateRevision: state.revision, mappingIdentity: mapping.identity, sourceIdentity, sourceStatus,
    rows, incoming, conflicts: Object.values(state.sync.conflicts), pendingResolutions: state.pendingResolutions,
  };
  // Keep the reviewed drafts private; UI serialization or caller edits cannot change a prepared intent.
  reviews.set(review, { stateIdentity: canonicalJson(state), rows: structuredClone(rows) });
  return review;
}

/** Materialize selected changes in one returned snapshot. Persist it before HTTP.
 * Retry existing work through the outbox; preparing a new review never replaces an opId. */
export function materializeDesktopGraphPublication(
  input: DesktopGraphExchangeState, review: DesktopGraphReview, selection: readonly string[],
  identityFactory: () => DesktopGraphPublicationIdentity,
): DesktopGraphExchangeState {
  const state = readDesktopGraphExchangeState(input, input.scope), prepared = reviews.get(review);
  if (!prepared || prepared.stateIdentity !== canonicalJson(state)) return fail('GRAPH_MAPPING_CHANGED');
  canonicalJson(selection);
  if (!Array.isArray(selection) || selection.length > DESKTOP_GRAPH_LIMITS.selected || selection.some(value => typeof value !== 'string') || new Set(selection).size !== selection.length) return fail();
  if (!selection.length) return state;
  const selected = selection.map(rowId => {
    const row = prepared.rows.find(candidate => candidate.rowId === rowId);
    if (!row || !['create', 'update', 'restore', 'delete'].includes(row.kind) || !row.localRelationId) return fail('GRAPH_PENDING');
    return row;
  });
  const knownEntities = new Set([
    ...Object.values(state.sync.serverRecords).map(record => record.entityId),
    ...state.sync.outbox.map(entry => entry.operation.entityId),
    ...state.links.map(link => link.entityId),
    ...Object.values(state.sync.conflicts).map(conflict => conflict.attempted.entityId),
  ]);
  let sync = state.sync;
  const links = new Map(state.links.map(link => [link.localRelationId, link]));
  for (const row of selected) {
    const identity = identityFactory(), entityId = row.entityId ?? identity.entityId;
    if (typeof entityId !== 'string' || !new RegExp(UUID_PATTERN).test(entityId) || row.kind === 'create' && knownEntities.has(entityId)) return fail();
    knownEntities.add(entityId);
    const mutation = row.kind === 'delete' ? 'delete' : row.kind === 'restore' ? 'restore' : 'put';
    sync = queueLocalEdit(sync, { entityType: 'graphRelation', entityId, mutation, data: mutation === 'delete' ? null : row.data }, { opId: identity.opId, clientCreatedAt: identity.clientCreatedAt });
    if (row.data) links.set(row.localRelationId!, { localRelationId: row.localRelationId!, entityId, lastLocalData: structuredClone(row.data) });
  }
  const next = withDesktopGraphSync(state, sync);
  return readDesktopGraphExchangeState({ ...next, links: [...links.values()] }, state.scope);
}
