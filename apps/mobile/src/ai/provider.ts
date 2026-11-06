import {AiError} from './errors.ts';
import {accountScopeAvailable} from '../privacy/browserErasure.ts';
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
  loadExternal(scope:AiAccountScope):AiProviderConfig {
    try {const value=this.#storage.getItem(PUBLIC_CONFIG_PREFIX+'external.'+encodeURIComponent(aiAccountKey(scope)));if(value&&value.length<=8192){const config=parseAiProvider(JSON.parse(value));if(!config.execution)return config;}}catch{}
    const current=this.load(scope);return current.execution?defaultAiProvider():current;
  }
  clear(scope:AiAccountScope):void {
    const key=encodeURIComponent(aiAccountKey(scope));
    try{this.#storage.removeItem(PUBLIC_CONFIG_PREFIX+key);this.#storage.removeItem(PUBLIC_CONFIG_PREFIX+'external.'+key);}
    catch{throw new AiError('SETTINGS_STORAGE_FAILED');}
  }
  save(scope: AiAccountScope, config: AiProviderConfig): void {
    if(!accountScopeAvailable(scope))throw new AiError('CANCELLED');
    const safe = parseAiProvider(config);
    try {
      const key=encodeURIComponent(aiAccountKey(scope)),previous=this.load(scope);
      let hasExternal=false;try{hasExternal=this.#storage.getItem(PUBLIC_CONFIG_PREFIX+'external.'+key)!==null;}catch{}
      if(!safe.execution&&(previous.execution||hasExternal))this.#storage.setItem(PUBLIC_CONFIG_PREFIX+'external.'+key,JSON.stringify(safe));
      else if(safe.execution&&!previous.execution)this.#storage.setItem(PUBLIC_CONFIG_PREFIX+'external.'+key,JSON.stringify(previous));
      this.#storage.setItem(PUBLIC_CONFIG_PREFIX+key,JSON.stringify(safe));
    }
    catch { throw new AiError('SETTINGS_STORAGE_FAILED'); }
  }
}
