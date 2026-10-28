import {
  canonicalJson, ENTITY_DATA_SCHEMAS, ENTITY_TYPES, isPlainObject, SYNC_LIMITS, UUID_PATTERN,
  validateEntityData, validateJsonSchema,
  type JsonSchema, type LocalEdit, type NoteData, type PaperData, type ValidationIssue, type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import { RICH_NOTE_DATA_SCHEMA, validateRichNoteData, remapRichNoteReferences,
  type RichNoteData } from '../../../../packages/sync-core/src/richNote.ts';

export const LIBRARY_TRANSFER_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxPapers: 500,
  maxNotes: 500,
  maxItems: 1000,
  maxIdAttempts: 32,
});

export interface LibraryMarkdownNote { ref: string; sourceId?: string; paperRef: string | null; paperSourceId?: string | null; title: string; body: string; format: 'markdown' }
export interface LibraryRichNote extends Omit<RichNoteData, 'paperId'> { ref: string; sourceId?: string; paperRef: string | null; paperSourceId?: string | null }
export type LibraryArchiveNote = LibraryMarkdownNote | LibraryRichNote;
export interface LibraryDesktopExportReport {
  source: 'desktop-saved-notes'; sourceIds: 'export-only-aliases'; scope: 'selected-saved-notes';
  requestedNotes: number;
  skipped: { entityType: 'paper' | 'note'; index: number; code: string }[];
  aliases: { entityType: 'paper' | 'note'; sourceId: string; originalId: string }[];
}
export interface LibraryArchive {
  format: 'paperquay-library';
  version: 1 | 2;
  /** v2 sourceId is a source identity used solely for explicit in-package binding. */
  papers: { ref: string; data: PaperData; sourceId?: string }[];
  notes: LibraryArchiveNote[];
  /** Diagnostic source keys are package-local aliases, never target identities. */
  exportReport?: LibraryDesktopExportReport;
}
export type LibraryBlockedReason = 'MISSING_PAPER' | 'PAPER_NOT_SELECTED' | 'AMBIGUOUS_PAPER';
export type LibraryImportAssociation =
  | { kind: 'none' }
  | { kind: 'new-paper'; paperKey: string; paperTitle: string }
  | { kind: 'existing-paper'; entityId: string; revision: number; paperTitle: string }
  | { kind: 'blocked'; reason: LibraryBlockedReason; paperKey: string | null };
export interface LibraryImportRow {
  key: string;
  entityType: 'paper' | 'note';
  ref: string;
  title: string;
  defaultSelected: boolean;
  selected: boolean;
  duplicate: { reason: 'doi' | 'exact-paper' | 'exact-note'; existingIds: string[]; archiveKeys: string[] } | null;
  association: LibraryImportAssociation | null;
  blockedReason: LibraryBlockedReason | null;
}
export interface LibraryImportSummary {
  papers: number;
  notes: number;
  selectedPapers: number;
  selectedNotes: number;
  duplicatePapers: number;
  duplicateNotes: number;
  blockedNotes: number;
  selectedBlockedNotes: number;
  skipped: number;
}
export interface LibraryImportPlan {
  archive: LibraryArchive;
  rows: LibraryImportRow[];
  summary: LibraryImportSummary;
  /** Contains private user content. Compare in memory only; never log or persist this value. */
  signature: string;
  requiresPaperOrganization: boolean;
  requiresRichNotes: boolean;
}
export interface LibraryExportSummary {
  papers: number;
  notes: number;
  unresolvedNoteLinks: number;
  omittedDeleted: number;
  omittedUnsupported: number;
  conflicted: number;
  scope: 'visible-saved-library-and-markdown' | 'visible-saved-library-and-rich-notes';
}
export type LibraryTransferErrorCode =
  | 'INVALID_JSON' | 'UNSUPPORTED_FORMAT' | 'INVALID_ARCHIVE' | 'ARCHIVE_TOO_LARGE'
  | 'INVALID_EXISTING_DATA' | 'INVALID_SELECTION' | 'INVALID_PLAN' | 'EMPTY_SELECTION'
  | 'BLOCKED_ASSOCIATION' | 'INVALID_GENERATED_ID' | 'ID_ALLOCATION_FAILED';
export class LibraryTransferError extends Error {
  readonly code: LibraryTransferErrorCode;
  readonly issues: readonly ValidationIssue[];
  constructor(code: LibraryTransferErrorCode, issues: readonly ValidationIssue[] = []) {
    super(code);
    this.name = 'LibraryTransferError';
    this.code = code;
    this.issues = issues.map(({ path, code: issueCode }) => ({ path, code: issueCode }));
  }
}

const uuid = new RegExp(UUID_PATTERN);
const paperRef: JsonSchema = { type: 'string', pattern: '^p[1-9][0-9]{0,5}$' };
const noteRef: JsonSchema = { type: 'string', pattern: '^n[1-9][0-9]{0,5}$' };
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const archiveSchema = object({
  format: { const: 'paperquay-library' }, version: { const: 1 },
  papers: { type: 'array', maxItems: LIBRARY_TRANSFER_LIMITS.maxPapers,
    items: object({ ref: paperRef, data: ENTITY_DATA_SCHEMAS.paper }) },
  notes: { type: 'array', maxItems: LIBRARY_TRANSFER_LIMITS.maxNotes, items: object({
    ref: noteRef, paperRef: { anyOf: [{ type: 'null' }, paperRef] },
    title: { type: 'string', maxLength: SYNC_LIMITS.maxTitleLength },
    body: { type: 'string', maxLength: SYNC_LIMITS.maxNoteBodyLength }, format: { const: 'markdown' },
  }) },
});
const sourceId: JsonSchema = { type: 'string', pattern: UUID_PATTERN };
const exportReportSchema: JsonSchema = object({
  source: { const: 'desktop-saved-notes' }, sourceIds: { const: 'export-only-aliases' }, scope: { const: 'selected-saved-notes' },
  requestedNotes: { type: 'integer', minimum: 1, maximum: LIBRARY_TRANSFER_LIMITS.maxNotes },
  skipped: { type: 'array', maxItems: LIBRARY_TRANSFER_LIMITS.maxItems, items: object({
    entityType: { enum: ['paper', 'note'] }, index: { type: 'integer', minimum: 0, maximum: LIBRARY_TRANSFER_LIMITS.maxItems - 1 },
    code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,79}$' },
  }) },
  aliases: { type: 'array', maxItems: LIBRARY_TRANSFER_LIMITS.maxItems, items: object({
    entityType: { enum: ['paper', 'note'] }, sourceId,
    originalId: { type: 'string', minLength: 1, maxLength: 512 },
  }) },
});
const markdownV2 = object({ ref: noteRef, sourceId, paperRef: { anyOf: [{ type: 'null' }, paperRef] }, paperSourceId: { anyOf: [{ type: 'null' }, sourceId] },
  title: { type: 'string', maxLength: SYNC_LIMITS.maxTitleLength }, body: { type: 'string', maxLength: SYNC_LIMITS.maxNoteBodyLength }, format: { const: 'markdown' } });
const { paperId: _richPaperId, ...richProperties } = RICH_NOTE_DATA_SCHEMA.properties!;
const archiveV2Schema = object({ format: { const: 'paperquay-library' }, version: { const: 2 },
  papers: { type: 'array', maxItems: LIBRARY_TRANSFER_LIMITS.maxPapers, items: object({ ref: paperRef, sourceId, data: ENTITY_DATA_SCHEMAS.paper }) },
  notes: { type: 'array', maxItems: LIBRARY_TRANSFER_LIMITS.maxNotes, items: { oneOf: [markdownV2,
    object({ ref: noteRef, sourceId, paperRef: { anyOf: [{ type: 'null' }, paperRef] }, paperSourceId: { anyOf: [{ type: 'null' }, sourceId] }, ...richProperties })] } },
});
archiveV2Schema.properties!.exportReport = exportReportSchema;
export function richLibraryNoteData(note: LibraryRichNote): RichNoteData {
  const fields = new Set(['ref', 'sourceId', 'paperRef', 'paperSourceId', 'title', 'body', 'format', 'document', 'metadata', 'assets']);
  if (!dataOnly(note) || Reflect.ownKeys(note).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(note, key);
    return typeof key !== 'string' || !fields.has(key) || !descriptor?.enumerable || !('value' in descriptor);
  })) throw new LibraryTransferError('INVALID_ARCHIVE');
  return validateRichNoteData({ paperId: null, title: note.title, body: note.body, format: note.format,
    document: note.document, metadata: note.metadata, assets: note.assets });
}

function checkBytes(text: string): void {
  if (text.length > LIBRARY_TRANSFER_LIMITS.maxBytes
    || new TextEncoder().encode(text).byteLength > LIBRARY_TRANSFER_LIMITS.maxBytes) {
    throw new LibraryTransferError('ARCHIVE_TOO_LARGE');
  }
}

function cloneJson<T>(value: T): T {
  // canonicalJson does not invoke toJSON or property accessors.
  return JSON.parse(canonicalJson(value)) as T;
}

function checkedArchive(value: unknown): LibraryArchive {
  const checked = validateJsonSchema<LibraryArchive>({ oneOf: [archiveSchema, archiveV2Schema] }, value);
  if (!checked.ok) {
    const unsupported = dataOnly(value) && (value.format !== undefined && value.format !== 'paperquay-library'
      || value.version !== undefined && value.version !== 1 && value.version !== 2);
    throw new LibraryTransferError(unsupported ? 'UNSUPPORTED_FORMAT' : 'INVALID_ARCHIVE', checked.issues);
  }
  const archive = checked.value;
  if (archive.papers.length + archive.notes.length > LIBRARY_TRANSFER_LIMITS.maxItems) {
    throw new LibraryTransferError('INVALID_ARCHIVE', [{ path: '$', code: 'TOO_MANY_ITEMS' }]);
  }
  for (const [field, values] of [['papers', archive.papers], ['notes', archive.notes]] as const) {
    const refs = new Set<string>(), sources = new Set<string>();
    for (let index = 0; index < values.length; index++) {
      if (refs.has(values[index].ref)) {
        throw new LibraryTransferError('INVALID_ARCHIVE', [{ path: `$.${field}[${index}].ref`, code: 'DUPLICATE_REF' }]);
      }
      refs.add(values[index].ref);
      if (archive.version === 2) {
        const id = values[index].sourceId!;
        if (sources.has(id)) throw new LibraryTransferError('INVALID_ARCHIVE', [{ path: `$.${field}[${index}].sourceId`, code: 'DUPLICATE_SOURCE_ID' }]);
        sources.add(id);
      }
    }
  }
  if (archive.version === 2) {
    const papers = new Map(archive.papers.map((paper) => [paper.ref, paper.sourceId]));
    for (const note of archive.notes) {
      if (note.paperRef === null ? note.paperSourceId !== null : typeof note.paperSourceId !== 'string'
        || papers.has(note.paperRef) && papers.get(note.paperRef) !== note.paperSourceId)
        throw new LibraryTransferError('INVALID_ARCHIVE', [{ path: '$.notes', code: 'INCONSISTENT_PAPER_REFERENCE' }]);
    }
    if (archive.exportReport) {
      const report = archive.exportReport, aliases = new Set<string>(), originalIds = new Set<string>(), skippedNotes = new Set<number>(), skippedKeys = new Set<string>();
      for (const entry of report.skipped) {
        const key = `${entry.entityType}:${entry.index}`;
        if (skippedKeys.has(key) || entry.entityType === 'note' && entry.index >= report.requestedNotes) throw new LibraryTransferError('INVALID_ARCHIVE');
        skippedKeys.add(key); if (entry.entityType === 'note') skippedNotes.add(entry.index);
      }
      if (report.requestedNotes !== archive.notes.length + skippedNotes.size) throw new LibraryTransferError('INVALID_ARCHIVE');
      for (const alias of report.aliases) {
        const key = `${alias.entityType}:${alias.sourceId}`, values = alias.entityType === 'paper' ? archive.papers : archive.notes;
        const originalKey = `${alias.entityType}:${alias.originalId}`;
        if (aliases.has(key) || originalIds.has(originalKey) || !values.some((entry) => entry.sourceId === alias.sourceId)
          || alias.originalId.trim() !== alias.originalId || /[\\/\x00-\x1f\x7f]/.test(alias.originalId)
          || /^(?:(?:standalone|file|https?):|[a-z]:)/i.test(alias.originalId)) throw new LibraryTransferError('INVALID_ARCHIVE');
        aliases.add(key); originalIds.add(originalKey);
      }
      if (aliases.size !== archive.papers.length + archive.notes.length) throw new LibraryTransferError('INVALID_ARCHIVE');
    }
  }
  try { for (const note of archive.notes) if (note.format === 'tiptap-json') richLibraryNoteData(note); }
  catch { throw new LibraryTransferError('INVALID_ARCHIVE', [{ path: '$.notes', code: 'INVALID_RICH_NOTE' }]); }
  const serialized = canonicalJson(archive);
  checkBytes(serialized);
  return JSON.parse(serialized) as LibraryArchive;
}

/** Only the explicitly versioned JSON exchange format is supported. */
export function parseLibraryArchive(text: string): LibraryArchive {
  if (typeof text !== 'string') throw new LibraryTransferError('INVALID_JSON');
  checkBytes(text);
  // The rich document has its own stricter recursive grammar and budget.
  let depth = 0; let quoted = false; let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      depth++;
      if (depth > 40) throw new LibraryTransferError('INVALID_ARCHIVE', [{ path: '$', code: 'MAX_DEPTH' }]);
    } else if (character === '}' || character === ']') depth--;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new LibraryTransferError('INVALID_JSON'); }
  return checkedArchive(value);
}

interface ExistingEntity {
  entityType: VisibleEntity['entityType'];
  entityId: string;
  revision: number;
  deleted: boolean;
  pending: boolean;
  status: VisibleEntity['status'];
  data: PaperData | NoteData | null;
}

function dataOnly(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
    && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
}

function checkedExisting(entities: readonly VisibleEntity[]): ExistingEntity[] {
  try {
    if (!Array.isArray(entities) || entities.length > SYNC_LIMITS.maxLocalEntities) throw new Error();
    const identities = new Set<string>();
    const result: ExistingEntity[] = [];
    for (let index = 0; index < entities.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(entities, index);
      if (!descriptor || !('value' in descriptor) || !dataOnly(descriptor.value)) throw new Error();
      const value = descriptor.value;
      if (typeof value.entityType !== 'string' || !ENTITY_TYPES.includes(value.entityType as VisibleEntity['entityType'])
        || typeof value.entityId !== 'string' || !uuid.test(value.entityId)
        || typeof value.deleted !== 'boolean' || typeof value.pending !== 'boolean'
        || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
        || typeof value.status !== 'string') throw new Error();
      const identity = `${value.entityType}:${value.entityId}`;
      if (identities.has(identity)) throw new Error();
      identities.add(identity);
      const entityType = value.entityType as VisibleEntity['entityType'];
      let data: PaperData | NoteData | null = null;
      if (!value.deleted && (entityType === 'paper' || entityType === 'note')) {
        const checked = validateEntityData(entityType, value.data);
        if (!checked.ok) throw new Error();
        data = cloneJson(checked.value);
      }
      result.push({ entityType, entityId: value.entityId, revision: value.revision as number,
        deleted: value.deleted, pending: value.pending, status: value.status as VisibleEntity['status'], data });
    }
    return result;
  } catch { throw new LibraryTransferError('INVALID_EXISTING_DATA'); }
}

const byId = (left: ExistingEntity, right: ExistingEntity) => left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0;

/** Exports only the saved local visible projection, never a sync snapshot or a complete backup. */
export function exportLibraryArchive(entities: readonly VisibleEntity[], options: { version?: 2; exportReport?: LibraryDesktopExportReport } = {}): {
  archive: LibraryArchive; json: string; summary: LibraryExportSummary;
} {
  const existing = checkedExisting(entities);
  const papers = existing.filter((entity) => !entity.deleted && entity.entityType === 'paper').sort(byId);
  const notes = existing.filter((entity) => !entity.deleted && entity.entityType === 'note').sort(byId);
  if (papers.length > LIBRARY_TRANSFER_LIMITS.maxPapers || notes.length > LIBRARY_TRANSFER_LIMITS.maxNotes) {
    throw new LibraryTransferError('INVALID_ARCHIVE', [{ path: '$', code: 'TOO_MANY_ITEMS' }]);
  }
  const activePaperIds = new Set(papers.map((entity) => entity.entityId));
  const referencedPaperIds = new Set(activePaperIds);
  for (const note of notes) {
    const paperId = (note.data as NoteData).paperId;
    if (paperId !== null) referencedPaperIds.add(paperId);
  }
  // Dangling associations receive fresh local refs too; source UUIDs never enter the file.
  const refs = new Map([...referencedPaperIds].sort().map((id, index) => [id, `p${index + 1}`]));
  const rich = notes.some((entity) => (entity.data as NoteData).format === 'tiptap-json'), version2 = rich || options.version === 2;
  if (options.exportReport && !version2) throw new LibraryTransferError('INVALID_ARCHIVE');
  const archive = checkedArchive({ format: 'paperquay-library', version: version2 ? 2 : 1,
    ...(options.exportReport ? { exportReport: options.exportReport } : {}),
    papers: papers.map((entity) => ({ ref: refs.get(entity.entityId)!, ...(version2 ? { sourceId: entity.entityId } : {}), data: entity.data as PaperData })),
    notes: notes.map((entity, index) => {
      const data = entity.data as NoteData;
      const { paperId, ...content } = data;
      return { ref: `n${index + 1}`, ...(version2 ? { sourceId: entity.entityId, paperSourceId: paperId } : {}), paperRef: paperId === null ? null : refs.get(paperId)!, ...content };
    }),
  });
  const json = JSON.stringify(archive, null, 2);
  checkBytes(json);
  const summary: LibraryExportSummary = {
    papers: papers.length, notes: notes.length,
    unresolvedNoteLinks: notes.filter((entity) => {
      const id = (entity.data as NoteData).paperId;
      return id !== null && !activePaperIds.has(id);
    }).length,
    omittedDeleted: existing.filter((entity) => entity.deleted).length,
    omittedUnsupported: existing.filter((entity) => !entity.deleted && entity.entityType !== 'paper' && entity.entityType !== 'note').length,
    conflicted: [...papers, ...notes].filter((entity) => entity.status === 'conflict').length,
    scope: rich ? 'visible-saved-library-and-rich-notes' : 'visible-saved-library-and-markdown',
  };
  return { archive, json, summary };
}

/** Conservative DOI matching; an invalid or ambiguous URL falls back to full metadata equality. */
function normalizedDoi(input: string | null): string | null {
  if (input === null) return null;
  let value = input.trim().replace(/^doi:\s*/i, '');
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (!['doi.org', 'dx.doi.org'].includes(parsed.hostname.toLowerCase()) || parsed.username || parsed.password
        || parsed.port || parsed.search || parsed.hash) return null;
      value = decodeURIComponent(parsed.pathname.slice(1));
    } catch { return null; }
  }
  value = value.trim();
  return /^10\.\d{4,9}\/[^\s]+$/i.test(value) ? value.toLowerCase() : null;
}

function paperFingerprint(data: PaperData): string {
  const doi = normalizedDoi(data.doi);
  // Personal organization is not bibliographic identity: a standards export
  // intentionally omits it and must not create a duplicate when re-imported.
  const { organization: _organization, ...metadata } = data;
  return doi === null ? `data:${canonicalJson(metadata)}` : `doi:${doi}`;
}
// Exact rich structure, metadata, assets and reference identities are compared.
// Different namespaces may conservatively remain separate copies; plain text,
// labels or title alone must never collapse distinct links or formatting.
const noteFingerprint = (association: string, data: NoteData | LibraryArchiveNote) => data.format === 'markdown'
  ? canonicalJson([association, data.title, data.body, 'markdown'])
  : canonicalJson([association, data.title, data.format, data.document, data.metadata, data.assets]);
const paperKey = (ref: string) => `paper:${ref}`;
const noteKey = (ref: string) => `note:${ref}`;
function addToIndex<T>(index: Map<string, T[]>, key: string, value: T): void {
  const values = index.get(key);
  if (values) values.push(value); else index.set(key, [value]);
}

function selectionSet(selection: readonly string[], known: Set<string>): Set<string> {
  if (!Array.isArray(selection) || selection.length > LIBRARY_TRANSFER_LIMITS.maxItems) throw new LibraryTransferError('INVALID_SELECTION');
  const result = new Set<string>();
  for (let index = 0; index < selection.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(selection, index);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string'
      || !known.has(descriptor.value) || result.has(descriptor.value)) throw new LibraryTransferError('INVALID_SELECTION');
    result.add(descriptor.value);
  }
  return result;
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

const plans = new WeakMap<LibraryImportPlan, { occupiedIds: ReadonlySet<string> }>();

/** Rebuild inside the account transaction and compare signature before allocating any new IDs. */
export function planLibraryImport(archive: LibraryArchive, existing: readonly VisibleEntity[], selection?: readonly string[]): LibraryImportPlan {
  const source = checkedArchive(archive);
  const saved = checkedExisting(existing);
  const savedPapers = saved.filter((entity) => !entity.deleted && entity.entityType === 'paper');
  const papersById = new Map(savedPapers.map((entity) => [entity.entityId, entity]));
  const savedByFingerprint = new Map<string, ExistingEntity[]>();
  for (const entity of savedPapers.sort(byId)) addToIndex(savedByFingerprint, paperFingerprint(entity.data as PaperData), entity);
  const sourcePapers = new Map(source.papers.map((paper) => [paper.ref, paper]));
  const sourceFingerprints = new Map(source.papers.map((paper) => [paper.ref, paperFingerprint(paper.data)]));
  const sourceByFingerprint = new Map<string, string[]>();
  const rows: LibraryImportRow[] = [];
  const defaults = new Set<string>();
  for (const paper of source.papers) {
    const fingerprint = sourceFingerprints.get(paper.ref)!;
    const previous = sourceByFingerprint.get(fingerprint) ?? [];
    const matches = savedByFingerprint.get(fingerprint) ?? [];
    const duplicate: LibraryImportRow['duplicate'] = matches.length || previous.length ? {
      reason: fingerprint.startsWith('doi:') ? 'doi' : 'exact-paper',
      existingIds: matches.map((entity) => entity.entityId), archiveKeys: [...previous],
    } : null;
    const key = paperKey(paper.ref);
    rows.push({ key, entityType: 'paper', ref: paper.ref, title: paper.data.title,
      defaultSelected: !duplicate, selected: false, duplicate, association: null, blockedReason: null });
    if (!duplicate) defaults.add(key);
    addToIndex(sourceByFingerprint, fingerprint, key);
  }
  const association = (ref: string | null, chosen: ReadonlySet<string>): LibraryImportAssociation => {
    if (ref === null) return { kind: 'none' };
    const paper = sourcePapers.get(ref);
    if (!paper) return { kind: 'blocked', reason: 'MISSING_PAPER', paperKey: null };
    const key = paperKey(ref);
    if (chosen.has(key)) return { kind: 'new-paper', paperKey: key, paperTitle: paper.data.title };
    const fingerprint = sourceFingerprints.get(ref)!;
    const peers = (sourceByFingerprint.get(fingerprint) ?? []).filter((candidate) => chosen.has(candidate));
    if (peers.length === 1) {
      const peer = sourcePapers.get(peers[0].slice('paper:'.length))!;
      return { kind: 'new-paper', paperKey: peers[0], paperTitle: peer.data.title };
    }
    if (peers.length > 1) return { kind: 'blocked', reason: 'AMBIGUOUS_PAPER', paperKey: key };
    const matches = savedByFingerprint.get(fingerprint) ?? [];
    if (matches.length === 1) return { kind: 'existing-paper', entityId: matches[0].entityId,
      revision: matches[0].revision, paperTitle: (matches[0].data as PaperData).title };
    return { kind: 'blocked', reason: matches.length ? 'AMBIGUOUS_PAPER' : 'PAPER_NOT_SELECTED', paperKey: key };
  };
  const savedNotes = new Map<string, ExistingEntity[]>();
  for (const entity of saved.filter((entry) => !entry.deleted && entry.entityType === 'note').sort(byId)) {
    const data = entity.data as NoteData;
    const linked = data.paperId === null ? null : papersById.get(data.paperId);
    const token = data.paperId === null ? 'none' : linked ? paperFingerprint(linked.data as PaperData) : `missing-existing:${data.paperId}`;
    addToIndex(savedNotes, noteFingerprint(token, data), entity);
  }
  const sourceNotes = new Map<string, string[]>();
  for (const note of source.notes) {
    const token = note.paperRef === null ? 'none' : sourceFingerprints.get(note.paperRef) ?? `missing-source:${note.paperRef}`;
    const fingerprint = noteFingerprint(token, note);
    const previous = sourceNotes.get(fingerprint) ?? [];
    const matches = savedNotes.get(fingerprint) ?? [];
    const duplicate: LibraryImportRow['duplicate'] = matches.length || previous.length ? {
      reason: 'exact-note', existingIds: matches.map((entity) => entity.entityId), archiveKeys: [...previous],
    } : null;
    const defaultAssociation = association(note.paperRef, defaults);
    const defaultSelected = duplicate === null && defaultAssociation.kind !== 'blocked';
    const key = noteKey(note.ref);
    rows.push({ key, entityType: 'note', ref: note.ref, title: note.title,
      defaultSelected, selected: false, duplicate, association: defaultAssociation,
      blockedReason: defaultAssociation.kind === 'blocked' ? defaultAssociation.reason : null });
    if (defaultSelected) defaults.add(key);
    addToIndex(sourceNotes, fingerprint, key);
  }
  const chosen = selection === undefined ? defaults : selectionSet(selection, new Set(rows.map((row) => row.key)));
  for (const row of rows) {
    row.selected = chosen.has(row.key);
    if (row.entityType === 'note') {
      row.association = association(source.notes.find((note) => note.ref === row.ref)!.paperRef, chosen);
      row.blockedReason = row.association.kind === 'blocked' ? row.association.reason : null;
    }
  }
  const summary: LibraryImportSummary = {
    papers: source.papers.length, notes: source.notes.length,
    selectedPapers: rows.filter((row) => row.entityType === 'paper' && row.selected).length,
    selectedNotes: rows.filter((row) => row.entityType === 'note' && row.selected).length,
    duplicatePapers: rows.filter((row) => row.entityType === 'paper' && row.duplicate !== null).length,
    duplicateNotes: rows.filter((row) => row.entityType === 'note' && row.duplicate !== null).length,
    blockedNotes: rows.filter((row) => row.blockedReason !== null).length,
    selectedBlockedNotes: rows.filter((row) => row.blockedReason !== null && row.selected).length,
    skipped: rows.filter((row) => !row.selected).length,
  };
  const requiresPaperOrganization = source.papers.some((paper) => chosen.has(paperKey(paper.ref)) && paper.data.organization !== undefined);
  const requiresRichNotes = source.notes.some((note) => chosen.has(noteKey(note.ref)) && note.format === 'tiptap-json');
  const relevant = new Set<string>();
  for (const row of rows) {
    for (const id of row.duplicate?.existingIds ?? []) relevant.add(`${row.entityType}:${id}`);
    if (row.association?.kind === 'existing-paper') relevant.add(`paper:${row.association.entityId}`);
  }
  // A matching DOI can survive a changed title or a newer local overlay. Reconfirm that
  // decision too, even when the user chose an independent copy rather than an existing link.
  const current = saved.filter((entity) => relevant.has(`${entity.entityType}:${entity.entityId}`))
    .sort((left, right) => {
      const leftKey = `${left.entityType}:${left.entityId}`; const rightKey = `${right.entityType}:${right.entityId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const signature = canonicalJson({ archive: source, rows, summary, requiresPaperOrganization, requiresRichNotes, current });
  const plan = freezeTree({ archive: source, rows, summary, signature, requiresPaperOrganization, requiresRichNotes });
  const occupiedIds = new Set(saved.map((entity) => entity.entityId));
  if (source.version === 2) for (const item of [...source.papers, ...source.notes]) occupiedIds.add(item.sourceId!);
  plans.set(plan, { occupiedIds });
  return plan;
}

/** Produces fresh creates only. This function does not persist, sync, or mutate the source. */
export function materializeLibraryImport(plan: LibraryImportPlan, createId: () => string): {
  edits: LocalEdit[]; summary: LibraryImportSummary; requiresPaperOrganization: boolean; requiresRichNotes: boolean;
} {
  const internal = plans.get(plan);
  if (!internal) throw new LibraryTransferError('INVALID_PLAN');
  if (plan.summary.selectedBlockedNotes) throw new LibraryTransferError('BLOCKED_ASSOCIATION');
  if (plan.summary.selectedPapers + plan.summary.selectedNotes === 0) throw new LibraryTransferError('EMPTY_SELECTION');
  if (typeof createId !== 'function') throw new LibraryTransferError('INVALID_GENERATED_ID');
  const occupied = new Set(internal.occupiedIds);
  const ids = new Map<string, string>();
  for (const row of plan.rows.filter((entry) => entry.selected)) {
    let allocated: string | null = null;
    for (let attempt = 0; attempt < LIBRARY_TRANSFER_LIMITS.maxIdAttempts; attempt++) {
      let candidate: unknown;
      try { candidate = createId(); }
      catch { throw new LibraryTransferError('ID_ALLOCATION_FAILED'); }
      if (typeof candidate !== 'string' || !uuid.test(candidate)) throw new LibraryTransferError('INVALID_GENERATED_ID');
      if (!occupied.has(candidate)) { allocated = candidate; break; }
    }
    if (allocated === null) throw new LibraryTransferError('ID_ALLOCATION_FAILED');
    occupied.add(allocated); ids.set(row.key, allocated);
  }
  const rows = new Map(plan.rows.map((row) => [row.key, row]));
  const sourcePapers = new Map(plan.archive.papers.filter((paper) => paper.sourceId && ids.has(paperKey(paper.ref))).map((paper) => [paper.sourceId!, ids.get(paperKey(paper.ref))!]));
  const sourceNotes = new Map(plan.archive.notes.filter((note) => note.sourceId && ids.has(noteKey(note.ref))).map((note) => [note.sourceId!, ids.get(noteKey(note.ref))!]));
  const edits: LocalEdit[] = [];
  for (const paper of plan.archive.papers) {
    const id = ids.get(paperKey(paper.ref));
    if (id) edits.push({ entityType: 'paper', entityId: id, mutation: 'put', data: cloneJson(paper.data) });
  }
  for (const note of plan.archive.notes) {
    const key = noteKey(note.ref); const id = ids.get(key);
    if (!id) continue;
    const linked = rows.get(key)!.association!;
    let paperId: string | null;
    if (linked.kind === 'none') paperId = null;
    else if (linked.kind === 'existing-paper') paperId = linked.entityId;
    else if (linked.kind === 'new-paper' && ids.has(linked.paperKey)) paperId = ids.get(linked.paperKey)!;
    else throw new LibraryTransferError('BLOCKED_ASSOCIATION');
    let data: NoteData;
    try { data = note.format === 'markdown' ? { paperId, title: note.title, body: note.body, format: 'markdown' }
      : remapRichNoteReferences(richLibraryNoteData(note), (kind, id) => kind === 'paper' ? sourcePapers.get(id) ?? null : kind === 'note' ? sourceNotes.get(id) ?? null : null, { paperId }); }
    catch { throw new LibraryTransferError('INVALID_ARCHIVE', [{ path: '$.notes', code: 'UNSUPPORTED_REFERENCE_REMAP' }]); }
    edits.push({ entityType: 'note', entityId: id, mutation: 'put', data });
  }
  return { edits, summary: { ...plan.summary }, requiresPaperOrganization: plan.requiresPaperOrganization, requiresRichNotes: plan.requiresRichNotes };
}
