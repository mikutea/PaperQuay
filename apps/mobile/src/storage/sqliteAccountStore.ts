import { normalizeServiceUrl } from '../config.ts';
import { ClientError } from '../errors.ts';
import { accountScopeKey, type AccountScope, type AccountStorage } from './accountStore.ts';

export interface AccountSqliteDriver {
  execute(sql: string): Promise<void>;
  query(sql: string, values: string[]): Promise<Record<string, unknown>[]>;
  run(sql: string, values: string[]): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

/** One queue per physical connection: no handle can interleave another handle's transaction. */
export class AccountSqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private closed = false;
  constructor(private readonly driver: AccountSqliteDriver) {
    this.ready = (async () => {
      // journal_mode and busy_timeout return rows; Android's execSQL cannot run those pragmas.
      const journal = await driver.query('PRAGMA journal_mode=WAL', []);
      await driver.execute('PRAGMA synchronous=FULL;');
      await driver.query('PRAGMA busy_timeout=5000', []);
      const synchronous = await driver.query('PRAGMA synchronous', []);
      if (String(journal[0]?.journal_mode).toLowerCase() !== 'wal' || synchronous[0]?.synchronous !== 2) throw new Error();
      await driver.execute('CREATE TABLE IF NOT EXISTS account_snapshots (scope_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);');
    })().catch(() => { throw new ClientError('STORAGE_UNAVAILABLE'); });
    void this.ready.catch(() => undefined);
  }
  run<T>(action: (driver: AccountSqliteDriver) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.ready;
      if (this.closed) throw new ClientError('STORAGE_UNAVAILABLE');
      return action(this.driver);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  close(): Promise<void> {
    return this.run(async (driver) => { await driver.close(); this.closed = true; });
  }
}

export class SqliteAccountStore<T> implements AccountStorage<T> {
  private closed = false;
  constructor(private readonly options: { database: AccountSqliteDatabase; decode: (value: unknown) => T }) {}
  private async readIn(driver: AccountSqliteDriver, scope: AccountScope): Promise<T | null> {
    const rows = await driver.query('SELECT payload FROM account_snapshots WHERE scope_key = ?', [accountScopeKey(scope)]);
    if (rows.length === 0) return null;
    try {
      if (rows.length !== 1 || typeof rows[0].payload !== 'string') throw new Error();
      const row: unknown = JSON.parse(rows[0].payload);
      if (!row || typeof row !== 'object') throw new Error();
      const entry = row as Record<string, unknown>;
      if (entry.version !== 1 || entry.scopeKey !== accountScopeKey(scope) ||
          entry.accountId !== scope.accountId.toLowerCase() || entry.apiBaseUrl !== normalizeServiceUrl(scope.apiBaseUrl)) throw new Error();
      return this.options.decode(entry.state);
    } catch { throw new ClientError('STORAGE_CORRUPT'); }
  }
  private enqueue<R>(action: (driver: AccountSqliteDriver) => Promise<R>): Promise<R> {
    if (this.closed) return Promise.reject(new ClientError('STORAGE_UNAVAILABLE'));
    return this.options.database.run(action).catch((error) => {
      throw error instanceof ClientError ? error : new ClientError('STORAGE_FAILED');
    });
  }
  read(scope: AccountScope): Promise<T | null> {
    accountScopeKey(scope);
    return this.enqueue((driver) => this.readIn(driver, scope));
  }
  update(scope: AccountScope, reducer: (current: T | null) => T, guard: () => boolean = () => true): Promise<T> {
    const scopeKey = accountScopeKey(scope);
    return this.enqueue(async (driver) => {
      let transaction = false;
      try {
        if (!guard()) throw new ClientError('ACCOUNT_CHANGED');
        await driver.begin();
        transaction = true;
        const current = await this.readIn(driver, scope);
        if (!guard()) throw new ClientError('ACCOUNT_CHANGED');
        const proposed = reducer(current);
        if (proposed instanceof Promise) throw new ClientError('STORAGE_FAILED');
        const result = this.options.decode(proposed);
        const payload = JSON.stringify({ version: 1, scopeKey, accountId: scope.accountId.toLowerCase(), apiBaseUrl: normalizeServiceUrl(scope.apiBaseUrl), state: result });
        await driver.run('INSERT INTO account_snapshots (scope_key, payload) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET payload = excluded.payload', [scopeKey, payload]);
        if (!guard()) throw new ClientError('ACCOUNT_CHANGED');
        // Resolve only after native COMMIT returns: content, outbox, conflicts and cursor move together.
        await driver.commit();
        transaction = false;
        return result;
      } catch (error) {
        if (transaction) {
          try { await driver.rollback(); } catch { throw new ClientError('STORAGE_FAILED'); }
        }
        throw error;
      }
    });
  }
  remove(scope: AccountScope): Promise<void> {
    const scopeKey = accountScopeKey(scope);
    return this.enqueue(async (driver) => {
      let transaction = false;
      try {
        await driver.begin(); transaction = true;
        await driver.run('DELETE FROM account_snapshots WHERE scope_key = ?', [scopeKey]);
        await driver.commit(); transaction = false;
      } catch (error) {
        if (transaction) await driver.rollback();
        throw error;
      }
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Native handles share an app-lifetime connection; closing one runtime only drains its work.
    await this.options.database.run(async () => undefined);
  }
}
