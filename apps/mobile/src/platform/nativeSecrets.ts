import { Capacitor } from '@capacitor/core';
import { KeychainAccess, SecureStorage, type SecureStoragePlugin } from '@aparajita/capacitor-secure-storage';
import { ClientError } from '../errors.ts';
import { secretAddress, validateSecret, type SecretStore } from './secretStore.ts';

type SecureBridge = Pick<SecureStoragePlugin, 'get' | 'set' | 'remove'> & Partial<Pick<SecureStoragePlugin, 'keys'>>;
export const NATIVE_SECRET_INVENTORY = 'address-inventory-v1';

/** Serializing before the asynchronous hash preserves set/remove order during logout. */
export class NativeSecretStore implements SecretStore {
  readonly persistence = 'system' as const;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly bridge: SecureBridge) {}

  private async inventory(): Promise<string[]> {
    const raw = await this.bridge.get(NATIVE_SECRET_INVENTORY, false, false);
    if (raw === null) return [];
    let value: unknown;
    try { value = typeof raw === 'string' && raw.length <= 100000 ? JSON.parse(raw) : null; } catch {}
    const row = value as {version?:unknown;addresses?:unknown} | null;
    if (!row || row.version !== 1 || !Array.isArray(row.addresses) || row.addresses.length > 1024 ||
      row.addresses.some(x => typeof x !== 'string' || !/^[a-f0-9]{64}$/.test(x)) || new Set(row.addresses).size !== row.addresses.length)
      throw new ClientError('STORAGE_CORRUPT');
    return row.addresses;
  }
  private async track(address: string, present: boolean): Promise<void> {
    const rows = await this.inventory(), exists = rows.includes(address);
    if (exists === present) return;
    if (present && rows.length >= 1024) throw new ClientError('STORAGE_FAILED');
    const addresses = present ? [...rows, address] : rows.filter(x => x !== address);
    await this.bridge.set(NATIVE_SECRET_INVENTORY, JSON.stringify({version:1, addresses}), false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
  }

  verifyErasureInventory(): Promise<void> {
    const result = this.tail.then(async () => {
      try {
        if (!this.bridge.keys) throw new ClientError('LEGACY_SECRETS_UNVERIFIED');
        const rows = new Set(await this.inventory()), keys = await this.bridge.keys(false);
        if (!Array.isArray(keys) || keys.length > 1025 || keys.some(key => typeof key !== 'string' || key !== NATIVE_SECRET_INVENTORY && !rows.has(key)))
          throw new ClientError('LEGACY_SECRETS_UNVERIFIED');
      } catch (error) { throw error instanceof ClientError ? error : new ClientError('STORAGE_FAILED'); }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private operation<T>(namespace: string, key: string, action: (address: string) => Promise<T>): Promise<T> {
    const address = secretAddress(namespace, key);
    const result = this.tail.then(async () => {
      try {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
        const digest = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
        return await action(digest);
      } catch (error) {
        throw error instanceof ClientError ? error : new ClientError('STORAGE_FAILED');
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  get(namespace: string, key: string): Promise<string | null> {
    return this.operation(namespace, key, async (address) => {
      const value = await this.bridge.get(address, false, false);
      if (value !== null && typeof value !== 'string') throw new ClientError('STORAGE_CORRUPT');
      if (value !== null) validateSecret(value);
      // Known legacy addresses migrate when accessed. Opaque legacy hashes
      // that cannot be attributed remain unverified and block an erasure ACK.
      if (value !== null) await this.track(address, true);
      return value;
    });
  }
  set(namespace: string, key: string, value: string): Promise<void> {
    validateSecret(value);
    return this.operation(namespace, key, async (address) => {
      await this.track(address, true); // Persist history before the value.
      await this.bridge.set(address, value, false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
    });
  }
  remove(namespace: string, key: string): Promise<void> {
    return this.operation(namespace, key, async (address) => {
      await this.bridge.remove(address, false);
      await this.track(address, false);
    });
  }
}

export async function createNativeSecretStore(): Promise<SecretStore> {
  // This plugin's web implementation uses localStorage; it must never be reached.
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('SecureStorage')) {
    throw new ClientError('STORAGE_UNAVAILABLE');
  }
  try {
    await SecureStorage.setKeyPrefix('paperquay.secure.v1.');
    await SecureStorage.setSynchronize(false);
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
    return new NativeSecretStore(SecureStorage);
  } catch {
    throw new ClientError('STORAGE_UNAVAILABLE');
  }
}
