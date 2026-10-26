import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, useEffect, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { activateReaderSheet, ReaderSheet } from '../src/components/ReaderSheet.tsx';

class Element {
  parentElement: Element | null = null;
  children: Element[] = [];
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly classList = { add: (value: string) => this.classes.add(value), remove: (value: string) => this.classes.delete(value), contains: (value: string) => this.classes.has(value) };
  readonly style = { overflow: '' };
  tabIndex = -1; candidate = false; disabled = false; drawn = true;
  tagName = 'button';
  focusOptions: FocusOptions | undefined;
  constructor(readonly ownerDocument: DocumentStub) {}
  get isConnected(): boolean { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  append(child: Element) { child.parentElement = this; this.children.push(child); return child; }
  contains(other: Element): boolean { for (let node: Element | null = other; node; node = node.parentElement) if (node === this) return true; return false; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  matches(selector: string) { return selector === ':disabled' && this.disabled; }
  closest(selector: string): Element | null {
    const attributes = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]+)")?\]/g)];
    for (let node: Element | null = this; node; node = node.parentElement) {
      if (attributes.some(([, name, value]) => node!.attributes.has(name) && (value === undefined || node!.getAttribute(name) === value))) return node;
    }
    return null;
  }
  getClientRects() { return this.drawn ? [{}] : []; }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap((child) => [
    ...(child.candidate && selector.split(',').includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]); }
  focus(options?: FocusOptions) { this.focusOptions = options; this.ownerDocument.activeElement = this; }
}
class DocumentStub extends EventTarget {
  readonly body = new Element(this);
  activeElement: Element = this.body;
  readonly defaultView = { HTMLElement: Element, getComputedStyle: () => ({ visibility: 'visible' }) };
}
function fixture() {
  const document = new DocumentStub(); document.body.style.overflow = 'auto';
  const app = document.body.append(new Element(document));
  const navigation = app.append(new Element(document)); navigation.setAttribute('aria-hidden', 'false');
  const workspace = app.append(new Element(document));
  const reader = workspace.append(new Element(document));
  const opener = reader.append(new Element(document)); opener.tabIndex = 0; opener.focus();
  const host = workspace.append(new Element(document));
  const overlay = host.append(new Element(document));
  const dialog = overlay.append(new Element(document)); dialog.setAttribute('role', 'dialog');
  const control = () => { const value = dialog.append(new Element(document)); value.candidate = true; value.tabIndex = 0; return value; };
  const first = control(); const hiddenFile = control(); hiddenFile.tabIndex = -1;
  const disabled = control(); disabled.disabled = true;
  const hidden = control(); hidden.drawn = false;
  const last = control();
  let closes = 0;
  const restore = activateReaderSheet(dialog as unknown as HTMLElement, () => { closes++; });
  return { document, app, navigation, reader, opener, host, overlay, dialog, first, last, restore, get closes() { return closes; } };
}
function event(type: string, fields: Record<string, unknown> = {}) {
  const value = new Event(type, { cancelable: true });
  for (const [key, field] of Object.entries(fields)) Object.defineProperty(value, key, { value: field });
  return value;
}

test('a nested portal isolates sibling branches without disabling its own ancestors and restores exact attributes', () => {
  const env = fixture();
  assert.equal(env.document.activeElement, env.dialog);
  assert.equal(env.reader.getAttribute('inert'), ''); assert.equal(env.navigation.getAttribute('aria-hidden'), 'true');
  assert.equal(env.app.getAttribute('inert'), null); assert.equal(env.host.getAttribute('inert'), null);
  assert.equal(env.document.body.style.overflow, 'hidden');
  env.restore();
  assert.equal(env.reader.getAttribute('inert'), null); assert.equal(env.navigation.getAttribute('aria-hidden'), 'false');
  assert.equal(env.document.body.style.overflow, 'auto'); assert.equal(env.document.activeElement, env.opener);
  assert.deepEqual(env.opener.focusOptions, { preventScroll: true });
});

test('Tab loops through visible enabled controls, focus escape is contained, and Escape closes only the modal', () => {
  const env = fixture();
  try {
    const tab = event('keydown', { key: 'Tab' }); env.document.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true); assert.equal(env.document.activeElement, env.first);
    const previous = event('keydown', { key: 'Tab', shiftKey: true }); env.document.dispatchEvent(previous);
    assert.equal(env.document.activeElement, env.last);
    env.document.dispatchEvent(event('keydown', { key: 'Tab' })); assert.equal(env.document.activeElement, env.first);
    env.opener.focus(); env.document.dispatchEvent(event('focusin')); assert.equal(env.document.activeElement, env.first);
    const escape = event('keydown', { key: 'Escape' }); env.document.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true); assert.equal(env.closes, 1);
    const page = event('keydown', { key: 'PageDown' }); env.document.dispatchEvent(page); assert.equal(page.defaultPrevented, true);
    const pointer = event('pointerdown'); env.document.dispatchEvent(pointer); assert.equal(pointer.defaultPrevented, true);
    const wheel = event('wheel'); env.document.dispatchEvent(wheel); assert.equal(wheel.defaultPrevented, true);
  } finally { env.restore(); }
});

test('nested modals retain the outer focus trap and restore the background only after the last close', () => {
  const env = fixture();
  const overlay = env.host.append(new Element(env.document));
  const dialog = overlay.append(new Element(env.document)); dialog.setAttribute('role', 'dialog');
  let closed = 0;
  const restore = activateReaderSheet(dialog as unknown as HTMLElement, () => { closed++; });
  env.document.dispatchEvent(event('keydown', { key: 'Escape' }));
  assert.equal(closed, 1); assert.equal(env.closes, 0); assert.equal(env.overlay.getAttribute('inert'), '');
  restore();
  assert.equal(env.document.activeElement, env.dialog); assert.equal(env.reader.getAttribute('inert'), '');
  assert.equal(env.document.body.style.overflow, 'hidden');
  env.restore(); assert.equal(env.document.body.style.overflow, 'auto'); assert.equal(env.reader.getAttribute('inert'), null);
});

test('native summary controls remain in the Tab order when details expands and collapses', () => {
  const env = fixture();
  const summary = env.dialog.append(new Element(env.document));
  summary.tagName = 'summary'; summary.candidate = true; summary.tabIndex = 0;
  const input = env.dialog.append(new Element(env.document));
  input.tagName = 'input'; input.candidate = true; input.tabIndex = 0; input.drawn = false;
  try {
    summary.focus();
    const closed = event('keydown', { key: 'Tab' }); env.document.dispatchEvent(closed);
    assert.equal(closed.defaultPrevented, true); assert.equal(env.document.activeElement, env.first);
    input.drawn = true; summary.focus();
    const expanded = event('keydown', { key: 'Tab' }); env.document.dispatchEvent(expanded);
    assert.equal(expanded.defaultPrevented, false, 'the browser must be free to move from summary to its revealed field');
    input.focus();
    const reverse = event('keydown', { key: 'Tab', shiftKey: true }); env.document.dispatchEvent(reverse);
    assert.equal(reverse.defaultPrevented, false, 'reverse Tab must be free to return to summary');
    input.drawn = false; summary.focus();
    const collapsed = event('keydown', { key: 'Tab' }); env.document.dispatchEvent(collapsed);
    assert.equal(collapsed.defaultPrevented, true); assert.equal(env.document.activeElement, env.first);
  } finally { env.restore(); }
});

test('a modal becoming an inline desktop panel keeps focus in its draft and releases the background', () => {
  const env = fixture(); env.last.focus(); env.dialog.setAttribute('role', 'region'); env.restore();
  assert.equal(env.document.activeElement, env.last); assert.equal(env.reader.getAttribute('inert'), null);
  assert.equal(env.document.body.style.overflow, 'auto');
});

test('an inline editor becoming a mobile modal retains the existing input focus', () => {
  const env = fixture(); env.last.focus(); env.dialog.setAttribute('role', 'region'); env.restore();
  env.dialog.setAttribute('role', 'dialog');
  const restore = activateReaderSheet(env.dialog as unknown as HTMLElement, () => undefined);
  assert.equal(env.document.activeElement, env.last);
  restore();
});

test('keepMounted preserves child state across hiding and responsive modal changes, and backdrop drags do not close', () => {
  let mounted = 0; let unmounted = 0; let closes = 0; let renderer!: ReactTestRenderer;
  function Draft() {
    const [value, setValue] = useState('original');
    useEffect(() => { mounted++; return () => { unmounted++; }; }, []);
    return createElement('input', { value, onChange: (event: { target: { value: string } }) => setValue(event.target.value) });
  }
  const sheet = (open: boolean, modal: boolean) => createElement(ReaderSheet, { open, modal, keepMounted: true,
    portalTarget: null, title: '阅读笔记', onClose: () => { closes++; }, children: createElement(Draft) });
  act(() => { renderer = create(sheet(true, true)); });
  act(() => renderer.root.findByType('input').props.onChange({ target: { value: 'unsaved draft' } }));
  act(() => renderer.update(sheet(false, true)));
  assert.equal(renderer.root.findByProps({ 'data-reader-sheet': 'true' }).props.hidden, true);
  assert.equal(renderer.root.findByType('input').props.value, 'unsaved draft');
  act(() => renderer.update(sheet(true, false)));
  assert.equal(renderer.root.findByProps({ role: 'region' }).props['aria-modal'], undefined);
  assert.equal(renderer.root.findByType('input').props.value, 'unsaved draft');
  act(() => renderer.update(sheet(true, true)));
  assert.equal(renderer.root.findByProps({ role: 'dialog' }).props['aria-modal'], true);
  const overlay = renderer.root.findByProps({ 'data-reader-sheet': 'true' }); const target = {};
  overlay.props.onPointerDown({ target: {}, currentTarget: target, pointerId: 1 });
  overlay.props.onPointerUp({ target, currentTarget: target, pointerId: 1 }); assert.equal(closes, 0);
  overlay.props.onPointerDown({ target, currentTarget: target, pointerId: 2 });
  overlay.props.onPointerUp({ target, currentTarget: target, pointerId: 2 }); assert.equal(closes, 1);
  assert.equal(mounted, 1); assert.equal(unmounted, 0);
  act(() => renderer.unmount()); assert.equal(unmounted, 1);
});
