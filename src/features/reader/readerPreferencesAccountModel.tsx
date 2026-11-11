import { useState } from 'react';
import { saveDesktopAccountModel, useDesktopAccountModel } from '../../services/desktopAccountModel';
import type { QaModelPreset } from '../../types/reader';
import { SettingsField, SettingsSelect } from './readerPreferencesPrimitives';
import type { ReaderPreferencesLocalizer } from './readerPreferencesTypes';

export function ReaderPreferencesAccountModel({ l, presets, activePresetId }: {
  l: ReaderPreferencesLocalizer;
  presets: QaModelPreset[];
  activePresetId: string;
}) {
  const { status, refresh } = useDesktopAccountModel();
  const [selection, setSelection] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const configured = presets.filter(preset => preset.baseUrl.trim() && preset.model.trim() && preset.apiKey.trim());
  const selected = configured.find(preset => preset.id === (selection ?? activePresetId)) ?? configured[0];

  if (!status) return null;

  const save = async (presetId: string | null) => {
    setBusy(true);
    setFeedback(undefined);
    try {
      await saveDesktopAccountModel(status, presetId);
      setFeedback({ error: false, text: presetId === null
        ? l('账号模型已移除。', 'Account model removed.')
        : l('模型已保存到账号。', 'Model saved to your account.') });
    } catch (error) {
      setFeedback({ error: true, text: String(error).includes('ACCOUNT_MODEL_CHANGED')
        ? l('账号模型已在另一端更新，请核对后再保存。', 'The account model changed on another device. Review it before saving again.')
        : l('保存失败，请检查账号连接和模型设置。', 'Could not save. Check the account connection and model settings.') });
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  const buttonClass = 'min-h-9 rounded-md border border-[var(--pq-border)] px-3 text-sm text-[var(--pq-text)] hover:bg-[var(--pq-hover)] disabled:opacity-50';
  return <SettingsField
    label={l('账号模型', 'Account model')}
    description={l('已登录的设备可以使用这份模型设置。密钥由账号服务加密保存。', 'Signed-in devices can use these model settings. The account service encrypts the API key.')}
  >
    <div className="space-y-2">
      {status.provider && <p className="break-words text-sm text-[var(--pq-text)]">{status.provider.model}</p>}
      <SettingsSelect
        aria-label={l('选择要保存到账号的本机预设', 'Choose a local preset to save to your account')}
        value={selected?.id ?? ''} disabled={busy || !selected}
        onChange={event => { setSelection(event.target.value); setFeedback(undefined); }}
      >
        {!selected && <option value="">{l('请先配置本机模型', 'Configure a local model first')}</option>}
        {configured.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
      </SettingsSelect>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy || !selected}
          onClick={() => selected && void save(selected.id)}>{l('保存到账号', 'Save to account')}</button>
        {status.provider && <button type="button" className={buttonClass} disabled={busy}
          onClick={() => void save(null)}>{l('移除账号模型', 'Remove account model')}</button>}
      </div>
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className="text-sm text-[var(--pq-text-muted)]">{feedback.text}</p>}
    </div>
  </SettingsField>;
}
