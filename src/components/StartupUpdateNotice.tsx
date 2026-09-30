import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocaleText } from '../i18n/uiLanguage';
import { checkForStartupUpdate, dismissStartupUpdate, type AppUpdateStatus } from '../services/appUpdate';
import { ReaderPreferencesUpdateSection } from '../features/reader/readerPreferencesUpdateSection';

export default function StartupUpdateNotice() {
  const l = useLocaleText();
  const [notice, setNotice] = useState<AppUpdateStatus | null>(null);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    // Let the library render first. The main process also deduplicates this
    // check across renderer reloads/windows for the entire application session.
    const timer = window.setTimeout(() => {
      void checkForStartupUpdate().then((status) => {
        if (active && status.showStartupNotice) setNotice(status);
      }).catch(() => { /* Offline startup must not block reading. */ });
    }, 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (notice && dialog.current && !dialog.current.open) {
      dialog.current.showModal();
      dialog.current.querySelector<HTMLButtonElement>('[data-update-later]')?.focus();
    }
  }, [notice]);

  const dismiss = async (skip: boolean) => {
    try {
      await dismissStartupUpdate(skip);
      dialog.current?.close();
      setNotice(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  if (!notice) return null;
  return createPortal(
    <dialog ref={dialog} aria-labelledby="startup-update-title"
      onCancel={(event) => { event.preventDefault(); void dismiss(false); }}
      className="m-auto max-h-[85vh] w-[min(760px,calc(100vw-32px))] overflow-auto rounded-2xl border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-5 text-[var(--pq-text)] shadow-[var(--pq-shadow-dialog)] backdrop:bg-black/50">
      <h2 id="startup-update-title" className="mb-4 text-lg font-semibold">
        {l(`发现新版本 ${notice.latestVersion}`, `Version ${notice.latestVersion} is available`)}
      </h2>
      <ReaderPreferencesUpdateSection active l={l} initialStatus={notice} />
      {error ? <p role="alert" className="mt-3 text-[var(--pq-danger)]">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-3">
        <button type="button" onClick={() => void dismiss(true)} className="pq-button px-3 py-2">{l('跳过此版本', 'Skip This Version')}</button>
        <button type="button" data-update-later onClick={() => void dismiss(false)} className="pq-button px-3 py-2">{l('稍后提醒', 'Later')}</button>
      </div>
    </dialog>, document.body,
  );
}
