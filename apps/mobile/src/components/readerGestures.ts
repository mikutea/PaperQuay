export interface ReaderTapPoint { clientX: number; clientY: number; pageIndex: number; onText: boolean }
export interface ReaderPointer extends ReaderTapPoint { pointerId: number; time: number }
interface TapActions { allowed: () => boolean; tap: () => void; doubleTap: (point: ReaderTapPoint) => void }

/** Recognizes only short, stationary one-finger taps; scrolling and native selection stay native. */
export class ReaderTapGesture {
  private readonly pointers = new Set<number>();
  private active: ReaderPointer | null = null;
  private previous: ReaderPointer | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private actions: TapActions) {}
  update(actions: TapActions) { this.actions = actions; }
  down(point: ReaderPointer, eligible: boolean) {
    this.pointers.add(point.pointerId);
    if (this.pointers.size !== 1 || !eligible || !this.actions.allowed()) { this.interrupt(); return; }
    this.active = point;
  }
  move(point: Pick<ReaderPointer, 'pointerId' | 'clientX' | 'clientY'>) {
    if (this.active?.pointerId === point.pointerId
      && Math.hypot(point.clientX - this.active.clientX, point.clientY - this.active.clientY) > 8) this.interrupt();
  }
  up(point: ReaderPointer, eligible: boolean) {
    this.pointers.delete(point.pointerId);
    const active = this.active; this.active = null;
    if (!active || active.pointerId !== point.pointerId || this.pointers.size || !eligible || !this.actions.allowed()
      || point.pageIndex !== active.pageIndex || point.time - active.time > 260 || point.time < active.time
      || Math.hypot(point.clientX - active.clientX, point.clientY - active.clientY) > 8) { this.interrupt(); return; }
    const previous = this.previous;
    if (previous && point.time - previous.time <= 300 && point.pageIndex === previous.pageIndex
      && Math.hypot(point.clientX - previous.clientX, point.clientY - previous.clientY) <= 28) {
      this.interrupt();
      // The browser owns double taps on text, including word selection and selection handles.
      if (!previous.onText && !point.onText) this.actions.doubleTap(point);
      return;
    }
    this.interrupt(); this.previous = point;
    this.timer = setTimeout(() => {
      this.previous = null; this.timer = undefined;
      if (!this.pointers.size && this.actions.allowed()) this.actions.tap();
    }, 300);
  }
  cancel(pointerId: number) { this.pointers.delete(pointerId); this.interrupt(); }
  interrupt() { this.active = null; this.previous = null; clearTimeout(this.timer); this.timer = undefined; }
  dispose() { this.interrupt(); this.pointers.clear(); }
}

export interface ReaderZoomAnchor {
  pageIndex: number; xRatio: number; yRatio: number; viewportX: number; viewportY: number;
}
const unit = (value: number) => Math.max(0, Math.min(1, value));

/** Capture the actual point under a tap or the viewport centre, not a browser zoom percentage. */
export function captureReaderZoomAnchor(pageIndex: number,
  page: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  viewport: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  point?: Pick<ReaderTapPoint, 'clientX' | 'clientY'>): ReaderZoomAnchor {
  const clientX = point?.clientX ?? viewport.left + viewport.width / 2;
  const clientY = point?.clientY ?? viewport.top + Math.min(viewport.height / 2, Math.max(0, page.top + page.height - viewport.top));
  return { pageIndex, xRatio: unit((clientX - page.left) / Math.max(1, page.width)),
    yRatio: unit((clientY - page.top) / Math.max(1, page.height)),
    viewportX: clientX - viewport.left, viewportY: clientY - viewport.top };
}

export function restoreReaderZoomAnchor(anchor: ReaderZoomAnchor, page: { left: number; top: number; width: number; height: number }) {
  return { left: Math.max(0, page.left + page.width * anchor.xRatio - anchor.viewportX),
    top: Math.max(0, page.top + page.height * anchor.yRatio - anchor.viewportY) };
}
