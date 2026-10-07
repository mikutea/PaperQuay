import clsx from 'clsx';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useWheelScrollDelegate } from '../../hooks/useWheelScrollDelegate';
import { pickLocaleText, type PreferencesSectionKey } from './readerShared';
import {
  buildReaderPreferencesSections,
  ReaderPreferencesContent,
} from './readerPreferencesContent';
import type { ReaderPreferencesWindowProps } from './readerPreferencesTypes';

export type { ReaderPreferencesWindowProps } from './readerPreferencesTypes';

function normalizePreferencesSection(section: PreferencesSectionKey | undefined): PreferencesSectionKey | undefined {
  return section === 'embedding' ? 'models' : section;
}

export default function ReaderPreferencesWindow({
  open,
  onClose,
  preferredSection,
  settings,
  translatedCount = 0,
  configSaveError = '',
  onRetryConfigSave,
  ...contentProps
}: ReaderPreferencesWindowProps) {
  const l = <T,>(zh: T, en: T) => pickLocaleText(settings.uiLanguage, zh, en);
  const sections = buildReaderPreferencesSections(l);
  const [activeSection, setActiveSection] = useState<PreferencesSectionKey>('general');
  const sidebarRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const handleSidebarWheelCapture = useWheelScrollDelegate({ rootRef: sidebarRef });
  const handleContentWheelCapture = useWheelScrollDelegate({ rootRef: contentRef });

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const normalizedSection = normalizePreferencesSection(preferredSection);

    if (normalizedSection) {
      setActiveSection(normalizedSection);
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open, preferredSection]);

  if (!open) {
    return null;
  }

  const activeSectionMeta = sections.find((section) => section.key === activeSection);

  const dialog = (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/62 backdrop-blur-sm">
      <button
        type="button"
        aria-label={l('关闭设置窗口', 'Close settings window')}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <div className="paperquay-settings relative flex h-[min(760px,calc(100vh-32px))] w-[min(1080px,calc(100vw-32px))] overflow-hidden rounded-[var(--pq-radius-lg)] border border-[var(--pq-border)] bg-[var(--pq-bg-primary)] shadow-[var(--pq-shadow-dialog)]">
        <aside
          ref={sidebarRef}
          onWheelCapture={handleSidebarWheelCapture}
          className="flex min-h-0 w-64 shrink-0 flex-col border-r border-[var(--pq-border)] bg-[var(--pq-sidebar)] px-4 py-4 backdrop-blur-xl"
        >
          <div className="shrink-0 px-3 pb-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--pq-text-faint)]">
              {l('设置', 'Settings')}
            </div>
            <div className="mt-2 text-2xl font-semibold tracking-tight text-[var(--pq-text)]">
              {l('设置', 'Settings')}
            </div>
            <div className="mt-2 text-sm leading-6 text-[var(--pq-text-muted)]">
              {l(
                '像桌面应用一样管理文库、阅读、解析与模型能力。',
                'Manage library, reading, parsing, and model capabilities in a desktop-first workflow.',
              )}
            </div>
          </div>

          <div
            data-wheel-scroll-target
            className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-y-contain pr-1"
          >
            {sections.map((section) => (
              <button
                key={section.key}
                type="button"
                onClick={() => setActiveSection(section.key)}
                className={clsx(
                  'flex w-full items-start gap-3 rounded-[var(--pq-radius-md)] px-3 py-3 text-left transition-all duration-200',
                  activeSection === section.key
                    ? 'bg-[var(--pq-accent-soft)] text-[var(--pq-accent)] ring-1 ring-[var(--pq-focus-ring)]'
                    : 'text-[var(--pq-text-muted)] hover:bg-[var(--pq-hover)] hover:text-[var(--pq-text)]',
                )}
              >
                <span
                  className={clsx(
                    'mt-0.5',
                    activeSection === section.key
                      ? 'text-[var(--pq-accent)]'
                      : 'text-[var(--pq-text-faint)]',
                  )}
                >
                  {section.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{section.title}</span>
                  <span
                    className={clsx(
                      'mt-1 block text-xs leading-5',
                      activeSection === section.key
                        ? 'text-[var(--pq-text-muted)]'
                        : 'text-[var(--pq-text-faint)]',
                    )}
                  >
                    {section.description}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="mt-4 shrink-0 rounded-[var(--pq-radius-md)] border border-[var(--pq-border)] bg-[var(--pq-surface-1)] p-3 text-xs leading-5 text-[var(--pq-text-muted)]">
            {l(
              `当前翻译缓存：${translatedCount} 个结构块`,
              `Translation cache: ${translatedCount} blocks`,
            )}
          </div>
        </aside>

        <section
          ref={contentRef}
          onWheelCapture={handleContentWheelCapture}
          className="flex min-w-0 flex-1 flex-col"
        >
          <header className="flex items-center justify-between border-b border-[var(--pq-border)] bg-[var(--pq-surface-1)] px-6 py-4 backdrop-blur-xl">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--pq-text-faint)]">
                {activeSectionMeta?.title}
              </div>
              <div className="mt-1 text-lg font-semibold text-[var(--pq-text)]">
                {activeSectionMeta?.description}
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="pq-button px-3 py-2 text-sm"
            >
              <X className="mr-2 h-4 w-4" strokeWidth={1.8} />
              {l('关闭', 'Close')}
            </button>
          </header>

          {configSaveError ? (
            <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-rose-300/40 bg-rose-500/10 px-6 py-3 text-sm text-rose-700 dark:text-rose-300">
              <span className="min-w-0 flex-1">{configSaveError}</span>
              <button type="button" className="pq-button shrink-0 px-3 py-2" onClick={onRetryConfigSave}>
                {l('重试保存', 'Retry save')}
              </button>
            </div>
          ) : null}

          <div
            data-wheel-scroll-target
            className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-6 pb-10"
          >
            <ReaderPreferencesContent
              activeSection={activeSection}
              l={l}
              settings={settings}
              {...contentProps}
            />
          </div>
        </section>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
