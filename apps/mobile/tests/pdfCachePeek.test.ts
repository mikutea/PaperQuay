import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { sha256 } from '../src/pdf/acquisition.ts';
import { cacheKey } from '../src/pdf/cachePolicy.ts';
import { PdfError } from '../src/pdf/errors.ts';
import { NativePdfCache, type CacheArea, type NativePdfFiles } from '../src/pdf/nativeCache.ts';
import { WebPdfCache } from '../src/pdf/webCache.ts';
import type { AccountScope } from '../src/storage/accountStore.ts';
import type { PdfCache, PdfVersion } from '../src/pdf/types.ts';

const scope: AccountScope = { apiBaseUrl: 'https://sync.example.org', accountId: crypto.randomUUID() };
const code = (value: string) => (error: unknown) => error instanceof PdfError && error.code === value;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(marker = 1) {
  const bytes = new Uint8Array(80).fill(marker);
  const version: PdfVersion = { entityId: crypto.randomUUID(), data: {
    paperId: crypto.randomUUID(), attachmentId: crypto.randomUUID(), sha256: await sha256(bytes), sizeBytes: bytes.length,
    mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount: 3,
  } };
  return { bytes, version };
}

class TrackedFiles implements NativePdfFiles {
  manifests: Record<'a' | 'b', string | null> = { a: null, b: null };
  blobs: Record<CacheArea, Map<string, Uint8Array>> = { cache: new Map(), data: new Map() };
  manifestWrites = 0; fileWrites = 0; removals = 0; manifestReads = 0; fileReads = 0;
  beforeRead: (() => Promise<void>) | undefined;
  async readManifest(slot: 'a' | 'b') { this.manifestReads++; return this.manifests[slot]; }
  async writeManifest(slot: 'a' | 'b', value: string) { this.manifestWrites++; this.manifests[slot] = value; }
  async list(area: CacheArea) { return [...this.blobs[area].keys()]; }
  async read(area: CacheArea, name: string, size: number) {
    this.fileReads++; await this.beforeRead?.();
    const value = this.blobs[area].get(name);
    if (!value) return null;
    if (value.byteLength !== size) throw new PdfError('CACHE_CORRUPT');
    return value.slice();
  }
  async write(area: CacheArea, name: string, bytes: Uint8Array) { this.fileWrites++; this.blobs[area].set(name, bytes.slice()); }
  async remove(area: CacheArea, name: string) { this.removals++; this.blobs[area].delete(name); }
  mutations() { return { manifestWrites: this.manifestWrites, fileWrites: this.fileWrites, removals: this.removals }; }
  snapshot() {
    return { manifests: { ...this.manifests }, blobs: Object.fromEntries((['cache', 'data'] as const).map((area) =>
      [area, [...this.blobs[area]].map(([name, bytes]) => [name, Array.from(bytes)]).sort()])) };
  }
}

function forbidWebWrites(context: TestContext) {
  let writes = 0;
  const unexpected = () => { writes++; throw new Error('peek attempted a write'); };
  const modes: string[] = [];
  const transaction = IDBDatabase.prototype.transaction;
  const mocks = [
    context.mock.method(IDBObjectStore.prototype, 'put', unexpected),
    context.mock.method(IDBObjectStore.prototype, 'add', unexpected),
    context.mock.method(IDBObjectStore.prototype, 'delete', unexpected),
    context.mock.method(IDBObjectStore.prototype, 'clear', unexpected),
    context.mock.method(IDBDatabase.prototype, 'transaction', function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      modes.push(args[1] ?? 'readonly'); return transaction.apply(this, args);
    }),
  ];
  return { writes: () => writes, modes, restore: () => { for (const mock of mocks) mock.mock.restore(); } };
}

async function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function writeRaw(db: IDBDatabase, action: (metadata: IDBObjectStore, content: IDBObjectStore) => void) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['metadata', 'content'], 'readwrite');
    tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    action(tx.objectStore('metadata'), tx.objectStore('content'));
  });
}

for (const backend of ['web', 'native'] as const) {
  test(`${backend} peek verifies exact scoped bytes without LRU changes, and ordinary read still updates LRU`, async (context) => {
    let clock = 10;
    const files = new TrackedFiles();
    const cache: PdfCache = backend === 'web'
      ? new WebPdfCache({ indexedDB: new IDBFactory(), databaseName: crypto.randomUUID(), now: () => clock })
      : new NativePdfCache(files, { now: () => clock });
    const sample = await fixture();
    try {
      await cache.put(scope, sample.version, sample.bytes, { pinned: true, sourceUrl: 'https://papers.example.org/paper.pdf' });
      const before = await cache.list(scope); const snapshot = files.snapshot(); const mutations = files.mutations();
      clock = 40;
      const audit = backend === 'web' ? forbidWebWrites(context) : null;
      assert.deepEqual(await cache.peek(scope, sample.version), sample.bytes);
      assert.deepEqual(await cache.peek(scope, { ...sample.version, data: { ...sample.version.data, pageCount: null, fileName: 'renamed.pdf' } }), sample.bytes);
      assert.deepEqual(await cache.list(scope), before);
      assert.deepEqual(files.snapshot(), snapshot); assert.deepEqual(files.mutations(), mutations);
      if (audit) { assert.equal(audit.writes(), 0); assert.ok(audit.modes.length > 0); assert.ok(audit.modes.every((mode) => mode === 'readonly')); audit.restore(); }
      assert.deepEqual(await cache.read(scope, sample.version), sample.bytes);
      assert.equal((await cache.list(scope))[0].lastUsedAt, 40);
    } finally { await cache.close(); }
  });

  test(`${backend} peek isolates account and service scopes and rejects mismatched cache identity without repairs`, async (context) => {
    const files = new TrackedFiles();
    const cache: PdfCache = backend === 'web' ? new WebPdfCache({ indexedDB: new IDBFactory(), databaseName: crypto.randomUUID() }) : new NativePdfCache(files);
    const sample = await fixture();
    try {
      await cache.put(scope, sample.version, sample.bytes);
      const snapshot = files.snapshot(); const mutations = files.mutations();
      const audit = backend === 'web' ? forbidWebWrites(context) : null;
      assert.equal(await cache.peek({ ...scope, accountId: crypto.randomUUID() }, sample.version), null);
      assert.equal(await cache.peek({ ...scope, apiBaseUrl: 'https://other.example.org' }, sample.version), null);
      assert.equal(await cache.peek(scope, { ...sample.version, entityId: crypto.randomUUID() }), null);
      for (const changed of [{ sha256: '0'.repeat(64) }, { sizeBytes: sample.bytes.length + 1 }, { pageCount: 4 }]) {
        await assert.rejects(cache.peek(scope, { ...sample.version, data: { ...sample.version.data, ...changed } }), code('CACHE_CORRUPT'));
      }
      await assert.rejects(cache.peek(scope, { ...sample.version, data: { ...sample.version.data, sha256: 'invalid' } }), code('VERSION_MISMATCH'));
      assert.deepEqual(files.snapshot(), snapshot); assert.deepEqual(files.mutations(), mutations);
      if (audit) { assert.equal(audit.writes(), 0); assert.ok(audit.modes.every((mode) => mode === 'readonly')); audit.restore(); }
    } finally { await cache.close(); }
  });
}

test('native peek neither calls mutating load nor initializes or cleans missing and corrupt manifests', async (context) => {
  const files = new TrackedFiles(); const cache = new NativePdfCache(files); const sample = await fixture();
  context.mock.method(cache as unknown as { load(): Promise<never> }, 'load', async () => { assert.fail('peek called mutating load'); });
  assert.equal(await cache.peek(scope, sample.version), null);
  assert.deepEqual(files.manifests, { a: null, b: null }); assert.deepEqual(files.mutations(), { manifestWrites: 0, fileWrites: 0, removals: 0 });
  const orphan = `${'0'.repeat(64)}.${sample.version.entityId}.${crypto.randomUUID()}.pdf`;
  files.blobs.cache.set(orphan, sample.bytes); files.blobs.data.set('unrelated-user-file.pdf', new Uint8Array([1]));
  const orphanSnapshot = files.snapshot();
  await assert.rejects(cache.peek(scope, sample.version), code('CACHE_CORRUPT'));
  assert.deepEqual(files.snapshot(), orphanSnapshot);
  files.manifests = { a: '{corrupt', b: '{corrupt' }; const corruptSnapshot = files.snapshot();
  await assert.rejects(cache.peek(scope, sample.version), code('CACHE_CORRUPT'));
  assert.deepEqual(files.snapshot(), corruptSnapshot); assert.deepEqual(files.mutations(), { manifestWrites: 0, fileWrites: 0, removals: 0 });
  await cache.close();
});

test('native peek retains orphan files, missing-file metadata, damaged bytes and a damaged recovery slot', async () => {
  const files = new TrackedFiles(); const cache = new NativePdfCache(files); const sample = await fixture();
  await cache.put(scope, sample.version, sample.bytes);
  const name = [...files.blobs.cache.keys()][0];
  const orphan = `${'0'.repeat(64)}.${crypto.randomUUID()}.${crypto.randomUUID()}.pdf`;
  files.blobs.cache.set(orphan, sample.bytes.slice()); files.manifests.b = '{interrupted';
  const baseline = files.snapshot(); const mutations = files.mutations();
  assert.deepEqual(await cache.peek(scope, sample.version), sample.bytes);
  assert.deepEqual(files.snapshot(), baseline);
  files.blobs.cache.get(name)![0] ^= 255; const corrupt = files.snapshot();
  await assert.rejects(cache.peek(scope, sample.version), code('CACHE_CORRUPT'));
  assert.deepEqual(files.snapshot(), corrupt);
  files.blobs.cache.delete(name); const missing = files.snapshot();
  assert.equal(await cache.peek(scope, sample.version), null);
  assert.deepEqual(files.snapshot(), missing); assert.deepEqual(files.mutations(), mutations);
  await cache.close();
});

test('web peek retains corrupt or missing blobs and refuses an oversized blob before materializing it', async (context) => {
  const factory = new IDBFactory(); const name = crypto.randomUUID();
  const cache = new WebPdfCache({ indexedDB: factory, databaseName: name }); const sample = await fixture();
  await cache.put(scope, sample.version, sample.bytes);
  const db = await openDatabase(factory, name); const key = cacheKey(scope, sample.version.entityId);
  try {
    for (const body of [new Blob([new Uint8Array(sample.bytes.length).fill(9)]), new Blob([new Uint8Array(sample.bytes.length + 1)]), null]) {
      await writeRaw(db, (_metadata, content) => { if (body) content.put(body, key); else content.delete(key); });
      let allocations = 0; const arrayBuffer = Blob.prototype.arrayBuffer;
      const blobMock = context.mock.method(Blob.prototype, 'arrayBuffer', function (this: Blob) { allocations++; return arrayBuffer.call(this); });
      const before = await cache.list(scope); const audit = forbidWebWrites(context);
      await assert.rejects(cache.peek(scope, sample.version), code('CACHE_CORRUPT'));
      assert.deepEqual(await cache.list(scope), before); assert.equal(audit.writes(), 0);
      assert.equal(allocations, body?.size === sample.bytes.length ? 1 : 0);
      audit.restore(); blobMock.mock.restore();
    }
  } finally { db.close(); await cache.close(); }
});

test('native queued and in-flight cancellation allocates no later file and cannot revive a concurrently cleared cache', async () => {
  const files = new TrackedFiles(); const cache = new NativePdfCache(files); const sample = await fixture();
  await cache.put(scope, sample.version, sample.bytes);
  const initialMutations = files.mutations(); const entered = deferred<void>(); const release = deferred<void>();
  files.beforeRead = async () => { entered.resolve(); await release.promise; };
  const firstAbort = new AbortController(); const queuedAbort = new AbortController();
  const first = cache.peek(scope, sample.version, { signal: firstAbort.signal });
  const firstRejected = assert.rejects(first, code('CANCELLED'));
  await entered.promise;
  const queued = cache.peek(scope, sample.version, { signal: queuedAbort.signal });
  const queuedRejected = assert.rejects(queued, code('CANCELLED'));
  const readsBeforeQueue = files.manifestReads;
  firstAbort.abort(); queuedAbort.abort();
  let cleared = false; const clearing = cache.clear(scope, { includePinned: true }).then(() => { cleared = true; });
  await turn(); assert.equal(files.fileReads, 1); assert.equal(files.manifestReads, readsBeforeQueue); assert.equal(cleared, false);
  assert.deepEqual(files.mutations(), initialMutations);
  release.resolve(); await firstRejected; await queuedRejected; await clearing;
  assert.equal(files.fileReads, 1); files.beforeRead = undefined;
  const clearedSnapshot = files.snapshot(); const clearedMutations = files.mutations();
  assert.equal(await cache.peek(scope, sample.version), null); await turn();
  assert.deepEqual(files.snapshot(), clearedSnapshot); assert.deepEqual(files.mutations(), clearedMutations);
  assert.equal(files.blobs.cache.size, 0); assert.equal(files.blobs.data.size, 0); await cache.close();
});

test('web peek serializes blob allocation and cancelled late bytes cannot recreate cleared metadata', async (context) => {
  const cache = new WebPdfCache({ indexedDB: new IDBFactory(), databaseName: crypto.randomUUID() }); const sample = await fixture();
  await cache.put(scope, sample.version, sample.bytes);
  const entered = deferred<void>(); const release = deferred<void>(); let allocations = 0;
  const arrayBuffer = Blob.prototype.arrayBuffer;
  const blobMock = context.mock.method(Blob.prototype, 'arrayBuffer', async function (this: Blob) {
    allocations++; entered.resolve(); await release.promise; return arrayBuffer.call(this);
  });
  const firstAbort = new AbortController(); const queuedAbort = new AbortController();
  const firstRejected = assert.rejects(cache.peek(scope, sample.version, { signal: firstAbort.signal }), code('CANCELLED'));
  await entered.promise;
  const queuedRejected = assert.rejects(cache.peek(scope, sample.version, { signal: queuedAbort.signal }), code('CANCELLED'));
  firstAbort.abort(); queuedAbort.abort(); await turn(); assert.equal(allocations, 1);
  await cache.clear(scope, { includePinned: true }); assert.deepEqual(await cache.list(scope), []);
  const audit = forbidWebWrites(context);
  release.resolve(); await firstRejected; await queuedRejected; await turn();
  assert.equal(allocations, 1); assert.equal(await cache.peek(scope, sample.version), null);
  assert.deepEqual(await cache.list(scope), []); assert.equal(audit.writes(), 0);
  audit.restore(); blobMock.mock.restore(); await cache.close();
});

test('pre-aborted peeks perform no cache reads or transactions', async (context) => {
  const files = new TrackedFiles(); const native = new NativePdfCache(files);
  const web = new WebPdfCache({ indexedDB: new IDBFactory(), databaseName: crypto.randomUUID() });
  await web.list(scope); // The existing Web constructor opens its database independently of peek.
  const sample = await fixture(); const abort = new AbortController(); abort.abort();
  const audit = forbidWebWrites(context);
  await assert.rejects(native.peek(scope, sample.version, { signal: abort.signal }), code('CANCELLED'));
  await assert.rejects(web.peek(scope, sample.version, { signal: abort.signal }), code('CANCELLED'));
  assert.equal(files.manifestReads, 0); assert.equal(files.fileReads, 0); assert.equal(audit.modes.length, 0); assert.equal(audit.writes(), 0);
  audit.restore(); await native.close(); await web.close();
});

test('native peek leaves actual PDF and manifest bytes and modification times unchanged', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperquay-peek-'));
  context.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('paperquay-peek-'));
    await rm(root, { recursive: true, force: true });
  });
  let writes = 0; let removals = 0;
  const files: NativePdfFiles = {
    async readManifest(slot) { try { return await readFile(path.join(root, `manifest-${slot}.json`), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
    async writeManifest(slot, value) { writes++; await writeFile(path.join(root, `manifest-${slot}.json`), value); },
    async list(area) { try { return await readdir(path.join(root, area)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } },
    async read(area, name, size) {
      try { const bytes = new Uint8Array(await readFile(path.join(root, area, name))); assert.equal(bytes.length, size); return bytes; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async write(area, name, bytes) { writes++; await mkdir(path.join(root, area), { recursive: true }); await writeFile(path.join(root, area, name), bytes); },
    async remove(area, name) { removals++; await unlink(path.join(root, area, name)); },
  };
  const cache = new NativePdfCache(files); const sample = await fixture();
  await cache.put(scope, sample.version, sample.bytes);
  const paths = [path.join(root, 'manifest-a.json'), path.join(root, 'manifest-b.json'),
    ...(await files.list('cache')).map((name) => path.join(root, 'cache', name))];
  for (const file of paths) await utimes(file, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
  const snapshot = () => Promise.all(paths.map(async (file) => ({ file, mtime: (await stat(file, { bigint: true })).mtimeNs.toString(), bytes: (await readFile(file)).toString('hex') })));
  const before = await snapshot(); writes = 0; removals = 0;
  assert.deepEqual(await cache.peek(scope, sample.version), sample.bytes);
  assert.deepEqual(await snapshot(), before); assert.equal(writes, 0); assert.equal(removals, 0);
  await cache.close();
});
