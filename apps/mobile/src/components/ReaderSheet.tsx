import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ReaderSheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
  modal?: boolean;
  /** Keep this target stable when switching between the desktop panel and mobile sheet. */
  portalTarget?: Element | DocumentFragment | null;
}

const focusableSelector = 'button,input,select,textarea,summary,a[href],[tabindex],[contenteditable="true"]';
interface ModalState {
  stack: HTMLElement[];
  overflow: string;
  blocked: Map<HTMLElement, { inert: string | null; hidden: string | null; hadClass: boolean }>;
  observer?: MutationObserver;
}
const modals = new WeakMap<Document, ModalState>();

function isolateSheet(document: Document, state: ModalState) {
  for (const [element, before] of state.blocked) {
    if (before.inert === null) element.removeAttribute('inert'); else element.setAttribute('inert', before.inert);
    if (before.hidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', before.hidden);
    if (!before.hadClass) element.classList.remove('reader-sheet-background');
  }
  state.blocked.clear();
  const top = state.stack[state.stack.length - 1];
  // Move focus out of the opener branch before hiding it from accessibility.
  // All previous inert branches have been restored, so a newly stacked sheet
  // can receive focus without disturbing an editor already inside that sheet.
  if (top && !top.contains(document.activeElement)) top.focus({ preventScroll: true });
  let branch = top?.parentElement;
  // A custom portal can live deep in the app. Block siblings at every level, never its ancestors.
  while (branch && branch !== document.body) {
    const parent = branch.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch || !(sibling instanceof (document.defaultView?.HTMLElement ?? HTMLElement))) continue;
      const element = sibling as HTMLElement;
      state.blocked.set(element, { inert: element.getAttribute('inert'), hidden: element.getAttribute('aria-hidden'),
        hadClass: element.classList.contains('reader-sheet-background') });
      element.setAttribute('inert', ''); element.setAttribute('aria-hidden', 'true'); element.classList.add('reader-sheet-background');
    }
    branch = parent;
  }
}

function visible(element: HTMLElement): boolean {
  return element.isConnected && !element.closest('[hidden],[inert],[aria-hidden="true"]')
    && element.getClientRects().length > 0
    && element.ownerDocument.defaultView?.getComputedStyle(element).visibility !== 'hidden';
}

/** Plain DOM focus management also supports WebViews without HTMLDialogElement.showModal. */
export function activateReaderSheet(dialog: HTMLElement, onClose: () => void): () => void {
  const document = dialog.ownerDocument;
  const opener = document.activeElement as HTMLElement | null;
  let state = modals.get(document);
  if (!state) {
    state = { stack: [], overflow: document.body?.style.overflow ?? '', blocked: new Map() };
    modals.set(document, state);
    if (document.body) document.body.style.overflow = 'hidden';
  }
  state.stack.push(dialog);
  isolateSheet(document, state);
  const Observer = document.defaultView?.MutationObserver;
  if (!state.observer && Observer && document.body) {
    state.observer = new Observer(() => isolateSheet(document, state!));
    state.observer.observe(document.body, { childList: true, subtree: true });
  }
  const isTop = () => state!.stack[state!.stack.length - 1] === dialog;
  const focus = (element: HTMLElement) => element.focus({ preventScroll: true });
  const eligible = (element: HTMLElement) => element.tabIndex >= 0 && !element.matches(':disabled') && visible(element);
  const candidates = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
    .filter(eligible)
    .sort((left, right) => (left.tabIndex || Infinity) - (right.tabIndex || Infinity));
  const first = () => candidates()[0] ?? dialog;
  const keydown = (event: KeyboardEvent) => {
    if (!isTop() || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); onClose(); return;
    }
    if (!dialog.contains(event.target as Node) && ['PageUp', 'PageDown', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (event.key !== 'Tab') return;
    const items = candidates(); const active = document.activeElement;
    const index = items.indexOf(active as HTMLElement);
    if (!items.length || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
      event.preventDefault();
      focus((event.shiftKey ? items[items.length - 1] : items[0]) ?? dialog);
    }
  };
  const focusin = (event: FocusEvent) => {
    if (isTop() && !dialog.contains(event.target as Node)) focus(first());
  };
  const outsideInput = (event: Event) => {
    const allowed = event.type === 'pointerdown' ? dialog.parentElement : dialog;
    if (isTop() && !allowed?.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); }
  };
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('focusin', focusin, true);
  document.addEventListener('pointerdown', outsideInput, true);
  document.addEventListener('touchmove', outsideInput, { capture: true, passive: false });
  document.addEventListener('wheel', outsideInput, { capture: true, passive: false });
  // A fresh sheet announces its title without opening the keyboard. A responsive transition
  // retains focus already inside the panel, including an editor and its text selection.
  const focused = document.activeElement as HTMLElement | null;
  if (!focused || !dialog.contains(focused) || !visible(focused)) focus(dialog);
  return () => {
    const wasTop = isTop();
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('focusin', focusin, true);
    document.removeEventListener('pointerdown', outsideInput, true);
    document.removeEventListener('touchmove', outsideInput, true);
    document.removeEventListener('wheel', outsideInput, true);
    state!.stack.splice(state!.stack.indexOf(dialog), 1);
    isolateSheet(document, state!);
    if (!state!.stack.length) {
      state!.observer?.disconnect();
      if (document.body) document.body.style.overflow = state!.overflow;
      modals.delete(document);
    }
    const becameInline = dialog.isConnected && dialog.getAttribute('role') === 'region' && !dialog.closest('[hidden]');
    if (wasTop && !becameInline) {
      if (opener && opener !== document.body && opener !== document.documentElement && visible(opener)) focus(opener);
      else if (state!.stack.length) focus(state!.stack[state!.stack.length - 1]);
      else {
        const active = document.activeElement as HTMLElement | null;
        if (active && active !== document.body && active !== document.documentElement && !dialog.contains(active) && visible(active)) return;
        // A desktop-to-mobile transition can capture an opener inside this
        // same retained panel. Return to a nearby visible control when it hides.
        for (let parent = dialog.parentElement; parent; parent = parent.parentElement) {
          const target = Array.from(parent.querySelectorAll<HTMLElement>(focusableSelector))
            .find(element => !dialog.contains(element) && eligible(element));
          if (target) { focus(target); return; }
        }
        const body = document.body, previousTabIndex = body?.getAttribute('tabindex');
        if (body) {
          body.setAttribute('tabindex', '-1'); focus(body);
          if (previousTabIndex == null) body.removeAttribute('tabindex'); else body.setAttribute('tabindex', previousTabIndex);
        }
      }
    }
  };
}

export function ReaderSheet({ open, title, onClose, children, className = '', keepMounted = false,
  modal = true, portalTarget }: ReaderSheetProps) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const backdropPointer = useRef<number | null>(null);
  const target = portalTarget === undefined ? (typeof document === 'undefined' ? null : document.body) : portalTarget;
  useLayoutEffect(() => {
    if (!open || !modal || !dialog.current) return;
    return activateReaderSheet(dialog.current, () => close.current());
  }, [open, modal, target]);
  useLayoutEffect(() => {
    if (!open || !modal || !dialog.current) return;
    const overlay = dialog.current.parentElement;
    const viewport = dialog.current.ownerDocument.defaultView?.visualViewport;
    if (!overlay || !viewport) return;
    const update = () => {
      overlay.style.setProperty('--reader-sheet-height', `${viewport.height}px`);
      overlay.style.setProperty('--reader-sheet-width', `${viewport.width}px`);
      overlay.style.setProperty('--reader-sheet-top', `${viewport.offsetTop}px`);
      overlay.style.setProperty('--reader-sheet-left', `${viewport.offsetLeft}px`);
    };
    update(); viewport.addEventListener('resize', update); viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update);
      for (const name of ['height', 'width', 'top', 'left']) overlay.style.removeProperty(`--reader-sheet-${name}`);
    };
  }, [open, modal, target]);
  if (!open && !keepMounted) return null;
  const content = <div className={`reader-sheet-overlay${modal ? '' : ' reader-sheet-inline'}`}
    hidden={!open} {...(!open ? { inert: '' } : {})}
    data-reader-sheet="true"
    onPointerDown={(event) => { backdropPointer.current = modal && event.target === event.currentTarget ? event.pointerId : null; }}
    onPointerUp={(event) => {
      if (modal && backdropPointer.current === event.pointerId && event.target === event.currentTarget) close.current();
      backdropPointer.current = null;
    }}
    onPointerCancel={() => { backdropPointer.current = null; }}>
    <section ref={dialog} className={`reader-sheet ${className}`} role={modal ? 'dialog' : 'region'}
      aria-modal={modal || undefined} aria-labelledby={titleId} tabIndex={-1}
      onKeyDown={(event) => { if (modal) event.stopPropagation(); }}>
      <header className="reader-sheet-heading">
        <button type="button" aria-label={`关闭${title}`} onClick={onClose}>关闭</button>
        <h2 id={titleId}>{title}</h2></header>
      <div className="reader-sheet-content">{children}</div>
    </section>
  </div>;
  return target ? createPortal(content, target) : content;
}
