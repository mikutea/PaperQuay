import {AiError} from './errors.ts';
import {aiAccountKey,defaultAiProvider,parseAiProvider} from '../../../../packages/ai-core/src/provider.ts';
import type {AiAccountScope,AiProviderConfig} from './types.ts';
export * from '../../../../packages/ai-core/src/provider.ts';
const PUBLIC_CONFIG_PREFIX='paperquay.mobile.ai-config.v1.';
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
