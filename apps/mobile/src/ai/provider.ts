import {AiError} from './errors.ts';
import {accountScopeAvailable} from '../privacy/browserErasure.ts';
import {aiAccountKey,defaultAiProvider,parseAiProvider} from '../../../../packages/ai-core/src/provider.ts';
import type {AiAccountScope,AiProviderConfig} from './types.ts';
import { ACCOUNT_MODEL_ID } from '../../../../packages/ai-core/src/accountModel.ts';
import { ACCOUNT_MODEL_APPROVAL_PREFIX, accountModelIsApproved, accountModelProvider } from './accountModelSession.ts';
export * from '../../../../packages/ai-core/src/provider.ts';
const PUBLIC_CONFIG_PREFIX='paperquay.mobile.ai-config.v1.';
export class LocalAiConfigStore {
  #storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  constructor(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) { this.#storage = storage; }
  load(scope: AiAccountScope): AiProviderConfig {
    try {
      const key = encodeURIComponent(aiAccountKey(scope));
      const provider = accountModelProvider(scope);
      const mode = this.#storage.getItem(PUBLIC_CONFIG_PREFIX + 'mode.' + key);
      if (provider && mode !== 'local' && (mode === 'account' || accountModelIsApproved(scope))) return provider;
    } catch { /* Local settings remain available. */ }
    return this.loadLocal(scope);
  }
  loadLocal(scope: AiAccountScope): AiProviderConfig {
    try {
      const value = this.#storage.getItem(PUBLIC_CONFIG_PREFIX + encodeURIComponent(aiAccountKey(scope)));
      if (!value || value.length > 8192) return defaultAiProvider();
      return parseAiProvider(JSON.parse(value));
    } catch { return defaultAiProvider(); }
  }
  loadExternal(scope:AiAccountScope):AiProviderConfig {
    try {const value=this.#storage.getItem(PUBLIC_CONFIG_PREFIX+'external.'+encodeURIComponent(aiAccountKey(scope)));if(value&&value.length<=8192){const config=parseAiProvider(JSON.parse(value));if(!config.execution)return config;}}catch{}
    const current=this.loadLocal(scope);return current.execution?defaultAiProvider():current;
  }
  useAccount(scope: AiAccountScope): void {
    if (!accountScopeAvailable(scope)) throw new AiError('CANCELLED');
    try { this.#storage.setItem(PUBLIC_CONFIG_PREFIX + 'mode.' + encodeURIComponent(aiAccountKey(scope)), 'account'); }
    catch { throw new AiError('SETTINGS_STORAGE_FAILED'); }
  }
  clear(scope:AiAccountScope):void {
    const key=encodeURIComponent(aiAccountKey(scope));
    try{this.#storage.removeItem(PUBLIC_CONFIG_PREFIX+key);this.#storage.removeItem(PUBLIC_CONFIG_PREFIX+'external.'+key);this.#storage.removeItem(PUBLIC_CONFIG_PREFIX+'mode.'+key);this.#storage.removeItem(ACCOUNT_MODEL_APPROVAL_PREFIX+key);}
    catch{throw new AiError('SETTINGS_STORAGE_FAILED');}
  }
  save(scope: AiAccountScope, config: AiProviderConfig): void {
    if(!accountScopeAvailable(scope))throw new AiError('CANCELLED');
    const safe = parseAiProvider(config);
    if (safe.id === ACCOUNT_MODEL_ID) { this.useAccount(scope); return; }
    try {
      const key=encodeURIComponent(aiAccountKey(scope)),previous=this.loadLocal(scope);
      let hasExternal=false;try{hasExternal=this.#storage.getItem(PUBLIC_CONFIG_PREFIX+'external.'+key)!==null;}catch{}
      if(!safe.execution&&(previous.execution||hasExternal))this.#storage.setItem(PUBLIC_CONFIG_PREFIX+'external.'+key,JSON.stringify(safe));
      else if(safe.execution&&!previous.execution)this.#storage.setItem(PUBLIC_CONFIG_PREFIX+'external.'+key,JSON.stringify(previous));
      this.#storage.setItem(PUBLIC_CONFIG_PREFIX+key,JSON.stringify(safe));
      if (accountModelProvider(scope)) this.#storage.setItem(PUBLIC_CONFIG_PREFIX + 'mode.' + key, 'local');
    }
    catch { throw new AiError('SETTINGS_STORAGE_FAILED'); }
  }
}
