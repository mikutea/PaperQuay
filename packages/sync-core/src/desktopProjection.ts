import {GRAPH_RELATION_LIMITS,validateGraphRelationData} from './graphRelation.ts';
import type { EntityDataMap, EntityType, ReadingPositionData, ValidationResult } from './types.ts';
import { SYNC_LIMITS, UUID_PATTERN } from './schema.ts';
import { isPlainObject, validateEntityData } from './validation.ts';
import { createRichNoteData, remapRichNoteReferences, richNoteUnresolvedId, parseRichNoteUnresolvedId, RICH_NOTE_LIMITS,
  type RichNoteData, type RichNoteAsset, type RichNoteUnresolvedReference } from './richNote.ts';

type IdentityKind = EntityType | 'attachment';
const IDENTITY_KINDS: readonly IdentityKind[] = ['paper', 'attachment', 'attachmentVersion', 'note', 'annotation', 'readingPosition','graphRelation'];
const uuid = (value: unknown): value is string => typeof value === 'string' && new RegExp(UUID_PATTERN).test(value);
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const localId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^(?:(?:standalone|file|https?):|[a-z]:)/i.test(value);
const dataObject = (value: unknown): value is Record<string, unknown> => isPlainObject(value) && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
const dataArray = (value: unknown): value is unknown[] => Array.isArray(value) && Object.keys(value).length === value.length && Object.keys(value).every((key) => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length) && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);

export interface DesktopIdentityMap {
  formatVersion: 1;
  accountId: string;
  /** Random binding ID stored in the trusted profile, never a supplied library path. */
  libraryBindingId: string;
  aliases: Record<string, string>;
}

export interface VerifiedDesktopAttachment {
  localPaperId: string;
  localAttachmentId: string;
  verification: 'sha256-complete';
  sha256: string;
  sizeBytes: number;
  pageCount: number | null;
}
/** Supplied by a scoped reader which has verified this exact source-to-bytes
 * binding. The pure projector never opens a path or fetches a source URL. */
export interface VerifiedDesktopRichNoteResource {
  proof: 'verified-note-image-bytes'; accountId: string; libraryBindingId: string;
  localNoteId: string; source: string; asset: RichNoteAsset;
}

/** Evidence produced at capture time, not inferred from today's path or file bytes. */
export interface DesktopHistoryVersionBinding {
  proof: 'captured-with-verified-version';
  accountId: string;
  libraryBindingId: string;
  localPaperId: string;
  localAttachmentId: string;
  sha256: string;
  sourceKey: string;
  sourceUpdatedAt: number;
  deviceId: string;
  sessionId: string;
  deviceSequence: number;
  furthestPageIndex: number;
  furthestOffsetRatio: number;
}

export type ProjectedEntity = {
  [K in EntityType]: { entityType: K; entityId: string; schemaVersion: 1; data: EntityDataMap[K] }
}[EntityType];

export interface DesktopProjectionSkip {
  entityType: EntityType | 'history';
  index: number;
  code: string;
}

export interface DesktopProjectionInput {
  accountId: string;
  libraryBindingId: string;
  identityMap: DesktopIdentityMap;
  papers: readonly unknown[];
  /** Explicit Markdown or desktop TipTap contentJson. Unsupported notes stay untouched. */
  notes?: readonly unknown[];
  /** Explicitly supplied saved custom/approved AI relations from the anchored library. */
  graphRelations?:readonly unknown[];
  richNoteResources?: readonly VerifiedDesktopRichNoteResource[];
  history?: Readonly<Record<string, unknown>>;
  verifiedAttachments?: readonly VerifiedDesktopAttachment[];
  historyBindings?: readonly DesktopHistoryVersionBinding[];
}

export interface DesktopProjectionResult {
  /** Persist this private mapping before sending entities; it is not a wire payload. */
  identityMap: DesktopIdentityMap;
  entities: ProjectedEntity[];
  skipped: DesktopProjectionSkip[];
}

export class DesktopProjectionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'DesktopProjectionError'; this.code = code; }
}
const fail = (code: string): never => { throw new DesktopProjectionError(code); };

export function validateDesktopIdentityMap(value: unknown): ValidationResult<DesktopIdentityMap> {
  const bad = (): ValidationResult<DesktopIdentityMap> => ({ ok: false, issues: [{ path: '$', code: 'INVALID_DESKTOP_IDENTITY_MAP' }] });
  if (!dataObject(value) || Object.keys(value).sort().join(',') !== 'accountId,aliases,formatVersion,libraryBindingId' || value.formatVersion !== 1 || !uuid(value.accountId) || !uuid(value.libraryBindingId) || !dataObject(value.aliases)) return bad();
  const entries = Object.entries(value.aliases);
  if (entries.length > SYNC_LIMITS.maxLocalEntities || new Set(entries.map(([, id]) => id)).size !== entries.length) return bad();
  try {
    for (const [key, id] of entries) {
      const parts = JSON.parse(key) as unknown;
      if (!uuid(id) || !Array.isArray(parts) || parts.length < 2 || parts.length > 5 || !IDENTITY_KINDS.includes(parts[0] as IdentityKind) || !parts.slice(1).every(localId) || JSON.stringify(parts) !== key) return bad();
    }
  } catch { return bad(); }
  return { ok: true, value: value as unknown as DesktopIdentityMap };
}

export function createDesktopIdentityMap(accountId: string, libraryBindingId: string): DesktopIdentityMap {
  if (!uuid(accountId) || !uuid(libraryBindingId)) return fail('INVALID_DESKTOP_SCOPE');
  return { formatVersion: 1, accountId, libraryBindingId, aliases: {} };
}

function assignIdentity(map: DesktopIdentityMap, kind: IdentityKind, parts: string[], allocateId: () => string): string {
  if (!IDENTITY_KINDS.includes(kind) || parts.length < 1 || parts.length > 4 || !parts.every(localId)) return fail('INVALID_LOCAL_ID');
  const key = JSON.stringify([kind, ...parts]);
  const existing = map.aliases[key];
  if (existing) return existing;
  if (Object.keys(map.aliases).length >= SYNC_LIMITS.maxLocalEntities) return fail('LOCAL_CAPACITY_EXCEEDED');
  const id = allocateId();
  if (!uuid(id) || Object.values(map.aliases).includes(id)) return fail('INVALID_ID_ALLOCATION');
  map.aliases[key] = id;
  return id;
}

export function ensureDesktopIdentity(map: DesktopIdentityMap, kind: IdentityKind, parts: string[], allocateId: () => string): { identityMap: DesktopIdentityMap; entityId: string } {
  if (!validateDesktopIdentityMap(map).ok) return fail('INVALID_DESKTOP_IDENTITY_MAP');
  const identityMap = structuredClone(map);
  return { identityMap, entityId: assignIdentity(identityMap, kind, parts, allocateId) };
}

const nullableText = (value: unknown): unknown => value == null || value === '' ? null : typeof value === 'string' ? value.trim() || null : undefined;
function stringList(value: unknown, field?: string): unknown {
  if (value === undefined || value === null) return [];
  if (!dataArray(value)) return null;
  return value.map((item) => typeof item === 'string' ? item.trim() : field && dataObject(item) && typeof item[field] === 'string' ? (item[field] as string).trim() : null);
}

function paperData(raw: Record<string, unknown>): unknown {
  const doi = nullableText(raw.doi);
  return {
    title: typeof raw.title === 'string' ? raw.title.trim() : null,
    doi: typeof doi === 'string' ? doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase() : doi,
    year: nullableText(raw.year), publication: nullableText(raw.publication), abstractText: nullableText(raw.abstractText),
    authors: stringList(raw.authors, 'name'), keywords: stringList(raw.keywords),
  };
}

function evidenceValid(value: unknown): value is VerifiedDesktopAttachment {
  return dataObject(value) && value.verification === 'sha256-complete' && localId(value.localPaperId) && localId(value.localAttachmentId) && sha256(value.sha256) && Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) > 0 && (value.pageCount === null || Number.isSafeInteger(value.pageCount) && (value.pageCount as number) > 0);
}

/** Bounded descriptor-only clone of saved desktop JSON. A raw document may
 * repeat the same data URI; the portable entity remains limited to 1 MiB after
 * image deduplication. This is not a promise to import unlimited legacy JSON. */
export function cloneDesktopRichSource(value: unknown, maximumCharacters = RICH_NOTE_LIMITS.entityBytes): unknown {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1 || maximumCharacters > 16 * 1024 * 1024) return fail('UNSUPPORTED_RICH_NOTE');
  let count = 0, characters = 0; const ancestors = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (++count > RICH_NOTE_LIMITS.nodes || depth > RICH_NOTE_LIMITS.depth) return fail('UNSUPPORTED_RICH_NOTE');
    if (typeof item === 'string') { if ((characters += item.length) > maximumCharacters) return fail('UNSUPPORTED_RICH_NOTE'); return item; }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) return fail('UNSUPPORTED_RICH_NOTE');
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype : !isPlainObject(item)) return fail('UNSUPPORTED_RICH_NOTE');
    if (array && item.length > RICH_NOTE_LIMITS.nodes) return fail('UNSUPPORTED_RICH_NOTE');
    ancestors.add(item); const output: Record<string, unknown> = {}, values: unknown[] = []; let entries = 0;
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) return fail('UNSUPPORTED_RICH_NOTE');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || key === '__proto__') return fail('UNSUPPORTED_RICH_NOTE');
      if ((characters += key.length) > maximumCharacters) return fail('UNSUPPORTED_RICH_NOTE');
      const child = copy(descriptor.value, depth + 1); if (array) values[Number(key)] = child; else output[key] = child; entries++;
    }
    if (array && entries !== item.length) return fail('UNSUPPORTED_RICH_NOTE');
    ancestors.delete(item); return array ? values : output;
  };
  return copy(value, 0);
}
const copyRichSource = cloneDesktopRichSource;
function projectRichSource(raw: Record<string, unknown>, paperId: string | null, papers: ReadonlyMap<string, string>,
  resources: ReadonlyMap<string, RichNoteAsset>): RichNoteData {
  const document = cloneDesktopRichSource(raw.contentJson, 16 * 1024 * 1024) as Record<string, unknown>;
  const descriptions = new Map<string, RichNoteUnresolvedReference>();
  const assets = new Map<string, RichNoteAsset>(), noteLinks = new Set<string>(), paperLinks = new Set<string>();
  const missing = (kind: RichNoteUnresolvedReference['kind'], id: string, label = '') => {
    const target = richNoteUnresolvedId(kind, id);
    if (!descriptions.has(`${kind}:${target}`)) descriptions.set(`${kind}:${target}`, { kind, id: target, label: label || id, reason: 'unmapped' });
    return target;
  };
  const paper = (id: unknown, label = ''): string => {
    if (typeof id !== 'string') return fail('UNSUPPORTED_RICH_NOTE');
    return papers.get(id.replace(/^native-library:/, '')) ?? missing('paper', id, label);
  };
  let labelOnly = 0;
  const walk = (node: unknown): void => {
    if (!dataObject(node)) return fail('UNSUPPORTED_RICH_NOTE');
    const attrs = node.attrs;
    if (node.type === 'image') {
      if (!dataObject(attrs) || typeof attrs.src !== 'string') return fail('UNSUPPORTED_RICH_NOTE');
      // These are the current desktop editor's self-contained/immutable sources.
      // A newly read file at an old path is not evidence of historical image bytes.
      if (!attrs.src.startsWith('blob:') && !attrs.src.startsWith('asset:sha256:') && !/^data:image\/(?:png|jpeg|webp);base64,/.test(attrs.src)) return fail('UNSUPPORTED_RICH_NOTE');
      const resource = resources.get(attrs.src);
      if (!resource) return fail('UNVERIFIED_RICH_NOTE_RESOURCE');
      if (attrs.src.startsWith('data:') && attrs.src !== `data:${resource.mediaType};base64,${resource.base64}`
        || attrs.src.startsWith('asset:') && attrs.src !== `asset:sha256:${resource.sha256}`) return fail('RICH_RESOURCE_EVIDENCE_MISMATCH');
      attrs.src = `asset:sha256:${resource.sha256}`; assets.set(resource.id, resource);
    }
    if (node.type === 'wikiLink' || node.type === 'paperReference') {
      if (!dataObject(attrs)) return fail('UNSUPPORTED_RICH_NOTE');
      const kind = node.type === 'wikiLink' ? 'note' : 'paper', key = kind === 'note' ? 'id' : 'paperId', original = attrs[key];
      if (typeof original === 'string') {
        const mapped = kind === 'note' ? missing('note', original, String(attrs.label || '')) : paper(original, String(attrs.label || ''));
        attrs[key] = mapped; (kind === 'note' ? noteLinks : paperLinks).add(mapped);
      } else if (typeof attrs.label === 'string' && attrs.label) {
        const id = `label-only:${kind}:${++labelOnly}`;
        descriptions.set(`${kind}:${id}`, { kind, id, label: attrs.label, reason: 'missing' });
      }
    }
    if (node.content !== undefined) { if (!dataArray(node.content)) return fail('UNSUPPORTED_RICH_NOTE'); for (const child of node.content) walk(child); }
  };
  walk(document);
  const list = (input: unknown) => { if (input === undefined) return []; if (!dataArray(input) || !input.every((id) => typeof id === 'string')) return fail('UNSUPPORTED_RICH_NOTE'); return input as string[]; };
  for (const id of list(raw.linkedNoteIds)) noteLinks.add(missing('note', id));
  for (const id of list(raw.linkedPaperIds)) paperLinks.add(paper(id));
  const metadata: Record<string, unknown> = { type: raw.type, anchors: [], tags: copyRichSource(raw.tags ?? []), color: raw.color ?? '#fef08a',
    isFavorite: raw.isFavorite ?? false, isPinned: raw.isPinned ?? false, linkedNoteIds: [...noteLinks], linkedPaperIds: [...paperLinks],
    createdAt: raw.createdAt, updatedAt: raw.updatedAt, unresolvedReferences: [] };
  const anchors = copyRichSource(raw.anchors ?? []); if (!dataArray(anchors)) return fail('UNSUPPORTED_RICH_NOTE');
  metadata.anchors = anchors.map((anchor) => {
    if (!dataObject(anchor) || anchor.verification !== undefined && anchor.verification !== 'unverified') return fail('UNSUPPORTED_RICH_NOTE');
    return { ...anchor, ...(anchor.paperId === undefined ? {} : { paperId: paper(anchor.paperId, typeof anchor.sourceTitle === 'string' ? anchor.sourceTitle : '') }), verification: 'unverified' };
  });
  for (const key of ['excerpt', 'pdfLocation', 'aiChatMessageIds']) if (raw[key] !== undefined && raw[key] !== null) metadata[key] = copyRichSource(raw[key]);
  if (raw.linkedPaperId !== undefined) metadata.linkedPaperId = raw.linkedPaperId === null ? null : paper(raw.linkedPaperId);
  if (raw.folderId !== undefined) { if (raw.folderId !== null && typeof raw.folderId !== 'string') return fail('UNSUPPORTED_RICH_NOTE'); metadata.folderId = raw.folderId === null ? null : missing('folder', raw.folderId); }
  if (raw.aiChatId !== undefined && raw.aiChatId !== null) { if (typeof raw.aiChatId !== 'string') return fail('UNSUPPORTED_RICH_NOTE'); metadata.aiChatId = missing('ai-chat', raw.aiChatId); }
  metadata.unresolvedReferences = [...descriptions.values()];
  return createRichNoteData({ paperId, title: raw.title as string, document, metadata, assets: [...assets.values()] });
}

/** This function does not open a library, read PDF bytes, upload files, or mutate legacy data. */
export function projectDesktopLibrary(input: DesktopProjectionInput, allocateId: () => string): DesktopProjectionResult {
  if (!dataObject(input)) return fail('INVALID_DESKTOP_SOURCE');
  if (!validateDesktopIdentityMap(input.identityMap).ok || input.identityMap.accountId !== input.accountId || input.identityMap.libraryBindingId !== input.libraryBindingId) return fail('DESKTOP_SCOPE_MISMATCH');
  if (!dataArray(input.papers) || input.papers.length > SYNC_LIMITS.maxLocalEntities || (input.notes !== undefined && !dataArray(input.notes)) || (input.history !== undefined && !dataObject(input.history))) return fail('INVALID_DESKTOP_SOURCE');
  for (const value of [input.notes,input.graphRelations, input.verifiedAttachments, input.historyBindings, input.richNoteResources]) {
    if (value !== undefined && (!dataArray(value) || value.length > SYNC_LIMITS.maxLocalEntities)) return fail('INVALID_DESKTOP_SOURCE');
  }
  if (input.history && Object.keys(input.history).length > SYNC_LIMITS.maxLocalEntities) return fail('INVALID_DESKTOP_SOURCE');
  const identityMap = structuredClone(input.identityMap);
  const entities: ProjectedEntity[] = [];
  const skipped: DesktopProjectionSkip[] = [];
  const paperIds = new Map<string, string>();
  const versions = new Map<string, { id: string; sha256: string }>();
  const evidence = new Map<string, VerifiedDesktopAttachment>();
  const keyForAttachment = (paperId: string, attachmentId: string) => JSON.stringify([paperId, attachmentId]);
  const skip = (entityType: DesktopProjectionSkip['entityType'], index: number, code: string) => skipped.push({ entityType, index, code });
  const richResources = new Map<string, Map<string, RichNoteAsset>>();
  for (const resource of input.richNoteResources ?? []) {
    if (!dataObject(resource) || resource.proof !== 'verified-note-image-bytes' || resource.accountId !== input.accountId || resource.libraryBindingId !== input.libraryBindingId
      || !localId(resource.localNoteId) || typeof resource.source !== 'string' || resource.source.length < 1 || resource.source.length > RICH_NOTE_LIMITS.entityBytes || !dataObject(resource.asset)) return fail('INVALID_RICH_NOTE_RESOURCE_EVIDENCE');
    const bySource = richResources.get(resource.localNoteId) ?? new Map<string, RichNoteAsset>();
    if (bySource.has(resource.source)) return fail('DUPLICATE_RICH_NOTE_RESOURCE_EVIDENCE');
    bySource.set(resource.source, copyRichSource(resource.asset) as RichNoteAsset); richResources.set(resource.localNoteId, bySource);
  }
  for (const candidate of input.verifiedAttachments ?? []) {
    if (!evidenceValid(candidate)) return fail('INVALID_ATTACHMENT_EVIDENCE');
    const key = keyForAttachment(candidate.localPaperId, candidate.localAttachmentId);
    if (evidence.has(key)) return fail('DUPLICATE_ATTACHMENT_EVIDENCE');
    evidence.set(key, candidate);
  }
  input.papers.forEach((candidate, index) => {
    if (!dataObject(candidate) || !localId(candidate.id) || paperIds.has(candidate.id)) { skip('paper', index, 'INVALID_LOCAL_PAPER'); return; }
    const validated = validateEntityData('paper', paperData(candidate));
    if (!validated.ok) { skip('paper', index, 'INVALID_PAPER_METADATA'); return; }
    const paperId = assignIdentity(identityMap, 'paper', [candidate.id], allocateId);
    paperIds.set(candidate.id, paperId);
    entities.push({ entityType: 'paper', entityId: paperId, schemaVersion: 1, data: validated.value });
    if (candidate.attachments === undefined) return;
    if (!dataArray(candidate.attachments) || candidate.attachments.length > SYNC_LIMITS.maxLocalEntities) { skip('attachmentVersion', index, 'INVALID_ATTACHMENTS'); return; }
    candidate.attachments.forEach((rawAttachment, attachmentIndex) => {
      if (!dataObject(rawAttachment) || !localId(rawAttachment.id) || rawAttachment.kind !== 'pdf' || rawAttachment.paperId !== candidate.id) { skip('attachmentVersion', attachmentIndex, 'INVALID_ATTACHMENT'); return; }
      const key = keyForAttachment(candidate.id as string, rawAttachment.id);
      if (versions.has(key)) { skip('attachmentVersion', attachmentIndex, 'DUPLICATE_ATTACHMENT'); return; }
      const verified = evidence.get(key);
      if (!verified) { skip('attachmentVersion', attachmentIndex, 'UNVERIFIED_ATTACHMENT_HASH'); return; }
      if ((rawAttachment.contentHash != null && rawAttachment.contentHash !== verified.sha256) || (rawAttachment.fileSize != null && rawAttachment.fileSize !== verified.sizeBytes)) { skip('attachmentVersion', attachmentIndex, 'ATTACHMENT_EVIDENCE_MISMATCH'); return; }
      const fileName = typeof rawAttachment.fileName === 'string' ? rawAttachment.fileName.replace(/\\/g, '/').split('/').pop() : undefined;
      const attachmentId = assignIdentity(identityMap, 'attachment', [candidate.id as string, rawAttachment.id], allocateId);
      const data = { paperId, attachmentId, sha256: verified.sha256, sizeBytes: verified.sizeBytes, mediaType: 'application/pdf', fileName, pageCount: verified.pageCount };
      const checked = validateEntityData('attachmentVersion', data);
      if (!checked.ok) { skip('attachmentVersion', attachmentIndex, 'INVALID_ATTACHMENT_METADATA'); return; }
      const versionId = assignIdentity(identityMap, 'attachmentVersion', [candidate.id as string, rawAttachment.id, verified.sha256], allocateId);
      entities.push({ entityType: 'attachmentVersion', entityId: versionId, schemaVersion: 1, data: checked.value });
      versions.set(key, { id: versionId, sha256: verified.sha256 });
    });
  });
  const prepared: { localId: string; index: number; entityId: string; data: EntityDataMap['note'] }[] = [];
  const localNotes = new Set<string>();
  (input.notes ?? []).forEach((candidate, index) => {
    if (!dataObject(candidate) || !localId(candidate.id)) { skip('note', index, 'INVALID_LOCAL_NOTE'); return; }
    if (candidate.deletedAt !== undefined && candidate.deletedAt !== null) { skip('note', index, 'DELETED_NOTE'); return; }
    if (localNotes.has(candidate.id)) { skip('note', index, 'DUPLICATE_NOTE'); return; }
    const rich = candidate.contentJson !== undefined && candidate.contentJson !== null;
    if (!rich && (candidate.format !== 'markdown' || typeof candidate.body !== 'string')) { skip('note', index, 'UNSUPPORTED_NOTE_FORMAT'); return; }
    const localPaper = typeof candidate.paperId === 'string' ? candidate.paperId.replace(/^native-library:/, '') : null;
    const paperId = candidate.paperId === 'global-notes' ? null : localPaper ? paperIds.get(localPaper) : candidate.paperId === null ? null : undefined;
    if (paperId === undefined) { skip('note', index, 'UNMAPPED_NOTE_PAPER'); return; }
    let data: unknown;
    try { data = rich ? projectRichSource(candidate, paperId, paperIds, richResources.get(candidate.id) ?? new Map())
      : { paperId, title: candidate.title, body: candidate.body, format: 'markdown' }; }
    catch (error) { skip('note', index, error instanceof DesktopProjectionError ? error.code : 'UNSUPPORTED_RICH_NOTE'); return; }
    const checked = validateEntityData('note', data);
    if (!checked.ok) { skip('note', index, 'INVALID_NOTE_METADATA'); return; }
    const noteId = assignIdentity(identityMap, 'note', [candidate.id], allocateId);
    localNotes.add(candidate.id); prepared.push({ localId: candidate.id, index, entityId: noteId, data: checked.value });
  });
  const activeNotes = new Map(prepared.map((entry) => [entry.localId, entry])), outputs = new Map<string, EntityDataMap['note']>();
  const mappedPaperIds = new Set(paperIds.values());
  const dependents = new Map<string, Set<(typeof prepared)[number]>>();
  for (const entry of prepared) if (entry.data.format === 'tiptap-json') for (const id of entry.data.metadata.linkedNoteIds) {
    const source = parseRichNoteUnresolvedId(id)?.sourceId ?? id, values = dependents.get(source) ?? new Set(); values.add(entry); dependents.set(source, values);
  }
  const queue = [...prepared], enqueued = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const entry = queue[cursor]; enqueued.delete(entry); if (!activeNotes.has(entry.localId)) continue;
    try {
      outputs.set(entry.localId, entry.data.format !== 'tiptap-json' ? entry.data : remapRichNoteReferences(entry.data, (kind, id, unresolved) => {
        if (kind === 'note') return activeNotes.get(id)?.entityId ?? null;
        if (kind === 'paper') return paperIds.get(id.replace(/^native-library:/, '')) ?? (!unresolved && mappedPaperIds.has(id) ? id : null);
        return null;
      }, { rebindUnresolved: true }));
    } catch {
      activeNotes.delete(entry.localId); outputs.delete(entry.localId); skip('note', entry.index, 'UNSUPPORTED_RICH_NOTE');
      for (const dependent of dependents.get(entry.localId) ?? []) if (!enqueued.has(dependent)) { queue.push(dependent); enqueued.add(dependent); }
    }
  }
  for (const entry of prepared) if (activeNotes.has(entry.localId)) entities.push({ entityType: 'note', entityId: entry.entityId, schemaVersion: 1, data: outputs.get(entry.localId)! });
  Object.entries(input.history ?? {}).forEach(([workspaceId, candidate], index) => {
    const localPaper = workspaceId.startsWith('native-library:') ? workspaceId.slice('native-library:'.length) : '';
    const paperId = paperIds.get(localPaper);
    if (!paperId || !dataObject(candidate) || candidate.workspaceId !== workspaceId) { skip('history', index, 'UNMAPPED_HISTORY'); return; }
    const bindings = (input.historyBindings ?? []).filter((binding) => dataObject(binding) && binding.localPaperId === localPaper);
    if (!bindings.length) { skip('history', index, 'UNVERIFIED_HISTORY_VERSION'); return; }
    for (const binding of bindings) {
      const version = versions.get(keyForAttachment(localPaper, binding.localAttachmentId));
      if (binding.proof !== 'captured-with-verified-version' || binding.accountId !== input.accountId || binding.libraryBindingId !== input.libraryBindingId || !version || version.sha256 !== binding.sha256 || !uuid(binding.deviceId)) { skip('readingPosition', index, 'INVALID_HISTORY_VERSION_BINDING'); continue; }
      const positions = candidate.pdfScrollPositions;
      const position = dataObject(positions) ? positions[binding.sourceKey] : null;
      if (!dataObject(position) || position.sourceKey !== binding.sourceKey || position.updatedAt !== binding.sourceUpdatedAt || !Number.isSafeInteger(binding.sourceUpdatedAt) || !Number.isSafeInteger(position.page) || (position.page as number) < 1 || typeof position.pageOffsetRatio !== 'number') { skip('readingPosition', index, 'UNSUPPORTED_LEGACY_POSITION'); continue; }
      let observedAt: string;
      try { observedAt = new Date(binding.sourceUpdatedAt).toISOString(); } catch { skip('readingPosition', index, 'INVALID_HISTORY_TIMESTAMP'); continue; }
      const data: ReadingPositionData = { paperId, attachmentVersionId: version.id, pageIndex: (position.page as number) - 1, offsetRatio: position.pageOffsetRatio, furthestPageIndex: binding.furthestPageIndex, furthestOffsetRatio: binding.furthestOffsetRatio, sessionId: binding.sessionId, deviceSequence: binding.deviceSequence, observedAt };
      if (!validateEntityData('readingPosition', data).ok) { skip('readingPosition', index, 'INVALID_READING_POSITION'); continue; }
      const entityId = assignIdentity(identityMap, 'readingPosition', [localPaper, version.id, binding.deviceId], allocateId);
      if (entities.some((entity) => entity.entityType === 'readingPosition' && entity.entityId === entityId)) { skip('readingPosition', index, 'DUPLICATE_HISTORY_BINDING'); continue; }
      entities.push({ entityType: 'readingPosition', entityId, schemaVersion: 1, data });
    }
    if (Array.isArray(candidate.annotations) && candidate.annotations.length) skip('annotation', index, 'UNSUPPORTED_LEGACY_ANCHOR');
    if (Array.isArray(candidate.blockTextMarks) && candidate.blockTextMarks.length) skip('annotation', index, 'UNSUPPORTED_STRUCTURED_TEXT_MARK');
  });

  const graphRows=input.graphRelations??[];
  if(graphRows.length>GRAPH_RELATION_LIMITS.relations)return fail('GRAPH_RELATION_LIMIT');
  const graphSeen=new Set<string>();let graphBytes=0;
  graphRows.forEach((candidate,index)=>{
    const known=['id','source','target','type','label','description','confidence','weight','createdAt','updatedAt'];
    if(!dataObject(candidate)||Reflect.ownKeys(candidate).some(k=>typeof k!=='string'||!known.includes(k))||!localId(candidate.id)||graphSeen.has(candidate.id)){skip('graphRelation',index,'INVALID_GRAPH_RELATION');return;}
    graphSeen.add(candidate.id);
    const endpoint=(raw:unknown)=>{
      if(typeof raw!=='string')return null;
      const kind=raw.startsWith('paper:')?'paper':raw.startsWith('note:')?'note':null;
      if(!kind)return null;const id=raw.slice(kind.length+1);if(!localId(id))return null;
      const entityId=kind==='paper'?paperIds.get(id):activeNotes.get(id)?.entityId;
      return entityId?{entityType:kind,entityId}:null;
    };
    const source=endpoint(candidate.source),target=endpoint(candidate.target);
    if(!source||!target){skip('graphRelation',index,'UNMAPPED_GRAPH_ENDPOINT');return;}
    let data;
    try{
      if(typeof candidate.createdAt!=='number'||!Number.isSafeInteger(candidate.createdAt)||candidate.createdAt<0)throw Error();
      data=validateGraphRelationData({source,target,relationType:candidate.type,label:candidate.label,description:candidate.description??'',confidence:candidate.confidence??null,weight:candidate.weight,createdAt:new Date(candidate.createdAt).toISOString(),updatedAt:candidate.updatedAt===undefined||candidate.updatedAt===null?null:typeof candidate.updatedAt==='number'&&Number.isSafeInteger(candidate.updatedAt)&&candidate.updatedAt>=candidate.createdAt?new Date(candidate.updatedAt).toISOString():'INVALID'});
    }catch{skip('graphRelation',index,'UNSUPPORTED_GRAPH_RELATION');return;}
    graphBytes+=new TextEncoder().encode(JSON.stringify(data)).length;
    if(graphBytes>GRAPH_RELATION_LIMITS.accountBytes)return fail('GRAPH_RELATION_LIMIT');
    const entityId=assignIdentity(identityMap,'graphRelation',[candidate.id],allocateId);
    entities.push({entityType:'graphRelation',entityId,schemaVersion:1,data});
  });

  return { identityMap, entities, skipped };
}
