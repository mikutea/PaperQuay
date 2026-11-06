/** Viewport coordinates for the body portal, independent of sidebar clipping. */
export function placeNoteExportResult(anchor: { top: number; right: number; bottom: number },
  viewport: { width: number; height: number }, contentHeight: number) {
  const margin = 8, width = Math.max(0, Math.min(288, viewport.width - margin * 2)), maxHeight = Math.max(0, viewport.height - margin * 2);
  const height = Math.min(contentHeight, maxHeight);
  const left = Math.max(margin, Math.min(anchor.right - width, viewport.width - width - margin));
  const below = anchor.bottom + margin, above = anchor.top - height - margin;
  const preferred = below + height > viewport.height - margin && above >= margin ? above : below;
  const top = Math.max(margin, Math.min(preferred, viewport.height - height - margin));
  return { left, top, width, maxHeight };
}
