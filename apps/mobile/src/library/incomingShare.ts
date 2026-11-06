import { assertIncomingShareCurrent, IncomingShareError, validateIncomingShareItem,
  type IncomingShareItem, type IncomingShareOptions } from '../platform/incomingShare.ts';
import { parseLibraryArchive, type LibraryArchive } from './libraryTransfer.ts';
import { parseBibliography, type BibliographyFormat, type BibliographyWarning } from './bibliographyTransfer.ts';
import { normalizeDoi } from './doiLookup.ts';

export type IncomingShareUnsupportedReason = 'MULTIPLE_DOIS' | 'MANUAL_REVIEW_REQUIRED' | 'INVALID_FORMAT';
export interface PreparedSource {
  readonly id: string; readonly digest: string; readonly kind: 'doi' | 'archive' | 'unsupported';
  readonly sourceName: string; readonly sourceText?: string; readonly doi?: string; readonly archive?: LibraryArchive;
  readonly warnings?: readonly BibliographyWarning[]; readonly reason?: IncomingShareUnsupportedReason;
}
const prepared = new WeakSet<object>();
export function isPreparedIncomingShareSource(value: unknown): value is PreparedSource {
  return !!value && typeof value === 'object' && prepared.has(value);
}
export function assertPreparedIncomingShareSource(value: unknown): PreparedSource {
  if (!isPreparedIncomingShareSource(value)) throw new IncomingShareError('INVALID');
  return value;
}
function freeze<T>(value: T): T {
  const queue: unknown[] = [value];
  while (queue.length) {
    const next = queue.pop();
    if (next && typeof next === 'object' && !Object.isFrozen(next)) {
      queue.push(...Object.values(next)); Object.freeze(next);
    }
  }
  return value;
}
/** The receipt digest binds the complete immutable transport item, including
 * metadata. Renaming/retyping/replacing the same ID cannot reuse its receipt. */
async function digestItem(item: IncomingShareItem, options: IncomingShareOptions): Promise<string> {
  assertIncomingShareCurrent(options);
  let bytes: ArrayBuffer;
  try {
    bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(item)));
  } catch {
    assertIncomingShareCurrent(options); throw new IncomingShareError('CRYPTO_UNAVAILABLE');
  }
  assertIncomingShareCurrent(options);
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== 32) throw new IncomingShareError('CRYPTO_UNAVAILABLE');
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function doiCandidate(text: string): { doi?: string; reason: IncomingShareUnsupportedReason } {
  const trimmed = text.trim(); let candidate = trimmed;
  if (/^https?:/i.test(trimmed)) {
    // Raw-authority match rejects credentials, ports, lookalike hosts, query,
    // fragments and dot-segment normalization. This never opens the URL.
    const match = /^https?:\/\/(?:dx\.)?doi\.org\/([^?#\\]*)$/i.exec(trimmed);
    if (!match) return { reason: 'MANUAL_REVIEW_REQUIRED' };
    try { candidate = decodeURIComponent(match[1]); } catch { return { reason: 'MANUAL_REVIEW_REQUIRED' }; }
  }
  if ((candidate.match(/10\.\d{4,9}\//gi)?.length ?? 0) > 1 || (trimmed.match(/10\.\d{4,9}\//gi)?.length ?? 0) > 1)
    return { reason: 'MULTIPLE_DOIS' };
  if (!/^10\.\d{4,9}\//i.test(candidate) || candidate.split('/').some(part => part === '.' || part === '..')) return { reason: 'MANUAL_REVIEW_REQUIRED' };
  try { return { doi: normalizeDoi(/^https?:/i.test(trimmed) ? trimmed : candidate), reason: 'MANUAL_REVIEW_REQUIRED' }; }
  catch { return { reason: 'MANUAL_REVIEW_REQUIRED' }; }
}
function checkArchiveStrings(archive: LibraryArchive): void {
  const queue: unknown[] = [archive];
  while (queue.length) {
    const next = queue.pop();
    if (typeof next === 'string' && (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(next)
      || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(next))) throw new IncomingShareError('INVALID');
    if (next && typeof next === 'object') queue.push(...Object.values(next));
  }
}
/** Validate/hash only after an explicit user preview action. Parsing is purely
 * local. Unsupported text stays available for manual checking, never auto-picked
 * as a DOI or silently converted from a damaged structured archive. */
export async function prepareIncomingShareSource(value: IncomingShareItem, options: IncomingShareOptions = {}): Promise<PreparedSource> {
  assertIncomingShareCurrent(options);
  const item = validateIncomingShareItem(value), digest = await digestItem(item, options);
  assertIncomingShareCurrent(options);
  const base = { id: item.id, digest, sourceName: item.name, sourceText: item.text };
  let result: PreparedSource;
  const media = item.mediaType;
  const format: BibliographyFormat | undefined = media === 'application/x-bibtex' ? 'bibtex'
    : media === 'application/x-research-info-systems' ? 'ris'
      : media === 'text/plain' && item.kind === 'file' ? /\.(bib|bibtex)$/i.test(item.name) ? 'bibtex' : /\.ris$/i.test(item.name) ? 'ris' : undefined : undefined;
  const markdown = media === 'text/markdown' || media === 'text/plain' && item.kind === 'file' && /\.(md|markdown)$/i.test(item.name);
  const json = media === 'application/json' || media === 'text/plain' && item.kind === 'file' && /\.json$/i.test(item.name);
  if (format || markdown || json) {
    try {
      const bibliography = format ? parseBibliography(item.text, format) : null;
      const archive = bibliography?.archive ?? (markdown ? parseLibraryArchive(JSON.stringify({ format: 'paperquay-library', version: 1, papers: [], notes: [
        { ref: 'n1', paperRef: null, title: item.name.replace(/\.(md|markdown)$/i, '').slice(0, 2048) || '导入笔记', body: item.text, format: 'markdown' },
      ] })) : parseLibraryArchive(item.text));
      // JSON escaping cannot smuggle invalid Unicode/controls into an otherwise
      // valid UTF-8 transport string, including legacy Markdown envelopes.
      checkArchiveStrings(archive);
      result = { ...base, kind: 'archive', archive, ...(bibliography ? { warnings: bibliography.warnings } : {}) };
    } catch { result = { ...base, kind: 'unsupported', reason: 'INVALID_FORMAT' }; }
  } else {
    const candidate = doiCandidate(item.text);
    result = candidate.doi ? { ...base, kind: 'doi', doi: candidate.doi } : { ...base, kind: 'unsupported', reason: candidate.reason };
  }
  assertIncomingShareCurrent(options);
  freeze(result); prepared.add(result); return result;
}
