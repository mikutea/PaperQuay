import { AiError } from './errors.ts';
import { checkedApiKey, parseAiProvider } from './provider.ts';
import type { AiProviderConfig } from './types.ts';

export const ACCOUNT_MODEL_ID = 'account-model';

export function accountModelApproval(revision: number, provider: AiProviderConfig): string {
  return JSON.stringify([revision, parseAiProvider(provider, true)]);
}

export interface AccountModelConnection {
  provider: AiProviderConfig;
  apiKey: string | null;
}

export interface AccountModelSettings {
  revision: number;
  connection: AccountModelConnection | null;
}

export function parseAccountModelSettings(value: unknown): AccountModelSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiError('CONFIG_INVALID');
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).length !== 2 || !Object.hasOwn(settings, 'connection') ||
      !Number.isInteger(settings.revision) || Number(settings.revision) < 0 || Number(settings.revision) > 2147483647) {
    throw new AiError('CONFIG_INVALID');
  }
  const revision = Number(settings.revision);
  if (settings.connection === null) return { revision, connection: null };
  if (!settings.connection || typeof settings.connection !== 'object' || Array.isArray(settings.connection)) {
    throw new AiError('CONFIG_INVALID');
  }
  const input = settings.connection as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'apiKey')) throw new AiError('CONFIG_INVALID');
  const provider = parseAiProvider(input.provider, true);
  if (provider.execution) throw new AiError('CONFIG_INVALID');
  if (input.apiKey !== null && typeof input.apiKey !== 'string') throw new AiError('KEY_INVALID');
  const apiKey = input.apiKey === null ? null : checkedApiKey(input.apiKey);
  if (provider.requiresKey && !apiKey) throw new AiError('KEY_MISSING');
  const url = new URL(provider.endpoint);
  if (apiKey && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new AiError('CONFIG_INVALID');
  }
  return { revision, connection: { provider: { ...provider, id: ACCOUNT_MODEL_ID }, apiKey } };
}
