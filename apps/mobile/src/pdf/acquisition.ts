import { PDF_LIMITS } from './types.ts';
import { PdfError, boundedSignal, throwIfAborted } from './errors.ts';

export interface PdfSourceProbe {
  url: string;
  fileName: string;
  sizeBytes: number | null;
  rangeSupported: boolean;
  validator: string | null;
}
export interface PdfTransferOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  onProgress?: (loaded: number, total: number | null) => void;
}

export function safePdfName(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? '';
  const clean = leaf.replace(/[:\x00-\x1f\x7f]/g, '').trim().slice(0, 250);
  return clean && clean !== '.' && clean !== '..' ? clean : 'document.pdf';
}

export function publicPdfUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new PdfError('URL_INVALID'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = host.split('.').map(Number);
  const privateV4 = ipv4.length === 4 && ipv4.every((value) => Number.isInteger(value))
    && (ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] >= 224
      || (ipv4[0] === 169 && ipv4[1] === 254) || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || privateV4 || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host.includes(':') || input.length > 4096) {
    throw new PdfError('URL_INVALID');
  }
  return url.href;
}

function fileNameFromUrl(value: string): string {
  const leaf = new URL(value).pathname.split('/').pop() || 'document.pdf';
  try { return safePdfName(decodeURIComponent(leaf)); } catch { return 'document.pdf'; }
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 1) throw new PdfError('INCOMPLETE');
  if (length > PDF_LIMITS.maxFileBytes) throw new PdfError('TOO_LARGE');
  return length;
}

function checkResponse(response: Response): void {
  if (response.type === 'opaqueredirect' || response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new PdfError('REDIRECT');
  }
  if (!response.ok || response.type === 'opaque') throw new PdfError('HTTP');
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/pdf' && type !== 'application/octet-stream' && type !== 'binary/octet-stream') {
    throw new PdfError('NOT_PDF');
  }
}

export function checkPdfSignature(bytes: Uint8Array): void {
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 1024));
  if (/^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(header)
    || !/%PDF-\d\.\d/.test(header)) throw new PdfError('NOT_PDF');
}

export function checkCompletePdfBytes(bytes: Uint8Array): void {
  if (!bytes.byteLength) throw new PdfError('INCOMPLETE');
  if (bytes.byteLength > PDF_LIMITS.maxFileBytes) throw new PdfError('TOO_LARGE');
  checkPdfSignature(bytes);
  const tail = new TextDecoder('ascii').decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  if (!/%%EOF(?:[\s\0]|$)/.test(tail)) throw new PdfError('INCOMPLETE');
}

function range(response: Response): { start: number; end: number; total: number } {
  const value = response.headers.get('content-range');
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) throw new PdfError('INCOMPLETE');
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total) {
    throw new PdfError('INCOMPLETE');
  }
  if (total > PDF_LIMITS.maxFileBytes) throw new PdfError('TOO_LARGE');
  return { start, end, total };
}

async function readResponse(
  response: Response, signal: AbortSignal, maximum: number,
  progress?: (loaded: number) => void, prefixOnly = false,
): Promise<Uint8Array> {
  if (!response.body) throw new PdfError('INCOMPLETE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      if (count + value.length > maximum) {
        if (!prefixOnly) throw new PdfError('TOO_LARGE');
        chunks.push(value.subarray(0, maximum - count));
        count = maximum;
        break;
      }
      chunks.push(value);
      count += value.length;
      progress?.(count);
      if (prefixOnly && count === maximum) break;
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function withResponse<T>(
  url: string, headers: Record<string, string>, options: PdfTransferOptions,
  use: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(options.signal);
  const bounded = boundedSignal(options.signal, options.timeoutMs ?? PDF_LIMITS.requestTimeoutMs);
  let response: Response | undefined;
  try {
    const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    response = await fetcher(url, { method: 'GET', headers, credentials: 'omit', redirect: 'manual',
      mode: 'cors', cache: 'no-store', referrerPolicy: 'no-referrer', signal: bounded.signal });
    if (bounded.signal.aborted) throw bounded.error();
    checkResponse(response);
    const value = await use(response, bounded.signal);
    if (bounded.signal.aborted) throw bounded.error();
    return value;
  } catch (error) {
    if (bounded.signal.aborted) throw bounded.error();
    if (error instanceof PdfError) throw error;
    throw new PdfError('NETWORK');
  } finally {
    await response?.body?.cancel().catch(() => undefined);
    bounded.close();
  }
}

/** A probe reads at most 1024 response bytes, even when a server ignores Range. */
export async function inspectPublicPdf(input: string, options: PdfTransferOptions = {}): Promise<PdfSourceProbe> {
  const url = publicPdfUrl(input);
  return withResponse(url, { Range: 'bytes=0-1023', Accept: 'application/pdf' }, options, async (response, signal) => {
    const length = contentLength(response);
    const partial = response.status === 206 ? range(response) : null;
    if (partial && (partial.start !== 0 || partial.end > 1023)) throw new PdfError('INCOMPLETE');
    if (response.status !== 200 && response.status !== 206) throw new PdfError('HTTP');
    const bytes = await readResponse(response, signal, 1024, undefined, true);
    if (partial && bytes.length !== partial.end + 1) throw new PdfError('INCOMPLETE');
    checkPdfSignature(bytes);
    return { url, fileName: fileNameFromUrl(url), sizeBytes: partial?.total ?? length,
      rangeSupported: partial !== null, validator: response.headers.get('etag') ?? response.headers.get('last-modified') };
  });
}

export async function downloadPublicPdf(probe: PdfSourceProbe, options: PdfTransferOptions = {}): Promise<Uint8Array> {
  const url = publicPdfUrl(probe.url);
  const bounded = boundedSignal(options.signal, PDF_LIMITS.operationTimeoutMs);
  const child = { ...options, signal: bounded.signal };
  try {
    let bytes: Uint8Array;
    if (probe.rangeSupported && probe.sizeBytes !== null) {
      if (!Number.isSafeInteger(probe.sizeBytes) || probe.sizeBytes < 1 || probe.sizeBytes > PDF_LIMITS.maxFileBytes) {
        throw new PdfError('TOO_LARGE');
      }
      bytes = new Uint8Array(probe.sizeBytes);
      for (let start = 0; start < bytes.length; start += PDF_LIMITS.rangeChunkBytes) {
        throwIfAborted(bounded.signal);
        const end = Math.min(bytes.length - 1, start + PDF_LIMITS.rangeChunkBytes - 1);
        const piece = await withResponse(url, { Range: `bytes=${start}-${end}`, Accept: 'application/pdf' }, child,
          async (response, signal) => {
            if (response.status !== 206) throw new PdfError('SOURCE_CHANGED');
            const part = range(response);
            const validator = response.headers.get('etag') ?? response.headers.get('last-modified');
            if (part.start !== start || part.end !== end || part.total !== bytes.length
              || (probe.validator !== null && validator !== probe.validator)) throw new PdfError('SOURCE_CHANGED');
            const piece = await readResponse(response, signal, end - start + 1,
              (loaded) => options.onProgress?.(start + loaded, bytes.length));
            if (piece.length !== end - start + 1) throw new PdfError('INCOMPLETE');
            return piece;
          });
        bytes.set(piece, start);
      }
    } else {
      bytes = await withResponse(url, { Accept: 'application/pdf' }, child, async (response, signal) => {
        if (response.status !== 200) throw new PdfError('INCOMPLETE');
        const length = contentLength(response);
        const validator = response.headers.get('etag') ?? response.headers.get('last-modified');
        if ((probe.validator !== null && validator !== probe.validator)
          || (probe.sizeBytes !== null && length !== null && probe.sizeBytes !== length)) throw new PdfError('SOURCE_CHANGED');
        const value = await readResponse(response, signal, PDF_LIMITS.maxFileBytes,
          (loaded) => options.onProgress?.(loaded, length));
        if ((length !== null && length !== value.length)
          || (probe.sizeBytes !== null && probe.sizeBytes !== value.length)) throw new PdfError('INCOMPLETE');
        return value;
      });
    }
    if (bounded.signal.aborted) throw bounded.error();
    checkCompletePdfBytes(bytes);
    return bytes;
  } catch (error) {
    if (bounded.signal.aborted) throw bounded.error();
    throw error;
  } finally { bounded.close(); }
}

export async function readLocalPdf(file: Blob, options: Pick<PdfTransferOptions, 'signal' | 'onProgress'> = {}): Promise<Uint8Array> {
  if (file.size > PDF_LIMITS.maxFileBytes) throw new PdfError('TOO_LARGE');
  const type = file.type.split(';')[0].toLowerCase();
  if (type && type !== 'application/pdf' && type !== 'application/octet-stream') throw new PdfError('NOT_PDF');
  const bounded = boundedSignal(options.signal, PDF_LIMITS.operationTimeoutMs);
  try {
    const bytes = await readResponse(new Response(file.stream()), bounded.signal, PDF_LIMITS.maxFileBytes,
      (loaded) => options.onProgress?.(loaded, file.size));
    if (bounded.signal.aborted) throw bounded.error();
    if (bytes.length !== file.size) throw new PdfError('INCOMPLETE');
    checkCompletePdfBytes(bytes);
    return bytes;
  } catch (error) {
    if (bounded.signal.aborted) throw bounded.error();
    throw error;
  } finally { bounded.close(); }
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
