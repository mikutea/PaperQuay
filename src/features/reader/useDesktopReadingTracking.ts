import { useEffect, useMemo, useRef } from 'react';
import { createDesktopReadingTracking } from '../../services/desktopReadingTracking';
import type { DesktopReadingReaderAccess } from '../../services/desktopReadingReader';

/** The chosen reading session outlives the settings sheet, never the loaded document. */
export function useDesktopReadingTracking(localPaperId: string | null, reader: DesktopReadingReaderAccess | null, active: boolean) {
  const latest = useRef({ localPaperId, reader, active }); latest.current = { localPaperId, reader, active };
  const lifetimes = useRef(new Map<object, symbol>());
  const controller = useMemo(() => localPaperId && reader && active ? createDesktopReadingTracking({ localPaperId, reader,
    isCurrent: () => latest.current.active && latest.current.localPaperId === localPaperId && latest.current.reader === reader,
  }) : undefined, [localPaperId, reader, active]);
  useEffect(() => {
    if (!controller) return;
    const lifetime = Symbol(); lifetimes.current.set(controller, lifetime);
    const flush = () => { void controller.stop().catch(() => { /* The controller keeps the error and exact session for explicit retry. */ }); };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      queueMicrotask(() => {
        if (lifetimes.current.get(controller) === lifetime) { lifetimes.current.delete(controller); void controller.dispose(); }
      });
    };
  }, [controller]);
  return controller;
}
