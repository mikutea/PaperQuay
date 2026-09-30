import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, ChevronDown, Sparkles } from 'lucide-react';
import type { QaModelPreset } from '../types/reader';
import { placeAnchoredMenu } from '../utils/anchoredMenu';
import { cn } from '../utils/cn';

interface ModelPresetPickerProps {
  l: (zh: string, en: string) => string;
  presets: QaModelPreset[];
  selectedPresetId: string;
  onChange: (presetId: string) => void;
  title: string;
  className?: string;
  compact?: boolean;
  pill?: boolean;
}

export function ModelPresetPicker({
  l,
  presets,
  selectedPresetId,
  onChange,
  title,
  className,
  compact = false,
  pill = false,
}: ModelPresetPickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [menuPlacement, setMenuPlacement] = useState<'above' | 'below'>('below');
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? presets[0] ?? null,
    [presets, selectedPresetId],
  );
  const updateMenuPosition = useCallback(() => {
    const button = buttonRef.current;

    if (!button || typeof window === 'undefined') {
      return;
    }

    const rect = button.getBoundingClientRect();
    const placement = placeAnchoredMenu({
      anchor: {
        left: rect.left,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
      },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      preferredWidth: compact ? 200 : 220,
    });

    setMenuPlacement(placement.placement);
    setMenuStyle({
      top: placement.top,
      bottom: placement.bottom,
      left: placement.left,
      width: placement.width,
      maxHeight: placement.maxHeight,
    });
  }, [compact]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    updateMenuPosition();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (
        target instanceof Node &&
        (rootRef.current?.contains(target) || menuRef.current?.contains(target))
      ) {
        return;
      }

      setOpen(false);
    };
    const handleViewportChange = () => updateMenuPosition();

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open, updateMenuPosition]);

  const menu = open ? (
    <div
      ref={menuRef}
      className={cn(
        'pq-card pq-model-menu fixed z-[9999] flex flex-col overflow-hidden p-0 shadow-[0_18px_48px_rgba(15,23,42,0.18)]',
        menuPlacement === 'above' ? 'pq-model-menu-above origin-bottom' : 'origin-top',
      )}
      style={menuStyle}
    >
      <div className="shrink-0 border-b border-[var(--pq-border-subtle)] px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--pq-accent)]" strokeWidth={1.9} />
          <div className="truncate text-xs font-semibold text-[var(--pq-text)]">{title}</div>
        </div>
        <div className="mt-0.5 truncate text-[10px] text-[var(--pq-text-faint)]">
          {l('选择一个已配置的模型', 'Choose a configured model')}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {presets.length === 0 ? (
          <div className="px-2.5 py-3 text-xs text-[var(--pq-text-muted)]">
            {l('还没有可用模型，请先到设置中添加。', 'No models yet. Add one in Settings first.')}
          </div>
        ) : (
          presets.map((preset) => {
            const selected = preset.id === selectedPreset?.id;

            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  onChange(preset.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[var(--pq-radius-sm)] px-2 py-1.5 text-left text-xs transition',
                  selected
                    ? 'bg-[var(--pq-accent-soft)] text-[var(--pq-accent)]'
                    : 'text-[var(--pq-text)] hover:bg-[var(--pq-surface-2)]',
                )}
              >
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition',
                    selected
                      ? 'bg-[var(--pq-accent)] text-white'
                      : 'bg-[var(--pq-surface-2)] text-[var(--pq-text-faint)]',
                  )}
                >
                  <Bot className="h-3.5 w-3.5" strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{preset.label || preset.model}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-[var(--pq-text-faint)]">
                    {preset.model}
                  </span>
                </span>
                {selected ? <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.4} /> : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={cn('relative shrink-0', className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (!open) updateMenuPosition();
          setOpen((current) => !current);
        }}
        title={title}
        aria-label={title}
        aria-expanded={open}
        className={cn(
          'group flex max-w-[190px] items-center gap-2 text-sm transition-all',
          pill
            ? 'h-9 w-[136px] rounded-full border border-[rgba(15,23,42,0.10)] bg-white px-3 text-[var(--pq-text-muted)] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_20px_rgba(15,23,42,0.04)] hover:border-[rgba(13,148,136,0.22)] hover:bg-white hover:shadow-[0_2px_5px_rgba(15,23,42,0.06),0_12px_26px_rgba(15,23,42,0.06)] sm:w-[156px] sm:px-4 dark:border-white/10 dark:bg-white/8'
            : 'pq-input h-10 rounded-xl px-3 text-[var(--pq-text-muted)] hover:border-[var(--pq-border-strong)] hover:bg-[var(--pq-accent-soft)]',
          compact ? 'w-10 justify-center px-0' : !pill && 'w-[190px]',
        )}
      >
        {pill ? (
          <Sparkles
            className="h-4 w-4 shrink-0 text-[var(--pq-accent)] opacity-70 transition group-hover:opacity-100"
            strokeWidth={1.9}
          />
        ) : (
          <Bot
            className="h-4 w-4 shrink-0 text-slate-400 dark:text-[var(--pq-text-faint)]"
            strokeWidth={1.8}
          />
        )}
        {compact ? null : (
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-left font-semibold',
              pill ? 'text-[var(--pq-text-muted)]' : 'text-[var(--pq-text)]',
            )}
          >
            {selectedPreset?.label || selectedPreset?.model || l('未配置模型', 'No model')}
          </span>
        )}
        {compact ? null : (
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-[var(--pq-text-faint)] transition-transform duration-200 group-hover:text-[var(--pq-accent)]',
              open && 'rotate-180',
            )}
            strokeWidth={1.9}
          />
        )}
      </button>

      {typeof document === 'undefined' || !menu ? null : createPortal(menu, document.body)}
    </div>
  );
}
