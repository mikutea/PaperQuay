import { AI_ACTION_LABELS, citedPages, prepareAiContext } from './context.ts';
import { canonicalAiEndpoint, parseAiProvider } from './provider.ts';
import type { PdfAiContext } from './sourceTypes.ts';
import { AI_LIMITS,AI_REMOTE_ERROR_CODES, type AiAction, type AiErrorCode, type AiFailure, type AiResult, type AiSourceSummary, type AiUsage, type PreparedAiContext } from './types.ts';

export const AI_ARCHIVE_LIMITS = Object.freeze({
  recordBytes: 1_048_576, templateBytes: 16_384, accountBytes: 16_777_216, records: 50, templates: 100,
});
export type AiArchiveErrorCode = 'INVALID_ITEM' | 'RECORD_LIMIT' | 'ARCHIVE_FULL' | 'ARCHIVE_CORRUPT' | 'ARCHIVE_UNAVAILABLE' | 'ITEM_CHANGED' | 'ACCOUNT_CHANGED';
export class AiArchiveError extends Error {
  readonly code: AiArchiveErrorCode;
  constructor(code: AiArchiveErrorCode) { super(code); this.name = 'AiArchiveError'; this.code = code; }
}
export type AiArchiveTerminalStatus = Exclude<AiResult['status'], 'running'>;
export interface AiArchiveProvider { id: string; endpoint: string; model: string }
interface ArchiveBase { version: 1; id: string; revision: number; createdAt: string; updatedAt: string }
export interface AiHistoryRecord extends ArchiveBase {
  kind: 'record'; revision: 1;
  context: PdfAiContext; action: AiAction; question: string; provider: AiArchiveProvider;
  result: { text: string; status: AiArchiveTerminalStatus; finishReason: string | null; usage: AiUsage | null; cost: 'unknown'; failure: AiFailure | null };
}
export interface AiQuestionTemplate extends ArchiveBase { kind: 'template'; title: string; action: AiAction; question: string }
export type AiArchiveItem = AiHistoryRecord | AiQuestionTemplate;
export interface AiArchiveSummary {
  kind: AiArchiveItem['kind']; id: string; revision: number; createdAt: string; updatedAt: string; title: string;
  status?: AiArchiveTerminalStatus; paperId?: string; attachmentVersionId?: string; sha256?: string;
}

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ACTIONS: readonly string[] = ['explain', 'translate', 'ask', 'rewrite', 'summarize'];
const TERMINAL: readonly string[] = ['complete', 'incomplete', 'cancelled', 'failed'];
const FAILURE_CODES: readonly AiErrorCode[] = [
  'CONFIG_INVALID', 'KEY_MISSING', 'KEY_INVALID', 'SECRET_STORAGE_FAILED', 'CONTEXT_MISSING', 'CONTEXT_INVALID', 'CONTEXT_TOO_LARGE', 'TEXT_MISSING',
  'QUESTION_REQUIRED', 'INPUT_TOO_LARGE', 'AUTHENTICATION_FAILED', 'ACCESS_DENIED', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'MODEL_OR_REQUEST_REJECTED',
  'ENDPOINT_NOT_FOUND', 'PROVIDER_UNAVAILABLE', 'NETWORK_OR_CORS', 'REDIRECT_BLOCKED', 'TIMEOUT', 'IDLE_TIMEOUT', 'CANCELLED', 'STREAM_INTERRUPTED',
  'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'OUTPUT_LIMIT', 'OUTPUT_TRUNCATED', 'CONTENT_FILTERED', 'UNSUPPORTED_RESPONSE', 'SETTINGS_STORAGE_FAILED', 'CONVERSATION_LIMIT',
];
function fail(code: AiArchiveErrorCode = 'INVALID_ITEM'): never { throw new AiArchiveError(code); }
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}

/** The public boundary accepts plain JSON data, not getters, custom serializers,
 * cycles or arrays with hidden properties. Imported byte limits remain store-owned. */
function inspect(value: unknown, optionalUndefined: readonly string[] = []): void {
  const ancestors = new Set<object>(); let nodes = 0, characters = 0;
  const walk = (input: unknown, depth: number): void => {
    if (++nodes > 1_000_000 || depth > 20) fail('RECORD_LIMIT');
    if (typeof input === 'string') {
      characters += input.length;
      if (characters > AI_ARCHIVE_LIMITS.recordBytes * 2) fail('RECORD_LIMIT');
      return;
    }
    if (input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return;
    if (!input || typeof input !== 'object' || ancestors.has(input)) fail();
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype) fail();
    if (array && input.length > 1_000_000) fail('RECORD_LIMIT');
    const keys = Reflect.ownKeys(input); let items = 0;
    ancestors.add(input);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) fail();
      // Builder options are not stored JSON; explicit optional undefined is the
      // same as omission. Archive DTOs never use this exception.
      if (descriptor.value === undefined && depth === 0 && optionalUndefined.includes(key)) continue;
      walk(descriptor.value, depth + 1); items++;
    }
    if (array && items !== input.length) fail();
    ancestors.delete(input);
  };
  walk(value, 0);
}
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const raw = value as Record<string, unknown>;
  if (required.some((key) => !own(raw, key)) || Object.keys(raw).some((key) => !required.includes(key) && !optional.includes(key))) fail();
  return raw;
}
function string(value: unknown, maximum: number, minimum = 0): string {
  if (typeof value !== 'string' || value.length < minimum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail();
  if (value.length > maximum) fail('RECORD_LIMIT');
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index); if (!(low >= 0xdc00 && low <= 0xdfff)) fail();
    } else if (code >= 0xdc00 && code <= 0xdfff) fail();
  }
  return value;
}
function bytes(value: unknown, maximum: number): string {
  const result = string(value, maximum);
  if (encoder.encode(result).byteLength > maximum) fail('RECORD_LIMIT');
  return result;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value; }
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) fail(); return value; }
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail();
  try { if (new Date(value).toISOString() !== value) fail(); } catch { fail(); }
  return value;
}
function action(value: unknown): AiAction { if (!ACTIONS.includes(value as string)) fail(); return value as AiAction; }
function status(value: unknown): AiArchiveTerminalStatus { if (!TERMINAL.includes(value as string)) fail(); return value as AiArchiveTerminalStatus; }
function textSource(value: unknown): NonNullable<PdfAiContext['textSource']> {
  const raw = object(value, ['kind', 'packageDigest', 'parserName', 'parserModel']);
  const model = string(raw.parserModel, 128, 1);
  if (raw.kind !== 'parsed-document' || raw.parserName !== 'mineru' || !model.trim()) fail();
  return { kind: 'parsed-document', packageDigest: hash(raw.packageDigest), parserName: 'mineru', parserModel: model };
}
function context(value: unknown): PdfAiContext {
  const raw = object(value, ['paperId', 'attachmentVersionId', 'sha256', 'scope', 'totalPages', 'pages', 'complete', 'label'], ['textSource']);
  uuid(raw.paperId); uuid(raw.attachmentVersionId); hash(raw.sha256); string(raw.label, 512);
  if (!['selection', 'page', 'document'].includes(raw.scope as string) || typeof raw.complete !== 'boolean') fail();
  const totalPages = integer(raw.totalPages, 1, AI_LIMITS.pages);
  if (!Array.isArray(raw.pages) || !raw.pages.length || raw.pages.length > AI_LIMITS.pages) fail();
  let totalBytes = 0;
  for (const entry of raw.pages) {
    const page = object(entry, ['pageIndex', 'text'], ['anchor']);
    integer(page.pageIndex, 0, totalPages - 1);
    totalBytes += encoder.encode(bytes(page.text, AI_LIMITS.contextBytes)).byteLength;
    if (totalBytes > AI_LIMITS.contextBytes) fail('RECORD_LIMIT');
    if (own(page, 'anchor')) {
      const anchor = object(page.anchor, ['pageIndex', 'coordinateSpace', 'quads', 'quote']);
      if (anchor.pageIndex !== page.pageIndex || anchor.coordinateSpace !== 'pdf-crop-box-unrotated-normalized'
        || !Array.isArray(anchor.quads) || anchor.quads.length > 200) fail();
      for (const quad of anchor.quads) {
        if (!Array.isArray(quad) || quad.length !== 8 || quad.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) fail();
      }
      if (anchor.quote !== null) {
        const quote = object(anchor.quote, ['exact', 'prefix', 'suffix']);
        for (const key of ['exact', 'prefix', 'suffix']) bytes(quote[key], AI_LIMITS.contextBytes);
      }
    }
  }
  if (own(raw, 'textSource')) textSource(raw.textSource);
  try {
    // This normalizes page order, coordinates and quote=null exactly as request preparation does.
    return prepareAiContext(value as PdfAiContext).source;
  } catch { return fail(); }
}
function provider(value: unknown): AiArchiveProvider {
  const raw = object(value, ['id', 'endpoint', 'model']);
  try {
    const parsed = parseAiProvider({ version: 1, id: raw.id, endpoint: raw.endpoint, model: raw.model,
      stream: false, includeUsage: false, requiresKey: true, maxOutputTokens: 2048, tokenParameter: 'max_completion_tokens' }, true);
    return { id: parsed.id, endpoint: canonicalAiEndpoint(parsed.endpoint), model: parsed.model };
  } catch { return fail(); }
}
function usage(value: unknown): AiUsage | null {
  if (value === null) return null;
  const raw = object(value, ['promptTokens', 'completionTokens', 'totalTokens']);
  const promptTokens = integer(raw.promptTokens, 0, 1_000_000_000), completionTokens = integer(raw.completionTokens, 0, 1_000_000_000);
  const totalTokens = integer(raw.totalTokens, 0, 1_000_000_000);
  if (totalTokens !== promptTokens + completionTokens) fail();
  return { promptTokens, completionTokens, totalTokens };
}
function failure(value: unknown): AiFailure | null {
  if (value === null) return null;
  const raw = object(value, ['code'], ['retryAfterSeconds']);
  if (!FAILURE_CODES.includes(raw.code as AiErrorCode)) fail();
  return { code: raw.code as AiErrorCode, ...(own(raw, 'retryAfterSeconds') ? { retryAfterSeconds: integer(raw.retryAfterSeconds, 0, 3600) } : {}) };
}
/** Archive/sync v1 retains its original error enum. Detailed routing errors stay in the private invocation ledger. */
function capturedFailure(value:unknown):AiFailure|null{if(value===null)return null;const raw=object(value,['code'],['retryAfterSeconds']);return failure(AI_REMOTE_ERROR_CODES.includes(raw.code as typeof AI_REMOTE_ERROR_CODES[number])?{...raw,code:'PROVIDER_UNAVAILABLE'}:raw);}
function result(value: unknown): AiHistoryRecord['result'] {
  const raw = object(value, ['text', 'status', 'finishReason', 'usage', 'cost', 'failure']);
  const terminal = status(raw.status), text = bytes(raw.text, AI_LIMITS.outputBytes);
  if (raw.cost !== 'unknown' || terminal === 'complete' && !text.trim()) fail();
  return { text, status: terminal, finishReason: raw.finishReason === null ? null : string(raw.finishReason, 128),
    usage: usage(raw.usage), cost: 'unknown', failure: failure(raw.failure) };
}
function size<T extends AiArchiveItem>(value: T): T {
  const limit = value.kind === 'record' ? AI_ARCHIVE_LIMITS.recordBytes : AI_ARCHIVE_LIMITS.templateBytes;
  if (encoder.encode(JSON.stringify(value)).byteLength > limit) fail('RECORD_LIMIT');
  return value;
}
function titlePrefix(value: string): string {
  const title = value.slice(0, 512), last = title.charCodeAt(title.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? title.slice(0, -1) : title;
}
function validate(value: unknown): AiArchiveItem {
  inspect(value);
  const kind = (value as Record<string, unknown> | null)?.kind;
  const base = ['kind', 'version', 'id', 'revision', 'createdAt', 'updatedAt'];
  const raw = object(value, [...base, ...(kind === 'record' ? ['context', 'action', 'question', 'provider', 'result'] : kind === 'template' ? ['title', 'action', 'question'] : [])]);
  if (!['record', 'template'].includes(raw.kind as string) || raw.version !== 1) fail();
  const id = uuid(raw.id), revision = integer(raw.revision, 1), createdAt = timestamp(raw.createdAt), updatedAt = timestamp(raw.updatedAt);
  if (updatedAt < createdAt) fail();
  const selectedAction = action(raw.action), question = bytes(raw.question, AI_LIMITS.questionBytes);
  if (kind === 'record') {
    if (revision !== 1) fail();
    return size({ kind, version: 1, id, revision: 1, createdAt, updatedAt,
      context: context(raw.context), action: selectedAction, question, provider: provider(raw.provider), result: result(raw.result) });
  }
  const title = string(raw.title, 128, 1);
  if (!title.trim() || !question.trim()) fail();
  return size({ kind: 'template', version: 1, id, revision, createdAt, updatedAt, title, action: selectedAction, question });
}

/** Synchronous, detached, fixed-key-order canonical data. */
export function validateAiArchiveItem(value: unknown): AiArchiveItem {
  try { return validate(value); } catch (error) { if (error instanceof AiArchiveError) throw error; return fail(); }
}
function summary(prepared: PreparedAiContext): AiSourceSummary {
  return { paperId: prepared.source.paperId, attachmentVersionId: prepared.source.attachmentVersionId, sha256: prepared.source.sha256,
    label: prepared.source.label, scope: prepared.source.scope, scopeLabel: prepared.scopeLabel, pageIndices: [...prepared.pageIndices],
    characters: prepared.characters, completeDocument: prepared.completeDocument,
    ...(prepared.source.textSource ? { textSource: { ...prepared.source.textSource } } : {}) };
}
function checkedSource(value: unknown): AiSourceSummary {
  const raw = object(value, ['paperId', 'attachmentVersionId', 'sha256', 'label', 'scope', 'scopeLabel', 'pageIndices', 'characters', 'completeDocument'], ['textSource']);
  if (!['selection', 'page', 'document'].includes(raw.scope as string) || typeof raw.completeDocument !== 'boolean' || !Array.isArray(raw.pageIndices)
    || !raw.pageIndices.length || raw.pageIndices.length > AI_LIMITS.pages) fail();
  return { paperId: uuid(raw.paperId), attachmentVersionId: uuid(raw.attachmentVersionId), sha256: hash(raw.sha256), label: string(raw.label, 512),
    scope: raw.scope as PdfAiContext['scope'], scopeLabel: string(raw.scopeLabel, 128), pageIndices: raw.pageIndices.map((page) => integer(page, 0, AI_LIMITS.pages - 1)),
    characters: integer(raw.characters, 1, AI_LIMITS.contextBytes), completeDocument: raw.completeDocument,
    ...(own(raw, 'textSource') ? { textSource: textSource(raw.textSource) } : {}) };
}

export function createAiHistoryRecord(input: PdfAiContext, captured: AiResult): AiHistoryRecord {
  try {
    inspect(input); inspect(captured);
    const raw = object(captured, ['requestId', 'action', 'model', 'source', 'text', 'status', 'finishReason', 'usage', 'cost', 'failure',
      'citations', 'unverifiedPageNumbers', 'question', 'provider', 'contextIdentity', 'startedAt', 'finishedAt']);
    const normalized = context(input), prepared = prepareAiContext(normalized);
    if (raw.contextIdentity !== prepared.identity || JSON.stringify(checkedSource(raw.source)) !== JSON.stringify(summary(prepared))) fail('ITEM_CHANGED');
    const publicProvider = provider(raw.provider);
    if (raw.model !== publicProvider.model) fail();
    // Source summaries and citations are derived for display, never duplicated in the archive DTO.
    const item = validateAiArchiveItem({ kind: 'record', version: 1, id: raw.requestId, revision: 1,
      createdAt: raw.startedAt, updatedAt: raw.finishedAt, context: normalized, action: raw.action, question: raw.question, provider: publicProvider,
      result: { text: raw.text, status: raw.status, finishReason: raw.finishReason, usage: raw.usage, cost: raw.cost, failure: capturedFailure(raw.failure) } });
    if (item.kind !== 'record') fail();
    return item;
  } catch (error) { if (error instanceof AiArchiveError) throw error; return fail(); }
}

export function createAiQuestionTemplate(input: { id: string; title: string; action: AiAction; question: string },
  options: { previous?: AiQuestionTemplate; now?: string } = {}): AiQuestionTemplate {
  try {
    inspect(input); inspect(options, ['previous', 'now']);
    object(input, ['id', 'title', 'action', 'question']); object(options, [], ['previous', 'now']);
    const at = timestamp(options.now ?? new Date().toISOString());
    const previous = options.previous === undefined ? undefined : validateAiArchiveItem(options.previous);
    if (previous && (previous.kind !== 'template' || previous.id !== input.id || at <= previous.updatedAt || previous.revision === Number.MAX_SAFE_INTEGER)) fail('ITEM_CHANGED');
    const item = validateAiArchiveItem({ kind: 'template', version: 1, id: input.id, revision: previous ? previous.revision + 1 : 1,
      createdAt: previous?.createdAt ?? at, updatedAt: at, title: input.title, action: input.action, question: input.question });
    if (item.kind !== 'template') fail();
    return item;
  } catch (error) { if (error instanceof AiArchiveError) throw error; return fail(); }
}

export function deriveAiHistoryResult(input: AiHistoryRecord): AiResult {
  const item = validateAiArchiveItem(input);
  if (item.kind !== 'record') fail();
  const prepared = prepareAiContext(item.context);
  return { requestId: item.id, action: item.action, model: item.provider.model, source: summary(prepared),
    text: item.result.text, status: item.result.status, finishReason: item.result.finishReason, usage: item.result.usage,
    cost: 'unknown', failure: item.result.failure, question: item.question, provider: { ...item.provider }, contextIdentity: prepared.identity,
    startedAt: item.createdAt, finishedAt: item.updatedAt, ...citedPages(item.result.text, prepared, item.id) };
}

export function summarizeAiArchiveItem(input: AiArchiveItem): AiArchiveSummary {
  const item = validateAiArchiveItem(input);
  const common = { kind: item.kind, id: item.id, revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt };
  return item.kind === 'template' ? { ...common, title: item.title } : { ...common,
    title: titlePrefix(AI_ACTION_LABELS[item.action] + ' · ' + item.context.label), status: item.result.status,
    paperId: item.context.paperId, attachmentVersionId: item.context.attachmentVersionId, sha256: item.context.sha256 };
}

/** Metadata-only checks for list paths; content/summary agreement is verified on read. */
export function validateAiArchiveSummary(value: unknown): AiArchiveSummary {
  try {
    inspect(value);
    const kind = (value as Record<string, unknown> | null)?.kind;
    const raw = object(value, ['kind', 'id', 'revision', 'createdAt', 'updatedAt', 'title',
      ...(kind === 'record' ? ['status', 'paperId', 'attachmentVersionId', 'sha256'] : [])]);
    if (kind !== 'record' && kind !== 'template') fail();
    const createdAt = timestamp(raw.createdAt), updatedAt = timestamp(raw.updatedAt), title = string(raw.title, kind === 'record' ? 512 : 128, 1);
    const revision = integer(raw.revision, 1);
    if (updatedAt < createdAt || !title.trim() || kind === 'record' && revision !== 1) fail();
    return { kind, id: uuid(raw.id), revision, createdAt, updatedAt, title,
      ...(kind === 'record' ? { status: status(raw.status), paperId: uuid(raw.paperId), attachmentVersionId: uuid(raw.attachmentVersionId), sha256: hash(raw.sha256) } : {}) };
  } catch (error) { if (error instanceof AiArchiveError) throw error; return fail(); }
}
