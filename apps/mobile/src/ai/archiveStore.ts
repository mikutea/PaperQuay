import { Capacitor } from '@capacitor/core';
import { canonicalJson } from '../../../../packages/sync-core/src/index.ts';
import { accountScopeKey, type AccountScope } from '../storage/accountStore.ts';
import { AccountSqliteDatabase, type AccountSqliteDriver } from '../storage/sqliteAccountStore.ts';
import { AI_ARCHIVE_LIMITS, AiArchiveError, validateAiArchiveItem, validateAiArchiveSummary, summarizeAiArchiveItem,
  type AiArchiveItem, type AiArchiveSummary } from './archiveTypes.ts';

export interface AiArchiveOptions { signal?: AbortSignal; guard?: () => boolean }
export interface AiArchiveStore {
  list(scope: AccountScope): Promise<AiArchiveSummary[]>;
  read(scope: AccountScope, kind: 'record' | 'template', id: string, options?: AiArchiveOptions): Promise<AiArchiveItem | null>;
  put(scope: AccountScope, item: AiArchiveItem, options: AiArchiveOptions & { expectedRevision?: number }): Promise<AiArchiveItem>;
  remove(scope: AccountScope, kind: 'record' | 'template', id: string, options: AiArchiveOptions & { expectedRevision: number }): Promise<void>;
  clear(scope: AccountScope, options?: AiArchiveOptions): Promise<void>;
}
export const AI_ARCHIVE_DATABASE = 'paperquay_ai_archive_v1';
type Limits = { [K in keyof typeof AI_ARCHIVE_LIMITS]: number };
interface Config { limits?: Partial<Limits> }
interface Metadata { key: string; scopeKey: string; summary: AiArchiveSummary; sizeBytes: number; digest: string }
interface Payload { key: string; scopeKey: string; payload: string }
interface Stored { meta: Metadata; payload: string; item: AiArchiveItem }
interface Prepared extends Stored {}
type Kind = AiArchiveItem['kind'];
type Generation = number | string;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const maxEntries = AI_ARCHIVE_LIMITS.records + AI_ARCHIVE_LIMITS.templates;
const maxSummaryBytes = 16384;
function fail(code: ConstructorParameters<typeof AiArchiveError>[0]): never { throw new AiArchiveError(code); }
function failure(error: unknown): AiArchiveError { return error instanceof AiArchiveError ? error : new AiArchiveError('ARCHIVE_UNAVAILABLE'); }
function check(options: AiArchiveOptions): void {
  if (options.signal?.aborted) fail('ACCOUNT_CHANGED');
  try { if (options.guard && !options.guard()) fail('ACCOUNT_CHANGED'); }
  catch { fail('ACCOUNT_CHANGED'); }
}
function policy(options: AiArchiveOptions): AiArchiveOptions { return { signal: options.signal, guard: options.guard }; }
function limitsFor(value?: Partial<Limits>): Limits {
  const limits: Limits = { ...AI_ARCHIVE_LIMITS, ...value };
  if (value && Object.keys(value).some((key) => !Object.hasOwn(AI_ARCHIVE_LIMITS, key))) fail('ARCHIVE_UNAVAILABLE');
  for (const key of Object.keys(AI_ARCHIVE_LIMITS) as (keyof Limits)[])
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > AI_ARCHIVE_LIMITS[key]) fail('ARCHIVE_UNAVAILABLE');
  return limits;
}
function scopeOf(scope: AccountScope): string {
  try { return accountScopeKey({ apiBaseUrl: scope.apiBaseUrl, accountId: scope.accountId }); }
  catch { return fail('ACCOUNT_CHANGED'); }
}
function keyFor(scope: string, kind: Kind, id: string): string {
  if (!['record', 'template'].includes(kind) || typeof id !== 'string' || !uuid.test(id)) return fail('INVALID_ITEM');
  return JSON.stringify([scope, kind, id]);
}
function ownsKey(key: unknown, scope: string): key is string {
  if (typeof key !== 'string') return false;
  try { const value = JSON.parse(key); return Array.isArray(value) && value.length === 3 && value[0] === scope
    && ['record', 'template'].includes(value[1]) && uuid.test(value[2]) && JSON.stringify(value) === key; }
  catch { return false; }
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','));
}
function generation(value: unknown, scope: string): Generation {
  if (value === undefined || value === null) return 0;
  if (!exact(value, ['scopeKey', 'generation']) || value.scopeKey !== scope) return fail('ARCHIVE_CORRUPT');
  const token = value.generation;
  if (typeof token === 'number' && Number.isSafeInteger(token) && token >= 0) return token;
  if (typeof token === 'string' && token.startsWith('reset-') && uuid.test(token.slice(6))) return token;
  return fail('ARCHIVE_CORRUPT');
}
function nextGeneration(value: unknown, scope: string): Generation {
  try {
    const previous = generation(value, scope);
    if (typeof previous === 'number' && previous < Number.MAX_SAFE_INTEGER) return previous + 1;
  } catch { /* Explicit recovery may replace corrupt control metadata too. */ }
  // Never recycle zero or a previous numeric generation after corruption.
  try { const id = crypto.randomUUID(); if (!uuid.test(id)) return fail('ARCHIVE_UNAVAILABLE'); return `reset-${id}`; }
  catch { return fail('ARCHIVE_UNAVAILABLE'); }
}
function metadata(value: unknown, scope: string): Metadata {
  try {
    if (!exact(value, ['key', 'scopeKey', 'summary', 'sizeBytes', 'digest']) || value.scopeKey !== scope
        || typeof value.digest !== 'string' || !hash.test(value.digest)) return fail('ARCHIVE_CORRUPT');
    const summary = validateAiArchiveSummary(value.summary);
    if (value.key !== keyFor(scope, summary.kind, summary.id) || !Number.isSafeInteger(value.sizeBytes)
        || (value.sizeBytes as number) < 1 || (value.sizeBytes as number) > AI_ARCHIVE_LIMITS[summary.kind === 'record' ? 'recordBytes' : 'templateBytes'])
      return fail('ARCHIVE_CORRUPT');
    return { key: value.key as string, scopeKey: scope, summary, sizeBytes: value.sizeBytes as number, digest: value.digest };
  } catch { return fail('ARCHIVE_CORRUPT'); }
}
function rowsFor(values: unknown[], keys: unknown[], scope: string, control: unknown, limits: Limits): Metadata[] {
  const rows = values.map((value) => metadata(value, scope));
  const expected = new Set(rows.map((row) => row.key));
  if (rows.length > maxEntries || expected.size !== rows.length || keys.length !== rows.length
      || keys.some((key) => typeof key !== 'string' || !expected.has(key)) || rows.length && !control) fail('ARCHIVE_CORRUPT');
  generation(control, scope);
  if (rows.filter((row) => row.summary.kind === 'record').length > limits.records
      || rows.filter((row) => row.summary.kind === 'template').length > limits.templates
      || rows.reduce((sum, row) => sum + row.sizeBytes, 0) > limits.accountBytes) fail('ARCHIVE_CORRUPT');
  return rows;
}
function raw(metaValue: unknown, payloadValue: unknown, scope: string): Stored | null {
  if (metaValue === undefined && payloadValue === undefined) return null;
  try {
    const meta = metadata(metaValue, scope);
    if (!exact(payloadValue, ['key', 'scopeKey', 'payload']) || payloadValue.key !== meta.key || payloadValue.scopeKey !== scope
        || typeof payloadValue.payload !== 'string' || payloadValue.payload.length > meta.sizeBytes
        || encoder.encode(payloadValue.payload).byteLength !== meta.sizeBytes) return fail('ARCHIVE_CORRUPT');
    const item = validateAiArchiveItem(JSON.parse(payloadValue.payload));
    if (canonicalJson(item) !== payloadValue.payload || canonicalJson(summarizeAiArchiveItem(item)) !== canonicalJson(meta.summary)) fail('ARCHIVE_CORRUPT');
    return { meta, payload: payloadValue.payload, item };
  } catch { return fail('ARCHIVE_CORRUPT'); }
}
async function digest(payload: string): Promise<string> {
  try {
    const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(payload));
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== 32) return fail('ARCHIVE_UNAVAILABLE');
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch { return fail('ARCHIVE_UNAVAILABLE'); }
}
async function verify(value: Stored | null, options: AiArchiveOptions): Promise<Stored | null> {
  check(options);
  if (value && await digest(value.payload) !== value.meta.digest) fail('ARCHIVE_CORRUPT');
  check(options); return value;
}
async function prepare(scope: string, item: AiArchiveItem, limits: Limits, options: AiArchiveOptions): Promise<Prepared> {
  // item was already detached synchronously at the public entry point.
  const payload = canonicalJson(item); const sizeBytes = encoder.encode(payload).byteLength;
  if (sizeBytes > limits[item.kind === 'record' ? 'recordBytes' : 'templateBytes']) fail('RECORD_LIMIT');
  const value = await digest(payload); check(options);
  return { item, payload, meta: { key: keyFor(scope, item.kind, item.id), scopeKey: scope,
    summary: summarizeAiArchiveItem(item), sizeBytes, digest: value } };
}
function decide(incoming: Prepared, previous: Stored | null, current: Stored | null, expected: number | undefined): boolean {
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) fail('ITEM_CHANGED');
  if (incoming.item.kind === 'record') {
    if (expected !== undefined && expected !== 0) fail('ITEM_CHANGED');
    if (current) {
      if (current.meta.digest === incoming.meta.digest && current.payload === incoming.payload) return false;
      return fail('ITEM_CHANGED');
    }
  } else if (current) {
    if (expected !== current.item.revision || incoming.item.revision !== current.item.revision + 1
        || incoming.item.createdAt !== current.item.createdAt || incoming.item.updatedAt <= current.item.updatedAt
        || previous?.payload !== current.payload || previous.meta.digest !== current.meta.digest) fail('ITEM_CHANGED');
    return true;
  }
  if (current || previous || incoming.item.revision !== 1 || expected !== undefined && expected !== 0) fail('ITEM_CHANGED');
  return true;
}
function capacity(rows: Metadata[], incoming: Prepared, limits: Limits): void {
  const retained = rows.filter((row) => row.key !== incoming.meta.key);
  if (retained.filter((row) => row.summary.kind === incoming.item.kind).length + 1 > limits[incoming.item.kind === 'record' ? 'records' : 'templates']
      || retained.reduce((sum, row) => sum + row.sizeBytes, incoming.meta.sizeBytes) > limits.accountBytes) fail('ARCHIVE_FULL');
}
function summaries(rows: Metadata[]): AiArchiveSummary[] {
  return rows.map((row) => row.summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** Three stores move together. Controls persist through clear so a pending
 * operation in another handle/tab cannot refill a deliberately cleared scope. */
export class WebAiArchiveStore implements AiArchiveStore {
  private readonly database: Promise<IDBDatabase>;
  private readonly limits: Limits;
  constructor(options: Config & { indexedDB?: IDBFactory; databaseName?: string } = {}) {
    this.limits = limitsFor(options.limits);
    this.database = new Promise((resolve, reject) => {
      try {
        const request = (options.indexedDB ?? globalThis.indexedDB).open(options.databaseName ?? AI_ARCHIVE_DATABASE, 1);
        request.onupgradeneeded = () => {
          for (const name of ['metadata', 'payloads']) request.result.createObjectStore(name, { keyPath: 'key' }).createIndex('account', 'scopeKey');
          request.result.createObjectStore('controls', { keyPath: 'scopeKey' });
        };
        request.onerror = request.onblocked = () => reject(new AiArchiveError('ARCHIVE_UNAVAILABLE'));
        request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
      } catch { reject(new AiArchiveError('ARCHIVE_UNAVAILABLE')); }
    });
    void this.database.catch(() => undefined);
  }
  private async transaction<T>(mode: IDBTransactionMode, options: AiArchiveOptions,
    action: (tx: IDBTransaction, finish: (value: T) => void, abort: (error: unknown) => void) => void): Promise<T> {
    check(options); let db: IDBDatabase;
    try { db = await this.database; } catch (error) { throw failure(error); }
    check(options);
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(['metadata', 'payloads', 'controls'], mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
      catch { reject(new AiArchiveError('ARCHIVE_UNAVAILABLE')); return; }
      let result: T, reason: unknown, finished = false;
      const abort = (error: unknown) => { reason = error; try { tx.abort(); } catch { /* Commit acknowledgement owns the result once committed. */ } };
      const cancel = () => abort(new AiArchiveError('ACCOUNT_CHANGED'));
      options.signal?.addEventListener('abort', cancel, { once: true });
      const finish = (value: T) => { check(options); result = value; finished = true; if (mode === 'readwrite') tx.commit(); };
      const cleanup = () => options.signal?.removeEventListener('abort', cancel);
      tx.oncomplete = () => { cleanup(); if (finished) resolve(result); else reject(new AiArchiveError('ARCHIVE_UNAVAILABLE')); };
      tx.onabort = tx.onerror = () => { cleanup(); reject(failure(reason)); };
      try { action(tx, finish, abort); } catch (error) { abort(error); }
    });
  }
  private capture(scope: string, options: AiArchiveOptions): Promise<Generation> {
    return this.transaction('readonly', options, (tx, finish, abort) => {
      const request = tx.objectStore('controls').get(scope);
      request.onsuccess = () => { try { finish(generation(request.result, scope)); } catch (error) { abort(error); } };
    });
  }
  private load(scope: string, key: string, options: AiArchiveOptions): Promise<{ generation: Generation; row: Stored | null }> {
    return this.transaction('readonly', options, (tx, finish, abort) => {
      const meta = tx.objectStore('metadata').get(key), payload = tx.objectStore('payloads').get(key), control = tx.objectStore('controls').get(scope);
      let pending = 3;
      const receive = () => { try {
        check(options); if (--pending) return;
        const row = raw(meta.result, payload.result, scope);
        if (row && !control.result) fail('ARCHIVE_CORRUPT');
        finish({ generation: generation(control.result, scope), row });
      } catch (error) { abort(error); } };
      meta.onsuccess = payload.onsuccess = control.onsuccess = receive;
    });
  }
  private mutate(scope: string, options: AiArchiveOptions, expectedGeneration: Generation, target: string | null,
    action: (tx: IDBTransaction, rows: Metadata[], current: Stored | null) => IDBRequest[]): Promise<void> {
    return this.transaction('readwrite', options, (tx, finish, abort) => {
      const metas = tx.objectStore('metadata').index('account').getAll(scope, maxEntries + 1);
      const keys = tx.objectStore('payloads').index('account').getAllKeys(scope, maxEntries + 1);
      const control = tx.objectStore('controls').get(scope);
      const payload = target ? tx.objectStore('payloads').get(target) : null;
      let pending = payload ? 4 : 3;
      const receive = () => { try {
        check(options); if (--pending) return;
        if (generation(control.result, scope) !== expectedGeneration) fail('ACCOUNT_CHANGED');
        const rows = rowsFor(metas.result, keys.result, scope, control.result, this.limits);
        const current = target ? raw(rows.find((row) => row.key === target), payload!.result, scope) : null;
        const writes = action(tx, rows, current);
        let remaining = writes.length;
        if (!remaining) finish();
        for (const write of writes) write.onsuccess = () => { try { check(options); if (--remaining === 0) finish(); } catch (error) { abort(error); } };
      } catch (error) { abort(error); } };
      metas.onsuccess = keys.onsuccess = control.onsuccess = receive;
      if (payload) payload.onsuccess = receive;
    });
  }
  async list(scope: AccountScope): Promise<AiArchiveSummary[]> {
    const account = scopeOf(scope);
    return this.transaction('readonly', {}, (tx, finish, abort) => {
      const metas = tx.objectStore('metadata').index('account').getAll(account, maxEntries + 1);
      const keys = tx.objectStore('payloads').index('account').getAllKeys(account, maxEntries + 1);
      const control = tx.objectStore('controls').get(account); let pending = 3;
      const receive = () => { try { if (--pending === 0) finish(summaries(rowsFor(metas.result, keys.result, account, control.result, this.limits))); } catch (error) { abort(error); } };
      metas.onsuccess = keys.onsuccess = control.onsuccess = receive;
    });
  }
  async read(scope: AccountScope, kind: Kind, id: string, options: AiArchiveOptions = {}): Promise<AiArchiveItem | null> {
    const account = scopeOf(scope), settings = policy(options), key = keyFor(account, kind, id);
    const loaded = await this.load(account, key, settings); const checked = await verify(loaded.row, settings);
    if (await this.capture(account, settings) !== loaded.generation) fail('ACCOUNT_CHANGED');
    check(settings); return checked?.item ?? null;
  }
  async put(scope: AccountScope, item: AiArchiveItem, options: AiArchiveOptions & { expectedRevision?: number } = {}): Promise<AiArchiveItem> {
    const account = scopeOf(scope), settings = policy(options), expected = options.expectedRevision;
    check(settings); const detached = validateAiArchiveItem(item);
    const captured = await this.capture(account, settings);
    const incoming = await prepare(account, detached, this.limits, settings);
    const loaded = await this.load(account, incoming.meta.key, settings);
    if (loaded.generation !== captured) fail('ACCOUNT_CHANGED');
    const previous = await verify(loaded.row, settings);
    await this.mutate(account, settings, captured, incoming.meta.key, (tx, rows, current) => {
      if (!decide(incoming, previous, current, expected)) return [];
      capacity(rows, incoming, this.limits); check(settings);
      return [tx.objectStore('controls').put({ scopeKey: account, generation: captured }),
        tx.objectStore('metadata').put(incoming.meta), tx.objectStore('payloads').put({ key: incoming.meta.key, scopeKey: account, payload: incoming.payload } satisfies Payload)];
    });
    return incoming.item;
  }
  async remove(scope: AccountScope, kind: Kind, id: string, options: AiArchiveOptions & { expectedRevision: number } = { expectedRevision: 0 }): Promise<void> {
    const account = scopeOf(scope), settings = policy(options), expected = options.expectedRevision, key = keyFor(account, kind, id);
    if (!Number.isSafeInteger(expected) || expected < 1) fail('ITEM_CHANGED');
    const captured = await this.capture(account, settings);
    await this.mutate(account, settings, captured, null, (tx, rows) => {
      if (rows.find((row) => row.key === key)?.summary.revision !== expected) fail('ITEM_CHANGED');
      return [tx.objectStore('controls').put({ scopeKey: account, generation: nextGeneration({ scopeKey: account, generation: captured }, account) }),
        tx.objectStore('metadata').delete(key), tx.objectStore('payloads').delete(key)];
    });
  }
  async clear(scope: AccountScope, options: AiArchiveOptions = {}): Promise<void> {
    const account = scopeOf(scope), settings = policy(options);
    return this.transaction('readwrite', settings, (tx, finish, abort) => {
      const metadataKeys = tx.objectStore('metadata').index('account').getAllKeys(account);
      const payloadKeys = tx.objectStore('payloads').index('account').getAllKeys(account);
      const control = tx.objectStore('controls').get(account); let pending = 3;
      const receive = () => { try {
        check(settings); if (--pending) return;
        const next = nextGeneration(control.result, account);
        const keys = [...new Set([...metadataKeys.result, ...payloadKeys.result])];
        if (keys.some((key) => !ownsKey(key, account))) fail('ARCHIVE_CORRUPT');
        const writes: IDBRequest[] = [tx.objectStore('controls').put({ scopeKey: account, generation: next })];
        for (const key of keys) { writes.push(tx.objectStore('metadata').delete(key)); writes.push(tx.objectStore('payloads').delete(key)); }
        let remaining = writes.length;
        for (const write of writes) write.onsuccess = () => { try { check(settings); if (--remaining === 0) finish(); } catch (error) { abort(error); } };
      } catch (error) { abort(error); } };
      metadataKeys.onsuccess = payloadKeys.onsuccess = control.onsuccess = receive;
    });
  }
  async close(): Promise<void> { (await this.database).close(); }
}

const sqlMeta = 'm.archive_key AS key, m.scope_key AS scopeKey, CASE WHEN length(CAST(m.summary AS BLOB)) <= 16384 THEN m.summary ELSE NULL END AS summary, m.size_bytes AS sizeBytes, m.digest, length(CAST(p.payload AS BLOB)) AS actualSize';
const sqlJoin = 'FROM ai_archive_metadata m LEFT JOIN ai_archive_payloads p ON p.archive_key = m.archive_key AND p.scope_key = m.scope_key';
function sqlMetadata(value: Record<string, unknown>, account: string): Metadata {
  if (typeof value.summary !== 'string' || value.summary.length > maxSummaryBytes) fail('ARCHIVE_CORRUPT');
  let summary: unknown; try { summary = JSON.parse(value.summary); } catch { return fail('ARCHIVE_CORRUPT'); }
  const meta = metadata({ key: value.key, scopeKey: value.scopeKey, summary, sizeBytes: value.sizeBytes, digest: value.digest }, account);
  if (meta.sizeBytes !== value.actualSize) fail('ARCHIVE_CORRUPT');
  return meta;
}

/** Dedicated archive database/connection; no sync snapshots, PDFs or secrets. */
export class SqliteAiArchiveStore implements AiArchiveStore {
  private readonly limits: Limits;
  private readonly ready: Promise<void>;
  private closed = false;
  constructor(private readonly database: AccountSqliteDatabase, options: Config = {}) {
    this.limits = limitsFor(options.limits);
    this.ready = database.run(async (driver) => { await driver.execute(
      'CREATE TABLE IF NOT EXISTS ai_archive_metadata (archive_key TEXT PRIMARY KEY NOT NULL, scope_key TEXT NOT NULL, summary TEXT NOT NULL, size_bytes INTEGER NOT NULL, digest TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ai_archive_metadata_account ON ai_archive_metadata(scope_key);'
      + ' CREATE TABLE IF NOT EXISTS ai_archive_payloads (archive_key TEXT PRIMARY KEY NOT NULL, scope_key TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ai_archive_payloads_account ON ai_archive_payloads(scope_key);'
      + ' CREATE TABLE IF NOT EXISTS ai_archive_controls (scope_key TEXT PRIMARY KEY NOT NULL, generation INTEGER NOT NULL);');
    }).catch((error) => { throw failure(error); });
    void this.ready.catch(() => undefined);
  }
  private async run<T>(action: (driver: AccountSqliteDriver) => Promise<T>): Promise<T> {
    try { await this.ready; if (this.closed) fail('ARCHIVE_UNAVAILABLE'); return await this.database.run(action); }
    catch (error) { throw failure(error); }
  }
  private async control(driver: AccountSqliteDriver, account: string, validate = true): Promise<{ scopeKey: string; generation: Generation } | undefined> {
    const rows = await driver.query('SELECT scope_key AS scopeKey, generation FROM ai_archive_controls WHERE scope_key = ?', [account]);
    if (rows.length > 1) fail('ARCHIVE_CORRUPT'); if (validate) generation(rows[0], account);
    return rows[0] as { scopeKey: string; generation: Generation } | undefined;
  }
  private capture(account: string, options: AiArchiveOptions): Promise<Generation> {
    return this.run(async (driver) => { check(options); const value = generation(await this.control(driver, account), account); check(options); return value; });
  }
  private async scan(driver: AccountSqliteDriver, account: string, control: unknown): Promise<Metadata[]> {
    const values = await driver.query(`SELECT ${sqlMeta} ${sqlJoin} WHERE m.scope_key = ? LIMIT ${maxEntries + 1}`, [account]);
    const keys = await driver.query(`SELECT archive_key AS key FROM ai_archive_payloads WHERE scope_key = ? LIMIT ${maxEntries + 1}`, [account]);
    return rowsFor(values.map((value) => sqlMetadata(value, account)), keys.map((row) => row.key), account, control, this.limits);
  }
  private async loadIn(driver: AccountSqliteDriver, account: string, key: string): Promise<Stored | null> {
    const kind: Kind = JSON.parse(key)[1];
    const maximum = AI_ARCHIVE_LIMITS[kind === 'record' ? 'recordBytes' : 'templateBytes'];
    const rows = await driver.query(`SELECT ${sqlMeta}, CASE WHEN length(CAST(p.payload AS BLOB)) <= ${maximum} THEN p.payload ELSE NULL END AS payload ${sqlJoin} WHERE m.scope_key = ? AND m.archive_key = ?`, [account, key]);
    const keys = await driver.query('SELECT archive_key AS key FROM ai_archive_payloads WHERE scope_key = ? AND archive_key = ?', [account, key]);
    if (!rows.length && !keys.length) return null;
    if (rows.length !== 1 || keys.length !== 1) fail('ARCHIVE_CORRUPT');
    const meta = sqlMetadata(rows[0], account);
    return raw(meta, { key, scopeKey: account, payload: rows[0].payload }, account);
  }
  private async transaction<T>(account: string, options: AiArchiveOptions,
    action: (driver: AccountSqliteDriver, control: { scopeKey: string; generation: Generation } | undefined) => Promise<T>, recoverControl = false): Promise<T> {
    check(options);
    return this.run(async (driver) => {
      let active = false;
      try {
        check(options); await driver.begin(); active = true;
        const control = await this.control(driver, account, !recoverControl); check(options);
        const result = await action(driver, control); check(options);
        await driver.commit(); active = false;
        // A completed commit stays successful even if its acknowledgement is late.
        return result;
      } catch (error) {
        if (active) { try { await driver.rollback(); } catch { fail('ARCHIVE_UNAVAILABLE'); } }
        throw error;
      }
    });
  }
  async list(scope: AccountScope): Promise<AiArchiveSummary[]> {
    const account = scopeOf(scope);
    return this.transaction(account, {}, async (driver, control) => summaries(await this.scan(driver, account, control)));
  }
  async read(scope: AccountScope, kind: Kind, id: string, options: AiArchiveOptions = {}): Promise<AiArchiveItem | null> {
    const account = scopeOf(scope), settings = policy(options), key = keyFor(account, kind, id);
    const loaded = await this.transaction(account, settings, async (driver, control) => {
      const row = await this.loadIn(driver, account, key); if (row && !control) fail('ARCHIVE_CORRUPT');
      return { row, generation: generation(control, account) };
    });
    const checked = await verify(loaded.row, settings);
    if (await this.capture(account, settings) !== loaded.generation) fail('ACCOUNT_CHANGED');
    check(settings); return checked?.item ?? null;
  }
  async put(scope: AccountScope, item: AiArchiveItem, options: AiArchiveOptions & { expectedRevision?: number } = {}): Promise<AiArchiveItem> {
    const account = scopeOf(scope), settings = policy(options), expected = options.expectedRevision;
    check(settings); const detached = validateAiArchiveItem(item);
    const captured = await this.capture(account, settings), incoming = await prepare(account, detached, this.limits, settings);
    const loaded = await this.transaction(account, settings, async (driver, control) => {
      if (generation(control, account) !== captured) fail('ACCOUNT_CHANGED');
      const value = await this.loadIn(driver, account, incoming.meta.key); if (value && !control) fail('ARCHIVE_CORRUPT'); return value;
    });
    const previous = await verify(loaded, settings);
    await this.transaction(account, settings, async (driver, control) => {
      if (generation(control, account) !== captured) fail('ACCOUNT_CHANGED');
      const rows = await this.scan(driver, account, control), current = await this.loadIn(driver, account, incoming.meta.key);
      if (!decide(incoming, previous, current, expected)) return;
      capacity(rows, incoming, this.limits); check(settings);
      await driver.run('INSERT INTO ai_archive_controls(scope_key, generation) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET generation = excluded.generation', [account, String(captured)]);
      check(settings);
      await driver.run('INSERT INTO ai_archive_metadata(archive_key, scope_key, summary, size_bytes, digest) VALUES (?, ?, ?, ?, ?) ON CONFLICT(archive_key) DO UPDATE SET summary = excluded.summary, size_bytes = excluded.size_bytes, digest = excluded.digest',
        [incoming.meta.key, account, canonicalJson(incoming.meta.summary), String(incoming.meta.sizeBytes), incoming.meta.digest]);
      check(settings);
      await driver.run('INSERT INTO ai_archive_payloads(archive_key, scope_key, payload) VALUES (?, ?, ?) ON CONFLICT(archive_key) DO UPDATE SET payload = excluded.payload', [incoming.meta.key, account, incoming.payload]);
    });
    return incoming.item;
  }
  async remove(scope: AccountScope, kind: Kind, id: string, options: AiArchiveOptions & { expectedRevision: number } = { expectedRevision: 0 }): Promise<void> {
    const account = scopeOf(scope), settings = policy(options), expected = options.expectedRevision, key = keyFor(account, kind, id);
    if (!Number.isSafeInteger(expected) || expected < 1) fail('ITEM_CHANGED');
    const captured = await this.capture(account, settings);
    await this.transaction(account, settings, async (driver, control) => {
      if (generation(control, account) !== captured) fail('ACCOUNT_CHANGED');
      const rows = await this.scan(driver, account, control);
      if (rows.find((row) => row.key === key)?.summary.revision !== expected) fail('ITEM_CHANGED');
      // Deletion also fences old idempotent creates. Otherwise an earlier save
      // still hashing could re-create the just-deleted history after its read.
      check(settings); await driver.run('INSERT INTO ai_archive_controls(scope_key, generation) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET generation = excluded.generation',
        [account, String(nextGeneration(control, account))]);
      check(settings); await driver.run('DELETE FROM ai_archive_metadata WHERE scope_key = ? AND archive_key = ?', [account, key]);
      check(settings); await driver.run('DELETE FROM ai_archive_payloads WHERE scope_key = ? AND archive_key = ?', [account, key]);
    });
  }
  async clear(scope: AccountScope, options: AiArchiveOptions = {}): Promise<void> {
    const account = scopeOf(scope), settings = policy(options);
    await this.transaction(account, settings, async (driver, control) => {
      const next = nextGeneration(control, account);
      // No payload or metadata parser runs on this recovery path.
      check(settings); await driver.run('INSERT INTO ai_archive_controls(scope_key, generation) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET generation = excluded.generation', [account, String(next)]);
      check(settings); await driver.run('DELETE FROM ai_archive_metadata WHERE scope_key = ?', [account]);
      check(settings); await driver.run('DELETE FROM ai_archive_payloads WHERE scope_key = ?', [account]);
    }, true);
  }
  async close(): Promise<void> { await this.ready; this.closed = true; await this.database.run(async () => undefined); }
}

let nativeDatabase: Promise<AccountSqliteDatabase> | undefined;
async function nativeStore(): Promise<SqliteAiArchiveStore> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('CapacitorSQLite')) fail('ARCHIVE_UNAVAILABLE');
  nativeDatabase ??= (async () => {
    const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
    const manager = new SQLiteConnection(CapacitorSQLite);
    const connection = await manager.createConnection(AI_ARCHIVE_DATABASE, false, 'no-encryption', 1, false);
    try {
      await connection.open();
      const database = new AccountSqliteDatabase({
        execute: async (sql) => { await connection.execute(sql, false); },
        query: async (sql, values) => (await connection.query(sql, values)).values ?? [],
        run: async (sql, values) => { await connection.run(sql, values, false); },
        begin: async () => { await connection.beginTransaction(); }, commit: async () => { await connection.commitTransaction(); },
        rollback: async () => { await connection.rollbackTransaction(); },
        close: async () => { await manager.closeConnection(AI_ARCHIVE_DATABASE, false); },
      });
      await database.run(async () => undefined); return database;
    } catch (error) { await manager.closeConnection(AI_ARCHIVE_DATABASE, false).catch(() => undefined); throw error; }
  })().catch(() => { nativeDatabase = undefined; return fail('ARCHIVE_UNAVAILABLE'); });
  return new SqliteAiArchiveStore(await nativeDatabase);
}
class NativeAiArchiveStore implements AiArchiveStore {
  private store: Promise<SqliteAiArchiveStore> | undefined;
  private get(): Promise<SqliteAiArchiveStore> { return this.store ??= nativeStore().catch((error) => { this.store = undefined; throw failure(error); }); }
  async list(scope: AccountScope) { const captured = { ...scope }; return (await this.get()).list(captured); }
  async read(scope: AccountScope, kind: Kind, id: string, options: AiArchiveOptions = {}) {
    const captured = { ...scope }, settings = policy(options); check(settings); return (await this.get()).read(captured, kind, id, settings);
  }
  async put(scope: AccountScope, item: AiArchiveItem, options: AiArchiveOptions & { expectedRevision?: number } = {}) {
    const captured = { ...scope }, settings = { ...policy(options), expectedRevision: options.expectedRevision };
    check(settings); const detached = validateAiArchiveItem(item);
    return (await this.get()).put(captured, detached, settings);
  }
  async remove(scope: AccountScope, kind: Kind, id: string, options: AiArchiveOptions & { expectedRevision: number } = { expectedRevision: 0 }) {
    const captured = { ...scope }, settings = { ...policy(options), expectedRevision: options.expectedRevision };
    check(settings); return (await this.get()).remove(captured, kind, id, settings);
  }
  async clear(scope: AccountScope, options: AiArchiveOptions = {}) {
    const captured = { ...scope }, settings = policy(options); check(settings); return (await this.get()).clear(captured, settings);
  }
}
let shared: AiArchiveStore | undefined;
export function getAiArchiveStore(): AiArchiveStore {
  return shared ??= Capacitor.isNativePlatform() ? new NativeAiArchiveStore() : new WebAiArchiveStore();
}
