import { isPlainObject, SYNC_LIMITS, validateEntityData, type PaperData } from '../../../../packages/sync-core/src/index.ts';
import type { LibraryArchive } from './libraryTransfer.ts';

export type DoiLookupErrorCode =
  | 'INVALID_DOI' | 'INVALID_OPTIONS' | 'ABORTED' | 'TIMEOUT' | 'NETWORK_FAILED'
  | 'NOT_FOUND' | 'RATE_LIMITED' | 'SERVICE_UNAVAILABLE' | 'HTTP_ERROR'
  | 'RESPONSE_TOO_LARGE' | 'INVALID_RESPONSE' | 'DOI_MISMATCH' | 'METADATA_LIMIT' | 'MISSING_TITLE';
export class DoiLookupError extends Error {
  readonly code: DoiLookupErrorCode;
  constructor(code: DoiLookupErrorCode) {
    super(code);
    this.name = 'DoiLookupError';
    this.code = code;
  }
}
export type DoiLookupWarningCode =
  | 'TITLE_ALTERNATIVES_OMITTED' | 'SUBTITLE_OMITTED' | 'TEXT_FORMATTING_REMOVED'
  | 'AUTHORS_MISSING' | 'AUTHORS_INCOMPLETE' | 'AFFILIATIONS_OMITTED'
  | 'YEAR_MISSING' | 'YEAR_INVALID' | 'YEAR_FALLBACK' | 'YEAR_CONFLICT'
  | 'PUBLICATION_MISSING' | 'PUBLICATION_ALTERNATIVES_OMITTED'
  | 'ABSTRACT_MISSING' | 'ABSTRACT_UNSUPPORTED' | 'SUBJECTS_AS_KEYWORDS' | 'ADDITIONAL_METADATA_OMITTED';
export interface DoiLookupWarning {
  code: DoiLookupWarningCode;
  field?: 'title' | 'authors' | 'year' | 'publication' | 'abstractText' | 'keywords';
}
const YEAR_FIELDS = ['issued', 'published', 'published-print', 'published-online'] as const;
type YearField = typeof YEAR_FIELDS[number];
export interface DoiLookupResult {
  archive: LibraryArchive;
  source: { provider: 'Crossref'; doi: string; apiUrl: string; doiUrl: string; yearField: YearField | null };
  warnings: DoiLookupWarning[];
}
export interface DoiLookupOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  timeout?: number;
}
export const DOI_LOOKUP_LIMITS = Object.freeze({
  maxInputLength: 4096,
  maxDoiLength: 2048,
  maxResponseBytes: 1024 * 1024,
  maxResponseChunks: 4096,
  maxJsonDepth: 32,
  maxTextAlternatives: 32,
  timeout: 10_000,
  maxTimeout: 30_000,
});

const fail = (code: DoiLookupErrorCode): never => { throw new DoiLookupError(code); };
const invisibleDoi = /[\s\p{Cc}\p{Cf}\\]/u;

/** Normalize an identifier; resolver links are parsed as text and are never fetched. */
export function normalizeDoi(input: string): string {
  if (typeof input !== 'string' || input.length > DOI_LOOKUP_LIMITS.maxInputLength) return fail('INVALID_DOI');
  let doi = input.trim();
  if (/^doi:/i.test(doi)) doi = doi.slice(4).trim();
  if (/^https?:/i.test(doi)) {
    // Inspect the raw authority: URL would silently erase explicit default ports and dot segments.
    const match = /^https?:\/\/(?:dx\.)?doi\.org\/([^?#\\]*)$/i.exec(doi);
    if (!match) return fail('INVALID_DOI');
    try { doi = decodeURIComponent(match[1]); } catch { return fail('INVALID_DOI'); }
    if (doi.split('/').some((part) => part === '.' || part === '..')) return fail('INVALID_DOI');
  }
  if (doi.length > DOI_LOOKUP_LIMITS.maxDoiLength || invisibleDoi.test(doi)
    || !/^10\.\d{4,9}\/.+$/u.test(doi)) return fail('INVALID_DOI');
  try { encodeURIComponent(doi); } catch { return fail('INVALID_DOI'); }
  return doi.toLowerCase();
}

class UnsupportedText extends Error {}
const controlText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const blockTags = new Set(['abstract', 'p', 'sec', 'title', 'list', 'list-item', 'disp-quote']);
const inlineTags = new Set(['bold', 'italic', 'b', 'i', 'em', 'strong', 'underline', 'sc', 'sup', 'sub',
  'ext-link', 'xref', 'styled-content', 'named-content']);
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeText(value: string): string {
  const decoded = value.replace(/&(#([^;\s&<>]*)|[a-z][a-z0-9]*);/gi, (_token, entity: string) => {
    if (Object.hasOwn(entities, entity)) return entities[entity];
    if (!/^#(?:x[0-9a-f]+|\d+)$/iu.test(entity)) throw new UnsupportedText();
    const number = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(number) || number < 1 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) {
      throw new UnsupportedText();
    }
    return String.fromCodePoint(number);
  });
  if (controlText.test(decoded)) throw new UnsupportedText();
  try { encodeURIComponent(decoded); } catch { throw new UnsupportedText(); }
  return decoded;
}

/** A bounded text-only JATS fragment reader. It does not instantiate a DOM or resolve entities/URLs. */
function plainText(raw: string, multiline: boolean): { text: string; formatted: boolean } {
  let output = '';
  let formatted = false;
  const stack: string[] = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== '<' || !/[A-Za-z/!?]/u.test(raw[index + 1] ?? '')) {
      let end = index + 1;
      while (end < raw.length && !(raw[end] === '<' && /[A-Za-z/!?]/u.test(raw[end + 1] ?? ''))) end += 1;
      const chunk = raw.slice(index, end);
      const decoded = decodeText(chunk);
      formatted ||= decoded !== chunk;
      output += decoded;
      index = end;
      continue;
    }
    let quote = '';
    let end = index + 1;
    for (; end < raw.length; end += 1) {
      const char = raw[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      if (end - index > 8192) throw new UnsupportedText();
    }
    if (end === raw.length || quote) throw new UnsupportedText();
    const token = raw.slice(index + 1, end);
    const closing = token.startsWith('/');
    const selfClosing = token.endsWith('/');
    const content = token.slice(closing ? 1 : 0, selfClosing ? -1 : undefined);
    const match = /^([A-Za-z][A-Za-z0-9:._-]*)([\s\S]*)$/u.exec(content);
    if (!match || closing && selfClosing) throw new UnsupportedText();
    const fullTag = match[1];
    const tag = fullTag.startsWith('jats:') ? fullTag.slice(5) : fullTag;
    if (tag.includes(':') || !blockTags.has(tag) && !inlineTags.has(tag) && tag !== 'break' && tag !== 'br') {
      throw new UnsupportedText();
    }
    let attributes = match[2];
    if (closing && attributes.trim()) throw new UnsupportedText();
    while (attributes.trim()) {
      const attribute = /^\s+[A-Za-z_:][A-Za-z0-9:._-]*\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/u.exec(attributes);
      if (!attribute) throw new UnsupportedText();
      decodeText(attribute[1] ?? attribute[2]);
      attributes = attributes.slice(attribute[0].length);
    }
    if (closing) {
      if (stack.pop() !== fullTag) throw new UnsupportedText();
      if (tag === 'sup' || tag === 'sub') output += '}';
    } else if (!selfClosing && tag !== 'br' && tag !== 'break') {
      if (stack.length >= DOI_LOOKUP_LIMITS.maxJsonDepth) throw new UnsupportedText();
      stack.push(fullTag);
      if (tag === 'sup' || tag === 'sub') output += tag === 'sup' ? '^{' : '_{';
    }
    if (blockTags.has(tag) || tag === 'break' || tag === 'br') output += '\n';
    formatted = true;
    index = end + 1;
  }
  if (stack.length) throw new UnsupportedText();
  const text = multiline
    ? output.replace(/\r\n?/gu, '\n').replace(/[^\S\n]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
    : output.replace(/\s+/gu, ' ').trim();
  return { text, formatted };
}

function parseJson(text: string): unknown {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (++depth > DOI_LOOKUP_LIMITS.maxJsonDepth) return fail('INVALID_RESPONSE');
    } else if (char === '}' || char === ']') depth -= 1;
  }
  try { return JSON.parse(text); } catch { return fail('INVALID_RESPONSE'); }
}

function yearOf(value: unknown): string | null {
  if (!isPlainObject(value) || !Array.isArray(value['date-parts']) || value['date-parts'].length !== 1) return null;
  const parts: unknown = value['date-parts'][0];
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 3 || !parts.every(Number.isInteger)) return null;
  const [year, month, day] = parts as number[];
  if (year < 1 || year > 9999 || month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day < 1 || day > days[month - 1]) return null;
  }
  return String(year);
}

function mapWork(value: unknown, doi: string, apiUrl: string): DoiLookupResult {
  if (!isPlainObject(value) || value.status !== 'ok' || value['message-type'] !== 'work'
    || typeof value['message-version'] !== 'string' || !/^1\.\d{1,4}\.\d{1,4}$/u.test(value['message-version'])
    || !isPlainObject(value.message)) return fail('INVALID_RESPONSE');
  return mapCrossrefWork(value.message, doi, apiUrl);
}

/** Shared strict work mapping for exact DOI responses and explicitly selected title candidates. */
export function mapCrossrefWork(input: unknown, doi: string, apiUrl: string): DoiLookupResult {
  if (!isPlainObject(input)) return fail('INVALID_RESPONSE');
  const work = input;
  if (typeof work.DOI !== 'string') return fail('INVALID_RESPONSE');
  let returnedDoi: string;
  try { returnedDoi = normalizeDoi(work.DOI); } catch { return fail('INVALID_RESPONSE'); }
  if (returnedDoi !== doi) return fail('DOI_MISMATCH');
  const warnings: DoiLookupWarning[] = [];
  const warn = (code: DoiLookupWarningCode, field?: DoiLookupWarning['field']) => {
    if (!warnings.some((warning) => warning.code === code && warning.field === field)) warnings.push(field ? { code, field } : { code });
  };
  const text = (value: unknown, limit: number, field: NonNullable<DoiLookupWarning['field']>): string | null => {
    if (typeof value !== 'string') return fail('INVALID_RESPONSE');
    if (value.length > limit * 4) return fail('METADATA_LIMIT');
    let result: ReturnType<typeof plainText>;
    try { result = plainText(value, field === 'abstractText'); } catch (error) {
      if (!(error instanceof UnsupportedText)) throw error;
      if (field !== 'abstractText') return fail('INVALID_RESPONSE');
      warn('ABSTRACT_UNSUPPORTED', field);
      return null;
    }
    if (result.text.length > limit) return fail('METADATA_LIMIT');
    if (result.formatted) warn('TEXT_FORMATTING_REMOVED', field);
    return result.text;
  };
  const alternatives = (value: unknown, limit: number): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return fail('INVALID_RESPONSE');
    if (value.length > DOI_LOOKUP_LIMITS.maxTextAlternatives) return fail('METADATA_LIMIT');
    return value.map((item) => {
      if (typeof item !== 'string') return fail('INVALID_RESPONSE');
      if (item.length > limit * 4) return fail('METADATA_LIMIT');
      return item;
    }).filter((item) => item.trim());
  };
  const titles = alternatives(work.title, SYNC_LIMITS.maxTitleLength);
  if (!titles.length) return fail('MISSING_TITLE');
  const title = text(titles[0], SYNC_LIMITS.maxTitleLength, 'title');
  if (!title) return fail('MISSING_TITLE');
  if (titles.length > 1) warn('TITLE_ALTERNATIVES_OMITTED', 'title');
  if (alternatives(work.subtitle, SYNC_LIMITS.maxTitleLength).length) warn('SUBTITLE_OMITTED', 'title');
  const publications = alternatives(work['container-title'], 2048);
  const publication = publications.length ? text(publications[0], 2048, 'publication') || null : null;
  if (!publication) warn('PUBLICATION_MISSING', 'publication');
  if (publications.length > 1) warn('PUBLICATION_ALTERNATIVES_OMITTED', 'publication');

  const authors: string[] = [];
  if (work.author !== undefined) {
    if (!Array.isArray(work.author)) return fail('INVALID_RESPONSE');
    if (work.author.length > SYNC_LIMITS.maxAuthors) return fail('METADATA_LIMIT');
    for (const author of work.author) {
      if (!isPlainObject(author)) return fail('INVALID_RESPONSE');
      const part = (key: string) => author[key] === undefined ? '' : text(author[key], SYNC_LIMITS.maxNameLength, 'authors') ?? '';
      const name = part('name');
      const given = part('given');
      const family = part('family');
      const suffix = part('suffix');
      if (author.affiliation !== undefined && (!Array.isArray(author.affiliation) || author.affiliation.length)) warn('AFFILIATIONS_OMITTED', 'authors');
      if (author.ORCID !== undefined) warn('ADDITIONAL_METADATA_OMITTED');
      if (name && (given || family || suffix) || !name && !given && !family) { warn('AUTHORS_INCOMPLETE', 'authors'); continue; }
      if (!name && (!given || !family)) warn('AUTHORS_INCOMPLETE', 'authors');
      const fullName = name || [given, family, suffix].filter(Boolean).join(' ');
      if (fullName.length > SYNC_LIMITS.maxNameLength) return fail('METADATA_LIMIT');
      authors.push(fullName);
    }
  }
  if (!authors.length) warn('AUTHORS_MISSING', 'authors');

  const dates: { field: YearField; year: string }[] = [];
  for (const field of YEAR_FIELDS) {
    if (work[field] === undefined) continue;
    const year = yearOf(work[field]);
    if (year) dates.push({ field, year }); else warn('YEAR_INVALID', 'year');
  }
  const date = dates[0];
  if (!date) warn('YEAR_MISSING', 'year');
  else if (date.field !== 'issued') warn('YEAR_FALLBACK', 'year');
  if (new Set(dates.map((entry) => entry.year)).size > 1) warn('YEAR_CONFLICT', 'year');
  let abstractText: string | null = null;
  if (work.abstract === undefined || work.abstract === null || work.abstract === '') warn('ABSTRACT_MISSING', 'abstractText');
  else abstractText = text(work.abstract, SYNC_LIMITS.maxAbstractLength, 'abstractText');
  if (abstractText === '') { abstractText = null; warn('ABSTRACT_MISSING', 'abstractText'); }
  const keywords: string[] = [];
  if (work.subject !== undefined) {
    if (!Array.isArray(work.subject)) return fail('INVALID_RESPONSE');
    if (work.subject.length > SYNC_LIMITS.maxKeywords) return fail('METADATA_LIMIT');
    for (const subject of work.subject) {
      const keyword = text(subject, SYNC_LIMITS.maxNameLength, 'keywords');
      if (keyword) keywords.push(keyword);
    }
  }
  if (keywords.length) warn('SUBJECTS_AS_KEYWORDS', 'keywords');
  const omitted = ['volume', 'issue', 'page', 'article-number', 'type', 'URL', 'link', 'publisher', 'publisher-location',
    'ISBN', 'ISSN', 'editor', 'chair', 'translator', 'funder', 'license', 'reference', 'relation', 'institution', 'archive',
    'alternative-id', 'original-title', 'short-title', 'short-container-title', 'update-to', 'degree', 'event', 'group-title',
    'number', 'standards-body', 'resource'];
  if (omitted.some((key) => work[key] !== undefined && work[key] !== null)) warn('ADDITIONAL_METADATA_OMITTED');
  const data: PaperData = { title, doi, year: date?.year ?? null, publication, abstractText, authors, keywords };
  if (!validateEntityData('paper', data).ok) return fail('INVALID_RESPONSE');
  return { archive: { format: 'paperquay-library', version: 1, papers: [{ ref: 'p1', data }], notes: [] },
    source: { provider: 'Crossref', doi, apiUrl, doiUrl: `https://doi.org/${encodeURIComponent(doi)}`, yearField: date?.field ?? null }, warnings };
}

function discardBody(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* No response content is retained on failure. */ }
}

/** Explicit lookup only: returns a preview archive and never writes to account or library state. */
export async function lookupDoi(input: string, options: DoiLookupOptions = {}): Promise<DoiLookupResult> {
  const doi = normalizeDoi(input);
  if (!isPlainObject(options as unknown)) return fail('INVALID_OPTIONS');
  const timeout = options.timeout === undefined ? DOI_LOOKUP_LIMITS.timeout : options.timeout;
  const fetcher = options.fetch === undefined ? globalThis.fetch : options.fetch;
  const signal = options.signal;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > DOI_LOOKUP_LIMITS.maxTimeout || typeof fetcher !== 'function'
    || signal !== undefined && (signal === null || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) return fail('INVALID_OPTIONS');
  if (signal?.aborted) return fail('ABORTED');
  const apiUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const controller = new AbortController();
  let stopped: DoiLookupError | null = null;
  let rejectStop: (error: DoiLookupError) => void = () => {};
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  // A custom transport can synchronously abort and throw before the first race attaches.
  void stop.catch(() => {});
  const cancel = (code: 'ABORTED' | 'TIMEOUT') => {
    if (stopped) return;
    stopped = new DoiLookupError(code);
    controller.abort();
    rejectStop(stopped);
  };
  const onAbort = () => cancel('ABORTED');
  signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = Date.now() + timeout;
  const timer = setTimeout(() => cancel('TIMEOUT'), timeout);
  const waitFor = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, stop]);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let fullyRead = false;
  try {
    const pending = Promise.resolve(fetcher(apiUrl, { method: 'GET', signal: controller.signal, credentials: 'omit',
      redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' }));
    void pending.then((late) => { if (stopped) discardBody(late); }, () => {});
    response = await waitFor(pending);
    if (response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect' || response.type === 'error'
      || response.url && response.url !== apiUrl) return fail('INVALID_RESPONSE');
    if (response.status === 404) return fail('NOT_FOUND');
    if (response.status === 429) return fail('RATE_LIMITED');
    if (response.status >= 500) return fail('SERVICE_UNAVAILABLE');
    if (response.status !== 200) return fail('HTTP_ERROR');
    const mediaType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json' && mediaType !== 'application/vnd.crossref-api-message+json') return fail('INVALID_RESPONSE');
    const size = response.headers.get('Content-Length');
    if (size && /^\d+$/u.test(size) && Number(size) > DOI_LOOKUP_LIMITS.maxResponseBytes) return fail('RESPONSE_TOO_LARGE');
    if (!response.body) return fail('INVALID_RESPONSE');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (let count = 0; ; count += 1) {
      const part = await waitFor(reader.read());
      if (part.done) { fullyRead = true; break; }
      if (!(part.value instanceof Uint8Array)) return fail('INVALID_RESPONSE');
      bytes += part.value.byteLength;
      if (count >= DOI_LOOKUP_LIMITS.maxResponseChunks || bytes > DOI_LOOKUP_LIMITS.maxResponseBytes) return fail('RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    let json: string;
    try { json = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return fail('INVALID_RESPONSE'); }
    const result = mapWork(parseJson(json), doi, apiUrl);
    if (signal?.aborted) return fail('ABORTED');
    if (stopped) throw stopped;
    if (Date.now() >= deadline) return fail('TIMEOUT');
    return result;
  } catch (error) {
    if (stopped) throw stopped;
    if (error instanceof DoiLookupError) throw error;
    return fail('NETWORK_FAILED');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (reader) {
      if (!fullyRead) { try { void reader.cancel().catch(() => {}); } catch { /* Cancellation must not wait for the network. */ } }
      try { reader.releaseLock(); } catch { /* A transport may still have an outstanding read. */ }
    } else if (response) discardBody(response);
  }
}

export { parseJson as parseCrossrefJson, mapWork as mapCrossrefDoiResponse };
