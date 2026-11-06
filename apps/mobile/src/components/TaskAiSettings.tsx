import { useCallback, useEffect, useRef } from 'react';
import { AiError } from '../ai/errors.ts';
import { LocalAiConfigStore } from '../ai/provider.ts';
import type { AiAccountScope, AiWorkspaceProps } from '../ai/types.ts';
import { AiWorkspace } from './AiWorkspace.tsx';
import { ReaderSheet } from './ReaderSheet.tsx';
import './taskAiSettings.css';

export function TaskAiSettingsEntry({ scope, disabled, onOpen }: {
  scope: AiAccountScope; disabled: boolean; onOpen(): void;
}) {
  let model = '';
  try { model = new LocalAiConfigStore(localStorage).load(scope).model; } catch { /* Configuration remains available without storage. */ }
  return <div className="task-ai-entry">
    <div><span>AI 助手</span><strong>{model || '先选择要使用的 AI'}</strong></div>
    <button type="button" className="text-button" disabled={disabled} onClick={onOpen}>{model ? '更换 AI' : '设置 AI'}</button>
  </div>;
}

type Props = Pick<AiWorkspaceProps, 'accountScope' | 'secretStore' | 'transport' | 'modelRouter'> & {
  returnTo: string; onClose(): void;
};

/** Keep the task underneath mounted, including its question, selections and unsaved editors. */
export function TaskAiSettingsSheet({ returnTo, onClose, ...runtime }: Props) {
  const dirty = useRef(false);
  const dirtyChanged = useCallback((value: boolean) => { dirty.current = value; }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const close = () => {
    if (dirty.current && !window.confirm('还有未保存的 AI 设置。放弃修改并返回' + returnTo + '？')) return;
    onClose();
  };
  return <ReaderSheet open title="AI 设置" className="task-ai-settings-sheet" onClose={close}>
    <p className="task-ai-return-help">设置完成后返回{returnTo}，已选材料和输入会保留。</p>
    <AiWorkspace {...runtime} mode="settings" context={null}
      onSettingsBack={close} settingsBackLabel={'返回' + returnTo}
      onSettingsDirty={dirtyChanged} onSettingsSaved={onClose}
      onSaveNote={async () => { throw new AiError('CONTEXT_MISSING'); }} onNavigateCitation={() => {}} />
  </ReaderSheet>;
}
