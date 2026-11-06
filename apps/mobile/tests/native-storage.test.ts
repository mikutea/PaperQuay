import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { KeychainAccess } from '@aparajita/capacitor-secure-storage';
import { MemorySecretStore } from '../src/platform/secretStore.ts';
import { NativeSecretStore, createNativeSecretStore } from '../src/platform/nativeSecrets.ts';
import { AccountSqliteDatabase, SqliteAccountStore, type AccountSqliteDriver } from '../src/storage/sqliteAccountStore.ts';
import type { AccountScope } from '../src/storage/accountStore.ts';

const a: AccountScope = { apiBaseUrl: 'https://sync.example.test', accountId: '11111111-1111-4111-8111-111111111111' };
const b: AccountScope = { ...a, accountId: '22222222-2222-4222-8222-222222222222' };
interface State { content: string; outbox: string[]; cursor: number; conflicts: string[]; }
const state = (cursor: number): State => ({ content: `note-${cursor}`, outbox: [`operation-${cursor}`], cursor, conflicts: [`conflict-${cursor}`] });
function decode(value: unknown): State {
  const item = value as State;
  if (!item || typeof item.content !== 'string' || !Array.isArray(item.outbox) || !Number.isSafeInteger(item.cursor) || !Array.isArray(item.conflicts)) throw new Error('invalid');
  return structuredClone(item);
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class Driver implements AccountSqliteDriver {
  readonly db: DatabaseSync;
  failCommit = false;
  afterWrite?: () => Promise<void>;
  beforeCommit?: () => Promise<void>;
  constructor(path: string) { this.db = new DatabaseSync(path); }
  async execute(sql: string) { this.db.exec(sql); }
  async query(sql: string, values: string[]) { return this.db.prepare(sql).all(...values) as Record<string, unknown>[]; }
  async run(sql: string, values: string[]) { this.db.prepare(sql).run(...values); await this.afterWrite?.(); }
  async begin() { this.db.exec('BEGIN IMMEDIATE'); }
  async commit() { await this.beforeCommit?.(); if (this.failCommit) throw new Error('disk-full-token-sentinel'); this.db.exec('COMMIT'); }
  async rollback() { this.db.exec('ROLLBACK'); }
  async close() { this.db.close(); }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'paperquay-native-sqlite-'));
  const path = join(directory, 'accounts.sqlite');
  const databases: AccountSqliteDatabase[] = [];
  const open = () => {
    const driver = new Driver(path);
    const database = new AccountSqliteDatabase(driver);
    databases.push(database);
    return { driver, database, store: new SqliteAccountStore({ database, decode }) };
  };
  t.after(async () => {
    for (const database of databases) await database.close().catch(() => undefined);
    for (const suffix of ['', '-wal', '-shm']) await unlink(path + suffix).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  });
  return { open };
}

test('real SQLite reopens one atomic account snapshot and isolates API/account namespaces', async (t) => {
  const setup = await fixture(t);
  const first = setup.open();
  await first.store.update(a, () => state(1));
  await first.store.update(b, () => state(2));
  await first.database.close();
  const reopened = setup.open();
  assert.deepEqual(await reopened.store.read(a), state(1));
  assert.deepEqual(await reopened.store.read(b), state(2));
  assert.equal(await reopened.store.read({ ...a, apiBaseUrl: 'https://other.example.test' }), null);
  await reopened.store.remove(a);
  assert.equal(await reopened.store.read(a), null);
  assert.deepEqual(await reopened.store.read(b), state(2));
});

test('write failure rolls back content, outbox, cursor and conflicts and survives reopening', async (t) => {
  const setup = await fixture(t);
  const first = setup.open();
  await first.store.update(a, () => state(1));
  first.driver.failCommit = true;
  await assert.rejects(first.store.update(a, () => state(2)), { code: 'STORAGE_FAILED' });
  assert.deepEqual(await first.store.read(a), state(1));
  first.driver.failCommit = false;
  await first.database.close();
  assert.deepEqual(await setup.open().store.read(a), state(1));
});

test('save acknowledgement waits for COMMIT and account switch before COMMIT rolls back', async (t) => {
  const { open } = await fixture(t);
  const { driver, store } = open();
  await store.update(a, () => state(1));
  const entered = deferred(); const release = deferred();
  driver.beforeCommit = async () => { entered.resolve(); await release.promise; };
  let acknowledged = false;
  const saving = store.update(a, () => state(2)).then(() => { acknowledged = true; });
  await entered.promise;
  assert.equal(acknowledged, false);
  release.resolve(); await saving;
  assert.equal(acknowledged, true);
  driver.beforeCommit = undefined;
  let active = true;
  driver.afterWrite = async () => { active = false; };
  await assert.rejects(store.update(a, () => state(3), () => active), { code: 'ACCOUNT_CHANGED' });
  assert.deepEqual(await store.read(a), state(2));
});

test('multiple handles serialize reducer transactions without lost updates; closing one leaves the other usable', async (t) => {
  const { open } = await fixture(t);
  const { database, store } = open();
  const other = new SqliteAccountStore({ database, decode });
  await store.update(a, () => state(0));
  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : other).update(a, (current) => state(current!.cursor + 1))));
  assert.equal((await other.read(a))?.cursor, 12);
  await store.close();
  await assert.rejects(store.read(a), { code: 'STORAGE_UNAVAILABLE' });
  await other.update(a, (current) => state(current!.cursor + 1));
  assert.equal((await other.read(a))?.cursor, 13);
});

test('native secrets hash namespaces, disable cloud sync and device migration, serialize removal, and sanitize failures', async () => {
  const entries = new Map<string, unknown>();
  const calls: unknown[][] = [];
  const store = new NativeSecretStore({
    get: async (...args) => { calls.push(['get', ...args]); return entries.get(args[0]) as string ?? null; },
    set: async (...args) => { calls.push(['set', ...args]); entries.set(args[0], args[1]); },
    remove: async (...args) => { calls.push(['remove', ...args]); return entries.delete(args[0]); },
  });
  await Promise.all([store.set('account-a/provider-a', 'api-key', 'private-token'), store.remove('account-a/provider-a', 'api-key')]);
  assert.equal(await store.get('account-a/provider-a', 'api-key'), null);
  assert.equal(store.persistence, 'system');
  assert.match(String(calls[0][1]), /^[0-9a-f]{64}$/);
  assert.deepEqual(calls[0].slice(3), [false, false, KeychainAccess.whenUnlockedThisDeviceOnly]);
  await store.set('account-b/provider-a', 'api-key', 'other-token');
  assert.equal(await store.get('account-a/provider-a', 'api-key'), null);
  const failed = new NativeSecretStore({ get: async () => { throw new Error('secret-path-token'); }, set: async () => undefined, remove: async () => false });
  await assert.rejects(failed.get('a', 'b'), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'STORAGE_FAILED');
    assert.ok(!String(error).includes('secret-path-token')); return true;
  });
  await assert.rejects(createNativeSecretStore(), { code: 'STORAGE_UNAVAILABLE' });
  const web = new MemorySecretStore();
  await web.set('a', 'b', 'web-token');
  assert.equal(await new MemorySecretStore().get('a', 'b'), null);
});
