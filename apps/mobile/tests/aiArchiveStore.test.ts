import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { IDBFactory, IDBIndex, IDBObjectStore, IDBTransaction } from 'fake-indexeddb';
import { canonicalJson } from '../../../packages/sync-core/src/index.ts';
import { AI_ARCHIVE_LIMITS, AiArchiveError, validateAiArchiveItem, summarizeAiArchiveItem,
  type AiArchiveItem, type AiHistoryRecord, type AiQuestionTemplate } from '../src/ai/archiveTypes.ts';
import { AI_ARCHIVE_DATABASE, WebAiArchiveStore, SqliteAiArchiveStore, type AiArchiveStore } from '../src/ai/archiveStore.ts';
import { AccountSqliteDatabase, type AccountSqliteDriver } from '../src/storage/sqliteAccountStore.ts';
import { accountScopeKey, type AccountScope } from '../src/storage/accountStore.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const a: AccountScope = { apiBaseUrl: 'https://sync.example.test', accountId: id(1) };
const b: AccountScope = { ...a, accountId: id(2) };
const c: AccountScope = { ...a, apiBaseUrl: 'https://another.example.test' };
const createdAt = '2026-10-28T12:00:00.000Z';
const time = (revision: number) => `2026-10-28T12:00:${String(revision).padStart(2, '0')}.000Z`;
const bytes = (item: AiArchiveItem) => new TextEncoder().encode(canonicalJson(validateAiArchiveItem(item))).byteLength;
function record(number = 10, text = 'An actual stored answer [P1].'): AiHistoryRecord {
  return { kind: 'record', version: 1, id: id(number), revision: 1, createdAt, updatedAt: time(1),
    context: { paperId: id(3), attachmentVersionId: id(4), sha256: 'a'.repeat(64), scope: 'page', totalPages: 2,
      pages: [{ pageIndex: 0, text: 'Source material used by this request.' }], complete: true, label: 'Synthetic paper' },
    action: 'ask', question: 'What was actually sent?', provider: { id: 'provider', endpoint: 'https://model.example.test/v1', model: 'synthetic-model' },
    result: { text, status: 'complete', finishReason: 'stop', usage: null, cost: 'unknown', failure: null } };
}
function template(number = 20, revision = 1, question = 'Summarize the evidence.'): AiQuestionTemplate {
  return { kind: 'template', version: 1, id: id(number), revision, createdAt, updatedAt: time(revision), title: 'Evidence template', action: 'ask', question };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
type Limits = { [K in keyof typeof AI_ARCHIVE_LIMITS]: number };
class Driver implements AccountSqliteDriver {
  readonly db: DatabaseSync;
  failCommit = false;
  afterWrite?: () => void;
  afterCommit?: () => Promise<void>;
  queries: string[] = [];
  constructor(file: string) { this.db = new DatabaseSync(file); }
  async execute(sql: string) { this.db.exec(sql); }
  async query(sql: string, values: string[]) { this.queries.push(sql); return this.db.prepare(sql).all(...values) as Record<string, unknown>[]; }
  async run(sql: string, values: string[]) { this.db.prepare(sql).run(...values); this.afterWrite?.(); }
  async begin() { this.db.exec('BEGIN IMMEDIATE'); }
  async commit() { if (this.failCommit) throw new Error('private-disk-path-and-payload-sentinel'); this.db.exec('COMMIT'); await this.afterCommit?.(); }
  async rollback() { this.db.exec('ROLLBACK'); }
  async close() { this.db.close(); }
}
async function openIdb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const request = factory.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function fixture(t: TestContext, backend: 'web' | 'sqlite', limits?: Partial<Limits>) {
  const factory = new IDBFactory(), databaseName = randomUUID();
  const directory = backend === 'sqlite' ? await mkdtemp(join(tmpdir(), 'paperquay-ai-archive-')) : null;
  const file = directory ? join(directory, AI_ARCHIVE_DATABASE + '.sqlite') : '';
  const driver = directory ? new Driver(file) : null;
  const database = driver ? new AccountSqliteDatabase(driver) : null;
  const stores: (WebAiArchiveStore | SqliteAiArchiveStore)[] = [];
  const open = () => {
    const store = database ? new SqliteAiArchiveStore(database, { limits }) : new WebAiArchiveStore({ indexedDB: factory, databaseName, limits });
    stores.push(store); return store;
  };
  const store = open();
  const rawKey = (item: AiArchiveItem, scope = a) => JSON.stringify([accountScopeKey(scope), item.kind, item.id]);
  async function tamper(item: AiArchiveItem, operation: 'payload' | 'summary' | 'meta-orphan' | 'payload-orphan' | 'payload-with-integrity', value = '{broken') {
    const key = rawKey(item);
    if (driver) {
      if (operation === 'payload') driver.db.prepare('UPDATE ai_archive_payloads SET payload = ? WHERE archive_key = ?').run(value, key);
      if (operation === 'payload-with-integrity') {
        driver.db.prepare('UPDATE ai_archive_payloads SET payload = ? WHERE archive_key = ?').run(value, key);
        driver.db.prepare('UPDATE ai_archive_metadata SET size_bytes = ?, digest = ? WHERE archive_key = ?')
          .run(new TextEncoder().encode(value).byteLength, createHash('sha256').update(value).digest('hex'), key);
      }
      if (operation === 'summary') driver.db.prepare('UPDATE ai_archive_metadata SET summary = ? WHERE archive_key = ?').run(value, key);
      if (operation === 'meta-orphan') driver.db.prepare('DELETE FROM ai_archive_payloads WHERE archive_key = ?').run(key);
      if (operation === 'payload-orphan') driver.db.prepare('DELETE FROM ai_archive_metadata WHERE archive_key = ?').run(key);
      return;
    }
    const db = await openIdb(factory, databaseName);
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['metadata', 'payloads'], 'readwrite');
      const target = tx.objectStore(operation === 'payload' || operation === 'payload-orphan' || operation === 'payload-with-integrity' ? 'payloads' : 'metadata');
      if (operation === 'meta-orphan') tx.objectStore('payloads').delete(key);
      else if (operation === 'payload-orphan') tx.objectStore('metadata').delete(key);
      else {
        const request = target.get(key); request.onsuccess = () => {
          const row = request.result;
          if (operation === 'payload' || operation === 'payload-with-integrity') row.payload = value;
          else row.summary = JSON.parse(value);
          target.put(row);
          if (operation === 'payload-with-integrity') {
            const meta = tx.objectStore('metadata').get(key); meta.onsuccess = () => tx.objectStore('metadata').put({ ...meta.result,
              sizeBytes: new TextEncoder().encode(value).byteLength, digest: createHash('sha256').update(value).digest('hex') });
          }
        };
      }
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
  }
  async function writeHook(operation: () => Promise<unknown>, action: () => void, fail = false) {
    if (driver) {
      driver.afterWrite = action; driver.failCommit = fail;
      try { return await operation(); } finally { driver.afterWrite = undefined; driver.failCommit = false; }
    }
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'payloads') {
        if (fail) throw new Error('private-disk-path-and-payload-sentinel');
        const request = original.apply(this, args); action(); return request;
      }
      return original.apply(this, args);
    };
    try { return await operation(); } finally { IDBObjectStore.prototype.put = original; }
  }
  async function tamperControl(value: string | number): Promise<void> {
    if (driver) { driver.db.prepare('UPDATE ai_archive_controls SET generation=? WHERE scope_key=?').run(value, accountScopeKey(a)); return; }
    const db = await openIdb(factory, databaseName);
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('controls', 'readwrite'); tx.objectStore('controls').put({ scopeKey: accountScopeKey(a), generation: value });
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
  }
  t.after(async () => {
    for (const item of stores) await item.close().catch(() => undefined);
    await database?.close().catch(() => undefined);
    if (directory) {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('paperquay-ai-archive-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { store, open, factory, databaseName, directory, file, database, driver, tamper, tamperControl, writeHook, rawKey };
}

for (const backend of ['web', 'sqlite'] as const) {
  test(`${backend} permanent erasure fences retained archive writers, survives ordinary clear and retains other scopes`,async t=>{
    const f=await fixture(t,backend),second=f.open();await f.store.put(a,record(),{});await second.put(b,record(),{});
    const gate=deferred(),pending=gate.promise.then(()=>second.put(a,record(11),{}));
    const blocked=assert.rejects(pending,{code:'ACCOUNT_CHANGED'});
    await f.store.clear(a,{accountErasure:true});gate.resolve();await blocked;
    assert.equal((await second.list(b)).length,1);
    await second.clear(a);await assert.rejects(f.open().put(a,record(),{}),{code:'ACCOUNT_CHANGED'});
    await second.clear(a,{accountErasure:true});await second.put(c,record(),{});
  });
  test(`${backend}: independent durable archive scope and immutable history idempotence`, async (t) => {
    const f = await fixture(t, backend), item = record();
    const saved = await f.store.put(a, item, {});
    assert.deepEqual(saved, validateAiArchiveItem(item));
    assert.deepEqual(await f.open().read(a, 'record', item.id), saved);
    assert.equal(await f.store.read(b, 'record', item.id), null); assert.equal(await f.store.read(c, 'record', item.id), null);
    await f.store.put(b, item, {}); await f.store.put(c, item, {});
    assert.deepEqual(await f.store.put(a, structuredClone(item), { expectedRevision: 0 }), saved);
    await assert.rejects(f.store.put(a, record(10, 'Different answer'), {}), { code: 'ITEM_CHANGED' });
    await assert.rejects(f.store.put(a, item, { expectedRevision: 1 }), { code: 'ITEM_CHANGED' });
    await f.store.remove(a, 'record', item.id, { expectedRevision: 1 });
    assert.deepEqual(await f.store.list(a), []); assert.ok(await f.store.read(b, 'record', item.id)); assert.ok(await f.store.read(c, 'record', item.id));
  });

  test(`${backend}: template revision CAS preserves newer edits and requires stable creation time`, async (t) => {
    const f = await fixture(t, backend), initial = template(), next = template(20, 2, 'Updated question');
    await f.store.put(a, initial, { expectedRevision: 0 });
    await assert.rejects(f.store.put(a, next, {}), { code: 'ITEM_CHANGED' });
    await assert.rejects(f.store.put(a, { ...next, createdAt: time(1) }, { expectedRevision: 1 }), { code: 'ITEM_CHANGED' });
    await f.open().put(a, next, { expectedRevision: 1 });
    await assert.rejects(f.store.remove(a, 'template', next.id, { expectedRevision: 1 }), { code: 'ITEM_CHANGED' });
    await assert.rejects(f.store.put(a, template(20, 3), { expectedRevision: 1 }), { code: 'ITEM_CHANGED' });
    assert.deepEqual(await f.store.read(a, 'template', next.id), validateAiArchiveItem(next));
    await f.store.remove(a, 'template', next.id, { expectedRevision: 2 }); assert.equal(await f.store.read(a, 'template', next.id), null);
  });

  test(`${backend}: two handles atomically race one template revision or a final quota slot`, async (t) => {
    const f = await fixture(t, backend, { records: 1 }), other = f.open();
    const results = await Promise.allSettled([f.store.put(a, record(10), {}), other.put(a, record(11), {})]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'ARCHIVE_FULL');
    assert.equal((await f.store.list(a)).length, 1);
    await f.store.put(a, template(), {});
    const updates = await Promise.allSettled([f.store.put(a, template(20, 2, 'One'), { expectedRevision: 1 }), other.put(a, template(20, 2, 'Two'), { expectedRevision: 1 })]);
    assert.equal(updates.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((updates.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'ITEM_CHANGED');
  });

  test(`${backend}: UTF-8 byte accounting refuses full archives without eviction or partial replacement`, async (t) => {
    const initial = template(20, 1, '中'.repeat(80)), next = template(20, 2, '中'.repeat(120));
    const f = await fixture(t, backend, { accountBytes: bytes(initial), templateBytes: bytes(next) - 1 });
    assert.ok(bytes(initial) > canonicalJson(initial).length);
    await f.store.put(a, initial, {});
    await assert.rejects(f.store.put(a, template(21), {}), { code: 'ARCHIVE_FULL' });
    await assert.rejects(f.store.put(a, next, { expectedRevision: 1 }), { code: 'RECORD_LIMIT' });
    assert.deepEqual(await f.store.read(a, 'template', initial.id), validateAiArchiveItem(initial));
    assert.equal((await f.store.list(a)).length, 1);
  });

  test(`${backend}: failed write/commit and invalid lifecycle roll back metadata, payload and control together`, async (t) => {
    const f = await fixture(t, backend), initial = template(), next = template(20, 2);
    await f.store.put(a, initial, {});
    await assert.rejects(f.writeHook(() => f.store.put(a, next, { expectedRevision: 1 }), () => {}, true), (error: unknown) => {
      assert.ok(error instanceof AiArchiveError); assert.equal(error.code, 'ARCHIVE_UNAVAILABLE');
      assert.ok(!String(error).includes('private-disk-path')); return true;
    });
    assert.deepEqual(await f.open().read(a, 'template', initial.id), validateAiArchiveItem(initial));
    let active = true;
    await assert.rejects(f.writeHook(() => f.store.put(a, next, { expectedRevision: 1, guard: () => active }), () => { active = false; }), { code: 'ACCOUNT_CHANGED' });
    assert.deepEqual(await f.store.read(a, 'template', initial.id), validateAiArchiveItem(initial));
    const signal = new AbortController();
    await assert.rejects(f.writeHook(() => f.store.put(a, next, { expectedRevision: 1, signal: signal.signal }), () => signal.abort()), { code: 'ACCOUNT_CHANGED' });
    assert.deepEqual(await f.store.read(a, 'template', initial.id), validateAiArchiveItem(initial));
  });

  test(`${backend}: clear generation defeats an old hash-pending save in another handle without blocking a new action`, async (t) => {
    const f = await fixture(t, backend), other = f.open(), entered = deferred(), release = deferred(), item = record();
    await f.store.put(b, record(11), {});
    const original = crypto.subtle.digest;
    Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async (...args: Parameters<SubtleCrypto['digest']>) => {
      entered.resolve(); await release.promise; return original.apply(crypto.subtle, args);
    } });
    try {
      const pending = f.store.put(a, item, {}); const rejection = assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
      await entered.promise; await other.clear(a); release.resolve(); await rejection;
    } finally { release.resolve(); Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: original }); }
    assert.deepEqual(await f.store.list(a), []); assert.ok(await f.store.read(b, 'record', id(11)));
    await other.put(a, item, {}); assert.ok(await f.store.read(a, 'record', item.id));
  });

  test(`${backend}: metadata/orphan corruption refuses quota/list while scope clear recovers without touching other accounts`, async (t) => {
    for (const corruption of ['summary', 'meta-orphan', 'payload-orphan'] as const) {
      const f = await fixture(t, backend), item = record(); await f.store.put(a, item, {}); await f.store.put(b, item, {});
      await f.tamper(item, corruption, JSON.stringify({ ...summarizeAiArchiveItem(item), extra: 'hidden' }));
      await assert.rejects(f.store.list(a), { code: 'ARCHIVE_CORRUPT' });
      await assert.rejects(f.store.put(a, record(12), {}), { code: 'ARCHIVE_CORRUPT' });
      await f.store.clear(a); assert.deepEqual(await f.store.list(a), []);
      assert.ok(await f.store.read(b, 'record', item.id));
    }
  });

  test(`${backend}: corrupt or exhausted control recovery never recycles a captured generation`, async (t) => {
    for (const invalid of ['damaged-control', Number.MAX_SAFE_INTEGER]) {
      const f = await fixture(t, backend), other = f.open(); await f.store.put(a, record(), {}); await f.store.put(b, template(), {});
      const original = crypto.subtle.digest, entered = deferred(), release = deferred();
      Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async (...args: Parameters<SubtleCrypto['digest']>) => {
        entered.resolve(); await release.promise; return original.apply(crypto.subtle, args);
      } });
      try {
        const pending = f.store.put(a, record(12), {}), rejected = assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
        await entered.promise; await f.tamperControl(invalid);
        if (typeof invalid === 'string') await assert.rejects(f.store.list(a), { code: 'ARCHIVE_CORRUPT' });
        await other.clear(a); release.resolve(); await rejected;
      } finally { release.resolve(); Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: original }); }
      assert.deepEqual(await f.store.list(a), []); assert.equal((await f.store.list(b)).length, 1);
      await f.store.put(a, record(), {}); assert.ok(await f.store.read(a, 'record', id(10)));
      await other.clear(a); assert.deepEqual(await f.store.list(a), []);
    }
  });

  test(`${backend}: a pending idempotent save cannot resurrect a record removed by another handle`, async (t) => {
    const f = await fixture(t, backend), other = f.open(), item = record(); await f.store.put(a, item, {});
    const original = crypto.subtle.digest, entered = deferred(), release = deferred();
    Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async (...args: Parameters<SubtleCrypto['digest']>) => {
      entered.resolve(); await release.promise; return original.apply(crypto.subtle, args);
    } });
    try {
      const pending = f.store.put(a, item, {}), rejected = assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
      await entered.promise; await other.remove(a, 'record', item.id, { expectedRevision: 1 }); release.resolve(); await rejected;
    } finally { release.resolve(); Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: original }); }
    assert.equal(await f.store.read(a, 'record', item.id), null);
    await f.store.put(a, item, {}); assert.ok(await f.store.read(a, 'record', item.id));
  });

  test(`${backend}: bounded payload/schema/hash checks fail with fixed codes; clear bypasses broken payload`, async (t) => {
    const changed = record(); changed.result.text = changed.result.text.replace('actual', 'actuAl');
    for (const corruption of ['x'.repeat(AI_ARCHIVE_LIMITS.recordBytes + 1), '{broken', canonicalJson(changed)]) {
      const f = await fixture(t, backend), item = record(); await f.store.put(a, item, {}); await f.tamper(item, 'payload', corruption);
      await assert.rejects(f.store.read(a, 'record', item.id), (error: unknown) => {
        assert.ok(error instanceof AiArchiveError); assert.equal(error.code, 'ARCHIVE_CORRUPT');
        assert.equal(String(error), 'AiArchiveError: ARCHIVE_CORRUPT'); return true;
      });
      await f.store.clear(a); assert.deepEqual(await f.store.list(a), []);
      await f.store.put(a, record(12), {}); assert.ok(await f.store.read(a, 'record', id(12)));
    }
    const f = await fixture(t, backend), item = record(); await f.store.put(a, item, {});
    await f.tamper(item, 'payload-with-integrity', canonicalJson({ ...item, apiKey: 'must-not-escape' }));
    await assert.rejects(f.store.read(a, 'record', item.id), { code: 'ARCHIVE_CORRUPT' });
    await f.store.clear(a); assert.deepEqual(await f.store.list(a), []);
  });

  test(`${backend}: cryptographic failure is fixed and a pending input is detached before hashing`, async (t) => {
    const f = await fixture(t, backend), original = crypto.subtle.digest, item = record();
    Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async () => { throw new Error('private-model-response-and-disk-path'); } });
    try { await assert.rejects(f.store.put(a, item, {}), { code: 'ARCHIVE_UNAVAILABLE', message: 'ARCHIVE_UNAVAILABLE' }); }
    finally { Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: original }); }
    assert.deepEqual(await f.store.list(a), []);
    const entered = deferred(), release = deferred();
    Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async (...args: Parameters<SubtleCrypto['digest']>) => { entered.resolve(); await release.promise; return original.apply(crypto.subtle, args); } });
    try {
      const pending = f.store.put(a, item, {}); await entered.promise;
      item.result.text = 'Mutated caller object'; item.context.pages[0].text = 'Mutated source';
      release.resolve(); await pending;
    } finally { release.resolve(); Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: original }); }
    const saved = await f.store.read(a, 'record', item.id); assert.ok(saved?.kind === 'record');
    assert.notEqual(saved.result.text, item.result.text); assert.notEqual(saved.context.pages[0].text, item.context.pages[0].text);
    Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async () => { throw new Error('private-crypto-path'); } });
    try { await assert.rejects(f.store.read(a, 'record', item.id), { code: 'ARCHIVE_UNAVAILABLE', message: 'ARCHIVE_UNAVAILABLE' }); }
    finally { Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: original }); }
  });

  test(`${backend}: deletion and clear failures roll back both stores and the generation fence`, async (t) => {
    for (const operation of ['remove', 'clear'] as const) for (const cause of ['failure', 'guard'] as const) {
      const f = await fixture(t, backend), item = record(); await f.store.put(a, item, {}); await f.store.put(b, item, {});
      let active = true;
      const erase = () => operation === 'clear' ? f.store.clear(a, { guard: () => active })
        : f.store.remove(a, 'record', item.id, { expectedRevision: 1, guard: () => active });
      if (f.driver) {
        f.driver.afterWrite = () => { if (cause === 'guard') active = false; }; f.driver.failCommit = cause === 'failure';
        try { await assert.rejects(erase(), { code: cause === 'guard' ? 'ACCOUNT_CHANGED' : 'ARCHIVE_UNAVAILABLE' }); }
        finally { f.driver.afterWrite = undefined; f.driver.failCommit = false; }
        assert.equal(f.driver.db.prepare('SELECT generation FROM ai_archive_controls WHERE scope_key=?').get(accountScopeKey(a))?.generation, 0);
      } else {
        const original = IDBObjectStore.prototype.delete;
        IDBObjectStore.prototype.delete = function (...args: Parameters<IDBObjectStore['delete']>) {
          if (this.name === 'payloads') {
            if (cause === 'failure') throw new Error('private-failed-delete');
            const request = original.apply(this, args); active = false; return request;
          }
          return original.apply(this, args);
        };
        try { await assert.rejects(erase(), { code: cause === 'guard' ? 'ACCOUNT_CHANGED' : 'ARCHIVE_UNAVAILABLE' }); }
        finally { IDBObjectStore.prototype.delete = original; }
        const db = await openIdb(f.factory, f.databaseName);
        try { const row = await new Promise<{ generation: number }>((resolve, reject) => {
          const request = db.transaction('controls').objectStore('controls').get(accountScopeKey(a));
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        }); assert.equal(row.generation, 0); } finally { db.close(); }
      }
      assert.ok(await f.store.read(a, 'record', item.id)); assert.ok(await f.store.read(b, 'record', item.id));
    }
  });

  test(`${backend}: actual default record/template slots refuse additions without evicting the first item`, async (t) => {
    const f = await fixture(t, backend);
    for (let n = 0; n < 50; n++) await f.store.put(a, record(1000 + n), {});
    await assert.rejects(f.store.put(a, record(2000), {}), { code: 'ARCHIVE_FULL' });
    for (let n = 0; n < 100; n++) await f.store.put(a, template(3000 + n), {});
    await assert.rejects(f.store.put(a, template(4000), {}), { code: 'ARCHIVE_FULL' });
    assert.equal((await f.store.list(a)).length, 150);
    assert.ok(await f.store.read(a, 'record', id(1000))); assert.ok(await f.store.read(a, 'template', id(3000)));
  });
}

test('Web listing fetches only closed metadata and content keys, never archive body values', async (t) => {
  const f = await fixture(t, 'web'); await f.store.put(a, record(), {}); await f.store.put(a, template(), {});
  const restores: (() => void)[] = [];
  for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) for (const name of ['get', 'getAll', 'openCursor', 'getAllRecords']) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name); if (!descriptor) continue;
    Object.defineProperty(prototype, name, { ...descriptor, value: function (this: IDBObjectStore | IDBIndex, ...args: unknown[]) {
      const store = 'objectStore' in this ? this.objectStore : this;
      if (store.name === 'payloads') throw new Error('Archive listing must not clone response bodies');
      return Reflect.apply(descriptor.value as (...args: unknown[]) => unknown, this, args);
    } });
    restores.push(() => Object.defineProperty(prototype, name, descriptor));
  }
  try { assert.equal((await f.store.list(a)).length, 2); }
  finally { restores.forEach((restore) => restore()); }
});

test('SQLite file reopen retains content and clear generations; independent archive does not change other stores', async (t) => {
  const f = await fixture(t, 'sqlite'), item = record();
  await f.database!.run(async () => undefined);
  f.driver!.db.prepare('INSERT INTO account_snapshots(scope_key,payload) VALUES(?,?)').run(accountScopeKey(a), 'sync-notes-keys-sentinel');
  await f.store.put(a, item, {}); await f.store.put(b, template(), {}); await f.database!.close();
  const driver = new Driver(f.file), database = new AccountSqliteDatabase(driver), reopened = new SqliteAiArchiveStore(database);
  try {
    assert.deepEqual(await reopened.read(a, 'record', item.id), validateAiArchiveItem(item));
    await reopened.clear(a); assert.deepEqual(await reopened.list(a), []); assert.equal((await reopened.list(b)).length, 1);
    assert.deepEqual(driver.db.prepare('SELECT payload FROM account_snapshots').all().map((row) => row.payload), ['sync-notes-keys-sentinel']);
    assert.equal(driver.db.prepare('SELECT generation FROM ai_archive_controls WHERE scope_key=?').get(accountScopeKey(a))?.generation, 1);
    driver.queries = []; await reopened.list(b);
    assert.ok(driver.queries.every((query) => !/THEN p\.payload/.test(query)), 'Metadata scans must not select body values');
  } finally { await reopened.close(); await database.close(); }
});

test('SQLite committed save remains successful when the native COMMIT acknowledgement arrives after lifecycle retirement', async (t) => {
  const f = await fixture(t, 'sqlite'), entered = deferred(), release = deferred(); let current = true, returned = false;
  // Put has a read-only preflight transaction before its mutation transaction.
  let commits = 0;
  f.driver!.afterCommit = async () => { if (++commits === 2) { entered.resolve(); await release.promise; } };
  const pending = f.store.put(a, record(), { guard: () => current }).then(() => { returned = true; });
  await entered.promise; assert.equal(returned, false); current = false; release.resolve(); await pending;
  f.driver!.afterCommit = undefined;
  assert.equal(returned, true); assert.ok(await f.store.read(a, 'record', id(10)));
});

test('Web committed save is not reclassified as failed when lifecycle retires before the promise continuation', async (t) => {
  const f = await fixture(t, 'web'); let current = true;
  const original = IDBTransaction.prototype.commit;
  IDBTransaction.prototype.commit = function () {
    this.addEventListener('complete', () => { current = false; }); return original.call(this);
  };
  try { assert.equal((await f.store.put(a, record(), { guard: () => current })).kind, 'record'); }
  finally { IDBTransaction.prototype.commit = original; }
  assert.equal(current, false); assert.ok(await f.store.read(a, 'record', id(10)));
});

test('hard limits and private database names cannot be expanded through configuration', () => {
  assert.equal(AI_ARCHIVE_DATABASE, 'paperquay_ai_archive_v1');
  assert.deepEqual(AI_ARCHIVE_LIMITS, { recordBytes: 1048576, templateBytes: 16384, accountBytes: 16777216, records: 50, templates: 100 });
  for (const key of Object.keys(AI_ARCHIVE_LIMITS) as (keyof Limits)[]) {
    assert.throws(() => new WebAiArchiveStore({ indexedDB: new IDBFactory(), limits: { [key]: AI_ARCHIVE_LIMITS[key] + 1 } }), { code: 'ARCHIVE_UNAVAILABLE' });
  }
});
