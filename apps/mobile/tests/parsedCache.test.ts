import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb';
import { verifyParsedDocument, type ParsedDocumentPackage } from '../../../packages/sync-core/src/index.ts';
import {
  PARSED_CACHE_DATABASE, PARSED_CACHE_LIMITS, SqliteParsedCache, WebParsedCache,
  type ParsedCache, type VerifiedParsedDocument,
} from '../src/parsed/cache.ts';
import { AccountSqliteDatabase, type AccountSqliteDriver } from '../src/storage/sqliteAccountStore.ts';
import { accountScopeKey, type AccountScope } from '../src/storage/accountStore.ts';
import type { PdfVersion } from '../src/pdf/types.ts';

const a: AccountScope = { apiBaseUrl: 'https://sync.example.test', accountId: '11111111-1111-4111-8111-111111111111' };
const b: AccountScope = { ...a, accountId: '22222222-2222-4222-8222-222222222222' };
const c: AccountScope = { ...a, apiBaseUrl: 'https://another.example.test' };
type Backend = 'web' | 'sqlite';
type CacheConfig = { limits?: Partial<typeof PARSED_CACHE_LIMITS>; now?: () => number };
type RawRow = { payload: string; digest: string; sizeBytes: number } & Record<string, unknown>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
class Driver implements AccountSqliteDriver {
  readonly db: DatabaseSync;
  failCommit = false;
  afterWrite?: () => void;
  beforeCommit?: () => Promise<void>;
  constructor(path: string) { this.db = new DatabaseSync(path); }
  async execute(sql: string) { this.db.exec(sql); }
  async query(sql: string, values: string[]) { return this.db.prepare(sql).all(...values) as Record<string, unknown>[]; }
  async run(sql: string, values: string[]) { this.db.prepare(sql).run(...values); this.afterWrite?.(); }
  async begin() { this.db.exec('BEGIN IMMEDIATE'); }
  async commit() { await this.beforeCommit?.(); if (this.failCommit) throw new Error('private-disk-path-sentinel'); this.db.exec('COMMIT'); }
  async rollback() { this.db.exec('ROLLBACK'); }
  async close() { this.db.close(); }
}
async function fixture(t: TestContext, backend: Backend, config: CacheConfig = {}) {
  const factory = new IDBFactory(); const databaseName = crypto.randomUUID();
  const directory = backend === 'sqlite' ? await mkdtemp(join(tmpdir(), 'paperquay-parsed-cache-')) : null;
  const path = directory ? join(directory, `${PARSED_CACHE_DATABASE}.sqlite`) : '';
  const driver = directory ? new Driver(path) : null;
  const database = driver ? new AccountSqliteDatabase(driver) : null;
  const caches: (WebParsedCache | SqliteParsedCache)[] = [];
  const open = () => {
    const cache = database ? new SqliteParsedCache(database, config) : new WebParsedCache({ indexedDB: factory, databaseName, ...config });
    caches.push(cache); return cache;
  };
  const cache = open();
  async function raw(transform: (row: RawRow) => RawRow): Promise<void> {
    if (driver) {
      const row = driver.db.prepare('SELECT * FROM parsed_packages WHERE scope_key = ?').get(accountScopeKey(a)) as Record<string, unknown>;
      const value = transform({ ...row, payload: String(row.payload), digest: String(row.digest), sizeBytes: Number(row.size_bytes) });
      driver.db.prepare('UPDATE parsed_packages SET payload = ?, digest = ?, size_bytes = ? WHERE cache_key = ?')
        .run(value.payload, value.digest, value.sizeBytes, String(row.cache_key));
      return;
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['packages', 'metadata'], 'readwrite'); const store = tx.objectStore('packages');
        const request = store.index('account').getAll(accountScopeKey(a));
        request.onsuccess = () => {
          const next = transform(request.result[0] as RawRow);
          const { payload: _payload, ...meta } = next;
          store.put(next); tx.objectStore('metadata').put(meta);
        };
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  async function writeHook(action: () => void, operation: () => Promise<unknown>, fail = false): Promise<unknown> {
    if (driver) {
      driver.afterWrite = action; driver.failCommit = fail;
      try { return await operation(); } finally { driver.afterWrite = undefined; driver.failCommit = false; }
    }
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'packages') {
        if (fail) throw new DOMException('private-disk-path-sentinel', 'QuotaExceededError');
        const result = original.apply(this, args); action(); return result;
      }
      return original.apply(this, args);
    };
    try { return await operation(); } finally { IDBObjectStore.prototype.put = original; }
  }
  t.after(async () => {
    for (const item of caches) await item.close().catch(() => undefined);
    await database?.close().catch(() => undefined);
    if (directory) {
      for (const suffix of ['', '-wal', '-shm']) await unlink(path + suffix).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(directory);
    }
  });
  return { cache, open, raw, writeHook, driver, database, path, factory, databaseName };
}
async function sample(text = 'Original paragraph', options: { version?: PdfVersion; sha256?: string; asset?: boolean } = {}) {
  const version: PdfVersion = options.version ? structuredClone(options.version) : {
    entityId: crypto.randomUUID(), data: { paperId: crypto.randomUUID(), attachmentId: crypto.randomUUID(),
      sha256: options.sha256 ?? 'a'.repeat(64), sizeBytes: 4096, mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount: 2 },
  };
  const document: ParsedDocumentPackage = {
    format: 'paperquay-parsed-document', version: 1, paperId: version.data.paperId, attachmentVersionId: version.entityId,
    pdf: { sha256: version.data.sha256, sizeBytes: version.data.sizeBytes, pageCount: 2 }, parser: { name: 'mineru', model: 'test-model' },
    blocks: [{ id: 'paragraph-1', pageIndex: 0, kind: 'text', text }], assets: [],
  };
  if (options.asset) {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
    document.assets = [{ id: 'image-1', mediaType: 'image/png', base64, sha256: digest, sizeBytes: bytes.byteLength, width: 1, height: 1 }];
    document.blocks.push({ id: 'figure-1', pageIndex: 1, kind: 'image', text: '', assetId: 'image-1' });
  }
  return { version, verified: await verifyParsedDocument(document) };
}
async function expectDocument(cache: ParsedCache, version: PdfVersion, verified: VerifiedParsedDocument, scope: AccountScope = a) {
  assert.deepEqual(await cache.read(scope, version, 2, { guard: () => true }), verified);
}
function openIndexedDB(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

test('web quota decisions and listing read metadata and keys without fetching any stored package body', async (t) => {
  const { cache } = await fixture(t, 'web'); const old = await sample(); const next = await sample('Next package');
  await cache.put(a, old.verified, {});
  const restored: (() => void)[] = []; const bodyRequests: string[] = [];
  for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) {
    for (const name of ['get', 'getAll', 'openCursor', 'getAllRecords']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor) continue;
      Object.defineProperty(prototype, name, { ...descriptor, value: function (this: IDBObjectStore | IDBIndex, ...args: unknown[]) {
        const store = 'objectStore' in this ? this.objectStore : this;
        if (store.name === 'packages') { bodyRequests.push(name); throw new Error('unexpected cached package body read'); }
        return Reflect.apply(descriptor.value as (...values: unknown[]) => unknown, this, args);
      } });
      restored.push(() => Object.defineProperty(prototype, name, descriptor));
    }
  }
  try {
    assert.equal((await cache.list(a)).length, 1);
    await cache.put(a, next.verified, {});
    assert.equal((await cache.list(a)).length, 2);
    assert.deepEqual(bodyRequests, []);
  } finally { for (const restore of restored) restore(); }
  await expectDocument(cache, old.version, old.verified); await expectDocument(cache, next.version, next.verified);
});

test('web metadata/content divergence rejects reads, quota updates and lists; explicit clear repairs both stores', async (t) => {
  const { cache, factory, databaseName } = await fixture(t, 'web'); const old = await sample(); const next = await sample('Next package');
  await cache.put(a, old.verified, {});
  const db = await openIndexedDB(factory, databaseName);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').delete(JSON.stringify([accountScopeKey(a), old.version.entityId, old.version.data.sha256]));
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
    });
    await assert.rejects(cache.read(a, old.version, 2), { code: 'CACHE_CORRUPT' });
    await assert.rejects(cache.list(a), { code: 'CACHE_CORRUPT' });
    await assert.rejects(cache.put(a, next.verified, {}), { code: 'CACHE_CORRUPT' });
    await cache.clear(a, {}); assert.deepEqual(await cache.list(a), []);
    await cache.put(a, next.verified, {}); await expectDocument(cache, next.version, next.verified);
  } finally { db.close(); }
});

test('web v2 metadata upgrade preserves existing v1 packages and includes them in atomic quota checks', async (t) => {
  const factory = new IDBFactory(); const databaseName = crypto.randomUUID(); const old = await sample(); const next = await sample('Next package');
  const account = accountScopeKey(a); const payload = JSON.stringify(old.verified.document);
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('packages', { keyPath: 'key' }).createIndex('account', 'scopeKey');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction('packages', 'readwrite');
    tx.objectStore('packages').put({ key: JSON.stringify([account, old.version.entityId, old.version.data.sha256]), scopeKey: account,
      versionId: old.version.entityId, sha256: old.version.data.sha256, sizeBytes: new TextEncoder().encode(payload).byteLength,
      storedAt: 1234, digest: old.verified.digest, payload });
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
  });
  legacy.close();
  const cache = new WebParsedCache({ indexedDB: factory, databaseName, limits: { maxCacheEntries: 1 } }); t.after(() => cache.close());
  await expectDocument(cache, old.version, old.verified);
  assert.equal((await cache.list(a))[0].storedAt, 1234);
  await assert.rejects(cache.put(a, next.verified, {}), { code: 'CACHE_FULL' });
  await expectDocument(cache, old.version, old.verified);
});

for (const backend of ['web', 'sqlite'] as const) {
  test(`${backend}: durable package replacement isolates service/account and PDF hash; version removal stays in account`, async (t) => {
    const { cache, open } = await fixture(t, backend);
    const original = await sample(); const replacement = await sample('Updated text', { version: original.version });
    await cache.put(a, original.verified, {}); await cache.put(b, original.verified, {}); await cache.put(c, original.verified, {});
    await cache.put(a, replacement.verified, {});
    const reopened = open();
    await expectDocument(reopened, original.version, replacement.verified);
    await expectDocument(reopened, original.version, original.verified, b);
    await expectDocument(reopened, original.version, original.verified, c);
    const otherHash = structuredClone(original.version); otherHash.data.sha256 = 'b'.repeat(64);
    assert.equal(await cache.read(a, otherHash, 2), null);
    const variant = await sample('Same version, different PDF identity', { version: otherHash });
    await cache.put(a, variant.verified, {});
    assert.equal((await cache.list(a)).length, 2);
    await cache.remove(a, original.version.entityId, { guard: () => true });
    assert.deepEqual(await cache.list(a), []);
    await expectDocument(cache, original.version, original.verified, b);
    await cache.clear(b, {}); assert.deepEqual(await cache.list(b), []);
    await expectDocument(cache, original.version, original.verified, c);
  });

  test(`${backend}: write/COMMIT failure retains the old package and sanitizes backend failures`, async (t) => {
    const { cache, writeHook, open } = await fixture(t, backend);
    const old = await sample(); const next = await sample('Replacement', { version: old.version });
    await cache.put(a, old.verified, {});
    await assert.rejects(writeHook(() => undefined, () => cache.put(a, next.verified, {}), true), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'CACHE_UNAVAILABLE');
      assert.ok(!String(error).includes('private-disk-path-sentinel')); return true;
    });
    await expectDocument(open(), old.version, old.verified);
  });

  test(`${backend}: invalid guard or cancellation before commit rolls back replacement; queued late writes stay isolated`, async (t) => {
    const { cache, writeHook } = await fixture(t, backend);
    const old = await sample(); const next = await sample('Late replacement', { version: old.version });
    await cache.put(a, old.verified, {});
    let current = true;
    await assert.rejects(writeHook(() => { current = false; }, () => cache.put(a, next.verified, { guard: () => current })), { code: 'ACCOUNT_CHANGED' });
    await expectDocument(cache, old.version, old.verified);
    const abort = new AbortController();
    await assert.rejects(writeHook(() => abort.abort(), () => cache.put(a, next.verified, { signal: abort.signal })), { code: 'CANCELLED' });
    await expectDocument(cache, old.version, old.verified);
    await assert.rejects(cache.put(a, next.verified, { guard: () => false }), { code: 'ACCOUNT_CHANGED' });
    const preAborted = new AbortController(); preAborted.abort();
    await assert.rejects(cache.put(a, next.verified, { signal: preAborted.signal }), { code: 'CANCELLED' });
    await cache.put(b, next.verified, {}); await expectDocument(cache, old.version, next.verified, b);
    await expectDocument(cache, old.version, old.verified);
  });

  test(`${backend}: every read detects changed package digest and rechecks paper, size and known pages`, async (t) => {
    const { cache, raw } = await fixture(t, backend);
    const old = await sample(); await cache.put(a, old.verified, {});
    const wrongPaper = structuredClone(old.version); wrongPaper.data.paperId = crypto.randomUUID();
    await assert.rejects(cache.read(a, wrongPaper, 2), { code: 'VERSION_MISMATCH' });
    const wrongSize = structuredClone(old.version); wrongSize.data.sizeBytes++;
    await assert.rejects(cache.read(a, wrongSize, 2), { code: 'VERSION_MISMATCH' });
    const unknownPages = structuredClone(old.version); unknownPages.data.pageCount = null;
    await assert.rejects(cache.read(a, unknownPages, 3), { code: 'VERSION_MISMATCH' });
    await assert.rejects(cache.read(a, old.version, 3), { code: 'VERSION_MISMATCH' });
    await raw((row) => {
      const document = JSON.parse(row.payload) as ParsedDocumentPackage;
      document.blocks[0].text = 'Tampered but structurally valid';
      const payload = JSON.stringify(document);
      return { ...row, payload, sizeBytes: new TextEncoder().encode(payload).byteLength };
    });
    await assert.rejects(cache.read(a, old.version, 2), { code: 'CACHE_CORRUPT' });
    assert.equal((await cache.list(a)).length, 1, 'reading never silently deletes a damaged cache entry');
  });

  test(`${backend}: every read verifies asset bytes even if an attacker updates the package digest`, async (t) => {
    const { cache, raw } = await fixture(t, backend);
    const old = await sample('With an image', { asset: true }); await cache.put(a, old.verified, {});
    await raw((row) => {
      const document = JSON.parse(row.payload) as ParsedDocumentPackage;
      const bytes = Buffer.from(document.assets[0].base64, 'base64');
      bytes[45] ^= 1;
      document.assets[0].base64 = bytes.toString('base64');
      const payload = JSON.stringify(document);
      return { ...row, payload, sizeBytes: new TextEncoder().encode(payload).byteLength,
        digest: createHash('sha256').update(payload).digest('hex') };
    });
    await assert.rejects(cache.read(a, old.version, 2), { code: 'CACHE_CORRUPT' });
    const forged = structuredClone(old.verified); forged.digest = '0'.repeat(64);
    await assert.rejects(cache.put(a, forged, {}), { code: 'CACHE_CORRUPT' });
  });

  test(`${backend}: explicit entry and byte quotas reject without eviction, including oversized replacement`, async (t) => {
    const small = await sample(); const large = await sample('x'.repeat(500), { version: small.version }); const other = await sample('Another version');
    const bytes = new TextEncoder().encode(JSON.stringify(small.verified.document)).byteLength;
    const { cache } = await fixture(t, backend, { limits: { maxCacheBytes: bytes + 4, maxCacheEntries: 1 } });
    await cache.put(a, small.verified, {});
    await assert.rejects(cache.put(a, other.verified, {}), { code: 'CACHE_FULL' });
    await assert.rejects(cache.put(a, large.verified, {}), { code: 'CACHE_FULL' });
    await expectDocument(cache, small.version, small.verified);
    await cache.put(b, small.verified, {}); await expectDocument(cache, small.version, small.verified, b);
    await assert.rejects(cache.remove(a, small.version.entityId, { guard: () => false }), { code: 'ACCOUNT_CHANGED' });
    await assert.rejects(cache.clear(a, { guard: () => false }), { code: 'ACCOUNT_CHANGED' });
    await expectDocument(cache, small.version, small.verified);
    await cache.clear(a, {}); assert.deepEqual(await cache.list(a), []);
  });

  test(`${backend}: async integrity verification suppresses results after an account switch or abort`, async (t) => {
    const { cache } = await fixture(t, backend); const old = await sample(); await cache.put(a, old.verified, {});
    for (const cancellation of ['guard', 'abort'] as const) {
      const entered = deferred(); const release = deferred(); let active = true; const controller = new AbortController();
      const original = crypto.subtle.digest;
      Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async (...args: Parameters<SubtleCrypto['digest']>) => {
        entered.resolve(); await release.promise; return original.apply(crypto.subtle, args);
      } });
      try {
        const reading = cache.read(a, old.version, 2, { guard: () => active, signal: controller.signal });
        const rejection = assert.rejects(reading, { code: cancellation === 'guard' ? 'ACCOUNT_CHANGED' : 'CANCELLED' });
        await entered.promise;
        if (cancellation === 'guard') active = false; else controller.abort();
        release.resolve(); await rejection;
      } finally { release.resolve(); Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: original }); }
    }
    await expectDocument(cache, old.version, old.verified);
  });

  test(`${backend}: concurrent handles serialize quota decisions, and the default 32-entry limit refuses the 33rd`, async (t) => {
    const setup = await fixture(t, backend, { limits: { maxCacheEntries: 1 } });
    const one = await sample(); const two = await sample('Second');
    const results = await Promise.allSettled([setup.cache.put(a, one.verified, {}), setup.open().put(a, two.verified, {})]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(rejected?.reason.code, 'CACHE_FULL'); assert.equal((await setup.cache.list(a)).length, 1);
    const defaults = await fixture(t, backend);
    const versions = await Promise.all(Array.from({ length: 33 }, (_, index) => sample(`Package ${index}`)));
    for (const value of versions.slice(0, 32)) await defaults.cache.put(a, value.verified, {});
    await assert.rejects(defaults.cache.put(a, versions[32].verified, {}), { code: 'CACHE_FULL' });
    assert.equal((await defaults.cache.list(a)).length, 32);
    await expectDocument(defaults.cache, versions[0].version, versions[0].verified);
  });

  test(`${backend}: explicit removal/clear can recover corrupt payloads; cancelled cleanup keeps existing packages`, async (t) => {
    const { cache, raw } = await fixture(t, backend); const value = await sample();
    await cache.put(a, value.verified, {}); await cache.put(b, value.verified, {});
    await raw((row) => ({ ...row, payload: '{truncated' }));
    await assert.rejects(cache.read(a, value.version, 2), { code: 'CACHE_CORRUPT' });
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(cache.read(b, value.version, 2, { signal: aborted.signal }), { code: 'CANCELLED' });
    await assert.rejects(cache.clear(b, { signal: aborted.signal }), { code: 'CANCELLED' });
    await assert.rejects(cache.remove(b, value.version.entityId, { signal: aborted.signal }), { code: 'CANCELLED' });
    await cache.remove(a, value.version.entityId, {}); assert.deepEqual(await cache.list(a), []);
    await cache.put(a, value.verified, {}); await raw((row) => ({ ...row, payload: '{truncated' }));
    await cache.clear(a, {}); assert.deepEqual(await cache.list(a), []);
    await expectDocument(cache, value.version, value.verified, b);
  });
}

test('SQLite parsed package storage uses its own file and never updates sync account snapshots', async (t) => {
  const { cache, driver } = await fixture(t, 'sqlite'); const old = await sample();
  driver!.db.prepare('INSERT INTO account_snapshots (scope_key, payload) VALUES (?, ?)').run(accountScopeKey(a), 'sync-snapshot-sentinel');
  await cache.put(a, old.verified, {}); await cache.clear(a, {});
  assert.deepEqual(driver!.db.prepare('SELECT payload FROM account_snapshots').all().map((row) => row.payload), ['sync-snapshot-sentinel']);
  assert.equal(PARSED_CACHE_DATABASE, 'paperquay_parsed_v1');
});

test('SQLite acknowledges a package only after COMMIT and serializes concurrent quota decisions', async (t) => {
  const { cache, driver, open } = await fixture(t, 'sqlite', { limits: { maxCacheEntries: 1 } });
  const first = await sample(); const second = await sample('Second'); const entered = deferred(); const release = deferred();
  driver!.beforeCommit = async () => { entered.resolve(); await release.promise; };
  let complete = false;
  const saving = cache.put(a, first.verified, {}).then(() => { complete = true; });
  await entered.promise; assert.equal(complete, false); release.resolve(); await saving;
  driver!.beforeCommit = undefined;
  await assert.rejects(open().put(a, second.verified, {}), { code: 'CACHE_FULL' });
  await expectDocument(cache, first.version, first.verified);
});

test('SQLite failed replacement preserves the old verified package after closing and reopening the physical file', async (t) => {
  const { cache, driver, database, path } = await fixture(t, 'sqlite');
  const old = await sample(); const next = await sample('Uncommitted replacement', { version: old.version });
  await cache.put(a, old.verified, {}); driver!.failCommit = true;
  await assert.rejects(cache.put(a, next.verified, {}), { code: 'CACHE_UNAVAILABLE' });
  driver!.failCommit = false; await database!.close();
  const reopenedDatabase = new AccountSqliteDatabase(new Driver(path));
  try { await expectDocument(new SqliteParsedCache(reopenedDatabase), old.version, old.verified); }
  finally { await reopenedDatabase.close(); }
});

test('the default hard limits remain 64 MiB per account and 32 packages', () => {
  assert.equal(PARSED_CACHE_LIMITS.maxCacheBytes, 64 * 1024 * 1024);
  assert.equal(PARSED_CACHE_LIMITS.maxCacheEntries, 32);
});

for(const backend of ['web','sqlite'] as const) {
  test(`${backend}: private export verifies orphan packages without a live library entity and rejects corrupt or foreign cache entries`,async t=>{
    const f=await fixture(t,backend),source=await sample('Orphan export sentinel');
    await f.cache.put(a,source.verified,{});const entry=(await f.cache.list(a))[0];
    assert.deepEqual(await f.cache.exportEntry(a,entry),source.verified);
    await assert.rejects(f.cache.exportEntry(b,entry),{code:'CACHE_CORRUPT'});
    await f.raw(row=>({...row,payload:row.payload.replace('Orphan export sentinel','Altered export sentinel')}));
    await assert.rejects(f.cache.exportEntry(a,entry),{code:'CACHE_CORRUPT'});
  });
}
