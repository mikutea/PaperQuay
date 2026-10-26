import { Capacitor } from '@capacitor/core';
import { KeychainAccess, SecureStorage, type SecureStoragePlugin } from '@aparajita/capacitor-secure-storage';
import { ClientError } from '../errors.ts';
import { secretAddress, validateSecret, type SecretStore } from './secretStore.ts';

type SecureBridge = Pick<SecureStoragePlugin, 'get' | 'set' | 'remove'>;

/** Serializing before the asynchronous hash preserves set/remove order during logout. */
export class NativeSecretStore implements SecretStore {
  readonly persistence = 'system' as const;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly bridge: SecureBridge) {}

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
      return value;
    });
  }
  set(namespace: string, key: string, value: string): Promise<void> {
    validateSecret(value);
    return this.operation(namespace, key, (address) =>
      this.bridge.set(address, value, false, false, KeychainAccess.whenUnlockedThisDeviceOnly));
  }
  remove(namespace: string, key: string): Promise<void> {
    return this.operation(namespace, key, async (address) => { await this.bridge.remove(address, false); });
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
