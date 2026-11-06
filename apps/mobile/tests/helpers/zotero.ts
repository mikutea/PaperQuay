import assert from 'node:assert/strict';
import { ZoteroClient, type ZoteroClientOptions, type ZoteroLibraryConfig } from '../../src/library/zoteroClient.ts';

export const zoteroConfig: ZoteroLibraryConfig = { kind: 'user', libraryId: '42', name: '研究文库' };
export const zoteroAccount = { apiBaseUrl: 'https://sync.example.invalid', accountId: '00000000-0000-4000-8000-000000000001' };
export const zoteroKey = 'DedicatedZoteroFixtureKey24';
export function zoteroItem(n = 1, version = 10, config = zoteroConfig, data: Record<string, unknown> = {}) {
  const key = n.toString(36).toUpperCase().padStart(8, '0');
  return { key, version, library: { type: config.kind, id: Number(config.libraryId), name: 'Remote library name' },
    data: { key, version, itemType: 'journalArticle', title: `Study ${n}`, DOI: '', date: '2026', publicationTitle: 'Journal',
      abstractNote: '', creators: [{ creatorType: 'author', firstName: 'A.', lastName: 'Author' }], tags: [], ...data } };
}
export function zoteroResponse(body: unknown, version = 10, extra: { total?: number; status?: number; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'Zotero-API-Version': '3', 'Last-Modified-Version': String(version), 'Content-Type': 'application/json', ...extra.headers });
  if (extra.total !== undefined || Array.isArray(body)) headers.set('Total-Results', String(extra.total ?? (body as unknown[]).length));
  return new Response(extra.status === 304 ? null : JSON.stringify(body), { status: extra.status ?? 200, headers });
}
export const zoteroDeleted = (items: string[] = [], version = 10) => zoteroResponse({ collections: [], searches: [], items, tags: [] }, version);
export interface CapturedZoteroRequest { url: URL; init: RequestInit; headers: Headers }
export type ZoteroReply = Response | ((request: CapturedZoteroRequest) => Response | Promise<Response>);
export function zoteroTransport(replies: ZoteroReply[], options: ZoteroClientOptions = {}) {
  const requests: CapturedZoteroRequest[] = [], delays: number[] = []; let now = 1_800_000_000_000;
  const fetcher: typeof fetch = async (input, init) => {
    const request = { url: new URL(String(input)), init: init!, headers: new Headers(init?.headers) }; requests.push(request);
    const reply = replies.shift(); assert.ok(reply, 'Unexpected extra Zotero request');
    return typeof reply === 'function' ? reply(request) : reply;
  };
  const client = new ZoteroClient({ fetch: fetcher, now: () => now,
    sleep: async (milliseconds, signal) => { assert.equal(signal.aborted, false); delays.push(milliseconds); now += milliseconds; }, ...options });
  return { client, requests, delays, replies, now: () => now };
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
