import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCOUNT_MODEL_ID, type AccountModelSettings } from '../../packages/ai-core/src/accountModel';
import type { AiProviderConfig } from '../../packages/ai-core/src/types';
import { invoke } from '../platform/electron/core';
import { listen } from '../platform/electron/event';
import type { QaModelPreset } from '../types/reader';
import { flushReaderConfigWrites } from './readerConfig';

export { ACCOUNT_MODEL_ID };

interface AccountModelStatus {
  scope: number;
  revision: number;
  provider: AiProviderConfig | null;
}

interface AccountModelPreset extends QaModelPreset {
  accountModelScope: number;
}

function toPreset(provider: AiProviderConfig, scope: number, apiKey = ''): AccountModelPreset {
  const apiMode = provider.apiMode ?? 'chat_completions';
  const path = apiMode === 'responses' ? '/responses' : '/chat/completions';
  return {
    id: ACCOUNT_MODEL_ID,
    label: provider.model,
    baseUrl: provider.endpoint + path,
    model: provider.model,
    apiMode,
    apiKey,
    accountModelScope: scope,
  };
}

export function accountModelPreset(status: AccountModelStatus | null): AccountModelPreset | null {
  return status?.provider ? toPreset(status.provider, status.scope) : null;
}

export function isAccountModelPreset<T extends QaModelPreset>(preset: T | null | undefined): preset is T & AccountModelPreset {
  return preset?.id === ACCOUNT_MODEL_ID && 'accountModelScope' in preset;
}

export async function loadDesktopAccountModelPreset(scope?: number): Promise<AccountModelPreset | null> {
  try {
    const result = await invoke<{ scope: number; settings: AccountModelSettings } | null>(
      'desktop_account_model_read', { includeKey: true, scope },
    );
    const connection = result?.settings.connection;
    return result && connection ? toPreset(connection.provider, result.scope, connection.apiKey ?? '') : null;
  } catch (error) {
    // Optional discovery keeps local workflows available during a service outage.
    // An explicit account-model selection supplies its captured owner scope.
    if (scope !== undefined) throw error;
    return null;
  }
}

export async function saveDesktopAccountModel(status: AccountModelStatus, presetId: string | null) {
  if (presetId !== null) await flushReaderConfigWrites();
  await invoke('desktop_account_model_write', { scope: status.scope, revision: status.revision, presetId });
}

type ModelChange = { scope: number | null; version: number };

export function useDesktopAccountModel() {
  const [status, setStatus] = useState<AccountModelStatus | null>(null);
  const pending = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++pending.current;
    try {
      const next = await invoke<AccountModelStatus | null>('desktop_account_model_read');
      if (id === pending.current) setStatus(next);
    } catch {
      if (id === pending.current) setStatus(null);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.paperquay?.listen) return;
    let active = true;
    let stop: (() => void) | undefined;
    let previousScope: number | null | undefined;
    void listen<ModelChange>('desktop-account-model:changed', ({ payload }) => {
      if (!active || !payload) return;
      if (previousScope !== payload.scope) {
        pending.current++;
        setStatus(null);
      }
      previousScope = payload.scope;
      if (payload.scope !== null) void refresh();
    }).then((unsubscribe) => {
      if (!active) unsubscribe();
      else stop = unsubscribe;
    }).catch(() => {});
    const focused = () => void refresh();
    window.addEventListener('focus', focused);
    void refresh();
    return () => {
      active = false;
      pending.current++;
      stop?.();
      window.removeEventListener('focus', focused);
    };
  }, [refresh]);
  return { status, refresh };
}
