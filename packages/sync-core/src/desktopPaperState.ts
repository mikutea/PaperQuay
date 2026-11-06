import type { AccountSyncState, PaperData, PaperOrganization, PullResponse, PushResult, SyncRecord } from './types.ts';
import { canonicalJson, isPlainObject, validateEntityData, validatePullResponse, validateRecord, validatePushResult } from './validation.ts';
import { UUID_PATTERN } from './schema.ts';
import { createAccountState, validateClientState, applyPullPage, getSyncContext, getVisibleEntity, queueLocalEdit, applyConflictResolution } from './state.ts';
import { isDesktopLocalId } from './desktopProjection.ts';
import { isPaperOrganizationHydration, projectLegacyPaper } from './features.ts';

export const DESKTOP_PAPER_LIMITS = Object.freeze({ privateBytes: 16 * 1024 * 1024, papers: 1000, selected: 16, pullPages: 4096, adoptions: 500 });
export interface DesktopPaperScope { serviceKey: string; accountId: string; libraryBindingId: string }
export interface DesktopPaperBinding { localPaperId: string; entityId: string }
/** These fields have no equivalent in the original desktop category tree or
 * precise reading position. They remain explicit, account-scoped choices. */
export type DesktopPaperOrganizationChoice = Pick<PaperOrganization, 'readingStatus' | 'queueRank' | 'collections'>;
export interface DesktopPaperOrganizationDraft extends DesktopPaperBinding { value: DesktopPaperOrganizationChoice }
export interface DesktopPaperMetadata {
  title: string; year: string | null; publication: string | null; doi: string | null; abstractText: string | null;
  keywords: string[]; isFavorite: boolean; updatedAt: number;
  authors: { id: string; name: string; givenName: string | null; familyName: string | null; sortOrder: number }[];
  tags: { id: string; name: string; color: string | null; sortOrder: number }[];
}
export interface DesktopPaperAdoption extends DesktopPaperBinding {
  adoptionId: string; record: SyncRecord<'paper'>; before: DesktopPaperMetadata; after: DesktopPaperMetadata;
  beforeOrganization: DesktopPaperOrganizationChoice | null; afterOrganization: DesktopPaperOrganizationChoice | null;
  phase: 'pending' | 'applied' | 'restoring' | 'restored'; createdAt: string;
}
export interface DesktopPaperResolution {
  conflictId: string; request: { opId: string; expectedRevision: number; choice: 'current' | 'attempted' };
  consumedOverlayOpId: string | null; lastResult: PushResult | null;
}
export interface DesktopPaperExchangeState {
  formatVersion: 1; scope: DesktopPaperScope; revision: number; organizationEnabled: boolean;
  sync: AccountSyncState; bindings: DesktopPaperBinding[]; organizations: DesktopPaperOrganizationDraft[];
  accepted: SyncRecord<'paper'>[]; adoptions: DesktopPaperAdoption[]; pendingResolutions: DesktopPaperResolution[]; checkedAt: string | null;
}
export class DesktopPaperError extends Error {
  readonly code: string;
  constructor(code = 'PAPER_STATE_INVALID') { super(code); this.code = code; this.name = 'DesktopPaperError'; }
}
const fail = (code = 'PAPER_STATE_INVALID'): never => { throw new DesktopPaperError(code); };
const id = (value: unknown): value is string => typeof value === 'string' && new RegExp(UUID_PATTERN).test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => isPlainObject(value)
  && Reflect.ownKeys(value).length === keys.length && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 131072;
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const organizationKey = (row: DesktopPaperBinding): string => JSON.stringify([row.localPaperId, row.entityId]);
function stamp(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24) return fail();
  try { if (new Date(value).toISOString() !== value) return fail(); } catch { return fail(); } return value;
}
export function validateDesktopPaperScope(value: unknown): DesktopPaperScope {
  canonicalJson(value);
  if (!exact(value, ['serviceKey', 'accountId', 'libraryBindingId']) || typeof value.serviceKey !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.serviceKey) || !id(value.accountId) || !id(value.libraryBindingId)) return fail('PAPER_SCOPE_CHANGED');
  return { serviceKey: value.serviceKey, accountId: value.accountId, libraryBindingId: value.libraryBindingId };
}
export function readDesktopPaperMetadata(value: unknown): DesktopPaperMetadata {
  canonicalJson(value);
  if (!exact(value, ['title', 'year', 'publication', 'doi', 'abstractText', 'keywords', 'isFavorite', 'updatedAt', 'authors', 'tags'])
    || !text(value.title) || !['year', 'publication', 'doi', 'abstractText'].every(key => nullableText(value[key]))
    || typeof value.isFavorite !== 'boolean' || !integer(value.updatedAt) || !Array.isArray(value.keywords) || value.keywords.length > 1000
    || value.keywords.some(row => !text(row)) || !Array.isArray(value.authors) || value.authors.length > 1000 || !Array.isArray(value.tags) || value.tags.length > 1000) return fail('PAPER_SOURCE_UNSUPPORTED');
  for (const row of value.authors) if (!exact(row, ['id', 'name', 'givenName', 'familyName', 'sortOrder']) || !text(row.id) || !text(row.name)
    || !nullableText(row.givenName) || !nullableText(row.familyName) || !integer(row.sortOrder)) return fail('PAPER_SOURCE_UNSUPPORTED');
  for (const row of value.tags) if (!exact(row, ['id', 'name', 'color', 'sortOrder']) || !text(row.id) || !text(row.name)
    || !nullableText(row.color) || !integer(row.sortOrder)) return fail('PAPER_SOURCE_UNSUPPORTED');
  if (new TextEncoder().encode(canonicalJson(value)).length > 1024 * 1024) return fail('PAPER_SOURCE_UNSUPPORTED');
  return structuredClone(value) as unknown as DesktopPaperMetadata;
}
/** Whitelist-only capture: no paths, attachments, settings or category IDs. */
export function captureDesktopPaperMetadata(raw: unknown): DesktopPaperMetadata {
  if (!isPlainObject(raw)) return fail('PAPER_SOURCE_UNSUPPORTED');
  const read = (key: string) => { const descriptor = Object.getOwnPropertyDescriptor(raw, key); if (!descriptor || !('value' in descriptor)) return fail('PAPER_SOURCE_UNSUPPORTED'); return descriptor.value; };
  return readDesktopPaperMetadata({ title: read('title'), year: read('year'), publication: read('publication'), doi: read('doi'), abstractText: read('abstractText'),
    keywords: read('keywords'), isFavorite: read('isFavorite'), updatedAt: read('updatedAt'), authors: read('authors'), tags: read('tags') });
}
export function readDesktopPaperOrganizationChoice(value: unknown): DesktopPaperOrganizationChoice {
  canonicalJson(value);
  if (!exact(value, ['readingStatus', 'queueRank', 'collections'])) return fail('PAPER_ORGANIZATION_INVALID');
  const checked = validateEntityData('paper', { title: 'Validation', doi: null, year: null, publication: null, abstractText: null, authors: [], keywords: [],
    organization: { favorite: false, tags: [], ...value } });
  if (!checked.ok || !checked.value.organization) return fail('PAPER_ORGANIZATION_INVALID');
  return { readingStatus: checked.value.organization.readingStatus, queueRank: checked.value.organization.queueRank, collections: [...checked.value.organization.collections] };
}
function bindings(value: unknown): DesktopPaperBinding[] {
  if (!Array.isArray(value) || value.length > DESKTOP_PAPER_LIMITS.papers) return fail('PAPER_STATE_FULL');
  const locals = new Set<string>(), ids = new Set<string>();
  return value.map(row => {
    if (!exact(row, ['localPaperId', 'entityId']) || !isDesktopLocalId(row.localPaperId) || !id(row.entityId)
      || locals.has(row.localPaperId) || ids.has(row.entityId)) return fail('PAPER_BINDING_CONFLICT');
    locals.add(row.localPaperId); ids.add(row.entityId); return { localPaperId: row.localPaperId, entityId: row.entityId };
  });
}
function resolution(value: unknown, sync: AccountSyncState): DesktopPaperResolution {
  if (!exact(value, ['conflictId', 'request', 'consumedOverlayOpId', 'lastResult']) || !id(value.conflictId)
    || !sync.conflicts[value.conflictId] || value.consumedOverlayOpId !== null && !id(value.consumedOverlayOpId)) return fail();
  const request = value.request;
  if (!exact(request, ['opId', 'expectedRevision', 'choice']) || !id(request.opId) || !integer(request.expectedRevision)
    || !['current', 'attempted'].includes(String(request.choice))) return fail();
  const result = value.lastResult === null ? null : validatePushResult(value.lastResult);
  if (result && (!result.ok || result.value.opId !== request.opId || result.value.status === 'applied'
    || result.value.status === 'conflict' && result.value.conflictId !== value.conflictId)) return fail();
  if (result?.ok && result.value.record && (result.value.record.entityType !== 'paper'
    || result.value.record.entityId !== sync.conflicts[value.conflictId].attempted.entityId)) return fail();
  return { conflictId: value.conflictId, request: { opId: request.opId, expectedRevision: request.expectedRevision, choice: request.choice as 'current' | 'attempted' },
    consumedOverlayOpId: value.consumedOverlayOpId as string | null, lastResult: result?.ok ? structuredClone(result.value) : null };
}
export function readDesktopPaperState(input: unknown, expected: DesktopPaperScope): DesktopPaperExchangeState {
  try {
    if (new TextEncoder().encode(canonicalJson(input)).length > DESKTOP_PAPER_LIMITS.privateBytes) return fail('PAPER_STATE_FULL');
    if (!exact(input, ['formatVersion', 'scope', 'revision', 'organizationEnabled', 'sync', 'bindings', 'organizations', 'accepted', 'adoptions', 'pendingResolutions', 'checkedAt'])
      || input.formatVersion !== 1 || !integer(input.revision, 1) || typeof input.organizationEnabled !== 'boolean') return fail();
    const scope = validateDesktopPaperScope(input.scope);
    if (canonicalJson(scope) !== canonicalJson(validateDesktopPaperScope(expected))) return fail('PAPER_SCOPE_CHANGED');
    const client = validateClientState(input.sync); if (!client.ok || client.value.accountId !== scope.accountId) return fail(); const sync = client.value;
    if (Object.values(sync.serverRecords).some(row => row.entityType !== 'paper') || sync.outbox.some(row => row.operation.entityType !== 'paper')
      || Object.values(sync.overlays).some(row => row.entityType !== 'paper') || Object.values(sync.conflicts).some(row => row.attempted.entityType !== 'paper')
      || Object.keys(sync.serverRecords).length > DESKTOP_PAPER_LIMITS.papers) return fail();
    const currentBindings = bindings(input.bindings);
    if (!Array.isArray(input.organizations) || input.organizations.length > DESKTOP_PAPER_LIMITS.papers) return fail('PAPER_STATE_FULL');
    const organizations = input.organizations.map(row => {
      if (!exact(row, ['localPaperId', 'entityId', 'value']) || !isDesktopLocalId(row.localPaperId) || !id(row.entityId)) return fail();
      return { localPaperId: row.localPaperId, entityId: row.entityId, value: readDesktopPaperOrganizationChoice(row.value) };
    });
    if (new Set(organizations.map(organizationKey)).size !== organizations.length) return fail();
    if (!Array.isArray(input.accepted) || input.accepted.length > DESKTOP_PAPER_LIMITS.papers || !Array.isArray(input.adoptions)
      || input.adoptions.length > DESKTOP_PAPER_LIMITS.adoptions || !Array.isArray(input.pendingResolutions)
      || input.pendingResolutions.length > DESKTOP_PAPER_LIMITS.papers) return fail('PAPER_STATE_FULL');
    const accepted = input.accepted.map(value => {
      const checked = validateRecord(value); if (!checked.ok || checked.value.entityType !== 'paper') return fail();
      const head = sync.serverRecords['paper:' + checked.value.entityId];
      if (!head || checked.value.revision > head.revision || checked.value.revision === head.revision && canonicalJson(checked.value) !== canonicalJson(head)
        && !isPaperOrganizationHydration(checked.value, head)) return fail();
      return structuredClone(checked.value) as SyncRecord<'paper'>;
    });
    if (new Set(accepted.map(row => row.entityId)).size !== accepted.length) return fail();
    const adoptions = input.adoptions.map(value => {
      if (!exact(value, ['adoptionId', 'entityId', 'localPaperId', 'record', 'before', 'after', 'beforeOrganization', 'afterOrganization', 'phase', 'createdAt'])
        || !id(value.adoptionId) || !id(value.entityId) || !isDesktopLocalId(value.localPaperId) || !['pending', 'applied', 'restoring', 'restored'].includes(String(value.phase))) return fail();
      const checked = validateRecord(value.record);
      if (!checked.ok || checked.value.entityType !== 'paper' || checked.value.entityId !== value.entityId || checked.value.deletedAt !== null || !checked.value.data) return fail();
      const head = sync.serverRecords['paper:' + value.entityId];
      if (!head || checked.value.revision > head.revision || checked.value.revision === head.revision && canonicalJson(checked.value) !== canonicalJson(head)
        && !isPaperOrganizationHydration(checked.value, head)) return fail();
      return { adoptionId: value.adoptionId, entityId: value.entityId, localPaperId: value.localPaperId, record: structuredClone(checked.value) as SyncRecord<'paper'>,
        before: readDesktopPaperMetadata(value.before), after: readDesktopPaperMetadata(value.after), phase: value.phase as DesktopPaperAdoption['phase'], createdAt: stamp(value.createdAt),
        beforeOrganization: value.beforeOrganization === null ? null : readDesktopPaperOrganizationChoice(value.beforeOrganization),
        afterOrganization: value.afterOrganization === null ? null : readDesktopPaperOrganizationChoice(value.afterOrganization) };
    });
    const active = adoptions.filter(row => row.phase === 'pending' || row.phase === 'restoring');
    if (new Set(adoptions.map(row => row.adoptionId)).size !== adoptions.length || active.length > DESKTOP_PAPER_LIMITS.selected
      || new Set(active.map(row => row.localPaperId)).size !== active.length) return fail();
    const pendingResolutions = input.pendingResolutions.map(value => resolution(value, sync));
    const operationIds = new Set([...sync.outbox.map(row => row.operation.opId), ...Object.values(sync.overlays).map(row => row.opId), ...Object.values(sync.conflicts).map(row => row.attempted.opId)]);
    if (new Set(pendingResolutions.map(row => row.conflictId)).size !== pendingResolutions.length
      || new Set(pendingResolutions.map(row => row.request.opId)).size !== pendingResolutions.length || pendingResolutions.some(row => operationIds.has(row.request.opId))) return fail();
    return { formatVersion: 1, scope, revision: input.revision, organizationEnabled: input.organizationEnabled, sync: structuredClone(sync), bindings: currentBindings,
      organizations, accepted, adoptions, pendingResolutions, checkedAt: input.checkedAt === null ? null : stamp(input.checkedAt) };
  } catch (error) { if (error instanceof DesktopPaperError) throw error; return fail(); }
}
export function createDesktopPaperState(owner: DesktopPaperScope, deviceId: string): DesktopPaperExchangeState {
  const scope = validateDesktopPaperScope(owner);
  return readDesktopPaperState({ formatVersion: 1, scope, revision: 1, organizationEnabled: false, sync: createAccountState(scope.accountId, deviceId),
    bindings: [], organizations: [], accepted: [], adoptions: [], pendingResolutions: [], checkedAt: null }, scope);
}
function next(input: DesktopPaperExchangeState, patch: Partial<DesktopPaperExchangeState>): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope); if (state.revision === Number.MAX_SAFE_INTEGER) return fail('PAPER_STATE_FULL');
  return readDesktopPaperState({ ...state, ...patch, revision: state.revision + 1 }, state.scope);
}
export function withDesktopPaperSync(state: DesktopPaperExchangeState, sync: AccountSyncState): DesktopPaperExchangeState { return next(state, { sync }); }
export function withDesktopPaperFeatures(input: DesktopPaperExchangeState, organizationEnabled: boolean): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope); if (typeof organizationEnabled !== 'boolean') return fail();
  return state.organizationEnabled === organizationEnabled ? state : next(state, { organizationEnabled, sync: { ...state.sync, cursor: null }, checkedAt: null });
}
export function withDesktopPaperBindings(input: DesktopPaperExchangeState, rows: readonly DesktopPaperBinding[]): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope), checked = bindings(rows);
  const pending = new Set([...state.sync.outbox.map(row => row.operation.entityId), ...Object.values(state.sync.overlays).map(row => row.entityId),
    ...state.adoptions.filter(row => row.phase === 'pending' || row.phase === 'restoring').map(row => row.entityId),
    ...state.pendingResolutions.map(row => state.sync.conflicts[row.conflictId].attempted.entityId)]);
  for (const entityId of pending) {
    const before = state.bindings.find(row => row.entityId === entityId), after = checked.find(row => row.entityId === entityId);
    if (before && canonicalJson(before) !== canonicalJson(after ?? null)) return fail('PAPER_BINDING_CHANGED');
  }
  return canonicalJson(checked) === canonicalJson(state.bindings) ? state : next(state, { bindings: checked });
}
export function stageDesktopPaperPull(input: DesktopPaperExchangeState, pages: readonly PullResponse[], observedAt: string): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope); stamp(observedAt); canonicalJson(pages);
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > DESKTOP_PAPER_LIMITS.pullPages) return fail('PAPER_LIMIT');
  if (new TextEncoder().encode(canonicalJson(pages)).length > DESKTOP_PAPER_LIMITS.privateBytes) return fail('PAPER_STATE_FULL');
  let sync = state.sync;
  for (let i = 0; i < pages.length; i++) {
    const valid = validatePullResponse(pages[i]);
    if (!valid.ok || valid.value.hasMore !== (i < pages.length - 1) || valid.value.hasMore && valid.value.nextCursor === sync.cursor) return fail();
    const records = valid.value.records.filter(row => row.entityType === 'paper').filter(row => {
      const previous = sync.serverRecords['paper:' + row.entityId];
      if (previous?.data && 'organization' in previous.data && row.data && !('organization' in row.data) && row.revision >= previous.revision) {
        if (canonicalJson(projectLegacyPaper(previous)) === canonicalJson(row)) return false;
        return fail('PAPER_ORGANIZATION_UNAVAILABLE');
      }
      return true;
    });
    sync = applyPullPage(sync, getSyncContext(sync), { fromCursor: sync.cursor, response: { ...valid.value, records } });
  }
  return next(state, { sync, checkedAt: observedAt });
}
function available(state: DesktopPaperExchangeState, entityId: string): SyncRecord<'paper'> {
  if (!id(entityId)) return fail('PAPER_SELECTION_INVALID');
  const head = state.sync.serverRecords['paper:' + entityId];
  if (!head || head.entityType !== 'paper' || head.deletedAt !== null || !head.data) return fail('PAPER_REMOTE_UNAVAILABLE');
  if (!state.bindings.some(row => row.entityId === entityId)) return fail('PAPER_BINDING_REQUIRED');
  if (getVisibleEntity(state.sync, 'paper', entityId)?.pending || Object.values(state.sync.conflicts).some(row => row.attempted.entityId === entityId)) return fail('PAPER_PENDING');
  if (state.adoptions.some(row => row.entityId === entityId && (row.phase === 'pending' || row.phase === 'restoring'))) return fail('PAPER_ADOPTION_UNCONFIRMED');
  return structuredClone(head) as SyncRecord<'paper'>;
}
export function updateDesktopPaperOrganization(input: DesktopPaperExchangeState, localPaperId: string, value: DesktopPaperOrganizationChoice): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope), binding = state.bindings.find(row => row.localPaperId === localPaperId);
  if (!state.organizationEnabled) return fail('PAPER_ORGANIZATION_UNAVAILABLE'); if (!binding) return fail('PAPER_BINDING_REQUIRED');
  available(state, binding.entityId); const choice = readDesktopPaperOrganizationChoice(value);
  return next(state, { organizations: [...state.organizations.filter(row => organizationKey(row) !== organizationKey(binding)), { ...binding, value: choice }] });
}
export function stageDesktopPaperPublication(input: DesktopPaperExchangeState, rows: readonly (DesktopPaperBinding & { data: PaperData })[], allocate: () => string, createdAt: string): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope); stamp(createdAt); canonicalJson(rows);
  if (!Array.isArray(rows) || !rows.length || rows.length > DESKTOP_PAPER_LIMITS.selected) return fail('PAPER_SELECTION_INVALID');
  const seen = new Set<string>(); let sync = state.sync;
  for (const row of rows) {
    if (!state.bindings.some(binding => binding.localPaperId === row.localPaperId && binding.entityId === row.entityId)) return fail('PAPER_BINDING_REQUIRED');
    if (seen.has(row.entityId)) return fail('PAPER_SELECTION_INVALID'); seen.add(row.entityId); const head = available(state, row.entityId);
    const data = validateEntityData('paper', row.data); if (!data.ok) return fail('PAPER_SOURCE_UNSUPPORTED');
    if (row.data.organization && !state.organizationEnabled || head.data?.organization && !row.data.organization) return fail('PAPER_ORGANIZATION_UNAVAILABLE');
    if (canonicalJson(head.data) !== canonicalJson(data.value)) sync = queueLocalEdit(sync, { entityType: 'paper', entityId: row.entityId, mutation: 'put', data: data.value }, { opId: allocate(), clientCreatedAt: createdAt });
  }
  return next(state, { sync });
}
/** Save complete old/new whitelists before a local SQLite transaction. No
 * remote tombstone may delete a local paper or its attachment. */
export function stageDesktopPaperAdoptions(input: DesktopPaperExchangeState, rows: readonly DesktopPaperAdoption[]): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope); canonicalJson(rows);
  if (!Array.isArray(rows) || !rows.length || rows.length > DESKTOP_PAPER_LIMITS.selected) return fail('PAPER_SELECTION_INVALID');
  if (state.adoptions.some(row => row.phase === 'pending' || row.phase === 'restoring')) return fail('PAPER_ADOPTION_UNCONFIRMED');
  const seen = new Set<string>();
  for (const row of rows) {
    const head = available(state, row.entityId);
    if (seen.has(row.entityId) || row.phase !== 'pending' || canonicalJson(row.record) !== canonicalJson(head)
      || !state.bindings.some(binding => binding.localPaperId === row.localPaperId && binding.entityId === row.entityId)) return fail('PAPER_PREVIEW_STALE');
    if (head.data?.organization && !state.organizationEnabled) return fail('PAPER_ORGANIZATION_UNAVAILABLE');
    const data = head.data!;
    if (canonicalJson({ title: row.after.title, year: row.after.year, publication: row.after.publication, doi: row.after.doi, abstractText: row.after.abstractText,
      keywords: row.after.keywords, authors: row.after.authors.map((author: DesktopPaperMetadata['authors'][number]) => author.name) }) !== canonicalJson({ title: data.title, year: data.year,
      publication: data.publication, doi: data.doi, abstractText: data.abstractText, keywords: data.keywords, authors: data.authors })) return fail('PAPER_PREVIEW_STALE');
    const previous = state.organizations.find(value => value.localPaperId === row.localPaperId && value.entityId === row.entityId)?.value || null;
    if (canonicalJson(previous) !== canonicalJson(row.beforeOrganization)) return fail('PAPER_PREVIEW_STALE');
    if (data.organization && (row.after.isFavorite !== data.organization.favorite || canonicalJson(row.after.tags.map((tag: DesktopPaperMetadata['tags'][number]) => tag.name)) !== canonicalJson(data.organization.tags)
      || canonicalJson(row.afterOrganization) !== canonicalJson({ readingStatus: data.organization.readingStatus, queueRank: data.organization.queueRank, collections: data.organization.collections }))) return fail('PAPER_PREVIEW_STALE');
    if (!data.organization && (row.after.isFavorite !== row.before.isFavorite || canonicalJson(row.after.tags) !== canonicalJson(row.before.tags)
      || canonicalJson(row.afterOrganization) !== canonicalJson(row.beforeOrganization))) return fail('PAPER_PREVIEW_STALE');
    seen.add(row.entityId);
  }
  return next(state, { adoptions: [...state.adoptions, ...structuredClone(rows)] });
}
export function completeDesktopPaperAdoptions(input: DesktopPaperExchangeState, adoptionIds: readonly string[]): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope); canonicalJson(adoptionIds);
  if (!Array.isArray(adoptionIds) || adoptionIds.length > DESKTOP_PAPER_LIMITS.selected || adoptionIds.some(value => !id(value)) || new Set(adoptionIds).size !== adoptionIds.length) return fail('PAPER_SELECTION_INVALID');
  const accepted = new Map(state.accepted.map(row => [row.entityId, row])), organizations = new Map(state.organizations.map(row => [organizationKey(row), row]));
  for (const adoptionId of adoptionIds) {
    const row = state.adoptions.find(entry => entry.adoptionId === adoptionId); if (!row || row.phase !== 'pending') return fail('PAPER_ADOPTION_UNCONFIRMED');
    accepted.set(row.entityId, row.record);
    if (row.afterOrganization) organizations.set(organizationKey(row), { localPaperId: row.localPaperId, entityId: row.entityId, value: row.afterOrganization });
  }
  return next(state, { accepted: [...accepted.values()], organizations: [...organizations.values()], adoptions: state.adoptions.map(row => adoptionIds.includes(row.adoptionId) ? { ...row, phase: 'applied' } : row) });
}
export function stageDesktopPaperRestoration(input: DesktopPaperExchangeState, adoptionId: string): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope), entry = state.adoptions.find(row => row.adoptionId === adoptionId);
  if (!entry || !id(adoptionId)) return fail('PAPER_SELECTION_INVALID');
  if (entry.phase === 'restored' || entry.phase === 'restoring') return state;
  if (entry.phase !== 'applied' || state.adoptions.some(row => row.phase === 'pending' || row.phase === 'restoring')) return fail('PAPER_ADOPTION_UNCONFIRMED');
  if (!state.bindings.some(row => row.localPaperId === entry.localPaperId && row.entityId === entry.entityId)) return fail('PAPER_BINDING_CHANGED');
  if (getVisibleEntity(state.sync, 'paper', entry.entityId)?.pending || Object.values(state.sync.conflicts).some(row => row.attempted.entityId === entry.entityId)) return fail('PAPER_PENDING');
  const current = state.organizations.find(row => row.localPaperId === entry.localPaperId && row.entityId === entry.entityId)?.value || null;
  if (canonicalJson(current) !== canonicalJson(entry.afterOrganization)) return fail('PAPER_ORGANIZATION_CHANGED');
  return next(state, { adoptions: state.adoptions.map(row => row === entry ? { ...row, phase: 'restoring' } : row) });
}
/** A local undo preserves the received account record as historical evidence;
 * it neither invents a server revision nor queues an account mutation. */
export function completeDesktopPaperRestorations(input: DesktopPaperExchangeState, adoptionIds: readonly string[]): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope); canonicalJson(adoptionIds);
  if (!Array.isArray(adoptionIds) || adoptionIds.length > DESKTOP_PAPER_LIMITS.selected || adoptionIds.some(value => !id(value)) || new Set(adoptionIds).size !== adoptionIds.length) return fail('PAPER_SELECTION_INVALID');
  const organizations = new Map(state.organizations.map(row => [organizationKey(row), row]));
  for (const adoptionId of adoptionIds) {
    const row = state.adoptions.find(entry => entry.adoptionId === adoptionId); if (!row || row.phase !== 'restoring') return fail('PAPER_ADOPTION_UNCONFIRMED');
    const current = organizations.get(organizationKey(row));
    if (canonicalJson(current?.value || null) !== canonicalJson(row.afterOrganization)) return fail('PAPER_ORGANIZATION_CHANGED');
    if (row.beforeOrganization) organizations.set(organizationKey(row), { localPaperId: row.localPaperId, entityId: row.entityId, value: row.beforeOrganization });
    else organizations.delete(organizationKey(row));
  }
  return next(state, { organizations: [...organizations.values()], adoptions: state.adoptions.map(row => adoptionIds.includes(row.adoptionId) ? { ...row, phase: 'restored' } : row) });
}
export function stageDesktopPaperResolution(input: DesktopPaperExchangeState, conflictId: string, choice: 'current' | 'attempted', expectedRevision: number, opId: string): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope), conflict = state.sync.conflicts[conflictId];
  if (!conflict || !id(opId) || !['current', 'attempted'].includes(choice)) return fail('PAPER_CONFLICT_CHANGED');
  if (!state.bindings.some(row => row.entityId === conflict.attempted.entityId)) return fail('PAPER_BINDING_REQUIRED');
  if (state.adoptions.some(row => row.entityId === conflict.attempted.entityId && (row.phase === 'pending' || row.phase === 'restoring'))) return fail('PAPER_ADOPTION_UNCONFIRMED');
  const head = state.sync.serverRecords['paper:' + conflict.attempted.entityId], revision = Math.max(head?.revision ?? 0, conflict.current?.revision ?? 0);
  if (revision !== expectedRevision) return fail('PAPER_CONFLICT_CHANGED');
  const previous = state.pendingResolutions.find(row => row.conflictId === conflictId);
  if (previous && (!previous.lastResult || previous.lastResult.status === 'rejected' && previous.lastResult.retryable === true)) return fail('PAPER_PENDING');
  if (previous?.request.opId === opId) return fail('PAPER_CONFLICT_CHANGED');
  return next(state, { pendingResolutions: [...state.pendingResolutions.filter(row => row !== previous), { conflictId, request: { opId, choice, expectedRevision },
    consumedOverlayOpId: state.sync.overlays['paper:' + conflict.attempted.entityId]?.opId ?? null, lastResult: null }] });
}
export function applyDesktopPaperResolution(input: DesktopPaperExchangeState, conflictId: string, result: unknown): DesktopPaperExchangeState {
  const state = readDesktopPaperState(input, input.scope), pending = state.pendingResolutions.find(row => row.conflictId === conflictId), valid = validatePushResult(result);
  if (!pending || !valid.ok || valid.value.opId !== pending.request.opId) return fail();
  const row = valid.value, original = state.sync.conflicts[conflictId];
  if (!original || row.record && (row.record.entityType !== 'paper' || row.record.entityId !== original.attempted.entityId)) return fail();
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
    sync.conflicts[conflictId] = { ...original, current: sync.serverRecords['paper:' + original.attempted.entityId] };
  }
  return next(state, { sync, pendingResolutions: state.pendingResolutions.map(value => value === pending ? { ...value, lastResult: row } : value) });
}

