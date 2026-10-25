import type { EntityDataMap, EntityType, ReadingPositionData, ValidationResult } from './types.ts';
import { SYNC_LIMITS, UUID_PATTERN } from './schema.ts';
import { isPlainObject, validateEntityData } from './validation.ts';

type IdentityKind = EntityType | 'attachment';
const IDENTITY_KINDS: readonly IdentityKind[] = ['paper', 'attachment', 'attachmentVersion', 'note', 'annotation', 'readingPosition'];
const uuid = (value: unknown): value is string => typeof value === 'string' && new RegExp(UUID_PATTERN).test(value);
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const localId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^(?:standalone|file|https?):/i.test(value);
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
  /** Only explicit format:'markdown'/body notes are supported; legacy rich text stays untouched. */
  notes?: readonly unknown[];
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

/** This function does not open a library, read PDF bytes, upload files, or mutate legacy data. */
export function projectDesktopLibrary(input: DesktopProjectionInput, allocateId: () => string): DesktopProjectionResult {
  if (!dataObject(input)) return fail('INVALID_DESKTOP_SOURCE');
  if (!validateDesktopIdentityMap(input.identityMap).ok || input.identityMap.accountId !== input.accountId || input.identityMap.libraryBindingId !== input.libraryBindingId) return fail('DESKTOP_SCOPE_MISMATCH');
  if (!dataArray(input.papers) || input.papers.length > SYNC_LIMITS.maxLocalEntities || (input.notes !== undefined && !dataArray(input.notes)) || (input.history !== undefined && !dataObject(input.history))) return fail('INVALID_DESKTOP_SOURCE');
  for (const value of [input.notes, input.verifiedAttachments, input.historyBindings]) {
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
  (input.notes ?? []).forEach((candidate, index) => {
    if (!dataObject(candidate) || !localId(candidate.id)) { skip('note', index, 'INVALID_LOCAL_NOTE'); return; }
    if (candidate.contentJson !== undefined && candidate.contentJson !== null) { skip('note', index, 'UNSUPPORTED_RICH_NOTE'); return; }
    if (candidate.format !== 'markdown' || typeof candidate.body !== 'string') { skip('note', index, 'UNSUPPORTED_NOTE_FORMAT'); return; }
    const localPaper = typeof candidate.paperId === 'string' ? candidate.paperId.replace(/^native-library:/, '') : null;
    const paperId = localPaper ? paperIds.get(localPaper) : candidate.paperId === null ? null : undefined;
    if (paperId === undefined) { skip('note', index, 'UNMAPPED_NOTE_PAPER'); return; }
    const checked = validateEntityData('note', { paperId, title: candidate.title, body: candidate.body, format: 'markdown' });
    if (!checked.ok) { skip('note', index, 'INVALID_NOTE_METADATA'); return; }
    const noteId = assignIdentity(identityMap, 'note', [candidate.id], allocateId);
    if (entities.some((entity) => entity.entityType === 'note' && entity.entityId === noteId)) { skip('note', index, 'DUPLICATE_NOTE'); return; }
    entities.push({ entityType: 'note', entityId: noteId, schemaVersion: 1, data: checked.value });
  });
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
  return { identityMap, entities, skipped };
}
