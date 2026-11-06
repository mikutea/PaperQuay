import type { StateStore } from 'oidc-client-ts';
import { ClientError } from '../errors.ts';
import type { SecretStore } from '../platform/secretStore.ts';

const queues = new WeakMap<SecretStore, Map<string, Promise<unknown>>>();
/** Shared across auth instances so replacing a runtime cannot race a late secure-store write. */
export function serializeSecret<T>(secrets: SecretStore, address: string, action: () => Promise<T>): Promise<T> {
  let map = queues.get(secrets);
  if (!map) { map = new Map(); queues.set(secrets, map); }
  const result = (map.get(address) ?? Promise.resolve()).then(action);
  const tail = result.catch(() => undefined);
  map.set(address, tail);
  void tail.then(() => { if (map!.get(address) === tail) map!.delete(address); });
  return result;
}

/** One bounded encrypted record keeps the PKCE verifier and state index atomic. */
export class SecureOidcStateStore implements StateStore {
  constructor(private readonly secrets: SecretStore, private readonly namespace: string, private readonly active: () => boolean = () => true) {}
  private async read(): Promise<Record<string, { value: string; expiresAt: number }>> {
    const raw = await this.secrets.get(this.namespace, 'pending-state');
    if (!raw) return {};
    try {
      const data = JSON.parse(raw) as Record<string, { value: string; expiresAt: number }>;
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > 8) throw new Error();
      const clean: Record<string, { value: string; expiresAt: number }> = {};
      for (const [key, entry] of Object.entries(data)) {
        if (!/^[A-Za-z0-9_-]{16,160}$/.test(key) || !entry || typeof entry.value !== 'string' ||
            entry.value.length > 16384 || !Number.isFinite(entry.expiresAt)) throw new Error();
        if (entry.expiresAt > Date.now() && entry.expiresAt <= Date.now() + 10 * 60_000) clean[key] = entry;
      }
      return clean;
    } catch { throw new ClientError('STORAGE_CORRUPT'); }
  }
  private operation<T>(action: () => Promise<T>): Promise<T> {
    return serializeSecret(this.secrets, `${this.namespace}:state`, async () => {
      if (!this.active()) throw new ClientError('ACCOUNT_CHANGED');
      return action();
    });
  }
  set(key: string, value: string): Promise<void> {
    return this.operation(async () => {
      if (!/^[A-Za-z0-9_-]{16,160}$/.test(key) || value.length > 16384) throw new ClientError('AUTH_FAILED');
      const entries = await this.read();
      if (!this.active()) throw new ClientError('ACCOUNT_CHANGED');
      if (!entries[key] && Object.keys(entries).length >= 8) throw new ClientError('AUTH_FAILED');
      entries[key] = { value, expiresAt: Date.now() + 10 * 60_000 };
      await this.secrets.set(this.namespace, 'pending-state', JSON.stringify(entries));
    });
  }
  get(key: string): Promise<string | null> {
    return this.operation(async () => (await this.read())[key]?.value ?? null);
  }
  remove(key: string): Promise<string | null> {
    return this.operation(async () => {
      const entries = await this.read();
      const value = entries[key]?.value ?? null;
      delete entries[key];
      if (!this.active()) throw new ClientError('ACCOUNT_CHANGED');
      await this.secrets.set(this.namespace, 'pending-state', JSON.stringify(entries));
      return value;
    });
  }
  getAllKeys(): Promise<string[]> { return this.operation(async () => Object.keys(await this.read())); }
  clear(): Promise<void> {
    return serializeSecret(this.secrets, `${this.namespace}:state`, () => this.secrets.remove(this.namespace, 'pending-state'));
  }
}
