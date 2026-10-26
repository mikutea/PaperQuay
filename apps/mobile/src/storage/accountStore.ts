import { Capacitor } from '@capacitor/core';
import { ClientError } from '../errors.ts';
import { normalizeServiceUrl } from '../config.ts';

export interface AccountScope {
  apiBaseUrl: string;
  accountId: string;
}
interface AccountRow {
  scopeKey: string;
  accountId: string;
  apiBaseUrl: string;
  version: 1;
  state: unknown;
}
type Decode<T> = (value: unknown) => T;

export interface AccountStorage<T> {
  read(scope: AccountScope): Promise<T | null>;
  update(scope: AccountScope, reducer: (current: T | null) => T, guard?: () => boolean): Promise<T>;
  remove(scope: AccountScope): Promise<void>;
  close(): Promise<void>;
}

export async function createAccountStorage<T>(options: { decode: Decode<T> }): Promise<AccountStorage<T>> {
  if (Capacitor.isNativePlatform()) {
    const { createNativeAccountStorage } = await import('./nativeAccountStore.ts');
    return createNativeAccountStorage(options);
  }
  return new AccountStore(options);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function accountScopeKey(scope: AccountScope): string {
  if (!UUID.test(scope.accountId)) throw new ClientError('ACCOUNT_CHANGED');
  return JSON.stringify([normalizeServiceUrl(scope.apiBaseUrl), scope.accountId.toLowerCase()]);
}

/** A reducer must be synchronous: IndexedDB transactions cannot survive network awaits. */
export class AccountStore<T> implements AccountStorage<T> {
  private readonly database: Promise<IDBDatabase>;
  private readonly decode: Decode<T>;

  constructor(options: { decode: Decode<T>; indexedDB?: IDBFactory; databaseName?: string }) {
    this.decode = options.decode;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    this.database = new Promise((resolve, reject) => {
      if (!factory) {
        reject(new ClientError('STORAGE_UNAVAILABLE'));
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(options.databaseName ?? 'paperquay-mobile-v1', 1);
      } catch {
        reject(new ClientError('STORAGE_UNAVAILABLE'));
        return;
      }
      request.onupgradeneeded = () =>
        request.result.createObjectStore('accounts', { keyPath: 'scopeKey' });
      request.onerror = () => reject(new ClientError('STORAGE_UNAVAILABLE'));
      request.onblocked = () => reject(new ClientError('STORAGE_UNAVAILABLE'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
    // Opening can fail before callers first access the store; retain a handled rejection.
    void this.database.catch(() => undefined);
  }

  private readRow(value: unknown, scope: AccountScope): T | null {
    if (value === undefined) return null;
    const row = value as Partial<AccountRow>;
    if (
      !row ||
      typeof row !== 'object' ||
      row.version !== 1 ||
      row.scopeKey !== accountScopeKey(scope) ||
      row.accountId !== scope.accountId ||
      row.apiBaseUrl !== normalizeServiceUrl(scope.apiBaseUrl)
    )
      throw new ClientError('STORAGE_CORRUPT');
    try {
      return this.decode(row.state);
    } catch {
      throw new ClientError('STORAGE_CORRUPT');
    }
  }

  async read(scope: AccountScope): Promise<T | null> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('accounts', 'readonly');
      const request = tx.objectStore('accounts').get(accountScopeKey(scope));
      let result: T | null = null;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          result = this.readRow(request.result, scope);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure ?? new ClientError('STORAGE_FAILED'));
    });
  }

  async update(
    scope: AccountScope,
    reducer: (current: T | null) => T,
    guard: () => boolean = () => true,
  ): Promise<T> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('accounts', 'readwrite', { durability: 'strict' });
      const objectStore = tx.objectStore('accounts');
      const request = objectStore.get(accountScopeKey(scope));
      let result: T;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          if (!guard()) throw new ClientError('ACCOUNT_CHANGED');
          const current = this.readRow(request.result, scope);
          result = this.decode(reducer(current));
          objectStore.put({
            scopeKey: accountScopeKey(scope),
            accountId: scope.accountId,
            apiBaseUrl: normalizeServiceUrl(scope.apiBaseUrl),
            version: 1,
            state: result,
          } satisfies AccountRow);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      // The returned state means the entity, outbox, conflicts, and cursor all committed.
      tx.oncomplete = () => resolve(result!);
      tx.onerror = tx.onabort = () =>
        reject(failure instanceof ClientError ? failure : new ClientError('STORAGE_FAILED'));
    });
  }

  async remove(scope: AccountScope): Promise<void> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('accounts', 'readwrite', { durability: 'strict' });
      tx.objectStore('accounts').delete(accountScopeKey(scope));
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new ClientError('STORAGE_FAILED'));
    });
  }

  async close(): Promise<void> {
    (await this.database).close();
  }
}
