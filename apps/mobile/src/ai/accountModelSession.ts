import { createContext } from 'react';
import {
  parseAccountModelSettings, type AccountModelConnection, type AccountModelSettings,
} from '../../../../packages/ai-core/src/accountModel.ts';
import { AI_SECRET_KEY, aiAccountKey, aiSecretNamespace } from '../../../../packages/ai-core/src/provider.ts';
import type { SyncApi } from '../api.ts';
import { ClientError, describeError } from '../errors.ts';
import { AiError } from './errors.ts';
import type { AiAccountScope, AiProviderConfig, SecretStore } from './types.ts';

type AccountModelApi = Pick<SyncApi, 'readAccountModel' | 'writeAccountModel'>;
interface AccountModelSnapshot {
  available: boolean;
  revision: number;
  provider: AiProviderConfig | null;
  error: string | null;
}

const providers = new Map<string, { owner: AccountModelSession; provider: AiProviderConfig }>();
export const emptyAccountModel: AccountModelSnapshot = {
  available: false, revision: 0, provider: null, error: null,
};

export function accountModelProvider(scope: AiAccountScope): AiProviderConfig | undefined {
  return providers.get(aiAccountKey(scope))?.provider;
}

/** Keep only public settings in the active workspace and resolve the key on demand. */
export class AccountModelSession {
  #snapshot = emptyAccountModel;
  #listeners = new Set<() => void>();
  #abort = new AbortController();
  #scopeKey: string;
  #namespace: string | null = null;
  #sequence = 0;
  #writing = false;
  #scope: AiAccountScope;
  #api: AccountModelApi;
  #current: () => boolean;

  constructor(scope: AiAccountScope, api: AccountModelApi, current: () => boolean) {
    this.#scope = scope;
    this.#api = api;
    this.#current = current;
    this.#scopeKey = aiAccountKey(scope);
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #isCurrent() {
    return !this.#abort.signal.aborted && this.#current();
  }

  #update(snapshot: AccountModelSnapshot) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  async #apply(settings: AccountModelSettings | null, sequence: number) {
    const provider = settings?.connection?.provider ?? null;
    const namespace = provider ? await aiSecretNamespace(this.#scope, provider) : null;
    if (!this.#isCurrent() || this.#sequence !== sequence) return;
    this.#namespace = namespace;
    if (provider) providers.set(this.#scopeKey, { owner: this, provider });
    else if (providers.get(this.#scopeKey)?.owner === this) providers.delete(this.#scopeKey);
    this.#update({ available: settings !== null, revision: settings?.revision ?? 0, provider, error: null });
  }

  async refresh(): Promise<void> {
    if (!this.#isCurrent() || this.#writing) return;
    const sequence = ++this.#sequence;
    try {
      const settings = await this.#api.readAccountModel(this.#abort.signal);
      await this.#apply(settings, sequence);
    } catch (error) {
      if (this.#isCurrent() && this.#sequence === sequence) {
        this.#update({ ...this.#snapshot, error: describeError(error) });
      }
    }
  }

  async write(connection: AccountModelConnection | null): Promise<void> {
    if (!this.#isCurrent()) throw new ClientError('ACCOUNT_CHANGED');
    if (!this.#snapshot.available || this.#writing) throw new ClientError('ACCOUNT_MODEL_UNAVAILABLE');
    const settings = parseAccountModelSettings({ revision: this.#snapshot.revision, connection });
    const sequence = ++this.#sequence;
    this.#writing = true;
    try {
      const revision = await this.#api.writeAccountModel(settings, this.#abort.signal);
      if (!this.#isCurrent()) throw new ClientError('ACCOUNT_CHANGED');
      await this.#apply({ ...settings, revision }, sequence);
    } finally {
      this.#writing = false;
    }
  }

  secretStore(local: SecretStore): SecretStore {
    return {
      persistence: local.persistence,
      get: async (namespace, key) => {
        if (key !== AI_SECRET_KEY || namespace !== this.#namespace) return local.get(namespace, key);
        if (!this.#isCurrent()) throw new AiError('CANCELLED');
        const revision = this.#snapshot.revision;
        const settings = await this.#api.readAccountModel(this.#abort.signal);
        if (!this.#isCurrent()) throw new AiError('CANCELLED');
        if (!settings?.connection || settings.revision !== revision || this.#snapshot.revision !== revision) {
          if (!this.#writing && this.#snapshot.revision === revision) await this.#apply(settings, ++this.#sequence);
          throw new AiError('ACCOUNT_MODEL_CHANGED');
        }
        return settings.connection.apiKey;
      },
      set: (namespace, key, value) => local.set(namespace, key, value),
      remove: (namespace, key) => local.remove(namespace, key),
    };
  }

  close() {
    this.#abort.abort();
    if (providers.get(this.#scopeKey)?.owner === this) providers.delete(this.#scopeKey);
    this.#listeners.clear();
    this.#namespace = null;
  }
}

export const AccountModelContext = createContext<{
  session: AccountModelSession | undefined;
  snapshot: AccountModelSnapshot;
} | null>(null);
