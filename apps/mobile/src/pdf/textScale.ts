/** Keep fixed PDF glyph geometry aligned with its canvas while app text follows system settings. */
export function observePdfTextScale(container: HTMLElement): () => void {
  const probe = container.ownerDocument.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  // A large font avoids confusing the browser's minimum font size with text zoom.
  // A clipped, fixed box does not extend the page's scroll area or receive input.
  probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:auto;overflow:hidden;visibility:hidden;pointer-events:none;margin:0;padding:0;border:0;font-size:1000px;line-height:1;white-space:pre;';
  probe.textContent = 'X';
  container.ownerDocument.body.append(probe);
  let active = true;
  let observer: ResizeObserver | undefined;
  const update = () => {
    if (!active) return;
    const scale = probe.getBoundingClientRect().height / 1000;
    container.style.setProperty('--pdf-text-scale-correction', String(Number.isFinite(scale) && scale > 0 ? 1 / scale : 1));
  };
  const close = () => {
    active = false; observer?.disconnect(); probe.remove();
    container.style.removeProperty('--pdf-text-scale-correction');
  };
  try {
    update();
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(probe);
    }
    return close;
  } catch (error) {
    close(); throw error;
  }
}
