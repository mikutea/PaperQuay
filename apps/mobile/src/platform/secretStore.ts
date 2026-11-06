import { Capacitor } from '@capacitor/core';
import { ClientError } from '../errors.ts';

/** Secrets never enter account snapshots, browser persistence, logs, or reactive state. */
export interface SecretStore {
  readonly persistence: 'memory' | 'system';
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  remove(namespace: string, key: string): Promise<void>;
  /** Native erasure must account for every prefixed system entry, including
   * entries from versions before the account address registry existed. */
  verifyErasureInventory?(): Promise<void>;
  /** Web runtime disposal destroys its own volatile map before releasing its
   * cross-context RAM lease. Native system storage is retained. */
  disposeMemory?():void;
}

export function secretAddress(namespace: string, key: string): string {
  if (!namespace || namespace.length > 4096 || !key || key.length > 256 || /[\u0000-\u001f]/.test(namespace + key)) {
    throw new ClientError('STORAGE_FAILED');
  }
  return JSON.stringify([namespace, key]);
}

export function validateSecret(value: string): void {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 131072) {
    throw new ClientError('STORAGE_FAILED');
  }
}

/** Browser credentials deliberately disappear on reload; no Web Storage fallback. */
export class MemorySecretStore implements SecretStore {
  readonly persistence = 'memory' as const;
  private readonly values = new Map<string, string>();
  private disposed=false;
  private check(){if(this.disposed)throw new ClientError('STORAGE_UNAVAILABLE');}
  async get(namespace: string, key: string): Promise<string | null> {
    this.check();
    return this.values.get(secretAddress(namespace, key)) ?? null;
  }
  async set(namespace: string, key: string, value: string): Promise<void> {
    this.check();
    validateSecret(value);
    this.values.set(secretAddress(namespace, key), value);
  }
  async remove(namespace: string, key: string): Promise<void> {
    this.check();
    this.values.delete(secretAddress(namespace, key));
  }
  disposeMemory(){this.disposed=true;this.values.clear();}
}

let shared: Promise<SecretStore> | undefined;
export function createSecretStore(): Promise<SecretStore> {
  if(!Capacitor.isNativePlatform())return Promise.resolve(new MemorySecretStore());
  shared ??= import('./nativeSecrets.ts').then(({ createNativeSecretStore }) => createNativeSecretStore()).catch((error) => {
      shared = undefined;
      throw error instanceof ClientError ? error : new ClientError('STORAGE_UNAVAILABLE');
    });
  return shared;
}
