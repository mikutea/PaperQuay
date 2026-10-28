import { Capacitor } from '@capacitor/core';
import {
  decodeParsedDocument, validateEntityData, verifyParsedDocument, type ParsedDocumentPackage,
} from '../../../../packages/sync-core/src/index.ts';
import { accountScopeKey, type AccountScope } from '../storage/accountStore.ts';
import { AccountSqliteDatabase, type AccountSqliteDriver } from '../storage/sqliteAccountStore.ts';
import { PdfError, throwIfAborted } from '../pdf/errors.ts';
import type { PdfVersion } from '../pdf/types.ts';

export interface ParsedCacheOptions { signal?: AbortSignal; guard?: () => boolean }
export interface VerifiedParsedDocument { document: ParsedDocumentPackage; digest: string }
export interface ParsedCacheEntry { versionId: string; sha256: string; sizeBytes: number; storedAt: number }
export interface ParsedCache {
  read(scope: AccountScope, version: PdfVersion, pageCount: number, options?: ParsedCacheOptions): Promise<VerifiedParsedDocument | null>;
  put(scope: AccountScope, validated: VerifiedParsedDocument, options: ParsedCacheOptions): Promise<void>;
  remove(scope: AccountScope, versionId: string, options?: ParsedCacheOptions): Promise<void>;
  clear(scope: AccountScope, options?: ParsedCacheOptions): Promise<void>;
  list(scope: AccountScope): Promise<ParsedCacheEntry[]>;
}

export interface ParsedCacheLimits { maxCacheBytes: number; maxCacheEntries: number }
export const PARSED_CACHE_LIMITS: Readonly<ParsedCacheLimits> = Object.freeze({ maxCacheBytes: 64 * 1024 * 1024, maxCacheEntries: 32 });
export const PARSED_CACHE_DATABASE = 'paperquay_parsed_v1';
const maxPackageBytes = 16 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
type Limits = ParsedCacheLimits;
interface Metadata extends ParsedCacheEntry { key: string; scopeKey: string; digest: string }
interface RecordRow extends Metadata { payload: string }
interface CacheConfig { limits?: Partial<Limits>; now?: () => number }

function limitsFor(value?: Partial<Limits>): Limits {
  const limits = { ...PARSED_CACHE_LIMITS, ...value };
  for (const key of ['maxCacheBytes', 'maxCacheEntries'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > PARSED_CACHE_LIMITS[key]) throw new PdfError('CACHE_UNAVAILABLE');
  }
  return limits;
}
function scopeKey(scope: AccountScope): string {
  try { return accountScopeKey({ apiBaseUrl: scope.apiBaseUrl, accountId: scope.accountId.toLowerCase() }); }
  catch { throw new PdfError('ACCOUNT_CHANGED'); }
}
function keyFor(account: string, versionId: string, sha256: string): string {
  if (!uuid.test(versionId) || !hash.test(sha256)) throw new PdfError('VERSION_MISMATCH');
  return JSON.stringify([account, versionId, sha256]);
}
function check(options: ParsedCacheOptions): void {
  throwIfAborted(options.signal);
  try { if (options.guard && !options.guard()) throw new Error(); }
  catch { throw new PdfError('ACCOUNT_CHANGED'); }
}
function cacheFailure(error: unknown): PdfError {
  return error instanceof PdfError ? error : new PdfError('CACHE_UNAVAILABLE');
}
function metadata(value: unknown, account: string): Metadata {
  const row = value as Metadata;
  if (!row || typeof row !== 'object' || row.scopeKey !== account || !uuid.test(row.versionId) || !hash.test(row.sha256)
      || !hash.test(row.digest) || row.key !== JSON.stringify([account, row.versionId, row.sha256])
      || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 1 || row.sizeBytes > maxPackageBytes
      || !Number.isSafeInteger(row.storedAt) || row.storedAt < 0) throw new PdfError('CACHE_CORRUPT');
  return { key: row.key, scopeKey: account, versionId: row.versionId, sha256: row.sha256,
    sizeBytes: row.sizeBytes, storedAt: row.storedAt, digest: row.digest };
}
function record(value: unknown, account: string): RecordRow {
  const row = value as RecordRow;
  const meta = metadata(value, account);
  if (typeof row.payload !== 'string' || row.payload.length > maxPackageBytes || encoder.encode(row.payload).byteLength !== meta.sizeBytes)
    throw new PdfError('CACHE_CORRUPT');
  return { ...meta, payload: row.payload };
}
function checkedRows(values: unknown[], account: string, limits: Limits): Metadata[] {
  const rows = values.map((value) => metadata(value, account));
  if (new Set(rows.map((row) => row.key)).size !== rows.length || rows.length > limits.maxCacheEntries
      || rows.reduce((sum, row) => sum + row.sizeBytes, 0) > limits.maxCacheBytes) throw new PdfError('CACHE_CORRUPT');
  return rows;
}
function matchingKeys(rows: Metadata[], keys: IDBValidKey[]): void {
  const expected = new Set(rows.map((row) => row.key));
  if (keys.length !== rows.length || keys.some((key) => typeof key !== 'string' || !expected.has(key))) throw new PdfError('CACHE_CORRUPT');
}
function matchingMetadata(value: unknown, expected: Metadata, account: string): void {
  if (JSON.stringify(metadata(value, account)) !== JSON.stringify(expected)) throw new PdfError('CACHE_CORRUPT');
}
function entries(rows: Metadata[]): ParsedCacheEntry[] {
  return rows.map(({ versionId, sha256, sizeBytes, storedAt }) => ({ versionId, sha256, sizeBytes, storedAt }))
    .sort((left, right) => right.storedAt - left.storedAt || left.versionId.localeCompare(right.versionId) || left.sha256.localeCompare(right.sha256));
}
function capacity(rows: Metadata[], incoming: RecordRow, limits: Limits): void {
  const retained = rows.filter((row) => row.key !== incoming.key);
  if (retained.length + 1 > limits.maxCacheEntries
      || retained.reduce((sum, row) => sum + row.sizeBytes, incoming.sizeBytes) > limits.maxCacheBytes) throw new PdfError('CACHE_FULL');
}
async function prepare(account: string, value: VerifiedParsedDocument, options: ParsedCacheOptions, now: () => number): Promise<RecordRow> {
  check(options);
  const expectedDigest = value.digest;
  let verified: VerifiedParsedDocument;
  try { verified = await verifyParsedDocument(value.document); }
  catch { check(options); throw new PdfError('CACHE_CORRUPT'); }
  check(options);
  if (verified.digest !== expectedDigest) throw new PdfError('CACHE_CORRUPT');
  const document = verified.document;
  const payload = JSON.stringify(document);
  return record({ key: keyFor(account, document.attachmentVersionId, document.pdf.sha256), scopeKey: account,
    versionId: document.attachmentVersionId, sha256: document.pdf.sha256, sizeBytes: encoder.encode(payload).byteLength,
    storedAt: now(), digest: verified.digest, payload }, account);
}
function expectedVersion(version: PdfVersion, pageCount: number): PdfVersion {
  const captured = { entityId: version.entityId, data: { ...version.data } };
  if (!uuid.test(captured.entityId) || !validateEntityData('attachmentVersion', captured.data).ok
      || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 2000
      || (captured.data.pageCount !== null && captured.data.pageCount !== pageCount)) throw new PdfError('VERSION_MISMATCH');
  return captured;
}
async function verifyRow(value: unknown, account: string, version: PdfVersion, pageCount: number,
  options: ParsedCacheOptions): Promise<VerifiedParsedDocument> {
  check(options);
  let verified: VerifiedParsedDocument;
  try {
    const row = record(value, account);
    verified = await decodeParsedDocument(encoder.encode(row.payload));
    if (row.digest !== verified.digest || row.versionId !== verified.document.attachmentVersionId
        || row.sha256 !== verified.document.pdf.sha256) throw new Error();
  } catch { check(options); throw new PdfError('CACHE_CORRUPT'); }
  check(options);
  const document = verified.document;
  if (document.paperId !== version.data.paperId || document.attachmentVersionId !== version.entityId
      || document.pdf.sha256 !== version.data.sha256 || document.pdf.sizeBytes !== version.data.sizeBytes
      || document.pdf.pageCount !== pageCount) throw new PdfError('VERSION_MISMATCH');
  return verified;
}

/** Metadata and content move in one transaction; quota/list scans never clone package bodies. */
export class WebParsedCache implements ParsedCache {
  private readonly database: Promise<IDBDatabase>;
  private readonly limits: Limits;
  private readonly now: () => number;
  constructor(options: CacheConfig & { indexedDB?: IDBFactory; databaseName?: string } = {}) {
    this.limits = limitsFor(options.limits); this.now = options.now ?? Date.now;
    this.database = new Promise((resolve, reject) => {
      try {
        const factory = options.indexedDB ?? globalThis.indexedDB;
        if (!factory) throw new Error();
        const request = factory.open(options.databaseName ?? PARSED_CACHE_DATABASE, 2);
        let openingFailure: unknown;
        request.onupgradeneeded = (event) => {
          const db = request.result;
          const packages = event.oldVersion ? request.transaction!.objectStore('packages')
            : db.createObjectStore('packages', { keyPath: 'key' });
          if (!event.oldVersion) packages.createIndex('account', 'scopeKey');
          const index = db.createObjectStore('metadata', { keyPath: 'key' });
          index.createIndex('account', 'scopeKey');
          if (event.oldVersion === 1) {
            // One-time migration retains the unpublished v1 packages and their quota accounting.
            const cursor = packages.openCursor();
            cursor.onsuccess = () => {
              if (!cursor.result) return;
              try {
                const value = cursor.result.value as RecordRow;
                if (typeof value?.scopeKey !== 'string') throw new PdfError('CACHE_CORRUPT');
                index.put(metadata(value, value.scopeKey)); cursor.result.continue();
              } catch (error) { openingFailure = error; request.transaction!.abort(); }
            };
          }
        };
        request.onerror = request.onblocked = () => reject(cacheFailure(openingFailure));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close(); resolve(db);
        };
      } catch { reject(new PdfError('CACHE_UNAVAILABLE')); }
    });
    void this.database.catch(() => undefined);
  }
  private async query(account: string, key: string | null, options: ParsedCacheOptions): Promise<unknown[]> {
    check(options);
    const db = await this.database;
    check(options);
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(['packages', 'metadata'], 'readonly'); }
      catch { reject(new PdfError('CACHE_UNAVAILABLE')); return; }
      let result: unknown[] = []; let failure: unknown;
      const abort = () => { failure = new PdfError('CANCELLED'); try { tx.abort(); } catch { /* Already committed. */ } };
      options.signal?.addEventListener('abort', abort, { once: true });
      const content = key === null ? tx.objectStore('packages').index('account').getAllKeys(account, this.limits.maxCacheEntries + 1)
        : tx.objectStore('packages').get(key);
      const index = key === null ? tx.objectStore('metadata').index('account').getAll(account, this.limits.maxCacheEntries + 1)
        : tx.objectStore('metadata').get(key);
      let pending = 2;
      const receive = () => {
        try {
          check(options); if (--pending) return;
          if (key === null) {
            const rows = checkedRows(index.result, account, this.limits);
            matchingKeys(rows, content.result as IDBValidKey[]); result = rows;
          } else if (content.result === undefined && index.result === undefined) result = [];
          else {
            const row = record(content.result, account);
            matchingMetadata(index.result, metadata(row, account), account); result = [row];
          }
        } catch (error) { failure = error; tx.abort(); }
      };
      content.onsuccess = index.onsuccess = receive;
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      tx.oncomplete = () => { cleanup(); try { check(options); resolve(result); } catch (error) { reject(error); } };
      tx.onabort = tx.onerror = () => { cleanup(); reject(cacheFailure(failure)); };
    });
  }
  async read(scope: AccountScope, version: PdfVersion, pageCount: number, options: ParsedCacheOptions = {}): Promise<VerifiedParsedDocument | null> {
    const account = scopeKey(scope); const expected = expectedVersion(version, pageCount);
    const rows = await this.query(account, keyFor(account, expected.entityId, expected.data.sha256), options);
    check(options);
    return rows.length ? verifyRow(rows[0], account, expected, pageCount, options) : null;
  }
  private async mutate(account: string, options: ParsedCacheOptions,
    action: (rows: Metadata[], packages: IDBObjectStore, index: IDBObjectStore) => IDBRequest[]): Promise<void> {
    check(options);
    const db = await this.database;
    check(options);
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(['packages', 'metadata'], 'readwrite', { durability: 'strict' }); }
      catch { reject(new PdfError('CACHE_UNAVAILABLE')); return; }
      let failure: unknown;
      const fail = (error: unknown) => { failure = error; try { tx.abort(); } catch { /* Already committed. */ } };
      const abort = () => fail(new PdfError('CANCELLED'));
      options.signal?.addEventListener('abort', abort, { once: true });
      const finish = () => { check(options); tx.commit(); };
      const store = tx.objectStore('packages');
      const index = tx.objectStore('metadata');
      const request = index.index('account').getAll(account, this.limits.maxCacheEntries + 1);
      const contentKeys = store.index('account').getAllKeys(account, this.limits.maxCacheEntries + 1);
      let reads = 2;
      const receive = () => {
        try {
          check(options); if (--reads) return;
          const rows = checkedRows(request.result as unknown[], account, this.limits);
          matchingKeys(rows, contentKeys.result);
          const writes = action(rows, store, index);
          let pending = writes.length;
          if (!pending) finish();
          for (const write of writes) write.onsuccess = () => {
            try { check(options); if (--pending === 0) finish(); } catch (error) { fail(error); }
          };
        } catch (error) { fail(error); }
      };
      request.onsuccess = contentKeys.onsuccess = receive;
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      tx.oncomplete = () => { cleanup(); resolve(); };
      tx.onabort = tx.onerror = () => { cleanup(); reject(cacheFailure(failure)); };
    });
  }
  async put(scope: AccountScope, validated: VerifiedParsedDocument, options: ParsedCacheOptions): Promise<void> {
    const account = scopeKey(scope);
    const incoming = await prepare(account, validated, options, this.now);
    await this.mutate(account, options, (rows, store, index) => {
      capacity(rows, incoming, this.limits);
      return [index.put(metadata(incoming, account)), store.put(incoming)];
    });
  }
  private async erase(account: string, versionId: string | null, options: ParsedCacheOptions): Promise<void> {
    check(options); const db = await this.database; check(options);
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(['packages', 'metadata'], 'readwrite', { durability: 'strict' }); }
      catch { reject(new PdfError('CACHE_UNAVAILABLE')); return; }
      let failure: unknown;
      const fail = (error: unknown) => { failure = error; try { tx.abort(); } catch { /* Already committed. */ } };
      const abort = () => fail(new PdfError('CANCELLED'));
      options.signal?.addEventListener('abort', abort, { once: true });
      const store = tx.objectStore('packages');
      const index = tx.objectStore('metadata');
      // Cleanup must also work when a package's payload is corrupt. Read keys only.
      const request = store.index('account').getAllKeys(account);
      const metadataKeys = index.index('account').getAllKeys(account);
      let reads = 2;
      const receive = () => {
        try {
          check(options); if (--reads) return;
          const keys = [...new Set([...request.result, ...metadataKeys.result])].filter((key) => {
            if (versionId === null) return true;
            try { const identity: unknown = JSON.parse(String(key)); return Array.isArray(identity) && identity[0] === account && identity[1] === versionId; }
            catch { return false; }
          });
          let pending = keys.length * 2;
          if (!pending) { check(options); tx.commit(); }
          for (const key of keys) {
            const complete = () => { try { check(options); if (--pending === 0) tx.commit(); } catch (error) { fail(error); } };
            store.delete(key).onsuccess = complete; index.delete(key).onsuccess = complete;
          }
        } catch (error) { fail(error); }
      };
      request.onsuccess = metadataKeys.onsuccess = receive;
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      tx.oncomplete = () => { cleanup(); resolve(); };
      tx.onabort = tx.onerror = () => { cleanup(); reject(cacheFailure(failure)); };
    });
  }
  remove(scope: AccountScope, versionId: string, options: ParsedCacheOptions = {}): Promise<void> {
    if (!uuid.test(versionId)) return Promise.reject(new PdfError('VERSION_MISMATCH'));
    return this.erase(scopeKey(scope), versionId, options);
  }
  clear(scope: AccountScope, options: ParsedCacheOptions = {}): Promise<void> {
    return this.erase(scopeKey(scope), null, options);
  }
  async list(scope: AccountScope): Promise<ParsedCacheEntry[]> {
    const account = scopeKey(scope);
    return entries(checkedRows(await this.query(account, null, {}), account, this.limits));
  }
  async close(): Promise<void> { (await this.database).close(); }
}

const selectMetadata = 'cache_key AS key, scope_key AS scopeKey, version_id AS versionId, sha256, size_bytes AS sizeBytes, stored_at AS storedAt, digest, length(CAST(payload AS BLOB)) AS actualSize';
function sqlMetadata(value: Record<string, unknown>, account: string): Metadata {
  const row = metadata(value, account);
  if (row.sizeBytes !== value.actualSize) throw new PdfError('CACHE_CORRUPT');
  return row;
}

/** This connection must belong to paperquay_parsed_v1, never the sync-state database. */
export class SqliteParsedCache implements ParsedCache {
  private readonly ready: Promise<void>;
  private readonly limits: Limits;
  private readonly now: () => number;
  private closed = false;
  constructor(private readonly database: AccountSqliteDatabase, options: CacheConfig = {}) {
    this.limits = limitsFor(options.limits); this.now = options.now ?? Date.now;
    this.ready = database.run(async (driver) => {
      await driver.execute('CREATE TABLE IF NOT EXISTS parsed_packages (cache_key TEXT PRIMARY KEY NOT NULL, scope_key TEXT NOT NULL, version_id TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, stored_at INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS parsed_packages_account ON parsed_packages(scope_key);');
    }).catch((error) => { throw cacheFailure(error); });
    void this.ready.catch(() => undefined);
  }
  private async run<T>(action: (driver: AccountSqliteDriver) => Promise<T>): Promise<T> {
    await this.ready;
    if (this.closed) throw new PdfError('CACHE_UNAVAILABLE');
    try { return await this.database.run(action); }
    catch (error) { throw cacheFailure(error); }
  }
  async read(scope: AccountScope, version: PdfVersion, pageCount: number, options: ParsedCacheOptions = {}): Promise<VerifiedParsedDocument | null> {
    const account = scopeKey(scope); const expected = expectedVersion(version, pageCount);
    const key = keyFor(account, expected.entityId, expected.data.sha256);
    check(options);
    const rows = await this.run<Record<string, unknown>[]>(async (driver) => {
      check(options);
      // A corrupted oversized SQL value must never be transferred to JavaScript.
      const result = await driver.query(`SELECT ${selectMetadata}, CASE WHEN length(CAST(payload AS BLOB)) <= ${maxPackageBytes} THEN payload ELSE NULL END AS payload FROM parsed_packages WHERE scope_key = ? AND cache_key = ?`, [account, key]);
      check(options); return result;
    });
    check(options);
    if (!rows.length) return null;
    if (rows.length !== 1) throw new PdfError('CACHE_CORRUPT');
    sqlMetadata(rows[0], account);
    return verifyRow(rows[0], account, expected, pageCount, options);
  }
  private async mutate(account: string, options: ParsedCacheOptions,
    action: (driver: AccountSqliteDriver, rows: Metadata[]) => Promise<void>, inspectRows = true): Promise<void> {
    check(options);
    await this.run<void>(async (driver) => {
      let transaction = false;
      try {
        check(options); await driver.begin(); transaction = true;
        const values = inspectRows ? await driver.query(`SELECT ${selectMetadata} FROM parsed_packages WHERE scope_key = ? LIMIT ${this.limits.maxCacheEntries + 1}`, [account]) : [];
        check(options);
        const rows = checkedRows(values.map((value) => sqlMetadata(value, account)), account, this.limits);
        await action(driver, rows);
        check(options);
        await driver.commit(); transaction = false;
      } catch (error) {
        if (transaction) {
          try { await driver.rollback(); } catch { throw new PdfError('CACHE_UNAVAILABLE'); }
        }
        throw error;
      }
    });
  }
  async put(scope: AccountScope, validated: VerifiedParsedDocument, options: ParsedCacheOptions): Promise<void> {
    const account = scopeKey(scope); const incoming = await prepare(account, validated, options, this.now);
    await this.mutate(account, options, async (driver, rows) => {
      capacity(rows, incoming, this.limits);
      await driver.run('INSERT INTO parsed_packages (cache_key, scope_key, version_id, sha256, size_bytes, stored_at, digest, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET size_bytes = excluded.size_bytes, stored_at = excluded.stored_at, digest = excluded.digest, payload = excluded.payload',
        [incoming.key, account, incoming.versionId, incoming.sha256, String(incoming.sizeBytes), String(incoming.storedAt), incoming.digest, incoming.payload]);
    });
  }
  remove(scope: AccountScope, versionId: string, options: ParsedCacheOptions = {}): Promise<void> {
    if (!uuid.test(versionId)) return Promise.reject(new PdfError('VERSION_MISMATCH'));
    const account = scopeKey(scope);
    return this.mutate(account, options, async (driver) => { await driver.run('DELETE FROM parsed_packages WHERE scope_key = ? AND version_id = ?', [account, versionId]); }, false);
  }
  clear(scope: AccountScope, options: ParsedCacheOptions = {}): Promise<void> {
    const account = scopeKey(scope);
    return this.mutate(account, options, async (driver) => { await driver.run('DELETE FROM parsed_packages WHERE scope_key = ?', [account]); }, false);
  }
  async list(scope: AccountScope): Promise<ParsedCacheEntry[]> {
    const account = scopeKey(scope);
    return this.run<ParsedCacheEntry[]>(async (driver) => {
      const values = await driver.query(`SELECT ${selectMetadata} FROM parsed_packages WHERE scope_key = ? LIMIT ${this.limits.maxCacheEntries + 1}`, [account]);
      return entries(checkedRows(values.map((value) => sqlMetadata(value, account)), account, this.limits));
    });
  }
  async close(): Promise<void> { await this.ready; this.closed = true; await this.database.run(async () => undefined); }
}

let nativeDatabase: Promise<AccountSqliteDatabase> | undefined;
async function createNativeCache(): Promise<SqliteParsedCache> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('CapacitorSQLite')) throw new PdfError('CACHE_UNAVAILABLE');
  nativeDatabase ??= (async () => {
    const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
    const manager = new SQLiteConnection(CapacitorSQLite);
    const connection = await manager.createConnection(PARSED_CACHE_DATABASE, false, 'no-encryption', 1, false);
    try {
      await connection.open();
      const database = new AccountSqliteDatabase({
        execute: async (sql) => { await connection.execute(sql, false); },
        query: async (sql, values) => (await connection.query(sql, values)).values ?? [],
        run: async (sql, values) => { await connection.run(sql, values, false); },
        begin: async () => { await connection.beginTransaction(); },
        commit: async () => { await connection.commitTransaction(); },
        rollback: async () => { await connection.rollbackTransaction(); },
        close: async () => { await manager.closeConnection(PARSED_CACHE_DATABASE, false); },
      });
      await database.run(async () => undefined);
      return database;
    } catch (error) { await manager.closeConnection(PARSED_CACHE_DATABASE, false).catch(() => undefined); throw error; }
  })().catch(() => { nativeDatabase = undefined; throw new PdfError('CACHE_UNAVAILABLE'); });
  return new SqliteParsedCache(await nativeDatabase);
}

/** Lazy native creation keeps the public cache getter synchronous, like the PDF cache. */
class NativeParsedCache implements ParsedCache {
  private cache: Promise<SqliteParsedCache> | undefined;
  private get(): Promise<SqliteParsedCache> {
    return this.cache ??= createNativeCache().catch((error) => { this.cache = undefined; throw cacheFailure(error); });
  }
  async read(scope: AccountScope, version: PdfVersion, pageCount: number, options: ParsedCacheOptions = {}) {
    const capturedScope = { ...scope }; const capturedVersion = { entityId: version.entityId, data: { ...version.data } };
    check(options); return (await this.get()).read(capturedScope, capturedVersion, pageCount, options);
  }
  async put(scope: AccountScope, validated: VerifiedParsedDocument, options: ParsedCacheOptions) {
    const capturedScope = { ...scope };
    // Capture untrusted input before lazy connection startup, rather than retaining a caller's mutable object.
    const document = structuredClone(validated.document); const digest = validated.digest;
    check(options); return (await this.get()).put(capturedScope, { document, digest }, options);
  }
  async remove(scope: AccountScope, versionId: string, options: ParsedCacheOptions = {}) {
    const capturedScope = { ...scope }; check(options); return (await this.get()).remove(capturedScope, versionId, options);
  }
  async clear(scope: AccountScope, options: ParsedCacheOptions = {}) {
    const capturedScope = { ...scope }; check(options); return (await this.get()).clear(capturedScope, options);
  }
  async list(scope: AccountScope) { const capturedScope = { ...scope }; return (await this.get()).list(capturedScope); }
}
let sharedCache: ParsedCache | undefined;
export function getParsedCache(): ParsedCache {
  return sharedCache ??= Capacitor.isNativePlatform() ? new NativeParsedCache() : new WebParsedCache();
}
