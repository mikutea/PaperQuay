import { canonicalJson } from '../../../../packages/sync-core/src/validation.ts';
import { assertIncomingShareCurrent, type IncomingShareOptions } from '../platform/incomingShare.ts';
import { assertPreparedIncomingShareSource, type PreparedSource } from './incomingShare.ts';
import { parseLibraryArchive, LIBRARY_TRANSFER_LIMITS, type LibraryArchive, type LibraryImportSummary } from './libraryTransfer.ts';
import { normalizeDoi } from './doiLookup.ts';

export const INCOMING_RECEIPT_LIMIT = 1024;
export class IncomingReceiptError extends Error {
  constructor(readonly code: 'INVALID' | 'CHANGED' | 'FULL' | 'CRYPTO_UNAVAILABLE') { super(code); this.name = 'IncomingReceiptError'; }
}
export interface IncomingImportReceipt {
  sourceId: string; sourceDigest: string; requestDigest: string; summary: LibraryImportSummary;
}
export interface PreparedIncomingImport {
  readonly sourceId: string; readonly sourceDigest: string; readonly requestDigest: string;
  readonly archive: LibraryArchive; readonly selection: readonly string[] | null;
}
export interface IncomingImportOptions extends IncomingShareOptions {
  /** Only for unsupported sources: the single DOI explicitly checked by the
   * user and actually looked up by the caller. It must match the only paper. */
  manualDoi?: string;
}
const prepared = new WeakSet<object>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const fail = (code: IncomingReceiptError['code'] = 'INVALID'): never => { throw new IncomingReceiptError(code); };
function current(options: IncomingShareOptions): void { try { assertIncomingShareCurrent(options); } catch { fail('CHANGED'); } }
function source(value: PreparedSource): PreparedSource { try { return assertPreparedIncomingShareSource(value); } catch { return fail(); } }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    const own = Reflect.ownKeys(value), result: Record<string, unknown> = {};
    if (own.length !== keys.length) return fail();
    for (const key of own) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !keys.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) return fail();
      result[key] = descriptor.value;
    }
    return result;
  } catch { return fail(); }
}
function array(value: unknown, maximum: number): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return fail();
    const keys = Reflect.ownKeys(value), result: unknown[] = [];
    if (keys.length !== length + 1) return fail();
    for (const key of keys) {
      if (key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length
        || !descriptor?.enumerable || !('value' in descriptor)) return fail();
      result[Number(key)] = descriptor.value;
    }
    return result;
  } catch { return fail(); }
}
/** Descriptor-only bounded JSON clone before canonical serialization. Hidden or
 * symbol fields must not disappear and become a different accepted request. */
function jsonSnapshot(value: unknown): unknown {
  const ancestors = new Set<object>(); let characters = 0;
  const add = (amount: number) => { if ((characters += amount) > LIBRARY_TRANSFER_LIMITS.maxBytes) fail(); };
  const copy = (next: unknown, depth: number): unknown => {
    if (depth > 40) return fail();
    if (next === null || typeof next === 'boolean' || typeof next === 'string' || typeof next === 'number' && Number.isFinite(next)) {
      add(JSON.stringify(next).length); return next;
    }
    if (!next || typeof next !== 'object' || ancestors.has(next)) return fail();
    const list = Array.isArray(next);
    if (list ? Object.getPrototypeOf(next) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(next))) return fail();
    ancestors.add(next); add(2); const values: unknown[] = [], result: Record<string, unknown> = {}; let count = 0;
    for (const key of Reflect.ownKeys(next)) {
      if (list && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(next, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor) || key === '__proto__'
        || list && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= next.length)) return fail();
      if (count++) add(1); if (!list) add(JSON.stringify(key).length + 1);
      const child = copy(descriptor.value, depth + 1); if (list) values[Number(key)] = child; else result[key] = child;
    }
    if (list && count !== next.length) return fail();
    ancestors.delete(next); return list ? values : result;
  };
  return copy(value, 0);
}
function archiveSnapshot(value: LibraryArchive): LibraryArchive {
  try { return parseLibraryArchive(canonicalJson(jsonSnapshot(value))); } catch { return fail(); }
}
function selectionSnapshot(selection: readonly string[] | undefined, archive: LibraryArchive): string[] | null {
  if (selection === undefined) return null;
  const values = array(selection, LIBRARY_TRANSFER_LIMITS.maxItems * 4);
  const keys = new Set([...archive.papers.map(paper => `paper:${paper.ref}`), ...archive.notes.map(note => `note:${note.ref}`)]);
  if (values.some(value => typeof value !== 'string' || !keys.has(value))) return fail();
  return [...new Set(values as string[])].sort();
}
function singleDoi(value: unknown): string {
  if (typeof value !== 'string') return fail();
  try {
    const doi = normalizeDoi(value);
    if ((doi.match(/10\.\d{4,9}\//gi)?.length ?? 0) !== 1 || doi.split('/').some(part => part === '.' || part === '..')) return fail();
    return doi;
  } catch { return fail(); }
}
function compatible(value: PreparedSource, archive: LibraryArchive, options: IncomingImportOptions): void {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(options, 'manualDoi'); } catch { return fail(); }
  if (descriptor && !('value' in descriptor)) fail();
  const manualDoi: unknown = descriptor?.value;
  if (value.kind === 'archive') {
    if (manualDoi !== undefined || !value.archive || canonicalJson(value.archive) !== canonicalJson(archive)) fail();
    return;
  }
  if (archive.papers.length !== 1 || archive.notes.length !== 0 || archive.exportReport !== undefined) fail();
  const expected = value.kind === 'doi'
    ? manualDoi === undefined ? singleDoi(value.doi) : fail()
    : singleDoi(manualDoi);
  if (singleDoi(archive.papers[0].data.doi) !== expected) fail();
}
function freeze<T>(value: T): T {
  const queue: unknown[] = [value];
  while (queue.length) { const next = queue.pop(); if (next && typeof next === 'object' && !Object.isFrozen(next)) { queue.push(...Object.values(next)); Object.freeze(next); } }
  return value;
}
export function assertPreparedIncomingImport(value: unknown): PreparedIncomingImport {
  if (!value || typeof value !== 'object' || !prepared.has(value)) return fail();
  return value as PreparedIncomingImport;
}

/** Request identity uses the caller's raw selection (undefined is null), never
 * current duplicate/default-selection state. Root must find a receipt inside
 * the same account transaction before calculating a new import plan. */
export async function prepareIncomingImport(value: PreparedSource, archive: LibraryArchive, selection?: readonly string[],
  options: IncomingImportOptions = {}): Promise<PreparedIncomingImport> {
  current(options); const original = source(value), snapshot = archiveSnapshot(archive), selected = selectionSnapshot(selection, snapshot);
  compatible(original, snapshot, options);
  const request = canonicalJson({ archive: snapshot, selection: selected });
  let bytes: ArrayBuffer;
  try { bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(request)); }
  catch { current(options); return fail('CRYPTO_UNAVAILABLE'); }
  current(options);
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== 32) return fail('CRYPTO_UNAVAILABLE');
  // A live form/array mutated while hashing must not silently commit the older
  // snapshot after the UI has moved to different content or choices.
  try {
    const after = archiveSnapshot(archive); compatible(original, after, options);
    if (canonicalJson({ archive: after, selection: selectionSnapshot(selection, after) }) !== request) fail('CHANGED');
  } catch { return fail('CHANGED'); }
  current(options);
  const result: PreparedIncomingImport = { sourceId: original.id, sourceDigest: original.digest,
    requestDigest: [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''), archive: snapshot, selection: selected };
  freeze(result); prepared.add(result); return result;
}

const summaryFields = ['papers', 'notes', 'selectedPapers', 'selectedNotes', 'duplicatePapers', 'duplicateNotes', 'blockedNotes', 'selectedBlockedNotes', 'skipped'] as const;
function summary(value: unknown): LibraryImportSummary {
  const raw = object(value, summaryFields);
  if (summaryFields.some(key => !Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) return fail();
  const result = Object.fromEntries(summaryFields.map(key => [key, raw[key]])) as unknown as LibraryImportSummary;
  if (result.papers > LIBRARY_TRANSFER_LIMITS.maxPapers || result.notes > LIBRARY_TRANSFER_LIMITS.maxNotes
    || result.papers + result.notes > LIBRARY_TRANSFER_LIMITS.maxItems || result.selectedPapers > result.papers || result.selectedNotes > result.notes
    || result.duplicatePapers > result.papers || result.duplicateNotes > result.notes || result.blockedNotes > result.notes || result.selectedNotes > result.notes - result.blockedNotes
    || result.selectedBlockedNotes !== 0 || result.selectedPapers + result.selectedNotes < 1
    || result.skipped !== result.papers + result.notes - result.selectedPapers - result.selectedNotes) return fail();
  return result;
}
function summaryForRequest(value: LibraryImportSummary, request: Pick<PreparedIncomingImport, 'archive' | 'selection'>): void {
  if (value.papers !== request.archive.papers.length || value.notes !== request.archive.notes.length) fail();
  if (request.selection !== null && (value.selectedPapers !== request.selection.filter(key => key.startsWith('paper:')).length
    || value.selectedNotes !== request.selection.filter(key => key.startsWith('note:')).length)) fail();
}
export function validateIncomingReceipts(value: unknown): IncomingImportReceipt[] {
  return array(value, INCOMING_RECEIPT_LIMIT).map(entry => {
    const raw = object(entry, ['sourceId', 'sourceDigest', 'requestDigest', 'summary']);
    if (typeof raw.sourceId !== 'string' || !uuid.test(raw.sourceId) || typeof raw.sourceDigest !== 'string' || !hash.test(raw.sourceDigest)
      || typeof raw.requestDigest !== 'string' || !hash.test(raw.requestDigest)) return fail();
    return { sourceId: raw.sourceId, sourceDigest: raw.sourceDigest, requestDigest: raw.requestDigest, summary: summary(raw.summary) };
  }).map((entry, index, all) => { if (all.findIndex(other => other.sourceId === entry.sourceId) !== index) fail(); return entry; });
}
export function findIncomingReceipt(receipts: unknown, value: PreparedIncomingImport): LibraryImportSummary | null {
  const request = assertPreparedIncomingImport(value), receipt = validateIncomingReceipts(receipts).find(entry => entry.sourceId === request.sourceId);
  if (!receipt) return null;
  if (receipt.sourceDigest !== request.sourceDigest || receipt.requestDigest !== request.requestDigest) return fail('CHANGED');
  summaryForRequest(receipt.summary, request); return receipt.summary;
}
export function appendIncomingReceipt(receipts: unknown, value: PreparedIncomingImport, result: LibraryImportSummary): IncomingImportReceipt[] {
  const request = assertPreparedIncomingImport(value), existing = validateIncomingReceipts(receipts), checked = summary(result);
  summaryForRequest(checked, request);
  const previous = findIncomingReceipt(existing, request);
  if (previous) { if (canonicalJson(previous) !== canonicalJson(checked)) return fail('CHANGED'); return existing; }
  if (existing.length >= INCOMING_RECEIPT_LIMIT) return fail('FULL');
  return [...existing, { sourceId: request.sourceId, sourceDigest: request.sourceDigest, requestDigest: request.requestDigest, summary: checked }];
}
/** Allows the UI to show a prior successful import before another DOI lookup.
 * It is informational; the transaction must still use findIncomingReceipt. */
export function peekIncomingReceipt(receipts: unknown, value: PreparedSource): LibraryImportSummary | null {
  const original = source(value), receipt = validateIncomingReceipts(receipts).find(entry => entry.sourceId === original.id);
  if (!receipt) return null;
  if (receipt.sourceDigest !== original.digest) return fail('CHANGED');
  if (original.kind === 'archive') summaryForRequest(receipt.summary, { archive: original.archive!, selection: null });
  else if (receipt.summary.papers !== 1 || receipt.summary.notes !== 0) return fail();
  return receipt.summary;
}
