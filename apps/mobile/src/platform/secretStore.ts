import { Capacitor } from '@capacitor/core';
import { ClientError } from '../errors.ts';

/** Secrets never enter account snapshots, browser persistence, logs, or reactive state. */
export interface SecretStore {
  readonly persistence: 'memory' | 'system';
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  remove(namespace: string, key: string): Promise<void>;
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
  async get(namespace: string, key: string): Promise<string | null> {
    return this.values.get(secretAddress(namespace, key)) ?? null;
  }
  async set(namespace: string, key: string, value: string): Promise<void> {
    validateSecret(value);
    this.values.set(secretAddress(namespace, key), value);
  }
  async remove(namespace: string, key: string): Promise<void> {
    this.values.delete(secretAddress(namespace, key));
  }
}

let shared: Promise<SecretStore> | undefined;
export function createSecretStore(): Promise<SecretStore> {
  shared ??= (Capacitor.isNativePlatform()
    ? import('./nativeSecrets.ts').then(({ createNativeSecretStore }) => createNativeSecretStore())
    : Promise.resolve(new MemorySecretStore())).catch((error) => {
      shared = undefined;
      throw error instanceof ClientError ? error : new ClientError('STORAGE_UNAVAILABLE');
    });
  return shared;
}
