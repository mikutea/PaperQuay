import {
  canonicalJson, ENTITY_DATA_SCHEMAS, ENTITY_TYPES, isPlainObject, SYNC_LIMITS, UUID_PATTERN,
  validateEntityData, validateJsonSchema,
  type JsonSchema, type LocalEdit, type PaperData, type ValidationIssue, type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import { normalizeDoi } from './doiLookup.ts';

export const EXTERNAL_LIBRARY_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024, maxItems: 500, maxJsonDepth: 16,
  maxSources: 50, maxMappings: 10_000, maxRegistryBytes: 32 * 1024 * 1024, maxIdAttempts: 32,
});
export const EXTERNAL_PAPER_FIELDS = ['title', 'doi', 'year', 'publication', 'abstractText', 'authors', 'keywords'] as const;
export type ExternalPaperField = typeof EXTERNAL_PAPER_FIELDS[number];
export type ExternalPaperData = Omit<PaperData, 'organization'>;
export type ExternalLibraryKind = 'zotero-user' | 'zotero-group' | 'external';
export interface ExternalLibrarySource { kind: ExternalLibraryKind; key: string; name: string }
export interface ExternalLibrarySnapshot {
  format: 'paperquay-external-library'; version: 1; source: ExternalLibrarySource;
  items: { key: string; version: number; data: ExternalPaperData }[];
}
export interface ExternalLibraryMapping {
  itemKey: string; itemVersion: number; paperId: string; baseline: ExternalPaperData;
}
export interface ExternalLibraryRegistry {
  version: 1;
  sources: (ExternalLibrarySource & { id: string; mappings: ExternalLibraryMapping[] })[];
}
export type ExternalLibraryWarningCode =
  | 'UNSUPPORTED_FIELDS' | 'UNSUPPORTED_ITEM' | 'TAGS_OMITTED' | 'CHILDREN_OMITTED'
  | 'ATTACHMENTS_OMITTED' | 'CREATOR_ROLES_OMITTED' | 'AUTHOR_STRUCTURE_FLATTENED'
  | 'DATE_PARTS_OMITTED' | 'YEAR_OMITTED' | 'TYPE_OMITTED' | 'TEXT_MARKUP_PRESERVED';
export interface ExternalLibraryWarning { code: ExternalLibraryWarningCode; itemKey?: string; count?: number }
export type ExternalLibraryResolution = 'prefer-local' | 'prefer-source';
export type ExternalLibraryDecision =
  | { itemKey: string; action: 'skip' | 'copy' }
  | { itemKey: string; action: 'link'; paperId: string; resolution?: ExternalLibraryResolution }
  | { itemKey: string; action: 'import'; resolution?: ExternalLibraryResolution };
export type ExternalLibraryBlockedReason =
  | 'DUPLICATE_CHOICE_REQUIRED' | 'FIELD_CONFLICT' | 'SOURCE_VERSION_REUSED'
  | 'TARGET_MISSING' | 'TARGET_DELETED' | 'TARGET_PENDING' | 'TARGET_ALREADY_LINKED' | 'INVALID_LINK_TARGET';
export interface ExternalLibraryFieldDiff {
  field: ExternalPaperField;
  /** Null also represents a field absent because there is no baseline or local target. */
  base: string | string[] | null; local: string | string[] | null; source: string | string[] | null;
  result: string | string[] | null; conflict: boolean;
}
export interface ExternalLibraryImportRow {
  itemKey: string; itemVersion: number; title: string; mapped: boolean;
  action: 'create' | 'link' | 'update' | 'unchanged' | 'skip' | 'blocked';
  targetPaperId: string | null; blockedReason: ExternalLibraryBlockedReason | null;
  skipReason: 'USER_SKIP' | 'STALE_VERSION' | null; resolution: ExternalLibraryResolution | null;
  duplicates: { reason: 'doi' | 'exact-paper'; existingIds: string[]; itemKeys: string[] } | null;
  fields: ExternalLibraryFieldDiff[];
}
export interface ExternalLibrarySummary {
  items: number; newPapers: number; linkedPapers: number; updatedPapers: number;
  unchanged: number; skipped: number; stale: number; blocked: number; conflicts: number;
  duplicateRows: number; plannedWrites: number; newMappings: number;
}
export interface ExternalLibraryImportPlan {
  snapshot: ExternalLibrarySnapshot; registry: ExternalLibraryRegistry; decisions: ExternalLibraryDecision[];
  rows: ExternalLibraryImportRow[]; summary: ExternalLibrarySummary;
  /** Private content: compare only in memory inside the account transaction; never persist or log. */
  signature: string;
}
export type ExternalLibraryErrorCode =
  | 'INVALID_JSON' | 'UNSUPPORTED_FORMAT' | 'INVALID_SNAPSHOT' | 'SNAPSHOT_TOO_LARGE'
  | 'EMPTY_ZOTERO_SNAPSHOT' | 'CROSS_LIBRARY_SNAPSHOT' | 'INVALID_REGISTRY' | 'REGISTRY_TOO_LARGE'
  | 'INVALID_EXISTING_DATA' | 'INVALID_DECISION' | 'INVALID_PLAN' | 'BLOCKED_IMPORT'
  | 'INVALID_GENERATED_ID' | 'ID_ALLOCATION_FAILED';
export class ExternalLibraryError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(readonly code: ExternalLibraryErrorCode, issues: readonly ValidationIssue[] = []) {
    super(code); this.name = 'ExternalLibraryError';
    this.issues = issues.map(({ path, code: issueCode }) => ({ path, code: issueCode }));
  }
}

const uuid = new RegExp(UUID_PATTERN);
const keyPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';
const keySchema: JsonSchema = { type: 'string', pattern: keyPattern, maxLength: 128 };
const revisionSchema: JsonSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
  type: 'object', properties, required, additionalProperties: false,
});
const metadataSchema = object(Object.fromEntries(EXTERNAL_PAPER_FIELDS.map((field) => [field, ENTITY_DATA_SCHEMAS.paper.properties![field]])));
const sourceProperties: Record<string, JsonSchema> = {
  kind: { enum: ['zotero-user', 'zotero-group', 'external'] }, key: keySchema,
  name: { type: 'string', minLength: 1, maxLength: SYNC_LIMITS.maxNameLength },
};
const snapshotSchema = object({
  format: { const: 'paperquay-external-library' }, version: { const: 1 }, source: object(sourceProperties),
  items: { type: 'array', maxItems: EXTERNAL_LIBRARY_LIMITS.maxItems,
    items: object({ key: keySchema, version: revisionSchema, data: metadataSchema }) },
});
const registrySchema = object({
  version: { const: 1 }, sources: { type: 'array', maxItems: EXTERNAL_LIBRARY_LIMITS.maxSources, items: object({
    ...sourceProperties, id: { type: 'string', minLength: 1, maxLength: 160 },
    mappings: { type: 'array', maxItems: EXTERNAL_LIBRARY_LIMITS.maxMappings, items: object({
      itemKey: keySchema, itemVersion: revisionSchema, paperId: { type: 'string', pattern: UUID_PATTERN }, baseline: metadataSchema,
    }) },
  }) },
});
const resolutionSchema: JsonSchema = { enum: ['prefer-local', 'prefer-source'] };
const decisionSchema: JsonSchema = { oneOf: [
  object({ itemKey: keySchema, action: { enum: ['skip', 'copy'] } }),
  object({ itemKey: keySchema, action: { const: 'link' }, paperId: { type: 'string', pattern: UUID_PATTERN },
    resolution: resolutionSchema }, ['itemKey', 'action', 'paperId']),
  object({ itemKey: keySchema, action: { const: 'import' }, resolution: resolutionSchema }, ['itemKey', 'action']),
] };
const invalidControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const sourceId = (source: ExternalLibrarySource) => `${source.kind}:${source.key}`;
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function fail(code: ExternalLibraryErrorCode, path = '$', issue = 'INVALID_VALUE'): never {
  throw new ExternalLibraryError(code, [{ path, code: issue }]);
}
function checkBytes(text: string, maxBytes: number, code: ExternalLibraryErrorCode): void {
  if (text.length > maxBytes || new TextEncoder().encode(text).byteLength > maxBytes) throw new ExternalLibraryError(code);
}
function cleanText(value: string, code: ExternalLibraryErrorCode, path: string): void {
  if (invalidControls.test(value)) fail(code, path, 'INVALID_TEXT');
  try { encodeURIComponent(value); } catch { fail(code, path, 'INVALID_TEXT'); }
}
function checkSource(source: ExternalLibrarySource, code: ExternalLibraryErrorCode): void {
  cleanText(source.name, code, '$.source.name');
  if (!source.name.trim()) fail(code, '$.source.name', 'EMPTY_TEXT');
  if (source.kind !== 'external' && (!/^[1-9][0-9]{0,15}$/.test(source.key)
    || !Number.isSafeInteger(Number(source.key)))) fail(code, '$.source.key', 'INVALID_LIBRARY_KEY');
}
function checkItemKey(key: string, kind: ExternalLibraryKind, code: ExternalLibraryErrorCode): void {
  if (!new RegExp(keyPattern).test(key) || kind !== 'external' && !/^[A-Z0-9]{8}$/.test(key)) {
    fail(code, '$.items', 'INVALID_ITEM_KEY');
  }
}
function metadata(data: PaperData): ExternalPaperData {
  return Object.fromEntries(EXTERNAL_PAPER_FIELDS.map((field) => [field, clone(data[field])])) as unknown as ExternalPaperData;
}
function checkedMetadata(data: ExternalPaperData, code: ExternalLibraryErrorCode, path: string): ExternalPaperData {
  const result = metadata(data);
  if (!result.title.trim() || [...result.authors, ...result.keywords].some((value) => !value.trim())) fail(code, path, 'EMPTY_TEXT');
  for (const field of EXTERNAL_PAPER_FIELDS) {
    const values = Array.isArray(result[field]) ? result[field] as string[] : [result[field]];
    for (const value of values) if (value !== null) cleanText(value as string, code, `${path}.${field}`);
  }
  if (result.doi !== null) {
    try { result.doi = normalizeDoi(result.doi); } catch { fail(code, `${path}.doi`, 'INVALID_DOI'); }
  }
  return result;
}
function checkedSnapshot(value: unknown): ExternalLibrarySnapshot {
  const checked = validateJsonSchema<ExternalLibrarySnapshot>(snapshotSchema, value);
  if (!checked.ok) {
    const unsupported = checked.issues.some((issue) => (issue.path === '$.format' || issue.path === '$.version') && issue.code === 'INVALID_CONSTANT');
    throw new ExternalLibraryError(unsupported ? 'UNSUPPORTED_FORMAT' : 'INVALID_SNAPSHOT', checked.issues);
  }
  checkSource(checked.value.source, 'INVALID_SNAPSHOT');
  const keys = new Set<string>();
  const result: ExternalLibrarySnapshot = { format: 'paperquay-external-library', version: 1,
    source: clone(checked.value.source), items: checked.value.items.map((item, index) => {
      checkItemKey(item.key, checked.value.source.kind, 'INVALID_SNAPSHOT');
      if (keys.has(item.key)) fail('INVALID_SNAPSHOT', `$.items[${index}].key`, 'DUPLICATE_ITEM_KEY');
      keys.add(item.key);
      return { key: item.key, version: item.version, data: checkedMetadata(item.data, 'INVALID_SNAPSHOT', `$.items[${index}].data`) };
    }) };
  checkBytes(canonicalJson(result), EXTERNAL_LIBRARY_LIMITS.maxBytes, 'SNAPSHOT_TOO_LARGE');
  return result;
}

/** Strict, bounded local state. No paths, credentials, organization, or sync protocol state are accepted. */
export function validateExternalLibraryRegistry(value: unknown): ExternalLibraryRegistry {
  const checked = validateJsonSchema<ExternalLibraryRegistry>(registrySchema, value);
  if (!checked.ok) throw new ExternalLibraryError('INVALID_REGISTRY', checked.issues);
  const identities = new Set<string>(); const paperIds = new Set<string>(); let total = 0; let bytes = 0;
  const result: ExternalLibraryRegistry = { version: 1, sources: [] };
  for (const source of checked.value.sources) {
    checkSource(source, 'INVALID_REGISTRY');
    if (source.id !== sourceId(source) || identities.has(source.id)) fail('INVALID_REGISTRY', '$.sources', 'INVALID_SOURCE_ID');
    identities.add(source.id);
    total += source.mappings.length;
    if (total > EXTERNAL_LIBRARY_LIMITS.maxMappings) throw new ExternalLibraryError('REGISTRY_TOO_LARGE');
    const keys = new Set<string>();
    const mappings = source.mappings.map((mapping): ExternalLibraryMapping => {
      checkItemKey(mapping.itemKey, source.kind, 'INVALID_REGISTRY');
      if (keys.has(mapping.itemKey) || paperIds.has(mapping.paperId)) fail('INVALID_REGISTRY', '$.sources', 'DUPLICATE_MAPPING');
      keys.add(mapping.itemKey); paperIds.add(mapping.paperId);
      const result = { itemKey: mapping.itemKey, itemVersion: mapping.itemVersion, paperId: mapping.paperId,
        baseline: checkedMetadata(mapping.baseline, 'INVALID_REGISTRY', '$.sources.mappings.baseline') };
      bytes += new TextEncoder().encode(canonicalJson(result)).byteLength;
      if (bytes > EXTERNAL_LIBRARY_LIMITS.maxRegistryBytes) throw new ExternalLibraryError('REGISTRY_TOO_LARGE');
      return result;
    }).sort((left, right) => left.itemKey.localeCompare(right.itemKey, 'en'));
    result.sources.push({ id: source.id, kind: source.kind, key: source.key, name: source.name, mappings });
  }
  result.sources.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  checkBytes(canonicalJson(result), EXTERNAL_LIBRARY_LIMITS.maxRegistryBytes, 'REGISTRY_TOO_LARGE');
  return result;
}

function warning(warnings: ExternalLibraryWarning[], code: ExternalLibraryWarningCode, itemKey?: string, count?: number): void {
  const entry: ExternalLibraryWarning = { code };
  if (itemKey !== undefined) entry.itemKey = itemKey;
  if (count !== undefined) entry.count = count;
  warnings.push(entry);
}
function dataObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
}
function zoteroString(value: unknown, max: number, path: string, optional = true): string {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > max) return fail('INVALID_SNAPSHOT', path, 'INVALID_TEXT');
  cleanText(value, 'INVALID_SNAPSHOT', path);
  return value;
}
function parseZotero(value: unknown[]): { snapshot: ExternalLibrarySnapshot; warnings: ExternalLibraryWarning[] } {
  if (value.length === 0) throw new ExternalLibraryError('EMPTY_ZOTERO_SNAPSHOT');
  if (value.length > EXTERNAL_LIBRARY_LIMITS.maxItems) fail('INVALID_SNAPSHOT', '$', 'TOO_MANY_ITEMS');
  const warnings: ExternalLibraryWarning[] = []; const keys = new Set<string>();
  let source: ExternalLibrarySource | undefined;
  const items: ExternalLibrarySnapshot['items'] = [];
  for (let index = 0; index < value.length; index++) {
    const record = value[index]; const path = `$[${index}]`;
    if (!dataObject(record) || !dataObject(record.library) || !dataObject(record.data)) fail('INVALID_SNAPSHOT', path, 'INVALID_ZOTERO_RECORD');
    const library = record.library; const data = record.data;
    if ((library.type !== 'user' && library.type !== 'group') || !Number.isSafeInteger(library.id) || (library.id as number) <= 0) {
      fail('INVALID_SNAPSHOT', `${path}.library`, 'INVALID_LIBRARY');
    }
    const current: ExternalLibrarySource = { kind: library.type === 'user' ? 'zotero-user' : 'zotero-group', key: String(library.id),
      name: zoteroString(library.name, SYNC_LIMITS.maxNameLength, `${path}.library.name`) || `Zotero ${library.type} ${library.id}` };
    checkSource(current, 'INVALID_SNAPSHOT');
    if (source && sourceId(source) !== sourceId(current)) throw new ExternalLibraryError('CROSS_LIBRARY_SNAPSHOT');
    source ??= current;
    if (typeof record.key !== 'string') fail('INVALID_SNAPSHOT', `${path}.key`, 'INVALID_ITEM_KEY');
    checkItemKey(record.key, source.kind, 'INVALID_SNAPSHOT');
    if (keys.has(record.key)) fail('INVALID_SNAPSHOT', `${path}.key`, 'DUPLICATE_ITEM_KEY');
    keys.add(record.key);
    if (!Number.isSafeInteger(record.version) || (record.version as number) < 0
      || data.key !== undefined && data.key !== record.key || data.version !== undefined && data.version !== record.version) {
      fail('INVALID_SNAPSHOT', `${path}.version`, 'INVALID_ITEM_VERSION');
    }
    const key = record.key;
    const omittedRecord = Object.keys(record).filter((field) => !['key', 'version', 'library', 'data'].includes(field)).length
      + Object.keys(library).filter((field) => !['id', 'type', 'name'].includes(field)).length;
    if (omittedRecord) warning(warnings, 'UNSUPPORTED_FIELDS', key, omittedRecord);
    const itemType = zoteroString(data.itemType, 80, `${path}.data.itemType`, false);
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(itemType)) fail('INVALID_SNAPSHOT', `${path}.data.itemType`, 'INVALID_ITEM_TYPE');
    if (data.deleted !== undefined && ![false, true, 0, 1].includes(data.deleted as boolean)) fail('INVALID_SNAPSHOT', `${path}.data.deleted`);
    if (itemType === 'attachment') { warning(warnings, 'ATTACHMENTS_OMITTED', key, 1); continue; }
    if (data.parentItem !== undefined && data.parentItem !== false && data.parentItem !== null) {
      if (typeof data.parentItem !== 'string') fail('INVALID_SNAPSHOT', `${path}.data.parentItem`);
      checkItemKey(data.parentItem, source.kind, 'INVALID_SNAPSHOT');
      warning(warnings, 'CHILDREN_OMITTED', key, 1); continue;
    }
    if (itemType === 'note' || itemType === 'annotation' || data.deleted === 1 || data.deleted === true) {
      warning(warnings, 'UNSUPPORTED_ITEM', key, 1); continue;
    }
    warning(warnings, 'TYPE_OMITTED', key);
    if (data.tags !== undefined) warning(warnings, 'TAGS_OMITTED', key);
    if (data.children !== undefined || data.notes !== undefined) warning(warnings, 'CHILDREN_OMITTED', key);
    if (data.attachments !== undefined) warning(warnings, 'ATTACHMENTS_OMITTED', key);
    const accepted = new Set(['key', 'version', 'itemType', 'title', 'DOI', 'date', 'publicationTitle', 'bookTitle', 'proceedingsTitle',
      'abstractNote', 'creators', 'tags', 'children', 'notes', 'attachments', 'deleted', 'parentItem']);
    const unknownFields = Object.keys(data).filter((field) => !accepted.has(field)).length;
    if (unknownFields) warning(warnings, 'UNSUPPORTED_FIELDS', key, unknownFields);
    const creators = data.creators ?? [];
    if (!Array.isArray(creators) || creators.length > SYNC_LIMITS.maxAuthors) fail('INVALID_SNAPSHOT', `${path}.data.creators`, 'INVALID_CREATORS');
    const authors: string[] = [];
    for (const creator of creators) {
      if (!dataObject(creator)) fail('INVALID_SNAPSHOT', `${path}.data.creators`, 'INVALID_CREATOR');
      const role = zoteroString(creator.creatorType, 80, `${path}.data.creators.creatorType`, false);
      if (role !== 'author') { warning(warnings, 'CREATOR_ROLES_OMITTED', key); continue; }
      const name = zoteroString(creator.name, SYNC_LIMITS.maxNameLength, `${path}.data.creators.name`);
      const first = zoteroString(creator.firstName, SYNC_LIMITS.maxNameLength, `${path}.data.creators.firstName`);
      const last = zoteroString(creator.lastName, SYNC_LIMITS.maxNameLength, `${path}.data.creators.lastName`);
      if (name && (first || last)) fail('INVALID_SNAPSHOT', `${path}.data.creators`, 'AMBIGUOUS_CREATOR');
      const author = (name || `${first} ${last}`).trim();
      if (!author || author.length > SYNC_LIMITS.maxNameLength) fail('INVALID_SNAPSHOT', `${path}.data.creators`, 'INVALID_CREATOR');
      authors.push(author);
      if (Object.keys(creator).some((field) => !['name', 'firstName', 'lastName', 'creatorType'].includes(field))) warning(warnings, 'UNSUPPORTED_FIELDS', key);
    }
    if (authors.length) warning(warnings, 'AUTHOR_STRUCTURE_FLATTENED', key);
    const date = zoteroString(data.date, 512, `${path}.data.date`).trim();
    const years = date.match(/\b[0-9]{4}\b/g) ?? [];
    const year = years.length === 1 ? years[0] : null;
    if (date && year === null) warning(warnings, 'YEAR_OMITTED', key);
    else if (year !== null && date !== year) warning(warnings, 'DATE_PARTS_OMITTED', key);
    const publications = ['publicationTitle', 'bookTitle', 'proceedingsTitle']
      .map((field) => zoteroString(data[field], SYNC_LIMITS.maxTitleLength, `${path}.data.${field}`).trim()).filter(Boolean);
    if (publications.length > 1) warning(warnings, 'UNSUPPORTED_FIELDS', key, publications.length - 1);
    const doi = zoteroString(data.DOI, 2048, `${path}.data.DOI`).trim() || null;
    const metadata: ExternalPaperData = {
      title: zoteroString(data.title, SYNC_LIMITS.maxTitleLength, `${path}.data.title`, false).trim(), doi, year,
      publication: publications[0] ?? null,
      abstractText: zoteroString(data.abstractNote, SYNC_LIMITS.maxAbstractLength, `${path}.data.abstractNote`) || null,
      authors, keywords: [],
    };
    if ([metadata.title, metadata.abstractText ?? '', ...authors].some((text) => /<\/?[a-zA-Z][^>]*>/.test(text))) {
      warning(warnings, 'TEXT_MARKUP_PRESERVED', key);
    }
    items.push({ key, version: record.version as number, data: metadata });
  }
  return { snapshot: checkedSnapshot({ format: 'paperquay-external-library', version: 1, source, items }), warnings };
}

/** Parses a user-selected JSON file only; no network, credentials, file names, or paths are consulted. */
export function parseExternalLibrary(text: string): { snapshot: ExternalLibrarySnapshot; warnings: ExternalLibraryWarning[] } {
  if (typeof text !== 'string') throw new ExternalLibraryError('INVALID_JSON');
  checkBytes(text, EXTERNAL_LIBRARY_LIMITS.maxBytes, 'SNAPSHOT_TOO_LARGE');
  let depth = 0; let quoted = false; let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      if (++depth > EXTERNAL_LIBRARY_LIMITS.maxJsonDepth) fail('INVALID_SNAPSHOT', '$', 'MAX_DEPTH');
    } else if (character === '}' || character === ']') depth--;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ExternalLibraryError('INVALID_JSON'); }
  return Array.isArray(value) ? parseZotero(value) : { snapshot: checkedSnapshot(value), warnings: [] };
}

interface ExistingEntity extends Omit<VisibleEntity, 'data'> { data: PaperData | null }
function checkedExisting(values: readonly VisibleEntity[]): ExistingEntity[] {
  try {
    if (!Array.isArray(values) || values.length > SYNC_LIMITS.maxLocalEntities) throw new Error();
    const identities = new Set<string>(); const result: ExistingEntity[] = [];
    for (let index = 0; index < values.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(values, index);
      if (!descriptor || !('value' in descriptor) || !dataObject(descriptor.value)) throw new Error();
      const entity = descriptor.value;
      if (!ENTITY_TYPES.includes(entity.entityType as VisibleEntity['entityType']) || typeof entity.entityId !== 'string' || !uuid.test(entity.entityId)
        || typeof entity.deleted !== 'boolean' || typeof entity.pending !== 'boolean' || !Number.isSafeInteger(entity.revision) || (entity.revision as number) < 0
        || !['synced', 'queued', 'sending', 'uncertain', 'conflict', 'rejected', 'device-blocked', 'overlay'].includes(entity.status as string)) throw new Error();
      const key = `${entity.entityType}:${entity.entityId}`;
      if (identities.has(key)) throw new Error();
      identities.add(key);
      let data: PaperData | null = null;
      if (entity.entityType === 'paper' && !entity.deleted) {
        const checked = validateEntityData('paper', entity.data);
        if (!checked.ok) throw new Error();
        data = clone(checked.value);
      }
      result.push({ entityType: entity.entityType as VisibleEntity['entityType'], entityId: entity.entityId,
        revision: entity.revision as number, deleted: entity.deleted, pending: entity.pending, status: entity.status as VisibleEntity['status'], data });
    }
    return result.sort((left, right) => `${left.entityType}:${left.entityId}`.localeCompare(`${right.entityType}:${right.entityId}`, 'en'));
  } catch { throw new ExternalLibraryError('INVALID_EXISTING_DATA'); }
}
function fingerprint(data: PaperData): { key: string; reason: 'doi' | 'exact-paper' } {
  if (data.doi !== null) {
    try { return { key: `doi:${normalizeDoi(data.doi)}`, reason: 'doi' }; } catch { /* Existing unrecognized DOI uses exact metadata. */ }
  }
  return { key: `data:${canonicalJson(metadata(data))}`, reason: 'exact-paper' };
}
function checkedDecisions(value: readonly ExternalLibraryDecision[] | undefined, snapshot: ExternalLibrarySnapshot): ExternalLibraryDecision[] {
  const checked = validateJsonSchema<ExternalLibraryDecision[]>({ type: 'array', maxItems: EXTERNAL_LIBRARY_LIMITS.maxItems, items: decisionSchema }, value ?? []);
  if (!checked.ok) throw new ExternalLibraryError('INVALID_DECISION', checked.issues);
  const keys = new Set(snapshot.items.map((item) => item.key)); const used = new Set<string>();
  for (const decision of checked.value) {
    if (!keys.has(decision.itemKey) || used.has(decision.itemKey)) fail('INVALID_DECISION', '$', 'INVALID_ITEM_KEY');
    used.add(decision.itemKey);
  }
  return clone(checked.value).sort((left, right) => left.itemKey.localeCompare(right.itemKey, 'en'));
}
function fieldDiffs(source: ExternalPaperData, local: PaperData | null, base: ExternalPaperData | null,
  resolution: ExternalLibraryResolution | null): ExternalLibraryFieldDiff[] {
  return EXTERNAL_PAPER_FIELDS.map((field) => {
    const incoming = source[field]; const current = local?.[field] ?? null; const previous = base?.[field] ?? null;
    const conflict = local !== null && !equal(current, incoming) && (base === null || !equal(current, previous) && !equal(incoming, previous));
    const result = local === null ? incoming : equal(current, incoming) ? current
      : base !== null && equal(current, previous) ? incoming
        : base !== null && equal(incoming, previous) ? current
          : resolution === 'prefer-source' ? incoming : current;
    return { field, base: clone(previous), local: clone(current), source: clone(incoming), result: clone(result), conflict };
  });
}
function resultingData(row: ExternalLibraryImportRow, local: PaperData | null): PaperData {
  const data = Object.fromEntries(row.fields.map((field) => [field.field, clone(field.result)])) as unknown as PaperData;
  if (local?.organization !== undefined) data.organization = clone(local.organization);
  return data;
}
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freezeTree); Object.freeze(value); }
  return value;
}
interface PlanInternals { existing: ExistingEntity[]; occupiedIds: ReadonlySet<string> }
const plans = new WeakMap<ExternalLibraryImportPlan, PlanInternals>();

/** Rebuild using current entities and registry inside the account transaction, then compare the reviewed signature. */
export function planExternalLibraryImport(snapshot: ExternalLibrarySnapshot, registry: ExternalLibraryRegistry | undefined,
  entities: readonly VisibleEntity[], decisions?: readonly ExternalLibraryDecision[]): ExternalLibraryImportPlan {
  const source = checkedSnapshot(snapshot);
  const savedRegistry = validateExternalLibraryRegistry(registry ?? { version: 1, sources: [] });
  const saved = checkedExisting(entities); const choices = checkedDecisions(decisions, source);
  const selectedSource = savedRegistry.sources.find((entry) => entry.id === sourceId(source.source));
  const mappings = new Map(selectedSource?.mappings.map((mapping) => [mapping.itemKey, mapping]) ?? []);
  const papers = saved.filter((entity) => entity.entityType === 'paper');
  const byId = new Map(papers.map((entity) => [entity.entityId, entity]));
  const choiceByKey = new Map(choices.map((decision) => [decision.itemKey, decision]));
  const owners = new Map(savedRegistry.sources.flatMap((entry) => entry.mappings.map((mapping) => [mapping.paperId, `${entry.id}:${mapping.itemKey}`] as const)));
  const activeFingerprints = new Map<string, string[]>(); const incomingFingerprints = new Map<string, string[]>();
  const add = (index: Map<string, string[]>, key: string, id: string) => {
    const values = index.get(key);
    if (values) values.push(id); else index.set(key, [id]);
  };
  for (const paper of papers) if (!paper.deleted) add(activeFingerprints, fingerprint(paper.data!).key, paper.entityId);
  for (const item of source.items) add(incomingFingerprints, fingerprint(item.data).key, item.key);
  const rows: ExternalLibraryImportRow[] = source.items.map((item) => {
    const mapping = mappings.get(item.key); const choice = choiceByKey.get(item.key);
    if (mapping && (choice?.action === 'copy' || choice?.action === 'link')) fail('INVALID_DECISION', '$', 'MAPPED_ITEM_CANNOT_RELINK');
    const resolution = choice && 'resolution' in choice ? choice.resolution ?? null : null;
    const targetId = mapping?.paperId ?? (choice?.action === 'link' ? choice.paperId : null);
    const target = targetId ? byId.get(targetId) : undefined;
    const identity = fingerprint(item.data);
    const existingIds = activeFingerprints.get(identity.key) ?? [];
    const itemKeys = (incomingFingerprints.get(identity.key) ?? []).filter((key) => key !== item.key);
    const duplicates = existingIds.length || itemKeys.length ? { reason: identity.reason, existingIds: [...existingIds], itemKeys } : null;
    const row: ExternalLibraryImportRow = { itemKey: item.key, itemVersion: item.version, title: item.data.title,
      mapped: mapping !== undefined, action: 'create', targetPaperId: targetId, blockedReason: null, skipReason: null, resolution, duplicates,
      fields: fieldDiffs(item.data, target?.data ?? null, mapping?.baseline ?? null, resolution) };
    const block = (reason: ExternalLibraryBlockedReason) => { row.action = 'blocked'; row.blockedReason = reason; return row; };
    if (choice?.action === 'skip') { row.action = 'skip'; row.skipReason = 'USER_SKIP'; return row; }
    if (mapping && item.version < mapping.itemVersion) { row.action = 'skip'; row.skipReason = 'STALE_VERSION'; return row; }
    if (mapping && item.version === mapping.itemVersion && !equal(item.data, mapping.baseline)) return block('SOURCE_VERSION_REUSED');
    if (targetId !== null) {
      if (!target) return block('TARGET_MISSING');
      if (target.deleted) return block('TARGET_DELETED');
      if (target.pending || target.status !== 'synced') return block('TARGET_PENDING');
      const owner = owners.get(targetId);
      if (owner !== undefined && owner !== `${sourceId(source.source)}:${item.key}`) return block('TARGET_ALREADY_LINKED');
      if (!mapping && !existingIds.includes(targetId)) return block('INVALID_LINK_TARGET');
      if (row.fields.some((field) => field.conflict) && resolution === null) return block('FIELD_CONFLICT');
      row.action = !mapping ? 'link' : equal(resultingData(row, target.data), target.data) ? 'unchanged' : 'update';
      return row;
    }
    if (duplicates && choice?.action !== 'copy') return block('DUPLICATE_CHOICE_REQUIRED');
    return row;
  });
  const claims = new Map<string, ExternalLibraryImportRow[]>();
  for (const row of rows) if (row.action === 'link' && row.targetPaperId !== null) claims.set(row.targetPaperId, [...(claims.get(row.targetPaperId) ?? []), row]);
  for (const claimed of claims.values()) if (claimed.length > 1) for (const row of claimed) { row.action = 'blocked'; row.blockedReason = 'TARGET_ALREADY_LINKED'; }
  const accepted = rows.filter((row) => row.action !== 'skip' && row.action !== 'blocked');
  const summary: ExternalLibrarySummary = {
    items: rows.length, newPapers: rows.filter((row) => row.action === 'create').length,
    linkedPapers: rows.filter((row) => row.action === 'link').length, updatedPapers: rows.filter((row) => row.action === 'update').length,
    unchanged: rows.filter((row) => row.action === 'unchanged').length, skipped: rows.filter((row) => row.action === 'skip').length,
    stale: rows.filter((row) => row.skipReason === 'STALE_VERSION').length, blocked: rows.filter((row) => row.action === 'blocked').length,
    conflicts: rows.filter((row) => row.fields.some((field) => field.conflict)).length, duplicateRows: rows.filter((row) => row.duplicates !== null).length,
    plannedWrites: accepted.filter((row) => row.targetPaperId === null || !equal(resultingData(row, byId.get(row.targetPaperId)!.data), byId.get(row.targetPaperId)!.data)).length,
    newMappings: accepted.filter((row) => !row.mapped).length,
  };
  if ((!selectedSource && accepted.length && savedRegistry.sources.length >= EXTERNAL_LIBRARY_LIMITS.maxSources)
    || savedRegistry.sources.reduce((count, entry) => count + entry.mappings.length, 0) + summary.newMappings > EXTERNAL_LIBRARY_LIMITS.maxMappings) {
    throw new ExternalLibraryError('REGISTRY_TOO_LARGE');
  }
  const signature = canonicalJson({ snapshot: source, registry: savedRegistry, decisions: choices, rows, summary, existing: saved });
  const plan = freezeTree({ snapshot: source, registry: savedRegistry, decisions: choices, rows, summary, signature });
  plans.set(plan, { existing: saved, occupiedIds: new Set([...saved.map((entity) => entity.entityId), ...owners.keys()]) });
  return plan;
}

/** Pure materialization. A caller must compare a freshly rebuilt transaction plan with the reviewed signature first. */
export function materializeExternalLibraryImport(plan: ExternalLibraryImportPlan, allocateId: () => string): {
  edits: LocalEdit[]; newRegistry: ExternalLibraryRegistry; summary: ExternalLibrarySummary;
} {
  const internal = plans.get(plan);
  if (!internal) throw new ExternalLibraryError('INVALID_PLAN');
  if (plan.summary.blocked) throw new ExternalLibraryError('BLOCKED_IMPORT');
  if (typeof allocateId !== 'function') throw new ExternalLibraryError('INVALID_GENERATED_ID');
  const occupied = new Set(internal.occupiedIds); const newRegistry = clone(plan.registry);
  const accepted = plan.rows.filter((row) => row.action !== 'skip');
  if (!accepted.length) return { edits: [], newRegistry, summary: { ...plan.summary } };
  let source = newRegistry.sources.find((entry) => entry.id === sourceId(plan.snapshot.source));
  if (!source) { source = { ...clone(plan.snapshot.source), id: sourceId(plan.snapshot.source), mappings: [] }; newRegistry.sources.push(source); }
  source.name = plan.snapshot.source.name;
  const items = new Map(plan.snapshot.items.map((item) => [item.key, item]));
  const existing = new Map(internal.existing.filter((entity) => entity.entityType === 'paper').map((entity) => [entity.entityId, entity]));
  const edits: LocalEdit[] = [];
  for (const row of accepted) {
    let paperId = row.targetPaperId;
    if (paperId === null) {
      for (let attempt = 0; attempt < EXTERNAL_LIBRARY_LIMITS.maxIdAttempts; attempt++) {
        let candidate: unknown;
        try { candidate = allocateId(); } catch { throw new ExternalLibraryError('ID_ALLOCATION_FAILED'); }
        if (typeof candidate !== 'string' || !uuid.test(candidate)) throw new ExternalLibraryError('INVALID_GENERATED_ID');
        if (!occupied.has(candidate)) { paperId = candidate; occupied.add(candidate); break; }
      }
      if (paperId === null) throw new ExternalLibraryError('ID_ALLOCATION_FAILED');
    }
    const local = existing.get(paperId)?.data ?? null;
    const data = resultingData(row, local);
    if (!validateEntityData('paper', data).ok) throw new ExternalLibraryError('INVALID_PLAN');
    if (local === null || !equal(local, data)) edits.push({ entityType: 'paper', entityId: paperId, mutation: 'put', data });
    const item = items.get(row.itemKey)!;
    const mapping: ExternalLibraryMapping = { itemKey: item.key, itemVersion: item.version, paperId, baseline: clone(item.data) };
    const index = source.mappings.findIndex((previous) => previous.itemKey === item.key);
    if (index < 0) source.mappings.push(mapping); else source.mappings[index] = mapping;
  }
  return { edits, newRegistry: validateExternalLibraryRegistry(newRegistry), summary: { ...plan.summary } };
}
