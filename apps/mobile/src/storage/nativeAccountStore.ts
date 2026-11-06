import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { ClientError } from '../errors.ts';
import { AccountSqliteDatabase, SqliteAccountStore } from './sqliteAccountStore.ts';

let shared: Promise<AccountSqliteDatabase> | undefined;
async function database(): Promise<AccountSqliteDatabase> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('CapacitorSQLite')) throw new ClientError('STORAGE_UNAVAILABLE');
  shared ??= (async () => {
    const manager = new SQLiteConnection(CapacitorSQLite);
    const connection = await manager.createConnection('paperquay_mobile_v1', false, 'no-encryption', 1, false);
    try {
      await connection.open();
      const database = new AccountSqliteDatabase({
        execute: async (sql) => { await connection.execute(sql, false); },
        query: async (sql, values) => (await connection.query(sql, values)).values ?? [],
        run: async (sql, values) => { await connection.run(sql, values, false); },
        begin: async () => { await connection.beginTransaction(); },
        commit: async () => { await connection.commitTransaction(); },
        rollback: async () => { await connection.rollbackTransaction(); },
        close: async () => { await manager.closeConnection('paperquay_mobile_v1', false); },
      });
      await database.run(async () => undefined);
      return database;
    }
    catch (error) {
      await manager.closeConnection('paperquay_mobile_v1', false).catch(() => undefined);
      throw error;
    }
  })().catch(() => { shared = undefined; throw new ClientError('STORAGE_UNAVAILABLE'); });
  return shared;
}
export async function createNativeAccountStorage<T>(options: { decode: (value: unknown) => T }): Promise<SqliteAccountStore<T>> {
  return new SqliteAccountStore({ ...options, database: await database() });
}
