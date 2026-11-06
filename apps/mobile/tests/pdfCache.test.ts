import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { NativePdfCache, type CacheArea, type NativePdfFiles } from '../src/pdf/nativeCache.ts';
import { WebPdfCache } from '../src/pdf/webCache.ts';
import { sha256 } from '../src/pdf/acquisition.ts';
import { PdfError } from '../src/pdf/errors.ts';
import { cancelPdfTasks, registerPdfTask } from '../src/pdf/tasks.ts';
import type { AccountScope } from '../src/storage/accountStore.ts';
import type { PdfCache, PdfVersion } from '../src/pdf/types.ts';

const a: AccountScope = { apiBaseUrl: 'https://sync.example.org', accountId: crypto.randomUUID() };
const b: AccountScope = { ...a, accountId: crypto.randomUUID() };
const code = (expected: string) => (error: unknown) => error instanceof PdfError && error.code === expected;
async function fixture(marker: number, length = 80) {
  const bytes = new Uint8Array(length).fill(marker);
  const version: PdfVersion = { entityId: crypto.randomUUID(), data: { paperId: crypto.randomUUID(), attachmentId: crypto.randomUUID(),
    sha256: await sha256(bytes), sizeBytes: bytes.length, mediaType: 'application/pdf', fileName: `synthetic-${marker}.pdf`, pageCount: 3 } };
  return { bytes, version };
}
const limits = { maxCacheBytes: 240, maxTemporaryBytes: 160, maxPinnedBytes: 160, maxCacheEntries: 4 };

class MemoryFiles implements NativePdfFiles {
  manifests: Record<'a' | 'b', string | null> = { a: null, b: null };
  blobs: Record<CacheArea, Map<string, Uint8Array>> = { cache: new Map(), data: new Map() };
  manifestWrites = 0;
  failManifestAt = -1;
  manifestFailure: 'partial' | 'after' = 'partial';
  failFile = false;
  onWrite: (() => void) | null = null;
  async readManifest(slot: 'a' | 'b') { return this.manifests[slot]; }
  async writeManifest(slot: 'a' | 'b', value: string) {
    this.manifestWrites++;
    if (this.manifestWrites === this.failManifestAt) {
      this.manifests[slot] = this.manifestFailure === 'after' ? value : '{interrupted';
      throw new Error('simulated interruption');
    }
    this.manifests[slot] = value;
  }
  async list(area: CacheArea) { return [...this.blobs[area].keys()]; }
  async read(area: CacheArea, name: string, size: number) {
    const bytes = this.blobs[area].get(name); if (!bytes) return null;
    if (bytes.length !== size) throw new PdfError('CACHE_CORRUPT');
    return bytes.slice();
  }
  async write(area: CacheArea, name: string, bytes: Uint8Array) {
    this.blobs[area].set(name, bytes.slice()); this.onWrite?.();
    if (this.failFile) { this.blobs[area].set(name, bytes.slice(0, 3)); throw new Error('disk full'); }
  }
  async remove(area: CacheArea, name: string) { this.blobs[area].delete(name); }
  count() { return this.blobs.cache.size + this.blobs.data.size; }
}

for (const backend of ['web', 'native'] as const) {
  test(`${backend} cache uses bounded own-account LRU, preserves pins and never exposes or evicts another account`, async () => {
    let clock = 0;
    const cache: PdfCache = backend === 'web'
      ? new WebPdfCache({ indexedDB: new IDBFactory(), databaseName: crypto.randomUUID(), limits, now: () => ++clock })
      : new NativePdfCache(new MemoryFiles(), { limits, now: () => ++clock });
    const one = await fixture(1); const two = await fixture(2); const three = await fixture(3); const other = await fixture(4);
    try {
      await cache.put(a, one.version, one.bytes, { pinned: true, sourceUrl: 'https://papers.example.org/one.pdf?private=local-only' });
      await cache.put(a, two.version, two.bytes);
      await cache.put(b, other.version, other.bytes);
      assert.equal((await cache.list(b)).length, 1); assert.equal(await cache.read(b, one.version), null);
      await cache.put(a, three.version, three.bytes);
      assert.equal(await cache.read(a, two.version), null, 'only the oldest unpinned file in the writing account may be evicted');
      assert.deepEqual(await cache.read(a, one.version), one.bytes); assert.deepEqual(await cache.read(b, other.version), other.bytes);
      await cache.clear(a);
      assert.deepEqual((await cache.list(a)).map((entry) => entry.versionId), [one.version.entityId]);
      await cache.clear(a, { includePinned: true });
      assert.deepEqual(await cache.list(a), []); assert.equal((await cache.list(b)).length, 1);
    } finally { await cache.close(); }
  });

  test(`${backend} cache rejects wrong bytes, aborted puts and impossible pinned capacity without losing earlier copies`, async () => {
    const cache: PdfCache = backend === 'web'
      ? new WebPdfCache({ indexedDB: new IDBFactory(), databaseName: crypto.randomUUID(), limits })
      : new NativePdfCache(new MemoryFiles(), { limits });
    const one = await fixture(1); const two = await fixture(2); const three = await fixture(3);
    try {
      await cache.put(a, one.version, one.bytes, { pinned: true }); await cache.put(a, two.version, two.bytes, { pinned: true });
      await assert.rejects(cache.put(a, three.version, three.bytes, { pinned: true }), code('CACHE_FULL'));
      await assert.rejects(cache.put(a, one.version, two.bytes), code('VERSION_MISMATCH'));
      const abort = new AbortController(); abort.abort();
      await assert.rejects(cache.put(a, three.version, three.bytes, { signal: abort.signal }), code('CANCELLED'));
      assert.equal((await cache.list(a)).length, 2); assert.deepEqual(await cache.read(a, one.version), one.bytes);
    } finally { await cache.close(); }
  });
}

test('IndexedDB content-write failure rolls back both metadata eviction and replacement atomically', async () => {
  const factory = new IDBFactory(); const cache = new WebPdfCache({ indexedDB: factory, databaseName: crypto.randomUUID(),
    limits: { ...limits, maxCacheBytes: 80, maxTemporaryBytes: 80 } });
  const old = await fixture(1); const next = await fixture(2);
  await cache.put(a, old.version, old.bytes);
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'content') throw new DOMException('simulated quota', 'QuotaExceededError');
    return original.apply(this, args);
  };
  try { await assert.rejects(cache.put(a, next.version, next.bytes), code('CACHE_UNAVAILABLE')); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual(await cache.read(a, old.version), old.bytes); assert.equal(await cache.read(a, next.version), null);
  await cache.close();
});

test('native pin moves only the app-owned copy to durable data; OS temporary-cache eviction is recoverable', async () => {
  const files = new MemoryFiles(); const cache = new NativePdfCache(files);
  const one = await fixture(1); const two = await fixture(2);
  await cache.put(a, one.version, one.bytes); await cache.put(a, two.version, two.bytes); await cache.setPinned(a, one.version.entityId, true);
  assert.equal(files.blobs.data.size, 1); assert.equal(files.blobs.cache.size, 1);
  files.blobs.cache.clear();
  const reopened = new NativePdfCache(files);
  assert.equal(await reopened.read(a, two.version), null); assert.deepEqual(await reopened.read(a, one.version), one.bytes);
  assert.deepEqual((await reopened.list(a)).map((entry) => entry.versionId), [one.version.entityId]);
});

test('native interruption before committing a manifest preserves the previous generation and reclaims only the partial new copy', async () => {
  const files = new MemoryFiles(); const cache = new NativePdfCache(files);
  const old = await fixture(1); const next = await fixture(2);
  files.blobs.data.set('unrelated-user-file.pdf', new Uint8Array([9]));
  await cache.put(a, old.version, old.bytes);
  files.failManifestAt = files.manifestWrites + 1;
  await assert.rejects(cache.put(a, next.version, next.bytes), code('CACHE_UNAVAILABLE'));
  const reopened = new NativePdfCache(files);
  assert.deepEqual(await reopened.read(a, old.version), old.bytes); assert.equal(await reopened.read(a, next.version), null);
  assert.equal(files.count(), 2); assert.deepEqual(files.blobs.data.get('unrelated-user-file.pdf'), new Uint8Array([9]));
});

test('native manifest write acknowledged as failed after durable write never deletes bytes referenced by the new generation', async () => {
  const files = new MemoryFiles(); const cache = new NativePdfCache(files);
  const old = await fixture(1); const next = await fixture(2);
  await cache.put(a, old.version, old.bytes);
  files.failManifestAt = files.manifestWrites + 1; files.manifestFailure = 'after';
  await assert.rejects(cache.put(a, next.version, next.bytes), code('CACHE_UNAVAILABLE'));
  const reopened = new NativePdfCache(files);
  assert.deepEqual(await reopened.read(a, old.version), old.bytes);
  assert.deepEqual(await reopened.read(a, next.version), next.bytes);
});

test('native clear cannot claim completion until both recovery manifests exclude removed copies', async () => {
  const files = new MemoryFiles(); const cache = new NativePdfCache(files);
  const one = await fixture(1); const other = await fixture(2);
  await cache.put(a, one.version, one.bytes, { pinned: true }); await cache.put(b, other.version, other.bytes, { pinned: true });
  files.failManifestAt = files.manifestWrites + 2;
  await assert.rejects(cache.clear(a, { includePinned: true }), code('CACHE_UNAVAILABLE'));
  const reopened = new NativePdfCache(files);
  await reopened.clear(a, { includePinned: true });
  assert.deepEqual(await reopened.list(a), []); assert.deepEqual(await reopened.read(b, other.version), other.bytes);
  assert.equal(files.count(), 1);
});

test('native cancellation after writing staged bytes and disk-full interruption preserve pinned prior bytes', async () => {
  const files = new MemoryFiles(); const cache = new NativePdfCache(files);
  const one = await fixture(1); const next = await fixture(2);
  await cache.put(a, one.version, one.bytes, { pinned: true });
  const abort = new AbortController(); files.onWrite = () => abort.abort();
  await assert.rejects(cache.put(a, next.version, next.bytes, { signal: abort.signal }), code('CANCELLED'));
  files.onWrite = null; files.failFile = true;
  await assert.rejects(cache.put(a, next.version, next.bytes), code('CACHE_UNAVAILABLE'));
  files.failFile = false;
  assert.deepEqual(await cache.read(a, one.version), one.bytes); assert.equal(files.count(), 1);
});

test('corrupt native recovery metadata fails closed without deleting files, and corrupted bytes are never returned', async () => {
  const files = new MemoryFiles(); const cache = new NativePdfCache(files); const one = await fixture(1);
  await cache.put(a, one.version, one.bytes, { pinned: true });
  const name = [...files.blobs.data.keys()][0]; files.blobs.data.get(name)![0] ^= 255;
  await assert.rejects(cache.read(a, one.version), code('CACHE_CORRUPT'));
  files.manifests = { a: '{broken', b: '{broken' };
  await assert.rejects(new NativePdfCache(files).list(a), code('CACHE_CORRUPT'));
  assert.equal(files.count(), 1);
});

test('account removal cancels only that account registered tasks and late put observes the abort', async () => {
  const first = new AbortController(); const second = new AbortController(); const other = new AbortController();
  const releaseFirst = registerPdfTask(a, first); registerPdfTask(a, second); const releaseOther = registerPdfTask(b, other);
  cancelPdfTasks(a); assert.equal(first.signal.aborted, true); assert.equal(second.signal.aborted, true); assert.equal(other.signal.aborted, false);
  releaseFirst(); releaseOther();
  const cache = new WebPdfCache({ indexedDB: new IDBFactory(), databaseName: crypto.randomUUID() }); const one = await fixture(1);
  await assert.rejects(cache.put(a, one.version, one.bytes, { signal: first.signal }), code('CANCELLED'));
  assert.deepEqual(await cache.list(a), []); await cache.close();
});
