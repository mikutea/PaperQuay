import { createContext } from 'react';
import {
  ACCOUNT_MODEL_ID, accountModelApproval, parseAccountModelSettings, type AccountModelConnection, type AccountModelSettings,
} from '../../../../packages/ai-core/src/accountModel.ts';
import { AI_SECRET_KEY, aiAccountKey, aiSecretNamespace } from '../../../../packages/ai-core/src/provider.ts';
import type { SyncApi } from '../api.ts';
import { ClientError, describeError } from '../errors.ts';
import { AiError } from './errors.ts';
import type { AiAccountScope, AiProviderConfig, SecretStore } from './types.ts';

type AccountModelApi = Pick<SyncApi, 'readAccountModel' | 'writeAccountModel'>;
export const ACCOUNT_MODEL_APPROVAL_PREFIX = 'paperquay.mobile.account-model-approval.v1.';
interface AccountModelSnapshot {
  available: boolean;
  revision: number;
  provider: AiProviderConfig | null;
  approved: boolean;
  error: string | null;
}

const providers = new Map<string, { owner: AccountModelSession; provider: AiProviderConfig }>();
export const emptyAccountModel: AccountModelSnapshot = {
  available: false, revision: 0, provider: null, approved: false, error: null,
};

export function accountModelProvider(scope: AiAccountScope): AiProviderConfig | undefined {
  return providers.get(aiAccountKey(scope))?.provider;
}

export function accountModelIsApproved(scope: AiAccountScope): boolean {
  const entry = providers.get(aiAccountKey(scope));
  return Boolean(entry && entry.owner.accepts(entry.provider));
}

export function assertAccountModelApproved(scope: AiAccountScope, provider: AiProviderConfig): void {
  if (provider.id !== ACCOUNT_MODEL_ID) return;
  const entry = providers.get(aiAccountKey(scope));
  if (!entry?.owner.accepts(provider)) throw new AiError('ACCOUNT_MODEL_APPROVAL_REQUIRED');
}

type ApprovalStorage = Pick<Storage, 'getItem' | 'setItem'>;
function approvalStorage(): ApprovalStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
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
  #storage: ApprovalStorage | undefined;
  #approval: string | null = null;
  #approvalKey: string;

  constructor(scope: AiAccountScope, api: AccountModelApi, current: () => boolean, storage = approvalStorage()) {
    this.#scope = scope;
    this.#api = api;
    this.#current = current;
    this.#scopeKey = aiAccountKey(scope);
    this.#storage = storage;
    this.#approvalKey = ACCOUNT_MODEL_APPROVAL_PREFIX + encodeURIComponent(this.#scopeKey);
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #isCurrent() {
    return !this.#abort.signal.aborted && this.#current();
  }

  accepts(provider: AiProviderConfig): boolean {
    return this.#isCurrent() && this.#snapshot.approved &&
      JSON.stringify(provider) === JSON.stringify(this.#snapshot.provider);
  }

  approve(revision: number): void {
    const provider = this.#snapshot.provider;
    if (!this.#isCurrent() || !provider || revision !== this.#snapshot.revision) {
      throw new AiError('ACCOUNT_MODEL_CHANGED');
    }
    this.#approval = accountModelApproval(revision, provider);
    try { this.#storage?.setItem(this.#approvalKey, this.#approval); } catch { /* Keep the approval for this session. */ }
    this.#update({ ...this.#snapshot, approved: true });
  }

  #update(snapshot: AccountModelSnapshot) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  async #apply(settings: AccountModelSettings | null, sequence: number) {
    const provider = settings?.connection?.provider ?? null;
    const namespace = provider ? await aiSecretNamespace(this.#scope, provider) : null;
    if (!this.#isCurrent() || this.#sequence !== sequence) return;
    const revision = settings?.revision ?? 0;
    const expected = provider ? accountModelApproval(revision, provider) : null;
    let saved: string | null = null;
    try { saved = this.#storage?.getItem(this.#approvalKey) ?? null; } catch { /* Session approval remains available. */ }
    const approved = Boolean(expected && (this.#approval === expected || saved === expected));
    this.#namespace = namespace;
    if (provider) providers.set(this.#scopeKey, { owner: this, provider });
    else if (providers.get(this.#scopeKey)?.owner === this) providers.delete(this.#scopeKey);
    this.#update({ available: settings !== null, revision, provider, approved, error: null });
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

  async write(connection: AccountModelConnection | null, expectedRevision: number): Promise<void> {
    if (!this.#isCurrent()) throw new ClientError('ACCOUNT_CHANGED');
    if (!this.#snapshot.available || this.#writing) throw new ClientError('ACCOUNT_MODEL_UNAVAILABLE');
    if (expectedRevision !== this.#snapshot.revision) throw new ClientError('ACCOUNT_MODEL_CHANGED');
    const settings = parseAccountModelSettings({ revision: expectedRevision, connection });
    const sequence = ++this.#sequence;
    this.#writing = true;
    try {
      const revision = await this.#api.writeAccountModel(settings, this.#abort.signal);
      if (!this.#isCurrent()) throw new ClientError('ACCOUNT_CHANGED');
      await this.#apply({ ...settings, revision }, sequence);
      if (settings.connection) this.approve(revision);
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
        if (!this.#snapshot.approved) throw new AiError('ACCOUNT_MODEL_APPROVAL_REQUIRED');
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
    this.#approval = null;
  }
}

export const AccountModelContext = createContext<{
  session: AccountModelSession | undefined;
  snapshot: AccountModelSnapshot;
} | null>(null);
