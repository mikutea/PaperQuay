import {Capacitor, SystemBars, SystemBarsStyle} from '@capacitor/core';

interface Appearance {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/** Keep native bars in step with the same appearance used by the app's CSS.
 * Capacitor 8 resolves DEFAULT once, then reuses that resolved style when the
 * device appearance changes while the Activity remains alive. */
export function observeSystemBarTheme(
  native = Capacitor.isNativePlatform(),
  appearance: () => Appearance = () => window.matchMedia('(prefers-color-scheme: dark)'),
  setStyle: (style: SystemBarsStyle) => Promise<void> = style => SystemBars.setStyle({style}),
): () => void {
  if (!native) return () => undefined;
  const query = appearance();
  const apply = () => {
    void setStyle(query.matches ? SystemBarsStyle.Dark : SystemBarsStyle.Light).catch(() => undefined);
  };
  query.addEventListener('change', apply);
  apply();
  return () => query.removeEventListener('change', apply);
}
