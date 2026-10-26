import { AiError } from './errors.ts';
import type { AiAccountScope, AiProviderConfig } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIG_FIELDS = ['version', 'id', 'endpoint', 'model', 'stream', 'includeUsage', 'requiresKey', 'maxOutputTokens', 'tokenParameter'];
const PUBLIC_CONFIG_PREFIX = 'paperquay.mobile.ai-config.v1.';
export const AI_SECRET_KEY = 'api-key';

export function canonicalAiEndpoint(input: string): string {
  if (typeof input !== 'string' || input.length > 2048 || /[\u0000-\u0020\u007f\\?#]/.test(input)
    || /%(?:00|0a|0d)/i.test(input)) throw new AiError('CONFIG_INVALID');
  let url: URL;
  try { url = new URL(input); } catch { throw new AiError('CONFIG_INVALID'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash
    || /\/(?:chat\/completions|models)\/?$/.test(url.pathname)) throw new AiError('CONFIG_INVALID');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\/$/, '');
}
export function aiAccountKey(scope: AiAccountScope): string {
  if (!scope || typeof scope.accountId !== 'string' || !UUID.test(scope.accountId)) throw new AiError('CONFIG_INVALID');
  return JSON.stringify([canonicalAiEndpoint(scope.apiBaseUrl), scope.accountId]);
}
export function defaultAiProvider(): AiProviderConfig {
  return {
    version: 1, id: 'primary', endpoint: 'https://api.openai.com/v1', model: '',
    stream: true, includeUsage: true, requiresKey: true, maxOutputTokens: 2048,
    tokenParameter: 'max_completion_tokens',
  };
}
export function parseAiProvider(input: unknown, requireModel = false): AiProviderConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiError('CONFIG_INVALID');
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some((key) => !CONFIG_FIELDS.includes(key)) || data.version !== 1
    || typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.id)
    || typeof data.endpoint !== 'string' || typeof data.model !== 'string'
    || (data.model !== '' && !/^[A-Za-z0-9_./:@+-]{1,160}$/.test(data.model))
    || (requireModel && !data.model) || typeof data.stream !== 'boolean' || typeof data.includeUsage !== 'boolean'
    || typeof data.requiresKey !== 'boolean' || !Number.isSafeInteger(data.maxOutputTokens)
    || Number(data.maxOutputTokens) < 64 || Number(data.maxOutputTokens) > 8192
    || !['max_completion_tokens', 'max_tokens'].includes(String(data.tokenParameter))) throw new AiError('CONFIG_INVALID');
  return {
    version: 1, id: data.id, endpoint: canonicalAiEndpoint(data.endpoint), model: data.model,
    stream: data.stream, includeUsage: data.includeUsage, requiresKey: data.requiresKey,
    maxOutputTokens: Number(data.maxOutputTokens),
    tokenParameter: data.tokenParameter as AiProviderConfig['tokenParameter'],
  };
}
export async function aiSecretNamespace(scope: AiAccountScope, provider: AiProviderConfig): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([aiAccountKey(scope), provider.id, canonicalAiEndpoint(provider.endpoint)]));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return 'paperquay.ai.v1.' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function checkedApiKey(input: string): string {
  if (typeof input !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(input)) throw new AiError('KEY_INVALID');
  return input;
}
export class LocalAiConfigStore {
  #storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  constructor(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) { this.#storage = storage; }
  load(scope: AiAccountScope): AiProviderConfig {
    try {
      const value = this.#storage.getItem(PUBLIC_CONFIG_PREFIX + encodeURIComponent(aiAccountKey(scope)));
      if (!value || value.length > 8192) return defaultAiProvider();
      return parseAiProvider(JSON.parse(value));
    } catch { return defaultAiProvider(); }
  }
  save(scope: AiAccountScope, config: AiProviderConfig): void {
    const safe = parseAiProvider(config);
    try { this.#storage.setItem(PUBLIC_CONFIG_PREFIX + encodeURIComponent(aiAccountKey(scope)), JSON.stringify(safe)); }
    catch { throw new AiError('SETTINGS_STORAGE_FAILED'); }
  }
}
